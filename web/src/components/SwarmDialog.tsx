import { useId, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '../data/store'
import { Dialog, Field } from './Dialog'
import { attempt } from './Toast'

interface Part {
  title: string
  brief: string
  agent: string
}

/** Splits a card for a swarm of agents: each part a card of its own, the card waiting for every part. */
export function SwarmDialog({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const store = useStore()
  const { state } = store
  const card = state.cards.find((c) => c.id === cardId)
  const [parts, setParts] = useState<Part[]>([
    { title: '', brief: '', agent: '' },
    { title: '', brief: '', agent: '' },
  ])
  const [busy, setBusy] = useState(false)
  const formId = useId()

  if (!card) return null
  const change = (index: number, field: keyof Part, value: string) =>
    setParts((was) => was.map((part, i) => (i === index ? { ...part, [field]: value } : part)))
  const add = () => setParts((was) => [...was, { title: '', brief: '', agent: '' }])
  const remove = (index: number) => setParts((was) => was.filter((_, i) => i !== index))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const clean = parts.filter((p) => p.title.trim())
    if (clean.length < 2) return
    setBusy(true)
    const split = await attempt(async () => {
      await store.splitCard(card.id, clean.map((p) => ({ title: p.title, ...(p.brief.trim() ? { brief: p.brief } : {}), ...(p.agent.trim() ? { agent: p.agent } : {}) })))
      return true
    })
    setBusy(false)
    // Refused, it stays open with what was typed, to change and send again.
    if (split) onClose()
  }

  const ready = parts.filter((p) => p.title.trim()).length >= 2
  return (
    <Dialog title={`Split “${card.title}”`} onClose={onClose} size="large" footer={
      <>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" form={formId} className="button primary" disabled={busy || !ready}>Split it</button>
      </>
    }>
      <form className="form swarm-form" id={formId} onSubmit={submit}>
        <p className="swarm-lead">Each part becomes a card of its own, with this card’s brief behind it. This card waits for every part, and is done when they all are.</p>
        {parts.map((part, index) => (
          // Each part a group of its own, named by its heading, so its three boxes read as that part's.
          <div key={index} className="swarm-part" role="group" aria-labelledby={`${formId}-part-${index}`}>
            <div className="swarm-part-head">
              <h3 id={`${formId}-part-${index}`}>Part {index + 1}</h3>
              {parts.length > 2 && (
                <button type="button" className="button quiet small" aria-label={`Remove part ${index + 1}`} onClick={() => remove(index)}><Trash2 size={13} aria-hidden="true" />Remove</button>
              )}
            </div>
            <Field label="What it does">
              <input value={part.title} onChange={(e) => change(index, 'title', e.target.value)} />
            </Field>
            <Field label="For">
              <select value={part.agent} onChange={(e) => change(index, 'agent', e.target.value)}>
                <option value="">Any agent</option>
                {state.agents.filter((a) => !a.revoked).map((a) => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="What it covers" hint="Only if it needs more than this card’s brief.">
              <textarea rows={2} value={part.brief} onChange={(e) => change(index, 'brief', e.target.value)} />
            </Field>
          </div>
        ))}
        <button type="button" className="button small swarm-add" onClick={add}><Plus size={14} aria-hidden="true" />Another part</button>
      </form>
    </Dialog>
  )
}
