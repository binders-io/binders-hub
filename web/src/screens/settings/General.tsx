import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { call } from '../../data/api'
import type { SpaceView } from '../../data/model'
import { spaceHref } from '../../data/space'
import { useStore } from '../../data/store'
import { ConfirmButton } from '../../components/ConfirmButton'
import { RepoInput } from '../../components/RepoInput'
import { attempt } from '../../components/Toast'
import { Changeable, Saved, WhoCan } from './shared'
import { agentsOf, useBinderAccess, useSaved, type SpacesView } from './access'
import { sectionHref } from './sections'

/** What happened to the binder you were in, so the page says so rather than showing what's no longer yours. */
type Gone = { kind: 'left' | 'removed'; name: string; revoked: { id: string; name: string }[]; next?: SpaceView }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The binder's name and address; its parts, if it has several; and how to leave it or take it off the hub. */
export function General() {
  const store = useStore()
  const { state } = store
  const me = state.me
  const access = useBinderAccess()
  const { here, may, managers, noOwner, change } = access
  const { saved, shown } = useSaved()
  const [gone, setGone] = useState<Gone>()
  const [typed, setTyped] = useState('')
  const [name, setName] = useState('')
  const [repo, setRepo] = useState<string[]>([])

  if (gone) return <NoLongerHere {...gone} />

  const start = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    store.addBinder(name, repo[0] ?? '')
    setName('')
    setRepo([])
  }
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

  const leave = async () => {
    if (!here || !me) return
    const done = await change(() => call<SpacesView & { revoked?: { id: string; name: string }[] }>('DELETE', `/api/spaces/${here.id}/members/${encodeURIComponent(me.user.login)}`))
    if (done) setGone({ kind: 'left', name: here.name, revoked: done.revoked ?? [], next: elsewhere(done.spaces) })
  }
  const remove = async () => {
    if (!here) return
    const done = await change(() => call<SpacesView>('DELETE', `/api/spaces/${here.id}`, { name: typed.trim() }))
    if (done) setGone({ kind: 'removed', name: here.name, revoked: [], next: elsewhere(done.spaces) })
  }

  return (
    <>
      <WhoCan may={may} managers={managers} />
      <Changeable may={may}>
        <>
          {here && (
            <section className="settings-card space-card">
              <div className="field">
                <div className="field-head"><label className="field-label" htmlFor={`space-name-${here.id}`}>Name</label><Saved show={shown('name')} /></div>
                <input id={`space-name-${here.id}`} key={here.name} defaultValue={here.name}
                  onBlur={(e) => {
                    const next = e.target.value.trim()
                    if (next && next !== here.name) void change(() => call<SpacesView>('PATCH', `/api/spaces/${here.id}`, { name: next })).then((done) => done && saved('name'))
                  }} />
              </div>
              <div className="field">
                <span className="field-label">Address</span>
                <div className="token-value mono"><span>{window.location.origin}/{here.id}</span></div>
              </div>
            </section>
          )}
          {several && (
            <ul className="binder-cards">
              {state.binders.map((binder) => {
                const notes = state.notes.filter((n) => n.binderId === binder.id).length
                const cards = state.cards.filter((c) => c.binderId === binder.id).length
                return (
                  <li key={binder.id} className="settings-card">
                    <div className="binder-card-head">
                      <input id={`binder-name-${binder.id}`} className="binder-name" aria-label={`Name of its part ${binder.name}`} defaultValue={binder.name}
                        onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== binder.name) { store.updateBinder(binder.id, { name: e.target.value }); saved(`part-${binder.id}`) } }} />
                      <Saved show={shown(`part-${binder.id}`)} />
                      <span className="faint num">{plural(notes, 'note', 'notes')} · {plural(cards, 'card', 'cards')}</span>
                      <button className="icon-button" disabled={notes + cards > 0} title={notes + cards > 0 ? 'Only an empty part can be deleted' : 'Delete this part'} aria-label={`Delete its part ${binder.name}`} onClick={() => void attempt(() => store.deleteBinder(binder.id))}><Trash2 size={14} /></button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {!state.binders.length && (
            <form className="settings-card binder-add" onSubmit={start}>
              <h3>Its notes and board</h3>
              <label className="field">
                <span className="field-label">Name</span>
                <input id="new-binder-name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="field">
                <label className="field-label" htmlFor="new-binder-repo">GitHub repo (optional)</label>
                <RepoInput id="new-binder-repo" single value={repo} placeholder="Pick the repo its cards go to…" onChange={setRepo} />
              </div>
              <button className="button primary" disabled={!name.trim()}><Plus size={14} /> Start it</button>
            </form>
          )}
        </>
      </Changeable>
      {here && !personal && isMember && (
        <section className="settings-card space-card">
          <h3 className="settings-sub">Leave this binder</h3>
          {onlyOwner
            ? <p className="field-hint">You’re its only owner, so you can’t leave yet. Make someone else an owner in <a href={sectionHref('people')}>People</a> first.</p>
            : (
              <>
                <p className="field-hint">You stop seeing its notes, cards and agents. {mine.length ? `${plural(mine.length, 'agent of yours stops', 'of your agents stop')} working in it: ${mine.map((a) => a.name).join(', ')}.` : 'None of your agents work in it.'}</p>
                <div><ConfirmButton className="button danger" question="Leave it? Press again" onConfirm={() => void leave()}>Leave this binder</ConfirmButton></div>
              </>
            )}
        </section>
      )}
      {here && !personal && mayRemove && (
        <section className="settings-card space-card">
          <h3 className="settings-sub">Take this binder off the hub</h3>
          {here.first
            ? <p className="field-hint">This is the hub’s own binder, so it stays.</p>
            : (
              <>
                <p className="field-hint">Nothing is destroyed. Its notes stay in its GitHub repo and its data on the hub’s disk. It just stops running here, and no one can open it from the hub.</p>
                <label className="field">
                  <span className="field-label">Type its name to confirm</span>
                  <input id="remove-space-name" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={here.name} autoComplete="off" />
                </label>
                <div><button type="button" className="button danger" disabled={typed.trim() !== here.name} onClick={() => void remove()}>Take it off the hub</button></div>
              </>
            )}
        </section>
      )}
    </>
  )
}

function NoLongerHere({ kind, name, revoked, next }: Gone) {
  return (
    <section className="settings-card space-card">
      <p role="status">
        {kind === 'left' ? `You left ${name}.` : `${name} is off the hub. Its notes are still in its GitHub repo, and its data on the hub’s disk.`}
        {revoked.length > 0 && ` ${plural(revoked.length, 'agent of yours was', 'of your agents were')} revoked with you: ${revoked.map((a) => a.name).join(', ')}.`}
      </p>
      <div><a className="button primary" href={next ? spaceHref(next.id, '#/home') : '/'}>{next ? `Open ${next.name}` : 'Go to the hub'}</a></div>
    </section>
  )
}
