import type { CSSProperties } from 'react'

/**
 * Where something is on its way: grey bars in its shape, shimmering unless less motion was asked for. Hidden from a
 * screen reader; whatever holds it says it is loading (aria-busy, or a status line).
 */
export function Skeleton({ width, height = 12, lines = 1, round = false, className }: {
  /** A CSS width: "60%", 120. With several lines, each is a little shorter than the last. */
  width?: number | string
  height?: number
  lines?: number
  /** A circle, for a picture or an icon. */
  round?: boolean
  className?: string
}) {
  const bar = (index: number): CSSProperties => ({
    width: width ?? (lines > 1 ? `${[92, 78, 64, 84, 56][index % 5]}%` : '100%'),
    height,
    borderRadius: round ? '50%' : Math.min(6, height / 2),
  })
  if (lines <= 1) return <span className={`skeleton${className ? ` ${className}` : ''}`} style={bar(0)} aria-hidden="true" />
  return (
    <span className={`skeleton-lines${className ? ` ${className}` : ''}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <span key={index} className="skeleton" style={bar(index)} />)}
    </span>
  )
}
