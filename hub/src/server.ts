import Fastify, { LogController, type FastifyBaseLogger } from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { sessionCookie, type Auth, type User } from './auth.ts'
import { RedisLog } from './log.ts'
import type { OptionsStore } from './options.ts'
import { agentRoutes } from './routes/agents.ts'
import { binderRoutes } from './routes/binders.ts'
import { copyRoutes } from './routes/copies.ts'
import { makeContext } from './routes/context.ts'
import { githubRoutes } from './routes/github.ts'
import { jiraRoutes } from './routes/jira.ts'
import { machineRoutes } from './routes/machines.ts'
import { oauthRoutes } from './routes/oauth.ts'
import { personalRoutes } from './routes/personal.ts'
import { signInRoutes } from './routes/signIn.ts'
import { stateRoutes } from './routes/state.ts'
import { tellRoutes } from './routes/tell.ts'
import { listenRoutes } from './routes/listen.ts'
import { webRoutes } from './routes/web.ts'
import { workRoutes } from './routes/work.ts'
import { brainRoutes } from './routes/brain.ts'
import { appLinkRoutes } from './routes/appLink.ts'
import type { BrainSettingsStore } from './brain/settings.ts'
import type { BrainMachines } from './brain/machines.ts'
import { readerMaySend } from './reader.ts'
import { readerWords, type Role, type Space, type Spaces } from './spaces.ts'

export { installer } from './routes/machines.ts'

export interface ServerOptions {
  /** The web app's address as people reach it, for GitHub's sign-in to come back to. */
  publicUrl: string
  /** GitHub logins who may change how the hub reaches GitHub, besides whoever made its app. */
  admins?: string[]
  /** Where the hub's own requests and warnings go. */
  logger?: FastifyBaseLogger
  /** Every request in the log, not only what goes wrong. */
  logRequests?: boolean
  /** The web app, built: the hub serves it itself when there's no Vite in front of it, as on a server. */
  webDir?: string
  /** Browsers enforce the content security policy, rather than only reporting what it would stop. */
  enforceCsp?: boolean
  /** What the server's updater writes when a newer commit's tests failed (.data/update-failed.txt). */
  updateFailedFile?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
    githubToken?: string
    /** Signed in through the OAuth App: its token, to look people up on GitHub. */
    identityToken?: string
    /** The person token this request came with, if it came with one rather than the session cookie. */
    personToken?: string
    /** The Binder it's for: the one it names (x-binders-space, or ?space= on the live feed), else the person's first. */
    space?: Space
    role?: Role
  }
}

/**
 * The hub over HTTP. People sign in at /auth (GitHub, or by name on a hub run on this machine); everything under /api
 * needs a session, and anything that changes something needs the web app's x-binders header too. Apps (the Mac) sign
 * in through /auth/app and use the person token it hands back, as a Bearer token, instead. Agents use /mcp with their
 * token. GitHub posts to /webhooks/github/<binder>, each Binder having its own GitHub App (the first's at /webhooks/github).
 *
 * A hub holds one or more Binders (spaces, in the code), each a team's own board. Most of /api is about one of them:
 * the one a request names with x-binders-space, or the first the person may open. Who may open which is the
 * Binder's members; the hub's admins make Binders and look after those that have no owner.
 */
export async function buildServer(spaces: Spaces, deps: { auth: Auth; options?: OptionsStore; brain?: BrainSettingsStore; machines?: BrainMachines }, options: ServerOptions) {
  const context = makeContext(spaces, deps, options)
  const { auth, isAdmin, secure, signInSpace } = context
  // A Binder with no owner is looked after by the hub's admins: the Binders' roles ask who they are.
  spaces.hubAdmin = isAdmin
  const app = Fastify({ ...(options.logger ? { loggerInstance: options.logger } : { logger: false }), logController: new LogController({ disableRequestLogging: !options.logRequests }), bodyLimit: 4 * 1024 * 1024, trustProxy: trustedProxies() })
  // The hub listens before its Binders have started, which takes a while with many of them: a server that watches
  // /health then sees a hub that's busy, not one that's gone. Until they're up, it's all that's answered besides /ready.
  app.addHook('onRequest', async (request, reply) => {
    if (spaces.ready) return
    const path = request.url.split('?')[0]
    if (path === '/health' || path === '/ready') return
    const error = 'The hub is still starting. Try again in a moment.'
    reply.code(503).header('retry-after', '5')
    return path.startsWith('/api/') ? reply.send({ error }) : reply.type('text/plain; charset=utf-8').send(error)
  })
  await app.register(websocket)
  await app.register(cookie)
  // OAuth's token, registration and revocation requests are form-encoded, as the spec says. A field sent more than once
  // (the binders ticked on the consent page) is a list; OAuth's own fields are read only as one value.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try {
      const fields: Record<string, string | string[]> = {}
      for (const [key, value] of new URLSearchParams(body as string)) {
        const had = fields[key]
        fields[key] = had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value]
      }
      done(null, fields)
    } catch (error) {
      done(error as Error)
    }
  })
  await app.register(helmet, {
    // Off unless the hub is on https: told once, a browser wouldn't reach it on plain http again.
    strictTransportSecurity: secure ? undefined : false,
    contentSecurityPolicy: {
      useDefaults: false,
      reportOnly: !options.enforceCsp,
      directives: {
        defaultSrc: ["'self'"],
        // WebAssembly is Automerge.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        // The editor, motion and Mermaid's diagrams all put styles in the page.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Notes show pictures from anywhere, and avatars come from GitHub.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", new URL(options.publicUrl).origin.replace(/^http/, 'ws')],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
  // Only where it's asked for, per route: typing, agents, GitHub and health checks aren't limited. Behind Cloudflare
  // everyone arrives from the tunnel, so the address it was given is the one to count, but only when the request came
  // from a proxy on this machine or its network: from anywhere else, that header is whatever the sender wrote.
  // Signed in, the person is counted.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.user?.login ?? String((nearby(request.socket.remoteAddress) && request.headers['cf-connecting-ip']) || request.ip),
    errorResponseBuilder: (_request, context) => Object.assign(new Error(`Too many tries. Try again in ${context.after}.`), { statusCode: 429 }),
  })

  // Who's asking, for everything under /api.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return
    // A runner's live link says who it is in its first message: its agent's token. So does a brain machine's, and its
    // who-am-I takes the machine's own token.
    if (['/api/runner/live', '/api/brain/machine', '/api/brain/machine/me', '/api/brain/machines/join', '/api/machines/join'].includes(request.url.split('?')[0])) return
    // An app's person token. A browser only sends this header when a page sets it, and no other site's page may (no
    // CORS here), so it needs no x-binders header.
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    // The Binder whose GitHub App they signed in through, and the token it gave.
    let signedThrough: { space?: string; token?: string } = {}
    if (bearer) {
      const person = await auth.personFor(bearer)
      if (!person) return reply.code(401).header('www-authenticate', 'Bearer realm="binders"').send({ error: 'This hub doesn’t know that token. Sign in again.' })
      // An MCP client's token is for its binder's MCP tools, not for everything the person can do.
      if (person.kind === 'mcp') return reply.code(403).send({ error: 'That token is for MCP only.' })
      request.user = person.user
      signedThrough = { space: person.space, token: person.token }
      request.personToken = person.id
    } else {
      const session = await auth.session(request.cookies[sessionCookie])
      if (!session) return reply.code(401).send({ error: 'Sign in first.' })
      request.user = session.user
      signedThrough = { space: session.space, token: session.token }
      request.identityToken = session.identity
      // Changes need the web app's own header, which another site can't send: no cross-site requests.
      if (request.method !== 'GET' && request.headers['x-binders'] !== '1') return reply.code(403).send({ error: 'Missing the web app’s header.' })
    }
    // Everyone gets a Binder of their own, made the first time they're seen.
    await spaces.ensurePersonal(request.user.login, signedThrough.space ?? signInSpace()).catch(() => undefined)
    const named = String(request.headers['x-binders-space'] ?? (request.query as { space?: string } | undefined)?.space ?? '')
    const mine = spaces.forPerson(request.user.login, isAdmin(request.user.login))
    const found = named ? mine.find((s) => s.info.id === named) : mine[0]
    if (found) {
      // Started now if it's a personal Binder nobody has needed since the hub started.
      request.space = await spaces.start(found.info.id)
      request.role = found.role
      // Their GitHub for this Binder: their sign-in to its own app (signed in before the hub kept one per Binder, the
      // token they signed in with, which is the first Binder's).
      // Each binder's own: their sign-in to its app, never another binder's; a personal binder has none.
      const through = signedThrough.space ?? spaces.list()[0]?.id
      request.githubToken = found.info.personal ? undefined : await auth.githubFor(request.user.login, found.info.id, through === found.info.id ? signedThrough.token : undefined)
    }
    if (!request.space && !hubWide.test(request.url)) {
      return reply.code(403).send({ error: named ? 'You’re not in that Binder. Ask one of its owners to add you.' : 'You’re not in a Binder on this hub yet. Ask one of its admins to add you.' })
    }
    // A reader changes nothing in a Binder: this is the one place that says so, for every route, so one added later is
    // refused too until reader.ts lets it through. The Binders' own routes are about the Binder in their path.
    const about = /^\/api\/spaces\/([^/?]+)/.exec(request.url)
    let role = request.role
    if (about) {
      try {
        role = mine.find((s) => s.info.id === decodeURIComponent(about[1]))?.role
      } catch {
        role = undefined
      }
    }
    if (role === 'reader' && !readerMaySend(request.method, request.url, request.user.login)) return reply.code(403).send({ error: readerWords })
  })

  /** What's the hub's rather than one Binder's: who you are, your tokens, its options, GitHub, and its Binders (the list of them, too). */
  const hubWide = /^\/api\/(me|tokens|options|spaces|hub)(\/|\?|$)/
  app.get('/health', async () => ({ ok: true }))
  app.get('/ready', async (_request, reply) => {
    if (!spaces.ready) return reply.code(503).send({ ok: false, message: 'The hub is still starting its Binders.' })
    const log = spaces.all()[0]?.hub.log
    const ready = log instanceof RedisLog ? await log.ping().catch(() => false) : !!log
    return reply.code(ready ? 200 : 503).send({ ok: ready, log: log?.kind, binders: spaces.list().length })
  })

  await signInRoutes(app, context)
  await stateRoutes(app, context)
  await binderRoutes(app, context)
  await copyRoutes(app, context)
  await workRoutes(app, context)
  await agentRoutes(app, context)
  await githubRoutes(app, context)
  await personalRoutes(app, context)
  await machineRoutes(app, context)
  await jiraRoutes(app, context)
  await tellRoutes(app, context)
  await listenRoutes(app, context)
  await brainRoutes(app, context)
  await appLinkRoutes(app, context)
  await oauthRoutes(app, context)
  await webRoutes(app, context)

  return app
}

/**
 * Proxies whose X-Forwarded-For is believed: TRUST_PROXY (true, or addresses and ranges), else those on this machine and
 * private networks, where a tunnel, Caddy or nginx in front of the hub would be.
 */
function trustedProxies(): boolean | string {
  const set = process.env.TRUST_PROXY?.trim()
  if (set === 'true' || set === '1') return true
  if (set === 'false' || set === '0') return false
  return set || 'loopback, linklocal, uniquelocal'
}

/** An address on this machine or a private network. */
export function nearby(address: string | undefined) {
  const a = (address ?? '').replace(/^::ffff:/, '')
  return a === '::1' || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)
}
