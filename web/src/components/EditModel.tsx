import { useState, type FormEvent } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { call } from '../data/api'
import type { Agent } from '../data/model'
import type { AgentEndpoint } from '../../../shared/work.ts'
import { Dialog, Field } from './Dialog'
import { SettingsLink } from './SettingsLink'
import { KeyField, ModelField, TakesField } from './ModelFields'
import { movedTo, newAddressNeedsKey } from './modelAgent'

/**
 * Changing an agent that is a model at an address: its model or deployment, its address where its kind has one, a new
 * key, and what it takes. The hub tries it again as it saves, so the card shows whether it works now. The key is never
 * sent back to the page, so the box starts empty, and empty means keep the one that's there. A refusal shows in the form.
 */
export function EditModel({ agent, onClose }: { agent: Agent & { endpoint: AgentEndpoint }; onClose: () => void }) {
  const { endpoint } = agent
  const [model, setModel] = useState(endpoint.model ?? '')
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [takes, setTakes] = useState(endpoint.takes)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  // What the hub found when it tried the saved model again, when that still isn't working.
  const [still, setStill] = useState<string>()
  const ready = endpoint.ready

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setProblem(undefined)
    setStill(undefined)
    try {
      const body = {
        takes,
        ...(endpoint.kind !== 'brain' ? { model: model.trim(), baseUrl: baseUrl.trim() } : {}),
        // Only a key that was typed is sent: none keeps the one the hub has.
        ...(endpoint.kind !== 'brain' && key.trim() ? { key: key.trim() } : {}),
      }
      const sent = await call<{ agent?: Agent } | undefined>('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/endpoint`, body)
      setKey('')
      const found = sent?.agent?.endpoint?.ready
      if (found && !found.ok) setStill(found.why || 'It didn’t answer as it needs to.')
      else onClose()
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : 'The hub couldn’t save that. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const clear = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setProblem(undefined)
  }
  const warning = still ?? (ready && !ready.ok ? ready.why || 'It didn’t answer as it needs to.' : undefined)

  return (
    <Dialog title={`Edit ${agent.name}`} onClose={onClose} wide closeOnlyFromButton={saving}>
      <form className="form model-agent-form" onSubmit={(e) => void save(e)} aria-busy={saving}>
        {warning && <p className="agent-warning" role="status"><TriangleAlert size={13} aria-hidden="true" /> {still ? `Saved, and it still isn’t ready: ${warning}` : `It isn’t ready: ${warning}`}</p>}
        <p className="field-hint model-agent-kind-line">
          {endpoint.kind === 'brain' ? <>It uses the model set up in <SettingsLink section="brain" />.</>
            : endpoint.kind === 'openai' ? 'A server that speaks OpenAI’s chat API.'
              : 'Claude, by Anthropic’s API.'}
        </p>
        {endpoint.kind === 'openai' && (
          <Field label="Address" hint="The address ending in /v1. For Azure and Foundry, your resource’s address followed by /openai/v1.">
            <input className="mono" inputMode="url" value={baseUrl} onChange={(e) => clear(setBaseUrl)(e.target.value)} placeholder="https://your-resource.openai.azure.com/openai/v1" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        )}
        {endpoint.kind !== 'brain' && <ModelField value={model} onChange={clear(setModel)} placeholder={endpoint.kind === 'anthropic' ? 'claude-opus-5-5' : undefined} />}
        {endpoint.kind !== 'brain' && <KeyField value={key} onChange={clear(setKey)} hint={movedTo(baseUrl, endpoint.baseUrl) ? newAddressNeedsKey : 'Empty keeps the key that’s there. Type one to replace it.'} />}
        {endpoint.kind === 'anthropic' && (
          <Field label="Address (optional)" hint="Only for Microsoft Foundry. Leave empty for Anthropic.">
            <input className="mono" inputMode="url" value={baseUrl} onChange={(e) => clear(setBaseUrl)(e.target.value)} placeholder="https://your-resource.services.ai.azure.com/anthropic" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        )}
        <TakesField takes={takes} onChange={clear(setTakes)} />
        <div className="model-agent-says">
          {saving && <p className="model-agent-result" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Saving it, and trying it again…</p>}
          {!saving && problem && <p className="model-agent-result bad" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {problem}</p>}
        </div>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={saving}>{still ? 'Close' : 'Cancel'}</button>
          <button type="submit" className="button primary" disabled={saving}>Save</button>
        </footer>
      </form>
    </Dialog>
  )
}
