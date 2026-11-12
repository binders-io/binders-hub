import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Member, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { EndpointAgents } from '../src/agent/endpoint.ts'
import { BrainMachines } from '../src/brain/machines.ts'
import { serve } from '../../runner/src/brain.ts'
import { seed } from './helpers.ts'

// root runs the hub (one of its admins) and is one of the Binder's admins as well; ana runs the Binder and no more than that.
const people: Member[] = [{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }, { login: 'di', role: 'reader' }, { login: 'root', role: 'admin' }]

/** A stand-in for a model server: one that calls the tool it's asked to, or one that only talks. */
async function modelServer(callsTools: boolean) {
  const seen: { path: string; auth?: string; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      seen.push({ path: request.url ?? '', auth: request.headers.authorization, body: JSON.parse(raw || '{}') as Record<string, unknown> })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [callsTools ? { message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ready', arguments: '{}' } }] }, finish_reason: 'tool_calls' } : { message: { content: 'I am ready!' }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`, seen, close: () => new Promise<void>((done) => server.close(() => done())) }
}

async function setUp() {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  await kv.set('spaces', JSON.stringify([{ id: 'acme', name: 'Acme', createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'hub', members: people }]))
  const settings = await new BrainSettingsStore(new MemoryKV(), sealer, {}).load()
  // The hub's machines, which a model's server can be on.
  const machines = await new BrainMachines(new MemoryKV()).load()
  settings.useMachines(machines)
  const made: Record<string, Space & { own: MemoryKV }> = {}
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const actions = new Actions(hub, github)
    const own = new MemoryKV()
    // Not started: these tests are of setting one up, and nothing here should wait for work.
    const endpoints = new EndpointAgents({ hub, actions, kv: own, sealer, brain: settings, reach: { thisMachineToo: true } })
    made[id] = { id, hub, actions, github, webhooks: new Webhooks(hub, actions), endpoints, own }
    return made[id]
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: people })
  const app = await buildServer(spaces, { auth, brain: settings, machines }, { publicUrl: 'http://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string) => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', 'x-binders-space': 'acme', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined, raw: text }
    }
  }
  return { as, url, space: () => made.acme, close: async () => { machines.closeAll(); await app.close() } }
}

describe('an agent that is a model, over the hub’s API', () => {
  it('is added by the Binder’s owners and admins, tried as it’s made, and its key is never sent back', async () => {
    const set = await setUp()
    const good = await modelServer(true)
    try {
      const [ana, cy, di] = await Promise.all(['ana', 'cy', 'di'].map((login) => set.as(login)))
      const fields = { name: 'Foundry GPT', kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'az-key-123' }
      assert.equal((await cy('POST', '/api/agents/endpoint', fields)).status, 422)
      assert.equal((await di('POST', '/api/agents/endpoint', fields)).status, 403)
      assert.equal((await cy('POST', '/api/agents/endpoint/test', fields)).status, 422)

      assert.deepEqual((await ana('POST', '/api/agents/endpoint/test', fields)).body, { ok: true })
      assert.equal(good.seen[0].auth, 'Bearer az-key-123')
      assert.equal(good.seen[0].path, '/openai/v1/chat/completions')
      assert.equal(good.seen[0].body.model, 'gpt-deploy')

      const made = await ana('POST', '/api/agents/endpoint', fields)
      assert.equal(made.status, 200)
      const agent = made.body.agent
      assert.deepEqual({ name: agent.name, owner: agent.owner, runsOn: agent.runsOn, kind: agent.endpoint.kind, model: agent.endpoint.model, takes: agent.endpoint.takes, ok: agent.endpoint.ready.ok }, { name: 'Foundry GPT', owner: 'ana', runsOn: 'This hub', kind: 'openai', model: 'gpt-deploy', takes: { cards: true, chats: true, debriefs: true, challenges: true }, ok: true })
      assert.ok(!made.raw.includes('az-key-123'), 'the key isn’t in the answer')
      assert.ok(!JSON.stringify(set.space().hub.state).includes('az-key-123'), 'nor in the state')
      const kept = await set.space().own.get(`endpoint-key:${agent.id}`)
      assert.ok(kept && !kept.includes('az-key-123'), 'it’s sealed in the Binder’s own store')

      // What it takes can be changed, and a new key replaces the old; it's tried again each time.
      const before = good.seen.length
      const changed = await ana('PATCH', `/api/agents/${agent.id}/endpoint`, { takes: { cards: true, chats: false, debriefs: false, challenges: true }, key: 'az-key-456' })
      assert.deepEqual(changed.body.agent.endpoint.takes, { cards: true, chats: false, debriefs: false, challenges: true })
      assert.equal(good.seen.length, before + 1)
      assert.equal(good.seen.at(-1)!.auth, 'Bearer az-key-456')
      assert.equal((await cy('PATCH', `/api/agents/${agent.id}/endpoint`, { takes: { chats: true } })).status, 422)

      // Changed with no key given, it's tried with the one that's kept.
      await ana('PATCH', `/api/agents/${agent.id}/endpoint`, { model: 'gpt-deploy-2' })
      assert.equal(good.seen.at(-1)!.auth, 'Bearer az-key-456')
      assert.equal(good.seen.at(-1)!.body.model, 'gpt-deploy-2')

      // Revoked, its key goes too.
      assert.equal((await ana('DELETE', `/api/agents/${agent.id}`)).status, 200)
      assert.equal(await set.space().own.get(`endpoint-key:${agent.id}`), undefined)
    } finally {
      await good.close()
      await set.close()
    }
  })

  it('is still made when its model can’t do the work, saying why, so it can be put right', async () => {
    const set = await setUp()
    const talks = await modelServer(false)
    try {
      const ana = await set.as('ana')
      const tried = (await ana('POST', '/api/agents/endpoint/test', { kind: 'openai', baseUrl: talks.url, model: 'small' })).body
      assert.equal(tried.ok, false)
      assert.match(tried.why, /didn’t call the tool it was asked to/)
      const made = (await ana('POST', '/api/agents/endpoint', { name: 'Small one', kind: 'openai', baseUrl: talks.url, model: 'small' })).body.agent
      assert.equal(made.endpoint.ready.ok, false)
      assert.match(made.endpoint.ready.why, /can’t do an agent’s work/)

      const own = (await ana('POST', '/api/agents/endpoint', { name: 'The hub’s own', kind: 'brain' })).body.agent
      assert.deepEqual({ kind: own.endpoint.kind, ok: own.endpoint.ready.ok }, { kind: 'brain', ok: false })
      assert.match(own.endpoint.ready.why, /The hub has no model of its own yet/)
      assert.equal('baseUrl' in own.endpoint, false)
    } finally {
      await talks.close()
      await set.close()
    }
  })

  it('refuses an address that isn’t one, a kind it doesn’t know, and a model with no name', async () => {
    const set = await setUp()
    try {
      const ana = await set.as('ana')
      assert.equal((await ana('POST', '/api/agents/endpoint', { name: 'X', kind: 'openai', baseUrl: 'not an address', model: 'm' })).status, 422)
      assert.equal((await ana('POST', '/api/agents/endpoint', { name: 'X', kind: 'telnet', baseUrl: 'https://x.example.com/v1', model: 'm' })).status, 422)
      assert.equal((await ana('POST', '/api/agents/endpoint', { name: 'X', kind: 'openai', baseUrl: 'https://x.example.com/v1' })).status, 422)
      assert.equal((await ana('POST', '/api/agents/endpoint', { name: '', kind: 'brain' })).status, 422)
      assert.deepEqual(set.space().hub.state.agents, [])
    } finally {
      await set.close()
    }
  })
})

describe('a step of an agent’s model, taken by the hub for an agent on a machine', () => {
  const step = (url: string, token: string | undefined, body: unknown) => fetch(`${url}/api/agent/step`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }))
  const asked = { system: 'Work in the repo.', turns: [{ role: 'user', text: 'Fix the header.' }], tools: [{ name: 'ready', description: 'Says the model can call tools.', input: { type: 'object', properties: {} } }] }

  it('takes the agent’s own token, asks its model with the key the hub keeps, and gives back the step', async () => {
    const set = await setUp()
    const good = await modelServer(true)
    try {
      const ana = await set.as('ana')
      const made = (await ana('POST', '/api/agents', { name: 'On a machine', provider: 'other', repos: [], binders: [], skills: [] })).body as { agent: { id: string }; token: string }
      const url = set.url
      // With no model of its own yet, there's nothing to ask.
      assert.deepEqual(await step(url, made.token, asked), { status: 502, body: { error: 'This agent has no model of its own. Give it one on the Agents page.' } })

      const agent = set.space().hub.state.agents.find((a) => a.id === made.agent.id)!
      await set.space().actions.putAgent('ana', { ...agent, endpoint: { kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', takes: { cards: true, chats: true, debriefs: true, challenges: true } } }, agent.id)
      await set.space().endpoints!.setKey(agent.id, 'az-key-789')
      const before = good.seen.length
      const answer = await step(url, made.token, asked)
      assert.equal(answer.status, 200)
      assert.deepEqual(answer.body, { text: '', calls: [{ id: 'c1', name: 'ready', input: {} }], stop: 'tools' })
      assert.ok(!JSON.stringify(answer.body).includes('az-key-789'), 'the key stays on the hub')
      // The server was asked whether it calls tools, then for the step itself: both with the hub's key.
      const sent = good.seen.slice(before)
      assert.ok(sent.length >= 1 && sent.every((s) => s.auth === 'Bearer az-key-789'))
      assert.deepEqual((sent.at(-1)!.body.messages as { role: string; content: string }[]).map((m) => [m.role, m.content]), [['system', 'Work in the repo.'], ['user', 'Fix the header.']])
    } finally {
      await good.close()
      await set.close()
    }
  })

  it('answers no one without an agent’s token, a revoked agent’s, or a step that isn’t one', async () => {
    const set = await setUp()
    try {
      const ana = await set.as('ana')
      const made = (await ana('POST', '/api/agents', { name: 'On a machine', provider: 'other', repos: [], binders: [], skills: [] })).body as { agent: { id: string }; token: string }
      assert.equal((await step(set.url, undefined, asked)).status, 401)
      assert.equal((await step(set.url, 'bnd_not-a-token', asked)).status, 401)
      assert.equal((await step(set.url, made.token, { ...asked, turns: [] })).status, 400)
      assert.equal((await step(set.url, made.token, { ...asked, system: 5 })).status, 400)
      assert.equal((await step(set.url, made.token, { ...asked, tools: [{ name: 'bad name!', description: 'x', input: {} }] })).status, 400)
      await ana('DELETE', `/api/agents/${made.agent.id}`)
      assert.equal((await step(set.url, made.token, asked)).status, 401)
    } finally {
      await set.close()
    }
  })
})

describe('an agent on a machine, and its model', () => {
  const machine = { name: 'On a machine', provider: 'other', repos: [], binders: [], skills: [], runner: { tool: 'binders', access: 'full', timeoutMinutes: 60, worktrees: true } }

  it('is never given a model, or another one, through the routes that make and change an agent', async () => {
    const set = await setUp()
    try {
      const cy = await set.as('cy')
      const sneaky = { kind: 'openai', baseUrl: 'http://169.254.169.254/latest', model: 'm', takes: { cards: true, chats: true, debriefs: true, challenges: true } }
      const made = (await cy('POST', '/api/agents', { ...machine, endpoint: sneaky })).body as { agent: { id: string; endpoint?: unknown } }
      assert.equal(made.agent.endpoint, undefined)
      assert.equal(set.space().hub.state.agents.find((a) => a.id === made.agent.id)!.endpoint, undefined)
      await cy('PATCH', `/api/agents/${made.agent.id}`, { name: 'On a machine', endpoint: sneaky })
      assert.equal(set.space().hub.state.agents.find((a) => a.id === made.agent.id)!.endpoint, undefined)
      // Nor does a member give it one by the model's own route: that's the Binder's owners and admins.
      const refused = await cy('PATCH', `/api/agents/${made.agent.id}/endpoint`, { kind: 'brain' })
      assert.equal(refused.status, 422)
      assert.match(refused.raw, /owners and admins/)
    } finally {
      await set.close()
    }
  })

  it('is given a model by the Binder’s owners and admins, keeps its runner, and its model stays through other edits', async () => {
    const set = await setUp()
    const good = await modelServer(true)
    try {
      const ana = await set.as('ana')
      const made = (await ana('POST', '/api/agents', machine)).body as { agent: { id: string }; token: string }
      const none = await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { model: 'gpt-deploy' })
      assert.equal(none.status, 422)
      assert.match(none.raw, /Say what its model is/)

      const given = await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'az-key-1' })
      assert.equal(given.status, 200)
      const agent = (given.body as { agent: { runner?: { tool: string }; endpoint: { kind: string; model: string; ready: { ok: boolean } } } }).agent
      assert.equal(agent.runner?.tool, 'binders')
      assert.deepEqual([agent.endpoint.kind, agent.endpoint.model, agent.endpoint.ready.ok], ['openai', 'gpt-deploy', true])
      assert.ok(!given.raw.includes('az-key-1'))
      assert.equal(await set.space().endpoints!.keyFor(made.agent.id), 'az-key-1')

      // Another edit of the agent leaves its model as it is.
      await ana('PATCH', `/api/agents/${made.agent.id}`, { name: 'Renamed', runner: machine.runner })
      const after = set.space().hub.state.agents.find((a) => a.id === made.agent.id)!
      assert.deepEqual([after.name, after.endpoint?.model], ['Renamed', 'gpt-deploy'])
    } finally {
      await good.close()
      await set.close()
    }
  })

  it('gets another kind of model with a key of its own, and gives its model up', async () => {
    const set = await setUp()
    const good = await modelServer(true)
    try {
      const ana = await set.as('ana')
      const made = (await ana('POST', '/api/agents', machine)).body as { agent: { id: string } }
      await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'az-key-1' })
      // The hub's own model in its place: the first model's address, name and key all go.
      const other = (await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { kind: 'brain' })).body as { agent: { endpoint: { kind: string; baseUrl?: string; model?: string } } }
      assert.deepEqual([other.agent.endpoint.kind, other.agent.endpoint.baseUrl, other.agent.endpoint.model], ['brain', undefined, undefined])
      assert.equal(await set.space().endpoints!.keyFor(made.agent.id), undefined)

      await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'az-key-2' })
      const cy = await set.as('cy')
      assert.equal((await cy('DELETE', `/api/agents/${made.agent.id}/endpoint`)).status, 422)
      const gone = await ana('DELETE', `/api/agents/${made.agent.id}/endpoint`)
      assert.equal(gone.status, 200)
      const after = set.space().hub.state.agents.find((a) => a.id === made.agent.id)!
      assert.equal(after.endpoint, undefined)
      assert.equal(after.runner?.tool, 'binders')
      assert.equal(await set.space().endpoints!.keyFor(made.agent.id), undefined)

      // A model with no machine is nothing without its model: that one is revoked instead.
      const hosted = (await ana('POST', '/api/agents/endpoint', { name: 'Hosted', kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'k' })).body as { agent: { id: string } }
      const kept = await ana('DELETE', `/api/agents/${hosted.agent.id}/endpoint`)
      assert.equal(kept.status, 422)
      assert.match(kept.raw, /revoke the agent/)
    } finally {
      await good.close()
      await set.close()
    }
  })

  it('asks a model found to call tools only for the steps, not again whether it does, until its key changes', async () => {
    const set = await setUp()
    const good = await modelServer(true)
    try {
      const ana = await set.as('ana')
      const made = (await ana('POST', '/api/agents', machine)).body as { agent: { id: string }; token: string }
      await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'az-key-1' })
      const step = () => fetch(`${set.url}/api/agent/step`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${made.token}` }, body: JSON.stringify({ system: 'Work.', turns: [{ role: 'user', text: 'Go' }], tools: [{ name: 'read_file', description: 'Reads.', input: { type: 'object', properties: {} } }] }) }).then((r) => r.status)
      const before = good.seen.length
      assert.equal(await step(), 200)
      const first = good.seen.length - before
      assert.equal(await step(), 200)
      assert.equal(await step(), 200)
      assert.equal(good.seen.length - before, first + 2, 'one request for each further step')
      await ana('PATCH', `/api/agents/${made.agent.id}/endpoint`, { key: 'az-key-2' })
      const changed = good.seen.length
      assert.equal(await step(), 200)
      assert.equal(good.seen.at(-1)!.auth, 'Bearer az-key-2')
      assert.ok(good.seen.length - changed >= 2, 'asked again whether it calls tools, with the new key')
    } finally {
      await good.close()
      await set.close()
    }
  })
})

describe('a model’s key', () => {
  it('is never sent to an address it wasn’t typed for: another address needs its key again, to try and to save', async () => {
    const set = await setUp()
    const good = await modelServer(true)
    const elsewhere = await modelServer(true)
    try {
      const ana = await set.as('ana')
      const hosted = (await ana('POST', '/api/agents/endpoint', { name: 'Hosted', kind: 'openai', baseUrl: good.url, model: 'gpt-deploy', key: 'az-key-1' })).body as { agent: { id: string } }

      // Tried again with no key typed, at the server it was given for: its own key is used.
      const before = good.seen.length
      assert.deepEqual((await ana('POST', '/api/agents/endpoint/test', { agent: hosted.agent.id, kind: 'openai', baseUrl: good.url, model: 'gpt-deploy' })).body, { ok: true })
      assert.equal(good.seen[before].auth, 'Bearer az-key-1')

      // Tried at another address: nothing of the key goes there.
      await ana('POST', '/api/agents/endpoint/test', { agent: hosted.agent.id, kind: 'openai', baseUrl: elsewhere.url, model: 'gpt-deploy' })
      assert.ok(elsewhere.seen.length >= 1)
      assert.ok(elsewhere.seen.every((s) => !(s.auth ?? '').includes('az-key-1')))

      // Saved at another address with no key typed: the old key is forgotten, not sent along.
      await ana('PATCH', `/api/agents/${hosted.agent.id}/endpoint`, { baseUrl: elsewhere.url })
      assert.ok(elsewhere.seen.every((s) => !(s.auth ?? '').includes('az-key-1')))
      assert.equal(await set.space().endpoints!.keyFor(hosted.agent.id), undefined)

      // Another deployment at the same server keeps its key.
      await ana('PATCH', `/api/agents/${hosted.agent.id}/endpoint`, { baseUrl: good.url, key: 'az-key-2' })
      await ana('PATCH', `/api/agents/${hosted.agent.id}/endpoint`, { model: 'gpt-other' })
      assert.equal(await set.space().endpoints!.keyFor(hosted.agent.id), 'az-key-2')
      assert.equal(good.seen.at(-1)!.auth, 'Bearer az-key-2')
    } finally {
      await good.close()
      await elsewhere.close()
      await set.close()
    }
  })
})

describe('a model on the hub’s own machine or network', () => {
  // These tests' hub lets any address through for its stand-in servers; this one is as a real hub is.
  async function realHub() {
    const set = await setUp()
    ;(set.space().endpoints as unknown as { reach: object }).reach = {}
    return set
  }

  it('is a hub admin’s to add, over http too, and nobody else’s: a Binder’s owner is told who can, and what to do for a model on their own machine', async () => {
    const set = await realHub()
    const local = await modelServer(true)
    try {
      const ana = await set.as('ana')
      const refused = await ana('POST', '/api/agents/endpoint', { name: 'Proxy', kind: 'openai', baseUrl: local.url, model: 'deploy' })
      assert.equal(refused.status, 422)
      assert.match(refused.raw, /127\.0\.0\.1 is on this hub’s own machine or network, which only a hub admin can have a model reached at\. If the model is on your own machine, set up Binders’ own agent there/)
      assert.deepEqual((await ana('POST', '/api/agents/endpoint/test', { kind: 'openai', baseUrl: local.url, model: 'deploy' })).body.ok, false)
      assert.equal(local.seen.length, 0, 'nothing was sent there')

      // The hub's admin runs the hub, so its own machine is theirs to point a model at.
      const root = await set.as('root')
      assert.deepEqual((await root('POST', '/api/agents/endpoint/test', { kind: 'openai', baseUrl: local.url, model: 'deploy' })).body, { ok: true })
      const made = await root('POST', '/api/agents/endpoint', { name: 'Proxy', kind: 'openai', baseUrl: local.url, model: 'deploy' })
      assert.equal(made.status, 200)
      assert.equal((made.body as { agent: { endpoint: { ready: { ok: boolean } } } }).agent.endpoint.ready.ok, true)
      assert.equal(local.seen.at(-1)!.auth, undefined, 'a proxy that holds its own key is sent none')
    } finally {
      await local.close()
      await set.close()
    }
  })

  it('still wants https for an address out on the internet, whoever asks', async () => {
    const set = await realHub()
    try {
      const root = await set.as('root')
      const refused = await root('POST', '/api/agents/endpoint', { name: 'Far', kind: 'openai', baseUrl: 'http://models.example.com/v1', model: 'deploy' })
      assert.equal(refused.status, 422)
      assert.match(refused.raw, /has to start with https:\/\//)
    } finally {
      await set.close()
    }
  })
})

describe('where Binders’ own agent finds its model on its own machine', () => {
  const machine = (runner: object) => ({ name: 'On a machine', provider: 'other', repos: [], binders: [], skills: [], runner: { tool: 'binders', access: 'full', timeoutMinutes: 60, worktrees: true, ...runner } })

  it('is an address its owner gives with its runner’s settings, http and this machine included, with the model there', async () => {
    const set = await setUp()
    try {
      const ana = await set.as('ana')
      const made = (await ana('POST', '/api/agents', machine({ modelUrl: ' http://127.0.0.1:8000 ', model: 'DeepSeek-Deploy' }))).body as { agent: { id: string; runner: { modelUrl?: string; model?: string } } }
      assert.deepEqual([made.agent.runner.modelUrl, made.agent.runner.model], ['http://127.0.0.1:8000', 'DeepSeek-Deploy'])
      for (const [runner, why] of [
        [{ modelUrl: 'http://127.0.0.1:8000' }, /Say which model, or which deployment, is at that address/],
        [{ modelUrl: 'localhost:8000', model: 'm' }, /is a web address, such as http:\/\/127\.0\.0\.1:8000/],
        [{ modelUrl: 'http://user:secret@127.0.0.1:8000', model: 'm' }, /can’t have a name or password in it\. A key goes in BINDERS_MODEL_KEY on the machine/],
      ] as const) {
        const refused = await ana('PATCH', `/api/agents/${made.agent.id}`, { name: 'On a machine', runner: machine(runner).runner })
        assert.equal(refused.status, 422)
        assert.match(refused.raw, why)
      }
      // Another tool has no use for it: it isn't kept.
      const other = (await ana('PATCH', `/api/agents/${made.agent.id}`, { name: 'On a machine', runner: { tool: 'claude', access: 'full', timeoutMinutes: 60, worktrees: true, modelUrl: 'http://127.0.0.1:8000', model: 'opus' } })).body as { runner: { modelUrl?: string } }
      assert.equal(other.runner.modelUrl, undefined)
    } finally {
      await set.close()
    }
  })

  it('is its owner’s alone to change, as with the rest of what it runs', async () => {
    const set = await setUp()
    try {
      const cy = await set.as('cy')
      const made = (await cy('POST', '/api/agents', machine({ modelUrl: 'http://127.0.0.1:8000', model: 'm' }))).body as { agent: { id: string } }
      const ana = await set.as('ana')
      const refused = await ana('PATCH', `/api/agents/${made.agent.id}`, { name: 'On a machine', runner: machine({ modelUrl: 'http://10.0.0.9:1234', model: 'm' }).runner })
      assert.equal(refused.status, 422)
      assert.match(refused.raw, /Only On a machine’s owner, @cy, can change what it runs on their machine/)
      assert.equal(set.space().hub.state.agents.find((a) => a.id === made.agent.id)!.runner!.modelUrl, 'http://127.0.0.1:8000')
    } finally {
      await set.close()
    }
  })

  it('reaches a server on one of the hub’s machines through that machine, for a hub admin: a proxy on the hub’s own host', async () => {
    const set = await setUp()
    // A proxy to a cloud on the machine: it says which models it has, and its models call tools.
    const seen: { path: string; model?: string }[] = []
    const proxy = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => {
        const json = (value: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        if (request.url === '/v1/models') return json({ data: ['kimi-pro', 'gpt-5.1', 'gpt-5-mini', 'text-embedding-3-large'].map((id) => ({ id, owned_by: 'system' })) })
        // What the daemon asks to tell what kind of server it is isn't a request for a model.
        if (request.method !== 'POST') {
          response.writeHead(404)
          return response.end()
        }
        seen.push({ path: request.url ?? '', model: (JSON.parse(raw || '{}') as { model?: string }).model })
        json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ready', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
      })
    })
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done))
    const address = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1`
    const stop = new AbortController()
    try {
      const root = await set.as('root')
      const ana = await set.as('ana')
      const added = await root('POST', '/api/brain/machines', { name: 'Server' })
      const machine = added.body.machine.id as string
      void serve({ hub: set.url, token: added.body.token, extra: [address], only: true, signal: stop.signal, log: () => {} })
      for (let i = 0; i < 400 && !((await root('GET', '/api/agents/endpoint/servers')).body.servers.length > 0); i++) await new Promise((done) => setTimeout(done, 25))

      // What a form offers: to the hub's admins, the servers on its machines with the models to talk to; to nobody else.
      assert.deepEqual((await root('GET', '/api/agents/endpoint/servers')).body, { servers: [{ machine, machineName: 'Server', url: address, gateway: true, models: ['kimi-pro', 'gpt-5.1', 'gpt-5-mini'] }] })
      assert.deepEqual((await ana('GET', '/api/agents/endpoint/servers')).body, { servers: [] })

      // The machines are the hub's: someone who runs a Binder and no more can't have a model reached through one.
      const model = { kind: 'openai', baseUrl: address, model: 'kimi-pro', machine }
      assert.deepEqual((await ana('POST', '/api/agents/endpoint/test', model)).body, { ok: false, why: 'Only a hub admin can have an agent’s model reached through one of the hub’s machines.' })
      assert.equal((await ana('POST', '/api/agents/endpoint', { name: 'Kimi', ...model })).status, 422)
      assert.equal(seen.length, 0)

      // A hub admin's: tried through the machine, by the address as the machine sees it.
      assert.deepEqual((await root('POST', '/api/agents/endpoint/test', model)).body, { ok: true })
      assert.deepEqual(seen.at(-1), { path: '/v1/chat/completions', model: 'kimi-pro' })
      const made = await root('POST', '/api/agents/endpoint', { name: 'Kimi', ...model })
      assert.equal(made.status, 200)
      const { ready, ...endpoint } = made.body.agent.endpoint
      assert.deepEqual(endpoint, { kind: 'openai', baseUrl: address, model: 'kimi-pro', machine, machineName: 'Server', takes: { cards: true, chats: true, debriefs: true, challenges: true } })
      assert.equal(ready.ok, true)
      // Another model on the same server: the machine stays, as nothing said otherwise.
      const changed = await root('PATCH', `/api/agents/${made.body.agent.id}/endpoint`, { model: 'gpt-5.1' })
      assert.deepEqual([changed.body.agent.endpoint.model, changed.body.agent.endpoint.machine, changed.body.agent.endpoint.ready.ok], ['gpt-5.1', machine, true])
      assert.equal(seen.at(-1)?.model, 'gpt-5.1')

      // A machine that isn't the hub's, and an address that machine doesn't serve, are said in words.
      assert.deepEqual((await root('POST', '/api/agents/endpoint/test', { ...model, machine: 'm-none' })).body, { ok: false, why: 'That machine was removed from the hub.' })
      const elsewhere = (await root('POST', '/api/agents/endpoint/test', { ...model, baseUrl: 'http://127.0.0.1:9/v1' })).body
      assert.deepEqual(elsewhere, { ok: false, why: `Server has no server at that address. It serves ${address}.` })
      assert.match((await root('POST', '/api/agents/endpoint/test', { kind: 'anthropic', model: 'claude', baseUrl: address, machine })).body.why ?? 'none', /none|key|Anthropic/i, 'only an OpenAI-style server is reached through a machine: the machine is dropped for any other kind')
    } finally {
      stop.abort()
      await set.close()
      await new Promise<void>((done) => proxy.close(() => done()))
    }
  })
})
