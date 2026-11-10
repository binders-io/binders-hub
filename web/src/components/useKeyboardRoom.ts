import { useEffect } from 'react'

/**
 * While a note is being written or a question typed on a phone, the page is as tall as what the keyboard leaves, so the
 * caret and the bar under the words stay above it. iOS slides the whole page up to show the caret instead: it's slid back.
 */
export function useKeyboardRoom(active: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!active || !viewport) return
    const root = document.documentElement
    const fit = () => {
      root.style.setProperty('--room', `${viewport.height}px`)
      if (window.scrollY) window.scrollTo(0, 0)
    }
    root.classList.add('writing')
    fit()
    viewport.addEventListener('resize', fit)
    viewport.addEventListener('scroll', fit)
    return () => {
      viewport.removeEventListener('resize', fit)
      viewport.removeEventListener('scroll', fit)
      root.classList.remove('writing')
      root.style.removeProperty('--room')
    }
  }, [active])
}
