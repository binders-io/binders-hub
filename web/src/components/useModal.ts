import { useEffect, useRef, useState, type RefObject } from 'react'

const controls = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Something over the page, for keyboards and screen readers: focus goes in, Tab stays in, Escape closes it, and focus
 * goes back to what opened it. Put the ref on an element with tabIndex -1 and aria-modal. Without `active` it's the
 * whole time it's drawn; `returnTo` is for something that stays drawn, as a tap on a phone doesn't always focus a button.
 */
export function useModal<T extends HTMLElement>(onClose: () => void, { active = true, returnTo }: { active?: boolean; returnTo?: RefObject<HTMLElement | null> } = {}) {
  const box = useRef<T>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  // Read while drawing: by the first effect, a field inside with autoFocus already has focus.
  const [before] = useState(() => document.activeElement as HTMLElement | null)

  useEffect(() => {
    const here = box.current
    if (!active || !here) return
    const back = returnTo?.current ?? before
    if (!here.contains(document.activeElement)) here.focus({ preventScroll: true })
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      // Another modal over this one has the keys.
      const top = document.activeElement?.closest('[aria-modal="true"]')
      if (top && top !== here) return
      if (event.key === 'Escape') return close.current()
      const list = [...here.querySelectorAll<HTMLElement>(controls)].filter((el) => el.checkVisibility?.() !== false)
      const first = list[0]
      const last = list[list.length - 1]
      const now = document.activeElement
      if (!first) return event.preventDefault()
      if (!here.contains(now)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey ? now === first || now === here : now === last) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener('keydown', keys)
    return () => {
      window.removeEventListener('keydown', keys)
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [active, before, returnTo])

  return box
}
