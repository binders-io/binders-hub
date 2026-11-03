import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '../data/store'
import { Dialog } from './Dialog'
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

  return (
    <Dialog title={`Split “${card.title}”`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <p className="faint">
          Each part becomes a card of its own, for the agent it names, with this card’s brief behind its own. This card waits for every part, and is done when they all are.
        </p>
        {parts.map((part, index) => (
          <div key={index} className="swarm-part">
            <div className="form-row">
              <input aria-label={`Part ${index + 1} title`} value={part.title} onChange={(e) => change(index, 'title', e.target.value)} placeholder={`Part ${index + 1} — what it does`} />
              <select aria-label={`Part ${index + 1} agent`} value={part.agent} onChange={(e) => change(index, 'agent', e.target.value)}>
                <option value="">Any agent</option>
                {state.agents.filter((a) => !a.revoked).map((a) => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
              {parts.length > 2 && (
                <button type="button" className="icon-button" aria-label={`Remove part ${index + 1}`} onClick={() => remove(index)}><Trash2 size={13} /></button>
              )}
            </div>
            <textarea aria-label={`Part ${index + 1} brief`} rows={2} value={part.brief} onChange={(e) => change(index, 'brief', e.target.value)} placeholder="What this part covers (optional; this card’s brief goes with it)" />
          </div>
        ))}
        <button type="button" className="text-button" onClick={add}><Plus size={13} /> Another part</button>
        <div>
          <button className="button primary" disabled={busy || parts.filter((p) => p.title.trim()).length < 2}>Split it</button>
        </div>
      </form>
    </Dialog>
  )
}
