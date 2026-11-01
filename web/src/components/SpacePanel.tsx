import { useEffect, useState, type FormEvent } from 'react'
import { ArrowUpRight, Plus, Trash2 } from 'lucide-react'
import { call } from '../data/api'
import type { Role, SpaceView } from '../data/model'
import { space, spaceHref } from '../data/space'
import { useStore } from '../data/store'
import { PersonAvatar } from './bits'
import { PeopleInput } from './PeopleInput'
import { attempt } from './Toast'

const roles: { id: Role; label: string }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'admin', label: 'Admin' },
  { id: 'member', label: 'Member' },
]

const addressOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40)

/**
 * The binder you're in: its name and who's in it, for its owners and admins to change, and your other binders. Anyone
 * makes a new one here, at its own address, and owns it.
 */
export function SpacePanel() {
  const { state } = useStore()
  const me = state.me
  const [view, setView] = useState<{ spaces: SpaceView[]; mayCreate: boolean }>()
  const refresh = () => void call<{ spaces: SpaceView[]; mayCreate: boolean }>('GET', '/api/spaces').then(setView).catch(() => {})
  useEffect(refresh, [])
  if (!view || !me) return null
  const here = view.spaces.find((s) => s.id === (me.space ?? space))
  const others = view.spaces.filter((s) => s !== here)
  const change = (work: () => Promise<{ spaces: SpaceView[]; mayCreate: boolean }>) => void attempt(work).then((next) => next && setView(next))

  return (
    <>
      {here && <Members here={here} me={me.user.login} change={change} />}
      {others.length > 0 && (
        <section>
          <h3 className="settings-sub">Your other binders</h3>
          <ul className="status-list">
            {others.map((s) => (
              <li key={s.id} className="ok">
                <span className="binder-initial">{s.name.charAt(0).toUpperCase()}</span>
                <div><b>{s.name}</b><span className="mono">/{s.id} · {s.role}</span></div>
                <a className="button" href={spaceHref(s.id, '#/home')}>Open <ArrowUpRight size={13} /></a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.mayCreate && <NewSpace me={me.user.login} forOthers={!!me.hubAdmin} />}
    </>
  )
}

function Members({ here, me, change }: { here: SpaceView; me: string; change: (work: () => Promise<{ spaces: SpaceView[]; mayCreate: boolean }>) => void }) {
  const [login, setLogin] = useState('')
  const [role, setRole] = useState<Role>('member')
  const manage = !!here.members
  const path = (who: string) => `/api/spaces/${here.id}/members/${encodeURIComponent(who)}`
  const add = (event: FormEvent) => {
    event.preventDefault()
    const who = login.trim().replace(/^@/, '')
    if (!who) return
    change(() => call('PUT', path(who), { role }))
    setLogin('')
  }
  return (
    <section className="settings-card space-card">
      <div className="binder-card-head">
        <input id={`space-name-${here.id}`} className="binder-name" aria-label="The binder’s name" defaultValue={here.name} disabled={!manage}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== here.name && change(() => call('PATCH', `/api/spaces/${here.id}`, { name: e.target.value }))} />
        <span className="faint mono">{window.location.origin}/{here.id}</span>
      </div>
      {manage ? (
        <>
          <ul className="member-list">
            {here.members!.map((m) => (
              <li key={m.login}>
                <PersonAvatar id={m.login} size={26} />
                <b>{m.login}{m.login.toLowerCase() === me.toLowerCase() && <span className="faint"> (you)</span>}</b>
                <select id={`member-role-${m.login}`} aria-label={`${m.login}’s role`} value={m.role} onChange={(e) => change(() => call('PUT', path(m.login), { role: e.target.value }))}>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <button className="icon-button" aria-label={`Remove ${m.login}`} title="Remove from this binder" onClick={() => change(() => call('DELETE', path(m.login)))}><Trash2 size={14} /></button>
              </li>
            ))}
            {!here.members!.length && <li className="faint">No members yet: anyone who can sign in to this hub can open it. Adding its first member, as owner, closes it to everyone else.</li>}
          </ul>
          <form className="member-add" onSubmit={add}>
            {/* GitHub logins suggested as you type; picking one, or Return, adds them with the role beside it. */}
            <PeopleInput id="member-login" kind="user" value={[]} implied={[]} impliedWhy="" disabled={false} onChange={(names) => {
              const who = names.at(-1)?.trim().replace(/^@/, '')
              if (who) change(() => call('PUT', path(who), { role }))
            }} />
            <select id="member-role" aria-label="Their role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </form>
          <p className="field-hint">Owners and admins add and remove people; only owners make or remove owners. Everyone in it sees its notes, cards and agents.</p>
        </>
      ) : (
        <p className="faint">You’re {here.role === 'admin' ? 'an admin' : 'a member'} here. Its owners and admins add and remove people.</p>
      )}
    </section>
  )
}

/** A new binder: anyone makes one, and owns it (the hub's admins may name another owner). Opened once made. */
export function NewSpace({ me, forOthers }: { me: string; forOthers: boolean }) {
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [owner, setOwner] = useState(me)
  const [touched, setTouched] = useState(false)
  const address = touched ? id : addressOf(name)
  const make = (event: FormEvent) => {
    event.preventDefault()
    void attempt(() => call<{ created?: { id: string } }>('POST', '/api/spaces', { id: address, name, ...(forOthers ? { owner } : {}) })).then((made) => {
      if (made?.created) window.location.href = spaceHref(made.created.id, '#/notes')
    })
  }
  return (
    <form className="settings-card binder-add" onSubmit={make}>
      <h3>New binder</h3>
      <p className="field-hint">Its own notes, folders, board, GitHub repo and members, at its own address. You own it, and add people to it.</p>
      <input id="new-space-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Its name" />
      <label className="field-label" htmlFor="new-space-id">Address</label>
      <div className="space-address">
        <span className="mono faint">{window.location.origin}/</span>
        <input id="new-space-id" className="mono" value={address} onChange={(e) => { setTouched(true); setId(e.target.value.toLowerCase()) }} placeholder="team-name" />
      </div>
      {forOthers && <>
        <label className="field-label" htmlFor="new-space-owner">Its owner</label>
        <input id="new-space-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="GitHub login" />
      </>}
      <button className="button primary" disabled={!name.trim() || !address || !owner.trim()}><Plus size={14} /> Make the binder</button>
    </form>
  )
}
