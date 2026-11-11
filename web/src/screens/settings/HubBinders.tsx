import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowRight, Boxes, FilePlus2, FileUp, Plus, RotateCcw, TriangleAlert } from 'lucide-react'
import { call, upload } from '../../data/api'
import { spaceHref } from '../../data/space'
import { useStore } from '../../data/store'
import { DataTable, Dialog, EmptyState, Field, Guided, Status, type Column } from '../../kit'
import { NewSpace } from '../../components/SpacePanel'
import { attempt, toast } from '../../components/Toast'
import { nameFromCopy } from './access'
import { CopyButton, HeaderAction } from './shared'

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

/** Who runs a binder, in a few words: its owners, else its admins, else nobody. */
const runBy = (b: HubBinder) => (b.owners.length ? `Owned by ${listed(b.owners)}` : b.admins.length ? `Admins ${listed(b.admins)}` : 'Nobody runs it')

/**
 * Every binder on the hub and who owns it, for the hub's admins, as a table: those with no owner first. Pressing one
 * names an owner for it, and opens it when the admin is in it. One button makes a new binder, empty or from a copy.
 */
export function HubBinders() {
  const me = useStore().state.me
  const admin = !!me?.hubAdmin
  const [binders, setBinders] = useState<HubBinder[]>()
  const [failed, setFailed] = useState<string>()
  const [naming, setNaming] = useState<HubBinder>()
  const [making, setMaking] = useState(false)
  const [made, setMade] = useState<{ id: string; name: string }>()

  const load = useCallback(() => call<{ binders: HubBinder[] }>('GET', '/api/hub/binders')
    .then((found) => { if (Array.isArray(found?.binders)) setBinders(found.binders) })
    .catch((error: Error) => setFailed(error.message)), [])
  useEffect(() => { if (admin) void load() }, [admin, load])
  const retry = () => {
    setFailed(undefined)
    void load()
  }

  if (!admin) return null

  // Those with no owner come first; the hub's own order holds within each.
  const ordered = binders ? [...binders.filter((b) => !b.owners.length), ...binders.filter((b) => b.owners.length)] : []
  const columns: Column<HubBinder>[] = [
    { key: 'name', header: 'Binder', cell: (b) => <span className="hub-binder-name">{b.name}{b.first && <span className="tag">The hub’s own</span>}</span>, text: (b) => `${b.name} ${b.id}`, phone: 'title', width: '38%' },
    { key: 'owners', header: 'Owners', cell: (b) => (b.owners.length ? listed(b.owners) : <Status tone="waiting">No owner</Status>), text: (b) => [...b.owners, ...b.admins].join(' ') },
    { key: 'people', header: 'People', cell: (b) => (b.people ? plural(b.people, 'person', 'people') : 'Nobody'), align: 'end', width: '120px' },
  ]

  return (
    <>
      <HeaderAction><button type="button" className="button primary" onClick={() => { setMade(undefined); setMaking(true) }}><Plus size={16} aria-hidden="true" />New binder</button></HeaderAction>
      {failed ? (
        <div className="section-card" role="alert">
          <EmptyState compact icon={<TriangleAlert size={18} />} title="Couldn’t load the hub’s binders." line={failed}
            action={<button type="button" className="button small" onClick={retry}><RotateCcw size={14} aria-hidden="true" />Try again</button>} />
        </div>
      ) : (
        <DataTable label="Binders on this hub" columns={columns} rows={ordered} rowKey={(b) => b.id} loading={!binders}
          onRowPress={setNaming} rowLabel={(b) => `Name an owner for ${b.name}`} filter={ordered.length > 8 ? 'Filter binders' : undefined}
          empty={<EmptyState compact icon={<Boxes size={18} />} title="No binders on this hub yet." line="Make one with New binder, empty or from a copy." />} />
      )}
      <AnimatePresence>
        {naming && <NameOwner key="name" binder={naming} onClose={() => setNaming(undefined)} onDone={(list) => { if (list) setBinders(list); setNaming(undefined) }} />}
        {making && me && (
          <Guided key="new" title="New binder" question="Start it from what?" onClose={() => setMaking(false)}
            options={[
              { id: 'empty', icon: <FilePlus2 size={18} />, name: 'An empty binder', line: 'Its own notes, board and people, from nothing.', recommended: true },
              { id: 'copy', icon: <FileUp size={18} />, name: 'From a copy', line: 'A copy downloaded from a binder’s General settings.' },
            ]}
            steps={(id) => id === 'empty'
              ? [{ title: 'Its name and owner', content: <NewSpace me={me.user.login} forOthers onCancel={() => setMaking(false)} /> }]
              : [
                { title: 'Which copy?', lead: 'It starts paused, beside the binder it was taken from.', content: (nav) => <FromCopy onCancel={() => setMaking(false)} onMade={(list, created) => { if (list) setBinders(list); setMade(created); nav.next() }} /> },
                { title: 'It’s made', content: <Made made={made} />, footer: (nav) => <button type="button" className="button primary" onClick={nav.close}>Done</button> },
              ]} />
        )}
      </AnimatePresence>
    </>
  )
}

/** The binder pressed in the table: what it is, and one field for the GitHub login it makes an owner. */
function NameOwner({ binder, onClose, onDone }: { binder: HubBinder; onClose: () => void; onDone: (list?: HubBinder[]) => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const login = typed.trim().replace(/^@/, '')
  const address = `${window.location.origin}/${binder.id}`
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
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="binder-summary">
          <div className="binder-summary-head">
            <b>{binder.name}</b>
            {binder.yours && <a className="text-button" href={spaceHref(binder.id, '#/home')}>Open {binder.name}<ArrowRight size={14} aria-hidden="true" /></a>}
          </div>
          <div className="value-box"><span className="mono">{address}</span><CopyButton value={address} label="its address" /></div>
          <p>{runBy(binder)} · {plural(binder.people, 'person', 'people')}</p>
        </div>
        {/* A binder nobody is in is open to everyone who can sign in: its first owner closes it to the rest. */}
        {binder.people === 0 && <p className="setup-warning" role="note"><TriangleAlert size={15} aria-hidden="true" /><span>Nobody is in this binder yet, so everyone who can sign in can open it. Once it has an owner, only the people added to it can.</span></p>}
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
function FromCopy({ onCancel, onMade }: { onCancel: () => void; onMade: (list: HubBinder[] | undefined, created: { id: string; name: string }) => void }) {
  const [file, setFile] = useState<File>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !name.trim()) return
    setBusy(true)
    // A refusal shows as a toast, in the hub's own words, and the form stays for another try.
    const done = await attempt(() => upload<{ binders: HubBinder[]; created: { id: string; name: string } }>(`/api/hub/binders/from-copy?name=${encodeURIComponent(name.trim())}`, file, 'application/gzip'))
    setBusy(false)
    if (!done) return
    toast(`Made ${done.created.name} from the copy.`)
    onMade(Array.isArray(done.binders) ? done.binders : undefined, done.created)
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label className="field-label" htmlFor="copy-file">The copy</label>
        <input id="copy-file" type="file" accept=".gz,application/gzip" aria-describedby="copy-file-hint" onChange={(e) => {
          const chosen = e.target.files?.[0]
          setFile(chosen)
          if (chosen) setName(nameFromCopy(chosen.name))
        }} />
        <span className="field-hint" id="copy-file-hint">A .binder-copy.json.gz file, from Download a copy in a binder’s General settings.</span>
      </div>
      <Field label="Name">
        <input id="copy-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <footer className="form-actions">
        <button type="button" className="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !file || !name.trim()}>{busy ? 'Making it…' : 'Make the binder'}</button>
      </footer>
    </form>
  )
}

/** The binder just made from a copy: that it waits to be turned on, and the way into it. */
function Made({ made }: { made?: { id: string; name: string } }) {
  return (
    <div className="made-binder">
      <p>It doesn’t write to GitHub until that’s turned on in its Settings.</p>
      {made && <a className="button" href={spaceHref(made.id, '#/home')}>Open {made.name}<ArrowRight size={14} aria-hidden="true" /></a>}
    </div>
  )
}
