import type { ReactNode } from 'react'
import { Section } from '../../kit'

/**
 * One part of the Brain's right rail: a section of the kit's, its heading with how many things are in it, and one card
 * for what it holds. The count is inside the heading, so a screen reader hears it with the name.
 */
export function RailSection({ id, title, count, alert = false, children }: { id: string; title: string; count: number; alert?: boolean; children: ReactNode }) {
  return (
    <Section level={2} id={`brain-rail-${id}`} className="brain-rail-section"
      title={<>{title} <span className={`count brain-count${alert && count > 0 ? ' alert' : ''}`}>{count}</span></>}>
      {children}
    </Section>
  )
}
