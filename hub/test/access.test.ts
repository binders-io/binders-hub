import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { agentOnline, boardFor } from '../src/brain/board.ts'
import { GitHub } from '../src/github.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { installer, windowsInstaller } from '../src/routes/machines.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Member, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import type { Agent } from '../../shared/work.ts'

// Who may do what in a Binder, and what happens to a person's agents, and to a Binder, when they go.

async function setUp(members: Member[] = [{ login: 'ana', role: 'owner' }]) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const stopped: string[] = []
  const made: string[] = []
  const make = async (id: string): Promise<Space> => {
    made.push(id)
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start()
    const actions = new Actions(hub, github)
    return { id, hub, actions, github, webhooks: new Webhooks(hub, actions), stop: async () => void stopped.push(id) }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members })
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string, space?: string) => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
  }
  return { kv, spaces, auth, url, as, made, stopped, make, close: () => app.close() }
}

type Caller = Awaited<ReturnType<Awaited<ReturnType<typeof setUp>>['as']>>

/** What an agent's token gets from the hub's MCP: the start of a conversation, as any client begins one. */
async function agentConnects(url: string, token: string) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-agent', version: '1.0.0' } } }),
  })
  return { status: response.status, text: await response.text() }
}

/** A person's own MCP connection to a Binder, and a tool called through it. */
async function personCalls(url: string, token: string, tool: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: 'test-person', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/acme/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  try {
    const result = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[] }
    return JSON.parse(result.content[0].text) as unknown
  } finally {
    await client.close()
  }
}

const changes = (who: Caller, ...list: { type: string; [key: string]: unknown }[]) => who('POST', '/api/changes', { client: 'tab-1234', changes: list.map((change, i) => ({ id: `c${Math.random().toString(36).slice(2, 8)}${i}`, change })) })
const putBinder = (who: Caller, binder: Record<string, unknown>) => changes(who, { type: 'binder.put', binder })
const agentsIn = (spaces: Spaces, id: string) => spaces.get(id)!.hub.state.agents

describe('taking a person out of a Binder', () => {
  it('revokes the agents they own there, and says which, and leaves everyone else’s', async () => {
    const { spaces, as, url, close } = await setUp()
    const ana = await as('ana')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    await ana('PUT', '/api/spaces/acme/members/dee', { role: 'member' })
    const cy = await as('cy', 'acme')
    const dee = await as('dee', 'acme')
    const first = (await cy('POST', '/api/agents', { name: 'Builder' })).body
    const second = (await cy('POST', '/api/agents', { name: 'Reviewer' })).body
    const others = (await dee('POST', '/api/agents', { name: 'Tester' })).body
    assert.equal((await agentConnects(url, first.token)).status, 200, 'it works while its owner is in')

    const removed = await ana('DELETE', '/api/spaces/acme/members/cy')
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.body.revoked.map((r: { name: string }) => r.name).sort(), ['Builder', 'Reviewer'])
    assert.deepEqual(removed.body.revoked.find((r: { name: string }) => r.name === 'Builder'), { id: first.agent.id, name: 'Builder' })
    assert.ok(removed.body.spaces[0].members, 'beside the list it gave before')
    assert.deepEqual(agentsIn(spaces, 'acme').filter((a) => a.revoked).map((a) => a.id).sort(), [first.agent.id, second.agent.id].sort())
    // The token is gone with the agent, and the other person’s agent goes on.
    assert.equal((await agentConnects(url, first.token)).status, 403)
    assert.equal((await agentConnects(url, second.token)).status, 403)
    assert.equal((await agentConnects(url, others.token)).status, 200)
    // Someone who owns none has nothing revoked.
    assert.deepEqual((await ana('DELETE', '/api/spaces/acme/members/dee')).body.revoked.map((r: { name: string }) => r.name), ['Tester'])
    await ana('PUT', '/api/spaces/acme/members/eve', { role: 'member' })
    assert.deepEqual((await ana('DELETE', '/api/spaces/acme/members/eve')).body.revoked, [])
    await close()
  })

  it('refuses an agent whose owner isn’t in its Binder, in words, but not in a Binder open to everyone', async () => {
    const { spaces, as, url, close } = await setUp()
    const ana = await as('ana')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    const made = (await (await as('cy', 'acme'))('POST', '/api/agents', { name: 'Builder' })).body
    // Out of the list without the route: an agent set up before taking someone out took their agents too.
    await spaces.removeMember('acme', 'cy', true)
    const refused = await agentConnects(url, made.token)
    assert.equal(refused.status, 403, 'a 403, never a 401, as the agent’s client would ask to sign in again and again')
    assert.match(refused.text, /@cy isn’t in this binder any more, so Builder can’t work in it/)
    await close()

    // A Binder with no members is open to everyone the hub lets in: its agents work.
    const open = await setUp([])
    const bo = await (await open.as('bo', 'acme'))('POST', '/api/agents', { name: 'Builder' })
    assert.equal((await agentConnects(open.url, bo.body.token)).status, 200)
    await open.close()
  })

  it('lets one of the hub’s named admins keep an agent in a Binder they aren’t a member of', async () => {
    // root is named as an admin of this hub, and so may open any team Binder without being listed in it.
    const { as, url, close } = await setUp()
    const made = await (await as('root', 'acme'))('POST', '/api/agents', { name: 'Fixer' })
    assert.equal(made.status, 200)
    assert.equal((await agentConnects(url, made.body.token)).status, 200)
    await close()
  })
})

describe('a person leaving a Binder', () => {
  it('may take themselves out, and their agents with them', async () => {
    const { spaces, as, url, close } = await setUp()
    const ana = await as('ana')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    await ana('PUT', '/api/spaces/acme/members/dee', { role: 'member' })
    const cy = await as('cy', 'acme')
    const made = (await cy('POST', '/api/agents', { name: 'Builder' })).body
    // Only themselves: a member can't take someone else out.
    assert.equal((await cy('DELETE', '/api/spaces/acme/members/dee')).status, 422)
    const left = await cy('DELETE', '/api/spaces/acme/members/cy')
    assert.equal(left.status, 200)
    assert.deepEqual(left.body.revoked, [{ id: made.agent.id, name: 'Builder' }])
    assert.deepEqual(left.body.spaces.map((s: { id: string }) => s.id), ['~cy'], 'their own is all they have left')
    assert.deepEqual(spaces.info('acme')!.members.map((m) => m.login), ['ana', 'dee'])
    assert.equal((await agentConnects(url, made.token)).status, 403)
    // Not in it: it isn't theirs to leave.
    assert.equal((await cy('DELETE', '/api/spaces/acme/members/cy')).status, 422)
    await close()
  })

  it('isn’t open to the last owner, or from a personal Binder, and an owner leaves when another stays', async () => {
    const { spaces, as, close } = await setUp()
    const ana = await as('ana')
    const refused = await ana('DELETE', '/api/spaces/acme/members/ana')
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /at least one owner/)
    const personal = await ana('DELETE', '/api/spaces/~ana/members/ana')
    assert.equal(personal.status, 422)
    assert.match(personal.body.error, /personal Binder/)
    assert.ok(spaces.info('~ana'))
    await ana('PUT', '/api/spaces/acme/members/bo', { role: 'owner' })
    assert.equal((await ana('DELETE', '/api/spaces/acme/members/ana')).status, 200)
    assert.deepEqual(spaces.info('acme')!.members, [{ login: 'bo', role: 'owner' }])
    await close()
  })
})

describe('who runs a Binder, for everyone in it', () => {
  it('lists its owners and admins to its members, who still don’t get the whole list', async () => {
    const { as, close } = await setUp()
    const ana = await as('ana')
    await ana('PUT', '/api/spaces/acme/members/di', { role: 'admin' })
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    const cy = await as('cy')
    const seen = (await cy('GET', '/api/spaces')).body.spaces
    const acme = seen.find((s: { id: string }) => s.id === 'acme')
    assert.deepEqual(acme.managers, [{ login: 'ana', role: 'owner' }, { login: 'di', role: 'admin' }])
    assert.equal(acme.members, undefined)
    assert.deepEqual(seen.find((s: { id: string }) => s.id === '~cy').managers, [{ login: 'cy', role: 'owner' }], 'a personal one’s person owns it')
    assert.deepEqual((await ana('GET', '/api/spaces')).body.spaces[0].managers.map((m: { login: string }) => m.login), ['ana', 'di'])
    await close()
  })
})

describe('where a Binder’s cards and notes go', () => {
  async function team() {
    const set = await setUp()
    const ana = await set.as('ana', 'acme')
    await ana('PUT', '/api/spaces/acme/members/di', { role: 'admin' })
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    assert.equal((await putBinder(ana, { id: 'p1', name: 'App' })).status, 200)
    return { ...set, ana, di: await set.as('di', 'acme'), cy: await set.as('cy', 'acme'), root: await set.as('root', 'acme') }
  }
  const refusal = 'Only this Binder’s owners and admins can change where its cards and notes go.'

  it('is changed by its owners and admins, and the hub’s admins, and by no other member', async () => {
    const { spaces, ana, di, cy, root, close } = await team()
    const state = () => spaces.get('acme')!.hub.state.binders[0]
    // A member renames, and writes out what's already so, and nothing more.
    assert.equal((await putBinder(cy, { id: 'p1', name: 'App, renamed' })).status, 200)
    assert.equal((await putBinder(cy, { id: 'p1', name: 'App', issues: true, notes: true, reviewComments: false, notesBranch: '', repo: null })).status, 200, 'a default written out isn’t a change')
    for (const [field, value] of [['repo', 'acme/app'], ['repos', ['acme/app']], ['notes', false], ['notesBranch', 'docs'], ['issues', false], ['reviewComments', true]] as const) {
      const refused = await putBinder(cy, { id: 'p1', name: 'App', [field]: value })
      assert.equal(refused.status, 422, field)
      assert.equal(refused.body.error, refusal, field)
    }
    assert.ok(!state().repo)
    // A new binder with them set, too.
    assert.equal((await putBinder(cy, { id: 'p2', name: 'Second', repo: 'acme/second' })).status, 422)
    assert.equal((await putBinder(cy, { id: 'p2', name: 'Second' })).status, 200)

    // Its owner and its admin do, and the hub's admin, who isn't in it.
    assert.equal((await putBinder(ana, { id: 'p1', name: 'App', repo: 'acme/app' })).status, 200)
    assert.equal(state().repo, 'acme/app')
    assert.equal((await putBinder(di, { id: 'p1', name: 'App', repo: 'acme/app', issues: false })).status, 200)
    assert.equal((await putBinder(root, { id: 'p1', name: 'App', repo: 'acme/app', issues: false, notesBranch: 'docs' })).status, 200)
    assert.equal(state().notesBranch, 'docs')
    // A member keeping it all as it is, renaming: not a change.
    assert.equal((await putBinder(cy, { id: 'p1', name: 'App again', repo: 'ACME/app', issues: false, notesBranch: 'docs' })).status, 200)
    assert.equal(state().name, 'App again')
    // And clearing one is a change.
    assert.equal((await putBinder(cy, { id: 'p1', name: 'App again', repo: 'acme/app', notesBranch: 'docs' })).status, 422)
    await close()
  })

  it('takes a binder away only for its owners and admins', async () => {
    const { spaces, ana, di, cy, close } = await team()
    assert.equal((await putBinder(ana, { id: 'p2', name: 'Spare' })).status, 200)
    const refused = await changes(cy, { type: 'binder.delete', id: 'p2' })
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, refusal)
    assert.equal(spaces.get('acme')!.hub.state.binders.length, 2)
    assert.equal((await changes(di, { type: 'binder.delete', id: 'p2' })).status, 200)
    assert.equal(spaces.get('acme')!.hub.state.binders.length, 1)
    await close()
  })

  it('stays open to anyone in a Binder with no members, and is a personal Binder’s person’s own', async () => {
    const open = await setUp([])
    const bo = await open.as('bo', 'acme')
    assert.equal((await putBinder(bo, { id: 'p1', name: 'App', repo: 'acme/app', issues: false })).status, 200)
    assert.equal((await changes(bo, { type: 'binder.delete', id: 'p1' })).status, 200)
    // Their own Binder: they own it.
    const own = await open.as('bo', '~bo')
    assert.equal((await putBinder(own, { id: 'p9', name: 'Notes', repo: 'bo/notes' })).status, 200)
    await open.close()
  })
})

describe('taking a Binder off the hub', () => {
  async function hubWithGlobex() {
    const set = await setUp()
    const root = await set.as('root')
    assert.equal((await root('POST', '/api/spaces', { id: 'globex', name: 'Globex', owner: 'bo' })).status, 200)
    const ana = await set.as('ana')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    return { ...set, root, ana, bo: await set.as('bo'), boIn: await set.as('bo', 'globex') }
  }

  it('is done by its owner or a hub admin, who type its name, and leaves it out of every list and request', async () => {
    const { spaces, kv, root, ana, bo, boIn, as, url, make, made, stopped, close } = await hubWithGlobex()
    const agent = (await boIn('POST', '/api/agents', { name: 'Builder' })).body
    assert.equal((await agentConnects(url, agent.token)).status, 200)
    await boIn('PUT', '/api/spaces/globex/members/cy', { role: 'member' })
    await boIn('PUT', '/api/spaces/globex/members/zed', { role: 'member' })
    assert.ok(spaces.people().includes('zed'), 'let in to sign in by it')

    // Only its owners and the hub's admins; its name, exactly; and a Binder they can open.
    const cy = await as('cy')
    assert.equal((await cy('DELETE', '/api/spaces/globex', { name: 'Globex' })).status, 422)
    const wrong = await bo('DELETE', '/api/spaces/globex', { name: 'globex' })
    assert.equal(wrong.status, 422)
    assert.match(wrong.body.error, /type its name exactly/)
    assert.equal((await bo('DELETE', '/api/spaces/globex')).status, 422, 'with no name at all')
    assert.equal((await ana('DELETE', '/api/spaces/globex', { name: 'Globex' })).body.error, 'No such Binder.', 'not one they can open')
    assert.ok(spaces.info('globex') && spaces.get('globex'))
    assert.deepEqual(stopped, [])

    const removed = await bo('DELETE', '/api/spaces/globex', { name: 'Globex' })
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.body.removed, { id: 'globex', name: 'Globex' })
    assert.ok(!removed.body.spaces.some((s: { id: string }) => s.id === 'globex'))
    assert.deepEqual(stopped, ['globex'], 'its running parts stopped')

    // Gone from where it was listed, opened and reached.
    assert.equal(spaces.info('globex'), undefined)
    assert.equal(spaces.get('globex'), undefined)
    assert.ok(!spaces.list().some((s) => s.id === 'globex'))
    assert.ok(!spaces.people().includes('zed'), 'nobody is let in by it any more')
    assert.ok(!(await bo('GET', '/api/spaces')).body.spaces.some((s: { id: string }) => s.id === 'globex'))
    assert.ok(!(await root('GET', '/api/spaces')).body.spaces.some((s: { id: string }) => s.id === 'globex'), 'the hub’s admin neither')
    assert.equal((await boIn('GET', '/api/state')).status, 403)
    assert.equal((await (await as('root', 'globex'))('GET', '/api/state')).status, 403)
    assert.equal((await bo('DELETE', '/api/spaces/globex', { name: 'Globex' })).body.error, 'No such Binder.')
    // An agent's token for it is refused as for a Binder that isn't there.
    const refused = await agentConnects(url, agent.token)
    assert.equal(refused.status, 403)
    assert.match(refused.text, /token was replaced or revoked/)
    // Its address stays taken: nothing new is made over it, by a name or an address.
    assert.equal((await root('POST', '/api/spaces', { id: 'globex', name: 'Another', owner: 'bo' })).status, 422)
    assert.equal(spaces.freeId('Globex'), 'globex-2')
    assert.equal((await bo('POST', '/api/spaces', { name: 'Globex' })).body.created.id, 'globex-2')

    // It's marked, not forgotten: not started again at the next boot, and its address still held.
    const kept = (JSON.parse((await kv.get('spaces'))!) as { id: string; removedAt?: string; removedBy?: string }[]).find((s) => s.id === 'globex')!
    assert.ok(kept.removedAt && !Number.isNaN(Date.parse(kept.removedAt)))
    assert.equal(kept.removedBy, 'bo')
    made.length = 0
    const again = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: [] })
    assert.ok(!made.includes('globex'), 'not started')
    assert.ok(made.includes('acme'))
    assert.equal(again.info('globex'), undefined)
    assert.equal(again.freeId('Globex'), 'globex-3', 'globex and globex-2 are both taken')
    await assert.rejects(again.create({ id: 'globex', name: 'Over it', owner: 'bo' }, 'bo'), /already/)
    await close()
  })

  it('says which Binder is the hub’s first, and only that one', async () => {
    const { as, close } = await setUp()
    const ana = await as('ana')
    const made = await ana('POST', '/api/spaces', { name: 'Design' })
    const view = (body: { spaces: { id: string; first?: boolean }[] }) => body.spaces.map((s) => [s.id, s.first])
    assert.deepEqual(view((await ana('GET', '/api/spaces')).body), [['acme', true], ['~ana', undefined], ['design', undefined]])
    assert.deepEqual(view(made.body), [['acme', true], ['~ana', undefined], ['design', undefined]], 'the other views say it too')
    await close()
  })

  it('lets a hub admin who isn’t in it remove it, and never the hub’s first Binder or a personal one', async () => {
    const { spaces, root, ana, close } = await hubWithGlobex()
    const first = await root('DELETE', '/api/spaces/acme', { name: 'Acme' })
    assert.equal(first.status, 422)
    assert.match(first.body.error, /first Binder/)
    assert.match((await ana('DELETE', '/api/spaces/acme', { name: 'Acme' })).body.error, /first Binder/, 'not by its owner either')
    const personal = await ana('DELETE', '/api/spaces/~ana', { name: 'Personal' })
    assert.equal(personal.status, 422)
    assert.match(personal.body.error, /personal Binder/)
    assert.ok(spaces.info('acme') && spaces.info('~ana'))
    assert.equal((await root('DELETE', '/api/spaces/~ana', { name: 'Personal' })).body.error, 'No such Binder.', 'the hub’s admins don’t reach someone’s own')

    assert.equal((await root('DELETE', '/api/spaces/globex', { name: 'Globex' })).status, 200)
    assert.equal(spaces.list().find((s) => s.id === 'globex'), undefined)
    await close()
  })
})

describe('an agent that’s listening', () => {
  it('is online for list_agents and for the brain’s board, without a recent lastSeen', async () => {
    const { spaces, auth, as, url, close } = await setUp()
    const ana = await as('ana', 'acme')
    const made = (await ana('POST', '/api/agents', { name: 'Builder' })).body
    const hub = spaces.get('acme')!.hub
    await putBinder(ana, { id: 'p1', name: 'App' })
    const { token } = await auth.issuePersonToken({ login: 'ana', name: 'Ana' } as never, 'A test client', undefined, 'acme', 'mcp')
    const online = async () => ((await personCalls(url, token, 'list_agents')) as { name: string; online: boolean }[]).find((a) => a.name === 'Builder')!.online
    const board = () => boardFor([{ id: 'acme', name: 'Acme', hub, actions: spaces.get('acme')!.actions }], 'ana').passage.text

    assert.equal(await online(), false, 'never heard from')
    assert.match(board(), /Builder \(yours, offline\)/)
    // Its runner waits for work: listening, though the hub hasn't written a lastSeen for it (it writes one at most every thirty minutes).
    assert.equal(hub.state.agents.find((a) => a.id === made.agent.id)!.lastSeen, undefined)
    hub.touch(made.agent.id, 1)
    assert.equal(await online(), true)
    assert.match(board(), /Builder \(yours, online\)/)
    hub.touch(made.agent.id, -1)
    assert.equal(await online(), true, 'and for two minutes after its last call')
    await close()
  })

  it('is told from what the hub keeps live, and from lastSeen only as a fallback', () => {
    const agent = (lastSeen?: string) => ({ id: 'a1', lastSeen }) as Agent
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
    assert.equal(agentOnline({ a1: { at: minutesAgo(40), listening: true } }, agent(minutesAgo(40))), true)
    assert.equal(agentOnline({ a1: { at: minutesAgo(1), listening: false } }, agent()), true)
    assert.equal(agentOnline({ a1: { at: minutesAgo(5), listening: false } }, agent(minutesAgo(5))), false)
    assert.equal(agentOnline({}, agent(minutesAgo(1))), true, 'as when the hub has just started')
    assert.equal(agentOnline({}, agent()), false)
  })
})

describe('the installer', () => {
  it('asks for Node 22, as the terminal and the brain’s link use Node’s own WebSocket', () => {
    for (const script of [installer('http://hub.test'), windowsInstaller('http://hub.test')]) {
      assert.match(script, /Node 22 or newer/)
      assert.doesNotMatch(script, /Node 20/)
      assert.match(script, /(-ge|-lt) 22/)
    }
  })
})

describe('a slow GitHub', () => {
  /** A GitHub that takes the request and never answers (or, with `refuses`, turns every one down at once), and what it was asked. */
  async function hanging(refuses = false) {
    const asked: string[] = []
    const server: Server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        asked.push(body ? (JSON.parse(body) as { refresh_token?: string }).refresh_token ?? request.url! : request.url!)
        if (refuses) response.end(JSON.stringify({ error: 'bad_refresh_token' }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { url, asked, close: () => { server.closeAllConnections(); server.close() } }
  }
  const authFor = (url: string) => {
    const kv = new MemoryKV()
    const auth = new Auth(kv, new Sealer('test-secret'), { github: () => ({ webUrl: url, apiUrl: url, clientId: 'id', clientSecret: 'secret' }), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const grant = (login: string, expiresInMs: number) => (auth as unknown as { keepGitHub(login: string, space: string, grant: object): Promise<void> }).keepGitHub(login, 'acme', { token: `gho_${login}`, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), refresh: `ghr_${login}`, refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    return { auth, grant }
  }
  const timed = async <T>(work: Promise<T>) => {
    const from = Date.now()
    return { value: await work, ms: Date.now() - from }
  }

  it('lets a request use a token that hasn’t run out while it renews, and waits for GitHub at most ten seconds when it has', async () => {
    const github = await hanging()
    const { auth, grant } = authFor(github.url)
    await grant('near', 60_000)
    await grant('gone', -1000)

    // A minute left: used as it is, and renewed beside the request, once for as many as ask.
    const near = await Promise.all([timed(auth.githubFor('near', 'acme')), timed(auth.githubFor('near', 'acme'))])
    assert.deepEqual(near.map((n) => n.value), ['gho_near', 'gho_near'])
    assert.ok(near.every((n) => n.ms < 1000), 'not held up for GitHub')
    await new Promise((done) => setTimeout(done, 100))
    assert.deepEqual(github.asked, ['ghr_near'])

    // Run out: nothing else to go on, so it waits, but not for good. The same limits hold for every other call to GitHub (20 s).
    const gone = timed(auth.githubFor('gone', 'acme'))
    const call = timed(new GitHub('gho_x', github.url).get('/user').catch((error: Error) => error.name))
    const poll = timed(new GitHub('gho_x', github.url).poll('/user').catch((error: Error) => error.name))
    const slow = await gone
    assert.equal(slow.value, undefined)
    assert.ok(slow.ms >= 9000 && slow.ms < 15_000, `waited ${slow.ms} ms`)
    // Not tried again for a minute: the next request has its answer at once.
    const next = await timed(auth.githubFor('gone', 'acme'))
    assert.equal(next.value, undefined)
    assert.ok(next.ms < 1000)
    assert.equal(github.asked.filter((a) => a === 'ghr_gone').length, 1)
    const [called, polled] = [await call, await poll]
    assert.equal(called.value, 'TimeoutError')
    assert.equal(polled.value, 'TimeoutError')
    assert.ok(called.ms >= 19_000 && called.ms < 25_000, `waited ${called.ms} ms`)
    github.close()
  })

  it('asks again to renew a minute after a renewal failed, not before', async () => {
    const github = await hanging(true)
    const { auth, grant } = authFor(github.url)
    await grant('gone', -1000)
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    try {
      const sent = () => github.asked.filter((a) => a === 'ghr_gone').length
      assert.equal(await auth.githubFor('gone', 'acme'), undefined)
      assert.equal(sent(), 1)
      assert.equal(await auth.githubFor('gone', 'acme'), undefined)
      assert.equal(sent(), 1, 'not at once')
      mock.timers.tick(30_000)
      assert.equal(await auth.githubFor('gone', 'acme'), undefined)
      assert.equal(sent(), 1, 'nor in half a minute')
      mock.timers.tick(31_000)
      assert.equal(await auth.githubFor('gone', 'acme'), undefined)
      assert.equal(sent(), 2, 'after a minute')
    } finally {
      mock.timers.reset()
      github.close()
    }
  })
})
