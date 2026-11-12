import { useEffect, useId, useRef, type ReactNode } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import type { AgentEndpoint } from '../../../shared/work.ts'
import { Field } from './Dialog'
import { Status } from '../kit'
import { machineKind, modelKinds, localMeansTheHub, looksLocal, serversAt, serverWords, type HubServer, type ModelBox } from './modelAgent'

// The boxes adding a model agent and editing one share: what it takes, its model, and its key; and how the forms say
// what the hub found, as a status under them or beside the box it's about.

type Takes = AgentEndpoint['takes']

/** What's wrong with a box, under it, in the colour that says so; it's read out as it comes. */
const wrong = (text: string) => <span className="field-error" role="alert">{text}</span>

const takesChoices: { key: keyof Takes; label: string }[] = [
  { key: 'cards', label: 'Cards given to it by name, and notes a folder distills' },
  { key: 'chats', label: 'Chats about a note' },
  { key: 'debriefs', label: 'Debriefs' },
  { key: 'challenges', label: 'Challenges' },
]

/** The four boxes for what it takes. */
export function TakesField({ takes, onChange, disabled = false }: { takes: Takes; onChange: (takes: Takes) => void; disabled?: boolean }) {
  return (
    <fieldset className="field model-agent-takes" disabled={disabled}>
      <legend className="field-label">What it takes</legend>
      <div className="model-agent-takes-list">
        {takesChoices.map(({ key, label }) => (
          <label key={key} className="check">
            <input type="checkbox" checked={takes[key]} onChange={(e) => onChange({ ...takes, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * The model's name or deployment, as the form has it. `options`, when a server says which models it has, are offered
 * as it's typed; a name not among them can still be typed.
 */
export function ModelField({ value, onChange, placeholder, options }: { value: string; onChange: (value: string) => void; placeholder?: string; options?: string[] }) {
  const listId = useId()
  return (
    <Field label="Model or deployment" hint={options ? `Type to find one of the ${options.length} it lists, or a deployment’s name as the server takes it.` : 'On Azure and Foundry, the deployment’s name.'}>
      <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false} list={options ? listId : undefined} />
      {options && <datalist id={listId}>{options.map((name) => <option key={name} value={name} />)}</datalist>}
    </Field>
  )
}

/** The key's box: never filled in by the page, hidden as typed, and not offered to a password manager. */
export function KeyField({ value, onChange, hint, error }: { value: string; onChange: (value: string) => void; hint?: string; error?: string }) {
  return (
    <Field label="Key" hint={error ? wrong(error) : hint}>
      <input type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={error ? true : undefined} />
    </Field>
  )
}

/**
 * A model's address, for one of the two kinds that have one. A local address is said to be the hub's own beside it, and
 * so is what the hub found wrong with it.
 */
export function AddressField({ kind, value, onChange, error, served = [], onServed }: { kind: 'openai' | 'anthropic'; value: string; onChange: (value: string) => void; error?: string; served?: HubServer[]; onServed?: (server: HubServer) => void }) {
  // An address the hub's machines serve: the hub may not reach it from where it runs, and each of those machines does.
  const names = served.map((s) => s.machineName)
  const through = served.length > 0 && onServed && (
    <span className="field-warn">
      {names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} serve` : `${names[0]} serves`} that address, and the hub may not reach it from where it runs.{' '}
      {served.map((s) => <button key={s.machine} type="button" className="text-button" onClick={() => onServed(s)}>Reach it through {s.machineName}</button>)}
    </span>
  )
  const hint = error ? wrong(error) : through ? through : looksLocal(value) ? <span className="field-warn">{localMeansTheHub}</span>
    : kind === 'openai' ? 'The address ending in /v1. For Azure and Foundry, your resource’s address followed by /openai/v1.'
      : 'Only for Microsoft Foundry. Leave empty for Anthropic.'
  return (
    <Field label={kind === 'openai' ? 'Address' : 'Address (optional)'} hint={hint}>
      <input className="mono" inputMode="url" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}
        placeholder={kind === 'openai' ? 'https://your-resource.openai.azure.com/openai/v1' : 'https://your-resource.services.ai.azure.com/anthropic'} autoComplete="off" autoCapitalize="none" spellCheck={false} />
    </Field>
  )
}

/** What a form for a model holds. */
export interface ModelValues {
  kind: AgentEndpoint['kind']
  model: string
  baseUrl: string
  key: string
  /** One of the hub's machines its server is on: then `baseUrl` is the server's address there. */
  machine?: string
}

/**
 * The three kinds to choose from, and the fields the chosen kind has and no others: the hub's own model has none, a
 * server that speaks OpenAI's API has an address, a model and a key, and Claude has a model and a key, and an address
 * only for Microsoft Foundry. `keyHint` is what the key's box says about the key; `errors`, what the hub found wrong
 * with a box, said beside it.
 */
export function ModelKindFields({ values, onChange, keyHint, onKind, errors = {}, servers = [] }: { values: ModelValues; onChange: (values: ModelValues) => void; keyHint?: string; onKind?: (kind: ModelValues['kind']) => void; errors?: Partial<Record<ModelBox, string>>; servers?: HubServer[] }) {
  const set = (fields: Partial<ModelValues>) => onChange({ ...values, ...fields })
  const { kind } = values
  // A server on one of the hub's machines: an OpenAI-style one, reached through the machine. Offered when there is one
  // (to a hub admin, as the hub says none to anyone else), and shown as chosen for a model that already is on one.
  const onMachine = kind === 'openai' && !!values.machine
  const server = onMachine ? servers.find((s) => s.machine === values.machine && s.url === values.baseUrl) : undefined
  const pickServer = (s: HubServer, model = '') => onChange({ kind: 'openai', machine: s.machine, baseUrl: s.url, model, key: '' })
  const serverId = useId()
  return (
    <>
      <div className="field" role="radiogroup" aria-label="What it is">
        <span className="field-label" aria-hidden="true">What it is</span>
        <div className="model-agent-kinds">
          {modelKinds.map((k) => {
            const on = kind === k.id && !onMachine
            return (
              <button key={k.id} type="button" role="radio" aria-checked={on} className={`model-agent-kind${on ? ' on' : ''}`} onClick={() => (onKind ? onKind(k.id) : set({ kind: k.id, machine: undefined, ...(onMachine ? { baseUrl: '', model: '' } : {}) }))}>
                <i className="model-agent-radio" aria-hidden="true" />
                <span>
                  <b>{k.name}</b>
                  <em>{k.help}</em>
                </span>
              </button>
            )
          })}
          {(servers.length > 0 || onMachine) && (
            <button type="button" role="radio" aria-checked={onMachine} className={`model-agent-kind${onMachine ? ' on' : ''}`} onClick={() => { if (!onMachine && servers[0]) pickServer(servers[0]) }}>
              <i className="model-agent-radio" aria-hidden="true" />
              <span>
                <b>{machineKind.name}</b>
                <em>{machineKind.help}</em>
              </span>
            </button>
          )}
        </div>
      </div>
      {onMachine && (
        <>
          <Field label="Server" hint={errors.baseUrl ? wrong(errors.baseUrl) : 'Reached through that machine’s daemon, so the hub needs no way to it of its own, and no key.'}>
            <select id={serverId} value={server ? `${server.machine} ${server.url}` : ''} onChange={(e) => { const next = servers.find((s) => `${s.machine} ${s.url}` === e.target.value); if (next) pickServer(next) }} aria-invalid={errors.baseUrl ? true : undefined}>
              {!server && <option value="">{values.baseUrl} (not served there now)</option>}
              {servers.map((s) => <option key={`${s.machine} ${s.url}`} value={`${s.machine} ${s.url}`}>{serverWords(s)}</option>)}
            </select>
          </Field>
          <ModelField value={values.model} onChange={(model) => set({ model })} options={server?.models} />
        </>
      )}
      {kind === 'openai' && !onMachine && (
        <>
          <AddressField kind="openai" value={values.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} served={serversAt(servers, values.baseUrl)} onServed={(s) => pickServer(s, values.model)} />
          <ModelField value={values.model} onChange={(model) => set({ model })} />
          <KeyField value={values.key} onChange={(key) => set({ key })} hint={keyHint} error={errors.key} />
        </>
      )}
      {kind === 'anthropic' && (
        <>
          <ModelField value={values.model} onChange={(model) => set({ model })} placeholder="claude-opus-5-5" />
          <KeyField value={values.key} onChange={(key) => set({ key })} hint={keyHint} error={errors.key} />
          <AddressField kind="anthropic" value={values.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} />
        </>
      )}
    </>
  )
}

/** What Try it said: either it works as an agent, or the hub's own words for why it doesn't. */
export interface Tried {
  ok: boolean
  why?: string
}

/**
 * How it stands, under a model's form: working on it, what Try it found as a status, or a refusal that isn't about any
 * one box. Each is read out as it comes; a refusal and a model that doesn't work, at once.
 */
export function ModelSays({ busy, tried, problem, children }: { busy?: string; tried?: Tried; problem?: string; children?: ReactNode }) {
  // What it says comes under a form that may be scrolled past it: brought into view as it comes, unless it's in view.
  const box = useRef<HTMLDivElement>(null)
  const said = busy ?? (tried ? `${tried.ok}${tried.why}` : '') + (problem ?? '') + (children ? 'more' : '')
  useEffect(() => {
    if (said) box.current?.scrollIntoView?.({ block: 'nearest' })
  }, [said])
  return (
    <div className="model-agent-says" ref={box}>
      {busy && <p className="model-agent-result" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> {busy}</p>}
      {!busy && tried && (tried.ok
        ? <p className="model-agent-result" role="status"><Status tone="ok">Works</Status><span>It answers and calls tools.</span></p>
        : <p className="model-agent-result" role="alert"><Status tone="bad">Didn’t work</Status><span>{tried.why || 'It didn’t answer as it needs to.'}</span></p>)}
      {!busy && problem && <p className="model-agent-result bad" role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>{problem}</span></p>}
      {!busy && children}
    </div>
  )
}
