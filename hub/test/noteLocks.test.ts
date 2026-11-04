import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Actions } from '../src/actions.ts'
import { Hub, Refused } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { mcpServer } from '../src/mcp.ts'
import { commentOn, decide, propose, setLock } from '../src/noteChanges.ts'
import { GitNotesSaver } from '../src/savers/gitNotes.ts'
import { binderContext, guideMost, guideOf } from '../../shared/guide.ts'
import { fromMarkdown, lineDiff } from '../../shared/notes.ts'

// A locked note stays as a person settled it, whichever way a change comes, and everyone else proposes.

const person = (login: string) => ({ kind: 'user' as const, login })
const agent = { kind: 'agent' as const, id: 'a1' }

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Payments', repo: 'acme/pay' } }, { type: 'binder.put', binder: { id: 'b2', name: 'Other' } }])
  hub.lockManager = (login) => login === 'boss'
  const note = (id: string, text: string, binderId = 'b1', folderId?: string) => hub.record({ kind: 'hub' }, { type: 'note.put', note: { id, title: id, binderId, folderId, text, editedAt: new Date().toISOString(), editors: [] } })
  await note('n1', '# Standards\n\nUse tabs.\n')
  const edit = (who: Parameters<Hub['record']>[0], text: string, id = 'n1') => hub.record(who, { type: 'note.edit', id, text, title: id, by: 'x', at: new Date().toISOString() })
  const stored = (id = 'n1') => hub.state.notes.find((n) => n.id === id)!
  return { hub, note, edit, stored }
}

describe('a locked note', () => {
  it('can be changed only by who locked it and the Binder’s owners and admins', async () => {
    const { hub, edit, stored } = await setUp()
    await edit(agent, 'An agent’s words, while it’s open.')
    await setLock(hub, 'sam', false, 'n1', true)
    assert.equal(stored().locked?.by, 'sam')

    await assert.rejects(edit(agent, 'no'), Refused)
    await assert.rejects(edit(person('pat'), 'no'), /locked by @sam/)
    await assert.rejects(hub.record(agent, { type: 'note.move', id: 'n1', binderId: 'b2' }), Refused)
    await assert.rejects(hub.record(person('pat'), { type: 'note.delete', id: 'n1' }), Refused)
    await assert.rejects(hub.submit('pat', 'tab-tab', [{ id: 'c1', change: { type: 'note.edit', id: 'n1', text: 'no', title: 'n1', by: 'pat', at: 'now' } }]), Refused)
    await assert.rejects(hub.submit('pat', 'tab-tab', [{ id: 'c2', change: { type: 'note.put', note: { ...stored(), text: 'no', locked: undefined } } }]), Refused)
    assert.equal(stored().text, 'An agent’s words, while it’s open.')

    await edit(person('SAM'), 'Who locked it.')
    await edit(person('boss'), 'An owner.')
    assert.equal(stored().text, 'An owner.')
  })

  it('can’t be unlocked by anyone else, or have its lock written away', async () => {
    const { hub, stored } = await setUp()
    await setLock(hub, 'sam', false, 'n1', true)
    await assert.rejects(setLock(hub, 'pat', false, 'n1', false), /Only @sam/)
    // Writing it whole, as the one who locked it, keeps the lock.
    await hub.submit('sam', 'tab-tab', [{ id: 'c1', change: { type: 'note.put', note: { ...stored(), text: 'Again', locked: undefined } } }])
    assert.equal(stored().locked?.by, 'sam')
    assert.equal(stored().text, 'Again')
    // And a lock can't be written on.
    await hub.submit('pat', 'tab-tab', [{ id: 'c2', change: { type: 'note.put', note: { id: 'new', title: 'new', binderId: 'b1', text: 'x', editedAt: 'now', editors: [], locked: { by: 'pat', at: 'now' } } } }])
    assert.equal(stored('new').locked, undefined)
    await hub.submit('pat', 'tab-tab', [{ id: 'c3', change: { type: 'note.lock', id: 'n1' } as never }]).then(() => assert.fail('a client can’t send a lock'), (error: Error) => assert.ok(error instanceof Refused))
    await setLock(hub, 'boss', true, 'n1', false)
    assert.equal(stored().locked, undefined)
  })

  it('takes a proposal from anyone, talked over and decided by who may change it', async () => {
    const { hub, stored } = await setUp()
    await assert.rejects(propose(hub, agent, 'a1', 'n1', 'x', 'because'), /isn’t locked/)
    await setLock(hub, 'sam', false, 'n1', true)
    await assert.rejects(propose(hub, agent, 'a1', 'n1', 'x', ' '), /Say why/)

    const proposal = await propose(hub, agent, 'a1', 'n1', '# Standards\n\nUse spaces.\n', 'The formatter uses spaces.')
    await commentOn(hub, person('pat'), 'pat', proposal.id, 'Agreed.')
    assert.deepEqual(hub.state.noteProposals[0].comments.map((c) => c.by), ['pat'])

    await assert.rejects(decide(hub, 'pat', false, proposal.id, true), /Only @sam/)
    assert.match(stored().text, /tabs/)
    await decide(hub, 'sam', false, proposal.id, true)
    assert.match(stored().text, /spaces/)
    assert.equal(stored().editedBy, 'a1', 'the words are the proposer’s')
    assert.equal(stored().locked?.by, 'sam', 'still locked')
    assert.equal(hub.state.noteProposals[0].state, 'accepted')
    await assert.rejects(decide(hub, 'sam', false, proposal.id, true), /been decided/)
  })

  it('won’t take a proposal over changes made since, and can turn one down', async () => {
    const { hub, edit, stored } = await setUp()
    await setLock(hub, 'sam', false, 'n1', true)
    const stale = await propose(hub, agent, 'a1', 'n1', 'Theirs', 'why')
    await edit(person('sam'), 'Sam moved on.')
    await assert.rejects(decide(hub, 'sam', false, stale.id, true), /changed since/)
    assert.equal(stored().text, 'Sam moved on.')
    await decide(hub, 'sam', false, stale.id, false)
    assert.equal(hub.state.noteProposals[0].state, 'rejected')
    assert.equal(stored().text, 'Sam moved on.')
  })

  it('tells an agent through its tools: refused an edit, and proposing instead', async () => {
    const { hub, stored } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: { id: 'a1', name: 'Builder', owner: 'sam', provider: 'claude', repos: [], binders: ['b1'], skills: [], createdAt: 'then' } as never })
    await setLock(hub, 'sam', false, 'n1', true)
    const client = new Client({ name: 'a1', version: '1' })
    const [ours, theirs] = InMemoryTransport.createLinkedPair()
    await Promise.all([mcpServer(hub, new Actions(hub, { forRepo: async () => undefined } as never), 'a1', { issueToken: async () => 'unused', publicUrl: 'http://hub.test' }).connect(theirs), client.connect(ours)])
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      return { text: result.content[0].text, error: !!result.isError }
    }
    try {
      const edited = await call('edit_note', { id: 'n1', text: 'mine now' })
      assert.equal(edited.error, true)
      assert.match(edited.text, /locked by @sam/)
      assert.match(JSON.parse((await call('get_note', { id: 'n1' })).text).locked.note, /propose_note_change/)

      const proposed = await call('propose_note_change', { id: 'n1', find: 'Use tabs.', replace: 'Use spaces.', why: 'The formatter uses spaces.' })
      assert.equal(proposed.error, false, proposed.text)
      assert.match(hub.state.noteProposals[0].text, /Use spaces/)
      assert.match(stored().text, /Use tabs/)
      assert.equal(JSON.parse((await call('get_note', { id: 'n1' })).text).open_proposals[0].why, 'The formatter uses spaces.')
      assert.equal((await call('reply_to_note_proposal', { id: hub.state.noteProposals[0].id, text: 'Here’s why.' })).error, false)
    } finally {
      await client.close()
    }
  })

  it('keeps a version for each lock and accepted proposal, and each can be read back', async () => {
    const { hub, stored } = await setUp()
    const dir = await mkdtemp(join(tmpdir(), 'binders-versions-'))
    const notes = new GitNotesSaver(hub, { dir, author: { name: 'T', email: 't@binders.invalid' }, quietMs: 100_000, longestMs: 100_000 })
    await notes.start()
    try {
      await setLock(hub, 'sam', false, 'n1', true)
      await notes.version('n1', 'Locked by @sam')
      const proposal = await propose(hub, agent, 'a1', 'n1', '# Standards\n\nUse spaces.\n', 'why')
      await decide(hub, 'sam', false, proposal.id, true)
      await notes.version('n1', 'Accepted')
      const commits = await notes.history('n1')
      assert.deepEqual(commits.map((c) => c.subject), ['Accepted', 'Locked by @sam', 'Notes as the hub has them'])
      assert.match(fromMarkdown((await notes.at('n1', commits[2].sha))!), /^# Standards\n\nUse tabs/)
      assert.match((await notes.at('n1', commits[1].sha))!, /locked_by: sam/)
      assert.match(stored().text, /spaces/)
    } finally {
      await notes.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('what every run reads first', () => {
  it('has how Binders works, the binder’s guide and where to look, as they are now', async () => {
    const { hub, note, stored } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'f1', binderId: 'b1', name: 'Runbooks' } })
    await note('n2', '# Deploying\n\nHow.', 'b1', 'f1')
    await note('guide', '# Payments guide\n\nRead [[Standards]] first.')
    await note('n9', '# Elsewhere\n\nAnother binder’s secret.', 'b2')
    assert.match(binderContext(hub.state, 'b1'), /has no guide yet/)

    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { ...hub.state.binders[0], guideNoteId: 'guide' } })
    await setLock(hub, 'sam', false, 'n1', true)
    const said = binderContext(hub.state, 'b1', 'n2')
    assert.match(said, /propose_note_change/)
    assert.match(said, /## This binder: Payments\n# Payments guide\n\nRead \[\[Standards\]\] first\./)
    assert.match(said, /Repo: acme\/pay/)
    assert.match(said, /Runbooks: Deploying \(n2\)/)
    assert.match(said, /The note your work came from: Deploying \(n2\)/)
    assert.match(said, /Standards \(n1\), locked/)
    assert.doesNotMatch(said, /Another binder/)
    assert.doesNotMatch(said, /Elsewhere/)

    // Always the note as it is now.
    await hub.record({ kind: 'hub' }, { type: 'note.edit', id: 'guide', text: '# Payments guide\n\nNew words.', title: 'g', by: 'x', at: 'now' })
    assert.match(binderContext(hub.state, 'b1'), /New words/)
    assert.equal(stored('guide').text.includes('New words'), true)
  })

  it('doesn’t let a guide or a big binder fill every run, and points to the rest', async () => {
    const { hub, note } = await setUp()
    await note('guide', `# Guide\n\n${'x'.repeat(guideMost * 2)}`)
    for (let i = 0; i < 300; i++) await note(`note-${i}`, `# A note with a fairly long title, number ${i}`)
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { ...hub.state.binders[0], guideNoteId: 'guide' } })
    assert.match(guideOf(hub.state, 'b1')!.text, /get_note guide has the rest/)
    const said = binderContext(hub.state, 'b1')
    assert.ok(said.length < guideMost + 5000, `${said.length} characters`)
    assert.match(said, /\d+ more: list_notes has them\./)
  })

  it('won’t read a guide from another binder, whatever the binder points to', async () => {
    const { hub, note } = await setUp()
    await note('theirs', '# Their guide', 'b2')
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { ...hub.state.binders[0], guideNoteId: 'theirs' } })
    assert.equal(guideOf(hub.state, 'b1'), undefined)
    assert.doesNotMatch(binderContext(hub.state, 'b1'), /Their guide/)
  })

  it('shows two versions line by line', () => {
    const kinds = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.kind}${l.text}`)
    assert.deepEqual(kinds('a\nb\nc', 'a\nx\nc'), [' a', '+x', '-b', ' c'])
    assert.deepEqual(kinds('a', 'a'), [' a'])
    assert.deepEqual(kinds('a\nb', 'a\nb\nc'), [' a', ' b', '+c'])
  })
})
