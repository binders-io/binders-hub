import { execFile } from 'node:child_process'
import { mkdir, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { pathOf, slug, toMarkdown, type Binder, type Note } from '../../../shared/notes.ts'
import type { Entry } from '../../../shared/state.ts'
import type { Hub } from '../hub.ts'
import { log } from '../logger.ts'

const run = promisify(execFile)

export interface GitNotesOptions {
  /** The notes repo on disk. It's made with `git init` when it isn't there. */
  dir: string
  /** Pushed after each commit when set, e.g. a GitHub repo's address. */
  remote?: string
  /** Where a binder's notes are pushed, asked before each push so a change in Settings takes effect at once. */
  pushTo?: (binder: Binder) => Promise<PushTarget | undefined>
  author: { name: string; email: string }
  /** How long typing has to pause before a commit (a minute). */
  quietMs?: number
  /** The longest edits wait while typing goes on without a pause (five minutes). */
  longestMs?: number
  /** Both, as the hub's options say now: Settings can change them while the hub runs. */
  timing?: () => { quietMs: number; longestMs: number }
}

export interface PushTarget {
  url: string
  branch: string
  /** For GitHub over HTTPS, sent as a header from the environment, never on git's command line. */
  token?: string
  /** What Settings calls it, such as the repo's owner/name. */
  name: string
}

export interface PushStatus {
  to?: string
  branch?: string
  at?: string
  error?: string
}

export interface Commit {
  sha: string
  short: string
  author: string
  at: string
  subject: string
}

/**
 * Keeps notes as Markdown files in a Git repo: one file per note, at its binder's and folders' path, and one commit
 * when the edits to a note pause, so typing makes a commit, not hundreds. A note that moves or is renamed moves its
 * file; one deleted loses it. After each commit the hub records note.saved, which clients show.
 */
export class GitNotesSaver {
  private timers = new Map<string, NodeJS.Timeout>()
  /** Where each note's file is, as last written. */
  private written = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()
  private timing: () => { quietMs: number; longestMs: number }
  /** When each note's waiting edits began. */
  private waitingSince = new Map<string, number>()
  private hub: Hub
  private options: GitNotesOptions

  constructor(hub: Hub, options: GitNotesOptions) {
    this.hub = hub
    this.options = options
    this.timing = options.timing ?? (() => ({ quietMs: options.quietMs ?? 60_000, longestMs: options.longestMs ?? 5 * 60_000 }))
  }

  /** Each binder's last push: where to, when, and what went wrong if it did. */
  pushed: Record<string, PushStatus> = {}

  /**
   * Pushes each binder's notes to its own repo: its folder in the hub's notes repo becomes the top of a branch there,
   * with a history of its own (a commit whenever that folder changed), so the binder's repo gets only its notes.
   */
  async push() {
    if (this.options.remote) await this.git('push', '-q', this.options.remote, 'HEAD:main').catch((err) => log.error({ err }, 'Pushing notes failed'))
    if (!this.options.pushTo) return
    for (const binder of this.hub.state.binders) {
      let target: PushTarget | undefined
      try {
        target = await this.options.pushTo(binder)
      } catch (error) {
        this.pushed[binder.id] = { error: (error as Error).message }
        continue
      }
      if (!target) {
        delete this.pushed[binder.id]
        continue
      }
      try {
        const tree = (await this.git('rev-parse', `HEAD:${slug(binder.name)}`)).stdout.trim()
        const ref = `refs/binders/${binder.id}`
        const parent = (await this.git('rev-parse', '--verify', '-q', ref).catch(() => ({ stdout: '' }))).stdout.trim()
        const parentTree = parent ? (await this.git('rev-parse', `${parent}^{tree}`)).stdout.trim() : ''
        if (tree !== parentTree) {
          const message = (await this.git('log', '-1', '--format=%s')).stdout.trim() || 'Notes from Binders'
          const commit = (await this.git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message)).stdout.trim()
          await this.git('update-ref', ref, commit)
        }
        await this.pushRef(ref, target)
        this.pushed[binder.id] = { to: target.name, branch: target.branch, at: new Date().toISOString() }
      } catch (error) {
        const words = String((error as Error).message)
        const why = /HEAD:.*does not exist|exists on disk, but not in|Not a valid object/.test(words)
          ? 'No notes to push yet.'
          : /non-fast-forward|fetch first|rejected/.test(words)
            ? `${target.branch} on ${target.name} has commits the hub doesn’t. Pick a branch of its own for the notes.`
            : /403|denied|not found|404/i.test(words) ? `The hub can’t write to ${target.name}: is the GitHub App installed there, with contents write?` : words.split('\n').find((l) => l.trim())?.slice(0, 200) ?? 'Pushing failed.'
        this.pushed[binder.id] = { to: target.name, branch: target.branch, error: why }
        if (why !== 'No notes to push yet.') log.error({ binder: binder.name, why }, 'Pushing a binder’s notes failed')
      }
    }
  }

  private pushRef(ref: string, target: PushTarget) {
    const extra: Record<string, string> = target.token
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${new URL(target.url).origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${target.token}`).toString('base64')}` }
      : {}
    return this.git({ env: extra }, 'push', '-q', target.url, `${ref}:refs/heads/${target.branch}`)
  }

  private git(...args: string[]): Promise<{ stdout: string; stderr: string }>
  private git(options: { env: Record<string, string> }, ...args: string[]): Promise<{ stdout: string; stderr: string }>
  private git(first: string | { env: Record<string, string> }, ...rest: string[]): Promise<{ stdout: string; stderr: string }> {
    const extra = typeof first === 'string' ? {} : first.env
    const args = typeof first === 'string' ? [first, ...rest] : rest
    const { name, email } = this.options.author
    return run('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: this.options.dir,
      // Git never looks above the notes folder, so a notes folder inside another repo (this one, say) is never taken
      // for that repo: it gets its own.
      env: { ...process.env, ...extra, GIT_CEILING_DIRECTORIES: dirname(this.options.dir), GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    })
  }

  /** Makes the repo if needed, writes every note as it is now in one commit, then follows the log. */
  async start() {
    await mkdir(this.options.dir, { recursive: true })
    const top = await this.git('rev-parse', '--show-toplevel').then((r) => r.stdout.trim(), () => '')
    if (!top || (await realpath(top)) !== (await realpath(this.options.dir))) await this.git('init', '-q', '-b', 'main')
    for (const note of this.hub.state.notes) this.written.set(note.id, this.pathFor(note))
    await this.commit(this.hub.state.notes.map((n) => n.id), 'Notes as the hub has them')
    this.hub.on('entries', (entries) => this.follow(entries))
  }

  private follow(entries: Entry[]) {
    for (const { change } of entries) {
      switch (change.type) {
        case 'note.put':
          this.later(change.note.id)
          break
        case 'note.edit':
        case 'note.link':
        case 'note.move':
        case 'note.delete':
        case 'note.lock':
          this.later(change.id)
          break
        case 'folder.put':
        case 'binder.put':
        case 'folder.delete':
        case 'binder.delete':
          // A renamed or removed folder moves every note under it.
          for (const note of this.hub.state.notes) if (this.written.get(note.id) !== this.pathFor(note)) this.later(note.id)
          // A binder's repo, branch or switch changed: its notes go there now.
          if (change.type === 'binder.put') this.pushSoon()
          break
        default:
          break
      }
    }
  }

  private pushTimer?: NodeJS.Timeout
  private pushSoon() {
    clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push(), 1000)
  }

  /** One commit when a note's edits pause for a while, and at least every few minutes while they don't. */
  private later(noteId: string) {
    clearTimeout(this.timers.get(noteId))
    const since = this.waitingSince.get(noteId) ?? Date.now()
    this.waitingSince.set(noteId, since)
    const { quietMs, longestMs } = this.timing()
    const wait = Math.max(0, Math.min(quietMs, since + longestMs - Date.now()))
    this.timers.set(noteId, setTimeout(() => {
      this.timers.delete(noteId)
      this.waitingSince.delete(noteId)
      this.queue = this.queue.then(async () => { await this.commit([noteId]) }).catch((err) => log.error({ err, note: noteId }, 'Saving a note to Git failed'))
    }, wait))
  }

  /** A note's version now, named: nothing waits for typing to pause. */
  async version(noteId: string, subject: string) {
    clearTimeout(this.timers.get(noteId))
    this.timers.delete(noteId)
    this.waitingSince.delete(noteId)
    this.queue = this.queue.then(async () => { await this.commit([noteId], subject) }).catch((err) => log.error({ err, note: noteId }, 'Saving a note failed'))
    await this.queue
  }

  /** Writes these notes' files as the hub has them now, and commits if anything changed. */
  private async commit(noteIds: string[], subject?: string) {
    const touched: { note?: Note; path?: string }[] = []
    for (const id of noteIds) {
      const note = this.hub.state.notes.find((n) => n.id === id)
      const before = this.written.get(id)
      const path = note ? this.pathFor(note) : undefined
      if (before && before !== path) await this.remove(before)
      if (note && path) {
        await mkdir(join(this.options.dir, dirname(path)), { recursive: true })
        await writeFile(join(this.options.dir, path), toMarkdown(note))
        this.written.set(id, path)
      } else {
        this.written.delete(id)
      }
      touched.push({ note, path })
    }
    await this.git('add', '-A')
    const { stdout: staged } = await this.git('status', '--porcelain')
    const changed = !!staged.trim()
    if (changed) {
      const only = touched.length === 1 ? touched[0] : undefined
      const message = subject ?? (only?.note ? `Edit “${only.note.title}”` : 'Remove a note')
      await this.git('commit', '-q', '-m', message)
      await this.push()
    }
    // Saved either way: edits that came back to what the file had are in the last commit already.
    const sha = (await this.git('rev-parse', '--short', 'HEAD').catch(() => ({ stdout: '' }))).stdout.trim()
    if (sha) for (const { note, path } of touched) if (note && path) await this.hub.record({ kind: 'hub' }, { type: 'note.saved', id: note.id, commit: sha, path }, `saved-${note.id}-${sha}`)
    return changed
  }

  /** The notes still waiting for typing to pause, no longer waiting. */
  private takeWaiting() {
    const waiting = [...this.timers.keys()]
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.waitingSince.clear()
    return waiting
  }

  /**
   * Save all: commits every note still waiting for typing to pause, now, in one commit, and pushes each binder's notes
   * to its repo whether or not anything was waiting, so a push that failed before is tried again.
   */
  saveAll(): Promise<{ committed: number }> {
    const waiting = this.takeWaiting()
    const done = this.queue.then(async () => {
      const changed = waiting.length ? await this.commit(waiting, waiting.length > 1 ? `Save ${waiting.length} notes` : undefined) : false
      if (!changed) await this.push()
      return { committed: changed ? waiting.length : 0 }
    })
    this.queue = done.then(() => {}, () => {})
    return done
  }

  /** The note's path, with its id added when another note already has that name in that folder. */
  private pathFor(note: Note) {
    const path = pathOf(this.hub.state, note)
    const taken = [...this.written.entries()].some(([id, other]) => id !== note.id && other.toLowerCase() === path.toLowerCase())
    return taken ? path.replace(/\.md$/, `-${note.id.slice(-6)}.md`) : path
  }

  private async remove(path: string) {
    await rm(join(this.options.dir, path), { force: true })
    // Folders left empty go too, as Git doesn't keep them.
    let dir = dirname(path)
    while (dir && dir !== '.') {
      const full = join(this.options.dir, dir)
      const left = await readdir(full).catch(() => ['?'])
      if (left.length) break
      await rmdir(full).catch(() => {})
      dir = dirname(dir)
    }
  }

  /** A note's commits, newest first, following its file through renames. */
  async history(noteId: string): Promise<Commit[]> {
    const path = this.written.get(noteId)
    if (!path) return []
    const { stdout } = await this.git('log', '--follow', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', '--', path).catch(() => ({ stdout: '' }))
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [sha, short, author, at, subject] = line.split('\x1f')
      return { sha, short, author, at, subject }
    })
  }

  /** The note's file as one commit had it. */
  async at(noteId: string, sha: string) {
    if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new Error('Not a commit')
    const path = this.written.get(noteId)
    if (!path) return undefined
    // The file may have had another name then; Git finds it by following the history.
    const { stdout: names } = await this.git('log', '--follow', '--format=%H', '--name-only', '--', path)
    const lines = names.split('\n').map((l) => l.trim()).filter(Boolean)
    const index = lines.findIndex((l) => l.startsWith(sha))
    const then = index >= 0 ? lines[index + 1] : path
    const { stdout } = await this.git('show', `${sha}:${then}`)
    return stdout
  }

  /** Commits whatever is still waiting for typing to pause. */
  async stop() {
    const waiting = this.takeWaiting()
    this.queue = this.queue.then(async () => { if (waiting.length) await this.commit(waiting) })
    await this.queue
  }
}
