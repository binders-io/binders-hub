import { sayServer, type MachineServer, type MachineView } from './machines.ts'

// What the hub chooses for each of the brain's jobs from your machines, when you haven't chosen: the biggest chat model
// on any of them, an embeddings model, a transcription model (Parakeet, Canary or the largest whisper), and a voice
// (Kokoro or another speech server's, else a Mac's own). Told apart by their names, as model servers say no more.

export type Job = 'chat' | 'embeddings' | 'transcription' | 'speech'
export const jobs: Job[] = ['chat', 'embeddings', 'transcription', 'speech']

export interface Pick {
  machine: string
  /** The server on it, or "say:" for macOS's voices. */
  url: string
  model: string
  /** For speech: the voice. */
  voice?: string
  /** How good a pick it is, against another for the same job: bigger is better. */
  score: number
}

const embedding = /embed|(^|[^a-z])bge|(^|[^a-z])e5([^a-z]|$)|(^|[^a-z])gte([^a-z]|$)|minilm|mxbai|arctic-embed|jina-emb|retriev/i
const transcription = /whisper|parakeet|canary|wav2vec|sensevoice|moonshine|voxtral|(^|[^a-z])asr([^a-z]|$)/i
const speech = /kokoro|(^|[^a-z])tts([^a-z]|$)|piper|orpheus|xtts|melo|parler|chatterbox|outetts|sesame|csm-|zonos|phonon/i
/** Audio models that both write down and read out: Liquid's LFM audio. */
const audioBoth = /lfm\d*-audio/i
const notChat = /rerank|guard|moderation|(^|[^a-z])clip|siglip|ocr|nougat|layout|(^|[^a-z])vae|diffusion|flux|sdxl|(^|[^a-z])sd-|stable-diffusion|image|video|music|latentsync|ace-step/i
/**
 * Speech models that need more than words to speak in one voice: Qwen's Base clones a voice from a sample of it, and its
 * VoiceDesign makes one from a description. Without either, each request comes out in a different voice.
 */
const needsSample = /tts.*[-_](base|voice-?design)([-_]|$)/i

/** Kokoro's voices, the most natural first; its name says how each sounds (American or British, female or male). */
export const kokoroVoices = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_fenrir', 'am_puck', 'am_adam', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis']
/** The speakers of Qwen's CustomVoice models: Aiden and Ryan speak English natively, the others with their own accents. */
export const qwenSpeakers = ['Aiden', 'Ryan', 'Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ono_Anna', 'Sohee']

/** The voices a speech model has, when they're known: Kokoro's, Qwen CustomVoice's, or a Mac's own (`voices`). */
export function voicesOf(model: string, kind: string, voices: string[] = []): string[] | undefined {
  if (kind === 'say') return voices.length ? voices : undefined
  if (/kokoro/i.test(`${model} ${kind}`)) return kokoroVoices
  if (/tts.*custom/i.test(model)) return qwenSpeakers
  return undefined
}

/** The voice a speech model reads in when none is chosen: one voice, always, so it doesn't change between sentences. */
export function defaultVoice(model: string, kind = '') {
  if (/kokoro/i.test(`${model} ${kind}`)) return 'af_heart'
  if (/tts.*custom/i.test(model)) return 'Aiden'
  if (/phonon/i.test(model)) return 'default'
  return ''
}

/** Helpers that come with speech models but aren't one: words to sounds, voice activity, codecs. */
const helper = /g2p|phonemi[sz]|(^|[^a-z])vad([^a-z]|$)|silero|tokenizer|codec/i

/**
 * Names of models that live in a cloud (OpenAI's, Azure's, Anthropic's, Google's, xAI's…): a server listing them is a
 * gateway to one, such as a LiteLLM proxy, not a model on the machine.
 */
const cloudName = /^(gpt-(3|35|4|5)|gpt-4o|chatgpt|o[134](-|$)|dall-e|text-embedding-(ada|3)|text-davinci|davinci|babbage|whisper-1|tts-1|claude-|gemini-|command-r|grok-|sonar)/i
/** Ollama's models that run in Ollama's cloud: gpt-oss:120b-cloud, glm-4.6:cloud. */
const ollamaCloud = /(^|[:-])cloud$/i
/** Servers that list what's downloaded on the machine, loaded or not: some of theirs may be too big to load there. */
const downloadedKinds = new Set(['ollama', 'lmstudio', 'binders'])

/** Whether a model could be on a machine at all: none that wouldn't fit in its memory, even at four bits. */
export function fits(model: string, memoryGb?: number) {
  const billions = sizeOf(model)
  if (!memoryGb || !billions) return true
  const bytes = /bf16|fp16|(^|[^a-z])f16/i.test(model) ? 2 : /fp8|8bit|int8|q8/i.test(model) ? 1 : 0.5
  return billions * bytes <= memoryGb * 1.1
}

/**
 * A server that lists cloud models, or a catalogue of models no machine like this could hold: a gateway to somewhere
 * else, which the hub never chooses from. Its kind doesn't clear it, as a kind is guessed from a port or from what the
 * first model says owns it (NVIDIA, for a gateway listing Nemotron first); only the daemon's own lists never are one.
 */
export function isGateway(server: { kind: MachineServer['kind']; models: MachineServer['models'] }, memoryGb?: number) {
  if (server.kind === 'binders' || server.kind === 'say' || !server.models.length) return false
  const cloud = server.models.filter((m) => cloudName.test(m.split('/').pop() ?? m)).length
  if (cloud >= 2) return true
  // Ollama and LM Studio list what's downloaded, and a server running one model (vLLM, TensorFold) may spread it over
  // several machines: neither is a catalogue.
  if (downloadedKinds.has(server.kind) || server.models.length < 4) return false
  const impossible = server.models.filter((m) => !fits(m, memoryGb)).length
  return (cloud + impossible) / server.models.length >= 0.3
}

/** Billions of parameters, from a model's name: qwen3:32b, Llama-3.3-70B-Instruct, gpt-oss-120b, mixtral-8x7b. */
export function sizeOf(model: string) {
  const experts = /(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model)
  if (experts) return Number(experts[1]) * Number(experts[2])
  const plain = /(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model)
  return plain ? Number(plain[1]) : 0
}

/**
 * A chat model's size, for choosing between them: from its name (qwen3:32b) or, with none there (GLM-5.3), from the
 * machine serving it, when that's a server that runs one big model (vLLM, NIM, TensorFold, SGLang): about three
 * quarters of its memory, in billions. Ollama's and LM Studio's many models, without a size, count as small.
 */
export function chatSize(model: string, kind: string, memoryGb?: number) {
  const named = sizeOf(model)
  // A machine's own list of downloaded models ('binders') has many: each counts by its name.
  if (named || !memoryGb || kind === 'ollama' || kind === 'lmstudio' || kind === 'binders') return named
  return Math.round(memoryGb * 0.75)
}

/** Which jobs a model is for: most do one, an audio model like LFM3-Audio both writing down and reading out. */
export function jobsOf(model: string, kind: string): Job[] {
  if (kind !== 'say' && audioBoth.test(model)) return ['transcription', 'speech']
  const job = jobOf(model, kind)
  return job ? [job] : []
}

/** Which job a model is for, by its name and its server. */
export function jobOf(model: string, kind: string): Job | undefined {
  if (kind === 'say') return 'speech'
  if (helper.test(model) || needsSample.test(model)) return undefined
  if (kind === 'kokoro' || speech.test(model)) return 'speech'
  if (transcription.test(model)) return 'transcription'
  if (embedding.test(model)) return 'embeddings'
  if (notChat.test(model)) return undefined
  return 'chat'
}

/** How good a transcription model is: Parakeet and Canary, then whisper by size. */
function hearing(model: string) {
  if (/parakeet|canary/i.test(model)) return 5
  if (/large-v3-turbo|turbo/i.test(model)) return 3.5
  if (/large/i.test(model)) return 4
  if (/medium/i.test(model)) return 2
  if (/small|distil/i.test(model)) return 1
  return 0.5
}

/** The voice a Mac reads answers out in, of those it has: one of the natural-sounding ones first. */
export function macVoice(voices: string[]) {
  return voices.find((v) => /\((Premium|Enhanced)\)/.test(v) && /^(Ava|Zoe|Samantha|Evan|Nathan|Tom|Allison|Susan|Joelle|Noelle)/.test(v))
    ?? ['Samantha', 'Ava', 'Daniel', 'Karen', 'Moira'].find((v) => voices.includes(v))
    ?? voices[0]
}

/** How good a model is for a job, as bestPicks scores it: to tell whether a newcomer is better than what's in use. */
/**
 * How good a voice is for reading answers out: Kokoro (quick, natural), then Qwen's CustomVoice, Phonon, any other
 * speech model, a Base model (which wants a voice to clone), and a Mac's own voices last.
 */
function speaking(url: string, model: string) {
  if (url === sayServer) return 1
  if (/kokoro/i.test(model)) return 2.6
  if (/tts.*custom/i.test(model)) return 2.4
  if (/phonon/i.test(model)) return 2.3
  if (/(^|[^a-z])base([^a-z]|$)/i.test(model)) return 1.5
  return 2
}

export function scoreOf(job: Job, url: string, model: string, kind = '', memoryGb?: number) {
  if (job === 'transcription') return hearing(model)
  if (job === 'speech') return speaking(url, model)
  return 1 + (job === 'chat' ? chatSize(model, kind, memoryGb) : sizeOf(model))
}

/** A model one of your machines can do a job with: where it is, what serves it, and whether it's running or loads when used. */
export interface Candidate extends Pick {
  machineName: string
  kind: string
  state: 'running' | 'on-demand' | 'voice'
  /** For speech: the voices it can read in, when they're known, for Settings to offer. */
  voices?: string[]
}

/** Every model your linked machines can do each job with, best first. */
export function candidates(machines: MachineView[]): Record<Job, Candidate[]> {
  const out: Record<Job, Candidate[]> = { chat: [], embeddings: [], transcription: [], speech: [] }
  for (const machine of machines) {
    if (!machine.online) continue
    const base = { machine: machine.id, machineName: machine.name }
    for (const server of machine.servers ?? []) {
      // A gateway to a cloud isn't a model on the machine: never one to choose.
      if (server.needsKey || isGateway(server, machine.facts?.memoryGb)) continue
      if (server.url === sayServer) {
        const voice = macVoice(server.models)
        // A Mac's own voices: one row, the voice it'd read in.
        if (voice) out.speech.push({ ...base, url: sayServer, model: '', voice, voices: server.models.slice(0, 200), score: 1, kind: 'say', state: 'voice' })
        continue
      }
      // Downloaded models (the daemon's, Ollama's, LM Studio's) load when they're used: running only when the daemon says
      // so. A server that lists the one it serves is running it.
      const downloaded = downloadedKinds.has(server.kind)
      const runningHere = (model: string) => !downloaded || (machine.running ?? []).some((r) => r.model === model)
      for (const model of server.models) {
        // Nothing that runs in a cloud, nor a download the machine couldn't load.
        if (ollamaCloud.test(model)) continue
        if ((downloaded || server.models.length > 1) && !fits(model, machine.facts?.memoryGb)) continue
        for (const job of jobsOf(model, server.kind)) {
          const state = runningHere(model) ? 'running' : 'on-demand'
          const score = job === 'chat' ? 1 + chatSize(model, server.kind, machine.facts?.memoryGb) : scoreOf(job, server.url, model)
          const voice = job === 'speech' ? defaultVoice(model, server.kind) : undefined
          const voices = job === 'speech' ? voicesOf(model, server.kind) : undefined
          out[job].push({ ...base, url: server.url, model, ...(voice !== undefined ? { voice } : {}), ...(voices ? { voices } : {}), score, kind: server.kind, state })
        }
      }
    }
  }
  for (const job of jobs) out[job].sort((a, b) => b.score - a.score)
  return out
}

/** The best pick for each job across the machines linked now. */
export function bestPicks(machines: MachineView[]): Partial<Record<Job, Pick>> {
  const all = candidates(machines)
  const best: Partial<Record<Job, Pick>> = {}
  for (const job of jobs) {
    const top = all[job][0]
    if (top) best[job] = { machine: top.machine, url: top.url, model: top.model, ...(top.voice !== undefined ? { voice: top.voice } : {}), score: top.score }
  }
  return best
}

/**
 * What the hub offers for a job none of your machines serves: a runtime started to serve a model already downloaded on
 * one ("serve"), or a model downloaded ("pull": into Ollama, or from Hugging Face for mlx-audio).
 */
export interface Offer {
  action: 'serve' | 'pull'
  /** The jobs it would do: an audio model, or a runtime serving several models, can do two. */
  jobs: Job[]
  machine: string
  /** The model, for the first of its jobs; `models` says which for each when they differ. */
  model: string
  models?: Partial<Record<Job, string>>
  /** Its download, roughly: "about 20 GB". */
  size?: string
  source?: 'ollama' | 'hf'
  runtime?: 'mlx-audio' | 'lmstudio'
}

/** Chat models by the memory of the machine they'd run on: the biggest that fits well. */
const chatByMemory: [number, string, string][] = [
  [96, 'gpt-oss:120b', 'about 65 GB'],
  [40, 'qwen3:32b', 'about 20 GB'],
  [20, 'gpt-oss:20b', 'about 14 GB'],
  [10, 'qwen3:8b', 'about 5 GB'],
  [0, 'qwen3:4b', 'about 2.5 GB'],
]

/** Whether an Ollama version is at least this one. */
function atLeast(version: string | undefined, wanted: string) {
  const have = (version ?? '').split('.').map(Number)
  const need = wanted.split('.').map(Number)
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i]
  }
  return true
}

/**
 * What to download for each open job no machine can do, into Ollama on a machine that has it: a chat model sized to the
 * machine with the most memory; EmbeddingGemma; LFM3-Audio for writing down (and reading out); Phonon for a Mac's voice.
 * One download that does two jobs is offered once.
 */
export function offers(machines: MachineView[], open: Job[]): Offer[] {
  const picks = bestPicks(machines)
  const out: Offer[] = []
  let wanted = open.filter((job) => !picks[job])
  const withOllama = machines.filter((m) => m.online && m.servers?.some((s) => s.kind === 'ollama'))
    .sort((a, b) => (b.facts?.memoryGb ?? 0) - (a.facts?.memoryGb ?? 0))
  // A Mac that runs mlx-audio gets audio models from Hugging Face: Parakeet, as the Binders app uses, and Kokoro.
  // (Its daemon loads mlx-audio when one of them is used: a Mac with Apple silicon, and a way to download.)
  const audioMac = machines.find((m) => m.online && /darwin arm64/.test(m.platform ?? '') && m.runtimes?.includes('hf'))
  if (audioMac) {
    for (const [job, model, size] of [['transcription', 'mlx-community/parakeet-tdt-0.6b-v3', 'about 1.2 GB'], ['speech', 'mlx-community/Kokoro-82M-bf16', 'about 200 MB']] as const) {
      if (!wanted.includes(job)) continue
      out.push({ action: 'pull', source: 'hf', jobs: [job], machine: audioMac.id, model, size })
      wanted = wanted.filter((j) => j !== job)
    }
  }
  const biggest = withOllama[0]
  if (!biggest) return out
  const add = (job: Job, machine: string, model: string, size: string) => {
    const same = out.find((o) => o.action === 'pull' && o.machine === machine && o.model === model)
    if (same) same.jobs.push(job)
    else out.push({ action: 'pull', source: 'ollama', jobs: [job], machine, model, size })
  }
  for (const job of wanted) {
    if (job === 'chat') {
      const [, model, size] = chatByMemory.find(([gb]) => (biggest.facts?.memoryGb ?? 8) >= gb)!
      add('chat', biggest.id, model, size)
    } else if (job === 'embeddings') {
      add('embeddings', biggest.id, 'embeddinggemma', 'about 620 MB')
    } else if (job === 'transcription') {
      add('transcription', biggest.id, 'lfm3-audio:2b', 'about 2 GB')
    } else {
      // A Mac's own voice model, light and Apache-licensed, where its Ollama can run it; else the audio model.
      const mac = withOllama.find((m) => /darwin arm64/.test(m.platform ?? '') && atLeast(m.servers?.find((s) => s.kind === 'ollama')?.version, '0.40.9'))
      if (mac) add('speech', mac.id, 'phonon:en', 'about 104 MB')
      else add('speech', biggest.id, 'lfm3-audio:2b', 'about 2 GB')
    }
  }
  return out
}

