import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { openMenuUnder, type MenuItem } from '../components/ContextMenu'

/**
 * The rare actions of a thing, behind a ⋯: the app's own menu, opened under the button, with arrow keys, Escape and a
 * question before anything that can't be undone (an item's `confirm`). `label` names it for a screen reader and a
 * hover: "More for Support mail".
 */
export function MenuButton({ items, label, className }: {
  /** The menu's items, or a function that makes them when it opens, for items that depend on the moment. */
  items: MenuItem[] | (() => MenuItem[])
  label: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      className={`icon-button menu-dots${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event) => {
        if (openMenuUnder(event, typeof items === 'function' ? items() : items, { onClose: () => setOpen(false) })) setOpen(true)
      }}
    >
      <MoreHorizontal size={16} />
    </button>
  )
}
