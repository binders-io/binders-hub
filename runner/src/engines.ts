import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { freemem, homedir, totalmem } from 'node:os'
import { join } from 'node:path'

// What serves the models downloaded on this machine, when the hub asks for one, as Ollama does for its own: the daemon
// lists every model here that an engine on this machine can run, and starts that engine when a request names the model.
//   TensorFold (installed by you) for chat models, on a Mac (MLX) and on Linux with an NVIDIA GPU: one model a process.
//   mlx-lm on a Mac for chat models: one process, loading the model each request names. Installed with uv when needed.
//   mlx-audio on a Mac for speech and transcription models, the same way. Installed with uv, with its server's packages.
//   vLLM on Linux, when it's installed and TensorFold isn't: one model a process.
// It runs one model-a-process engine at a time (big models don't share a machine well), stops what it started after
// twenty idle minutes, and never stops a server you started yourself.

export type EngineId = 'tensorfold' | 'mlx-lm' | 'mlx-audio' | 'vllm'

export type Find = (command: string) => string | undefined

export interface EngineSpec {
  id: EngineId
  /** One process a model (TensorFold, vLLM), or one for them all, loading the model each request names. */
  perModel: boolean
  /** Its command line on a port (and for its model, one a process): undefined until it's installed. */
  command(find: Find, port: number, model?: string): [string, string[]] | undefined
  /** How it's installed when it isn't, with uv. */
  install?(find: Find): [string, string[]] | undefined
  /** How long it may take to answer once started: a big model takes minutes to load. */
  readyMs: number
}

const at = (port: number) => ['--host', '127.0.0.1', '--port', String(port)]

export const engines: Record<EngineId, EngineSpec> = {
  tensorfold: {
    id: 'tensorfold', perModel: true, readyMs: 20 * 60_000,
    command: (find, port, model) => {
      const tensorfold = find('tensorfold')
      return tensorfold && model ? [tensorfold, ['serve', model, ...at(port), '--name', model]] : undefined
    },
  },
  'mlx-lm': {
    id: 'mlx-lm', perModel: false, readyMs: 3 * 60_000,
    command: (find, port) => {
      const server = find('mlx_lm.server')
      return server ? [server, at(port)] : undefined
    },
    install: (find) => {
      const uv = find('uv')
      return uv ? [uv, ['tool', 'install', 'mlx-lm']] : undefined
    },
  },
  'mlx-audio': {
    id: 'mlx-audio', perModel: false, readyMs: 3 * 60_000,
    command: (find, port) => {
      const server = find('mlx_audio.server')
      return server ? [server, at(port)] : undefined
    },
    // Its server's own packages (uvicorn, FastAPI, webrtcvad), which the plain package leaves out.
    install: (find) => {
      const uv = find('uv')
      return uv ? [uv, ['tool', 'install', 'mlx-audio[server]']] : undefined
    },
  },
  vllm: {
    id: 'vllm', perModel: true, readyMs: 20 * 60_000,
    command: (find, port, model) => {
      const vllm = find('vllm')
      return vllm && model ? [vllm, ['serve', model, ...at(port)]] : undefined
    },
  },
}

/** A speech or transcription model, by its name. */
export function isAudio(name: string) {
  return !/g2p/i.test(name) && /whisper|parakeet|canary|moonshine|voxtral|qwen\d*-asr|kokoro|tts|csm|dia-|orpheus|chatterbox|outetts|spark-tts|vibevoice|sesame/i.test(name)
}

export type Kind = 'chat' | 'audio' | 'embeddings' | 'other'

/** What a model is for, by its name: the brain's jobs, or none of them (images, music, video…). */
export function kindOf(name: string): Kind {
  if (isAudio(name)) return 'audio'
  if (/image|vae|diffusion|flux|sdxl|(^|[^a-z])sd-|latentsync|ace-step|music|video|g2p|(^|[^a-z])clip|siglip|ocr|depth|controlnet|lora/i.test(name)) return 'other'
  if (/embed|minilm|(^|[^a-z])bge|(^|[^a-z])e5-|(^|[^a-z])gte-|mxbai|arctic-embed|rerank/i.test(name)) return 'embeddings'
  return 'chat'
}

export type Format = 'mlx' | 'gguf' | 'cuda' | 'hf'

/** How a model's weights are kept, by its name: MLX for a Mac, quantized for NVIDIA, GGUF, or plain Hugging Face. */
export function formatOf(name: string): Format {
  if (/gguf/i.test(name)) return 'gguf'
  if (/nvfp4|(^|[^a-z])fp8|awq|gptq|w4a16|w8a8|(^|[^a-z])int[48]/i.test(name)) return 'cuda'
  if (/mlx/i.test(name)) return 'mlx'
  return 'hf'
}

/** Roughly how much memory a model takes, in GB, from its name (billions of parameters, and how they're kept): 0 unknown. */
export function memoryOf(name: string) {
  const experts = /(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(name)
  const plain = /(?:^|[^a-z0-9.])e?(\d+(?:\.\d+)?)b(?![a-z])/i.exec(name)
  const billions = experts ? Number(experts[1]) * Number(experts[2]) : plain ? Number(plain[1]) : 0
  if (!billions) return 0
  const bytes = /(^|[^0-9])4bit|q4|nvfp4|int4|w4a16|awq|gptq|mxfp4|oq4/i.test(name) ? 0.55 : /8bit|q8|fp8|int8|w8a8/i.test(name) ? 1.05 : /6bit|q6/i.test(name) ? 0.8 : 2.05
  return Math.round(billions * bytes * 1.15 + 1)
}

/** What serves a model on this machine, or why nothing does. */
export function engineFor(name: string, on: { mac: boolean; memoryGb: number; have: (id: EngineId) => boolean; canInstall: boolean }): EngineId | { why: string } {
  const kind = kindOf(name)
  if (kind === 'other') return { why: 'not a model the brain uses' }
  const need = memoryOf(name)
  if (need && need > on.memoryGb * 0.8) return { why: `too big for this machine (about ${need} GB)` }
  if (kind === 'embeddings') return { why: 'embeddings models aren’t loaded on demand yet' }
  if (kind === 'audio') {
    if (!on.mac) return { why: 'nothing on Linux serves speech models on demand yet' }
    return on.have('mlx-audio') || on.canInstall ? 'mlx-audio' : { why: 'needs uv, to install mlx-audio with' }
  }
  const format = formatOf(name)
  if (format === 'gguf') return { why: 'GGUF models aren’t loaded on demand yet' }
  if (on.mac) {
    if (format === 'cuda') return { why: 'made for NVIDIA GPUs' }
    if (on.have('tensorfold')) return 'tensorfold'
    return on.have('mlx-lm') || on.canInstall ? 'mlx-lm' : { why: 'needs uv, to install mlx-lm with' }
  }
  if (format === 'mlx') return { why: 'MLX models run on a Mac' }
  if (on.have('tensorfold')) return 'tensorfold'
  if (on.have('vllm')) return 'vllm'
  return { why: 'nothing here runs it: TensorFold or vLLM would' }
}

/** The models here, each with what serves it or why nothing does. */
export function catalogue(names: string[], on: Parameters<typeof engineFor>[1]) {
  const served = new Map<string, EngineId>()
  const notes: { name: string; engine?: EngineId; why?: string }[] = []
  for (const name of names) {
    const engine = engineFor(name, on)
    if (typeof engine === 'string') {
      served.set(name, engine)
      notes.push({ name, engine })
    } else notes.push({ name, why: engine.why })
  }
  return { served, notes }
}

/** This machine, as engineFor weighs it. */
export function thisMachine(find: Find) {
  return {
    mac: process.platform === 'darwin' && process.arch === 'arm64',
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    have: (id: EngineId) => Boolean(engines[id].command(find, 1, 'model')),
    canInstall: Boolean(find('uv')),
  }
}

interface Running {
  id: EngineId
  model?: string
  port: number
  child: ChildProcess
  ready: Promise<boolean>
  lastUsed: number
  busy: number
  said: string
}

const running = new Map<string, Running>()
const installing = new Map<EngineId, Promise<boolean>>()

/** Where what an engine says is written, on this machine. */
export const engineLog = (id: string) => join(process.env.BINDERS_HOME ?? join(homedir(), '.binders'), 'logs', `${id}.log`)

/** The line that says why something stopped: its last error, else its last line. */
export function whyStopped(output: string) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  return [...lines].reverse().find((l) => /error|exception|not found|no module|failed|denied|cannot|can't|out of memory/i.test(l)) ?? lines.at(-1) ?? ''
}

/** A free port for an engine, from 8941. */
async function freePort(from = 8941): Promise<number> {
  const taken = new Set([...running.values()].map((r) => r.port))
  for (let port = from; port < 9100; port++) {
    if (taken.has(port)) continue
    const free = await new Promise<boolean>((done) => {
      const probe = createServer()
      probe.once('error', () => done(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
    })
    if (free) return port
  }
  throw new Error('no free port for an engine')
}

/** Memory free for a model now, in GB: Linux's own estimate of what can be had without swapping; else what's free. */
export async function freeGb() {
  const info = await readFile('/proc/meminfo', 'utf8').catch(() => '')
  const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(info)
  return available ? Number(available[1]) / 1024 ** 2 : freemem() / 1024 ** 3
}

/** An engine installed once, with uv, while others wait for the same install. */
function installOnce(spec: EngineSpec, find: Find, log: (line: string) => void): Promise<boolean> {
  const going = installing.get(spec.id)
  if (going) return going
  const install = spec.install?.(find)
  if (!install) return Promise.resolve(false)
  log(`Installing ${spec.id}, the first time only.`)
  const done = new Promise<boolean>((resolve) => {
    const child = spawn(install[0], install[1], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  }).finally(() => installing.delete(spec.id))
  installing.set(spec.id, done)
  return done
}

/** Installs, before they're asked for, the engines the models here need: so a first request doesn't wait minutes. */
export async function prepare(needed: EngineId[], find: Find, log: (line: string) => void, specs = engines) {
  for (const id of [...new Set(needed)]) {
    const spec = specs[id]
    if (spec.command(find, 1, 'model') || !spec.install) continue
    if (!(await installOnce(spec, find, log))) log(`Couldn’t install ${id}.`)
  }
}

function stop(key: string) {
  const run = running.get(key)
  if (!run) return
  running.delete(key)
  run.child.kill()
}

/**
 * The engine for a model, running: started (and installed) when it isn't, one model-a-process engine at a time. Its
 * address, or why it can't be had.
 */
export async function engineAddress(model: string, served: Map<string, EngineId>, find: Find, log: (line: string) => void, specs = engines): Promise<{ base: string; done: () => void } | { error: string }> {
  const id = served.get(model)
  if (!id) return { error: `${model} isn’t a model this machine serves` }
  const spec = specs[id]
  const key = spec.perModel ? `${id}:${model}` : id
  let run = running.get(key)
  if (!run) {
    // One big model at a time: what else this daemon started for one model goes first.
    if (spec.perModel) for (const [other, r] of running) if (specs[r.id].perModel) stop(other)
    // On Linux, memory is what's free now (a model you serve yourself may hold most of it); a Mac's is shared, and pages.
    const need = memoryOf(model)
    if (spec.perModel && need && process.platform === 'linux') {
      await new Promise((done) => setTimeout(done, 1000))
      const free = await freeGb()
      if (need > free) return { error: `${model} needs about ${need} GB, and ${Math.floor(free)} GB is free on this machine now` }
    }
    const port = await freePort()
    let command = spec.command(find, port, model)
    if (!command && spec.install && (await installOnce(spec, find, log))) command = spec.command(find, port, model)
    if (!command) return { error: `${id} isn’t installed on this machine` }
    log(`Starting ${id}${spec.perModel ? ` for ${model}` : ''}.`)
    await mkdir(join(engineLog(id), '..'), { recursive: true }).catch(() => {})
    const file = createWriteStream(engineLog(id), { flags: 'a' })
    const child = spawn(command[0], command[1], { stdio: ['ignore', 'pipe', 'pipe'] })
    const started: Running = { id, model: spec.perModel ? model : undefined, port, child, lastUsed: Date.now(), busy: 0, said: '', ready: Promise.resolve(false) }
    const keep = (chunk: Buffer) => {
      file.write(chunk)
      started.said = (started.said + chunk.toString()).slice(-20_000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    let exited = false
    child.on('exit', () => {
      exited = true
      file.end()
      if (running.get(key) === started) running.delete(key)
    })
    child.on('error', () => { exited = true })
    started.ready = (async () => {
      const end = Date.now() + spec.readyMs
      while (Date.now() < end && !exited) {
        await new Promise((done) => setTimeout(done, 500))
        const up = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
        if (up) return true
      }
      return false
    })()
    running.set(key, started)
    run = started
  }
  const ready = await run.ready
  if (!ready) {
    stop(key)
    return { error: `${id} didn’t start: ${whyStopped(run.said) || 'it said nothing'} (more in ${engineLog(id).replace(homedir(), '~')})` }
  }
  run.lastUsed = Date.now()
  run.busy++
  const done = () => {
    run.busy = Math.max(0, run.busy - 1)
    run.lastUsed = Date.now()
  }
  return { base: `http://127.0.0.1:${run.port}/v1`, done }
}

/** What this daemon started and nothing has asked for in a while, stopped: its memory back. */
export function stopIdle(idleMs = 20 * 60_000) {
  for (const [key, run] of running) if (run.busy === 0 && Date.now() - run.lastUsed > idleMs) stop(key)
}

/** Everything this daemon started, stopped: as it stops. */
export function stopAll() {
  for (const key of [...running.keys()]) stop(key)
}

/** The ports of what this daemon started: reached through it, never found again as servers of their own. */
export function enginePorts() {
  return [...running.values()].map((r) => r.port)
}

/** What's running now, for Settings: each engine, and its model when it has one. */
export function runningNow() {
  return [...running.values()].map((r) => ({ engine: r.id, ...(r.model ? { model: r.model } : {}) }))
}
