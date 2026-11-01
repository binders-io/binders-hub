import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siOpencode, siQwen } from 'simple-icons'
import type { AgentTool } from '../../../shared/agents.ts'

// Each agent's mark in the text colour, from Simple Icons where there is one; the rest are their initials on a tile.

const marks: Partial<Record<AgentTool, { path: string }>> = {
  claude: siClaude, copilot: siGithubcopilot, gemini: siGooglegemini, cursor: siCursor, opencode: siOpencode, qwen: siQwen,
}
const initials: Partial<Record<AgentTool, string>> = { codex: 'Cx', pi: 'π', amp: 'Am', goose: 'Gs', aider: 'Ai', custom: '>_' }

export function ToolIcon({ tool, size = 20 }: { tool: AgentTool; size?: number }) {
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
