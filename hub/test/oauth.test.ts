import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { createServer } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { Spaces } from '../src/spaces.ts'
import { note } from './helpers.ts'

// A person's MCP connection: an MCP client registers itself, the person allows it in the browser, and it gets a person
// token that runs out and renews. No agent's one-time pad, so replacing an agent's token doesn't break it.

async function setUp() {
  const hub = new Hub(new MemoryLog())
  // As a real hub has it: the Binder's address is its space's, and its log's one binder is "main".
  await hub.start([
    { type: 'binder.put', binder: { id: 'main', name: 'Mobile app' } },
    { type: 'folder.put', folder: { id: 'f1', binderId: 'main', name: 'Planning' } },
    { type: 'note.put', note: note('n1', 'First note', { binderId: 'main' }) },
  ])
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const issues = new IssuesSaver(hub, github, { quietMs: 20 })
  issues.start()
  const webhooks = new Webhooks(hub, actions, issues)
  const spaces = Spaces.of(kv, [
    { info: { id: 'mobile-app', name: 'Mobile app', members: [] }, space: { id: 'mobile-app', hub, actions, webhooks, github, issues } },
    { info: { id: 'other', name: 'Other', members: [{ login: 'ana', role: 'member' }] }, space: { id: 'other', hub, actions, webhooks, github, issues } },
  ])
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['ana'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { hub, app, url, close: async () => { await issues.stop(); await app.close() } }
}

async function signIn(url: string, login = 'you') {
  const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
  assert.equal(response.status, 200)
  return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
}

const json = (response: Response) => response.json() as Promise<any>

function api(url: string, cookie: string) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

async function mcpCall(url: string, token: string, name: string, args: Record<string, unknown> = {}, path = '/mcp') {
  const client = new Client({ name: 'test-terminal', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}${path}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = result.content[0]?.text ?? ''
    let value: unknown = text
    try {
      value = JSON.parse(text)
    } catch {
      // Words, not JSON.
    }
    return { error: !!result.isError, text, value }
  } finally {
    await client.close()
  }
}

async function mcpStatus(url: string, token?: string, path = '/mcp') {
  const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) })
  return { status: response.status, auth: response.headers.get('www-authenticate') }
}

describe('OAuth for MCP', () => {
  it('registers a client, allows it, and gives it a person token that works on MCP', async () => {
    const set = await setUp()
    try {
      const cookie = await signIn(set.url)
      const me = await api(set.url, cookie)('GET', '/api/me')
      assert.equal(me.body.space, 'mobile-app')

      const metadata = await fetch(`${set.url}/.well-known/oauth-authorization-server`).then(json)
      assert.equal(metadata.issuer, 'http://hub.test')
      assert.equal(metadata.authorization_endpoint, 'http://hub.test/oauth/authorize')
      const resource = await fetch(`${set.url}/.well-known/oauth-protected-resource/mobile-app/mcp`).then(json)
      assert.equal(resource.resource, 'http://hub.test/mobile-app/mcp')
      assert.deepEqual(resource.authorization_servers, ['http://hub.test'])

      const registered = await fetch(`${set.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test terminal', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' }) }).then(json)
      assert.ok(registered.client_id)

      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: registered.client_id,
        redirect_uri: 'http://localhost:9999/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'state-123',
        resource: 'http://hub.test/mobile-app/mcp',
        scope: 'mcp',
      })

      const consent = await fetch(`${set.url}/oauth/authorize?${params}`, { headers: { cookie } })
      assert.equal(consent.status, 200)
      assert.match(await consent.text(), /Allow Test terminal/)

      const allowed = await fetch(`${set.url}/oauth/authorize`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' })
      assert.equal(allowed.status, 302)
      const back = new URL(allowed.headers.get('location')!)
      assert.equal(back.searchParams.get('state'), 'state-123')
      const code = back.searchParams.get('code')!

      const tokens = await fetch(`${set.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: registered.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier }).toString() }).then(json)
      assert.ok(tokens.access_token.startsWith('bnp_'))
      assert.ok(tokens.refresh_token.startsWith('bnr_'))

      const who = await mcpCall(set.url, tokens.access_token, 'whoami')
      assert.equal(who.error, false)
      assert.equal((who.value as { login: string }).login, 'you')
      assert.deepEqual((who.value as { binder: { id: string } }).binder.id, 'main')

      const made = await mcpCall(set.url, tokens.access_token, 'create_note', { binder: 'main', text: '# From the terminal\n' })
      assert.equal(made.error, false, made.text)
      const note = await mcpCall(set.url, tokens.access_token, 'get_note', { id: (made.value as { id: string }).id })
      assert.equal(note.error, false)
      assert.match((note.value as { text: string }).text, /From the terminal/)
      assert.deepEqual(set.hub.state.notes.find((n) => n.id === (made.value as { id: string }).id)?.editors, ['you'])

      // The binder's own address works too, and says which binder it is.
      const byBinder = await mcpCall(set.url, tokens.access_token, 'whoami', {}, '/mobile-app/mcp')
      assert.equal((byBinder.value as { binder: { id: string } }).binder.id, 'main')
    } finally {
      await set.close()
    }
  })

  it('renews its token, and an agent’s token being replaced doesn’t touch it', async () => {
    const set = await setUp()
    try {
      const cookie = await signIn(set.url)
      const registered = await fetch(`${set.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test terminal', redirect_uris: ['http://localhost:9999/cb'] }) }).then(json)
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const params = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: 'http://hub.test/mobile-app/mcp' })
      const allowed = await fetch(`${set.url}/oauth/authorize`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' })
      const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!
      const tokens = await fetch(`${set.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: registered.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier }).toString() }).then(json)

      // An agent is set up and its token replaced: the person's connection is a person token, so it stands.
      const agent = await api(set.url, cookie)('POST', '/api/agents', { name: 'Reviewer' })
      assert.equal(agent.status, 200)
      await api(set.url, cookie)('POST', `/api/agents/${agent.body.agent.id}/token`)
      const still = await mcpCall(set.url, tokens.access_token, 'whoami')
      assert.equal(still.error, false)

      // A refresh rotates both: the old access token stops, the new one works.
      const renewed = await fetch(`${set.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registered.client_id }).toString() }).then(json)
      assert.ok(renewed.access_token && renewed.access_token !== tokens.access_token)
      assert.equal((await mcpStatus(set.url, tokens.access_token)).status, 401)
      assert.equal((await mcpStatus(set.url, renewed.access_token)).status, 200)

      // The client's sign-out stops it, and the old refresh token is gone with it.
      await fetch(`${set.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: renewed.access_token }).toString() })
      assert.equal((await mcpStatus(set.url, renewed.access_token)).status, 401)
      const again = await fetch(`${set.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: renewed.refresh_token, client_id: registered.client_id }).toString() })
      assert.equal(again.status, 400)
    } finally {
      await set.close()
    }
  })

  it('gives a person a token for a client that can’t sign in, and it lasts until they stop it', async () => {
    const set = await setUp()
    try {
      const cookie = await signIn(set.url)
      const made = await api(set.url, cookie)('POST', '/api/tokens', { app: 'A terminal' })
      assert.equal(made.status, 200)
      assert.ok(made.body.token.startsWith('bnp_'))

      const who = await mcpCall(set.url, made.body.token, 'whoami')
      assert.equal(who.error, false)
      assert.equal((who.value as { login: string }).login, 'you')
      const listed = await api(set.url, cookie)('GET', '/api/tokens')
      assert.ok(listed.body.tokens.some((t: { kind?: string }) => t.kind === 'mcp'))

      // A person's token, not an agent's: replacing an agent's token doesn't touch it.
      const agent = await api(set.url, cookie)('POST', '/api/agents', { name: 'Reviewer' })
      await api(set.url, cookie)('POST', `/api/agents/${agent.body.agent.id}/token`)
      assert.equal((await mcpCall(set.url, made.body.token, 'whoami')).error, false)

      // Stopping it here stops it on MCP.
      await api(set.url, cookie)('DELETE', `/api/tokens/${made.body.id}`)
      assert.equal((await mcpStatus(set.url, made.body.token)).status, 403)
    } finally {
      await set.close()
    }
  })

  it('refuses a binder the person isn’t in', async () => {
    const set = await setUp()
    try {
      const cookie = await signIn(set.url)
      const registered = await fetch(`${set.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test terminal', redirect_uris: ['http://localhost:9999/cb'] }) }).then(json)
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const params = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: 'http://hub.test/other/mcp' })
      const consent = await fetch(`${set.url}/oauth/authorize?${params}`, { headers: { cookie } })
      assert.equal(consent.status, 403)
      assert.match(await consent.text(), /isn’t in that binder/)
    } finally {
      await set.close()
    }
  })

  it('tells an unauthenticated client where to sign in, and refuses a wrong PKCE verifier', async () => {
    const set = await setUp()
    try {
      const refused = await mcpStatus(set.url)
      assert.equal(refused.status, 401)
      assert.match(refused.auth ?? '', /resource_metadata="http:\/\/hub\.test\/\.well-known\/oauth-protected-resource"/)

      const byBinder = await mcpStatus(set.url, undefined, '/mobile-app/mcp')
      assert.match(byBinder.auth ?? '', /resource_metadata="http:\/\/hub\.test\/\.well-known\/oauth-protected-resource\/mobile-app\/mcp"/)

      const cookie = await signIn(set.url)
      const registered = await fetch(`${set.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test terminal', redirect_uris: ['http://localhost:9999/cb'] }) }).then(json)
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const params = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: 'http://hub.test/mobile-app/mcp' })
      const allowed = await fetch(`${set.url}/oauth/authorize`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' })
      const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!
      const wrong = await fetch(`${set.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: registered.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: randomBytes(32).toString('base64url') }).toString() })
      assert.equal(wrong.status, 400)
      assert.equal((await json(wrong)).error, 'invalid_grant')
    } finally {
      await set.close()
    }
  })
})

// Each binder with a hub of its own, as a real hub has them: every one's log calls its binder "main".
async function setUpBinders(port?: number) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const savers: IssuesSaver[] = []
  const binder = async (id: string, name: string, logins: string[]) => {
    const hub = new Hub(new MemoryLog())
    await hub.start([{ type: 'binder.put', binder: { id: 'main', name } }])
    const actions = new Actions(hub, github)
    const issues = new IssuesSaver(hub, github, { quietMs: 20 })
    issues.start()
    savers.push(issues)
    return { info: { id, name, members: logins.map((login) => ({ login, role: 'member' as const })) }, space: { id, hub, actions, webhooks: new Webhooks(hub, actions, issues), github, issues } }
  }
  const a = await binder('team-a', 'Team A', ['you', 'ana'])
  const b = await binder('team-b', 'Team B', ['you'])
  const c = await binder('team-c', 'Team C', ['ana'])
  const spaces = Spaces.of(kv, [a, b, c])
  const app = await buildServer(spaces, { auth }, { publicUrl: port ? `http://127.0.0.1:${port}` : 'http://hub.test', admins: ['ana'] })
  await app.listen({ port: port ?? 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const cookie = await signIn(url)
  return { a, b, c, auth, kv, spaces, url, cookie, close: async () => { await Promise.all(savers.map((s) => s.stop())); await app.close() } }
}

const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const register = (url: string, body: unknown) => fetch(`${url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Connects a client to a binder, as far as its code: register, allow, and what's left to exchange. */
async function allow(url: string, cookie: string, space: string, redirect = 'http://localhost:9999/cb') {
  const client = await register(url, { client_name: 'Test terminal', redirect_uris: [redirect] }).then(json)
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const allowed = await fetch(`${url}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `http://hub.test/${space}/mcp` }).toString() })
  return { client, verifier, code: new URL(allowed.headers.get('location')!).searchParams.get('code')! }
}

async function connect(url: string, cookie: string, space: string) {
  const { client, verifier, code } = await allow(url, cookie, space)
  const tokens = await fetch(`${url}/oauth/token`, form({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier })).then(json)
  return { clientId: client.client_id as string, access: tokens.access_token as string, refresh: tokens.refresh_token as string }
}

const renew = (url: string, clientId: string, refresh: string) => fetch(`${url}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }))

/** Runs something as if later than it is. */
async function later<T>(ms: number, work: () => Promise<T>) {
  const real = Date.now
  Date.now = () => real() + ms
  try {
    return await work()
  } finally {
    Date.now = real
  }
}

describe('OAuth for MCP, with the MCP SDK’s own client', () => {
  it('goes from a 401 to a tool call, and renews', async () => {
    const free = createServer()
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve))
    const port = (free.address() as AddressInfo).port
    await new Promise((resolve) => free.close(resolve))
    const set = await setUpBinders(port)
    try {
      const server = new URL(`${set.url}/team-a/mcp`)
      let sentTo: URL | undefined
      let verifier = ''
      let info: unknown
      let tokens: { access_token: string; refresh_token?: string; token_type: string } | undefined
      const provider = {
        redirectUrl: 'http://localhost:9999/cb',
        clientMetadata: { client_name: 'SDK terminal', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
        clientInformation: () => info,
        saveClientInformation: (value: unknown) => { info = value },
        tokens: () => tokens,
        saveTokens: (value: typeof tokens) => { tokens = value },
        redirectToAuthorization: (url: URL) => { sentTo = url },
        saveCodeVerifier: (value: string) => { verifier = value },
        codeVerifier: () => verifier,
      } as unknown as OAuthClientProvider

      // Unsigned in: the 401 sends it through discovery and registration, to the browser.
      const first = new StreamableHTTPClientTransport(server, { authProvider: provider })
      await assert.rejects(new Client({ name: 'sdk', version: '1.0.0' }).connect(first), UnauthorizedError)
      assert.equal(sentTo?.pathname, '/oauth/authorize')
      assert.equal(sentTo?.searchParams.get('resource'), server.toString())

      // The person allows it, in the browser.
      const consent = await fetch(new URL(`${sentTo!.pathname}${sentTo!.search}`, set.url), { headers: { cookie: set.cookie } })
      assert.match(await consent.text(), /Allow SDK terminal/)
      const allowed = await fetch(`${set.url}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie: set.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: sentTo!.searchParams.toString() })
      await first.finishAuth(new URL(allowed.headers.get('location')!).searchParams.get('code')!)
      assert.ok(tokens?.access_token.startsWith('bnp_'))

      const call = async () => {
        const client = new Client({ name: 'sdk', version: '1.0.0' })
        await client.connect(new StreamableHTTPClientTransport(server, { authProvider: provider }))
        const result = (await client.callTool({ name: 'whoami', arguments: {} })) as { content: { text: string }[] }
        await client.close()
        return JSON.parse(result.content[0].text) as { binder: { name: string } }
      }
      assert.equal((await call()).binder.name, 'Team A')

      // Its access token gone: the SDK renews by itself, on the next 401.
      const before = tokens!.access_token
      tokens = { ...tokens!, access_token: 'bnp_no-longer-any-good' }
      assert.equal((await call()).binder.name, 'Team A')
      assert.notEqual(tokens!.access_token, before)
      assert.ok(tokens!.access_token.startsWith('bnp_') && tokens!.access_token !== 'bnp_no-longer-any-good')
    } finally {
      await set.close()
    }
  })
})

describe('OAuth for MCP, kept to what was allowed', () => {
  it('keeps a connection to the one binder it was allowed for', async () => {
    const set = await setUpBinders()
    try {
      const { access } = await connect(set.url, set.cookie, 'team-a')
      assert.equal((await mcpCall(set.url, access, 'whoami', {}, '/team-a/mcp')).error, false)
      assert.equal(((await mcpCall(set.url, access, 'whoami')).value as { binder: { name: string } }).binder.name, 'Team A')
      // Another binder they're in, and one they're not: refused, not moved to one they are.
      assert.equal((await mcpStatus(set.url, access, '/team-b/mcp')).status, 403)
      assert.equal((await mcpStatus(set.url, access, '/team-c/mcp')).status, 403)
    } finally {
      await set.close()
    }
  })

  it('stops a connection when its person leaves the binder, and never writes in another', async () => {
    const set = await setUpBinders()
    try {
      const { access } = await connect(set.url, set.cookie, 'team-a')
      set.a.info.members.splice(0, set.a.info.members.length, { login: 'ana', role: 'member' })
      assert.equal((await mcpStatus(set.url, access, '/team-a/mcp')).status, 403)
      assert.equal((await mcpStatus(set.url, access)).status, 403)
      assert.equal(set.b.space.hub.state.notes.length, 0)
    } finally {
      await set.close()
    }
  })

  it('takes an MCP token on MCP only, and it can’t make itself a longer-lasting one', async () => {
    const set = await setUpBinders()
    try {
      const { access } = await connect(set.url, set.cookie, 'team-a')
      const bearer = { authorization: `Bearer ${access}` }
      assert.equal((await fetch(`${set.url}/api/me`, { headers: bearer })).status, 403)
      assert.equal((await fetch(`${set.url}/api/spaces`, { headers: bearer })).status, 403)
      assert.equal((await fetch(`${set.url}/api/tokens`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' })).status, 403)

      // The same for one made on the account page; it goes by the binder the page is for, and holds no GitHub token.
      const made = await fetch(`${set.url}/api/tokens`, { method: 'POST', headers: { cookie: set.cookie, 'x-binders': '1', 'x-binders-space': 'team-b', 'content-type': 'application/json' }, body: '{"app":"A terminal"}' }).then(json)
      assert.equal((await fetch(`${set.url}/api/me`, { headers: { authorization: `Bearer ${made.token}` } })).status, 403)
      assert.equal(((await mcpCall(set.url, made.token, 'whoami')).value as { binder: { name: string } }).binder.name, 'Team B')
      assert.equal((await set.auth.personFor(made.token))?.token, undefined)
      assert.equal((await mcpStatus(set.url, made.token, '/team-a/mcp')).status, 403)
    } finally {
      await set.close()
    }
  })

  it('never sends a token set by hand to sign in, which it would ignore, again and again', async () => {
    const set = await setUpBinders()
    try {
      const cookie = await signIn(set.url)
      const agent = await api(set.url, cookie)('POST', '/api/agents', { name: 'Reviewer' })
      const first = await api(set.url, cookie)('POST', `/api/agents/${agent.body.agent.id}/token`)
      await api(set.url, cookie)('POST', `/api/agents/${agent.body.agent.id}/token`)
      const made = await api(set.url, cookie)('POST', '/api/tokens', { app: 'A tool' })
      await api(set.url, cookie)('DELETE', `/api/tokens/${made.body.id}`)
      for (const dead of [first.body.token, 'bnd_nothingmadethis', made.body.token]) {
        const answer = await mcpStatus(set.url, dead)
        assert.equal(answer.status, 403)
        assert.equal(answer.auth, null, 'nothing points it at the sign-in')
      }
      // Signing in is still the way for no token, and for one that ran out or that nothing made by hand.
      for (const none of [undefined, 'bnp_madeup']) {
        const answer = await mcpStatus(set.url, none)
        assert.equal(answer.status, 401)
        assert.match(answer.auth ?? '', /resource_metadata/)
      }
    } finally {
      await set.close()
    }
  })

  it('leaves an app’s token on /api: it isn’t a connection, and it makes no tokens', async () => {
    const set = await setUpBinders()
    try {
      const { token } = await set.auth.issuePersonToken({ login: 'you', name: 'You' }, 'An app')
      const bearer = { authorization: `Bearer ${token}` }
      assert.equal((await fetch(`${set.url}/api/me`, { headers: bearer })).status, 200)
      assert.equal((await mcpStatus(set.url, token)).status, 403)
      assert.equal((await fetch(`${set.url}/api/tokens`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' })).status, 403)
    } finally {
      await set.close()
    }
  })

  it('keeps what anyone can register small, few and short-lived', async () => {
    const set = await setUpBinders()
    try {
      assert.equal((await register(set.url, { redirect_uris: [`https://x.example/${'a'.repeat(32 * 1024)}`] })).status, 413)
      assert.equal((await register(set.url, { redirect_uris: [`https://x.example/${'a'.repeat(600)}`] })).status, 400)
      const odd = await register(set.url, { redirect_uris: ['https://x.example/cb'], grant_types: ['authorization_code', 'x'.repeat(5000)], response_types: ['code', 'y'.repeat(5000)] }).then(json)
      assert.deepEqual(odd.grant_types, ['authorization_code'])
      assert.deepEqual(odd.response_types, ['code'])

      // Nobody signed in with it: gone after a day. Signed in with: still there, and its refresh token still renews.
      const url = `http://localhost:9999/cb`
      const challenge = 'a'.repeat(43)
      const page = (id: string) => fetch(`${set.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: url, code_challenge: challenge, code_challenge_method: 'S256' })}`, { headers: { cookie: set.cookie } })
      const unused = await register(set.url, { redirect_uris: [url] }).then(json)
      const used = await connect(set.url, set.cookie, 'team-a')
      const twoDays = 2 * 24 * 60 * 60 * 1000
      await later(twoDays, async () => {
        const session = await signIn(set.url)
        const gone = await fetch(`${set.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: unused.client_id, redirect_uri: url, code_challenge: challenge, code_challenge_method: 'S256' })}`, { headers: { cookie: session } })
        assert.equal(gone.status, 400)
        assert.match(await gone.text(), /add it again/)
        assert.equal((await renew(set.url, used.clientId, used.refresh)).status, 200)
      })
      assert.equal((await page(used.clientId)).status, 200)

      // Few: ten a minute from one address.
      let limited = 0
      for (let i = 0; i < 12; i++) if ((await register(set.url, { redirect_uris: [url] })).status === 429) limited++
      assert.ok(limited > 0)
    } finally {
      await set.close()
    }
  })

  it('says on the consent page where a client’s code goes', async () => {
    const set = await setUpBinders()
    try {
      const shown = async (redirect: string) => {
        const client = await register(set.url, { client_name: 'A Trusted Terminal', redirect_uris: [redirect] }).then(json)
        const page = await fetch(`${set.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'http://hub.test/team-a/mcp' })}`, { headers: { cookie: set.cookie } }).then((r) => r.text())
        return page.replace(/<input type="hidden"[^>]*>/g, '')
      }
      const website = await shown('https://site.example/cb')
      assert.match(website, /gives this connection to site\.example/)
      assert.match(website, /give cards to agents/)
      assert.match(await shown('http://localhost:9999/cb'), /a program on this computer \(localhost:9999\)/)
      assert.match(await shown('someapp://mcp/oauth/callback'), /opens someapp:\/\/ links/)
    } finally {
      await set.close()
    }
  })

  it('keeps a connection’s id through renewals, so Disconnect still stops it', async () => {
    const set = await setUpBinders()
    try {
      const first = await connect(set.url, set.cookie, 'team-a')
      const listed = () => api(set.url, set.cookie)('GET', '/api/tokens').then((r) => r.body.tokens as { id: string; at: string; kind: string }[])
      const before = (await listed()).filter((t) => t.kind === 'mcp')
      assert.equal(before.length, 1)
      const renewed = await renew(set.url, first.clientId, first.refresh).then(json)
      const after = (await listed()).filter((t) => t.kind === 'mcp')
      assert.deepEqual(after.map((t) => [t.id, t.at]), before.map((t) => [t.id, t.at]))

      assert.equal((await api(set.url, set.cookie)('DELETE', `/api/tokens/${before[0].id}`)).status, 200)
      assert.equal((await mcpStatus(set.url, renewed.access_token)).status, 401)
      assert.equal((await renew(set.url, first.clientId, renewed.refresh_token)).status, 400)
    } finally {
      await set.close()
    }
  })

  it('gives copies of a client renewing together the same tokens, so none of them has to ask its person again', async () => {
    const set = await setUpBinders()
    try {
      const first = await connect(set.url, set.cookie, 'team-a')
      // Their hour is up, and they all renew at once, or one after another within the minute.
      const together = await Promise.all([1, 2, 3].map(() => renew(set.url, first.clientId, first.refresh)))
      assert.deepEqual(together.map((r) => r.status), [200, 200, 200])
      const answers = await Promise.all(together.map(json))
      assert.equal(new Set(answers.map((a) => a.access_token)).size, 1)
      assert.equal(new Set(answers.map((a) => a.refresh_token)).size, 1)
      const newest = await later(30_000, () => renew(set.url, first.clientId, first.refresh)).then(json)
      assert.equal(newest.refresh_token, answers[0].refresh_token)
      assert.equal((await mcpStatus(set.url, newest.access_token)).status, 200)

      // One connection on the account page, as ever.
      const me = await api(set.url, set.cookie)('GET', '/api/tokens')
      assert.equal((me.body as { tokens: { kind?: string }[] }).tokens.filter((t) => t.kind === 'mcp').length, 1)

      // Its next renewal carries on from there.
      const next = await renew(set.url, first.clientId, newest.refresh_token).then(json)
      assert.equal((await mcpStatus(set.url, next.access_token)).status, 200)
    } finally {
      await set.close()
    }
  })

  it('refuses a refresh token long used, and the connection stands', async () => {
    const set = await setUpBinders()
    try {
      const first = await connect(set.url, set.cookie, 'team-a')
      const newest = await renew(set.url, first.clientId, first.refresh).then(json)
      const stale = await later(61_000, () => renew(set.url, first.clientId, first.refresh))
      assert.equal(stale.status, 400)
      assert.equal((await json(stale)).error, 'invalid_grant')
      assert.equal((await mcpStatus(set.url, newest.access_token)).status, 200)
      assert.equal((await renew(set.url, first.clientId, newest.refresh_token)).status, 200)
    } finally {
      await set.close()
    }
  })

  it('never gives a renewal to another client, and stops the connection if one tries', async () => {
    const set = await setUpBinders()
    try {
      const stranger = await register(set.url, { redirect_uris: ['http://localhost:9999/cb'] }).then(json)
      const unused = await connect(set.url, set.cookie, 'team-a')
      assert.equal((await renew(set.url, stranger.client_id, unused.refresh)).status, 400)
      assert.equal((await mcpStatus(set.url, unused.access)).status, 401)

      // Nor the answer kept for the minute after a renewal.
      const first = await connect(set.url, set.cookie, 'team-a')
      const newest = await renew(set.url, first.clientId, first.refresh).then(json)
      assert.equal((await renew(set.url, stranger.client_id, first.refresh)).status, 400)
      assert.equal((await mcpStatus(set.url, newest.access_token)).status, 401)
    } finally {
      await set.close()
    }
  })

  it('keeps the tokens it holds on to for that minute sealed', async () => {
    const set = await setUpBinders()
    try {
      const first = await connect(set.url, set.cookie, 'team-a')
      const newest = await renew(set.url, first.clientId, first.refresh).then(json)
      const held = [...(set.kv as unknown as { values: Map<string, { value: string }> }).values.entries()].filter(([key]) => key.startsWith('oauth-renewed:'))
      assert.equal(held.length, 1)
      assert.equal(held[0][1].value.includes(newest.access_token), false)
      assert.equal(held[0][1].value.includes(newest.refresh_token), false)
    } finally {
      await set.close()
    }
  })

  it('takes a code or a refresh token once, even twice at the same moment', async () => {
    const set = await setUpBinders()
    try {
      const { client, verifier, code } = await allow(set.url, set.cookie, 'team-a')
      const exchange = () => fetch(`${set.url}/oauth/token`, form({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier }))
      const codes = await Promise.all([exchange(), exchange()])
      assert.deepEqual(codes.map((r) => r.status).sort(), [200, 400])

      const first = await connect(set.url, set.cookie, 'team-a')
      const renewals = await Promise.all([renew(set.url, first.clientId, first.refresh), renew(set.url, first.clientId, first.refresh)])
      const answers = await Promise.all(renewals.map(json))
      assert.equal(answers[0].refresh_token, answers[1].refresh_token, 'one renewal, whoever asked')
    } finally {
      await set.close()
    }
  })

  it('takes any port for a program on this computer, and only what was registered otherwise', async () => {
    const set = await setUpBinders()
    try {
      const ask = (id: string, redirect: string) => fetch(`${set.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirect, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'http://hub.test/team-a/mcp' })}`, { headers: { cookie: set.cookie }, redirect: 'manual' })
      const local = await register(set.url, { redirect_uris: ['http://localhost:9999/cb'] }).then(json)
      assert.equal((await ask(local.client_id, 'http://localhost:10000/cb')).status, 200)
      assert.equal((await ask(local.client_id, 'http://localhost:10000/other')).status, 400)
      assert.equal((await ask(local.client_id, 'http://127.0.0.1:9999/cb')).status, 400)
      const site = await register(set.url, { redirect_uris: ['https://site.example/cb'] }).then(json)
      assert.equal((await ask(site.client_id, 'https://site.example:8443/cb')).status, 400)

      assert.equal((await register(set.url, { redirect_uris: ['someapp://mcp/oauth/callback'] })).status, 201)
      for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts', 'http://site.example/cb', 'https://localhost@site.example/cb']) {
        assert.equal((await register(set.url, { redirect_uris: [bad] })).status, 400, bad)
      }
    } finally {
      await set.close()
    }
  })
})
