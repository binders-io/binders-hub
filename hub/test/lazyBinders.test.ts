import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import WebSocket from 'ws'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV, type KV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { Spaces, worksAlone, type Space, type SpaceInfo } from '../src/spaces.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { BrainMachines } from '../src/brain/machines.ts'
import { SpaceBrain } from '../src/brain/brain.ts'
import type { BrainModel } from '../src/brain/models.ts'
import { emptyState } from '../../shared/state.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card } from '../../shared/work.ts'
import { note, tempDir, until } from './helpers.ts'

// A personal Binder with nothing going on in it isn't started with the hub. It starts when its own person needs it, once,
// and nobody else's doing starts it.

const at = '2026-11-09T10:00:00.000Z'
const picture = 'a1b2c3d4e5f6a1b2c3d4e5f6.png'
const talk = 'so the van needs new tyres before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost'

const info = (id: string, extra: Partial<SpaceInfo> = {}): SpaceInfo => ({ id, name: id, createdAt: at, createdBy: 'hub', members: [], ...extra })
const personal = (login: string, extra: Partial<SpaceInfo> = {}) => info(`~${login}`, { name: 'Personal', members: [{ login, role: 'owner' }], personal: login, home: 'team', ...extra })

/** A way to make Binders that counts how many times each is started and stopped, with the start of any held back by `hold`. */
function counting(hold: Record<string, Promise<void>> = {}) {
  const starts = new Map<string, number>()
  const stops: string[] = []
  const make = async (id: string): Promise<Space> => {
    starts.set(id, (starts.get(id) ?? 0) + 1)
    await hold[id]
    const hub = new Hub(new MemoryLog())
    await hub.start()
    const actions = new Actions(hub, undefined as never)
    return { id, hub, actions, webhooks: new Webhooks(hub, actions), github: undefined as never, stop: async () => void stops.push(id) }
  }
  return { starts, stops, make }
}

/** A kv that says each time the hub's list of Binders is written. */
class WatchedKV extends MemoryKV {
  saved = 0
  override async set(key: string, value: string, ttlSeconds?: number) {
    if (key === 'spaces') this.saved++
    return super.set(key, value, ttlSeconds)
  }
}

const withList = async (kv: KV, infos: SpaceInfo[]) => {
  await kv.set('spaces', JSON.stringify(infos))
  return kv
}

describe('which Binders the hub starts', () => {
  const list = () => [info('team', { members: [{ login: 'ana', role: 'owner' }] }), personal('ana', { wakes: true }), personal('bo'), personal('cy', { wakes: false })]

  it('starts its team Binders, the personal ones that work alone and those with no say yet, and leaves the rest asleep', async () => {
    const { starts, make } = counting()
    const spaces = await new Spaces(await withList(new MemoryKV(), list()), make).load({ id: 'team', name: 'Team', members: [] })
    assert.deepEqual([...starts].sort(), [['team', 1], ['~ana', 1], ['~bo', 1]], 'team, one that wakes, and one from before this was kept')
    assert.equal(spaces.asleep, 1)
    assert.equal(spaces.get('~cy'), undefined, 'the one that doesn’t wake isn’t running')
    assert.deepEqual(spaces.all().map((s) => s.id), ['team', '~ana', '~bo'])
    assert.equal(spaces.list().length, 4, 'but it’s on the hub')
    assert.ok(spaces.info('~cy'))
    assert.deepEqual(spaces.forPerson('cy').map((s) => s.info.id), ['~cy'], 'and its person finds it')
  })
})

describe('starting a Binder when it’s needed', () => {
  const list = () => [info('team', { members: [{ login: 'ana', role: 'owner' }] }), info('extra', { members: [{ login: 'ana', role: 'owner' }] }), personal('cy', { wakes: false })]

  it('starts it once for everyone who asks at the same moment, and gives them the same Binder back each time', async () => {
    const { starts, make } = counting()
    const spaces = await new Spaces(await withList(new MemoryKV(), list()), make).load({ id: 'team', name: 'Team', members: [] })
    assert.equal(starts.get('~cy'), undefined)
    const [one, two, three] = await Promise.all([spaces.start('~cy'), spaces.start('~cy'), spaces.start('~cy')])
    assert.ok(one)
    assert.ok(one === two && two === three, 'one Binder for all three')
    assert.equal(starts.get('~cy'), 1)
    assert.equal(spaces.get('~cy'), one, '`get` has it from then on')
    assert.equal(await spaces.start('~cy'), one)
    assert.equal(starts.get('~cy'), 1, 'and later asks start nothing')
    assert.equal(spaces.asleep, 0)
    assert.equal(await spaces.start('team'), spaces.get('team'), 'one that is running is just given')
    assert.equal(starts.get('team'), 1)
  })

  it('gives nothing for a Binder that isn’t on the hub, or was taken off it', async () => {
    const { starts, make } = counting()
    const spaces = await new Spaces(await withList(new MemoryKV(), list()), make).load({ id: 'team', name: 'Team', members: [] })
    assert.equal(await spaces.start('nowhere'), undefined)
    await spaces.remove('extra', 'ana')
    assert.equal(await spaces.start('extra'), undefined)
    assert.equal(starts.get('extra'), 1, 'it started with the hub, and not again')
    assert.deepEqual([...starts.keys()].sort(), ['extra', 'team'], 'nothing else was started')
  })

  it('gives nothing while the hub is still starting its own', async () => {
    let release = () => {}
    const { make } = counting({ team: new Promise<void>((done) => { release = done }) })
    const spaces = new Spaces(await withList(new MemoryKV(), list()), make)
    const loading = spaces.load({ id: 'team', name: 'Team', members: [] })
    await new Promise((done) => setTimeout(done, 20))
    assert.equal(spaces.ready, false)
    assert.equal(await spaces.start('~cy'), undefined)
    release()
    await loading
    assert.ok(await spaces.start('~cy'))
  })

  it('doesn’t keep a Binder that was taken off the hub while it was starting', async () => {
    let release = () => {}
    const { starts, stops, make } = counting({ '~cy': new Promise<void>((done) => { release = done }) })
    const spaces = await new Spaces(await withList(new MemoryKV(), list()), make).load({ id: 'team', name: 'Team', members: [] })
    const waking = spaces.start('~cy')
    await until(() => starts.get('~cy') === 1)
    // Taken off the hub (a personal Binder has no way to be, so this is the list saying so) before it finished starting.
    spaces.info('~cy')!.removedAt = at
    release()
    await waking
    assert.equal(spaces.get('~cy'), undefined, 'not kept')
    assert.deepEqual(stops, ['~cy'], 'and stopped')
    assert.equal(await spaces.start('~cy'), undefined)
  })
})

describe('saying which Binders wake', () => {
  const list = () => [info('team', { members: [{ login: 'ana', role: 'owner' }] }), personal('cy', { wakes: false })]

  it('saves only when it changes, and only for a personal Binder', async () => {
    const { make } = counting()
    const kv = await withList(new WatchedKV(), list()) as WatchedKV
    const spaces = await new Spaces(kv, make).load({ id: 'team', name: 'Team', members: [] })
    const before = kv.saved
    await spaces.setWakes('~cy', false)
    assert.equal(kv.saved, before, 'the same as it was: nothing written')
    await spaces.setWakes('~cy', true)
    assert.equal(kv.saved, before + 1)
    assert.equal(spaces.info('~cy')!.wakes, true)
    assert.equal((JSON.parse((await kv.get('spaces'))!) as SpaceInfo[]).find((i) => i.id === '~cy')!.wakes, true, 'and in the saved list')
    await spaces.setWakes('~cy', true)
    assert.equal(kv.saved, before + 1, 'said again: still one write')
    await spaces.setWakes('team', true)
    assert.equal(kv.saved, before + 1, 'a team Binder has no say')
    assert.equal(spaces.info('team')!.wakes, undefined)
    await spaces.setWakes('nowhere', true)
    assert.equal(kv.saved, before + 1)
  })
})

describe('work that goes on without its person', () => {
  const agent: Agent = { id: 'a1', name: 'Pen', provider: 'claude', owner: 'cy', repos: [], binders: [], skills: [], createdAt: at }
  const card: Card = { id: 'c1', binderId: 'b1', title: 'Paint', brief: '', doneWhen: '', size: 'S', stage: 'ready', createdAt: at, createdBy: 'cy', updatedAt: at, waitsFor: [], activity: [] }
  const schedule = { id: 's1', noteId: 'n1', binderId: 'b1', cron: '0 9 * * 1', tz: 'UTC', enabled: true, createdAt: at, createdBy: 'cy' }
  const space = (over: Record<string, unknown> = {}, waiting = 0) => ({ hub: { state: { ...emptyState(), binders: [{ id: 'b1', name: 'Notes' }], ...over } }, brain: { summariesWaiting: waiting } }) as unknown as Pick<Space, 'hub' | 'brain'>

  it('is none when there is none', () => {
    assert.equal(worksAlone(space()), false)
    assert.equal(worksAlone({ hub: space().hub, brain: undefined }), false, 'with no brain, nothing waits for a summary')
  })

  it('is an agent that isn’t revoked', () => {
    assert.equal(worksAlone(space({ agents: [agent] })), true)
    assert.equal(worksAlone(space({ agents: [{ ...agent, revoked: true }] })), false, 'a revoked one is not')
  })

  it('is a schedule', () => {
    assert.equal(worksAlone(space({ schedules: [schedule] })), true)
  })

  it('is a card being worked on', () => {
    assert.equal(worksAlone(space({ cards: [{ ...card, stage: 'working' }] })), true)
    assert.equal(worksAlone(space({ cards: [card, { ...card, id: 'c2', stage: 'blocked' }] })), false, 'a card waiting for the person is not')
  })

  it('is a repo it follows', () => {
    assert.equal(worksAlone(space({ binders: [{ id: 'b1', name: 'Notes', repo: 'acme/web' }] })), true)
    assert.equal(worksAlone(space({ binders: [{ id: 'b1', name: 'Notes', repos: ['acme/web'] }] })), false, 'agents’ repos are not a repo it follows')
  })

  it('is a capture waiting for a summary', () => {
    assert.equal(worksAlone(space({}, 1)), true)
  })

  it('is its own Jira, which tells it what happened there whether its person is here or not', () => {
    const withJira = (settings: object) => ({ ...space(), jira: { settings } }) as unknown as Parameters<typeof worksAlone>[0]
    assert.equal(worksAlone(withJira({ baseUrl: 'https://acme.atlassian.net' })), true)
    assert.equal(worksAlone(withJira({})), false, 'one that was never set up is not')
  })
})

// Through the server ------------------------------------------------------------------------------------------------------

function standInModel(): BrainModel {
  return {
    label: 'stand-in (test)',
    summarize: async () => ({ title: 'Van tyres talk', summary: 'They talked about the van.', points: [], decisions: [], followUps: [] }),
    answer: async (_question, passages) => ({ text: `See ${passages[0].title}.`, parts: [{ text: `See ${passages[0].title}.`, sources: [0] }] }),
    sortMoment: async () => ({ kind: 'none', title: '' }),
    talk: async () => 'x',
  }
}

const binder = (id: string, name: string): Change => ({ type: 'binder.put', binder: { id, name, createdBy: 'you' } })
const ownAgent: Agent = { id: 'a1', name: 'Pen', provider: 'claude', owner: 'you', repos: [], binders: [], skills: [], createdAt: at }
const question: Card = { id: 'c1', binderId: '~you-part', title: 'Which garage?', brief: '', doneWhen: '', size: 'S', stage: 'blocked', needsYou: 'Which garage?', createdAt: at, createdBy: 'you', updatedAt: at, waitsFor: [], activity: [] }

/**
 * A hub with a team Binder (you and bo are in it) and three personal ones that haven't started: you's, bo's and cy's. Each
 * personal Binder's list entry says `wakes: false`, so the hub leaves them. you's holds a note with a picture, an agent and
 * a card waiting on its person.
 */
async function setUp() {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  settings.useForTests(standInModel())
  const machines = await new BrainMachines(kv).load()
  settings.useMachines(machines)
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const root = await tempDir('lazy')
  await mkdir(join(root, '~you', 'notes', 'files'), { recursive: true })
  await writeFile(join(root, '~you', 'notes', 'files', picture), 'not really a picture')
  await withList(kv, [
    info('team', { name: 'Team', members: [{ login: 'you', role: 'owner' }, { login: 'bo', role: 'member' }] }),
    personal('you', { wakes: false }), personal('bo', { wakes: false }), personal('cy', { wakes: false }),
  ])
  const seeds: Record<string, Change[]> = {
    team: [binder('team-part', 'Server'), { type: 'note.put', note: note('tn1', 'Team plan', { binderId: 'team-part', text: '# Team plan\n\nShip on Friday.\n' }) }],
    '~you': [
      binder('~you-part', 'Notes'),
      { type: 'note.put', note: note('n1', 'Van tyres', { binderId: '~you-part', text: `# Van tyres\n\nSam will book the garage for Tuesday.\n\n![shot](/api/files/${picture})\n` }) },
      { type: 'agent.put', agent: ownAgent },
      { type: 'card.put', card: question },
    ],
  }
  const { starts, stops, make: counted } = counting()
  const brains: SpaceBrain[] = []
  const make = async (id: string): Promise<Space> => {
    const made = await counted(id)
    await made.hub.start(seeds[id] ?? [binder(`${id}-part`, 'Notes')])
    const brain = new SpaceBrain({ id, hub: made.hub, kv: new MemoryKV(), settings, quietMs: 10 })
    brain.start()
    brains.push(brain)
    await brain.caughtUp()
    const connection = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, id === 'team' ? { webhookSecret: 'shh-team' } : {}, id)
    return { ...made, github: connection, brain, filesDir: join(root, id, 'files') }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'team', name: 'Team', members: [] })
  const app = await buildServer(spaces, { auth, brain: settings, machines }, { publicUrl: 'http://hub.test', admins: ['boss'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const started = (id: string) => starts.get(id)
  const signIn = async (login: string) => {
    const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    assert.equal(response.status, 200)
    return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
  }
  /** A person's calls to the hub, in the Binder named (or the first of theirs). */
  const as = async (login: string, space?: string) => {
    const cookie = await signIn(login)
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const type = response.headers.get('content-type') ?? ''
      const bytes = Buffer.from(await response.arrayBuffer())
      let parsed: any = bytes
      if (type.includes('json')) parsed = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined
      return { status: response.status, body: parsed, type, headers: response.headers }
    }
  }
  const token = async (login: string, space?: string, kind: 'app' | 'mcp' = 'app') => (await auth.issuePersonToken({ login, name: login } as never, 'A test client', undefined, space, kind)).token
  const sockets: WebSocket[] = []
  const socket = async (path: string, headers: Record<string, string>) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}${path}`, { headers })
    sockets.push(ws)
    const heard: Record<string, any>[] = []
    const closed: { code?: number } = {}
    ws.on('message', (data) => heard.push(JSON.parse(String(data))))
    ws.on('close', (code) => { closed.code = code })
    await new Promise<void>((done, fail) => { ws.once('open', () => done()); ws.once('error', fail) })
    return { ws, heard, closed }
  }
  return {
    kv, spaces, auth, machines, url, started, stops, signIn, as, token, socket,
    close: async () => { for (const ws of sockets) ws.close(); for (const brain of brains) brain.stop(); machines.closeAll(); await app.close() },
  }
}

type Set = Awaited<ReturnType<typeof setUp>>

/** Runs a test on a fresh hub in which cy's, you's and bo's own Binders are asleep, and closes it after. */
const onFresh = (test: (set: Set) => Promise<void>) => async () => {
  const set = await setUp()
  try {
    assert.equal(set.started('team'), 1, 'the team Binder started with the hub')
    for (const id of ['~you', '~bo', '~cy']) assert.equal(set.started(id), undefined, `${id} hasn’t started`)
    await test(set)
  } finally {
    await set.close()
  }
}

/** A person's own MCP connection to one Binder, and a tool called through it. */
async function personCalls(url: string, token: string, path: string, tool: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: 'test-person', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}${path}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  try {
    const result = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[] }
    return JSON.parse(result.content[0].text) as any
  } finally {
    await client.close()
  }
}

describe('a personal Binder that hasn’t started is started by what its own person does', () => {
  it('a request with its header', onFresh(async (set) => {
    const you = await set.as('you', '~you')
    const state = await you('GET', '/api/state')
    assert.equal(state.status, 200)
    assert.ok(state.body.state.notes.some((n: { id: string }) => n.id === 'n1'), 'their own notes')
    assert.equal(set.started('~you'), 1)
    await you('GET', '/api/state')
    assert.equal(set.started('~you'), 1, 'asked again, started once')
    assert.equal(set.started('~bo'), undefined)
    assert.equal(set.started('~cy'), undefined)
  }))

  it('a request that names no Binder starts the first of theirs, and not their own', onFresh(async (set) => {
    const you = await set.as('you')
    const state = await you('GET', '/api/state')
    assert.ok(state.body.state.notes.some((n: { id: string }) => n.id === 'tn1'))
    assert.equal(set.started('~you'), undefined, 'the team Binder is the first of theirs: nothing needs their own')
  }))

  it('the live feed', onFresh(async (set) => {
    const live = await set.socket('/api/live?since=0&space=~you', { cookie: await set.signIn('you') })
    await until(() => live.heard.some((m) => m.type === 'entries'))
    assert.equal(set.started('~you'), 1)
    const entries = live.heard.filter((m) => m.type === 'entries').flatMap((m) => m.entries as { change: { type: string; note?: { id: string } } }[])
    assert.ok(entries.some((e) => e.change.type === 'note.put' && e.change.note?.id === 'n1'), 'it carries that Binder’s own changes')
  }))

  it('a capture through the app link', onFresh(async (set) => {
    const phone = await set.socket('/api/app/link', { authorization: `Bearer ${await set.token('you')}` })
    assert.equal(set.started('~you'), undefined, 'connecting starts the first of theirs only')
    const answers = new Map<number, Record<string, any>>()
    phone.ws.on('message', (data) => { const m = JSON.parse(String(data)); if (typeof m.id === 'number') answers.set(m.id, m) })
    const call = async (id: number, method: string, params: Record<string, unknown>) => {
      phone.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      await until(() => answers.has(id))
      return answers.get(id)!
    }
    const filed = await call(1, 'binders/conversation', { id: 'conv-1', segments: [{ start: 0, end: 9, text: talk, speaker: 'A' }], started: at, ended: at, device: 'Test iPhone' })
    assert.equal(filed.error, undefined)
    assert.equal(set.started('~you'), 1)
    assert.equal(set.started('~bo'), undefined)
    const own = set.spaces.get('~you')!
    assert.ok(own.hub.state.notes.some((n) => n.captured === 'conversation'), 'filed as a note in their own Binder')
    const places = await call(2, 'tools/call', { name: 'list_binders', arguments: {} })
    const listed = JSON.parse(places.result.content[0].text) as { id: string }[]
    assert.ok(listed.some((b) => b.id.startsWith('~you/')) && listed.some((b) => b.id.startsWith('team/')), 'and listed with the others')
    assert.equal(set.started('~you'), 1)
  }))

  it('the app link’s first call, which lists the notes of a Binder they never asked for yet', onFresh(async (set) => {
    const phone = await set.socket('/api/app/link', { authorization: `Bearer ${await set.token('you')}` })
    const answers = new Map<number, Record<string, any>>()
    phone.ws.on('message', (data) => { const m = JSON.parse(String(data)); if (typeof m.id === 'number') answers.set(m.id, m) })
    phone.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notes', arguments: { limit: 50 } } }))
    await until(() => answers.has(1))
    const notes = JSON.parse(answers.get(1)!.result.content[0].text) as { title: string }[]
    assert.ok(notes.some((n) => n.title === 'Van tyres'), 'their own Binder’s note is there, and not an empty list')
    assert.equal(set.started('~you'), 1)
  }))

  it('the app link following their Binders for changes', onFresh(async (set) => {
    const phone = await set.socket('/api/app/link', { authorization: `Bearer ${await set.token('you')}` })
    phone.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'binders/subscribe', params: {} }))
    await until(() => phone.heard.some((m) => m.id === 1))
    assert.equal(set.started('~you'), 1)
    await set.spaces.get('~you')!.hub.record({ kind: 'user', login: 'you' }, { type: 'note.put', note: note('n2', 'Another', { binderId: '~you-part', text: '# Another\n' }) })
    await until(() => phone.heard.some((m) => m.method === 'binders/changed' && (m.params.kinds as string[]).includes('notes')))
  }))

  it('their MCP', onFresh(async (set) => {
    const listed = await personCalls(set.url, await set.token('you', '~you', 'mcp'), '/~you/mcp', 'list_notes')
    assert.ok(listed.some((n: { id: string }) => n.id === 'n1'))
    assert.equal(set.started('~you'), 1)
    assert.equal(set.started('~bo'), undefined)
  }))

  it('an agent’s token for an agent in that Binder', onFresh(async (set) => {
    const agentToken = await set.auth.issueAgentToken('a1', '~you')
    const response = await fetch(`${set.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-agent', version: '1.0.0' } } }),
    })
    assert.equal(response.status, 200)
    assert.equal(set.started('~you'), 1)
  }))

  it('a runner’s live link for that agent', onFresh(async (set) => {
    const runner = await set.socket('/api/runner/live', {})
    runner.ws.send(JSON.stringify({ type: 'hello', token: await set.auth.issueAgentToken('a1', '~you') }))
    await until(() => set.started('~you') === 1)
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(runner.closed.code, undefined, 'its token is known, so it isn’t turned away')
    assert.equal(set.started('~you'), 1)
  }))

  it('a join line made for it', onFresh(async (set) => {
    const { token } = await set.machines.agentLine('you', '~you')
    assert.equal(set.started('~you'), undefined, 'making the line by hand starts nothing')
    const joined = await fetch(`${set.url}/api/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, host: 'Studio-Mac.local', tools: ['claude'] }) })
    assert.equal(joined.status, 200)
    assert.equal(set.started('~you'), 1)
    const agents = set.spaces.get('~you')!.hub.state.agents
    assert.equal(agents.length, 2, 'its own agent and the machine’s')
    assert.ok(agents.some((a) => a.id !== 'a1' && a.owner === 'you'))
  }))

  it('Ask across their Binders', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const asked = await you('POST', '/api/brain/ask', { question: 'Who books the garage?', everywhere: true })
    assert.equal(asked.status, 200)
    assert.ok(asked.body.sources.some((s: { id: string }) => s.id === 'n1'), 'it read their own Binder’s note')
    assert.equal(set.started('~you'), 1)
    assert.equal(set.started('~bo'), undefined)
  }))

  it('Search across their Binders', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const found = await you('POST', '/api/brain/search', { query: 'garage', everywhere: true })
    assert.equal(found.status, 200)
    assert.ok(JSON.stringify(found.body).includes('n1'))
    assert.equal(set.started('~you'), 1)
  }))

  it('sending a note to it', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const sent = await you('POST', '/api/notes/tn1/send', { binder: '~you' })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.binder, '~you')
    assert.equal(set.started('~you'), 1)
    assert.ok(set.spaces.get('~you')!.hub.state.notes.some((n) => n.id === sent.body.id && n.text.includes('Ship on Friday.')), 'the copy is in it')
  }))

  it('listing where a note can be sent', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const where = await you('GET', '/api/notes/send-to')
    assert.deepEqual(where.body.binders, [{ id: '~you', name: 'Personal', personal: true }])
    assert.equal(set.started('~you'), 1)
  }))

  it('what waits for them, in each Binder', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const waiting = await you('GET', '/api/me/waiting')
    assert.equal(waiting.status, 200)
    assert.deepEqual(waiting.body.binders, [{ id: 'team', name: 'Team', count: 0 }, { id: '~you', name: 'Personal', count: 1 }])
    assert.equal(set.started('~you'), 1)
    assert.equal(set.started('~bo'), undefined)
  }))

  it('a picture kept in it, asked for from another Binder', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const shown = await you('GET', `/api/files/${picture}`)
    assert.equal(shown.status, 200)
    assert.equal(shown.body.toString('utf8'), 'not really a picture')
    assert.equal(set.started('~you'), 1)
    assert.equal(set.started('~bo'), undefined)
  }))

  it('their capture settings, read', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const settings = await you('GET', '/api/personal/captures')
    assert.equal(settings.body.home, '~you')
    assert.deepEqual(settings.body.binders.map((b: { id: string }) => b.id), ['~you', 'team'])
    assert.equal(set.started('~you'), 1)
  }))

  it('their capture settings, changed', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const chosen = await you('PUT', '/api/personal/captures', { binder: 'team' })
    assert.equal(chosen.status, 200, 'not “your own Binder isn’t ready”')
    assert.equal(chosen.body.home, 'team')
    assert.equal(set.started('~you'), 1)
    assert.equal((await you('GET', '/api/personal/captures')).body.home, 'team', 'and kept in their own Binder')
  }))

  it('a capture that names no Binder, which goes where they chose', onFresh(async (set) => {
    const you = await set.as('you')
    const made = await you('POST', '/api/captures', { kind: 'dictation', text: 'Remind the team about Friday.' })
    assert.equal(made.status, 200)
    assert.equal(set.started('~you'), 1, 'their own Binder was looked in, for the choice')
    assert.ok(set.spaces.get('team')!.hub.state.notes.some((n) => n.id === made.body.note.id), 'it went to the Binder they were in, as no choice was made')
  }))

  it('downloading its copy', onFresh(async (set) => {
    const you = await set.as('you', 'team')
    const copy = await you('GET', '/api/spaces/~you/copy')
    assert.equal(copy.status, 200)
    assert.match(copy.type, /gzip/)
    assert.match(String(copy.headers.get('content-disposition')), /attachment/)
    assert.ok(copy.body.length > 20, 'the copy has something in it')
    assert.equal(set.started('~you'), 1)
  }))
})

describe('a personal Binder that hasn’t started is left alone by everyone else', () => {
  it('another person’s requests, however they ask', onFresh(async (set) => {
    const bo = await set.as('bo', '~you')
    assert.equal((await bo('GET', '/api/state')).status, 403)
    const fromTeam = await set.as('bo', 'team')
    assert.equal((await fromTeam('GET', `/api/files/${picture}`)).status, 404, 'a picture in someone’s own Binder isn’t found from theirs')
    const copy = await fromTeam('GET', '/api/spaces/~you/copy')
    assert.ok(copy.status >= 400, 'no copy of it')
    assert.equal((await fromTeam('POST', '/api/notes/tn1/send', { binder: '~you' })).status, 422)
    assert.deepEqual((await fromTeam('GET', '/api/notes/send-to')).body.binders, [{ id: '~bo', name: 'Personal', personal: true }])
    assert.deepEqual((await fromTeam('GET', '/api/me/waiting')).body.binders.map((b: { id: string }) => b.id), ['team', '~bo'])
    assert.equal((await fromTeam('POST', '/api/brain/ask', { question: 'Who books the garage?', everywhere: true })).status, 200)
    assert.equal((await fromTeam('PUT', '/api/personal/captures', { binder: '~you' })).status, 422)
    assert.equal((await fromTeam('GET', '/api/personal/captures')).body.home, '~bo')
    const live = await set.socket('/api/live?since=0&space=~you', { cookie: await set.signIn('bo') }).catch(() => undefined)
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(live?.heard.length ?? 0, 0, 'no feed of it')
    const phone = await set.socket('/api/app/link', { authorization: `Bearer ${await set.token('bo')}` })
    phone.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'binders/hello', params: {} }))
    await until(() => phone.heard.some((m) => m.id === 1))
    await assert.rejects(personCalls(set.url, await set.token('bo', '~you', 'mcp'), '/~you/mcp', 'list_notes'), 'their MCP connection for it is refused')
    assert.equal(set.started('~you'), undefined)
    assert.equal(set.started('~cy'), undefined)
    assert.equal(set.started('~bo'), 1, 'while bo’s own started, once')
  }))

  it('a hub admin listing the hub’s Binders, or looking at what they can reach', onFresh(async (set) => {
    const boss = await set.as('boss', 'team')
    const listed = await boss('GET', '/api/hub/binders')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.binders.map((b: { id: string }) => b.id), ['team'], 'the team Binders: personal ones aren’t theirs to list')
    assert.equal((await boss('GET', '/api/spaces')).status, 200)
    assert.equal((await boss('GET', '/api/state')).status, 403, 'and not opened')
    assert.ok((await boss('GET', '/api/spaces/~you/copy')).status >= 400)
    assert.ok([403, 404].includes((await boss('GET', `/api/files/${picture}`)).status), 'no picture of theirs')
    assert.equal((await boss('POST', '/api/brain/ask', { question: 'garage', everywhere: true })).status, 403, 'in no Binder, there is nothing for them to ask')
    assert.equal(set.started('~you'), undefined)
    assert.equal(set.started('~bo'), undefined)
    assert.equal(set.started('~cy'), undefined)
  }))

  it('a webhook to a team Binder, or one aimed at a personal one', onFresh(async (set) => {
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' })
    const signed = `sha256=${createHmac('sha256', 'shh-team').update(body).digest('hex')}`
    const send = (path: string, headers: Record<string, string> = {}) => fetch(`${set.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    const ping = await send('/webhooks/github/team', { 'x-github-event': 'ping', 'x-hub-signature-256': signed })
    assert.equal(ping.status, 200, 'the team Binder heard it')
    assert.equal((await send('/webhooks/github/~you', { 'x-github-event': 'ping', 'x-hub-signature-256': signed })).status, 404)
    assert.equal((await send('/webhooks/jira/~you?secret=guess')).status, 404)
    assert.equal(set.started('~you'), undefined)
    assert.equal(set.started('~bo'), undefined)
    assert.equal(set.started('~cy'), undefined)
    assert.equal(set.started('team'), 1)
  }))
})
