import type { Actions } from './actions.ts'
import type { GitHubConnection } from './githubConnection.ts'
import type { JiraConnection } from './jira.ts'
import { Refused, type Hub } from './hub.ts'
import type { KV } from './kv.ts'
import type { GitHubPoller } from './poller.ts'
import type { GitNotesSaver } from './savers/gitNotes.ts'
import type { IssuesSaver } from './savers/issues.ts'
import type { JiraSaver } from './savers/jira.ts'
import type { Webhooks } from './webhooks.ts'

// One hub, several Binders: each its own team, with its own change log, projects, notes, cards and agents, and its own
// members, and its own GitHub: its app, installations and webhook, and each member's sign-in to it. In the code a
// Binder is a space (its log's name in Redis, hub:<space>:…), since "binder" already names a project inside one, as the
// log and the apps have always called it. Sessions, people's and agents' tokens and the hub's options are the hub's
// own, shared by all its Binders.

export type Role = 'owner' | 'admin' | 'member'

export interface Member {
  login: string
  role: Role
}

export interface SpaceInfo {
  id: string
  name: string
  createdAt: string
  createdBy: string
  /** Who may open it. None: anyone the hub lets in, as on a hub with one Binder nobody has set up. */
  members: Member[]
  /** A person's own Binder: their login. Nobody else opens it, the hub's admins included. */
  personal?: string
  /** For a personal Binder: the Binder whose GitHub App it reaches GitHub through (the one its person signs in by). */
  home?: string
}

/** A Binder's running parts. */
export interface Space {
  id: string
  hub: Hub
  actions: Actions
  webhooks: Webhooks
  /** How it reaches GitHub: its own app, installations and webhook. */
  github: GitHubConnection
  notes?: GitNotesSaver
  poller?: GitHubPoller
  issues?: IssuesSaver
  /** The binder's own Jira: its saver writes cards there, its webhook brings what happened back. */
  jira?: JiraConnection
  jiraIssues?: JiraSaver
  /** Where pictures put in its notes are kept. */
  filesDir?: string
  stop?: () => Promise<void>
}

/** Names a Binder's address can't take: the hub's own paths. */
const reserved = new Set(['api', 'auth', 'oauth', 'setup', 'mcp', 'webhooks', 'runner', 'health', 'ready', 'assets', 'static', 'admin', 'new', 'hub', 'install', 'icons'])
export const spaceIdPattern = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/
/** A person's own Binder is at /~login. */
export const personalId = (login: string) => `~${login.toLowerCase()}`
// A GitHub login, or an Enterprise Managed User's, which ends in its enterprise's shortcode (`jdoe_acme`).
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:_[A-Za-z0-9]{1,20})?$/
const listKey = 'spaces'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The first Binder a hub's store already holds (the hub's own keys, `kv`), so a hub keeps its address when the default changes. */
export async function firstSpaceIn(kv: KV) {
  const raw = await kv.get(listKey).catch(() => undefined)
  const infos = raw ? (JSON.parse(raw) as SpaceInfo[]) : []
  return (infos.find((i) => i.createdBy === 'hub') ?? infos.find((i) => !i.personal))?.id
}

export class Spaces {
  private kv: KV
  private make: (id: string, info: SpaceInfo) => Promise<Space>
  private infos: SpaceInfo[] = []
  private running = new Map<string, Space>()

  /** `make` starts a Binder's parts; the first Binder is the one this hub had before it held several. */
  constructor(kv: KV, make: (id: string, info: SpaceInfo) => Promise<Space>) {
    this.kv = kv
    this.make = make
  }

  /** Reads which Binders there are and starts each. A hub with none gets `first`, with `members`. */
  async load(first: { id: string; name: string; members: Member[] }) {
    const raw = await this.kv.get(listKey)
    this.infos = raw ? (JSON.parse(raw) as SpaceInfo[]) : []
    if (!this.infos.length) {
      this.infos = [{ id: first.id, name: first.name, createdAt: new Date().toISOString(), createdBy: 'hub', members: first.members }]
      await this.save()
    }
    // Team Binders first: a personal one reaches GitHub through one of them.
    for (const info of [...this.infos.filter((i) => !i.personal), ...this.infos.filter((i) => i.personal)]) this.running.set(info.id, await this.make(info.id, info))
    return this
  }

  /** For tests and hubs started by hand: Binders already running, kept in memory. */
  static of(kv: KV, spaces: { info: Omit<SpaceInfo, 'createdAt' | 'createdBy'>; space: Space }[]) {
    const made = new Spaces(kv, async () => { throw new Refused('This hub can’t make Binders.') })
    for (const { info, space } of spaces) {
      made.infos.push({ ...info, createdAt: new Date().toISOString(), createdBy: 'hub' })
      made.running.set(info.id, space)
    }
    return made
  }

  private async save() {
    await this.kv.set(listKey, JSON.stringify(this.infos))
  }

  list() {
    return this.infos
  }

  info(id: string) {
    return this.infos.find((s) => s.id === id)
  }

  get(id: string) {
    return this.running.get(id)
  }

  all() {
    return [...this.running.values()]
  }

  /** Everyone who's a member of a Binder: let in to sign in, like the hub's allowed people. */
  people() {
    return [...new Set(this.infos.flatMap((s) => s.members.map((m) => m.login)))]
  }

  roleOf(id: string, login: string): Role | undefined {
    const info = this.info(id)
    if (!info) return undefined
    if (!info.members.length) return 'member'
    return info.members.find((m) => same(m.login, login))?.role
  }

  /** The Binders a person may open, theirs first in the order they were made. Hub admins may open all. */
  forPerson(login: string, hubAdmin = false) {
    return this.infos
      .map((info) => ({ info, role: this.roleOf(info.id, login) ?? (hubAdmin && !info.personal ? ('admin' as const) : undefined) }))
      .filter((s): s is { info: SpaceInfo; role: Role } => !!s.role)
  }

  /** Whether a person may change who's in a Binder: its owners and admins, and the hub's admins. */
  mayManage(id: string, login: string, hubAdmin: boolean) {
    const role = this.roleOf(id, login)
    return hubAdmin || role === 'owner' || role === 'admin'
  }

  /** An address for a new Binder from its name: "Mobile app" is /mobile-app, or /mobile-app-2 when that's taken. */
  freeId(name: string) {
    let base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/, '')
    if (!/^[a-z]/.test(base)) base = `binder${base ? `-${base}` : ''}`.slice(0, 34)
    if (base.length < 3) base = `${base}-binder`
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (spaceIdPattern.test(id) && !reserved.has(id) && !this.info(id)) return id
    }
  }

  /**
   * A new Binder: one notebook with its own board, notes, repo and members, its maker its owner. `home`: the Binder
   * whose GitHub App it reaches GitHub through (the hub's one app), else it has none of its own until one is made.
   */
  async create(fields: { id?: string; name: string; owner: string; home?: string }, by: string) {
    const name = fields.name.trim().slice(0, 60)
    const id = (fields.id?.trim() || this.freeId(name)).toLowerCase()
    const owner = fields.owner.trim().replace(/^@/, '')
    if (!spaceIdPattern.test(id) || reserved.has(id)) throw new Refused('A Binder’s address is 3 to 40 lowercase letters, digits and dashes, starting with a letter, and not one of the hub’s own (api, auth, mcp…).')
    if (this.info(id)) throw new Refused(`There’s a Binder at /${id} already.`)
    if (!name) throw new Refused('Give the Binder a name.')
    if (!loginPattern.test(owner)) throw new Refused('Its owner is a GitHub login.')
    const info: SpaceInfo = { id, name, createdAt: new Date().toISOString(), createdBy: by, members: [{ login: owner, role: 'owner' }], ...(fields.home ? { home: fields.home } : {}) }
    this.running.set(id, await this.make(id, info))
    this.infos.push(info)
    await this.save()
    return info
  }

  /** A person's own Binder, made the first time they're seen: theirs alone, reaching GitHub through `home`'s app. */
  async ensurePersonal(login: string, home: string | undefined) {
    const id = personalId(login)
    const had = this.info(id)
    if (had) return { info: had, made: false }
    if (!loginPattern.test(login)) throw new Refused('A personal Binder is for a GitHub login.')
    const pending = this.making.get(id)
    if (pending) return { info: await pending, made: false }
    const work = (async () => {
      const info: SpaceInfo = { id, name: 'Personal', createdAt: new Date().toISOString(), createdBy: login, members: [{ login, role: 'owner' }], personal: login, ...(home ? { home } : {}) }
      this.running.set(id, await this.make(id, info))
      this.infos.push(info)
      await this.save()
      return info
    })()
    this.making.set(id, work)
    try {
      return { info: await work, made: true }
    } finally {
      this.making.delete(id)
    }
  }

  private making = new Map<string, Promise<SpaceInfo>>()

  async rename(id: string, name: string) {
    const info = this.need(id)
    const clean = name.trim().slice(0, 60)
    if (!clean) throw new Refused('Give the Binder a name.')
    info.name = clean
    await this.save()
    return info
  }

  /** Adds someone or changes their role. Only an owner (or the hub's admin) makes or unmakes owners. */
  async setMember(id: string, login: string, role: Role, byOwner: boolean) {
    const info = this.need(id)
    if (info.personal) throw new Refused('A personal Binder is its person’s alone.')
    const clean = login.trim().replace(/^@/, '')
    if (!loginPattern.test(clean)) throw new Refused('A member is a GitHub login.')
    if (!['owner', 'admin', 'member'].includes(role)) throw new Refused('A member is an owner, an admin or a member.')
    const existing = info.members.find((m) => same(m.login, clean))
    if ((role === 'owner' || existing?.role === 'owner') && !byOwner) throw new Refused('Only an owner makes or unmakes owners.')
    const members = existing ? info.members.map((m) => (m === existing ? { ...m, role } : m)) : [...info.members, { login: clean, role }]
    if (!members.some((m) => m.role === 'owner')) throw new Refused(info.members.length ? 'A Binder keeps at least one owner.' : 'A Binder’s first member is its owner.')
    info.members = members
    await this.save()
    return info
  }

  async removeMember(id: string, login: string, byOwner: boolean) {
    const info = this.need(id)
    if (info.personal) throw new Refused('A personal Binder is its person’s alone.')
    const existing = info.members.find((m) => same(m.login, login))
    if (!existing) throw new Refused('They’re not in this Binder.')
    if (existing.role === 'owner' && !byOwner) throw new Refused('Only an owner removes an owner.')
    const members = info.members.filter((m) => m !== existing)
    if (!members.some((m) => m.role === 'owner')) throw new Refused('A Binder keeps at least one owner.')
    info.members = members
    await this.save()
    return info
  }

  private need(id: string) {
    const info = this.info(id)
    if (!info) throw new Refused('No such Binder.')
    return info
  }

  async stop() {
    for (const space of this.running.values()) await space.stop?.()
  }
}
