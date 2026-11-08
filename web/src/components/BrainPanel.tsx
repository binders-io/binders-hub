import { useEffect, useState } from 'react'
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
}

interface Download {
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
  onDisk?: { name: string; source: string }[]
  looked?: { where: string; count: number }[]
}

/** A speech or transcription model, by its name: what people look for on their machines first. */
const audioModel = (name: string) => /whisper|parakeet|canary|moonshine|voxtral|asr|kokoro|tts|csm|orpheus|chatterbox|outetts|vibevoice|phonon|lfm\d*-audio/i.test(name)

/** What a machine has downloaded that nothing serves yet, in words: its audio models by name, and how many more. */
function diskLine(m: Machine) {
  const all = m.onDisk ?? []
  if (!all.length) return m.looked?.length ? `No downloaded models found in ${m.looked.map((l) => l.where).join(', ')}.` : ''
  const audio = all.filter((d) => audioModel(d.name)).map((d) => shortName(d.name))
  const rest = all.length - audio.length
  return `Downloaded: ${[...audio.slice(0, 6), ...(audio.length > 6 ? [`${audio.length - 6} more for speech`] : [])].join(', ')}${audio.length && rest ? ', and ' : ''}${rest ? `${rest} other model${rest === 1 ? '' : 's'}` : ''}. Looked in ${(m.looked ?? []).map((l) => l.where).join(', ') || 'the usual places'}.`
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

/** A model's name as people know it: without its publisher. */
const shortName = (model: string) => model.split('/').pop() ?? model

/** How far a download has got, in words: "42% of 20 GB", or what Ollama says it's doing. */
function progressOf(d: Download) {
  if (d.error) return `Couldn’t download it: ${d.error}.`
  if (d.done) return 'Downloaded. The hub is choosing it now.'
  if (d.total > 0) return `${Math.floor((d.completed / d.total) * 100)}% of ${(d.total / 1024 ** 3).toFixed(d.total > 10 * 1024 ** 3 ? 0 : 1)} GB`
  return d.status ? `${d.status.charAt(0).toUpperCase()}${d.status.slice(1)}…` : 'Starting…'
}

type Role = 'embeddings' | 'transcription' | 'speech'

const serverNames: Record<string, string> = { ollama: 'Ollama', lmstudio: 'LM Studio', vllm: 'vLLM', nim: 'NVIDIA NIM', kokoro: 'Kokoro', sglang: 'SGLang', openai: 'A server', say: 'macOS voices' }

/** A server on a machine, in words: "Ollama on :11434 · 6 models", or "macOS voices · 143". */
function serverLabel(server: MachineServer) {
  if (server.kind === 'say') return `macOS voices · ${server.models.length}`
  let port = ''
  try {
    port = new URL(server.url).port
  } catch { /* shown without */ }
  if (server.needsKey) return `A server${port ? ` on :${port}` : ''} that wants a key`
  return `${serverNames[server.kind] ?? 'A server'}${port ? ` on :${port}` : ''} · ${server.models.length} model${server.models.length === 1 ? '' : 's'}`
}

/** One of your machines, a server on it and a model there, chosen from what its daemon found. */
function MachinePicker({ id, machines, machine, baseUrl, model, voices, disabled, onPick }: {
  id: string
  machines: Machine[]
  machine: string
  baseUrl: string
  model: string
  /** macOS's voices are offered: for reading answers out. */
  voices?: boolean
  disabled: boolean
  onPick: (pick: { machine: string; baseUrl: string; model: string }) => void
}) {
  const offered = (m?: Machine) => (m?.servers ?? []).filter((s) => !s.needsKey && (voices || s.kind !== 'say'))
  const chosen = machines.find((m) => m.id === machine)
  const servers = offered(chosen)
  const server = servers.find((s) => s.url === baseUrl)
  const first = (m?: Machine) => offered(m)[0]
  if (!machines.length) return <p className="field-hint">Add a machine first, under Your machines.</p>
  return (
    <div className="machine-pick">
      <label className="field">
        <span className="field-label">Machine</span>
        <select id={`${id}-machine`} value={machine} disabled={disabled} onChange={(e) => {
          const m = machines.find((x) => x.id === e.target.value)
          onPick({ machine: e.target.value, baseUrl: first(m)?.url ?? '', model: first(m)?.models[0] ?? '' })
        }}>
          <option value="">Choose a machine</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name}{m.online ? '' : ' (away)'}</option>)}
        </select>
      </label>
      {chosen && servers.length > 0 && (
        <label className="field">
          <span className="field-label">Server on it</span>
          <select id={`${id}-server`} value={baseUrl} disabled={disabled} onChange={(e) => onPick({ machine, baseUrl: e.target.value, model: servers.find((s) => s.url === e.target.value)?.models[0] ?? '' })}>
            {!server && <option value="">Choose a server</option>}
            {servers.map((s) => <option key={s.url} value={s.url}>{serverLabel(s)}</option>)}
          </select>
        </label>
      )}
      {server && (
        <label className="field">
          <span className="field-label">{server.kind === 'say' ? 'Voice' : 'Model'}</span>
          <select id={`${id}-model`} value={model} disabled={disabled} onChange={(e) => onPick({ machine, baseUrl, model: e.target.value })}>
            {!server.models.includes(model) && <option value={model}>{model || 'Choose one'}</option>}
            {server.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      {chosen && !servers.length && <p className="field-hint">{(chosen.servers ?? []).some((s) => s.needsKey)
        ? `${chosen.name} found a model server that wants a key before it says which models it has. Start it without one for this machine (it’s reached from the machine itself), and it’s offered within five minutes.`
        : `${chosen.name} hasn’t found a model server for this: nothing listening there answered with a list of models. Once one does (Ollama, vLLM, TensorFold, a whisper server…), it’s offered within five minutes.`}</p>}
    </div>
  )
}

/** Your machines: one line that adds any of them; what each serves and whether it's linked; removing one. */
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
}

type Field = 'model' | 'baseUrl' | 'embeddingsBaseUrl' | 'embeddingsModel' | 'transcriptionBaseUrl' | 'transcriptionModel' | 'speechBaseUrl' | 'speechModel' | 'speechVoice'
type KeyName = 'apiKey' | 'embeddingsKey' | 'transcriptionKey' | 'speechKey'

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
  /** A job switched to a machine of yours, before one is chosen for it. */
  const [onMachine, setOnMachine] = useState<Partial<Record<Role, boolean>>>({})
  /** A job the hub chose, opened to choose another. */
  const [changing, setChanging] = useState<Partial<Record<Job, boolean>>>({})

  useEffect(() => {
    void call<{ brain: BrainView; admin: boolean; index?: IndexStats }>('GET', '/api/brain').then((r) => {
      setBrain(r.brain)
      setAdmin(r.admin)
      setIndex(r.index)
    }).catch(() => {})
  }, [])

  // Your machines, an admin's: looked at again now and then, so one just set up shows as linked, and often while a model
  // downloads. A finished download changes what the brain uses, so the brain is read again then too.
  const loadMachines = () => void call<{ machines: Machine[]; offers?: Offer[]; latest?: string }>('GET', '/api/brain/machines').then((r) => {
    setLatest(r.latest)
    setMachines((before) => {
      const finished = r.machines.some((m) => (m.downloads ?? []).some((d) => d.done && !before.find((b) => b.id === m.id)?.downloads?.find((x) => x.model === d.model)?.done))
      if (finished) void call<{ brain: BrainView }>('GET', '/api/brain').then((b) => setBrain(b.brain)).catch(() => {})
      return r.machines
    })
    setOffered(r.offers ?? [])
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
  const chosenForYou = (job: Job) => Boolean(brain.autoJobs?.includes(job)) && !changing[job]
  const chooseForMe = async (job: Job) => {
    const result = await attempt(() => call<{ brain: BrainView }>('POST', '/api/brain/choose', { jobs: [job] }))
    if (!result) return
    setBrain(result.brain)
    setChanging((now) => ({ ...now, [job]: false }))
  }
  const inUseFor: Record<Job, string | undefined> = { chat: brain.inUse, embeddings: brain.embeddingsInUse, transcription: brain.transcriptionInUse, speech: brain.speechInUse }
  const chosen = (job: Job) => (
    <div className="auto-pick">
      <p className="option-status"><Sparkles size={12} aria-hidden="true" /> Chosen for you: <b className="mono">{inUseFor[job] ?? 'a model on your machines'}</b>. When a better one appears on your machines, the hub moves to it.</p>
      <button type="button" className="text-button" onClick={() => setChanging((now) => ({ ...now, [job]: true }))}>Choose another</button>
    </div>
  )
  /** A download for this job: one under way (with how far it's got), or one the hub offers, a click away. */
  const download = (job: Job) => {
    for (const machine of machines) {
      const going = (machine.downloads ?? []).find((d) => d.job === job || offered.some((o) => o.model === d.model && o.jobs.includes(job)))
      if (going && !(going.done && brain.autoJobs?.includes(job))) {
        const share = going.total > 0 ? going.completed / going.total : 0
        return (
          <div className="model-download">
            <p className="option-status"><DownloadIcon size={12} aria-hidden="true" /> {going.model} on {machine.name}: {progressOf(going)}</p>
            {!going.done && !going.error && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}><span style={{ width: `${Math.max(2, share * 100)}%` }} /></div>}
          </div>
        )
      }
    }
    const offer = offered.find((o) => o.jobs.includes(job))
    if (!offer) return null
    const on = machines.find((m) => m.id === offer.machine)?.name ?? 'your machine'
    const also = offer.jobs.filter((j) => j !== job)
    const alsoWords = also.length ? ` It also ${also.includes('speech') ? 'reads answers out' : also.includes('transcription') ? 'writes down audio' : also.includes('embeddings') ? 'finds by meaning' : 'answers'}.` : ''
    if (offer.action === 'serve') {
      const model = offer.models?.[job] ?? offer.model
      // The others for the same job on that machine, which "Choose another" offers once it serves them.
      const others = (machines.find((m) => m.id === offer.machine)?.onDisk ?? []).map((d) => d.name)
        .filter((name) => name !== model && audioModel(name) && (job === 'speech' ? /kokoro|tts|csm|orpheus|chatterbox|outetts|vibevoice|phonon|lfm\d*-audio/i : /whisper|parakeet|canary|moonshine|voxtral|asr|lfm\d*-audio/i).test(name))
        .map(shortName)
      const serve = async () => {
        if (await attempt(() => call('POST', `/api/brain/machines/${offer.machine}/serve`, { runtime: offer.runtime, job }))) loadMachines()
      }
      return (
        <div className="model-download">
          <p className="option-status">{shortName(model)} is already on {on}, with nothing serving it yet.{alsoWords}{others.length ? ` Also there: ${others.slice(0, 4).join(', ')}${others.length > 4 ? `, and ${others.length - 4} more` : ''}: once it serves, Choose another picks one of them.` : ''}</p>
          <button type="button" className="button" onClick={() => void serve()}>Use it, with {offer.runtime === 'mlx-audio' ? 'mlx-audio' : 'LM Studio'}</button>
        </div>
      )
    }
    const pull = async () => {
      if (await attempt(() => call('POST', `/api/brain/machines/${offer.machine}/pull`, { model: offer.model, job, source: offer.source }))) loadMachines()
    }
    return (
      <div className="model-download">
        <p className="option-status">None of your machines has a model for this yet.{alsoWords}</p>
        <button type="button" className="button" onClick={() => void pull()}><DownloadIcon size={13} aria-hidden="true" /> Download {shortName(offer.model)} on {on}{offer.size ? ` (${offer.size})` : ''}</button>
      </div>
    )
  }

  /** Handing a job back, when your machines have models and the job is someone's choice. */
  const letHub = (job: Job) => machines.some((m) => m.online && m.servers?.length) && !brain.autoJobs?.includes(job)
    ? <button type="button" className="text-button" onClick={() => void chooseForMe(job)}>Let the hub choose from your machines</button>
    : null

  /** Whether a job is on one of your machines: chosen, or being chosen. */
  const usesMachine = (role: Role) => Boolean(brain[`${role}Machine`]) || Boolean(onMachine[role])
  const where = (role: Role) => (
    <Segmented id={`brain-${role}-where`} value={usesMachine(role) ? 'machine' : 'server'} disabled={!admin}
      onChange={(next) => {
        setOnMachine((now) => ({ ...now, [role]: next === 'machine' }))
        // Back to a server: what was chosen on the machine goes, as it was for it.
        if (next === 'server' && brain[`${role}Machine`]) void save({ [`${role}Machine`]: '', [`${role}BaseUrl`]: '', [`${role}Model`]: '', ...(role === 'speech' ? { speechVoice: '' } : {}) }, `${role}Machine`)
      }}
      choices={[['server', 'A server'], ['machine', 'A machine of yours']]} />
  )
  const picker = (role: Role) => {
    // macOS's voices: the voice is the choice, kept as the voice.
    const sayVoice = role === 'speech' && brain.speechBaseUrl === 'say:'
    return (
      <MachinePicker id={`brain-${role}`} machines={machines} voices={role === 'speech'} disabled={!admin}
        machine={brain[`${role}Machine`] ?? ''} baseUrl={brain[`${role}BaseUrl`] ?? ''} model={(sayVoice ? brain.speechVoice : brain[`${role}Model`]) ?? ''}
        onPick={(pick) => void save(role === 'speech' && pick.baseUrl === 'say:'
          ? { speechMachine: pick.machine, speechBaseUrl: 'say:', speechModel: '', speechVoice: pick.model }
          : { [`${role}Machine`]: pick.machine, [`${role}BaseUrl`]: pick.baseUrl, [`${role}Model`]: pick.model }, `${role}Machine`)} />
    )
  }
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

  return (
    <div className="options">
      {!admin && <p className="setup-note">Only the hub’s admins can change these.</p>}

      <Option title="In use" detail="What the brain does now, and how much of this binder it has read.">
        <p className="option-status">
          {brain.inUse ? <>Summing up and answering with <b className="mono">{brain.inUse}</b>.</> : 'No model: the brain finds passages by their words, and doesn’t sum up or answer.'}
          {' '}{brain.embeddingsInUse ? <>Finding by meaning with <b className="mono">{brain.embeddingsInUse}</b>.</> : 'Finding by words only.'}
        </p>
        {brain.needs && <p className="option-status option-error">The model needs: {brain.needs}</p>}
        {brain.embeddingsNeeds && <p className="option-status option-error">Embeddings need: {brain.embeddingsNeeds}</p>}
        <p className="option-status">
          {brain.transcriptionInUse ? <>Writing down what phones send as audio with <b className="mono">{brain.transcriptionInUse}</b>.</> : 'No transcription model: phones and Macs write down what they hear themselves.'}
          {' '}{brain.speechInUse ? <>Reading answers out with <b className="mono">{brain.speechInUse}</b>.</> : ''}
          {brain.localOnly ? ' Local AI only: every model is on the hub’s own network.' : ''}
        </p>
        {brain.transcriptionNeeds && <p className="option-status option-error">Transcription needs: {brain.transcriptionNeeds}</p>}
        {brain.speechNeeds && <p className="option-status option-error">Speech needs: {brain.speechNeeds}</p>}
        {index && <p className="option-status num">This binder: {index.sources} note{index.sources === 1 ? '' : 's'} and cards read, in {index.passages} passages{brain.embeddingsInUse ? `, ${index.withVectors} of them found by meaning` : ''}.</p>}
      </Option>

      {admin && <>
        <Machines machines={machines} onChange={loadMachines} latest={latest} />

        <Option title="The hub’s model" detail="Sums up the conversations and meetings phones and Macs send, and answers questions from the binders, citing the notes and cards it used. Claude runs at Anthropic with the hub’s key; a server of your own, such as Ollama, LM Studio or vLLM, keeps the words on your machines." aside={note('provider')}>
          {download('chat')}
          {chosenForYou('chat') ? chosen('chat') : <>
          <Segmented id="brain-provider" value={brain.provider} disabled={off('provider')} onChange={(provider) => void save({ provider }, 'provider')}
            choices={[['off', 'Off'], ['anthropic', 'Claude'], ['openai', 'A server of your own'], ['machine', 'A machine of yours']]} />
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
          {brain.provider === 'machine' && (
            <MachinePicker id="brain" machines={machines} machine={brain.machine ?? ''} baseUrl={brain.baseUrl ?? ''} model={brain.model ?? ''} disabled={off('provider')}
              onPick={(pick) => void save({ provider: 'machine', ...pick }, 'provider')} />
          )}
          {letHub('chat')}
          </>}
        </Option>

        <Option title="Summing up" detail="A conversation or meeting sent to the hub gets a summary at the top of its note: what it was about, what was decided, and who said they’d do what. Distill can then turn the note into cards." aside={note('summarize')}>
          <Segmented id="brain-summarize" value={brain.summarize ? 'on' : 'off'} disabled={off('summarize') || brain.provider === 'off'} onChange={(on) => void save({ summarize: on === 'on' }, 'summarize')} choices={[['on', 'On'], ['off', 'Off']]} />
        </Option>

        <Option title="Finding by meaning" detail="Optional. An embeddings model finds the passages that mean what a question asks, even in other words. Any server that speaks OpenAI’s embeddings API works: Ollama, LM Studio, OpenAI or Voyage. Without one, the brain finds passages by their words.">
          {download('embeddings')}
          {chosenForYou('embeddings') ? chosen('embeddings') : <>
          {where('embeddings')}
          {usesMachine('embeddings') ? picker('embeddings') : <>
            {field('embeddingsBaseUrl', 'Its address', 'http://localhost:11434/v1')}
            {field('embeddingsModel', 'Model', 'nomic-embed-text')}
            {keyField('embeddingsKey', embeddingsKey, setEmbeddingsKey, brain.embeddingsKeySet, 'None needed for most servers on your own machines')}
          </>}
          {letHub('embeddings')}
          </>}
        </Option>

        <Option title="Writing down audio" detail="Optional. With a transcription model, phones send the hub what they record and the hub writes it down, with a bigger model than a phone can run; the voices the phone told apart keep their names. The audio isn’t kept. Any server that speaks OpenAI’s transcription API works: a whisper.cpp or faster-whisper server, a Parakeet server, or OpenAI.">
          {download('transcription')}
          {chosenForYou('transcription') ? chosen('transcription') : <>
          {where('transcription')}
          {usesMachine('transcription') ? picker('transcription') : <>
            {field('transcriptionBaseUrl', 'Its address', 'http://localhost:8080/v1')}
            {field('transcriptionModel', 'Model', 'whisper-large-v3')}
            {keyField('transcriptionKey', transcriptionKey, setTranscriptionKey, brain.transcriptionKeySet, 'None needed for most servers on your own machines')}
          </>}
          {letHub('transcription')}
          </>}
        </Option>

        <Option title="Reading answers out" detail="Optional. A speech model reads the hub’s answers out on phones, in a voice you choose. Any server that speaks OpenAI’s speech API works: Kokoro, a Piper gateway, or OpenAI; and a Mac of yours reads them out in macOS’s own voices.">
          {download('speech')}
          {chosenForYou('speech') ? chosen('speech') : <>
          {where('speech')}
          {usesMachine('speech') ? <>
            {picker('speech')}
            {brain.speechMachine && brain.speechBaseUrl && brain.speechBaseUrl !== 'say:' && field('speechVoice', 'Voice', 'af_heart')}
          </> : <>
            {field('speechBaseUrl', 'Its address', 'http://localhost:8880/v1')}
            {field('speechModel', 'Model', 'kokoro')}
            {field('speechVoice', 'Voice', 'af_heart')}
            {keyField('speechKey', speechKey, setSpeechKey, brain.speechKeySet, 'None needed for most servers on your own machines')}
          </>}
          {letHub('speech')}
          </>}
        </Option>

        <Option title="Local AI only" detail="Every model the hub uses runs on its own network: this machine, your LAN or your VPN. Claude and any address outside it are refused, so nothing said or written leaves your machines." aside={note('localOnly')}>
          <Segmented id="brain-local-only" value={brain.localOnly ? 'on' : 'off'} disabled={off('localOnly')} onChange={(on) => void save({ localOnly: on === 'on' }, 'localOnly')} choices={[['off', 'Off'], ['on', 'On']]} />
        </Option>
      </>}
    </div>
  )
}
