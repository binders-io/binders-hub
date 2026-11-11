import type { ReactNode } from 'react'

/** What a state means, as the app's colours say it: green done or fine, blue running, amber waiting on you, violet in review, red failed, grey off. */
export type Tone = 'ok' | 'running' | 'waiting' | 'review' | 'bad' | 'off'

/** A state in a small pill: a dot in its colour and a word or two. The words carry it; the colour only helps. */
export function Status({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`status-pill ${tone}`} title={title}>
      <i aria-hidden="true" />
      {children}
    </span>
  )
}
