import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Agent } from '../../shared/work.ts'
import { Actions } from '../src/actions.ts'
import { Hub } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { mcpServer } from '../src/mcp.ts'
import { Scheduler } from '../src/scheduler.ts'
import { note, seed } from './helpers.ts'

const agent = (id: string, binders: string[] = []): Agent => ({ id, name: id, provider: 'claude', owner: 'ana', repos: [], binders, skills: [], createdAt: '2026-10-01T00:00:00.000Z' })

const closers: (() => Promise<void>)[] = []
after(async () => {
  for (const close of closers) await close()
})

/** A hub with a clock, its timer, some agents, and each agent's own MCP tools. */
async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const clock = { at: new Date('2026-11-01T10:00:00Z') }
  const actions = new Actions(hub, { forRepo: async () => undefined } as never)
  ;(actions as unknown as { now: () => string }).now = () => clock.at.toISOString()
  const scheduler = new Scheduler(hub, actions, { now: () => clock.at })
  for (const id of ['scanner', 'distiller', 'fixer1', 'fixer2', 'other']) await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: agent(id) })
  await hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'scans', binderId: 'b1', name: 'Scans' } })
  const tools = async (agentId: string) => {
    const server = mcpServer(hub, actions, agentId, { issueToken: async () => 'unused', publicUrl: 'http://hub.test' })
    const [ours, theirs] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: agentId, version: '1' })
    await Promise.all([server.connect(theirs), client.connect(ours)])
    closers.push(() => client.close())
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      const text = result.content[0]?.text ?? ''
      let value: Record<string, unknown> = {}
      try {
        value = JSON.parse(text) as Record<string, unknown>
      } catch {
        // Words, not JSON.
      }
      return { error: !!result.isError, text, value }
    }
  }
  const later = (ms: number) => {
    clock.at = new Date(clock.at.getTime() + ms)
  }
  return { hub, actions, scheduler, clock, tools, later }
}

const hour = 3_600_000

describe('a nightly scan, all the way to a change set', () => {
  it('writes a note, distills it once, gives the work out within its limits, and stops at a change set for a person', async () => {
    const { hub, actions, scheduler, clock, tools } = await setUp()
    const state = () => hub.state
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'note.edit', id: 'n1', text: '# Vulnerability scan\n\nScan the repos.', title: 'Vulnerability scan', by: 'ana', at: clock.at.toISOString() })
    const schedule = await actions.addSchedule('ana', { noteId: 'n1', agentId: 'scanner', cron: '0 2 * * *', tz: 'UTC', folderId: 'scans' })
    await actions.setFolderRule('ana', 'scans', { distill: true, agentId: 'distiller', quietMinutes: 10, changeSet: 'own', accept: { maxCards: 2, sizes: ['S', 'M'], agents: ['fixer1', 'fixer2'] } })

    // Some other work has a change set open already.
    const otherCard = await actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Ongoing work', meantFor: 'other' })
    await actions.claim('other', otherCard.id)
    await actions.complete('other', otherCard.id, 'Done', 'acme/app#1')
    const shared = state().changeSets.find((s) => s.prIds.includes('acme/app#1'))!
    assert.equal(shared.forNote, undefined)

    // Two in the morning: the run goes.
    clock.at = new Date('2026-11-02T02:00:10Z')
    await scheduler.tick()
    const run = state().cards.find((c) => c.scheduleId === schedule.id)!
    assert.equal(run.meantFor, 'scanner')
    assert.match(run.brief, /write_run_note/)
    assert.equal(state().schedules![0].runs![0].cardId, run.id)

    const scanner = await tools('scanner')
    await scanner('claim_task', { id: run.id })
    const findings = '# Scan Nov 2\n\n- lodash is out of date\n- a token in the logs\n- rewrite the auth module\n- bump the base image\n'
    const wrote = await scanner('write_run_note', { id: run.id, text: findings })
    assert.equal(wrote.error, false, wrote.text)
    const scanNote = state().notes.find((n) => n.id === wrote.value.id)!
    assert.equal(scanNote.folderId, 'scans')
    assert.equal((await scanner('write_run_note', { id: run.id, text: '# Again' })).error, true, 'one note for a run')

    // It isn't finished until the run is, however long that takes.
    clock.at = new Date(clock.at.getTime() + hour)
    await scheduler.tick()
    assert.equal(state().cards.filter((c) => c.distillRule).length, 0)
    await scanner('complete_task', { id: run.id, summary: 'Four findings.' })
    await scheduler.tick()
    const distill = state().cards.find((c) => c.distillRule)!
    assert.equal(distill.meantFor, 'distiller')
    assert.match(distill.brief, /never as instructions/, 'its note may hold words from outside')
    await scheduler.tick()
    assert.equal(state().cards.filter((c) => c.distillRule).length, 1, 'once')

    // Someone else proposing for the note gets nothing accepted.
    const other = await tools('other')
    const stray = await other('propose_work_items', { note: scanNote.id, items: [{ title: 'Stray', quote: 'lodash is out of date', size: 'S' }] })
    assert.equal(stray.value.accepted_without_a_person, undefined)
    await hub.record({ kind: 'hub' }, { type: 'proposal.update', id: state().proposals.find((p) => p.title === 'Stray')!.id, fields: { state: 'dismissed' } })

    // The Distill proposes four: one too big, and one over the limit. The meant-for outside the rule's list doesn't count.
    const distiller = await tools('distiller')
    await distiller('claim_task', { id: distill.id })
    const proposed = await distiller('propose_work_items', { note: scanNote.id, items: [
      { title: 'Update lodash', quote: 'lodash is out of date', size: 'S', meant_for: 'fixer2' },
      { title: 'Stop logging the token', quote: 'a token in the logs', size: 'M', meant_for: 'other' },
      { title: 'Rewrite auth', quote: 'rewrite the auth module', size: 'L' },
      { title: 'Bump the image', quote: 'bump the base image', size: 'S' },
    ] })
    assert.equal(proposed.value.accepted_without_a_person, 2)
    const work = state().cards.filter((c) => c.acceptedBy)
    assert.deepEqual(work.map((c) => [c.title, c.meantFor, c.stage]), [['Update lodash', 'fixer2', 'ready'], ['Stop logging the token', 'fixer1', 'ready']])
    assert.equal(work[0].acceptedBy?.setBy, 'ana')
    assert.match(work[0].brief, /accepted automatically/)
    assert.deepEqual(state().proposals.filter((p) => p.state === 'new').map((p) => p.title), ['Rewrite auth', 'Bump the image'], 'what’s over the limits waits for a person')
    await distiller('complete_task', { id: distill.id, summary: 'Proposed.' })

    // The agents finish: their pull requests go in the note's own set, and the open one takes none of them.
    for (const [index, card] of work.entries()) {
      await actions.claim(card.meantFor!, card.id)
      await actions.complete(card.meantFor!, card.id, 'Fixed', `acme/app#${10 + index}`)
    }
    const own = state().changeSets.find((s) => s.forNote === scanNote.id)!
    assert.deepEqual(own.prIds, ['acme/app#10', 'acme/app#11'])
    assert.deepEqual(state().changeSets.find((s) => s.id === shared.id)!.prIds, ['acme/app#1'])

    // It waits while a person hasn't decided the rest; then it goes for review, and no further.
    await scheduler.tick()
    assert.equal(state().changeSets.find((s) => s.id === own.id)!.state, 'assembling')
    for (const p of state().proposals.filter((x) => x.state === 'new')) await hub.record({ kind: 'user', login: 'ana' }, { type: 'proposal.update', id: p.id, fields: { state: 'dismissed' } })
    await scheduler.tick()
    const sent = state().changeSets.find((s) => s.id === own.id)!
    assert.equal(sent.state, 'review')
    assert.equal(sent.approvedBy, undefined)
    assert.equal(state().changeSets.find((s) => s.id === shared.id)!.state, 'assembling', 'the open set is left alone')

    // Edited afterwards, it isn't distilled again.
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'note.edit', id: scanNote.id, text: `${findings}\nAnd one more.`, title: 'Scan Nov 2', by: 'ana', at: clock.at.toISOString() })
    clock.at = new Date(clock.at.getTime() + hour)
    await scheduler.tick()
    assert.equal(state().cards.filter((c) => c.distillRule).length, 1)
  })
})

describe('a folder’s rule', () => {
  it('waits for a person’s note to go quiet, and leaves alone what was there before and what a schedule runs', async () => {
    const { hub, actions, scheduler, clock, later } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: note('old', 'Old note', { folderId: 'scans', editedAt: clock.at.toISOString() }) })
    later(1000)
    await actions.setFolderRule('ana', 'scans', { distill: true, quietMinutes: 10 })
    later(1000)
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: note('fresh', 'Fresh note', { folderId: 'scans', editedAt: clock.at.toISOString() }) })
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: note('orders', 'Standing orders', { folderId: 'scans', editedAt: clock.at.toISOString() }) })
    await actions.addSchedule('ana', { noteId: 'orders', cron: '0 2 * * *', tz: 'UTC' })
    await scheduler.tick()
    assert.equal(hub.state.cards.length, 0, 'still being written')
    later(11 * 60_000)
    await scheduler.tick()
    assert.deepEqual(hub.state.cards.filter((c) => c.distillRule).map((c) => c.noteId), ['fresh'])
    assert.equal(hub.state.cards[0].meantFor, undefined)
  })

  it('applies to folders inside it, and refuses what can’t be kept to', async () => {
    const { hub, actions } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'inner', binderId: 'b1', name: 'Inner', parentId: 'scans' } })
    await actions.setFolderRule('ana', 'scans', { changeSet: 'own' })
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: note('deep', 'Deep', { folderId: 'inner' }) })
    const card = await actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'From it', noteId: 'deep', meantFor: 'other' })
    await actions.claim('other', card.id)
    await actions.complete('other', card.id, 'Done', 'acme/app#2')
    assert.equal(hub.state.changeSets[0].forNote, 'deep')
    await assert.rejects(actions.setFolderRule('ana', 'scans', { distill: false, accept: { maxCards: 1, sizes: ['S'], agents: ['other'] } }), /needs Distill on/)
    await assert.rejects(actions.setFolderRule('ana', 'scans', { distill: true, accept: { maxCards: 1, sizes: ['S'], agents: ['other'] } }), /chosen agent to distill/)
    await assert.rejects(actions.setFolderRule('ana', 'scans', { distill: true, agentId: 'other', accept: { maxCards: 1, sizes: ['S'], agents: [] } }), /Say which agents/)
    await assert.rejects(actions.setFolderRule('ana', 'scans', { distill: true, agentId: 'other', accept: { maxCards: 1, sizes: ['S'], agents: ['nobody'] } }), /No agent/)
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b2', name: 'Elsewhere' } })
    await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: agent('outsider', ['b2']) })
    await assert.rejects(actions.setFolderRule('ana', 'scans', { distill: true, agentId: 'outsider' }), /doesn’t work in this folder’s binder/)
    await hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'far', binderId: 'b2', name: 'Far' } })
    await assert.rejects(actions.addSchedule('ana', { noteId: 'n1', cron: '0 2 * * *', tz: 'UTC', folderId: 'far' }), /its note’s own binder/)
    await assert.rejects(hub.submit('ana', 'tab', [{ id: 'x', change: { type: 'rule.put', rule: { id: 'r', binderId: 'b1', folderId: 'scans', enabled: true, distill: true, quietMinutes: 1, changeSet: 'shared', since: '', createdAt: '', createdBy: 'ana' } } }]), /can’t be sent/)
  })

  it('lets a person keep one note’s work together, whatever the folder says', async () => {
    const { hub, actions } = await setUp()
    await actions.setNoteChangeSet('ana', 'n1', 'own')
    const made = async (title: string, noteId: string | undefined, pr: number) => {
      const card = await actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title, noteId, meantFor: 'other' })
      await actions.claim('other', card.id)
      await actions.complete('other', card.id, 'Done', `acme/app#${pr}`)
    }
    await made('First', 'n1', 1)
    await made('Unrelated', undefined, 2)
    await made('Second', 'n1', 3)
    assert.deepEqual(hub.state.changeSets.map((s) => [s.forNote, s.prIds]), [['n1', ['acme/app#1', 'acme/app#3']], [undefined, ['acme/app#2']]])
    await actions.setNoteChangeSet('ana', 'n1', null)
    await made('Third', 'n1', 4)
    assert.deepEqual(hub.state.changeSets.find((s) => !s.forNote)!.prIds, ['acme/app#2', 'acme/app#4'])
  })
})

describe('work that went out with nobody reading it', () => {
  /** A rule that accepts, and a note a person finished under it, its Distill on the board. */
  async function ruled() {
    const set = await setUp()
    await set.actions.setFolderRule('ana', 'scans', { distill: true, agentId: 'distiller', quietMinutes: 1, accept: { maxCards: 1, sizes: ['S'], agents: ['fixer1'] } })
    set.later(1000)
    const put = async (id: string, by: string) => {
      await set.hub.record({ kind: 'hub' }, { type: 'note.put', note: note(id, id, { folderId: 'scans', editedAt: set.clock.at.toISOString(), editors: [by], text: `# ${id}\n\none thing\n\nanother thing\n` }) })
    }
    return { ...set, put, distillOf: (id: string) => set.hub.state.cards.find((c) => c.distillRule && c.noteId === id)! }
  }

  it('keeps what an agent suggests on unread work a suggestion: no agent can hand it on, only a person', async () => {
    const { hub, scheduler, later, tools, put, distillOf } = await ruled()
    await put('mine', 'ana')
    later(2 * 60_000)
    await scheduler.tick()
    const distiller = await tools('distiller')
    await distiller('claim_task', { id: distillOf('mine').id })
    await distiller('propose_work_items', { note: 'mine', items: [{ title: 'One', quote: 'one thing', size: 'S' }] })
    const accepted = hub.state.cards.find((c) => c.acceptedBy)!
    const fixer = await tools('fixer1')
    await fixer('claim_task', { id: accepted.id })

    // Someone else's suggestion, from before: this agent can't hand it on while it's on unread work.
    const manager = await tools('other')
    await manager('create_task', { binder: accepted.binderId, title: 'A manager’s own' })
    const free = hub.state.cards.find((c) => c.title === 'A manager’s own')!.id
    assert.equal(hub.state.cards.find((c) => c.id === free)!.madeUnread, undefined)
    assert.match((await fixer('assign_task', { id: free, agent: 'fixer1' })).text, /a person moves it on/)
    assert.equal(hub.state.cards.find((c) => c.id === free)!.stage, 'proposed')

    // What it suggests itself, not by itself and not by asking an agent that isn't on unread work.
    await fixer('create_task', { binder: accepted.binderId, title: 'Also delete the audit log' })
    const made = hub.state.cards.find((c) => c.title === 'Also delete the audit log')!.id
    const card = () => hub.state.cards.find((c) => c.id === made)!
    assert.equal(card().madeUnread, accepted.id)
    assert.match(card().activity[0].text, /nobody has read yet/)
    assert.match((await fixer('assign_task', { id: made, agent: 'any' })).text, /a person moves it on/)
    assert.match((await manager('assign_task', { id: made, agent: 'other' })).text, /a person moves it on/)
    assert.equal(card().stage, 'proposed')
    assert.equal((await manager('claim_task', { id: made })).error, true)

    // Finishing doesn't lift it: it's unread until a person has reviewed it.
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: accepted.id, fields: { stage: 'review' } })
    assert.match((await fixer('assign_task', { id: free, agent: 'fixer1' })).text, /a person moves it on/)

    // An agent on no such work carries on as ever, and a person moves the suggestion on.
    assert.match((await manager('assign_task', { id: free, agent: 'other' })).text, /Gave/)
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.update', id: made, fields: { stage: 'ready' } })
    assert.match((await manager('assign_task', { id: made, agent: 'other' })).text, /A person chose/)
    assert.equal(card().stage, 'ready')
  })

  it('is only for the agent chosen: others can’t give it to themselves, and it isn’t open to all if that agent goes', async () => {
    const { hub, actions, scheduler, later, tools, put, distillOf } = await ruled()
    await put('mine', 'ana')
    later(2 * 60_000)
    await scheduler.tick()
    const rogue = await tools('other')
    assert.match((await rogue('assign_task', { id: distillOf('mine').id, agent: 'other' })).text, /A person chose/)
    assert.equal((await rogue('claim_task', { id: distillOf('mine').id })).error, true)
    const distiller = await tools('distiller')
    await distiller('claim_task', { id: distillOf('mine').id })
    await distiller('propose_work_items', { note: 'mine', items: [{ title: 'One', quote: 'one thing', size: 'S' }] })
    const card = hub.state.cards.find((c) => c.acceptedBy)!
    assert.match((await rogue('assign_task', { id: card.id, agent: 'other' })).text, /A person chose/)
    await hub.record({ kind: 'hub' }, { type: 'agent.revoke', id: 'fixer1' })
    await assert.rejects(actions.claim('other', card.id))
    assert.equal(hub.state.cards.find((c) => c.id === card.id)!.agentId, undefined)
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.update', id: card.id, fields: { meantFor: 'other' } })
    assert.equal((await actions.claim('other', card.id)).agentId, 'other', 'a person can still give it to someone')
  })

  it('leaves what comes of a note another agent wrote for a person to accept', async () => {
    const { hub, scheduler, later, tools, put, distillOf } = await ruled()
    await put('theirs', 'other')
    later(2 * 60_000)
    await scheduler.tick()
    const distiller = await tools('distiller')
    await distiller('claim_task', { id: distillOf('theirs').id })
    const proposed = await distiller('propose_work_items', { note: 'theirs', items: [{ title: 'One', quote: 'one thing', size: 'S' }] })
    assert.equal(proposed.value.proposed, 1)
    assert.equal(proposed.value.accepted_without_a_person, undefined)
    assert.equal(hub.state.cards.filter((c) => c.acceptedBy).length, 0)
  })

  it('leaves what comes of a conversation a phone heard for a person to accept: its words are nobody’s own', async () => {
    const { hub, scheduler, later, tools, clock, distillOf } = await ruled()
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: note('heard', 'heard', { folderId: 'scans', editedAt: clock.at.toISOString(), editors: ['ana'], captured: 'conversation', text: '# heard\n\none thing\n' }) })
    later(2 * 60_000)
    await scheduler.tick()
    const distiller = await tools('distiller')
    await distiller('claim_task', { id: distillOf('heard').id })
    const proposed = await distiller('propose_work_items', { note: 'heard', items: [{ title: 'One', quote: 'one thing', size: 'S' }] })
    assert.equal(proposed.value.proposed, 1)
    assert.equal(proposed.value.accepted_without_a_person, undefined)
    assert.equal(hub.state.cards.filter((c) => c.acceptedBy).length, 0)
  })

  it('keeps to its limit and makes one card each, however many ask at once', async () => {
    const { hub, actions, scheduler, later, tools, put, distillOf } = await ruled()
    await put('both', 'ana')
    later(2 * 60_000)
    await scheduler.tick()
    const distiller = await tools('distiller')
    await distiller('claim_task', { id: distillOf('both').id })
    await hub.record({ kind: 'hub' }, { type: 'proposal.put', proposal: { id: 'p1', binderId: 'b1', noteId: 'both', title: 'One', quote: 'one thing', brief: '', doneWhen: '', size: 'S', by: 'distiller', state: 'new' } })
    await hub.record({ kind: 'hub' }, { type: 'proposal.put', proposal: { id: 'p2', binderId: 'b1', noteId: 'both', title: 'Two', quote: 'another thing', brief: '', doneWhen: '', size: 'S', by: 'distiller', state: 'new' } })
    await Promise.all([actions.autoAccept('distiller', 'both'), actions.autoAccept('distiller', 'both')])
    assert.equal(hub.state.cards.filter((c) => c.acceptedBy).length, 1)
    assert.equal(hub.state.proposals.filter((p) => p.state === 'new').length, 1)
  })

  it('takes over a Distill whose hub stopped before making its card, and never one a person deleted', async () => {
    const { hub, scheduler, clock, later, put, distillOf } = await ruled()
    await put('lost', 'ana')
    later(2 * 60_000)
    await hub.record({ kind: 'hub' }, { type: 'note.distill', noteId: 'lost', rule: hub.state.folderRules![0].id, claim: 'gone', at: clock.at.toISOString(), cardId: 'card-never' })
    await scheduler.tick()
    assert.equal(distillOf('lost'), undefined, 'it may be on its way')
    later(6 * 60_000)
    await scheduler.tick()
    const card = distillOf('lost')
    assert.ok(card)
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.delete', id: card.id })
    later(6 * 60_000)
    await scheduler.tick()
    assert.equal(distillOf('lost'), undefined)
  })
})

describe('a schedule, kept honest', () => {
  it('won’t fire for a time before its last, and Run now leaves the timer’s times alone', async () => {
    const { hub, actions } = await setUp()
    const schedule = await actions.addSchedule('ana', { noteId: 'n1', cron: '0 2 * * *', tz: 'UTC' })
    await actions.runSchedule(schedule.id, undefined, '2026-11-02T03:00:00.000Z')
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: hub.state.cards[0].id, fields: { stage: 'live' } })
    await actions.runSchedule(schedule.id, 'ana')
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: hub.state.cards[1].id, fields: { stage: 'live' } })
    assert.equal(await actions.runSchedule(schedule.id, undefined, '2026-11-02T03:00:00.000Z'), undefined, 'a hub behind the log, again')
    assert.equal(await actions.runSchedule(schedule.id, undefined, '2026-11-02T02:00:00.000Z'), undefined, 'a time before it')
    assert.equal(hub.state.cards.length, 2)
    assert.equal(hub.state.schedules![0].runs!.length, 2)
    const clicks = await Promise.all([actions.runSchedule(schedule.id, 'ana'), actions.runSchedule(schedule.id, 'bo')])
    assert.equal(clicks.filter(Boolean).length, 2, 'two clicks are two runs')
    assert.equal(hub.state.schedules![0].runs!.length, 4, 'and both are kept')
  })


  it('fires once for each time it’s due, whoever asks', async () => {
    const { hub, actions } = await setUp()
    const schedule = await actions.addSchedule('ana', { noteId: 'n1', cron: '0 2 * * *', tz: 'UTC' })
    const due = '2026-11-02T02:00:00.000Z'
    const runs = await Promise.all([actions.runSchedule(schedule.id, undefined, due), actions.runSchedule(schedule.id, undefined, due)])
    assert.equal(runs.filter(Boolean).length, 1)
    assert.equal(hub.state.cards.length, 1)
  })

  it('isn’t held up by a run in review or one gone quiet, but doesn’t pile up behind one nobody took', async () => {
    const { hub, actions, scheduler, clock, later } = await setUp()
    const schedule = await actions.addSchedule('ana', { noteId: 'n1', agentId: 'other', cron: '0 * * * *', tz: 'UTC', staleHours: 2 })
    const fire = async () => {
      later(hour)
      await scheduler.tick()
      return hub.state.cards.length
    }
    assert.equal(await fire(), 1)
    assert.equal(await fire(), 1, 'nobody took it')
    assert.match(hub.state.schedules![0].lastSkipped ?? '', /nobody has taken it/)
    const first = hub.state.cards[0]
    await actions.claim('other', first.id)
    await hub.record({ kind: 'hub' }, { type: 'card.activity', id: first.id, activity: { at: clock.at.toISOString(), by: 'other', kind: 'said', text: 'Working' } })
    assert.equal(await fire(), 1, 'going, and recently')
    assert.equal(await fire(), 1, 'still within its hours')
    assert.equal(await fire(), 2, 'gone quiet: the next goes ahead')
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: hub.state.cards[1].id, fields: { stage: 'review', agentId: 'other' } })
    assert.equal(await fire(), 3, 'in review it waits on a person, and holds nothing up')
    const runs = hub.state.schedules!.find((s) => s.id === schedule.id)!.runs!
    assert.ok(runs.some((r) => r.skipped) && runs.some((r) => r.cardId))
    assert.ok(runs.length <= 20)
  })

  it('says why, and turns off, when what it needs is gone', async () => {
    const { hub, actions, scheduler, later } = await setUp()
    const schedule = await actions.addSchedule('ana', { noteId: 'n1', agentId: 'other', cron: '0 * * * *', tz: 'UTC' })
    await hub.record({ kind: 'hub' }, { type: 'agent.revoke', id: 'other' })
    later(hour)
    await scheduler.tick()
    const off = hub.state.schedules!.find((s) => s.id === schedule.id)!
    assert.equal(off.enabled, false)
    assert.match(off.failing ?? '', /agent was removed/)
    assert.equal(hub.state.cards.length, 0)
    await actions.updateSchedule('ana', schedule.id, { agentId: 'fixer1', enabled: true })
    assert.equal(hub.state.schedules!.find((s) => s.id === schedule.id)!.failing, undefined)
  })
})

describe('agents talking to each other', () => {
  async function working() {
    const set = await setUp()
    const made = async (agentId: string, title: string) => {
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title, meantFor: agentId })
      await set.actions.claim(agentId, card.id)
      return card
    }
    return { ...set, mine: await made('fixer1', 'Mine'), theirs: await made('fixer2', 'Theirs') }
  }
  const conversation = async (call: Awaited<ReturnType<Awaited<ReturnType<typeof setUp>>['tools']>>, id: string) => ((await call('get_task', { id })).value.conversation ?? []) as { kind: string; to_me?: boolean; text: string; by: string }[]

  it('reaches the other’s card and shows on both, marked for whom it’s meant', async () => {
    const { hub, tools, mine, theirs } = await working()
    const one = await tools('fixer1')
    const two = await tools('fixer2')
    const sent = await one('message_agent', { to: 'fixer2', text: 'What shape is your API?' })
    assert.equal(sent.error, false, sent.text)
    const heard = await conversation(two, theirs.id)
    assert.deepEqual(heard.map((c) => [c.by, c.kind, c.to_me, c.text]), [['fixer1', 'message', true, 'What shape is your API?']])
    assert.equal((await conversation(one, mine.id))[0].to_me, false, 'not said back to its sender')
    assert.ok(hub.state.cards.find((c) => c.id === theirs.id)!.activity.some((a) => a.kind === 'message' && a.to === 'fixer2'))
    assert.match((await one('message_agent', { to: 'fixer1', text: 'Me' })).text, /That’s you/)
    assert.match((await one('message_agent', { to: 'scanner', text: 'Hello' })).text, /isn’t working on anything/)
  })

  it('doesn’t bring a person’s last word back to the agent, or count as one', async () => {
    const { hub, actions, tools, theirs } = await working()
    await actions.comment('ana', theirs.id, 'Please look again.')
    const { resumeFor } = await import('../../shared/work.ts')
    const fixer2 = hub.state.agents.find((a) => a.id === 'fixer2')!
    assert.equal(resumeFor(hub.state, fixer2)?.id, theirs.id)
    await (await tools('fixer1'))('message_agent', { to: 'fixer2', text: 'A word' })
    assert.equal(resumeFor(hub.state, fixer2)?.id, theirs.id, 'its message doesn’t hide that a person spoke')
    assert.equal(hub.state.cards.find((c) => c.id === theirs.id)!.stage, 'working')
  })

  it('stops two agents going round in circles', async () => {
    const { tools } = await working()
    const one = await tools('fixer1')
    const two = await tools('fixer2')
    let refused
    for (let i = 0; i < 25 && !refused; i++) {
      const sent = await (i % 2 ? two : one)('message_agent', { to: i % 2 ? 'fixer1' : 'fixer2', text: `Message ${i}` })
      if (sent.error) refused = { i, text: sent.text }
    }
    assert.equal(refused?.i, 20)
    assert.match(refused?.text ?? '', /ask a person/)
  })

  it('stays in the binders the sender works in, and out of a Challenge', async () => {
    const { hub, actions, tools, theirs } = await working()
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b2', name: 'Elsewhere' } })
    await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: agent('elsewhere', ['b2']) })
    assert.match((await (await tools('elsewhere'))('message_agent', { to: 'fixer2', text: 'Hello' })).text, /isn’t working on anything in a binder you share/)
    // The card it's challenging is in review, the author busy on another: neither may talk to the other.
    const challenged = await actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Challenged', meantFor: 'fixer2' })
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: challenged.id, fields: { agentId: 'fixer2', stage: 'review', challenge: { state: 'asked', agentId: 'other', askedAt: new Date().toISOString(), askedBy: 'ana' } as never } })
    assert.match((await (await tools('other'))('message_agent', { to: 'fixer2', text: 'Why did you do that?' })).text, /a Challenge judges the code/)
    const author = await actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Reviewer busy', meantFor: 'other' })
    await actions.claim('other', author.id)
    assert.match((await (await tools('fixer2'))('message_agent', { to: 'other', text: 'Go easy on me' })).text, /a Challenge judges the code/)
    assert.ok(hub.state.cards.find((c) => c.id === theirs.id))
  })
})
