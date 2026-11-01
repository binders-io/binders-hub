import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

/** Says so when something didn't work: an action the hub refused, a change it undid. */
export function useToast() {
  const [message, setMessage] = useState<string>()
  useEffect(() => {
    const show = (event: Event) => setMessage((event as CustomEvent<string>).detail)
    window.addEventListener('binders-refused', show)
    return () => window.removeEventListener('binders-refused', show)
  }, [])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(undefined), 6000)
    return () => window.clearTimeout(timer)
  }, [message])
  return { message, clear: () => setMessage(undefined) }
}

export const toast = (message: string) => window.dispatchEvent(new CustomEvent('binders-refused', { detail: message }))

/** Runs an action, and shows what went wrong if it did. */
export async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (error) {
    toast((error as Error).message)
    return undefined
  }
}

export function Toast() {
  const { message, clear } = useToast()
  return (
    <>
      {/* Always in the page: a screen reader may not read a live region that arrives with its words. */}
      <div className="sr-only" role="alert">{message}</div>
      <AnimatePresence>
        {message && (
          <motion.div className="toast" aria-hidden="true" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} onClick={clear}>
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
