import type { ReactNode } from 'react'

/**
 * Nothing here yet, said once and kindly: an icon, one line, an optional second line, and what to do about it. For a
 * list, a table or a whole screen with nothing in it.
 */
export function EmptyState({ icon, title, line, action, compact = false }: {
  icon?: ReactNode
  /** One line: what isn't here. */
  title: ReactNode
  /** One more line: why, or what happens next. */
  line?: ReactNode
  /** The way to change it, usually one button. */
  action?: ReactNode
  /** Smaller, for inside a section's card or a table. */
  compact?: boolean
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
      <p className="empty-state-title">{title}</p>
      {line && <p className="empty-state-line">{line}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
