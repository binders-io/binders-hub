import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { Spaces, type Space } from '../src/spaces.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { SpaceBrain, noModelToSum } from '../src/brain/brain.ts'
import { chooseHome, chosenHome, hasSummary, transcriptOf } from '../src/brain/captures.ts'
import type { BrainModel, Summary } from '../src/brain/models.ts'
import type { Change } from '../../shared/state.ts'
import { note, tempDir, until } from './helpers.ts'

// Captures that reach the team, wherever a person says they go, and summaries that arrive late: a note sent to another
// of the person's Binders, the Binder their captures go to, and a capture that waited for a model.

const talk = 'so the van needs new tyres before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams'
const summary: Summary = { title: 'Van tyres', summary: 'They talked about the van.', points: [], decisions: [], followUps: ['Book the garage for Tuesday'] }
const picture = 'a1b2c3d4e5f6a1b2c3d4e5f6.png'

function standInModel(seen: { text: string; at: number }[] = [], pause = 0): BrainModel {
  return {
    label: 'stand-in (test)',
    summarize: async (capture) => {
      seen.push({ text: capture.text, at: Date.now() })
      if (pause) await new Promise((done) => setTimeout(done, pause))
      return summary
    },
    answer: async () => ({ text: 'x', parts: [] }),
    sortMoment: async () => ({ kind: 'none', title: '' }),
    talk: async () => 'x',
  }
}

const binder = (id: string, name: string): Change => ({ type: 'binder.put', binder: { id, name, createdBy: 'you' } })

/**
 * A hub with three team Binders and the person's own: `you` is in team, side and their own; `bo` is in team and ops; and
 * boss is a hub admin who is in none of them. Each has a brain and a folder for its pictures.
 */
async function setUp() {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  settings.useForTests(standInModel())
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const root = await tempDir('captures')
  const make = async (id: string, part: string, seed: Change[] = []): Promise<Space> => {
    const hub = new Hub(new MemoryLog())
    await hub.start([binder(`${id}-part`, part), ...seed])
    const actions = new Actions(hub, github)
    const brain = new SpaceBrain({ id, hub, kv: new MemoryKV(), settings, quietMs: 10, retryMs: 30 })
    brain.start()
    return { id, hub, actions, webhooks: new Webhooks(hub, actions), github, brain, filesDir: join(root, id, 'files') }
  }
  const mine = await make('~you', 'Notes', [
    { type: 'note.put', note: note('n1', 'Lunch with Sam', { binderId: '~you-part', text: `# Lunch with Sam\n\nWe met at noon.\n\n![shot](/api/files/${picture})\n`, captured: 'conversation' }) },
  ])
  const team = await make('team', 'Server')
  const side = await make('side', 'Side')
  const ops = await make('ops', 'Ops')
  // The picture is where it was put: in the note's own Binder, by its part's name.
  await mkdir(join(root, '~you', 'notes', 'files'), { recursive: true })
  await writeFile(join(root, '~you', 'notes', 'files', picture), 'not really a picture')
  const spaces = Spaces.of(kv, [
    { info: { id: 'team', name: 'Team', members: [{ login: 'you', role: 'owner' }, { login: 'bo', role: 'member' }] }, space: team },
    { info: { id: 'side', name: 'Side', members: [{ login: 'you', role: 'owner' }] }, space: side },
    { info: { id: 'ops', name: 'Ops', members: [{ login: 'bo', role: 'owner' }] }, space: ops },
    { info: { id: '~you', name: 'Personal', members: [{ login: 'you', role: 'owner' }], personal: 'you' }, space: mine },
  ])
  const app = await buildServer(spaces, { auth, brain: settings }, { publicUrl: 'http://hub.test', admins: ['boss'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const { token } = await auth.issuePersonToken({ login: 'you', name: 'You' } as never, 'Binders for iPhone on a test phone')
  return { kv, settings, spaces, mine, team, side, ops, root, url, token, auth, close: async () => { for (const s of [mine, team, side, ops]) s.brain!.stop(); await app.close() } }
}

async function signIn(url: string, login: string) {
  const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
  assert.equal(response.status, 200)
  return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
}

/** A person's calls to the hub, in the Binder named. */
function api(url: string, cookie: string) {
  return async (method: string, path: string, body?: unknown, space?: string) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    let parsed: unknown = text
    try { parsed = text ? JSON.parse(text) : undefined } catch { /* a file, as it is */ }
    return { status: response.status, body: parsed as Record<string, any> }
  }
}

describe('sending a note to another Binder', () => {
  it('copies it with its pictures, a line each way, and says so when it’s sent twice', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, await signIn(set.url, 'you'))
      const bo = api(set.url, await signIn(set.url, 'bo'))
      assert.equal((await bo('GET', `/api/files/${picture}`, undefined, 'team')).status, 404, 'a teammate can’t see a picture kept in someone’s own Binder')

      const sent = await you('POST', '/api/notes/n1/send', { binder: 'team' }, '~you')
      assert.equal(sent.status, 200)
      assert.equal(sent.body.again, false)
      assert.equal(sent.body.binder, 'team')
      assert.equal(sent.body.binderName, 'Team')
      assert.equal(sent.body.marked, true)
      const copy = set.team.hub.state.notes.find((n) => n.id === sent.body.id)!
      assert.equal(copy.title, 'Lunch with Sam')
      assert.equal(copy.binderId, 'team-part')
      assert.equal(copy.folderId, undefined, 'at the top: the Binder had no folder for captures, and none is made')
      assert.equal(set.team.hub.state.folders.length, 0)
      assert.equal(copy.captured, 'conversation', 'a conversation is still read by a person before work comes of it')
      assert.equal(copy.editedBy, 'you')
      const lines = copy.text.split('\n')
      assert.equal(lines[0], '# Lunch with Sam')
      assert.match(lines[2], /^_Sent from \[Lunch with Sam\]\(http:\/\/hub\.test\/~you\/#\/notes\/n1\) in Personal by @you on \d{4}-\d\d-\d\d \d\d:\d\d UTC\._$/)
      assert.ok(copy.text.includes('We met at noon.') && copy.text.includes(`![shot](/api/files/${picture})`))
      // The original stays, with a line at its end for where it went, a link to the copy.
      const original = set.mine.hub.state.notes.find((n) => n.id === 'n1')!
      assert.ok(original.text.startsWith('# Lunch with Sam\n\nWe met at noon.'))
      assert.match(original.text.trimEnd().split('\n').at(-1)!, new RegExp(`^_Sent to Team on \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC: \\[Lunch with Sam\\]\\(http://hub\\.test/#/notes/${copy.id}\\)\\._$`))
      assert.equal(original.binderId, '~you-part', 'it stays where it is')
      // Its picture is in the team's now: a teammate who isn't in the person's own Binder sees it.
      assert.equal(await readFile(join(set.root, 'team', 'server', 'files', picture), 'utf8'), 'not really a picture')
      assert.equal((await bo('GET', `/api/files/${picture}`, undefined, 'team')).status, 200)

      const second = await you('POST', '/api/notes/n1/send', { binder: 'team' }, '~you')
      assert.equal(second.status, 200)
      assert.equal(second.body.again, true, 'said, not guessed')
      assert.notEqual(second.body.id, sent.body.id)
      assert.equal(set.team.hub.state.notes.filter((n) => n.title === 'Lunch with Sam').length, 2, 'a second copy')
    } finally {
      await set.close()
    }
  })

  it('goes in the folder a Binder keeps captures in, when it has one, and makes no other', async () => {
    const set = await setUp()
    try {
      await set.side.hub.record({ kind: 'user', login: 'you' }, { type: 'folder.put', folder: { id: 'f-caps', binderId: 'side-part', name: 'captures' } })
      await set.side.hub.record({ kind: 'user', login: 'you' }, { type: 'folder.put', folder: { id: 'f-other', binderId: 'side-part', name: 'Plans' } })
      const you = api(set.url, await signIn(set.url, 'you'))
      const sent = await you('POST', '/api/notes/n1/send', { binder: 'side' }, '~you')
      assert.equal(sent.status, 200)
      assert.equal(sent.body.folder, 'captures')
      assert.equal(set.side.hub.state.notes.find((n) => n.id === sent.body.id)!.folderId, 'f-caps')
      assert.equal(set.side.hub.state.folders.length, 2)
    } finally {
      await set.close()
    }
  })

  it('refuses in plain words: a Binder they’re not in, one that isn’t there, a note that’s gone, the same Binder', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, await signIn(set.url, 'you'))
      const before = JSON.stringify([set.team.hub.state.notes, set.ops.hub.state.notes, set.mine.hub.state.notes])
      const notIn = await you('POST', '/api/notes/n1/send', { binder: 'ops' }, '~you')
      assert.deepEqual([notIn.status, notIn.body.error], [422, 'You’re not in that Binder.'])
      const nowhere = await you('POST', '/api/notes/n1/send', { binder: 'nowhere' }, '~you')
      assert.deepEqual([nowhere.status, nowhere.body.error], [422, 'You’re not in that Binder.'], 'a Binder that isn’t there reads like one they’re not in')
      // Somebody else's personal Binder is theirs alone.
      const theirs = await you('POST', '/api/notes/n1/send', { binder: '~bo' }, '~you')
      assert.equal(theirs.body.error, 'You’re not in that Binder.')
      const gone = await you('POST', '/api/notes/gone/send', { binder: 'team' }, '~you')
      assert.deepEqual([gone.status, gone.body.error], [422, 'That note isn’t there any more.'])
      const same = await you('POST', '/api/notes/n1/send', { binder: '~you' }, '~you')
      assert.deepEqual([same.status, same.body.error], [422, 'That note is in that Binder already.'])
      const none = await you('POST', '/api/notes/n1/send', {}, '~you')
      assert.deepEqual([none.status, none.body.error], [422, 'Say which Binder to send it to.'])
      assert.equal(JSON.stringify([set.team.hub.state.notes, set.ops.hub.state.notes, set.mine.hub.state.notes]), before, 'nothing was made or changed')

      // From a Binder they're not in: a hub admin doesn't open it, so sends from none they aren't a member of.
      const boss = api(set.url, await signIn(set.url, 'boss'))
      assert.equal((await boss('GET', '/api/notes/send-to', undefined, 'ops')).status, 403)
      assert.equal((await boss('POST', '/api/notes/anything/send', { binder: 'team' }, 'ops')).status, 403)
      const bo = api(set.url, await signIn(set.url, 'bo'))
      assert.equal((await bo('POST', '/api/notes/n1/send', { binder: 'team' }, '~you')).status, 403, 'someone’s own Binder isn’t opened by anyone else')
    } finally {
      await set.close()
    }
  })

  it('lists the Binders a person may send to: their other ones, their own first, and never one they’re not in', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, await signIn(set.url, 'you'))
      const fromOwn = await you('GET', '/api/notes/send-to', undefined, '~you')
      assert.deepEqual(fromOwn.body.binders, [{ id: 'team', name: 'Team', personal: false }, { id: 'side', name: 'Side', personal: false }])
      const fromTeam = await you('GET', '/api/notes/send-to', undefined, 'team')
      assert.deepEqual(fromTeam.body.binders, [{ id: '~you', name: 'Personal', personal: true }, { id: 'side', name: 'Side', personal: false }])
      const boss = api(set.url, await signIn(set.url, 'boss'))
      assert.equal((await boss('GET', '/api/notes/send-to', undefined, 'team')).status, 403, 'a hub admin’s other Binders aren’t theirs to send to, or to open')
    } finally {
      await set.close()
    }
  })

  it('leaves a note locked against the sender as it is, and still copies it', async () => {
    const set = await setUp()
    try {
      // A member who isn't one of its owners: the lock stops them changing the original, not reading it.
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.put', note: note('held', 'Held', { binderId: 'team-part', text: '# Held\n\nAnother’s words.\n' }) })
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.lock', id: 'held', locked: { by: 'you', at: 'now' } })
      const bo = api(set.url, await signIn(set.url, 'bo'))
      const before = set.team.hub.state.notes.find((n) => n.id === 'held')!.text
      const sent = await bo('POST', '/api/notes/held/send', { binder: 'ops' }, 'team')
      assert.equal(sent.status, 200)
      assert.equal(sent.body.marked, false)
      assert.equal(set.team.hub.state.notes.find((n) => n.id === 'held')!.text, before)
      const copy = set.ops.hub.state.notes.find((n) => n.id === sent.body.id)!
      assert.equal(copy.locked, undefined, 'the copy is the sender’s to change')
      assert.ok(copy.text.includes('Another’s words.'))
      // Its owner's own send marks it, as the owner may change it.
      const you = api(set.url, await signIn(set.url, 'you'))
      assert.equal((await you('POST', '/api/notes/held/send', { binder: 'side' }, 'team')).body.marked, true)
    } finally {
      await set.close()
    }
  })
})

describe('where a person’s captures go', () => {
  it('is theirs to choose from the Binders they’re in, their own unless they say, and theirs alone', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, await signIn(set.url, 'you'))
      const first = await you('GET', '/api/personal/captures')
      assert.equal(first.body.home, '~you')
      assert.deepEqual(first.body.binders, [{ id: '~you', name: 'Personal', personal: true }, { id: 'team', name: 'Team', personal: false }, { id: 'side', name: 'Side', personal: false }])
      const chosen = await you('PUT', '/api/personal/captures', { binder: 'team' })
      assert.equal(chosen.body.home, 'team')
      assert.equal(await chosenHome(set.mine.brain!.kv), 'team', 'kept in their own Binder’s store')
      assert.equal((await you('GET', '/api/personal/captures')).body.home, 'team')

      const refused = await you('PUT', '/api/personal/captures', { binder: 'ops' })
      assert.deepEqual([refused.status, refused.body.error], [422, 'You’re not in that Binder.'])
      assert.equal((await you('PUT', '/api/personal/captures', { binder: '~bo' })).status, 422)
      assert.equal((await you('PUT', '/api/personal/captures', {})).status, 422)
      assert.equal((await you('GET', '/api/personal/captures')).body.home, 'team', 'a refusal changes nothing')

      // Someone else's choice is their own: bo has made none, and sees theirs, not this one.
      const bo = api(set.url, await signIn(set.url, 'bo'))
      assert.equal((await bo('GET', '/api/personal/captures', undefined, 'team')).body.home, '~bo')

      // Their own again, as the default: nothing is kept.
      assert.equal((await you('PUT', '/api/personal/captures', { binder: '~you' })).body.home, '~you')
      assert.equal(await chosenHome(set.mine.brain!.kv), undefined)
    } finally {
      await set.close()
    }
  })

  /** The iPhone's side of the link: JSON-RPC calls over the WebSocket. */
  async function link(url: string, token: string) {
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/app/link`, { headers: { authorization: `Bearer ${token}` } })
    await new Promise<void>((done, fail) => { socket.once('open', () => done()); socket.once('error', fail) })
    let next = 1
    const waiting = new Map<number, (message: Record<string, unknown>) => void>()
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>
      if (typeof message.id === 'number') waiting.get(message.id)?.(message)
    })
    const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done) => {
      const id = next++
      waiting.set(id, done)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    return { request, close: () => socket.close() }
  }
  const converse = (id: string) => ({ id, started: '2026-11-07T10:00:00Z', ended: '2026-11-07T10:05:00Z', device: 'iPhone', speakers: {}, segments: talk.split(' and ').map((text, i) => ({ id: `S${i}`, start: i * 10, end: i * 10 + 9, text, speaker: 'Speaker 1' })) })
  const filed = async (phone: Awaited<ReturnType<typeof link>>, id: string) => {
    await until(async () => ((await phone.request('binders/outcomes', { ids: [id] })).result as { outcomes: { state: string }[] }).outcomes[0]?.state === 'filed')
    return ((await phone.request('binders/outcomes', { ids: [id] })).result as { outcomes: { line: string; binder?: string }[] }).outcomes[0]
  }

  it('files what the iPhone hears there, with its follow-ups going where the conversation went, and back to their own when they’ve left it', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [] })
      const you = api(set.url, await signIn(set.url, 'you'))
      assert.equal((await you('PUT', '/api/personal/captures', { binder: 'side' })).body.home, 'side')

      await phone.request('binders/conversation', converse('C0FFEE00-0000-4000-8000-0000000000A1'))
      const outcome = await filed(phone, 'C0FFEE00-0000-4000-8000-0000000000A1')
      assert.equal(outcome.line, 'Filed in Side: Van tyres')
      assert.equal(outcome.binder, 'Side')
      assert.ok(set.side.hub.state.notes.some((n) => n.captured === 'conversation'), 'in the Binder they chose')
      assert.ok(!set.mine.hub.state.notes.some((n) => n.captured === 'conversation' && n.id.startsWith('note-cap-')), 'not in their own')
      const offered = ((await phone.request('binders/suggestions')).result as { suggestions: Record<string, unknown>[] }).suggestions
      assert.deepEqual(offered.map((s) => [s.text, s.binder, s.status]), [['Book the garage for Tuesday', 'Side', 'offered']])
      assert.ok(!('place' in offered[0]), 'what the iPhone reads has the same keys as before')
      await phone.request('binders/suggestion', { id: offered[0].id, action: 'accept' })
      assert.ok(set.side.hub.state.cards.some((c) => c.title === 'Book the garage for Tuesday'), 'on the board of the Binder it was heard for')
      assert.ok(!set.mine.hub.state.cards.some((c) => c.title === 'Book the garage for Tuesday'))

      // Left that Binder: what's captured next goes to their own again.
      await set.spaces.setMember('side', 'sam', 'owner', true)
      await set.spaces.removeMember('side', 'you', true)
      await phone.request('binders/conversation', converse('C0FFEE00-0000-4000-8000-0000000000A2'))
      const back = await filed(phone, 'C0FFEE00-0000-4000-8000-0000000000A2')
      assert.equal(back.line, 'Filed in Personal: Van tyres')
      assert.equal((await you('GET', '/api/personal/captures')).body.home, '~you', 'read as their own again')
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('puts what they say to Binders on its own, a to-do say, on that Binder’s board', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [] })
      set.settings.useForTests({ ...standInModel(), sortMoment: async (said) => ({ kind: 'todo', title: said.replace(/^remind me to /i, '') }) })
      const you = api(set.url, await signIn(set.url, 'you'))
      await phone.request('binders/moment', { id: 'M1', text: 'remind me to ring the garage' })
      assert.ok(set.mine.hub.state.cards.some((c) => c.title === 'ring the garage'), 'their own, by default')
      await you('PUT', '/api/personal/captures', { binder: 'team' })
      const said = await phone.request('binders/moment', { id: 'M2', text: 'remind me to book the van' })
      assert.equal((said.result as { outcome: { line: string } }).outcome.line, 'Added to Team: book the van')
      assert.ok(set.team.hub.state.cards.some((c) => c.title === 'book the van'))
      assert.ok(!set.mine.hub.state.cards.some((c) => c.title === 'book the van'))
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('offers a follow-up on a Binder the person has left only with a word to say so', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [] })
      const you = api(set.url, await signIn(set.url, 'you'))
      await you('PUT', '/api/personal/captures', { binder: 'side' })
      await phone.request('binders/conversation', converse('C0FFEE00-0000-4000-8000-0000000000B1'))
      await filed(phone, 'C0FFEE00-0000-4000-8000-0000000000B1')
      await set.spaces.setMember('side', 'sam', 'owner', true)
      await set.spaces.removeMember('side', 'you', true)
      const offered = ((await phone.request('binders/suggestions')).result as { suggestions: { id: string }[] }).suggestions
      const reply = await phone.request('binders/suggestion', { id: offered[0].id, action: 'accept' })
      assert.equal((reply.error as { message: string }).message, 'You’re not in Side any more, so that can’t go on its board.')
      assert.equal(set.side.hub.state.cards.length, 0)
    } finally {
      phone.close()
      await set.close()
    }
  })
})

/** A hub and a brain of its own, for the summaries that come late. */
async function withBrain(options: { kv?: MemoryKV; hub?: Hub; model?: BrainModel } = {}) {
  const kv = options.kv ?? new MemoryKV()
  const settings = await new BrainSettingsStore(new MemoryKV(), new Sealer('test-secret'), {}).load()
  settings.useForTests(options.model)
  const hub = options.hub ?? new Hub(new MemoryLog())
  if (!options.hub) await hub.start([binder('b1', 'Server')])
  const brain = new SpaceBrain({ id: 'late', hub, kv, settings, quietMs: 10, retryMs: 30 })
  brain.start()
  return { kv, settings, hub, brain, stop: () => brain.stop() }
}

const conversation = { kind: 'conversation' as const, text: `**[00:00] You:** ${talk}` }
const bare = (hub: Hub, id: string) => hub.state.notes.find((n) => n.id === id)!

describe('a capture that wasn’t summed up', () => {
  it('gets its summary once a model answers, with what the person wrote since kept beside it', async () => {
    const set = await withBrain()
    try {
      const made = await set.brain.capture('you', conversation, { sourceId: 'one' })
      assert.equal(made.summarizing, false, 'no model answers')
      const id = made.note.id
      assert.ok(!hasSummary(bare(set.hub, id).text))
      // They change it meanwhile: their words are added to, and its title is theirs.
      const mine = bare(set.hub, id)
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'note.edit', id, text: `${mine.text.replace(mine.title, 'Tyres, my way')}\nMy own line, written before the summary.\n`, title: 'Tyres, my way', by: 'you', at: new Date().toISOString() })
      await new Promise((done) => setTimeout(done, 80))
      assert.ok(!hasSummary(bare(set.hub, id).text), 'nothing is made up while no model answers')

      set.settings.useForTests(standInModel())
      await until(() => hasSummary(bare(set.hub, id).text))
      const now = bare(set.hub, id)
      assert.ok(now.text.includes('My own line, written before the summary.'), 'their words stay')
      assert.ok(now.text.includes('# Tyres, my way'), 'and their title')
      assert.equal(now.title, 'Tyres, my way')
      assert.ok(now.text.includes('## Summary\n\nThey talked about the van.'))
      assert.ok(now.text.indexOf('## Summary') < now.text.indexOf('## Transcript'), 'above the transcript')
      assert.equal(now.editedBy, 'hub')
      await until(async () => (await set.kv.get('summaries-waiting')) === '{}')
    } finally {
      set.stop()
    }
  })

  it('takes the title the hub chose, while it’s still the note’s, and tries again if the model fails', async () => {
    let fail = true
    const model: BrainModel = { ...standInModel(), summarize: async () => { if (fail) throw new Error('The model isn’t answering.'); return summary } }
    const set = await withBrain({ model })
    try {
      const made = await set.brain.capture('you', conversation, { sourceId: 'two' })
      assert.equal(made.summarizing, true)
      assert.equal(await made.written, undefined)
      assert.ok(!hasSummary(bare(set.hub, made.note.id).text))
      fail = false
      await until(() => hasSummary(bare(set.hub, made.note.id).text))
      assert.equal(bare(set.hub, made.note.id).title, 'Van tyres', 'the summary’s title replaces the hub’s own')
    } finally {
      set.stop()
    }
  })

  it('does the oldest first, a few at a time, and gives up on one a week old', async () => {
    const seen: { text: string; at: number }[] = []
    const set = await withBrain()
    try {
      const day = 86_400_000
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const made = await set.brain.capture('you', { ...conversation, text: `**[00:00] You:** ${talk} number${i}` }, { sourceId: `many-${i}` })
        ids.push(made.note.id)
      }
      const old = await set.brain.capture('you', { ...conversation, text: `**[00:00] You:** ${talk} ancient` }, { sourceId: 'ancient' })
      // Their arrival times, as they were kept: the last one captured arrived first, the ancient one over a week ago.
      const arrived: Record<string, { since: string }> = Object.fromEntries([...ids].reverse().map((id, i) => [id, { since: new Date(Date.now() - (5 - i) * day).toISOString() }]))
      arrived[old.note.id] = { since: new Date(Date.now() - 8 * day).toISOString() }
      await set.kv.set('summaries-waiting', JSON.stringify(arrived))
      set.stop()
      // A hub start-up: it reads what waited, and a model answers.
      let running = 0
      let most = 0
      const model: BrainModel = { ...standInModel(), summarize: async (c) => { seen.push({ text: c.text, at: Date.now() }); running++; most = Math.max(most, running); await new Promise((done) => setTimeout(done, 30)); running--; return summary } }
      const again = await withBrain({ kv: set.kv, hub: set.hub, model })
      try {
        await until(() => ids.every((id) => hasSummary(bare(set.hub, id).text)), 8000)
        assert.ok(most <= 3 && most >= 1, `at most a few at once (${most})`)
        // Oldest first: the one kept as arriving first is the one captured last (ids[4]).
        assert.deepEqual(seen.map((s) => /number(\d)/.exec(s.text)![1]), ['4', '3', '2', '1', '0'])
        assert.ok(!hasSummary(bare(set.hub, old.note.id).text), 'a week is long enough')
        assert.equal(await set.kv.get('summaries-waiting'), '{}')
      } finally {
        again.stop()
      }
    } finally {
      set.stop()
    }
  })

  it('remembers across a restart, leaves a locked note or one someone summed themselves, and forgets a note that’s gone', async () => {
    const set = await withBrain()
    try {
      const a = await set.brain.capture('you', { ...conversation, text: `**[00:00] You:** ${talk} alpha` }, { sourceId: 'a' })
      const b = await set.brain.capture('you', { ...conversation, text: `**[00:00] You:** ${talk} bravo` }, { sourceId: 'b' })
      const c = await set.brain.capture('you', { ...conversation, text: `**[00:00] You:** ${talk} charlie` }, { sourceId: 'c' })
      const d = await set.brain.capture('you', { ...conversation, text: `**[00:00] You:** ${talk} delta` }, { sourceId: 'd' })
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'note.lock', id: b.note.id, locked: { by: 'you', at: 'now' } })
      const ownSummary = `${bare(set.hub, c.note.id).text}\n## Summary\n\nMy own summary.\n`
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'note.edit', id: c.note.id, text: ownSummary, title: bare(set.hub, c.note.id).title, by: 'you', at: new Date().toISOString() })
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'note.delete', id: d.note.id })
      set.stop()
      // The hub restarts: a new brain over the same notes and the same store.
      const again = await withBrain({ kv: set.kv, hub: set.hub, model: standInModel() })
      try {
        await until(() => hasSummary(bare(set.hub, a.note.id).text))
        await until(async () => (await set.kv.get('summaries-waiting')) === '{}')
        assert.ok(!hasSummary(bare(set.hub, b.note.id).text), 'a locked note is a person’s to settle')
        assert.ok(bare(set.hub, c.note.id).text.endsWith('My own summary.\n'), 'a summary they wrote is theirs')
        assert.ok(!bare(set.hub, c.note.id).text.includes('They talked about the van.'))
      } finally {
        again.stop()
      }
    } finally {
      set.stop()
    }
  })

  it('isn’t waited for when it’s a dictation or too short to sum up', async () => {
    const set = await withBrain({ model: standInModel() })
    try {
      const dictation = await set.brain.capture('you', { kind: 'dictation', text: talk }, { sourceId: 'dict' })
      const short = await set.brain.capture('you', { kind: 'conversation', text: 'too few words here' }, { sourceId: 'short' })
      assert.equal(dictation.summarizing, false)
      assert.equal(short.summarizing, false)
      assert.equal(await set.kv.get('summaries-waiting'), undefined, 'nothing waits')
    } finally {
      set.stop()
    }
  })
})

describe('summing up any note', () => {
  it('puts a summary beside a note’s words, whatever the note is, and says what it can’t do in plain words', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, await signIn(set.url, 'you'))
      const bo = api(set.url, await signIn(set.url, 'bo'))
      const words = `# Planning\n\n${talk}\n\nAnd a line of my own.\n`
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.put', note: note('w1', 'Planning', { binderId: 'team-part', text: words }) })
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.put', note: note('w2', 'Tiny', { binderId: 'team-part', text: '# Tiny\n\nFew words.\n' }) })
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.put', note: note('w3', 'Settled', { binderId: 'team-part', text: words }) })
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.lock', id: 'w3', locked: { by: 'you', at: 'then' } })

      set.settings.useForTests(undefined)
      const noModel = await you('POST', '/api/notes/w1/sum-up', undefined, 'team')
      assert.deepEqual([noModel.status, noModel.body.error], [422, noModelToSum])
      assert.equal(noModelToSum, 'The hub has no model to sum it up with yet. An admin can set one up in Settings → Brain.')
      assert.equal(set.team.hub.state.notes.find((n) => n.id === 'w1')!.text, words)

      set.settings.useForTests(standInModel())
      const small = await you('POST', '/api/notes/w2/sum-up', undefined, 'team')
      assert.deepEqual([small.status, small.body.error], [422, 'There isn’t enough in it to sum up yet.'])
      const gone = await you('POST', '/api/notes/nope/sum-up', undefined, 'team')
      assert.deepEqual([gone.status, gone.body.error], [422, 'That note isn’t there any more.'])
      const locked = await bo('POST', '/api/notes/w3/sum-up', undefined, 'team')
      assert.equal(locked.status, 422)
      assert.match(locked.body.error, /locked by @you/)

      const done = await you('POST', '/api/notes/w1/sum-up', undefined, 'team')
      assert.deepEqual([done.status, done.body], [200, { ok: true }])
      const now = set.team.hub.state.notes.find((n) => n.id === 'w1')!
      assert.ok(now.text.startsWith(words.replace(/\n+$/, '')), 'their words are as they were')
      assert.ok(now.text.includes('## Summary\n\nThey talked about the van.'))
      assert.equal(now.title, 'Planning')
      assert.equal(now.editedBy, 'hub')
      const twice = await you('POST', '/api/notes/w1/sum-up', undefined, 'team')
      assert.deepEqual([twice.status, twice.body.error], [422, 'It has a summary already.'])
      // The one who locked it may.
      assert.equal((await you('POST', '/api/notes/w3/sum-up', undefined, 'team')).status, 200)
    } finally {
      await set.close()
    }
  })

  it('says what went wrong when the model fails, and leaves the note as it is', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, await signIn(set.url, 'you'))
      const words = `# Planning\n\n${talk}\n`
      await set.team.hub.record({ kind: 'user', login: 'you' }, { type: 'note.put', note: note('w1', 'Planning', { binderId: 'team-part', text: words }) })
      set.settings.useForTests({ ...standInModel(), summarize: async () => { throw new Error('The model is busy.') } })
      const failed = await you('POST', '/api/notes/w1/sum-up', undefined, 'team')
      assert.deepEqual([failed.status, failed.body.error], [422, 'The hub’s model couldn’t sum it up: The model is busy.'])
      assert.equal(set.team.hub.state.notes.find((n) => n.id === 'w1')!.text, words)
    } finally {
      await set.close()
    }
  })
})

describe('what captures.ts keeps', () => {
  it('reads the words to sum up from a note, and keeps a person’s choice only when there is one', async () => {
    assert.equal(transcriptOf('# T\n\n_line_\n\n## Transcript\n\nhello there\n\n## Notes\n\nmine\n'), 'hello there')
    assert.equal(transcriptOf('# T\n\nplain words\n'), 'plain words')
    const kv = new MemoryKV()
    await chooseHome(kv, 'team')
    assert.equal(await chosenHome(kv), 'team')
    await chooseHome(kv)
    assert.equal(await chosenHome(kv), undefined)
  })
})
