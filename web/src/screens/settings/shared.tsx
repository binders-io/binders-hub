import { Check, Copy, Lock, UserRoundX, X } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Role } from '../../data/model'
import { useStore } from '../../data/store'
import { useBinderAccess } from './access'
import { sectionHref } from './sections'

/** The one line a person who can't change a binder's settings sees: who can. */
export function WhoCan({ may, managers }: { may: boolean; managers: { login: string; role: Role }[] }) {
  if (may) return null
  const names = managers.map((m) => `@${m.login}`)
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return <p className="settings-note"><Lock size={14} aria-hidden="true" /><span>Only this binder’s owners and admins{list ? `, ${list},` : ''} can change these.</span></p>
}

/**
 * Said once, at the top of this binder's settings, when it has no owner: to one of the hub's admins, who look after it,
 * where to name one; to everyone else, its own admins included, who can.
 */
export function NoOwnerLine() {
  const me = useStore().state.me
  const { noOwner } = useBinderAccess()
  if (!noOwner || !me) return null
  const line = me.hubAdmin
    ? <p>This binder has no owner yet, so the hub’s admins look after it. Name an owner in <a href={sectionHref('people')}>People</a>.</p>
    : <p>This binder has no owner yet. One of the hub’s admins can name one.</p>
  return <div className="settings-note warn" role="status"><UserRoundX size={14} aria-hidden="true" />{line}</div>
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

/**
 * Where a section's one main action goes: the page header's, at the right of the section's name (under it on a phone).
 * Settings gives the place; a section put anywhere else shows its action where it stands.
 */
const ActionPlace = createContext<{ framed: boolean; place: HTMLElement | null }>({ framed: false, place: null })
export const ActionPlaceProvider = ActionPlace.Provider

/** A section's main action, drawn in the page's header: "Add people", "New binder". */
export function HeaderAction({ children }: { children: ReactNode }) {
  const { framed, place } = useContext(ActionPlace)
  if (!framed) return <div className="settings-own-action">{children}</div>
  return place ? createPortal(children, place) : null
}

/**
 * A row whose line can run on to a second: what something is, how it stands, or what doing it does, with a control at
 * its end. Rows (the kit's) cut their line short; this is for what has to be read whole, as before leaving a binder.
 * Goes in a kit `Rows`.
 */
export function InfoRow({ icon, title, line, status, trailing, children, tone }: {
  icon?: ReactNode
  title: ReactNode
  line?: ReactNode
  status?: ReactNode
  trailing?: ReactNode
  /** More under the line: a log to open, a list. */
  children?: ReactNode
  /** 'danger' for what can't be taken back: its icon in red. */
  tone?: 'danger'
}) {
  return (
    <li className={`rows-item info-row${tone ? ` ${tone}` : ''}${trailing ? ' has-trailing' : ''}`}>
      <div className="rows-main">
        {icon && <span className="rows-icon" aria-hidden="true">{icon}</span>}
        <div className="rows-text">
          <span className="info-row-title">{title}</span>
          {line && <span className="info-row-line">{line}</span>}
          {children}
        </div>
        {status && <span className="rows-status">{status}</span>}
      </div>
      {trailing && <span className="rows-trailing">{trailing}</span>}
    </li>
  )
}

/** Copies a value, and says "Copied" for a moment where it said "Copy". */
export function CopyButton({ value, label, small = true }: { value: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    await navigator.clipboard?.writeText(value).catch(() => {})
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <>
      <button type="button" className={`button${small ? ' small' : ''} copy-button${copied ? ' copied' : ''}`} onClick={() => void copy()} aria-label={copied ? `Copied ${label}` : `Copy ${label}`}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <span className="sr-only" role="status">{copied ? 'Copied' : ''}</span>
    </>
  )
}
