import type { KV } from '../kv.ts'
import type { Sealer } from '../secrets.ts'
import { Refusal } from '../auth.ts'
import { BrainUnavailable, ClaudeModel, OpenAICompatibleEmbedder, OpenAICompatibleModel, OpenAICompatibleSpeaker, OpenAICompatibleTranscriber, tryModel, type BrainModel, type Embedder, type Speaker, type Transcriber, type Via } from './models.ts'
import { sayServer, type BrainMachines, type MachineView } from './machines.ts'
import { bestPicks, candidates, defaultVoice, gateways, isGateway, scoreOf, type Job } from './autoPick.ts'

// Which models the hub's brain uses, set by an admin in Settings, under Brain, and kept in the hub's store with its
// keys sealed. An environment variable set for one fixes it, as with the hub's other options:
//   BRAIN_PROVIDER          anthropic, openai (any server that speaks OpenAI's chat API) or off
//   BRAIN_MODEL             the model (claude-opus-5-5 for Anthropic)
//   BRAIN_BASE_URL          the server, for openai (e.g. http://localhost:11434/v1 for Ollama); for anthropic, a proxy
//                           in front of Anthropic's API, which only the environment can set
//   BRAIN_API_KEY           its key; for Anthropic, ANTHROPIC_API_KEY does as well
//   EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY   embeddings, from a server that speaks OpenAI's API
//   TRANSCRIPTION_BASE_URL, TRANSCRIPTION_MODEL, TRANSCRIPTION_API_KEY   transcription (OpenAI's transcription API: a
//                           whisper or Parakeet server of your own), so what phones and Macs record is written down better
//   SPEECH_BASE_URL, SPEECH_MODEL, SPEECH_VOICE, SPEECH_API_KEY   speech (OpenAI's speech API: Kokoro and the like), so
//                           the hub can answer out loud
//   BRAIN_FIRST             0 for the Brain not to draft answers to agents' questions (it does, when someone looks at
//                           what's waiting, with the chat model)
//   BRAIN_LOCAL_ONLY        1: every model on the hub's own network, never a cloud provider
// Each job can also be served by one of your machines (machines.ts): a Mac or a GPU box running the Binders daemon, which
// reaches the model servers on itself for the hub. Those are chosen in Settings only, as the machines are added there.
// Off, the hub still finds passages by their words; with a model it sums up what's captured and answers questions;
// with embeddings it also finds passages by what they mean.
//
// A key goes only where it was meant to: one set in the environment only to an address the environment sets too (or
// to Anthropic's own), and one saved in Settings is cleared when the provider changes, so it never follows to a server
// it wasn't for. Without a key the hub makes no Claude client at all, rather than send whatever else the SDK finds.

export type BrainProvider = 'off' | 'anthropic' | 'openai' | 'machine'

export interface BrainSettings {
  provider: BrainProvider
  model: string
  baseUrl: string
  /** Sum up dictations, conversations and meetings sent to the hub, as they arrive. */
  summarize: boolean
  /** Look first at what waits on people: draft an answer to an agent's question when someone looks at what's waiting. */
  first: boolean
  embeddingsBaseUrl: string
  embeddingsModel: string
  transcriptionBaseUrl: string
  transcriptionModel: string
  speechBaseUrl: string
  speechModel: string
  speechVoice: string
  /** Every model on the hub's own network: no cloud provider, and no address outside it. */
  localOnly: boolean
  /**
   * The machine each job is served by, when it's one of yours: its id. The job's address is then a server on that
   * machine (http://127.0.0.1:11434/v1, say), or "say:" for macOS's voices. Empty: the hub reaches the address itself.
   */
  machine: string
  embeddingsMachine: string
  transcriptionMachine: string
  speechMachine: string
  /**
   * The jobs the hub chose itself, from your machines (autoPick.ts): chosen again when a better model appears on one, or
   * its machine is removed. A job you set is yours, and never chosen for you again.
   */
  autoJobs: Job[]
  /** The jobs an admin set, even to nothing (the brain off): never chosen for them. */
  ownJobs: Job[]
}

/** What Settings shows: the settings, whether each key is set (never the key), and what the environment fixes. */
export interface BrainView extends BrainSettings {
  apiKeySet: boolean
  /** The key in use is the hub's ANTHROPIC_API_KEY. */
  usesAnthropicKey: boolean
  embeddingsKeySet: boolean
  transcriptionKeySet: boolean
  speechKeySet: boolean
  locked: Partial<Record<keyof BrainSettings | KeyName, string>>
  /** What's in use, in words: "claude-opus-5-5 (Anthropic)", or undefined when off. */
  inUse?: string
  embeddingsInUse?: string
  /** What it still needs before it can be used, in words, when it's set to something but can't be used yet. */
  needs?: string
  embeddingsNeeds?: string
  transcriptionInUse?: string
  transcriptionNeeds?: string
  speechInUse?: string
  speechNeeds?: string
}

type KeyName = 'apiKey' | 'embeddingsKey' | 'transcriptionKey' | 'speechKey'
const keyNames: KeyName[] = ['apiKey', 'embeddingsKey', 'transcriptionKey', 'speechKey']

export const defaultModel = 'claude-opus-5-5'

const defaults: BrainSettings = {
  provider: 'off', model: '', baseUrl: '', summarize: true, first: true, embeddingsBaseUrl: '', embeddingsModel: '',
  transcriptionBaseUrl: '', transcriptionModel: '', speechBaseUrl: '', speechModel: '', speechVoice: '', localOnly: false,
  machine: '', embeddingsMachine: '', transcriptionMachine: '', speechMachine: '', autoJobs: [], ownJobs: [],
}

const variables = {
  provider: 'BRAIN_PROVIDER',
  model: 'BRAIN_MODEL',
  baseUrl: 'BRAIN_BASE_URL',
  summarize: 'BRAIN_SUMMARIZE',
  first: 'BRAIN_FIRST',
  embeddingsBaseUrl: 'EMBEDDINGS_BASE_URL',
  embeddingsModel: 'EMBEDDINGS_MODEL',
  transcriptionBaseUrl: 'TRANSCRIPTION_BASE_URL',
  transcriptionModel: 'TRANSCRIPTION_MODEL',
  speechBaseUrl: 'SPEECH_BASE_URL',
  speechModel: 'SPEECH_MODEL',
  speechVoice: 'SPEECH_VOICE',
  localOnly: 'BRAIN_LOCAL_ONLY',
  machine: 'BRAIN_MACHINE',
  embeddingsMachine: 'EMBEDDINGS_MACHINE',
  transcriptionMachine: 'TRANSCRIPTION_MACHINE',
  speechMachine: 'SPEECH_MACHINE',
  autoJobs: 'BRAIN_AUTO_JOBS',
  ownJobs: 'BRAIN_OWN_JOBS',
  apiKey: 'BRAIN_API_KEY',
  embeddingsKey: 'EMBEDDINGS_API_KEY',
  transcriptionKey: 'TRANSCRIPTION_API_KEY',
  speechKey: 'SPEECH_API_KEY',
} as const

interface Kept extends Partial<BrainSettings> {
  apiKey?: string
  embeddingsKey?: string
  transcriptionKey?: string
  speechKey?: string
}

/**
 * Whether an address is on the hub's own network: this machine, a private or VPN range (Tailscale's and Covee's
 * 100.64/10 among them), a .local or .internal name, or a one-word name such as a container's.
 */
export function onOwnNetwork(address: string) {
  let host: string
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, '')
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

function checkedUrl(value: unknown, what: string) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Refusal(`${what} is a web address, like http://localhost:11434/v1.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Refusal(`${what} starts with https:// or http://.`)
  if (url.username || url.password) throw new Refusal(`${what} has no name or password in it: the key goes in its own box.`)
  return text.replace(/\/+$/, '')
}

function checked(fields: Partial<BrainSettings>): Partial<BrainSettings> {
  const out: Partial<BrainSettings> = {}
  if (fields.provider !== undefined) {
    if (!['off', 'anthropic', 'openai', 'machine'].includes(fields.provider)) throw new Refusal('The brain is off, Anthropic, a server that speaks OpenAI’s API, or one of your machines.')
    out.provider = fields.provider
  }
  for (const name of ['machine', 'embeddingsMachine', 'transcriptionMachine', 'speechMachine'] as const) {
    if (fields[name] === undefined) continue
    const id = String(fields[name]).trim()
    if (id && !/^m-[a-z0-9]{1,32}$/.test(id)) throw new Refusal('That isn’t one of your machines.')
    out[name] = id
  }
  if (fields.model !== undefined) {
    const model = String(fields.model).trim()
    if (model.length > 200 || /\s/.test(model)) throw new Refusal('A model’s name is one word, like claude-opus-5-5.')
    out.model = model
  }
  if (fields.baseUrl !== undefined) out.baseUrl = checkedUrl(fields.baseUrl, 'The model’s server')
  if (fields.summarize !== undefined) out.summarize = Boolean(fields.summarize)
  if (fields.first !== undefined) out.first = Boolean(fields.first)
  if (fields.embeddingsBaseUrl !== undefined) out.embeddingsBaseUrl = checkedUrl(fields.embeddingsBaseUrl, 'The embeddings server')
  if (fields.embeddingsModel !== undefined) {
    const model = String(fields.embeddingsModel).trim()
    if (model.length > 200 || /\s/.test(model)) throw new Refusal('An embeddings model’s name is one word.')
    out.embeddingsModel = model
  }
  if (fields.transcriptionBaseUrl !== undefined) out.transcriptionBaseUrl = checkedUrl(fields.transcriptionBaseUrl, 'The transcription server')
  // macOS's voices on one of your machines go by "say:".
  if (fields.speechBaseUrl !== undefined) out.speechBaseUrl = String(fields.speechBaseUrl).trim() === sayServer ? sayServer : checkedUrl(fields.speechBaseUrl, 'The speech server')
  for (const name of ['transcriptionModel', 'speechModel', 'speechVoice'] as const) {
    if (fields[name] === undefined) continue
    const value = String(fields[name]).trim()
    if (value.length > 200 || /\s/.test(value)) throw new Refusal('A model’s or voice’s name is one word.')
    out[name] = value
  }
  if (fields.localOnly !== undefined) out.localOnly = Boolean(fields.localOnly)
  for (const name of ['autoJobs', 'ownJobs'] as const) {
    if (fields[name] !== undefined) out[name] = (Array.isArray(fields[name]) ? fields[name] : []).filter((j): j is Job => ['chat', 'embeddings', 'transcription', 'speech'].includes(String(j)))
  }
  return out
}

/** Each job's settings: a change to any of them, by an admin, makes the job theirs. */
/** What a job needs when it's set to a gateway's model and Local AI only is on. */
const cloudGateway = 'Local AI only is on, and that model runs in a cloud, through a gateway: choose one on your machines.'

const jobFields: Record<Job, string[]> = {
  chat: ['provider', 'machine', 'baseUrl', 'model', 'apiKey'],
  embeddings: ['embeddingsBaseUrl', 'embeddingsModel', 'embeddingsMachine', 'embeddingsKey'],
  transcription: ['transcriptionBaseUrl', 'transcriptionModel', 'transcriptionMachine', 'transcriptionKey'],
  speech: ['speechBaseUrl', 'speechModel', 'speechVoice', 'speechMachine', 'speechKey'],
}

function fromEnv(env: Record<string, string | undefined>) {
  const fields: Partial<BrainSettings> = {}
  if (env[variables.provider]) fields.provider = env[variables.provider] as BrainProvider
  if (env[variables.model]) fields.model = env[variables.model]
  if (env[variables.baseUrl]) fields.baseUrl = env[variables.baseUrl]
  if (env[variables.summarize]) fields.summarize = !['0', 'off', 'false', 'no'].includes(env[variables.summarize]!.toLowerCase())
  if (env[variables.first]) fields.first = !['0', 'off', 'false', 'no'].includes(env[variables.first]!.toLowerCase())
  if (env[variables.embeddingsBaseUrl]) fields.embeddingsBaseUrl = env[variables.embeddingsBaseUrl]
  if (env[variables.embeddingsModel]) fields.embeddingsModel = env[variables.embeddingsModel]
  for (const name of ['transcriptionBaseUrl', 'transcriptionModel', 'speechBaseUrl', 'speechModel', 'speechVoice'] as const) if (env[variables[name]]) fields[name] = env[variables[name]]
  if (env[variables.localOnly]) fields.localOnly = !['0', 'off', 'false', 'no'].includes(env[variables.localOnly]!.toLowerCase())
  return {
    fields: checked(fields),
    apiKey: env[variables.apiKey] || undefined,
    embeddingsKey: env[variables.embeddingsKey] || undefined,
    transcriptionKey: env[variables.transcriptionKey] || undefined,
    speechKey: env[variables.speechKey] || undefined,
    anthropicKey: env.ANTHROPIC_API_KEY || undefined,
  }
}

interface Made {
  model?: BrainModel
  embedder?: Embedder
  transcriber?: Transcriber
  speaker?: Speaker
  needs?: string
  embeddingsNeeds?: string
  transcriptionNeeds?: string
  speechNeeds?: string
}

export class BrainSettingsStore {
  private kv: KV
  private sealer: Sealer
  private stored: Kept = {}
  private fixed: ReturnType<typeof fromEnv>
  /** Bumped on every change, so whoever made a model from the settings knows to make it again. */
  version = 0

  constructor(kv: KV, sealer: Sealer, env: Record<string, string | undefined> = {}) {
    this.kv = kv
    this.sealer = sealer
    this.fixed = fromEnv(env)
  }

  async load() {
    try {
      const raw = JSON.parse((await this.kv.get('brain')) ?? '{}') as Kept
      this.stored = checked(raw)
      for (const name of keyNames) if (raw[name]) this.stored[name] = raw[name]
    } catch {
      this.stored = {}
    }
    this.changed()
    return this
  }

  get(): BrainSettings {
    const { apiKey: _a, embeddingsKey: _e, transcriptionKey: _t, speechKey: _s, ...stored } = this.stored
    return { ...defaults, ...stored, ...this.fixed.fields }
  }

  private open(sealed: string | undefined) {
    if (!sealed) return undefined
    try {
      return this.sealer.open(sealed)
    } catch {
      // Sealed with another secret: as good as not set.
      return undefined
    }
  }

  /**
   * The model's key and where it may go: BRAIN_API_KEY only to BRAIN_BASE_URL (or Anthropic's own address), the one saved
   * in Settings to the address saved there, ANTHROPIC_API_KEY only to Anthropic.
   */
  private apiKey(): { key?: string; fromEnv: boolean } {
    if (this.fixed.apiKey) return { key: this.fixed.apiKey, fromEnv: true }
    const saved = this.open(this.stored.apiKey)
    if (saved) return { key: saved, fromEnv: false }
    if (this.get().provider === 'anthropic' && this.fixed.anthropicKey) return { key: this.fixed.anthropicKey, fromEnv: true }
    return { fromEnv: false }
  }

  private embeddingsKey(): { key?: string; fromEnv: boolean } {
    return this.serverKey('embeddingsKey')
  }

  /** A server's key: the environment's, else the one saved in Settings. */
  private serverKey(name: 'embeddingsKey' | 'transcriptionKey' | 'speechKey'): { key?: string; fromEnv: boolean } {
    if (this.fixed[name]) return { key: this.fixed[name], fromEnv: true }
    return { key: this.open(this.stored[name]), fromEnv: false }
  }

  view(): BrainView {
    const now = this.get()
    const locked: BrainView['locked'] = {}
    for (const key of Object.keys(this.fixed.fields) as (keyof BrainSettings)[]) locked[key] = variables[key]
    for (const name of keyNames) if (this.fixed[name]) locked[name] = variables[name]
    return {
      ...now,
      apiKeySet: Boolean(this.apiKey().key),
      usesAnthropicKey: now.provider === 'anthropic' && !this.fixed.apiKey && !this.open(this.stored.apiKey) && Boolean(this.fixed.anthropicKey),
      embeddingsKeySet: Boolean(this.embeddingsKey().key),
      transcriptionKeySet: Boolean(this.serverKey('transcriptionKey').key),
      speechKeySet: Boolean(this.serverKey('speechKey').key),
      locked,
      ...(this.made.model ? { inUse: this.made.model.label } : {}),
      ...(this.made.embedder ? { embeddingsInUse: this.made.embedder.label } : {}),
      ...(this.made.needs ? { needs: this.made.needs } : {}),
      ...(this.made.embeddingsNeeds ? { embeddingsNeeds: this.made.embeddingsNeeds } : {}),
      ...(this.made.transcriber ? { transcriptionInUse: this.made.transcriber.label } : {}),
      ...(this.made.transcriptionNeeds ? { transcriptionNeeds: this.made.transcriptionNeeds } : {}),
      ...(this.made.speaker ? { speechInUse: this.made.speaker.label } : {}),
      ...(this.made.speechNeeds ? { speechNeeds: this.made.speechNeeds } : {}),
    }
  }

  /**
   * Changes settings; a key given as '' is cleared, one left out is kept. An admin's change to a job makes it theirs; the
   * hub's own (autoPick) says which jobs it chose.
   */
  async set(fields: Partial<BrainSettings> & Partial<Record<KeyName, string>>, by: 'admin' | 'hub' = 'admin') {
    const { apiKey, embeddingsKey, transcriptionKey, speechKey, autoJobs: givenAuto, ownJobs: givenOwn, ...rest } = fields
    const fixedField = Object.keys(rest).find((key) => key in this.fixed.fields) as keyof BrainSettings | undefined
    if (fixedField) throw new Refusal(`That one is set on the hub by ${variables[fixedField]}, so it can’t be changed here.`)
    for (const [name, value] of [['apiKey', apiKey], ['embeddingsKey', embeddingsKey], ['transcriptionKey', transcriptionKey], ['speechKey', speechKey]] as const) {
      if (value !== undefined && this.fixed[name]) throw new Refusal(`That key is set on the hub by ${variables[name]}, so it can’t be changed here.`)
    }
    const checkedFields = checked(rest)
    const next: Kept = { ...this.stored, ...checkedFields }
    // Another provider: its address, model and key were for the old one, and go with it unless given now.
    const before = this.get().provider
    if (checkedFields.provider !== undefined && checkedFields.provider !== before) {
      if (rest.baseUrl === undefined) next.baseUrl = ''
      if (rest.model === undefined) next.model = ''
      if (apiKey === undefined) delete next.apiKey
    }
    const before2 = this.get()
    if (checkedFields.machine !== undefined && checkedFields.machine !== before2.machine && apiKey === undefined) delete next.apiKey
    for (const role of ['embeddings', 'transcription', 'speech'] as const) {
      const changed = checkedFields[`${role}Machine`]
      if (changed !== undefined && changed !== before2[`${role}Machine`] && fields[`${role}Key`] === undefined) delete next[`${role}Key`]
    }
    for (const [name, value] of [['apiKey', apiKey], ['embeddingsKey', embeddingsKey], ['transcriptionKey', transcriptionKey], ['speechKey', speechKey]] as const) {
      if (value === undefined) continue
      const key = value.trim()
      if (key.length > 500 || /\s/.test(key)) throw new Refusal('A key is one line with no spaces.')
      if (key) next[name] = this.sealer.seal(key)
      else delete next[name]
    }
    const before3 = this.get()
    const touched = (Object.keys(jobFields) as Job[]).filter((job) => jobFields[job].some((name) => name in fields))
    next.autoJobs = by === 'hub' ? (givenAuto ?? before3.autoJobs) : before3.autoJobs.filter((job) => !touched.includes(job))
    next.ownJobs = by === 'hub' ? (givenOwn ?? before3.ownJobs) : [...new Set([...before3.ownJobs, ...touched])]
    this.stored = next
    await this.kv.set('brain', JSON.stringify(this.stored))
    this.changed()
    return this.view()
  }

  private picking: Promise<unknown> = Promise.resolve()

  /** The jobs open to the hub's choosing: no admin set them, and they're unset or the hub's own choice. */
  openJobs(): Job[] {
    const now = this.get()
    const own = new Set(now.ownJobs)
    const auto = new Set(now.autoJobs)
    return (['chat', 'embeddings', 'transcription', 'speech'] as Job[]).filter((job) => {
      if (own.has(job) || jobFields[job].some((name) => name in this.fixed.fields)) return false
      if (job === 'chat') return now.provider === 'off' || (auto.has('chat') && now.provider === 'machine')
      return (!now[`${job}BaseUrl`] && !now[`${job}Machine`]) || auto.has(job)
    })
  }

  /** Jobs an admin hands back: cleared, and chosen by the hub from your machines from now on. */
  async letHubChoose(jobs: Job[]) {
    const fields: Record<string, string> = {}
    for (const job of jobs) {
      if ([...jobFields[job]].some((name) => name in this.fixed.fields)) throw new Refusal(`That job is set on the hub by its environment, so it can’t be chosen for you.`)
      if (job === 'chat') Object.assign(fields, { provider: 'off', machine: '', baseUrl: '', model: '' })
      else Object.assign(fields, { [`${job}Machine`]: '', [`${job}BaseUrl`]: '', [`${job}Model`]: '', ...(job === 'speech' ? { speechVoice: '' } : {}) })
    }
    const now = this.get()
    await this.set({ ...fields, autoJobs: now.autoJobs.filter((j) => !jobs.includes(j)), ownJobs: now.ownJobs.filter((j) => !jobs.includes(j)) } as Partial<BrainSettings>, 'hub')
    if (this.machines) await this.autoPick(this.machines.list())
    return this.view()
  }

  /**
   * Each job no one chose, given the best model on your machines linked now; one the hub chose before, given a better
   * one when it appears (a Spark joining after a Mac), or let go when its machine is removed. One at a time.
   */
  autoPick(machines: MachineView[]) {
    this.picking = this.picking.then(() => this.pickNow(machines)).catch(() => undefined)
    return this.picking
  }

  private async pickNow(machines: MachineView[]) {
    const now = this.get()
    const picks = bestPicks(machines)
    const listed = candidates(machines)
    const auto = new Set(now.autoJobs)
    const known = (id: string) => machines.some((m) => m.id === id)
    const linked = (id: string) => machines.some((m) => m.id === id && m.online)
    const fixed = (names: string[]) => names.some((name) => name in this.fixed.fields)
    const fields: Record<string, string> = {}
    const own = new Set(now.ownJobs)
    for (const job of ['chat', 'embeddings', 'transcription', 'speech'] as Job[]) {
      if (fixed(jobFields[job]) || own.has(job)) continue
      const chosen = auto.has(job)
      const machine = job === 'chat' ? now.machine : now[`${job}Machine`]
      const url = job === 'chat' ? now.baseUrl : now[`${job}BaseUrl`]
      const model = job === 'chat' ? now.model : job === 'speech' && url === sayServer ? '' : now[`${job}Model`]
      // Open: nothing set (the brain off, for chat), or the hub's own choice.
      const open = job === 'chat' ? now.provider === 'off' || (chosen && now.provider === 'machine') : (!url && !machine) || chosen
      if (!open) continue
      const pick = picks[job]
      const current = chosen && machine ? { machine, url, model } : undefined
      const same = pick && current && pick.machine === current.machine && pick.url === current.url && pick.model === current.model
      // What's in use, scored as bestPicks scores it: by its server and machine, too, for a model with no size in its name.
      const server = current ? machines.find((m) => m.id === current.machine)?.servers?.find((s) => s.url === current.url) : undefined
      const memory = current ? machines.find((m) => m.id === current.machine)?.facts?.memoryGb : undefined
      // What the hub chose before and is no longer a candidate (its machine went, or it turned out not to be a model there,
      // such as a gateway's): the best that is takes its place.
      const gone = current && !listed[job].some((c) => c.machine === current.machine && c.url === current.url && (c.model === current.model || (c.url === sayServer && job === 'speech')))
      const better = pick && !same && (!current || gone || !linked(current.machine) || pick.score > scoreOf(job, current.url, current.model, server?.kind, memory))
      if (better) {
        if (job === 'chat') Object.assign(fields, { provider: 'machine', machine: pick.machine, baseUrl: pick.url, model: pick.model })
        else Object.assign(fields, { [`${job}Machine`]: pick.machine, [`${job}BaseUrl`]: pick.url, [`${job}Model`]: pick.model, ...(job === 'speech' ? { speechVoice: pick.voice ?? '' } : {}) })
        auto.add(job)
      } else if (current && (!known(current.machine) || (gone && linked(current.machine)))) {
        // Its machine was removed, or it's linked and the model isn't one to use there (a gateway's), and no other machine
        // has one: the job is open again.
        if (job === 'chat') Object.assign(fields, { provider: 'off', machine: '', baseUrl: '', model: '' })
        else Object.assign(fields, { [`${job}Machine`]: '', [`${job}BaseUrl`]: '', [`${job}Model`]: '', ...(job === 'speech' ? { speechVoice: '' } : {}) })
        auto.delete(job)
      }
    }
    if (!Object.keys(fields).length) return
    await this.set({ ...fields, autoJobs: [...auto] } as Partial<BrainSettings>, 'hub')
  }

  private made: Made = {}

  private changed() {
    this.version++
    const now = this.get()
    const made: Made = {}
    const key = this.apiKey()
    const addressFromEnv = 'baseUrl' in this.fixed.fields
    const local = (address: string) => !now.localOnly || onOwnNetwork(address)
    const notLocal = (address: string) => `Local AI only is on, and ${hostOf(address)} isn’t on the hub’s own network.`
    if (now.provider === 'anthropic') {
      // Anthropic's own address, or a proxy the environment sets: never one saved in Settings.
      const baseURL = addressFromEnv ? now.baseUrl || undefined : undefined
      if (now.localOnly && !(baseURL && onOwnNetwork(baseURL))) made.needs = 'Local AI only is on, and Claude runs at Anthropic: choose a server of your own.'
      else if (!key.key) made.needs = 'Its Anthropic key.'
      else made.model = new ClaudeModel({ model: now.model || defaultModel, apiKey: key.key, baseURL })
    } else if (now.provider === 'machine') {
      const via = this.via(now.machine, now.baseUrl)
      if (typeof via === 'string') made.needs = via
      else if (!now.baseUrl) made.needs = 'A server on that machine.'
      else if (!now.model) made.needs = 'The name of the model on it.'
      else if (now.localOnly && via.gateway) made.needs = cloudGateway
      else made.model = new OpenAICompatibleModel({ baseURL: now.baseUrl, model: now.model, apiKey: key.key, via })
    } else if (now.provider === 'openai') {
      if (!now.baseUrl) made.needs = 'The address of the server.'
      else if (!now.model) made.needs = 'The name of the model on the server.'
      else if (!local(now.baseUrl)) made.needs = notLocal(now.baseUrl)
      else if (key.fromEnv && !addressFromEnv) made.needs = `The key set by ${variables.apiKey} only goes to the address ${variables.baseUrl} sets: set that too, or save a key here.`
      else made.model = new OpenAICompatibleModel({ baseURL: now.baseUrl, model: now.model, apiKey: key.key })
    }
    // A server for a job: its address and model given, its key only where it was meant to go, on the network allowed.
    const server = (name: 'embeddings' | 'transcription' | 'speech', what: string): { base: string; model: string; key?: string; via?: Via; machine?: string } | string | undefined => {
      const base = now[`${name}BaseUrl`]
      const model = now[`${name}Model`]
      const machine = now[`${name}Machine`]
      if (machine) {
        // On one of your machines: on its own network by being there.
        const via = this.via(machine, base)
        if (typeof via === 'string') return via
        if (!base) return `A ${what} server on that machine.`
        if (now.localOnly && via.gateway) return cloudGateway
        if (base === sayServer) return name === 'speech' ? { base, model, via, machine, key: undefined } : `macOS’s voices don’t do ${what}.`
        if (!model) return `The name of the ${what} model.`
        return { base, model, via, machine, key: this.serverKey(`${name}Key`).key }
      }
      if (base === sayServer) return 'macOS’s voices are reached through one of your machines.'
      if (!base && !model) return undefined
      if (!base) return `The address of the ${what} server.`
      if (!model) return `The name of the ${what} model.`
      if (!local(base)) return notLocal(base)
      const serverKey = this.serverKey(`${name}Key`)
      if (serverKey.fromEnv && !(`${name}BaseUrl` in this.fixed.fields)) return `The key set by ${variables[`${name}Key`]} only goes to the address ${variables[`${name}BaseUrl`]} sets.`
      return { base, model, key: serverKey.key }
    }
    const embeddings = server('embeddings', 'embeddings')
    if (typeof embeddings === 'string') made.embeddingsNeeds = embeddings
    else if (embeddings) made.embedder = new OpenAICompatibleEmbedder({ baseURL: embeddings.base, model: embeddings.model, apiKey: embeddings.key, via: embeddings.via })
    const transcription = server('transcription', 'transcription')
    if (typeof transcription === 'string') made.transcriptionNeeds = transcription
    else if (transcription) made.transcriber = new OpenAICompatibleTranscriber({ baseURL: transcription.base, model: transcription.model, apiKey: transcription.key, via: transcription.via })
    const speech = server('speech', 'speech')
    if (typeof speech === 'string') made.speechNeeds = speech
    else if (speech?.base === sayServer && speech.machine && this.machines) made.speaker = this.machines.speaker(speech.machine, now.speechVoice || speech.model)
    // One voice, always: a model that has several (Qwen's CustomVoice) picks another for each request without one.
    else if (speech) made.speaker = new OpenAICompatibleSpeaker({ baseURL: speech.base, model: speech.model, voice: now.speechVoice || defaultVoice(speech.model) || undefined, apiKey: speech.key, via: speech.via })
    this.made = made
    this.gatewaysSeen = this.gatewaysInUse()
  }

  private machines?: BrainMachines
  private gatewaysSeen = ''

  /** Whether a server on one of your machines is a gateway to a cloud, as far as the machine has said what it serves. */
  private gatewayAt(machine: string, url: string) {
    const found = this.machines?.get(machine)
    const server = found?.servers?.find((s) => s.url === url)
    return !!server && isGateway(server, found?.facts?.memoryGb)
  }

  /** Which jobs use a gateway now: a machine says what it serves after it links, so this can change under a setting. */
  private gatewaysInUse() {
    const now = this.get()
    return [
      now.provider === 'machine' && this.gatewayAt(now.machine, now.baseUrl) ? 'chat' : '',
      ...(['embeddings', 'transcription', 'speech'] as const).map((job) => (now[`${job}Machine`] && this.gatewayAt(now[`${job}Machine`], now[`${job}BaseUrl`]) ? job : '')),
    ].join(' ')
  }

  /**
   * A model on a gateway on one of your machines, made a job's: an admin's choice, never the hub's. It runs in a
   * cloud, so Local AI only refuses it. A gateway lists more than it can reach, and may take a name it doesn't list
   * (a deployment's), so any name is taken and the model is asked one short thing first: the job stays as it was when
   * nothing comes back.
   */
  async useGateway(job: 'chat' | 'embeddings', machine: string, url: string, model: string) {
    if (jobFields[job].some((name) => name in this.fixed.fields)) throw new Refusal('That job is set on the hub by its environment, so it can’t be changed here.')
    const gateway = this.machines ? gateways(this.machines.list()).find((g) => g.machine === machine && g.url === url) : undefined
    if (!gateway) throw new Refusal('That gateway isn’t on a machine linked to the hub right now.')
    if (/\s/.test(model)) throw new Refusal('A model’s name has no spaces in it.')
    if (this.get().localOnly) throw new Refusal('Local AI only is on, and that model runs in a cloud. Turn it off to use a model through a gateway.')
    const via = this.via(machine, url)
    if (typeof via === 'string') throw new Refusal(via)
    try {
      await tryModel(job, { baseURL: url, model, via })
    } catch (err) {
      if (!(err instanceof BrainUnavailable)) throw err
      throw new Refusal(`${model} didn’t answer through ${gateway.machineName}. ${err.message}${/[.!?]$/.test(err.message) ? '' : '.'} Nothing was changed.`)
    }
    return this.set(job === 'chat' ? { provider: 'machine', machine, baseUrl: url, model } : { embeddingsMachine: machine, embeddingsBaseUrl: url, embeddingsModel: model })
  }

  /** What each job needs, said again: a machine was added or removed. */
  refresh() {
    this.changed()
  }

  /** The hub's machines, for the jobs served by one of them: and, as they come and go, what each job uses. */
  useMachines(machines: BrainMachines) {
    this.machines = machines
    machines.onChange(() => {
      void this.autoPick(machines.list())
      // A server that turned out a gateway (or stopped being one): what each job needs is said again.
      if (this.gatewaysInUse() !== this.gatewaysSeen) this.changed()
    })
    this.changed()
  }

  /** How an agent's model on one of the hub's machines is reached, or why it can't be, in words. */
  machineVia(id: string, url: string): Via | string {
    const via = this.via(id, url)
    if (typeof via === 'string') return via
    const machine = this.machines?.get(id)
    // Said here, by name, rather than by the machine when it's asked: a server that went away, or an address mistyped.
    const serves = (machine?.servers ?? []).some((s) => url === s.url || url.startsWith(`${s.url}/`))
    if (machine?.servers?.length && !serves) return `${via.name} has no server at that address. It serves ${machine.servers.map((s) => s.url).slice(0, 6).join(', ')}.`
    return via
  }

  /** How a job reaches one of your machines, or why it can't. */
  private via(id: string, url = ''): Via | string {
    if (!id) return 'Choose one of your machines.'
    if (!this.machines) return 'This hub has no machines.'
    if (!this.machines.get(id)) return 'That machine was removed from the hub.'
    return { name: this.machines.name(id), fetch: this.machines.fetchVia(id), ...(this.gatewayAt(id, url) ? { gateway: true } : {}) }
  }

  /** The model to sum up and answer with, when there is one. */
  model(): BrainModel | undefined {
    return this.tests ? this.tests.model : this.made.model
  }

  /** The embeddings model, when there is one. */
  embedder(): Embedder | undefined {
    return this.tests ? this.tests.embedder : this.made.embedder
  }

  /** The transcription model, when there is one. */
  transcriber(): Transcriber | undefined {
    return this.tests ? this.tests.transcriber : this.made.transcriber
  }

  /** The speech model, when there is one. */
  speaker(): Speaker | undefined {
    return this.tests ? this.tests.speaker : this.made.speaker
  }

  /** For tests: models of their own, standing in. */
  useForTests(model?: BrainModel, embedder?: Embedder, transcriber?: Transcriber, speaker?: Speaker) {
    this.tests = { model, embedder, transcriber, speaker }
    this.version++
  }

  private tests?: { model?: BrainModel; embedder?: Embedder; transcriber?: Transcriber; speaker?: Speaker }
}

function hostOf(address: string) {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}
