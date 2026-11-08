import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Binder } from '../../shared/notes.ts'
import { MemoryKV } from '../src/kv.ts'
import { BrainIndex } from '../src/brain/index.ts'
import { VectorFiles, vectorBranch } from '../src/brain/vectorFiles.ts'

const run = promisify(execFile)

/** A stand-in embeddings model that counts what it's asked to embed. */
function model(key = 'localhost:11434|stand-in') {
  const asked: string[] = []
  return {
    key,
    asked,
    embed: async (texts: string[]) => {
      asked.push(...texts)
      return texts.map((t) => Float32Array.from([t.length, 1, 0]))
    },
  }
}

const places: string[] = []
const place = async (name: string) => {
  const dir = await mkdtemp(join(tmpdir(), `binders-${name}-`))
  places.push(dir)
  return dir
}
after(async () => {
  await Promise.all(places.map((dir) => rm(dir, { recursive: true, force: true })))
})

const note = (id: string, text: string) => ({ kind: 'note' as const, id, title: id, text })
const binder = { id: 'b1', name: 'Binder' } as Binder

/** A hub's files: on a disk of their own, and pushing to `remote` when given. */
function filesAt(dir: string, remote?: string) {
  return new VectorFiles({
    dir,
    binders: () => [binder],
    binderOf: () => 'b1',
    pushTo: async () => (remote ? { url: remote, branch: 'unused', name: 'team/repo' } : undefined),
    author: { name: 'Tests', email: 'tests@binders.invalid' },
    quietMs: 60_000,
  })
}

async function filesIn(dir: string) {
  const out: string[] = []
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && !join(entry.parentPath, entry.name).includes('/.git/') && entry.name.endsWith('.json')) out.push(join(entry.parentPath, entry.name))
  }
  return out
}

describe('vectors kept outside Redis', () => {
  it('writes a note’s vectors to a file, without its words or the model’s address', async () => {
    const dir = await place('words')
    const files = filesAt(dir)
    await files.start()
    await new BrainIndex(new MemoryKV(), files).put(note('n1', 'The private plan for the launch.'), model())
    const [file] = await filesIn(dir)
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('private plan'))
    assert.ok(!text.includes('localhost'))
    assert.equal(JSON.parse(text).model, 'stand-in')
    await files.stop()
  })

  it('gives vectors back to a hub whose Redis was rebuilt, without asking the model', async () => {
    const dir = await place('rebuilt')
    const files = filesAt(dir)
    await files.start()
    const first = model()
    await new BrainIndex(new MemoryKV(), files).put(note('n1', 'Words about the launch.'), first)
    assert.equal(first.asked.length, 1)

    const again = model()
    const rebuilt = new BrainIndex(new MemoryKV(), files)
    await rebuilt.put(note('n1', 'Words about the launch.'), again)
    assert.deepEqual(again.asked, [])
    assert.equal((await rebuilt.stats()).withVectors, 1)
    await files.stop()
  })

  it('still gives them back with the model down', async () => {
    const dir = await place('down')
    const files = filesAt(dir)
    await files.start()
    const up = model()
    await new BrainIndex(new MemoryKV(), files).put(note('n1', 'Words about the launch.'), up)
    const rebuilt = new BrainIndex(new MemoryKV(), files)
    await rebuilt.put(note('n1', 'Words about the launch.'), { key: up.key, embed: () => Promise.reject(new Error('down')) })
    assert.equal((await rebuilt.stats()).withVectors, 1)
    await files.stop()
  })

  it('asks the model only for passages that changed, and for another model’s vectors', async () => {
    const dir = await place('changed')
    const files = filesAt(dir)
    await files.start()
    await new BrainIndex(new MemoryKV(), files).put(note('n1', 'First part.\n\nSecond part.'), model())
    const other = model('localhost:11434|another')
    await new BrainIndex(new MemoryKV(), files).put(note('n1', 'First part.\n\nSecond part.'), other)
    assert.equal(other.asked.length, 1)
    await files.stop()
  })

  it('gives vectors made before there were files a home when the note is next read', async () => {
    const dir = await place('backfill')
    const kv = new MemoryKV()
    const made = model()
    const older = new BrainIndex(kv)
    await older.put(note('n1', 'Older words.'), made)
    await older.flush()
    const files = filesAt(dir)
    await files.start()
    const index = new BrainIndex(kv, files)
    assert.equal(await index.put(note('n1', 'Older words.'), made), false)
    assert.equal((await filesIn(dir)).length, 1)
    assert.equal(made.asked.length, 1)
    await files.stop()
  })

  it('takes a deleted note’s file away', async () => {
    const dir = await place('deleted')
    const files = filesAt(dir)
    await files.start()
    const index = new BrainIndex(new MemoryKV(), files)
    await index.put(note('n1', 'Words.'), model())
    await index.remove('note', 'n1')
    assert.deepEqual(await filesIn(dir), [])
    await files.stop()
  })

  it('pushes to a branch of their own with no history, and a hub with an empty disk fetches them back', async () => {
    const remote = await place('remote')
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote])
    const url = `file://${remote}`
    const dir = await place('hub')
    const files = filesAt(dir, url)
    await files.start()
    const index = new BrainIndex(new MemoryKV(), files)
    await index.put(note('n1', 'Words about the launch.'), model())
    await files.push()
    assert.equal(files.status()?.branch, vectorBranch)
    await index.put(note('n2', 'More words.'), model())
    await files.push()

    const log = await run('git', ['--git-dir', remote, 'log', '--format=%H', vectorBranch])
    assert.equal(log.stdout.trim().split('\n').length, 1)
    const tree = await run('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', vectorBranch])
    assert.equal(tree.stdout.trim().split('\n').filter((f) => f.endsWith('.json')).length, 2)
    await files.stop()

    // Disk and Redis both gone: the repo has them.
    const fresh = filesAt(await place('fresh'), url)
    await fresh.start()
    assert.deepEqual(fresh.keys().sort(), ['note:n1', 'note:n2'])
    const asked = model()
    const rebuilt = new BrainIndex(new MemoryKV(), fresh)
    await rebuilt.put(note('n1', 'Words about the launch.'), asked)
    assert.deepEqual(asked.asked, [])
    assert.equal((await rebuilt.stats()).withVectors, 1)
    await fresh.stop()
  })

  it('starts empty when the repo has no branch for them yet', async () => {
    const remote = await place('nobranch')
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote])
    const files = filesAt(await place('new'), `file://${remote}`)
    await files.start()
    assert.deepEqual(files.keys(), [])
    await files.stop()
  })
})
