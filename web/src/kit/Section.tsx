import { useId, type ReactNode } from 'react'
import { More } from './More'

/**
 * A part of a screen: a title, an optional one-line lead, an optional action at the right of the title, an optional
 * "How this works", and one card for what it holds. Inside the card, its parts are divided by hairlines: Rows, a
 * DataTable, or plain blocks, each padded. Never a card inside it; a card that finds itself there loses its frame.
 */
export function Section({ title, lead, action, more, moreLabel, children, level = 3, card = true, id, className }: {
  title: ReactNode
  /** One line under the title. */
  lead?: ReactNode
  /** One button at the right of the title, usually a small one ("Add"). */
  action?: ReactNode
  /** The long explanation, behind "How this works". */
  more?: ReactNode
  /** The words for `more`'s line, when "How this works" isn't right. */
  moreLabel?: string
  children: ReactNode
  /** 3 under a page's own heading (the default); 2 when the section is the page's top level. */
  level?: 2 | 3
  /** false: what it holds goes straight under the title, with no card around it (a guided setup, a lone button). */
  card?: boolean
  id?: string
  className?: string
}) {
  const made = useId()
  const heading = id ?? `section-${made}`
  const Title = level === 2 ? 'h2' : 'h3'
  return (
    <section className={`section${className ? ` ${className}` : ''}`} aria-labelledby={heading}>
      <div className="section-head">
        <div className="section-text">
          <Title id={heading} className="section-title">{title}</Title>
          {lead && <p className="section-lead">{lead}</p>}
        </div>
        {action && <div className="section-action">{action}</div>}
      </div>
      {more && <More summary={moreLabel}>{more}</More>}
      {card ? <div className="section-card">{children}</div> : children}
    </section>
  )
}
