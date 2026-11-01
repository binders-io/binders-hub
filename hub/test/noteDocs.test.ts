import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Hub, Refused } from '../src/hub.ts'
import { MemoryLog, RedisLog } from '../src/log.ts'
import { GitNotesSaver } from '../src/savers/gitNotes.ts'
import { applyChanges, changesTo, load, noteActor, noteDoc, save, textOf, type NoteDoc } from '../../shared/noteDoc.ts'
import { titleOf } from '../../shared/notes.ts'
import type { Entry } from '../../shared/state.ts'
import { seed, startRedis, tempDir, until } from './helpers.ts'

let redis: Awaited<ReturnType<typeof startRedis>>
before(async () => { redis = await startRedis(6392) })
after(() => redis?.stop())

const git = (dir: string, ...args: string[]) => promisify(execFile)('git', args, { cwd: dir }).then((r) => r.stdout.trim())

/** Someone with the note open: its document as the hub had it when they opened it, and what they type into it. */
function opened(hub: Hub, noteId = 'n1') {
  let doc: NoteDoc = load(save(hub.noteDoc(noteId)!))
  return {
    get text() { return textOf(doc) },
    /** Types `text` in, and gives the edit that carries it. */
    type(text: string, by = 'you') {
      const changes = changesTo(doc, text)
      doc = applyChanges(doc, changes)
      return { type: 'note.edit' as const, id: noteId, text, title: titleOf(text), by, at: new Date().toISOString(), changes }
    },
    /** The others' edits as they come in the live feed. */
    receive(entries: Entry[]) {
      for (const { change } of entries) if (change.type === 'note.edit' && change.id === noteId && change.changes) doc = applyChanges(doc, change.changes)
    },
  }
}

const paragraph = '# First note\n\nThe board is slow to load.\n'

describe('notes as Automerge documents', () => {
  it('keeps both people’s words when they type in the same paragraph at once', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.submit('you', 'tab-1', [{ id: 'p', change: opened(hub).type(paragraph) }])
    const you = opened(hub)
    const sam = opened(hub)
    // Neither has seen the other's edit.
    const yours = you.type('# First note\n\nThe board is very slow to load.\n')
    const sams = sam.type('# First note\n\nThe board is slow to load on Mondays.\n', 'sam')
    await hub.submit('you', 'tab-1', [{ id: 'y', change: yours }])
    await hub.submit('sam', 'tab-2', [{ id: 's', change: sams }])
    const merged = '# First note\n\nThe board is very slow to load on Mondays.\n'
    assert.equal(hub.state.notes[0].text, merged)
    assert.deepEqual(hub.state.notes[0].editors, ['you', 'sam'])

    // The edits go on in the log with the text as merged, so a client with no document shows the same.
    const sent = await hub.read(0)
    const last = sent[sent.length - 1].change
    assert.equal(last.type === 'note.edit' && last.text, merged)
    // And a client with one ends up there by applying the changes.
    you.receive(sent)
    assert.equal(you.text, merged)
  })

  it('commits the merged Markdown to Git', async () => {
    const dir = await tempDir('notes-merged')
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const saver = new GitNotesSaver(hub, { dir, author: { name: 'Test', email: 'test@binders.invalid' }, quietMs: 40 })
    await saver.start()
    await hub.submit('you', 'tab-1', [{ id: 'p', change: opened(hub).type(paragraph) }])
    const you = opened(hub)
    const sam = opened(hub)
    await hub.submit('you', 'tab-1', [{ id: 'y', change: you.type('# First note\n\nThe board is very slow to load.\n') }])
    await hub.submit('sam', 'tab-2', [{ id: 's', change: sam.type('# First note\n\nThe board is slow to load on Mondays.\n', 'sam') }])
    await saver.stop()
    const file = await readFile(join(dir, 'server/planning/first-note.md'), 'utf8')
    assert.match(file, /---\n# First note\n\nThe board is very slow to load on Mondays\.\n$/)
    assert.match(await git(dir, 'show', 'HEAD:server/planning/first-note.md'), /very slow to load on Mondays/)
  })

  it('starts a note written before Automerge from its text, and its first Automerge edit keeps that text', async () => {
    // A log from before: the note put, then edited whole, as the web app did.
    const log = new MemoryLog()
    const at = '2026-10-01T00:00:00.000Z'
    for (const [index, change] of seed().entries()) await log.append({ id: `seed-${index}`, client: 'hub', at, change })
    const old = '# First note\n\nWritten before Automerge.\n'
    await log.append({ id: 'old', client: 'user:you:tab-0', at, change: { type: 'note.edit', id: 'n1', text: old, title: 'First note', by: 'you', at } })
    const hub = new Hub(log)
    await hub.start()
    assert.equal(hub.state.notes[0].text, old)

    // Its document starts from that text, made the same way by anyone: the skeleton, then the text.
    assert.equal(textOf(hub.noteDoc('n1')!), old)
    assert.deepEqual(save(hub.noteDoc('n1')!), save(noteDoc('n1', old)))

    const you = opened(hub)
    await hub.submit('you', 'tab-1', [{ id: 'first', change: you.type(old + '\nAnd one more line.\n') }])
    assert.equal(hub.state.notes[0].text, '# First note\n\nWritten before Automerge.\n\nAnd one more line.\n')

    // Another hub reading the same log makes the same document.
    const again = new Hub(log)
    await again.start()
    assert.equal(again.state.notes[0].text, hub.state.notes[0].text)
    assert.deepEqual(save(again.noteDoc('n1')!), save(hub.noteDoc('n1')!))
  })

  it('makes an edit sent whole into changes, so it merges with what others typed meanwhile', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.submit('you', 'tab-1', [{ id: 'p', change: opened(hub).type(paragraph) }])
    const sam = opened(hub)
    // An agent's edit through MCP, or an older web app: the whole text.
    const whole = paragraph + '\n- Cache it for a second.\n'
    await hub.record({ kind: 'agent', id: 'a1' }, { type: 'note.edit', id: 'n1', text: whole, title: 'First note', by: 'a1', at: 'now' })
    const entries = await hub.read(0)
    const recorded = entries[entries.length - 1].change
    assert.ok(recorded.type === 'note.edit' && recorded.changes?.length, 'it went in the log as Automerge changes')
    // Sam typed before seeing it.
    await hub.submit('sam', 'tab-2', [{ id: 's', change: sam.type('# First note\n\nThe board is slow to load on Mondays.\n', 'sam') }])
    assert.equal(hub.state.notes[0].text, '# First note\n\nThe board is slow to load on Mondays.\n\n- Cache it for a second.\n')
  })

  it('refuses changes that build on a version it doesn’t have, or that are written as the note itself', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    // Made from a document of its own, not the hub's.
    const stranger = applyChanges(noteDoc('n1', '# Something else\n'), [])
    const changes = changesTo(stranger, '# Something else entirely\n')
    await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'x', change: { type: 'note.edit', id: 'n1', text: '', title: '', by: 'you', at: 'now', changes } }]), /builds on a version of the note the hub doesn’t have/)
    const forged = changesTo(hub.noteDoc('n1')!, '# Forged\n', noteActor('n1'))
    await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'f', change: { type: 'note.edit', id: 'n1', text: '', title: '', by: 'you', at: 'now', changes: forged } }]), /under an actor of your own/)
    await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'g', change: { type: 'note.edit', id: 'n1', text: '', title: '', by: 'you', at: 'now', changes: ['not automerge'] } }]), Refused)
    assert.equal(hub.state.notes[0].text, '# First note\n')
  })

  it('starts the document again from a note put whole', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const you = opened(hub)
    await hub.submit('you', 'tab-1', [{ id: 'e', change: you.type(paragraph) }])
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: { ...hub.state.notes[0], text: '# Put again\n' } })
    assert.equal(textOf(hub.noteDoc('n1')!), '# Put again\n')
    await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'late', change: you.type(paragraph + 'More.\n') }]), /get the note’s document again/)
  })

  it('merges the same way on two hubs sharing one Redis', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const one = new Hub(new RedisLog(redis.url, 'docs'))
    const two = new Hub(new RedisLog(redis.url, 'docs'))
    await one.start(seed())
    await two.start()
    await one.submit('you', 'tab-1', [{ id: 'p', change: opened(one).type(paragraph) }])
    await until(() => two.version === one.version)
    const you = opened(one)
    const sam = opened(two)
    await Promise.all([
      one.submit('you', 'tab-1', [{ id: 'y', change: you.type('# First note\n\nThe board is very slow to load.\n') }]),
      two.submit('sam', 'tab-2', [{ id: 's', change: sam.type('# First note\n\nThe board is slow to load on Mondays.\n', 'sam') }]),
    ])
    await until(() => one.version === two.version && one.version === 6)
    assert.equal(one.state.notes[0].text, '# First note\n\nThe board is very slow to load on Mondays.\n')
    assert.deepEqual(one.state, two.state)
    await one.log.close()
    await two.log.close()
  })
})
