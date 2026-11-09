import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { KV } from './kv.ts'
import type { Sealer } from './secrets.ts'
import { log } from './logger.ts'

// Who's asking. People sign in with GitHub (or, on a hub run on this machine with no GitHub app set up, with a name
// alone); the hub keeps their GitHub token, encrypted, for what they do on GitHub through it: one per person, shared by
// their sessions and apps, and renewed before it runs out (a GitHub App's sign-in lasts eight hours, its renewal six
// months). Agents use a token the
// hub gave when they were set up; only its hash is kept. Apps a person signs in to (the Mac) get a person token the
// same way, and use it in place of the session cookie.

export interface User {
  login: string
  name: string
  avatar?: string
}

interface StoredSession {
  user: User
  /** The Binder whose GitHub App they signed in through, which their token is for. */
  space?: string
  /** The GitHub token, encrypted with the hub's secret. */
  token?: string
  /** Signed in through the OAuth App: its token, encrypted, for looking people up on GitHub only, never for repos. */
  identity?: string
  at: string
}

export interface GitHubLogin {
  clientId: string
  clientSecret: string
  /** github.com, or a GitHub Enterprise server. */
  webUrl: string
  apiUrl: string
}

export interface AuthOptions {
  /**
   * The GitHub OAuth client to sign in with for a Binder (its GitHub App's), as it is now: setup in Settings can make
   * one while the hub runs. No Binder named: the one people sign in to the hub through.
   */
  github: (space?: string) => GitHubLogin | undefined
  /**
   * The hub's GitHub OAuth App, when one is set up: people sign in through it (anyone on GitHub, as the GitHub App may
   * be private, which only its own organization's members can sign in through), and connect their GitHub to the
   * GitHub App separately, for what's done as them on repos.
   */
  oauth?: () => GitHubLogin | undefined
  /** The GitHub an OAuth App set in Settings is on (github.com unless an Enterprise server). */
  endpoints?: { webUrl: string; apiUrl: string }
  /** GitHub logins let in, and organizations whose members are. Both empty: anyone who signs in. */
  allowed: () => { users: string[]; orgs: string[] }
  devLogin: () => boolean
}

/** A person's GitHub sign-in as the hub keeps it. */
interface GitHubGrant {
  token: string
  expiresAt?: string
  refresh?: string
  refreshExpiresAt?: string
  /** The GitHub account it acts as, when that isn't their own sign-in's (an Enterprise Managed User's, say). */
  as?: string
}

/** A person's GitHub sign-in, without the token: for Settings. */
export interface GitHubLink {
  connected: boolean
  /** When the token in hand runs out; the hub renews it before then. None: it doesn't. */
  expiresAt?: string
  /** Until when it can be renewed without signing in again. */
  renewsUntil?: string
  /** The GitHub account it acts as, when it isn't their sign-in's own. */
  as?: string
}

/** GitHub's answer when a code or a renewal becomes a token. */
interface TokenAnswer {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

const grantOf = (answer: TokenAnswer, now = Date.now()): GitHubGrant => ({
  token: answer.access_token!,
  expiresAt: answer.expires_in ? new Date(now + answer.expires_in * 1000).toISOString() : undefined,
  refresh: answer.refresh_token,
  refreshExpiresAt: answer.refresh_token_expires_in ? new Date(now + answer.refresh_token_expires_in * 1000).toISOString() : undefined,
})

export const sessionCookie = 'binders_session'
/** People's GitHub profiles, by login, and the enterprise shortcodes of managed accounts connected here. */
const peopleKey = 'people'
const shortcodesKey = 'emu-shortcodes'
const sessionDays = 30
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export class Refusal extends Error {}

export class Auth {
  private kv: KV
  private sealer: Sealer
  readonly options: AuthOptions
  /** Renewals under way, by login: two requests at once share one, as GitHub takes each refresh token once. */
  private renewing = new Map<string, Promise<string | undefined>>()
  /** When a renewal that failed may be tried again, by login: GitHub being slow or down isn't asked again at every request. */
  private renewRetryAt = new Map<string, number>()

  constructor(kv: KV, sealer: Sealer, options: AuthOptions) {
    this.kv = kv
    this.sealer = sealer
    this.options = options
  }

  // OAuth Apps. A person's own, for their personal binder's notes repo in their own GitHub account: set by them in
  // their personal binder, kept sealed for them alone, and seen by no binder or person else. And, set by hand on the
  // hub only (GITHUB_OAUTH_*), one to sign people in through, for a hub whose GitHub Apps can't (private ones, for
  // people outside their organization); without it, people sign in through a binder's GitHub App.

  private personalApps = new Map<string, { clientId: string; clientSecret: string }>()
  /** One set before each person had their own (in a hub admin's personal binder): theirs, until they set their own. */
  private legacyApp?: { clientId: string; clientSecret: string }
  private appKey = (login: string) => `github-oauth-app:${login.toLowerCase()}`

  async loadOAuthApp() {
    const raw = await this.kv.get('github-oauth-app')
    if (!raw) return
    try {
      const kept = JSON.parse(raw) as { clientId: string; secret: string }
      this.legacyApp = { clientId: kept.clientId, clientSecret: this.open(kept.secret) }
    } catch {
      // Sealed with another secret: as if none were set.
    }
  }

  private async ownApp(login: string) {
    const known = this.personalApps.get(login.toLowerCase())
    if (known) return known
    const raw = await this.kv.get(this.appKey(login))
    if (!raw) return undefined
    try {
      const kept = JSON.parse(raw) as { clientId: string; secret: string }
      const app = { clientId: kept.clientId, clientSecret: this.open(kept.secret) }
      this.personalApps.set(login.toLowerCase(), app)
      return app
    } catch {
      return undefined
    }
  }

  /** A person's own OAuth App, for their personal binder; a hub admin may have the one set before people had their own. */
  async personalOAuth(login: string, hubAdmin = false): Promise<GitHubLogin | undefined> {
    const app = (await this.ownApp(login)) ?? (hubAdmin ? this.legacyApp : undefined)
    return app ? { ...app, ...(this.options.endpoints ?? { webUrl: 'https://github.com', apiUrl: 'https://api.github.com' }) } : undefined
  }

  async setPersonalOAuth(login: string, clientId: string, clientSecret: string) {
    const id = clientId.trim()
    const secret = clientSecret.trim()
    if (!/^[\w.-]{8,64}$/.test(id)) throw new Refusal('That isn’t an OAuth App’s Client ID.')
    if (!/^[\w-]{20,128}$/.test(secret)) throw new Refusal('That isn’t an OAuth App’s client secret.')
    await this.kv.set(this.appKey(login), JSON.stringify({ clientId: id, secret: this.seal(secret) }))
    this.personalApps.set(login.toLowerCase(), { clientId: id, clientSecret: secret })
  }

  /** Takes their OAuth App away, and the connection made through it. */
  async clearPersonalOAuth(login: string, hubAdmin = false) {
    await this.kv.del(this.appKey(login))
    this.personalApps.delete(login.toLowerCase())
    if (hubAdmin && this.legacyApp) {
      await this.kv.del('github-oauth-app')
      this.legacyApp = undefined
    }
    await this.forgetPersonal(login)
  }

  /** Their own OAuth App, as Settings shows it: never its secret. */
  async personalOAuthStatus(login: string, hubAdmin = false) {
    const app = (await this.ownApp(login)) ?? (hubAdmin ? this.legacyApp : undefined)
    return app ? { set: true, clientId: app.clientId } : { set: false }
  }

  /** The OAuth App people sign in through: set by hand on the hub only. */
  oauthLogin(): GitHubLogin | undefined {
    return this.options.oauth?.()
  }

  private seal(text: string) {
    return this.sealer.seal(text)
  }

  private open(sealed: string) {
    return this.sealer.open(sealed)
  }

  async startSession(user: User, token?: string, space?: string, identity?: string) {
    const id = randomBytes(32).toString('base64url')
    const stored: StoredSession = { user, space, token: token ? this.seal(token) : undefined, ...(identity ? { identity: this.seal(identity) } : {}), at: new Date().toISOString() }
    await this.kv.set(`session:${sha(id)}`, JSON.stringify(stored), sessionDays * 86400)
    return { id, maxAge: sessionDays * 86400 }
  }

  async session(id: string | undefined): Promise<{ user: User; token?: string; space?: string; identity?: string } | undefined> {
    if (!id) return undefined
    const raw = await this.kv.get(`session:${sha(id)}`)
    if (!raw) return undefined
    const stored = JSON.parse(raw) as StoredSession
    let token: string | undefined
    let identity: string | undefined
    try {
      token = stored.token ? this.open(stored.token) : undefined
      identity = stored.identity ? this.open(stored.identity) : undefined
    } catch {
      // Sealed with another secret: the session stands, its GitHub token doesn't.
    }
    return { user: stored.user, token, space: stored.space, identity }
  }

  async endSession(id: string | undefined) {
    if (id) await this.kv.del(`session:${sha(id)}`)
  }

  // GitHub sign-in --------------------------------------------------------------------------------------------------

  /** How someone signs in now: through the hub's OAuth App when it has one, else a Binder's GitHub App. */
  signInVia(): 'oauth' | 'app' {
    return this.oauthLogin() ? 'oauth' : 'app'
  }

  private client(via: 'oauth' | 'app' | 'personal' | 'connect', space?: string, own?: GitHubLogin) {
    const github = via === 'app' || via === 'connect' ? this.options.github(space) : via === 'personal' ? own : this.oauthLogin()
    if (!github) throw new Refusal(via === 'app' || via === 'connect' ? 'Connecting GitHub isn’t set up for this binder: its GitHub App comes first.' : 'Signing in with GitHub isn’t set up on this hub: its OAuth App comes first (Settings → GitHub).')
    return github
  }

  // A person's own GitHub, for their personal binder: through the hub's OAuth App, with access to their repos, so the
  // hub can make their notes repo in their account and push to it. Theirs alone, kept sealed; never used for any other
  // binder, which reaches GitHub through its GitHub App.

  private personalKey = (login: string) => `github-personal:${login.toLowerCase()}`

  async personalToken(login: string): Promise<string | undefined> {
    const raw = await this.kv.get(this.personalKey(login))
    if (!raw) return undefined
    try {
      return this.open(raw)
    } catch {
      return undefined
    }
  }

  async forgetPersonal(login: string) {
    await this.kv.del(this.personalKey(login))
  }

  /**
   * Where to send someone to sign in (`oauth`: who they are, through the hub's OAuth App) or to connect their GitHub to
   * a Binder's GitHub App (`app`, also signing them in when the hub has no OAuth App), and the state to check after.
   */
  githubStart(callback: string, space?: string, via: 'oauth' | 'app' | 'personal' | 'connect' = 'app', own?: GitHubLogin) {
    const github = this.client(via, space, own)
    const state = randomBytes(18).toString('base64url')
    const url = new URL('/login/oauth/authorize', github.webUrl)
    url.searchParams.set('client_id', github.clientId)
    url.searchParams.set('redirect_uri', callback)
    // The OAuth App asks only who they are (and their organizations, for who's let in). The GitHub App's scopes are its
    // permissions; repo and read:org matter only to a hub on a token set by hand.
    // For a personal binder's repo: repo, to make it in their account and push to it.
    url.searchParams.set('scope', via === 'oauth' ? 'read:user user:email read:org' : via === 'personal' ? 'repo read:user user:email read:org' : 'repo read:org')
    url.searchParams.set('state', state)
    return { url: url.toString(), state }
  }

  /** Back from GitHub: the code for a token, the token for who they are, and whether they're let in. */
  /**
   * Back from GitHub. `connect`: someone signed in to the hub connecting a GitHub account to a binder's app, kept for
   * them (`as`, their hub login) whichever account it is, an Enterprise Managed User's included, and not signing them in
   * as it.
   */
  async githubFinish(code: string, callback: string, space: string, via: 'oauth' | 'app' | 'personal' | 'connect' = 'app', as?: string, own?: GitHubLogin): Promise<{ user: User; token?: string; identity?: string }> {
    const github = this.client(via, space, own)
    const response = await fetch(new URL('/login/oauth/access_token', github.webUrl), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: callback }),
    })
    const body = (await response.json()) as TokenAnswer
    if (!body.access_token) throw new Refusal(body.error_description ?? 'GitHub didn’t sign you in.')
    const token = body.access_token
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'binders-hub' }
    const me = (await (await fetch(new URL('/user', github.apiUrl), { headers })).json()) as { login: string; name?: string; avatar_url?: string }
    if (!me.login) throw new Refusal('GitHub didn’t say who you are.')
    const user = { login: me.login, name: me.name || me.login, avatar: me.avatar_url }
    // How they're shown: the name on their GitHub profile, when it has one.
    await this.rememberPerson({ login: me.login, name: me.name || undefined, avatar: me.avatar_url })
    // Their own GitHub, through their own OAuth App, for their personal binder: kept for them (`as`) alone.
    if (via === 'personal') {
      if (!as) throw new Refusal('Sign in to the hub first, then connect your GitHub.')
      await this.kv.set(this.personalKey(as), this.seal(token))
      return { user }
    }
    if (via === 'connect') {
      if (!as) throw new Refusal('Sign in to the hub first, then connect your GitHub.')
      await this.keepGitHub(as, space, { ...grantOf(body), ...(me.login.toLowerCase() !== as.toLowerCase() ? { as: me.login } : {}) })
      // Another account of theirs, connected for an organization their own can't reach: an Enterprise Managed User's,
      // whose login ends in its enterprise's shortcode. Logins ending in it are shown without it.
      const shortcode = /_([A-Za-z0-9]{1,20})$/.exec(me.login)?.[1]
      if (shortcode && me.login.toLowerCase() !== as.toLowerCase()) await this.rememberShortcode(shortcode)
      return { user }
    }
    await this.letIn(me.login, async () => {
      const orgs = (await (await fetch(new URL('/user/orgs', github.apiUrl), { headers })).json()) as { login: string }[]
      return Array.isArray(orgs) ? orgs.map((o) => o.login.toLowerCase()) : []
    })
    // Signed in through the OAuth App: who they are, nothing more. Its token reaches no repo of the GitHub App's, so it
    // isn't kept as their GitHub for any Binder.
    if (via === 'oauth') return { user, identity: token }
    await this.keepGitHub(me.login, space, grantOf(body))
    return { user, token }
  }

  // How people are shown -------------------------------------------------------------------------------------------

  /** People's GitHub profiles as last seen at sign-in, by login: the name and picture to show for them. */
  async people(): Promise<Record<string, { name?: string; avatar?: string }>> {
    const raw = await this.kv.get(peopleKey)
    try {
      return raw ? (JSON.parse(raw) as Record<string, { name?: string; avatar?: string }>) : {}
    } catch {
      return {}
    }
  }

  async rememberPerson(person: { login: string; name?: string; avatar?: string }) {
    const all = await this.people()
    const key = person.login.toLowerCase()
    const was = all[key]
    if (was && was.name === person.name && was.avatar === person.avatar) return
    delete all[key]
    all[key] = { ...(person.name ? { name: person.name.slice(0, 100) } : {}), ...(person.avatar ? { avatar: person.avatar.slice(0, 300) } : {}) }
    // The most recent few thousand: the oldest go first.
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - 3000))) delete all[old]
    await this.kv.set(peopleKey, JSON.stringify(all))
  }

  /** The enterprise shortcodes of managed accounts connected here, in lower case. */
  async shortcodes(): Promise<string[]> {
    const raw = await this.kv.get(shortcodesKey)
    try {
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  }

  private async rememberShortcode(code: string) {
    const all = await this.shortcodes()
    if (all.includes(code.toLowerCase())) return
    await this.kv.set(shortcodesKey, JSON.stringify([...all, code.toLowerCase()].slice(-50)))
  }

  // People's GitHub sign-ins ---------------------------------------------------------------------------------------

  // Each Binder's GitHub App gives its own sign-in: a GitHub App's token reaches only where that app is installed.
  private githubKey = (login: string, space: string) => `github-person:${space}:${login.toLowerCase()}`

  private async keepGitHub(login: string, space: string, grant: GitHubGrant) {
    await this.kv.set(this.githubKey(login, space), this.seal(JSON.stringify(grant)))
  }

  private async grant(login: string, space: string): Promise<GitHubGrant | undefined> {
    const sealed = await this.kv.get(this.githubKey(login, space))
    if (!sealed) return undefined
    try {
      return JSON.parse(this.open(sealed)) as GitHubGrant
    } catch {
      // Sealed with another secret: as good as none.
      return undefined
    }
  }

  /**
   * A person's GitHub token for a Binder, renewed when it's about to run out. `fromSession` is the one their session or
   * app token was given at sign-in through that Binder, taken as theirs when the hub keeps none yet (signed in before it
   * kept one per person).
   */
  async githubFor(login: string, space: string, fromSession?: string): Promise<string | undefined> {
    const grant = await this.grant(login, space)
    if (!grant) {
      if (fromSession) await this.keepGitHub(login, space, { token: fromSession })
      return fromSession
    }
    if (!grant.expiresAt || Date.parse(grant.expiresAt) - Date.now() > 5 * 60_000) return grant.token
    // Still good for a few minutes: it's used as it is, and a renewal happens beside the request. Only once it has run
    // out is a request held up for the renewal, as it has nothing else to go on.
    const expired = Date.parse(grant.expiresAt) <= Date.now()
    if (!grant.refresh || (grant.refreshExpiresAt && Date.parse(grant.refreshExpiresAt) <= Date.now())) return expired ? undefined : grant.token
    const key = `${space}:${login.toLowerCase()}`
    let renewal = this.renewing.get(key)
    if (!renewal) {
      if ((this.renewRetryAt.get(key) ?? 0) > Date.now()) return expired ? undefined : grant.token
      renewal = this.renew(login, space, grant.refresh)
        .then((token) => {
          if (token) this.renewRetryAt.delete(key)
          else this.renewRetryAt.set(key, Date.now() + 60_000)
          return token
        })
        .finally(() => this.renewing.delete(key))
      this.renewing.set(key, renewal)
    }
    if (!expired) return grant.token
    return renewal
  }

  private async renew(login: string, space: string, refresh: string) {
    const github = this.options.github(space)
    if (!github) return undefined
    try {
      const response = await fetch(new URL('/login/oauth/access_token', github.webUrl), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, grant_type: 'refresh_token', refresh_token: refresh }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await response.json()) as TokenAnswer
      if (!body.access_token) {
        log.warn({ login, space, why: body.error_description ?? body.error ?? 'no token' }, 'Renewing someone’s GitHub failed: they connect again')
        return undefined
      }
      // Still the account it acted as (an Enterprise Managed User's, say).
      const before = await this.grant(login, space)
      await this.keepGitHub(login, space, { ...grantOf(body), ...(before?.as ? { as: before.as } : {}) })
      return body.access_token
    } catch {
      return undefined
    }
  }

  /** GitHub turned the token down: forgotten, so the person is asked to sign in again. */
  async forgetGitHub(login: string, space: string) {
    await this.kv.del(this.githubKey(login, space))
  }

  /** Where a person's GitHub sign-in stands, for Settings. */
  async githubLink(login: string, space: string): Promise<GitHubLink> {
    const grant = await this.grant(login, space)
    const now = Date.now()
    const live = !!grant && (!grant.expiresAt || Date.parse(grant.expiresAt) > now || (!!grant.refresh && (!grant.refreshExpiresAt || Date.parse(grant.refreshExpiresAt) > now)))
    return { connected: live, expiresAt: grant?.expiresAt, renewsUntil: grant?.refreshExpiresAt, as: grant?.as }
  }

  private async letIn(login: string, orgs: () => Promise<string[]>) {
    const { users: allowedUsers, orgs: allowedOrgs } = this.options.allowed()
    if (!allowedUsers.length && !allowedOrgs.length) return
    if (allowedUsers.some((u) => u.toLowerCase() === login.toLowerCase())) return
    if (allowedOrgs.length) {
      const mine = await orgs()
      if (allowedOrgs.some((o) => mine.includes(o.toLowerCase()))) return
    }
    throw new Refusal(`${login} isn’t one of this hub’s people. Ask whoever runs it to add you.`)
  }

  /** On a hub run on this machine with no GitHub app: signing in with a name, for trying it out. */
  async devUser(login: string): Promise<User> {
    if (!this.options.devLogin()) throw new Refusal('Signing in without GitHub is off on this hub.')
    const clean = login.trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 39)
    if (!clean) throw new Refusal('Give a name of letters, digits and dashes.')
    return { login: clean, name: clean }
  }

  /** A one-time link for setting up a hub nobody can sign in to yet: it signs its opener in to do the setup. */
  async setupCode() {
    const code = randomBytes(18).toString('base64url')
    await this.kv.set(`setup-code:${sha(code)}`, '1', 24 * 3600)
    return code
  }

  async useSetupCode(code: string) {
    const key = `setup-code:${sha(code)}`
    if (!(await this.kv.get(key))) throw new Refusal('That setup link was used already, or it\u2019s older than a day. Restart the hub for a new one.')
    await this.kv.del(key)
    return { login: 'setup', name: 'Setting up' } satisfies User
  }

  // Agents' tokens -------------------------------------------------------------------------------------------------

  /** A new token for an agent of a Binder; any earlier one stops working. Shown once: only its hash is kept. */
  async issueAgentToken(agentId: string, space: string) {
    const token = `bnd_${randomBytes(32).toString('base64url')}`
    const old = await this.kv.get(`agent-token-of:${agentId}`)
    if (old) await this.kv.del(`agent-token:${old}`)
    const hash = sha(token)
    await this.kv.set(`agent-token:${hash}`, `${space}/${agentId}`)
    await this.kv.set(`agent-token-of:${agentId}`, hash)
    return token
  }

  /** The agent a token is for, and its Binder: none for a token made before a hub held several, which is the first's. */
  async agentFor(token: string | undefined): Promise<{ id: string; space?: string } | undefined> {
    if (!token?.startsWith('bnd_')) return undefined
    const hash = sha(token)
    const value = await this.kv.get(`agent-token:${hash}`)
    if (!value) return undefined
    const at = value.indexOf('/')
    const id = at >= 0 ? value.slice(at + 1) : value
    // The kept hash must be the agent's current one.
    const current = await this.kv.get(`agent-token-of:${id}`)
    if (!current || !timingSafeEqual(Buffer.from(current), Buffer.from(hash))) return undefined
    return { id, space: at >= 0 ? value.slice(0, at) : undefined }
  }

  async revokeAgent(agentId: string) {
    const hash = await this.kv.get(`agent-token-of:${agentId}`)
    if (hash) await this.kv.del(`agent-token:${hash}`)
    await this.kv.del(`agent-token-of:${agentId}`)
  }

  // People's tokens, for apps (the Mac) that can't keep the session cookie, and for MCP clients that sign in through
  // OAuth. An app's lasts until it's revoked; an MCP client's runs out, and its refresh token renews it.

  /**
   * A token for an app (or an MCP client that can't sign in with OAuth) to act as this person, with their GitHub token
   * as their session has it. Shown once. An app's lasts until it's revoked; an MCP client's too, when it's made here.
   */
  async issuePersonToken(user: User, app: string, githubToken?: string, space?: string, kind: 'app' | 'mcp' = 'app') {
    const token = `bnp_${randomBytes(32).toString('base64url')}`
    const hash = sha(token)
    const id = randomBytes(9).toString('base64url')
    const at = new Date().toISOString()
    const stored: StoredPersonToken = { id, user, app, space, token: githubToken ? this.seal(githubToken) : undefined, at, kind }
    await this.kv.set(`person-token:${hash}`, JSON.stringify(stored))
    const mine = await this.personTokenList(user.login)
    await this.kv.set(`person-tokens-of:${user.login.toLowerCase()}`, JSON.stringify([...mine, { id, hash, app, at, kind }]))
    return { token, id }
  }

  /** The hub's own keys, for the OAuth server's clients and codes. */
  get store(): KV {
    return this.kv
  }

  /**
   * A person token for an MCP client that signed in through OAuth: an access token that runs out, and a refresh token
   * that renews it (once: the client gets a new one each time). Only its hashes are kept, as for an agent's.
   */
  async issueOAuthPersonToken(user: User, app: string, clientId: string, space: string, scope: string, renewing?: { id: string; at: string }, spaces?: string[]) {
    const token = `bnp_${randomBytes(32).toString('base64url')}`
    const refresh = `bnr_${randomBytes(32).toString('base64url')}`
    const hash = sha(token)
    const refreshHash = sha(refresh)
    // A renewal is the same connection: its id and when it was made stay, so the account page can still stop it.
    const id = renewing?.id ?? randomBytes(9).toString('base64url')
    const at = renewing?.at ?? new Date().toISOString()
    const expiresAt = new Date(Date.now() + oauthAccessSeconds * 1000).toISOString()
    const several = spaces && spaces.length > 1 ? { spaces } : {}
    const stored: StoredPersonToken = { id, user, app, space, ...several, at, kind: 'mcp', clientId, scope, expiresAt, refreshHash }
    await this.kv.set(`person-token:${hash}`, JSON.stringify(stored))
    const kept: StoredRefresh = { id, user, app, space, ...several, clientId, scope, accessHash: hash, at, expiresAt: new Date(Date.now() + oauthRefreshSeconds * 1000).toISOString() }
    await this.kv.set(`oauth-refresh:${refreshHash}`, JSON.stringify(kept), oauthRefreshSeconds)
    const mine = await this.personTokenList(user.login)
    await this.kv.set(`person-tokens-of:${user.login.toLowerCase()}`, JSON.stringify([...mine, { id, hash, app, at, kind: 'mcp' }]))
    return { token, refresh, id, expiresIn: oauthAccessSeconds }
  }

  /**
   * A refresh token for a new access token, rotating both: the old access token stops working. Copies of a client on one
   * machine share a connection, and when its hour is up they all renew at once. So for a minute a used refresh token
   * gets the same answer again, and they all end up with the same tokens; refused, a client throws its login away and
   * asks its person to allow it again, every hour. After that it's refused, and the connection stands: a client asleep
   * through the renewal shouldn't cost everyone else theirs.
   */
  async refreshOAuthPersonToken(refresh: string, clientId: string): Promise<OAuthIssued> {
    const hash = sha(refresh)
    const running = this.oauthRenewals.get(hash)
    const renewal = running ?? this.renewOAuth(hash).finally(() => this.oauthRenewals.delete(hash))
    if (!running) this.oauthRenewals.set(hash, renewal)
    const done = await renewal
    if (done.clientId !== clientId) {
      await this.stopConnection(done.login, done.issued.id)
      throw new Refusal('That refresh token is for another client.')
    }
    return done.issued
  }

  private oauthRenewals = new Map<string, Promise<OAuthRenewal>>()

  private async renewOAuth(hash: string): Promise<OAuthRenewal> {
    const raw = await this.kv.take(`oauth-refresh:${hash}`)
    if (!raw) {
      const sealed = await this.kv.get(`oauth-renewed:${hash}`)
      if (sealed) return JSON.parse(this.sealer.open(sealed)) as OAuthRenewal
      throw new Refusal('That refresh token is unknown, or was used already.')
    }
    const kept = JSON.parse(raw) as StoredRefresh
    if (Date.parse(kept.expiresAt) <= Date.now()) {
      await this.stopConnection(kept.user.login, kept.id)
      throw new Refusal('That refresh token has run out: connect again.')
    }
    await this.kv.del(`person-token:${kept.accessHash}`)
    const mine = await this.personTokenList(kept.user.login)
    await this.kv.set(`person-tokens-of:${kept.user.login.toLowerCase()}`, JSON.stringify(mine.filter((t) => t.id !== kept.id)))
    const issued = await this.issueOAuthPersonToken(kept.user, kept.app, kept.clientId, kept.space, kept.scope, { id: kept.id, at: kept.at }, kept.spaces)
    const renewal: OAuthRenewal = { clientId: kept.clientId, login: kept.user.login, issued }
    await this.kv.set(`oauth-renewed:${hash}`, this.sealer.seal(JSON.stringify(renewal)), oauthRenewGraceSeconds)
    return renewal
  }

  /** Stops a connection that may already be gone. */
  private async stopConnection(login: string, id: string) {
    await this.revokePersonToken(login, id).catch((error) => {
      if (!(error instanceof Refusal)) throw error
    })
  }

  /** Stops an access or refresh token at once: the access token, its refresh token, and its place in the list. */
  async revokeOAuthToken(token: string | undefined) {
    if (!token) return
    if (token.startsWith('bnr_')) {
      const hash = sha(token)
      const raw = await this.kv.get(`oauth-refresh:${hash}`)
      if (!raw) return
      const kept = JSON.parse(raw) as StoredRefresh
      await this.kv.del(`oauth-refresh:${hash}`)
      await this.kv.del(`person-token:${kept.accessHash}`)
      const mine = await this.personTokenList(kept.user.login)
      await this.kv.set(`person-tokens-of:${kept.user.login.toLowerCase()}`, JSON.stringify(mine.filter((t) => t.id !== kept.id)))
      return
    }
    if (!token.startsWith('bnp_')) return
    const hash = sha(token)
    const raw = await this.kv.get(`person-token:${hash}`)
    if (!raw) return
    const stored = JSON.parse(raw) as StoredPersonToken
    await this.kv.del(`person-token:${hash}`)
    if (stored.refreshHash) await this.kv.del(`oauth-refresh:${stored.refreshHash}`)
    const mine = await this.personTokenList(stored.user.login)
    await this.kv.set(`person-tokens-of:${stored.user.login.toLowerCase()}`, JSON.stringify(mine.filter((t) => t.id !== stored.id)))
  }

  async personFor(token: string | undefined): Promise<{ user: User; token?: string; space?: string; spaces?: string[]; id: string; kind: 'app' | 'mcp' } | undefined> {
    if (!token?.startsWith('bnp_')) return undefined
    const raw = await this.kv.get(`person-token:${sha(token)}`)
    if (!raw) return undefined
    const stored = JSON.parse(raw) as StoredPersonToken
    if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) return undefined
    let githubToken: string | undefined
    try {
      githubToken = stored.token ? this.open(stored.token) : undefined
    } catch {
      // Sealed with another secret: the token stands, its GitHub token doesn't.
    }
    return { user: stored.user, token: githubToken, space: stored.space, ...(stored.spaces ? { spaces: stored.spaces } : {}), id: stored.id, kind: stored.kind ?? 'app' }
  }

  /**
   * A person's tokens, without the tokens themselves: which app, since when, and the Binder whose GitHub App it signed
   * in through (space). kind says whether it's an app signed in through the browser or an MCP client through OAuth.
   */
  async personTokens(login: string) {
    const mine = await this.personTokenList(login)
    // A revoke racing a new token can leave a dead one in the list: only those still known count.
    const live = await Promise.all(mine.map(async (t) => {
      const raw = await this.kv.get(`person-token:${t.hash}`)
      if (!raw) return undefined
      const stored = JSON.parse(raw) as StoredPersonToken
      // An MCP access token that has run out is still a live connection while its refresh token renews it.
      if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) {
        if (!stored.refreshHash || !(await this.kv.get(`oauth-refresh:${stored.refreshHash}`))) return undefined
      }
      return { id: t.id, app: t.app, at: t.at, space: stored.space, spaces: stored.spaces, kind: stored.kind ?? 'app', expiresAt: stored.expiresAt, clientId: stored.clientId }
    }))
    return live.filter((t) => !!t)
  }

  /** Stops one of a person's tokens at once, and its refresh token. Only their own: someone else's id is refused like an unknown one. */
  async revokePersonToken(login: string, id: string) {
    const mine = await this.personTokenList(login)
    const found = mine.find((t) => t.id === id)
    if (!found) throw new Refusal('No such token.')
    const raw = await this.kv.get(`person-token:${found.hash}`)
    await this.kv.del(`person-token:${found.hash}`)
    if (raw) {
      const stored = JSON.parse(raw) as StoredPersonToken
      if (stored.refreshHash) await this.kv.del(`oauth-refresh:${stored.refreshHash}`)
      else await this.kv.set(`person-token-stopped:${found.hash}`, '1')
    }
    await this.kv.set(`person-tokens-of:${login.toLowerCase()}`, JSON.stringify(mine.filter((t) => t.id !== id)))
  }

  /** Whether this was a token made by hand and stopped since. An OAuth client's that's gone signs in again; this can't. */
  async stoppedByHand(token: string | undefined) {
    return !!token?.startsWith('bnp_') && !!(await this.kv.get(`person-token-stopped:${sha(token)}`))
  }

  private async personTokenList(login: string) {
    const raw = await this.kv.get(`person-tokens-of:${login.toLowerCase()}`)
    return raw ? (JSON.parse(raw) as { id: string; hash: string; app: string; at: string; kind?: 'app' | 'mcp' }[]) : []
  }
}

/** How long an MCP client's access token lasts, and how long its refresh token may renew it. */
const oauthAccessSeconds = 60 * 60
const oauthRefreshSeconds = 30 * 24 * 60 * 60
/** How long after a renewal its old refresh token may be seen again without stopping the connection. */
const oauthRenewGraceSeconds = 60

/** What a renewal gave, in its own right and for a moment after: refresh tokens are one use, and clients share them. */
interface OAuthIssued {
  token: string
  refresh: string
  id: string
  expiresIn: number
}

interface OAuthRenewal {
  clientId: string
  login: string
  issued: OAuthIssued
}

interface StoredRefresh {
  id: string
  user: User
  app: string
  space: string
  /** Every Binder the connection reaches, when it's more than one (space is the first). */
  spaces?: string[]
  clientId: string
  scope: string
  /** The hash of the access token it was issued with, so revoking it stops that too. */
  accessHash: string
  at: string
  expiresAt: string
}

interface StoredPersonToken {
  id: string
  user: User
  /** The app it was given to, as it named itself: "Binders for Mac on Ana’s MacBook", or an MCP client's name. */
  app: string
  /** The GitHub token, encrypted with the hub's secret. */
  token?: string
  /** The Binder whose GitHub App that token is for; for an MCP connection, the (first) Binder it reaches. */
  space?: string
  /** Every Binder an MCP connection reaches, when its person allowed more than one. */
  spaces?: string[]
  at: string
  /** What it was given to: an app signed in through the browser, or an MCP client signed in through OAuth. */
  kind?: 'app' | 'mcp'
  /** When it stops working: set for MCP clients; an app's lasts until it's revoked. */
  expiresAt?: string
  /** The OAuth client it was issued to. */
  clientId?: string
  scope?: string
  /** Its refresh token's hash, if it has one. */
  refreshHash?: string
}
