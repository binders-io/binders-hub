import { type ReactNode } from 'react'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useModal } from './useModal'

/** A form over the page: Escape or the scrim closes it. */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useModal<HTMLDivElement>(onClose)
  return (
    <>
      <motion.div className="scrim strong" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.div ref={box} tabIndex={-1} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.16 }}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="dialog-body">{children}</div>
      </motion.div>
    </>
  )
}

/** A label above its field, as Binders' forms have them. */
/**
 * A form field: its name, the control and a hint. `group` is for a control made of several buttons (chips, a choice of
 * numbers): a label would pass a click on its empty space to the first button inside, such as a chip's remove.
 */
export function Field({ label, hint, group = false, htmlFor, children }: { label: string; hint?: string; group?: boolean; htmlFor?: string; children: ReactNode }) {
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
