import { useEffect, useState } from 'react'

/**
 * What a card's page says while its detail comes: nothing for a moment, so a quick one doesn't flash, then "Loading…".
 * When it couldn't be loaded it says so, with a way to try again; offline, that it loads when the hub is back.
 */
export function CardLoading({ failed, offline, again }: { failed: boolean; offline: boolean; again: () => void }) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), 200)
    return () => window.clearTimeout(timer)
  }, [])
  if (offline) return <p className="work-loading faint" role="status">This card isn’t on this device yet. It loads when you’re back online.</p>
  if (failed) return <p className="work-loading" role="alert">This card couldn’t be loaded. <button type="button" className="text-button" onClick={again}>Try again</button></p>
  return late ? <p className="work-loading faint" role="status">Loading…</p> : null
}
