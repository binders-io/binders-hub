import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startingSeed } from '../../shared/seed.ts'
import { Actions } from './actions.ts'
import { Auth } from './auth.ts'
import { GitHubConnection } from './githubConnection.ts'
import { JiraConnection } from './jira.ts'
import { Hub } from './hub.ts'
import { HubLease, MemoryKV, RedisKV, type KV } from './kv.ts'
import { MemoryLog, RedisLog, RedisPair, type ChangeLog } from './log.ts'
import { CopyKeeper } from './copies.ts'
import { GitNotesSaver } from './savers/gitNotes.ts'
import { IssuesSaver } from './savers/issues.ts'
import { JiraSaver } from './savers/jira.ts'
import { ReviewsSaver } from './savers/reviews.ts'
import { Scheduler } from './scheduler.ts'
import { hubSecret, Sealer } from './secrets.ts'
import { buildServer } from './server.ts'
import { Spaces, firstSpaceIn, worksAlone, type Space, type SpaceInfo } from './spaces.ts'
import { agentReach } from './reach.ts'
import { Merger } from './merger.ts'
import { Webhooks } from './webhooks.ts'
import { GitHubPoller } from './poller.ts'
import { Teller } from './tell.ts'
import { OptionsStore, optionsFromEnv } from './options.ts'
import { log as hubLog } from './logger.ts'
import { BrainSettingsStore } from './brain/settings.ts'
import { BrainMachines } from './brain/machines.ts'
import { SpaceBrain } from './brain/brain.ts'
import { KeptKV, StateFile } from './kept.ts'
import { VectorFiles, vectorBranch } from './brain/vectorFiles.ts'
import type { Binder } from '../../shared/notes.ts'

// Everything comes from the environment (see README.md). GitHub is best set up from Settings, which makes a GitHub App
// and keeps its keys here; the GITHUB_* variables set it up by hand instead, and win where both are set.
//   PORT, HOST              where the hub listens (4400 on 127.0.0.1)
//   PUBLIC_URL              the web app's address as people reach it (http://localhost:5173)
//   REDIS_URL               the change log's Redis, a working copy of what's kept in .data; without it the log lives in
//                           this process and is gone when it stops
//   HUB_SPACE, HUB_NAME     the first Binder's address and name (main, or what the hub's store already has); more are made from the binder switcher’s “New binder…”
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
//   HUB_LEASE_SECONDS       how long this hub's hold on its Redis lasts if it dies without letting go (30); it renews it a third of that often
//   HUB_LEASE_WAIT_SECONDS  how long it waits for another hub's hold on the same Redis to lapse before giving up (40)
//   LOG=1                   every request in the log, not only what goes wrong; LOG_LEVEL sets how much (info)
//   CSP_ENFORCE             1 for browsers to enforce the content security policy; unset, they report what it would stop
//   BRAIN_PROVIDER, BRAIN_MODEL, BRAIN_BASE_URL, BRAIN_API_KEY (or ANTHROPIC_API_KEY), EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL,
//   EMBEDDINGS_API_KEY, BRAIN_SUMMARIZE   the hub's own models, for summaries and answers (see brain/settings.ts)
const env = process.env
const port = Number(env.PORT ?? 4400)
const host = env.HOST ?? '127.0.0.1'
const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const hubKeys = '_hub'
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'

// Every Binder's log shares one pair of connections, so a hub with thousands of them doesn't use up Redis's.
const redisPair = env.REDIS_URL ? new RedisPair(env.REDIS_URL) : undefined

// Only one hub may use a Redis: a second would merge, post issues and ask GitHub alongside the first. A hub that's
// restarting waits for its earlier self's hold to lapse, if that one didn't let go. Without a Redis there's nothing to share.
const seconds = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Number(value) * 1000 : fallback)
const leaseMs = seconds(env.HUB_LEASE_SECONDS, 30_000)
const leaseWaitMs = seconds(env.HUB_LEASE_WAIT_SECONDS, 40_000)
/** Set once the hub is up enough to stop properly. */
let stopHub: ((code: number) => Promise<void>) | undefined
const lease = redisPair && new HubLease(redisPair.redis, {
  ttlMs: leaseMs,
  renewMs: leaseMs / 3,
  waitMs: leaseWaitMs,
  onWait: () => console.log(`Another hub holds this Redis. Waiting up to ${Math.round(leaseWaitMs / 1000)} seconds for it to let go.`),
  onLost: (holder) => {
    console.error(`Another hub (${holder ?? 'unknown'}) has taken this Redis over, and only one may use it. This hub is stopping.`)
    if (stopHub) void stopHub(1)
    else process.exit(1)
  },
})
const early = lease && (() => void lease.release().finally(() => process.exit(0)))
if (lease && redisPair) {
  const taken = await lease.take()
  if (!taken.held) {
    console.error(`Another hub is running on this Redis${taken.holder ? ` (${taken.holder})` : ''}, and only one may. Stop it first, or give this hub a Redis of its own.`)
    redisPair.close()
    process.exit(1)
  }
  // Until the real ones are in place, below: a stop in between still lets go.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, early!)
}

const { secret, made } = await hubSecret(env.HUB_SECRET, resolve('.data/secret'))
if (made) console.log(`Made the hub's secret in ${resolve('.data/secret')}: keep it with the hub's data.`)
const sealer = new Sealer(secret)

// What's the hub's own (sessions, tokens, the GitHub App, options, its list of Binders) is kept apart from any Binder.
// A hub that held one Binder kept it in that Binder's keys: moved once.
// The first Binder's address: as set, else as the store already has it, else "main" for a new hub.
const hubFile = resolve('.data/hub-kept.json')
const space = env.HUB_SPACE ?? (redisPair ? await storedFirstSpace(redisPair) : undefined) ?? 'main'
const firstLog: ChangeLog = env.REDIS_URL ? new RedisLog(env.REDIS_URL, space, redisPair) : new MemoryLog()
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

/** A store whose lasting keys are in a file, so Redis can be rebuilt: those in Redis go there the first time. */
const keptIn = (redis: RedisKV, file: string) => {
  return new KeptKV(redis, file).load((skip) => redis.lasting(skip))
}
const kv: KV = firstLog instanceof RedisLog ? await keptIn(new RedisKV(firstLog.redis, hubKeys), hubFile) : new MemoryKV()

// The hub's options, changed in Settings; an environment variable for one fixes it.
const options = await new OptionsStore(kv, optionsFromEnv(env)).load()
// The models the hub's brain uses, set in Settings under Brain; BRAIN_* and EMBEDDINGS_* fix them.
const brainSettings = await new BrainSettingsStore(kv, sealer, env).load()
// Machines of yours serving the brain's models (a Mac, a DGX Spark), linked through the Binders daemon.
const brainMachines = await new BrainMachines(kv).load()
brainSettings.useMachines(brainMachines)

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

/** Where a Binder other than the first keeps its files. */
const binderDir = (id: string) => resolve(`.data/binders/${id}`)

/** A Binder's parts, started. The first keeps the folders it had before a hub held several; others get their own. */
async function startSpace(id: string, info: SpaceInfo): Promise<Space> {
  const first = id === space
  const dir = (name: string) => (first ? resolve(`.data/${name}`) : join(binderDir(id), name))
  const log = first ? firstLog : env.REDIS_URL ? new RedisLog(env.REDIS_URL, id, redisPair) : new MemoryLog()
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
    return !!state && (state.binders.some((b) => same(b.repo) || !!b.repos?.some(same)) || state.agents.some((a) => !a.revoked && a.repos.some(same)))
  }
  // This Binder's own store: one, as its parts share keys and a file.
  const ownKv: KV = log instanceof RedisLog ? await keptIn(new RedisKV(log.redis, id), dir('kept.json')) : new MemoryKV()
  // A Binder made from a copy has its saved state put in its folder before it starts, whether or not there's a Redis.
  const planted = !first && !(log instanceof RedisLog) && (await stat(dir('state.json')).then(() => true, () => false))
  const stateFile = log instanceof RedisLog || planted ? new StateFile(dir('state.json')) : undefined
  const github = new GitHubConnection(ownKv, sealer, endpoints, first ? manual : {}, first ? undefined : id, { id, binder: (other) => spaces.get(other)?.github, linked })
  await github.load()
  // An app made while the hub was only on this machine, or a tunnel with a new address: point its webhook here.
  const hook = info.personal ? 'already' : await github.pointWebhook(publicUrl).catch((error: Error) => `failed (${error.message})`)
  if (hook === 'pointed') console.log(`Pointed ${id}'s GitHub App's webhook at ${publicUrl}${github.path('hook')}.`)
  else if (hook.startsWith('failed')) hubLog.warn({ binder: id, why: hook }, 'Couldn’t point a GitHub App’s webhook here')
  const hub = new Hub(log)
  hub.lockManager = (login) => spaces.mayManage(id, login, spaces.hubAdmin(login))
  started = hub
  // A Binder is one notebook: it starts with the one binder its notes and board are in, named as it is.
  await hub.start(first ? startingSeed(options.get().allowedUsers[0] ?? 'you') : [{ type: 'binder.put', binder: info.personal ? { id: 'notes', name: 'Notes', createdBy: info.personal } : { id: 'main', name: info.name, createdBy: info.createdBy } }], await stateFile?.read(), await stateFile?.readDocs())
  await stateFile?.follow(hub)
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
  const jira = new JiraConnection(ownKv, sealer, id)
  await jira.load().catch(() => undefined)
  const jiraIssues = new JiraSaver(hub, () => jira, ownKv, id)
  void jiraIssues.load().catch(() => undefined)
  jiraIssues.start()
  // A channel the binder tells when something starts waiting, if its owners set one (Settings → How work flows).
  const tell = new Teller(ownKv, sealer, id, { state: () => hub.state, name: () => spaces.info(id)?.name ?? info.name, several: () => spaces.list().length > 1, base: boardUrl })
  await tell.load().catch(() => undefined)
  tell.start()
  // A Challenge's findings as a review on the card's pull request, in binders that turn it on.
  const reviews = new ReviewsSaver(hub, github, { publicUrl: boardUrl })
  reviews.start()
  const webhooks = new Webhooks(hub, actions, issues)
  // Without webhooks reaching it, the hub asks GitHub instead (HUB_POLL: auto, on or off; HUB_POLL_SECONDS: how often).
  const poller = new GitHubPoller(hub, github, webhooks, { settings: () => ({ mode: options.get().pollMode, everyMs: options.get().pollSeconds * 1000 }) })
  poller.start()
  // Environments come from GitHub's deployments: the hub looks for them itself (the scheduler's timer) unless webhooks tell it.
  actions.webhooksHeard = () => poller.webhookHeard
  await actions.followDeliveries()
  // The brain: this binder's notes and cards indexed in its own store, kept up as they change.
  // A personal binder is its person's alone: its passages aren't sent to an embeddings server the hub's admins chose.
  // Each binder's notes go to its own repo, on a branch of their own, and so do its daily copies.
  const reach = async (binder: Binder) => {
    if (!binder.repo) return undefined
    // A personal binder pushes with its person's own GitHub, connected through the OAuth App, when it is.
    const own = info.personal ? await auth.personalToken(info.personal) : undefined
    if (own) return { url: `${endpoints.webUrl}/${binder.repo}.git`, token: own, name: binder.repo, own: true }
    const access = await github.gitAccess(binder.repo)
    if (!access) throw new Error(`The hub can’t reach ${binder.repo}: install the GitHub App on it.`)
    return { ...access, name: binder.repo, own: false }
  }
  const pushTo = async (binder: Binder) => {
    if (!binder.repo || binder.notes === false) return undefined
    const { own, ...target } = (await reach(binder))!
    return { ...target, branch: binder.notesBranch || (own ? 'main' : 'binders-notes') }
  }
  // Its vectors outlive Redis: on the hub's disk, and in the binder's repo beside its notes, on a branch of their own.
  const files = info.personal ? undefined : new VectorFiles({
    dir: dir('embeddings'),
    binders: () => hub.state.binders,
    binderOf: (kind, item) => (kind === 'note' ? hub.state.notes : hub.state.cards).find((s) => s.id === item)?.binderId,
    pushTo: async (binder) => {
      const target = await pushTo(binder)
      return target && { ...target, branch: vectorBranch }
    },
    author: gitAuthor,
  })
  const brain = new SpaceBrain({ id, hub, kv: ownKv, settings: brainSettings, embeds: !info.personal, files })
  brain.start()
  const notesDir = first ? notesRoot : dir('notes')
  const notes = new GitNotesSaver(hub, {
    dir: notesDir,
    remote: first ? env.NOTES_REMOTE : undefined,
    pushTo,
    timing: () => ({ quietMs: options.get().notesQuietSeconds * 1000, longestMs: options.get().notesLongestMinutes * 60_000 }),
    author: gitAuthor,
  })
  await notes.start()
  // Notes run as cards on a timer.
  const scheduler = new Scheduler(hub, actions)
  // A daily copy of the whole binder on the hub's disk, and in its repo when the binder says so: asked on the timer.
  const copies = new CopyKeeper({
    dir: dir('copies'),
    hub,
    of: () => ({ id, name: spaces.info(id)?.name ?? info.name, people: spaces.info(id)?.members ?? [] }),
    pushTo: async (binder) => {
      const found = await reach(binder)
      if (!found) return undefined
      const { own: _own, ...target } = found
      return target
    },
    author: gitAuthor,
  })
  scheduler.copies = copies
  scheduler.start()
  const running: Space = {
    id, hub, actions, webhooks, github, notes, poller, issues, jira, jiraIssues, tell, filesDir: join(notesDir, 'files'), brain, copies,
    stop: async () => {
      // First: the rest of stopping can take longer than a server gives it.
      await stateFile?.save().catch(() => undefined)
      scheduler.stop()
      await copies.stop()
      tell.stop()
      brain.stop()
      poller.stop()
      await notes.stop()
      await issues.stop()
      await jiraIssues?.stop()
      await reviews.stop()
      await files?.stop()
      await stateFile?.stop()
      await log.close()
    },
  }
  return running
}

// A hub with no list of Binders yet: the one it had, with no members, so whoever the hub let in still gets in, as
// before. Adding its first member, as owner, closes it to everyone else.
const spaces = new Spaces(kv, startSpace)
spaces.dirOf = binderDir

// Listening comes first and the Binders start after: with thousands of them that takes a while, and a server that
// watches /health must see a hub that's busy rather than one that's gone. Until they're up, /ready and every other
// request say so (see server.ts).
const app = await buildServer(spaces, { auth, options, brain: brainSettings, machines: brainMachines }, { publicUrl, logger: hubLog, logRequests: env.LOG === '1', webDir: env.WEB_DIR, enforceCsp: env.CSP_ENFORCE === '1' })
await app.listen({ port, host })
console.log(`Binders hub listening on http://${host}:${port}; starting its Binders.`)

// Which personal Binders have work that goes on without their person: those start with the hub, and the rest when
// their person next comes. Said again each minute, as a Binder gains and loses such work, and once more as the hub stops.
const sayWhichWake = async () => {
  for (const space of spaces.all()) if (spaces.info(space.id)?.personal) await spaces.setWakes(space.id, worksAlone(space)).catch(() => undefined)
}
const wakesTimer = setInterval(() => void sayWhichWake(), 60_000)
wakesTimer.unref()

const stop = async (code: number) => {
  clearInterval(wakesTimer)
  await app.close()
  await sayWhichWake()
  await spaces.stop()
  // Last of the hub's, so the next one starts at once.
  await lease?.release()
  redisPair?.close()
  process.exit(code)
}
stopHub = stop
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  if (early) process.off(signal, early)
  process.on(signal, () => void stop(0))
}

try {
  await spaces.load({ id: space, name: env.HUB_NAME ?? space, members: [] })
} catch (error) {
  console.error(error)
  await stop(1)
}

const githubOf = (s: Space) => {
  const status = s.github.status()
  return `${s.id}: ${status.mode === 'none' ? 'not set up (its Settings → GitHub sets it up)' : `${status.mode === 'app' ? `app ${status.app?.slug}` : 'set up by hand'}${status.server ? ', reaching repos' : ', not installed on any repo yet'}${status.webhooks ? ', webhooks on' : ''}`}`
}
const lines = [
  `Binders hub on http://${host}:${port} for ${publicUrl}`,
  `log: ${firstLog.kind}${firstLog.kind === 'memory' ? ' (set REDIS_URL to keep it)' : ''}`,
  `Binders: ${spaces.all().map((s) => `${spaces.info(s.id)?.name ?? s.id} at /${s.id} (version ${s.hub.version})`).join(', ')}${spaces.asleep ? `, and ${spaces.asleep} personal that start when they’re first needed` : ''}`,
  `GitHub: ${spaces.all().map(githubOf).join('; ')}`,
  `following GitHub: ${options.get().pollMode === 'off' ? 'webhooks only' : `by asking every ${options.get().pollSeconds} s while no webhook arrives`}`,
  `sign-in: ${[signInThrough() ? `GitHub (through ${signInThrough()!.id}'s app)` : '', auth.options.devLogin() ? 'by name (this machine only)' : ''].filter(Boolean).join(' and ') || 'none yet'}`,
  `notes in ${notesRoot}`,
  `MCP for agents: ${publicUrl}/mcp`,
]
// Nobody can sign in yet: a one-time link to set GitHub up.
if (!signInThrough() && !auth.options.devLogin()) lines.push(`set up: ${publicUrl}/auth/setup?code=${await auth.setupCode()}`)
console.log(lines.join('\n  '))

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

async function storedFirstSpace(pair: RedisPair) {
  // The file first: Redis may have been rebuilt, and its first Binder would look like a new hub's.
  const kept = await firstSpaceIn(await new KeptKV(new MemoryKV(), hubFile).load())
  if (kept) return kept
  return firstSpaceIn(new RedisKV(pair.redis, hubKeys))
}
