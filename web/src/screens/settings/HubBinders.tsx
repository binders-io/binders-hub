import { useEffect, useState, type FormEvent } from 'react'
import { FileUp, UserPlus } from 'lucide-react'
import { call, upload } from '../../data/api'
import { spaceHref } from '../../data/space'
import { useStore } from '../../data/store'
import { Dialog, Field } from '../../components/Dialog'
import { attempt, toast } from '../../components/Toast'
import { nameFromCopy } from './access'

/** A binder as the hub lists it for its admins. */
export interface HubBinder {
  id: string
  name: string
  createdAt: string
  first?: boolean
  people: number
  owners: string[]
  admins: string[]
  /** Whether the asker can open it: they're in it, it's open to everyone, or it has no owner. */
  yours: boolean
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The names as a sentence says them: @ana, @bo and @cy. */
const listed = (logins: string[]) => {
  const names = logins.map((l) => `@${l}`)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

/**
 * Every binder on the hub and who owns it, for the hub's admins: those with no owner first, each with a button to name
 * one. A binder the admin is in links to it; the rest they can see and name an owner for, and not open.
 */
export function HubBinders() {
  const admin = !!useStore().state.me?.hubAdmin
  const [binders, setBinders] = useState<HubBinder[]>()
  const [failed, setFailed] = useState<string>()
  const [naming, setNaming] = useState<HubBinder>()
  const [fromCopy, setFromCopy] = useState(false)

  useEffect(() => {
    if (!admin) return
    call<{ binders: HubBinder[] }>('GET', '/api/hub/binders')
      .then((found) => { if (Array.isArray(found?.binders)) setBinders(found.binders) })
      .catch((error: Error) => setFailed(error.message))
  }, [admin])

  if (!admin) return null
  if (failed) return <p className="setup-note" role="alert">{failed}</p>
  if (!binders) return null

  // Those with no owner come first; the hub's own order holds within each.
  const ordered = [...binders.filter((b) => !b.owners.length), ...binders.filter((b) => b.owners.length)]
  const made = (list?: HubBinder[]) => { if (list) setBinders(list) }
  return (
    <>
      <div><button type="button" className="button" onClick={() => setFromCopy(true)}><FileUp size={14} /> New binder from a copy</button></div>
      {!binders.length && <p className="setup-note">No binders on this hub yet.</p>}
      {binders.length > 0 && <ul className="binder-cards" aria-label="Binders on this hub">
        {ordered.map((b) => (
          <li key={b.id} className="settings-card hub-binder">
            <div className="hub-binder-head">
              <b>{b.yours ? <a href={spaceHref(b.id, '#/home')}>{b.name}</a> : b.name}</b>
              {!b.owners.length && <span className="tag warn">No owner</span>}
              <button type="button" className="button" aria-label={`Name an owner for ${b.name}`} onClick={() => setNaming(b)}><UserPlus size={14} /> Name an owner</button>
            </div>
            <span className="faint mono">{window.location.origin}/{b.id}</span>
            <span className="faint">
              {b.owners.length ? `Owned by ${listed(b.owners)}` : b.admins.length ? `Admins ${listed(b.admins)}` : 'Nobody runs it'} · {plural(b.people, 'person', 'people')}
            </span>
          </li>
        ))}
      </ul>}
      {fromCopy && <FromCopy onClose={() => setFromCopy(false)} onMade={made} />}
      {naming && <NameOwner binder={naming} onClose={() => setNaming(undefined)} onDone={(list) => { if (list) setBinders(list); setNaming(undefined) }} />}
    </>
  )
}

/** One field for a GitHub login, and one button that says who it makes an owner. */
function NameOwner({ binder, onClose, onDone }: { binder: HubBinder; onClose: () => void; onDone: (list?: HubBinder[]) => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const login = typed.trim().replace(/^@/, '')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!login) return
    setBusy(true)
    // A refusal shows as a toast, in the hub's own words, and the dialog stays for another try.
    const done = await attempt(() => call<{ binders: HubBinder[] }>('PUT', `/api/hub/binders/${encodeURIComponent(binder.id)}/owners/${encodeURIComponent(login)}`))
    setBusy(false)
    if (!done) return
    toast(`Made @${login} an owner of ${binder.name}.`)
    onDone(Array.isArray(done.binders) ? done.binders : undefined)
  }
  return (
    <Dialog title="Name an owner" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="field-hint">{binder.name}</p>
        {/* A binder nobody is in is open to everyone who can sign in: its first owner closes it to the rest. */}
        {binder.people === 0 && <p className="setup-note" role="note">Nobody is in this binder yet, so everyone who can sign in can open it. Once it has an owner, only the people added to it can.</p>}
        <Field label="GitHub login">
          <input id="owner-login" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Their GitHub login" autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </Field>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !login}>{login ? `Make @${login} an owner` : 'Make an owner'}</button>
        </footer>
      </form>
    </Dialog>
  )
}

/** A file and a name, and a new binder started from them, paused so it can sit beside the one the copy was taken from. */
function FromCopy({ onClose, onMade }: { onClose: () => void; onMade: (list?: HubBinder[]) => void }) {
  const [file, setFile] = useState<File>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<{ id: string; name: string }>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !name.trim()) return
    setBusy(true)
    // A refusal shows as a toast, in the hub's own words, and the dialog stays for another try.
    const done = await attempt(() => upload<{ binders: HubBinder[]; created: { id: string; name: string } }>(`/api/hub/binders/from-copy?name=${encodeURIComponent(name.trim())}`, file, 'application/gzip'))
    setBusy(false)
    if (!done) return
    toast(`Made ${done.created.name} from the copy.`)
    onMade(Array.isArray(done.binders) ? done.binders : undefined)
    setMade(done.created)
  }
  if (made) {
    return (
      <Dialog title="New binder from a copy" onClose={onClose}>
        <div className="form">
          <p className="field-hint">It doesn’t write to GitHub until that’s turned on in its Settings.</p>
          <p><a href={spaceHref(made.id, '#/home')}>Open {made.name}</a></p>
        </div>
      </Dialog>
    )
  }
  return (
    <Dialog title="New binder from a copy" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="The copy">
          <input id="copy-file" type="file" accept=".gz,application/gzip" onChange={(e) => {
            const chosen = e.target.files?.[0]
            setFile(chosen)
            if (chosen) setName(nameFromCopy(chosen.name))
          }} />
        </Field>
        <Field label="Name">
          <input id="copy-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !file || !name.trim()}>{busy ? 'Making it…' : 'Make the binder'}</button>
        </footer>
      </form>
    </Dialog>
  )
}
