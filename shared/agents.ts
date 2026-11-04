// The agents a runner can start, for the Agents page and the runner alike: their names, how much access each can be
// given, and whether Binders' MCP tools can be handed to them for one run. Without those tools the runner does the
// bookkeeping itself: it gives the agent the card or the note, and reports back what it printed.

export type AgentTool = 'claude' | 'codex' | 'opencode' | 'dsh' | 'pi' | 'copilot' | 'gemini' | 'cursor' | 'amp' | 'goose' | 'aider' | 'qwen' | 'custom'
export type Access = 'full' | 'auto' | 'edits'

export interface ToolInfo {
  id: AgentTool
  name: string
  /** Who makes it, under the name. */
  by: string
  /** The command it's started with. */
  command: string
  /** Whether Binders' MCP tools reach it for a run; if not, the runner hands it the work and reports for it. */
  mcp: boolean
  /** The access it can be given, the first being what it starts with. */
  access: Access[]
  /** Its command line was tried against the tool itself; the others follow their makers' documentation. */
  tried: boolean
  /** Why it can't be opened in a terminal, when it can't. */
  noTerminal?: string
  /** Models it takes, when they're fixed names; otherwise the runner lists them on the machine. */
  models?: string[]
}

export const tools: ToolInfo[] = [
  { id: 'claude', name: 'Claude Code', by: 'Anthropic', command: 'claude', mcp: true, access: ['full', 'auto', 'edits'], tried: true, models: ['opus', 'sonnet', 'haiku'] },
  { id: 'codex', name: 'Codex', by: 'OpenAI', command: 'codex', mcp: true, access: ['full', 'edits'], tried: true },
  { id: 'opencode', name: 'OpenCode', by: 'SST', command: 'opencode', mcp: true, access: ['full', 'edits'], tried: true },
  { id: 'dsh', name: 'DeepSeek Harness', by: 'DeepSeek', command: 'dsh', mcp: true, access: ['full'], tried: true, noTerminal: 'DeepSeek Harness has no terminal app to open: its releases come with a headless mode, which takes this agent’s cards, and a web app (dsh web).' },
  { id: 'copilot', name: 'Copilot CLI', by: 'GitHub', command: 'copilot', mcp: true, access: ['full', 'edits'], tried: true },
  { id: 'pi', name: 'Pi', by: 'pi.dev', command: 'pi', mcp: false, access: ['full'], tried: true },
  { id: 'gemini', name: 'Gemini CLI', by: 'Google', command: 'gemini', mcp: false, access: ['full', 'edits'], tried: false },
  { id: 'cursor', name: 'Cursor CLI', by: 'Cursor', command: 'cursor-agent', mcp: false, access: ['full', 'edits'], tried: false },
  { id: 'amp', name: 'Amp', by: 'Sourcegraph', command: 'amp', mcp: false, access: ['full'], tried: false },
  { id: 'goose', name: 'Goose', by: 'Block', command: 'goose', mcp: false, access: ['full'], tried: false },
  { id: 'aider', name: 'Aider', by: 'Aider', command: 'aider', mcp: false, access: ['full', 'edits'], tried: false },
  { id: 'qwen', name: 'Qwen Code', by: 'Alibaba', command: 'qwen', mcp: false, access: ['full', 'edits'], tried: false },
  { id: 'custom', name: 'My own command', by: 'Anything that takes a prompt', command: '', mcp: false, access: ['full'], tried: true },
]

export const toolInfo = (id: AgentTool | undefined) => tools.find((t) => t.id === id) ?? tools[0]

/** The runner the hub hands out; one older than this lacks things the app offers (several cards at once, chats). */
export const runnerVersion = '0.11.0'

/** The first runner that restarts when asked from the Agents page. */
export const restartSince = '0.8.1'

/** The first runner that writes repo briefs and gives them to its agents. */
export const briefsSince = '0.8.0'

/** Whether a runner's version is this one or newer ("0.6.10" is newer than "0.6.9"). */
export function atLeast(version: string | undefined, least: string) {
  if (!version) return false
  const [x, y] = [version, least].map((v) => v.split('.').map((n) => Number(n) || 0))
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return true
}

export const accessNames: Record<Access, string> = { full: 'Full access: no prompts', auto: 'Auto: it decides what’s safe', edits: 'Edits only' }
