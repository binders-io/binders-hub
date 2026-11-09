import type { KV } from './kv.ts'
import { ListIndex, type Finisher, type IndexOptions, type ListKind } from './listIndex.ts'

// The repos each of a GitHub App's installations reaches, with what GitHub says of each (its description, topics and
// custom properties, whether it's archived), kept as listIndex.ts keeps a list: read in the background, a page at a time,
// so picking one from an organization of tens of thousands, or every one with a topic, is a lookup.

export interface IndexedRepo {
  fullName: string
  private: boolean
  description?: string
  archived?: boolean
  topics?: string[]
  /** Its custom properties, each with its values. Only an organization's repos have any. */
  properties?: Record<string, string[]>
}

/** One page of an installation's repos (a hundred at most), and how many it has in all, when GitHub says. */
export type RepoLister = (installation: number, page: number) => Promise<{ repos: IndexedRepo[]; total?: number }>

/** Kept as [name, flags (1 private, 2 archived), description, topics, properties], the empty ones left off the end. */
const repos: ListKind<IndexedRepo> = {
  key: (installation) => `repo-index:${installation}`,
  id: (repo) => repo.fullName.toLowerCase(),
  version: 2,
  keep: (repo) => {
    const kept: unknown[] = [repo.fullName, (repo.private ? 1 : 0) | (repo.archived ? 2 : 0), repo.description ?? '', repo.topics ?? [], repo.properties ?? {}]
    while (kept.length > 2) {
      const last = kept[kept.length - 1]
      if (last === '' || (Array.isArray(last) && !last.length) || (typeof last === 'object' && last && !Array.isArray(last) && !Object.keys(last).length)) kept.pop()
      else break
    }
    return kept
  },
  read: (kept) => {
    if (!Array.isArray(kept) || typeof kept[0] !== 'string') return undefined
    const [fullName, flags, description, topics, properties] = kept as [string, number, string?, string[]?, Record<string, string[]>?]
    return {
      fullName,
      private: (Number(flags) & 1) === 1,
      ...((Number(flags) & 2) === 2 ? { archived: true } : {}),
      ...(description ? { description } : {}),
      ...(Array.isArray(topics) && topics.length ? { topics } : {}),
      ...(properties && typeof properties === 'object' && Object.keys(properties).length ? { properties } : {}),
    }
  },
}

export class RepoIndex extends ListIndex<IndexedRepo> {
  constructor(kv: KV, list: RepoLister, options: Partial<IndexOptions> = {}, finish?: Finisher<IndexedRepo>) {
    super(kv, repos, async (installation, page) => {
      const answer = await list(installation, page)
      return { items: answer.repos, total: answer.total }
    }, options, finish)
  }

  /**
   * The repos of these installations that match what's typed, best first: the name itself, then names that start with
   * it, then names that have it. Nothing typed: the first, by name. `complete` says whether every list is read through.
   * `keep`, when given, says which repos may be shown at all, before the best are taken.
   */
  async search(installations: number[], typed: string, limit: number, keep?: (fullName: string) => boolean) {
    const words = typed.trim().toLowerCase()
    const { items, ...progress } = await this.all(installations, keep ? (repo) => keep(repo.fullName) : undefined)
    const scored: { repo: IndexedRepo; score: number }[] = []
    for (const { item } of items) {
      const score = rank(item.fullName.toLowerCase(), words)
      if (score !== undefined) scored.push({ repo: item, score })
    }
    scored.sort((a, b) => a.score - b.score || a.repo.fullName.length - b.repo.fullName.length || a.repo.fullName.localeCompare(b.repo.fullName))
    return { repos: scored.slice(0, limit).map((s) => s.repo), more: Math.max(0, scored.length - limit), ...progress }
  }
}

/** How well a repo's name ("owner/name", in lower case) matches what's typed: lower is better; undefined, not at all. */
export function rank(fullName: string, words: string) {
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
