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
const transcription = /whisper|parakeet|canary|wav2vec|sensevoice|moonshine/i
const speech = /kokoro|(^|[^a-z])tts([^a-z]|$)|piper|orpheus|xtts|melo|parler|chatterbox|outetts|sesame|csm-|zonos/i
const notChat = /rerank|guard|moderation|(^|[^a-z])clip|siglip|ocr|nougat|layout|(^|[^a-z])vae|diffusion|flux|sdxl|(^|[^a-z])sd-|stable-diffusion/i

/** Billions of parameters, from a model's name: qwen3:32b, Llama-3.3-70B-Instruct, gpt-oss-120b, mixtral-8x7b. */
export function sizeOf(model: string) {
  const experts = /(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model)
  if (experts) return Number(experts[1]) * Number(experts[2])
  const plain = /(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model)
  return plain ? Number(plain[1]) : 0
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
export function scoreOf(job: Job, url: string, model: string) {
  if (job === 'transcription') return hearing(model)
  if (job === 'speech') return url === sayServer ? 1 : 2
  return 1 + sizeOf(model)
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
      if (server.url === sayServer) {
        const voice = macVoice(server.models)
        // A Mac's own voices: the last resort for reading answers out, after a speech server.
        if (voice) offer('speech', { machine: machine.id, url: sayServer, model: '', voice, score: 1 })
        continue
      }
      for (const model of server.models) {
        const job = jobOf(model, server.kind)
        if (job === 'chat') offer('chat', { machine: machine.id, url: server.url, model, score: 1 + sizeOf(model) })
        else if (job === 'embeddings') offer('embeddings', { machine: machine.id, url: server.url, model, score: 1 + sizeOf(model) })
        else if (job === 'transcription') offer('transcription', { machine: machine.id, url: server.url, model, score: hearing(model) })
        else if (job === 'speech') offer('speech', { machine: machine.id, url: server.url, model, voice: /kokoro/i.test(`${model} ${server.kind}`) ? 'af_heart' : '', score: 2 })
      }
    }
  }
  return best
}
