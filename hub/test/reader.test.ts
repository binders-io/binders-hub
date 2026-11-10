import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import WebSocket from 'ws'
import { Actions } from '../src/actions.ts'
import { AppLinkSession, captureHome } from '../src/appLink.ts'
import { Auth } from '../src/auth.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { ask, SpaceBrain, talk, type AskPlace } from '../src/brain/brain.ts'
import { chooseHome } from '../src/brain/captures.ts'
import { boardFor, propose, type WorkPlace } from '../src/brain/board.ts'
import type { BrainModel } from '../src/brain/models.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { personServer, type PersonPlace } from '../src/mcpPerson.ts'
import { readerMaySend } from '../src/reader.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { readerWords, Spaces, type Member, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import { forAttention, waitingOn } from '../../shared/waiting.ts'
import { seed } from './helpers.ts'

// A reader: sees everything in a Binder and changes nothing in it. The hub says so in one place, its hook, and what
// they may still send is a short list in reader.ts that a route added later isn't on until someone puts it there.

async function setUp(members: Member[] = [{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'reader' }, { login: 'bo', role: 'member' }]) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const actions = new Actions(hub, github)
    return { id, hub, actions, github, webhooks: new Webhooks(hub, actions) }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members })
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const cookieOf = async (login: string) => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    return /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
  }
  const as = async (login: string, space: string | undefined = 'acme') => {
    const cookie = await cookieOf(login)
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
      const text = await response.text()
      let parsed: any
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        // A note’s document comes as bytes.
      }
      return { status: response.status, body: parsed }
    }
  }
  return { kv, spaces, auth, app, url, as, cookieOf, close: () => app.close() }
}

const refusal = { status: 403, body: { error: readerWords } }
const refused = (answer: { status: number; body?: { error?: string } }) => answer.status === 403 && answer.body?.error === readerWords

describe('making someone a reader', () => {
  it('is set where roles are, by those who may change roles, and keeps a Binder’s owner', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'ed', role: 'admin' }, { login: 'bo', role: 'member' }])
    const ana = await as('ana')
    const added = await ana('PUT', '/api/spaces/acme/members/cy', { role: 'reader' })
    assert.equal(added.status, 200)
    assert.equal(spaces.roleOf('acme', 'cy'), 'reader')
    assert.equal(spaces.roleOf('acme', 'CY'), 'reader')
    // An admin may, as with a member; a member may not.
    assert.equal((await (await as('ed'))('PUT', '/api/spaces/acme/members/bo', { role: 'reader' })).status, 200)
    assert.equal(spaces.roleOf('acme', 'bo'), 'reader')
    const refusedByMember = await (await as('cy'))('PUT', '/api/spaces/acme/members/cy', { role: 'owner' })
    assert.deepEqual(refusedByMember, refusal)
    // Back to a member, and then a reader again; only an owner makes or unmakes owners, as ever.
    assert.equal((await ana('PUT', '/api/spaces/acme/members/bo', { role: 'member' })).status, 200)
    assert.equal(spaces.roleOf('acme', 'bo'), 'member')
    assert.match((await (await as('ed'))('PUT', '/api/spaces/acme/members/ana', { role: 'reader' })).body.error, /Only an owner makes or unmakes owners/)
    // The last owner can’t become a reader.
    assert.match((await ana('PUT', '/api/spaces/acme/members/ana', { role: 'reader' })).body.error, /at least one owner/)
    assert.equal((await ana('PUT', '/api/spaces/acme/members/cy', { role: 'boss' })).status, 422)
    await close()
  })

  it('isn’t one of the Binder’s managers, so a reader sees who the owners and admins are', async () => {
    const { as, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'ed', role: 'admin' }, { login: 'cy', role: 'reader' }, { login: 'bo', role: 'member' }])
    const cy = await as('cy')
    const here = (await cy('GET', '/api/spaces')).body.spaces.find((s: { id: string }) => s.id === 'acme')
    assert.equal(here.role, 'reader')
    assert.deepEqual(here.managers, [{ login: 'ana', role: 'owner' }, { login: 'ed', role: 'admin' }])
    assert.equal(here.members, undefined, 'the list of members is for those who may change it')
    assert.equal((await cy('GET', '/api/me')).body.role, 'reader')
    await close()
  })

  it('a Binder with no members is open to everyone as members, and a personal Binder’s person is its owner', async () => {
    const { as, spaces, close } = await setUp([])
    const eve = await as('eve', 'acme')
    assert.equal((await eve('GET', '/api/state')).status, 200)
    assert.equal((await eve('POST', '/api/cards', { binderId: 'b1', title: 'Open to all' })).status, 200)
    const home = await as('eve', '~eve')
    assert.equal(spaces.roleOf('~eve', 'eve'), 'owner')
    assert.equal((await home('POST', '/api/cards', { binderId: 'b1', title: 'Mine' })).status === 403, false)
    assert.match((await (await as('eve', 'acme'))('PUT', '/api/spaces/~eve/members/cy', { role: 'reader' })).body.error, /personal Binder is its person’s alone/)
    await close()
  })

  it('is told in the history as a role change reads, and as an addition does', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'bo', role: 'member' }])
    const ana = await as('ana')
    const last = () => spaces.get('acme')!.hub.state.history?.at(-1)
    await ana('PUT', '/api/spaces/acme/members/bo', { role: 'reader' })
    assert.equal(last()?.text, 'Made @bo a reader.')
    assert.equal(last()?.by, 'ana')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'reader' })
    assert.equal(last()?.text, 'Added @cy to this Binder as a reader.')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    assert.equal(last()?.text, 'Made @cy a member.')
    await close()
  })

  it('takes their agents away, as taking them out does, and says which', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }, { login: 'bo', role: 'member' }])
    const cy = await as('cy')
    const first = (await cy('POST', '/api/agents', { name: 'Builder' })).body
    const second = (await cy('POST', '/api/agents', { name: 'Reviewer' })).body
    const others = (await (await as('bo'))('POST', '/api/agents', { name: 'Tester' })).body
    const ana = await as('ana')
    const made = await ana('PUT', '/api/spaces/acme/members/cy', { role: 'reader' })
    assert.equal(made.status, 200)
    assert.deepEqual(made.body.revoked.map((r: { name: string }) => r.name).sort(), ['Builder', 'Reviewer'])
    assert.deepEqual(made.body.revoked.find((r: { name: string }) => r.name === 'Builder'), { id: first.agent.id, name: 'Builder' })
    assert.ok(made.body.spaces[0].managers, 'beside the list it gave before')
    const state = spaces.get('acme')!.hub.state
    assert.deepEqual(state.agents.filter((a) => a.revoked).map((a) => a.id).sort(), [first.agent.id, second.agent.id].sort())
    assert.ok(!state.agents.find((a) => a.id === others.agent.id)!.revoked, 'someone else’s agent goes on')
    assert.match(state.history!.map((h) => h.text).join('\n'), /Revoked the agent “Builder”, as @cy can only read this Binder now\./)
    // Someone who owns none has nothing revoked; and once a reader, saying so again revokes nothing more.
    assert.deepEqual((await ana('PUT', '/api/spaces/acme/members/bo', { role: 'reader' })).body.revoked.map((r: { name: string }) => r.name), ['Tester'])
    assert.deepEqual((await ana('PUT', '/api/spaces/acme/members/dee', { role: 'reader' })).body.revoked, [])
    assert.deepEqual((await ana('PUT', '/api/spaces/acme/members/dee', { role: 'reader' })).body.revoked, [])
    // The other roles answer as they always have.
    assert.equal((await ana('PUT', '/api/spaces/acme/members/dee', { role: 'member' })).body.revoked, undefined)
    await close()
  })
})

describe('what a reader may do', () => {
  it('reads all of it: the state, the history, the trash, the notes, who’s in the Binder, what’s waiting', async () => {
    const { spaces, as, close } = await setUp()
    const cy = await as('cy')
    const state = await cy('GET', '/api/state')
    assert.equal(state.status, 200)
    assert.ok(state.body.state.notes.length)
    assert.equal((await cy('GET', '/api/state?light=1')).status, 200)
    assert.equal((await cy('GET', '/api/history')).status, 200)
    assert.equal((await cy('GET', '/api/trash')).status, 200)
    assert.equal((await cy('GET', '/api/notes/n1/doc')).status, 200)
    // A note's text, who links to it and a search of the notes: asked for when a note is opened, and reads like the rest.
    assert.deepEqual((await cy('GET', '/api/notes/n1/text')).body.text, '# First note\n')
    assert.equal((await cy('GET', '/api/notes/n1/backlinks')).status, 200)
    assert.deepEqual((await cy('GET', '/api/notes/search?q=first')).body, { ids: ['n1'] })
    assert.equal((await cy('GET', '/api/notes/n1/access')).status, 200)
    assert.equal((await cy('GET', '/api/spaces')).status, 200)
    assert.equal((await cy('GET', '/api/jira')).status, 200)
    assert.equal((await cy('GET', '/api/tell')).status, 200)
    // Something waits on their agent’s owner; nothing waits on a reader, so the Binder switcher’s number is 0.
    const hub = spaces.get('acme')!.hub
    await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: { id: 'a1', name: 'Sonnet', owner: 'cy', binders: [], repos: [], skills: [] } as never })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'k1', title: 'Which one?', binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'blocked', agentId: 'a1', needsYou: 'Which region?', waitsFor: [], activity: [], updatedAt: '2026-11-09T09:00:00.000Z' } as never })
    assert.ok(forAttention(waitingOn(hub.state, 'cy')).length > 0, 'it would wait on them')
    // A card as the hub has it, asked for when a finished card is opened: a read like the rest.
    assert.equal((await cy('GET', '/api/cards/k1/whole')).body.card.title, 'Which one?')
    assert.equal((await cy('GET', '/api/cards/nope/whole')).status, 404)
    const waiting = await cy('GET', '/api/me/waiting')
    assert.deepEqual(waiting.body.binders.find((b: { id: string }) => b.id === 'acme'), { id: 'acme', name: 'Acme', count: 0 })
    await close()
  })

  it('changes nothing: a change, a card, an agent, a setting, a lock, all refused in words, and nothing is written', async () => {
    const { spaces, as, close } = await setUp()
    const cy = await as('cy')
    const hub = spaces.get('acme')!.hub
    const before = hub.version
    const edit = { client: 'tab-1234', changes: [{ id: 'c1', change: { type: 'note.edit', id: 'n1', text: '# First note\nmore\n', title: 'First note', by: 'cy', at: '2026-11-09T00:00:00.000Z' } }] }
    assert.deepEqual(await cy('POST', '/api/changes', edit), refusal)
    assert.deepEqual(await cy('POST', '/api/cards', { binderId: 'b1', title: 'A card' }), refusal)
    assert.deepEqual(await cy('POST', '/api/agents', { name: 'Builder' }), refusal)
    assert.deepEqual(await cy('POST', '/api/agents/join-line', {}), refusal)
    assert.deepEqual(await cy('POST', '/api/notes/n1/lock', { locked: true }), refusal)
    assert.deepEqual(await cy('POST', '/api/sets/s1/approve', {}), refusal)
    assert.deepEqual(await cy('POST', '/api/environments/x/promote', {}), refusal)
    assert.deepEqual(await cy('POST', '/api/notes/n1/send', { binder: '~cy' }), refusal)
    assert.deepEqual(await cy('PATCH', '/api/spaces/acme', { name: 'Mine now' }), refusal)
    assert.deepEqual(await cy('DELETE', '/api/spaces/acme/members/ana'), refusal)
    assert.deepEqual(await cy('PATCH', '/api/options', {}), refusal)
    assert.equal(hub.version, before, 'nothing reached the log')
    assert.equal(spaces.info('acme')!.name, 'Acme')
    // The same requests from a member and an owner are not met by this rule at all.
    assert.equal((await (await as('bo'))('POST', '/api/changes', edit)).status, 200)
    assert.equal((await (await as('ana'))('POST', '/api/cards', { binderId: 'b1', title: 'A card' })).status, 200)
    await close()
  })

  it('may still ask the brain, keep their own tokens and their own Binder, leave, and make a Binder of their own', async () => {
    const { spaces, as, close } = await setUp()
    const cy = await as('cy')
    // The hub has no brain here: the refusal is the brain’s, not the reader’s.
    for (const [method, path] of [['POST', '/api/brain/ask'], ['POST', '/api/notes/n1/ask'], ['POST', '/api/brain/search']] as const) {
      const answer = await cy(method, path, { question: 'What is going on?', query: 'going' })
      assert.equal(refused(answer), false, `${method} ${path}`)
    }
    assert.equal((await cy('DELETE', '/api/brain/conversation')).status === 403, false)
    const token = await cy('POST', '/api/tokens', { app: 'A tool' })
    assert.equal(token.status, 200)
    assert.equal((await cy('GET', '/api/tokens')).body.tokens.length, 1)
    assert.equal((await cy('DELETE', `/api/tokens/${token.body.id}`)).status, 200)
    assert.equal((await cy('DELETE', '/api/me/personal-github')).status, 200)
    assert.equal((await cy('GET', '/api/personal/captures')).status, 200)
    const made = await cy('POST', '/api/spaces', { name: 'Cy’s own' })
    assert.equal(made.status, 200)
    assert.equal(spaces.roleOf(made.body.created.id, 'cy'), 'owner')
    // Leaving is theirs: taking themselves out. Taking another out isn’t.
    assert.deepEqual(await cy('DELETE', '/api/spaces/acme/members/ana'), refusal)
    const left = await cy('DELETE', '/api/spaces/acme/members/cy')
    assert.equal(left.status, 200)
    assert.deepEqual(left.body.revoked, [])
    assert.equal(spaces.roleOf('acme', 'cy'), undefined)
    await close()
  })

  it('sends a capture only where it can be written: a reader’s is refused, in the same words, by the route that knows where it goes', async () => {
    const { as, close } = await setUp()
    const cy = await as('cy')
    const refusedHere = await cy('POST', '/api/captures', { kind: 'dictation', text: 'Remember the milk' })
    assert.equal(refusedHere.status, 422)
    assert.equal(refusedHere.body.error, readerWords)
    await close()
  })

  it('is never shown an agent’s terminal, though they own the agent', async () => {
    const { spaces, as, cookieOf, url, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }])
    const made = (await (await as('cy'))('POST', '/api/agents', { name: 'Builder' })).body
    const ana = await as('ana')
    const anasAgent = (await ana('POST', '/api/agents', { name: 'Reviewer' })).body
    // Set straight in the list, as an agent made before they were a reader would be: no revoking to rely on.
    await spaces.setMember('acme', 'cy', 'reader', true)
    const cy = await as('cy')
    const asked = await cy('GET', `/api/agents/${made.agent.id}/terminals`)
    assert.equal(asked.status, 422)
    assert.equal(asked.body.error, readerWords)
    assert.equal((await ana('GET', `/api/agents/${anasAgent.agent.id}/terminals`)).status, 200)
    // The live feed lists terminals to an owner and not to a reader.
    const heard = async (login: string) => {
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live?space=acme`, { headers: { cookie: await cookieOf(login) } })
      const seen: string[] = []
      socket.on('message', (data) => seen.push(JSON.parse(String(data)).type))
      await new Promise((done) => socket.once('open', done))
      await new Promise((done) => setTimeout(done, 250))
      socket.close()
      return seen
    }
    assert.ok((await heard('ana')).includes('terminals'), 'an owner is told of terminals')
    const readerSaw = await heard('cy')
    assert.ok(readerSaw.includes('entries') && readerSaw.includes('presence'), 'a reader still follows the Binder live')
    assert.ok(!readerSaw.includes('terminals'))
    await close()
  })
})

// Every route -----------------------------------------------------------------------------------------------------------

/** The registered routes as [method, path], read from Fastify's printed tree: each line's path is its parents' parts and its own. */
function routesOf(tree: string) {
  const out: [string, string][] = []
  const stack: string[] = []
  for (const line of tree.split('\n')) {
    const found = /^((?:│   |    )*)(?:├── |└── )(\S+) \(([^)]+)\)$/.exec(line)
    if (!found) continue
    const depth = found[1].length / 4
    stack.length = depth
    stack[depth] = found[2]
    const path = stack.join('')
    for (const method of found[3].split(', ')) out.push([method, path])
  }
  return out
}

/** What a reader may send though it isn't a read, as the walk below holds the hub to: written out again here on purpose. */
const theirOwnOrOnlyAsks = [
  'POST /api/brain/ask', 'POST /api/notes/:id/ask', 'POST /api/brain/search', 'POST /api/brain/speak', 'DELETE /api/brain/conversation',
  'POST /api/tokens', 'DELETE /api/tokens/:id', 'DELETE /api/me/personal-github',
  'PUT /api/personal/oauth', 'DELETE /api/personal/oauth', 'PUT /api/personal/captures', 'POST /api/personal/repo',
  'POST /api/spaces',
  // Naming a Binder's owner is the hub's, and the route asks for a hub admin.
  'PUT /api/hub/binders/:id/owners/:login',
  // So is starting a Binder from a copy.
  'POST /api/hub/binders/from-copy',
]
/** Addresses that find out which Binder they’re for, and refuse a reader there: the hook leaves them to. */
const decidedInTheRoute = ['POST /api/captures', 'POST /api/app/audio', 'POST /api/brain/do']
/** Not a person’s request in a Binder: sign-in, a token’s own proof, a webhook’s signature, MCP (which checks the role itself). */
const notAPersonsRequest = [
  'POST /auth/dev', 'POST /auth/logout', 'POST /oauth/register', 'POST /oauth/revoke', 'POST /oauth/authorize', 'POST /oauth/token',
  'POST /webhooks/jira/:space', 'POST /webhooks/github', 'POST /webhooks/github/:space', 'POST /mcp', 'POST /:space/mcp', 'DELETE /mcp', 'DELETE /:space/mcp',
  // The hook lets these through unsigned: a machine’s own token or a line made earlier is the proof.
  'POST /api/machines/join', 'POST /api/brain/machines/join',
]
/** Leaving is the one address with a person in it: taking yourself out is allowed, taking another isn’t. */
const leaving = 'DELETE /api/spaces/:id/members/:login'

describe('every address that changes something', () => {
  it('is refused for a reader unless it’s theirs or only asks, so a route added later is refused by default', async () => {
    const { app, as, close } = await setUp()
    const cy = await as('cy')
    const found = routesOf(app.printRoutes({ commonPrefix: false })).filter(([method]) => method !== 'GET' && method !== 'HEAD')
    assert.ok(found.length > 100, `found the routes (${found.length})`)
    const has = new Set(found.map(([method, path]) => `${method} ${path}`))
    // Nothing on a list that isn’t a route any more, and nothing outside /api that nobody has looked at.
    for (const listed of [...theirOwnOrOnlyAsks, ...decidedInTheRoute, ...notAPersonsRequest, leaving]) assert.ok(has.has(listed), `${listed} is on a list but isn’t a route`)
    const unsorted = [...has].filter((r) => !r.split(' ')[1].startsWith('/api/') && !notAPersonsRequest.includes(r))
    assert.deepEqual(unsorted, [], 'a route outside /api that isn’t sorted: does it need the role?')

    const refusedRoutes: string[] = []
    const passed: string[] = []
    for (const [method, path] of found) {
      const key = `${method} ${path}`
      if (!path.startsWith('/api/') || notAPersonsRequest.includes(key) || key === leaving) continue
      // A real Binder in a Binder’s path, and anything for the rest.
      const concrete = path.replace(/^\/api\/spaces\/:id/, '/api/spaces/acme').replace(/:login/, 'ana').replace(/:[a-z]+/g, 'x').replace(/\*/g, 'x')
      const answer = await cy(method, concrete, {})
      if (refused(answer)) refusedRoutes.push(key)
      else passed.push(key)
    }
    assert.deepEqual([...passed].sort(), [...theirOwnOrOnlyAsks, ...decidedInTheRoute].sort(), 'only what’s theirs or only asks gets past the hook')
    assert.ok(refusedRoutes.length > 80, `most of them are refused (${refusedRoutes.length})`)
    // Taking someone else out of the Binder is refused, and taking yourself out isn’t.
    assert.deepEqual(await cy('DELETE', '/api/spaces/acme/members/ana'), refusal)
    assert.equal(readerMaySend('DELETE', '/api/spaces/acme/members/cy', 'cy'), true)
    assert.equal(readerMaySend('DELETE', '/api/spaces/acme/members/%40CY', 'cy'), true)
    assert.equal(readerMaySend('DELETE', '/api/spaces/acme/members/ana', 'cy'), false)
    assert.equal(readerMaySend('PUT', '/api/spaces/acme/members/cy', 'cy'), false)
    assert.equal(readerMaySend('GET', '/api/anything/at/all', 'cy'), true)
    assert.equal(readerMaySend('HEAD', '/api/anything/at/all', 'cy'), true)
    assert.equal(readerMaySend('POST', '/api/anything/new', 'cy'), false)
    assert.equal(readerMaySend('OPTIONS', '/api/brain/ask', 'cy'), false)
    await close()
  })

  it('is not met by that rule for anyone who isn’t a reader', async () => {
    const { app, as, close } = await setUp()
    const bo = await as('bo')
    const found = routesOf(app.printRoutes({ commonPrefix: false })).filter(([method, path]) => method !== 'GET' && method !== 'HEAD' && path.startsWith('/api/') && !notAPersonsRequest.includes(`${method} ${path}`))
    for (const [method, path] of found) {
      if (path.startsWith('/api/spaces/:id')) continue
      const answer = await bo(method, path.replace(/:[a-z]+/g, 'x').replace(/\*/g, 'x'), {})
      assert.equal(refused(answer), false, `${method} ${path}`)
    }
    await close()
  })
})

// An agent whose owner is a reader ---------------------------------------------------------------------------------------

describe('an agent whose owner is a reader', () => {
  it('is refused on MCP, as one whose owner has left is, and works again when its owner can change the Binder', async () => {
    const { spaces, as, url, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }])
    const made = (await (await as('cy'))('POST', '/api/agents', { name: 'Builder' })).body
    const connect = async () => {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-agent', version: '1.0.0' } } }),
      })
      return { status: response.status, text: await response.text() }
    }
    assert.equal((await connect()).status, 200)
    // As an agent set up before the owner was a reader would be: still listed, its token still good.
    await spaces.setMember('acme', 'cy', 'reader', true)
    const refusedNow = await connect()
    assert.equal(refusedNow.status, 403)
    assert.match(refusedNow.text, /@cy can only read this binder, so Builder can’t work in it/)
    await spaces.setMember('acme', 'cy', 'member', true)
    assert.equal((await connect()).status, 200)
    await close()
  })
})

// A person's MCP -----------------------------------------------------------------------------------------------------------

describe('a reader’s own MCP', () => {
  async function connect(role: PersonPlace['role']) {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const kv = new MemoryKV()
    const github = new GitHubConnection(kv, new Sealer('s'), { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
    const settings = {} as BrainSettingsStore
    const place: PersonPlace = { id: 'acme', name: 'Acme', role, hub, actions: new Actions(hub, github) }
    const server = personServer([place], { login: 'cy', name: 'Cy' }, { settings, url: (space, kind, id) => `http://hub.test/${space}/${kind}/${id}` })
    const [near, far] = InMemoryTransport.createLinkedPair()
    await server.connect(far)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(near)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      return { text: result.content[0].text, error: !!result.isError }
    }
    return { hub, call, close: () => client.close() }
  }

  it('reads: the binders, notes, cards and what’s said of them', async () => {
    const { call, close } = await connect('reader')
    assert.equal((await call('list_notes', { binder: 'b1' })).error, false)
    assert.match((await call('get_note', { id: 'n1' })).text, /First note/)
    assert.equal((await call('list_tasks')).error, false)
    assert.equal((await call('list_agents')).error, false)
    assert.equal((await call('get_binder_context', {})).error, false)
    await close()
  })

  it('says they’re a reader, in whoami and list_binders', async () => {
    const { call, close } = await connect('reader')
    const me = JSON.parse((await call('whoami')).text)
    assert.equal(me.binders[0].role, 'reader')
    assert.equal(me.binders[0].note, readerWords)
    const listed = JSON.parse((await call('list_binders')).text)
    assert.equal(listed[0].role, 'reader')
    assert.equal(listed[0].note, readerWords)
    const member = await connect('member')
    assert.equal(JSON.parse((await member.call('list_binders')).text)[0].note, undefined, 'only a reader is told')
    await member.close()
    await close()
  })

  it('refuses every tool that writes, in the same words, and writes nothing', async () => {
    const { hub, call, close } = await connect('reader')
    const before = hub.version
    const writes: [string, Record<string, unknown>][] = [
      ['create_note', { binder: 'b1', text: '# New\n' }],
      ['append_to_note', { id: 'n1', text: 'more' }],
      ['edit_note', { id: 'n1', text: '# Other\n' }],
      ['create_folder', { binder: 'b1', name: 'Ideas' }],
      ['move_note', { id: 'n1' }],
      ['create_task', { binder: 'b1', title: 'A card' }],
      ['comment_task', { id: 'k1', text: 'Hello' }],
      ['assign_task', { id: 'k1', agent: 'any' }],
      ['stop_task', { id: 'k1' }],
      ['propose_work_items', { note: 'n1', items: [{ title: 'Do it', quote: 'First note' }] }],
      ['propose_note_change', { id: 'n1', why: 'Stale', text: '# New words\n' }],
      ['reply_to_note_proposal', { id: 'p1', text: 'Hm' }],
      ['add_repo_lesson', { repo: 'acme/web', text: 'Run the tests first' }],
      ['capture', { binder: 'b1', kind: 'dictation', text: 'Remember the milk' }],
    ]
    // A card and a proposal to talk about, so the refusal isn’t just a missing id.
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'k1', title: 'A card', binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'ready', waitsFor: [], activity: [], updatedAt: '2026-11-09T00:00:00.000Z' } as never })
    const start = hub.version
    for (const [name, args] of writes) {
      const answer = await call(name, args)
      assert.equal(answer.error, true, name)
      assert.ok(answer.text === readerWords || /No (proposal|binder|card|note)|isn’t a repo/.test(answer.text), `${name}: ${answer.text}`)
      if (['create_note', 'append_to_note', 'edit_note', 'create_folder', 'move_note', 'create_task', 'comment_task', 'assign_task', 'stop_task', 'propose_work_items', 'propose_note_change', 'capture'].includes(name)) assert.equal(answer.text, readerWords, name)
    }
    assert.equal(hub.version, start, 'nothing was written')
    assert.ok(before <= start)
    await close()
  })

  it('writes for a member through the same tools', async () => {
    const { call, hub, close } = await connect('member')
    assert.equal((await call('create_note', { binder: 'b1', text: '# New\n' })).error, false)
    assert.equal((await call('create_task', { binder: 'b1', title: 'A card' })).error, false)
    assert.ok(hub.state.notes.some((n) => n.title === 'New'))
    await close()
  })
})

// Asking ---------------------------------------------------------------------------------------------------------------------

describe('asking, as a reader', () => {
  const model = (replies: string[], saw: string[] = []): BrainModel => ({
    label: 'scripted',
    summarize: async () => ({ title: '', summary: '', points: [], decisions: [], followUps: [] }),
    answer: async (_q, passages, more) => {
      saw.push(more ?? '')
      const text = replies.shift() ?? 'Nothing to say.'
      return { text, parts: [{ text, sources: passages.map((_p, i) => i) }] }
    },
    talk: async (_turns, _passages, more) => {
      saw.push(more ?? '')
      return replies.shift() ?? 'Nothing to say.'
    },
    sortMoment: async () => ({ kind: 'none', title: '' }),
  })

  async function setUpBoard() {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const kv = new MemoryKV()
    const sealer = new Sealer('s')
    const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
    const actions = new Actions(hub, github)
    const settings = await new BrainSettingsStore(kv, sealer, {}).load()
    const replies: string[] = []
    const saw: string[] = []
    settings.useForTests(model(replies, saw))
    const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
    brain.start()
    await brain.caughtUp()
    const place = (readOnly: boolean): WorkPlace => ({ id: 'test', name: 'Server', hub, actions, ...(readOnly ? { readOnly } : {}) })
    const places = (readOnly: boolean): AskPlace[] => [{ id: 'test', name: 'Server', brain, url: () => 'http://hub.test', work: place(readOnly) }]
    return { hub, settings, replies, saw, place, places, stop: () => brain.stop() }
  }

  it('offers a reader nothing to be done, and refuses a line a model wrote anyway, in the same words', async () => {
    const set = await setUpBoard()
    try {
      set.replies.push('DO card b1 Fix the footer')
      const asked = await ask(set.settings, set.places(true), 'Put a card on the board to fix the footer', { person: 'cy', may: true })
      assert.equal(asked.proposal, undefined)
      assert.equal(asked.answer?.text, readerWords)
      assert.ok(!set.saw[0].includes('DO card'), 'the model wasn’t told how to ask for changes')
      assert.match(set.saw[0], /only tell them how things stand/)
      // The same for someone who can change the Binder: offered, and a proposal waits for their answer.
      set.replies.push('DO card b1 Fix the footer')
      const member = await ask(set.settings, set.places(false), 'Put a card on the board to fix the footer', { person: 'bo', may: true })
      assert.ok(member.proposal, 'a member is asked')
      assert.match(set.saw[1], /DO card/)
    } finally {
      set.stop()
    }
  })

  it('refuses in propose, where each thing is looked at, and in Talk', async () => {
    const set = await setUpBoard()
    try {
      const board = boardFor([set.place(true)], 'cy')
      assert.throws(() => propose({ verb: 'card', mark: 'b1', rest: 'Fix the footer' }, board, 'cy'), { message: readerWords })
      assert.doesNotThrow(() => propose({ verb: 'card', mark: 'b1', rest: 'Fix the footer' }, boardFor([set.place(false)], 'bo'), 'bo'))
      set.replies.push('DO card b1 Fix the footer')
      const said = await talk(set.settings, set.places(true), [{ role: 'user', text: 'Put a card on the board to fix the footer' }], { person: 'cy' })
      assert.equal(said.reply, readerWords)
    } finally {
      set.stop()
    }
  })
})

// The iPhone's link ------------------------------------------------------------------------------------------------------------

describe('the iPhone’s link, for a reader', () => {
  async function linked(login: string) {
    const set = await setUp()
    const sent: Record<string, any>[] = []
    const session = new AppLinkSession({ spaces: set.spaces, login, webUrl: (space, kind, id) => `http://hub.test/${space}/${kind}/${id}`, hubName: 'hub.test', version: 'test', send: (message) => void sent.push(message) })
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      sent.length = 0
      await session.handle({ id: 1, method: 'tools/call', params: { name, arguments: args } })
      const reply = sent.find((m) => m.id === 1)!
      return { error: reply.error?.message as string | undefined, tool: reply.result as { content: { text: string }[]; isError: boolean } | undefined }
    }
    return { ...set, call, hub: set.spaces.get('acme')!.hub, close: async () => { session.close(); await set.close() } }
  }
  const refusedTool = (answer: Awaited<ReturnType<Awaited<ReturnType<typeof linked>>['call']>>) => answer.tool?.isError === true && answer.tool.content[0].text === readerWords

  it('reads the boards and notes, and every tool that writes is refused in words it can show', async () => {
    const { call, hub, close } = await linked('cy')
    assert.equal((await call('list_tasks')).tool?.isError, false)
    assert.equal((await call('list_notes')).tool?.isError, false)
    assert.equal((await call('get_note', { id: 'acme/n1' })).tool?.isError, false)
    const start = hub.version
    assert.ok(refusedTool(await call('create_task', { binder: 'acme/b1', title: 'A card' })), 'create_task')
    assert.ok(refusedTool(await call('add_todo', { binder: 'acme/b1', text: 'Buy milk' })), 'add_todo')
    assert.ok(refusedTool(await call('add_note', { binder: 'acme/b1', text: '# A note\n\nWords' })), 'add_note')
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'k1', title: 'A card', binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'ready', waitsFor: [], activity: [], updatedAt: '2026-11-09T00:00:00.000Z' } as never })
    const seen = hub.version
    assert.ok(refusedTool(await call('update_task', { id: 'acme/k1', column: 'in_progress' })), 'update_task')
    assert.ok(refusedTool(await call('comment_task', { id: 'acme/k1', text: 'Hi' })), 'comment_task')
    assert.equal(hub.version, seen, 'nothing was written')
    assert.ok(seen > start)
    await close()
  })

  it('writes for a member through the same tools', async () => {
    const { call, hub, close } = await linked('bo')
    assert.equal((await call('create_task', { binder: 'acme/b1', title: 'A card' })).tool?.isError, false)
    assert.ok(hub.state.cards.some((c) => c.title === 'A card'))
    await close()
  })

  it('files its captures in their own Binder when the one they chose is one they can only read', async () => {
    const kv = new MemoryKV()
    const own = new MemoryKV()
    const space = (id: string) => ({ id, hub: {}, ...(id === '~cy' ? { brain: { kv: own } } : {}) }) as unknown as Space
    const spaces = Spaces.of(kv, [
      { info: { id: 'acme', name: 'Acme', members: [{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'reader' }, { login: 'bo', role: 'member' }] }, space: space('acme') },
      { info: { id: '~cy', name: 'Personal', members: [{ login: 'cy', role: 'owner' }], personal: 'cy' }, space: space('~cy') },
      { info: { id: '~bo', name: 'Personal', members: [{ login: 'bo', role: 'owner' }], personal: 'bo' }, space: { ...space('~bo'), brain: { kv: own } } as unknown as Space },
    ])
    await chooseHome(own, 'acme')
    assert.equal(await captureHome(spaces, 'cy'), '~cy', 'a reader’s capture is their own again')
    assert.equal(await captureHome(spaces, 'bo'), 'acme', 'a member’s goes where they chose')
  })

  it('doesn’t list a Binder they can only read as somewhere to send captures or notes', async () => {
    const { as, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }, { login: 'bo', role: 'reader' }])
    // bo reads Acme and has a Binder of their own; cy can change Acme and has one too.
    const bo = await as('bo', 'acme')
    const cy = await as('cy', 'acme')
    await bo('GET', '/api/me')
    await cy('GET', '/api/me')
    const boOwn = await as('bo', '~bo')
    const places = (await boOwn('GET', '/api/personal/captures')).body.binders.map((b: { id: string }) => b.id)
    assert.deepEqual(places, ['~bo'], 'Acme isn’t one of bo’s places to send captures')
    assert.deepEqual((await boOwn('PUT', '/api/personal/captures', { binder: 'acme' })).body, { error: readerWords })
    const cyOwn = await as('cy', '~cy')
    assert.deepEqual((await cyOwn('GET', '/api/personal/captures')).body.binders.map((b: { id: string }) => b.id), ['~cy', 'acme'])
    assert.deepEqual((await boOwn('GET', '/api/notes/send-to')).body.binders.map((b: { id: string }) => b.id), [])
    // From Acme, a reader’s Send to is refused by the hook; to Acme, from their own Binder, by the route.
    assert.deepEqual((await bo('POST', '/api/notes/n1/send', { binder: '~bo' })), refusal)
    assert.deepEqual((await boOwn('POST', '/api/notes/n1/send', { binder: 'acme' })), { status: 422, body: { error: readerWords } })
    await close()
  })
})
