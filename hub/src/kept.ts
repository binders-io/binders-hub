import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HubState } from '../../shared/state.ts'
import type { Hub } from './hub.ts'
import type { KV } from './kv.ts'
import { log } from './logger.ts'

// Redis is the hub's working copy, and can be rebuilt with nothing lost that matters. What has to last is in files on
// the hub's disk, with its notes: a Binder's whole state (StateFile), and the settings, keys and tokens' hashes the hub
// keeps beside it (KeptKV). What's only for now stays in Redis: sign-ins, one-time codes, and what can be made again.

/** Written whole and then moved into place: a stop halfway leaves the file as it was. Only the hub's user may read it. */
async function writeWhole(file: string, text: string | Uint8Array) {
  await mkdir(dirname(file), { recursive: true })
  const next = `${file}.new`
  await writeFile(next, text, { mode: 0o600 })
  await rename(next, file)
}

/** Kept in Redis alone though they have no time limit: the hub makes them again. */
const madeAgain = (key: string) => key.startsWith('brain:') || key.startsWith('repo-index:') || key.startsWith('people-index:')

/**
 * Keys that last, in a file on the hub's disk, with a copy in Redis. A key with a time limit is only for now, and stays
 * in Redis alone. A hub with an empty Redis reads on as if nothing happened.
 */
export class KeptKV implements KV {
  private inner: KV
  private file: string
  private values = new Map<string, string>()
  private writing: Promise<unknown> = Promise.resolve()

  constructor(inner: KV, file: string) {
    this.inner = inner
    this.file = file
  }

  /** Reads the file, and takes from Redis any lasting key it doesn't have yet: all of them, the first time. */
  async load(lasting?: (skip: (key: string) => boolean) => Promise<[string, string][]>) {
    const raw = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (raw) {
      // Not a guess at empty: starting without them would look like a hub that was never set up.
      for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, string>)) this.values.set(key, value)
    }
    const found = await lasting?.((key) => madeAgain(key) || this.values.has(key)) ?? []
    for (const [key, value] of found) this.values.set(key, value)
    if (found.length) await this.save()
    return this
  }

  private save() {
    const done = this.writing.then(() => writeWhole(this.file, JSON.stringify(Object.fromEntries(this.values))))
    this.writing = done.catch(() => undefined)
    return done
  }

  async get(key: string) {
    return this.values.get(key) ?? this.inner.get(key)
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds || madeAgain(key)) {
      if (this.values.delete(key)) await this.save()
      await this.inner.set(key, value, ttlSeconds)
      return
    }
    this.values.set(key, value)
    await this.save()
    // The file has it: Redis being away doesn't lose it.
    await this.inner.set(key, value).catch((error: Error) => log.warn({ key, why: error.message }, 'Couldn’t copy a key to Redis'))
  }

  async del(key: string) {
    if (this.values.delete(key)) await this.save()
    await this.inner.del(key)
  }

  async take(key: string) {
    const kept = this.values.get(key)
    if (kept === undefined) return this.inner.take(key)
    this.values.delete(key)
    await this.save()
    await this.inner.del(key).catch(() => undefined)
    return kept
  }
}

export interface SavedState {
  version: number
  state: HubState
}

/**
 * A Binder's whole state in a file: its notes, cards, agents and change sets as the log has made them, at a version,
 * with each note's shared-editing document in a folder beside it. A hub starts from here and reads only what its log
 * has after that version, so the log is kept short: once the state is saved, what's well behind it is forgotten. Saved
 * soon after changes and when it stops.
 *
 * The file as it was a day ago, or at the last start, is kept as state.prev.json, and the log is never cut past it: if
 * the state file can't be read, the one before it and the log still make the Binder whole.
 */
export class StateFile {
  private file: string
  private previous: string
  private docsDir: string
  private hub?: Hub
  private everyMs: number
  private options: { keep: number; previousEveryMs: number; now: () => number }
  private timer?: NodeJS.Timeout
  private saved = -1
  private writing: Promise<unknown> = Promise.resolve()
  /** The version of the state file on disk now, and whether it could be read; and of the one kept from before. */
  private onDisk = -1
  private readable = false
  private previousVersion = -1
  private previousAt = 0
  private trimmed = 0
  /** Says a state and its notes' documents were saved here at least once: written after the first, never before. */
  private marker: string
  private marked = false

  /**
   * `keep`: how many changes stay in the log behind the saved state, for pages catching up from where they were.
   * `previousEveryMs`: how often the file is kept aside as the one before.
   */
  constructor(file: string, everyMs = 15_000, options: { keep?: number; previousEveryMs?: number; now?: () => number } = {}) {
    this.file = file
    this.previous = file.replace(/(\.json)?$/, '.prev.json')
    this.docsDir = join(dirname(file), 'note-docs')
    this.marker = join(this.docsDir, '.saved')
    this.everyMs = everyMs
    this.options = { keep: 5000, previousEveryMs: 24 * 60 * 60_000, now: () => Date.now(), ...options }
  }

  private static async readFrom(file: string): Promise<SavedState | undefined> {
    const raw = await readFile(file, 'utf8').catch(() => undefined)
    if (!raw) return undefined
    try {
      const saved = JSON.parse(raw) as SavedState
      return typeof saved.version === 'number' && saved.state ? saved : undefined
    } catch (error) {
      log.error({ file, why: (error as Error).message }, 'Couldn’t read a Binder’s saved state')
      return undefined
    }
  }

  /**
   * The state as it was last saved; the one kept from before when that can't be read; undefined for a Binder that
   * never saved one. A Binder that did, with neither left to read, isn't started on what little its log still holds.
   */
  async read(): Promise<SavedState | undefined> {
    const saved = await StateFile.readFrom(this.file)
    if (saved) {
      this.onDisk = saved.version
      this.readable = true
      return saved
    }
    const before = await StateFile.readFrom(this.previous)
    if (before) {
      log.error({ file: this.file, version: before.version }, 'A Binder’s saved state couldn’t be read: starting from the one kept before it, and what the log has since')
      this.previousVersion = before.version
      return before
    }
    const had = await stat(this.marker).then(() => true, () => false)
    if (had) throw new Error(`This Binder’s saved state (${this.file}) is missing or can’t be read, and so is the one kept before it. Its change log no longer holds its whole history, so it isn’t started on what’s left: put the file back from a backup, then start the hub again.`)
    return undefined
  }

  /**
   * The notes' documents saved beside the state, by note. Undefined: none were ever saved here (a Binder from before
   * they were), so its whole log is read once more to make them.
   */
  async readDocs(): Promise<Map<string, Uint8Array> | undefined> {
    this.marked = await stat(this.marker).then(() => true, () => false)
    if (!this.marked) return undefined
    const names = await readdir(this.docsDir).catch(() => [] as string[])
    const docs = new Map<string, Uint8Array>()
    for (const name of names) {
      if (!name.endsWith(docEnd)) continue
      const bytes = await readFile(join(this.docsDir, name)).catch(() => undefined)
      if (bytes) docs.set(decodeURIComponent(name.slice(0, -docEnd.length)), new Uint8Array(bytes))
    }
    return docs
  }

  /** Saves it now, and again soon after each change. The file as it was before this start is kept beside it first. */
  async follow(hub: Hub) {
    this.hub = hub
    hub.on('entries', this.changed)
    if (this.readable) await this.keepPrevious()
    await this.save()
  }

  /** Keeps the state file as it is on disk as the one before: what the log is never cut past. */
  private async keepPrevious() {
    if (this.onDisk < 0) return
    const kept = await copyFile(this.file, this.previous).then(() => true, () => false)
    if (!kept) return
    this.previousVersion = this.onDisk
    this.previousAt = this.options.now()
  }

  private changed = () => {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.save().catch((error: Error) => log.error({ file: this.file, why: error.message }, 'Couldn’t save a Binder’s state'))
    }, this.everyMs)
    this.timer.unref?.()
  }

  /**
   * The state and the documents that changed, both as they are at this moment: the documents are written first, so a
   * state on disk never has a document older than it beside it. Then the log is cut to what's still needed.
   */
  save(): Promise<unknown> {
    const hub = this.hub
    if (!hub || hub.version === this.saved) return this.writing
    const version = hub.version
    const docs = hub.changedDocs()
    let text: string
    try {
      text = JSON.stringify({ version, at: new Date().toISOString(), state: hub.state })
    } catch (error) {
      // Too much to write as one text: said, and tried again with the next change, the hub going on meanwhile.
      hub.docsChangedAgain(docs.keys())
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const was = this.saved
    this.saved = version
    const done = this.writing.then(async () => {
      try {
        for (const [noteId, bytes] of docs) {
          const file = join(this.docsDir, `${encodeURIComponent(noteId)}${docEnd}`)
          if (bytes) await writeWhole(file, bytes)
          else await rm(file, { force: true })
        }
        if (this.readable && this.options.now() - this.previousAt >= this.options.previousEveryMs) await this.keepPrevious()
        await writeWhole(this.file, text)
      } catch (error) {
        hub.docsChangedAgain(docs.keys())
        if (this.saved === version) this.saved = was
        throw error
      }
      this.onDisk = version
      this.readable = true
      // Only now: a log cut short always has a state and this mark beside it.
      if (!this.marked) {
        await writeWhole(this.marker, '')
        this.marked = true
      }
      // Behind the saved state, and never past the one kept before it.
      const upTo = Math.min(version - this.options.keep, this.previousVersion)
      if (hub.log.trim && upTo > this.trimmed) {
        await hub.log.trim(upTo).then(() => { this.trimmed = upTo }, (error: Error) => log.warn({ file: this.file, why: error.message }, 'Couldn’t shorten a Binder’s change log'))
      }
    })
    this.writing = done.catch(() => undefined)
    return done
  }

  async stop() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.hub?.off('entries', this.changed)
    await this.save().catch((error: Error) => log.error({ file: this.file, why: error.message }, 'Couldn’t save a Binder’s state as it stopped'))
    await this.writing
  }
}

/** A note's document on disk: its id, made safe for a file's name, with this at the end. */
const docEnd = '.automerge'
