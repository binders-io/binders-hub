import { useState, type FormEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowRight, CircleCheck, Download, LogOut, NotebookPen, NotebookText, Plus, PowerOff } from 'lucide-react'
import { call } from '../../data/api'
import type { SpaceView } from '../../data/model'
import { spaceHref } from '../../data/space'
import { useStore } from '../../data/store'
import { Dialog, EmptyState, Field, Row, Rows, Section } from '../../kit'
import { ConfirmButton } from '../../components/ConfirmButton'
import { RepoInput } from '../../components/RepoInput'
import { attempt } from '../../components/Toast'
import { Changeable, CopyButton, InfoRow, Saved, WhoCan } from './shared'
import { agentsOf, useBinderAccess, useSaved, type SpacesView } from './access'
import { sectionHref } from './sections'

/** What happened to the binder you were in, so the page says so rather than showing what's no longer yours. */
type Gone = { kind: 'left' | 'removed'; name: string; revoked: { id: string; name: string }[]; next?: SpaceView }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The binder's name and address; its parts, if it has several; a copy of it; and, last, leaving it or taking it off
 * the hub, which can't be taken back, each asked about first.
 */
export function General() {
  const store = useStore()
  const { state } = store
  const me = state.me
  const access = useBinderAccess()
  const { here, may, managers, noOwner, change } = access
  const { saved, shown } = useSaved()
  const [gone, setGone] = useState<Gone>()
  const [part, setPart] = useState<string>()
  const [starting, setStarting] = useState(false)
  const [removing, setRemoving] = useState(false)

  if (gone) return <NoLongerHere {...gone} />

  // A binder is one notebook; one made before that may still hold several, each shown with its own name.
  const several = state.binders.length > 1
  const personal = !!here?.id.startsWith('~')
  const mine = me ? agentsOf(state.agents, me.user.login) : []
  // Leaving is theirs, whatever their role: a reader may leave as a member may.
  const isMember = !!me && (here?.role === 'member' || here?.role === 'reader' || managers.some((m) => m.login.toLowerCase() === me.user.login.toLowerCase()))
  const onlyOwner = me?.role === 'owner' && managers.filter((m) => m.role === 'owner').length <= 1
  // Its owners, and one of the hub's admins looking after a binder that has none.
  const mayRemove = !!me && (me.role === 'owner' || (me.role === 'admin' && !!me.hubAdmin && noOwner))
  const elsewhere = (spaces: SpaceView[] | undefined) => spaces?.find((s) => s.id !== here?.id)
  const mayLeave = !!here && !personal && isMember
  const offerRemove = !!here && !personal && mayRemove

  const leave = async () => {
    if (!here || !me) return
    const done = await change(() => call<SpacesView & { revoked?: { id: string; name: string }[] }>('DELETE', `/api/spaces/${here.id}/members/${encodeURIComponent(me.user.login)}`))
    if (done) setGone({ kind: 'left', name: here.name, revoked: done.revoked ?? [], next: elsewhere(done.spaces) })
  }
  const address = here ? `${window.location.origin}/${here.id}` : ''
  const editing = state.binders.find((b) => b.id === part)
  const counted = (id: string) => ({ notes: state.notes.filter((n) => n.binderId === id).length, cards: state.cards.filter((c) => c.binderId === id).length })

  return (
    <>
      <WhoCan may={may} managers={managers} />
      {here && (
        <Section title="Name and address">
          <div className="general-fields">
            <Changeable may={may}>
              <div className="field">
                <div className="field-head"><label className="field-label" htmlFor={`space-name-${here.id}`}>Name</label><Saved show={shown('name')} /></div>
                <input id={`space-name-${here.id}`} key={here.name} defaultValue={here.name} autoComplete="off"
                  onBlur={(e) => {
                    const next = e.target.value.trim()
                    if (next && next !== here.name) void change(() => call<SpacesView>('PATCH', `/api/spaces/${here.id}`, { name: next })).then((done) => done && saved('name'))
                  }} />
              </div>
            </Changeable>
            <div className="field">
              <span className="field-label" id="space-address-label">Address</span>
              <div className="value-box" aria-labelledby="space-address-label" role="group">
                <span className="mono">{address}</span>
                <CopyButton value={address} label="the address" />
              </div>
            </div>
          </div>
        </Section>
      )}
      {several && (
        <Section title="Its parts" lead="Made when a binder held several notebooks: each has its own notes and board.">
          <Rows label="Its parts">
            {state.binders.map((binder) => {
              const { notes, cards } = counted(binder.id)
              return (
                <Row key={binder.id} icon={<NotebookText size={16} />} title={binder.name} meta={`${plural(notes, 'note', 'notes')} · ${plural(cards, 'card', 'cards')}`}
                  status={<Saved show={shown(`part-${binder.id}`)} />} disabled={!may} onPress={() => setPart(binder.id)} label={`Change its part ${binder.name}`} />
              )
            })}
          </Rows>
        </Section>
      )}
      {!state.binders.length && (
        <Section title="Its notes and board">
          <EmptyState compact icon={<NotebookPen size={18} />} title="It has no notes or board yet" line="Start them, and pick the GitHub repo its cards go to if you like."
            action={may ? <button type="button" className="button primary small" onClick={() => setStarting(true)}><Plus size={14} aria-hidden="true" />Start them</button> : undefined} />
        </Section>
      )}
      {here && may && (
        <Section title="Copies" more={<p>A copy has its notes, its board, its change sets and its history. Not its connections to GitHub or Jira, no tokens, and not the pictures and files in notes, which are kept with the notes.</p>} moreLabel="What’s in a copy">
          <Rows label="Copies">
            <InfoRow icon={<Download size={16} />} title="Download a copy" line="Everything in this binder as one file, to keep or to start a new binder from."
              trailing={<a className="button small" href={`/api/spaces/${encodeURIComponent(here.id)}/copy`} download aria-label="Download a copy">Download</a>} />
          </Rows>
        </Section>
      )}
      {(mayLeave || offerRemove) && (
        <Section title="Leave or remove">
          <Rows label="Leave or remove">
            {mayLeave && (
              <InfoRow icon={<LogOut size={16} />} title="Leave this binder"
                line={onlyOwner
                  ? <>You’re its only owner, so you can’t leave yet. Make someone else an owner in <a href={sectionHref('people')}>People</a> first.</>
                  : <>You stop seeing its notes, cards and agents. {mine.length ? `${plural(mine.length, 'agent of yours stops', 'of your agents stop')} working in it: ${mine.map((a) => a.name).join(', ')}.` : 'None of your agents work in it.'}</>}
                trailing={onlyOwner ? undefined : <ConfirmButton className="button small danger" question="Leave it? Press again" onConfirm={() => void leave()}>Leave</ConfirmButton>} />
            )}
            {offerRemove && (
              <InfoRow icon={<PowerOff size={16} />} tone={here.first ? undefined : 'danger'} title="Take this binder off the hub"
                line={here.first ? 'This is the hub’s own binder, so it stays.' : 'It stops running here. Its notes stay in its GitHub repo, and its data on the hub’s disk.'}
                trailing={here.first ? undefined : <button type="button" className="button small danger" onClick={() => setRemoving(true)}>Take it off…</button>} />
            )}
          </Rows>
        </Section>
      )}
      <AnimatePresence>
        {editing && <PartDialog key="part" binder={editing} {...counted(editing.id)} onClose={() => setPart(undefined)} onSaved={() => saved(`part-${editing.id}`)} />}
        {starting && <StartDialog key="start" onClose={() => setStarting(false)} />}
        {removing && here && (
          <RemoveDialog key="remove" name={here.name} onClose={() => setRemoving(false)}
            onRemove={async (typed) => {
              const done = await change(() => call<SpacesView>('DELETE', `/api/spaces/${here.id}`, { name: typed }))
              if (!done) return false
              setGone({ kind: 'removed', name: here.name, revoked: [], next: elsewhere(done.spaces) })
              return true
            }} />
        )}
      </AnimatePresence>
    </>
  )
}

/** One of an old binder's parts: its name, and deleting it once it's empty. */
function PartDialog({ binder, notes, cards, onClose, onSaved }: { binder: { id: string; name: string }; notes: number; cards: number; onClose: () => void; onSaved: () => void }) {
  const store = useStore()
  const [name, setName] = useState(binder.name)
  const empty = notes + cards === 0
  const save = (event: FormEvent) => {
    event.preventDefault()
    const next = name.trim()
    if (next && next !== binder.name) {
      store.updateBinder(binder.id, { name: next })
      onSaved()
    }
    onClose()
  }
  return (
    <Dialog title={binder.name} onClose={onClose} size="small">
      <form className="form" onSubmit={save}>
        <div className="field">
          <label className="field-label" htmlFor={`binder-name-${binder.id}`}>Name</label>
          <input id={`binder-name-${binder.id}`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus aria-describedby={`binder-name-${binder.id}-hint`} />
          <span className="field-hint" id={`binder-name-${binder.id}-hint`}>{plural(notes, 'note', 'notes')} and {plural(cards, 'card', 'cards')} in it.</span>
        </div>
        <footer className="form-actions">
          <ConfirmButton className="button danger form-actions-start" question="Delete it? Press again" disabled={!empty} title={empty ? undefined : 'Only an empty part can be deleted'}
            onConfirm={() => { onClose(); void attempt(() => store.deleteBinder(binder.id)) }}>Delete this part</ConfirmButton>
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={!name.trim()}>Save</button>
        </footer>
      </form>
    </Dialog>
  )
}

/** A binder with no notes or board yet: a name for them, and the repo its cards go to if there's one. */
function StartDialog({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const [name, setName] = useState('')
  const [repo, setRepo] = useState<string[]>([])
  const start = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    store.addBinder(name, repo[0] ?? '')
    onClose()
  }
  return (
    <Dialog title="Start its notes and board" onClose={onClose}>
      <form className="form" onSubmit={start}>
        <Field label="Name">
          <input id="new-binder-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
        </Field>
        <div className="field">
          <label className="field-label" htmlFor="new-binder-repo">GitHub repo (optional)</label>
          <RepoInput id="new-binder-repo" single value={repo} placeholder="Pick the repo its cards go to…" onChange={setRepo} />
        </div>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={!name.trim()}>Start it</button>
        </footer>
      </form>
    </Dialog>
  )
}

/** Taking the binder off the hub: what it does, and its name typed, before the button will press. */
function RemoveDialog({ name, onClose, onRemove }: { name: string; onClose: () => void; onRemove: (typed: string) => Promise<boolean> }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const remove = async (event: FormEvent) => {
    event.preventDefault()
    if (typed.trim() !== name) return
    setBusy(true)
    // A refusal shows as a toast, in the hub's own words, and the dialog stays for another try.
    const done = await onRemove(typed.trim())
    if (!done) setBusy(false)
  }
  return (
    <Dialog title={`Take ${name} off the hub?`} onClose={onClose} size="small">
      <form className="form" onSubmit={(e) => void remove(e)}>
        <p className="dialog-line">Nothing is destroyed. Its notes stay in its GitHub repo and its data on the hub’s disk. It just stops running here, and no one can open it from the hub.</p>
        <Field label="Type its name to confirm">
          <input id="remove-space-name" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} autoComplete="off" autoFocus />
        </Field>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button danger primary" disabled={busy || typed.trim() !== name}>Take it off the hub</button>
        </footer>
      </form>
    </Dialog>
  )
}

function NoLongerHere({ kind, name, revoked, next }: Gone) {
  const line = [
    kind === 'removed' ? 'Its notes are still in its GitHub repo, and its data on the hub’s disk.' : '',
    revoked.length ? `${plural(revoked.length, 'agent of yours was', 'of your agents were')} revoked with you: ${revoked.map((a) => a.name).join(', ')}.` : '',
  ].filter(Boolean).join(' ')
  return (
    <div className="settings-gone" role="status">
      <EmptyState icon={kind === 'left' ? <LogOut size={20} /> : <CircleCheck size={20} />} title={kind === 'left' ? `You left ${name}.` : `${name} is off the hub.`} line={line || undefined}
        action={<a className="button primary" href={next ? spaceHref(next.id, '#/home') : '/'}>{next ? `Open ${next.name}` : 'Go to the hub'}<ArrowRight size={14} aria-hidden="true" /></a>} />
    </div>
  )
}
