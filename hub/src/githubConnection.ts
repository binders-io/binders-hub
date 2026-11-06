import { createSign, randomBytes } from 'node:crypto'
import { GitHub, GitHubError } from './github.ts'
import type { KV } from './kv.ts'
import type { Sealer } from './secrets.ts'
import { Refusal } from './auth.ts'
import { log } from './logger.ts'
import { RepoIndex, type IndexedRepo } from './repoIndex.ts'

export type Access = 'push' | 'read' | 'none'

// How a Binder reaches GitHub. Either a GitHub App made from its Settings with GitHub's manifest flow (the hub keeps its
// keys, sealed, in the Binder's own keys, and mints a short-lived token for each repo it's installed on), or, set by hand
// in the environment for the hub's first Binder, an OAuth app for signing in and a token for everything else. The
// environment wins where both are set. Each Binder has its own: forgetting one's app leaves the others' alone.
//
// Where an app is installed scopes who may use it, whichever account made it. Its installation on an organization may be
// shared: another Binder working in that organization uses it rather than making one more app, by reference
// (`borrowed`), so the app's keys, installations and webhook stay in one place, the Binder that made it. An installation
// on a person's own account is shared only by that person. Whoever borrows proves, with their own GitHub, that they can
// reach the installation (it's one GitHub lists for them, or they're a member of its organization); the lending Binder
// keeps the loan (`loans`): who it's lent to, which app, which installations, and who asked. Each use checks it again:
// the same app still, still installed there, still lent. Its owners see each loan in its Settings and can end it;
// forgetting or remaking its app ends them all. A borrower reaches only the installations it was lent, and through them
// only the repos it has linked (its projects' and its agents'), never the rest of the organization's.

export interface AppSettings {
  appId: number
  slug: string
  name: string
  owner: { login: string; type: 'User' | 'Organization' }
  clientId: string
  clientSecret: string
  webhookSecret: string
  privateKey: string
  htmlUrl: string
  /** Where its webhook points, once the hub has told GitHub. */
  hookUrl?: string
  /** Made on this machine, without webhook events: they're ticked on GitHub once it has a webhook. */
  madeLocally?: boolean
  createdBy: string
  createdAt: string
  installations: { id: number; account: string; type?: 'User' | 'Organization' }[]
}

export interface ManualSettings {
  clientId?: string
  clientSecret?: string
  token?: string
  webhookSecret?: string
}

export interface Endpoints {
  webUrl: string
  apiUrl: string
}

/** How a Binder finds the others, for sharing an organization's app between them. */
export interface Sharing {
  /** This Binder's id, as the others know it. */
  id: string
  /** Another Binder's connection. */
  binder: (id: string) => GitHubConnection | undefined
  /** Whether a repo is one this Binder linked (a project's, or an agent's): the only ones a borrowed app reaches. */
  linked?: (repo: string) => boolean
}

/** Another Binder's app, used here: which Binder, and which app it had when it was lent. */
export interface Borrowed {
  from: string
  appId: number
  /** The installations it was lent, by account. None, from before installations were lent: the app's own organization. */
  accounts?: string[]
}

/** A loan of this Binder's app to another, kept by the Binder that lends it. */
export interface Loan {
  to: string
  appId: number
  /** Who asked for it, having shown GitHub lets them reach those installations. */
  by: string
  at: string
  /** The installations lent, by account. None, from before installations were lent: the app's own organization. */
  accounts?: string[]
}

const appKey = 'github-app'
/** Which Binder's app this one uses, when it uses another's. */
const borrowedKey = 'github-app-borrowed'
/** Which Binders use this one's app. */
const loansKey = 'github-app-loans'
/** Names once each, whatever their case, and none blank. */
const unique = (names: string[]) => names.filter((name, i) => name && names.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i)
/** The events Binders listens for. */
export const webhookEvents = ['issues', 'pull_request', 'check_run', 'workflow_run', 'deployment_status']
/** JSON kept in the KV, when it's there and the shape `ok` expects. */
const parse = <T>(raw: string | undefined | null, ok: (value: any) => boolean): T | undefined => {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    return ok(value) ? (value as T) : undefined
  } catch {
    return undefined
  }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** The accounts a loan or a borrowing covers: those named, or (from before installations were lent) the app's own. */
const lentAccounts = (app: AppSettings, accounts?: string[]) => accounts?.length ? accounts : app.owner.type === 'Organization' ? [app.owner.login] : []
const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?(\/|$)/.test(url)

export class GitHubConnection {
  private kv: KV
  private sealer: Sealer
  private manual: ManualSettings
  readonly endpoints: Endpoints
  /** The app this Binder made, if it made one. */
  private own?: AppSettings
  /** The Binder whose app this one uses instead, and which app, when it does. */
  private borrowed?: Borrowed
  /** The Binders this one lends its app to. */
  private loans: Loan[] = []
  /** How it finds the other Binders, to borrow or lend an organization's app. */
  private sharing?: Sharing
  private repoInstallations = new Map<string, number>()
  private publicUrlAtCreation = ''
  private tokens = new Map<number, { token: string; until: number }>()
  /** The repos its own app's installations reach, read in the background and kept (repoIndex.ts). */
  readonly ownIndex: RepoIndex
  /** What searching GitHub found lately, by what was typed; and when GitHub last said to slow down. */
  private searched = new Map<string, { at: number; repos: IndexedRepo[] }>()
  private searchHeldUntil = 0
  /** Its Binder's address, for the paths GitHub comes back to; none for the hub's first, which keeps the plain ones. */
  readonly space?: string

  constructor(kv: KV, sealer: Sealer, endpoints: Endpoints, manual: ManualSettings = {}, space?: string, sharing?: Sharing, indexOptions?: ConstructorParameters<typeof RepoIndex>[2]) {
    this.ownIndex = new RepoIndex(kv, async (installation, page) => {
      const client = new GitHub(await this.installationToken(installation), this.endpoints.apiUrl)
      const answer = await client.get<{ total_count?: number; repositories: { full_name: string; private: boolean }[] }>(`/installation/repositories?per_page=100&page=${page}`)
      return { total: answer.total_count, repos: answer.repositories.map((r) => ({ fullName: r.full_name, private: r.private })) }
    }, indexOptions)
    this.kv = kv
    this.sealer = sealer
    this.endpoints = endpoints
    this.manual = manual
    this.space = space
    this.sharing = sharing
  }

  /** The app it works through: its own, or the one it borrows (that Binder's own: borrowing goes one step, never on). */
  private get app(): AppSettings | undefined {
    return this.own ?? this.lending()?.own
  }

  /** The app's installations this Binder may use: all of its own app's; of a borrowed one, those it was lent. */
  private get installations(): AppSettings['installations'] {
    if (this.own) return this.own.installations
    const app = this.lending()?.own
    if (!app) return []
    const accounts = lentAccounts(app, this.borrowed?.accounts)
    return app.installations.filter((i) => accounts.some((a) => same(a, i.account)))
  }

  /** The connection whose app this one borrows, while the loan holds. */
  private lending(): GitHubConnection | undefined {
    if (this.own || !this.borrowed || !this.sharing) return undefined
    const lender = this.sharing.binder(this.borrowed.from)
    if (!lender || lender === this) return undefined
    return lender.loanTo(this.sharing.id, this.borrowed.appId) ? undefined : lender
  }

  /**
   * Why a loan of this Binder's app to `to` doesn't hold, or undefined when it does: the same app it lent, still lent,
   * and still installed on at least one of the accounts it was lent for.
   */
  private loanTo(to: string, appId: number): string | undefined {
    const app = this.own
    if (!app || app.appId !== appId) return 'its app is gone: forgotten or made again there'
    if (this.manual.clientId || this.manual.token) return 'its GitHub is set up by hand on the hub now'
    const loan = this.loans.find((l) => l.to === to && l.appId === appId)
    if (!loan) return 'its owners stopped lending it'
    const accounts = lentAccounts(app, loan.accounts)
    if (!app.installations.some((i) => accounts.some((a) => same(a, i.account)))) return `its app isn’t installed on ${accounts.map((a) => `@${a}`).join(', ') || 'that account'} any more`
    return undefined
  }

  /** The Binder whose app this one uses, while it does. */
  get borrowedFrom(): string | undefined {
    return this.lending() ? this.borrowed?.from : undefined
  }

  /** A borrowed app this Binder can't use any more, and why: what Settings says in its place. */
  lost(): { from: string; why: string } | undefined {
    if (this.own || !this.borrowed || this.lending()) return undefined
    const lender = this.sharing?.binder(this.borrowed.from)
    const why = !lender || lender === this ? 'that binder is gone' : lender.loanTo(this.sharing!.id, this.borrowed.appId) ?? 'it can’t be reached'
    return { from: this.borrowed.from, why }
  }

  /** The Binders this one's app is lent to, while each loan holds. */
  lentTo(): Loan[] {
    return this.loans.filter((l) => !this.loanTo(l.to, l.appId))
  }

  /** Ends a loan of this Binder's app: that Binder stops reaching GitHub through it at once. */
  async endLoan(to: string) {
    const before = this.loans.length
    this.loans = this.loans.filter((l) => l.to !== to)
    if (this.loans.length !== before) await this.saveLoans()
  }

  /** Lends installations of this Binder's app to another, asked for by someone GitHub lets reach them. */
  private async lend(to: string, by: string, accounts: string[]) {
    const app = this.own
    if (!app) throw new Refusal('That binder has no GitHub App of its own to share.')
    this.loans = [...this.loans.filter((l) => l.to !== to), { to, appId: app.appId, by, at: new Date().toISOString(), accounts }]
    await this.saveLoans()
  }

  /** Where GitHub sends this Binder's webhooks, and comes back to after making and installing its app. */
  path(kind: 'hook' | 'created' | 'installed'): string {
    // A borrowed app's webhook points at the Binder that made it, which hands each delivery on.
    const lender = kind === 'hook' ? this.lending() : undefined
    if (lender) return lender.path('hook')
    const base = kind === 'hook' ? '/webhooks/github' : `/setup/github/${kind}`
    return this.space ? `${base}/${this.space}` : base
  }

  async load() {
    this.borrowed = parse<Borrowed>(await this.kv.get(borrowedKey), (b) => typeof b?.from === 'string' && typeof b?.appId === 'number')
    this.loans = parse<Loan[]>(await this.kv.get(loansKey), Array.isArray) ?? []
    const sealed = await this.kv.get(appKey)
    if (!sealed) return
    try {
      this.own = JSON.parse(this.sealer.open(sealed)) as AppSettings
    } catch {
      log.warn('The GitHub App’s settings were sealed with another secret, so they can’t be read: set it up again from Settings.')
    }
  }

  private async save() {
    if (this.own) await this.kv.set(appKey, this.sealer.seal(JSON.stringify(this.own)))
    else await this.kv.del(appKey)
    if (this.borrowed && !this.own) await this.kv.set(borrowedKey, JSON.stringify(this.borrowed))
    else await this.kv.del(borrowedKey)
  }

  private async saveLoans() {
    if (this.loans.length) await this.kv.set(loansKey, JSON.stringify(this.loans))
    else await this.kv.del(loansKey)
  }

  // What the rest of the hub asks -----------------------------------------------------------------------------------

  /** The OAuth client people sign in with, if there is one. */
  signIn() {
    if (this.manual.clientId && this.manual.clientSecret) return { clientId: this.manual.clientId, clientSecret: this.manual.clientSecret, ...this.endpoints }
    if (this.app) return { clientId: this.app.clientId, clientSecret: this.app.clientSecret, ...this.endpoints }
    return undefined
  }

  webhookSecret() {
    return this.manual.webhookSecret ?? (this.app?.webhookSecret || undefined)
  }

  /** Who's let in because of the app: whoever made it, its owner if that's a person, its organization's members if not. */
  allowed() {
    if (!this.app) return { users: [] as string[], orgs: [] as string[] }
    return {
      users: unique([this.app.createdBy, ...(this.app.owner.type === 'User' ? [this.app.owner.login] : [])]),
      orgs: this.app.owner.type === 'Organization' ? [this.app.owner.login] : [],
    }
  }

  /** People who may change how the hub reaches GitHub. */
  admins() {
    return this.app ? unique([this.app.createdBy, ...(this.app.owner.type === 'User' ? [this.app.owner.login] : [])]) : []
  }

  /**
   * Made by someone signed in by name, the app doesn't know its maker's GitHub login: the first person to sign in with
   * GitHub after (and so let in, as its owner or in its organization) becomes it.
   */
  async claimMaker(login: string) {
    if (!this.own || this.own.createdBy) return
    this.own = { ...this.own, createdBy: login }
    await this.save()
  }

  // Sharing an organization's app between Binders ----------------------------------------------------------------------

  /**
   * What another Binder may be offered of this one's app: one this Binder made itself, with its installations and the
   * kind of account each is on. Who may use which is for whoever asks to show (`mayReach`). Nothing while GitHub is set
   * up by hand here.
   */
  shareable() {
    const app = this.own
    if (!app || this.manual.clientId || this.manual.token) return undefined
    return { name: app.name, slug: app.slug, owner: app.owner.login, htmlUrl: app.htmlUrl, installations: app.installations.map((i) => ({ account: i.account, type: this.kindOf(i) })) }
  }

  /** The kind of account an installation is on, as kept, or known from the app's owner when it's on that account. */
  private kindOf(installation: AppSettings['installations'][number]): 'User' | 'Organization' | undefined {
    if (installation.type) return installation.type
    return this.own && same(installation.account, this.own.owner.login) ? this.own.owner.type : undefined
  }

  /** Fills in, from GitHub, the kind of account each installation is on, for those kept before it was asked. */
  async knowInstallations() {
    const app = this.own
    if (!app || app.installations.every((i) => this.kindOf(i))) return
    const known = await Promise.all(app.installations.map(async (i) => {
      if (this.kindOf(i)) return i
      const found = await this.asApp<{ account: { login: string; type: 'User' | 'Organization' } }>('GET', `/app/installations/${i.id}`).catch(() => undefined)
      return found ? { ...i, type: found.account.type } : i
    }))
    this.own = { ...app, installations: known }
    await this.save()
  }

  /**
   * Whether a person can reach this app's installation on `account`, as GitHub says with their own token: on a person's
   * own account, only that person; on an organization, it's one GitHub lists for them, or they're an active member.
   */
  async mayReach(token: string | undefined, login: string, account: string) {
    const installation = this.own?.installations.find((i) => same(i.account, account))
    if (!installation) return false
    const kind = this.kindOf(installation)
    if (kind === 'User') return same(account, login)
    if (!token || !kind) return false
    const me = this.asUser(token)
    // A sign-in through this app lists the installations its person can reach; one through another app can't ask.
    for (let n = 1; n <= 10; n++) {
      const page = await me.get<{ installations: { id: number }[] }>(`/user/installations?per_page=100&page=${n}`).catch(() => undefined)
      if (!page?.installations) break
      if (page.installations.some((i) => i.id === installation.id)) return true
      if (page.installations.length < 100) break
    }
    const membership = await me.get<{ state?: string }>(`/user/memberships/orgs/${encodeURIComponent(account)}`).catch(() => undefined)
    return membership?.state === 'active'
  }

  /**
   * Uses installations of another Binder's app rather than making one more app. Refused while this Binder has an app of
   * its own or GitHub set by hand, for an app that Binder borrows itself, and for an account the app isn't installed on.
   * Whoever asks must have shown GitHub lets them reach each installation (`mayReach`, which the caller checks). Asked
   * again of the same Binder's app, the accounts are added to those it uses.
   */
  async reuse(from: string, by: string, accounts: string[]) {
    if (this.manual.clientId || this.manual.token) throw new Refusal('This binder’s GitHub is set up by hand on the hub, through its GITHUB_* settings.')
    if (this.own) throw new Refusal('This binder has a GitHub App of its own: forget it first to use another binder’s.')
    if (!this.sharing) throw new Refusal('This binder can’t use another binder’s app.')
    if (from === this.sharing.id) throw new Refusal('That’s this binder.')
    const lender = this.sharing.binder(from)
    const app = lender && lender !== this ? lender.own : undefined
    if (!lender || !app) throw new Refusal('That binder has no GitHub App of its own to share.')
    if (!lender.shareable()) throw new Refusal('That binder’s GitHub is set up by hand on the hub, so it can’t be shared.')
    if (!accounts.length) throw new Refusal('Pick an account the app is installed on.')
    const missing = accounts.find((a) => !app.installations.some((i) => same(i.account, a)))
    if (missing) throw new Refusal(`${app.name} isn’t installed on @${missing}.`)
    const kept = this.borrowed?.from === from && this.borrowed.appId === app.appId ? lentAccounts(app, this.borrowed.accounts) : []
    const all = unique([...kept, ...accounts])
    await lender.lend(this.sharing.id, by, all)
    // One loan at a time: whichever it had before is handed back.
    await this.endBorrowing(from)
    this.borrowed = { from, appId: app.appId, accounts: all }
    this.repoInstallations.clear()
    this.tokens.clear()
    await this.save()
    return app
  }

  /** The accounts of a borrowed app this Binder uses, while it does. */
  get borrowedAccounts(): string[] {
    const app = this.lending()?.own
    return app ? lentAccounts(app, this.borrowed?.accounts) : []
  }

  /** Hands back the loan this Binder had, unless it's from `keep`. */
  private async endBorrowing(keep?: string) {
    if (!this.borrowed || !this.sharing || this.borrowed.from === keep) return
    const lender = this.sharing.binder(this.borrowed.from)
    if (lender && lender !== this) await lender.endLoan(this.sharing.id)
  }

  /** GitHub as the hub, for one repo: the manual token, or the app's installation on that repo. */
  async forRepo(repo: string): Promise<GitHub | undefined> {
    if (this.manual.token) return new GitHub(this.manual.token, this.endpoints.apiUrl)
    if (!this.app) return undefined
    const installation = await this.installationFor(repo)
    if (!installation) return undefined
    return new GitHub(await this.installationToken(installation), this.endpoints.apiUrl)
  }

  /** Pushing over git to a repo the app reaches: its address and a token that can write to it. */
  async gitAccess(repo: string): Promise<{ url: string; token: string } | undefined> {
    const token = this.manual.token ?? (this.app ? await this.installationFor(repo).then((id) => (id ? this.installationToken(id) : undefined)) : undefined)
    return token ? { url: `${this.endpoints.webUrl}/${repo}.git`, token } : undefined
  }

  /** GitHub as the hub for an organization or account the app is installed on, for reading its members. */
  async forAccount(account: string): Promise<GitHub | undefined> {
    if (this.manual.token) return new GitHub(this.manual.token, this.endpoints.apiUrl)
    const installation = this.installations.find((i) => i.account.toLowerCase() === account.toLowerCase())
    if (!installation) return undefined
    return new GitHub(await this.installationToken(installation.id), this.endpoints.apiUrl)
  }

  /** The list of repos it searches: its own app's, or the one of the Binder whose app it borrows. */
  private get repoIndex() {
    return this.lending()?.ownIndex ?? this.ownIndex
  }

  /**
   * The repos the app reaches that match what's typed, for a picker: from the list kept of each installation's repos,
   * which starts being read the first time it's asked for. A name it doesn't have yet (still being read, or made since)
   * is asked of GitHub's search, and kept when found.
   */
  async findRepos(typed: string, limit = 50, keep?: (fullName: string) => boolean): Promise<{ repos: IndexedRepo[]; more: number; reading?: { indexed: number; total?: number } }> {
    const ids = this.installations.map((i) => i.id)
    if (!ids.length) return { repos: [], more: 0 }
    const index = this.repoIndex
    await index.ensure(ids)
    let found = await index.search(ids, typed, limit, keep)
    // A first read of a small installation is done in a moment: wait for it rather than show a list half read.
    if (!found.complete && found.indexed < 100) {
      await Promise.race([index.settled(ids), new Promise((done) => setTimeout(done, 3000))])
      found = await index.search(ids, typed, limit, keep)
    }
    const words = typed.trim()
    if (words.length >= 2 && (!found.complete || !found.repos.length)) {
      const more = (await this.searchGitHub(words).catch(() => [])).filter((r) => (!keep || keep(r.fullName)) && !found.repos.some((f) => f.fullName.toLowerCase() === r.fullName.toLowerCase()))
      if (more.length) found = { ...found, repos: [...found.repos, ...more].slice(0, limit) }
    }
    return { repos: found.repos, more: found.more, ...(found.complete ? {} : { reading: { indexed: found.indexed, total: found.total } }) }
  }

  /**
   * Asks GitHub for repos by name, in each installation's account: "owner/name" exactly, else its search. Only an
   * installation on all of its account's repos is asked: what it finds there, the app reaches. (One on chosen repos has
   * a short list, read through quickly and kept up to date by GitHub's word of each change.) Search allows few calls a
   * minute, so answers are kept for a few minutes, and a refusal holds it back for one; an answer cut short isn't kept.
   */
  private async searchGitHub(typed: string): Promise<IndexedRepo[]> {
    // Words of a name, not GitHub's search qualifiers ("org:other" would reach past the app's own accounts).
    const words = typed.replace(/\S*:\S*/g, ' ').replace(/[^\w./ -]/g, ' ').replace(/\s+/g, ' ').trim()
    if (words.length < 2) return []
    const key = words.toLowerCase()
    const kept = this.searched.get(key)
    if (kept && Date.now() - kept.at < 5 * 60_000) return kept.repos
    const out: IndexedRepo[] = []
    let whole = true
    const exact = /^([\w.-]+)\/([\w.-]+)$/.exec(words)
    for (const installation of this.installations.slice(0, 5)) {
      if (exact && !same(exact[1], installation.account)) continue
      if (!exact && Date.now() < this.searchHeldUntil) { whole = false; break }
      const selection = await this.selectionOf(installation.id)
      if (!selection) whole = false
      if (selection !== 'all') continue
      const client = new GitHub(await this.installationToken(installation.id), this.endpoints.apiUrl)
      try {
        let repos: IndexedRepo[]
        if (exact) {
          const repo = await client.get<{ full_name: string; private: boolean }>(`/repos/${exact[1]}/${exact[2]}`)
          repos = [{ fullName: repo.full_name, private: repo.private }]
        } else {
          const scope = `${installation.type === 'User' ? 'user' : 'org'}:${installation.account}`
          const answer = await client.get<{ items: { full_name: string; private: boolean }[] }>(`/search/repositories?q=${encodeURIComponent(`${words} in:name ${scope}`)}&per_page=20`)
          repos = answer.items.map((r) => ({ fullName: r.full_name, private: r.private }))
        }
        // In the installation's own account alone.
        repos = repos.filter((r) => same(r.fullName.split('/')[0], installation.account))
        out.push(...repos)
        await this.repoIndex.add(installation.id, repos)
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 403 || error.status === 429)) this.searchHeldUntil = Date.now() + 60_000
        if (!(error instanceof GitHubError && error.status === 404)) whole = false
      }
    }
    if (!whole) return out
    if (this.searched.size > 500) this.searched.clear()
    this.searched.set(key, { at: Date.now(), repos: out })
    return out
  }

  /** Whether an installation is on all its account's repos or chosen ones, as GitHub says; asked once. */
  private selections = new Map<number, string>()
  private async selectionOf(installation: number) {
    const known = this.selections.get(installation)
    if (known) return known
    const found = await this.asApp<{ repository_selection?: string }>('GET', `/app/installations/${installation}`).then((i) => i.repository_selection ?? 'selected', () => undefined)
    if (found) this.selections.set(installation, found)
    return found
  }

  /** What GitHub says of its installations' repos (added, removed, uninstalled), kept in the list it searches. */
  async heardInstallation(event: string, payload: { action?: string; installation?: { id?: number }; repositories_added?: { full_name: string; private: boolean }[]; repositories_removed?: { full_name: string }[] }) {
    const id = payload.installation?.id
    if (typeof id !== 'number') return
    if (event === 'installation' && payload.action === 'deleted') return this.ownIndex.forget(id)
    if (event !== 'installation_repositories') return
    // Changed between all repos and chosen ones, perhaps: asked again when next needed.
    this.selections.delete(id)
    await this.ownIndex.add(id, (payload.repositories_added ?? []).map((r) => ({ fullName: r.full_name, private: r.private })))
    await this.ownIndex.remove(id, (payload.repositories_removed ?? []).map((r) => r.full_name))
  }

  /**
   * Makes a repo as the person (in their account, or an organization they belong to), then makes sure the app reaches
   * it: an installation on chosen repos only gets it added.
   */
  /**
   * Makes a repo as the person (their account's, or an organization's). When GitHub won't let their account make one
   * in an organization the app is installed on, and `asApp` (they manage this binder's GitHub), the app makes it
   * itself, with the Administration permission that organization gave it: an organization of Enterprise Managed Users
   * lets no outside account make repos, though its owner installed the app to.
   */
  async createRepo(userToken: string | undefined, login: string, fields: { owner: string; name: string; private: boolean; description?: string }, asApp = false) {
    const body = { name: fields.name, private: fields.private, description: fields.description, auto_init: true }
    const mine = fields.owner.toLowerCase() === login.toLowerCase()
    const installation = this.installations.find((i) => i.account.toLowerCase() === fields.owner.toLowerCase())
    const refused = (error: unknown) => error instanceof GitHubError && (error.status === 403 || error.status === 404)
    const taken = (error: unknown) => error instanceof GitHubError && error.status === 422 && /already exists|name already/i.test(error.message)
    let repo: { id: number; full_name: string; html_url: string }
    try {
      // Without their own GitHub here, straight to the app.
      if (!userToken) throw new GitHubError(403, 'Not connected')
      const me = this.asUser(userToken)
      repo = mine ? await me.send('POST', '/user/repos', body) : await me.send('POST', `/orgs/${fields.owner}/repos`, body)
    } catch (error) {
      if (taken(error)) throw new Error(`${fields.owner}/${fields.name} already exists.`)
      if (!refused(error) || mine || !installation || !asApp) throw error
      try {
        const app = new GitHub(await this.installationToken(installation.id), this.endpoints.apiUrl)
        repo = await app.send('POST', `/orgs/${fields.owner}/repos`, body)
        // Made by the app, so it reaches it already.
        return { fullName: repo.full_name, url: repo.html_url, byApp: true }
      } catch (second) {
        if (taken(second)) throw new Error(`${fields.owner}/${fields.name} already exists.`)
        if (refused(second)) throw new Error(`Administration: neither @${login} nor this binder’s GitHub App may make repos in ${fields.owner}.`)
        throw second
      }
    }
    if (installation) await this.asUser(userToken!).send('PUT', `/user/installations/${installation.id}/repositories/${repo.id}`).catch(() => {})
    return { fullName: repo.full_name, url: repo.html_url }
  }

  /** What the hub needs of its GitHub App, permission by permission, and what for, in words. */
  static readonly needs: Record<string, { level: 'read' | 'write'; for: string }> = {
    issues: { level: 'write', for: 'keeping cards as issues' },
    pull_requests: { level: 'write', for: 'reading, approving and merging pull requests' },
    contents: { level: 'write', for: 'pushing notes, and agents’ code' },
    administration: { level: 'write', for: 'making a repo from the hub' },
    checks: { level: 'read', for: 'showing a pull request’s checks' },
    actions: { level: 'write', for: 'running and showing workflows' },
    metadata: { level: 'read', for: 'reading repos at all' },
    members: { level: 'read', for: 'suggesting the organization’s people' },
  }

  /**
   * How the app stands, as GitHub says now: what it asks for against what the hub needs, and for each installation the
   * repos it reaches and the permissions its account hasn't accepted yet (asked for since it was installed), each with
   * where on GitHub to put it right.
   */
  async health() {
    if (!this.app) return undefined
    const web = this.endpoints.webUrl.replace(/\/$/, '')
    const app = await this.asApp<{ slug: string; name: string; html_url: string; owner: { login: string; type: string }; permissions: Record<string, string> }>('GET', '/app')
    const enough = (have: string | undefined, need: 'read' | 'write') => have === 'write' || have === 'admin' || (need === 'read' && have === 'read')
    const settingsUrl = app.owner.type === 'Organization' ? `${web}/organizations/${app.owner.login}/settings/apps/${app.slug}/permissions` : `${web}/settings/apps/${app.slug}/permissions`
    const lacking = (have: Record<string, string>) => Object.entries(GitHubConnection.needs).filter(([key, need]) => !enough(have[key], need.level)).map(([key, need]) => ({ permission: key, level: need.level, for: need.for }))
    const asked = lacking(app.permissions)
    const installations = []
    for (const installation of this.installations) {
      const found = await this.asApp<{ account: { login: string }; permissions: Record<string, string>; repository_selection: 'all' | 'selected'; html_url: string; suspended_at?: string | null }>('GET', `/app/installations/${installation.id}`).catch(() => undefined)
      if (!found) {
        installations.push({ account: installation.account, gone: true })
        continue
      }
      const client = new GitHub(await this.installationToken(installation.id), this.endpoints.apiUrl)
      const repos = await client.get<{ total_count: number }>('/installation/repositories?per_page=1').then((r) => r.total_count, () => undefined)
      // Asked for by the app but not accepted here: the account's owners accept it on the installation's page.
      const pending = lacking(found.permissions).filter((p) => !asked.some((a) => a.permission === p.permission))
      installations.push({ account: found.account.login, selection: found.repository_selection, repos, url: found.html_url, suspended: !!found.suspended_at, pending })
    }
    return { app: { name: app.name, slug: app.slug, owner: app.owner.login, ownerType: app.owner.type, url: app.html_url, settingsUrl }, missing: asked, installations }
  }

  /** The accounts the app is installed on. */
  installedAccounts() {
    return this.installations.map((i) => i.account)
  }

  /** GitHub as a person, with the token from their sign-in. */
  asUser(token: string) {
    return new GitHub(token, this.endpoints.apiUrl)
  }

  /**
   * A token of the app's for one repo, for an agent's run: that repo only, its code and pull requests, for an hour.
   * Undefined without an app (a token set by hand can't be narrowed) or when the app isn't installed there.
   */
  async runToken(repo: string): Promise<{ token: string; expiresAt: string } | undefined> {
    if (!this.app) return undefined
    const installation = await this.installationFor(repo)
    if (!installation) return undefined
    const { token, expires_at } = await this.asApp<{ token: string; expires_at: string }>('POST', `/app/installations/${installation}/access_tokens`, {
      repositories: [repo.split('/')[1]],
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' },
    })
    return { token, expiresAt: expires_at }
  }

  /** What GitHub said each person may do in each repo, kept a couple of minutes. */
  private reach = new Map<string, { at: number; access: Access }>()

  /**
   * What a person may do in a repo, as GitHub says with their token: push (write, maintain or admin), read, or nothing
   * (GitHub answers as if it weren't there). A token GitHub turns down throws its GitHubError (401).
   */
  async access(token: string, repo: string): Promise<Access> {
    const key = `${token.slice(-12)}:${repo.toLowerCase()}`
    const known = this.reach.get(key)
    if (known && Date.now() - known.at < 2 * 60_000) return known.access
    let access: Access
    try {
      const found = await this.asUser(token).get<{ permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } }>(`/repos/${repo}`)
      access = found.permissions?.push || found.permissions?.maintain || found.permissions?.admin ? 'push' : 'read'
    } catch (error) {
      if (!(error instanceof GitHubError) || (error.status !== 404 && error.status !== 403)) throw error
      access = 'none'
    }
    this.reach.set(key, { at: Date.now(), access })
    if (this.reach.size > 2000) this.reach.delete(this.reach.keys().next().value!)
    return access
  }

  get connected() {
    return !!this.manual.token || !!this.installations.length
  }

  status() {
    return {
      mode: this.manual.clientId || this.manual.token ? ('manual' as const) : this.app ? ('app' as const) : ('none' as const),
      app: this.app ? {
        name: this.app.name, slug: this.app.slug, owner: this.app.owner.login, ownerType: this.app.owner.type, htmlUrl: this.app.htmlUrl,
        installations: this.installations.map((i) => i.account), installUrl: `${this.app.htmlUrl}/installations/new`, hookUrl: this.app.hookUrl,
        madeLocally: !!this.app.madeLocally,
        // Another Binder's, used here: changed there. Or this Binder's own, which others in its organization may use.
        borrowedFrom: this.borrowedFrom,
        borrowedAccounts: this.borrowedAccounts,
        shareable: !!this.own && !!this.shareable()?.installations.length,
        // The Binders this one's app is lent to, which its owners may end.
        lentTo: this.own ? this.lentTo().map((l) => ({ binder: l.to, by: l.by, at: l.at, accounts: lentAccounts(this.own!, l.accounts) })) : [],
        settingsUrl: new URL(this.app.owner.type === 'Organization' ? `/organizations/${this.app.owner.login}/settings/apps/${this.app.slug}` : `/settings/apps/${this.app.slug}`, this.endpoints.webUrl).toString(),
      } : undefined,
      signIn: !!this.signIn(),
      server: this.connected,
      webhooks: !!this.manual.webhookSecret || !!this.app?.hookUrl,
      // Another Binder's app this one used, which it can't any more: the loan ended, or the app changed there.
      lost: this.lost(),
    }
  }

  // Making the app ----------------------------------------------------------------------------------------------------

  /** What GitHub needs to make the app: everything Binders uses, pointing back at this hub. */
  manifest(publicUrl: string, name: string) {
    const local = isLocal(publicUrl)
    return {
      name,
      url: publicUrl,
      description: 'Binders: notes become work, agents do it, and GitHub keeps it.',
      // GitHub refuses a webhook it can't reach, and events without a webhook, so a hub on this machine makes the app with
      // neither; pointWebhook gives it the address later, and the events are ticked on GitHub.
      ...(local ? {} : { hook_attributes: { url: `${publicUrl}${this.path('hook')}`, active: true } }),
      redirect_url: `${publicUrl}${this.path('created')}`,
      callback_urls: [`${publicUrl}/auth/github/callback`],
      setup_url: `${publicUrl}${this.path('installed')}`,
      setup_on_update: true,
      public: false,
      request_oauth_on_install: false,
      default_permissions: {
        issues: 'write',
        pull_requests: 'write',
        contents: 'write',
        administration: 'write',
        checks: 'read',
        actions: 'write',
        deployments: 'read',
        metadata: 'read',
        members: 'read',
      },
      ...(local ? {} : { default_events: webhookEvents }),
    }
  }

  /** The first step: where the browser posts the manifest, and the state to check when GitHub sends it back. */
  async startCreating(login: string, viaGitHub: boolean, publicUrl: string, options: { org?: string; name?: string }) {
    const org = options.org?.trim()
    if (org && !/^[A-Za-z0-9-]+$/.test(org)) throw new Refusal('An organization’s name is letters, digits and dashes.')
    // App names are unique across GitHub, so the default carries who it's for.
    const name = (options.name?.trim() || `Binders for ${login || 'this hub'}`).slice(0, 34)
    const state = randomBytes(18).toString('base64url')
    await this.kv.set(`github-app-state:${state}`, JSON.stringify({ login: viaGitHub ? login : '', org, publicUrl }), 900)
    const path = org ? `/organizations/${org}/settings/apps/new` : '/settings/apps/new'
    const action = new URL(path, this.endpoints.webUrl)
    action.searchParams.set('state', state)
    return { action: action.toString(), manifest: JSON.stringify(this.manifest(publicUrl, name)), local: isLocal(publicUrl) }
  }

  /** Back from GitHub with the made app's code: its keys for the hub to keep. */
  async finishCreating(code: string, state: string) {
    const started = await this.kv.get(`github-app-state:${state}`)
    if (!started) throw new Refusal('That setup didn’t start here, or took longer than 15 minutes. Start it again from Settings.')
    await this.kv.del(`github-app-state:${state}`)
    const { login } = JSON.parse(started) as { login: string }
    this.publicUrlAtCreation = (JSON.parse(started) as { publicUrl?: string }).publicUrl ?? ''
    const response = await fetch(`${this.endpoints.apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'binders-hub' },
    })
    const app = (await response.json()) as { id: number; slug: string; name: string; owner: { login: string; type: 'User' | 'Organization' }; client_id: string; client_secret: string; webhook_secret: string; pem: string; html_url: string; message?: string }
    if (!response.ok) throw new Refusal(`GitHub didn’t hand over the app: ${app.message ?? response.status}.`)
    this.own = {
      appId: app.id, slug: app.slug, name: app.name, owner: app.owner, clientId: app.client_id, clientSecret: app.client_secret,
      webhookSecret: app.webhook_secret ?? '', privateKey: app.pem, htmlUrl: app.html_url, createdBy: login, createdAt: new Date().toISOString(), installations: [],
      hookUrl: app.webhook_secret && !isLocal(this.publicUrlAtCreation) ? `${this.publicUrlAtCreation}${this.path('hook')}` : undefined,
      madeLocally: isLocal(this.publicUrlAtCreation),
    }
    // Its own now: whatever it borrowed before is handed back, and a new app is lent to nobody yet.
    await this.endBorrowing()
    this.borrowed = undefined
    this.loans = []
    await this.saveLoans()
    this.repoInstallations.clear()
    this.tokens.clear()
    await this.save()
    return this.own
  }

  /** Back from installing the app on an account's repos. */
  async installed(installationId: number): Promise<string> {
    // A borrowed app's installations are kept where it was made.
    const lender = this.lending()
    if (lender) {
      this.repoInstallations.clear()
      return lender.installed(installationId)
    }
    if (!this.own) throw new Refusal('Make the GitHub App first.')
    const installation = await this.asApp<{ id: number; account: { login: string; type?: 'User' | 'Organization' } }>('GET', `/app/installations/${installationId}`)
    const rest = this.own.installations.filter((i) => i.id !== installation.id)
    this.own = { ...this.own, installations: [...rest, { id: installation.id, account: installation.account.login, ...(installation.account.type ? { type: installation.account.type } : {}) }] }
    this.repoInstallations.clear()
    await this.save()
    return installation.account.login
  }

  /**
   * Points the app's webhook at this hub, with a secret of the hub's, when the hub has a public address and the webhook
   * points elsewhere or nowhere: an app made on this machine, or a tunnel whose address changed. Says what it did.
   */
  async pointWebhook(publicUrl: string): Promise<'pointed' | 'already' | 'local' | 'no app' | 'borrowed'> {
    // A borrowed app's webhook is its maker's to point: pointing it here would take it from that Binder.
    if (!this.own && this.borrowed && !this.manual.webhookSecret) return 'borrowed'
    if (!this.own || this.manual.webhookSecret) return 'no app'
    if (isLocal(publicUrl)) return 'local'
    const url = `${publicUrl}${this.path('hook')}`
    if (this.own.hookUrl === url && this.own.webhookSecret) return 'already'
    const secret = this.own.webhookSecret || randomBytes(24).toString('hex')
    await this.asApp('PATCH', '/app/hook/config', { url, content_type: 'json', secret, insecure_ssl: '0' })
    this.own = { ...this.own, hookUrl: url, webhookSecret: secret }
    await this.save()
    return 'pointed'
  }

  /**
   * Forgets the app here, or stops borrowing another Binder's. It stays on GitHub until it's deleted there. Forgotten,
   * its loans end: the Binders that used it lose it too, and say so.
   */
  async disconnect() {
    await this.endBorrowing()
    this.own = undefined
    this.borrowed = undefined
    this.loans = []
    await this.saveLoans()
    this.repoInstallations.clear()
    this.tokens.clear()
    await this.save()
  }

  // Tokens ------------------------------------------------------------------------------------------------------------

  /** The app's own short-lived JSON Web Token, signed with its key. */
  private jwt() {
    const app = this.app!
    const now = Math.floor(Date.now() / 1000)
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(app.appId) })}`
    return `${body}.${createSign('RSA-SHA256').update(body).sign(app.privateKey).toString('base64url')}`
  }

  private async asApp<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.endpoints.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.jwt()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'binders-hub', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = (await response.json().catch(() => ({}))) as T & { message?: string }
    if (!response.ok) throw new GitHubError(response.status, json.message ?? `GitHub answered ${response.status}`)
    return json
  }

  private async installationFor(repo: string) {
    const known = this.repoInstallations.get(repo)
    if (known) return known
    try {
      const { id } = await this.asApp<{ id: number }>('GET', `/repos/${repo}/installation`)
      // A borrowed app reaches only the organization it was lent for, not every account it's installed on.
      if (!this.own && !this.installations.some((i) => i.id === id)) return undefined
      // And only the repos this Binder linked: the lending Binder's other repos there stay its own.
      if (!this.own && this.sharing?.linked && !this.sharing.linked(repo)) return undefined
      this.repoInstallations.set(repo, id)
      return id
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined
      throw error
    }
  }

  private async installationToken(installation: number) {
    const cached = this.tokens.get(installation)
    if (cached && cached.until > Date.now() + 5 * 60_000) return cached.token
    const { token, expires_at } = await this.asApp<{ token: string; expires_at: string }>('POST', `/app/installations/${installation}/access_tokens`)
    this.tokens.set(installation, { token, until: Date.parse(expires_at) })
    return token
  }
}
