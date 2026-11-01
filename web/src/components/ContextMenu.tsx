import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'

// Right-click menus, as the Mac app has them: on a card, a card's chip in a note, a note or a folder. One menu at a time,
// drawn where the click was, kept on screen, gone on Escape, a click elsewhere or a scroll. Text keeps the browser's
// own menu (copy, paste, spelling).

export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; confirm?: string }
  | { heading: string }
  | { separator: true }

type Open = { x: number; y: number; items: MenuItem[]; from: Element | null }

let show: ((open: Open | undefined) => void) | undefined

/** Opens a menu at the right-click, in place of the browser's. */
export function openMenu(event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) {
  if (!items.length || !show) return
  event.preventDefault()
  event.stopPropagation()
  show({ x: event.clientX, y: event.clientY, items, from: document.activeElement })
}

/** Opens a menu under its ⋯: a phone has no right-click, and a keyboard shouldn't need one. */
export function openMenuUnder(event: SyntheticEvent, items: MenuItem[]) {
  const rect = event.currentTarget.getBoundingClientRect()
  openMenu({ clientX: rect.right - 210, clientY: rect.bottom + 4, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, items)
}

/** Back to where a menu was opened from, for a keyboard: what's chosen may then move focus on, as a rename does. */
function refocus(open: Open) {
  if (open.from instanceof HTMLElement && open.from.isConnected) open.from.focus({ preventScroll: true })
}

/** Where menus are drawn: once, in the app. */
export function ContextMenuHost() {
  const [open, setOpen] = useState<Open>()
  const [at, setAt] = useState<{ left: number; top: number }>()
  const [sure, setSure] = useState<number>()
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    show = (next) => {
      setOpen(next)
      setAt(undefined)
      setSure(undefined)
    }
    return () => { show = undefined }
  }, [])

  // Kept on screen: measured once drawn, then moved in from the edges.
  useLayoutEffect(() => {
    if (!open || !list.current) return
    const { width, height } = list.current.getBoundingClientRect()
    setAt({ left: Math.max(8, Math.min(open.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(open.y, window.innerHeight - height - 8)) })
    list.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!list.current?.contains(event.target as Node)) setOpen(undefined) }
    const close = () => setOpen(undefined)
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        refocus(open)
        return setOpen(undefined)
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const now = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(now + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', keys)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', keys)
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div className="context-menu" role="menu" ref={list} style={at ?? { left: open.x, top: open.y, visibility: 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {open.items.map((item, index) => {
        if ('separator' in item) return <hr key={index} />
        if ('heading' in item) return <span key={index} role="presentation" className="context-menu-heading">{item.heading}</span>
        const asking = item.confirm && sure === index
        return (
          <button key={index} type="button" role="menuitem" className={`${item.danger ? 'danger' : ''}${asking ? ' sure' : ''}`} disabled={item.disabled}
            onClick={() => {
              // Something that can't be undone asks once more, in place.
              if (item.confirm && !asking) return setSure(index)
              refocus(open)
              setOpen(undefined)
              item.onSelect()
            }}>
            {item.icon}<span>{asking ? item.confirm : item.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
