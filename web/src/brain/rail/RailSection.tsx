import type { ReactNode } from 'react'

/**
 * One part of the Brain's right rail: a small heading with how many things are in it, and what it holds. The count is
 * inside the heading, so a screen reader hears it with the name.
 */
export function RailSection({ id, title, count, alert = false, children }: { id: string; title: string; count: number; alert?: boolean; children: ReactNode }) {
  const heading = `brain-rail-${id}`
  return (
    <section className="brain-rail-section" aria-labelledby={heading}>
      <h2 id={heading}>{title} <span className={`count brain-count${alert && count > 0 ? ' alert' : ''}`}>{count}</span></h2>
      {children}
    </section>
  )
}
