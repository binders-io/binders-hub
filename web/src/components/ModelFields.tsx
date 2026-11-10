import type { AgentEndpoint } from '../../../shared/work.ts'
import { Field } from './Dialog'
import { modelKinds } from './modelAgent'

// The boxes adding a model agent and editing one share: what it takes, its model, and its key.

type Takes = AgentEndpoint['takes']

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
export function KeyField({ value, onChange, hint }: { value: string; onChange: (value: string) => void; hint?: string }) {
  return (
    <Field label="Key" hint={hint}>
      <input type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
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
 * only for Microsoft Foundry. `keyHint` is what the key's box says about the key.
 */
export function ModelKindFields({ values, onChange, keyHint, onKind }: { values: ModelValues; onChange: (values: ModelValues) => void; keyHint?: string; onKind?: (kind: ModelValues['kind']) => void }) {
  const set = (fields: Partial<ModelValues>) => onChange({ ...values, ...fields })
  const { kind } = values
  return (
    <>
      <div className="field" role="radiogroup" aria-label="What it is">
        <span className="field-label" aria-hidden="true">What it is</span>
        <div className="model-agent-kinds">
          {modelKinds.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`model-agent-kind${kind === k.id ? ' on' : ''}`} onClick={() => (onKind ? onKind(k.id) : set({ kind: k.id }))}>
              <b>{k.name}</b>
              <em>{k.help}</em>
            </button>
          ))}
        </div>
      </div>
      {kind === 'openai' && (
        <>
          <Field label="Address" hint="The address ending in /v1. For Azure and Foundry, your resource’s address followed by /openai/v1.">
            <input className="mono" inputMode="url" value={values.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://your-resource.openai.azure.com/openai/v1" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
          <ModelField value={values.model} onChange={(model) => set({ model })} />
          <KeyField value={values.key} onChange={(key) => set({ key })} hint={keyHint} />
        </>
      )}
      {kind === 'anthropic' && (
        <>
          <ModelField value={values.model} onChange={(model) => set({ model })} placeholder="claude-opus-5-5" />
          <KeyField value={values.key} onChange={(key) => set({ key })} hint={keyHint} />
          <Field label="Address (optional)" hint="Only for Microsoft Foundry. Leave empty for Anthropic.">
            <input className="mono" inputMode="url" value={values.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://your-resource.services.ai.azure.com/anthropic" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        </>
      )}
    </>
  )
}
