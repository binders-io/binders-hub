import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { runnerVersion } from '../../shared/agents.ts'

// The Binders daemon for the hub's brain: it serves the model servers on this machine (a Mac, or a GPU box such as a
// DGX Spark) to the hub, so the hub's brain can sum up, answer, find by meaning, write down audio and read answers out
// with them. It links to the hub with the machine's token (Settings → Brain → Machines), says which servers it found
// here, and then makes the requests the hub sends, to those servers only: never to an address the hub names that isn't
// one of them, so the hub can't reach anything else through it. On a Mac, macOS's own voices read answers out too.
//
//   binders add --token bnw_…            sets it up in the background (launchd on a Mac, systemd on Linux)
//   binders-runner brain --hub URL --token-file FILE [--serve http://127.0.0.1:9000/v1,…]   runs it here

/** A model server on this machine, as the hub sees it. */
export interface Server {
  /** Its address, e.g. http://127.0.0.1:11434/v1; "say:" for macOS's voices. */
  url: string
  kind: string
  /** The models it lists, or the voices, for say. */
  models: string[]
  /** Ollama's version, when it's Ollama: which models it can pull and serve. */
  version?: string
  /** It answered, but wants a key before it says which models it has. */
  needsKey?: boolean
}

/** What the hub weighs when it offers a model to download here: how much memory this machine has. */
export function facts() {
  return { memoryGb: Math.round(totalmem() / 1024 ** 3) }
}

/** A model downloaded on this machine that no server here serves yet: from Hugging Face, or in LM Studio. */
export interface OnDisk {
  name: string
  source: 'hf' | 'lmstudio'
}

/** Where Hugging Face keeps what it downloads: its hub cache, as its own tools find it. */
export function hfCache(env: Record<string, string | undefined> = process.env) {
  return env.HF_HUB_CACHE ?? join(env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub')
}

/** A model's Hugging Face name from its folder in the cache: models--mlx-community--Kokoro-82M-bf16. */
export function repoOf(folder: string) {
  if (!folder.startsWith('models--')) return undefined
  const [org, ...name] = folder.slice('models--'.length).split('--')
  return org && name.length ? `${org}/${name.join('--')}` : undefined
}

/** Where a command is: on the PATH, or one of the usual places (uv's, LM Studio's, Homebrew's). */
export function which(command: string, env: Record<string, string | undefined> = process.env) {
  const places = [...(env.PATH ?? '').split(':'), join(homedir(), '.local', 'bin'), join(homedir(), '.lmstudio', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const place of places) {
    if (place && existsSync(join(place, command))) return join(place, command)
  }
  return undefined
}

/**
 * The models downloaded here: the names of Hugging Face's model folders (only their names: never a file in them, and
 * never its token), and LM Studio's list.
 */
export async function onDisk(): Promise<OnDisk[]> {
  const found: OnDisk[] = []
  const folders = await readdir(hfCache()).catch(() => [] as string[])
  for (const folder of folders) {
    const repo = repoOf(folder)
    if (repo) found.push({ name: repo, source: 'hf' })
  }
  const lms = which('lms')
  if (lms) {
    const { code, out } = await run(lms, ['ls', '--json'], 15_000)
    if (code === 0) {
      try {
        const listed = JSON.parse(out) as { modelKey?: string; path?: string; id?: string }[]
        for (const m of Array.isArray(listed) ? listed : []) {
          const name = String(m.modelKey ?? m.id ?? m.path ?? '')
          if (name) found.push({ name, source: 'lmstudio' })
        }
      } catch { /* an LM Studio that says it otherwise: none from it */ }
    }
  }
  return found.slice(0, 300)
}

/** What can serve models found on disk here: mlx-audio for audio on Apple Silicon (through uv), and LM Studio's server. */
export function runtimes(): string[] {
  const out: string[] = []
  if (process.platform === 'darwin' && process.arch === 'arm64' && (which('mlx_audio.server') || which('uvx') || which('uv'))) out.push('mlx-audio')
  if (which('lms')) out.push('lmstudio')
  if (which('hf') || which('uvx') || which('uv')) out.push('hf')
  return out
}

/** Where the daemon runs mlx-audio, on this machine only. */
export const mlxAudioUrl = 'http://127.0.0.1:8939/v1'
const servingFile = () => join(process.env.BINDERS_HOME ?? join(homedir(), '.binders'), 'brain-serving.json')

/** The command line that runs mlx-audio's server here: its own, or uv's for it. */
export function mlxAudioCommand(find: (command: string) => string | undefined = which): [string, string[]] | undefined {
  const own = find('mlx_audio.server')
  if (own) return [own, ['--host', '127.0.0.1', '--port', '8939']]
  const uvx = find('uvx')
  if (uvx) return [uvx, ['--from', 'mlx-audio', 'mlx_audio.server', '--host', '127.0.0.1', '--port', '8939']]
  const uv = find('uv')
  if (uv) return [uv, ['tool', 'run', '--from', 'mlx-audio', 'mlx_audio.server', '--host', '127.0.0.1', '--port', '8939']]
  return undefined
}

let mlxAudio: ReturnType<typeof spawn> | undefined

/** Whether something answers at an address: any answer at all. */
async function answers(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)
}

/**
 * A runtime started to serve what's on disk, as the hub asked, and kept: mlx-audio (its first start fetches it through
 * uv, which takes a few minutes) or LM Studio's server. Started again whenever the daemon starts.
 */
export async function startServing(runtime: string, note: (status: string) => void = () => {}): Promise<{ ok: boolean; error?: string }> {
  if (runtime === 'lmstudio') {
    const lms = which('lms')
    if (!lms) return { ok: false, error: 'LM Studio isn’t on this machine' }
    note('starting LM Studio’s server')
    const { code } = await run(lms, ['server', 'start'], 120_000)
    if (code !== 0) return { ok: false, error: 'LM Studio’s server didn’t start' }
  } else if (runtime === 'mlx-audio') {
    if (!(await answers(`${mlxAudioUrl}/models`))) {
      const command = mlxAudioCommand()
      if (!command || process.platform !== 'darwin') return { ok: false, error: 'mlx-audio needs a Mac with Apple silicon, and uv (or mlx-audio) on it' }
      note('starting mlx-audio (the first time, uv fetches it: a few minutes)')
      mlxAudio?.kill()
      mlxAudio = spawn(command[0], command[1], { stdio: 'ignore' })
      mlxAudio.on('exit', () => { mlxAudio = undefined })
      let up = false
      for (let i = 0; i < 600 && !up; i++) {
        await sleep(1000)
        up = await answers(`${mlxAudioUrl}/models`)
        if (!mlxAudio) break
      }
      if (!up) return { ok: false, error: 'mlx-audio didn’t start' }
    }
  } else {
    return { ok: false, error: `${runtime} isn’t something this daemon runs` }
  }
  // Kept, so it's started again with the daemon.
  const kept = new Set(await readFile(servingFile(), 'utf8').then((t) => JSON.parse(t) as string[], () => []))
  kept.add(runtime)
  await mkdir(join(servingFile(), '..'), { recursive: true }).catch(() => {})
  await writeFile(servingFile(), JSON.stringify([...kept]))
  return { ok: true }
}

/** The runtimes the hub asked for before, started again. */
async function startKept(log: (line: string) => void) {
  const kept = await readFile(servingFile(), 'utf8').then((t) => JSON.parse(t) as string[], () => [])
  for (const runtime of kept) {
    const started = await startServing(runtime)
    if (!started.ok) log(`Couldn’t start ${runtime} again: ${started.error}.`)
  }
}

/** Where model servers usually listen on a machine, and what usually listens there. */
export const usual: [string, string][] = [
  ['http://127.0.0.1:11434/v1', 'ollama'],
  ['http://127.0.0.1:1234/v1', 'lmstudio'],
  // vLLM and NVIDIA NIM, and speaches (faster-whisper and Kokoro behind OpenAI's API).
  ['http://127.0.0.1:8000/v1', 'vllm'],
  // llama.cpp's server, MLX's, and whisper servers.
  ['http://127.0.0.1:8080/v1', 'openai'],
  ['http://127.0.0.1:8880/v1', 'kokoro'],
  ['http://127.0.0.1:30000/v1', 'sglang'],
  ['http://127.0.0.1:5000/v1', 'openai'],
]

/** macOS's voices, as an address the hub can choose. */
export const sayServer = 'say:'

/**
 * Whether an address is on this machine or its own network (loopback, private and VPN ranges, .local and one-word
 * names): the only kind the daemon serves.
 */
export function nearby(address: string) {
  let host: string
  try {
    const url = new URL(address)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost' || ['.localhost', '.local', '.lan', '.internal', '.home.arpa'].some((end) => host.endsWith(end))) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  if (host.includes(':')) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  return !host.includes('.')
}

/** A speech or transcription model, by its name: what mlx-audio serves. */
export function isAudio(name: string) {
  return /whisper|parakeet|canary|moonshine|voxtral|qwen\d*-asr|kokoro|tts|csm|dia-|orpheus|chatterbox|outetts|spark-tts|vibevoice|sesame/i.test(name)
}

/** One server, if it answers OpenAI's model list: what it is and which models it has, or that it wants a key first. */
export async function probe(address: string, kind: string, timeoutMs = 4000): Promise<Server | undefined> {
  const base = address.replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (response.status === 401 || response.status === 403) return { url: base, kind, models: [], needsKey: true }
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: { id?: unknown; owned_by?: unknown }[] }
    if (!Array.isArray(body.data)) return undefined
    const models = body.data.map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 300)
    // vLLM says it's vLLM; NIM, NVIDIA's.
    const owner = String(body.data[0]?.owned_by ?? '').toLowerCase()
    const named = owner === 'vllm' ? 'vllm' : owner.includes('nvidia') ? 'nim' : kind
    // Ollama, wherever it listens, says so at its own /api/version: it's the one that pulls models.
    const version = await fetch(`${base.replace(/\/v1$/, '')}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(async (r) => (r.ok ? String(((await r.json()) as { version?: unknown }).version ?? '') : ''), () => '')
    return version ? { url: base, kind: 'ollama', models, version } : { url: base, kind: named, models }
  } catch {
    return undefined
  }
}

/** The names in `say -v '?'`: "Samantha            en_US    # Hello! My name is Samantha." */
export function voiceNames(listing: string) {
  return [...new Set(listing.split('\n').map((line) => /^(.+?)\s{2,}[a-z]{2,3}[_-][A-Za-z0-9]+/.exec(line)?.[1]?.trim()).filter((n): n is string => Boolean(n)))].slice(0, 300)
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return done({ code: -1, out: '' })
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); done({ code: -1, out }) })
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, out }) })
  })
}

/** macOS's voices on this machine; none elsewhere. */
export async function voices(): Promise<string[]> {
  if (process.platform !== 'darwin') return []
  const { code, out } = await run('say', ['-v', '?'], 10_000)
  return code === 0 ? voiceNames(out) : []
}

/** Ports never a model server's: ssh, mail, DNS, printing, databases, and the like. */
const notModels = new Set([22, 25, 53, 111, 123, 139, 445, 631, 3306, 5353, 5432, 6379, 11211, 27017])

/**
 * The TCP ports this machine listens on, each with the address to reach it at from here: from the kernel's own table on
 * Linux, from lsof on a Mac. A port open on every address is reached at 127.0.0.1.
 */
export async function listening(): Promise<string[]> {
  const out = new Set<string>()
  if (process.platform === 'linux') {
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const table = await readFile(file, 'utf8').catch(() => '')
      for (const line of table.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        if (cols[3] !== '0A') continue
        const [hex, portHex] = (cols[1] ?? '').split(':')
        const port = parseInt(portHex ?? '', 16)
        if (!port || port < 1024 || notModels.has(port)) continue
        // An IPv4 address, little-endian: a server on one address only is reached there; on all of them, at loopback.
        const ip = hex?.length === 8 ? [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.') : '0.0.0.0'
        out.add(`http://${ip === '0.0.0.0' ? '127.0.0.1' : ip}:${port}`)
      }
    }
  } else if (process.platform === 'darwin') {
    const { code, out: listed } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], 10_000)
    if (code === 0) {
      for (const line of listed.split('\n')) {
        const found = /^n(.*):(\d+)$/.exec(line)
        if (!found) continue
        const port = Number(found[2])
        if (port < 1024 || notModels.has(port)) continue
        const host = found[1].replace(/^\[|\]$/g, '')
        out.add(`http://${host === '*' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${port}`)
      }
    }
  }
  return [...out].filter(nearby).slice(0, 80)
}

/**
 * Every server found on this machine: the ones it was told of, the usual places, and every port it listens on that
 * answers OpenAI's model list (at /v1/models or /models), then macOS's voices (`only`: just those it was told of).
 */
export async function detect(extra: string[] = [], only = false): Promise<Server[]> {
  const seen = new Set<string>()
  const open = only ? [] : await listening()
  const candidates = [...extra.map((u) => [u.trim().replace(/\/+$/, ''), 'openai'] as [string, string]), ...(only ? [] : usual),
    ...open.flatMap((origin) => [[`${origin}/v1`, 'openai'], [origin, 'openai']] as [string, string][])].filter(([u]) => {
    if (!u || seen.has(u) || !nearby(u)) return false
    seen.add(u)
    return true
  })
  const answered = (await Promise.all(candidates.map(([u, kind]) => probe(u, kind)))).filter((s): s is Server => Boolean(s))
  // One server answers at /v1 and at its root alike: kept once, as /v1, which the hub's model classes add their paths to.
  const found = answered.filter((s) => !(s.url.match(/:\d+$/) && answered.some((o) => o.url === `${s.url}/v1`)))
  if (!only && (await answers(`${mlxAudioUrl}/models`))) {
    const audio = (await onDisk()).filter((m) => m.source === 'hf' && isAudio(m.name)).map((m) => m.name)
    found.push({ url: mlxAudioUrl, kind: 'mlx-audio', models: audio })
  }
  const spoken = only ? [] : await voices()
  if (spoken.length) found.push({ url: sayServer, kind: 'say', models: spoken })
  return found
}

interface Reply {
  type: 'reply'
  id: string
  ok: boolean
  status?: number
  headers?: Record<string, string>
  body?: string
  error?: string
}

/** Headers that are the connection's, not the request's: never passed on. */
const own = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect'])

/**
 * One request the hub sends through: made to a server this machine found on itself, and only to one; the server's
 * answer goes back as it came.
 */
export async function relay(message: { id?: unknown; method?: unknown; url?: unknown; headers?: unknown; body?: unknown }, servers: Server[]): Promise<Reply> {
  const id = String(message.id ?? '')
  const url = String(message.url ?? '')
  const ours = servers.some((s) => s.url !== sayServer && (url === s.url || url.startsWith(`${s.url}/`)))
  if (!ours || !nearby(url)) return { type: 'reply', id, ok: false, error: 'that address isn’t one of the servers on this machine' }
  const method = String(message.method ?? 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) return { type: 'reply', id, ok: false, error: `${method} isn’t passed on` }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries((message.headers ?? {}) as Record<string, unknown>)) {
    if (!own.has(name.toLowerCase())) headers[name] = String(value)
  }
  try {
    const response = await fetch(url, { method, headers, ...(typeof message.body === 'string' && method === 'POST' ? { body: Buffer.from(message.body, 'base64') } : {}), signal: AbortSignal.timeout(20 * 60_000) })
    const body = Buffer.from(await response.arrayBuffer())
    return { type: 'reply', id, ok: true, status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' }, body: body.toString('base64') }
  } catch {
    return { type: 'reply', id, ok: false, error: `the server at ${new URL(url).host} didn’t answer` }
  }
}

/** A model Ollama can be asked to pull: a name and a tag, nothing that could be read as anything else. */
export const pullable = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80})?(:[a-z0-9][a-z0-9._-]{0,60})?$/i

/**
 * A model downloaded into Ollama on this machine, as the hub asked: through Ollama's own API, never a command line, with
 * what it's done told as it goes. Only a model name; only to the Ollama this machine found.
 */
export async function pull(message: { id?: unknown; model?: unknown }, servers: Server[], progress: (status: string, completed: number, total: number) => void): Promise<Reply> {
  const id = String(message.id ?? '')
  const model = String(message.model ?? '')
  const ollama = servers.find((s) => s.kind === 'ollama')
  if (!ollama) return { type: 'reply', id, ok: false, error: 'this machine has no Ollama to download into' }
  if (!pullable.test(model)) return { type: 'reply', id, ok: false, error: `${model} isn’t a model’s name` }
  let response: Response
  try {
    response = await fetch(`${ollama.url.replace(/\/v1$/, '')}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, name: model, stream: true }), signal: AbortSignal.timeout(12 * 3_600_000) })
  } catch {
    return { type: 'reply', id, ok: false, error: 'Ollama didn’t answer' }
  }
  if (!response.ok || !response.body) return { type: 'reply', id, ok: false, error: `Ollama answered ${response.status}` }
  let last = 0
  let failed = ''
  let finished = false
  let rest = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true })
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let step: { status?: string; completed?: number; total?: number; error?: string }
      try {
        step = JSON.parse(line)
      } catch {
        continue
      }
      if (step.error) failed = step.error
      if (step.status === 'success') finished = true
      // Told now and then, not for every chunk.
      if (Date.now() - last > 1000 || step.status === 'success') {
        last = Date.now()
        progress(String(step.status ?? ''), Number(step.completed) || 0, Number(step.total) || 0)
      }
    }
  }
  if (failed || !finished) return { type: 'reply', id, ok: false, error: failed || 'the download stopped before it finished' }
  return { type: 'reply', id, ok: true, status: 200 }
}

/** A Hugging Face model downloaded with its own tool (hf, or through uv), as the hub asked: for mlx-audio to serve. */
export async function hfDownload(message: { id?: unknown; model?: unknown }, progress: (status: string) => void): Promise<Reply> {
  const id = String(message.id ?? '')
  const repo = String(message.model ?? '')
  if (!/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(repo)) return { type: 'reply', id, ok: false, error: `${repo} isn’t a Hugging Face model’s name` }
  const hf = which('hf')
  const uvx = which('uvx')
  const command: [string, string[]] | undefined = hf ? [hf, ['download', repo]] : uvx ? [uvx, ['--from', 'huggingface-hub', 'hf', 'download', repo]] : undefined
  if (!command) return { type: 'reply', id, ok: false, error: 'this machine has neither hf nor uv to download with' }
  progress('downloading')
  const ticking = setInterval(() => progress('downloading'), 5000)
  const { code } = await run(command[0], command[1], 6 * 3_600_000).finally(() => clearInterval(ticking))
  return code === 0 ? { type: 'reply', id, ok: true, status: 200 } : { type: 'reply', id, ok: false, error: 'the download didn’t finish' }
}

/** Words read out by one of macOS's voices, as WAV. */
export async function say(message: { id?: unknown; text?: unknown; voice?: unknown }, servers: Server[]): Promise<Reply> {
  const id = String(message.id ?? '')
  const spoken = servers.find((s) => s.url === sayServer)
  if (!spoken) return { type: 'reply', id, ok: false, error: 'this machine has no macOS voices' }
  const voice = typeof message.voice === 'string' ? message.voice : ''
  // Only a voice it has: never a word that `say` could take for something else.
  if (voice && !spoken.models.includes(voice)) return { type: 'reply', id, ok: false, error: `this Mac has no voice called ${voice}` }
  const text = String(message.text ?? '').slice(0, 4000)
  if (!text.trim()) return { type: 'reply', id, ok: false, error: 'nothing to say' }
  const folder = await mkdtemp(join(tmpdir(), 'binders-say-'))
  try {
    const input = join(folder, 'words.txt')
    const output = join(folder, 'spoken.wav')
    await writeFile(input, text)
    const { code } = await run('say', [...(voice ? ['-v', voice] : []), '-f', input, '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050'], 120_000)
    if (code !== 0) return { type: 'reply', id, ok: false, error: 'say couldn’t read it out' }
    return { type: 'reply', id, ok: true, status: 200, headers: { 'content-type': 'audio/wav' }, body: (await readFile(output)).toString('base64') }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** A machine joining with the command from Settings → Brain (a bnj_ token): its own token, and the name the hub gives it. */
export async function joinMachine(hub: string, joinToken: string, host = hostname()): Promise<{ token: string; name: string; id?: string }> {
  let response: Response
  try {
    response = await fetch(`${hub.replace(/\/+$/, '')}/api/brain/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: joinToken, host }), signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new Error(`Couldn’t reach the hub at ${hub}.`)
  }
  const body = (await response.json().catch(() => ({}))) as { token?: string; name?: string; id?: string; error?: string }
  if (!response.ok || !body.token?.startsWith('bnw_')) throw new Error(body.error ?? `The hub answered ${response.status}.`)
  return { token: body.token, name: body.name ?? host, ...(body.id ? { id: body.id } : {}) }
}

/** What it found here, in words, a line each: for binders add to say. */
export function foundLines(servers: Server[]) {
  if (!servers.length) return ['  No model servers found here yet: nothing that listens on this machine answered with a list of models. Start one (Ollama, LM Studio, vLLM, TensorFold, a whisper or Kokoro server) and it’s offered within five minutes.']
  return servers.map((s) => {
    if (s.kind === 'say') return `  macOS voices: ${s.models.length}`
    if (s.needsKey) return `  A model server at ${s.url} wants a key before it says which models it has.`
    const port = (() => {
      try {
        return new URL(s.url).port
      } catch {
        return ''
      }
    })()
    const names: Record<string, string> = { ollama: 'Ollama', lmstudio: 'LM Studio', vllm: 'vLLM', nim: 'NVIDIA NIM', kokoro: 'Kokoro', sglang: 'SGLang' }
    const shown = s.models.slice(0, 6).join(', ') + (s.models.length > 6 ? `, and ${s.models.length - 6} more` : '')
    return `  ${names[s.kind] ?? 'A model server'}${port ? ` on :${port}` : ''}: ${shown || 'no models yet'}`
  })
}

/** Who the machine's token is, as the hub says: for binders add. */
export async function machineIdentity(hub: string, token: string): Promise<{ name: string; id?: string }> {
  let response: Response
  try {
    response = await fetch(`${hub.replace(/\/+$/, '')}/api/brain/machine/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new Error(`Couldn’t reach the hub at ${hub}.`)
  }
  if (response.status === 401) throw new Error('The hub doesn’t know that token: add the machine again in Settings → Brain → Machines.')
  if (!response.ok) throw new Error(`The hub answered ${response.status}.`)
  const me = (await response.json()) as { name?: string; id?: string }
  return { name: me.name ?? 'Brain machine', ...(me.id ? { id: me.id } : {}) }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * Links to the hub and serves it until stopped: says which servers it found, answers what the hub sends, looks for
 * servers again every few minutes (one started later is offered then), and links again after any break.
 */
/** Whether version a is newer than b: 0.14.0 against 0.13.2. */
export function newer(a: string, b: string) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** The hub's runner file in place of this one, when it's the version the hub said: false when it isn't, or can't be had. */
async function replaceWith(hub: string, version: string, file: string, log: (line: string) => void) {
  try {
    const response = await fetch(new URL('/runner/binders-runner.mjs', hub), { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60_000) })
    const code = response.ok ? await response.text() : ''
    if (!code.includes(`runnerVersion = "${version}"`)) return false
    await writeFile(`${file}.new`, code)
    await rename(`${file}.new`, file)
    return true
  } catch (error) {
    log(`Couldn’t update to ${version}: ${error instanceof Error ? error.message : String(error)}.`)
    return false
  }
}

export async function serve(options: { hub: string; token: string; name?: string; extra?: string[]; log?: (line: string) => void; signal?: AbortSignal; lookEveryMs?: number; host?: string; only?: boolean; selfUpdate?: string }) {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`))
  const url = `${options.hub.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/brain/machine`
  let servers = await detect(options.extra, options.only)
  let failures = 0
  /** The link up now, if one is: for news that comes in between (a runtime started again). */
  let live: WebSocket | undefined
  // What the hub asked to be served before, started again beside the link (mlx-audio's first start can take minutes).
  if (!options.only) {
    void startKept(log).then(async () => {
      servers = await detect(options.extra, options.only)
      if (live?.readyState === WebSocket.OPEN) live.send(JSON.stringify({ type: 'servers', servers, onDisk: await onDisk(), runtimes: runtimes() }))
    })
  }
  const describe = () => (servers.length ? servers.map((s) => `${s.kind} at ${s.url} (${s.models.length} ${s.kind === 'say' ? 'voices' : 'models'})`).join(', ') : 'no model servers yet')
  log(`Serving ${describe()}.`)
  while (!options.signal?.aborted) {
    const closed = await new Promise<{ code: number; reason: string }>((done) => {
      const socket = new WebSocket(url)
      let looking: NodeJS.Timeout | undefined
      const stop = () => socket.close(1000)
      options.signal?.addEventListener('abort', stop, { once: true })
      socket.addEventListener('open', () => {
        live = socket
        void (async () => {
          const disk = options.only ? [] : await onDisk()
          socket.send(JSON.stringify({ type: 'hello', token: options.token, name: options.name ?? hostname(), host: options.host ?? hostname(), version: runnerVersion, platform: `${process.platform} ${process.arch}`, servers, facts: facts(), onDisk: disk, runtimes: options.only ? [] : runtimes() }))
        })()
        const lookAgain = async () => {
          const now = await detect(options.extra, options.only)
          if (JSON.stringify(now) === JSON.stringify(servers)) return
          servers = now
          log(`Now serving ${describe()}.`)
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'servers', servers }))
        }
        setTimeout(() => void lookAgain(), 30_000)
        looking = setInterval(() => void lookAgain(), options.lookEveryMs ?? 5 * 60_000)
      })
      socket.addEventListener('message', async (event) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>
        } catch {
          return
        }
        if (message.type === 'welcome') {
          failures = 0
          log(`Linked to the hub as ${String(message.name ?? 'a machine')}.`)
          // The hub hands out a newer daemon: this one takes its place, and the service starts it again on it.
          if (typeof message.latest === 'string' && options.selfUpdate && newer(message.latest, runnerVersion) && (await replaceWith(options.hub, message.latest, options.selfUpdate, log))) {
            log(`Updated to ${message.latest}: starting again on it.`)
            socket.close(1000)
            process.exit(0)
          }
          return
        }
        const send = (value: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(value))
        if (message.type === 'serve') {
          const runtime = String(message.runtime ?? '')
          log(`Starting ${runtime} to serve what's on disk, as the hub asked.`)
          const started = await startServing(runtime, (status) => send({ type: 'progress', id: message.id, status, completed: 0, total: 0 }))
          if (started.ok) {
            servers = await detect(options.extra, options.only)
            send({ type: 'servers', servers, onDisk: await onDisk(), runtimes: runtimes() })
          } else log(`Couldn’t start ${runtime}: ${started.error}.`)
          send({ type: 'reply', id: message.id, ok: started.ok, ...(started.error ? { error: started.error } : {}) })
          return
        }
        if (message.type === 'pull') {
          const fromHf = message.source === 'hf'
          log(`Downloading ${String(message.model)} ${fromHf ? 'from Hugging Face' : 'into Ollama'}, as the hub asked.`)
          const reply = fromHf
            ? await hfDownload(message, (status) => send({ type: 'progress', id: message.id, status, completed: 0, total: 0 }))
            : await pull(message, servers, (status, completed, total) => send({ type: 'progress', id: message.id, status, completed, total }))
          // A Hugging Face audio model is served by mlx-audio: started, if it isn't already.
          if (reply.ok && fromHf) await startServing('mlx-audio')
          log(reply.ok ? `Downloaded ${String(message.model)}.` : `Couldn’t download ${String(message.model)}: ${reply.error}.`)
          // What's served now, the new model with it, before the hub hears it's done.
          if (reply.ok) {
            servers = await detect(options.extra, options.only)
            send({ type: 'servers', servers, ...(options.only ? {} : { onDisk: await onDisk(), runtimes: runtimes() }) })
          }
          send(reply)
          return
        }
        const reply = message.type === 'http' ? await relay(message, servers) : message.type === 'say' ? await say(message, servers) : undefined
        if (reply) send(reply)
      })
      socket.addEventListener('close', (event) => {
        if (live === socket) live = undefined
        clearInterval(looking)
        options.signal?.removeEventListener('abort', stop)
        done({ code: event.code, reason: event.reason })
      })
      socket.addEventListener('error', () => { /* the close that follows says it */ })
    })
    if (options.signal?.aborted) break
    failures++
    // Turned away (removed from the hub, or its token stopped): try again now and then, in case it's added back.
    const refused = closed.code === 4003
    const wait = refused ? 10 * 60_000 : [1, 2, 5, 10, 30, 60][Math.min(failures - 1, 5)] * 1000
    log(refused ? `The hub turned this machine away (${closed.reason || 'unknown token'}). Trying again in 10 minutes.` : `Lost the hub; linking again in ${Math.round(wait / 1000)} s.`)
    await sleep(wait)
  }
}

/** binders-runner brain --hub URL --token-file FILE [--name NAME] [--serve URL,URL]: the daemon, in the foreground. */
export async function brainCommand(argv: string[]): Promise<number> {
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const hub = value('--hub') ?? process.env.BINDERS_URL
  const file = value('--token-file')
  const token = file ? readFileSync(file, 'utf8').trim() : process.env.BINDERS_TOKEN
  if (!hub || !token?.startsWith('bnw_')) {
    console.error('binders-runner brain needs --hub and the machine’s token (--token-file, or BINDERS_TOKEN=bnw_…).')
    return 1
  }
  if (typeof WebSocket === 'undefined') {
    console.error(`Serving models to the hub needs Node 22 or newer; this is ${process.version}.`)
    return 1
  }
  const extra = (value('--serve') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // Run as the single file the hub hands out, it keeps itself current, as an agent's runner does.
  const self = import.meta.url.endsWith('.mjs') ? fileURLToPath(import.meta.url) : undefined
  await serve({ hub, token, name: value('--name'), extra, ...(self ? { selfUpdate: self } : {}) })
  return 0
}
