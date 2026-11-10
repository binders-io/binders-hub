import type { KV } from './kv.ts'

// A list GitHub gives a page at a time for each of a GitHub App's installations (the repos it reaches, an organization's
// people), kept in the hub's store and in memory, so finding one among tens of thousands is a lookup, not a walk through
// GitHub's pages on every keystroke. An installation's list is read a page of a hundred at a time, in the background:
// what's read so far is searchable at once, a hub that restarts goes on from the page it stopped at, and a complete list
// is read again after a while, the old one answering meanwhile. GitHub's word of something added or removed changes the
// list as it comes. What's kept is a copy of GitHub's: lost, it's read again.

/** How a kind of thing is kept. */
export interface ListKind<T> {
  /** The store's key for an installation's list. */
  key: (installation: number) => string
  /** What a thing is known by: the same whatever its case. */
  id: (item: T) => string
  /** A thing as it's kept, and back again (undefined: it can't be read, and is left out). */
  keep: (item: T) => unknown
  read: (kept: unknown) => T | undefined
  /** The shape it's kept in: a list kept in an older shape answers, and is read again at once. */
  version: number
}

/**
 * One page of an installation's list, a hundred at most; how many it has in all, when GitHub says; and how many GitHub
 * gave, when some were left out (a page with fewer than a hundred is the last).
 */
export type Lister<T> = (installation: number, page: number) => Promise<{ items: T[]; total?: number; size?: number }>

/** What reading a list through found besides the list itself, kept with it: run once each time it's read through. */
export type Finisher<T> = (installation: number, items: Map<string, T>) => Promise<Record<string, unknown> | undefined>

interface Kept {
  /** The shape it's kept in. None: the first. */
  v?: number
  /** When the list was last read through, or started. */
  at: string
  done: boolean
  /** The page to go on from, while not done. */
  next?: number
  total?: number
  items?: unknown[]
  /** The repos' list, before it was kept as items. */
  repos?: unknown[]
  meta?: Record<string, unknown>
}

interface Held<T> {
  items: Map<string, T>
  at: number
  done: boolean
  next: number
  total?: number
  meta?: Record<string, unknown>
  reading?: Promise<void>
  /**
   * While a complete list is read again: GitHub's word of things added (the thing) and removed (null) meanwhile, put on
   * the new list when it's done, as newer than any page it read.
   */
  changes?: Map<string, T | null>
  /** When reading last failed, to wait before trying again. */
  failedAt?: number
}

export interface IndexOptions {
  /** How old a complete list gets before it's read again. */
  staleMs: number
  /** Between pages, to leave GitHub's rate limit for everything else. */
  pauseMs: number
  /** How many pages between saves, while reading. */
  saveEvery: number
  /** How long after a failed read to try again. */
  retryMs: number
  now: () => number
}

const defaults: IndexOptions = { staleMs: 6 * 60 * 60_000, pauseMs: 100, saveEvery: 10, retryMs: 5 * 60_000, now: () => Date.now() }
const pageSize = 100

/** How far these installations' lists are read: all through, how many so far, and how many in all when GitHub said. */
export interface Progress {
  complete: boolean
  indexed: number
  total?: number
  /** Reading one of them failed the last time it was tried. */
  failed?: boolean
}

export class ListIndex<T> {
  private held = new Map<number, Held<T>>()
  private loading = new Map<number, Promise<Held<T>>>()
  private kv: KV
  private kind: ListKind<T>
  private list: Lister<T>
  private finish?: Finisher<T>
  protected options: IndexOptions

  constructor(kv: KV, kind: ListKind<T>, list: Lister<T>, options: Partial<IndexOptions> = {}, finish?: Finisher<T>) {
    this.kv = kv
    this.kind = kind
    this.list = list
    this.finish = finish
    this.options = { ...defaults, ...options }
  }

  /** An installation's list: in memory, or from the store, or a new empty one. */
  private async load(installation: number): Promise<Held<T>> {
    const found = this.held.get(installation)
    if (found) return found
    let loading = this.loading.get(installation)
    if (!loading) {
      loading = (async () => {
        const raw = await this.kv.get(this.kind.key(installation)).catch(() => undefined)
        let kept: Kept | undefined
        try { kept = raw ? (JSON.parse(raw) as Kept) : undefined } catch { kept = undefined }
        const items = new Map<string, T>()
        for (const each of kept?.items ?? kept?.repos ?? []) {
          const item = this.kind.read(each)
          if (item) items.set(this.kind.id(item), item)
        }
        const current = (kept?.v ?? 1) >= this.kind.version
        const held: Held<T> = {
          items,
          // Kept in an older shape: stale, so it's read again now, answering meanwhile.
          at: kept && current ? Date.parse(kept.at) || 0 : 0,
          done: kept?.done ?? false,
          next: kept?.next ?? 1,
          total: kept?.total,
          meta: kept?.meta,
        }
        this.held.set(installation, held)
        this.loading.delete(installation)
        return held
      })()
      this.loading.set(installation, loading)
    }
    return loading
  }

  private async save(installation: number, held: Held<T>, items = held.items) {
    const kept: Kept = {
      v: this.kind.version,
      at: new Date(held.at || this.options.now()).toISOString(),
      done: held.done,
      ...(held.done ? {} : { next: held.next }),
      ...(held.total === undefined ? {} : { total: held.total }),
      ...(held.meta ? { meta: held.meta } : {}),
      items: [...items.values()].map((item) => this.kind.keep(item)),
    }
    await this.kv.set(this.kind.key(installation), JSON.stringify(kept)).catch(() => undefined)
  }

  /**
   * Starts reading any of these installations not read through yet, or read too long ago. Doesn't wait for it.
   * `again`: one that failed lately is tried now, as someone asked to.
   */
  async ensure(installations: number[], again = false) {
    const now = this.options.now()
    for (const installation of installations) {
      const held = await this.load(installation)
      if (held.reading) continue
      if (held.failedAt && !again && now - held.failedAt < this.options.retryMs) continue
      if (held.done && held.at && now - held.at < this.options.staleMs) continue
      held.reading = this.read(installation, held).finally(() => { held.reading = undefined })
    }
  }

  /** Waits for the reading these installations are doing now, for tests and the first search of an empty list. */
  async settled(installations: number[]) {
    await Promise.all(installations.map((i) => this.held.get(i)?.reading))
  }

  /**
   * Reads an installation's list through. A first read goes on from where it stopped, adding to what's searchable as
   * it goes; reading a complete list again builds a new one beside it, which replaces it when done.
   */
  private async read(installation: number, held: Held<T>) {
    const again = held.done
    const fresh = again ? new Map<string, T>() : held.items
    if (again) held.changes = new Map()
    let page = again ? 1 : held.next
    // Pages read at another time than the first ones may have moved (things added or removed before them): a list read
    // that way is read again soon, from the start, if it came out short.
    const resumed = !again && page > 1
    const started = this.options.now()
    if (!again && page === 1) held.at = started
    for (;;) {
      let answer: Awaited<ReturnType<Lister<T>>> | undefined
      for (let attempt = 0; attempt < 3 && !answer; attempt++) {
        answer = await this.list(installation, page).catch(() => undefined)
        if (!answer && attempt < 2) await pause(this.options.pauseMs * 10 * (attempt + 1))
      }
      if (!answer) {
        held.failedAt = this.options.now()
        held.changes = undefined
        if (!again) await this.save(installation, held)
        return
      }
      for (const item of answer.items) fresh.set(this.kind.id(item), item)
      if (answer.total !== undefined) held.total = answer.total
      page++
      if ((answer.size ?? answer.items.length) < pageSize) break
      if (!again) {
        held.next = page
        if ((page - 1) % this.options.saveEvery === 0) await this.save(installation, held)
      }
      await pause(this.options.pauseMs)
    }
    for (const [key, item] of held.changes ?? []) {
      if (item) fresh.set(key, item)
      else fresh.delete(key)
    }
    // What else the list needs, now it's whole (for repos, their custom properties when the list didn't carry them).
    const meta = this.finish ? await this.finish(installation, fresh).catch(() => undefined) : undefined
    held.items = fresh
    held.changes = undefined
    held.done = true
    held.next = 1
    if (meta) held.meta = meta
    held.at = again ? started : held.at || started
    if (resumed && held.total !== undefined && fresh.size < held.total) held.at = 0
    held.failedAt = undefined
    await this.save(installation, held)
  }

  /**
   * Things GitHub said were added to an installation's list, or found by asking it. `onlyNew`: those it has already
   * stay as they are, for what was found by a way of asking that says less of them.
   */
  async add(installation: number, items: T[], onlyNew = false) {
    if (!items.length) return
    const held = await this.load(installation)
    for (const item of items) {
      const key = this.kind.id(item)
      if (onlyNew && held.items.has(key)) continue
      held.items.set(key, item)
      held.changes?.set(key, item)
    }
    if (held.done) await this.save(installation, held)
  }

  /** Things GitHub said were removed from an installation's list, by what they're known by. */
  async remove(installation: number, ids: string[]) {
    if (!ids.length) return
    const held = await this.load(installation)
    for (const id of ids) {
      const key = id.toLowerCase()
      held.items.delete(key)
      held.changes?.set(key, null)
    }
    if (held.done) await this.save(installation, held)
  }

  /** Forgets an installation's list: the app was uninstalled there. */
  async forget(installation: number) {
    this.held.delete(installation)
    await this.kv.del(this.kind.key(installation)).catch(() => undefined)
  }

  /**
   * Everything in these installations' lists, each thing once, with the installation it's from, and how far they're
   * read. `keep`, when given, says which may be had at all.
   */
  async all(installations: number[], keep?: (item: T) => boolean): Promise<{ items: { item: T; installation: number }[] } & Progress> {
    const lists = await Promise.all(installations.map((i) => this.load(i)))
    const items: { item: T; installation: number }[] = []
    const seen = new Set<string>()
    lists.forEach((held, n) => {
      for (const [key, item] of held.items) {
        if (seen.has(key) || (keep && !keep(item))) continue
        seen.add(key)
        items.push({ item, installation: installations[n] })
      }
    })
    return { items, ...this.progressOf(lists) }
  }

  private progressOf(lists: Held<T>[]): Progress {
    return {
      complete: lists.every((h) => h.done),
      indexed: lists.reduce((n, h) => n + h.items.size, 0),
      total: lists.every((h) => h.total !== undefined) ? lists.reduce((n, h) => n + (h.total ?? 0), 0) : undefined,
      ...(lists.some((h) => h.failedAt) ? { failed: true } : {}),
    }
  }

  /** How an installation's list stands: how far it's read, when it was read through, and what else was found then. */
  async status(installation: number) {
    const held = await this.load(installation)
    return { ...this.progressOf([held]), at: held.done && held.at ? new Date(held.at).toISOString() : undefined, reading: !!held.reading, meta: held.meta }
  }
}

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
