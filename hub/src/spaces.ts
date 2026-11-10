import type { SpaceBrain } from './brain/brain.ts'
import type { CopyKeeper } from './copies.ts'
import type { Actions } from './actions.ts'
import type { GitHubConnection } from './githubConnection.ts'
import type { JiraConnection } from './jira.ts'
import { Refused, type Hub } from './hub.ts'
import type { KV } from './kv.ts'
import type { GitHubPoller } from './poller.ts'
import type { GitNotesSaver } from './savers/gitNotes.ts'
import type { IssuesSaver } from './savers/issues.ts'
import type { JiraSaver } from './savers/jira.ts'
import type { Teller } from './tell.ts'
import type { Webhooks } from './webhooks.ts'
import type { Inbox } from './listen/inbox.ts'
import type { FeedReader } from './listen/reader.ts'

// One hub, several Binders: each its own team, with its own change log, projects, notes, cards and agents, and its own
// members, and its own GitHub: its app, installations and webhook, and each member's sign-in to it. In the code a
// Binder is a space (its log's name in Redis, hub:<space>:…), since "binder" already names a project inside one, as the
// log and the apps have always called it. Sessions, people's and agents' tokens and the hub's options are the hub's
// own, shared by all its Binders.

// A reader sees everything in a Binder and can ask its brain about it, and changes nothing in it.
export type Role = 'owner' | 'admin' | 'member' | 'reader'

/** What a reader is told wherever they try to change a Binder: its owners are the ones who can let them. */
export const readerWords = 'You can read this binder, and can’t change it. One of its owners can let you.'

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
  /**
   * For a personal Binder: whether it has work that goes on without its person (an agent, a schedule, a run under way, a
   * repo it follows, its own Jira, a summary waiting), so it starts with the hub. One that has none starts when it's first needed.
   * Not said yet, for one from before this was kept: it starts with the hub, and says.
   */
  wakes?: boolean
  /**
   * When it was taken off the hub, and by whom. It stays in the list so its address stays taken, but it isn't listed,
   * opened or started; its files and its GitHub repo are left as they were.
   */
  removedAt?: string
  removedBy?: string
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
  /** The channel it tells when something starts waiting. */
  tell?: Teller
  /** Where pictures put in its notes are kept. */
  filesDir?: string
  /** Its daily copies on the hub's disk, and in its repo when it says so. */
  copies?: CopyKeeper
  /** Its brain: the index of its notes and cards, what's captured put in as notes, questions answered. */
  brain?: SpaceBrain
  /** What its listeners hear, and what becomes of it; and the feeds it reads to hear without being reached. */
  inbox?: Inbox
  feeds?: FeedReader
  stop?: () => Promise<void>
}

/**
 * Whether a Binder has work that goes on without its person: an agent that may be listening, a schedule, a run under
 * way, a repo whose pull requests it follows, a Jira project that tells it what happened there, a capture waiting for
 * a summary. A personal Binder with none of these needn't run until its person next comes.
 */
export function worksAlone(space: Pick<Space, 'hub' | 'brain' | 'jira'>) {
  const { state } = space.hub
  return state.agents.some((agent) => !agent.revoked) || (state.schedules?.length ?? 0) > 0 || state.cards.some((card) => card.stage === 'working') ||
    state.binders.some((binder) => !!binder.repo) || !!space.jira?.settings.baseUrl || (space.brain?.summariesWaiting ?? 0) > 0 ||
    // A feed is read on the hub's timer, which only a running Binder has. What's posted to it starts it when it arrives.
    (state.listeners ?? []).some((listener) => listener.kind === 'feed' && listener.mode !== 'off')
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
  return (infos.find((i) => i.createdBy === 'hub' && !i.removedAt) ?? infos.find((i) => !i.personal && !i.removedAt))?.id
}

export class Spaces {
  private kv: KV
  private make: (id: string, info: SpaceInfo) => Promise<Space>
  /** Every Binder the hub has made, those taken off it too: their addresses stay taken. */
  private infos: SpaceInfo[] = []
  // What's asked on every request, kept to hand rather than found in `infos` each time, which a hub with thousands of
  // Binders would walk several times over. Each is changed where `infos` is: see `add`, `index` and `unindex`.
  private byId = new Map<string, SpaceInfo>()
  /** Where each was made in the list, so a person's Binders come out in that order. */
  private madeAt = new Map<string, number>()
  /** By login, in lower case: the Binders that name them as a member. Where to look; a Binder's own members say what they are. */
  private memberOf = new Map<string, Set<string>>()
  /** The live Binders with no members: anyone the hub lets in may open them. */
  private open = new Set<string>()
  /** The live team Binders with no owner (those with no members too): the hub's admins look after them until they have one. */
  private ownerless = new Set<string>()
  /** Who runs the hub, set once by the server: nobody until then. */
  hubAdmin: (login: string) => boolean = () => false
  /** The folder a new Binder keeps its state and documents in, where a Binder started from a copy is put before it starts. None: this hub can't. */
  dirOf?: (id: string) => string
  /** `list()`, until a Binder is made, taken off the hub or loaded. */
  private live?: readonly SpaceInfo[]
  /** Set once every Binder has started: until then the hub answers only that it's starting. */
  private started = false
  private running = new Map<string, Space>()
  /** The Binder the hub started with: kept for good, as its files are the hub's own folders. */
  private firstId?: string

  /** `make` starts a Binder's parts; the first Binder is the one this hub had before it held several. */
  constructor(kv: KV, make: (id: string, info: SpaceInfo) => Promise<Space>) {
    this.kv = kv
    this.make = make
  }

  /** Reads which Binders there are and starts each. A hub with none gets `first`, with `members`. */
  async load(first: { id: string; name: string; members: Member[] }) {
    const raw = await this.kv.get(listKey)
    this.setInfos(raw ? (JSON.parse(raw) as SpaceInfo[]) : [])
    this.firstId = first.id
    if (!this.infos.length) {
      this.setInfos([{ id: first.id, name: first.name, createdAt: new Date().toISOString(), createdBy: 'hub', members: first.members }])
      await this.save()
    }
    // Team Binders first: a personal one reaches GitHub through one of them. Then the personal ones with work that goes
    // on without their person. The rest start when they're first needed (`start`), so a hub with thousands of people
    // starts the Binders in use and not one for everybody.
    const live = this.list()
    for (const info of [...live.filter((i) => !i.personal), ...live.filter((i) => i.personal && i.wakes !== false)]) this.running.set(info.id, await this.make(info.id, info))
    this.started = true
    return this
  }

  /** Binders being started because someone needs them: one start each, whoever else asks meanwhile. */
  private waking = new Map<string, Promise<Space>>()

  /**
   * A Binder's running parts, started now if they aren't yet: a personal Binder with nothing going on in it isn't
   * started with the hub, and starts here the first time it's needed. Undefined for one that isn't on the hub, or
   * while the hub is still starting the Binders it starts with.
   */
  async start(id: string): Promise<Space | undefined> {
    const running = this.running.get(id)
    if (running) return running
    const info = this.info(id)
    if (!info || !this.started) return undefined
    let waking = this.waking.get(id)
    if (!waking) {
      waking = this.make(id, info).then((space) => {
        // Taken off the hub while it was starting: it isn't kept.
        if (this.info(id)) this.running.set(id, space)
        else void space.stop?.().catch(() => undefined)
        return space
      }).finally(() => this.waking.delete(id))
      this.waking.set(id, waking)
    }
    return waking
  }

  /** How many Binders on the hub haven't started: those nobody has needed since the hub did. */
  get asleep() {
    return this.list().length - this.running.size
  }

  /**
   * Says whether a personal Binder has work that goes on without its person, for the next time the hub starts. Kept
   * only when it changes.
   */
  async setWakes(id: string, wakes: boolean) {
    const info = this.info(id)
    if (!info?.personal || info.wakes === wakes) return
    info.wakes = wakes
    await this.save()
  }

  /** For tests and hubs started by hand: Binders already running, kept in memory. */
  static of(kv: KV, spaces: { info: Omit<SpaceInfo, 'createdAt' | 'createdBy'>; space: Space }[]) {
    const made = new Spaces(kv, async () => { throw new Refused('This hub can’t make Binders.') })
    made.firstId = spaces[0]?.info.id
    for (const { info, space } of spaces) {
      made.add({ ...info, createdAt: new Date().toISOString(), createdBy: 'hub' })
      made.running.set(info.id, space)
    }
    made.started = true
    return made
  }

  /** Whether every Binder has started. */
  get ready() {
    return this.started
  }

  private setInfos(infos: SpaceInfo[]) {
    this.infos = []
    this.byId.clear()
    this.madeAt.clear()
    this.memberOf.clear()
    this.open.clear()
    this.ownerless.clear()
    this.live = undefined
    for (const info of infos) this.add(info)
  }

  /** A Binder made or loaded: at the end of the list, and in what finds it. */
  private add(info: SpaceInfo) {
    this.madeAt.set(info.id, this.infos.length)
    this.infos.push(info)
    this.byId.set(info.id, info)
    this.index(info)
    this.live = undefined
  }

  private index(info: SpaceInfo) {
    if (info.removedAt) return
    if (!info.members.length) this.open.add(info.id)
    if (!info.personal && !info.members.some((m) => m.role === 'owner')) this.ownerless.add(info.id)
    for (const member of info.members) {
      const login = member.login.toLowerCase()
      const ids = this.memberOf.get(login) ?? new Set<string>()
      ids.add(info.id)
      this.memberOf.set(login, ids)
    }
  }

  /** Call before its members change or it's taken off the hub, with the members it has now. */
  private unindex(info: SpaceInfo) {
    this.open.delete(info.id)
    this.ownerless.delete(info.id)
    for (const member of info.members) {
      const login = member.login.toLowerCase()
      const ids = this.memberOf.get(login)
      ids?.delete(info.id)
      if (ids && !ids.size) this.memberOf.delete(login)
    }
  }

  private async save() {
    await this.kv.set(listKey, JSON.stringify(this.infos))
  }

  /** The Binders on the hub: not those taken off it. */
  list(): readonly SpaceInfo[] {
    return (this.live ??= this.infos.filter((s) => !s.removedAt))
  }

  info(id: string) {
    const info = this.byId.get(id)
    return info && !info.removedAt ? info : undefined
  }

  /** Addresses of Binders being made right now: taken, though they aren't in the list yet. */
  private starting = new Set<string>()

  /** Whether an address is used, by a Binder or by one that was taken off the hub: nothing new is made over it. */
  private taken(id: string) {
    return this.byId.has(id) || this.starting.has(id)
  }

  get(id: string) {
    return this.running.get(id)
  }

  all() {
    return [...this.running.values()]
  }

  /** Everyone who's a member of a Binder: let in to sign in, like the hub's allowed people. */
  people() {
    return [...new Set(this.list().flatMap((s) => s.members.map((m) => m.login)))]
  }

  /** A person's own place in a Binder, with no hub admin in it: for what is about them, not about running the Binder. */
  roleOf(id: string, login: string): Role | undefined {
    const info = this.info(id)
    return info && this.roleIn(info, login)
  }

  private roleIn(info: SpaceInfo, login: string): Role | undefined {
    if (!info.members.length) return 'member'
    return info.members.find((m) => same(m.login, login))?.role
  }

  /** Whether a Binder has an owner: one that has none is looked after by the hub's admins until it has. */
  hasOwner(id: string) {
    return !!this.info(id)?.members.some((m) => m.role === 'owner')
  }

  /**
   * What a person is in a Binder: their own place, or a member's for anyone in one with no members. A hub admin is
   * an admin of a team Binder that has no owner, whatever lower place they have there, and of none that has one.
   */
  roleFor(id: string, login: string, hubAdmin: boolean): Role | undefined {
    const info = this.info(id)
    return info && this.roleWith(info, login, hubAdmin)
  }

  private roleWith(info: SpaceInfo, login: string, hubAdmin: boolean): Role | undefined {
    if (hubAdmin && this.ownerless.has(info.id)) return 'admin'
    return this.roleIn(info, login)
  }

  /** The Binders a person may open, theirs first in the order they were made. A hub admin's include those with no owner. */
  forPerson(login: string, hubAdmin = false) {
    // Where to look: their own Binders, the open ones and, for a hub admin, those with no owner. Each says what they are.
    const ids = new Set([...(this.memberOf.get(login.toLowerCase()) ?? []), ...this.open, ...(hubAdmin ? this.ownerless : [])])
    return [...ids]
      .sort((a, b) => this.madeAt.get(a)! - this.madeAt.get(b)!)
      .map((id) => this.info(id)!)
      .map((info) => ({ info, role: this.roleWith(info, login, hubAdmin) }))
      .filter((s): s is { info: SpaceInfo; role: Role } => !!s.role)
  }

  /** Whether a person may change a Binder (who's in it, its settings): its owners and admins, and the hub's admins while it has no owner. */
  mayManage(id: string, login: string, hubAdmin: boolean) {
    const role = this.roleFor(id, login, hubAdmin)
    return role === 'owner' || role === 'admin'
  }

  /** An address for a new Binder from its name: "Mobile app" is /mobile-app, or /mobile-app-2 when that's taken. */
  freeId(name: string) {
    let base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/, '')
    if (!/^[a-z]/.test(base)) base = `binder${base ? `-${base}` : ''}`.slice(0, 34)
    if (base.length < 3) base = `${base}-binder`
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (spaceIdPattern.test(id) && !reserved.has(id) && !this.taken(id)) return id
    }
  }

  /**
   * A new Binder: one notebook with its own board, notes, repo and members, its maker its owner. `home`: the Binder
   * whose GitHub App it reaches GitHub through (the hub's one app), else it has none of its own until one is made.
   * `before` is run with its address once that's settled and before it starts: a Binder made from a copy has its saved
   * state put in its folder there. If it, or the start, fails, nothing is left of the Binder in the list.
   */
  async create(fields: { id?: string; name: string; owner: string; home?: string }, by: string, before?: (id: string) => Promise<void>) {
    const name = fields.name.trim().slice(0, 60)
    const id = (fields.id?.trim() || this.freeId(name)).toLowerCase()
    const owner = fields.owner.trim().replace(/^@/, '')
    if (!spaceIdPattern.test(id) || reserved.has(id)) throw new Refused('A Binder’s address is 3 to 40 lowercase letters, digits and dashes, starting with a letter, and not one of the hub’s own (api, auth, mcp…).')
    if (this.taken(id)) throw new Refused(`There’s a Binder at /${id} already.`)
    if (!name) throw new Refused('Give the Binder a name.')
    if (!loginPattern.test(owner)) throw new Refused('Its owner is a GitHub login.')
    const info: SpaceInfo = { id, name, createdAt: new Date().toISOString(), createdBy: by, members: [{ login: owner, role: 'owner' }], ...(fields.home ? { home: fields.home } : {}) }
    this.starting.add(id)
    try {
      await before?.(id)
      this.running.set(id, await this.make(id, info))
    } finally {
      this.starting.delete(id)
    }
    this.add(info)
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
      this.add(info)
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

  /** Adds someone or changes their role. Only an owner (or the hub's admin, while it has none) makes or unmakes owners. */
  async setMember(id: string, login: string, role: Role, byOwner: boolean) {
    const info = this.need(id)
    if (info.personal) throw new Refused('A personal Binder is its person’s alone.')
    const clean = login.trim().replace(/^@/, '')
    if (!loginPattern.test(clean)) throw new Refused('A member is a GitHub login.')
    if (!['owner', 'admin', 'member', 'reader'].includes(role)) throw new Refused('A member is an owner, an admin, a member or a reader.')
    const existing = info.members.find((m) => same(m.login, clean))
    if ((role === 'owner' || existing?.role === 'owner') && !byOwner) throw new Refused('Only an owner makes or unmakes owners.')
    const members = existing ? info.members.map((m) => (m === existing ? { ...m, role } : m)) : [...info.members, { login: clean, role }]
    if (!members.some((m) => m.role === 'owner')) throw new Refused(info.members.length ? 'A Binder keeps at least one owner.' : 'A Binder’s first member is its owner.')
    this.unindex(info)
    info.members = members
    this.index(info)
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
    this.unindex(info)
    info.members = members
    this.index(info)
    await this.save()
    return info
  }

  /** Whether this is the Binder the hub started with. */
  isFirst(id: string) {
    return id === this.firstId
  }

  /**
   * Takes a Binder off the hub: its running parts stop, and it's marked removed in the list, so it isn't listed, opened
   * or started again. Nothing of it is destroyed (its files and its GitHub repo stay as they are), and its address stays
   * taken.
   */
  async remove(id: string, by: string) {
    const info = this.need(id)
    if (this.isFirst(id)) throw new Refused('The hub’s first Binder can’t be removed: its files are the hub’s own.')
    if (info.personal) throw new Refused('A personal Binder can’t be removed.')
    this.unindex(info)
    info.removedAt = new Date().toISOString()
    info.removedBy = by
    this.live = undefined
    await this.save()
    const space = this.running.get(id)
    this.running.delete(id)
    // Already out of reach; a part that won't stop is left to end with the hub.
    await space?.stop?.().catch(() => undefined)
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
