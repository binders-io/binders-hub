import { useEffect, useRef, useState, type ReactNode } from 'react'

/** How long a button stays asking before it goes back to what it was. */
export const askingForMs = 4000

/**
 * The one way of asking before something that can't be taken back. The first press turns the button's words into the
 * question ("Revoke it? Press again"); a second press within a few seconds does it; otherwise it goes back, and so it
 * does when focus leaves it or Escape is pressed. The question is read out when it appears, since a screen reader may
 * not say that a button's words changed. `ask={false}` acts on the first press, for when there's nothing to lose.
 */
export function ConfirmButton({ question, detail, onConfirm, ask = true, className = 'button', title, label, disabled = false, children }: {
  /** Said in the button once pressed, ending in "Press again". */
  question: string
  /** What it will do, for when the question can't say it all: shown under the button and read out with it. */
  detail?: string
  onConfirm: () => void
  ask?: boolean
  className?: string
  title?: string
  /** The name of a button that has only an icon. */
  label?: string
  disabled?: boolean
  children: ReactNode
}) {
  const [asking, setAsking] = useState(false)
  const timer = useRef<number>(undefined)
  const stop = () => {
    window.clearTimeout(timer.current)
    setAsking(false)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // A button that stops being pressable has nothing to ask.
  const sure = asking && !disabled
  return (
    <>
      <button
        type="button"
        className={`confirm-button ${className}${sure ? ' sure' : ''}`}
        title={sure ? question : title}
        aria-label={sure ? question : label}
        disabled={disabled}
        onClick={() => {
          if (!ask || asking) {
            stop()
            return onConfirm()
          }
          setAsking(true)
          timer.current = window.setTimeout(() => setAsking(false), askingForMs)
        }}
        onBlur={stop}
        onKeyDown={(event) => { if (event.key === 'Escape' && asking) { event.stopPropagation(); stop() } }}
      >
        {sure ? question : children}
      </button>
      <span className="sr-only" role="status">{sure ? `${question}${detail ? ` ${detail}` : ''}` : ''}</span>
      {sure && detail && <span className="confirm-detail" aria-hidden="true">{detail}</span>}
    </>
  )
}
