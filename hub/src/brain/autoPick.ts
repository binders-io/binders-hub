import { sayServer, type MachineView } from './machines.ts'

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
const notChat = /rerank|guard|moderation|(^|[^a-z])clip|siglip|ocr|nougat|layout|(^|[^a-z])vae|diffusion|flux|sdxl|(^|[^a-z])sd-|stable-diffusion/i

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
export function scoreOf(job: Job, url: string, model: string, kind = '', memoryGb?: number) {
  if (job === 'transcription') return hearing(model)
  if (job === 'speech') return url === sayServer ? 1 : 2
  return 1 + (job === 'chat' ? chatSize(model, kind, memoryGb) : sizeOf(model))
}

/** The best pick for each job across the machines linked now. */
export function bestPicks(machines: MachineView[]): Partial<Record<Job, Pick>> {
  const best: Partial<Record<Job, Pick>> = {}
  const offer = (job: Job, pick: Pick) => {
    if (!best[job] || pick.score > best[job]!.score) best[job] = pick
  }
  for (const machine of machines) {
    if (!machine.online) continue
    for (const server of machine.servers ?? []) {
      if (server.needsKey) continue
      if (server.url === sayServer) {
        const voice = macVoice(server.models)
        // A Mac's own voices: the last resort for reading answers out, after a speech server.
        if (voice) offer('speech', { machine: machine.id, url: sayServer, model: '', voice, score: 1 })
        continue
      }
      for (const model of server.models) {
        for (const job of jobsOf(model, server.kind)) {
          if (job === 'chat') offer('chat', { machine: machine.id, url: server.url, model, score: 1 + chatSize(model, server.kind, machine.facts?.memoryGb) })
          else if (job === 'embeddings') offer('embeddings', { machine: machine.id, url: server.url, model, score: 1 + sizeOf(model) })
          else if (job === 'transcription') offer('transcription', { machine: machine.id, url: server.url, model, score: hearing(model) })
          else if (job === 'speech') offer('speech', { machine: machine.id, url: server.url, model, voice: /kokoro/i.test(`${model} ${server.kind}`) ? 'af_heart' : /phonon/i.test(model) ? 'default' : '', score: 2 })
        }
      }
    }
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
  // First, what's already downloaded on a machine and only needs serving: mlx-audio for audio on a Mac, LM Studio for
  // its own models. Offered when it would do better than what's in use: Kokoro or Qwen on disk over a Mac's own voices.
  // One runtime serves every model it can there: one offer, for each job it covers.
  const taken = new Set<Job>()
  for (const machine of machines.filter((m) => m.online)) {
    for (const runtime of ['mlx-audio', 'lmstudio'] as const) {
      if (!machine.runtimes?.includes(runtime)) continue
      const models: Partial<Record<Job, string>> = {}
      for (const job of open) {
        if (taken.has(job)) continue
        const fits = (machine.onDisk ?? []).filter((m) => (runtime === 'mlx-audio' ? (m.source === 'hf' || m.source === 'dir') && (job === 'speech' || job === 'transcription') : m.source === 'lmstudio' && (job === 'chat' || job === 'embeddings')) && jobsOf(m.name, '').includes(job))
        const best = fits.sort((a, b) => scoreOf(job, '', b.name) - scoreOf(job, '', a.name))[0]
        if (best && scoreOf(job, '', best.name) > (picks[job]?.score ?? 0)) models[job] = best.name
      }
      const jobs = Object.keys(models) as Job[]
      if (!jobs.length) continue
      out.push({ action: 'serve', runtime, jobs, machine: machine.id, model: models[jobs[0]]!, models })
      for (const job of jobs) taken.add(job)
      wanted = wanted.filter((job) => !jobs.includes(job))
    }
  }
  const withOllama = machines.filter((m) => m.online && m.servers?.some((s) => s.kind === 'ollama'))
    .sort((a, b) => (b.facts?.memoryGb ?? 0) - (a.facts?.memoryGb ?? 0))
  // A Mac that runs mlx-audio gets audio models from Hugging Face: Parakeet, as the Binders app uses, and Kokoro.
  const audioMac = machines.find((m) => m.online && m.runtimes?.includes('mlx-audio') && m.runtimes.includes('hf'))
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

