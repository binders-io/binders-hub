import type { KV } from './kv.ts'

// The repos each of a GitHub App's installations reaches, kept in the hub's store and in memory, so picking one from an
// organization of tens of thousands is a lookup, not a walk through GitHub's pages on every keystroke. An installation
// is read a page of a hundred at a time, in the background: what's read so far is searchable at once, a hub that
// restarts goes on from the page it stopped at, and a complete list is read again after a while, the old one answering
// meanwhile. GitHub's word that repos were added to or removed from an installation changes the list as it comes.

export interface IndexedRepo {
  fullName: string
  private: boolean
}

/** One page of an installation's repos (a hundred at most), and how many it has in all, when GitHub says. */
export type RepoLister = (installation: number, page: number) => Promise<{ repos: IndexedRepo[]; total?: number }>

interface Kept {
  /** When the list was last read through, or started. */
  at: string
  done: boolean
  /** The page to go on from, while not done. */
  next?: number
  total?: number
  repos: [string, 0 | 1][]
}

interface Held {
  repos: Map<string, IndexedRepo>
  at: number
  done: boolean
  next: number
  total?: number
  reading?: Promise<void>
  /**
   * While a complete list is read again: GitHub's word of repos added (a repo) and removed (null) meanwhile, put on the
   * new list when it's done, as newer than any page it read.
   */
  changes?: Map<string, IndexedRepo | null>
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

export class RepoIndex {
  private held = new Map<number, Held>()
  private loading = new Map<number, Promise<Held>>()
  private kv: KV
  private list: RepoLister
  private options: IndexOptions

  constructor(kv: KV, list: RepoLister, options: Partial<IndexOptions> = {}) {
    this.kv = kv
    this.list = list
    this.options = { ...defaults, ...options }
  }

  private key(installation: number) {
    return `repo-index:${installation}`
  }

  /** An installation's list: in memory, or from the store, or a new empty one. */
  private async load(installation: number): Promise<Held> {
    const found = this.held.get(installation)
    if (found) return found
    let loading = this.loading.get(installation)
    if (!loading) {
      loading = (async () => {
        const raw = await this.kv.get(this.key(installation)).catch(() => undefined)
        let kept: Kept | undefined
        try { kept = raw ? (JSON.parse(raw) as Kept) : undefined } catch { kept = undefined }
        const held: Held = {
          repos: new Map((kept?.repos ?? []).map(([fullName, closed]) => [fullName.toLowerCase(), { fullName, private: closed === 1 }])),
          at: kept ? Date.parse(kept.at) || 0 : 0,
          done: kept?.done ?? false,
          next: kept?.next ?? 1,
          total: kept?.total,
        }
        this.held.set(installation, held)
        this.loading.delete(installation)
        return held
      })()
      this.loading.set(installation, loading)
    }
    return loading
  }

  private async save(installation: number, held: Held, repos = held.repos) {
    const kept: Kept = {
      at: new Date(held.at || this.options.now()).toISOString(),
      done: held.done,
      ...(held.done ? {} : { next: held.next }),
      ...(held.total === undefined ? {} : { total: held.total }),
      repos: [...repos.values()].map((r) => [r.fullName, r.private ? 1 : 0]),
    }
    await this.kv.set(this.key(installation), JSON.stringify(kept)).catch(() => undefined)
  }

  /** Starts reading any of these installations not read through yet, or read too long ago. Doesn't wait for it. */
  async ensure(installations: number[]) {
    const now = this.options.now()
    for (const installation of installations) {
      const held = await this.load(installation)
      if (held.reading) continue
      if (held.failedAt && now - held.failedAt < this.options.retryMs) continue
      if (held.done && now - held.at < this.options.staleMs) continue
      held.reading = this.read(installation, held).finally(() => { held.reading = undefined })
    }
  }

  /** Waits for the reading these installations are doing now, for tests and the first search of an empty list. */
  async settled(installations: number[]) {
    await Promise.all(installations.map((i) => this.held.get(i)?.reading))
  }

  /**
   * Reads an installation's repos through. A first read goes on from where it stopped, adding to what's searchable as
   * it goes; reading a complete list again builds a new one beside it, which replaces it when done.
   */
  private async read(installation: number, held: Held) {
    const again = held.done
    const fresh = again ? new Map<string, IndexedRepo>() : held.repos
    if (again) held.changes = new Map()
    let page = again ? 1 : held.next
    // Pages read at another time than the first ones may have moved (repos added or removed before them): a list read
    // that way is read again soon, from the start, if it came out short.
    const resumed = !again && page > 1
    const started = this.options.now()
    if (!again && page === 1) held.at = started
    for (;;) {
      let answer: { repos: IndexedRepo[]; total?: number } | undefined
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
      for (const repo of answer.repos) fresh.set(repo.fullName.toLowerCase(), repo)
      if (answer.total !== undefined) held.total = answer.total
      page++
      if (answer.repos.length < pageSize) break
      if (!again) {
        held.next = page
        if ((page - 1) % this.options.saveEvery === 0) await this.save(installation, held)
      }
      await pause(this.options.pauseMs)
    }
    for (const [key, repo] of held.changes ?? []) {
      if (repo) fresh.set(key, repo)
      else fresh.delete(key)
    }
    held.repos = fresh
    held.changes = undefined
    held.done = true
    held.next = 1
    held.at = again ? started : held.at || started
    if (resumed && held.total !== undefined && fresh.size < held.total) held.at = 0
    held.failedAt = undefined
    await this.save(installation, held)
  }

  /** Repos GitHub said were added to an installation, or found by searching it. */
  async add(installation: number, repos: IndexedRepo[]) {
    if (!repos.length) return
    const held = await this.load(installation)
    for (const repo of repos) {
      held.repos.set(repo.fullName.toLowerCase(), repo)
      held.changes?.set(repo.fullName.toLowerCase(), repo)
    }
    if (held.done) await this.save(installation, held)
  }

  /** Repos GitHub said were removed from an installation. */
  async remove(installation: number, names: string[]) {
    if (!names.length) return
    const held = await this.load(installation)
    for (const name of names) {
      held.repos.delete(name.toLowerCase())
      held.changes?.set(name.toLowerCase(), null)
    }
    if (held.done) await this.save(installation, held)
  }

  /** Forgets an installation's list: the app was uninstalled there. */
  async forget(installation: number) {
    this.held.delete(installation)
    await this.kv.del(this.key(installation)).catch(() => undefined)
  }

  /**
   * The repos of these installations that match what's typed, best first: the name itself, then names that start with
   * it, then names that have it. Nothing typed: the first, by name. `complete` says whether every list is read through.
   * `keep`, when given, says which repos may be shown at all, before the best are taken.
   */
  async search(installations: number[], typed: string, limit: number, keep?: (fullName: string) => boolean) {
    const words = typed.trim().toLowerCase()
    const lists = await Promise.all(installations.map((i) => this.load(i)))
    const scored: { repo: IndexedRepo; score: number }[] = []
    const seen = new Set<string>()
    for (const held of lists) {
      for (const [key, repo] of held.repos) {
        if (seen.has(key)) continue
        const score = rank(key, words)
        if (score === undefined || (keep && !keep(repo.fullName))) continue
        seen.add(key)
        scored.push({ repo, score })
      }
    }
    scored.sort((a, b) => a.score - b.score || a.repo.fullName.length - b.repo.fullName.length || a.repo.fullName.localeCompare(b.repo.fullName))
    return {
      repos: scored.slice(0, limit).map((s) => s.repo),
      more: Math.max(0, scored.length - limit),
      complete: lists.every((h) => h.done),
      indexed: lists.reduce((n, h) => n + h.repos.size, 0),
      total: lists.every((h) => h.total !== undefined) ? lists.reduce((n, h) => n + (h.total ?? 0), 0) : undefined,
    }
  }
}

/** How well a repo's name ("owner/name", in lower case) matches what's typed: lower is better; undefined, not at all. */
function rank(fullName: string, words: string) {
  if (!words) return 0
  const name = fullName.slice(fullName.indexOf('/') + 1)
  if (fullName === words || name === words) return 0
  if (name.startsWith(words) || fullName.startsWith(words)) return 1
  if (name.includes(words)) return 2
  if (fullName.includes(words)) return 3
  // Words in any order: "web api" finds acme/api-web.
  const parts = words.split(/\s+/).filter(Boolean)
  if (parts.length > 1 && parts.every((p) => fullName.includes(p))) return 4
  return undefined
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
