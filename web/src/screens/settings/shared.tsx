import { Check, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Role } from '../../data/model'
import { useStore } from '../../data/store'
import { useBinderAccess } from './access'
import { sectionHref } from './sections'

/** The one line a person who can't change a binder's settings sees: who can. */
export function WhoCan({ may, managers }: { may: boolean; managers: { login: string; role: Role }[] }) {
  if (may) return null
  const names = managers.map((m) => `@${m.login}`)
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return <p className="setup-note">Only this binder’s owners and admins{list ? `, ${list},` : ''} can change these.</p>
}

/**
 * Said once, at the top of this binder's settings, when it has no owner: to one of the hub's admins, who look after it,
 * where to name one; to everyone else, its own admins included, who can.
 */
export function NoOwnerLine() {
  const me = useStore().state.me
  const { noOwner } = useBinderAccess()
  if (!noOwner || !me) return null
  if (me.hubAdmin) return <p className="setup-note" role="status">This binder has no owner yet, so the hub’s admins look after it. Name an owner in <a href={sectionHref('people')}>People</a>.</p>
  return <p className="setup-note" role="status">This binder has no owner yet. One of the hub’s admins can name one.</p>
}

/** Greys out whatever's inside, and takes it out of the Tab order, when its person may not change it. */
export function Changeable({ may, children }: { may: boolean; children: ReactNode }) {
  return <fieldset className="settings-changeable" disabled={!may}>{children}</fieldset>
}

/** "Saved", beside what was saved. Its place is always there, so a screen reader hears it arrive. */
export function Saved({ show }: { show: boolean }) {
  return <span className="option-saved" role="status">{show && <><Check size={12} strokeWidth={3} /> Saved</>}</span>
}

/** One line of how something stands: a tick, or a cross where it needs a look. */
export function Status({ ok, label, detail }: { ok: boolean; label: string; detail: ReactNode }) {
  return (
    <li className={ok ? 'ok' : ''}>
      <span className="status-icon">{ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}</span>
      <div>
        <b>{label}</b>
        <span>{detail}</span>
      </div>
    </li>
  )
}
