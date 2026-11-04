import { join, resolve } from 'node:path'
import { startingSeed } from '../../shared/seed.ts'
import { Actions } from './actions.ts'
import { Auth } from './auth.ts'
import { GitHubConnection } from './githubConnection.ts'
import { JiraConnection } from './jira.ts'
import { Hub } from './hub.ts'
import { MemoryKV, RedisKV, type KV } from './kv.ts'
import { MemoryLog, RedisLog, type ChangeLog } from './log.ts'
import { GitNotesSaver } from './savers/gitNotes.ts'
import { IssuesSaver } from './savers/issues.ts'
import { JiraSaver } from './savers/jira.ts'
import { ReviewsSaver } from './savers/reviews.ts'
import { Scheduler } from './scheduler.ts'
import { hubSecret, Sealer } from './secrets.ts'
import { buildServer } from './server.ts'
import { Spaces, firstSpaceIn, type Space, type SpaceInfo } from './spaces.ts'
import { agentReach } from './reach.ts'
import { Merger } from './merger.ts'
import { Webhooks } from './webhooks.ts'
import { GitHubPoller } from './poller.ts'
import { OptionsStore, optionsFromEnv } from './options.ts'
import { log as hubLog } from './logger.ts'

// Everything comes from the environment (see README.md). GitHub is best set up from Settings, which makes a GitHub App
// and keeps its keys here; the GITHUB_* variables set it up by hand instead, and win where both are set.
//   PORT, HOST              where the hub listens (4400 on 127.0.0.1)
//   PUBLIC_URL              the web app's address as people reach it (http://localhost:5173)
//   REDIS_URL               the change log's Redis; without it the log lives in this process and is gone when it stops
//   HUB_SPACE, HUB_NAME     the first Binder's address and name (main, or what the hub's store already has); more are made in Settings
//   HUB_SECRET              seals what the hub keeps; without it, one is made in .data/secret and kept
//   HUB_ADMINS              GitHub logins who may change GitHub's setup, besides whoever made the app
//   HUB_ALLOWED_USERS, HUB_ALLOWED_ORGS      who may sign in, besides the app's maker and its organization
//   HUB_EMU_SHORTCODES      Enterprise Managed Users' shortcodes (comma-separated), left off their logins where people are shown
//   HUB_DEV_LOGIN           1 to allow signing in with a name alone; on by default on 127.0.0.1 until GitHub is set up
//   GITHUB_URL, GITHUB_API_URL               for GitHub Enterprise (github.com and api.github.com by default)
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET   GitHub set up by hand
//   NOTES_DIR, NOTES_REMOTE, GIT_AUTHOR      the notes repo, where its commits are pushed, and their author
//   HUB_POLL, HUB_POLL_SECONDS  asking GitHub instead of webhooks: auto (while no webhook arrives), on or off; every 30 s
//   NOTES_QUIET_SECONDS     how long typing pauses before a note is committed (60)
//   WEB_DIR                 the web app, built (web/dist), for the hub to serve itself when Vite isn't in front of it
//   LOG=1                   every request in the log, not only what goes wrong; LOG_LEVEL sets how much (info)
//   CSP_ENFORCE             1 for browsers to enforce the content security policy; unset, they report what it would stop
const env = process.env
const port = Number(env.PORT ?? 4400)
const host = env.HOST ?? '127.0.0.1'
const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const hubKeys = '_hub'
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'

const { secret, made } = await hubSecret(env.HUB_SECRET, resolve('.data/secret'))
if (made) console.log(`Made the hub's secret in ${resolve('.data/secret')}: keep it with the hub's data.`)
const sealer = new Sealer(secret)

// What's the hub's own (sessions, tokens, the GitHub App, options, its list of Binders) is kept apart from any Binder.
// A hub that held one Binder kept it in that Binder's keys: moved once.
// The first Binder's address: as set, else as the store already has it, else "main" for a new hub.
const space = env.HUB_SPACE ?? (env.REDIS_URL ? await storedFirstSpace(env.REDIS_URL) : undefined) ?? 'main'
const firstLog: ChangeLog = env.REDIS_URL ? new RedisLog(env.REDIS_URL, space) : new MemoryLog()
const kv: KV = firstLog instanceof RedisLog ? new RedisKV(firstLog.redis, hubKeys) : new MemoryKV()
if (firstLog instanceof RedisLog) {
  const moved = await moveHubKeys(firstLog, space)
  if (moved) console.log(`Moved ${moved} of the hub's own keys out of ${space}'s.`)
}

// Each Binder reaches GitHub through its own app; GITHUB_* set the first Binder's by hand. The hub's GitHub keys from
// before Binders had their own are the first's: moved once.
const endpoints = { webUrl: env.GITHUB_URL ?? 'https://github.com', apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com' }
const manual = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, token: env.GITHUB_TOKEN, webhookSecret: env.GITHUB_WEBHOOK_SECRET }
if (firstLog instanceof RedisLog) {
  const moved = await moveGitHubKeys(firstLog, space)
  if (moved) console.log(`Gave ${space} the hub's ${moved} GitHub keys from before each Binder had its own.`)
}

// The hub's options, changed in Settings; an environment variable for one fixes it.
const options = await new OptionsStore(kv, optionsFromEnv(env)).load()

/** The Binder people sign in to the hub through when none is named: the first with a GitHub App. */
const signInThrough = () => spaces.all().find((s) => s.github.signIn())
const auth = new Auth(kv, sealer, {
  github: (named) => (named ? spaces.get(named)?.github.signIn() : signInThrough()?.github.signIn()),
  // Let in: the hub's allowed people, every Binder's members, and whoever each Binder's app lets in.
  allowed: () => {
    const apps = spaces.all().map((s) => s.github.allowed())
    const now = options.get()
    return { users: [...now.allowedUsers, ...apps.flatMap((a) => a.users), ...spaces.people()], orgs: [...now.allowedOrgs, ...apps.flatMap((a) => a.orgs)] }
  },
  devLogin: () => {
    const mode = options.get().devLogin
    return mode === 'on' || (mode === 'auto' && loopback && !signInThrough() && !auth.oauthLogin())
  },
  // The hub's OAuth App for signing in, set by hand (GITHUB_OAUTH_CLIENT_ID and _SECRET) or else in Settings.
  oauth: () => (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET ? { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET, ...endpoints } : undefined),
  endpoints,
})
await auth.loadOAuthApp()

const author = /^(.*)<(.+)>$/.exec(env.GIT_AUTHOR ?? '')
const gitAuthor = author ? { name: author[1].trim(), email: author[2].trim() } : { name: 'Binders Hub', email: 'hub@binders.invalid' }
const notesRoot = resolve(env.NOTES_DIR ?? '.data/notes')

/** A Binder's parts, started. The first keeps the folders it had before a hub held several; others get their own. */
async function startSpace(id: string, info: SpaceInfo): Promise<Space> {
  const first = id === space
  const dir = (name: string) => (first ? resolve(`.data/${name}`) : resolve(`.data/binders/${id}/${name}`))
  const log = first ? firstLog : env.REDIS_URL ? new RedisLog(env.REDIS_URL, id) : new MemoryLog()
  // Each binder's GitHub is its own: its app, its installations and its people's sign-ins to it, seen by no other
  // binder, so a binder set up for one organization shows its repos to nobody outside it. A personal binder has no
  // GitHub App: its notes repo is its person's own, reached through the hub's OAuth App (pushTo, below).
  // The one exception, which the lending binder's owners see and can end: a binder may use another binder's app through
  // the installations its people can reach (an organization they're in, or their own account), found when it's asked
  // for as binders start one by one, and reaching through them only the repos it linked itself.
  let started: Hub | undefined
  const linked = (repo: string) => {
    const same = (r?: string) => !!r && r.toLowerCase() === repo.toLowerCase()
    const state = started?.state
    return !!state && (state.binders.some((b) => same(b.repo)) || state.agents.some((a) => !a.revoked && a.repos.some(same)))
  }
  const github = new GitHubConnection(log instanceof RedisLog ? new RedisKV(log.redis, id) : new MemoryKV(), sealer, endpoints, first ? manual : {}, first ? undefined : id, { id, binder: (other) => spaces.get(other)?.github, linked })
  await github.load()
  // An app made while the hub was only on this machine, or a tunnel with a new address: point its webhook here.
  const hook = info.personal ? 'already' : await github.pointWebhook(publicUrl).catch((error: Error) => `failed (${error.message})`)
  if (hook === 'pointed') console.log(`Pointed ${id}'s GitHub App's webhook at ${publicUrl}${github.path('hook')}.`)
  else if (hook.startsWith('failed')) hubLog.warn({ binder: id, why: hook }, 'Couldn’t point a GitHub App’s webhook here')
  const hub = new Hub(log)
  hub.lockManager = (login) => spaces.mayManage(id, login, false)
  started = hub
  // A Binder is one notebook: it starts with the one binder its notes and board are in, named as it is.
  await hub.start(first ? startingSeed(options.get().allowedUsers[0] ?? 'you') : [{ type: 'binder.put', binder: info.personal ? { id: 'notes', name: 'Notes', createdBy: info.personal } : { id: 'main', name: info.name, createdBy: info.createdBy } }])
  const actions = new Actions(hub, github)
  // Agents reach no more of GitHub than their owners.
  actions.reach = agentReach(github, auth, id, endpoints.webUrl)
  // Change sets merge as a train: the hub settles conflicts it can in its own working copies of the repos.
  actions.merger = new Merger({ dir: dir('repos'), access: (repo) => github.gitAccess(repo), author: gitAuthor })
  actions.mergeMethod = () => options.get().mergeMethod
  actions.agentCommits = () => options.get().agentCommits
  actions.watchTrains()
  actions.watchSwarm()
  void actions.moveBriefsToNotes().catch(() => {})
  // Links back to the board; the first Binder's stay at the hub's address, as they were written in its issues.
  const boardUrl = first ? publicUrl : `${publicUrl}/${id}`
  const issues = new IssuesSaver(hub, github, { publicUrl: boardUrl })
  issues.start()
  // Jira, this binder's own: the saver mirrors cards into it, its webhook brings what happened there back. Its secret
  // and the token it acts as live in the hub's store, sealed, the saver's issue ids beside them.
  const jiraKv = log instanceof RedisLog ? new RedisKV(log.redis, id) : new MemoryKV()
  const jira = new JiraConnection(jiraKv, sealer, id)
  await jira.load().catch(() => undefined)
  const jiraIssues = new JiraSaver(hub, () => jira, jiraKv, id)
  void jiraIssues.load().catch(() => undefined)
  jiraIssues.start()
  // A Challenge's findings as a review on the card's pull request, in binders that turn it on.
  const reviews = new ReviewsSaver(hub, github, { publicUrl: boardUrl })
  reviews.start()
  const webhooks = new Webhooks(hub, actions, issues)
  // Without webhooks reaching it, the hub asks GitHub instead (HUB_POLL: auto, on or off; HUB_POLL_SECONDS: how often).
  const poller = new GitHubPoller(hub, github, webhooks, { settings: () => ({ mode: options.get().pollMode, everyMs: options.get().pollSeconds * 1000 }) })
  poller.start()
  const notesDir = first ? notesRoot : dir('notes')
  const notes = new GitNotesSaver(hub, {
    dir: notesDir,
    remote: first ? env.NOTES_REMOTE : undefined,
    // Each binder's notes go to its own repo, on a branch of their own.
    pushTo: async (binder) => {
      if (!binder.repo || binder.notes === false) return undefined
      // A personal binder pushes with its person's own GitHub, connected through the OAuth App, when it is.
      const own = info.personal ? await auth.personalToken(info.personal) : undefined
      if (own) return { url: `${endpoints.webUrl}/${binder.repo}.git`, token: own, branch: binder.notesBranch || 'main', name: binder.repo }
      const access = await github.gitAccess(binder.repo)
      if (!access) throw new Error(`The hub can’t reach ${binder.repo}: install the GitHub App on it.`)
      return { ...access, branch: binder.notesBranch || 'binders-notes', name: binder.repo }
    },
    timing: () => ({ quietMs: options.get().notesQuietSeconds * 1000, longestMs: options.get().notesLongestMinutes * 60_000 }),
    author: gitAuthor,
  })
  await notes.start()
  // Notes run as cards on a timer.
  const scheduler = new Scheduler(hub, actions)
  scheduler.start()
  const running: Space = {
    id, hub, actions, webhooks, github, notes, poller, issues, jira, jiraIssues, filesDir: join(notesDir, 'files'),
    stop: async () => {
      scheduler.stop()
      poller.stop()
      await notes.stop()
      await issues.stop()
      await jiraIssues?.stop()
      await reviews.stop()
      await log.close()
    },
  }
  return running
}

// A hub with no list of Binders yet: the one it had, with no members, so whoever the hub let in still gets in, as
// before. Adding its first member, as owner, closes it to everyone else.
const spaces = new Spaces(kv, startSpace)
await spaces.load({ id: space, name: env.HUB_NAME ?? space, members: [] })

const app = await buildServer(spaces, { auth, options }, { publicUrl, logger: hubLog, logRequests: env.LOG === '1', webDir: env.WEB_DIR, enforceCsp: env.CSP_ENFORCE === '1' })
await app.listen({ port, host })

const githubOf = (s: Space) => {
  const status = s.github.status()
  return `${s.id}: ${status.mode === 'none' ? 'not set up (its Settings → GitHub sets it up)' : `${status.mode === 'app' ? `app ${status.app?.slug}` : 'set up by hand'}${status.server ? ', reaching repos' : ', not installed on any repo yet'}${status.webhooks ? ', webhooks on' : ''}`}`
}
const lines = [
  `Binders hub on http://${host}:${port} for ${publicUrl}`,
  `log: ${firstLog.kind}${firstLog.kind === 'memory' ? ' (set REDIS_URL to keep it)' : ''}`,
  `Binders: ${spaces.all().map((s) => `${spaces.info(s.id)?.name ?? s.id} at /${s.id} (version ${s.hub.version})`).join(', ')}`,
  `GitHub: ${spaces.all().map(githubOf).join('; ')}`,
  `following GitHub: ${options.get().pollMode === 'off' ? 'webhooks only' : `by asking every ${options.get().pollSeconds} s while no webhook arrives`}`,
  `sign-in: ${[signInThrough() ? `GitHub (through ${signInThrough()!.id}'s app)` : '', auth.options.devLogin() ? 'by name (this machine only)' : ''].filter(Boolean).join(' and ') || 'none yet'}`,
  `notes in ${notesRoot}`,
  `MCP for agents: ${publicUrl}/mcp`,
]
// Nobody can sign in yet: a one-time link to set GitHub up.
if (!signInThrough() && !auth.options.devLogin()) lines.push(`set up: ${publicUrl}/auth/setup?code=${await auth.setupCode()}`)
console.log(lines.join('\n  '))

const stop = async () => {
  await app.close()
  await spaces.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

/** Moves the hub's own keys (hub:<first>:kv:…) to hub:_hub:kv:…, once: renamed, so each keeps what's left of its expiry. */
async function moveHubKeys(log: RedisLog, from: string) {
  const redis = log.redis
  const done = `hub:${hubKeys}:kv:moved-from`
  if (await redis.exists(done)) return 0
  let cursor = '0'
  let moved = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `hub:${from}:kv:*`, 'COUNT', 500)
    for (const key of keys) {
      await redis.renamenx(key, `hub:${hubKeys}:kv:${key.slice(`hub:${from}:kv:`.length)}`)
      moved++
    }
    cursor = next
  } while (cursor !== '0')
  await redis.set(done, from)
  return moved
}

/**
 * Gives the first Binder the hub's GitHub keys from before each Binder had its own app, once: the app and any setup
 * under way go to its keys, and people's sign-ins to that app become theirs for it.
 */
async function moveGitHubKeys(log: RedisLog, first: string) {
  const redis = log.redis
  const done = `hub:${hubKeys}:kv:github-moved-to`
  if (await redis.exists(done)) return 0
  const from = `hub:${hubKeys}:kv:`
  let moved = 0
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${from}github-*`, 'COUNT', 500)
    for (const key of keys) {
      const name = key.slice(from.length)
      const person = /^github-person:([^:]+)$/.exec(name)
      if (person) await redis.renamenx(key, `${from}github-person:${first}:${person[1]}`)
      else if (name === 'github-app' || name.startsWith('github-app-state:')) await redis.renamenx(key, `hub:${first}:kv:${name}`)
      else continue
      moved++
    }
    cursor = next
  } while (cursor !== '0')
  await redis.set(done, first)
  return moved
}

async function storedFirstSpace(url: string) {
  const probe = new RedisLog(url, hubKeys)
  try {
    return await firstSpaceIn(new RedisKV(probe.redis, hubKeys))
  } finally {
    await probe.close()
  }
}
