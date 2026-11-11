import type { ReactNode } from 'react'

/**
 * How a screen starts: its title, one line under it, and its one primary action. On a wide window the action is to the
 * right of the title; on a phone it is under the line, as wide as the screen. The other ways in belong behind that one
 * action (a Guided dialog), not beside it.
 */
export function PageHeader({ title, lead, action, eyebrow, level = 2, id }: {
  title: ReactNode
  /** One line: what this screen is for. More belongs in a More ("How this works") further down. */
  lead?: ReactNode
  /** The screen's one primary action, usually a `button primary`. */
  action?: ReactNode
  /** A rare small-capitals line over the title, such as the binder a settings page is in. */
  eyebrow?: ReactNode
  /** 2 under the top bar's own heading (the default); 1 for a page with no top bar. */
  level?: 1 | 2
  id?: string
}) {
  const Title = level === 1 ? 'h1' : 'h2'
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <Title id={id} className="page-title">{title}</Title>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {action && <div className="page-action">{action}</div>}
    </header>
  )
}
