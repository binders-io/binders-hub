import { useState, type FormEvent } from 'react'
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react'
import { call } from '../data/api'
import type { Agent } from '../data/model'
import type { AgentEndpoint } from '../../../shared/work.ts'
import { Dialog, Field } from './Dialog'
import { ModelKindFields, TakesField } from './ModelFields'

type Kind = AgentEndpoint['kind']

/** What Try it and Add it say about the model: either it works as an agent, or the hub's own words for why it doesn't. */
interface Tried {
  ok: boolean
  why?: string
}

/**
 * Adding an agent that is a model at an address, with no machine: the hub runs it. Try it asks the hub whether the model
 * is reached with that key and calls a tool when asked to, saving nothing; Add it makes the agent. The key is typed
 * here and sent in the body of those two calls alone: never in an address, the browser's storage or a toast, and it's
 * cleared from the form once the agent is made. A refusal shows in the form, where the person is looking.
 */
export function AddModel({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('brain')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [takes, setTakes] = useState<AgentEndpoint['takes']>({ cards: true, chats: true, debriefs: true, challenges: true })
  const [busy, setBusy] = useState<'trying' | 'adding'>()
  const [result, setResult] = useState<Tried>()
  const [problem, setProblem] = useState<string>()
  // Once it's made, the form stays to say how it went, with its key gone, and can't be sent again.
  const [made, setMade] = useState<Agent>()

  // Changing anything makes what Try it said about the old values stale.
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setResult(undefined)
    setProblem(undefined)
  }

  /** What the hub is told about the model: only what this kind has, and nothing empty. */
  const fields = () => ({
    kind,
    ...(kind !== 'brain' && model.trim() ? { model: model.trim() } : {}),
    ...(kind !== 'brain' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(kind !== 'brain' && key.trim() ? { key: key.trim() } : {}),
  })

  const words = (error: unknown) => (error instanceof Error && error.message ? error.message : 'The hub couldn’t do that. Try again.')

  const tryIt = async () => {
    setBusy('trying')
    setResult(undefined)
    setProblem(undefined)
    try {
      const said = await call<Tried | undefined>('POST', '/api/agents/endpoint/test', fields())
      setResult({ ok: !!said?.ok, why: said?.why })
    } catch (error) {
      setProblem(words(error))
    } finally {
      setBusy(undefined)
    }
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || made || !name.trim()) return
    setBusy('adding')
    setResult(undefined)
    setProblem(undefined)
    try {
      const sent = await call<{ agent?: Agent } | undefined>('POST', '/api/agents/endpoint', { name: name.trim(), ...fields(), takes })
      setKey('')
      if (sent?.agent) setMade(sent.agent)
      else onClose()
    } catch (error) {
      setProblem(words(error))
    } finally {
      setBusy(undefined)
    }
  }

  const ready = made?.endpoint?.ready

  return (
    <Dialog title="Add a model, with no machine" onClose={onClose} wide closeOnlyFromButton={!!busy}>
      <form className="form model-agent-form" onSubmit={(e) => void add(e)} aria-busy={!!busy}>
        <fieldset className="model-agent-set" disabled={!!made}>
          <Field label="Name">
            <input id="model-agent-name" autoFocus required value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder="Azure assistant" autoComplete="off" />
          </Field>
          <ModelKindFields values={{ kind, model, baseUrl, key }} onChange={(v) => { edit(setKind)(v.kind); setModel(v.model); setBaseUrl(v.baseUrl); setKey(v.key) }} />
          <TakesField takes={takes} onChange={edit(setTakes)} />
        </fieldset>

        <div className="model-agent-says">
          {busy && <p className="model-agent-result" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> {busy === 'trying' ? 'Trying it…' : 'Adding it…'}</p>}
          {!busy && result && (result.ok
            ? <p className="model-agent-result ok" role="status"><Check size={14} strokeWidth={3} aria-hidden="true" /> It answers and calls tools.</p>
            : <p className="model-agent-result bad" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {result.why || 'It didn’t answer as it needs to.'}</p>)}
          {!busy && problem && <p className="model-agent-result bad" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {problem}</p>}
          {!busy && made && (ready && !ready.ok
            ? <p className="model-agent-result bad" role="status"><TriangleAlert size={14} aria-hidden="true" /> {`${made.name} is added, but it isn’t ready: ${ready.why || 'it didn’t answer as it needs to'}. Change its address or key from its card.`}</p>
            : <p className="model-agent-result ok" role="status"><Check size={14} strokeWidth={3} aria-hidden="true" /> {`${made.name} is added. It answers and calls tools.`}</p>)}
        </div>

        <footer className="form-actions">
          {made ? (
            <button type="button" className="button primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="button" onClick={onClose} disabled={!!busy}>Cancel</button>
              <button type="button" className="button" onClick={() => void tryIt()} disabled={!!busy}>Try it</button>
              <button type="submit" className="button primary" disabled={!!busy || !name.trim()}>Add it</button>
            </>
          )}
        </footer>
      </form>
    </Dialog>
  )
}
