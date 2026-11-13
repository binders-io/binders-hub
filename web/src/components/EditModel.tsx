import { useState, type FormEvent } from 'react'
import { TriangleAlert } from 'lucide-react'
import { call } from '../data/api'
import type { Agent } from '../data/model'
import type { AgentEndpoint } from '../../../shared/work.ts'
import { Dialog } from './Dialog'
import { SettingsLink } from './SettingsLink'
import { AddressField, KeyField, ModelField, ModelSays, TakesField } from './ModelFields'
import { boxOf, movedTo, newAddressNeedsKey, useHubServers } from './modelAgent'

/**
 * Changing an agent that is a model at an address: its model or deployment, its address where its kind has one, a new
 * key, and what it takes. The hub tries it again as it saves, so the card shows whether it works now. The key is never
 * sent back to the page, so the box starts empty, and empty means keep the one that's there. A refusal shows in the form,
 * beside the box it's about when it names one.
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
  // A server on one of the hub's machines: its address is the machine's, and it has no key, so only its model changes
  // here. The models that server has are offered as one is typed.
  const servers = useHubServers()
  const onMachine = endpoint.kind === 'openai' && !!endpoint.machine
  const served = onMachine ? servers.find((s) => s.machine === endpoint.machine && s.url === endpoint.baseUrl) : undefined

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
  const box = endpoint.kind === 'brain' ? undefined : boxOf(problem)
  const keyHint = movedTo(baseUrl, endpoint.baseUrl) ? newAddressNeedsKey : 'Empty keeps the key that’s there. Type one to replace it.'

  return (
    <Dialog title={`Edit ${agent.name}`} onClose={onClose} closeOnlyFromButton={saving}>
      <form className="form model-agent-form" onSubmit={(e) => void save(e)} aria-busy={saving}>
        {warning && <p className="agent-warning model-agent-warning" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{still ? `Saved, and it still isn’t ready: ${warning}` : `It isn’t ready: ${warning}`}</span></p>}
        <p className="field-hint model-agent-kind-line">
          {endpoint.kind === 'brain' ? <>It uses the model set up in <SettingsLink section="brain" />.</>
            : onMachine ? `A server on ${endpoint.machineName ?? 'one of the hub’s machines'}, which the hub reaches through that machine.`
              : endpoint.kind === 'openai' ? 'A server that speaks OpenAI’s chat API.'
              : 'Claude, by Anthropic’s API.'}
        </p>
        {endpoint.kind === 'openai' && !onMachine && <AddressField kind="openai" value={baseUrl} onChange={clear(setBaseUrl)} error={box === 'baseUrl' ? problem : undefined} />}
        {endpoint.kind !== 'brain' && <ModelField value={model} onChange={clear(setModel)} placeholder={endpoint.kind === 'anthropic' ? 'claude-opus-5-5' : undefined} options={served?.models} />}
        {endpoint.kind !== 'brain' && !onMachine && <KeyField value={key} onChange={clear(setKey)} hint={keyHint} error={box === 'key' ? problem : undefined} />}
        {endpoint.kind === 'anthropic' && <AddressField kind="anthropic" value={baseUrl} onChange={clear(setBaseUrl)} error={box === 'baseUrl' ? problem : undefined} />}
        <TakesField takes={takes} onChange={clear(setTakes)} />
        <ModelSays busy={saving ? 'Saving it, and trying it again…' : undefined} problem={box && !onMachine ? undefined : problem} />
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={saving}>{still ? 'Close' : 'Cancel'}</button>
          <button type="submit" className="button primary" disabled={saving}>Save</button>
        </footer>
      </form>
    </Dialog>
  )
}
