import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siOpencode, siQwen } from 'simple-icons'
import type { AgentTool } from '../../../shared/agents.ts'

// Each agent's mark in the text colour, from Simple Icons where there is one; the rest are their initials on a tile.

const marks: Partial<Record<AgentTool, { path: string }>> = {
  claude: siClaude, copilot: siGithubcopilot, gemini: siGooglegemini, cursor: siCursor, opencode: siOpencode, qwen: siQwen,
}
const initials: Partial<Record<AgentTool, string>> = { codex: 'Cx', pi: 'π', amp: 'Am', goose: 'Gs', aider: 'Ai', custom: '>_' }

export function ToolIcon({ tool, size = 20 }: { tool: AgentTool; size?: number }) {
  // Binders' own: its page with two rings, drawn in lines so it takes the colour around it.
  if (tool === 'binders') {
    return (
      <svg className="tool-icon" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round">
        <rect x="18" y="8" width="34" height="48" rx="6" />
        <path d="M28 24h14M28 33h11M28 42h7" />
        <circle cx="18" cy="22" r="5" />
        <circle cx="18" cy="42" r="5" />
      </svg>
    )
  }
  const mark = marks[tool]
  if (mark) {
    return (
      <svg className="tool-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path d={mark.path} fill="currentColor" />
      </svg>
    )
  }
  return <span className="tool-icon initials" style={{ width: size, height: size, fontSize: size * 0.44 }} aria-hidden="true">{initials[tool] ?? '?'}</span>
}
