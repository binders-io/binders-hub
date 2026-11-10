import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import type { GitHub } from '../src/github.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub, Refused } from '../src/hub.ts'
import { emptyBatch, putBack, trashMs } from '../src/history.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Scheduler } from '../src/scheduler.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Member, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import { lightChange, lightState } from '../../shared/light.ts'
import { applyChange, emptyState } from '../../shared/state.ts'
import { trashKept } from '../../shared/notes.ts'
import type { Card, Proposal } from '../../shared/work.ts'
import { note, seed, until } from './helpers.ts'

// What's deleted goes to the Binder’s trash, whole, with who deleted it and when, and can be put back for thirty days.

const at = '2026-11-09T10:00:00.000Z'
const person = (login: string) => ({ kind: 'user' as const, login })
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: 'Do it', doneWhen: 'It is done', size: 'M', stage: 'ready', createdAt: at, createdBy: 'ana', updatedAt: at, waitsFor: [], activity: [{ at, by: 'ana', kind: 'created', text: 'Made it' }], ...extra })
const proposal = (id: string, noteId: string, state: Proposal['state'] = 'new'): Proposal => ({ id, binderId: 'b1', noteId, title: `Do ${id}`, quote: '', brief: '', doneWhen: '', size: 'S', by: 'builder', state })

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  return hub
}

describe('deleting a note', () => {
  it('moves it to the trash, whole, with who deleted it and when, and leaves every list as it does now', async () => {
    const hub = await setUp()
    const first = hub.state.notes[0]
    await hub.submit('ana', 'tab-1234', [{ id: 'd1', change: { type: 'note.delete', id: 'n1' } }])
    assert.deepEqual(hub.state.notes, [])
    assert.equal(hub.state.trashedNotes?.length, 1)
    const [trashed] = hub.state.trashedNotes!
    assert.deepEqual(trashed.note, first)
    assert.equal(trashed.by, 'ana')
    assert.ok(Math.abs(Date.now() - Date.parse(trashed.at)) < 5000)
    // The log has who and when beside the change, for every hub on it.
    const [entry] = (await hub.read(0)).filter((e) => e.change.type === 'note.delete')
    assert.deepEqual(entry.change, { type: 'note.delete', id: 'n1', by: 'ana', at: trashed.at })
  })

  it('says who deleted it itself, whatever a client wrote in the change', async () => {
    const hub = await setUp()
    await hub.submit('ana', 'tab-1234', [{ id: 'd1', change: { type: 'note.delete', id: 'n1', by: 'someone-else', at: '2020-01-01T00:00:00.000Z' } as never }])
    assert.equal(hub.state.trashedNotes![0].by, 'ana')
    assert.ok(hub.state.trashedNotes![0].at > '2026')
  })

  it('is the same from the hub’s own side: an agent, or the apps through the link', async () => {
    const hub = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: { id: 'a1', name: 'Builder', provider: 'claude', owner: 'ana', repos: [], binders: [], skills: [], createdAt: at } })
    await hub.record({ kind: 'agent', id: 'a1' }, { type: 'note.delete', id: 'n1' })
    assert.equal(hub.state.trashedNotes![0].by, 'Builder')
  })

  it('dismisses what was proposed from it that’s still new, and brings it back with the note', async () => {
    const hub = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'proposal.put', proposal: proposal('p1', 'n1') })
    await hub.record({ kind: 'hub' }, { type: 'proposal.put', proposal: proposal('p2', 'n1', 'accepted') })
    await hub.record({ kind: 'hub' }, { type: 'proposal.put', proposal: proposal('p3', 'n1', 'dismissed') })
    await hub.record({ kind: 'hub' }, { type: 'proposal.put', proposal: proposal('p4', 'other') })
    const states = () => hub.state.proposals.map((p) => `${p.id}:${p.state}`)
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    assert.deepEqual(states(), ['p1:dismissed', 'p2:accepted', 'p3:dismissed', 'p4:new'])
    assert.deepEqual(hub.state.trashedNotes![0].dismissed, ['p1'])
    await putBack(hub, 'bo', 'note', 'n1')
    assert.deepEqual(states(), ['p1:new', 'p2:accepted', 'p3:dismissed', 'p4:new'], 'only the one that was dismissed with it')
  })
})

describe('putting a note back', () => {
  it('returns it as it was, to its folder, with its lock', async () => {
    const hub = await setUp()
    await hub.record(person('ana'), { type: 'note.lock', id: 'n1', locked: { by: 'ana', at } })
    const was = hub.state.notes[0]
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    const done = await putBack(hub, 'bo', 'note', 'n1')
    assert.equal(done.title, 'First note')
    assert.deepEqual(hub.state.notes, [was])
    assert.equal(hub.state.notes[0].folderId, 'f1')
    assert.equal(hub.state.notes[0].locked?.by, 'ana')
    assert.deepEqual(hub.state.trashedNotes, [])
    assert.equal(hub.state.history!.at(-1)!.text, 'Put back the note “First note”.')
    assert.equal(hub.state.history!.at(-1)!.by, 'bo')
  })

  it('goes to the top of its binder when its folder is gone', async () => {
    const hub = await setUp()
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    await hub.record(person('ana'), { type: 'folder.delete', id: 'f1' })
    await putBack(hub, 'ana', 'note', 'n1')
    assert.equal(hub.state.notes[0].folderId, undefined)
    assert.equal(hub.state.notes[0].binderId, 'b1')
  })

  it('refuses what isn’t in the trash, or whose binder is gone, and only once', async () => {
    const hub = await setUp()
    await assert.rejects(putBack(hub, 'ana', 'note', 'nope'), { message: 'That isn’t in the trash any more.' })
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    await putBack(hub, 'ana', 'note', 'n1')
    await assert.rejects(putBack(hub, 'ana', 'note', 'n1'), Refused)
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    await hub.record(person('ana'), { type: 'folder.delete', id: 'f1' })
    await hub.record(person('ana'), { type: 'binder.delete', id: 'b1' })
    await assert.rejects(putBack(hub, 'ana', 'note', 'n1'), /binder it was in is gone/)
  })

  it('can’t be claimed by a client: only the hub says a note or a card was put back', async () => {
    const hub = await setUp()
    await assert.rejects(hub.submit('ana', 'tab-1234', [{ id: 'x1', change: { type: 'note.put', note: note('n5', 'Mine'), restored: { by: 'ana', at } } }]), /put back from the trash/)
    await assert.rejects(hub.submit('ana', 'tab-1234', [{ id: 'x2', change: { type: 'card.put', card: card('c5'), restored: { by: 'ana', at } } }]), /put back from the trash/)
  })
})

describe('deleting a card', () => {
  it('moves it to the trash, whole with its activity, and leaves the board as it does now', async () => {
    const hub = await setUp()
    const whole = card('c1', { activity: [{ at, by: 'ana', kind: 'created', text: 'Made it' }, { at, by: 'ana', kind: 'comment', text: 'Hello' }] })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: whole })
    await hub.submit('ana', 'tab-1234', [{ id: 'd1', change: { type: 'card.delete', id: 'c1' } }])
    assert.deepEqual(hub.state.cards, [])
    assert.deepEqual(hub.state.trashedCards![0].card, whole)
    assert.equal(hub.state.trashedCards![0].by, 'ana')
  })

  it('is put back in its stage with no agent holding it, a card that was being worked in Ready', async () => {
    const hub = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { stage: 'review', agentId: 'a1', progress: 1, doing: 'Waiting for review', prId: 'acme/web#3' }) })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c2', { stage: 'working', agentId: 'a1', progress: 0.4, doing: 'Reading the code', permission: { request: 'r1', agent: 'a1', tool: 'Bash', what: 'ls', at } }) })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c3', { stage: 'blocked', needsYou: 'Which one?' }) })
    for (const id of ['c1', 'c2', 'c3']) await hub.record(person('ana'), { type: 'card.delete', id })
    for (const id of ['c1', 'c2', 'c3']) await putBack(hub, 'bo', 'card', id)
    const by = (id: string) => hub.state.cards.find((c) => c.id === id)!
    assert.equal(by('c1').stage, 'review')
    assert.equal(by('c1').prId, 'acme/web#3')
    assert.equal(by('c2').stage, 'ready')
    assert.equal(by('c3').stage, 'blocked')
    assert.equal(by('c3').needsYou, 'Which one?')
    for (const id of ['c1', 'c2', 'c3']) {
      assert.equal(by(id).agentId, undefined)
      assert.equal(by(id).doing, undefined)
      assert.equal(by(id).progress, undefined)
      assert.equal(by(id).permission, undefined)
      // As it was, and one more line to say it came back.
      assert.deepEqual(by(id).activity.slice(0, 1), [{ at, by: 'ana', kind: 'created', text: 'Made it' }])
      assert.equal(by(id).activity.at(-1)!.text, 'Put back from the trash')
      assert.equal(by(id).activity.at(-1)!.by, 'bo')
    }
    assert.deepEqual(hub.state.trashedCards, [])
    assert.equal(hub.state.history!.at(-1)!.text, 'Put back the card “Card c3”.')
  })
})

describe('what a browser holds', () => {
  it('has neither the trash nor who deleted what: its own copy of a deletion is the plain one', async () => {
    const hub = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1') })
    await hub.record(person('ana'), { type: 'card.delete', id: 'c1' })
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    const light = lightState(hub.state)
    assert.equal('trashedNotes' in light, false)
    assert.equal('trashedCards' in light, false)
    const deletes = (await hub.read(0)).filter((e) => e.change.type.endsWith('.delete')).map((e) => lightChange(e.change))
    assert.deepEqual(deletes, [{ type: 'card.delete', id: 'c1' }, { type: 'note.delete', id: 'n1' }])
    // Applied there, no trash grows in the tab, and the lists are the hub’s.
    let tab = light
    for (const change of deletes) tab = applyChange(tab, change)
    assert.equal('trashedNotes' in tab, false)
    assert.deepEqual(tab.notes, hub.state.notes)
    assert.deepEqual(tab.cards, hub.state.cards)
  })

  it('sees a note put back as the note it was, from the change an older tab already knows', async () => {
    const hub = await setUp()
    await hub.record(person('ana'), { type: 'note.delete', id: 'n1' })
    await putBack(hub, 'ana', 'note', 'n1')
    const put = (await hub.read(0)).filter((e) => e.change.type === 'note.put').at(-1)!.change
    assert.equal(put.type, 'note.put')
    let tab = lightState(emptyState())
    tab = applyChange(tab, put)
    assert.equal(tab.notes[0].title, 'First note')
  })

  it('a log read again from its start, with deletions from before the trash, doesn’t fill it', () => {
    let state = emptyState()
    state = applyChange(state, { type: 'binder.put', binder: { id: 'b1', name: 'Server' } })
    state = applyChange(state, { type: 'note.put', note: note('n1', 'Old') })
    state = applyChange(state, { type: 'note.delete', id: 'n1' })
    assert.equal(state.trashedNotes, undefined)
    assert.deepEqual(state.notes, [])
  })
})

describe('how much the trash holds, and for how long', () => {
  it('holds at most 200 notes and 200 cards, the oldest going first', async () => {
    let state = emptyState()
    for (let n = 0; n < trashKept + 5; n++) {
      state = applyChange(state, { type: 'note.put', note: note(`n${n}`, `Note ${n}`) })
      state = applyChange(state, { type: 'card.put', card: card(`c${n}`) })
      state = applyChange(state, { type: 'note.delete', id: `n${n}`, by: 'ana', at })
      state = applyChange(state, { type: 'card.delete', id: `c${n}`, by: 'ana', at })
    }
    assert.equal(state.trashedNotes!.length, 200)
    assert.equal(state.trashedCards!.length, 200)
    assert.equal(state.trashedNotes![0].note.id, 'n5')
    assert.equal(state.trashedCards!.at(-1)!.card.id, 'c204')
  })

  it('lets go of what’s older than thirty days, a few at a time, and keeps the rest', async () => {
    const hub = await setUp()
    const { connection } = { connection: new GitHubConnection(new MemoryKV(), new Sealer('x'), { webUrl: 'http://unused', apiUrl: 'http://unused' }, {}) }
    const actions = new Actions(hub, connection)
    for (let n = 0; n < 5; n++) {
      await hub.record({ kind: 'hub' }, { type: 'note.put', note: note(`x${n}`, `Note ${n}`) })
      await hub.record({ kind: 'hub' }, { type: 'card.put', card: card(`k${n}`) })
      await hub.record(person('ana'), { type: 'note.delete', id: `x${n}` })
      await hub.record(person('ana'), { type: 'card.delete', id: `k${n}` })
    }
    assert.equal(emptyBatch, 20)
    // Not yet thirty days: nothing goes, even a day short.
    let clock = new Date(Date.now() + trashMs - 60_000)
    const scheduler = new Scheduler(hub, actions, { now: () => clock, tidyBatch: 4 })
    await scheduler.tick()
    assert.equal(hub.state.trashedNotes!.length, 5)
    assert.equal(hub.state.trashedCards!.length, 5)
    // Past it, four a pass, notes first and the oldest first.
    clock = new Date(Date.now() + trashMs + 60_000)
    await scheduler.tick()
    assert.deepEqual(hub.state.trashedNotes!.map((t) => t.note.id), ['x4'])
    assert.equal(hub.state.trashedCards!.length, 5)
    await scheduler.tick()
    assert.equal(hub.state.trashedNotes!.length, 0)
    assert.equal(hub.state.trashedCards!.length, 2)
    await scheduler.tick()
    await scheduler.tick()
    assert.equal(hub.state.trashedCards!.length, 0)
    await assert.rejects(putBack(hub, 'ana', 'note', 'x0'), /isn’t in the trash any more/)
    // A newer one, put there after, stays.
    clock = new Date(Date.now() + trashMs - 60_000)
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: note('x9', 'Newer') })
    await hub.record(person('ana'), { type: 'note.delete', id: 'x9' })
    await scheduler.tick()
    assert.equal(hub.state.trashedNotes!.length, 1)
  })
})

describe('the trash, from the web', () => {
  async function serve(members: Member[] = [{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }]) {
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const make = async (id: string): Promise<Space> => {
      const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
      const hub = new Hub(new MemoryLog())
      await hub.start(seed())
      const actions = new Actions(hub, github)
      return { id, hub, actions, github, webhooks: new Webhooks(hub, actions), stop: async () => undefined }
    }
    const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members })
    const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const as = async (login: string) => {
      const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
      const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
      return async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', 'x-binders-space': 'acme', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      }
    }
    return { spaces, hub: () => spaces.get('acme')!.hub, as, close: () => app.close() }
  }
  const change = (who: Awaited<ReturnType<Awaited<ReturnType<typeof serve>>['as']>>, ...list: { type: string; [key: string]: unknown }[]) => who('POST', '/api/changes', { client: 'tab-1234', changes: list.map((c, i) => ({ id: `c${Math.random().toString(36).slice(2, 8)}${i}`, change: c })) })

  it('lists what’s there without its contents, newest first, and puts it back for anyone in the Binder', async () => {
    const { as, hub, close } = await serve()
    const ana = await as('ana')
    const cy = await as('cy')
    await change(ana, { type: 'card.put', card: card('c1', { title: 'Plan it' }) })
    await change(ana, { type: 'note.delete', id: 'n1' })
    await sleep(5)
    await change(ana, { type: 'card.delete', id: 'c1' })
    const listed = (await cy('GET', '/api/trash')).body.items
    assert.deepEqual(listed.map((i: { kind: string; id: string; title: string; by: string }) => [i.kind, i.id, i.title, i.by]), [['card', 'c1', 'Plan it', 'ana'], ['note', 'n1', 'First note', 'ana']])
    assert.deepEqual(Object.keys(listed[0]).sort(), ['at', 'binderId', 'by', 'id', 'kind', 'title'])
    assert.equal((await cy('POST', '/api/trash/note/n1/restore')).body.title, 'First note')
    assert.equal((await cy('POST', '/api/trash/card/c1/restore')).status, 200)
    assert.equal(hub().state.notes.length, 1)
    assert.equal(hub().state.cards[0].id, 'c1')
    assert.deepEqual((await ana('GET', '/api/trash')).body.items, [])
    const again = await ana('POST', '/api/trash/note/n1/restore')
    assert.equal(again.status, 422)
    assert.equal(again.body.error, 'That isn’t in the trash any more.')
    assert.equal((await ana('POST', '/api/trash/folder/f1/restore')).status, 422)
    await close()
  })

  it('is for people in the Binder only', async () => {
    const { as, close } = await serve()
    const mal = await as('mal')
    assert.equal((await mal('GET', '/api/trash')).status, 403)
    assert.equal((await mal('POST', '/api/trash/note/n1/restore')).status, 403)
    await close()
  })
})

describe('a deleted card’s GitHub issue', () => {
  interface Call { what: 'close' | 'open' | 'comment'; number: number; body?: string }
  async function inGitHub(options: { reachable?: () => boolean } = {}) {
    const calls: Call[] = []
    const github = {
      updateIssue: async (_repo: string, number: number, fields: { state?: string }) => { calls.push({ what: fields.state === 'closed' ? 'close' : 'open', number }); return { number, html_url: '' } },
      createComment: async (_repo: string, number: number, body: string) => { calls.push({ what: 'comment', number, body }); return { id: 1, html_url: '' } },
      createIssue: async () => ({ number: 7, html_url: 'https://github.test/acme/web/issues/7' }),
    } as unknown as GitHub
    const hub = new Hub(new MemoryLog())
    await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } }])
    const saver = new IssuesSaver(hub, { forRepo: async () => (options.reachable?.() ?? true) ? github : undefined }, { quietMs: 10 })
    saver.start()
    const given = { repo: 'acme/web', number: 7, url: 'https://github.test/acme/web/issues/7' }
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { issue: given }) })
    // Its first save, which has nothing to change, is let finish first.
    await sleep(60)
    calls.length = 0
    return { hub, saver, calls }
  }

  it('is closed with a word on who deleted it, and opened again when it’s put back', async () => {
    const { hub, calls, saver } = await inGitHub()
    await hub.submit('ana', 'tab-1234', [{ id: 'd1', change: { type: 'card.delete', id: 'c1' } }])
    await until(() => calls.length === 2)
    assert.deepEqual(calls.map((c) => [c.what, c.number]), [['close', 7], ['comment', 7]])
    assert.equal(calls[1].body, 'This card was deleted on Binders by @ana. If it’s put back within 30 days, this issue opens again.')
    await putBack(hub, 'bo', 'card', 'c1')
    await until(() => calls.length === 3)
    assert.deepEqual(calls[2], { what: 'open', number: 7 })
    await saver.stop()
  })

  it('names an agent and the hub as they are, not as people', async () => {
    const { hub, calls, saver } = await inGitHub()
    await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: { id: 'a1', name: 'Builder', provider: 'claude', owner: 'ana', repos: [], binders: [], skills: [], createdAt: at } })
    await hub.record({ kind: 'agent', id: 'a1' }, { type: 'card.delete', id: 'c1' })
    await until(() => calls.length === 2)
    assert.match(calls[1].body!, /deleted on Binders by Builder\./)
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c2', { issue: { repo: 'acme/web', number: 8, url: '' } }) })
    await sleep(60)
    calls.length = 0
    await hub.record({ kind: 'hub' }, { type: 'card.delete', id: 'c2' })
    await until(() => calls.length === 2)
    assert.match(calls[1].body!, /by the hub\./)
    await saver.stop()
  })

  it('is tried again with the next save when GitHub can’t be reached, and only the comment again once it’s closed', async () => {
    let reachable = false
    const { hub, calls, saver } = await inGitHub({ reachable: () => reachable })
    await hub.record(person('ana'), { type: 'card.delete', id: 'c1' })
    await sleep(80)
    assert.equal(calls.length, 0)
    reachable = true
    // Any card’s next save takes it up.
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c2', { title: 'Another' }) })
    await until(() => calls.length === 2)
    assert.deepEqual(calls.map((c) => c.what), ['close', 'comment'])
    await sleep(60)
    assert.equal(calls.length, 2, 'once')
    await saver.stop()
  })

  it('is left alone when it’s put back before GitHub was told, when the card had none, or when issues are off', async () => {
    const { hub, calls, saver } = await inGitHub()
    await hub.record(person('ana'), { type: 'card.delete', id: 'c1' })
    await putBack(hub, 'ana', 'card', 'c1')
    await sleep(100)
    assert.equal(calls.length, 0, 'nothing was closed, so nothing is opened')
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c3') })
    await sleep(60)
    calls.length = 0
    await hub.record(person('ana'), { type: 'card.delete', id: 'c3' })
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web', issues: false } })
    await hub.record(person('ana'), { type: 'card.delete', id: 'c1' })
    await sleep(100)
    assert.equal(calls.length, 0)
    await saver.stop()
  })
})
