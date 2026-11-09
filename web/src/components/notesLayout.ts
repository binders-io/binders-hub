import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

// How the notes screen is laid out: the notes list, the note and the panel beside it (chat or Distill), each resizable
// or hidden, the panel wide; and one of them full screen. Remembered in this browser. A popped-out window shows one
// part alone.

export type Focus = 'none' | 'note' | 'chat'

export interface NotesLayout {
  tree: number
  side: number
  treeOpen: boolean
  sideOpen: boolean
  wide: boolean
}

const key = 'binders-notes-layout'
const fallback: NotesLayout = { tree: 268, side: 360, treeOpen: true, sideOpen: true, wide: false }

/** The part this window shows alone, when it was popped out: ?popout=note or ?popout=chat. */
export const poppedOut = (): Focus => {
  const part = new URLSearchParams(window.location.search).get('popout')
  return part === 'note' || part === 'chat' ? part : 'none'
}

/** Opens the note, or its chat, in a window of its own, kept live like any other tab. */
export function popOut(part: 'note' | 'chat', noteId: string) {
  const url = `${window.location.origin}${window.location.pathname}?popout=${part}#/notes/${noteId}`
  window.open(url, `binders-${part}-${noteId}`, part === 'chat' ? 'popup,width=520,height=820' : 'popup,width=980,height=1000')
}

const sideKey = 'binders-note-side'
/** How long a request to open a note on Distill holds: it's for the screen about to draw, not one drawn much later. */
const askedForMs = 10_000
let asked: { noteId: string; at: number } | undefined
const askers = new Set<() => void>()

/**
 * For another screen to call just before it goes to a note: the note opens with Distill showing, the panel open on a
 * desktop and the Distill view on a phone. It also makes Distill the side tab to come back to.
 */
export function openOnDistill(noteId: string) {
  try { window.localStorage.setItem(sideKey, 'distill') } catch { /* only a convenience */ }
  asked = { noteId, at: Date.now() }
  askers.forEach((answer) => answer())
}

/** Calls `open` once for each request to open this note on Distill: one made before it drew, or while it's showing. */
export function useDistillAsked(noteId: string, open: () => void) {
  const latest = useRef(open)
  useEffect(() => { latest.current = open })
  useEffect(() => {
    const answer = () => {
      if (!asked || asked.noteId !== noteId) return
      const fresh = Date.now() - asked.at < askedForMs
      asked = undefined
      if (fresh) latest.current()
    }
    answer()
    askers.add(answer)
    return () => { askers.delete(answer) }
  }, [noteId])
}

/** The tab the side panel last showed, in this browser. */
export const rememberedSide = (): 'chat' | 'distill' => {
  try { return window.localStorage.getItem(sideKey) === 'distill' ? 'distill' : 'chat' } catch { return 'chat' }
}

export const rememberSide = (side: 'chat' | 'distill') => {
  try { window.localStorage.setItem(sideKey, side) } catch { /* only a convenience */ }
}

export function useNotesLayout() {
  const [layout, setLayout] = useState<NotesLayout>(() => {
    try {
      return { ...fallback, ...(JSON.parse(window.localStorage.getItem(key) ?? '{}') as Partial<NotesLayout>) }
    } catch {
      return fallback
    }
  })
  const [focus, setFocusState] = useState<Focus>(poppedOut)
  const popped = poppedOut() !== 'none'

  const change = useCallback((fields: Partial<NotesLayout>) => {
    setLayout((was) => {
      const next = { ...was, ...fields }
      try { window.localStorage.setItem(key, JSON.stringify(next)) } catch { /* only a convenience */ }
      return next
    })
  }, [])

  // Full screen hides the rest of the app too, and asks the browser for the whole screen; leaving either leaves both.
  const setFocus = useCallback((next: Focus) => {
    if (popped) return
    setFocusState(next)
    document.body.classList.toggle('focus-mode', next !== 'none')
    if (next !== 'none' && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {})
    if (next === 'none' && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }, [popped])

  useEffect(() => {
    if (popped) return
    const left = () => { if (!document.fullscreenElement) { setFocusState('none'); document.body.classList.remove('focus-mode') } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && document.body.classList.contains('focus-mode')) setFocus('none') }
    document.addEventListener('fullscreenchange', left)
    window.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('fullscreenchange', left)
      window.removeEventListener('keydown', escape)
      document.body.classList.remove('focus-mode')
    }
  }, [popped, setFocus])

  /** Dragging an edge: the notes list's right edge, or the panel's left edge. */
  const drag = useCallback((which: 'tree' | 'side') => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const start = which === 'tree' ? layout.tree : layout.side
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing')
    const move = (e: PointerEvent) => {
      const delta = e.clientX - startX
      const size = which === 'tree' ? start + delta : start - delta
      const most = which === 'tree' ? 480 : Math.round(window.innerWidth * 0.7)
      change({ [which]: Math.max(which === 'tree' ? 180 : 280, Math.min(most, Math.round(size))), ...(which === 'side' ? { wide: false } : {}) })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }, [layout.tree, layout.side, change])

  return { layout, change, focus, setFocus, popped, drag }
}
