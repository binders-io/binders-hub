import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { detect, hfCache, isAudio, mlxAudioCommand, nearby, onDisk, probe, pull, relay, repoOf, say, voiceNames } from '../src/brain.ts'
import { mkdtemp, mkdir as makeDir, writeFile as write } from 'node:fs/promises'
import { tmpdir as tempDir } from 'node:os'
import { join as joinPath } from 'node:path'
import { plistFor, unitFor } from '../src/daemon.ts'

describe('the brain daemon', () => {
  const closers: (() => Promise<void>)[] = []
  after(async () => { for (const close of closers) await close() })

  /** A model server standing in, on this machine: what it was sent, and fixed answers. */
  async function standIn() {
    const seen: { method: string; path: string; headers: Record<string, unknown>; body: string }[] = []
    const server: Server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        seen.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body })
        if (request.url === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' })
          return response.end(JSON.stringify({ data: [{ id: 'meta/llama-3.1-8b', owned_by: 'vllm' }] }))
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ echoed: body }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    closers.push(() => new Promise<void>((done) => server.close(() => done())))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen }
  }

  it('serves only what is on this machine or its own network', () => {
    for (const near of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://spark-1:8000/v1', 'http://192.168.1.40:8000/v1', 'http://100.64.0.7:8000', 'http://spark.local:8000', 'http://[::1]:8000']) assert.ok(nearby(near), near)
    for (const far of ['https://api.openai.com/v1', 'http://8.8.8.8/v1', 'file:///etc/passwd', 'say:', 'not a url']) assert.ok(!nearby(far), far)
  })

  it('finds a server and what it is, and reads macOS’s voices from say’s list', async () => {
    const server = await standIn()
    assert.deepEqual(await probe(server.url, 'openai'), { url: server.url, kind: 'vllm', models: ['meta/llama-3.1-8b'] })
    assert.equal(await probe('http://127.0.0.1:9/v1', 'openai', 300), undefined)
    const found = await detect([`${server.url}/`])
    assert.ok(found.some((s) => s.url === server.url), 'the one it was told of, without its slash')
    assert.deepEqual(voiceNames('Albert              en_US    # Hello! My name is Albert.\nAmélie              fr_CA    # Bonjour !\nGood News           en_US    # Hello!\nnonsense\n'), ['Albert', 'Amélie', 'Good News'])
  })

  it('passes on a request to a server it found, as it came, and nothing to anywhere else', async () => {
    const server = await standIn()
    const servers = [{ url: server.url, kind: 'vllm', models: ['m'] }]
    const reply = await relay({ id: '1', method: 'POST', url: `${server.url}/chat/completions`, headers: { 'content-type': 'application/json', host: 'hub.test', authorization: 'Bearer local' }, body: Buffer.from('{"model":"m"}').toString('base64') }, servers)
    assert.equal(reply.ok, true)
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(Buffer.from(reply.body!, 'base64').toString()), { echoed: '{"model":"m"}' })
    const sent = server.seen.at(-1)!
    assert.equal(sent.headers.authorization, 'Bearer local')
    assert.notEqual(sent.headers.host, 'hub.test', 'the connection’s own headers aren’t passed on')
    const elsewhere = ['https://api.openai.com/v1/chat/completions', `${server.url.replace(/\d+\/v1$/, '1/v1')}/chat/completions`, `${server.url}evil/chat`, 'http://169.254.169.254/latest/meta-data']
    for (const url of elsewhere) {
      const refused = await relay({ id: '2', method: 'POST', url, headers: {}, body: '' }, servers)
      assert.deepEqual([refused.ok, refused.error], [false, 'that address isn’t one of the servers on this machine'], url)
    }
    assert.equal((await relay({ id: '3', method: 'DELETE', url: `${server.url}/models`, headers: {} }, servers)).ok, false)
  })

  it('reads out only with a voice the Mac has', async () => {
    const servers = [{ url: 'say:', kind: 'say', models: ['Samantha'] }]
    assert.deepEqual(await say({ id: '1', text: 'Hi', voice: '-o/tmp/x' }, servers), { type: 'reply', id: '1', ok: false, error: 'this Mac has no voice called -o/tmp/x' })
    assert.equal((await say({ id: '2', text: 'Hi' }, [])).error, 'this machine has no macOS voices')
    assert.equal((await say({ id: '3', text: '   ', voice: 'Samantha' }, servers)).error, 'nothing to say')
  })

  it('runs as a service of its own: binders-runner brain, with its token in a file and the servers it was told of', () => {
    const saved = { name: 'spark-1', agent: 'Spark 1', hub: 'https://hub.test', workspace: '/home/me', addedAt: '', kind: 'brain' as const, serve: ['http://127.0.0.1:9000/v1'] }
    const unit = unitFor(saved)
    assert.match(unit, /binders-runner\.mjs brain --hub https:\/\/hub\.test --token-file \S+spark-1\.token --name spark-1 --serve http:\/\/127\.0\.0\.1:9000\/v1/)
    assert.doesNotMatch(unit, /--workspace/)
    assert.match(plistFor(saved), /<string>brain<\/string>/)
  })

  it('knows Ollama by its version, and downloads into it as the hub asks, saying how far it has got', async () => {
    const pulled: string[] = []
    const server: Server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        if (request.url === '/api/version') return response.end(JSON.stringify({ version: '0.40.13' }))
        if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'gemma4:26b' }] }))
        if (request.url === '/api/pull') {
          pulled.push(JSON.parse(body).model)
          response.writeHead(200, { 'content-type': 'application/x-ndjson' })
          response.write('{"status":"pulling manifest"}\n{"status":"downloading","total":100,"completed":40}\n')
          return setTimeout(() => response.end('{"status":"downloading","total":100,"completed":100}\n{"status":"success"}\n'), 20)
        }
        response.writeHead(404)
        response.end()
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    closers.push(() => new Promise<void>((done) => server.close(() => done())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    const ollama = await probe(url, 'openai')
    assert.deepEqual(ollama, { url, kind: 'ollama', models: ['gemma4:26b'], version: '0.40.13' })
    const steps: [string, number, number][] = []
    const done = await pull({ id: 'p1', model: 'embeddinggemma' }, [ollama!], (status, completed, total) => steps.push([status, completed, total]))
    assert.deepEqual([done.ok, pulled], [true, ['embeddinggemma']])
    assert.deepEqual(steps.at(-1), ['success', 0, 0])
    assert.ok(steps.some(([status]) => status === 'pulling manifest'))
    // Only a model's name, and only into an Ollama it found.
    assert.equal((await pull({ id: 'p2', model: 'x; rm -rf ~' }, [ollama!], () => {})).ok, false)
    assert.equal((await pull({ id: 'p3', model: 'qwen3:8b' }, [{ url, kind: 'vllm', models: [] }], () => {})).error, 'this machine has no Ollama to download into')
  })

  it('finds models downloaded from Hugging Face by their folders’ names alone, and knows how to run mlx-audio here', async () => {
    assert.equal(repoOf('models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit'), 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit')
    assert.equal(repoOf('datasets--someone--speech'), undefined)
    assert.equal(hfCache({ HF_HOME: '/data/hf' }), '/data/hf/hub')
    assert.equal(hfCache({ HF_HUB_CACHE: '/cache', HF_HOME: '/data/hf' }), '/cache')
    const cache = await mkdtemp(joinPath(tempDir(), 'hf-cache-'))
    await makeDir(joinPath(cache, 'models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit'))
    await makeDir(joinPath(cache, 'models--mlx-community--parakeet-tdt-0.6b-v3'))
    await write(joinPath(cache, 'version.txt'), '1')
    const before = process.env.HF_HUB_CACHE
    process.env.HF_HUB_CACHE = cache
    try {
      const names = (await onDisk()).filter((m) => m.source === 'hf').map((m) => m.name).sort()
      assert.deepEqual(names, ['mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', 'mlx-community/parakeet-tdt-0.6b-v3'])
    } finally {
      if (before === undefined) delete process.env.HF_HUB_CACHE
      else process.env.HF_HUB_CACHE = before
    }
    assert.ok(isAudio('mlx-community/Kokoro-82M-bf16') && isAudio('Qwen/Qwen3-ASR-0.6B') && !isAudio('Qwen/Qwen3-32B'))
    assert.deepEqual(mlxAudioCommand((c) => (c === 'uvx' ? '/u/.local/bin/uvx' : undefined)), ['/u/.local/bin/uvx', ['--from', 'mlx-audio', 'mlx_audio.server', '--host', '127.0.0.1', '--port', '8939']])
    assert.deepEqual(mlxAudioCommand((c) => (c === 'mlx_audio.server' ? '/bin/mlx_audio.server' : '/u/uvx'))![0], '/bin/mlx_audio.server')
    assert.equal(mlxAudioCommand(() => undefined), undefined)
  })
})

