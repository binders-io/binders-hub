import type { Agent } from '../data/model'
import { runnerVersion } from '../../../shared/agents.ts'

const older = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

/**
 * What its runner can do, as it said when it last connected: an old runner (or none that said) takes one card at a
 * time and doesn't answer chats while it works, so the app says to restart it.
 */
export function runnerState(agent: Agent): { old: boolean; text: string } {
  const seen = agent.runnerSeen
  if (!seen) return { old: true, text: 'Its runner is an older one: one card at a time. Restart it to take several.' }
  if (older(seen.version, runnerVersion)) return { old: true, text: `Its runner is ${seen.version} and the hub has ${runnerVersion}. It updates itself when it’s idle, or restart it now.` }
  return { old: false, text: `Runner ${seen.version} · up to ${seen.parallel} at once` }
}
