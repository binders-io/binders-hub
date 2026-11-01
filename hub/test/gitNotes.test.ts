import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Hub } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { GitNotesSaver } from '../src/savers/gitNotes.ts'
import { seed, tempDir, until } from './helpers.ts'

const git = (dir: string, ...args: string[]) => promisify(execFile)('git', args, { cwd: dir }).then((r) => r.stdout.trim())
const exists = (path: string) => access(path).then(() => true, () => false)

async function setUp() {
  const dir = await tempDir('notes')
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const saver = new GitNotesSaver(hub, { dir, author: { name: 'Test', email: 'test@binders.invalid' }, quietMs: 40 })
  await saver.start()
  return { dir, hub, saver }
}

const edit = (title: string, more: string[] = []) => ({
  type: 'note.edit' as const, id: 'n1', title, by: 'you', at: 'now',
  text: [`# ${title}`, ...(more.length ? ['', ...more.map((line) => `- ${line}`)] : [])].join('\n') + '\n',
})

describe('notes in Git', () => {
  it('writes every note as Markdown at its binder and folder, in one first commit', async () => {
    const { dir, saver } = await setUp()
    const file = await readFile(join(dir, 'server/planning/first-note.md'), 'utf8')
    assert.match(file, /^---\nid: n1\nbinder: b1\nfolder: f1\n---\n# First note\n$/)
    assert.equal(await git(dir, 'rev-list', '--count', 'HEAD'), '1')
    await saver.stop()
  })

  it('makes one commit when typing pauses, and says so in the log', async () => {
    const { dir, hub, saver } = await setUp()
    const first = hub.state.notes[0].commit
    assert.ok(first, 'the first commit is recorded too')
    for (const [index, word] of ['F', 'Fi', 'Fir', 'First'].entries()) await hub.submit('you', 'tab-1', [{ id: `k${index}`, change: edit('First note', [word]) }])
    await until(() => hub.state.notes[0].commit !== first)
    assert.equal(await git(dir, 'rev-list', '--count', 'HEAD'), '2', 'four quick edits, one commit')
    assert.equal(hub.state.notes[0].commit, await git(dir, 'rev-parse', '--short', 'HEAD'))
    assert.match(await readFile(join(dir, 'server/planning/first-note.md'), 'utf8'), /# First note\n\n- First\n$/)
    await saver.stop()
  })

  it('saves all at once: what waits for typing to pause is committed now, and pushed', async () => {
    const dir = await tempDir('notes')
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    let pushes = 0
    const saver = new GitNotesSaver(hub, { dir, author: { name: 'Test', email: 'test@binders.invalid' }, quietMs: 60_000, longestMs: 60_000, pushTo: async () => { pushes++; return undefined } })
    await saver.start()
    const first = hub.state.notes[0].commit
    await hub.submit('you', 'tab-1', [{ id: 's1', change: edit('First note', ['now']) }])
    pushes = 0
    assert.deepEqual(await saver.saveAll(), { committed: 1 })
    assert.equal(await git(dir, 'rev-list', '--count', 'HEAD'), '2', 'committed without waiting a minute')
    assert.notEqual(hub.state.notes[0].commit, first)
    assert.equal(pushes, 1, 'and pushed')
    assert.deepEqual(await saver.saveAll(), { committed: 0 }, 'nothing waiting: nothing to commit')
    assert.equal(pushes, 2, 'but pushed again, in case the last push failed')
    await saver.stop()
  })

  it('moves the file when the note is renamed or moved, and keeps its history across', async () => {
    const { dir, hub, saver } = await setUp()
    await hub.submit('you', 'tab-1', [{ id: 'r', change: edit('Second name') }])
    await until(async () => exists(join(dir, 'server/planning/second-name.md')))
    await hub.submit('you', 'tab-1', [{ id: 'm', change: { type: 'note.move', id: 'n1', binderId: 'b1' } }])
    await until(async () => exists(join(dir, 'server/second-name.md')))
    assert.equal(await exists(join(dir, 'server/planning')), false, 'the empty folder goes')
    await until(async () => (await saver.history('n1')).length === 3)
    const history = await saver.history('n1')
    const first = await saver.at('n1', history[2].short)
    assert.match(first ?? '', /# First note/, 'the first version reads back from its old path')
    await saver.stop()
  })

  it('keeps its own repo when the notes folder sits inside another one', async () => {
    const outer = await tempDir('outer')
    await git(outer, 'init', '-q')
    await writeFile(join(outer, 'source.ts'), 'export {}\n')
    const dir = join(outer, '.data', 'notes')
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const saver = new GitNotesSaver(hub, { dir, author: { name: 'Test', email: 'test@binders.invalid' }, quietMs: 40 })
    await saver.start()
    assert.equal(await realpath(await git(dir, 'rev-parse', '--show-toplevel')), await realpath(dir), 'the notes have a repo of their own')
    await assert.rejects(git(outer, 'rev-parse', 'HEAD'), 'nothing was committed to the outer repo')
    assert.equal(await git(dir, 'ls-files'), 'server/planning/first-note.md', 'only notes go in the notes repo')
    await saver.stop()
  })

  it('keeps the work that came from a note in its front matter', async () => {
    const { dir, hub, saver } = await setUp()
    await hub.submit('you', 'tab-1', [{ id: 'w', change: { type: 'note.link', id: 'n1', link: { itemId: 'w212', quote: 'Say "hi"' } } }])
    await saver.stop()
    assert.match(await readFile(join(dir, 'server/planning/first-note.md'), 'utf8'), /work:\n {2}- \{ item: w212, quote: "Say \\"hi\\"" \}\n---\n# First note\n$/)
  })

  it('commits while typing goes on without a pause, at least every so often', async () => {
    const dir = await tempDir('notes-long')
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const saver = new GitNotesSaver(hub, { dir, author: { name: 'Test', email: 'test@binders.invalid' }, quietMs: 200, longestMs: 300 })
    await saver.start()
    // An edit every 80 ms never pauses for 200 ms, but the longest wait is 300 ms.
    for (let index = 0; index < 8; index++) {
      await hub.submit('you', 'tab-1', [{ id: `t${index}`, change: edit('First note', [`word ${index}`]) }])
      await new Promise((done) => setTimeout(done, 80))
    }
    assert.ok(Number(await git(dir, 'rev-list', '--count', 'HEAD')) >= 2, 'a commit came before the typing stopped')
    await saver.stop()
  })

  it('commits what’s still waiting when it stops', async () => {
    const { dir, hub, saver } = await setUp()
    await hub.submit('you', 'tab-1', [{ id: 'late', change: edit('Last words') }])
    await saver.stop()
    assert.equal(await exists(join(dir, 'server/planning/last-words.md')), true)
  })

  it('pushes each binder’s notes to its own repo, as a branch of their own with only that binder in it', async () => {
    const dir = await tempDir('notes-push')
    const remote = await tempDir('notes-remote')
    await git(remote, 'init', '-q', '--bare')
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const saver = new GitNotesSaver(hub, {
      dir, author: { name: 'Test', email: 'test@binders.invalid' }, quietMs: 40,
      pushTo: async (binder) => (binder.repo && binder.notes !== false ? { url: remote, branch: binder.notesBranch || 'binders-notes', name: binder.repo } : undefined),
    })
    await saver.start()
    await hub.submit('you', 'tab-1', [{ id: 'r', change: { type: 'binder.put', binder: { ...hub.state.binders[0], repo: 'acme/web' } } }])
    await until(async () => !!saver.pushed[hub.state.binders[0].id]?.at)
    const files = await git(remote, 'ls-tree', '-r', '--name-only', 'binders-notes')
    assert.equal(files, 'planning/first-note.md', 'the binder’s folder is the top of the branch')

    // An edit is pushed on top, without rewriting what's there.
    const before = await git(remote, 'rev-parse', 'binders-notes')
    await hub.submit('you', 'tab-1', [{ id: 'e', change: edit('First note', ['more']) }])
    await until(async () => (await git(remote, 'rev-parse', 'binders-notes')) !== before)
    assert.equal(await git(remote, 'rev-parse', 'binders-notes~1'), before)
    await saver.stop()
  })

})
