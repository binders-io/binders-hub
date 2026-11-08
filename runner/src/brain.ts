import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, totalmem } from 'node:os'
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
}

/** What the hub weighs when it offers a model to download here: how much memory this machine has. */
export function facts() {
  return { memoryGb: Math.round(totalmem() / 1024 ** 3) }
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

/** One server, if it answers OpenAI's model list: what it is and which models it has. */
export async function probe(address: string, kind: string, timeoutMs = 1500): Promise<Server | undefined> {
  const base = address.replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) })
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

/** Every server found on this machine: the usual places, those it was told of, and macOS's voices (`only`: just those). */
export async function detect(extra: string[] = [], only = false): Promise<Server[]> {
  const seen = new Set<string>()
  const candidates = [...extra.map((u) => [u.trim().replace(/\/+$/, ''), 'openai'] as [string, string]), ...(only ? [] : usual)].filter(([u]) => {
    if (!u || seen.has(u) || !nearby(u)) return false
    seen.add(u)
    return true
  })
  const found = (await Promise.all(candidates.map(([u, kind]) => probe(u, kind)))).filter((s): s is Server => Boolean(s))
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
  if (!servers.length) return ['  No model servers found here yet. Start one (Ollama, LM Studio, vLLM, a whisper or Kokoro server) and it’s offered within five minutes.']
  return servers.map((s) => {
    if (s.kind === 'say') return `  macOS voices: ${s.models.length}`
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
export async function serve(options: { hub: string; token: string; name?: string; extra?: string[]; log?: (line: string) => void; signal?: AbortSignal; lookEveryMs?: number; host?: string; only?: boolean }) {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`))
  const url = `${options.hub.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/brain/machine`
  let servers = await detect(options.extra, options.only)
  let failures = 0
  const describe = () => (servers.length ? servers.map((s) => `${s.kind} at ${s.url} (${s.models.length} ${s.kind === 'say' ? 'voices' : 'models'})`).join(', ') : 'no model servers yet')
  log(`Serving ${describe()}.`)
  while (!options.signal?.aborted) {
    const closed = await new Promise<{ code: number; reason: string }>((done) => {
      const socket = new WebSocket(url)
      let looking: NodeJS.Timeout | undefined
      const stop = () => socket.close(1000)
      options.signal?.addEventListener('abort', stop, { once: true })
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'hello', token: options.token, name: options.name ?? hostname(), host: options.host ?? hostname(), version: runnerVersion, platform: `${process.platform} ${process.arch}`, servers, facts: facts() }))
        looking = setInterval(async () => {
          const now = await detect(options.extra, options.only)
          if (JSON.stringify(now) === JSON.stringify(servers)) return
          servers = now
          log(`Now serving ${describe()}.`)
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'servers', servers }))
        }, options.lookEveryMs ?? 5 * 60_000)
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
          return
        }
        const send = (value: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(value))
        if (message.type === 'pull') {
          log(`Downloading ${String(message.model)} into Ollama, as the hub asked.`)
          const reply = await pull(message, servers, (status, completed, total) => send({ type: 'progress', id: message.id, status, completed, total }))
          log(reply.ok ? `Downloaded ${String(message.model)}.` : `Couldn’t download ${String(message.model)}: ${reply.error}.`)
          // What's served now, the new model with it, before the hub hears it's done.
          if (reply.ok) {
            servers = await detect(options.extra, options.only)
            send({ type: 'servers', servers })
          }
          send(reply)
          return
        }
        const reply = message.type === 'http' ? await relay(message, servers) : message.type === 'say' ? await say(message, servers) : undefined
        if (reply) send(reply)
      })
      socket.addEventListener('close', (event) => {
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
  await serve({ hub, token, name: value('--name'), extra })
  return 0
}
