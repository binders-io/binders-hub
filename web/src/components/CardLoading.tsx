import { useEffect, useState } from 'react'
import { CloudOff, RotateCw } from 'lucide-react'
import { EmptyState, Skeleton } from '../kit'

/**
 * What a card's page says while its detail comes: nothing for a moment, so a quick one doesn't flash, then the shape of
 * what's coming. When it couldn't be loaded it says so, with a way to try again; offline, that it loads when the hub is
 * back.
 */
export function CardLoading({ failed, offline, again }: { failed: boolean; offline: boolean; again: () => void }) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), 200)
    return () => window.clearTimeout(timer)
  }, [])
  if (offline) {
    return (
      <div className="work-loading" role="status">
        <EmptyState compact icon={<CloudOff size={18} />} title="This card isn’t on this device yet. It loads when you’re back online." />
      </div>
    )
  }
  if (failed) {
    return (
      <div className="work-loading" role="alert">
        <EmptyState compact icon={<RotateCw size={18} />} title="This card couldn’t be loaded." action={<button type="button" className="button small" onClick={again}>Try again</button>} />
      </div>
    )
  }
  if (!late) return null
  return (
    <div className="work-loading work-loading-shape" role="status">
      <span className="sr-only">Loading…</span>
      <div className="work-loading-main" aria-hidden="true">
        <Skeleton height={56} />
        <Skeleton width="30%" height={16} />
        <Skeleton lines={4} />
      </div>
      <div className="work-loading-side" aria-hidden="true">
        <Skeleton width="40%" height={14} />
        <Skeleton lines={3} />
      </div>
    </div>
  )
}
