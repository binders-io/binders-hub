import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Right-click menus, as the Mac app has them: on a card, a card's chip in a note, a note or a folder. One menu at a time,
// drawn where the click was, kept on screen, gone on Escape, a click elsewhere or a scroll. Text keeps the browser's
// own menu (copy, paste, spelling).

export type MenuItem =
  /** `confirm` is what it says once pressed, worded as ConfirmButton's: a question ending "Press again". */
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; confirm?: string }
  /** A long list of its own, opened in place of the menu, so it never pushes the rest of the menu out of reach. */
  | { label: string; icon?: ReactNode; submenu: MenuItem[] }
  /** The way back out of one. */
  | { label: string; icon?: ReactNode; back: MenuItem[] }
  | { heading: string }
  | { separator: true }

type Open = { x: number; y: number; items: MenuItem[]; from: Element | null; onClose?: () => void }

/** Where a menu goes back to, and who wants to know it closed: a ⋯ button says whether its menu is open. */
export interface MenuOptions {
  from?: Element | null
  onClose?: () => void
}

let show: ((open: Open | undefined) => void) | undefined

/** Opens a menu at the right-click, in place of the browser's. Whether it opened: not with nothing in it. */
export function openMenu(event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[], options: MenuOptions = {}) {
  if (!items.length || !show) return false
  event.preventDefault()
  event.stopPropagation()
  show({ x: event.clientX, y: event.clientY, items, from: options.from ?? document.activeElement, onClose: options.onClose })
  return true
}

/** Opens a menu under its ⋯: a phone has no right-click, and a keyboard shouldn't need one. */
export function openMenuUnder(event: SyntheticEvent, items: MenuItem[], options: MenuOptions = {}) {
  const rect = event.currentTarget.getBoundingClientRect()
  // A button pressed with a pointer isn't always focused (Safari): the menu goes back to the button all the same.
  return openMenu({ clientX: rect.right - 210, clientY: rect.bottom + 4, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, items, { from: event.currentTarget, ...options })
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
  // Told once its menu has gone, however it went: a choice, Escape, a click elsewhere, or another menu in its place.
  // Going into a submenu and back is the same menu.
  const told = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    if (told.current && told.current !== open?.onClose) told.current()
    told.current = open?.onClose
  }, [open])
  useEffect(() => () => told.current?.(), [])

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
    // A scroll elsewhere moves what the menu was opened on. Its own is just reading down a long menu.
    const scrolled = (event: Event) => { if (!list.current?.contains(event.target as Node)) close() }
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
    // A tap on nothing in particular has no mousedown on an iPhone, and a menu doesn't outlive its screen.
    window.addEventListener('pointerdown', away)
    window.addEventListener('mousedown', away)
    window.addEventListener('hashchange', close)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', keys)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('mousedown', away)
      window.removeEventListener('hashchange', close)
      window.removeEventListener('scroll', scrolled, true)
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
        if ('submenu' in item) {
          return (
            <button key={index} type="button" role="menuitem" aria-haspopup="menu" onClick={() => {
              setSure(undefined)
              setOpen({ ...open, items: [{ label: 'Back', icon: <ChevronLeft size={14} />, back: open.items }, { separator: true }, ...item.submenu] })
            }}>
              {item.icon}<span>{item.label}</span><ChevronRight size={14} className="context-menu-more" />
            </button>
          )
        }
        if ('back' in item) {
          return (
            <button key={index} type="button" role="menuitem" onClick={() => setOpen({ ...open, items: item.back })}>
              {item.icon}<span>{item.label}</span>
            </button>
          )
        }
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
            {item.icon}<span title={item.label}>{asking ? item.confirm : item.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
