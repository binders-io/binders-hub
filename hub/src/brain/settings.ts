import type { KV } from '../kv.ts'
import type { Sealer } from '../secrets.ts'
import { Refusal } from '../auth.ts'
import { ClaudeModel, OpenAICompatibleEmbedder, OpenAICompatibleModel, OpenAICompatibleSpeaker, OpenAICompatibleTranscriber, type BrainModel, type Embedder, type Speaker, type Transcriber } from './models.ts'

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
//   BRAIN_LOCAL_ONLY        1: every model on the hub's own network, never a cloud provider
// Off, the hub still finds passages by their words; with a model it sums up what's captured and answers questions;
// with embeddings it also finds passages by what they mean.
//
// A key goes only where it was meant to: one set in the environment only to an address the environment sets too (or
// to Anthropic's own), and one saved in Settings is cleared when the provider changes, so it never follows to a server
// it wasn't for. Without a key the hub makes no Claude client at all, rather than send whatever else the SDK finds.

export type BrainProvider = 'off' | 'anthropic' | 'openai'

export interface BrainSettings {
  provider: BrainProvider
  model: string
  baseUrl: string
  /** Sum up dictations, conversations and meetings sent to the hub, as they arrive. */
  summarize: boolean
  embeddingsBaseUrl: string
  embeddingsModel: string
  transcriptionBaseUrl: string
  transcriptionModel: string
  speechBaseUrl: string
  speechModel: string
  speechVoice: string
  /** Every model on the hub's own network: no cloud provider, and no address outside it. */
  localOnly: boolean
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
  provider: 'off', model: '', baseUrl: '', summarize: true, embeddingsBaseUrl: '', embeddingsModel: '',
  transcriptionBaseUrl: '', transcriptionModel: '', speechBaseUrl: '', speechModel: '', speechVoice: '', localOnly: false,
}

const variables = {
  provider: 'BRAIN_PROVIDER',
  model: 'BRAIN_MODEL',
  baseUrl: 'BRAIN_BASE_URL',
  summarize: 'BRAIN_SUMMARIZE',
  embeddingsBaseUrl: 'EMBEDDINGS_BASE_URL',
  embeddingsModel: 'EMBEDDINGS_MODEL',
  transcriptionBaseUrl: 'TRANSCRIPTION_BASE_URL',
  transcriptionModel: 'TRANSCRIPTION_MODEL',
  speechBaseUrl: 'SPEECH_BASE_URL',
  speechModel: 'SPEECH_MODEL',
  speechVoice: 'SPEECH_VOICE',
  localOnly: 'BRAIN_LOCAL_ONLY',
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
    if (!['off', 'anthropic', 'openai'].includes(fields.provider)) throw new Refusal('The brain is off, Anthropic, or a server that speaks OpenAI’s API.')
    out.provider = fields.provider
  }
  if (fields.model !== undefined) {
    const model = String(fields.model).trim()
    if (model.length > 200 || /\s/.test(model)) throw new Refusal('A model’s name is one word, like claude-opus-5-5.')
    out.model = model
  }
  if (fields.baseUrl !== undefined) out.baseUrl = checkedUrl(fields.baseUrl, 'The model’s server')
  if (fields.summarize !== undefined) out.summarize = Boolean(fields.summarize)
  if (fields.embeddingsBaseUrl !== undefined) out.embeddingsBaseUrl = checkedUrl(fields.embeddingsBaseUrl, 'The embeddings server')
  if (fields.embeddingsModel !== undefined) {
    const model = String(fields.embeddingsModel).trim()
    if (model.length > 200 || /\s/.test(model)) throw new Refusal('An embeddings model’s name is one word.')
    out.embeddingsModel = model
  }
  if (fields.transcriptionBaseUrl !== undefined) out.transcriptionBaseUrl = checkedUrl(fields.transcriptionBaseUrl, 'The transcription server')
  if (fields.speechBaseUrl !== undefined) out.speechBaseUrl = checkedUrl(fields.speechBaseUrl, 'The speech server')
  for (const name of ['transcriptionModel', 'speechModel', 'speechVoice'] as const) {
    if (fields[name] === undefined) continue
    const value = String(fields[name]).trim()
    if (value.length > 200 || /\s/.test(value)) throw new Refusal('A model’s or voice’s name is one word.')
    out[name] = value
  }
  if (fields.localOnly !== undefined) out.localOnly = Boolean(fields.localOnly)
  return out
}

function fromEnv(env: Record<string, string | undefined>) {
  const fields: Partial<BrainSettings> = {}
  if (env[variables.provider]) fields.provider = env[variables.provider] as BrainProvider
  if (env[variables.model]) fields.model = env[variables.model]
  if (env[variables.baseUrl]) fields.baseUrl = env[variables.baseUrl]
  if (env[variables.summarize]) fields.summarize = !['0', 'off', 'false', 'no'].includes(env[variables.summarize]!.toLowerCase())
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

  /** Changes settings; a key given as '' is cleared, one left out is kept. */
  async set(fields: Partial<BrainSettings> & Partial<Record<KeyName, string>>) {
    const { apiKey, embeddingsKey, transcriptionKey, speechKey, ...rest } = fields
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
    for (const [name, value] of [['apiKey', apiKey], ['embeddingsKey', embeddingsKey], ['transcriptionKey', transcriptionKey], ['speechKey', speechKey]] as const) {
      if (value === undefined) continue
      const key = value.trim()
      if (key.length > 500 || /\s/.test(key)) throw new Refusal('A key is one line with no spaces.')
      if (key) next[name] = this.sealer.seal(key)
      else delete next[name]
    }
    this.stored = next
    await this.kv.set('brain', JSON.stringify(this.stored))
    this.changed()
    return this.view()
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
    } else if (now.provider === 'openai') {
      if (!now.baseUrl) made.needs = 'The address of the server.'
      else if (!now.model) made.needs = 'The name of the model on the server.'
      else if (!local(now.baseUrl)) made.needs = notLocal(now.baseUrl)
      else if (key.fromEnv && !addressFromEnv) made.needs = `The key set by ${variables.apiKey} only goes to the address ${variables.baseUrl} sets: set that too, or save a key here.`
      else made.model = new OpenAICompatibleModel({ baseURL: now.baseUrl, model: now.model, apiKey: key.key })
    }
    // A server for a job: its address and model given, its key only where it was meant to go, on the network allowed.
    const server = (name: 'embeddings' | 'transcription' | 'speech', what: string): { base: string; model: string; key?: string } | string | undefined => {
      const base = now[`${name}BaseUrl`]
      const model = now[`${name}Model`]
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
    else if (embeddings) made.embedder = new OpenAICompatibleEmbedder({ baseURL: embeddings.base, model: embeddings.model, apiKey: embeddings.key })
    const transcription = server('transcription', 'transcription')
    if (typeof transcription === 'string') made.transcriptionNeeds = transcription
    else if (transcription) made.transcriber = new OpenAICompatibleTranscriber({ baseURL: transcription.base, model: transcription.model, apiKey: transcription.key })
    const speech = server('speech', 'speech')
    if (typeof speech === 'string') made.speechNeeds = speech
    else if (speech) made.speaker = new OpenAICompatibleSpeaker({ baseURL: speech.base, model: speech.model, voice: now.speechVoice || undefined, apiKey: speech.key })
    this.made = made
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
