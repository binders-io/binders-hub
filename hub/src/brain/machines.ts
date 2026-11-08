import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { KV } from '../kv.ts'
import { Refused } from '../hub.ts'
import { log } from '../logger.ts'
import { BrainUnavailable, type Speaker } from './models.ts'

// Machines of yours that serve the brain's models: a Mac, or a GPU box such as a DGX Spark, running the Binders daemon
// (`binders add --token bnw_…`). It links to the hub, says which model servers it found on itself (Ollama, LM Studio,
// vLLM or NIM, MLX, a whisper or Parakeet server, Kokoro) and, on a Mac, macOS's voices; the hub sends the requests for
// those servers through it, and it reaches only them. So all the brain's own logic (prompts, parsing, citations) stays
// here, and a machine needs no more than the daemon and the servers it already runs.

export interface MachineServer {
  /** Its address on the machine, e.g. http://127.0.0.1:11434/v1; "say:" for macOS's voices. */
  url: string
  /** What it is, as the daemon could tell: ollama, lmstudio, vllm, nim, kokoro, openai (anything else that speaks OpenAI's API), say. */
  kind: string
  /** The models it lists, or the voices, for say. */
  models: string[]
}

export interface MachineInfo {
  id: string
  name: string
  addedBy: string
  addedAt: string
  /** As it said when it last linked. */
  platform?: string
  version?: string
  servers?: MachineServer[]
  seenAt?: string
}

export interface MachineView extends MachineInfo {
  online: boolean
}

interface Kept extends MachineInfo {
  /** Its token's hash: the token itself is shown once, when it's added. */
  tokenHash: string
}

/** The address the daemon reads for macOS's voices. */
export const sayServer = 'say:'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const listKey = 'brain-machines'
const tokenKey = (token: string) => `brain-machine-token:${hash(token)}`

/** How long a request through a machine may take at most, whatever it asks (a long recording, written down). */
const longest = 20 * 60_000

type Waiting = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

interface Reply {
  ok: boolean
  status?: number
  headers?: Record<string, string>
  /** base64 */
  body?: string
  error?: string
}

function clean(servers: unknown): MachineServer[] {
  if (!Array.isArray(servers)) return []
  return servers.slice(0, 40).flatMap((s) => {
    const server = s as Partial<MachineServer>
    const url = String(server.url ?? '').slice(0, 300)
    if (!url) return []
    return [{ url, kind: String(server.kind ?? 'openai').slice(0, 20), models: Array.isArray(server.models) ? server.models.slice(0, 300).map((m) => String(m).slice(0, 200)) : [] }]
  })
}

export class BrainMachines {
  private kv: KV
  private machines: Kept[] = []
  private live = new Map<string, WebSocket>()
  private waiting = new Map<string, Waiting>()

  constructor(kv: KV) {
    this.kv = kv
  }

  async load() {
    try {
      this.machines = JSON.parse((await this.kv.get(listKey)) ?? '[]') as Kept[]
    } catch {
      this.machines = []
    }
    return this
  }

  private async save() {
    await this.kv.set(listKey, JSON.stringify(this.machines))
  }

  list(): MachineView[] {
    return this.machines.map(({ tokenHash: _t, ...info }) => ({ ...info, online: this.live.has(info.id) }))
  }

  get(id: string): MachineView | undefined {
    return this.list().find((m) => m.id === id)
  }

  /** A machine to add: its name, and its token, shown this once. */
  async add(by: string, name: string) {
    const named = name.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!named) throw new Refused('Give the machine a name, like “Studio Mac” or “Spark 1”.')
    if (this.machines.length >= 20) throw new Refused('A hub takes up to 20 machines.')
    const token = `bnw_${randomBytes(32).toString('base64url')}`
    const machine: Kept = { id: `m-${randomUUID().replace(/-/g, '').slice(0, 12)}`, name: named, addedBy: by, addedAt: new Date().toISOString(), tokenHash: hash(token) }
    this.machines.push(machine)
    await this.kv.set(tokenKey(token), machine.id)
    await this.save()
    const { tokenHash: _t, ...info } = machine
    return { machine: { ...info, online: false } as MachineView, token }
  }

  /** Removed: its token stops working, and its link closes. */
  async remove(id: string) {
    const machine = this.machines.find((m) => m.id === id)
    if (!machine) throw new Refused('No such machine.')
    this.machines = this.machines.filter((m) => m.id !== id)
    await this.kv.del(`brain-machine-token:${machine.tokenHash}`)
    await this.save()
    this.live.get(id)?.close(4003, 'This machine was removed from the hub.')
    this.live.delete(id)
  }

  /** The machine a token is for. */
  async who(token: string | undefined): Promise<MachineView | undefined> {
    if (!token?.startsWith('bnw_')) return undefined
    const id = await this.kv.get(tokenKey(token))
    return id ? this.get(id) : undefined
  }

  /**
   * A machine's link: it says who it is first (its token) and what it serves, then answers what the hub sends it. A
   * second link for the same machine takes over from the first.
   */
  link(socket: WebSocket) {
    let id: string | undefined
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000)
    const hello = setTimeout(() => !id && socket.close(4001, 'Say who you are first.'), 10_000)
    socket.on('message', async (raw) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      if (!id) {
        if (message.type !== 'hello') return
        const machine = await this.who(String(message.token ?? ''))
        clearTimeout(hello)
        if (!machine) return socket.close(4003, 'This hub doesn’t know that token.')
        id = machine.id
        const before = this.live.get(id)
        this.live.set(id, socket)
        if (before && before !== socket) before.close(4000, 'This machine linked again.')
        await this.heard(id, message)
        socket.send(JSON.stringify({ type: 'welcome', id, name: machine.name }))
        log.info({ machine: machine.name }, 'A brain machine linked')
        return
      }
      if (message.type === 'servers') return void (await this.heard(id, message))
      if (message.type === 'reply') {
        const key = String(message.id ?? '')
        const waiting = this.waiting.get(key)
        if (!waiting) return
        this.waiting.delete(key)
        clearTimeout(waiting.timer)
        waiting.resolve(message as unknown as Reply)
      }
    })
    socket.on('close', () => {
      clearInterval(ping)
      clearTimeout(hello)
      if (id && this.live.get(id) === socket) this.live.delete(id)
    })
  }

  /** What a machine said it serves, kept so Settings shows it while the machine is away too. */
  private async heard(id: string, message: Record<string, unknown>) {
    const machine = this.machines.find((m) => m.id === id)
    if (!machine) return
    if (message.servers !== undefined) machine.servers = clean(message.servers)
    if (typeof message.platform === 'string') machine.platform = message.platform.slice(0, 40)
    if (typeof message.version === 'string') machine.version = message.version.slice(0, 40)
    machine.seenAt = new Date().toISOString()
    await this.save()
  }

  private nameOf(id: string) {
    return this.machines.find((m) => m.id === id)?.name ?? 'Your machine'
  }

  /** One request to a machine, answered by it, or a plain reason why not. */
  private ask(id: string, request: Record<string, unknown>, signal?: AbortSignal | null): Promise<Reply> {
    const socket = this.live.get(id)
    if (!this.machines.some((m) => m.id === id)) return Promise.reject(new BrainUnavailable('That machine was removed from the hub.'))
    if (!socket || socket.readyState !== socket.OPEN) return Promise.reject(new BrainUnavailable(`${this.nameOf(id)} isn’t linked to the hub right now. Is it on, with the Binders daemon running?`))
    const key = randomUUID()
    return new Promise<Reply>((resolve, reject) => {
      const fail = (error: Error) => {
        if (!this.waiting.delete(key)) return
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => fail(new BrainUnavailable(`${this.nameOf(id)} didn’t answer in time.`)), longest)
      this.waiting.set(key, { resolve, reject, timer })
      signal?.addEventListener('abort', () => fail(signal.reason instanceof Error ? signal.reason : new BrainUnavailable(`${this.nameOf(id)} took too long.`)), { once: true })
      socket.send(JSON.stringify({ ...request, id: key }))
    })
  }

  /**
   * A fetch that goes through the machine to a server on it: what the hub's model classes use for a job a machine
   * serves. The machine answers with the server's own reply.
   */
  fetchVia(id: string): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const body = request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : undefined
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => {
        headers[name] = value
      })
      const reply = await this.ask(id, { type: 'http', method: request.method, url: request.url, headers, ...(body ? { body } : {}) }, init?.signal)
      if (!reply.ok) throw new BrainUnavailable(`${this.nameOf(id)} couldn’t reach that server: ${reply.error ?? 'it said no more'}.`)
      return new Response(reply.body ? Buffer.from(reply.body, 'base64') : null, { status: reply.status ?? 200, headers: reply.headers ?? {} })
    }) as typeof fetch
  }

  /** macOS's voices on a machine: words read out as audio. */
  speaker(id: string, voice: string): Speaker {
    return {
      label: `${voice || 'the default voice'} on ${this.nameOf(id)}`,
      speak: async (text: string) => {
        const reply = await this.ask(id, { type: 'say', text: text.slice(0, 4000), ...(voice ? { voice } : {}) }, AbortSignal.timeout(120_000))
        if (!reply.ok || !reply.body) throw new BrainUnavailable(`${this.nameOf(id)} couldn’t read that out: ${reply.error ?? 'no audio came back'}.`)
        return { audio: Buffer.from(reply.body, 'base64'), mime: reply.headers?.['content-type'] ?? 'audio/wav' }
      },
    }
  }

  /** The machine's name, for labels. */
  name(id: string) {
    return this.nameOf(id)
  }

  /** For tests: every link closed. */
  closeAll() {
    for (const socket of this.live.values()) socket.close(1001)
    this.live.clear()
    for (const waiting of this.waiting.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new BrainUnavailable('The hub is stopping.'))
    }
    this.waiting.clear()
  }
}
