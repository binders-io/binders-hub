import type { IndexedRepo } from './repoIndex.ts'

// How the repo picker finds repos, among those a person may see. Nothing here reaches GitHub, and the route settles what
// a person may see before this runs, so every count made here is of repos they could list anyway.

export interface RepoFilter {
  /** Words looked for in its name, description, topics and properties' values. */
  q?: string
  topic?: string
  /** A property's name, with the value it must have. */
  property?: string
  value?: string
}

/** Whether a repo can be linked here, and why not. Unset, GitHub says so on linking. */
export interface Link {
  linkable?: boolean
  why?: string
}

/** The words among what GitHub gave. */
const words = (raw: unknown[]) => raw.filter((word): word is string => typeof word === 'string' && word !== '')

export const topicsOf = (raw: unknown) => (Array.isArray(raw) ? words(raw) : [])

/** GitHub gives a property's value as a string, a list or null, and older servers give no properties at all. */
export function propertiesOf(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).flatMap(([name, value]) => {
    const values = words(Array.isArray(value) ? value : [value])
    return values.length ? [[name, values]] : []
  }))
}

/**
 * Whether a repo can be linked, as `mayLink` will decide: `anyReached` for those who run a binder, linking its own repo
 * from those its app reaches, and `byName` for a hub tried out on this machine, with no GitHub to ask. A repo GitHub
 * didn't list as theirs stays unknown: `mayLink` asks about it, and it may yet be theirs.
 */
export function linkOf(repo: { archived?: boolean; push?: boolean }, who: { anyReached: boolean; token: boolean; byName: boolean }): Link {
  if (repo.archived) return { linkable: false, why: 'Archived on GitHub, so no work can happen there' }
  if (who.anyReached) return { linkable: true }
  if (!who.token) return who.byName ? { linkable: true } : { linkable: false, why: 'Connect your GitHub to this binder to link it' }
  if (repo.push === false) return { linkable: false, why: 'You can only read it, so it can’t be linked' }
  return repo.push ? { linkable: true } : {}
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** How well a repo answers the words: 0 is best, undefined is not at all. */
function rankOf(repo: IndexedRepo, typed: string) {
  if (!typed) return 0
  const full = repo.fullName.toLowerCase()
  const name = full.slice(full.indexOf('/') + 1)
  if (full === typed || name === typed) return 0
  if (name.startsWith(typed) || full.startsWith(typed)) return 1
  if (name.includes(typed)) return 2
  if (full.includes(typed)) return 3
  const elsewhere = [repo.description ?? '', ...(repo.topics ?? []), ...Object.values(repo.properties ?? {}).flat()].map((text) => text.toLowerCase())
  if (elsewhere.some((text) => text.includes(typed))) return 4
  // Words in any order, in its name or what GitHub says of it: "web api" finds acme/api-web.
  const parts = typed.split(/\s+/).filter(Boolean)
  if (parts.length > 1 && parts.every((p) => full.includes(p) || elsewhere.some((text) => text.includes(p)))) return 5
  return undefined
}

/** What can be linked first, then what GitHub will be asked about, then what can't be, then what's archived. */
const standingOf = (repo: IndexedRepo, link: Link) => (repo.archived ? 3 : link.linkable === false ? 2 : link.linkable === undefined ? 1 : 0)

const byCount = <T extends { count: number }>(name: (item: T) => string) => (a: T, b: T) => b.count - a.count || name(a).localeCompare(name(b))

/**
 * The repos matching a filter, best first, and what can be chosen next. Each choice is counted among the repos the
 * other choices leave, so it says what picking it gives, and what's chosen stays offered though nothing matches it now.
 * `link` says whether each match can be linked, for the order: asked only of the matches.
 */
export function filterRepos<T extends IndexedRepo>(repos: T[], filter: RepoFilter, link: (repo: T) => Link = () => ({})) {
  const typed = (filter.q ?? '').trim().toLowerCase()
  const { topic, property, value } = filter
  const ranked = repos.flatMap((repo) => {
    const rank = rankOf(repo, typed)
    return rank === undefined ? [] : [{ repo, rank }]
  })
  const hasTopic = (repo: T) => !topic || (repo.topics ?? []).some((t) => same(t, topic))
  const hasProperty = (repo: T) => !property || !value || Object.entries(repo.properties ?? {}).some(([name, values]) => same(name, property) && values.some((v) => same(v, value)))

  const topics = new Map<string, number>(topic ? [[topic, 0]] : [])
  for (const { repo } of ranked) if (hasProperty(repo)) for (const t of repo.topics ?? []) topics.set(t, (topics.get(t) ?? 0) + 1)

  const properties = new Map<string, Map<string, number>>(property && value ? [[property, new Map([[value, 0]])]] : [])
  for (const { repo } of ranked) {
    if (!hasTopic(repo)) continue
    for (const [name, values] of Object.entries(repo.properties ?? {})) {
      const counts = properties.get(name) ?? new Map<string, number>()
      properties.set(name, counts)
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
  }

  const matches = ranked.filter(({ repo }) => hasTopic(repo) && hasProperty(repo)).map((m) => ({ ...m, link: link(m.repo) }))
  matches.sort((a, b) => a.rank - b.rank || standingOf(a.repo, a.link) - standingOf(b.repo, b.link) || a.repo.fullName.length - b.repo.fullName.length || a.repo.fullName.localeCompare(b.repo.fullName))
  return {
    repos: matches.map(({ repo, link }) => ({ ...repo, ...link })),
    topics: [...topics].map(([name, count]) => ({ name, count })).sort(byCount((t) => t.name)),
    properties: [...properties]
      .map(([name, values]) => ({ name, values: [...values].map(([v, count]) => ({ value: v, count })).sort(byCount((v) => v.value)) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}
