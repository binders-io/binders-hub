/**
 * An agent's tool in a terminal of its own, as on the machine it runs on: the runner keeps it going in a pseudo-
 * terminal, and the hub passes what it writes to whoever has it open in the web app, and what they type back. Only the
 * agent's owner opens one: it's their machine.
 */

/** One terminal on an agent's runner. */
export interface TerminalInfo {
  sid: string
  /** What it runs, as people know it: "Claude Code". */
  tool: string
  /** Who opened it (a GitHub login). */
  by: string
  startedAt: string
  /** Where it works: its own worktree, as the runner's machine names it. */
  dir: string
  /** What its owner called it, its tab's name. */
  name?: string
}

/** The hub to a runner. */
export type ToRunner =
  | { type: 'open'; sid: string; by: string; cols: number; rows: number; viewer: string }
  | { type: 'attach'; sid: string; viewer: string }
  | { type: 'input'; sid: string; data: string }
  | { type: 'resize'; sid: string; cols: number; rows: number }
  | { type: 'close'; sid: string }
  | { type: 'rename'; sid: string; name: string }

/** A runner to the hub. The first, on every connection, is hello. */
export type FromRunner =
  | { type: 'hello'; token: string; version: string }
  | { type: 'sessions'; sessions: TerminalInfo[] }
  | { type: 'output'; sid: string; data: string }
  /** What a terminal wrote so far, for one person just opening it. */
  | { type: 'replay'; sid: string; viewer: string; data: string }
  | { type: 'exit'; sid: string; code: number | null; why?: string }

/** The hub to the web app. */
export type ToViewer =
  | { type: 'ready'; session: TerminalInfo }
  /** It changed: renamed, say. */
  | { type: 'session'; session: TerminalInfo }
  | { type: 'output'; data: string }
  /** Everything it wrote so far: the screen starts over from it. */
  | { type: 'replay'; data: string }
  | { type: 'exit'; code: number | null; why?: string }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string }

/** The web app to the hub. */
export type FromViewer =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** Ends the terminal: its tool is stopped. */
  | { type: 'end' }
  /** Names it; empty for its tool's name again. */
  | { type: 'rename'; name: string }

/** A terminal's name as kept: one line, not too long. */
export const terminalName = (name: unknown) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)

/** A terminal's size, kept to what a screen can be. */
export const termSize = (cols: unknown, rows: unknown) => ({
  cols: Math.min(500, Math.max(20, Math.round(Number(cols) || 100))),
  rows: Math.min(200, Math.max(5, Math.round(Number(rows) || 30))),
})
