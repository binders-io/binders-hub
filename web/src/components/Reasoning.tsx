import { useEffect, useState } from 'react'
import { Brain } from 'lucide-react'
import type { AskedEffort } from '../../../shared/changeSet.ts'

/** How hard an agent reasons over a debrief or Challenge: auto goes by the change's size. */
export type Reasoning = 'auto' | 'low' | 'medium' | 'high'

const key = 'binders-hub-reasoning'
const changed = 'binders-reasoning'

/** The level this browser asks for, as last picked. */
export function readReasoning(): Reasoning {
  try {
    const kept = window.localStorage.getItem(key)
    return kept === 'low' || kept === 'medium' || kept === 'high' ? kept : 'auto'
  } catch {
    return 'auto'
  }
}

/** For a request to the hub: the level, or nothing for auto (the hub picks by the change's size). */
export const askedReasoning = () => {
  const level = readReasoning()
  return level === 'auto' ? {} : { effort: level }
}

/**
 * The reasoning a debrief or Challenge asks for, beside its button: Auto (low for a small change, high for a big one),
 * or a level of your own. Remembered in this browser, and the same everywhere it shows.
 */
export function ReasoningPicker() {
  const [level, setLevel] = useState(readReasoning)
  useEffect(() => {
    const follow = () => setLevel(readReasoning())
    window.addEventListener(changed, follow)
    return () => window.removeEventListener(changed, follow)
  }, [])
  const pick = (next: Reasoning) => {
    setLevel(next)
    try { window.localStorage.setItem(key, next) } catch { /* only a convenience */ }
    window.dispatchEvent(new Event(changed))
  }
  return (
    <label className="reasoning-pick" title="How hard the agent reasons over it. Auto: low for a small change, medium for a mid-sized one, high for a big one. Codex and Claude Code follow it.">
      <Brain size={13} aria-hidden />
      <select id="reasoning-level" aria-label="Reasoning" value={level} onChange={(e) => pick(e.target.value as Reasoning)}>
        <option value="auto">Auto</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </label>
  )
}

/** The reasoning it was asked with, in words: "low reasoning, auto for 24 changed lines". */
export const reasoningWords = (effort?: AskedEffort) =>
  effort ? `${effort.level} reasoning${effort.auto ? `, auto for ${effort.lines ?? 0} changed line${effort.lines === 1 ? '' : 's'}` : ''}` : ''
