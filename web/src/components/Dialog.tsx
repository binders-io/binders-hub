import { type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, X } from 'lucide-react'
import { useModal } from './useModal'
import { sheetQuery, useMedia } from './bits'

export type DialogSize = 'small' | 'medium' | 'large'

/**
 * A form over the page: Escape or the scrim closes it. `closeOnlyFromButton` is for what can't be got back once it's
 * gone (a token shown once): only its Close button shuts it, not a tap outside or Escape.
 *
 * On a wide window it sits in the middle; on a phone it is a sheet from the bottom, its footer in reach of a thumb.
 * `footer` holds its buttons, the main one last, kept in view however long the body is. `onBack` puts a Back button
 * before its name, for a dialog with steps. `wide` is `size="large"`, under its old name.
 */
export function Dialog({ title, onClose, children, footer, size = 'medium', wide = false, onBack, closeOnlyFromButton = false }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: DialogSize
  wide?: boolean
  onBack?: () => void
  closeOnlyFromButton?: boolean
}) {
  const box = useModal<HTMLDivElement>(closeOnlyFromButton ? () => {} : onClose)
  const sheet = useMedia(sheetQuery)
  // Whoever asked for less motion gets a fade, with nothing moving.
  const still = useReducedMotion()
  const sized = wide ? 'large' : size
  const motionProps = still
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
    : sheet
      ? { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' }, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const } }
      : { initial: { opacity: 0, y: 8, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, scale: 0.98 }, transition: { duration: 0.16 } }
  return (
    <>
      <motion.div className="scrim strong" onClick={closeOnlyFromButton ? undefined : onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.div ref={box} tabIndex={-1} className={`dialog${sized === 'medium' ? '' : ` ${sized}`}${sized === 'large' ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} {...motionProps}>
        {/* Not a banner: the page has its own, and a dialog's header only names the dialog. */}
        <header role="none">
          {onBack && (
            <button type="button" className="dialog-back" onClick={onBack}><ChevronLeft size={16} aria-hidden="true" />Back</button>
          )}
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </motion.div>
    </>
  )
}

/**
 * A form field: its name, the control and a hint. `group` is for a control made of several buttons (chips, a choice of
 * numbers): a label would pass a click on its empty space to the first button inside, such as a chip's remove.
 */
export function Field({ label, hint, group = false, htmlFor, children }: { label: string; hint?: ReactNode; group?: boolean; htmlFor?: string; children: ReactNode }) {
  if (group) {
    return (
      <div className="field" role="group" aria-label={label}>
        {htmlFor ? <label className="field-label" htmlFor={htmlFor}>{label}</label> : <span className="field-label">{label}</span>}
        {children}
        {hint && <span className="field-hint">{hint}</span>}
      </div>
    )
  }
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}
