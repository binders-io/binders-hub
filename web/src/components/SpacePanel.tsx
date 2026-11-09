import { useState, type FormEvent } from 'react'
import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { call } from '../data/api'
import type { Role } from '../data/model'
import { spaceHref } from '../data/space'
import { useStore } from '../data/store'
import { Changeable, Saved, WhoCan } from '../screens/settings/shared'
import { agentsOf, useBinderAccess, useSaved, type SpacesView } from '../screens/settings/access'
import { PersonAvatar, PersonName } from './bits'
import { ConfirmButton } from './ConfirmButton'
import { PeopleInput } from './PeopleInput'
import { attempt, toast } from './Toast'

const roles: { id: Role; label: string }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'admin', label: 'Admin' },
  { id: 'member', label: 'Member' },
]

const addressOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The binder's people, in Settings: who runs it, which everyone in it sees, and who's in it, for its owners and admins to
 * change. Taking someone out takes their agents with them, so it asks first and says how many.
 */
export function People() {
  const { state } = useStore()
  const me = state.me
  const { here, managers, may, change } = useBinderAccess()
  const { saved, shown } = useSaved()
  const [role, setRole] = useState<Role>('member')
  if (!here || !me) return null
  const members = here.members
  const path = (who: string) => `/api/spaces/${here.id}/members/${encodeURIComponent(who)}`
  const empty = managers.length === 0 && !members?.length
  const you = (login: string) => login.toLowerCase() === me.user.login.toLowerCase()
  const put = (who: string, next: Role, key: string) => void change(() => call<SpacesView>('PUT', path(who), { role: next })).then((done) => done && saved(key))
  const take = (who: string) => void change(() => call<SpacesView & { revoked?: { id: string; name: string }[] }>('DELETE', path(who))).then((done) => {
    if (!done) return
    const revoked = done.revoked ?? []
    toast(`Removed @${who}.${revoked.length ? ` Their ${plural(revoked.length, 'agent was', 'agents were')} revoked with them: ${revoked.map((a) => a.name).join(', ')}.` : ''}`)
  })
  const person = (login: string) => <><PersonAvatar id={login} size={26} /><b><PersonName id={login} />{you(login) && <span className="faint"> (you)</span>}</b></>

  return (
    <>
      {empty && (
        <p className="setup-warning" role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>Nobody is in this binder yet, so anyone who can sign in to this hub can open it. {members ? 'Add its first member, as owner, to close it to everyone else.' : 'One of the hub’s admins adds its first owner.'}</span>
        </p>
      )}
      {members ? (
        <Changeable may={may}>
          <section className="settings-card space-card">
            <ul className="member-list" aria-label="People in this binder">
              {members.map((m) => {
                const own = agentsOf(state.agents, m.login)
                return (
                  <li key={m.login}>
                    {person(m.login)}
                    <select id={`member-role-${m.login}`} aria-label={`${m.login}’s role`} value={m.role} onChange={(e) => put(m.login, e.target.value as Role, `role-${m.login}`)}>
                      {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                    <Saved show={shown(`role-${m.login}`)} />
                    <ConfirmButton className="icon-button" label={`Remove ${m.login}`} title="Remove from this binder" question="Remove them? Press again"
                      detail={own.length ? `${plural(own.length, 'agent of theirs', 'agents of theirs')} ${own.length === 1 ? 'stops' : 'stop'} with them: ${own.map((a) => a.name).join(', ')}.` : 'None of their agents work here.'}
                      onConfirm={() => take(m.login)}><Trash2 size={14} /></ConfirmButton>
                  </li>
                )
              })}
              {!members.length && <li className="faint">Nobody yet.</li>}
            </ul>
            <div className="field">
              <div className="field-head"><label className="field-label" htmlFor="member-login">Add someone</label><Saved show={shown('add')} /></div>
              {/* GitHub logins suggested as you type; picking one, or Return, adds them with the role beside it. */}
              <div className="member-add">
                <PeopleInput id="member-login" kind="user" value={[]} implied={[]} impliedWhy="" disabled={false} onChange={(names) => {
                  const who = names.at(-1)?.trim().replace(/^@/, '')
                  if (who) put(who, role, 'add')
                }} />
                <select id="member-role" aria-label="Their role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
            </div>
            <p className="field-hint">Owners and admins add and remove people; only owners make or remove owners. Everyone in it sees its notes, cards and agents.</p>
          </section>
        </Changeable>
      ) : (
        <>
          {!empty && <WhoCan may={false} managers={managers} />}
          {managers.length > 0 && (
            <section className="settings-card space-card">
              <h3 className="settings-sub">Who runs it</h3>
              <ul className="member-list">
                {managers.map((m) => (
                  <li key={m.login}>
                    {person(m.login)}
                    <span className="faint">{m.role === 'owner' ? 'Owner' : 'Admin'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
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
      <label className="field">
        <span className="field-label">Name</span>
        <input id="new-space-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Its name" />
      </label>
      <label className="field-label" htmlFor="new-space-id">Address</label>
      <div className="space-address">
        <span className="mono faint">{window.location.origin}/</span>
        <input id="new-space-id" className="mono" value={address} onChange={(e) => { setTouched(true); setId(e.target.value.toLowerCase()) }} placeholder="team-name" />
      </div>
      {forOthers && (
        <div className="field">
          <label className="field-label" htmlFor="new-space-owner">Its owner</label>
          {/* One owner, picked as every other person is; picking another replaces the first. */}
          <PeopleInput id="new-space-owner" kind="user" value={owner ? [owner] : []} implied={[]} impliedWhy="" disabled={false} onChange={(names) => setOwner(names.at(-1) ?? '')} />
        </div>
      )}
      <button className="button primary" disabled={!name.trim() || !address || !owner.trim()}><Plus size={14} /> Make the binder</button>
    </form>
  )
}
