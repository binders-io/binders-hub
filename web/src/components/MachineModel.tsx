import { useState, type FormEvent } from 'react'
import { TriangleAlert } from 'lucide-react'
import { call } from '../data/api'
import type { Agent } from '../data/model'
import { ConfirmButton } from './ConfirmButton'
import { Dialog } from './Dialog'
import { ModelKindFields, ModelSays, type ModelValues, type Tried } from './ModelFields'
import { boxOf, movedTo, newAddressNeedsKey, useHubServers } from './modelAgent'

/**
 * The model of an agent on a machine (Binders' own agent): which kind, its model or deployment, its address where its
 * kind has one, and a key. The hub takes each step of the agent's model, so the machine needs no key. What it takes is
 * not here: the agent's runner settings decide that. Try it asks the hub whether the model works and saves nothing; Save
 * sets it, and the hub tries it again. Another kind replaces the model and forgets its key, so a key is typed again.
 * The key is sent in the body of those calls alone, and cleared once it's saved.
 */
export function MachineModel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const was = agent.endpoint
  const [values, setValues] = useState<ModelValues>({ kind: was?.kind ?? 'brain', model: was?.model ?? '', baseUrl: was?.baseUrl ?? '', key: '', ...(was?.machine ? { machine: was.machine } : {}) })
  const servers = useHubServers()
  const [busy, setBusy] = useState<'trying' | 'saving' | 'removing'>()
  const [result, setResult] = useState<Tried>()
  const [problem, setProblem] = useState<string>()
  // What the hub found when it tried the saved model, when that still isn't working.
  const [still, setStill] = useState<string>()
  const changed = values.kind !== was?.kind

  const edit = (next: ModelValues) => {
    setValues(next)
    setResult(undefined)
    setProblem(undefined)
  }
  // Another kind starts empty, since its address and model are not the old kind's; coming back to the first restores them.
  const pickKind = (kind: ModelValues['kind']) => {
    // From a server on one of the hub's machines to one at an address of its own is another model too.
    if (kind === values.kind && !values.machine) return
    edit(kind === was?.kind && !was.machine ? { kind, model: was.model ?? '', baseUrl: was.baseUrl ?? '', key: '' } : { kind, model: '', baseUrl: '', key: '' })
  }

  const words = (error: unknown) => (error instanceof Error && error.message ? error.message : 'The hub couldn’t do that. Try again.')
  const withModel = values.kind !== 'brain'
  const typed = {
    kind: values.kind,
    ...(withModel && values.model.trim() ? { model: values.model.trim() } : {}),
    ...(withModel && values.baseUrl.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
    ...(withModel && values.key.trim() ? { key: values.key.trim() } : {}),
    // A server on one of the hub's machines, or (sent empty) no longer one.
    ...(values.kind === 'openai' && (values.machine || was?.machine) ? { machine: values.machine ?? '' } : {}),
  }

  const run = async (doing: 'trying' | 'saving' | 'removing', work: () => Promise<void>) => {
    setBusy(doing)
    setResult(undefined)
    setProblem(undefined)
    setStill(undefined)
    try {
      await work()
    } catch (error) {
      setProblem(words(error))
    } finally {
      setBusy(undefined)
    }
  }

  const tryIt = () => run('trying', async () => {
    // With no key typed, the hub tries it with the key it keeps, when it's still the server that key was given for.
    const said = await call<Tried | undefined>('POST', '/api/agents/endpoint/test', { ...typed, agent: agent.id })
    setResult({ ok: !!said?.ok, why: said?.why })
  })

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    // An address that was there and is emptied is sent empty, so the hub forgets it; for a new kind there's none to forget.
    const body = { ...typed, ...(withModel && !values.baseUrl.trim() && !changed ? { baseUrl: '' } : {}) }
    return run('saving', async () => {
      const sent = await call<{ agent?: Agent } | undefined>('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/endpoint`, body)
      setValues((v) => ({ ...v, key: '' }))
      const found = sent?.agent?.endpoint?.ready
      if (found && !found.ok) setStill(found.why || 'It didn’t answer as it needs to.')
      else onClose()
    })
  }

  const takeAway = () => void run('removing', async () => {
    await call('DELETE', `/api/agents/${encodeURIComponent(agent.id)}/endpoint`)
    onClose()
  })

  const keyHint = !withModel ? undefined : !was ? undefined : changed ? 'A new kind of model needs its own key.' : movedTo(values.baseUrl, was.baseUrl) ? newAddressNeedsKey : 'Empty keeps the key that’s there. Type one to replace it.'
  const warning = still ?? (was?.ready && !was.ready.ok ? was.ready.why || 'It didn’t answer as it needs to.' : undefined)
  // A refusal about the address or the key is said beside that box; anything else, under the form.
  const box = withModel ? boxOf(problem) : undefined

  return (
    <Dialog title={was ? `${agent.name}’s model` : `Give ${agent.name} a model`} onClose={onClose} closeOnlyFromButton={!!busy}>
      <form className="form model-agent-form" onSubmit={save} aria-busy={!!busy}>
        <p className="field-hint model-agent-kind-line">The hub takes each step of this model for the agent, so its machine needs no key.</p>
        {warning && <p className="agent-warning model-agent-warning" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{still ? `Saved, and it still isn’t ready: ${warning}` : `It isn’t ready: ${warning}`}</span></p>}
        <fieldset className="model-agent-set" disabled={!!busy}>
          <ModelKindFields values={values} onChange={edit} onKind={pickKind} keyHint={keyHint} errors={box && problem ? { [box]: problem } : {}} servers={servers} />
        </fieldset>
        <ModelSays busy={busy === 'trying' ? 'Trying it…' : busy === 'saving' ? 'Saving it, and trying it again…' : busy === 'removing' ? 'Taking it away…' : undefined} tried={result} problem={box ? undefined : problem} />
        <footer className="form-actions model-agent-machine-actions">
          {was && (
            <span className="model-agent-away">
              <ConfirmButton className="button quiet danger" question="Take it away? Press again" onConfirm={takeAway} disabled={!!busy}>Take its model away</ConfirmButton>
            </span>
          )}
          <button type="button" className="button" onClick={() => void tryIt()} disabled={!!busy}>Try it</button>
          <button type="submit" className="button primary" disabled={!!busy}>Save</button>
        </footer>
      </form>
    </Dialog>
  )
}
