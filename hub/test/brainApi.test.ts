import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { SpaceBrain } from '../src/brain/brain.ts'
import type { BrainModel } from '../src/brain/models.ts'
import { oneSpace, seed } from './helpers.ts'

const talk = 'so the van needs new tyres before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams because both of them use it every week'

/** A stand-in for the hub's model: a fixed summary, and an answer resting on the first passage it's given. */
function standInModel(): BrainModel & { asked: { question: string; titles: string[] }[] } {
  const asked: { question: string; titles: string[] }[] = []
  return {
    label: 'stand-in (test)',
    asked,
    summarize: async () => ({ title: 'Van tyres', summary: 'They talked about the van’s tyres.', points: ['The tyres are worn'], decisions: ['Split the cost'], followUps: ['Sam books the garage for Tuesday'] }),
    answer: async (question, passages) => {
      asked.push({ question, titles: passages.map((p) => p.title) })
      return { text: `It’s in ${passages[0].title}.`, parts: [{ text: `It’s in ${passages[0].title}.`, sources: [0] }] }
    },
    talk: async (turns) => `You said ${turns[turns.length - 1].text}.`,
    sortMoment: async (said) => (/\?$/.test(said.trim()) ? { kind: 'question' as const, title: said.trim() } : /^remind me to /i.test(said) ? { kind: 'todo' as const, title: said.replace(/^remind me to /i, '') } : /^note /i.test(said) ? { kind: 'note' as const, title: said.replace(/^note /i, '') } : { kind: 'none' as const, title: '' }),
  }
}

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const issues = new IssuesSaver(hub, github, { quietMs: 20 })
  const webhooks = new Webhooks(hub, actions, issues)
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const model = standInModel()
  settings.useForTests(model)
  const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
  brain.start()
  const app = await buildServer(oneSpace(kv, { hub, actions, webhooks, github, brain }), { auth, brain: settings }, { publicUrl: 'http://hub.test', admins: ['boss'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { hub, kv, auth, settings, model, brain, url, close: async () => { brain.stop(); await app.close() } }
}

async function signIn(url: string, login = 'you') {
  const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
  assert.equal(response.status, 200)
  return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
}

function api(url: string, headers: Record<string, string>) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

async function mcpCall(url: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: 'test-terminal', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    return { error: !!result.isError, text: result.content[0]?.text ?? '' }
  } finally {
    await client.close()
  }
}

describe('the hub’s brain, as apps and terminals reach it', () => {
  it('puts what a phone captured in as a note in the folder for it, sums it up, and gives back the same note when it’s sent again', async () => {
    const set = await setUp()
    try {
      // The phone signs in as the Mac does, and sends with its app token.
      const { token } = await set.auth.issuePersonToken({ login: 'you', name: 'You' } as never, 'Binders for iPhone on a test phone')
      const phone = api(set.url, { authorization: `Bearer ${token}` })
      const sent = await phone('POST', '/api/captures', { kind: 'conversation', text: talk, sourceId: 'phone-capture-1', device: 'A test phone', durationSeconds: 95 })
      assert.equal(sent.status, 200)
      assert.equal(sent.body.created, true)
      assert.equal(sent.body.summarizing, true)
      assert.match(sent.body.url, /^http:\/\/hub\.test\/#\/notes\/note-cap-/)
      await set.brain.summariesWritten()
      const note = set.hub.state.notes.find((n) => n.id === sent.body.note.id)!
      assert.equal(note.title, 'Van tyres', 'a title the hub chose becomes the summary’s')
      assert.equal(note.captured, 'conversation', 'marked as heard, so no rule takes its work on without a person')
      assert.equal(note.editedBy, 'hub', 'the summary is the hub’s, not the person’s')
      assert.equal(set.hub.state.folders.find((f) => f.id === note.folderId)?.name, 'Captures')
      assert.equal(note.binderId, 'b1')
      assert.match(note.text, /## Summary\n\nThey talked about the van’s tyres\.[\s\S]*\*\*Follow-ups\*\*\n\n- Sam books the garage for Tuesday[\s\S]*## Transcript\n\nso the van needs new tyres/)
      assert.match(note.text, /_Conversation · .* · 2 min · from A test phone_/)
      // The outbox sends it again: the same note, nothing new.
      const again = await phone('POST', '/api/captures', { kind: 'conversation', text: talk, sourceId: 'phone-capture-1' })
      assert.deepEqual([again.body.created, again.body.note.id], [false, note.id])
      assert.equal(set.hub.state.notes.filter((n) => n.id.startsWith('note-cap-')).length, 1)
      // A dictation is the person’s own words: its own folder, no summary.
      const dictated = await phone('POST', '/api/captures', { kind: 'dictation', text: 'Remember to water the tomatoes.', title: 'Tomatoes' })
      assert.equal(dictated.body.summarizing, false)
      assert.equal(set.hub.state.folders.find((f) => f.id === dictated.body.note.folderId)?.name, 'Dictations')
      assert.equal((await phone('POST', '/api/captures', { kind: 'meeting', text: '   ' })).status, 422)
    } finally {
      await set.close()
    }
  })

  it('answers a question from a binder’s notes and cards, citing them, and gives the passages alone without a model', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, { cookie: await signIn(set.url), 'x-binders': '1' })
      await you('POST', '/api/captures', { kind: 'conversation', text: talk })
      await set.brain.summariesWritten()
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'card.put', card: { id: 'card-1', binderId: 'b1', title: 'Pay the garage invoice', brief: 'The garage sends an invoice after the tyres.', doneWhen: 'Paid', size: 'S', stage: 'ready', createdAt: '', createdBy: 'you', updatedAt: '', waitsFor: [], activity: [] } })
      await set.brain.caughtUp()
      const answered = await you('POST', '/api/brain/ask', { question: 'Who books the garage?' })
      assert.equal(answered.status, 200)
      assert.equal(answered.body.model, 'stand-in (test)')
      assert.equal(answered.body.searchedBy, 'words')
      assert.deepEqual(answered.body.answer.parts[0].sources, [1])
      assert.equal(answered.body.sources[0].n, 1)
      assert.ok(answered.body.sources.some((s: { kind: string; id: string; url: string }) => s.kind === 'card' && s.id === 'card-1' && s.url === 'http://hub.test/#/work/card-1'))
      assert.ok(set.model.asked[0].titles.includes('Van tyres'))
      // What ⌘K shows as someone types: the passages, and the model isn't asked.
      const before = set.model.asked.length
      const searched = await you('POST', '/api/brain/search', { query: 'garage invoice' })
      assert.equal(searched.status, 200)
      assert.equal(searched.body.answer, undefined)
      assert.equal(searched.body.sources[0].id, 'card-1')
      assert.equal(set.model.asked.length, before)
      assert.equal((await you('POST', '/api/brain/search', { query: ' ' })).status, 422)
      set.settings.useForTests(undefined)
      const bare = await you('POST', '/api/brain/ask', { question: 'garage invoice' })
      assert.equal(bare.body.answer, undefined)
      assert.equal(bare.body.sources[0].id, 'card-1')
      assert.equal((await you('POST', '/api/brain/ask', { question: ' ' })).status, 422)
    } finally {
      await set.close()
    }
  })

  it('lets only the hub’s admins set it up, seals its keys, and shows the rest only what answers', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, { cookie: await signIn(set.url), 'x-binders': '1' })
      const boss = api(set.url, { cookie: await signIn(set.url, 'boss'), 'x-binders': '1' })
      assert.equal((await you('PATCH', '/api/brain', { provider: 'anthropic' })).status, 422)
      const made = await boss('PATCH', '/api/brain', { provider: 'anthropic', apiKey: 'sk-test-not-a-real-key' })
      assert.equal(made.status, 200)
      assert.equal(made.body.brain.apiKeySet, true)
      assert.equal(made.body.brain.inUse, 'claude-opus-5-5 (Anthropic)')
      assert.ok(!JSON.stringify(made.body).includes('sk-test-not-a-real-key'))
      assert.ok(!(await set.kv.get('brain'))!.includes('sk-test-not-a-real-key'), 'kept sealed')
      await set.brain.caughtUp()
      const seen = await you('GET', '/api/brain')
      // What answers, and whether it all stays on the hub's own network: never where the models are or how they're reached.
      assert.deepEqual(Object.keys(seen.body.brain).sort(), ['first', 'inUse', 'localOnly', 'provider', 'summarize'])
      assert.equal(seen.body.index.sources >= 1, true)
      const chosen = await boss('PATCH', '/api/brain', { provider: 'openai' })
      assert.equal(chosen.body.brain.needs, 'The address of the server.')
      assert.equal(chosen.body.brain.apiKeySet, false, 'the key saved for Claude doesn’t follow to another server')
      const local = await boss('PATCH', '/api/brain', { provider: 'openai', baseUrl: 'http://localhost:11434/v1/', model: 'qwen3', embeddingsBaseUrl: 'http://localhost:11434/v1', embeddingsModel: 'nomic-embed-text', apiKey: '' })
      assert.equal(local.body.brain.baseUrl, 'http://localhost:11434/v1')
      assert.equal(local.body.brain.apiKeySet, false, 'an empty key clears it')
      assert.equal(local.body.brain.embeddingsInUse, 'nomic-embed-text (localhost:11434)')
      assert.match((await boss('PATCH', '/api/brain', { baseUrl: 'http://name:pass@localhost/v1' })).body.error, /no name or password/)
    } finally {
      await set.close()
    }
  })

  it('leaves a title a person gave, a folder they renamed or moved, and forgets a note deleted before a restart', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, { cookie: await signIn(set.url), 'x-binders': '1' })
      // A summary that waits, while the person renames the note.
      let release: () => void = () => {}
      const held = new Promise<void>((done) => { release = done })
      const model = standInModel()
      set.settings.useForTests({ ...model, summarize: async (capture) => { await held; return model.summarize(capture) } })
      const sent = await you('POST', '/api/captures', { kind: 'conversation', text: talk })
      const id = sent.body.note.id as string
      const note = () => set.hub.state.notes.find((n) => n.id === id)!
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'note.edit', id, text: note().text.replace(/^# .*/, '# Q3 planning'), title: 'Q3 planning', by: 'you', at: new Date().toISOString() })
      release()
      await set.brain.summariesWritten()
      assert.equal(note().title, 'Q3 planning')
      assert.match(note().text, /^# Q3 planning\n[\s\S]*## Summary/)
      // The person renames Captures and puts it inside another folder: the next capture goes there, as they left it.
      const folder = set.hub.state.folders.find((f) => f.id === note().folderId)!
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'folder.put', folder: { id: 'f-2026', binderId: 'b1', name: '2026' } })
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'folder.put', folder: { ...folder, name: 'Heard', parentId: 'f-2026' } })
      const next = await you('POST', '/api/captures', { kind: 'conversation', text: `${talk} again` })
      assert.equal(next.body.note.folderId, folder.id)
      assert.deepEqual([set.hub.state.folders.find((f) => f.id === folder.id)?.name, set.hub.state.folders.find((f) => f.id === folder.id)?.parentId], ['Heard', 'f-2026'])
      // Indexed, then deleted, and the hub stops before the brain hears of it: started again, it's gone from the index.
      await set.brain.caughtUp()
      assert.ok((await set.brain.index.keys()).includes(`note:${id}`))
      set.brain.stop()
      await set.hub.record({ kind: 'user', login: 'you' }, { type: 'note.delete', id })
      const { SpaceBrain } = await import('../src/brain/brain.ts')
      const again = new SpaceBrain({ id: 'test', hub: set.hub, kv: set.kv, settings: set.settings, quietMs: 10 })
      again.start()
      await new Promise((done) => setTimeout(done, 30))
      await again.caughtUp()
      assert.ok(!(await again.index.keys()).includes(`note:${id}`))
      again.stop()
    } finally {
      await set.close()
    }
  })

  it('answers and takes captures in a person’s own terminal over MCP', async () => {
    const set = await setUp()
    try {
      const you = api(set.url, { cookie: await signIn(set.url), 'x-binders': '1' })
      const token = (await you('POST', '/api/tokens', { app: 'A terminal' })).body.token as string
      const captured = await mcpCall(set.url, token, 'capture', { binder: 'b1', kind: 'meeting', text: talk, title: 'Weekly sync' })
      assert.equal(captured.error, false)
      await set.brain.summariesWritten()
      const made = JSON.parse(captured.text) as { note: string; summarizing: boolean }
      const note = set.hub.state.notes.find((n) => n.id === made.note)!
      assert.equal(note.title, 'Weekly sync', 'a title given is kept')
      assert.equal(set.hub.state.folders.find((f) => f.id === note.folderId)?.name, 'Meetings')
      assert.match(note.text, /## Summary/)
      await set.brain.caughtUp()
      const answer = await mcpCall(set.url, token, 'ask', { question: 'garage tyres' })
      assert.equal(answer.error, false)
      assert.match(answer.text, /^It’s in Weekly sync\. \[1\]\n\nSources:\n\[1\] Note “Weekly sync” in Test/)
      assert.match((await mcpCall(set.url, token, 'capture', { binder: 'nowhere', kind: 'dictation', text: 'x' })).text, /No binder nowhere/)
    } finally {
      await set.close()
    }
  })
})
