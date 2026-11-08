import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import { BrainMachines } from '../src/brain/machines.ts'
import { SpaceBrain } from '../src/brain/brain.ts'
import { BrainUnavailable } from '../src/brain/models.ts'
import { bestPicks, candidates, offers } from '../src/brain/autoPick.ts'
import { runnerVersion } from '../../shared/agents.ts'
import { joinMachine, serve } from '../../runner/src/brain.ts'
import { oneSpace, seed } from './helpers.ts'

/** A model server standing in for one on the machine: OpenAI's chat, embeddings and transcription APIs, fixed answers. */
async function modelServer(models = ['qwen3:14b', 'whisper-large-v3']) {
  const seen: { path: string; type: string; size: number; host?: string }[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ path: request.url ?? '', type: String(request.headers['content-type'] ?? ''), size: body.length, host: request.headers.host })
      const json = (value: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (request.url === '/v1/models') return json({ data: models.map((id) => ({ id, owned_by: 'library' })) })
      if (request.url === '/v1/chat/completions') return json({ choices: [{ message: { content: '{"title":"Van tyres","summary":"Tyres before the trip.","points":[],"decisions":["Split the cost"],"followUps":["Book the garage"]}' } }] })
      if (request.url === '/v1/audio/transcriptions') return json({ text: 'Book the garage.', segments: [{ start: 0, end: 1.5, text: 'Book the garage.' }] })
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { url, seen, close: () => new Promise<void>((done) => server.close(() => done())) }
}

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const webhooks = new Webhooks(hub, actions, new IssuesSaver(hub, github, { quietMs: 20 }))
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const machines = await new BrainMachines(kv).load()
  settings.useMachines(machines)
  const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
  brain.start()
  const app = await buildServer(oneSpace(kv, { hub, actions, webhooks, github, brain }), { auth, brain: settings, machines }, { publicUrl: 'http://hub.test', admins: ['boss'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { settings, machines, url, close: async () => { brain.stop(); machines.closeAll(); await app.close() } }
}

async function signIn(url: string, login: string) {
  const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
  return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
}

function api(url: string, cookie: string) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error('timed out')
}

describe('machines of yours serving the brain’s models', () => {
  it('adds a machine, links its daemon, and sums up, writes down and finds through the servers on it, and nothing else', async () => {
    const set = await setUp()
    const models = await modelServer()
    const stop = new AbortController()
    try {
      const boss = api(set.url, await signIn(set.url, 'boss'))
      const you = api(set.url, await signIn(set.url, 'you'))
      assert.equal((await you('POST', '/api/brain/machines', { name: 'Spark 1' })).status, 422, 'an admin’s to add')
      const added = await boss('POST', '/api/brain/machines', { name: 'Spark 1' })
      assert.equal(added.status, 200)
      assert.match(added.body.token, /^bnw_/)
      assert.equal(added.body.install, `curl -fsSL http://hub.test/install | sh -s -- add --token ${added.body.token}`)
      const id = added.body.machine.id as string
      // binders add asks who the token is.
      const me = await fetch(`${set.url}/api/brain/machine/me`, { headers: { authorization: `Bearer ${added.body.token}` } })
      assert.deepEqual(await me.json(), { id, name: 'Spark 1' })
      assert.equal((await fetch(`${set.url}/api/brain/machine/me`, { headers: { authorization: 'Bearer bnw_nope' } })).status, 401)

      // The daemon, as binders add runs it: it finds the server it was told of, and links.
      const lines: string[] = []
      // Only the server it's told of: the port scan is the daemon's own test's (the suite's other servers listen here too).
      void serve({ hub: set.url, token: added.body.token, extra: [models.url], only: true, signal: stop.signal, log: (line) => lines.push(line) })
      await until(async () => (await boss('GET', '/api/brain/machines')).body.machines[0]?.online === true)
      const listed = (await boss('GET', '/api/brain/machines')).body.machines[0]
      assert.deepEqual(listed.servers.find((s: { url: string }) => s.url === models.url)?.models, ['qwen3:14b', 'whisper-large-v3'])
      assert.equal((await you('GET', '/api/brain/machines')).status, 422)

      // The hub's model on it: summed up through the machine, by the server there.
      const chosen = await boss('PATCH', '/api/brain', { provider: 'machine', machine: id, baseUrl: models.url, model: 'qwen3:14b' })
      assert.equal(chosen.body.brain.inUse, 'qwen3:14b on Spark 1')
      const summary = await set.settings.model()!.summarize({ kind: 'conversation', text: 'we need new tyres before the trip' })
      assert.deepEqual([summary.title, summary.followUps], ['Van tyres', ['Book the garage']])
      assert.ok(models.seen.some((s) => s.path === '/v1/chat/completions'))

      // Writing down audio on it too: the recording goes through as it is.
      const written = await boss('PATCH', '/api/brain', { transcriptionMachine: id, transcriptionBaseUrl: models.url, transcriptionModel: 'whisper-large-v3' })
      assert.equal(written.body.brain.transcriptionInUse, 'whisper-large-v3 on Spark 1')
      const heard = await set.settings.transcriber()!.transcribe(new Uint8Array(4096), 'audio/mp4')
      assert.deepEqual(heard.segments.map((s) => s.text), ['Book the garage.'])
      assert.match(models.seen.at(-1)!.type, /^multipart\/form-data/)
      assert.ok(models.seen.at(-1)!.size > 4096)
      // Local AI only: a job on your machine is on your network by being there.
      assert.equal((await boss('PATCH', '/api/brain', { localOnly: true })).body.brain.inUse, 'qwen3:14b on Spark 1')

      // Only the servers it found: an address the hub names that isn't one of them isn't reached through it.
      await boss('PATCH', '/api/brain', { baseUrl: 'http://127.0.0.1:9/v1' })
      await assert.rejects(set.settings.model()!.summarize({ kind: 'conversation', text: 'x' }), (err: Error) => err instanceof BrainUnavailable && /isn’t one of the servers on this machine/.test(err.message))
      await boss('PATCH', '/api/brain', { baseUrl: models.url })

      // Away: said plainly.
      stop.abort()
      await until(async () => (await boss('GET', '/api/brain/machines')).body.machines[0]?.online === false)
      await assert.rejects(set.settings.model()!.summarize({ kind: 'conversation', text: 'x' }), /Spark 1 isn’t linked to the hub right now/)

      // Removed: its token stops, and what it served says it needs a machine.
      assert.equal((await boss('DELETE', `/api/brain/machines/${id}`)).status, 200)
      assert.equal(await set.machines.who(added.body.token), undefined)
      const after = (await boss('GET', '/api/brain')).body.brain
      assert.equal(after.needs, 'That machine was removed from the hub.')
      assert.equal(after.transcriptionNeeds, 'That machine was removed from the hub.')
      assert.ok(lines.some((l) => l.startsWith('Serving openai at')), lines.join('\n'))
    } finally {
      stop.abort()
      await models.close()
      await set.close()
    }
  })

  it('reads answers out with a Mac’s own voices through its daemon', async () => {
    const set = await setUp()
    try {
      const { machine, token } = await set.machines.add('boss', 'Studio Mac')
      // A daemon standing in: a Mac's voices, and what it sends back for words read out.
      const { WebSocket } = await import('ws')
      const socket = new WebSocket(`${set.url.replace('http', 'ws')}/api/brain/machine`)
      const said: { voice?: string; text?: string }[] = []
      socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token, servers: [{ url: 'say:', kind: 'say', models: ['Samantha', 'Daniel'] }] })))
      let latest = ''
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; id: string; voice?: string; text?: string; latest?: string }
        if (message.type === 'welcome') latest = message.latest ?? ''
        if (message.type !== 'say') return
        said.push({ voice: message.voice, text: message.text })
        socket.send(JSON.stringify({ type: 'reply', id: message.id, ok: true, status: 200, headers: { 'content-type': 'audio/wav' }, body: Buffer.from('RIFF-ish').toString('base64') }))
      })
      await until(() => set.machines.get(machine.id)?.online === true && latest !== '')
      assert.equal(latest, runnerVersion, 'the daemon this hub hands out, for an older one to take its place')
      const view = await set.settings.set({ speechMachine: machine.id, speechBaseUrl: 'say:', speechVoice: 'Samantha' })
      assert.equal(view.speechInUse, 'Samantha on Studio Mac')
      const spoken = await set.settings.speaker()!.speak('Tomatoes along the south wall.')
      assert.deepEqual([spoken.mime, spoken.audio.toString()], ['audio/wav', 'RIFF-ish'])
      assert.deepEqual(said, [{ voice: 'Samantha', text: 'Tomatoes along the south wall.' }])
      // macOS's voices are a machine's: never an address the hub reaches itself.
      assert.equal((await set.settings.set({ speechMachine: '' })).speechNeeds, 'macOS’s voices are reached through one of your machines.')
      socket.close()
    } finally {
      await set.close()
    }
  })

  it('takes machines with one line, names them by their hosts, and chooses their models for every job no one set', async () => {
    const set = await setUp()
    const spark = await modelServer(['llama-3.3-70b-instruct', 'nomic-embed-text', 'whisper-large-v3', 'kokoro'])
    const mac = await modelServer(['qwen3:235b-a22b'])
    const stops = [new AbortController(), new AbortController()]
    try {
      const boss = api(set.url, await signIn(set.url, 'boss'))
      const command = await boss('POST', '/api/brain/machines/command', {})
      const join = /--token (bnj_\S+)$/.exec(command.body.install)![1]
      assert.match(command.body.install, /^curl -fsSL http:\/\/hub\.test\/install \| sh -s -- add --token bnj_/)

      // The line, run on a Spark: it joins under its host's name, links, and the hub takes its models.
      const first = await joinMachine(set.url, join, 'spark-1.local')
      assert.equal(first.name, 'spark-1')
      void serve({ hub: set.url, token: first.token, extra: [spark.url], only: true, host: 'spark-1.local', signal: stops[0].signal, log: () => {} })
      await until(() => set.settings.get().autoJobs.length === 4)
      const view = set.settings.view()
      assert.deepEqual([view.inUse, view.embeddingsInUse, view.transcriptionInUse, view.speechInUse], ['llama-3.3-70b-instruct on spark-1', 'nomic-embed-text on spark-1', 'whisper-large-v3 on spark-1', 'kokoro, af_heart on spark-1'])

      // The same line on a Mac with a bigger model: chat moves there, the rest stays where it's better.
      const second = await joinMachine(set.url, join, 'studio-mac')
      void serve({ hub: set.url, token: second.token, extra: [mac.url], only: true, host: 'studio-mac', signal: stops[1].signal, log: () => {} })
      await until(() => set.settings.view().inUse === 'qwen3:235b-a22b on studio-mac')
      assert.equal(set.settings.view().embeddingsInUse, 'nomic-embed-text on spark-1')

      // A job you set is yours: never chosen for you again, until you hand it back.
      await boss('PATCH', '/api/brain', { transcriptionMachine: '', transcriptionBaseUrl: '', transcriptionModel: '' })
      assert.equal(set.settings.view().transcriptionInUse, undefined)
      await set.settings.autoPick(set.machines.list())
      assert.equal(set.settings.view().transcriptionInUse, undefined)
      const back = await boss('POST', '/api/brain/choose', { jobs: ['transcription'] })
      assert.equal(back.body.brain.transcriptionInUse, 'whisper-large-v3 on spark-1')
      assert.ok(back.body.brain.autoJobs.includes('transcription'))

      // Turning the brain off is a choice too.
      await boss('PATCH', '/api/brain', { provider: 'off' })
      await set.settings.autoPick(set.machines.list())
      assert.equal(set.settings.get().provider, 'off')
      await boss('POST', '/api/brain/choose', { jobs: ['chat'] })
      assert.equal(set.settings.view().inUse, 'qwen3:235b-a22b on studio-mac')

      // The Mac removed: chat goes back to the Spark's best.
      const macId = set.machines.list().find((m) => m.name === 'studio-mac')!.id
      await boss('DELETE', `/api/brain/machines/${macId}`)
      await until(() => set.settings.view().inUse === 'llama-3.3-70b-instruct on spark-1')

      // The line once more on the Spark: the same machine, a fresh token, the old one stopped.
      const again = await joinMachine(set.url, join, 'spark-1.local')
      assert.equal(again.id, first.id)
      assert.equal(await set.machines.who(first.token), undefined)
      await assert.rejects(joinMachine(set.url, 'bnj_not-a-command', 'x'), /run out or was replaced/)
    } finally {
      for (const stop of stops) stop.abort()
      await spark.close()
      await mac.close()
      await set.close()
    }
  })

  it('offers a model sized to the machine for each job none can do: one download for two jobs, once', () => {
    const ollama = (version = '0.40.13') => [{ url: 'http://127.0.0.1:11434/v1', kind: 'ollama', version, models: ['qwen3:8b'] }]
    const spark = { id: 'm-spark', name: 'spark-1', addedBy: 'boss', addedAt: '', online: true, platform: 'linux arm64', facts: { memoryGb: 128 }, servers: ollama() }
    const mac = { id: 'm-mac', name: 'studio-mac', addedBy: 'boss', addedAt: '', online: true, platform: 'darwin arm64', facts: { memoryGb: 36 }, servers: ollama() }
    // The Spark's chat model is bigger than what's there: chat has a pick, so it's not offered.
    assert.deepEqual(offers([spark], ['embeddings', 'transcription', 'speech']), [
      { action: 'pull', source: 'ollama', jobs: ['embeddings'], machine: 'm-spark', model: 'embeddinggemma', size: 'about 620 MB' },
      { action: 'pull', source: 'ollama', jobs: ['transcription', 'speech'], machine: 'm-spark', model: 'lfm3-audio:2b', size: 'about 2 GB' },
    ])
    // Nothing for chat at all: sized to the machine with the most memory.
    const empty = { ...spark, servers: [{ ...ollama()[0], models: ['nomic-embed-text'] }] }
    assert.equal(offers([empty], ['chat'])[0].model, 'gpt-oss:120b')
    assert.equal(offers([{ ...empty, facts: { memoryGb: 36 } }], ['chat'])[0].model, 'gpt-oss:20b')
    // A Mac's own voice, where its Ollama can run it; an older Ollama gets the audio model.
    assert.deepEqual(offers([spark, mac], ['speech']).map((o) => [o.machine, o.model]), [['m-mac', 'phonon:en']])
    assert.deepEqual(offers([{ ...mac, servers: ollama('0.40.2') }], ['speech']).map((o) => o.model), ['lfm3-audio:2b'])
    // No Ollama anywhere: nothing to offer.
    assert.deepEqual(offers([{ ...spark, servers: [{ url: 'http://127.0.0.1:8000/v1', kind: 'vllm', models: [] }] }], ['embeddings']), [])
  })

  it('downloads a model it offered into a machine’s Ollama, and uses it once it’s there', async () => {
    const set = await setUp()
    const models = ['llama-3.3-70b-instruct']
    const ollama: Server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        if (request.url === '/api/version') return response.end(JSON.stringify({ version: '0.40.13' }))
        if (request.url === '/v1/models') return response.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
        if (request.url === '/api/pull') {
          response.write('{"status":"downloading","total":1000,"completed":500}\n')
          return setTimeout(() => {
            models.push('embeddinggemma')
            response.end('{"status":"success"}\n')
          }, 30)
        }
        response.end('{}')
      })
    })
    await new Promise<void>((done) => ollama.listen(0, '127.0.0.1', done))
    const stop = new AbortController()
    try {
      const boss = api(set.url, await signIn(set.url, 'boss'))
      const { token } = await set.machines.add('boss', 'spark-1', 'spark-1')
      void serve({ hub: set.url, token, extra: [`http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`], only: true, host: 'spark-1', signal: stop.signal, log: () => {} })
      await until(() => set.settings.get().autoJobs.includes('chat'))
      const listed = await boss('GET', '/api/brain/machines')
      const offer = listed.body.offers.find((o: { jobs: string[] }) => o.jobs.includes('embeddings'))
      assert.deepEqual([offer.model, offer.machine], ['embeddinggemma', listed.body.machines[0].id])
      assert.equal(listed.body.machines[0].facts.memoryGb > 0, true)
      const started = await boss('POST', `/api/brain/machines/${offer.machine}/pull`, { model: 'embeddinggemma', job: 'embeddings' })
      assert.equal(started.status, 200)
      await until(() => set.settings.view().embeddingsInUse === 'embeddinggemma on spark-1')
      const after = await boss('GET', '/api/brain/machines')
      assert.equal(after.body.machines[0].downloads[0].done, true)
      assert.ok(!after.body.offers.some((o: { jobs: string[] }) => o.jobs.includes('embeddings')), 'no longer offered')
      assert.equal((await boss('POST', `/api/brain/machines/${offer.machine}/pull`, { model: 'x; rm -rf ~', job: 'chat' })).status, 422)
    } finally {
      stop.abort()
      await new Promise<void>((done) => ollama.close(() => done()))
      await set.close()
    }
  })

  it('lists every model each job can be done with, best first, leaving out helpers that aren’t voices', () => {
    const mac = { id: 'm-mac', name: 'Mac.helfei.com', addedBy: 'boss', addedAt: '', online: true, platform: 'darwin arm64', facts: { memoryGb: 64 }, runtimes: ['hf'],
      running: [{ engine: 'mlx-audio' }],
      servers: [{ url: 'say:', kind: 'say', models: ['Karen', 'Samantha'] }, { url: 'http://models.binders/v1', kind: 'binders', models: ['beshkenadze/kitten-tts-g2p', 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', 'mlx-community/Kokoro-82M-bf16'] }] }
    const all = candidates([mac])
    assert.deepEqual(all.speech.map((c) => [c.model || c.voice, c.state]), [
      ['mlx-community/Kokoro-82M-bf16', 'on-demand'], ['mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', 'on-demand'], ['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', 'on-demand'], ['Samantha', 'voice'],
    ])
    assert.equal(all.speech[0].machineName, 'Mac.helfei.com')
    assert.equal(bestPicks([mac]).speech?.model, 'mlx-community/Kokoro-82M-bf16')
    // Nothing to write down with: Parakeet from Hugging Face, on a Mac with a way to download it.
    assert.deepEqual(offers([mac], ['transcription']).map((o) => [o.action, o.source, o.model]), [['pull', 'hf', 'mlx-community/parakeet-tdt-0.6b-v3']])
  })

  it('starts a runtime on a machine to serve what’s on it, and uses it once it serves', async () => {
    const set = await setUp()
    try {
      const boss = api(set.url, await signIn(set.url, 'boss'))
      const { machine, token } = await set.machines.add('boss', 'studio-mac', 'studio-mac')
      const { WebSocket } = await import('ws')
      const socket = new WebSocket(`${set.url.replace('http', 'ws')}/api/brain/machine`)
      const asked: string[] = []
      const tts = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'
      socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token, platform: 'darwin arm64', servers: [], runtimes: ['mlx-audio', 'hf'], onDisk: [{ name: tts, source: 'hf' }] })))
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; id: string; runtime?: string }
        if (message.type !== 'serve') return
        asked.push(message.runtime!)
        socket.send(JSON.stringify({ type: 'progress', id: message.id, status: 'starting mlx-audio', completed: 0, total: 0 }))
        socket.send(JSON.stringify({ type: 'servers', servers: [{ url: 'http://127.0.0.1:8939/v1', kind: 'mlx-audio', models: [tts] }] }))
        socket.send(JSON.stringify({ type: 'reply', id: message.id, ok: true }))
      })
      await until(() => set.machines.get(machine.id)?.online === true)
      assert.equal((await boss('POST', `/api/brain/machines/${machine.id}/serve`, { runtime: 'mlx-audio', job: 'speech' })).status, 200)
      await until(() => set.settings.view().speechInUse === `${tts} on studio-mac`)
      assert.deepEqual(asked, ['mlx-audio'])
      assert.equal((await boss('POST', `/api/brain/machines/${machine.id}/serve`, { runtime: 'lmstudio', job: 'chat' })).status, 422, 'only what it can run')
      socket.close()
    } finally {
      await set.close()
    }
  })

  it('ranks a big model with no size in its name, on a Spark’s own server, above a smaller one named with its size', () => {
    const spark = { id: 'm-spark', name: 'spark-4793', addedBy: 'boss', addedAt: '', online: true, platform: 'linux arm64', facts: { memoryGb: 128 }, servers: [{ url: 'http://127.0.0.1:8090/v1', kind: 'openai', models: ['GLM-5.3'] }] }
    const mac = { id: 'm-mac', name: 'helders-macbook-pro', addedBy: 'boss', addedAt: '', online: true, platform: 'darwin arm64', facts: { memoryGb: 64 }, servers: [{ url: 'http://127.0.0.1:11434/v1', kind: 'ollama', models: ['gemma4:26b', 'llama3.2:latest'] }] }
    assert.deepEqual([bestPicks([mac, spark]).chat?.machine, bestPicks([mac, spark]).chat?.model], ['m-spark', 'GLM-5.3'])
    assert.equal(bestPicks([mac]).chat?.model, 'gemma4:26b', 'an Ollama model with no size counts as small')
  })

  it('takes a voice downloaded on a Mac over its own voices, with no offer to make', () => {
    const mac = { id: 'm-mac', name: 'helders-macbook-pro', addedBy: 'boss', addedAt: '', online: true, platform: 'darwin arm64', facts: { memoryGb: 64 },
      servers: [{ url: 'say:', kind: 'say', models: ['Samantha'] }, { url: 'http://models.binders/v1', kind: 'binders', models: ['hexgrad/Kokoro-82M'] }] }
    assert.equal(bestPicks([mac]).speech?.model, 'hexgrad/Kokoro-82M')
    assert.deepEqual(offers([mac], ['speech']), [])
  })

  it('chooses from a machine’s downloaded models, loaded when asked, as from any server: by each model’s own size', () => {
    const mac = { id: 'm-mac', name: 'studio-mac', addedBy: 'boss', addedAt: '', online: true, platform: 'darwin arm64', facts: { memoryGb: 64 },
      servers: [{ url: 'say:', kind: 'say', models: ['Samantha'] }, { url: 'http://models.binders/v1', kind: 'binders', models: ['mlx-community/Qwen3-8B-4bit', 'mlx-community/Qwen3-32B-4bit', 'mlx-community/Kokoro-82M-bf16', 'mlx-community/parakeet-tdt-0.6b-v3'] }] }
    const picks = bestPicks([mac])
    assert.deepEqual([picks.chat?.model, picks.speech?.model, picks.transcription?.model], ['mlx-community/Qwen3-32B-4bit', 'mlx-community/Kokoro-82M-bf16', 'mlx-community/parakeet-tdt-0.6b-v3'])
    // A Spark's GLM in TensorFold, with no size in its name, still outranks a Mac's 32B on disk.
    const spark = { id: 'm-spark', name: 'spark-4793', addedBy: 'boss', addedAt: '', online: true, platform: 'linux arm64', facts: { memoryGb: 128 }, servers: [{ url: 'http://127.0.0.1:8090/v1', kind: 'openai', models: ['GLM-5.3'] }] }
    assert.equal(bestPicks([mac, spark]).chat?.model, 'GLM-5.3')
  })
})

