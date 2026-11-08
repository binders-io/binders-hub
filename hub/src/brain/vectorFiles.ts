import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Binder } from '../../../shared/notes.ts'
import { log } from '../logger.ts'
import { pushEnv, type PushStatus, type PushTarget } from '../savers/gitNotes.ts'
import { packed, unpacked, type SourceKind, type VectorStore } from './index.ts'

const run = promisify(execFile)

/** Where a binder's vectors go in its repo: a branch of their own, away from its notes and with no history. */
export const vectorBranch = 'binders-embeddings'

const networkMs = 5 * 60_000
const retryMs = 5 * 60_000
const about = `# Embeddings

Binders keeps the embeddings of this repo's notes and cards here, so they survive the hub's Redis being rebuilt. Each
file holds the vectors of one note or card, by a hash of each passage, and none of its words. The branch keeps no
history: each save replaces it. Binders makes these again if they're deleted.
`

export interface VectorFilesOptions {
  /** The folder on the hub's disk: a Git repo, made when it isn't there. */
  dir: string
  binders: () => Binder[]
  /** The binder a note or card is in, so its vectors go only to that binder's repo. */
  binderOf: (kind: SourceKind, id: string) => string | undefined
  /** Where a binder's notes go. Its vectors go to the same repo, or stay on this disk when there's none. */
  pushTo?: (binder: Binder) => Promise<PushTarget | undefined>
  author: { name: string; email: string }
  /** How long indexing has to pause before a push (a minute). */
  quietMs?: number
}

const folderOf = (binderId: string) => `b-${encodeURIComponent(binderId)}`
const modelFolder = (embedKey: string) => createHash('sha256').update(embedKey).digest('hex').slice(0, 16)
const sourceName = (kind: SourceKind, id: string) => `${kind}-${encodeURIComponent(id)}.json`

/**
 * The long-term home of a binder's embeddings. Redis holds a working copy the hub can lose: these files are written on
 * the hub's disk, one per note or card, and pushed to the binder's repo. A hub with an empty disk fetches them back, and
 * one with an empty Redis takes vectors from here before asking the model.
 */
export class VectorFiles implements VectorStore {
  /** Each binder's last push: where to, when, and what went wrong if it did. */
  pushed: Record<string, PushStatus> = {}
  private options: VectorFilesOptions
  /** Each source's files (one per embeddings model it has had), by the file's name. */
  private files = new Map<string, Set<string>>()
  /** Writes and reading the tree take turns: a push never reads half a file. */
  private queue: Promise<unknown> = Promise.resolve()
  private timer?: NodeJS.Timeout
  private pushing?: Promise<void>
  private dirty = false
  /** What each binder's repo was last sent in this run. */
  private sent = new Map<string, string>()
  private pushes = 0
  private stopped = false

  constructor(options: VectorFilesOptions) {
    this.options = options
  }

  /** Makes the repo if needed, fetches what a binder's repo has when this disk has nothing of it, and reads what's here. */
  async start() {
    await mkdir(this.options.dir, { recursive: true })
    const top = await this.git({}, 'rev-parse', '--show-toplevel').then((r) => r.stdout.trim(), () => '')
    if (!top || (await realpath(top)) !== (await realpath(this.options.dir))) await this.git({}, 'init', '-q', '-b', 'main')
    for (const binder of this.options.binders()) {
      await this.restore(binder).catch((error: Error) => log.warn({ binder: binder.id, why: error.message.split('\n')[0] }, 'Couldn’t bring a binder’s embeddings back from its repo'))
    }
    await this.readFolders()
    // Anything written just before the last stop may never have been pushed.
    if (this.files.size) this.soon()
  }

  private async restore(binder: Binder) {
    const folder = folderOf(binder.id)
    const here = await readdir(join(this.options.dir, folder)).catch(() => [] as string[])
    if (here.length) return
    const target = await this.options.pushTo?.(binder)
    if (!target) return
    const ref = `refs/vectors/${folder}`
    try {
      await this.git(pushEnv(target), 'fetch', '-q', '--depth', '1', '--no-tags', target.url, `+refs/heads/${vectorBranch}:${ref}`)
    } catch (error) {
      if (/couldn't find remote ref|could not find remote ref/i.test((error as Error).message)) return
      throw error
    }
    await this.git({}, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', folder)
    await this.git({}, 'read-tree', `--prefix=${folder}/`, ref)
    await this.git({}, 'checkout-index', '-a', '-f')
    log.info({ binder: binder.id, from: target.name }, 'Brought a binder’s embeddings back from its repo')
  }

  private async readFolders() {
    for (const folder of await readdir(this.options.dir).catch(() => [] as string[])) {
      if (!folder.startsWith('b-')) continue
      for (const model of await readdir(join(this.options.dir, folder)).catch(() => [] as string[])) {
        if (model.endsWith('.md')) continue
        for (const name of await readdir(join(this.options.dir, folder, model)).catch(() => [] as string[])) this.note(name, join(folder, model, name))
      }
    }
  }

  private note(name: string, path: string) {
    const paths = this.files.get(name) ?? new Set<string>()
    paths.add(path)
    this.files.set(name, paths)
  }

  /** Every note and card with a file, as "kind:id". */
  keys() {
    return [...this.files.keys()].map((name) => {
      const cut = name.indexOf('-')
      return `${name.slice(0, cut)}:${decodeURIComponent(name.slice(cut + 1, -'.json'.length))}`
    })
  }

  private pathOf(kind: SourceKind, id: string, embedKey: string) {
    const binder = this.options.binderOf(kind, id)
    return binder === undefined ? undefined : join(folderOf(binder), modelFolder(embedKey), sourceName(kind, id))
  }

  has(kind: SourceKind, id: string, embedKey: string) {
    const path = this.pathOf(kind, id, embedKey)
    return !!path && !!this.files.get(sourceName(kind, id))?.has(path)
  }

  async read(kind: SourceKind, id: string, embedKey: string) {
    const out = new Map<string, Float32Array>()
    const path = this.pathOf(kind, id, embedKey)
    if (!path || !this.files.get(sourceName(kind, id))?.has(path)) return out
    try {
      const kept = JSON.parse(await readFile(join(this.options.dir, path), 'utf8')) as { vectors?: Record<string, string> }
      for (const [hash, vector] of Object.entries(kept.vectors ?? {})) out.set(hash, unpacked(vector))
    } catch {
      // A file this hub can't read: its vectors are made again.
    }
    return out
  }

  async write(kind: SourceKind, id: string, embedKey: string, vectors: { hash: string; vector: Float32Array }[]) {
    const path = this.pathOf(kind, id, embedKey)
    if (!path) return
    const name = sourceName(kind, id)
    const folder = path.split('/')[0]
    await this.turn(async () => {
      await mkdir(dirname(join(this.options.dir, path)), { recursive: true })
      await writeFile(join(this.options.dir, folder, 'README.md'), about)
      // The address of the embeddings server stays out of the file: only the model's name is any use to a reader.
      const kept = { source: `${kind}-${id}`, model: embedKey.split('|').at(-1), vectors: Object.fromEntries(vectors.map((v) => [v.hash, packed(v.vector)])) }
      await writeFile(join(this.options.dir, path), `${JSON.stringify(kept)}\n`)
      // Moved to another binder: its vectors leave the old binder's repo.
      for (const other of this.files.get(name) ?? []) {
        if (other.split('/')[0] === folder) continue
        await rm(join(this.options.dir, other), { force: true })
        this.files.get(name)?.delete(other)
      }
      this.note(name, path)
    })
    this.soon()
  }

  async remove(kind: SourceKind, id: string) {
    const name = sourceName(kind, id)
    const paths = this.files.get(name)
    if (!paths) return
    this.files.delete(name)
    await this.turn(async () => {
      for (const path of paths) await rm(join(this.options.dir, path), { force: true })
    })
    this.soon()
  }

  private turn<T>(work: () => Promise<T>) {
    const done = this.queue.then(work)
    this.queue = done.catch(() => undefined)
    return done
  }

  private soon(ms = this.options.quietMs ?? 60_000) {
    this.dirty = true
    // A push at most this often, however steadily things change: the timer isn't put off by each change.
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.push()
    }, ms)
    this.timer.unref?.()
  }

  /** Each binder's vectors to its repo: one commit with no parent, replacing the last, so the branch never grows history. */
  push() {
    this.pushing ??= this.pushAll().finally(() => {
      this.pushing = undefined
      // Changed while it pushed, with the timer gone off into that push.
      if (this.dirty) this.soon()
    })
    return this.pushing
  }

  private async pushAll() {
    this.dirty = false
    if (!this.options.pushTo) return
    const root = await this.turn(async () => {
      await this.git({}, 'add', '-A')
      return (await this.git({}, 'write-tree')).stdout.trim()
    })
    let failed = false
    for (const binder of this.options.binders()) {
      let target: PushTarget | undefined
      try {
        target = await this.options.pushTo(binder)
      } catch (error) {
        this.pushed[binder.id] = { error: (error as Error).message }
        failed = true
        continue
      }
      if (!target) {
        delete this.pushed[binder.id]
        continue
      }
      const folder = folderOf(binder.id)
      const tree = await this.git({}, 'rev-parse', '-q', '--verify', `${root}:${folder}`).then((r) => r.stdout.trim(), () => '')
      if (!tree) continue
      const sending = `${target.url}|${tree}`
      if (this.sent.get(binder.id) === sending) continue
      try {
        const ref = `refs/vectors/${folder}`
        const last = await this.git({}, 'rev-parse', '-q', '--verify', ref).then((r) => r.stdout.trim(), () => '')
        const lastTree = last ? await this.git({}, 'rev-parse', `${last}^{tree}`).then((r) => r.stdout.trim(), () => '') : ''
        const commit = lastTree === tree ? last : (await this.git({}, 'commit-tree', tree, '-m', 'Embeddings from Binders')).stdout.trim()
        if (commit !== last) await this.git({}, 'update-ref', ref, commit)
        await this.git(pushEnv(target), 'push', '-q', '--force', target.url, `${ref}:refs/heads/${vectorBranch}`)
        this.sent.set(binder.id, sending)
        this.pushed[binder.id] = { to: target.name, branch: vectorBranch, at: new Date().toISOString() }
      } catch (error) {
        const words = String((error as Error).message)
        const why = /403|denied|not found|404/i.test(words) ? `The hub can’t write to ${target.name}: is the GitHub App installed there, with contents write?` : words.split('\n').find((l) => l.trim())?.slice(0, 200) ?? 'Pushing failed.'
        this.pushed[binder.id] = { to: target.name, branch: vectorBranch, error: why }
        log.error({ binder: binder.id, why }, 'Pushing a binder’s embeddings failed')
        failed = true
      }
    }
    if (failed) this.soon(retryMs)
    // Each push leaves the commit and trees before it behind.
    if (++this.pushes % 20 === 0) await this.git({}, 'gc', '-q', '--prune=now').catch(() => undefined)
  }

  /** Where this binder's vectors are kept, for Settings: nothing filled in means this disk alone. */
  status(): PushStatus {
    return Object.values(this.pushed)[0] ?? {}
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.queue
    if (this.pushing) await this.pushing.catch(() => undefined)
    if (this.dirty) await this.push().catch(() => undefined)
  }

  private git(env: Record<string, string>, ...args: string[]) {
    const { name, email } = this.options.author
    return run('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: this.options.dir,
      timeout: networkMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env, GIT_CEILING_DIRECTORIES: dirname(this.options.dir), GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    })
  }
}
