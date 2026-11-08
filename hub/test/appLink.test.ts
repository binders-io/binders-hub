import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
import { IssuesSaver } from '../src/savers/issues.ts'
import { Spaces } from '../src/spaces.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { SpaceBrain } from '../src/brain/brain.ts'
import type { BrainModel, Speaker, Transcriber } from '../src/brain/models.ts'
import { seed } from './helpers.ts'

const talk = 'so the van needs new tyres before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams'

function standInModel(): BrainModel {
  return {
    label: 'stand-in (test)',
    summarize: async () => ({ title: 'Van tyres', summary: 'They talked about the van.', points: [], decisions: [], followUps: ['Book the garage for Tuesday'] }),
    answer: async (_question, passages) => ({ text: `See ${passages[0].title}.`, parts: [{ text: `See ${passages[0].title}.`, sources: [0] }] }),
    sortMoment: async (said) => (/\?$/.test(said.trim()) ? { kind: 'question', title: said.trim() } : /^remind me to /i.test(said) ? { kind: 'todo', title: said.replace(/^remind me to /i, '') } : { kind: 'none', title: '' }),
    // What it heard, the turn before, and what it found: said back, so a test can see all three reached it.
    talk: async (turns, passages) => `You said “${turns[turns.length - 1].text}” after ${turns.length - 1} turns${passages.length ? `, and ${passages[0].title} says ${passages[0].text.split('\n').pop()}` : ''}.`,
  }
}

/** A transcription model standing in: the same two stretches, written better than the iPhone did ("tyres"). */
function standInTranscriber(heard: { mime: string; bytes: number }[] = []): Transcriber {
  return {
    label: 'stand-in transcriber (test)',
    transcribe: async (audio, mime) => {
      heard.push({ mime, bytes: audio.length })
      return { text: talk, segments: [{ start: 0.2, end: 3.8, text: 'so the van needs new tyres before the trip' }, { start: 4.1, end: 9.5, text: 'and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams' }] }
    },
  }
}

const standInSpeaker: Speaker = { label: 'stand-in voice (test)', speak: async (text) => ({ audio: Buffer.from(`spoken:${text}`), mime: 'audio/mpeg' }) }

/** A hub with a team Binder and the person's own, each with its brain, and an app token for the person. */
async function setUp(voice: { transcriber?: Transcriber; speaker?: Speaker } = {}) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  settings.useForTests(standInModel(), undefined, voice.transcriber, voice.speaker)
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const make = async (id: string, binder: { id: string; name: string }) => {
    const hub = new Hub(new MemoryLog())
    await hub.start(id === 'team' ? seed() : [{ type: 'binder.put', binder: { ...binder, createdBy: 'you' } }])
    const actions = new Actions(hub, github)
    const issues = new IssuesSaver(hub, github, { quietMs: 20 })
    const brain = new SpaceBrain({ id, hub, kv: new MemoryKV(), settings, quietMs: 10 })
    brain.start()
    return { id, hub, actions, webhooks: new Webhooks(hub, actions, issues), github, brain }
  }
  const team = await make('team', { id: 'b1', name: 'Team' })
  const own = await make('~you', { id: 'notes', name: 'Notes' })
  const spaces = Spaces.of(kv, [
    { info: { id: 'team', name: 'Team', members: [{ login: 'you', role: 'owner' }] }, space: team },
    { info: { id: '~you', name: 'you', members: [{ login: 'you', role: 'owner' }], personal: 'you' }, space: own },
  ])
  const app = await buildServer(spaces, { auth, brain: settings }, { publicUrl: 'http://hub.test' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const { token } = await auth.issuePersonToken({ login: 'you', name: 'You' } as never, 'Binders for iPhone on a test phone')
  return { team, own, settings, url, token, close: async () => { team.brain.stop(); own.brain.stop(); await app.close() } }
}

/** The iPhone's side of the link: JSON-RPC calls over the WebSocket, and the notifications it gets. */
async function link(url: string, token: string) {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/api/app/link`, { headers: { authorization: `Bearer ${token}` } })
  await new Promise<void>((done, fail) => { socket.once('open', () => done()); socket.once('error', fail) })
  let next = 1
  const waiting = new Map<number, (message: Record<string, unknown>) => void>()
  const notes: Record<string, unknown>[] = []
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as Record<string, unknown>
    if (typeof message.id === 'number') waiting.get(message.id)?.(message)
    else notes.push(message)
  })
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done) => {
    const id = next++
    waiting.set(id, done)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request('tools/call', { name, arguments: args })
    const result = reply.result as { content: { text: string }[]; isError: boolean }
    let value: unknown = result.content[0].text
    try { value = JSON.parse(result.content[0].text) } catch { /* words */ }
    return { isError: result.isError, value }
  }
  return { request, tool, notes, close: () => socket.close() }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error('timed out')
}

describe('the hub as an iPhone’s brain', () => {
  it('says hello as a Mac does, lists the person’s binders across their Binders, and runs the board in the iPhone’s shapes', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      const hello = await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [], device: 'D1' })
      const features = (hello.result as { features: string[] }).features
      for (const f of ['conversation', 'outcomes', 'askProgress', 'moment', 'suggestions', 'todosAreCards']) assert.ok(features.includes(f), f)
      assert.ok(!features.includes('manager') && !features.includes('agentSessions'), 'what the hub can’t do yet isn’t offered')
      assert.deepEqual(await phone.request('binders/subscribe').then((r) => r.result), {})

      const binders = (await phone.tool('list_binders')).value as { id: string; name: string; shared: boolean }[]
      assert.deepEqual(binders.map((b) => [b.id, b.name, b.shared]), [['team/b1', 'Team', true], ['~you/notes', 'Personal', false]])

      const made = (await phone.tool('create_task', { title: 'Paint the fence', binder: 'Team', column: 'ready', request_id: 'r1' })).value as { id: string }
      assert.match(made.id, /^team\/card-/)
      const again = (await phone.tool('create_task', { title: 'Paint the fence', binder: 'Team', column: 'ready', request_id: 'r1' })).value as { id: string }
      assert.equal(again.id, made.id, 'the outbox sending it twice makes one card')
      const tasks = (await phone.tool('list_tasks')).value as Record<string, unknown>[]
      const card = tasks.find((t) => t.id === made.id)!
      assert.deepEqual(Object.keys(card).sort(), ['assignee', 'assignee_is_agent', 'binder', 'claim_expires', 'column', 'due', 'id', 'links', 'meant_for', 'meant_for_confirmed', 'preview', 'title', 'todo', 'updated'])
      assert.equal(card.column, 'ready')
      assert.match(String(card.updated), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'no fraction of a second: the iPhone’s date reader refuses one')
      await phone.tool('update_task', { id: made.id, column: 'backlog' })
      await phone.tool('comment_task', { id: made.id, text: 'Use the green paint' })
      const detail = (await phone.tool('get_task', { id: made.id })).value as { column: string; timeline: { kind: string; who: string; text: string }[]; details: string }
      assert.equal(detail.column, 'backlog')
      assert.deepEqual(detail.timeline.map((e) => [e.kind, e.who]).at(-1), ['comment', 'You'])
      assert.equal((await phone.tool('claim_task', { id: made.id })).isError, true, 'on a hub, agents take cards')
      await until(() => phone.notes.some((n) => n.method === 'binders/changed' && (n.params as { kinds: string[] }).kinds.includes('tasks')))

      const note = (await phone.tool('add_note', { text: 'Fence colours\nGreen, or the grey.', binder: 'Team' })).value as { id: string }
      const notes = (await phone.tool('list_notes', { limit: 50, binder: 'Team' })).value as { id: string; title: string; folder: string }[]
      assert.ok(notes.some((n) => n.id === note.id && n.title === 'Fence colours'))
      const read = (await phone.tool('get_note', { id: note.id })).value as { text: string; binder: string }
      assert.match(read.text, /^# Fence colours\n\nGreen, or the grey\./)
      assert.deepEqual((await phone.tool('list_todos', { status: 'open' })).value, [])
      const folders = (await phone.tool('list_folders', { binder: 'team/b1', parent: '/' })).value as Record<string, unknown>[]
      assert.deepEqual(Object.keys(folders[0]).sort(), ['binder', 'binder_id', 'folders', 'id', 'meetings', 'name', 'notes', 'parent_id', 'path'])
      assert.equal(folders[0].binder_id, 'team/b1')
      const streams = (await phone.tool('work_streams')).value as Record<string, unknown>
      assert.deepEqual(Object.keys(streams).sort(), ['done_today', 'headline', 'questions', 'reviews', 'waiting_to_start', 'working'])
      assert.equal(streams.headline, 'Nobody working.')
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('takes a capture into the person’s own Binder, says what came of it, and offers its follow-ups as cards', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [] })
      await phone.request('binders/subscribe')
      const id = 'C0FFEE00-0000-4000-8000-000000000001'
      const segments = talk.split(' and ').map((text, i) => ({ id: `S${i}`, channel: 'microphone', start: i * 10, end: i * 10 + 9, text, speaker: i % 2 ? 'Speaker 2' : 'Speaker 1' }))
      const sent = await phone.request('binders/conversation', { id, started: '2026-11-07T10:00:00Z', ended: '2026-11-07T10:05:00Z', segments, speakers: { 'Speaker 1': 'You' }, device: 'iPhone', engine: 'parakeet' })
      assert.deepEqual(sent.result, { id })
      await until(async () => {
        const reply = await phone.request('binders/outcomes', { ids: [id] })
        return (reply.result as { outcomes: { state: string }[] }).outcomes[0]?.state === 'filed'
      })
      const outcome = ((await phone.request('binders/outcomes', { ids: [id.toLowerCase()] })).result as { outcomes: Record<string, unknown>[] }).outcomes[0]
      assert.equal(outcome.line, 'Filed in Personal: Van tyres')
      assert.equal(outcome.made, undefined, 'only the iPhone’s own keys')
      assert.ok(set.own.hub.state.notes.some((n) => n.captured === 'conversation'), 'in the person’s own Binder')
      assert.ok(!set.team.hub.state.notes.some((n) => n.captured), 'never a team’s on its own')
      const meeting = (await phone.tool('get_meeting', { id })).value as { notes: string; duration_minutes: number; attendees: string[] }
      assert.match(meeting.notes, /## Summary[\s\S]*\*\*\[00:00\] You:\*\* so the van needs new tyres/)
      assert.equal(meeting.duration_minutes, 5)
      const offered = ((await phone.request('binders/suggestions')).result as { suggestions: { id: string; kind: string; text: string; status: string }[] }).suggestions
      assert.deepEqual(offered.map((s) => [s.kind, s.text, s.status]), [['card', 'Book the garage for Tuesday', 'offered']])
      await phone.request('binders/suggestion', { id: offered[0].id, action: 'accept' })
      assert.ok(set.own.hub.state.cards.some((c) => c.title === 'Book the garage for Tuesday' && c.stage === 'ready'))
      // Sent again by the outbox: nothing new.
      await phone.request('binders/conversation', { id, started: '2026-11-07T10:00:00Z', ended: '2026-11-07T10:05:00Z', segments, speakers: {}, device: 'iPhone', engine: 'parakeet' })
      assert.equal(set.own.hub.state.notes.filter((n) => n.captured === 'conversation').length, 1)
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('acts on a moment at once, answers a question with its sources while it streams, and takes a moment back', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [] })
      const todo = (await phone.request('binders/moment', { id: 'M1', heard: '2026-11-07T10:00:00Z', text: 'remind me to call the plumber' })).result as { outcome: Record<string, unknown> }
      assert.equal(todo.outcome.state, 'acted')
      assert.equal(todo.outcome.kind, 'todo')
      assert.equal(todo.outcome.line, 'Added to Personal: call the plumber')
      const card = set.own.hub.state.cards.find((c) => c.title === 'call the plumber')!
      assert.equal(card.stage, 'proposed')
      await phone.request('binders/outcome', { id: 'M1', action: 'undo' })
      assert.ok(!set.own.hub.state.cards.some((c) => c.id === card.id), 'taken back while nobody moved it')

      await phone.tool('add_note', { text: 'Plumbing\nThe plumber comes on Thursdays.', binder: 'Personal' })
      await set.own.brain.caughtUp()
      const answer = (await phone.tool('ask_knowledge', { question: 'When does the plumber come?', progress_token: 'T1' })).value as { answer: string; sources: { kind: string; title: string; binder: string }[] }
      assert.equal(answer.answer, 'See Plumbing. [1]')
      assert.deepEqual(answer.sources.map((s) => [s.kind, s.title, s.binder]), [['note', 'Plumbing', 'Personal']])
      const progress = phone.notes.filter((n) => n.method === 'binders/ask-progress').map((n) => (n.params as { stage?: string; token: string }))
      assert.deepEqual(progress.map((p) => [p.token, p.stage]), [['T1', 'keyword'], ['T1', 'sources']])
      const asked = (await phone.request('binders/moment', { id: 'M2', heard: '2026-11-07T10:01:00Z', text: 'when does the plumber come?' })).result as { outcome: { state: string; line: string } }
      assert.equal(asked.outcome.state, 'answered')
      assert.match(asked.outcome.line, /^See Plumbing\. \[1\]\nPlumbing$/)
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('talks: answers each turn with the conversation so far and what it found, and lists Talk only with a model', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      const hello = (await phone.request('binders/hello', { name: 'Test iPhone', protocol: 1, features: [] })).result as { features: string[] }
      assert.ok(hello.features.includes('talks'))
      await phone.tool('add_note', { text: 'Plumbing\nThe plumber comes on Thursdays.', binder: 'Personal' })
      await set.own.brain.caughtUp()
      const first = (await phone.request('binders/talk', { turns: [{ role: 'user', text: 'When does the plumber come?' }], token: 'K1' })).result as { reply: string; sources: { title: string; binder: string }[] }
      assert.equal(first.reply, 'You said “When does the plumber come?” after 0 turns, and Plumbing says The plumber comes on Thursdays..')
      assert.deepEqual(first.sources.map((s) => [s.title, s.binder]), [['Plumbing', 'Personal']])
      assert.deepEqual(phone.notes.filter((n) => n.method === 'binders/ask-progress').map((n) => (n.params as { token: string; stage: string }).stage), ['sources'])
      // A short follow-up is looked for with what came before it, and the model hears the whole conversation.
      const turns = [{ role: 'assistant', text: 'Hello there.' }, { role: 'user', text: 'When does the plumber come?' }, { role: 'assistant', text: first.reply }, { role: 'user', text: 'and what time?' }]
      const second = (await phone.request('binders/talk', { turns })).result as { reply: string; sources: { title: string }[] }
      assert.match(second.reply, /^You said “and what time\?” after 2 turns, and Plumbing says/)
      // Nothing said: refused in words.
      const empty = await phone.request('binders/talk', { turns: [{ role: 'user', text: '   ' }] })
      assert.equal((empty.error as { message: string }).message, 'Say something first.')
      // Warming for Talk answers at once; capture's own warm-ups load nothing.
      assert.deepEqual((await phone.request('binders/warm', { talk: true })).result, {})
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('lets only an app’s token in', async () => {
    const set = await setUp()
    try {
      const refused = new WebSocket(`${set.url.replace('http', 'ws')}/api/app/link`)
      const status = await new Promise<number>((done) => refused.once('unexpected-response', (_req, res) => done(res.statusCode ?? 0)))
      assert.equal(status, 401)
    } finally {
      await set.close()
    }
  })

  it('writes down a conversation’s audio with its own model and the iPhone’s voices, in place of the iPhone’s transcript when that came first, and reads answers out', async () => {
    const heard: { mime: string; bytes: number }[] = []
    const set = await setUp({ transcriber: standInTranscriber(heard), speaker: standInSpeaker })
    const phone = await link(set.url, set.token)
    try {
      const hello = (await phone.request('binders/hello', { name: 'iPhone', protocol: 1 })).result as { features: string[] }
      assert.ok(hello.features.includes('transcribes') && hello.features.includes('speaks'))
      const send = (body: Buffer, described: unknown, token = set.token) => fetch(`${set.url}/api/app/audio`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mp4', 'x-binders-capture': encodeURIComponent(JSON.stringify(described)) },
        body,
      })
      const voices = { turns: [{ start: 0, end: 4, speaker: 'Speaker 1' }, { start: 4, end: 10, speaker: 'Speaker 2' }], speakers: { 'Speaker 1': 'You', 'Speaker 2': 'Sam' } }
      const outcome = async (id: string) => ((await phone.request('binders/outcomes', { ids: [id] })).result as { outcomes: { state: string; line: string }[] }).outcomes[0]

      // Audio alone: written down on the hub, voices named from the iPhone's turns, filed in the person's own Binder.
      const first = 'A1A1A1A1-0000-4000-8000-000000000001'
      // A minute of quiet between the two voices, left out of the file: Sam's turn starts 4 s into it, 64 s on the clock.
      const clock = [{ file: 0, wall: 0 }, { file: 4, wall: 64 }]
      const sent = await send(Buffer.from('fake m4a bytes'), { id: first, started: '2026-11-07T10:00:00Z', ended: '2026-11-07T10:01:10Z', device: 'iPhone', ...voices, clock })
      assert.equal(sent.status, 202)
      assert.equal((await outcome(first)).line === 'Writing it down on your hub…' || (await outcome(first)).state === 'filed', true)
      await until(async () => (await outcome(first))?.state === 'filed')
      await set.own.brain.summariesWritten()
      const filed = set.own.hub.state.notes.find((n) => n.captured === 'conversation')!
      assert.match(filed.text, /\*\*\[00:00\] You:\*\* so the van needs new tyres/)
      assert.match(filed.text, /\*\*\[01:04\] Sam:\*\* and sam said/)
      assert.deepEqual(heard[0], { mime: 'audio/mp4', bytes: 14 })

      // The iPhone's own transcript first (a word wrong), then the audio: the hub's words go in its place, summary kept.
      const second = 'B2B2B2B2-0000-4000-8000-000000000002'
      await phone.request('binders/conversation', { id: second, started: '2026-11-07T11:00:00Z', ended: '2026-11-07T11:00:10Z', device: 'iPhone', speakers: { 'Speaker 1': 'You' },
        segments: [{ start: 0, end: 9, text: 'so the van needs new tires before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams', speaker: 'Speaker 1' }] })
      await until(async () => (await outcome(second))?.state === 'filed')
      await set.own.brain.summariesWritten()
      assert.equal((await send(Buffer.from('more bytes'), { id: second, ...voices })).status, 202)
      const rewritten = () => set.own.hub.state.notes.find((n) => n.captured === 'conversation' && n.id !== filed.id)!
      await until(() => /new tyres/.test(rewritten().text))
      await set.own.brain.summariesWritten()
      assert.doesNotMatch(rewritten().text, /new tires/)
      assert.match(rewritten().text, /## Summary/)
      assert.equal(set.own.hub.state.notes.filter((n) => n.captured === 'conversation').length, 2)

      // Only an app's token, and the recording described.
      assert.equal((await send(Buffer.from('x'), { id: 'x' }, 'nope')).status, 401)
      const undescribed = await fetch(`${set.url}/api/app/audio`, { method: 'POST', headers: { authorization: `Bearer ${set.token}`, 'content-type': 'audio/mp4' }, body: Buffer.from('x') })
      assert.equal(undescribed.status, 422)

      // Answers read out, over the link and on their own.
      const spoken = (await phone.request('binders/speak', { text: 'Tomatoes along the south wall.' })).result as { audio: string; mime: string }
      assert.equal(Buffer.from(spoken.audio, 'base64').toString(), 'spoken:Tomatoes along the south wall.')
      assert.equal(spoken.mime, 'audio/mpeg')
      const plain = await fetch(`${set.url}/api/brain/speak`, { method: 'POST', headers: { authorization: `Bearer ${set.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) })
      assert.equal(plain.headers.get('content-type'), 'audio/mpeg')
      assert.equal(Buffer.from(await plain.arrayBuffer()).toString(), 'spoken:Hello')
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('says it can’t write down audio or speak without those models', async () => {
    const set = await setUp()
    const phone = await link(set.url, set.token)
    try {
      const hello = (await phone.request('binders/hello', { name: 'iPhone', protocol: 1 })).result as { features: string[] }
      assert.ok(!hello.features.includes('transcribes') && !hello.features.includes('speaks'))
      const sent = await fetch(`${set.url}/api/app/audio`, { method: 'POST', headers: { authorization: `Bearer ${set.token}`, 'content-type': 'audio/mp4', 'x-binders-capture': encodeURIComponent(JSON.stringify({ id: 'C3' })) }, body: Buffer.from('x') })
      assert.equal(sent.status, 422)
      const spoken = await phone.request('binders/speak', { text: 'Hello' })
      assert.match((spoken.error as { message: string }).message, /no speech model/)
    } finally {
      phone.close()
      await set.close()
    }
  })

  it('keeps the iPhone’s timed transcript when the hub’s model gives back words with no times', async () => {
    const untimed: Transcriber = { label: 'words only (test)', transcribe: async () => ({ text: 'so the van needs new tyres', segments: [{ start: 0, end: 0, text: 'so the van needs new tyres' }] }) }
    const set = await setUp({ transcriber: untimed })
    const phone = await link(set.url, set.token)
    try {
      const id = 'C4C4C4C4-0000-4000-8000-000000000004'
      await phone.request('binders/conversation', { id, started: '2026-11-07T12:00:00Z', ended: '2026-11-07T12:00:10Z', device: 'iPhone', speakers: { 'Speaker 1': 'You', 'Speaker 2': 'Sam' },
        segments: [{ start: 0, end: 4, text: 'so the van needs new tires before the trip', speaker: 'Speaker 1' }, { start: 4, end: 9, text: 'and sam said he would book the garage for tuesday morning and we agreed to split the cost', speaker: 'Speaker 2' }] })
      await until(async () => ((await phone.request('binders/outcomes', { ids: [id] })).result as { outcomes: { state: string }[] }).outcomes[0]?.state === 'filed')
      await set.own.brain.summariesWritten()
      const sent = await fetch(`${set.url}/api/app/audio`, { method: 'POST', headers: { authorization: `Bearer ${set.token}`, 'content-type': 'audio/mp4', 'x-binders-capture': encodeURIComponent(JSON.stringify({ id })) }, body: Buffer.from('audio') })
      assert.equal(sent.status, 202)
      await new Promise((done) => setTimeout(done, 150))
      const note = set.own.hub.state.notes.find((n) => n.captured === 'conversation')!
      assert.match(note.text, /\*\*\[00:04\] Sam:\*\* and sam said/, 'who said what, and when, as the iPhone had it')
    } finally {
      phone.close()
      await set.close()
    }
  })
})

