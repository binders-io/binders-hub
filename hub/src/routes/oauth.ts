import { sessionCookie, type User } from '../auth.ts'
import { OAuthError, OAuth, authorizationServerMetadata, protectedResourceMetadata, mcpScope, sameRedirect, validRedirectUri, type OAuthClient } from '../oauth.ts'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Context } from './context.ts'

// The hub's OAuth server, for MCP clients: they discover it from a 401, register, sign in through GitHub in a browser,
// and exchange a code for a person token. See hub/src/oauth.ts for the store.

const returnCookie = 'binders_oauth_return'
/** A browser at GitHub and back: plenty for a person, too few to guess with. */
const oauthLimit = { bodyLimit: 16 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
/** Registering needs no sign-in and keeps something, so far fewer: an MCP client does it once. */
const registerLimit = { bodyLimit: 16 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

const setCookie = (reply: FastifyReply, name: string, value: string, maxAge: number, secure: boolean) =>
  reply.setCookie(name, value, { path: '/', httpOnly: true, sameSite: 'lax', maxAge, secure })

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The authorize request's fields, from a query or a form body. */
interface AuthorizeQuery {
  response_type?: string
  client_id?: string
  redirect_uri?: string
  code_challenge?: string
  code_challenge_method?: string
  state?: string
  resource?: string
  scope?: string
  deny?: string
}

/** Where to send a client with an error, when its redirect URI is known to be its own. */
function backTo(reply: FastifyReply, redirect: string, state: string | undefined, error: string, description: string) {
  const url = new URL(redirect)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', description)
  if (state) url.searchParams.set('state', state)
  return reply.redirect(url.toString())
}

/** A plain page for a browser that isn't signed in yet, on a hub that signs in with a name. */
function signInPage(url: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Binders</title></head><body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5"><h1>Sign in to Binders</h1><p>An MCP client is connecting to this hub. Sign in here first, then come back.</p><p><a href="/">Sign in</a> · <a href="${escape(url)}">Continue</a></p></body></html>`
}

/** Where allowing a client sends its code. A client names itself, so this is what says who it is. */
function destination(redirect: string) {
  const url = new URL(redirect)
  if (url.protocol === 'http:') return `<p>Allowing it goes back to a program on this computer (${escape(url.host)}).</p>`
  if (url.protocol !== 'https:') return `<p>Allowing it goes to the app on this computer that opens ${escape(url.protocol)}// links.</p>`
  return `<p style="padding: .75rem 1rem; border: 1px solid #b45309; border-radius: .4rem"><b>Allowing it gives this connection to ${escape(url.host)}</b>, a website. A client chooses its own name, so only allow it if you started this there and you trust that site.</p>`
}

/** The page where a person allows an MCP client, naming it, the binder it will act on, and where it goes. */
/**
 * The page that asks the person to allow a client: for the one Binder its address names, or, at the hub's own /mcp, for
 * the Binders they tick (one ticked already when they're in one alone). `problem` says why it's shown again.
 */
function consentPage(query: AuthorizeQuery, client: OAuthClient, binders: { id: string; name: string }[], user: User, choose: boolean, problem?: string) {
  const hidden = (name: string, value: string | undefined) => (value === undefined ? '' : `<input type="hidden" name="${name}" value="${escape(value)}">`)
  const who = escape(client.clientName ?? 'An MCP client')
  const picking = choose
    ? `<p><b>${who}</b> wants to connect as <b>@${escape(user.login)}</b>. Pick the binders it may work in:</p>
<input type="hidden" name="choosing" value="1">
<fieldset style="border: 1px solid #ddd; border-radius: .4rem; padding: .5rem 1rem; margin: 0">
<legend style="padding: 0 .25rem">Binders</legend>
${binders.map((b, i) => `<label style="display: flex; gap: .5rem; align-items: baseline; padding: .3rem 0"><input type="checkbox" id="binder-${i}" name="binder" value="${escape(b.id)}"${binders.length === 1 ? ' checked' : ''}> <span><b>${escape(b.name)}</b> <span style="color: #666">/${escape(b.id)}</span></span></label>`).join('\n')}
</fieldset>
${problem ? `<p role="alert" style="color: #b42318">${escape(problem)}</p>` : ''}
<p>As you, it can read and write the notes of the binders you pick, make and comment on cards, give cards to agents (which sets them working), and read change sets. Each binder stays apart: it works in one at a time, and moves nothing between them. To change which binders it reaches, connect it again. You can disconnect it from your account page.</p>`
    : `<p><b>${who}</b> wants to connect to <b>${escape(binders[0].name)}</b> as <b>@${escape(user.login)}</b>.</p>
<p>As you, it can read and write this binder's notes, make and comment on cards, give cards to agents (which sets them working), and read change sets. You can disconnect it from your account page.</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Allow · Binders</title></head><body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5">
<h1>Allow ${escape(client.clientName ?? 'an MCP client')}?</h1>
<form method="post" action="/oauth/authorize">
${picking}
${destination(query.redirect_uri!)}
${hidden('response_type', query.response_type)}${hidden('client_id', query.client_id)}${hidden('redirect_uri', query.redirect_uri)}${hidden('code_challenge', query.code_challenge)}${hidden('code_challenge_method', query.code_challenge_method)}${hidden('state', query.state)}${hidden('resource', query.resource)}${hidden('scope', query.scope)}
<div style="display: flex; gap: .75rem; margin-top: 1.5rem">
<button type="submit" style="padding: .6rem 1rem; font: inherit; border-radius: .4rem; border: 1px solid #111; background: #111; color: #fff">Allow</button>
<button type="submit" name="deny" value="1" style="padding: .6rem 1rem; font: inherit; border-radius: .4rem; border: 1px solid #bbb; background: #fff">Cancel</button>
</div>
</form></body></html>`
}

/** The fields a client sent, as a body that may be form-encoded or JSON. */
function fieldsOf(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {}
  return Object.fromEntries(Object.entries(body as Record<string, unknown>).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : typeof value === 'number' ? [[key, String(value)]] : [])))
}

/** A client's HTTP Basic credentials, as OAuth 2.0 lets a confidential client send them. */
function basicAuth(header: string | undefined) {
  const found = /^Basic\s+(.+)$/i.exec(header ?? '')
  if (!found) return undefined
  const [clientId, secret] = Buffer.from(found[1], 'base64').toString('utf8').split(':')
  return clientId && secret ? { clientId, secret } : undefined
}

export async function oauthRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, options, secure, isAdmin } = context
  const publicUrl = options.publicUrl.replace(/\/$/, '')
  const oauth = new OAuth(auth.store, auth, publicUrl)

  // Discovery: the hub as an authorization server, and the MCP server as a protected resource. The resource metadata
  // is also at the path a client derives from its MCP URL (/.well-known/oauth-protected-resource/<binder>/mcp).
  app.get('/.well-known/oauth-authorization-server', oauthLimit, async () => authorizationServerMetadata(publicUrl))
  app.get('/.well-known/oauth-protected-resource', oauthLimit, async () => protectedResourceMetadata(publicUrl))
  app.get('/.well-known/oauth-protected-resource/*', oauthLimit, async (request) => {
    const path = (request.params as { '*': string })['*']
    return protectedResourceMetadata(publicUrl, path ? `${publicUrl}/${path}`.replace(/\/$/, '') : undefined)
  })

  // Dynamic client registration: an MCP client registers itself, as the spec has it.
  app.post('/oauth/register', registerLimit, async (request, reply) => {
    try {
      const { client, secret } = await oauth.register(request.body)
      return reply.code(201).send({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
      })
    } catch (error) {
      if (error instanceof OAuthError) return reply.code(400).send({ error: error.code, error_description: error.message })
      throw error
    }
  })

  /** The authorize request, checked, with the client it names: undefined and a reply when it can't go on. */
  const checked = async (query: AuthorizeQuery, reply: FastifyReply) => {
    const client = await oauth.client(query.client_id ?? '')
    if (!client) return { reply: reply.code(400).type('text/html').send('<p>That MCP client isn’t registered on this hub. A registration nobody uses runs out: remove this connection from the client and add it again.</p>') }
    const redirect = query.redirect_uri ?? ''
    if (!validRedirectUri(redirect) || !client.redirectUris.some((registered) => sameRedirect(registered, redirect))) return { reply: reply.code(400).type('text/html').send('<p>That client asked to come back somewhere it didn’t register.</p>') }
    const state = query.state
    if (query.response_type !== 'code') return { reply: backTo(reply, redirect, state, 'unsupported_response_type', 'Only the authorization code flow is here.') }
    if (query.code_challenge_method !== 'S256' || !query.code_challenge || !/^[A-Za-z0-9\-._~]{43}$/.test(query.code_challenge)) return { reply: backTo(reply, redirect, state, 'invalid_request', 'The client needs a PKCE S256 challenge.') }
    if (!oauth.resourceOk(query.resource)) return { reply: backTo(reply, redirect, state, 'invalid_target', 'That resource isn’t this hub.') }
    return { client }
  }

  /**
   * The Binders a connection may be for: the one its resource names, when the person is in it; at the hub's own /mcp,
   * any of theirs, for them to pick (choose).
   */
  const bindersFor = (login: string, query: AuthorizeQuery) => {
    const mine = spaces.forPerson(login, isAdmin(login))
    const named = oauth.spaceOf(query.resource)
    if (named) return { choose: false, binders: mine.filter((s) => s.info.id === named).map((s) => s.info) }
    return { choose: true, binders: mine.map((s) => s.info) }
  }
  const notIn = (reply: FastifyReply, login: string, query: AuthorizeQuery) => reply.code(403).type('text/html').send(`<p>@${escape(login)} ${query.resource && oauth.spaceOf(query.resource) ? 'isn’t in that binder' : 'isn’t in a binder on this hub yet'}.</p>`)

  // The browser half: sign in (through GitHub, or by name on a hub on this machine), then allow the client.
  app.get('/oauth/authorize', oauthLimit, async (request, reply) => {
    const query = request.query as AuthorizeQuery
    const check = await checked(query, reply)
    if (!check.client) return check.reply
    const session = await auth.session(request.cookies[sessionCookie])
    if (!session) {
      // GitHub: back here after signing in, through a cookie this browser keeps. Without GitHub, sign in here first.
      if (auth.oauthLogin() || auth.options.github()) {
        const here = new URL(request.url, publicUrl).toString()
        setCookie(reply, returnCookie, Buffer.from(here).toString('base64url'), 600, secure)
        return reply.redirect('/auth/github')
      }
      return reply.type('text/html').send(signInPage(new URL(request.url, publicUrl).toString()))
    }
    const { choose, binders } = bindersFor(session.user.login, query)
    if (!binders.length) return notIn(reply, session.user.login, query)
    return reply.type('text/html').send(consentPage(query, check.client, binders, session.user, choose))
  })

  app.post('/oauth/authorize', oauthLimit, async (request, reply) => {
    const query = fieldsOf(request.body) as AuthorizeQuery
    const check = await checked(query, reply)
    if (!check.client) return check.reply
    const redirect = query.redirect_uri!
    if (query.deny) return backTo(reply, redirect, query.state, 'access_denied', 'The person didn’t allow it.')
    const session = await auth.session(request.cookies[sessionCookie])
    if (!session) return reply.code(400).type('text/html').send('<p>That permission form came from a browser that isn’t signed in. <a href="/">Sign in</a>, then connect again.</p>')
    const { choose, binders } = bindersFor(session.user.login, query)
    if (!binders.length) return notIn(reply, session.user.login, query)
    // Those ticked, of theirs. The page's own form says it offered the choice, and then nothing ticked is nothing
    // allowed; one sent without it (from before there was a choice), by someone in one Binder alone, is for that one.
    const sent = request.body as { binder?: unknown; choosing?: unknown } | undefined
    const ticked = sent?.binder
    const asked = (Array.isArray(ticked) ? ticked : ticked === undefined ? [] : [ticked]).filter((b): b is string => typeof b === 'string')
    const picked = !choose ? binders : asked.length ? binders.filter((b) => asked.includes(b.id)) : !sent?.choosing && binders.length === 1 ? binders : []
    if (!picked.length || (choose && asked.length > 0 && picked.length !== new Set(asked).size)) return reply.code(400).type('text/html').send(consentPage(query, check.client, binders, session.user, choose, asked.length ? 'You aren’t in one of those binders.' : 'Pick at least one binder.'))
    const code = await oauth.putCode({
      clientId: check.client.clientId,
      login: session.user.login,
      user: session.user,
      space: picked[0].id,
      ...(picked.length > 1 ? { spaces: picked.map((b) => b.id) } : {}),
      redirectUri: redirect,
      codeChallenge: query.code_challenge!,
      resource: query.resource,
      scope: mcpScope,
    })
    const url = new URL(redirect)
    url.searchParams.set('code', code)
    if (query.state) url.searchParams.set('state', query.state)
    return reply.redirect(url.toString())
  })

  // The client half: a code for tokens, or a refresh token for new ones.
  app.post('/oauth/token', oauthLimit, async (request, reply) => {
    const input = fieldsOf(request.body)
    try {
      const answer = await oauth.token(input, basicAuth(request.headers.authorization))
      return reply.header('cache-control', 'no-store').send(answer)
    } catch (error) {
      if (error instanceof OAuthError) return reply.code(error.code === 'invalid_client' ? 401 : 400).send({ error: error.code, error_description: error.message })
      throw error
    }
  })

  // Signing out: the client revokes its token, as the account page does.
  app.post('/oauth/revoke', oauthLimit, async (request) => {
    const input = fieldsOf(request.body)
    await oauth.revoke(input.token)
    return { ok: true }
  })
}
