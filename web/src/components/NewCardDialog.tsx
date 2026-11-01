import { useState, type FormEvent } from 'react'
import type { Card } from '../data/model'
import { useStore } from '../data/store'
import { Dialog, Field } from './Dialog'
import { attempt } from './Toast'

/** A card put on a board by hand: what it is, what done looks like, and who it's for. */
export function NewCardDialog({ binderId, onClose }: { binderId?: string; onClose: () => void }) {
  const store = useStore()
  const { state } = store
  const [binder, setBinder] = useState(binderId ?? state.binders[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [doneWhen, setDoneWhen] = useState('')
  const [size, setSize] = useState<Card['size']>('M')
  const [meantFor, setMeantFor] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const made = await attempt(() => store.createCard({ binderId: binder, title, brief, doneWhen, size, meantFor: meantFor || undefined }))
    setBusy(false)
    if (made) onClose()
  }

  return (
    <Dialog title="New card" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {state.binders.length > 1 && (
          <Field label="Part">
            <select id="card-binder" value={binder} onChange={(e) => setBinder(e.target.value)}>
              {state.binders.map((b) => <option key={b.id} value={b.id}>{b.name}{b.repo ? ` · ${b.repo}` : ''}</option>)}
            </select>
          </Field>
        )}
        <Field label="Title">
          <input id="card-title" autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" />
        </Field>
        <Field label="Brief" hint="What an agent needs to know to do it.">
          <textarea id="card-brief" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} />
        </Field>
        <Field label="Done when">
          <input id="card-done" value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} placeholder="How you'll know it's finished" />
        </Field>
        <div className="form-row">
          <Field label="Size">
            <select id="card-size" value={size} onChange={(e) => setSize(e.target.value as Card['size'])}>
              <option value="S">Small</option>
              <option value="M">Medium</option>
              <option value="L">Large</option>
            </select>
          </Field>
          <Field label="For">
            <select id="card-for" value={meantFor} onChange={(e) => setMeantFor(e.target.value)}>
              <option value="">Any agent that can</option>
              {state.agents.filter((a) => !a.revoked).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim() || !binder}>Put on the board</button>
        </footer>
      </form>
    </Dialog>
  )
}
