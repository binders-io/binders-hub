import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hub } from '../src/hub.ts'
import { StateFile } from '../src/kept.ts'
import { MemoryLog, RedisLog } from '../src/log.ts'
import { applyChanges, changesTo, load, noteDoc, save, textOf, type NoteDoc } from '../../shared/noteDoc.ts'
import { titleOf } from '../../shared/notes.ts'
import type { Change } from '../../shared/state.ts'
import { seed, startRedis, tempDir } from './helpers.ts'

// A Binder starts from its saved state and its notes' documents, and reads only what its log has since: so how long it
// takes to start, and how much its log holds, don't grow with how long it has been going.

/** Someone with the note open: its document as the hub had it when they opened it, and what they type into it. */
function opened(hub: Hub, noteId = 'n1') {
  let doc: NoteDoc = load(save(hub.noteDoc(noteId)!))
  return {
    type(text: string) {
      const changes = changesTo(doc, text)
      doc = applyChanges(doc, changes)
      return { type: 'note.edit' as const, id: noteId, text, title: titleOf(text), by: 'you', at: new Date().toISOString(), changes }
    },
  }
}

const folder = (id: string): Change => ({ type: 'folder.put', folder: { id, binderId: 'b1', name: id } })

/** A hub started as main.ts starts one: from what's saved in `dir`, then saving there. `reads`: where it read its log from. */
async function started(log: MemoryLog, dir: string, options?: ConstructorParameters<typeof StateFile>[2]) {
  const file = new StateFile(join(dir, 'state.json'), 15_000, options)
  const reads: number[] = []
  const read = log.read.bind(log)
  log.read = async (after: number, limit?: number) => { reads.push(after); return read(after, limit) }
  const hub = new Hub(log)
  await hub.start(seed(), await file.read(), await file.readDocs())
  log.read = read
  await file.follow(hub)
  return { hub, file, reads }
}

const docFiles = async (dir: string) => (await readdir(join(dir, 'note-docs')).catch(() => [] as string[])).filter((name) => name.endsWith('.automerge')).sort()

describe('a Binder starting from what it saved', () => {
  it('starts from its saved state and its notes’ documents, reading only what the log has since', async () => {
    const dir = await tempDir('saved-start')
    const log = new MemoryLog()
    const first = await started(log, dir)
    const someone = opened(first.hub)
    await first.hub.submit('you', 'tab-1', [{ id: 'a', change: someone.type('# First note\n\nOne line.\n') }])
    await first.file.save()
    const savedAt = first.hub.version
    // Written after the save, and never saved: the hub stopped without a word.
    await first.hub.submit('you', 'tab-1', [{ id: 'b', change: someone.type('# First note\n\nOne line.\nAnd another.\n') }])

    const second = await started(log, dir)
    assert.equal(second.reads[0], savedAt, 'it reads the log from the version it saved, not from its beginning')
    assert.equal(second.hub.version, first.hub.version)
    assert.equal(second.hub.state.notes.find((n) => n.id === 'n1')!.text, '# First note\n\nOne line.\nAnd another.\n')
    assert.deepEqual(save(second.hub.noteDoc('n1')!), save(first.hub.noteDoc('n1')!), 'the note’s document is as it was')
    // Whoever had the note open goes on from the document they have.
    await second.hub.submit('you', 'tab-1', [{ id: 'c', change: someone.type('# First note\n\nOne line.\nAnd another.\nAnd a third.\n') }])
    assert.equal(second.hub.state.notes.find((n) => n.id === 'n1')!.text, '# First note\n\nOne line.\nAnd another.\nAnd a third.\n')
    await second.file.stop()
  })

  it('reads its whole log once more when no documents were saved yet, and saves every one', async () => {
    const dir = await tempDir('saved-start')
    const log = new MemoryLog()
    const first = await started(log, dir)
    const someone = opened(first.hub)
    await first.hub.submit('you', 'tab-1', [{ id: 'a', change: someone.type('# First note\n\nFrom before.\n') }])
    await first.file.stop()
    // A Binder from before documents were saved beside its state.
    await rm(join(dir, 'note-docs'), { recursive: true })

    const second = await started(log, dir)
    assert.equal(second.reads[0], 0, 'the whole log, so the documents come out as they were')
    assert.deepEqual(await docFiles(dir), ['n1.automerge'])
    await second.hub.submit('you', 'tab-1', [{ id: 'b', change: someone.type('# First note\n\nFrom before.\nAnd since.\n') }])
    await second.file.stop()

    // From then on it starts from what it saved.
    const third = await started(log, dir)
    assert.equal(third.reads[0], second.hub.version)
    assert.equal(third.hub.state.notes.find((n) => n.id === 'n1')!.text, '# First note\n\nFrom before.\nAnd since.\n')
    await third.file.stop()
  })

  it('drops a note’s saved document when the note is put again whole, and when it’s deleted', async () => {
    const dir = await tempDir('saved-start')
    const { hub, file } = await started(new MemoryLog(), dir)
    await hub.submit('you', 'tab-1', [{ id: 'a', change: opened(hub).type('# First note\n\nTyped.\n') }])
    await file.save()
    assert.deepEqual(await docFiles(dir), ['n1.automerge'])
    const note = hub.state.notes.find((n) => n.id === 'n1')!
    await hub.record({ kind: 'hub' }, { type: 'note.put', note: { ...note, text: '# First note\n\nPut again whole.\n' } })
    await file.save()
    assert.deepEqual(await docFiles(dir), [])
    await hub.submit('you', 'tab-1', [{ id: 'b', change: opened(hub).type('# First note\n\nPut again whole.\nAnd typed.\n') }])
    await file.save()
    assert.deepEqual(await docFiles(dir), ['n1.automerge'])
    await hub.record({ kind: 'hub' }, { type: 'note.delete', id: 'n1' })
    await file.save()
    assert.deepEqual(await docFiles(dir), [])
    await file.stop()
  })

  it('sets aside a saved document that doesn’t say what its note says, so it can’t put its own words back', async () => {
    const dir = await tempDir('saved-start')
    const log = new MemoryLog()
    const first = await started(log, dir)
    await first.hub.submit('you', 'tab-1', [{ id: 'a', change: opened(first.hub).type('# First note\n\nWhat the note says.\n') }])
    await first.file.stop()
    await writeFile(join(dir, 'note-docs', 'n1.automerge'), save(noteDoc('n1', '# First note\n\nSomething older.\n')))

    const second = await started(log, dir)
    assert.equal(textOf(second.hub.noteDoc('n1')!), '# First note\n\nWhat the note says.\n')
    await second.hub.submit('you', 'tab-1', [{ id: 'b', change: opened(second.hub).type('# First note\n\nWhat the note says.\nAnd more.\n') }])
    assert.equal(second.hub.state.notes.find((n) => n.id === 'n1')!.text, '# First note\n\nWhat the note says.\nAnd more.\n')
    await second.file.stop()
  })
})

describe('a Binder’s log, kept short', () => {
  it('forgets what’s well behind the saved state, never past the state kept before it, and still starts whole', async () => {
    const dir = await tempDir('short-log')
    const log = new MemoryLog()
    let now = Date.parse('2026-11-09T10:00:00Z')
    const options = { keep: 3, previousEveryMs: 24 * 60 * 60_000, now: () => now }
    const first = await started(log, dir, options)
    await first.file.stop()
    // Nothing is kept from before on a Binder's first run, so nothing is forgotten yet.
    assert.equal((await log.read(0, 1))[0].version, 1)

    const second = await started(log, dir, options)
    const kept = second.hub.version
    for (let n = 1; n <= 10; n++) await second.hub.record({ kind: 'hub' }, folder(`f${n}`))
    await second.file.save()
    assert.equal((await log.read(0, 1))[0].version, kept + 1, 'cut to the state kept at this start, though the saved one is further on')

    // A day on, the saved state becomes the one kept before, and the log is cut up to a little behind the newest.
    now += 25 * 60 * 60_000
    for (let n = 11; n <= 20; n++) await second.hub.record({ kind: 'hub' }, folder(`f${n}`))
    await second.file.save()
    assert.equal((await log.read(0, 1))[0].version, kept + 10 + 1)
    await second.file.stop()

    const third = await started(log, dir, options)
    assert.equal(third.hub.state.folders.length, second.hub.state.folders.length)
    assert.deepEqual(third.hub.state.folders.map((f) => f.id).slice(-2), ['f19', 'f20'])
    assert.equal(third.hub.version, second.hub.version)
    await third.file.stop()
  })

  it('starts from the state kept before when the saved one can’t be read, with what the log has since', async () => {
    const dir = await tempDir('short-log')
    const log = new MemoryLog()
    const options = { keep: 3 }
    await (await started(log, dir, options)).file.stop()
    const second = await started(log, dir, options)
    for (let n = 1; n <= 8; n++) await second.hub.record({ kind: 'hub' }, folder(`f${n}`))
    await second.file.stop()
    await writeFile(join(dir, 'state.json'), '{ half a fi')

    const third = await started(log, dir, options)
    assert.deepEqual(third.hub.state.folders.map((f) => f.id).slice(-2), ['f7', 'f8'])
    assert.equal(third.hub.version, second.hub.version)
    await third.file.stop()
    // And its damaged file wasn't kept as the one before.
    assert.ok(JSON.parse(await readFile(join(dir, 'state.prev.json'), 'utf8')).version)
  })

  it('isn’t started on what’s left of its log when neither saved state can be read', async () => {
    const dir = await tempDir('short-log')
    const log = new MemoryLog()
    await (await started(log, dir)).file.stop()
    await (await started(log, dir)).file.stop()
    await rm(join(dir, 'state.json'))
    await rm(join(dir, 'state.prev.json'))
    await assert.rejects(new StateFile(join(dir, 'state.json')).read(), /put the file back from a backup/)
    // A Binder that never saved anything is only new.
    assert.equal(await new StateFile(join(await tempDir('short-log'), 'state.json')).read(), undefined)
  })

  it('goes on when the state can’t be written, and saves it and its documents the next time', async () => {
    const dir = await tempDir('short-log')
    const { hub, file } = await started(new MemoryLog(), dir)
    await hub.submit('you', 'tab-1', [{ id: 'a', change: opened(hub).type('# First note\n\nTyped.\n') }])
    const state = hub.state
    // Something that can't be written as text, as a state too large for one would be.
    hub.state = { ...state, binders: [{ ...state.binders[0], count: 1n } as never] }
    await assert.rejects(file.save())
    assert.deepEqual(await docFiles(dir), [])
    hub.state = state
    await hub.record({ kind: 'hub' }, folder('later'))
    await file.save()
    assert.deepEqual(await docFiles(dir), ['n1.automerge'])
    await file.stop()
  })
})

describe('the log on Redis, cut short', () => {
  it('forgets what it’s told to, numbers on from where it was, and reads from what’s left', async (t) => {
    const redis = await startRedis(6398)
    if (!redis) return t.skip('redis-server isn’t installed')
    const log = new RedisLog(redis.url, 'short')
    t.after(async () => { await log.close(); redis.stop() })
    for (let n = 1; n <= 10; n++) await log.append({ id: `c${n}`, client: 'hub', at: '2026-11-09T00:00:00.000Z', change: folder(`f${n}`) })
    await log.trim(6)
    assert.deepEqual((await log.read(0)).map((e) => e.version), [7, 8, 9, 10])
    assert.equal(await log.latest(), 10)
    assert.equal(await log.append({ id: 'c11', client: 'hub', at: '2026-11-09T00:00:00.000Z', change: folder('f11') }), 11)
    // Asked to forget nothing, or less than it already has, it changes nothing.
    await log.trim(0)
    await log.trim(3)
    assert.deepEqual((await log.read(0)).map((e) => e.version), [7, 8, 9, 10, 11])
  })
})
