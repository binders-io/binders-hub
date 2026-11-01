import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Refusal, sessionCookie } from '../auth.ts'
import { personalId } from '../spaces.ts'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { GitHubLogin, User } from '../auth.ts'
import type { Context } from './context.ts'

// Signing in and out: GitHub, an app on the Mac, by name on a hub on this machine, and who you are.

const appStatePattern = /^[A-Za-z0-9_-]{8,128}$/
const appCookie = 'binders_app'

/** Sign-in and the like: plenty for a person, too few to guess with. */
const signInLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

/** An app's sign-in, kept in a cookie while the person is away at GitHub. */
interface PendingApp {
  state: string
  app: string
  redirect: string
}

/** Only back to the app: a binders:// link, binders://auth unless the app says which. */
function appRedirect(redirect: string | undefined) {
  try {
    const url = new URL(redirect || 'binders://auth')
    return url.protocol === 'binders:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function readPendingApp(cookie: string | undefined): PendingApp | undefined {
  if (!cookie) return undefined
  try {
    const pending = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8')) as PendingApp
    return appStatePattern.test(pending.state) && appRedirect(pending.redirect) && typeof pending.app === 'string' ? pending : undefined
  } catch {
    return undefined
  }
}

const setCookie = (reply: FastifyReply, name: string, value: string, maxAge: number, secure: boolean) =>
  reply.setCookie(name, value, { path: '/', httpOnly: true, sameSite: 'lax', maxAge, secure })


export async function signInRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, options, secure, isLocal, login, isAdmin, mayManageGitHub, signInSpace, fail, callback } = context
  /**
   * A newer commit the server's updater (deploy/update.sh) didn't put in, because its tests failed: what it wrote for
   * us, the commit, when, its subject and how the tests ended. Not the one running (a later run put it in after all).
   */
  const updateFailed = async () => {
    const text = await readFile(options.updateFailedFile ?? resolve('.data/update-failed.txt'), 'utf8').catch(() => '')
    const [commit, at, subject, ...log] = text.split('\n')
    if (!/^[0-9a-f]{7,40}$/.test(commit ?? '') || commit === process.env.BINDERS_COMMIT) return undefined
    return { commit, at, subject, log: log.join('\n').trim().slice(-6000) }
  }

  // Signing in ------------------------------------------------------------------------------------------------------

  app.get('/auth/options', async () => ({ github: !!auth.oauthLogin() || !!auth.options.github(), dev: auth.options.devLogin() }))


  // A one-time link the hub prints when nobody can sign in yet, for setting it up.
  app.get('/auth/setup', signInLimit, async (request, reply) => {
    try {
      const user = await auth.useSetupCode(String((request.query as { code?: string }).code ?? ''))
      const session = await auth.startSession(user)
      setCookie(reply, sessionCookie, session.id, session.maxAge, secure)
      return reply.redirect('/#/settings')
    } catch (error) {
      return reply.code(403).type('text/html').send(`<p>${(error as Error).message.replace(/</g, '&lt;')}</p>`)
    }
  })

  // Signing in goes through the hub's OAuth App when it has one; connecting someone's GitHub (or signing in on a hub
  // without one) through a Binder's GitHub App.
  const startGitHub = (reply: FastifyReply, named?: string, connect: false | 'app' | 'personal' | 'connect' = false, own?: GitHubLogin, back?: 'account') => {
    const via = connect || auth.signInVia()
    const space = via === 'connect' ? (named && spaces.info(named) && !spaces.info(named)?.personal ? named : undefined)
      : via !== 'app' ? (named && spaces.info(named) ? named : spaces.list().find((s) => !s.personal)?.id) : signInSpace(named)
    if (!space) throw new Refusal('Signing in with GitHub isn’t set up on this hub.')
    const { url, state } = auth.githubStart(callback, space, via, own)
    setCookie(reply, 'binders_oauth', `${state}.${space}.${via}${back ? `.${back}` : ''}`, 600, secure)
    return url
  }

  // Signing in, or connecting your GitHub to a Binder's GitHub App (?connect=1, ?space=). Connecting from your account
  // page (?back=account) comes back there rather than to the binder's Settings.
  app.get('/auth/github', signInLimit, async (request, reply) => {
    try {
      const query = request.query as { space?: string; connect?: string; personal?: string; back?: string }
      // Their own GitHub, for their personal binder, goes through their own OAuth App, set in that binder.
      let own: GitHubLogin | undefined
      if (query.personal === '1') {
        const session = await auth.session(request.cookies[sessionCookie])
        if (!session) throw new Refusal('Sign in to the hub first, then connect your GitHub.')
        own = await auth.personalOAuth(session.user.login, isAdmin(session.user.login))
        if (!own) throw new Refusal('Set up your OAuth App first, in your personal binder’s Settings → GitHub.')
      }
      const url = startGitHub(reply, query.personal === '1' ? undefined : query.space, query.personal === '1' ? 'personal' : query.connect === '1' ? 'connect' : false, own, query.back === 'account' ? 'account' : undefined)
      // Signing in to the web app: not coming back to an app that started and gave up.
      setCookie(reply, appCookie, '', 0, secure)
      return reply.redirect(url)
    } catch (error) {
      return fail(reply, error)
    }
  })

  // An app signing someone in: it opens this in the browser with a state of its own and its name. Signed in already,
  // they go straight back to the app with a person token; otherwise through GitHub first. The token goes back only to
  // a binders:// link, with the app's state for it to check that it asked.
  app.get('/auth/app', signInLimit, async (request, reply) => {
    const query = request.query as { state?: string; app?: string; redirect?: string }
    const back = appRedirect(query.redirect)
    if (!query.state || !appStatePattern.test(query.state) || !back) return reply.code(400).type('text/html').send('<p>That sign-in link isn’t one an app made: it needs a state and a binders:// address to go back to.</p>')
    const pending: PendingApp = { state: query.state, app: (query.app ?? '').trim().slice(0, 100) || 'An app', redirect: back }
    const session = await auth.session(request.cookies[sessionCookie])
    if (session) return reply.redirect(await handBack(pending, session.user, session.token, session.space))
    try {
      const url = startGitHub(reply)
      setCookie(reply, appCookie, Buffer.from(JSON.stringify(pending)).toString('base64url'), 600, secure)
      return reply.redirect(url)
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      return reply.code(403).type('text/html').send('<p>This hub doesn’t sign in with GitHub. <a href="/">Sign in here</a>, then sign in from the app again.</p>')
    }
  })

  /** Where the app goes back to: its binders:// link with the new token, the app's state, and this hub's address. */
  const handBack = async (pending: PendingApp, user: User, githubToken?: string, space?: string) => {
    const { token } = await auth.issuePersonToken(user, pending.app, githubToken, space)
    const url = new URL(pending.redirect)
    url.searchParams.set('token', token)
    url.searchParams.set('state', pending.state)
    url.searchParams.set('hub', options.publicUrl)
    return url.toString()
  }

  app.get('/auth/github/callback', signInLimit, async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string }
    const [expected, space, via = 'app', back] = (request.cookies.binders_oauth ?? '').split('.')
    const screen = back === 'account' ? 'account' : 'settings'
    if (!code || !state || !space || state !== expected || !['app', 'oauth', 'personal', 'connect'].includes(via)) return reply.code(400).type('text/html').send('<p>That sign-in didn’t come from here. <a href="/">Try again</a>.</p>')
    try {
      // Their own GitHub through their own OAuth App: kept for their personal binder, and they stay who they are.
      if (via === 'personal') {
        const session = await auth.session(request.cookies[sessionCookie])
        const as = session?.user.login
        await auth.githubFinish(code, callback, space, 'personal', as, as ? await auth.personalOAuth(as, isAdmin(as)) : undefined)
        return reply.redirect(`/${personalId(as ?? '')}/#/${screen}`)
      }
      // Connecting a GitHub account to a binder's app, signed in already: kept for them, and they stay who they are.
      if (via === 'connect') {
        const session = await auth.session(request.cookies[sessionCookie])
        await auth.githubFinish(code, callback, space, 'connect', session?.user.login)
        return reply.redirect(`/${space}/#/${screen}`)
      }
      const { user, token, identity } = await auth.githubFinish(code, callback, space, via as 'app' | 'oauth')
      if (via === 'app') await spaces.get(space)?.github.claimMaker(user.login)
      const session = await auth.startSession(user, token, space, identity)
      setCookie(reply, sessionCookie, session.id, session.maxAge, secure)
      // Started by an app: back to it with a token of its own.
      const pending = readPendingApp(request.cookies[appCookie])
      if (pending) {
        setCookie(reply, appCookie, '', 0, secure)
        return reply.redirect(await handBack(pending, user, token, space))
      }
      // Back to the Binder they came from, when they're in it.
      return reply.redirect(spaces.forPerson(user.login, isAdmin(user.login)).some((s) => s.info.id === space) ? `/${space}/` : '/')
    } catch (error) {
      const message = error instanceof Refusal ? error.message : 'GitHub didn’t sign you in.'
      return reply.code(403).type('text/html').send(`<p>${message.replace(/</g, '&lt;')} <a href="/">Back</a></p>`)
    }
  })

  app.post('/auth/dev', signInLimit, async (request, reply) => {
    if (request.headers['x-binders'] !== '1') return reply.code(403).send({ error: 'Missing the web app’s header.' })
    try {
      const user = await auth.devUser(String((request.body as { login?: string })?.login ?? ''))
      const session = await auth.startSession(user)
      setCookie(reply, sessionCookie, session.id, session.maxAge, secure)
      return { user }
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.post('/auth/logout', async (request, reply) => {
    await auth.endSession(request.cookies[sessionCookie])
    setCookie(reply, sessionCookie, '', 0, secure)
    return { ok: true }
  })

  // A person's tokens: which apps are signed in as them, and stopping one. An app signing out revokes its own.
  // Each with the Binder it's registered to: the one whose GitHub App it signed in through. One naming none was signed in
  // before the hub kept one per Binder, and counts as the first Binder's (as the hook above takes it), if they're in it.
  app.get('/api/tokens', async (request) => {
    const login = request.user!.login
    const theirs = new Set(spaces.forPerson(login, isAdmin(login)).map((s) => s.info.id))
    return {
      tokens: (await auth.personTokens(login)).map(({ space, ...t }) => {
        const id = space ?? spaces.list()[0]?.id
        const info = id && (space || theirs.has(id)) ? spaces.info(id) : undefined
        return { ...t, binder: info ? { id: info.id, name: info.name, personal: !!info.personal } : undefined, current: t.id === request.personToken }
      }),
    }
  })
  app.delete('/api/tokens/:id', async (request, reply) => {
    try {
      await auth.revokePersonToken(request.user!.login, (request.params as { id: string }).id)
      return { ok: true }
    } catch (error) {
      if (error instanceof Refusal) return reply.code(404).send({ error: error.message })
      throw error
    }
  })

  // Their own GitHub, for their personal binder's repo, through the hub's OAuth App: taken away here.
  app.delete('/api/me/personal-github', async (request) => {
    await auth.forgetPersonal(login(request))
    return { ok: true }
  })

  app.get('/api/me', async (request) => ({
    user: request.user,
    // Their own GitHub, connected through the hub's OAuth App for their personal binder's repo; and whether it can be.
    ownGitHub: { connected: !!(await auth.personalToken(request.user!.login)), possible: (await auth.personalOAuthStatus(request.user!.login, isAdmin(request.user!.login))).set },
    // This Binder's GitHub.
    github: { ...(request.space?.github.status() ?? { mode: 'none' as const, signIn: false, server: false, webhooks: false }), token: !!request.githubToken, admin: mayManageGitHub(request), local: isLocal, polling: request.space?.poller?.status() },
    hubAdmin: isAdmin(request.user!.login),
    // Which commit the hub runs, and for its admins a newer one that didn't get in because its tests failed.
    version: process.env.BINDERS_COMMIT ? { commit: process.env.BINDERS_COMMIT, subject: process.env.BINDERS_COMMIT_SUBJECT || undefined, repo: process.env.BINDERS_REPO_URL || undefined } : undefined,
    updateFailed: isAdmin(request.user!.login) ? await updateFailed() : undefined,
    publicUrl: options.publicUrl,
    mcpUrl: new URL('/mcp', options.publicUrl).toString(),
    webhookUrl: new URL(request.space?.github.path('hook') ?? '/webhooks/github', options.publicUrl).toString(),
    log: request.space?.hub.log.kind,
    space: request.space?.id,
    role: request.role,
    spaces: spaces.forPerson(request.user!.login, isAdmin(request.user!.login)).map(({ info, role }) => ({ id: info.id, name: info.name, role })),
  }))
}
