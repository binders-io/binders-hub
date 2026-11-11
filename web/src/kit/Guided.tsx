import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Dialog, type DialogSize } from '../components/Dialog'

/** One of the ways in, on the first step. */
export interface GuidedOption {
  id: string
  icon: ReactNode
  name: string
  /** One line: what this way is, or who it's for. */
  line: string
  recommended?: boolean
  disabled?: boolean
}

/** What a step can do to the dialog: its content and footer get this, to move on when they're done. */
export interface GuidedNav {
  next: () => void
  back: () => void
  close: () => void
  /** To a step of the chosen option's line, by its place: 0 is its first. */
  goTo: (step: number) => void
  /** Which step this is, from 0, and how many the chosen option has. */
  step: number
  steps: number
}

export interface GuidedStep {
  /** The step's heading. */
  title: string
  /** One line under it. */
  lead?: ReactNode
  /** What the step holds: a form, a command to copy, anything. A form keeps its own buttons, kept in reach at the bottom. */
  content: ReactNode | ((nav: GuidedNav) => ReactNode)
  /** Buttons for the dialog's footer, the main one last. Leave it out when the content is a form with buttons of its own. */
  footer?: ReactNode | ((nav: GuidedNav) => ReactNode)
  /** For a step with typing or a wait that would be lost: only Close and Back leave it, not Escape or a tap outside. */
  closeOnlyFromButton?: boolean
}

/**
 * The guided dialog: one way into something that can be done several ways. Its first step is the choice (each way an
 * icon, a name and one line, one of them maybe Recommended); then the chosen way's own steps, with Back, the step's
 * title, and how far along it is when there are several. Focus goes to each step's heading as it comes, and a screen
 * reader is told where it is. Escape and Close work as a Dialog's.
 */
export function Guided({ title, question, lead, options, steps, onClose, start, size }: {
  /** The dialog's name: "Add an agent". */
  title: string
  /** The first step's heading: "What kind?" */
  question: string
  /** One line under the question. */
  lead?: ReactNode
  options: GuidedOption[]
  /** The steps of a chosen option, by its id. */
  steps: (option: string) => GuidedStep[]
  onClose: () => void
  /** An option to start in, skipping the choice, for a way in that already knows which. Back still reaches the choice. */
  start?: string
  size?: DialogSize
}) {
  const [choice, setChoice] = useState<string | undefined>(start)
  const [index, setIndex] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const id = useId()
  const line = choice ? steps(choice) : []
  const step = line[Math.min(index, line.length - 1)]
  const counted = line.length > 1

  // Each new step: its heading takes focus, so a keyboard starts there and a screen reader says it, and the body is
  // back at its top. The first time only when nothing in the dialog has taken focus for itself.
  const first = useRef(true)
  useEffect(() => {
    const here = heading.current
    if (!here) return
    const body = here.closest('.dialog-body')
    if (body) body.scrollTop = 0
    const now = document.activeElement
    if (first.current && now instanceof HTMLElement && here.closest('[role="dialog"]')?.contains(now) && now.matches('input, textarea, select, [contenteditable="true"]')) {
      first.current = false
      return
    }
    first.current = false
    here.focus({ preventScroll: true })
  }, [choice, index])

  const nav: GuidedNav = {
    next: () => setIndex((i) => Math.min(i + 1, line.length - 1)),
    back: () => {
      if (index > 0) return setIndex(index - 1)
      setChoice(undefined)
      setIndex(0)
    },
    close: onClose,
    goTo: (to: number) => setIndex(Math.max(0, Math.min(to, line.length - 1))),
    step: index,
    steps: line.length,
  }
  const content = step && (typeof step.content === 'function' ? step.content(nav) : step.content)
  const footer = step && (typeof step.footer === 'function' ? step.footer(nav) : step.footer)
  const where = step ? (counted ? `Step ${index + 1} of ${line.length}: ${step.title}` : step.title) : question

  return (
    <Dialog title={title} onClose={onClose} onBack={choice ? nav.back : undefined} footer={footer} size={size} closeOnlyFromButton={!!step?.closeOnlyFromButton}>
      <div className="guided">
        {/* Said once each step comes, after the heading itself is read. */}
        <p className="sr-only" role="status">{where}</p>
        {!step ? (
          <>
            <div className="guided-head">
              <h3 ref={heading} tabIndex={-1} className="guided-title">{question}</h3>
              {lead && <p className="guided-lead">{lead}</p>}
            </div>
            <ul className="guided-options">
              {options.map((option) => (
                <li key={option.id}>
                  <button type="button" className="guided-option" disabled={option.disabled} aria-labelledby={`${id}-${option.id}-name${option.recommended ? ` ${id}-${option.id}-tag` : ''}`} aria-describedby={`${id}-${option.id}-line`}
                    onClick={() => { setChoice(option.id); setIndex(0) }}>
                    <span className="guided-option-icon" aria-hidden="true">{option.icon}</span>
                    <span className="guided-option-text">
                      <span className="guided-option-name">
                        <b id={`${id}-${option.id}-name`}>{option.name}</b>
                        {option.recommended && <span id={`${id}-${option.id}-tag`} className="guided-recommended">Recommended</span>}
                      </span>
                      <span id={`${id}-${option.id}-line`} className="guided-option-line">{option.line}</span>
                    </span>
                    <ChevronRight size={16} className="guided-option-go" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="guided-head">
              {counted && (
                <div className="guided-progress" aria-hidden="true">
                  <span className="guided-count">Step {index + 1} of {line.length}</span>
                  <span className="guided-bar">{line.map((_, i) => <i key={i} className={i <= index ? 'done' : undefined} />)}</span>
                </div>
              )}
              <h3 ref={heading} tabIndex={-1} className="guided-title">{step.title}</h3>
              {step.lead && <p className="guided-lead">{step.lead}</p>}
            </div>
            <div className="guided-step">{content}</div>
          </>
        )}
      </div>
    </Dialog>
  )
}
