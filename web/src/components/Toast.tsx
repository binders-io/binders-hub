import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { isNetworkFailure, unreachable } from '../data/api'

/** What a toast can carry besides its words: a button for what to do about it, and whether it's bad news. */
export interface ToastOptions {
  /** "Undo", "Open": a button in the toast, which closes it, then does what it says, so a toast that does shows. */
  action?: { label: string; run: () => void }
  /** Something didn't work: it looks like it, and a screen reader says so at once. */
  bad?: boolean
}

interface Shown extends ToastOptions {
  message: string
}

const showFor = 6000
/** Longer with a button, which has to be found and pressed. */
const showForAction = 10_000

/** Says so when something happened or didn't work: an action the hub refused, a change it undid, a link copied. */
export function useToast() {
  const [shown, setShown] = useState<Shown>()
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const show = (event: Event) => setShown({ ...(event as CustomEvent<Shown>).detail })
    window.addEventListener('binders-refused', show)
    return () => window.removeEventListener('binders-refused', show)
  }, [])
  // It stays while a pointer or the keyboard is on it, so what it offers can be reached.
  useEffect(() => {
    if (!shown || held) return
    const timer = window.setTimeout(() => setShown(undefined), shown.action ? showForAction : showFor)
    return () => window.clearTimeout(timer)
  }, [shown, held])
  const clear = useCallback(() => {
    setShown(undefined)
    setHeld(false)
  }, [])
  return { shown, message: shown?.message, clear, hold: setHeld }
}

export const toast = (message: string, options: ToastOptions = {}) => window.dispatchEvent(new CustomEvent('binders-refused', { detail: { message, ...options } }))

/** A toast for something that didn't work: it looks it, and is read out as an alert. */
export const failure = (message: string, options: Omit<ToastOptions, 'bad'> = {}) => toast(message, { ...options, bad: true })

/** Runs an action, and shows what went wrong if it did. */
export async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (error) {
    // The browser's own words for a request that got no answer ("Failed to fetch") say nothing a person can use.
    failure(isNetworkFailure(error) ? unreachable : (error as Error).message)
    return undefined
  }
}

export function Toast() {
  const { shown, clear, hold } = useToast()
  return (
    <>
      {/* Always in the page: a screen reader may not read a live region that arrives with its words. An ordinary toast is
          read politely, after what's being said now; a failure at once. */}
      <div className="sr-only" role="status">{shown && !shown.bad ? shown.message : ''}</div>
      <div className="sr-only" role="alert">{shown?.bad ? shown.message : ''}</div>
      <AnimatePresence>
        {shown && (
          <motion.div
            className={`toast${shown.bad ? ' bad' : ''}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            onClick={clear}
            onPointerEnter={() => hold(true)}
            onPointerLeave={() => hold(false)}
            onFocus={() => hold(true)}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hold(false) }}
            onKeyDown={(event) => { if (event.key === 'Escape') clear() }}
          >
            {/* The regions above say it, so not again here. */}
            <span aria-hidden="true">{shown.message}</span>
            {shown.action && (
              <button type="button" className="toast-action" onClick={(event) => { event.stopPropagation(); clear(); shown.action!.run() }}>{shown.action.label}</button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
