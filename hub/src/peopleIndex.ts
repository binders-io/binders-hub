import type { KV } from './kv.ts'
import { ListIndex, type IndexOptions, type Lister, type ListKind } from './listIndex.ts'

// The people in each organization a GitHub App is installed on, kept as listIndex.ts keeps a list: read in the
// background a page at a time, so an organization of thousands is searched as a name is typed, not read through GitHub's
// pages first. Read again every couple of hours, and at once as GitHub says someone joined or left.

export interface Member {
  login: string
  avatar?: string
}

const people: ListKind<Member> = {
  key: (installation) => `people-index:${installation}`,
  id: (member) => member.login.toLowerCase(),
  version: 1,
  keep: (member) => (member.avatar ? [member.login, member.avatar] : [member.login]),
  read: (kept) => (Array.isArray(kept) && typeof kept[0] === 'string' ? { login: kept[0], ...(typeof kept[1] === 'string' && kept[1] ? { avatar: kept[1] } : {}) } : undefined),
}

export class PeopleIndex extends ListIndex<Member> {
  constructor(kv: KV, list: Lister<Member>, options: Partial<IndexOptions> = {}) {
    super(kv, people, list, { staleMs: 2 * 60 * 60_000, ...options })
  }

  /**
   * The people of these installations' organizations whose login matches what's typed, best first: the login itself,
   * then logins that start with it, then logins that have it. Nothing typed: the first, by login. `managed`, when
   * they're Enterprise Managed Users, is the enterprise's shortcode their logins end in.
   */
  async search(installations: number[], typed: string, limit: number) {
    const words = typed.trim().replace(/^@/, '').toLowerCase()
    const { items, ...progress } = await this.all(installations)
    const scored: { member: Member; installation: number; score: number }[] = []
    for (const { item, installation } of items) {
      const login = item.login.toLowerCase()
      const score = !words ? 0 : login === words ? 0 : login.startsWith(words) ? 1 : login.includes(words) ? 2 : undefined
      if (score !== undefined) scored.push({ member: item, installation, score })
    }
    scored.sort((a, b) => a.score - b.score || a.member.login.length - b.member.login.length || a.member.login.localeCompare(b.member.login))
    // Each organization on its own: one of managed users beside an ordinary one is still one.
    const managed = installations.map((i) => managedShortcode(items.filter((x) => x.installation === i).map((x) => x.item.login))).find(Boolean)
    return {
      people: scored.slice(0, limit).map((s) => ({ ...s.member, installation: s.installation })),
      more: Math.max(0, scored.length - limit),
      managed,
      ...progress,
    }
  }
}

/**
 * The shortcode of an organization of Enterprise Managed Users, from its members: in one, the accounts end in the
 * enterprise's shortcode (`jdoe_acme`). Undefined for an ordinary organization, where logins have no underscore.
 */
export function managedShortcode(logins: string[]) {
  if (!logins.length) return undefined
  // Most of them, not all: the enterprise's setup account is `<shortcode>_admin`.
  const counts = new Map<string, number>()
  for (const login of logins) {
    const end = /_([A-Za-z0-9]{1,20})$/.exec(login)?.[1]?.toLowerCase()
    if (end) counts.set(end, (counts.get(end) ?? 0) + 1)
  }
  const [top, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? []
  return top && count! >= Math.ceil(logins.length * 0.8) ? top : undefined
}
