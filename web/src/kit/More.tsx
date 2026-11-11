import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * The rest of an explanation, for whoever wants it: closed, it is one line ("How this works"); open, its words. A
 * heading's own line says what a thing is; this says how it works.
 */
export function More({ summary = 'How this works', children, open }: { summary?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="disclosure" open={open}>
      <summary><ChevronRight size={14} aria-hidden="true" className="disclosure-chevron" />{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
