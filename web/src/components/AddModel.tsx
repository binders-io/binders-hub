import { useState, type FormEvent } from 'react'
import { call } from '../data/api'
import type { Agent } from '../data/model'
import type { AgentEndpoint } from '../../../shared/work.ts'
import { Field } from './Dialog'
import { Status } from '../kit'
import { ModelKindFields, ModelSays, TakesField, type ModelValues, type Tried } from './ModelFields'
import { boxOf } from './modelAgent'

/**
 * Adding an agent that is a model at an address, with no machine: the hub runs it. A step of adding an agent, so it's a
 * form with its own buttons. Try it asks the hub whether the model is reached with that key and calls a tool when asked
 * to, saving nothing; Add it makes the agent. The key is typed here and sent in the body of those two calls alone: never
 * in an address, the browser's storage or a toast, and it's cleared from the form once the agent is made. A refusal shows
 * in the form, beside the box it's about when it names one.
 */
export function AddModelForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [values, setValues] = useState<ModelValues>({ kind: 'brain', model: '', baseUrl: '', key: '' })
  const [takes, setTakes] = useState<AgentEndpoint['takes']>({ cards: true, chats: true, debriefs: true, challenges: true })
  const [busy, setBusy] = useState<'trying' | 'adding'>()
  const [result, setResult] = useState<Tried>()
  const [problem, setProblem] = useState<string>()
  // Once it's made, the form stays to say how it went, with its key gone, and can't be sent again.
  const [made, setMade] = useState<Agent>()
  const { kind, model, baseUrl, key } = values

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
      setValues((v) => ({ ...v, key: '' }))
      if (sent?.agent) setMade(sent.agent)
      else onClose()
    } catch (error) {
      setProblem(words(error))
    } finally {
      setBusy(undefined)
    }
  }

  const ready = made?.endpoint?.ready
  // A refusal about the address or the key is said beside that box; anything else, under the form.
  const box = kind === 'brain' ? undefined : boxOf(problem)

  return (
    <form className="form model-agent-form" onSubmit={(e) => void add(e)} aria-busy={!!busy}>
      <fieldset className="model-agent-set" disabled={!!made}>
        <Field label="Name">
          <input id="model-agent-name" autoFocus required value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder="Azure assistant" autoComplete="off" />
        </Field>
        <ModelKindFields values={values} onChange={edit(setValues)} errors={box && problem ? { [box]: problem } : {}} />
        <TakesField takes={takes} onChange={edit(setTakes)} />
      </fieldset>

      <ModelSays busy={busy === 'trying' ? 'Trying it…' : busy === 'adding' ? 'Adding it…' : undefined} tried={result} problem={box ? undefined : problem}>
        {made && (ready && !ready.ok
          ? <p className="model-agent-result" role="status"><Status tone="waiting">Not ready</Status><span>{`${made.name} is added, but it isn’t ready: ${ready.why || 'it didn’t answer as it needs to'}. Change its address or key from its card.`}</span></p>
          : <p className="model-agent-result" role="status"><Status tone="ok">Added</Status><span>{`${made.name} is added. It answers and calls tools.`}</span></p>)}
      </ModelSays>

      <footer className="form-actions">
        {made ? (
          <button type="button" className="button primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button type="button" className="button" onClick={() => void tryIt()} disabled={!!busy}>Try it</button>
            <button type="submit" className="button primary" disabled={!!busy || !name.trim()}>Add it</button>
          </>
        )}
      </footer>
    </form>
  )
}
