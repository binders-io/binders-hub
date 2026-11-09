import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Download as DownloadIcon, Sparkles } from 'lucide-react'
import { call } from '../data/api'
import { attempt, toast } from './Toast'
import { Option, Segmented } from './HubOptionsPanel'

// The hub's brain: the model that sums up what phones and Macs capture and answers questions from the binders, the
// embeddings that find passages by what they mean, the transcription model that writes down what phones send as audio,
// the voice that reads answers out, and a switch that keeps all of them on the hub's own network. Any of those jobs can be
// served by a machine of yours (a Mac, a DGX Spark) running the Binders daemon. An admin's to set; everyone sees what's in
// use.

type Provider = 'off' | 'anthropic' | 'openai' | 'machine'

interface BrainView {
  provider: Provider
  model?: string
  baseUrl?: string
  summarize: boolean
  embeddingsBaseUrl?: string
  embeddingsModel?: string
  apiKeySet?: boolean
  usesAnthropicKey?: boolean
  embeddingsKeySet?: boolean
  locked?: Record<string, string>
  inUse?: string
  embeddingsInUse?: string
  needs?: string
  embeddingsNeeds?: string
  transcriptionBaseUrl?: string
  transcriptionModel?: string
  transcriptionKeySet?: boolean
  transcriptionInUse?: string
  transcriptionNeeds?: string
  speechBaseUrl?: string
  speechModel?: string
  speechVoice?: string
  speechKeySet?: boolean
  speechInUse?: string
  speechNeeds?: string
  localOnly?: boolean
  machine?: string
  embeddingsMachine?: string
  transcriptionMachine?: string
  speechMachine?: string
  /** The jobs the hub chose itself from your machines, and those an admin set. */
  autoJobs?: Job[]
  ownJobs?: Job[]
}

type Job = 'chat' | 'embeddings' | 'transcription' | 'speech'

interface MachineServer {
  url: string
  kind: string
  models: string[]
  needsKey?: boolean
  /** It lists cloud models, or ones too big for the machine: a gateway to somewhere else, never chosen from. */
  gateway?: boolean
}

interface Download {
  kind?: 'pull' | 'serve'
  model: string
  job: Job
  status: string
  completed: number
  total: number
  done?: boolean
  error?: string
}

interface Machine {
  id: string
  name: string
  online: boolean
  platform?: string
  servers?: MachineServer[]
  seenAt?: string
  version?: string
  downloads?: Download[]
  onDisk?: { name: string; source: string; engine?: string; why?: string }[]
  looked?: { where: string; count: number }[]
  running?: { engine: string; model?: string }[]
}

/**
 * What a machine has downloaded, in words: how many it loads when asked (and with what), what's running now, and why
 * the rest can't run there.
 */
function diskLine(m: Machine) {
  const all = m.onDisk ?? []
  if (!all.length) return m.looked?.length ? `No downloaded models found in ${m.looked.map((l) => l.where).join(', ')}.` : ''
  const served = all.filter((d) => d.engine)
  const engines = [...new Set(served.map((d) => d.engine))].join(', ')
  const why = new Map<string, number>()
  for (const d of all) if (d.why) why.set(d.why, (why.get(d.why) ?? 0) + 1)
  const running = (m.running ?? []).map((r) => (r.model ? `${r.engine} (${shortName(r.model)})` : r.engine))
  return [
    `Downloaded: ${all.length} model${all.length === 1 ? '' : 's'}${served.length ? `, ${served.length} loaded when asked for${engines ? ` (${engines})` : ''}` : ''}.`,
    running.length ? `Running now: ${running.join(', ')}.` : '',
    why.size ? `The rest: ${[...why].map(([reason, n]) => `${n} ${reason}`).join('; ')}.` : '',
    `Looked in ${(m.looked ?? []).map((l) => l.where).join(', ') || 'the usual places'}.`,
  ].filter(Boolean).join(' ')
}

/** What the hub offers for jobs none of your machines serves: a model already there to serve, or one to download. */
interface Offer {
  action: 'serve' | 'pull'
  jobs: Job[]
  machine: string
  model: string
  models?: Partial<Record<Job, string>>
  size?: string
  source?: 'ollama' | 'hf'
  runtime?: 'mlx-audio' | 'lmstudio'
}

/** A model one of your machines can do a job with, as the hub ranks them. */
interface Candidate {
  machine: string
  machineName: string
  url: string
  model: string
  voice?: string
  kind: string
  state: 'running' | 'on-demand' | 'voice'
  /** For speech: the voices it can read in, when they're known. */
  voices?: string[]
}

/** Where each of Qwen's CustomVoice speakers is from: Aiden and Ryan speak English natively. */
const qwenAccents: Record<string, string> = { Aiden: 'English', Ryan: 'English', Vivian: 'Chinese', Serena: 'Chinese', Uncle_Fu: 'Chinese', Dylan: 'Beijing', Eric: 'Sichuan', Ono_Anna: 'Japanese', Sohee: 'Korean' }

/** A voice as people would name it: Kokoro's af_heart is "Heart (American, female)"; Qwen's Aiden, "Aiden (English)". */
function voiceLabel(voice: string) {
  const kokoro = /^([ab])([fm])_([a-z]+)$/.exec(voice)
  if (kokoro) return `${kokoro[3][0].toUpperCase()}${kokoro[3].slice(1)} (${kokoro[1] === 'a' ? 'American' : 'British'}, ${kokoro[2] === 'f' ? 'female' : 'male'})`
  if (qwenAccents[voice]) return `${voice.replace('_', ' ')} (${qwenAccents[voice]})`
  return voice
}

/** A model's name as people know it: without its publisher. */
const shortName = (model: string) => model.split('/').pop() ?? model

/** How far a download has got, in words: "42% of 20 GB", or what Ollama says it's doing. */
function progressOf(d: Download) {
  const serving = d.kind === 'serve'
  if (d.error) return `Couldn’t ${serving ? 'start it' : 'download it'}: ${d.error}.`
  if (d.done) return serving ? 'Started. The hub is choosing from it now.' : 'Downloaded. The hub is choosing it now.'
  if (d.total > 0) return `${Math.floor((d.completed / d.total) * 100)}% of ${(d.total / 1024 ** 3).toFixed(d.total > 10 * 1024 ** 3 ? 0 : 1)} GB`
  return d.status ? `${d.status.charAt(0).toUpperCase()}${d.status.slice(1)}…` : 'Starting…'
}

const serverNames: Record<string, string> = { ollama: 'Ollama', lmstudio: 'LM Studio', vllm: 'vLLM', nim: 'NVIDIA NIM', kokoro: 'Kokoro', sglang: 'SGLang', openai: 'A server', say: 'macOS voices' }

/** A server on a machine, in words: "Ollama on :11434 · 6 models", or "macOS voices · 143". */
function serverLabel(server: MachineServer) {
  if (server.kind === 'say') return `macOS voices · ${server.models.length}`
  let port = ''
  try {
    port = new URL(server.url).port
  } catch { /* shown without */ }
  if (server.needsKey) return `A server${port ? ` on :${port}` : ''} that wants a key`
  if (server.gateway) return `A gateway${port ? ` on :${port}` : ''} to cloud models (${server.models.length}), not used`
  if (server.kind === 'binders') return `Downloaded models · ${server.models.length}, each loaded when it’s asked for`
  return `${serverNames[server.kind] ?? 'A server'}${port ? ` on :${port}` : ''} · ${server.models.length} model${server.models.length === 1 ? '' : 's'}`
}

/** Whether version a is older than b: 0.13.2 against 0.14.1. */
function older(a: string, b: string) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

function Machines({ machines, onChange, latest }: { machines: Machine[]; onChange: () => void; latest?: string }) {
  const [command, setCommand] = useState<{ install: string; expiresAt: string }>()
  const [removing, setRemoving] = useState<string>()
  const getCommand = async () => {
    const result = await attempt(() => call<{ install: string; expiresAt: string }>('POST', '/api/brain/machines/command', {}))
    if (result) setCommand(result)
  }
  const remove = async (id: string) => {
    if (!(await attempt(() => call('DELETE', `/api/brain/machines/${id}`)))) return
    setRemoving(undefined)
    onChange()
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it in a terminal on each machine.'), () => toast('Couldn’t copy it: select it and copy it yourself.'))
  const until = command ? new Date(command.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  return (
    <Option title="Your machines" detail="A Mac, or a GPU box such as a DGX Spark, giving the hub the models it runs: Ollama, LM Studio, vLLM or NIM, MLX, a whisper or Parakeet server, Kokoro and, on a Mac, macOS’s own voices. Run one line on it; the hub finds its models and uses the best of them for each job you haven’t set yourself.">
      {machines.length > 0 && (
        <ul className="machine-list">
          {machines.map((m) => (
            <li key={m.id}>
              <span className={`machine-dot${m.online ? ' on' : ''}`} aria-hidden="true" />
              <div>
                <b>{m.name}</b> <span className="machine-state">{m.online ? 'Linked' : m.seenAt ? 'Away' : 'Not linked yet'}{m.platform ? ` · ${m.platform}` : ''}{m.version ? ` · daemon ${m.version}` : ''}</span>
                {/* From 0.14.0 a daemon updates itself when it links; one before that needs its line run again. */}
                {latest && m.version && older(m.version, latest) && <span className="machine-serves option-error">{older(m.version, '0.14.0') ? `Its daemon is too old to update itself: run the line from “Add more machines” on ${m.name} again.` : 'Its daemon updates itself the next time it links.'}</span>}
                <span className="machine-serves">{m.servers?.length ? m.servers.map(serverLabel).join(' · ') : m.seenAt ? 'No model servers found on it yet.' : 'Waiting for it to link.'}</span>
                {diskLine(m) && <span className="machine-serves">{diskLine(m)}</span>}
              </div>
              {removing === m.id
                ? <span className="machine-confirm">Remove {m.name}? <button type="button" className="button" onClick={() => void remove(m.id)}>Remove</button> <button type="button" className="button" onClick={() => setRemoving(undefined)}>Keep</button></span>
                : <button type="button" className="button" onClick={() => setRemoving(m.id)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {command ? (
        <div className="machine-install">
          <p>Paste this in a terminal on each machine, as yourself, not with sudo: a Mac, or Linux such as a DGX Spark. It installs the Binders daemon, which runs in the background and joins under the machine’s own name. It works on as many machines as you like until {until}.</p>
          <div className="machine-line">
            <code>{command.install}</code>
            <button type="button" className="button" onClick={() => copy(command.install)}><Copy size={13} /> Copy</button>
          </div>
        </div>
      ) : (
        <div className="machine-add">
          <button type="button" className="button" onClick={() => void getCommand()}>{machines.length ? 'Add more machines' : 'Add your machines'}</button>
        </div>
      )}
    </Option>
  )
}

interface IndexStats {
  sources: number
  passages: number
  withVectors: number
  /** Where the vectors are kept: its repo, or nothing filled in for the hub's disk alone. None for a personal binder, which has no vectors. */
  kept?: { to?: string; branch?: string; at?: string; error?: string }
}

type Field = 'model' | 'baseUrl' | 'embeddingsBaseUrl' | 'embeddingsModel' | 'transcriptionBaseUrl' | 'transcriptionModel' | 'speechBaseUrl' | 'speechModel' | 'speechVoice'
type KeyName = 'apiKey' | 'embeddingsKey' | 'transcriptionKey' | 'speechKey'

/** Machines whose daemon is older than this hub's: each said, with the line that brings it up to date when it can't do so itself. */
function OldDaemons({ machines, latest }: { machines: Machine[]; latest?: string }) {
  const [line, setLine] = useState<string>()
  const old = machines.filter((m) => latest && m.version && older(m.version, latest))
  if (!old.length) return null
  const stuck = old.filter((m) => older(m.version!, '0.14.0'))
  const getLine = async () => {
    const result = await attempt(() => call<{ install: string }>('POST', '/api/brain/machines/command', {}))
    if (result) setLine(result.install)
  }
  return (
    <div className="old-daemons" role="status">
      {old.map((m) => (
        <p key={m.id}><b>{m.name}</b> runs daemon {m.version}; this hub’s is {latest}. {older(m.version!, '0.14.0') ? 'It’s too old to update itself: run the line below on it once.' : 'It updates itself the next time it links.'}</p>
      ))}
      {stuck.length > 0 && (line
        ? <div className="machine-line"><code>{line}</code><button type="button" className="button" onClick={() => void navigator.clipboard.writeText(line).then(() => toast('Copied. Paste it in a terminal on the machine.'), () => toast('Couldn’t copy it: select it and copy it yourself.'))}><Copy size={13} /> Copy</button></div>
        : <button type="button" className="button" onClick={() => void getLine()}>Get the line</button>)}
    </div>
  )
}

const stateWords: Record<Candidate['state'], string> = { running: 'Running', 'on-demand': 'Loads when used', voice: 'Built in' }

/** Where a candidate comes from on its machine, in words: Ollama, its downloads, macOS, a server on a port. */
function sourceOf(c: Candidate) {
  if (c.kind === 'binders') return 'downloaded'
  if (c.kind === 'say') return 'macOS'
  if (serverNames[c.kind] && c.kind !== 'openai') return serverNames[c.kind]
  try {
    const port = new URL(c.url).port
    return port ? `server on :${port}` : 'a server'
  } catch {
    return 'a server'
  }
}

export function BrainPanel() {
  const [brain, setBrain] = useState<BrainView>()
  const [admin, setAdmin] = useState(false)
  const [index, setIndex] = useState<IndexStats>()
  const [saved, setSaved] = useState<string>()
  const [apiKey, setApiKey] = useState('')
  const [embeddingsKey, setEmbeddingsKey] = useState('')
  const [transcriptionKey, setTranscriptionKey] = useState('')
  const [speechKey, setSpeechKey] = useState('')
  const [machines, setMachines] = useState<Machine[]>([])
  const [offered, setOffered] = useState<Offer[]>([])
  const [latest, setLatest] = useState<string>()
  const [choices, setChoices] = useState<Partial<Record<Job, Candidate[]>>>({})
  /** A job's list opened past its first few. */
  const [showAll, setShowAll] = useState<Partial<Record<Job, boolean>>>({})

  useEffect(() => {
    void call<{ brain: BrainView; admin: boolean; index?: IndexStats }>('GET', '/api/brain').then((r) => {
      setBrain(r.brain)
      setAdmin(r.admin)
      setIndex(r.index)
    }).catch(() => {})
  }, [])

  // Your machines, an admin's: looked at again now and then, so one just set up shows as linked, and often while a model
  // downloads. A finished download changes what the brain uses, so the brain is read again then too.
  const loadMachines = () => void call<{ machines: Machine[]; offers?: Offer[]; latest?: string; candidates?: Partial<Record<Job, Candidate[]>> }>('GET', '/api/brain/machines').then((r) => {
    setLatest(r.latest)
    setChoices(r.candidates ?? {})
    setMachines((before) => {
      const finished = r.machines.some((m) => (m.downloads ?? []).some((d) => d.done && !before.find((b) => b.id === m.id)?.downloads?.find((x) => x.model === d.model)?.done))
      if (finished) void call<{ brain: BrainView }>('GET', '/api/brain').then((b) => setBrain(b.brain)).catch(() => {})
      return r.machines
    })
    setOffered((r.offers ?? []).filter((o) => o.action === 'pull'))
  }).catch(() => {})
  const downloading = machines.some((m) => (m.downloads ?? []).some((d) => !d.done && !d.error))
  useEffect(() => {
    if (!admin) return
    loadMachines()
    const again = window.setInterval(loadMachines, downloading ? 2000 : 8000)
    return () => window.clearInterval(again)
  }, [admin, downloading])

  if (!brain) return null

  const save = async (fields: Record<string, unknown>, what: string) => {
    const result = await attempt(() => call<{ brain: BrainView }>('PATCH', '/api/brain', fields))
    if (!result) return false
    setBrain(result.brain)
    setSaved(what)
    window.setTimeout(() => setSaved(undefined), 1500)
    return true
  }
  const locked = brain.locked ?? {}
  const off = (key: string) => !admin || !!locked[key]
  const note = (key: string) => (locked[key] ? <span className="option-lock">Set on the hub by {locked[key]}</span> : saved === key ? <span className="option-saved"><Check size={12} strokeWidth={3} /> Saved</span> : null)
  const field = (key: Field, label: string, placeholder: string) => (
    <label className="field">
      <span className="field-label">{label} {note(key)}</span>
      <input id={`brain-${key}`} className="mono" defaultValue={brain[key] ?? ''} placeholder={placeholder} disabled={off(key)} autoComplete="off" spellCheck={false}
        onBlur={(e) => e.target.value.trim() !== (brain[key] ?? '') && void save({ [key]: e.target.value.trim() }, key)} />
    </label>
  )
  const keyField = (name: KeyName, value: string, set: (v: string) => void, isSet: boolean | undefined, placeholder: string) => (
    <div className="field">
      <label className="field-label" htmlFor={`brain-${name}`}>Key {note(name)}</label>
      <div className="brain-key">
        <input id={`brain-${name}`} type="password" className="mono" value={value} onChange={(e) => set(e.target.value)} disabled={off(name)} autoComplete="new-password"
          placeholder={isSet ? 'Set. Type a new one to replace it' : placeholder} />
        <button type="button" className="button" disabled={off(name) || !value.trim()} onClick={() => void save({ [name]: value.trim() }, name).then((ok) => ok && set(''))}>Save</button>
        {isSet && !locked[name] && <button type="button" className="button" disabled={!admin} onClick={() => void save({ [name]: '' }, name)}>Clear</button>}
      </div>
    </div>
  )

  const inUseFor: Record<Job, string | undefined> = { chat: brain.inUse, embeddings: brain.embeddingsInUse, transcription: brain.transcriptionInUse, speech: brain.speechInUse }
  const needsFor: Record<Job, string | undefined> = { chat: brain.needs, embeddings: brain.embeddingsNeeds, transcription: brain.transcriptionNeeds, speech: brain.speechNeeds }
  const chooseForMe = async (job: Job) => {
    const result = await attempt(() => call<{ brain: BrainView }>('POST', '/api/brain/choose', { jobs: [job] }))
    if (result) setBrain(result.brain)
  }
  /** Whether a candidate is what the job uses now. */
  const isInUse = (job: Job, c: Candidate) => {
    if (job === 'chat') return brain.provider === 'machine' && brain.machine === c.machine && brain.baseUrl === c.url && brain.model === c.model
    if (brain[`${job}Machine`] !== c.machine || brain[`${job}BaseUrl`] !== c.url) return false
    return c.kind === 'say' ? true : brain[`${job}Model`] === c.model
  }
  /** A candidate made the job's: yours from then on (the hub no longer chooses it), until you let the hub choose again. */
  const use = (job: Job, c: Candidate) => {
    if (job === 'chat') return void save({ provider: 'machine', machine: c.machine, baseUrl: c.url, model: c.model }, 'provider')
    if (job === 'speech') return void save(c.kind === 'say' ? { speechMachine: c.machine, speechBaseUrl: 'say:', speechModel: '', speechVoice: c.voice ?? '' } : { speechMachine: c.machine, speechBaseUrl: c.url, speechModel: c.model, speechVoice: c.voice ?? '' }, 'speechMachine')
    void save({ [`${job}Machine`]: c.machine, [`${job}BaseUrl`]: c.url, [`${job}Model`]: c.model }, `${job}Machine`)
  }
  /** The engine a downloaded model loads with, on its machine: said beside "Loads when used". */
  const engineOf = (c: Candidate) => (c.kind === 'binders' ? machines.find((m) => m.id === c.machine)?.onDisk?.find((d) => d.name === c.model)?.engine : undefined)

  /** What a job uses now, who chose it, and what's wrong with it, if anything. */
  const inUse = (job: Job) => {
    const auto = brain.autoJobs?.includes(job)
    return (
      <div className="job-in-use">
        <span className="field-label">In use</span>
        <p>
          {inUseFor[job] ? <b className="mono">{inUseFor[job]!.replace(/^[\w.-]+\/(?=[^\s/]+(,| on ))/, '')}</b> : <span className="faint">Nothing yet</span>}
          {auto && <span className="choice-chip chosen"><Sparkles size={11} aria-hidden="true" /> Chosen for you</span>}
          {!auto && admin && (choices[job]?.length ?? 0) > 0 && <button type="button" className="text-button" onClick={() => void chooseForMe(job)}>Let the hub choose</button>}
        </p>
        {needsFor[job] && <p className="option-status option-error">It needs: {needsFor[job]}</p>}
      </div>
    )
  }

  /** The voice answers are read out in, for a model with several: one, always, chosen here. */
  const voicePicker = () => {
    const current = (choices.speech ?? []).find((c) => isInUse('speech', c))
    if (!current?.voices?.length) return null
    const value = brain.speechVoice || current.voice || current.voices[0]
    return (
      <label className="field">
        <span className="field-label">Voice {note('speechVoice')}</span>
        <select id="brain-speechVoice" value={value} disabled={off('speechVoice')} onChange={(e) => void save({ speechVoice: e.target.value }, 'speechVoice')}>
          {(current.voices.includes(value) ? current.voices : [value, ...current.voices]).map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
        </select>
      </label>
    )
  }

  /** Every model on your machines this job can be done with, best first: each with its machine, its state, and Use. */
  const list = (job: Job) => {
    const all = choices[job] ?? []
    if (!all.length) return null
    const shown = showAll[job] ? all : all.slice(0, 6)
    return (
      <div className="choices">
        <span className="field-label">On your machines</span>
        <ul className="choice-list">
          {shown.map((c) => {
            const current = isInUse(job, c)
            const engine = engineOf(c)
            return (
              <li key={`${c.machine} ${c.url} ${c.model} ${c.voice ?? ''}`} className={current ? 'on' : undefined}>
                <div className="choice-name">
                  <b>{c.kind === 'say' ? `macOS voice: ${c.voice}` : shortName(c.model)}</b>
                  <span>{c.machineName} · {sourceOf(c)}</span>
                </div>
                <span className={`choice-chip ${c.state}`}>{stateWords[c.state]}{engine && c.state === 'on-demand' ? ` · ${engine}` : ''}</span>
                <button type="button" className="button" disabled={current || !admin} onClick={() => use(job, c)}>{current ? 'In use' : 'Use'}</button>
              </li>
            )
          })}
        </ul>
        {all.length > shown.length && <button type="button" className="text-button" onClick={() => setShowAll((now) => ({ ...now, [job]: true }))}>Show all {all.length}</button>}
      </div>
    )
  }

  /** A download for this job: one under way (with how far it's got), or one the hub offers, a click away. */
  const download = (job: Job) => {
    for (const machine of machines) {
      const going = (machine.downloads ?? []).find((d) => d.kind !== 'serve' && d.job === job)
      if (going && !(going.done && brain.autoJobs?.includes(job))) {
        const share = going.total > 0 ? going.completed / going.total : 0
        return (
          <div className="model-download">
            <p className="option-status"><DownloadIcon size={12} aria-hidden="true" /> {shortName(going.model)} on {machine.name}: {progressOf(going)}</p>
            {!going.done && !going.error && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}><span style={{ width: `${Math.max(2, share * 100)}%` }} /></div>}
          </div>
        )
      }
    }
    const offer = offered.find((o) => o.jobs.includes(job))
    if (!offer) return null
    const on = machines.find((m) => m.id === offer.machine)?.name ?? 'your machine'
    const pull = async () => {
      if (await attempt(() => call('POST', `/api/brain/machines/${offer.machine}/pull`, { model: offer.model, job, source: offer.source }))) loadMachines()
    }
    return (
      <div className="choices">
        <span className="field-label">To download</span>
        <ul className="choice-list">
          <li>
            <div className="choice-name"><b>{shortName(offer.model)}</b><span>{on}{offer.size ? ` · ${offer.size}` : ''}</span></div>
            <span className="choice-chip">None of your machines has one yet</span>
            <button type="button" className="button" disabled={!admin} onClick={() => void pull()}><DownloadIcon size={13} aria-hidden="true" /> Download</button>
          </li>
        </ul>
      </div>
    )
  }

  /** A server the hub reaches by its address instead: tucked away, as most people use their machines. */
  const byAddress = (job: Exclude<Job, 'chat'>) => {
    const keys = { embeddings: [embeddingsKey, setEmbeddingsKey, brain.embeddingsKeySet] as const, transcription: [transcriptionKey, setTranscriptionKey, brain.transcriptionKeySet] as const, speech: [speechKey, setSpeechKey, brain.speechKeySet] as const }[job]
    const placeholders = { embeddings: ['http://localhost:11434/v1', 'nomic-embed-text'], transcription: ['http://localhost:8080/v1', 'whisper-large-v3'], speech: ['http://localhost:8880/v1', 'kokoro'] }[job]
    return (
      <details className="by-address">
        <summary>Use a server by its address</summary>
        {field(`${job}BaseUrl`, 'Its address', placeholders[0])}
        {field(`${job}Model`, 'Model', placeholders[1])}
        {job === 'speech' && field('speechVoice', 'Voice', 'af_heart')}
        {keyField(`${job}Key`, keys[0], keys[1], keys[2], 'None needed for most servers on your own machines')}
      </details>
    )
  }

  /** The models to choose from for a job, and a server by its address, once there's something in use: most people leave it. */
  const change = (job: Job, more: ReactNode) => (
    <details className="by-address job-change" open={!inUseFor[job]}>
      <summary>Change it</summary>
      {list(job)}
      {more}
    </details>
  )
  /** How much of this binder the brain has read, and where what it found by meaning is kept. */
  const read = index && <p className="option-status num">This binder: {index.sources} note{index.sources === 1 ? '' : 's'} and cards read, in {index.passages} passages{brain.embeddingsInUse ? `, ${index.withVectors} of them found by meaning` : ''}.{brain.embeddingsInUse && index.kept && <> {index.kept.error ? `The embeddings couldn’t be saved to GitHub: ${index.kept.error}` : index.kept.to ? `The embeddings are saved in ${index.kept.to}, on ${index.kept.branch}, so a rebuilt hub gets them back.` : 'The embeddings are saved on the hub’s disk: give this binder a repo and they’re saved there too.'}</>}</p>

  return (
    <div className="options">
      {!admin && <p className="setup-note">Only the hub’s admins can change these.</p>}
      {admin && <OldDaemons machines={machines} latest={latest} />}

      {!admin && <Option title="In use" detail="What the brain does now, and how much of this binder it has read.">
        <p className="option-status">
          {brain.inUse ? <>Summing up and answering with <b className="mono">{brain.inUse}</b>.</> : 'No model: the brain finds passages by their words, and doesn’t sum up or answer.'}
          {' '}{brain.embeddingsInUse ? <>Finding by meaning with <b className="mono">{brain.embeddingsInUse}</b>.</> : 'Finding by words only.'}
        </p>
        <p className="option-status">
          {brain.transcriptionInUse ? <>Writing down what phones send as audio with <b className="mono">{brain.transcriptionInUse}</b>.</> : 'No transcription model: phones and Macs write down what they hear themselves.'}
          {' '}{brain.speechInUse ? <>Reading answers out with <b className="mono">{brain.speechInUse}</b>.</> : ''}
          {brain.localOnly ? ' Local AI only: every model is on the hub’s own network.' : ''}
        </p>
        {read}
      </Option>}

      {admin && <>
        <Machines machines={machines} onChange={loadMachines} latest={latest} />

        <Option title="The hub’s model" detail="Sums up what phones and Macs send, answers questions from the binders, and talks." aside={note('provider')}>
          {inUse('chat')}
          {download('chat')}
          {change('chat', <>
            <div className="field">
              <span className="field-label">Sum up conversations and meetings {note('summarize')}</span>
              <Segmented id="brain-summarize" value={brain.summarize ? 'on' : 'off'} disabled={off('summarize') || brain.provider === 'off'} onChange={(on) => void save({ summarize: on === 'on' }, 'summarize')} choices={[['on', 'On'], ['off', 'Off']]} />
            </div>
            <details className="by-address">
              <summary>Use Claude, or a server by its address</summary>
              <Segmented id="brain-provider" value={brain.provider} disabled={off('provider')} onChange={(provider) => void save({ provider }, 'provider')}
                choices={[['off', 'Off'], ['anthropic', 'Claude'], ['openai', 'A server by its address']]} />
              {brain.provider === 'anthropic' && <>
                {field('model', 'Model', 'claude-opus-5-5')}
                {keyField('apiKey', apiKey, setApiKey, brain.apiKeySet && !brain.usesAnthropicKey, 'sk-ant-…')}
                {brain.usesAnthropicKey && <span className="field-hint">Using the hub’s ANTHROPIC_API_KEY until a key is saved here.</span>}
              </>}
              {brain.provider === 'openai' && <>
                {field('baseUrl', 'Its address', 'http://localhost:11434/v1')}
                {field('model', 'Model', 'qwen3:32b')}
                {keyField('apiKey', apiKey, setApiKey, brain.apiKeySet, 'None needed for most servers on your own machines')}
              </>}
            </details>
          </>)}
        </Option>

        <Option title="Finding by meaning" detail="Optional. Finds the passages that mean what a question asks, even in other words. Without it, passages are found by their words.">
          {inUse('embeddings')}
          {read}
          {download('embeddings')}
          {change('embeddings', byAddress('embeddings'))}
        </Option>

        <Option title="Writing down audio" detail="Optional. Writes down what phones record with a bigger model than a phone can run. The audio isn’t kept.">
          {inUse('transcription')}
          {download('transcription')}
          {change('transcription', byAddress('transcription'))}
        </Option>

        <Option title="Reading answers out" detail="Optional. Reads the hub’s answers out on phones.">
          {inUse('speech')}
          {voicePicker()}
          {download('speech')}
          {change('speech', byAddress('speech'))}
        </Option>

        <Option title="Local AI only" detail="Every model the hub uses runs on its own network: this machine, your LAN or your VPN. Claude and any address outside it are refused, so nothing said or written leaves your machines." aside={note('localOnly')}>
          <Segmented id="brain-local-only" value={brain.localOnly ? 'on' : 'off'} disabled={off('localOnly')} onChange={(on) => void save({ localOnly: on === 'on' }, 'localOnly')} choices={[['off', 'Off'], ['on', 'On']]} />
        </Option>
      </>}
    </div>
  )
}
