import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogue, engineAddress, engineFor, formatOf, kindOf, memoryOf, runningNow, stopAll, stopIdle, type EngineSpec } from '../src/engines.ts'
import { modelOfRequest, modelsUrl, relay } from '../src/brain.ts'

/** An engine standing in: listens on the port it's given, lists its models, and says which port answered. */
async function fakeEngine() {
  const folder = await mkdtemp(join(tmpdir(), 'fake-engine-'))
  const file = join(folder, 'engine.mjs')
  await writeFile(file, `
import { createServer } from 'node:http'
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
if (process.argv.includes('--broken')) { console.error('ModuleNotFoundError: No module named uvicorn'); process.exit(1) }
createServer((q, r) => {
  let body = ''
  q.on('data', (c) => { body += c })
  q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ path: q.url, port, model: process.argv[2], body })) })
}).listen(port, '127.0.0.1')
`)
  return file
}

describe('serving the models downloaded on a machine, on demand', () => {
  after(() => stopAll())

  it('knows what each model is for, how it’s kept, and what runs it on a Mac or on Linux', () => {
    assert.deepEqual(['mlx-community/Qwen3-8B-4bit', 'mlx-community/Kokoro-82M-bf16', 'mlx-community/all-MiniLM-L6-v2-4bit', 'someone/flux-image-2', 'someone/kitten-tts-g2p'].map(kindOf), ['chat', 'audio', 'embeddings', 'other', 'other'])
    assert.deepEqual(['mlx-community/Qwen3-8B-4bit', 'unsloth/Qwen3-32B-NVFP4', 'unsloth/gemma-3-4b-it-GGUF', 'Qwen/Qwen3-8B'].map(formatOf), ['mlx', 'cuda', 'gguf', 'hf'])
    assert.equal(memoryOf('mlx-community/Qwen3-32B-4bit'), 21)
    assert.equal(memoryOf('Qwen/Qwen3-8B'), 20)
    assert.equal(memoryOf('someone/unsized-model'), 0)
    const mac = { mac: true, memoryGb: 64, have: () => false, canInstall: true }
    const spark = { mac: false, memoryGb: 128, have: (id: string) => id === 'tensorfold', canInstall: true }
    assert.equal(engineFor('mlx-community/Qwen3-8B-4bit', mac), 'mlx-lm')
    assert.equal(engineFor('mlx-community/Qwen3-8B-4bit', { ...mac, have: (id: string) => id === 'tensorfold' }), 'tensorfold', 'TensorFold, when it’s there')
    assert.equal(engineFor('mlx-community/Kokoro-82M-bf16', mac), 'mlx-audio')
    assert.deepEqual(engineFor('unsloth/Qwen3-32B-NVFP4', mac), { why: 'made for NVIDIA GPUs' })
    assert.equal(engineFor('unsloth/Qwen3-32B-NVFP4', spark), 'tensorfold')
    assert.deepEqual(engineFor('mlx-community/Qwen3-8B-4bit', spark), { why: 'MLX models run on a Mac' })
    assert.deepEqual(engineFor('mlx-community/Kokoro-82M-bf16', spark), { why: 'nothing on Linux serves speech models on demand yet' })
    assert.deepEqual(engineFor('Qwen/Qwen3-235B-A22B', mac), { why: 'too big for this machine (about 555 GB)' })
    assert.deepEqual(engineFor('Qwen/Qwen3-8B', { ...spark, have: () => false }), { why: 'nothing here runs it: TensorFold or vLLM would' })
    const { served, notes } = catalogue(['mlx-community/Qwen3-8B-4bit', 'someone/flux-image-2'], mac)
    assert.deepEqual([...served], [['mlx-community/Qwen3-8B-4bit', 'mlx-lm']])
    assert.deepEqual(notes[1], { name: 'someone/flux-image-2', why: 'not a model the brain uses' })
  })

  it('starts the engine for the model a request names, reuses it, runs one big model at a time, and stops what sits idle', async () => {
    const engine = await fakeEngine()
    const specs = {
      'mlx-lm': { id: 'mlx-lm', perModel: false, readyMs: 30_000, command: (_f, port) => [process.execPath, [engine, 'shared', '--port', String(port)]] },
      tensorfold: { id: 'tensorfold', perModel: true, readyMs: 30_000, command: (_f, port, model) => [process.execPath, [engine, model!, '--port', String(port)]] },
      'mlx-audio': { id: 'mlx-audio', perModel: false, readyMs: 3000, command: (_f, port) => [process.execPath, [engine, 'broken', '--broken', '--port', String(port)]] },
      vllm: { id: 'vllm', perModel: true, readyMs: 1000, command: () => undefined },
    } as Record<string, EngineSpec> as never
    const served = new Map([['small-chat', 'mlx-lm'], ['other-chat', 'mlx-lm'], ['big-a', 'tensorfold'], ['big-b', 'tensorfold'], ['voice', 'mlx-audio']] as const) as never
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    const first = await engineAddress('small-chat', served, () => undefined, log, specs)
    assert.ok('base' in first)
    // One process for every model it loads by name.
    const second = await engineAddress('other-chat', served, () => undefined, log, specs)
    assert.ok('base' in second && second.base === first.base)
    first.done()
    second.done()
    // One model a process: the second big one takes the first one's place.
    const a = await engineAddress('big-a', served, () => undefined, log, specs)
    assert.ok('base' in a)
    a.done()
    const b = await engineAddress('big-b', served, () => undefined, log, specs)
    assert.ok('base' in b)
    b.done()
    assert.deepEqual(runningNow().map((r) => r.engine + (r.model ? `:${r.model}` : '')).sort(), ['mlx-lm', 'tensorfold:big-b'])
    // An engine that stops as it starts says why.
    const broken = await engineAddress('voice', served, () => undefined, log, specs)
    assert.ok('error' in broken && /didn’t start: ModuleNotFoundError: No module named uvicorn/.test(broken.error), JSON.stringify(broken))
    assert.deepEqual(await engineAddress('not-here', served, () => undefined, log, specs), { error: 'not-here isn’t a model this machine serves' })
    stopIdle(0)
    assert.deepEqual(runningNow(), [])
    assert.ok(lines.some((l) => l === 'Starting tensorfold for big-b.'))
  })

  it('sends a request for a downloaded model to its engine, by the model its body names', async () => {
    assert.equal(modelOfRequest(Buffer.from('{"model":"mlx-community/Qwen3-8B-4bit","messages":[]}'), 'application/json'), 'mlx-community/Qwen3-8B-4bit')
    assert.equal(modelOfRequest(Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a.m4a"\r\n\r\n...\r\n--x\r\nContent-Disposition: form-data; name="model"\r\n\r\nmlx-community/parakeet-tdt-0.6b-v3\r\n--x--'), 'multipart/form-data; boundary=x'), 'mlx-community/parakeet-tdt-0.6b-v3')
    const seen: string[] = []
    const engine: Server = createServer((q, r) => {
      seen.push(q.url ?? '')
      r.writeHead(200, { 'content-type': 'application/json' })
      r.end('{"choices":[{"message":{"content":"ok"}}]}')
    })
    await new Promise<void>((done) => engine.listen(0, '127.0.0.1', done))
    let finished = 0
    const route = async (model: string) => (model === 'mlx-community/Qwen3-8B-4bit' ? { base: `http://127.0.0.1:${(engine.address() as AddressInfo).port}/v1`, done: () => { finished++ } } : { error: `${model} isn’t a model this machine serves` })
    const body = Buffer.from(JSON.stringify({ model: 'mlx-community/Qwen3-8B-4bit', messages: [] })).toString('base64')
    const reply = await relay({ id: 'r1', method: 'POST', url: `${modelsUrl}/chat/completions`, headers: { 'content-type': 'application/json' }, body }, [], route)
    assert.deepEqual([reply.ok, reply.status, seen, finished], [true, 200, ['/v1/chat/completions'], 1])
    const other = await relay({ id: 'r2', method: 'POST', url: `${modelsUrl}/chat/completions`, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"model":"x"}').toString('base64') }, [], route)
    assert.deepEqual([other.ok, other.error], [false, 'x isn’t a model this machine serves'])
    // Without a way to route, the address isn't one of the servers here.
    assert.equal((await relay({ id: 'r3', method: 'POST', url: `${modelsUrl}/chat/completions`, headers: {}, body }, [])).ok, false)
    await new Promise<void>((done) => engine.close(() => done()))
  })
})
