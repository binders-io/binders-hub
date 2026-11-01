import type { Activity } from './model'

/** What an agent said and did, as its session showed it, for a terminal. */
export function sessionLines(activity: Activity[]) {
  const lines: string[] = []
  for (const a of activity) {
    if (a.kind === 'step') {
      lines.push(`⏺ ${a.tool ?? 'Step'}(${a.text})`)
      if (a.result) lines.push(`  ⎿  ${a.result}`)
    } else if (a.kind === 'said') lines.push(`⏺ ${a.text}`)
  }
  return lines
}
