import type { KV } from '../kv.ts'
import type { Sealer } from '../secrets.ts'
import { Refusal } from '../auth.ts'
import { ClaudeModel, OpenAICompatibleEmbedder, OpenAICompatibleModel, type BrainModel, type Embedder } from './models.ts'

// Which models the hub's brain uses, set by an admin in Settings, under Brain, and kept in the hub's store with its
// keys sealed. An environment variable set for one fixes it, as with the hub's other options:
//   BRAIN_PROVIDER          anthropic, openai (any server that speaks OpenAI's chat API) or off
//   BRAIN_MODEL             the model (claude-opus-5-5 for Anthropic)
//   BRAIN_BASE_URL          the server, for openai (e.g. http://localhost:11434/v1 for Ollama); for anthropic, a proxy
//                           in front of Anthropic's API, which only the environment can set
//   BRAIN_API_KEY           its key; for Anthropic, ANTHROPIC_API_KEY does as well
//   EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY   embeddings, from a server that speaks OpenAI's API
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
}

/** What Settings shows: the settings, whether each key is set (never the key), and what the environment fixes. */
export interface BrainView extends BrainSettings {
  apiKeySet: boolean
  /** The key in use is the hub's ANTHROPIC_API_KEY. */
  usesAnthropicKey: boolean
  embeddingsKeySet: boolean
  locked: Partial<Record<keyof BrainSettings | 'apiKey' | 'embeddingsKey', string>>
  /** What's in use, in words: "claude-opus-5-5 (Anthropic)", or undefined when off. */
  inUse?: string
  embeddingsInUse?: string
  /** What it still needs before it can be used, in words, when it's set to something but can't be used yet. */
  needs?: string
  embeddingsNeeds?: string
}

export const defaultModel = 'claude-opus-5-5'

const defaults: BrainSettings = { provider: 'off', model: '', baseUrl: '', summarize: true, embeddingsBaseUrl: '', embeddingsModel: '' }

const variables = {
  provider: 'BRAIN_PROVIDER',
  model: 'BRAIN_MODEL',
  baseUrl: 'BRAIN_BASE_URL',
  summarize: 'BRAIN_SUMMARIZE',
  embeddingsBaseUrl: 'EMBEDDINGS_BASE_URL',
  embeddingsModel: 'EMBEDDINGS_MODEL',
  apiKey: 'BRAIN_API_KEY',
  embeddingsKey: 'EMBEDDINGS_API_KEY',
} as const

interface Kept extends Partial<BrainSettings> {
  apiKey?: string
  embeddingsKey?: string
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
  return { fields: checked(fields), apiKey: env[variables.apiKey] || undefined, embeddingsKey: env[variables.embeddingsKey] || undefined, anthropicKey: env.ANTHROPIC_API_KEY || undefined }
}

interface Made {
  model?: BrainModel
  embedder?: Embedder
  needs?: string
  embeddingsNeeds?: string
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
      this.stored = { ...checked(raw), ...(raw.apiKey ? { apiKey: raw.apiKey } : {}), ...(raw.embeddingsKey ? { embeddingsKey: raw.embeddingsKey } : {}) }
    } catch {
      this.stored = {}
    }
    this.changed()
    return this
  }

  get(): BrainSettings {
    const { apiKey: _a, embeddingsKey: _e, ...stored } = this.stored
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
    if (this.fixed.embeddingsKey) return { key: this.fixed.embeddingsKey, fromEnv: true }
    return { key: this.open(this.stored.embeddingsKey), fromEnv: false }
  }

  view(): BrainView {
    const now = this.get()
    const locked: BrainView['locked'] = {}
    for (const key of Object.keys(this.fixed.fields) as (keyof BrainSettings)[]) locked[key] = variables[key]
    if (this.fixed.apiKey) locked.apiKey = variables.apiKey
    if (this.fixed.embeddingsKey) locked.embeddingsKey = variables.embeddingsKey
    return {
      ...now,
      apiKeySet: Boolean(this.apiKey().key),
      usesAnthropicKey: now.provider === 'anthropic' && !this.fixed.apiKey && !this.open(this.stored.apiKey) && Boolean(this.fixed.anthropicKey),
      embeddingsKeySet: Boolean(this.embeddingsKey().key),
      locked,
      ...(this.made.model ? { inUse: this.made.model.label } : {}),
      ...(this.made.embedder ? { embeddingsInUse: this.made.embedder.label } : {}),
      ...(this.made.needs ? { needs: this.made.needs } : {}),
      ...(this.made.embeddingsNeeds ? { embeddingsNeeds: this.made.embeddingsNeeds } : {}),
    }
  }

  /** Changes settings; a key given as '' is cleared, one left out is kept. */
  async set(fields: Partial<BrainSettings> & { apiKey?: string; embeddingsKey?: string }) {
    const { apiKey, embeddingsKey, ...rest } = fields
    const fixedField = Object.keys(rest).find((key) => key in this.fixed.fields) as keyof BrainSettings | undefined
    if (fixedField) throw new Refusal(`That one is set on the hub by ${variables[fixedField]}, so it can’t be changed here.`)
    if (apiKey !== undefined && this.fixed.apiKey) throw new Refusal(`The model’s key is set on the hub by ${variables.apiKey}, so it can’t be changed here.`)
    if (embeddingsKey !== undefined && this.fixed.embeddingsKey) throw new Refusal(`The embeddings key is set on the hub by ${variables.embeddingsKey}, so it can’t be changed here.`)
    const checkedFields = checked(rest)
    const next: Kept = { ...this.stored, ...checkedFields }
    // Another provider: its address, model and key were for the old one, and go with it unless given now.
    const before = this.get().provider
    if (checkedFields.provider !== undefined && checkedFields.provider !== before) {
      if (rest.baseUrl === undefined) next.baseUrl = ''
      if (rest.model === undefined) next.model = ''
      if (apiKey === undefined) delete next.apiKey
    }
    for (const [name, value] of [['apiKey', apiKey], ['embeddingsKey', embeddingsKey]] as const) {
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
    if (now.provider === 'anthropic') {
      // Anthropic's own address, or a proxy the environment sets: never one saved in Settings.
      const baseURL = addressFromEnv ? now.baseUrl || undefined : undefined
      if (!key.key) made.needs = 'Its Anthropic key.'
      else made.model = new ClaudeModel({ model: now.model || defaultModel, apiKey: key.key, baseURL })
    } else if (now.provider === 'openai') {
      if (!now.baseUrl) made.needs = 'The address of the server.'
      else if (!now.model) made.needs = 'The name of the model on the server.'
      else if (key.fromEnv && !addressFromEnv) made.needs = `The key set by ${variables.apiKey} only goes to the address ${variables.baseUrl} sets: set that too, or save a key here.`
      else made.model = new OpenAICompatibleModel({ baseURL: now.baseUrl, model: now.model, apiKey: key.key })
    }
    const embeddingsKey = this.embeddingsKey()
    if (now.embeddingsBaseUrl || now.embeddingsModel) {
      if (!now.embeddingsBaseUrl) made.embeddingsNeeds = 'The address of the embeddings server.'
      else if (!now.embeddingsModel) made.embeddingsNeeds = 'The name of the embeddings model.'
      else if (embeddingsKey.fromEnv && !('embeddingsBaseUrl' in this.fixed.fields)) made.embeddingsNeeds = `The key set by ${variables.embeddingsKey} only goes to the address ${variables.embeddingsBaseUrl} sets.`
      else made.embedder = new OpenAICompatibleEmbedder({ baseURL: now.embeddingsBaseUrl, model: now.embeddingsModel, apiKey: embeddingsKey.key })
    }
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

  /** For tests: models of their own, standing in. */
  useForTests(model?: BrainModel, embedder?: Embedder) {
    this.tests = { model, embedder }
    this.version++
  }

  private tests?: { model?: BrainModel; embedder?: Embedder }
}
