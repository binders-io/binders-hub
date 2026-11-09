import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HubState } from '../../shared/state.ts'
import type { Hub } from './hub.ts'
import type { KV } from './kv.ts'
import { log } from './logger.ts'

// Redis is the hub's working copy, and can be rebuilt with nothing lost that matters. What has to last is in files on
// the hub's disk, with its notes: a Binder's whole state (StateFile), and the settings, keys and tokens' hashes the hub
// keeps beside it (KeptKV). What's only for now stays in Redis: sign-ins, one-time codes, and what can be made again.

/** Written whole and then moved into place: a stop halfway leaves the file as it was. Only the hub's user may read it. */
async function writeWhole(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  const next = `${file}.new`
  await writeFile(next, text, { mode: 0o600 })
  await rename(next, file)
}

/** Kept in Redis alone though they have no time limit: the hub makes them again. */
const madeAgain = (key: string) => key.startsWith('brain:') || key.startsWith('repo-index:')

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
 * A Binder's whole state in a file: its notes, cards, agents and change sets as the log has made them, at a version. A
 * hub whose log is behind that version lost it, and carries on from here. Saved soon after changes and when it stops.
 */
export class StateFile {
  private file: string
  private hub?: Hub
  private everyMs: number
  private timer?: NodeJS.Timeout
  private saved = -1
  private writing: Promise<unknown> = Promise.resolve()

  constructor(file: string, everyMs = 15_000) {
    this.file = file
    this.everyMs = everyMs
  }

  async read(): Promise<SavedState | undefined> {
    const raw = await readFile(this.file, 'utf8').catch(() => undefined)
    if (!raw) return undefined
    try {
      const saved = JSON.parse(raw) as SavedState
      return typeof saved.version === 'number' && saved.state ? saved : undefined
    } catch (error) {
      log.error({ file: this.file, why: (error as Error).message }, 'Couldn’t read a Binder’s saved state')
      return undefined
    }
  }

  /**
   * Saves it now, and again soon after each change. What the file held before this start is kept beside it first, as
   * state.prev.json: one start back, should this one have read its log wrong.
   */
  async follow(hub: Hub) {
    this.hub = hub
    hub.on('entries', this.changed)
    await copyFile(this.file, this.file.replace(/(\.json)?$/, '.prev.json')).catch(() => undefined)
    await this.save()
  }

  private changed = () => {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.save().catch((error: Error) => log.error({ file: this.file, why: error.message }, 'Couldn’t save a Binder’s state'))
    }, this.everyMs)
    this.timer.unref?.()
  }

  save() {
    const hub = this.hub
    if (!hub || hub.version === this.saved) return this.writing
    const version = hub.version
    const text = JSON.stringify({ version, at: new Date().toISOString(), state: hub.state })
    this.saved = version
    const done = this.writing.then(() => writeWhole(this.file, text))
    this.writing = done.catch(() => undefined)
    return done
  }

  async stop() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.hub?.off('entries', this.changed)
    await this.save()
    await this.writing
  }
}
