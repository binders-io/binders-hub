import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Entry, Change } from '../../shared/state.ts'
import { cardChangeSet } from '../../shared/changeSet.ts'
import { changesTo, load, textOf } from '../../shared/noteDoc.ts'
import { defaultRunner, leftCard } from '../../shared/work.ts'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { ReviewsSaver } from '../src/savers/reviews.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { canCatchUp } from '../src/routes/state.ts'
import { Spaces, type Member } from '../src/spaces.ts'
import type { OwnerAccess } from '../src/reach.ts'
import { fakeGitHub, oneSpace, seed, tempDir, until } from './helpers.ts'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Merger, keepBothAdditions } from '../src/merger.ts'

async function setUp(options: { github?: Awaited<ReturnType<typeof fakeGitHub>>; devLogin?: boolean; allowedUsers?: string[]; webhookSecret?: string; filesDir?: string; merger?: Merger; webDir?: string; updateFailedFile?: string; admins?: string[]; members?: Member[] } = {}) {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: options.github?.url ?? 'http://unused', apiUrl: options.github?.url ?? 'http://unused' },
    options.github ? { clientId: 'id', clientSecret: 'secret', token: 'ghs_server', webhookSecret: options.webhookSecret } : {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: options.allowedUsers ?? [], orgs: [] }), devLogin: () => options.devLogin ?? true })
  const actions = new Actions(hub, github)
  actions.merger = options.merger
  actions.trainDelayMs = 30
  actions.mergeWaitMs = 10
  actions.watchTrains()
  const issues = new IssuesSaver(hub, github, { quietMs: 20 })
  issues.start()
  const reviews = new ReviewsSaver(hub, github, { publicUrl: 'http://hub.test' })
  reviews.start()
  const webhooks = new Webhooks(hub, actions, issues)
  const app = await buildServer(oneSpace(kv, { hub, actions, webhooks, github, issues, filesDir: options.filesDir }, options.members), { auth }, { publicUrl: 'http://hub.test', admins: options.admins, webDir: options.webDir, updateFailedFile: options.updateFailedFile })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { hub, app, url, issues, actions, close: async () => { await issues.stop(); await reviews.stop(); await app.close() } }
}

async function signIn(url: string, login = 'you') {
  const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
  assert.equal(response.status, 200)
  return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
}

function api(url: string, cookie: string) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

async function agentClient(url: string, token: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = result.content[0]?.text ?? ''
    let value: unknown = text
    try {
      value = JSON.parse(text)
    } catch {
      // Words, not JSON.
    }
    return { error: !!result.isError, value: value as Record<string, unknown> & string, text }
  }
  return { client, call }
}

describe('a delivery from GitHub', () => {
  it('that isn’t in a shape the hub knows is ignored, not failed, so GitHub doesn’t keep retrying it', async () => {
    const secret = 'webhook-secret'
    const github = await fakeGitHub()
    const { hub, url, close } = await setUp({ github, webhookSecret: secret })
    const before = hub.version
    for (const [event, payload] of [['issues', { action: 'edited' }], ['pull_request', { action: 'opened', repository: { full_name: 'acme/app' } }], ['check_run', { check_run: 'nope' }]] as const) {
      const body = JSON.stringify(payload)
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
      const response = await fetch(`${url}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature }, body })
      assert.equal(response.status, 200, event)
      assert.equal((await response.json() as { result: string }).result, 'ignored')
    }
    assert.equal(hub.version, before)
    await close()
    await github.close()
  })
})

describe('a folder’s rule', () => {
  it('is its Binder’s owners’ and admins’ to set, because it sends work to agents with nobody reading it first', async () => {
    const { hub, url, close } = await setUp({ admins: ['root'], members: [{ login: 'sam', role: 'member' }, { login: 'boss', role: 'admin' }] })
    const member = api(url, await signIn(url, 'sam'))
    const admin = api(url, await signIn(url, 'boss'))
    const folder = hub.state.folders[0].id
    const refused = await member('PUT', `/api/folders/${folder}/rule`, { distill: true })
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /owners and admins/)
    assert.equal((hub.state.folderRules ?? []).length, 0)
    assert.equal((await member('DELETE', `/api/folders/${folder}/rule`)).status, 422)
    const set = await admin('PUT', `/api/folders/${folder}/rule`, { distill: true, quietMinutes: 5, changeSet: 'own' })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.equal(hub.state.folderRules![0].createdBy, 'boss')
    const state = await member('GET', '/api/state')
    assert.equal(state.body.state.folderRules?.[0]?.folderId, folder, 'everyone in the Binder can see what it does')
    assert.equal((await member('PUT', `/api/notes/${hub.state.notes[0].id}/change-set`, { changeSet: 'own' })).status, 200, 'one note’s change set is its people’s')
    assert.equal((await member('POST', '/api/changes', { client: 'tab-one', changes: [{ id: 'x', change: { type: 'rule.delete', id: hub.state.folderRules![0].id } }] })).status, 422)
    await close()
  })
})

describe('an agent’s owner', () => {
  async function teamWithAgent() {
    const set = await setUp({ admins: ['root'], members: [{ login: 'you', role: 'member' }, { login: 'sam', role: 'member' }, { login: 'boss', role: 'admin' }] })
    const owner = api(set.url, await signIn(set.url, 'you'))
    const teammate = api(set.url, await signIn(set.url, 'sam'))
    const made = await owner('POST', '/api/agents', { name: 'Builder', provider: 'claude', runner: { tool: 'claude', access: 'edits', timeoutMinutes: 60 } })
    return { ...set, owner, teammate, id: made.body.agent.id as string }
  }

  it('alone says what runs on their machine: a teammate can’t change an agent’s command or access', async () => {
    const { hub, teammate, owner, id, close } = await teamWithAgent()
    const refused = await teammate('PATCH', `/api/agents/${id}`, { runner: { tool: 'custom', command: 'touch /tmp/not-yours', access: 'full', timeoutMinutes: 60 } })
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /owner/)
    assert.equal(hub.state.agents.find((a) => a.id === id)?.runner?.tool, 'claude', 'the runner is as it was')
    assert.equal((await owner('PATCH', `/api/agents/${id}`, { runner: { tool: 'custom', command: 'make', access: 'edits', timeoutMinutes: 60 } })).status, 200)
    await close()
  })

  it('alone takes a new token for it, which would speak as the agent', async () => {
    const { teammate, owner, id, close } = await teamWithAgent()
    assert.equal((await teammate('POST', `/api/agents/${id}/token`)).status, 422)
    assert.ok((await owner('POST', `/api/agents/${id}/token`)).body.token)
    await close()
  })

  it('lets a teammate with no say in the Binder neither revoke it nor change it, and its owner do both', async () => {
    const { hub, teammate, owner, id, close } = await teamWithAgent()
    assert.equal((await teammate('PATCH', `/api/agents/${id}`, { name: 'Mine now' })).status, 422)
    assert.equal((await teammate('DELETE', `/api/agents/${id}`)).status, 422)
    assert.equal(hub.state.agents.find((a) => a.id === id)?.revoked, undefined)
    assert.equal((await owner('PATCH', `/api/agents/${id}`, { name: 'Renamed' })).status, 200)
    assert.equal((await owner('DELETE', `/api/agents/${id}`)).status, 200)
    await close()
  })

  it('leaves the Binder’s admins able to tidy up, but not to run anything on the owner’s machine', async () => {
    const { hub, url, id, close } = await teamWithAgent()
    const admin = api(url, await signIn(url, 'boss'))
    assert.equal((await admin('PATCH', `/api/agents/${id}`, { name: 'Tidied', runner: hub.state.agents.find((a) => a.id === id)!.runner })).status, 200, 'an unchanged runner goes along, as the Agents page sends it')
    assert.equal((await admin('PATCH', `/api/agents/${id}`, { runner: { ...hub.state.agents.find((a) => a.id === id)!.runner, tool: 'custom', command: 'whoami' } })).status, 422)
    assert.equal((await admin('POST', `/api/agents/${id}/token`)).status, 422)
    assert.equal((await admin('DELETE', `/api/agents/${id}`)).status, 200)
    await close()
  })

  it('counts what a runner would come to, so nobody else can reset one by sending less of it', async () => {
    const { hub, url, owner, id, close } = await teamWithAgent()
    const admin = api(url, await signIn(url, 'boss'))
    await owner('PATCH', `/api/agents/${id}`, { runner: { tool: 'custom', command: 'safe-wrapper', access: 'edits', workspace: '/safe', parallel: 1, timeoutMinutes: 60 } })
    const runner = () => hub.state.agents.find((a) => a.id === id)!.runner
    const set = runner()
    for (const less of [{}, { access: 'edits' }, { command: 'safe-wrapper' }, { tool: 'custom', command: 'safe-wrapper' }, { tool: 'custom', command: 'safe-wrapper', access: 'edits' }]) {
      const refused = await admin('PATCH', `/api/agents/${id}`, { runner: less })
      assert.equal(refused.status, 422, JSON.stringify(less))
      assert.match(refused.body.error, /owner/)
      assert.deepEqual(runner(), set, 'the runner is as it was')
    }
    assert.equal((await admin('PATCH', `/api/agents/${id}`, { name: 'Tidied', runner: set })).status, 200, 'all of it, unchanged, goes along')
    assert.deepEqual(runner(), set)
    await close()
  })

  it('lets an admin tidy up an agent with no runner set, which the Agents page fills in, and leaves it unset', async () => {
    const { hub, url, owner, close } = await teamWithAgent()
    const admin = api(url, await signIn(url, 'boss'))
    for (const [provider, tool] of [['claude', 'claude'], ['openai', 'codex'], ['other', 'claude']]) {
      const id = (await owner('POST', '/api/agents', { name: `Bare ${provider}`, provider })).body.agent.id as string
      const shown = { ...defaultRunner, tool }
      const form = { name: `Tidied ${provider}`, provider, repos: [], skills: [], binders: [], runner: shown }
      assert.equal((await admin('PATCH', `/api/agents/${id}`, form)).status, 200, provider)
      const agent = hub.state.agents.find((a) => a.id === id)!
      assert.equal(agent.name, `Tidied ${provider}`)
      assert.equal(agent.runner, undefined, 'what it runs is still its owner’s to set')
      assert.equal((await admin('PATCH', `/api/agents/${id}`, { runner: { ...shown, access: 'edits' } })).status, 422, 'a changed one is refused all the same')
    }
    await close()
  })

  it('doesn’t take anything from the body that isn’t theirs to set', async () => {
    const { hub, owner, id, close } = await teamWithAgent()
    await owner('PATCH', `/api/agents/${id}`, { owner: 'someone-else', revoked: true, name: 'Same' })
    const agent = hub.state.agents.find((a) => a.id === id)!
    assert.equal(agent.owner, 'you')
    assert.equal(agent.revoked, undefined)
    await close()
  })
})

describe('what the hub asks of a request', () => {
  it('reads a cookie it can’t decode as a stranger, not as an error', async () => {
    const { url, close } = await setUp()
    const response = await fetch(`${url}/api/me`, { headers: { cookie: 'other=%; binders_session=%E0%A4%A' } })
    assert.equal(response.status, 401)
    await close()
  })

  it('refuses a body that isn’t what the route takes, saying so, rather than falling over', async () => {
    const { url, close } = await setUp()
    const you = api(url, await signIn(url))
    for (const [method, path, body] of [
      ['POST', '/api/agents', { provider: 'claude' }],
      ['POST', '/api/cards', { title: 5 }],
      ['POST', '/api/sets/s1/order', { prIds: 'not a list' }],
      ['POST', '/api/schedules', 'not an object'],
    ] as const) {
      const refused = await you(method, path, body)
      assert.equal(refused.status, 422, `${method} ${path}`)
      assert.equal(typeof refused.body.error, 'string')
    }
    await close()
  })

  it('takes fields it doesn’t know, so a newer client isn’t refused', async () => {
    const { url, close } = await setUp()
    const you = api(url, await signIn(url))
    assert.equal((await you('POST', '/api/agents', { name: 'Fine', fromTheFuture: true })).status, 200)
    await close()
  })

  it('slows down repeated sign-ins, in the shape everything else fails in, and leaves agents and GitHub alone', async () => {
    const { url, close } = await setUp()
    const attempt = () => fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'you' }) })
    let last = await attempt()
    for (let i = 0; i < 40 && last.status !== 429; i++) last = await attempt()
    assert.equal(last.status, 429)
    assert.equal(typeof (await last.json() as { error: string }).error, 'string')
    assert.equal((await fetch(`${url}/ready`)).status, 200, 'health checks aren’t counted')
    await close()
  })

  it('counts each person behind the same proxy apart', async () => {
    const { url, close } = await setUp()
    const attempt = (who: string) => fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1', 'cf-connecting-ip': who }, body: JSON.stringify({ login: 'you' }) })
    let last = await attempt('203.0.113.1')
    for (let i = 0; i < 40 && last.status !== 429; i++) last = await attempt('203.0.113.1')
    assert.equal(last.status, 429)
    assert.equal((await attempt('203.0.113.2')).status, 200)
    await close()
  })
})

describe('the headers a browser gets', () => {
  it('says what the page may do, leaving room for WebAssembly and the styles the editor injects', async () => {
    const { url, close } = await setUp()
    const headers = (await fetch(`${url}/health`)).headers
    const policy = headers.get('content-security-policy-report-only') ?? headers.get('content-security-policy') ?? ''
    for (const part of ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "frame-ancestors 'none'", "object-src 'none'", 'img-src']) assert.ok(policy.includes(part), `has ${part}: ${policy}`)
    assert.doesNotMatch(policy, /upgrade-insecure-requests/, 'a hub on plain http stays reachable')
    assert.equal(headers.get('x-content-type-options'), 'nosniff')
    await close()
  })

  it('doesn’t ask for https from a hub on plain http', async () => {
    const { url, close } = await setUp()
    assert.equal((await fetch(`${url}/health`)).headers.get('strict-transport-security'), null)
    await close()
  })

  it('keeps pictures sandboxed under their own policy', async () => {
    const dir = await tempDir('files')
    const { url, close } = await setUp({ filesDir: dir })
    const cookie = await signIn(url)
    const put = await fetch(`${url}/api/files`, { method: 'POST', headers: { cookie, 'x-binders': '1', 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    const { url: path } = await put.json() as { url: string }
    const got = await fetch(`${url}${path}`, { headers: { cookie } })
    assert.match(got.headers.get('content-security-policy') ?? '', /sandbox/)
    await close()
  })
})

describe('changes from a person', () => {
  it('refuses one that can’t be applied, says why, and the Binder carries on', async () => {
    const { hub, url, close } = await setUp()
    const you = api(url, await signIn(url))
    const before = hub.version
    const refused = await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'bad', change: { type: 'note.put' } }] })
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /note\.put/)
    assert.equal(hub.version, before, 'nothing went in the log')
    const fine = await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'ok', change: { type: 'binder.put', binder: { id: 'b2', name: 'Design' } } }] })
    assert.equal(fine.status, 200)
    assert.ok(hub.state.binders.some((b) => b.id === 'b2'))
    await close()
  })
})

describe('signing in', () => {
  it('tells the hub’s admins when a newer commit didn’t get in because its tests failed', async () => {
    const dir = await tempDir('update')
    const file = join(dir, 'update-failed.txt')
    writeFileSync(file, ['a4f9871aa', '2026-10-31T15:00:00Z', 'Agents in a terminal', '✖ agents’ terminals', 'ℹ fail 1'].join('\n'))
    const { url, close } = await setUp({ updateFailedFile: file })
    const you = api(url, await signIn(url))
    const me = (await you('GET', '/api/me')).body
    assert.deepEqual(me.updateFailed, { commit: 'a4f9871aa', at: '2026-10-31T15:00:00Z', subject: 'Agents in a terminal', log: '✖ agents’ terminals\nℹ fail 1' })
    writeFileSync(file, '')
    assert.equal((await you('GET', '/api/me')).body.updateFailed, undefined, 'none once it’s cleared')
    await close()
  })

  it('keeps everything under /api behind a session, and changes behind the web app’s header', async () => {
    const { url, close } = await setUp()
    assert.equal((await fetch(`${url}/api/state`)).status, 401)
    const cookie = await signIn(url)
    assert.equal((await fetch(`${url}/api/state`, { headers: { cookie } })).status, 200)
    const noHeader = await fetch(`${url}/api/changes`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ client: 'tab-123', changes: [] }) })
    assert.equal(noHeader.status, 403)
    const me = await api(url, cookie)('GET', '/api/me')
    assert.equal(me.body.user.login, 'you')
    await close()
  })

  it('signs in with GitHub, and keeps out who isn’t let in', async () => {
    const github = await fakeGitHub({ login: 'octo' })
    const { url, close } = await setUp({ github })
    const start = await fetch(`${url}/auth/github`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const location = new URL(start.headers.get('location')!)
    assert.equal(location.pathname, '/login/oauth/authorize')
    assert.equal(location.searchParams.get('scope'), 'repo read:org')
    const state = location.searchParams.get('state')!
    const stateCookie = /binders_oauth=[^;]+/.exec(start.headers.get('set-cookie')!)![0]
    const back = await fetch(`${url}/auth/github/callback?code=good&state=${state}`, { headers: { cookie: stateCookie }, redirect: 'manual' })
    assert.equal(back.status, 302)
    const cookie = /binders_session=[^;]+/.exec(back.headers.get('set-cookie')!)![0]
    const me = await api(url, cookie)('GET', '/api/me')
    assert.equal(me.body.user.login, 'octo')
    assert.equal(me.body.github.token, true, 'the session keeps their GitHub token')
    const forged = await fetch(`${url}/auth/github/callback?code=good&state=other`, { headers: { cookie: stateCookie }, redirect: 'manual' })
    assert.equal(forged.status, 400)
    await close()

    const strict = await setUp({ github, allowedUsers: ['someone-else'] })
    const again = await fetch(`${strict.url}/auth/github`, { redirect: 'manual' })
    const againState = new URL(again.headers.get('location')!).searchParams.get('state')!
    const refused = await fetch(`${strict.url}/auth/github/callback?code=good&state=${againState}`, { headers: { cookie: /binders_oauth=[^;]+/.exec(again.headers.get('set-cookie')!)![0] }, redirect: 'manual' })
    assert.equal(refused.status, 403)
    assert.match(await refused.text(), /isn’t one of this hub’s people/)
    await strict.close()
    await github.close()
  })
})

describe('each person’s GitHub', () => {
  async function viaGitHub(url: string) {
    const start = await fetch(`${url}/auth/github`, { redirect: 'manual' })
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const back = await fetch(`${url}/auth/github/callback?code=good&state=${state}`, { headers: { cookie: /binders_oauth=[^;]+/.exec(start.headers.get('set-cookie')!)![0] }, redirect: 'manual' })
    return /binders_session=[^;]+/.exec(back.headers.get('set-cookie')!)![0]
  }

  it('renews a sign-in before it runs out, once for all at once', async () => {
    const github = await fakeGitHub({ login: 'octo' })
    // A GitHub App's sign-in: a minute left, so the hub renews it on the next call.
    github.world.tokenSeconds = 60
    const { url, close } = await setUp({ github, devLogin: false })
    const octo = api(url, await viaGitHub(url))
    const link = await octo('GET', '/api/github/me')
    assert.equal(link.body.connected, true)
    // A minute left isn't out yet: the call goes on with the token it has, and it's renewed beside the call.
    await until(() => github.world.renewals >= 1)
    const used = () => github.calls.filter((c) => c.path === '/user/repos').map((c) => c.auth)
    // Once the renewed one is kept, calls go out with it.
    await until(async () => {
      await octo('GET', '/api/github/repos')
      return !!used().at(-1)?.startsWith('Bearer gho_renewed_')
    })
    const before = used().length
    const answers = await Promise.all([octo('GET', '/api/github/repos'), octo('GET', '/api/github/repos?q=a'), octo('GET', '/api/me')])
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200])
    assert.equal(answers[2].body.github.token, true)
    // Renewed again (still a minute each time), each refresh token used once, and never back to the first token.
    await until(() => github.world.renewals >= 2)
    assert.ok(used().slice(before).every((auth) => auth?.startsWith('Bearer gho_renewed_')))
    await close()
    await github.close()
  })

  it('links a project or an agent only to a repo its person can push to', async () => {
    const github = await fakeGitHub({ login: 'octo' })
    github.world.access = { 'acme/docs': 'read', 'acme/secret': 'none' }
    const { url, hub, close } = await setUp({ github, devLogin: false })
    const octo = api(url, await viaGitHub(url))
    const link = (id: string, repo: string) => octo('POST', '/api/changes', { client: 'tab-1234', changes: [{ id, change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo } } }] })
    assert.equal((await link('c1', 'acme/web')).status, 200)
    assert.equal(hub.state.binders.find((b) => b.id === 'b1')?.repo, 'acme/web')
    const read = await link('c2', 'acme/docs')
    assert.equal(read.status, 422)
    assert.match(read.body.error, /As @octo, GitHub lets you read acme\/docs but not push/)
    assert.equal((await link('c3', 'acme/secret')).status, 422)
    assert.equal(hub.state.binders.find((b) => b.id === 'b1')?.repo, 'acme/web')
    // Renaming keeps the repo it has, without asking GitHub again.
    github.world.access['acme/web'] = 'read'
    assert.equal((await octo('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'c4', change: { type: 'binder.put', binder: { id: 'b1', name: 'Web', repo: 'acme/web' } } }] })).status, 200)

    assert.equal((await octo('POST', '/api/agents', { name: 'Builder', repos: ['acme/docs'] })).status, 422)
    const made = await octo('POST', '/api/agents', { name: 'Builder', repos: ['acme/app'] })
    assert.equal(made.status, 200)
    assert.equal((await octo('PATCH', `/api/agents/${made.body.agent.id}`, { repos: ['acme/app', 'acme/secret'] })).status, 422)

    const me = await octo('GET', '/api/github/me')
    // What GitHub said is kept a couple of minutes: still push, as when it was linked.
    assert.deepEqual(me.body.projects.map((p: { repo?: string; access?: string }) => [p.repo, p.access]), [['acme/web', 'push']])
    await close()

    // Signed in by name on a hub that allows it: no GitHub to ask, so it's let through.
    const local = await setUp({ github })
    const you = api(local.url, await signIn(local.url))
    assert.equal((await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'l1', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/secret' } } }] })).status, 200)
    await local.close()
    await github.close()
  })
})

describe('several Binders on one hub', () => {
  async function setUpBinders(githubUrl = 'http://unused') {
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    // Each Binder its own GitHub, with its own webhook secret.
    const make = async (id: string) => {
      const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: githubUrl, apiUrl: githubUrl }, githubUrl === 'http://unused' ? { webhookSecret: `shh-${id}` } : {}, id)
      const hub = new Hub(new MemoryLog())
      await hub.start()
      const actions = new Actions(hub, github)
      return { id, hub, actions, github, webhooks: new Webhooks(hub, actions) }
    }
    const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: [{ login: 'ana', role: 'owner' }] })
    const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const as = async (login: string, space?: string) => {
      const cookie = await signIn(url, login)
      return async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      }
    }
    return { spaces, url, as, close: () => app.close() }
  }

  it('keeps each Binder to its members, and its admins make more', async () => {
    const { spaces, as, close } = await setUpBinders()
    const ana = await as('ana')
    const me = await ana('GET', '/api/me')
    assert.equal(me.body.space, 'acme')
    assert.deepEqual(me.body.spaces, [{ id: 'acme', name: 'Acme', role: 'owner' }, { id: '~ana', name: 'Personal', role: 'owner' }], 'and a Binder of their own')

    // Not a member of any team's Binder: signed in, with only their own to open.
    const bo = await as('bo')
    assert.deepEqual((await bo('GET', '/api/me')).body.spaces.map((s: { id: string }) => s.id), ['~bo'])
    assert.equal((await (await as('bo', 'acme'))('GET', '/api/state')).status, 403)
    assert.equal((await (await as('bo', '~ana'))('GET', '/api/state')).status, 403, 'nor anyone else’s own')
    // Anyone makes a Binder, and owns it, whoever they name; its address comes from its name.
    const made = await bo('POST', '/api/spaces', { name: 'Mobile app', owner: 'ana' })
    assert.equal(made.status, 200)
    assert.deepEqual(made.body.created, { id: 'mobile-app', name: 'Mobile app' })
    assert.deepEqual(spaces.info('mobile-app')?.members, [{ login: 'bo', role: 'owner' }])
    assert.equal((await bo('POST', '/api/spaces', { name: 'Mobile app' })).body.created.id, 'mobile-app-2')

    // The hub's admin makes one for bo, who owns it.
    const root = await as('root')
    assert.equal((await root('POST', '/api/spaces', { id: 'api', name: 'Nope', owner: 'bo' })).status, 422)
    assert.equal((await root('POST', '/api/spaces', { id: 'globex', name: 'Globex', owner: 'bo' })).status, 200)
    const boInGlobex = await as('bo', 'globex')
    assert.equal((await boInGlobex('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'g1', change: { type: 'binder.put', binder: { id: 'p1', name: 'Globex app' } } }] })).status, 200)
    assert.deepEqual(spaces.get('globex')!.hub.state.binders.map((b) => b.name), ['Globex app'])
    assert.equal(spaces.info('globex')?.name, 'Globex app', 'a Binder goes by its one binder’s name')
    assert.equal(spaces.get('acme')!.hub.state.binders.length, 0)

    // ana can't open it, by name or otherwise.
    const anaInGlobex = await as('ana', 'globex')
    assert.equal((await anaInGlobex('GET', '/api/state')).status, 403)
    assert.equal((await ana('GET', '/api/state')).body.state.binders.length, 0)

    // ana adds cy as a member; a member can't add people, and the last owner can't leave.
    assert.equal((await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })).status, 200)
    assert.equal((await ana('PUT', '/api/spaces/acme/members/jdoe_acme', { role: 'member' })).status, 200, 'an Enterprise Managed User’s login, with its shortcode')
    assert.equal((await ana('DELETE', '/api/spaces/acme/members/jdoe_acme')).status, 200)
    assert.equal((await ana('PUT', '/api/spaces/acme/members/no_such__login', { role: 'member' })).status, 422)
    const cy = await as('cy')
    assert.equal((await cy('GET', '/api/me')).body.space, 'acme')
    assert.equal((await cy('PUT', '/api/spaces/acme/members/dee', { role: 'member' })).status, 422)
    assert.equal((await ana('DELETE', '/api/spaces/acme/members/ana')).status, 422)
    assert.equal((await ana('PUT', '/api/spaces/globex/members/ana', { role: 'owner' })).status, 422)
    const listed = await ana('GET', '/api/spaces')
    assert.deepEqual(listed.body.spaces[0].members.map((m: { login: string }) => m.login), ['ana', 'cy'])
    assert.equal((await cy('GET', '/api/spaces')).body.spaces[0].members, undefined)
    await close()
  })

  it('binds an agent to its Binder, and sends GitHub’s events to the Binders with the repo', async () => {
    const { spaces, url, as, close } = await setUpBinders()
    const root = await as('root')
    await root('POST', '/api/spaces', { id: 'globex', name: 'Globex', owner: 'bo' })
    const bo = await as('bo', 'globex')
    await bo('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'g1', change: { type: 'binder.put', binder: { id: 'p1', name: 'App', repo: 'globex/app' } } }] })
    const card = (await bo('POST', '/api/cards', { binderId: 'p1', title: 'Fix the login' })).body

    const made = await bo('POST', '/api/agents', { name: 'Builder' })
    const agent = await agentClient(url, made.body.token)
    const listed = await agent.call('list_binders')
    assert.ok(JSON.stringify(listed.value).includes('globex/app'))
    assert.equal(spaces.get('acme')!.hub.state.agents.length, 0)
    await agent.client.close()

    // Each Binder's GitHub posts to its own path, signed with its own secret.
    const body = JSON.stringify({ action: 'opened', pull_request: { number: 4, title: 'Fix', body: `binders-card: ${card.id}`, state: 'open', html_url: '', head: { ref: 'agent/x' } }, repository: { full_name: 'globex/app' } })
    const deliver = (path: string, secret: string) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body })
    assert.equal((await deliver('/webhooks/github', 'shh-globex')).status, 401, 'the first Binder’s path takes only its own secret')
    assert.equal((await deliver('/webhooks/github/globex', 'shh-globex')).status, 200)
    assert.equal(spaces.get('globex')!.hub.state.pulls[0]?.cardId, card.id)
    assert.equal(spaces.get('acme')!.hub.state.pulls.length, 0)
    await close()
  })

  it('keeps each Binder’s GitHub App its own: made, installed and forgotten there alone', async () => {
    const fake = await fakeGitHub()
    const { spaces, url, as, close } = await setUpBinders(fake.url)
    const root = await as('root')
    await root('POST', '/api/spaces', { id: 'globex', name: 'Globex', owner: 'bo' })
    const make = async (who: Awaited<ReturnType<typeof as>>, space: string) => {
      const started = await who('POST', '/api/github/app', { org: 'acme' })
      assert.equal(started.status, 200)
      assert.equal(JSON.parse(started.body.manifest).redirect_url, `http://hub.test/setup/github/created/${space}`)
      assert.equal(JSON.parse(started.body.manifest).hook_attributes.url, `http://hub.test/webhooks/github/${space}`)
      return new URL(started.body.action).searchParams.get('state')
    }
    const ana = await as('ana', 'acme')
    const bo = await as('bo', 'globex')
    // A member who isn't an owner or admin can't change a Binder's GitHub.
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    assert.equal((await (await as('cy', 'acme'))('POST', '/api/github/app', {})).status, 422)
    for (const [who, space] of [[ana, 'acme'], [bo, 'globex']] as const) {
      const state = await make(who, space)
      const created = await fetch(`${url}/setup/github/created/${space}?code=made&state=${state}`, { redirect: 'manual' })
      assert.equal(created.headers.get('location'), `/${space}/#/settings`)
    }
    assert.equal(spaces.get('acme')!.github.status().mode, 'app')
    assert.equal(spaces.get('globex')!.github.status().mode, 'app')
    assert.equal((await bo('DELETE', '/api/github/app')).status, 200)
    assert.equal(spaces.get('globex')!.github.status().mode, 'none')
    assert.equal(spaces.get('acme')!.github.status().mode, 'app', 'forgetting it in one Binder leaves the other’s')
    await close()
    await fake.close()
  })
})

describe('the web app, built', () => {
  it('serves its files, index.html for the rest, and nothing outside it', async () => {
    const dir = await tempDir('web')
    execFileSync('mkdir', ['-p', join(dir, 'web/assets')])
    writeFileSync(join(dir, 'web/index.html'), '<!doctype html><title>Binders</title>')
    writeFileSync(join(dir, 'web/assets/app-1a2b.js'), 'console.log(1)')
    writeFileSync(join(dir, 'secret'), 'sealed')
    const { url, close } = await setUp({ webDir: join(dir, 'web') })
    try {
      const page = await fetch(`${url}/`)
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-type') ?? '', /text\/html/)
      assert.equal(await page.text(), '<!doctype html><title>Binders</title>')
      const script = await fetch(`${url}/assets/app-1a2b.js`)
      assert.match(script.headers.get('content-type') ?? '', /javascript/)
      assert.match(script.headers.get('cache-control') ?? '', /immutable/)
      assert.equal(await (await fetch(`${url}/anything/else`)).text(), '<!doctype html><title>Binders</title>')
      assert.equal(await (await fetch(`${url}/%2e%2e/secret`)).text(), '<!doctype html><title>Binders</title>')
      // A tab left open across an update asks for files that are gone: a page in their place only fails stranger.
      const gone = await fetch(`${url}/assets/app-old.js`)
      assert.equal(gone.status, 404)
      assert.doesNotMatch(gone.headers.get('content-type') ?? '', /text\/html/)
      // What's been compressed goes compressed, to those who take it.
      writeFileSync(join(dir, 'web/assets/app-1a2b.js.br'), 'not really brotli')
      const small = await fetch(`${url}/assets/app-1a2b.js`, { headers: { 'accept-encoding': 'br' } })
      assert.equal(small.headers.get('content-encoding'), 'br')
      assert.match(small.headers.get('content-type') ?? '', /javascript/)
      assert.match(small.headers.get('cache-control') ?? '', /immutable/)
      assert.equal((await fetch(`${url}/assets/app-1a2b.js`, { headers: { 'accept-encoding': 'identity' } })).headers.get('content-encoding'), null)
      assert.equal((await fetch(`${url}/api/nothing`)).status, 401)
      assert.equal((await fetch(`${url}/runner/nothing`)).status, 404)
      assert.equal((await fetch(`${url}/health`)).status, 200)
    } finally {
      await close()
    }
  })
})

describe('apps’ person tokens', () => {
  /** What the browser does for an app: /auth/app, GitHub, and back to the binders:// link the hub hands over. */
  async function appSignIn(url: string, state: string) {
    const start = await fetch(`${url}/auth/app?state=${state}&app=${encodeURIComponent('Binders for Mac')}`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const github = new URL(start.headers.get('location')!)
    assert.equal(github.pathname, '/login/oauth/authorize')
    const set = start.headers.getSetCookie()
    const cookie = ['binders_oauth', 'binders_app'].map((name) => set.find((c) => c.startsWith(`${name}=`))!.split(';')[0]).join('; ')
    const back = await fetch(`${url}/auth/github/callback?code=good&state=${github.searchParams.get('state')}`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(back.status, 302)
    return new URL(back.headers.get('location')!)
  }

  const bearer = (url: string, token: string) => async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }

  it('signs an app in through GitHub, hands back a bnp_ token on a binders:// link, and takes it on /api and /api/live', async () => {
    const github = await fakeGitHub({ login: 'octo' })
    const { url, close } = await setUp({ github })
    const back = await appSignIn(url, 'mac-state-1234')
    assert.equal(back.protocol, 'binders:')
    assert.equal(back.searchParams.get('state'), 'mac-state-1234', 'the app’s own state comes back, for it to check it asked')
    assert.equal(back.searchParams.get('hub'), 'http://hub.test')
    const token = back.searchParams.get('token')!
    assert.match(token, /^bnp_[A-Za-z0-9_-]{43}$/)
    const as = bearer(url, token)

    // The state, a change (no x-binders header: no cookie, so nothing cross-site), and who they are.
    const state = await as('GET', '/api/state')
    assert.equal(state.status, 200)
    assert.ok(state.body.state.binders.some((b: { id: string }) => b.id === 'b1'))
    const me = await as('GET', '/api/me')
    assert.equal(me.body.user.login, 'octo')
    assert.equal(me.body.github.token, true, 'the token carries their GitHub token, as a session does')
    const sent = await as('POST', '/api/changes', { client: 'mac-1234', changes: [{ id: 'b2', change: { type: 'binder.put', binder: { id: 'b2', name: 'From the Mac' } } }] })
    assert.equal(sent.status, 200)

    // The live feed, with the token as its header.
    const received: Entry[] = []
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=0`, { headers: { authorization: `Bearer ${token}` } })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; entries?: Entry[] }
      if (message.type === 'entries') received.push(...message.entries!)
    })
    await new Promise((done) => socket.once('open', done))
    await until(() => received.some((e) => e.client === 'user:octo:mac-1234'))
    socket.close()

    // They see it among their tokens, the one in use marked, and can stop it.
    const tokens = await as('GET', '/api/tokens')
    assert.equal(tokens.body.tokens.length, 1)
    assert.equal(tokens.body.tokens[0].app, 'Binders for Mac')
    assert.equal(tokens.body.tokens[0].current, true)
    assert.deepEqual(tokens.body.tokens[0].binder, { id: 'test', name: 'Test', personal: false }, 'it names the binder it’s registered to')
    assert.ok(!JSON.stringify(tokens.body).includes(token), 'the token itself is never shown again')
    assert.equal((await as('DELETE', `/api/tokens/${tokens.body.tokens[0].id}`)).status, 200)

    // Revoked, or never known: 401 on /api and /api/live, and no falling back to anything else.
    for (const dead of [token, 'bnp_madeup', 'bnd_notforapi']) {
      assert.equal((await bearer(url, dead)('GET', '/api/state')).status, 401)
      assert.equal((await bearer(url, dead)('POST', '/api/changes', { client: 'mac-1234', changes: [] })).status, 401)
      const refused = new WebSocket(`${url.replace('http', 'ws')}/api/live`, { headers: { authorization: `Bearer ${dead}` } })
      assert.equal(await new Promise((done) => refused.once('unexpected-response', (_request, response) => done(response.statusCode))), 401)
    }
    await close()
    await github.close()
  })

  it('hands a token straight back to someone signed in already, only to binders://, and only their own tokens to revoke', async () => {
    const { url, close } = await setUp()
    const cookie = await signIn(url, 'ana')
    const start = await fetch(`${url}/auth/app?state=mac-state-5678&app=Mac`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(start.status, 302)
    const back = new URL(start.headers.get('location')!)
    assert.equal(`${back.protocol}//${back.host}`, 'binders://auth')
    const token = back.searchParams.get('token')!
    assert.equal((await bearer(url, token)('GET', '/api/me')).body.user.login, 'ana')

    // Nowhere but the app, and only with a state for it to check.
    assert.equal((await fetch(`${url}/auth/app?state=mac-state-5678&redirect=${encodeURIComponent('https://elsewhere.test/steal')}`, { headers: { cookie }, redirect: 'manual' })).status, 400)
    assert.equal((await fetch(`${url}/auth/app`, { headers: { cookie }, redirect: 'manual' })).status, 400)
    // No GitHub on this hub and not signed in: sign in on the web first.
    assert.equal((await fetch(`${url}/auth/app?state=mac-state-5678`, { redirect: 'manual' })).status, 403)

    // Someone else can't see or stop Ana's token; Ana can, from the web app with the cookie.
    const ben = api(url, await signIn(url, 'ben'))
    assert.deepEqual((await ben('GET', '/api/tokens')).body.tokens, [])
    const [mine] = (await api(url, cookie)('GET', '/api/tokens')).body.tokens
    assert.equal(mine.current, false)
    // Signed in by name, through no binder's GitHub App: it counts as the first binder's, which she's in.
    assert.equal(mine.binder.name, 'Test')
    assert.equal((await ben('DELETE', `/api/tokens/${mine.id}`)).status, 404)
    assert.equal((await bearer(url, token)('GET', '/api/state')).status, 200)
    assert.equal((await api(url, cookie)('DELETE', `/api/tokens/${mine.id}`)).status, 200)
    assert.equal((await bearer(url, token)('GET', '/api/state')).status, 401)
    await close()
  })
})

describe('the live feed', () => {
  it('sends what a signed-in tab missed, then every change as it comes', async () => {
    const { url, close } = await setUp()
    const cookie = await signIn(url)
    const received: Entry[] = []
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=1`, { headers: { cookie } })
    let presence: unknown
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; entries?: Entry[]; presence?: unknown }
      if (message.type === 'entries') received.push(...message.entries!)
      if (message.type === 'presence') presence = message.presence
    })
    await new Promise((done) => socket.once('open', done))
    await until(() => received.length === 2)
    assert.deepEqual(presence, {}, 'agents’ presence comes first, live and out of the log')
    await api(url, cookie)('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'b2', change: { type: 'binder.put', binder: { id: 'b2', name: 'Design' } } }] })
    await until(() => received.length === 3)
    assert.equal(received[2].client, 'user:you:tab-1234')
    socket.close()
    const anonymous = new WebSocket(`${url.replace('http', 'ws')}/api/live`)
    const code = await new Promise((done) => anonymous.once('unexpected-response', (_request, response) => done(response.statusCode)))
    assert.equal(code, 401)
    await close()
  })
  /** A socket on the live feed from a version, with everything it's sent. */
  async function following(url: string, cookie: string, since: number) {
    const received: Entry[] = []
    const told: { type: string; version?: number }[] = []
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=${since}`, { headers: { cookie } })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; entries?: Entry[]; version?: number }
      if (message.type === 'entries') received.push(...message.entries!)
      else if (message.type !== 'presence' && message.type !== 'terminals') told.push(message)
    })
    await new Promise((done) => socket.once('open', done))
    return { received, told, socket }
  }
  const versions = (entries: Entry[]) => entries.map((e) => e.version)
  const run = (from: number, to: number) => Array.from({ length: to - from }, (_, n) => from + 1 + n)
  const line = (n: number): Change => ({ type: 'card.activity', id: 'c1', activity: { at: 'now', by: 'you', kind: 'comment', text: `Line ${n}` } })

  it('brings a client that’s thousands of changes behind every one of them, in order', async () => {
    const { url, hub, close } = await setUp()
    const cookie = await signIn(url)
    const from = hub.version
    for (let n = 0; n < 4500; n++) await hub.record({ kind: 'hub' }, line(n))
    const { received, told, socket } = await following(url, cookie, from)
    await until(() => received.length === 4500)
    assert.deepEqual(versions(received), run(from, hub.version), 'none left out, none twice, none out of turn')
    assert.deepEqual(told, [])
    socket.close()
    await close()
  })

  it('holds what happens while a client is catching up, so nothing goes ahead of what came before it', async () => {
    const { url, hub, close } = await setUp()
    const cookie = await signIn(url)
    const from = hub.version
    for (let n = 0; n < 5; n++) await hub.record({ kind: 'hub' }, line(n))
    // The log takes a moment to read back, and changes land meanwhile.
    const read = hub.read.bind(hub)
    let reads = 0
    hub.read = async (after, limit) => {
      const found = await read(after, limit)
      if (reads++ < 2) {
        await hub.record({ kind: 'hub' }, line(100 + reads))
        await new Promise((done) => setTimeout(done, 60))
      }
      return found
    }
    const { received, socket } = await following(url, cookie, from)
    await until(() => received.length === hub.version - from)
    await hub.record({ kind: 'hub' }, line(200))
    await until(() => received.length === hub.version - from)
    assert.deepEqual(versions(received), run(from, hub.version))
    socket.close()
    await close()
  })

  it('tells a client the log doesn’t go back to, or one ahead of it, that it’s behind, and sends what happens from now', async () => {
    const { url, hub, close } = await setUp()
    const cookie = await signIn(url)
    const from = hub.version
    for (let n = 0; n < 10; n++) await hub.record({ kind: 'hub' }, line(n))
    // The log was cut short of where this client is: the change after its own is gone.
    await hub.log.trim?.(from + 5)
    const behind = await following(url, cookie, from)
    await until(() => behind.told.length === 1)
    assert.deepEqual(behind.told, [{ type: 'behind', version: hub.version }])
    assert.deepEqual(behind.received, [], 'nothing from the middle of what it missed')
    await hub.record({ kind: 'hub' }, line(50))
    await until(() => behind.received.length === 1)
    assert.deepEqual(versions(behind.received), [hub.version])
    behind.socket.close()
    // One that says it's further on than the hub is: its version isn't of this log.
    const ahead = await following(url, cookie, hub.version + 100)
    await until(() => ahead.told.length === 1)
    assert.deepEqual(ahead.told, [{ type: 'behind', version: hub.version }])
    await hub.record({ kind: 'hub' }, line(51))
    await until(() => ahead.received.length === 1)
    assert.deepEqual(versions(ahead.received), [hub.version])
    ahead.socket.close()
    // One that's where the hub is gets neither: there's nothing to catch up on.
    const here = await following(url, cookie, hub.version)
    await hub.record({ kind: 'hub' }, line(52))
    await until(() => here.received.length === 1)
    assert.deepEqual(here.told, [])
    here.socket.close()
    await close()
  })

  it('gives a note’s Automerge document to edit from, and sends the edits on with the text merged', async () => {
    const { url, hub, close } = await setUp()
    const cookie = await signIn(url)
    const opened = async () => load(new Uint8Array(await (await fetch(`${url}/api/notes/n1/doc`, { headers: { cookie } })).arrayBuffer()))
    const yours = await opened()
    const sams = await opened()
    assert.equal(textOf(yours), '# First note\n')
    const received: Entry[] = []
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=${hub.version}`, { headers: { cookie } })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; entries?: Entry[] }
      if (message.type === 'entries') received.push(...message.entries!)
    })
    await new Promise((done) => socket.once('open', done))
    const edit = (changes: string[], by: string) => ({ type: 'note.edit', id: 'n1', text: '', title: '', by, at: 'now', changes })
    const you = api(url, cookie)
    assert.equal((await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'y', change: edit(changesTo(yours, '# First note, mine\n'), 'you') }] })).status, 200)
    assert.equal((await you('POST', '/api/changes', { client: 'tab-5678', changes: [{ id: 's', change: edit(changesTo(sams, '# Our first note\n'), 'you') }] })).status, 200)
    await until(() => received.length === 2)
    const last = received[1].change
    assert.equal(last.type === 'note.edit' && last.text, '# Our first note, mine\n')
    assert.equal(hub.state.notes[0].title, 'Our first note, mine')
    assert.equal((await fetch(`${url}/api/notes/nope/doc`, { headers: { cookie } })).status, 404)
    socket.close()
    await close()
  })
})

describe('agents within their owners’ reach', () => {
  it('takes cards only in repos its owner can push to, and runs with a token for that repo alone', async () => {
    const { url, hub, actions, close } = await setUp()
    // What GitHub would say of each owner, and the tokens the app would make.
    const owners: Record<string, OwnerAccess> = { 'you/acme/web': 'push', 'you/acme/docs': 'read' }
    const made: string[] = []
    actions.reach = {
      owner: async (owner, repo) => owners[`${owner}/${repo}`] ?? 'none',
      runToken: async (repo) => { made.push(repo); return { token: `ghs_only_${repo.replace('/', '_')}`, expiresAt: '2026-10-30T13:00:00Z' } },
      webUrl: 'https://github.test',
    }
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [
      { id: 'p1', change: { type: 'binder.put', binder: { id: 'web', name: 'Web', repo: 'acme/web' } } },
      { id: 'p2', change: { type: 'binder.put', binder: { id: 'docs', name: 'Docs', repo: 'acme/docs' } } },
    ] })
    const docsCard = (await you('POST', '/api/cards', { binderId: 'docs', title: 'Fix a typo' })).body
    const webCard = (await you('POST', '/api/cards', { binderId: 'web', title: 'Add a page' })).body
    for (const card of [docsCard, webCard]) await hub.record({ kind: 'user', login: 'you' }, { type: 'card.update', id: card.id, fields: { stage: 'ready' } })
    const made1 = await you('POST', '/api/agents', { name: 'Builder' })
    const builder = await agentClient(url, made1.body.token)

    // The docs card first: refused, as its owner can only read there, and not offered again meanwhile.
    const refused = await builder.call('claim_task', { id: docsCard.id })
    assert.equal(refused.error, true)
    assert.match(refused.text, /you, who set this agent up, can’t push to acme\/docs \(read only\)/)
    assert.equal(hub.state.cards.find((c) => c.id === docsCard.id)?.agentId, undefined)
    assert.match(hub.state.cards.find((c) => c.id === docsCard.id)!.activity.at(-1)!.text, /Builder couldn’t take it: you, who set this agent up, can’t push to acme\/docs/, 'said on the card, for its people')
    const offered = await builder.call('wait_for_work', { timeout_seconds: 0 })
    assert.equal(offered.value.id, webCard.id)

    // No token before it holds the card; once it does, one for its repo alone.
    assert.equal((await builder.call('repo_token', { id: webCard.id })).error, true)
    assert.equal((await builder.call('claim_task', { id: webCard.id })).error, false)
    const token = await builder.call('repo_token', { id: webCard.id })
    assert.deepEqual(token.value, { repo: 'acme/web', token: 'ghs_only_acme_web', expires_at: '2026-10-30T13:00:00Z', github: 'https://github.test', as: 'app' }, 'no sign-in of its owner’s to push with: the app’s')
    assert.deepEqual(made, ['acme/web'])

    // With its owner's sign-in, it pushes and commits as them (the default); set to the app, as the app's bot.
    actions.reach.ownerToken = async (owner) => (owner === 'you' ? 'ghu_owner_you' : undefined)
    actions.reach.author = async (as) => (as === 'owner' ? { name: 'You Person', email: '7+you@users.noreply.github.com' } : { name: 'binders[bot]', email: '9+binders[bot]@users.noreply.github.com' })
    const asOwner = await builder.call('repo_token', { id: webCard.id })
    assert.equal(asOwner.value.token, 'ghu_owner_you')
    assert.equal(asOwner.value.as, 'owner')
    assert.deepEqual(asOwner.value.author, { name: 'You Person', email: '7+you@users.noreply.github.com' })
    await you('PATCH', `/api/agents/${made1.body.agent.id}`, { runner: { ...hub.state.agents.find((a) => a.id === made1.body.agent.id)!.runner, commitAs: 'app' } })
    const asApp = await builder.call('repo_token', { id: webCard.id })
    assert.equal(asApp.value.token, 'ghs_only_acme_web')
    assert.deepEqual(asApp.value.author, { name: 'binders[bot]', email: '9+binders[bot]@users.noreply.github.com' })
    await you('PATCH', `/api/agents/${made1.body.agent.id}`, { runner: { ...hub.state.agents.find((a) => a.id === made1.body.agent.id)!.runner, commitAs: 'owner' } })

    // The hub's admins fix it for every agent: always the app, whatever the agent says; saving it keeps theirs.
    actions.agentCommits = () => 'app'
    assert.equal((await builder.call('repo_token', { id: webCard.id })).value.as, 'app', 'the admins’ choice wins over the agent’s own')
    await you('PATCH', `/api/agents/${made1.body.agent.id}`, { runner: { ...hub.state.agents.find((a) => a.id === made1.body.agent.id)!.runner, commitAs: 'owner' }, name: 'Builder' })
    assert.equal(hub.state.agents.find((a) => a.id === made1.body.agent.id)!.runner?.commitAs, 'app', 'saving an agent keeps the admins’ choice')
    // Always the owner: theirs while the hub holds their sign-in, and no falling back to the app when it doesn't.
    actions.agentCommits = () => 'owner'
    assert.equal((await builder.call('repo_token', { id: webCard.id })).value.as, 'owner')
    assert.equal(hub.state.agents.find((a) => a.id === made1.body.agent.id)!.runner?.commitAs, 'app', 'the agent’s stored choice is only replaced when it’s next saved')
    actions.reach.ownerToken = async () => undefined
    const noOwner = await builder.call('repo_token', { id: webCard.id })
    assert.equal(noOwner.error, true)
    assert.match(noOwner.text, /admins have agents commit as their owners/)
    actions.agentCommits = () => 'agent'
    await you('PATCH', `/api/agents/${made1.body.agent.id}`, { runner: { ...hub.state.agents.find((a) => a.id === made1.body.agent.id)!.runner, commitAs: 'owner' } })
    actions.reach.ownerToken = undefined
    actions.reach.author = undefined

    // For the repo it works in: one of its own, not any.
    assert.equal((await builder.call('repo_token', { id: webCard.id, repo: 'acme/other' })).error, true)
    await you('PATCH', `/api/agents/${made1.body.agent.id}`, { repos: ['acme/app'] })
    owners['you/acme/app'] = 'push'
    const own = await builder.call('repo_token', { id: webCard.id, repo: 'acme/app' })
    assert.equal(own.value.token, 'ghs_only_acme_app', own.text)
    owners['you/acme/app'] = 'read'
    assert.match((await builder.call('repo_token', { id: webCard.id, repo: 'acme/app' })).text, /can’t push to acme\/app/)

    // Its owner loses push meanwhile: no fresh token.
    owners['you/acme/web'] = 'read'
    assert.match((await builder.call('repo_token', { id: webCard.id })).text, /can’t push to acme\/web/)
    await builder.client.close()
    await close()
  })
})

describe('agents handing work on', () => {
  it('gives a card to another agent when a person asks one to, and a limit to binders gone since limits nothing', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    const chat = await you('POST', '/api/agents', { name: 'Chat', binders: ['gone'] })
    const builder = await you('POST', '/api/agents', { name: 'Builder' })
    const card = (await you('POST', '/api/cards', { binderId: hub.state.binders[0].id, title: 'Redesign the stat boxes' })).body
    const talker = await agentClient(url, chat.body.token)
    assert.ok((await talker.call('list_binders')).value.length > 0, 'its only binder is gone: it works in every one')
    assert.match((await talker.call('assign_task', { id: card.id, agent: 'Nobody' })).text, /No agent Nobody\. These are: Chat, Builder/)
    assert.match((await talker.call('assign_task', { id: card.id, agent: 'builder' })).text, /Gave “Redesign the stat boxes” to Builder/)
    assert.equal(hub.state.cards.find((c) => c.id === card.id)?.meantFor, builder.body.agent.id)
    const worker = await agentClient(url, builder.body.token)
    const offered = await worker.call('wait_for_work', { timeout_seconds: 0 })
    assert.equal(offered.value.id, card.id, 'its runner is offered it')
    for (const c of [talker, worker]) await c.client.close()
    await close()
  })
})

describe('agents setting agents up', () => {
  it('sets up an agent for its owner within its own reach, and the new one works with the token it gets', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    const binder = hub.state.binders[0]
    const lead = await you('POST', '/api/agents', { name: 'Lead', repos: ['acme/web', 'acme/app'], binders: [binder.id] })
    await you('PATCH', `/api/agents/${lead.body.agent.id}`, { runner: { tool: 'claude', access: 'auto', timeoutMinutes: 45, parallel: 2 } })
    const manager = await agentClient(url, lead.body.token)

    assert.match((await manager.call('create_agent', { name: 'Wide', repos: ['acme/other'] })).text, /works there at most, not in acme\/other/)
    assert.match((await manager.call('create_agent', { name: 'Loose', access: 'full' })).text, /auto access: an agent you set up has that at most/)
    assert.match((await manager.call('create_agent', { name: 'lead' })).text, /There’s an agent called lead already/)

    const made = await manager.call('create_agent', { name: 'Reviewer', tool: 'codex', access: 'edits', repos: ['acme/web'], skills: ['review'] })
    assert.ok(!made.error, made.text)
    const agent = hub.state.agents.find((a) => a.name === 'Reviewer')!
    assert.equal(agent.owner, 'you')
    assert.equal(agent.provider, 'openai')
    assert.deepEqual(agent.repos, ['acme/web'])
    assert.deepEqual(agent.binders, [binder.id], 'its binders: the lead’s')
    assert.deepEqual([agent.runner?.tool, agent.runner?.access, agent.runner?.timeoutMinutes], ['codex', 'edits', 45])
    const token = String(made.value.token)
    assert.ok(String(made.value.start_runner).includes(`/install | sh -s -- add --token ${token} `))

    const reviewer = await agentClient(url, token)
    assert.equal((await reviewer.call('whoami')).value.name, 'Reviewer')
    for (const c of [manager, reviewer]) await c.client.close()
    await close()
  })
})

describe('an agent’s runners', () => {
  it('lets only the owner of the agent that asked answer a permission, and nobody write one', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    const them = api(url, await signIn(url, 'them'))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'p0', change: { type: 'binder.put', binder: { id: 'pb', name: 'Perms' } } }] })
    const mine = await you('POST', '/api/agents', { name: 'Mine' })
    const theirs = await them('POST', '/api/agents', { name: 'Theirs' })
    const card = (await you('POST', '/api/cards', { binderId: 'pb', title: 'Publish it' })).body
    const agent = await agentClient(url, mine.body.token)
    assert.equal((await agent.call('claim_task', { id: card.id })).error, false)
    assert.equal((await agent.call('ask_permission', { id: card.id, request: 'r1', tool: 'Bash', what: 'npm publish' })).error, false)
    const stored = () => hub.state.cards.find((c) => c.id === card.id)!
    assert.equal(stored().permission?.agent, mine.body.agent.id)

    // Nobody writes an answer straight into the card, not even its owner.
    const written = { ...stored().permission!, answer: 'allow', by: 'them' }
    for (const change of [{ type: 'card.update', id: card.id, fields: { permission: written } }, { type: 'card.put', card: { ...stored(), permission: written } }]) {
      assert.equal((await them('POST', '/api/changes', { client: 'tab-5678', changes: [{ id: `w-${change.type}`, change }] })).status, 422, change.type)
      assert.equal(stored().permission?.answer, undefined)
    }
    assert.equal((await them('POST', `/api/cards/${card.id}/permission`, { request: 'r1', allow: true })).status, 422, 'not their agent')
    assert.equal((await you('POST', `/api/cards/${card.id}/permission`, { request: 'nope', allow: true })).status, 422, 'not what’s waiting')
    // The agent can't answer itself, or change what's waiting.
    assert.equal((await agent.call('ask_permission', { id: card.id, request: 'r1', tool: 'Bash', what: 'ls' })).error, true)
    assert.equal(stored().permission?.what, 'npm publish')
    assert.equal((await agent.call('ask_permission', { id: card.id, request: 'long', tool: 'Bash', what: 'x'.repeat(4001) })).error, true)

    // Given to another agent, the question is gone: the new holder's owner can't answer on the first one's machine.
    assert.equal((await them('POST', '/api/changes', { client: 'tab-5678', changes: [{ id: 'give', change: { type: 'card.update', id: card.id, fields: { agentId: theirs.body.agent.id } } }] })).status, 200)
    assert.equal(stored().permission, undefined)
    assert.equal((await them('POST', `/api/cards/${card.id}/permission`, { request: 'r1', allow: true })).status, 422)
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'back', change: { type: 'card.update', id: card.id, fields: { agentId: mine.body.agent.id } } }] })

    // Answered: on the card's record, and not taken for a person writing to the agent.
    assert.equal((await agent.call('ask_permission', { id: card.id, request: 'r2', tool: 'Bash', what: 'npm publish' })).error, false)
    assert.equal((await you('POST', `/api/cards/${card.id}/permission`, { request: 'r2', allow: true })).status, 200)
    assert.equal(stored().permission?.answer, 'allow')
    assert.equal(stored().activity.at(-1)?.kind, 'permission')
    const read = (await agent.call('get_task', { id: card.id })).value as unknown as { conversation: unknown[]; permission: { answer: string } }
    assert.equal(read.permission.answer, 'allow')
    assert.equal(read.conversation.length, 0)
    // And gone once the run has moved on, even where nothing clears a field but the log.
    assert.equal((await agent.call('end_permission', { id: card.id, request: 'r2' })).error, false)
    assert.equal(stored().permission, undefined)
    await agent.client.close()
    await close()
  })

  it('tells a runner that starts beside another for the same agent, and counts them', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    const made = await you('POST', '/api/agents', { name: 'Twice' })
    const first = await agentClient(url, made.body.token)
    const second = await agentClient(url, made.body.token)
    assert.equal((await first.call('update_profile', { runner: { version: '0.6.3', parallel: 1, id: 'aaa' } })).value.other_runners, undefined, 'alone')
    await first.call('wait_for_work', { timeout_seconds: 0, runner_id: 'aaa' })
    const told = await second.call('update_profile', { runner: { version: '0.6.3', parallel: 1, id: 'bbb' } })
    assert.equal((told.value.other_runners as unknown[]).length, 1, 'the second hears of the first')
    assert.equal(hub.presence()[made.body.agent.id]?.runners, 2)
    // One saying it's gone isn't counted, so the runner that replaces it isn't taken for a second.
    await first.call('update_profile', { runner: { version: '0.6.3', parallel: 1, id: 'aaa', gone: true } })
    assert.equal(hub.presence()[made.body.agent.id]?.runners, 1)
    assert.equal((await first.call('update_profile', { runs_on: 'mac · ~/code', runner: { version: '0.6.3', parallel: 1, id: 'ccc' } })).value.other_runners && hub.presence()[made.body.agent.id]?.runnersOn?.includes('mac · ~/code'), true, 'and it says where they run')
    for (const c of [first, second]) await c.client.close()
    await close()
  })
})

describe('an agent giving a card up', () => {
  it('isn’t offered it again for a while, so a runner that can’t start it doesn’t loop', async () => {
    const { url, close } = await setUp()
    const you = api(url, await signIn(url))
    const made = await you('POST', '/api/agents', { name: 'Looper' })
    const card = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Needs a worktree', meantFor: made.body.agent.id })).body
    const looper = await agentClient(url, made.body.token)
    assert.equal((await looper.call('wait_for_work', { timeout_seconds: 0 })).value.id, card.id)
    await looper.call('claim_task', { id: card.id })
    await looper.call('release_task', { id: card.id, reason: 'Couldn’t make its worktree: fatal: already checked out' })
    assert.equal((await looper.call('wait_for_work', { timeout_seconds: 0 })).text, 'nothing yet')
    await looper.client.close()
    await close()
  })
})

describe('agents over MCP', () => {
  it('finds work, takes it, reports, asks, finishes with a pull request, and ships it', async () => {
    const github = await fakeGitHub()
    const { url, hub, actions, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const made = await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'It does.' })
    assert.equal(made.status, 200)
    const cardId = made.body.id as string

    // The card becomes an issue in the binder's repo.
    await until(() => !!hub.state.cards.find((c) => c.id === cardId)?.issue)
    assert.ok(github.calls.some((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues'))

    const first = await you('POST', '/api/agents', { name: 'Builder', provider: 'claude', skills: ['TypeScript'] })
    const second = await you('POST', '/api/agents', { name: 'Other' })
    assert.match(first.body.token, /^bnd_/)
    const builder = await agentClient(url, first.body.token)
    const other = await agentClient(url, second.body.token)

    const tools = (await builder.client.listTools()).tools.map((t) => t.name)
    for (const name of ['whoami', 'wait_for_work', 'claim_task', 'report_progress', 'ask', 'complete_task', 'propose_work_items', 'get_note']) assert.ok(tools.includes(name), name)
    assert.equal((await builder.call('whoami')).value.name, 'Builder')

    const work = await builder.call('wait_for_work', { timeout_seconds: 1 })
    assert.equal(work.value.id, cardId)
    assert.equal((await builder.call('claim_task', { id: cardId })).value.stage, 'working')
    const lost = await other.call('claim_task', { id: cardId })
    assert.equal(lost.error, true)
    assert.match(lost.text, /Another agent took that card first/)

    await builder.call('report_progress', { id: cardId, doing: 'Writing the route', progress: 0.4, plan: [{ text: 'Route', done: true }, { text: 'Test', done: false }], steps: [{ tool: 'Edit', text: 'src/server.ts', result: '+8 −0' }, { tool: 'Bash', text: 'npm test', result: '✓ 3 passed' }] })
    let card = hub.state.cards.find((c) => c.id === cardId)!
    assert.equal(card.doing, 'Writing the route')
    assert.equal(card.plan?.length, 2)
    assert.deepEqual(card.activity.filter((a) => a.kind === 'step').map((a) => a.tool), ['Edit', 'Bash'])

    await builder.call('ask', { id: cardId, question: 'Should /health check Redis?' })
    assert.equal(hub.state.cards.find((c) => c.id === cardId)!.needsYou, 'Should /health check Redis?')
    assert.equal(hub.state.cards.find((c) => c.id === cardId)!.stage, 'blocked', 'waiting on a person: blocked')
    await you('POST', `/api/cards/${cardId}/comment`, { text: 'No, keep it cheap. /ready checks Redis.' })
    assert.equal(hub.state.cards.find((c) => c.id === cardId)!.stage, 'working', 'answered: back to working')
    const task = await builder.call('get_task', { id: cardId })
    assert.equal(task.value.needs_you, undefined)
    assert.match(JSON.stringify(task.value.conversation), /keep it cheap/)

    const done = await builder.call('complete_task', { id: cardId, summary: 'Added /health with a test.', pull_request: 'acme/web#7' })
    assert.equal(done.value.stage, 'review')
    assert.ok(hub.state.cards.find((c) => c.id === cardId)!.plan!.every((step) => step.done), 'finishing ticks off the plan')
    card = hub.state.cards.find((c) => c.id === cardId)!
    const pull = hub.state.pulls.find((p) => p.id === 'acme/web#7')!
    assert.equal(pull.cardId, cardId)
    assert.equal(pull.checks[0].state, 'passed', 'checks read from GitHub')
    assert.equal(pull.files[0].path, 'src/a.ts')
    const set = hub.state.changeSets.find((s) => s.prIds.includes(pull.id))!
    assert.equal(set.state, 'assembling')

    const approved = await you('POST', `/api/sets/${set.id}/approve`)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    const merges = github.calls.filter((c) => c.path.endsWith('/merge') || c.path.endsWith('/reviews')).map((c) => `${c.method} ${c.path}`)
    assert.deepEqual(merges, ['POST /repos/acme/web/pulls/7/reviews', 'PUT /repos/acme/web/pulls/7/merge'])
    assert.equal(hub.state.pulls.find((p) => p.id === pull.id)!.state, 'merged')
    assert.equal(hub.state.pulls.find((p) => p.id === pull.id)!.mergeSha, 'merged7', 'the merge commit GitHub made is kept')
    assert.equal(hub.state.cards.find((c) => c.id === cardId)!.stage, 'live', 'merged is done')
    // Merged is as far as the hub takes it: nothing is deployed, or made up, until GitHub says so.
    assert.equal(hub.state.environments.length, 0)
    assert.equal(hub.state.changeSets.find((s) => s.id === set.id)!.state, 'merged')
    assert.equal((await builder.call('get_task', { id: cardId })).value.stage, 'done', 'agents read it as done')
    assert.equal((await builder.call('list_tasks', { stage: 'done' })).value.length, 1)

    // GitHub deploys it: the environment is found, the pull request is on it, and the change set has shipped.
    github.world.compares['merged7...abc1234def'] = { commits: [], status: 'ahead' }
    await actions.deploymentSeen('acme/web', { environment: 'production', ref: 'v1.0.0', sha: 'abc1234def', state: 'success' })
    assert.deepEqual(hub.state.environments.map((e) => [e.id, e.version, e.pullIds]), [['acme/web#production', 'v1.0.0', ['acme/web#7']]])
    assert.equal(hub.state.changeSets.find((s) => s.id === set.id)!.state, 'shipped')

    // Deleted, though shipped: gone from the hub and its environments, with its card kept and nothing asked of GitHub.
    // The card's issue carries on being saved in the background, whatever happens to its set.
    const asked = () => github.calls.filter((c) => !c.path.includes('/issues')).length
    const askedGitHub = asked()
    const deleted = await you('DELETE', `/api/sets/${set.id}`)
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.ok(!hub.state.changeSets.some((s) => s.id === set.id))
    assert.ok(hub.state.environments.every((e) => !e.changeSetIds.includes(set.id)))
    assert.equal(hub.state.cards.find((c) => c.id === cardId)!.stage, 'live')
    assert.equal(hub.state.pulls.find((p) => p.id === pull.id)!.state, 'merged')
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(asked(), askedGitHub)
    assert.equal((await you('DELETE', `/api/sets/${set.id}`)).status, 422, 'it’s gone')

    // Revoked: its token stops working at once.
    await you('DELETE', `/api/agents/${second.body.agent.id}`)
    const revoked = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${second.body.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(revoked.status, 403)

    await builder.client.close()
    await other.client.close()
    await close()
    await github.close()
  })

  it('gathers a card’s Change Set: its worktree’s diff before a pull request, the pull request’s after', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'It does, with a test.' })).body.id as string
    const { body } = await you('POST', '/api/agents', { name: 'Builder' })
    const builder = await agentClient(url, body.token)
    await builder.call('claim_task', { id: cardId })
    await builder.call('report_progress', { id: cardId, doing: 'Writing the route', steps: [{ tool: 'Edit', text: 'src/server.ts', result: '+3 −0' }], said: 'Adding /health.' })

    // In progress, no pull request yet, nothing from the runner: the brief, done-when and log, and no diff.
    let set = (await you('GET', `/api/cards/${cardId}/change-set`)).body
    assert.equal(set.source, 'none')
    assert.deepEqual(set.files, [])

    // The runner sends its worktree's diff; the same diff again records nothing.
    const diff = ['diff --git a/src/server.ts b/src/server.ts', 'index 1..2 100644', '--- a/src/server.ts', '+++ b/src/server.ts', '@@ -1,2 +1,4 @@', ' const app = server()', '-app.listen()', '+app.get(\'/health\', () => ({ ok: true }))', '+app.listen()', '+// health', 'diff --git a/test/health.test.ts b/test/health.test.ts', 'new file mode 100644', '--- /dev/null', '+++ b/test/health.test.ts', '@@ -0,0 +1 @@', '+test(\'health\')', ''].join('\n')
    const sent = await builder.call('report_diff', { id: cardId, branch: 'binders/' + cardId, base: 'abc123', diff })
    assert.equal(sent.value.files, 2)
    const version = hub.version
    await builder.call('report_diff', { id: cardId, branch: 'binders/' + cardId, base: 'abc123', diff })
    assert.equal(hub.version, version, 'an unchanged diff isn’t recorded again')

    set = (await you('GET', `/api/cards/${cardId}/change-set`)).body
    assert.equal(set.card.stage, 'working')
    assert.equal(set.source, 'worktree')
    assert.equal(set.worktree.branch, `binders/${cardId}`)
    assert.equal(set.worktree.base, 'abc123')
    assert.deepEqual(set.files.map((f: { path: string; added: number; removed: number }) => [f.path, f.added, f.removed]), [['src/server.ts', 3, 1], ['test/health.test.ts', 1, 0]])
    assert.equal(set.added, 4)
    assert.equal(set.removed, 1)
    assert.equal(set.brief, 'GET /health answers 200.')
    assert.equal(set.doneWhen, 'It does, with a test.')
    assert.equal(set.doing, 'Writing the route')
    assert.ok(set.log.some((a: { kind: string; text: string }) => a.kind === 'step' && a.text === 'src/server.ts'))
    assert.ok(set.log.some((a: { kind: string; text: string }) => a.kind === 'said' && a.text === 'Adding /health.'))

    // With a pull request, in review: its diff from GitHub, not the worktree's.
    await builder.call('complete_task', { id: cardId, summary: 'Added /health.', pull_request: 'acme/web#7' })
    set = (await you('GET', `/api/cards/${cardId}/change-set`)).body
    assert.equal(set.card.stage, 'review')
    assert.equal(set.source, 'pull')
    assert.equal(set.worktree, undefined)
    assert.equal(set.pull.id, 'acme/web#7')
    assert.equal(set.pull.checks[0].state, 'passed')
    assert.deepEqual(set.files.map((f: { path: string }) => f.path), ['src/a.ts'])
    assert.deepEqual(set.files[0].lines.map((l: { kind: string }) => l.kind), ['@', ' ', '-', '+', '+'])
    assert.equal(set.doneWhen, 'It does, with a test.')
    assert.ok(set.log.some((a: { kind: string }) => a.kind === 'completed'))

    // A pull request whose files haven't come from GitHub doesn't hide the worktree's diff.
    const worktree = { branch: `binders/${cardId}`, base: 'abc123', at: 'now', files: [{ path: 'src/server.ts', added: 1, removed: 0, lines: [] }] }
    const unread = cardChangeSet({ ...hub.state, pulls: hub.state.pulls.map((p) => ({ ...p, files: [] })), cards: hub.state.cards.map((c) => (c.id === cardId ? { ...c, worktree } : c)) }, cardId)!
    assert.equal(unread.source, 'worktree')
    assert.deepEqual(unread.files.map((f) => f.path), ['src/server.ts'])

    assert.equal((await you('GET', '/api/cards/nope/change-set')).status, 422)
    await builder.client.close()
    await close()
    await github.close()
  })

  it('writes a card’s debrief when a person asks: an agent that’s free reads its Change Set and sends five sections', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'GET /health answers 200. A test covers it.' })).body.id as string
    const builderMade = await you('POST', '/api/agents', { name: 'Builder' })
    const writerMade = await you('POST', '/api/agents', { name: 'Writer' })
    const builder = await agentClient(url, builderMade.body.token)
    const writer = await agentClient(url, writerMade.body.token)
    await builder.call('claim_task', { id: cardId })

    // Only while it's being built or in review.
    const ready = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Later', meantFor: builderMade.body.agent.id })).body.id as string
    assert.equal((await you('POST', `/api/cards/${ready}/debrief`)).status, 422)

    await builder.call('complete_task', { id: cardId, summary: 'Added /health.', pull_request: 'acme/web#7' })
    await until(() => !!hub.state.cards.find((c) => c.id === cardId)?.issue)
    const issueNumber = hub.state.cards.find((c) => c.id === cardId)!.issue!.number
    const issueWrites = () => github.calls.filter((c) => c.method === 'PATCH' && c.path === `/repos/acme/web/issues/${issueNumber}`).length
    const commentCalls = () => github.calls.filter((c) => c.path.startsWith('/repos/acme/web/issues/') && c.path.includes('comments'))
    await sleep(300)
    const writesBefore = issueWrites()

    // Writer is listening and free, so the hub gives it to Writer, and only when it says it writes debriefs.
    const waiting = writer.call('wait_for_work', { timeout_seconds: 3, debriefs: true })
    await until(() => !!hub.presence()[writerMade.body.agent.id]?.listening)
    const asked = await you('POST', `/api/cards/${cardId}/debrief`)
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(asked.body.state, 'asked')
    assert.equal(asked.body.agentId, writerMade.body.agent.id)
    const found = (await waiting).value
    assert.equal(found.kind, 'debrief')
    // The card's in a change set: the debrief is of the whole set (its id), and goes on the card too once written.
    const setId = hub.state.changeSets.find((s) => s.prIds.includes(hub.state.cards.find((c) => c.id === cardId)!.prId!))!.id
    assert.equal(found.id, setId)
    assert.match(String(found.title), /^Change set #\d+: /)
    assert.equal(found.effort, 'low', 'a small change: low reasoning, picked by its size')
    assert.equal((await you('POST', `/api/cards/${cardId}/debrief`)).status, 422, 'one at a time')
    assert.notEqual((await writer.call('wait_for_work', { timeout_seconds: 0 })).value.kind, 'debrief', 'only to an agent that says it writes debriefs')
    assert.equal((await builder.call('send_debrief', { id: cardId, doing: 'Reading' })).error, true, 'only its own agent sends it')

    await writer.call('send_debrief', { id: cardId, doing: 'Reading the Change Set' })
    assert.equal(hub.state.changeSets.find((s) => s.id === setId)!.debrief!.state, 'writing', 'named by its card, the set’s debrief')
    assert.equal((await writer.call('wait_for_work', { timeout_seconds: 0, debriefs: true })).text, 'nothing yet', 'a debrief it has started isn’t given again')

    const set = (await writer.call('get_change_set', { id: cardId })).value
    assert.deepEqual(set.done_when_points, ['GET /health answers 200.', 'A test covers it.'])
    assert.equal(set.source, 'pull')
    assert.deepEqual((set.files as { path: string }[]).map((f) => f.path), ['src/a.ts'])
    assert.equal((set.card as { agent: string }).agent, 'Builder')

    // Missing a section or a done-when point goes back to the agent.
    const sections = { does: 'Adds GET /health, answering 200 with { ok: true }.', changes: [{ area: 'Server', what: 'A /health route.' }], look_at: ['Nothing checks Redis: /ready does.'], try_it: 'npm start, then curl localhost:8080/health.' }
    const short = await writer.call('send_debrief', { id: cardId, ...sections, against: [{ point: 'Answers 200', mark: 'met', where: 'src/a.ts' }] })
    assert.equal(short.error, true)
    assert.match(short.text, /a mark for each done-when point \(none yet for “GET \/health answers 200\.”, “A test covers it\.”\)/)
    const noTry = await writer.call('send_debrief', { id: cardId, ...sections, try_it: ' ', against: [{ point: 'a', mark: 'met', where: 'src/a.ts' }, { point: 'b', mark: 'not met', where: 'No test.' }] })
    assert.match(noTry.text, /try_it/)

    // Read a file at a time and written as it goes, so no one answer holds it all; finished with what's left.
    const outline = (await writer.call('get_change_set', { id: cardId, outline: true })).value
    assert.deepEqual(outline.files, [{ path: 'src/a.ts', added: 2, removed: 1, parts: 1 }], 'each file’s size, not its diff')
    const one = (await writer.call('get_change_set', { id: cardId, file: 'b/src/a.ts' })).value
    assert.equal(one.path, 'src/a.ts')
    assert.match(String(one.diff), /\+c/)
    assert.equal(one.parts, 1)
    const added = await writer.call('add_to_debrief', { id: cardId, changes: sections.changes, against: [{ point: 'GET /health answers 200', mark: 'met', where: 'src/a.ts' }] })
    assert.match(added.text, /Kept: 1 area, 1 done-when point, 0 things to look at/)
    assert.match(hub.state.changeSets.find((s) => s.id === setId)!.debrief!.doing ?? '', /1 area, 1 point so far/)
    const sent = await writer.call('send_debrief', { id: cardId, does: sections.does, look_at: sections.look_at, try_it: sections.try_it, against: [{ point: 'A test covers it', mark: 'partly met', where: 'A test, but not of the body.' }] })
    assert.equal(sent.error, false, sent.text)
    const debrief = hub.state.cards.find((c) => c.id === cardId)!.debrief!
    assert.equal(debrief.state, 'done')
    assert.equal(debrief.source, 'pull')
    assert.equal(debrief.does, sections.does)
    assert.deepEqual(debrief.changes, sections.changes)
    assert.deepEqual(debrief.against!.map((p) => [p.point, p.mark]), [['GET /health answers 200.', 'met'], ['A test covers it.', 'partly met']], 'the card’s own words for each point')
    assert.deepEqual(debrief.lookAt, sections.look_at)
    assert.equal(debrief.tryIt, sections.try_it)
    assert.deepEqual(hub.state.cards.find((c) => c.id === cardId)!.activity.filter((a) => a.kind === 'debrief').map((a) => a.text), ['Asked Writer for a debrief, at low reasoning for 3 changed lines (change set #1)', 'Wrote the debrief: 1 of 2 met (change set #1)'])
    assert.equal(debrief.fromSet, setId, 'the card’s copy of its set’s debrief')
    assert.equal((await writer.call('send_debrief', { id: cardId, ...sections })).error, true, 'nothing waits for it now')

    // Kept on GitHub too: a comment on the card's issue, with its five sections, so it's there with Binders off.
    await until(() => !!hub.state.cards.find((c) => c.id === cardId)!.debrief!.comment)
    const posted = commentCalls()
    assert.deepEqual(posted.map((c) => [c.method, c.path]), [['POST', `/repos/acme/web/issues/${issueNumber}/comments`]])
    const markdown = String(posted[0].body!.body)
    for (const words of ['### Debrief: 1 of 2 done-when points met', sections.does, '**Server:** A /health route.', '🟡 **partly met:** A test covers it. (A test, but not of the body.)', sections.look_at[0], sections.try_it, `<!-- binders {"debrief":"${cardId}"} -->`]) assert.ok(markdown.includes(words), `the comment has ${words}`)
    const kept = hub.state.cards.find((c) => c.id === cardId)!.debrief!
    assert.equal(kept.comment!.writtenAt, kept.writtenAt)
    assert.match(kept.comment!.url, /#issuecomment-/)

    // Read back to be spoken, by an agent (the talk-to-myself loop) and over the API.
    const read = (await builder.call('get_debrief', { id: cardId })).value
    assert.equal(read.state, 'done')
    assert.equal(read.by, 'Writer')
    assert.equal(read.on_github, kept.comment!.url)
    assert.match(String(read.speech), /^Debrief of change set 1, by Writer\. What it does: Adds GET \/health/, 'its change set’s')
    assert.match(String(read.speech), /1 of 2 done-when points are met\. Met: GET \/health answers 200\. Partly met: A test covers it\. A test, but not of the body\./)
    assert.doesNotMatch(String(read.speech), /[`*#]/)
    const viaApi = await you('GET', `/api/cards/${cardId}/debrief`)
    assert.equal(viaApi.status, 200)
    assert.equal(viaApi.body.speech, read.speech)
    assert.equal((await you('GET', `/api/cards/${ready}/debrief`)).status, 422, 'a card with none says so')
    assert.match((await builder.call('get_debrief', { id: ready })).text, /has no debrief/)

    // Asked again, with an agent named: the last one stays until the new one is written, or the agent can't.
    const again = await you('POST', `/api/cards/${cardId}/debrief`, { agentId: builderMade.body.agent.id })
    assert.equal(again.body.state, 'asked')
    assert.equal(again.body.does, sections.does)
    assert.equal((await builder.call('wait_for_work', { timeout_seconds: 0, debriefs: true })).value.kind, 'debrief')
    await builder.call('send_debrief', { id: cardId, failed: 'The pull request was closed.' })
    const failed = hub.state.changeSets.find((s) => s.id === setId)!.debrief!
    assert.equal(failed.state, 'failed', 'on the set')
    assert.equal(failed.failed, 'The pull request was closed.')
    const onCard = hub.state.cards.find((c) => c.id === cardId)!.debrief!
    assert.equal(onCard.state, 'done', 'the card keeps the last one written')

    assert.equal(onCard.comment!.id, kept.comment!.id, 'the comment stays with the last one written')

    // Written again: the same comment is edited, not a second one made.
    await you('POST', `/api/cards/${cardId}/debrief`, { agentId: builderMade.body.agent.id })
    await builder.call('send_debrief', { id: cardId, ...sections, does: 'Adds GET /health, now with a test of its body.', against: [{ point: 'a', mark: 'met', where: 'src/a.ts' }, { point: 'b', mark: 'met', where: 'test/a.test.ts' }] })
    await until(() => { const d = hub.state.cards.find((c) => c.id === cardId)!.debrief!; return d.comment?.writtenAt === d.writtenAt })
    await sleep(100)
    const edits = commentCalls().slice(1)
    assert.deepEqual(edits.map((c) => [c.method, c.path]), [['PATCH', `/repos/acme/web/issues/comments/${kept.comment!.id}`]])
    assert.match(String(edits[0].body!.body), /2 of 2 done-when points met[\s\S]*now with a test of its body/)

    await sleep(300)
    assert.equal(issueWrites(), writesBefore, 'a debrief isn’t written into the card’s issue body')

    await builder.client.close()
    await writer.client.close()
    await close()
    await github.close()
  })

  it('debriefs and challenges a whole change set: every pull request together, findings back to each card', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const made = async (name: string) => {
      const { body } = await you('POST', '/api/agents', { name })
      return { id: body.agent.id as string, ...(await agentClient(url, body.token)) }
    }
    const builder = await made('Builder')
    const reviewer = await made('Reviewer')
    // Two cards, each with its pull request, in one change set.
    const ids: string[] = []
    for (const [title, done, number] of [['Add a health check', 'GET /health answers 200.', 7], ['Add a readiness check', 'GET /ready checks Redis.', 8]] as const) {
      const id = (await you('POST', '/api/cards', { binderId: 'b1', title, brief: `${title}.`, doneWhen: done })).body.id as string
      await builder.call('claim_task', { id })
      await builder.call('complete_task', { id, summary: 'Done.', pull_request: `acme/web#${number}` })
      ids.push(id)
    }
    const set = hub.state.changeSets.find((s) => s.prIds.length === 2)!
    assert.deepEqual(set.prIds, ['acme/web#7', 'acme/web#8'])

    // Asked from one of its cards, it's the set's.
    const asked = await you('POST', `/api/cards/${ids[0]}/challenge`, { agentId: reviewer.id })
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(hub.state.changeSets.find((s) => s.id === set.id)!.challenge!.state, 'asked')
    assert.equal((await you('POST', `/api/sets/${set.id}/challenge`)).status, 422, 'one at a time')
    const job = (await reviewer.call('wait_for_work', { timeout_seconds: 0, challenges: true })).value
    assert.deepEqual([job.kind, job.id], ['challenge', set.id])
    const view = (await reviewer.call('get_challenge_set', { id: set.id })).value
    assert.deepEqual((view.files as { path: string }[]).map((f) => f.path), ['acme/web#7: src/a.ts', 'acme/web#8: src/a.ts'], 'each file with its pull request')
    assert.deepEqual(view.done_when_points, ['Add a health check: GET /health answers 200.', 'Add a readiness check: GET /ready checks Redis.'])
    assert.equal((view.pulls as unknown[]).length, 2)

    // Each finding names its pull request; one that doesn't goes back.
    const finding = { kind: 'bug', line: 2, what: 'Both checks register the same route.', confidence: 'confirmed', severity: 'high' }
    const refused = (await reviewer.call('send_challenge', { id: set.id, findings: [{ ...finding, file: 'src/a.ts' }] })).text
    assert.match(refused, /with its pull request/)
    assert.match(refused, /acme\/web#7, acme\/web#8/, 'says which there are')
    assert.match(refused, /“src\/a\.ts”/, 'and what it was sent')
    // What a finished run wrote can't be asked again: kept on the likeliest pull request, saying so, rather than lost.
    const onePlaced = await reviewer.call('send_challenge', { id: set.id, summary: 'From a run that’s over.', place_unmatched: true, findings: [{ ...finding, file: 'lib/outside.ts' }] })
    assert.equal(onePlaced.text, 'Sent: 1 finding.')
    const placed = hub.state.changeSets.find((s) => s.id === set.id)!.challenge!.findings![0]
    assert.equal(placed.pull, 'acme/web#7')
    assert.match(placed.what, /named lib\/outside\.ts, which isn’t in this change set’s diffs/)
    assert.equal((await you('POST', `/api/sets/${set.id}/challenge`)).status, 200, 'asked again, for the rest of this test')
    assert.equal((await reviewer.call('wait_for_work', { timeout_seconds: 0, challenges: true })).value.id, set.id)
    const sent = await reviewer.call('send_challenge', { id: set.id, summary: 'They clash.', findings: [{ ...finding, file: 'acme/web#7: src/a.ts' }, { ...finding, severity: 'low', confidence: 'plausible', what: 'Untested.', file: 'acme/web#8: src/a.ts', line: 3 }] })
    assert.equal(sent.text, 'Sent: 2 findings.')
    const whole = hub.state.changeSets.find((s) => s.id === set.id)!.challenge!
    assert.deepEqual(whole.findings!.map((f) => [f.pull, f.file]), [['acme/web#7', 'src/a.ts'], ['acme/web#8', 'src/a.ts']])
    const [first, second] = ids.map((id) => hub.state.cards.find((c) => c.id === id)!.challenge!)
    assert.deepEqual([first.fromSet, first.findings!.map((f) => f.pull)], [set.id, ['acme/web#7']], 'each card gets the findings on its own pull request')
    assert.deepEqual(second.findings!.map((f) => f.pull), ['acme/web#8'])
    // Acted on per card, as a card's own are.
    assert.equal((await you('POST', `/api/cards/${ids[1]}/findings/${second.findings![0].id}`, { action: 'dismiss' })).status, 200)

    // Its debrief too: of both, every card's done-when points marked, then on each card.
    await you('POST', `/api/sets/${set.id}/debrief`, { agentId: builder.id })
    assert.equal((await builder.call('wait_for_work', { timeout_seconds: 0, debriefs: true })).value.id, set.id)
    const sections = { does: 'Two checks.', changes: [{ area: 'Server', what: 'Two routes.' }], look_at: [], try_it: 'curl them.' }
    const plan = [
      { title: 'Health answers 200', point: 'add a health check: get /health answers 200.', steps: ['curl -i https://preview/health'], expect: 'HTTP 200.', risk: 'high' },
      { title: 'No steps, so left out', steps: [], expect: 'Nothing.' },
      { title: 'Ready fails without Redis', setup: 'Stop Redis.', steps: ['curl -i https://preview/ready'], expect: 'HTTP 503.', risk: 'wild' },
    ]
    const secret = await builder.call('send_debrief', { id: set.id, ...sections, against: [{ point: 'a', mark: 'met', where: 'src/a.ts' }, { point: 'b', mark: 'not met', where: 'Missing.' }], test_plan: [{ ...plan[0], setup: `Use the token ghp_${'a'.repeat(36)}` }] })
    assert.match(secret.text, /looks like a secret/, 'a secret in the plan sends it back')
    const wrote = await builder.call('send_debrief', { id: set.id, ...sections, against: [{ point: 'a', mark: 'met', where: 'src/a.ts' }, { point: 'b', mark: 'not met', where: 'Missing.' }], test_plan: plan })
    assert.equal(wrote.error, false, wrote.text)
    assert.match(wrote.text, /2 functional tests/)
    const kept = hub.state.changeSets.find((s) => s.id === set.id)!.debrief!
    assert.deepEqual(kept.against!.map((p) => p.point), ['Add a health check: GET /health answers 200.', 'Add a readiness check: GET /ready checks Redis.'])
    assert.deepEqual(kept.testPlan!.map((t) => [t.id, t.title, t.point, t.risk]), [['t1', 'Health answers 200', 'Add a health check: GET /health answers 200.', 'high'], ['t2', 'Ready fails without Redis', undefined, undefined]], 'numbered, a test without steps left out, a point in the card’s words, a risk it doesn’t know dropped')
    for (const id of ids) assert.equal(hub.state.cards.find((c) => c.id === id)!.debrief!.fromSet, set.id)
    for (const id of ids) assert.equal(hub.state.cards.find((c) => c.id === id)!.debrief!.testPlan!.length, 2, 'each card has the plan')

    // Whoever runs a test records how it went, as themselves, on the set and every card of it; marked again, it's cleared.
    const result = (test: string, by: string, outcome: string | null) => ({ type: 'test.result', id: ids[0], test, result: outcome ? { outcome, note: outcome === 'failed' ? 'Answers 500.' : undefined, by, at: new Date().toISOString() } : null })
    const send = (change: unknown, n: number) => you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: `t-${n}`, change }] })
    assert.equal((await send(result('t1', 'someone-else', 'passed'), 1)).status, 422, 'only as yourself')
    assert.equal((await send(result('t9', 'you', 'passed'), 2)).status, 422, 'only a test the plan has')
    assert.equal((await send({ ...result('t1', 'you', 'passed'), result: { outcome: 'maybe', by: 'you', at: 'now' } }, 3)).status, 422, 'passed or failed')
    assert.equal((await send(result('t1', 'you', 'passed'), 4)).status, 200)
    assert.equal((await send(result('t2', 'you', 'failed'), 5)).status, 200)
    const now = () => hub.state.changeSets.find((s) => s.id === set.id)!.debrief!.testPlan!
    assert.deepEqual(now().map((t) => [t.result?.outcome, t.result?.by, t.result?.note]), [['passed', 'you', undefined], ['failed', 'you', 'Answers 500.']])
    for (const id of ids) assert.deepEqual(hub.state.cards.find((c) => c.id === id)!.debrief!.testPlan!.map((t) => t.result?.outcome), ['passed', 'failed'])
    assert.equal((await send(result('t2', 'you', null), 6)).status, 200)
    assert.equal(now()[1].result, undefined, 'cleared')
    assert.match((await builder.call('get_debrief', { id: ids[0] })).text, /Health answers 200/, 'agents read the plan back')
    for (const agent of [builder, reviewer]) await agent.client.close()
    await close()
    await github.close()
  })

  it('challenges a card with an agent that didn’t write it, which never sees the author’s plan or log, and keeps its findings', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'GET /health answers 200. A test covers it.' })).body.id as string
    const made = async (name: string) => {
      const { body } = await you('POST', '/api/agents', { name })
      return { id: body.agent.id as string, ...(await agentClient(url, body.token)) }
    }
    const builder = await made('Builder')
    const writer = await made('Writer')
    const reviewer = await made('Reviewer')
    const card = () => hub.state.cards.find((c) => c.id === cardId)!

    // Nothing to challenge before the work has a diff, nor once it's off the board's working stages.
    assert.equal((await you('POST', `/api/cards/${cardId}/challenge`)).status, 422)
    await builder.call('claim_task', { id: cardId })
    assert.match((await you('POST', `/api/cards/${cardId}/challenge`)).body.error, /nothing to challenge/)
    // The author's reasoning, which the reviewer must never see.
    await builder.call('report_progress', { id: cardId, doing: 'SECRET-DOING', plan: [{ text: 'SECRET-PLAN', done: true }], steps: [{ tool: 'Edit', text: 'SECRET-STEP' }], said: 'SECRET-SAID' })
    await you('POST', `/api/cards/${cardId}/comment`, { text: 'SECRET-COMMENT' })
    await builder.call('complete_task', { id: cardId, summary: 'SECRET-SUMMARY', pull_request: 'acme/web#7' })
    await until(() => !!card().issue)
    const issueWrites = () => github.calls.filter((c) => c.method === 'PATCH' && c.path === `/repos/acme/web/issues/${card().issue!.number}`).length
    // Writer wrote its debrief, so it read the author's log.
    await you('POST', `/api/cards/${cardId}/debrief`, { agentId: writer.id })
    await writer.call('send_debrief', { id: cardId, failed: 'Not now.' })
    await sleep(300)
    const writesBefore = issueWrites()

    // Left to the hub, one that didn't write it (a person may name any agent, an author too: see below).
    const asked = await you('POST', `/api/cards/${cardId}/challenge`)
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(asked.body.agentId, reviewer.id, 'the hub picks one that didn’t write it, nor read its log for the debrief')
    assert.equal(asked.body.picked, 'hub')
    assert.deepEqual(asked.body.authors, [builder.id])
    assert.equal((await you('POST', `/api/cards/${cardId}/challenge`)).status, 422, 'one at a time')

    assert.notEqual((await reviewer.call('wait_for_work', { timeout_seconds: 0 })).value.kind, 'challenge', 'only to an agent that says it challenges')
    const found = (await reviewer.call('wait_for_work', { timeout_seconds: 0, challenges: true })).value
    assert.equal(found.kind, 'challenge')
    // Of the card's whole change set: the job is the set's.
    assert.equal(found.id, hub.state.changeSets.find((s) => s.prIds.includes(hub.state.cards.find((c) => c.id === cardId)!.prId!))!.id)

    // What the reviewer can read of the card has none of the author's reasoning, by any tool.
    const view = (await reviewer.call('get_task', { id: cardId })).text
    assert.doesNotMatch(view, /SECRET/)
    assert.match(view, /GET \/health answers 200/)
    assert.equal((await reviewer.call('get_change_set', { id: cardId })).error, true)
    assert.equal((await reviewer.call('get_debrief', { id: cardId })).error, true)
    assert.equal((await builder.call('get_challenge_set', { id: cardId })).error, true, 'only for its reviewer')
    const set = await reviewer.call('get_challenge_set', { id: cardId })
    assert.equal(set.error, false, set.text)
    assert.doesNotMatch(set.text, /SECRET|"plan"|"log"|Builder/)
    assert.deepEqual(set.value.done_when_points, ['GET /health answers 200.', 'A test covers it.'])
    assert.equal(set.value.source, 'pull')
    const diff = (set.value.files as { path: string; diff: string }[])[0]
    assert.equal(diff.path, 'src/a.ts')
    assert.deepEqual(diff.diff.split('\n'), ['@@ ', '  1  a', '  2 -b', '  2 +c', '  3 +d'], 'each line numbered as in its file')

    // Or read a file at a time: the outline, then each file's numbered diff.
    const outline = (await reviewer.call('get_challenge_set', { id: cardId, outline: true })).value
    assert.deepEqual((outline.files as { path: string; parts: number; diff?: string }[]).map((f) => [f.path, f.parts, f.diff]), [['src/a.ts', 1, undefined]])
    assert.deepEqual(String((await reviewer.call('get_challenge_set', { id: cardId, file: 'src/a.ts' })).value.diff).split('\n'), ['@@ ', '  1  a', '  2 -b', '  2 +c', '  3 +d'])
    assert.match((await reviewer.call('get_challenge_set', { id: cardId, file: 'src/nope.ts' })).text, /No file src\/nope\.ts in it/)

    // Every finding says where, what goes wrong, how sure and how bad.
    assert.equal((await builder.call('send_challenge', { id: cardId, doing: 'Reading' })).error, true, 'only its reviewer sends it')
    await reviewer.call('send_challenge', { id: cardId, doing: 'Reading the diff' })
    assert.equal(hub.state.changeSets.find((s) => s.id === found.id)!.challenge!.state, 'reviewing', 'named by its card, the set’s Challenge')
    assert.equal((await reviewer.call('wait_for_work', { timeout_seconds: 0, challenges: true })).text, 'nothing yet', 'a Challenge it has started isn’t given again')
    const finding = { kind: 'bug', file: 'src/a.ts', line: 3, what: 'd is added but nothing reads it.', confidence: 'plausible', severity: 'low' }
    assert.equal((await reviewer.call('send_challenge', { id: cardId, findings: [{ ...finding, line: 0 }] })).error, true, 'a line is 1 or more')
    const vague = await reviewer.call('send_challenge', { id: cardId, findings: [{ ...finding, what: ' ' }] })
    assert.equal(vague.error, true)
    assert.match(vague.text, /finding 1: what goes wrong/)
    // Sent as it goes, checked as they come; the summary finishes it with the last one.
    assert.match((await reviewer.call('add_findings', { id: cardId, findings: [{ ...finding, what: ' ' }] })).text, /finding 1: what goes wrong/)
    assert.match((await reviewer.call('add_findings', { id: cardId, findings: [finding] })).text, /Kept: 1 finding so far/)
    const sent = await reviewer.call('send_challenge', { id: cardId, summary: 'One real bug.', findings: [{ kind: 'done-when', file: 'b/src/a.ts', line: 2, what: 'No test covers /health: the second done-when point isn’t met.', confidence: 'confirmed', severity: 'high', fix: 'Add test/health.test.ts.' }] })
    assert.equal(sent.text, 'Sent: 2 findings.')
    const challenge = card().challenge!
    assert.equal(challenge.state, 'done')
    assert.equal(challenge.summary, 'One real bug.')
    assert.deepEqual(challenge.findings!.map((f) => [f.id, f.severity, f.confidence, f.file, f.line, f.pull]), [['f1', 'high', 'confirmed', 'src/a.ts', 2, 'acme/web#7'], ['f2', 'low', 'plausible', 'src/a.ts', 3, 'acme/web#7']], 'worst first, at the diff’s own path')
    assert.equal(challenge.findings![0].fix, 'Add test/health.test.ts.')
    assert.deepEqual(card().activity.filter((a) => a.kind === 'challenge').map((a) => a.text), ['Asked Reviewer to challenge it, at low reasoning for 3 changed lines (change set #1)', 'Challenged it: 2 findings, 1 high (change set #1)'])
    assert.equal(challenge.fromSet, found.id, 'the card’s copy: the findings on its pull request')
    assert.equal((await reviewer.call('send_challenge', { id: cardId, findings: [] })).error, true, 'nothing waits for it now')

    // Once it's done, the card is as any other to the reviewer, and anyone may read the findings.
    assert.match((await reviewer.call('get_task', { id: cardId })).text, /SECRET-PLAN/)
    const read = (await builder.call('get_challenge', { id: cardId })).value
    assert.equal(read.by, 'Reviewer')
    assert.deepEqual((read.findings as { id: string }[]).map((f) => f.id), ['f1', 'f2'])

    // A person may name the reviewer: Writer didn't write it.
    const again = await you('POST', `/api/cards/${cardId}/challenge`, { agentId: writer.id })
    assert.equal(again.status, 200)
    assert.equal(again.body.picked, 'person')
    assert.equal(card().challenge!.findings!.length, 2, 'the last findings stay on show meanwhile')
    await writer.call('send_challenge', { id: cardId, summary: 'Nothing wrong.', findings: [] })
    assert.deepEqual(card().challenge!.findings, [])
    assert.equal(card().activity.at(-1)!.text, 'Challenged it and found nothing wrong (change set #1)')

    await sleep(300)
    assert.equal(issueWrites(), writesBefore, 'a Challenge isn’t written into the card’s issue')
    assert.equal(github.calls.filter((c) => c.path === '/repos/acme/web/pulls/7/reviews').length, 0, 'nor posted on the pull request, with its binder’s switch off')
    assert.equal(card().challenge!.review, undefined)
    for (const agent of [builder, writer, reviewer]) await agent.client.close()
    await close()
    await github.close()
  })

  it('posts a Challenge’s findings as a review on the pull request when its binder says so, each on its line', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web', reviewComments: true } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'GET /health answers 200.' })).body.id as string
    const made = async (name: string) => {
      const { body } = await you('POST', '/api/agents', { name })
      return { id: body.agent.id as string, ...(await agentClient(url, body.token)) }
    }
    const builder = await made('Builder')
    const reviewer = await made('Reviewer')
    const card = () => hub.state.cards.find((c) => c.id === cardId)!
    await builder.call('claim_task', { id: cardId })
    await builder.call('complete_task', { id: cardId, summary: 'Done.', pull_request: 'acme/web#7' })
    await until(() => !!card().issue)
    const posts = () => github.calls.filter((c) => c.method === 'POST' && c.path === '/repos/acme/web/pulls/7/reviews')

    // Nothing is posted until the findings are in. The pull request's diff is "@@ -1,2 +1,3 @@ a -b +c +d".
    assert.equal((await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })).status, 200)
    await reviewer.call('send_challenge', { id: cardId, doing: 'Reading' })
    await sleep(100)
    assert.equal(posts().length, 0)
    const findings = [
      { kind: 'bug', file: 'src/a.ts', line: 3, what: 'd is added but nothing reads it.', confidence: 'plausible', severity: 'low' },
      { kind: 'done-when', file: 'test/health.test.ts', line: 1, what: 'No test covers /health.', confidence: 'confirmed', severity: 'high', fix: 'Add one.' },
      { kind: 'edge case', file: 'src/a.ts', line: 40, what: 'Past the diff.', confidence: 'plausible', severity: 'medium' },
    ]
    assert.equal((await reviewer.call('send_challenge', { id: cardId, summary: 'One real gap.', findings })).error, false)
    await until(() => !!card().challenge!.review)
    assert.equal(posts().length, 1, 'one review for all of them')
    const sent = posts()[0].body as { event: string; body: string; comments: { path: string; line: number; side: string; body: string }[] }
    assert.equal(sent.event, 'COMMENT', 'it comments: it neither approves nor asks for changes')
    assert.deepEqual(sent.comments.map((c) => [c.path, c.line, c.side]), [['src/a.ts', 3, 'RIGHT']], 'only the finding on a line of the diff is a line comment')
    assert.match(sent.comments[0].body, /^\*\*Low\*\* · plausible · bug\n\nd is added but nothing reads it\.$/)
    for (const words of ['### Challenge: 3 findings, 1 high', 'By Reviewer', 'One real gap.', '**Not on a line of this diff**', '`test/health.test.ts:1`', '**Fix:** Add one.', '`src/a.ts:40`', `(http://hub.test/#/work/${cardId})`, `<!-- binders {"challenge":"${cardId}"} -->`]) assert.ok(sent.body.includes(words), `the review has ${words}`)
    const review = card().challenge!.review!
    assert.deepEqual([review.repo, review.number, review.onLines, review.failed], ['acme/web', 7, 1, undefined])
    assert.match(review.url!, /pull\/7#pullrequestreview-\d+$/)
    await sleep(200)
    assert.equal(posts().length, 1, 'posted once: the saver’s own record of it isn’t new findings')

    // New commits moved the lines out of the diff: GitHub refuses line comments, so every finding goes in the body.
    github.world.linesGone = true
    await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })
    await reviewer.call('send_challenge', { id: cardId, findings: [findings[0]] })
    await until(() => card().challenge!.review?.onLines === 0)
    assert.equal(posts().length, 3)
    assert.deepEqual((posts()[2].body as { comments: unknown[] }).comments, [])
    assert.match((posts()[2].body as { body: string }).body, /\*\*Findings\*\*\n\n- `src\/a\.ts:3`/)

    // A Challenge that finds nothing posts nothing; nor does one with the switch turned off.
    await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })
    await reviewer.call('send_challenge', { id: cardId, findings: [] })
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r2', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web', reviewComments: false } } }] })
    await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })
    await reviewer.call('send_challenge', { id: cardId, findings: [findings[0]] })
    await sleep(300)
    assert.equal(posts().length, 3)
    assert.equal(card().challenge!.review, undefined)
    for (const agent of [builder, reviewer]) await agent.client.close()
    await close()
    await github.close()
  })

  it('sends a Challenge finding back to the agent that wrote the work, dismisses one, or makes a card of it', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'GET /health answers 200. A test covers it.' })).body.id as string
    const made = async (name: string) => {
      const { body } = await you('POST', '/api/agents', { name })
      return { id: body.agent.id as string, ...(await agentClient(url, body.token)) }
    }
    const builder = await made('Builder')
    const reviewer = await made('Reviewer')
    const card = () => hub.state.cards.find((c) => c.id === cardId)!
    const act = (finding: string, action: string) => you('POST', `/api/cards/${cardId}/findings/${finding}`, { action })

    await builder.call('claim_task', { id: cardId })
    await builder.call('complete_task', { id: cardId, summary: 'Added it.', pull_request: 'acme/web#7' })
    assert.equal(card().stage, 'review')
    assert.equal((await act('f1', 'dismiss')).status, 422, 'no Challenge, no findings')
    await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })
    await reviewer.call('send_challenge', { id: cardId, summary: 'Three things.', findings: [
      { kind: 'done-when', file: 'src/a.ts', line: 2, what: 'No test covers /health. The second point isn’t met.', confidence: 'confirmed', severity: 'high', fix: 'Add test/health.test.ts.' },
      { kind: 'bug', file: 'src/a.ts', line: 3, what: 'd is added but nothing reads it.', confidence: 'plausible', severity: 'medium' },
      { kind: 'simpler', file: 'src/a.ts', line: 1, what: 'The handler could be one line.', confidence: 'plausible', severity: 'low' },
    ] })
    assert.deepEqual(card().challenge!.findings!.map((f) => f.id), ['f1', 'f2', 'f3'])
    assert.equal((await act('f1', 'merge')).status, 422, 'only the four actions')
    assert.equal((await act('f9', 'dismiss')).status, 422)
    // Before it's sent back, the author has nothing to carry on with.
    assert.equal((await builder.call('wait_for_work', { timeout_seconds: 0 })).text, 'nothing yet')

    // Send back: a comment to the author on the card, which goes back to In progress, and its runner carries on.
    const back = await act('f1', 'send back')
    assert.equal(back.status, 200, JSON.stringify(back.body))
    assert.equal(card().stage, 'working')
    assert.equal(card().agentId, builder.id)
    const comment = card().activity.at(-1)!
    assert.equal(comment.kind, 'comment')
    assert.equal(comment.by, 'you')
    assert.match(comment.text, /Reviewer’s Challenge \(high, confirmed, done-when\) at src\/a\.ts:2 in acme\/web#7: No test covers \/health/)
    assert.match(comment.text, /Fix: Add test\/health\.test\.ts\./)
    assert.deepEqual({ ...card().challenge!.findings![0].outcome, at: undefined }, { kind: 'sent back', by: 'you', at: undefined, agentId: builder.id })
    const resumed = (await builder.call('wait_for_work', { timeout_seconds: 0 })).value
    assert.equal(resumed.kind, 'card')
    assert.equal(resumed.id, cardId)
    assert.equal(resumed.resume, true)
    assert.match(JSON.stringify(resumed.conversation), /No test covers \/health/)
    assert.match((await act('f1', 'send back')).body.error, /already sent back/)

    // Dismiss, and open it again.
    assert.equal((await act('f2', 'reopen')).status, 422, 'only a dismissed one opens again')
    await act('f2', 'dismiss')
    assert.equal(card().challenge!.findings![1].outcome!.kind, 'dismissed')
    assert.match((await act('f2', 'card')).body.error, /dismissed/)
    await act('f2', 'reopen')
    assert.equal(card().challenge!.findings![1].outcome, undefined)
    await act('f2', 'dismiss')
    assert.equal(card().stage, 'working', 'dismissing doesn’t move the card')

    // Make a card: a new one on the board from the finding.
    const cardsBefore = hub.state.cards.length
    const fresh = await act('f3', 'card')
    assert.equal(fresh.status, 200)
    assert.equal(hub.state.cards.length, cardsBefore + 1)
    const made3 = hub.state.cards.find((c) => c.id === fresh.body.id)!
    assert.equal(made3.title, 'The handler could be one line')
    assert.equal(made3.stage, 'ready')
    assert.equal(made3.binderId, 'b1')
    assert.match(made3.brief, /From the Challenge of “Add a health check” \(card-/)
    assert.match(made3.brief, /src\/a\.ts:1 in acme\/web#7/)
    assert.match(made3.doneWhen, /src\/a\.ts:1/)
    assert.equal(card().challenge!.findings![2].outcome!.cardId, made3.id)
    assert.match((await act('f3', 'card')).body.error, /already has a card/)
    assert.deepEqual(card().activity.filter((a) => a.kind === 'challenge').slice(-4).map((a) => a.text), ['Dismissed finding f2 (src/a.ts:3 in acme/web#7)', 'Opened finding f2 again', 'Dismissed finding f2 (src/a.ts:3 in acme/web#7)', 'Made a card of finding f3: “The handler could be one line”'])

    // Past review, nothing goes back.
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'x', change: { type: 'card.update', id: cardId, fields: { stage: 'live' } } }] })
    await until(() => card().stage === 'live')
    await act('f2', 'reopen')
    assert.match((await act('f2', 'send back')).body.error, /past review/)

    for (const agent of [builder, reviewer]) await agent.client.close()
    await close()
    await github.close()
  })

  it('lets the author reply once to each finding, fixed or disagree and why, and starts no second round', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'GET /health answers 200. A test covers it.' })).body.id as string
    const made = async (name: string) => {
      const { body } = await you('POST', '/api/agents', { name })
      return { id: body.agent.id as string, ...(await agentClient(url, body.token)) }
    }
    const builder = await made('Builder')
    const reviewer = await made('Reviewer')
    const card = () => hub.state.cards.find((c) => c.id === cardId)!
    await builder.call('claim_task', { id: cardId })
    await builder.call('complete_task', { id: cardId, summary: 'Done.', pull_request: 'acme/web#7' })
    await until(() => !!card().issue)

    // Nothing to reply to before the Challenge is done.
    assert.equal((await you('POST', `/api/cards/${cardId}/challenge/replies`)).status, 422)
    await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })
    assert.match((await you('POST', `/api/cards/${cardId}/challenge/replies`)).body.error, /no findings to reply to/)
    await reviewer.call('send_challenge', { id: cardId, summary: 'Two things.', findings: [
      { kind: 'bug', file: 'src/a.ts', line: 3, what: 'd is added but nothing reads it.', confidence: 'plausible', severity: 'low' },
      { kind: 'done-when', file: 'src/a.ts', line: 2, what: 'No test covers /health.', confidence: 'confirmed', severity: 'high' },
    ] })
    assert.equal((await builder.call('reply_to_findings', { id: cardId, doing: 'Reading' })).error, true, 'not before a person asks')

    const asked = await you('POST', `/api/cards/${cardId}/challenge/replies`)
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(asked.body.replies.agentId, builder.id, 'the author answers')
    assert.equal(asked.body.replies.state, 'asked')
    assert.match((await you('POST', `/api/cards/${cardId}/challenge/replies`)).body.error, /already replying/)
    assert.match((await you('POST', `/api/cards/${cardId}/challenge`)).body.error, /replying to the last findings/, 'no new Challenge over a round under way')

    assert.notEqual((await builder.call('wait_for_work', { timeout_seconds: 0 })).value?.kind, 'replies', 'only to an agent that says it replies')
    const found = (await builder.call('wait_for_work', { timeout_seconds: 0, replies: true })).value
    assert.equal(found.kind, 'replies')
    assert.equal(found.id, cardId)
    assert.equal(found.findings, 2)
    assert.equal((await reviewer.call('reply_to_findings', { id: cardId, doing: 'Reading' })).error, true, 'only the author replies')
    await builder.call('reply_to_findings', { id: cardId, doing: 'Adding the test' })
    assert.equal(card().challenge!.replies!.state, 'replying')
    assert.equal((await builder.call('wait_for_work', { timeout_seconds: 0, replies: true })).text, 'nothing yet', 'a round it has started isn’t given again')

    // One reply to every finding, each fixed or disagree with why.
    const partial = await builder.call('reply_to_findings', { id: cardId, replies: [{ finding: 'f1', verdict: 'fixed', why: 'Added test/health.test.ts.' }] })
    assert.equal(partial.error, true)
    assert.match(partial.text, /a reply to f2/)
    const muddled = await builder.call('reply_to_findings', { id: cardId, replies: [{ finding: 'f1', verdict: 'fixed', why: ' ' }, { finding: 'f9', verdict: 'disagree', why: 'x' }, { finding: 'f2', verdict: 'disagree', why: 'x' }, { finding: 'f2', verdict: 'fixed', why: 'y' }] })
    assert.equal(muddled.error, true)
    assert.match(muddled.text, /reply 1 \(f1\): why/)
    assert.match(muddled.text, /no finding “f9”/)
    assert.match(muddled.text, /f2 is answered twice/)
    const sent = await builder.call('reply_to_findings', { id: cardId, replies: [
      { finding: 'f2', verdict: 'disagree', why: 'd is read by the status page in src/status.ts:12.' },
      { finding: 'f1', verdict: 'fixed', why: 'Added test/health.test.ts.' },
    ] })
    assert.equal(sent.error, false, sent.text)
    assert.match(sent.text, /one round/)
    const challenge = card().challenge!
    assert.equal(challenge.replies!.state, 'done')
    assert.deepEqual(challenge.findings!.map((f) => [f.id, f.reply?.verdict, f.reply?.why, f.reply?.by]), [
      ['f1', 'fixed', 'Added test/health.test.ts.', builder.id],
      ['f2', 'disagree', 'd is read by the status page in src/status.ts:12.', builder.id],
    ])
    assert.equal(card().activity.at(-1)!.text, 'Replied to the findings: 1 fixed, 1 disagreed')

    // That was the one round: the author can't send again, a person can't ask again, and the reviewer isn't sent anything.
    assert.equal((await builder.call('reply_to_findings', { id: cardId, replies: [] })).error, true)
    assert.match((await you('POST', `/api/cards/${cardId}/challenge/replies`)).body.error, /one round of replies/)
    assert.equal((await reviewer.call('wait_for_work', { timeout_seconds: 0, challenges: true, replies: true })).text, 'nothing yet')
    assert.equal(challenge.state, 'done')
    const read = (await reviewer.call('get_challenge', { id: cardId })).value as unknown as { replies: { state: string }; findings: { reply: { by: string } }[] }
    assert.equal(read.replies.state, 'done')
    assert.equal(read.findings[0].reply.by, 'Builder')

    // A new Challenge brings new findings without replies, which may be replied to once again.
    await you('POST', `/api/cards/${cardId}/challenge`, { agentId: reviewer.id })
    assert.equal(card().challenge!.findings![0].reply?.verdict, 'fixed', 'the last replies stay on show meanwhile')
    await reviewer.call('send_challenge', { id: cardId, summary: 'Two left.', findings: [
      { kind: 'bug', file: 'src/a.ts', line: 3, what: 'Still unread.', confidence: 'plausible', severity: 'low' },
      { kind: 'simpler', file: 'src/a.ts', line: 2, what: 'Could be one line.', confidence: 'plausible', severity: 'low' },
    ] })
    assert.equal(card().challenge!.replies, undefined)
    assert.equal(card().challenge!.findings![0].reply, undefined)
    assert.equal((await you('POST', `/api/cards/${cardId}/challenge/replies`)).status, 200)
    // A round that fails brought no replies, so a person may ask once more.
    await builder.call('reply_to_findings', { id: cardId, failed: 'Out of time.' })
    assert.equal(card().challenge!.replies!.state, 'failed')
    // A finding a person dismissed needs no answer.
    assert.equal((await you('POST', `/api/cards/${cardId}/findings/f2`, { action: 'dismiss' })).status, 200)
    assert.equal((await you('POST', `/api/cards/${cardId}/challenge/replies`)).status, 200)
    const one = await builder.call('reply_to_findings', { id: cardId, replies: [{ finding: 'f1', verdict: 'disagree', why: 'It is read in src/status.ts.' }] })
    assert.equal(one.error, false, one.text)
    assert.deepEqual(card().challenge!.findings!.map((f) => [f.id, f.reply?.verdict, f.outcome?.kind]), [['f1', 'disagree', undefined], ['f2', undefined, 'dismissed']])
    assert.equal(card().activity.at(-1)!.text, 'Replied to the findings: 1 disagreed')

    for (const agent of [builder, reviewer]) await agent.client.close()
    await close()
    await github.close()
  })

  it('says a debrief is out of date when new commits land, and written again it starts with what changed since', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github, webhookSecret: 'shh' })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const cardId = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Add a health check', brief: 'GET /health answers 200.', doneWhen: 'GET /health answers 200. A test covers it.' })).body.id as string
    const builderMade = await you('POST', '/api/agents', { name: 'Builder' })
    const writerMade = await you('POST', '/api/agents', { name: 'Writer' })
    const builder = await agentClient(url, builderMade.body.token)
    const writer = await agentClient(url, writerMade.body.token)
    await builder.call('claim_task', { id: cardId })
    await builder.call('complete_task', { id: cardId, summary: 'Added /health.', pull_request: 'acme/web#7' })
    await until(() => !!hub.state.pulls.find((p) => p.id === 'acme/web#7')?.head)
    const pull = () => hub.state.pulls.find((p) => p.id === 'acme/web#7')!
    const debriefNow = () => hub.state.cards.find((c) => c.id === cardId)!.debrief!

    // A first debrief: written at the head the pull request has.
    const sections = { does: 'Adds GET /health, answering 200.', changes: [{ area: 'Server', what: 'A /health route.' }], look_at: [], try_it: 'npm start, then curl localhost:8080/health.' }
    const against = [{ point: 'Answers 200', mark: 'met' as const, where: 'src/a.ts' }, { point: 'Tested', mark: 'met' as const, where: 'src/a.test.ts' }]
    await you('POST', `/api/cards/${cardId}/debrief`, { agentId: writerMade.body.agent.id })
    const first = await writer.call('send_debrief', { id: cardId, ...sections, against })
    assert.equal(first.error, false, first.text)
    assert.equal(debriefNow().head, 'sha7', 'the commit it was written at')
    assert.equal(debriefNow().since, undefined, 'the first debrief has nothing before it')
    const changeSetOf = async () => (await writer.call('get_change_set', { id: cardId })).value as { debrief?: { out_of_date?: { from: string; to: string; commits: { sha: string; title: string }[]; files: string[] } } }
    assert.equal((await changeSetOf()).debrief?.out_of_date, undefined, 'nothing has landed since')

    // New commits on the pull request: the debrief says it's out of date, with only those commits.
    github.world.heads[7] = 'sha9'
    github.world.compares['sha7...sha9'] = {
      commits: [
        { sha: 'c1aaaaaaa', commit: { message: 'Fix the header casing\n\nMore words.', author: { name: 'Builder', date: '2026-10-30T01:00:00Z' } } },
        { sha: 'c2bbbbbbb', commit: { message: 'Test the body too', author: { name: 'Builder', date: '2026-10-30T01:05:00Z' } } },
      ],
      files: [{ filename: 'src/health.ts', additions: 4, deletions: 1 }],
      additions: 4,
      deletions: 1,
    }
    const body = JSON.stringify({ action: 'synchronize', pull_request: { number: 7, title: 'Health', body: '', state: 'open', html_url: '', head: { ref: 'agent/7-work', sha: 'sha9' } }, repository: { full_name: 'acme/web' } })
    const delivered = await fetch(`${url}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}` }, body })
    assert.equal(delivered.status, 200)
    assert.equal(pull().head, 'sha9')

    const stale = (await changeSetOf()).debrief?.out_of_date
    assert.equal(stale?.from, 'sha7')
    assert.equal(stale?.to, 'sha9')
    assert.deepEqual(stale?.commits.map((c) => c.title), ['Fix the header casing', 'Test the body too'], 'only the commits that landed, first line only')
    assert.deepEqual(stale?.files, ['src/health.ts'])

    // Written again, it needs what the new commits changed, and keeps only those.
    const again = await you('POST', `/api/cards/${cardId}/debrief`, { agentId: writerMade.body.agent.id })
    assert.equal(again.body.state, 'asked')
    assert.equal(again.body.does, sections.does, 'the last one stays while the new one is written')
    const without = await writer.call('send_debrief', { id: cardId, ...sections, against })
    assert.equal(without.error, true)
    assert.match(without.text, /since \(what the new commits changed/)
    const since = 'The header is upper case now, and a test covers the body.'
    const written = await writer.call('send_debrief', { id: cardId, ...sections, against, since })
    assert.equal(written.error, false, written.text)
    const debrief = debriefNow()
    assert.equal(debrief.head, 'sha9')
    assert.equal(debrief.since!.from, 'sha7')
    assert.equal(debrief.since!.to, 'sha9')
    assert.equal(debrief.since!.what, since)
    assert.deepEqual(debrief.since!.commits.map((c) => c.sha), ['c1aaaaaaa', 'c2bbbbbbb'])
    assert.deepEqual(debrief.since!.files, ['src/health.ts'])
    assert.equal((await changeSetOf()).debrief?.out_of_date, undefined, 'current again')

    // Asked again with nothing new: no since to give.
    await you('POST', `/api/cards/${cardId}/debrief`, { agentId: writerMade.body.agent.id })
    const plain = await writer.call('send_debrief', { id: cardId, ...sections, against })
    assert.equal(plain.error, false, plain.text)
    assert.equal(debriefNow().since, undefined)
    assert.equal(debriefNow().head, 'sha9')

    // A pull request whose head the hub never heard of (it opened before the hub kept heads): read when it's written.
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: 'acme/web#7', fields: { head: undefined } })
    assert.equal(pull().head, undefined)
    await you('POST', `/api/cards/${cardId}/debrief`, { agentId: writerMade.body.agent.id })
    const read = await writer.call('send_debrief', { id: cardId, ...sections, against })
    assert.equal(read.error, false, read.text)
    assert.equal(pull().head, 'sha9', 'read from GitHub and kept on the pull request')
    assert.equal(debriefNow().head, 'sha9')

    await builder.client.close()
    await writer.client.close()
    await close()
    await github.close()
  })

  it('proposes work from a note, word for word, and a person accepts it onto the board', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'e', change: { type: 'note.edit', id: 'n1', by: 'you', at: 'now', title: 'First note', text: '# First note\n\n- Cache the board for a second.\n' } }] })
    const { body } = await you('POST', '/api/agents', { name: 'Reader' })
    const reader = await agentClient(url, body.token)
    const result = await reader.call('propose_work_items', { note: 'First note', items: [{ title: 'Cache the board', quote: 'Cache the board for a second.' }, { title: 'Made up', quote: 'Not in the note.' }] })
    assert.equal(result.value.proposed, 1)
    assert.match(JSON.stringify(result.value.skipped), /isn’t in the note word for word/)
    const again = await reader.call('propose_work_items', { note: 'n1', items: [{ title: 'Cache it again', quote: 'Cache the board for a second.' }] })
    assert.equal(again.value.proposed, 0, 'the same words aren’t proposed twice')
    const proposal = hub.state.proposals[0]
    const accepted = await you('POST', `/api/proposals/${proposal.id}/accept`)
    assert.equal(accepted.body.stage, 'ready')
    assert.deepEqual(hub.state.notes[0].work?.map((w) => w.quote), ['Cache the board for a second.'])
    await reader.client.close()
    await close()
  })
})

describe('GitHub’s webhooks', () => {
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  it('refuses an unsigned delivery, and turns signed ones into changes', async () => {
    const github = await fakeGitHub()
    const { url, hub, close } = await setUp({ github, webhookSecret: 'shh' })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const card = (await you('POST', '/api/cards', { binderId: 'b1', title: 'Old title' })).body
    await until(() => !!hub.state.cards.find((c) => c.id === card.id)?.issue)
    const issue = hub.state.cards.find((c) => c.id === card.id)!.issue!
    const deliver = async (event: string, payload: unknown, secret = 'shh') => {
      const body = JSON.stringify(payload)
      return fetch(`${url}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(secret, body) }, body })
    }
    assert.equal((await deliver('issues', {}, 'wrong')).status, 401)

    await deliver('issues', { action: 'edited', issue: { number: issue.number, title: 'New title', body: 'Brief written on GitHub', state: 'open', html_url: '' }, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.cards.find((c) => c.id === card.id)!.title, 'New title')

    await deliver('pull_request', { action: 'opened', pull_request: { number: 9, title: 'Health', body: `binders-card: ${card.id}`, state: 'open', html_url: '', head: { ref: 'agent/x' } }, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.pulls.find((p) => p.id === 'acme/web#9')?.cardId, card.id)

    await deliver('check_run', { check_run: { name: 'lint', status: 'completed', conclusion: 'failure', pull_requests: [{ number: 9 }] }, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.pulls.find((p) => p.id === 'acme/web#9')!.checks.find((c) => c.name === 'lint')?.state, 'failed')

    await deliver('deployment_status', { deployment_status: { state: 'success' }, deployment: { environment: 'staging', ref: 'main', sha: 'abcdef123', payload: { version: '0.3.0' } }, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.environments.find((e) => e.id === 'acme/web#staging')!.version, '0.3.0')

    await deliver('issues', { action: 'closed', issue: { number: issue.number, title: 'New title', body: '', state: 'closed', html_url: '' }, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.cards.find((c) => c.id === card.id)!.stage, 'live')
    await close()
    await github.close()
  })

  it('lets an agent make folders and move notes, carries on when a person comments, and keeps pictures', async () => {
    const filesDir = await tempDir('files')
    const { url, hub, close } = await setUp({ filesDir })
    const you = api(url, await signIn(url))
    const made = await you('POST', '/api/agents', { name: 'Keeper' })
    const keeper = await agentClient(url, made.body.token)
    const noteId = hub.state.notes[0].id
    const binder = hub.state.notes[0].binderId

    const folder = await keeper.call('create_folder', { binder, name: 'docs' })
    assert.equal(folder.value.made, true)
    assert.equal((await keeper.call('create_folder', { binder, name: 'Docs' })).value.id, folder.value.id, 'the same name twice is one folder')
    await keeper.call('move_note', { id: noteId, folder: 'docs' })
    assert.equal(hub.state.notes.find((n) => n.id === noteId)?.folderId, folder.value.id)

    // A card it holds and stopped on: a person's comment sends it back to work.
    const card = await you('POST', '/api/cards', { binderId: binder, title: 'Tidy the docs' })
    await keeper.call('claim_task', { id: card.body.id })
    assert.equal((await keeper.call('wait_for_work', { timeout_seconds: 0 })).text, 'nothing yet')
    await you('POST', `/api/cards/${card.body.id}/comment`, { text: 'Carry on with this card.' })
    const back = await keeper.call('wait_for_work', { timeout_seconds: 0 })
    assert.equal(back.value.id, card.body.id)
    assert.equal(back.value.resume, true)

    const cookie = await signIn(url)
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f00000000049454e44ae426082', 'hex')
    const sent = await fetch(`${url}/api/files`, { method: 'POST', headers: { cookie, 'x-binders': '1', 'content-type': 'image/png' }, body: png })
    const { url: address } = await sent.json() as { url: string }
    assert.match(address, /^\/api\/files\/[a-f0-9]{24}\.png$/)
    const got = await fetch(`${url}${address}`, { headers: { cookie } })
    assert.equal(got.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png)
    assert.equal((await fetch(`${url}${address}`)).status, 401, 'only for people signed in')
    const text = await fetch(`${url}/api/files`, { method: 'POST', headers: { cookie, 'x-binders': '1', 'content-type': 'text/html' }, body: '<script>' })
    assert.notEqual(text.status, 200, 'only pictures')

    await keeper.client.close()
    await close()
  })


  it('lets a person talk with an agent about a note, the agent reading, changing it and answering', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    const made = await you('POST', '/api/agents', { name: 'Manager' })
    const manager = await agentClient(url, made.body.token)
    const note = hub.state.notes[0]

    const said = await you('POST', `/api/notes/${note.id}/chat`, { agentId: made.body.agent.id, text: 'Call it “Kickoff” instead.' })
    assert.equal(said.status, 200)
    assert.notEqual((await manager.call('wait_for_work', { timeout_seconds: 0 })).value.kind, 'chat', 'only to an agent that says it answers chats')
    const found = await manager.call('wait_for_work', { timeout_seconds: 1, chats: true })
    assert.equal(found.value.kind, 'chat')
    assert.equal((found.value.note as { id: string }).id, note.id)
    assert.match(JSON.stringify(found.value.messages), /Kickoff/)

    await manager.call('chat_reply', { id: found.value.id, working: true, doing: 'Reading the note' })
    assert.equal(hub.state.chats[0].doing, 'Reading the note')
    assert.equal((await manager.call('wait_for_work', { timeout_seconds: 0, chats: true })).text, 'nothing yet', 'a chat it has started isn’t given again')

    const title = note.text.split('\n')[0].replace(/^#\s*/, '')
    assert.equal((await manager.call('edit_note', { id: note.id, find: title, replace: 'Kickoff' })).error, false)
    assert.match(hub.state.notes[0].text, /^# Kickoff/)
    await manager.call('chat_reply', { id: found.value.id, text: 'Renamed it to Kickoff.' })
    const chat = hub.state.chats[0]
    assert.deepEqual(chat.messages.map((m) => m.text), ['Call it “Kickoff” instead.', 'Renamed it to Kickoff.'])
    assert.equal(chat.working, undefined, 'its answer ends its turn')

    await manager.client.close()
    await close()
  })


  it('merges an approved change set as a train: past what’s behind, settling added lines, and back for what its agent resolves', async () => {
    const github = await fakeGitHub()
    // GitHub's copy of the repo: main and the pull requests' branches, as a local bare repo the hub fetches and pushes.
    const remote = await tempDir('train-remote')
    const work = await tempDir('train-work')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@binders.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd }).toString()
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(work, 'init', '-q', '-b', 'main')
    const file = (text: string) => writeFileSync(join(work, 'routes.ts'), text)
    file('a\nz\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'start')
    git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', 'origin', 'main')
    // #8 adds a route where main will too; #9 changes the line main will change.
    git(work, 'checkout', '-q', '-b', 'agent/8-work'); file('a\nb\nz\n'); git(work, 'commit', '-qam', 'route b'); git(work, 'push', '-q', 'origin', 'agent/8-work')
    git(work, 'checkout', '-q', 'main'); git(work, 'checkout', '-q', '-b', 'agent/9-work'); file('a\ny\n'); git(work, 'commit', '-qam', 'z to y'); git(work, 'push', '-q', 'origin', 'agent/9-work')
    git(work, 'checkout', '-q', 'main'); file('a\nc\nx\n'); git(work, 'commit', '-qam', 'route c, z to x'); git(work, 'push', '-q', 'origin', 'main')

    const merger = new Merger({ dir: await tempDir('train-repos'), access: async () => ({ url: remote, token: 'unused' }), author: { name: 'Hub', email: 'hub@binders.invalid' } })
    const { url, hub, close } = await setUp({ github, merger })
    const you = api(url, await signIn(url))
    await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'r', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }] })
    const made = await you('POST', '/api/agents', { name: 'Builder' })
    const builder = await agentClient(url, made.body.token)
    const finish = async (title: string, pr: string) => {
      const card = await you('POST', '/api/cards', { binderId: 'b1', title, meantFor: made.body.agent.id })
      await builder.call('claim_task', { id: card.body.id })
      await builder.call('complete_task', { id: card.body.id, summary: 'Done.', pull_request: pr })
      return card.body.id as string
    }
    await finish('Behind', 'acme/web#7')
    await finish('Adds a route', 'acme/web#8')
    const overlapping = await finish('Changes a line', 'acme/web#9')
    const set = hub.state.changeSets.find((s) => s.prIds.includes('acme/web#9'))!
    github.world.mergeable[7] = 'behind'
    github.world.mergeable[8] = 'dirty'
    github.world.mergeable[9] = 'dirty'
    // #9 was opened against #7's branch, stacked: it must land on main, after #7.
    github.world.bases[9] = 'agent/7-work'

    const approved = await you('POST', `/api/sets/${set.id}/approve`)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    const pull = (n: number) => hub.state.pulls.find((p) => p.id === `acme/web#${n}`)!
    assert.equal(pull(7).state, 'merged', 'behind but clean: merged as it was')
    assert.equal(github.calls.find((c) => c.path === '/repos/acme/web/pulls/7/merge')?.body?.merge_method, 'merge', 'with a merge commit')
    // #8: it added a line where main added one and changed the next; the hub kept all of it and pushed.
    assert.equal(execFileSync('git', ['show', 'agent/8-work:routes.ts'], { cwd: remote }).toString(), 'a\nb\nc\nx\n')
    assert.equal(pull(8).state, 'open', 'waits for its checks to run again')
    // #9: both changed the same line; back with its agent, and the train didn't stop for it.
    assert.ok(github.calls.some((c) => c.method === 'PATCH' && c.path === '/repos/acme/web/pulls/9' && c.body?.base === 'main'), 'the stacked one was pointed at main once #7 had merged')
    assert.equal(github.world.bases[9], 'main')
    const card = hub.state.cards.find((c) => c.id === overlapping)!
    assert.equal(card.stage, 'ready')
    assert.equal(card.meantFor, made.body.agent.id)
    assert.match(card.activity[card.activity.length - 1].text, /routes\.ts/)
    const waiting = hub.state.changeSets.find((s) => s.id === set.id)!
    assert.equal(waiting.state, 'merging', 'still approved, merging as each is ready')
    assert.deepEqual(waiting.waiting?.map((w) => w.prId), ['acme/web#8', 'acme/web#9'])

    // #8's checks pass again: the train merges it without being asked.
    github.world.mergeable[8] = 'clean'
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: 'acme/web#8', fields: { checks: pull(8).checks.map((c) => ({ ...c, state: 'passed' as const })) } })
    await until(() => pull(8).state === 'merged', 3000)

    // The agent resolves #9 and pushes: the train merges it and the set is done.
    await builder.call('claim_task', { id: overlapping })
    await builder.call('complete_task', { id: overlapping, summary: 'Resolved: kept x.', pull_request: 'acme/web#9' })
    github.world.mergeable[9] = 'clean'
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: 'acme/web#9', fields: { mergeable: 'clean' } })
    await until(() => hub.state.changeSets.find((s) => s.id === set.id)!.state === 'merged', 3000)
    assert.equal(hub.state.changeSets.find((s) => s.id === set.id)!.waiting, undefined)

    await builder.client.close()
    await close()
    await github.close()
  })


describe('settling conflicts', () => {
  const conflict = (ours: string[], ancestor: string[], theirs: string[]) => ['top', '<<<<<<< HEAD', ...ours, '||||||| base', ...ancestor, '=======', ...theirs, '>>>>>>> origin/main', 'end'].join('\n')
  it('keeps both sides when both only added lines at the same place, the base’s first', () => {
    assert.equal(keepBothAdditions(conflict(['b'], [], ['c'])), 'top\nc\nb\nend')
  })
  it('puts lines one side added around the other side’s change', () => {
    assert.equal(keepBothAdditions(conflict(['b', 'z'], ['z'], ['c', 'x'])), 'top\nb\nc\nx\nend')
    assert.equal(keepBothAdditions(conflict(['y'], ['z'], ['z', 'w'])), 'top\ny\nw\nend')
  })
  it('leaves it when both sides changed the same lines, or the markers aren’t diff3', () => {
    assert.equal(keepBothAdditions(conflict(['y'], ['z'], ['x'])), undefined)
    assert.equal(keepBothAdditions(['<<<<<<< HEAD', 'b', '=======', 'c', '>>>>>>> main'].join('\n')), undefined)
  })
})

})

describe('repo briefs', () => {
  const brief = (extra = '') => `## What it is\nThe web app for the board.${extra}\n\n## Map\n- src/server.ts: the routes\n- src/hub.ts: the change log, applied in order\n\n## Rules it keeps\n- Every change is checked before it goes in the log (src/schemas.ts).\n\n## Build, test, run\nnpm test, about a minute.\n`

  it('is written by the agent asked, given to agents that work in its repo, and gathers lessons until it’s written again', async () => {
    const { url, hub, close } = await setUp()
    const you = api(url, await signIn(url))
    await hub.submit('you', 'tab-1', [{ id: 'r1', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }, { id: 'r2', change: { type: 'binder.put', binder: { id: 'b2', name: 'Other' } } }])
    const scribe = await you('POST', '/api/agents', { name: 'Scribe', repos: ['acme/web'] })
    const outsider = await you('POST', '/api/agents', { name: 'Outsider', repos: ['acme/other'], binders: ['b2'] })
    const writer = await agentClient(url, scribe.body.token)
    const other = await agentClient(url, outsider.body.token)

    assert.match((await you('POST', '/api/briefs/acme/nope/ask', {})).body.error, /isn’t one of this binder’s repos/)
    assert.match((await you('POST', '/api/briefs/acme/web/ask', {})).body.error, /on runner 0\.8\.0 or newer/, 'the hub picks only a runner that writes briefs')
    await writer.call('update_profile', { runner: { version: '0.8.0', parallel: 1 } })
    const asked = await you('POST', '/api/briefs/ACME/web/ask', {})
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(asked.body.ask.agentId, scribe.body.agent.id)
    assert.match((await you('POST', '/api/briefs/acme/web/ask', {})).body.error, /Scribe is already writing/)
    assert.equal((await writer.call('request_repo_brief', { repo: 'acme/web' })).text, 'Scribe is writing it already.')

    const job = await writer.call('wait_for_work', { timeout_seconds: 0, briefs: true, cards: false })
    assert.deepEqual([job.value.kind, job.value.repo, job.value.refresh], ['brief', 'acme/web', undefined])
    assert.equal((await writer.call('wait_for_work', { timeout_seconds: 0, briefs: true, cards: false, busy: ['brief:acme/web'] })).text, 'nothing yet')
    assert.match((await other.call('send_repo_brief', { repo: 'acme/web', text: brief() })).text, /No brief of acme\/web is waiting for you/)
    await writer.call('send_repo_brief', { repo: 'acme/web', doing: 'Reading src/hub.ts' })
    assert.deepEqual([hub.state.briefs![0].ask?.state, hub.state.briefs![0].ask?.doing], ['writing', 'Reading src/hub.ts'])
    assert.match((await writer.call('send_repo_brief', { repo: 'acme/web', text: 'Too short.' })).text, /too short/)
    assert.match((await writer.call('send_repo_brief', { repo: 'acme/web', text: brief(`\nIts token is ghp_${'a'.repeat(36)}.`) })).text, /looks like a secret/)
    const sent = await writer.call('send_repo_brief', { repo: 'acme/web', text: brief(), sha: 'abc1234def' })
    assert.ok(!sent.error, sent.text)

    const read = await writer.call('get_repo_brief', { repo: 'Acme/Web' })
    assert.deepEqual([read.value.text, read.value.written_from, read.value.written_by, read.value.ask], [brief().trim(), 'abc1234def', 'Scribe', undefined])
    // Kept as a note, in the repo's folder in Repo docs, saved with the binder's notes.
    const kept = hub.state.notes.find((n) => n.id === read.value.note)!
    const folder = hub.state.folders.find((f) => f.id === kept.folderId)!
    const docs = hub.state.folders.find((f) => f.id === folder.parentId)!
    assert.deepEqual([kept.title, kept.binderId, folder.name, docs.name, docs.parentId], ['Brief', 'b1', 'acme/web', 'Repo docs', undefined])
    // People's notes there, and in Repo docs itself, go to agents with it; a person's edit to the brief is the brief.
    await hub.submit('you', 'tab-1', [
      { id: 'd1', change: { type: 'note.put', note: { id: 'doc-1', title: 'Deploys', binderId: 'b1', folderId: folder.id, editedAt: new Date().toISOString(), editors: ['you'], text: '# Deploys\nThe image runs every test before it goes out.' } } },
      { id: 'd2', change: { type: 'note.put', note: { id: 'doc-2', title: 'Team rules', binderId: 'b1', folderId: docs.id, editedAt: new Date().toISOString(), editors: ['you'], text: '# Team rules\nNo company names in tests.' } } },
      { id: 'd3', change: { type: 'note.edit', id: kept.id, text: `# Brief\n\n${brief(' Edited by a person.')}`, title: 'Brief', by: 'you', at: new Date().toISOString() } },
    ])
    const withDocs = await writer.call('get_repo_brief', { repo: 'acme/web' })
    assert.match(withDocs.value.text as string, /Edited by a person\./)
    assert.deepEqual((withDocs.value.docs as { folder: string; notes: { title: string }[] }).notes.map((n) => n.title), ['Deploys', 'Team rules'])
    assert.match((await other.call('get_repo_brief', { repo: 'acme/web' })).text, /isn’t a repo you work in/, 'an agent elsewhere doesn’t read it')

    // Lessons, from agents and people, until it's written again; then folded in, and ones added since kept.
    assert.ok(!(await writer.call('add_repo_lesson', { repo: 'acme/web', text: 'npm test needs python3 for the terminal tests.' })).error)
    assert.equal((await you('POST', '/api/briefs/acme/web/lessons', { text: 'Deploys run the web tests too.' })).status, 200)
    assert.match((await writer.call('add_repo_lesson', { repo: 'acme/web', text: `key AKIA${'B'.repeat(16)}` })).text, /secret/)
    assert.deepEqual(((await writer.call('get_repo_brief', { repo: 'acme/web' })).value.lessons as { text: string; by: string }[]).map((l) => [l.by, l.text]), [['Scribe', 'npm test needs python3 for the terminal tests.'], ['you', 'Deploys run the web tests too.']])
    assert.ok(!(await writer.call('request_repo_brief', { repo: 'acme/web', refresh: true })).error)
    const again = await writer.call('wait_for_work', { timeout_seconds: 0, briefs: true, cards: false })
    assert.deepEqual([again.value.refresh, again.value.written_from, again.value.lessons], [true, 'abc1234def', 2])
    await new Promise((done) => setTimeout(done, 5))
    await writer.call('add_repo_lesson', { repo: 'acme/web', text: 'The board’s drag needs a mouse fallback.' })
    await writer.call('send_repo_brief', { repo: 'acme/web', text: brief(' Now with a phone view.'), sha: 'fff0000' })
    const now = hub.state.briefs![0]
    assert.deepEqual([now.sha, now.lessons?.map((l) => l.text)], ['fff0000', ['The board’s drag needs a mouse fallback.']], 'the lessons it was given folded in, the newer one kept')
    assert.equal(now.noteId, kept.id, 'written again into the same note')
    assert.match(hub.state.notes.find((n) => n.id === kept.id)!.text, /Now with a phone view\./)

    // A card says its repo, so a runner knows whose brief it needs.
    const card = await you('POST', '/api/cards', { binderId: 'b1', title: 'Phone view', meantFor: scribe.body.agent.id })
    assert.equal((await writer.call('get_task', { id: card.body.id })).value.repo, 'acme/web')

    assert.equal((await you('DELETE', `/api/briefs/acme/web/lessons/${encodeURIComponent(now.lessons![0].at)}`)).status, 200)
    assert.equal(hub.state.briefs![0].lessons, undefined)
    assert.equal((await you('DELETE', '/api/briefs/acme/web')).status, 200)
    assert.equal(hub.state.briefs!.length, 0)
    for (const c of [writer, other]) await c.client.close()
    await close()
  })
})

describe('the runner, from the hub', () => {
  it('hands out the runner’s file and its installer, so runners can install and update themselves', async () => {
    const { url, close } = await setUp()
    const file = await fetch(`${url}/runner/binders-runner.mjs`)
    assert.equal(file.status, 200, 'built before the tests, as the image builds it')
    assert.match(await file.text(), /runnerVersion = "\d+\.\d+\.\d+"/)
    const install = await fetch(`${url}/install`)
    assert.equal(install.status, 200)
    assert.match(await install.text(), /\/runner\/binders-runner\.mjs/)
    const onWindows = await fetch(`${url}/install.ps1`)
    assert.equal(onWindows.status, 200)
    assert.match(await onWindows.text(), /\/runner\/binders-runner\.mjs[\s\S]*binders\.cmd/)
    await close()
  })

  it('asks an agent’s runners to restart, for whoever may manage it', async () => {
    const { url, hub, close } = await setUp({ admins: ['root'], members: [{ login: 'you', role: 'member' }, { login: 'other', role: 'member' }] })
    const you = api(url, await signIn(url))
    const made = await you('POST', '/api/agents', { name: 'Builder' })
    const agent = await agentClient(url, made.body.token)
    assert.equal((await agent.call('whoami')).value.restartAsked, undefined)
    const asked = await you('POST', `/api/agents/${made.body.agent.id}/restart`)
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(((await agent.call('whoami')).value.restartAsked as { by: string }).by, 'you')
    // Kept through an edit.
    await you('PATCH', `/api/agents/${made.body.agent.id}`, { name: 'Builder 2' })
    assert.equal(hub.state.agents.find((a) => a.id === made.body.agent.id)!.restartAsked?.by, 'you')
    const other = api(url, await signIn(url, 'other'))
    assert.match((await other('POST', `/api/agents/${made.body.agent.id}/restart`)).body.error, /can restart its runner/)
    await agent.client.close()
    await close()
  })
})

describe('repo briefs from before they were notes', () => {
  it('are moved into notes in Repo docs when the hub starts', async () => {
    const { hub, actions, close } = await setUp()
    await hub.submit('you', 'tab-1', [{ id: 'r1', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } } }])
    await hub.record({ kind: 'hub' }, { type: 'brief.put', brief: { id: 'acme/web', repo: 'acme/web', text: '## Map\nsrc/hub.ts: the log.', writtenAt: '2026-11-01T00:00:00.000Z' } })
    await actions.moveBriefsToNotes()
    const brief = hub.state.briefs![0]
    assert.equal(brief.text, undefined)
    const note = hub.state.notes.find((n) => n.id === brief.noteId)!
    assert.equal(note.text, '# Brief\n\n## Map\nsrc/hub.ts: the log.\n')
    await actions.moveBriefsToNotes()
    assert.equal(hub.state.notes.filter((n) => n.title === 'Brief').length, 1, 'once')
    await close()
  })
})

describe('a browser’s state', () => {
  const diff = [{ path: 'src/a.ts', added: 1, removed: 0, lines: [{ kind: '+' as const, text: 'a new line', n: 1 }] }]
  const pull = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: '', state: 'open' as const, checks: [], files: diff }
  const card = { id: 'c-light', binderId: 'b1', title: 'A card', brief: '', doneWhen: '', size: 'S' as const, stage: 'working' as const, createdAt: 'now', createdBy: 'you', updatedAt: 'now', waitsFor: [], activity: [], worktree: { branch: 'b', base: 'main', files: diff, at: 'now' } }
  const withWork = async () => {
    const set = await setUp()
    await set.hub.record({ kind: 'hub' }, { type: 'pr.put', pull })
    await set.hub.record({ kind: 'hub' }, { type: 'card.put', card })
    return { ...set, as: api(set.url, await signIn(set.url)) }
  }

  it('leaves out diffs’ lines, and gives a pull request’s when it’s opened', async () => {
    const { as, close } = await withWork()
    const whole = (await as('GET', '/api/state')).body.state
    assert.equal(whole.pulls[0].files[0].lines.length, 1, 'the apps still get all of it')
    const light = (await as('GET', '/api/state?light=1')).body.state
    assert.deepEqual(light.pulls[0].files, [{ path: 'src/a.ts', added: 1, removed: 0, lines: [] }])
    assert.deepEqual(light.cards.find((c: { id: string }) => c.id === 'c-light').worktree.files[0].lines, [])

    assert.deepEqual((await as('GET', '/api/pulls/acme%2Fweb/7/files')).body.files, diff)
    assert.equal((await as('GET', '/api/pulls/acme%2Fweb/8/files')).status, 404)
    await close()
  })

  it('sends no state to a page that’s current, or that’s been following and can catch up from the feed', async () => {
    const { hub, as, close } = await withWork()
    const now = hub.version
    assert.equal((await as('GET', `/api/state?light=1&have=${now}`)).body.state, undefined)
    assert.equal((await as('GET', `/api/state?light=1&have=${now}`)).body.version, now)
    assert.ok((await as('GET', `/api/state?light=1&have=${now - 1}`)).body.state, 'a page just loaded starts from the whole state')
    assert.equal((await as('GET', `/api/state?light=1&have=${now - 1}&replay=1`)).body.state, undefined)
    assert.ok((await as('GET', `/api/state?light=1&have=${now + 5}&replay=1`)).body.state, 'ahead of the hub: it started over')
    assert.ok((await as('GET', '/api/state?light=1&have=0&replay=1')).body.state)
    await close()
  })

  it('isn’t told to catch up from changes a rebuilt log no longer has, or from too far back', async () => {
    const log = new MemoryLog()
    const hub = new Hub(log)
    await hub.start(undefined, { version: 3000, state: new Hub(new MemoryLog()).state })
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b9', name: 'After' } })
    assert.equal(hub.version, 3001)
    assert.equal(await canCatchUp(hub, 3000), true)
    assert.equal(await canCatchUp(hub, 2999), false, 'what came before the rebuild isn’t in the log')
    assert.equal(await canCatchUp(hub, 500), false, 'more than the feed should replay')
  })

  it('leaves them out of the live feed too, for a browser', async () => {
    const { hub, url, close } = await withWork()
    const cookie = await signIn(url)
    const listen = async (query: string) => {
      const received: Entry[] = []
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=${hub.version}${query}`, { headers: { cookie } })
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string; entries?: Entry[] }
        if (message.type === 'entries') received.push(...message.entries!)
      })
      await new Promise((done) => socket.once('open', done))
      return { received, socket }
    }
    const light = await listen('&light=1')
    const whole = await listen('')
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { files: diff } })
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: card.id, fields: { worktree: card.worktree } })
    await until(() => light.received.length === 2 && whole.received.length === 2)
    const files = (entries: Entry[]) => entries.map((e) => (e.change.type === 'pr.update' ? e.change.fields.files : e.change.type === 'card.update' ? e.change.fields.worktree?.files : undefined)?.[0].lines.length)
    assert.deepEqual(files(light.received), [0, 0])
    assert.deepEqual(files(whole.received), [1, 1])
    assert.deepEqual((light.received[0].change as { fields: { files: unknown[] } }).fields.files, [{ path: 'src/a.ts', added: 1, removed: 0, lines: [] }])
    light.socket.close()
    whole.socket.close()
    await close()
  })
})

describe('a note’s text, asked for when it’s opened', () => {
  const put = (id: string, title: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'note.put' as const, note: { id, title, binderId: 'b1', editedAt: '2026-11-10T08:00:00.000Z', editors: ['you'], text, ...extra } })
  const withNotes = async () => {
    const set = await setUp()
    // A deeper folder, to see a place from the outermost in.
    await set.hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'f2', binderId: 'b1', name: 'Quarterly', parentId: 'f1' } })
    await set.hub.record({ kind: 'hub' }, put('t1', 'Target', '# Target\n\nWhat the others point at.\n'))
    await set.hub.record({ kind: 'hub' }, put('l1', 'Links once', '# Links once\n\nIntro line.\n- first, see [[Target]] for more\n- and again [[target]]\n'))
    await set.hub.record({ kind: 'hub' }, put('l2', 'Links in a heading', '# Links in a heading\n\n## [[Target|The target]] again\n'))
    await set.hub.record({ kind: 'hub' }, put('l3', 'Links elsewhere', '# Links elsewhere\n\nOnly [[Something else]].\n'))
    await set.hub.record({ kind: 'hub' }, put('d1', 'Deep', '# Deep\n\nThe rollout needs a zebra crossing.\n', { folderId: 'f2' }))
    return { ...set, as: api(set.url, await signIn(set.url)) }
  }

  it('answers a note’s text and when it was edited, from the hub’s own copy', async () => {
    const { as, close } = await withNotes()
    const got = await as('GET', '/api/notes/t1/text')
    assert.equal(got.status, 200)
    assert.deepEqual(got.body, { text: '# Target\n\nWhat the others point at.\n', editedAt: '2026-11-10T08:00:00.000Z' })
    const missing = await as('GET', '/api/notes/nope/text')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: 'No such note' })
    await close()
  })

  it('names the other notes that link to a note, in lower case, with the first line that does', async () => {
    const { as, close } = await withNotes()
    const got = await as('GET', '/api/notes/t1/backlinks')
    assert.equal(got.status, 200)
    assert.deepEqual(got.body.notes, [
      { id: 'l1', title: 'Links once', line: 'first, see [[Target]] for more' },
      { id: 'l2', title: 'Links in a heading', line: '[[Target|The target]] again' },
    ])
    assert.deepEqual((await as('GET', '/api/notes/l3/backlinks')).body, { notes: [] })
    assert.deepEqual((await as('GET', '/api/notes/n1/backlinks')).body, { notes: [] })
    assert.equal((await as('GET', '/api/notes/nope/backlinks')).status, 404)
    await close()
  })

  it('leaves out a note that links to itself', async () => {
    const { hub, as, close } = await withNotes()
    await hub.record({ kind: 'hub' }, put('t1', 'Target', '# Target\n\nSee [[target]].\n'))
    assert.deepEqual((await as('GET', '/api/notes/t1/backlinks')).body.notes.map((n: { id: string }) => n.id), ['l1', 'l2'])
    await close()
  })

  it('searches titles, places and text, each word anywhere among them, in the state’s order', async () => {
    const { as, close } = await withNotes()
    const ids = async (q: string) => (await as('GET', `/api/notes/search?q=${encodeURIComponent(q)}`)).body.ids
    assert.deepEqual(await ids('zebra'), ['d1'], 'only in the text')
    assert.deepEqual(await ids('ZEBRA Crossing'), ['d1'], 'in lower case, every word')
    assert.deepEqual(await ids('quarterly'), ['d1'], 'a folder’s name')
    assert.deepEqual(await ids('server planning quarterly'), ['d1'], 'the Binder’s name, then the folders’ from the outermost in')
    assert.deepEqual(await ids('deep zebra'), ['d1'], 'one word in the title and one in the text')
    assert.deepEqual(await ids('deep rubbish'), [], 'every word has to be there')
    assert.deepEqual(await ids('links'), ['l1', 'l2', 'l3'])
    assert.deepEqual(await ids('planning'), ['n1', 'd1'], 'the folder’s own notes and the ones inside it')
    await close()
  })

  it('answers nothing to a search that’s too short or too long, and at most 200 ids', async () => {
    const { hub, as, close } = await withNotes()
    assert.deepEqual((await as('GET', '/api/notes/search?q=z')).body, { ids: [] })
    assert.deepEqual((await as('GET', '/api/notes/search?q=')).body, { ids: [] })
    assert.deepEqual((await as('GET', '/api/notes/search')).body, { ids: [] })
    assert.deepEqual((await as('GET', '/api/notes/search?q=%20%20')).body, { ids: [] }, 'spaces are no words')
    assert.deepEqual((await as('GET', `/api/notes/search?q=${'a'.repeat(201)}`)).body, { ids: [] })
    assert.equal((await as('GET', `/api/notes/search?q=${'a'.repeat(200)}`)).status, 200)
    for (let i = 0; i < 210; i++) await hub.record({ kind: 'hub' }, put(`m${i}`, `Many ${i}`, `# Many ${i}\n\nsame words\n`))
    const ids = (await as('GET', '/api/notes/search?q=same%20words')).body.ids
    assert.equal(ids.length, 200)
    assert.equal(ids[0], 'm0')
    await close()
  })

  it('finds a note in a folder that loops back on itself without going round for ever', async () => {
    const { hub, as, close } = await withNotes()
    await hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'fa', binderId: 'b1', name: 'Alpha', parentId: 'fb' } })
    await hub.record({ kind: 'hub' }, { type: 'folder.put', folder: { id: 'fb', binderId: 'b1', name: 'Beta', parentId: 'fa' } })
    await hub.record({ kind: 'hub' }, put('c1', 'Circular', '# Circular\n', { folderId: 'fa' }))
    assert.deepEqual((await as('GET', '/api/notes/search?q=beta%20alpha')).body.ids, ['c1'])
    await close()
  })

  it('refuses a note put from a browser that holds it without its text, and the Binder keeps the note', async () => {
    const { hub, url, close } = await withNotes()
    const you = api(url, await signIn(url))
    const before = hub.version
    const refused = await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'light', change: put('t1', 'Target', '', { left: { size: 40, head: '# Target', links: [] } }) }] })
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, 'This note’s text isn’t loaded in this browser, so it can’t be saved from it.')
    assert.equal(hub.version, before, 'nothing went in the log')
    assert.equal(hub.state.notes.find((n) => n.id === 't1')?.text, '# Target\n\nWhat the others point at.\n')
    // A whole note goes in as before.
    const fine = await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'whole', change: put('t1', 'Target', '# Target\n\nChanged.\n') }] })
    assert.equal(fine.status, 200)
    assert.equal(hub.state.notes.find((n) => n.id === 't1')?.text, '# Target\n\nChanged.\n')
    await close()
  })

  it('has /api/state whole, and /api/state?light=1 without any note’s text', async () => {
    const { as, close } = await withNotes()
    const whole = (await as('GET', '/api/state')).body.state
    const t1 = whole.notes.find((n: { id: string }) => n.id === 't1')
    assert.equal(t1.text, '# Target\n\nWhat the others point at.\n')
    assert.equal(t1.left, undefined)
    const light = (await as('GET', '/api/state?light=1')).body.state
    assert.ok(light.notes.length > 1)
    for (const n of light.notes) {
      assert.equal(n.text, '', n.id)
      assert.equal(typeof n.left.size, 'number', n.id)
    }
    assert.deepEqual(light.notes.find((n: { id: string }) => n.id === 'l1').left.links, ['target'])
    await close()
  })

  it('sends a note’s change whole on the live feed to a browser holding the light state', async () => {
    const { hub, url, close } = await withNotes()
    const cookie = await signIn(url)
    const received: Entry[] = []
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=${hub.version}&light=1`, { headers: { cookie } })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; entries?: Entry[] }
      if (message.type === 'entries') received.push(...message.entries!)
    })
    await new Promise((done) => socket.once('open', done))
    await hub.record({ kind: 'hub' }, put('t1', 'Target', '# Target\n\nLive words.\n'))
    await until(() => received.length === 1)
    const got = received[0].change
    assert.equal(got.type === 'note.put' && got.note.text, '# Target\n\nLive words.\n')
    socket.close()
    await close()
  })
})

describe('a finished card’s detail, asked for when it’s opened', () => {
  const day = 86_400_000
  const ago = (days: number) => new Date(Date.now() - days * day).toISOString()
  const line = (n: number) => ({ at: ago(30 - n / 10), by: 'builder', kind: 'step' as const, tool: 'Bash', text: `step ${n}`, result: 'ok' })
  const finished = (id: string, extra: Record<string, unknown> = {}) => ({
    id, binderId: 'b1', title: `Card ${id}`, brief: `Brief of ${id}.`, doneWhen: 'It works.', size: 'M' as const, stage: 'live' as const, createdAt: ago(40), createdBy: 'you', updatedAt: ago(20), waitsFor: [], activity: Array.from({ length: 30 }, (_, n) => line(n)),
    debrief: { state: 'done' as const, askedBy: 'you', askedAt: ago(21), agentId: 'builder' }, ...extra,
  })
  const withCards = async () => {
    const set = await setUp()
    await set.hub.record({ kind: 'hub' }, { type: 'card.put', card: finished('old') })
    await set.hub.record({ kind: 'hub' }, { type: 'card.put', card: finished('yesterday', { updatedAt: ago(1) }) })
    return { ...set, as: api(set.url, await signIn(set.url)) }
  }

  it('answers a card as the hub has it, detail and every line of its activity', async () => {
    const { hub, as, close } = await withCards()
    const got = await as('GET', '/api/cards/old/whole')
    assert.equal(got.status, 200)
    assert.deepEqual(Object.keys(got.body), ['card'])
    assert.deepEqual(got.body.card, JSON.parse(JSON.stringify(hub.state.cards.find((c) => c.id === 'old'))))
    assert.equal(got.body.card.brief, 'Brief of old.')
    assert.equal(got.body.card.activity.length, 30)
    assert.equal(got.body.card.left, undefined)
    assert.equal(got.body.card.debrief.state, 'done')
    await close()
  })

  it('answers 404 for a card that isn’t there', async () => {
    const { as, close } = await withCards()
    const missing = await as('GET', '/api/cards/nope/whole')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: 'No such card.' })
    await close()
  })

  it('has /api/state give every card whole, and /api/state?light=1 give the old one without its detail', async () => {
    const { as, close } = await withCards()
    const whole = (await as('GET', '/api/state')).body.state.cards as { id: string; brief: string; activity: unknown[]; left?: unknown; debrief?: unknown }[]
    for (const id of ['old', 'yesterday']) {
      const c = whole.find((x) => x.id === id)!
      assert.equal(c.brief, `Brief of ${id}.`, id)
      assert.equal(c.activity.length, 30, id)
      assert.equal(c.left, undefined, id)
      assert.ok(c.debrief, id)
    }
    const light = (await as('GET', '/api/state?light=1')).body.state.cards as typeof whole
    const old = light.find((x) => x.id === 'old')!
    assert.equal(old.brief, '')
    assert.deepEqual(old.activity, [])
    assert.deepEqual(old.left, { debrief: 'done' })
    assert.equal(old.debrief, undefined)
    const recent = light.find((x) => x.id === 'yesterday')!
    assert.equal(recent.brief, 'Brief of yesterday.')
    assert.equal(recent.left, undefined)
    assert.ok(recent.debrief)
    await close()
  })

  it('refuses a card put from a browser that holds it without its detail, and the Binder keeps the card', async () => {
    const { hub, url, close } = await withCards()
    const you = api(url, await signIn(url))
    const before = hub.version
    const shell = leftCard(finished('old', { title: 'Overwritten' }))
    const refused = await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'light', change: { type: 'card.put', card: shell } }] })
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, 'This card isn’t loaded in this browser, so it can’t be saved from it.')
    assert.equal(hub.version, before, 'nothing went in the log')
    const kept = hub.state.cards.find((c) => c.id === 'old')!
    assert.equal(kept.title, 'Card old')
    assert.equal(kept.brief, 'Brief of old.')
    assert.equal(kept.activity.length, 30)
    // A whole card goes in as before.
    const fine = await you('POST', '/api/changes', { client: 'tab-1234', changes: [{ id: 'whole', change: { type: 'card.put', card: finished('old', { title: 'Renamed' }) } }] })
    assert.equal(fine.status, 200)
    assert.equal(hub.state.cards.find((c) => c.id === 'old')?.title, 'Renamed')
    assert.equal(hub.state.cards.find((c) => c.id === 'old')?.left, undefined)
    await close()
  })

  it('sends a card’s change whole on the live feed to a browser holding the light state', async () => {
    const { hub, url, close } = await withCards()
    const cookie = await signIn(url)
    const received: Entry[] = []
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?since=${hub.version}&light=1`, { headers: { cookie } })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; entries?: Entry[] }
      if (message.type === 'entries') received.push(...message.entries!)
    })
    await new Promise((done) => socket.once('open', done))
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: finished('old', { brief: 'Changed.' }) })
    await until(() => received.length === 1)
    const got = received[0].change
    assert.equal(got.type === 'card.put' && got.card.brief, 'Changed.')
    assert.equal(got.type === 'card.put' && got.card.left, undefined)
    socket.close()
    await close()
  })
})
