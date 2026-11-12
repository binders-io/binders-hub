import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { AudioLines, Copy, Download as DownloadIcon, Laptop, LoaderCircle, Plus, Search, Server, ShieldCheck, Sparkles, TriangleAlert, Volume2, Check, X } from 'lucide-react'
import { call } from '../data/api'
import { attempt, failure, toast } from './Toast'
import { href } from '../route'
import { ConfirmButton } from './ConfirmButton'
import { Segmented, SettingNote, Switch } from './HubOptionsPanel'
import { DataTable, Dialog, EmptyState, Guided, More, Row, Rows, Section, Skeleton, Status, type Column, type Tone } from '../kit'

// The hub's brain: the model that sums up what phones and Macs capture and answers questions from the binders, the
// embeddings that find passages by what they mean, the transcription model that writes down what phones send as audio,
// the voice that reads answers out, and a switch that keeps all of them on the hub's own network. Any of those jobs can be
// served by a machine of yours (a Mac, a DGX Spark) running the Binders daemon. An admin's to set; everyone sees what's in
// use. Each is a row saying what it uses; an admin presses it to change it, in a dialog of the choices.

type Provider = 'off' | 'anthropic' | 'openai' | 'machine'

interface BrainView {
  provider: Provider
  model?: string
  baseUrl?: string
  summarize: boolean
  first?: boolean
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
  /** It lists cloud models, or ones too big for the machine: a gateway to somewhere else, which the hub never chooses from. */
  gateway?: boolean
}

/** A gateway on one of your machines, and the models it lists for each job: an admin's to choose from, never the hub's. */
interface Gateway {
  machine: string
  machineName: string
  url: string
  models: Partial<Record<Job, string[]>>
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
  if (server.gateway) return `A gateway${port ? ` on :${port}` : ''} to ${server.models.length} cloud models. The hub never picks one itself: choose one under Models.`
  if (server.kind === 'binders') return `Downloaded models · ${server.models.length}, each loaded when it’s asked for`
  return `${serverNames[server.kind] ?? 'A server'}${port ? ` on :${port}` : ''} · ${server.models.length} model${server.models.length === 1 ? '' : 's'}`
}

/** What a machine has for the hub, in a few words: the models it can use, leaving out what wants a key or is someone else's. */
function modelCount(m: Machine) {
  const usable = (m.servers ?? []).filter((server) => !server.needsKey && !server.gateway)
  const models = usable.filter((server) => server.kind !== 'say').reduce((n, server) => n + server.models.length, 0)
  const voices = usable.some((server) => server.kind === 'say')
  // A gateway's models run somewhere else: yours to choose, so said apart from what the hub chooses from.
  const cloud = (m.servers ?? []).filter((server) => server.gateway && !server.needsKey).reduce((n, server) => n + server.models.length, 0)
  const gateway = cloud ? `a gateway to ${cloud} cloud models` : ''
  if (!models && !voices) return gateway ? `A${gateway.slice(1)}, yours to choose` : 'No models the hub can use yet'
  return [[models ? `${models} model${models === 1 ? '' : 's'}` : '', voices ? 'macOS voices' : ''].filter(Boolean).join(' and '), gateway].filter(Boolean).join(', and ')
}

/** Whether version a is older than b: 0.13.2 against 0.14.1. */
function older(a: string, b: string) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

/** How a machine stands, as a status: linked, away, or not linked yet. */
function machineStatus(m: Machine): { tone: Tone; words: string } {
  if (m.online) return { tone: 'ok', words: 'Linked' }
  return m.seenAt ? { tone: 'off', words: 'Away' } : { tone: 'waiting', words: 'Not linked yet' }
}

const machineColumns: Column<Machine>[] = [
  { key: 'name', header: 'Machine', cell: (m) => m.name, text: (m) => m.name, phone: 'title', width: '32%' },
  { key: 'serves', header: 'What it serves', cell: (m) => (m.seenAt ? modelCount(m) : 'Waiting for it to link') },
  { key: 'state', header: 'State', cell: (m) => <Status tone={machineStatus(m).tone}>{machineStatus(m).words}</Status>, width: '150px' },
]

/** One of your machines, opened from its row: what it runs, what it serves, what it has on disk, and Remove. */
function MachineDialog({ machine: m, latest, onRemove, onClose }: { machine: Machine; latest?: string; onRemove: () => void; onClose: () => void }) {
  const stands = machineStatus(m)
  // From 0.14.0 a daemon updates itself when it links; one before that needs its line run again.
  const old = latest && m.version && older(m.version, latest)
  return (
    <Dialog title={m.name} onClose={onClose} footer={<>
      <ConfirmButton className="button danger dialog-foot-start" question="Remove it? Press again" onConfirm={onRemove}>Remove</ConfirmButton>
      <button type="button" className="button primary" onClick={onClose}>Done</button>
    </>}>
      <dl className="machine-facts">
        <dt>State</dt>
        <dd><Status tone={stands.tone}>{stands.words}</Status>{!m.seenAt && <span className="faint"> Waiting for it to link.</span>}</dd>
        {(m.platform || m.version) && <><dt>Runs</dt><dd>{[m.platform, m.version && `daemon ${m.version}`].filter(Boolean).join(' · ')}</dd></>}
        {old && <><dt>Its daemon</dt><dd className="option-error">{older(m.version!, '0.14.0') ? `Too old to update itself: run the line from Add on ${m.name} again.` : 'It updates itself the next time it links.'}</dd></>}
        {m.seenAt && <><dt>Serves</dt><dd>{m.servers?.length ? <ul className="machine-servers">{m.servers.map((server) => <li key={server.url + server.kind}>{serverLabel(server)}</li>)}</ul> : modelCount(m)}</dd></>}
        {diskLine(m) && <><dt>On disk</dt><dd>{diskLine(m)}</dd></>}
      </dl>
    </Dialog>
  )
}

/**
 * The line that links your machines to the hub, as a step of adding one: asked for once as it opens, with the machines
 * that link while it's open. It carries a secret for a while, so it's kept here alone, never in an address or a toast.
 */
function BrainLine({ machines }: { machines: Machine[] }) {
  const [command, setCommand] = useState<{ install: string; expiresAt: string }>()
  const [problem, setProblem] = useState(false)
  // What was already there, so only a machine that links from now on is listed.
  const [before] = useState(() => new Set(machines.map((m) => m.id)))
  const asked = useRef(false)
  const getCommand = async () => {
    setProblem(false)
    const result = await attempt(() => call<{ install: string; expiresAt: string }>('POST', '/api/brain/machines/command', {}))
    if (result) setCommand(result)
    else setProblem(true)
  }
  // Asked once as it opens, though a development build runs effects twice: each ask makes a line.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void getCommand()
  }, [])
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it in a terminal on each machine.'), () => failure('Couldn’t copy it: select it and copy it yourself.'))
  const until = command ? new Date(command.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  const linked = machines.filter((m) => !before.has(m.id))
  return (
    <div className="add-machine">
      {problem ? (
        <div className="add-machine-problem"><button type="button" className="button" onClick={() => void getCommand()}>Try again</button></div>
      ) : !command ? (
        <p className="add-machine-wait" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Making the line…</p>
      ) : (
        <>
          <div className="command">
            <pre className="mono">{command.install}</pre>
            <button type="button" className="icon-button" onClick={() => copy(command.install)} aria-label="Copy the line" title="Copy the line"><Copy size={14} /></button>
          </div>
          <p>It installs the Binders daemon, which runs in the background and links under the machine’s own name. It works on as many machines as you like until {until}.</p>
        </>
      )}
      <section className="add-machine-joined" aria-label="Machines that linked">
        <h4>Machines that linked</h4>
        {linked.length ? (
          <ul className="joined-list">
            {linked.map((m) => (
              <li key={m.id}>
                <div><b>{m.name}</b><span className="joined-where">{m.seenAt ? modelCount(m) : 'Waiting for it to link'}</span></div>
                <span className={`joined-state${m.online ? ' on' : ''}`}>{m.online ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <LoaderCircle size={13} className="spin" aria-hidden="true" />}{m.online ? 'Linked' : 'Not linked yet'}</span>
              </li>
            ))}
          </ul>
        ) : <p className="add-machine-wait"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Waiting for one to run it…</p>}
      </section>
    </div>
  )
}

/**
 * Adding a machine: one that only lends the hub its models gets the daemon's line here; one with your code on it is
 * better added from the Agents page, where it becomes an agent that takes cards and lends its models too.
 */
function AddMachines({ machines, onClose }: { machines: Machine[]; onClose: () => void }) {
  const done = (nav: { close: () => void }) => <button type="button" className="button primary" onClick={nav.close}>Done</button>
  return (
    <Guided title="Add a machine" question="What is it for?" onClose={onClose}
      options={[
        { id: 'models', icon: <Server size={18} />, name: 'Lending the hub its models', line: 'A Mac, or a GPU box such as a DGX Spark. The hub uses the best of what it serves for each job.', recommended: true },
        { id: 'code', icon: <Laptop size={18} />, name: 'Working on your code too', line: 'It becomes an agent that takes cards, and lends the hub its models as well.' },
      ]}
      steps={(id) => id === 'models'
        ? [{ title: 'Run this on each machine', lead: 'In a terminal, as yourself, not with sudo: a Mac, or Linux such as a DGX Spark.', content: <BrainLine machines={machines} />, footer: done }]
        : [{ title: 'Add it from the Agents page', lead: 'There, one line run in the folder with the code sets up an agent on the machine.', content: <p className="choice-dialog-lead">As one of the hub’s admins, each machine you add there lends its models to the hub’s brain too, and shows here.</p>, footer: <a className="button primary" href={href({ screen: 'agents' })}>Go to Agents</a> }]} />
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
        ? <div className="command"><pre className="mono">{line}</pre><button type="button" className="icon-button" aria-label="Copy the line" title="Copy the line" onClick={() => void navigator.clipboard.writeText(line).then(() => toast('Copied. Paste it in a terminal on the machine.'), () => failure('Couldn’t copy it: select it and copy it yourself.'))}><Copy size={14} /></button></div>
        : <button type="button" className="button small" onClick={() => void getLine()}>Get the line</button>)}
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

/** What each job is called, what it does, and what's said when nothing does it. */
const jobs: { job: Job; title: string; icon: ReactNode; detail: string; none: string }[] = [
  { job: 'chat', title: 'The hub’s model', icon: <Sparkles size={16} />, detail: 'Sums up what phones and Macs send, answers questions from the binders, and talks.', none: 'None yet: nothing is summed up or answered' },
  { job: 'embeddings', title: 'Finding by meaning', icon: <Search size={16} />, detail: 'Optional. Finds the passages that mean what a question asks, even in other words. Without it, passages are found by their words.', none: 'None: passages are found by their words' },
  { job: 'transcription', title: 'Writing down audio', icon: <AudioLines size={16} />, detail: 'Optional. Writes down what phones record with a bigger model than a phone can run. The audio isn’t kept.', none: 'None: phones and Macs write down what they hear' },
  { job: 'speech', title: 'Reading answers out', icon: <Volume2 size={16} />, detail: 'Optional. Reads the hub’s answers out on phones.', none: 'None: answers aren’t read out' },
]

export function BrainPanel() {
  const [brain, setBrain] = useState<BrainView>()
  const [failed, setFailed] = useState(false)
  const [admin, setAdmin] = useState(false)
  const [index, setIndex] = useState<IndexStats>()
  const [saved, setSaved] = useState<string>()
  const [apiKey, setApiKey] = useState('')
  const [embeddingsKey, setEmbeddingsKey] = useState('')
  const [transcriptionKey, setTranscriptionKey] = useState('')
  const [speechKey, setSpeechKey] = useState('')
  const [machines, setMachines] = useState<Machine[]>([])
  const [machinesLoaded, setMachinesLoaded] = useState(false)
  const [offered, setOffered] = useState<Offer[]>([])
  const [latest, setLatest] = useState<string>()
  const [choices, setChoices] = useState<Partial<Record<Job, Candidate[]>>>({})
  /** The gateways on your machines; what's typed to find a model on one, for each job; the one being tried; what it said. */
  const [gatewayList, setGatewayList] = useState<Gateway[]>([])
  const [finding, setFinding] = useState<Partial<Record<Job, string>>>({})
  const [trying, setTrying] = useState<string>()
  const [gatewaySaid, setGatewaySaid] = useState<Partial<Record<Job, string>>>({})
  /** A job's list opened past its first few. */
  const [showAll, setShowAll] = useState<Partial<Record<Job, boolean>>>({})
  /** What's open: a job's choices, a machine, or adding one. */
  const [open, setOpen] = useState<Job>()
  const [machineOpen, setMachineOpen] = useState<string>()
  const [adding, setAdding] = useState(false)

  const load = () => call<{ brain: BrainView; admin: boolean; index?: IndexStats }>('GET', '/api/brain').then((r) => {
    setBrain(r.brain)
    setAdmin(r.admin)
    setIndex(r.index)
  }).catch(() => setFailed(true))
  useEffect(() => {
    void load()
  }, [])

  // Your machines, an admin's: looked at again now and then, so one just set up shows as linked, and often while a model
  // downloads. A finished download changes what the brain uses, so the brain is read again then too.
  const loadMachines = () => void call<{ machines: Machine[]; offers?: Offer[]; latest?: string; candidates?: Partial<Record<Job, Candidate[]>>; gateways?: Gateway[] }>('GET', '/api/brain/machines').then((r) => {
    setLatest(r.latest)
    setChoices(r.candidates ?? {})
    setGatewayList(r.gateways ?? [])
    setMachines((before) => {
      const finished = r.machines.some((m) => (m.downloads ?? []).some((d) => d.done && !before.find((b) => b.id === m.id)?.downloads?.find((x) => x.model === d.model)?.done))
      if (finished) void call<{ brain: BrainView }>('GET', '/api/brain').then((b) => setBrain(b.brain)).catch(() => {})
      return r.machines
    })
    setOffered((r.offers ?? []).filter((o) => o.action === 'pull'))
    setMachinesLoaded(true)
  }).catch(() => setMachinesLoaded(true))
  const downloading = machines.some((m) => (m.downloads ?? []).some((d) => !d.done && !d.error))
  useEffect(() => {
    if (!admin) return
    loadMachines()
    const again = window.setInterval(loadMachines, downloading ? 2000 : 8000)
    return () => window.clearInterval(again)
  }, [admin, downloading])

  if (!brain) {
    return failed
      ? <div className="settings-failed"><EmptyState compact icon={<TriangleAlert size={18} />} title="Couldn’t load the brain’s settings" line="The hub didn’t answer." action={<button type="button" className="button" onClick={() => { setFailed(false); void load() }}>Try again</button>} /></div>
      : <div className="settings-wait" aria-busy="true"><p className="sr-only" role="status">Loading…</p><Skeleton lines={4} /></div>
  }

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
  const note = (key: string) => <SettingNote locked={locked[key]} saved={saved === key} />
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
  /** What a job uses, as people read it: without its publisher. */
  const shownInUse = (job: Job) => inUseFor[job]?.replace(/^[\w.-]+\/(?=[^\s/]+(,| on ))/, '')
  const lockedJob: Record<Job, string> = { chat: 'provider', embeddings: 'embeddingsBaseUrl', transcription: 'transcriptionBaseUrl', speech: 'speechBaseUrl' }
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
  /** A download under way for a job, and on which machine. */
  const goingFor = (job: Job) => {
    for (const machine of machines) {
      const going = (machine.downloads ?? []).find((d) => d.kind !== 'serve' && d.job === job)
      if (going && !(going.done && brain.autoJobs?.includes(job))) return { machine, going }
    }
    return undefined
  }

  /** How a job stands, as its row's status: what it needs, a download, chosen for you, or set on the hub. */
  const jobStatus = (job: Job) => {
    if (locked[lockedJob[job]]) return <SettingNote locked={locked[lockedJob[job]]} saved={false} />
    if (needsFor[job]) return <Status tone="bad" title={`It needs: ${needsFor[job]}`}>Needs a look</Status>
    const down = goingFor(job)
    if (down && !down.going.done && !down.going.error) return <Status tone="running">Downloading</Status>
    if (brain.autoJobs?.includes(job)) return <Status tone="ok">Chosen for you</Status>
    return undefined
  }

  /** What a job uses now, who chose it, and what's wrong with it, if anything. */
  const inUse = (job: Job) => {
    const auto = brain.autoJobs?.includes(job)
    return (
      <div className="job-in-use">
        <span className="field-label">In use {note(job === 'chat' ? 'provider' : job === 'speech' ? 'speechMachine' : `${job}Machine`)}</span>
        <p>
          {inUseFor[job] ? <b className="mono">{shownInUse(job)}</b> : <span className="faint">Nothing yet</span>}
          {auto && <Status tone="ok">Chosen for you</Status>}
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
                  <span>{c.machineName} · {sourceOf(c)} · {stateWords[c.state]}{engine && c.state === 'on-demand' ? ` · ${engine}` : ''}</span>
                </div>
                {current ? <Status tone="ok">In use</Status> : <button type="button" className="button small" disabled={!admin} onClick={() => use(job, c)}>Use</button>}
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
    const down = goingFor(job)
    if (down) {
      const { machine, going } = down
      const share = going.total > 0 ? going.completed / going.total : 0
      return (
        <div className="model-download">
          <p className="option-status"><DownloadIcon size={12} aria-hidden="true" /> {shortName(going.model)} on {machine.name}: {progressOf(going)}</p>
          {!going.done && !going.error && <div className="progress" role="progressbar" aria-label={`Downloading ${shortName(going.model)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}><span style={{ width: `${Math.max(2, share * 100)}%` }} /></div>}
        </div>
      )
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
            <div className="choice-name"><b>{shortName(offer.model)}</b><span>{on}{offer.size ? ` · ${offer.size}` : ''} · none of your machines has one yet</span></div>
            <button type="button" className="button small" disabled={!admin} onClick={() => void pull()}><DownloadIcon size={13} aria-hidden="true" /> Download</button>
          </li>
        </ul>
      </div>
    )
  }

  /**
   * Cloud models a gateway on one of your machines reaches: found by typing, and yours to choose, never the hub's. The
   * hub asks the one chosen a short thing first, and says what the gateway said when nothing comes back.
   */
  const throughGateway = (job: Job) => {
    if (job !== 'chat' && job !== 'embeddings') return null
    const all = gatewayList.flatMap((g) => (g.models[job] ?? []).map((model) => ({ machine: g.machine, machineName: g.machineName, url: g.url, model })))
    if (!all.length) return null
    type Listed = (typeof all)[number]
    const inUseNow = (g: Listed) => (job === 'chat'
      ? brain.provider === 'machine' && brain.machine === g.machine && brain.baseUrl === g.url && brain.model === g.model
      : brain.embeddingsMachine === g.machine && brain.embeddingsBaseUrl === g.url && brain.embeddingsModel === g.model)
    const words = (finding[job] ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const matching = all.filter((g) => words.every((word) => g.model.toLowerCase().includes(word)))
    // What's in use first, then as the gateway lists them.
    const ordered = [...matching.filter(inUseNow), ...matching.filter((g) => !inUseNow(g))]
    const shown = ordered.slice(0, 8)
    const keyOf = (g: Listed) => `${job} ${g.machine} ${g.url} ${g.model}`
    const portOf = (url: string) => {
      try { return new URL(url).port } catch { return '' }
    }
    const on = [...new Set(gatewayList.filter((g) => g.models[job]?.length).map((g) => g.machineName))]
    const choose = async (g: Listed) => {
      setTrying(keyOf(g))
      setGatewaySaid((now) => ({ ...now, [job]: undefined }))
      try {
        const result = await call<{ brain: BrainView }>('POST', '/api/brain/gateway', { job, machine: g.machine, url: g.url, model: g.model })
        setBrain(result.brain)
        toast(`${g.model} answered. The hub uses it now.`)
      } catch (error) {
        setGatewaySaid((now) => ({ ...now, [job]: (error as Error).message }))
      } finally {
        setTrying(undefined)
      }
    }
    const findId = `brain-gateway-find-${job}`
    return (
      <div className="choices gateway-choices">
        <span className="field-label">Through a gateway</span>
        <p className="field-hint">{all.length} cloud model{all.length === 1 ? '' : 's'}, reached through {on.join(' and ')}. What’s asked goes to that cloud, so the hub never picks one itself. The one you choose is asked a short thing first, to see that it answers.</p>
        {all.length > 8 && (
          <div className="data-table-filter">
            <Search size={15} aria-hidden="true" />
            <label htmlFor={findId} className="sr-only">Find a cloud model</label>
            <input id={findId} className="input" type="search" placeholder="Find a model: gpt-5, claude, deepseek" value={finding[job] ?? ''} onChange={(e) => setFinding((now) => ({ ...now, [job]: e.target.value }))} autoComplete="off" spellCheck={false} />
            {finding[job] && <button type="button" className="icon-button" aria-label="Clear what’s typed" onClick={() => setFinding((now) => ({ ...now, [job]: '' }))}><X size={14} /></button>}
          </div>
        )}
        {brain.localOnly && <p className="option-status">Local AI only is on, so a cloud model can’t be used. Turn it off to choose one.</p>}
        {gatewaySaid[job] && <p className="option-status option-error" role="alert">{gatewaySaid[job]}</p>}
        {shown.length > 0 && (
          <ul className="choice-list" aria-label="Cloud models through a gateway">
            {shown.map((g) => {
              const current = inUseNow(g)
              const busy = trying === keyOf(g)
              const port = portOf(g.url)
              return (
                <li key={keyOf(g)} className={current ? 'on' : undefined}>
                  <div className="choice-name">
                    <b>{g.model}</b>
                    <span>{g.machineName} · gateway{port ? ` on :${port}` : ''} · runs in a cloud</span>
                  </div>
                  {current ? <Status tone="ok">In use</Status> : (
                    <button type="button" className="button small" disabled={!admin || !!brain.localOnly || !!trying} aria-label={busy ? `Trying ${g.model}` : `Use ${g.model}`} onClick={() => void choose(g)}>
                      {busy ? <><LoaderCircle size={13} className="spin" aria-hidden="true" /> Trying it…</> : 'Use'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <p className="field-hint" role="status">{!matching.length ? 'None of them has that in its name.' : ordered.length > shown.length ? `${ordered.length - shown.length} more: type to find one.` : ''}</p>
      </div>
    )
  }

  /** A server the hub reaches by its address instead: tucked away, as most people use their machines. */
  const byAddress = (job: Exclude<Job, 'chat'>) => {
    const keys = { embeddings: [embeddingsKey, setEmbeddingsKey, brain.embeddingsKeySet] as const, transcription: [transcriptionKey, setTranscriptionKey, brain.transcriptionKeySet] as const, speech: [speechKey, setSpeechKey, brain.speechKeySet] as const }[job]
    const placeholders = { embeddings: ['http://localhost:11434/v1', 'nomic-embed-text'], transcription: ['http://localhost:8080/v1', 'whisper-large-v3'], speech: ['http://localhost:8880/v1', 'kokoro'] }[job]
    return (
      <More summary="Use a server by its address">
        <div className="by-address">
          {field(`${job}BaseUrl`, 'Its address', placeholders[0])}
          {field(`${job}Model`, 'Model', placeholders[1])}
          {job === 'speech' && field('speechVoice', 'Voice', 'af_heart')}
          {keyField(`${job}Key`, keys[0], keys[1], keys[2], 'None needed for most servers on your own machines')}
        </div>
      </More>
    )
  }
  const claudeOrAddress = (
    <More summary="Use Claude, or a server by its address" open={brain.provider === 'anthropic' || brain.provider === 'openai' || undefined}>
      <div className="by-address">
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
      </div>
    </More>
  )

  /** How much of this binder the brain has read, and where what it found by meaning is kept. */
  const read = index && <p className="option-status num">This binder: {index.sources} note{index.sources === 1 ? '' : 's'} and cards read, in {index.passages} passages{brain.embeddingsInUse ? `, ${index.withVectors} of them found by meaning` : ''}.{brain.embeddingsInUse && index.kept && <> {index.kept.error ? `The embeddings couldn’t be saved to GitHub: ${index.kept.error}` : index.kept.to ? `The embeddings are saved in ${index.kept.to}, on ${index.kept.branch}, so a rebuilt hub gets them back.` : 'The embeddings are saved on the hub’s disk: give this binder a repo and they’re saved there too.'}</>}</p>
  const job = jobs.find((j) => j.job === open)
  const machine = machines.find((m) => m.id === machineOpen)
  const remove = async (id: string) => {
    if (!(await attempt(() => call('DELETE', `/api/brain/machines/${id}`)))) return
    setMachineOpen(undefined)
    loadMachines()
  }
  const noModel = brain.provider === 'off' && !brain.inUse

  return (
    <div className="brain-settings">
      {!admin && <p className="setup-note">Only the hub’s admins can change these.</p>}
      {admin && <OldDaemons machines={machines} latest={latest} />}

      {admin && (
        <Section title="Your machines" lead="Macs and GPU boxes that lend the hub their models."
          action={<button type="button" className="button small" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add</button>}>
          <DataTable label="Your machines" columns={machineColumns} rows={machines} rowKey={(m) => m.id} onRowPress={(m) => setMachineOpen(m.id)} rowLabel={(m) => `Open ${m.name}`} loading={!machinesLoaded}
            empty={<EmptyState compact icon={<Server size={18} />} title="No machines yet" line="Add a Mac or a GPU box: the hub finds what it serves and uses the best of it for each job." />} />
        </Section>
      )}

      <Section title="Models" lead="What the hub uses for each job."
        more={<><p>The hub chooses from your machines, the best of what they serve for each job, until you choose one yourself.</p><p>A gateway to cloud models on one of them is yours to choose from: the hub never picks one itself.</p><p>Local AI only refuses Claude, a gateway’s cloud models and any address outside the hub’s own network, so nothing said or written leaves your machines.</p></>}>
        <Rows label="Models">
          {jobs.map(({ job: j, title, icon, none }) => (
            <Row key={j} icon={icon} title={title} meta={shownInUse(j) ?? none} status={jobStatus(j)}
              onPress={admin ? () => setOpen(j) : undefined} label={admin ? `${title}: ${shownInUse(j) ?? 'nothing yet'}. Change it` : undefined} />
          ))}
          <Row icon={<ShieldCheck size={16} />} title="Local AI only" meta="Every model on the hub’s own network: this machine, your LAN or your VPN"
            status={note('localOnly')} trailing={<Switch label="Local AI only" on={!!brain.localOnly} disabled={off('localOnly')} onChange={(on) => void save({ localOnly: on }, 'localOnly')} />} />
        </Rows>
        {read && <div className="brain-read">{read}</div>}
      </Section>

      <Section title="What it does" lead={noModel ? 'With the hub’s model, once it has one.' : 'With the hub’s model.'}
        more={<p>When someone looks at what’s waiting on them, the Brain drafts an answer from the binder’s notes for them to send. Nothing goes to an agent until they press Send.</p>}>
        <Rows label="What it does">
          <Row title="Sum up conversations and meetings" meta="What phones and Macs send, as a note" status={note('summarize')}
            trailing={<Switch label="Sum up conversations and meetings" on={brain.summarize} disabled={off('summarize') || brain.provider === 'off'} onChange={(on) => void save({ summarize: on }, 'summarize')} />} />
          <Row title="Draft answers to agents’ questions" meta="From the binder’s notes, for whoever is asked to send" status={note('first')}
            trailing={<Switch label="Draft answers to agents’ questions" on={brain.first !== false} disabled={off('first') || brain.provider === 'off'} onChange={(on) => void save({ first: on }, 'first')} />} />
        </Rows>
      </Section>

      <AnimatePresence>
        {job && (
          <Dialog key={`job-${job.job}`} title={job.title} onClose={() => setOpen(undefined)} footer={<button type="button" className="button primary" onClick={() => setOpen(undefined)}>Done</button>}>
            <div className="job-dialog">
              <p className="choice-dialog-lead">{job.detail}</p>
              {inUse(job.job)}
              {download(job.job)}
              {list(job.job)}
              {throughGateway(job.job)}
              {job.job === 'speech' && voicePicker()}
              {job.job === 'chat' ? claudeOrAddress : byAddress(job.job)}
            </div>
          </Dialog>
        )}
        {machine && <MachineDialog key={`machine-${machine.id}`} machine={machine} latest={latest} onRemove={() => void remove(machine.id)} onClose={() => setMachineOpen(undefined)} />}
        {adding && <AddMachines key="add" machines={machines} onClose={() => setAdding(false)} />}
      </AnimatePresence>
    </div>
  )
}
