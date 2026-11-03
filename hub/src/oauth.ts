import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Auth, User } from './auth.ts'
import { Refusal } from './auth.ts'
import type { KV } from './kv.ts'

// The hub as an OAuth 2.1 authorization server for MCP clients, with GitHub only saying who the person is. The MCP
// spec's clients (Claude Code, Cursor, others) discover this server from a 401, register themselves, open a browser to
// /oauth/authorize, and exchange a code with PKCE for a person token that runs out and renews. No one-time pad to copy,
// and an agent's token being rotated doesn't touch it.

/** A client an MCP app registered, as the hub keeps it. Its secret is kept hashed, as an agent's token is. */
export interface OAuthClient {
  clientId: string
  clientName?: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none' | 'client_secret_post'
  secretHash?: string
  grantTypes: string[]
  responseTypes: string[]
  createdAt: string
}

/** A code waiting to be exchanged: five minutes, once, and only by the client and PKCE challenge it was made for. */
export interface OAuthCode {
  clientId: string
  login: string
  user: User
  /** The Binder the connection is for: the one whose /<binder>/mcp the client reached, or the person's first. */
  space: string
  redirectUri: string
  codeChallenge: string
  resource?: string
  scope: string
  expiresAt: string
}

/** What /oauth/token answers, as the MCP client reads it. */
export interface OAuthTokenAnswer {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** An OAuth error, with the code the client expects (invalid_request, invalid_client, invalid_grant, unsupported_grant_type). */
export class OAuthError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const clientKey = (id: string) => `oauth-client:${id}`
const codeKey = (code: string) => `oauth-code:${sha(code)}`
/** How long a code may be exchanged: short, as it travels through a browser. */
const codeSeconds = 300
/** How long a registration lasts: anyone may make one, so one nobody signs in with goes soon. */
const unusedClientSeconds = 24 * 60 * 60
/** One in use lasts longer than its refresh token, renewed each time it gets a token. */
const usedClientSeconds = 60 * 24 * 60 * 60
/** The scope an MCP connection gets: the whole binder, as the person's own. */
export const mcpScope = 'mcp'

const loopback = (url: URL) => url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
/** Links that open a page, a file or something other than the app that registered: never where a code goes. */
const notAnApp = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:', 'sms:', 'view-source:'])

/** A redirect URI an MCP client may come back to: https anywhere, http only on the machine, or an app's own link (someapp://). */
export function validRedirectUri(uri: string) {
  if (uri.length > 512) return false
  try {
    const url = new URL(uri)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:') return loopback(url)
    return !notAnApp.has(url.protocol)
  } catch {
    return false
  }
}

/** Whether a client registered this redirect URI: exactly, except that a loopback listener takes any free port (RFC 8252). */
export function sameRedirect(registered: string, asked: string) {
  if (registered === asked) return true
  try {
    const a = new URL(registered)
    const b = new URL(asked)
    return loopback(a) && loopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

/** PKCE, S256: the challenge is the verifier's SHA-256 in base64url, as the spec says. */
export function pkceMatches(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const expected = createHash('sha256').update(verifier).digest('base64url')
  return expected.length === challenge.length && timingSafeEqual(Buffer.from(expected), Buffer.from(challenge))
}

/** The hub as an authorization server, for a client's discovery. */
export function authorizationServerMetadata(publicUrl: string) {
  const base = publicUrl.replace(/\/$/, '')
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: [mcpScope],
  }
}

/** The MCP server as a protected resource, for a client's discovery: the binder's /<binder>/mcp, or the hub's /mcp. */
export function protectedResourceMetadata(publicUrl: string, resource?: string) {
  const base = publicUrl.replace(/\/$/, '')
  return {
    resource: resource ?? `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [mcpScope],
    bearer_methods_supported: ['header'],
  }
}

/** The clients an MCP app registers, and the codes it exchanges, kept in the hub's store. */
export class OAuth {
  private kv: KV
  private auth: Auth
  private publicUrl: string

  constructor(kv: KV, auth: Auth, publicUrl: string) {
    this.kv = kv
    this.auth = auth
    this.publicUrl = publicUrl.replace(/\/$/, '')
  }

  /**
   * Registers a client from its dynamic client registration request. Public clients (no secret, PKCE only) are the
   * usual ones; a client that asks for a secret gets one, shown once, kept hashed.
   */
  async register(input: unknown): Promise<{ client: OAuthClient; secret?: string }> {
    const body = (input ?? {}) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown; response_types?: unknown }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && validRedirectUri(u)) : []
    if (!redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'A client needs at least one redirect URI: https, http on this machine, or an app’s own link.')
    if (redirectUris.length > 5) throw new OAuthError('invalid_redirect_uri', 'A client may have at most five redirect URIs.')
    const method = body.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'none'
    const grants = Array.isArray(body.grant_types) ? ['authorization_code', 'refresh_token'].filter((g) => (body.grant_types as unknown[]).includes(g)) : ['authorization_code', 'refresh_token']
    if (!grants.includes('authorization_code')) throw new OAuthError('invalid_client_metadata', 'A client has to take authorization_code.')
    const responses = Array.isArray(body.response_types) ? ['code'].filter((r) => (body.response_types as unknown[]).includes(r)) : ['code']
    if (!responses.includes('code')) throw new OAuthError('invalid_client_metadata', 'A client has to answer with code.')
    const clientId = randomBytes(24).toString('base64url')
    const secret = method === 'client_secret_post' ? randomBytes(32).toString('base64url') : undefined
    const client: OAuthClient = {
      clientId,
      clientName: typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : undefined,
      redirectUris: [...new Set(redirectUris)],
      tokenEndpointAuthMethod: method,
      ...(secret ? { secretHash: sha(secret) } : {}),
      grantTypes: [...new Set(grants)],
      responseTypes: [...new Set(responses)],
      createdAt: new Date().toISOString(),
    }
    await this.kv.set(clientKey(clientId), JSON.stringify(client), unusedClientSeconds)
    return { client, secret }
  }

  async client(clientId: string): Promise<OAuthClient | undefined> {
    if (!clientId) return undefined
    const raw = await this.kv.get(clientKey(clientId))
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as OAuthClient
    } catch {
      return undefined
    }
  }

  /** A client's secret, as the token request sends it (client_secret_post, or HTTP Basic). */
  async clientOk(client: OAuthClient, secret?: string) {
    if (client.tokenEndpointAuthMethod === 'none') return true
    if (!secret || !client.secretHash) return false
    return timingSafeEqual(Buffer.from(sha(secret)), Buffer.from(client.secretHash))
  }

  /** A code for a person who allowed a client: five minutes, once, for that client, redirect and PKCE challenge. */
  async putCode(code: Omit<OAuthCode, 'expiresAt'>): Promise<string> {
    const value = randomBytes(32).toString('base64url')
    const stored: OAuthCode = { ...code, expiresAt: new Date(Date.now() + codeSeconds * 1000).toISOString() }
    await this.kv.set(codeKey(value), JSON.stringify(stored), codeSeconds)
    return value
  }

  /** A code, once: read and gone. */
  async takeCode(value: string): Promise<OAuthCode | undefined> {
    if (!value) return undefined
    const raw = await this.kv.take(codeKey(value))
    if (!raw) return undefined
    try {
      const code = JSON.parse(raw) as OAuthCode
      return Date.parse(code.expiresAt) > Date.now() ? code : undefined
    } catch {
      return undefined
    }
  }

  /** A code or a refresh token, as /oauth/token answers. */
  async token(input: Record<string, string>, basic?: { clientId: string; secret: string }): Promise<OAuthTokenAnswer> {
    const grant = input.grant_type
    const clientId = basic?.clientId || input.client_id || ''
    const client = await this.client(clientId)
    if (!client) throw new OAuthError('invalid_client', 'This hub doesn’t know that client.')
    if (!(await this.clientOk(client, basic?.secret || input.client_secret))) throw new OAuthError('invalid_client', 'That client’s secret isn’t right.')
    if (grant === 'authorization_code') {
      const code = await this.takeCode(input.code ?? '')
      if (!code) throw new OAuthError('invalid_grant', 'That code is unknown, used already, or older than five minutes.')
      if (code.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'That code was made for another client.')
      if (input.redirect_uri && input.redirect_uri !== code.redirectUri) throw new OAuthError('invalid_grant', 'That redirect URI isn’t the one the code was made for.')
      if (!input.code_verifier || !pkceMatches(input.code_verifier, code.codeChallenge)) throw new OAuthError('invalid_grant', 'The code verifier doesn’t match the challenge.')
      const issued = await this.auth.issueOAuthPersonToken(code.user, client.clientName ?? 'An MCP client', client.clientId, code.space, code.scope || mcpScope)
      await this.keep(client)
      return { access_token: issued.token, token_type: 'Bearer', expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: code.scope || mcpScope }
    }
    if (grant === 'refresh_token') {
      if (!input.refresh_token) throw new OAuthError('invalid_request', 'A refresh needs its refresh_token.')
      try {
        const issued = await this.auth.refreshOAuthPersonToken(input.refresh_token, client.clientId)
        await this.keep(client)
        return { access_token: issued.token, token_type: 'Bearer', expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: mcpScope }
      } catch (error) {
        if (error instanceof Refusal) throw new OAuthError('invalid_grant', error.message)
        throw error
      }
    }
    throw new OAuthError('unsupported_grant_type', 'The grant is authorization_code or refresh_token.')
  }

  private async keep(client: OAuthClient) {
    await this.kv.set(clientKey(client.clientId), JSON.stringify(client), usedClientSeconds)
  }

  /** Stops an access or refresh token: what a client asks when it signs out, and what the account page does. */
  async revoke(token: string | undefined) {
    await this.auth.revokeOAuthToken(token)
  }

  /** The resource a client asked for, as this hub knows it: its /mcp, or a binder’s /<binder>/mcp. */
  resourceOk(resource: string | undefined) {
    if (!resource) return true
    try {
      const url = new URL(resource)
      return url.origin === new URL(this.publicUrl).origin && (url.pathname === '/mcp' || /^\/[^/]+\/mcp\/?$/.test(url.pathname))
    } catch {
      return false
    }
  }

  /** The binder a resource names: its path’s first part, for /<binder>/mcp. None for the hub’s /mcp. */
  spaceOf(resource: string | undefined) {
    if (!resource) return undefined
    try {
      const match = /^\/([^/]+)\/mcp\/?$/.exec(new URL(resource).pathname)
      return match?.[1]
    } catch {
      return undefined
    }
  }
}
