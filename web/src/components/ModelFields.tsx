import { useEffect, useRef, type ReactNode } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import type { AgentEndpoint } from '../../../shared/work.ts'
import { Field } from './Dialog'
import { Status } from '../kit'
import { modelKinds, localMeansTheHub, looksLocal, type ModelBox } from './modelAgent'

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

/** The model's name or deployment, as the form has it. */
export function ModelField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <Field label="Model or deployment" hint="On Azure and Foundry, the deployment’s name.">
      <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false} />
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
export function AddressField({ kind, value, onChange, error }: { kind: 'openai' | 'anthropic'; value: string; onChange: (value: string) => void; error?: string }) {
  const hint = error ? wrong(error) : looksLocal(value) ? <span className="field-warn">{localMeansTheHub}</span>
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
}

/**
 * The three kinds to choose from, and the fields the chosen kind has and no others: the hub's own model has none, a
 * server that speaks OpenAI's API has an address, a model and a key, and Claude has a model and a key, and an address
 * only for Microsoft Foundry. `keyHint` is what the key's box says about the key; `errors`, what the hub found wrong
 * with a box, said beside it.
 */
export function ModelKindFields({ values, onChange, keyHint, onKind, errors = {} }: { values: ModelValues; onChange: (values: ModelValues) => void; keyHint?: string; onKind?: (kind: ModelValues['kind']) => void; errors?: Partial<Record<ModelBox, string>> }) {
  const set = (fields: Partial<ModelValues>) => onChange({ ...values, ...fields })
  const { kind } = values
  return (
    <>
      <div className="field" role="radiogroup" aria-label="What it is">
        <span className="field-label" aria-hidden="true">What it is</span>
        <div className="model-agent-kinds">
          {modelKinds.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`model-agent-kind${kind === k.id ? ' on' : ''}`} onClick={() => (onKind ? onKind(k.id) : set({ kind: k.id }))}>
              <i className="model-agent-radio" aria-hidden="true" />
              <span>
                <b>{k.name}</b>
                <em>{k.help}</em>
              </span>
            </button>
          ))}
        </div>
      </div>
      {kind === 'openai' && (
        <>
          <AddressField kind="openai" value={values.baseUrl} onChange={(baseUrl) => set({ baseUrl })} error={errors.baseUrl} />
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
