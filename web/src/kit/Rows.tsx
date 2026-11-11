import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * A list of things, one a row, divided by hairlines. On its own it has a card's frame; in a Section's card it takes the
 * card's.
 */
export function Rows({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return <ul className={`rows${className ? ` ${className}` : ''}`} aria-label={label}>{children}</ul>
}

/**
 * One thing in a list: its icon, its name, one line about it, its state, and at the end a chevron, a switch or a menu.
 * Given `onPress` or `href`, the whole row is one button or link (the trailing control stays apart from it, so a switch
 * or a ⋯ is its own target). What goes in `title`, `meta` and `status` is read out as the row's name, so keep them to
 * words: no buttons or links inside a pressable row.
 */
export function Row({ icon, title, meta, status, trailing, onPress, href, label, disabled = false, current = false }: {
  icon?: ReactNode
  title: ReactNode
  /** One line under the title: what it is or how it stands. It is cut short rather than wrapped. */
  meta?: ReactNode
  /** A Status, before the trailing control. */
  status?: ReactNode
  /** 'chevron' (the default for a row that opens something), 'none', or a control of its own: a switch or a MenuButton. */
  trailing?: 'chevron' | 'none' | ReactNode
  onPress?: () => void
  href?: string
  /** The row's name for a screen reader when the words in it don't say what pressing it does. */
  label?: string
  disabled?: boolean
  /** The one this page is about, or the one chosen. */
  current?: boolean
}) {
  const pressable = !!(onPress || href)
  const chevron = trailing === 'chevron' || (pressable && trailing === undefined)
  const control = trailing !== undefined && trailing !== 'chevron' && trailing !== 'none' ? trailing : undefined
  const inner = (
    <>
      {icon && <span className="rows-icon" aria-hidden="true">{icon}</span>}
      <span className="rows-text">
        <span className="rows-title">{title}</span>
        {meta && <span className="rows-meta">{meta}</span>}
      </span>
      {status && <span className="rows-status">{status}</span>}
      {chevron && <ChevronRight size={16} className="rows-chevron" aria-hidden="true" />}
    </>
  )
  return (
    <li className={`rows-item${pressable ? ' pressable' : ''}${current ? ' current' : ''}${disabled ? ' disabled' : ''}`}>
      {href && !disabled ? (
        <a className="rows-main" href={href} aria-label={label} aria-current={current ? 'page' : undefined}>{inner}</a>
      ) : onPress || href ? (
        <button type="button" className="rows-main" onClick={onPress} aria-label={label} aria-current={current ? 'true' : undefined} disabled={disabled}>{inner}</button>
      ) : (
        <div className="rows-main">{inner}</div>
      )}
      {control && <span className="rows-trailing">{control}</span>}
    </li>
  )
}
