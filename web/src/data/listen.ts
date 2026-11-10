import { useEffect, useRef } from 'react'
import type { Listener, Outcome } from '../../../shared/listen.ts'
import { call } from './api'

// Listeners, as the web app talks to the hub about them: what is set up, and what came in. The hub's live socket says
// `heard` when something came in or was taken back; sync.ts turns that into a window event, and whatever shows what came
// in listens for it and asks again.

export type { Listener, Outcome } from '../../../shared/listen.ts'

/** A listener as the hub lists it: an address to post to carries its address. */
export type ListenerView = Listener & { address?: string }

export interface ListenView {
  listeners: ListenerView[]
  /** Whether you may add, change and remove listeners. */
  mayManage: boolean
}

/** The window event sync.ts sends when the hub says something was heard. */
export const heardEvent = 'binders-heard'

/** The hub's listeners and whether you may change them. An answer that isn't that comes back as none, and you may not. */
export async function loadListeners(): Promise<ListenView> {
  const found = await call<Partial<ListenView> | undefined>('GET', '/api/listen')
  return { listeners: Array.isArray(found?.listeners) ? found.listeners : [], mayManage: found?.mayManage === true }
}

/** What came in, newest first. */
export async function loadFeed(): Promise<Outcome[]> {
  const found = await call<{ rows?: Outcome[] } | undefined>('GET', '/api/listen/feed')
  return Array.isArray(found?.rows) ? found.rows : []
}

/** Takes back what a row says was filed as a note, and gives the row as it is now. */
export async function undoRow(id: string): Promise<Outcome> {
  const done = await call<{ row: Outcome }>('POST', `/api/listen/feed/${encodeURIComponent(id)}/undo`)
  return done.row
}

/** Lets a note that came from outside through, so its folder's rule may start work from it. */
export const passNote = (noteId: string) => call('POST', `/api/notes/${encodeURIComponent(noteId)}/pass`)

/** Runs `again` whenever the hub says something was heard or taken back. */
export function useHeard(again: () => void) {
  const latest = useRef(again)
  useEffect(() => { latest.current = again })
  useEffect(() => {
    const run = () => latest.current()
    window.addEventListener(heardEvent, run)
    return () => window.removeEventListener(heardEvent, run)
  }, [])
}

/** Whether an address is one a link may open: a web address, never a script. */
export const isWebAddress = (address: string | undefined): address is string => !!address && /^https?:\/\//i.test(address.trim())
