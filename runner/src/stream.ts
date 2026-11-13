// Reading what an agent prints as it works, line by line, into what the card shows: each step (a file read, an edit,
// a command and what came back) and what it said. Claude Code prints its stream-json; Codex its --json events; a custom
// command may print either. Lines that are neither are ignored.

/** The name the runner gives Binders' MCP server in the agent's config. */
export const mcpServer = 'binders_hub'

export interface Step {
  tool: string
  text: string
  result?: string
}

export interface Reading {
  steps: Step[]
  said: string[]
  /** Claude Code's session, for carrying on after a person answers. */
  sessionId?: string
  cost?: number
  minutes?: number
  /** Tokens the run used: input, output and cache, all told. */
  tokens?: number
  /** The agent's last words, for saying why it stopped. */
  last?: string
  /** Its final answer in full, for a chat reply. */
  reply?: string
  failed?: boolean
  /** What the agent itself said went wrong (Codex's error events, Claude Code's failed result), for saying why it stopped. */
  error?: string
  /** What Claude Code refused it for want of a permission (its result's permission_denials), as a person would read it. */
  denied?: string[]
  /** The permission mode Claude Code started in, as its init says: a policy may lower the one asked for. */
  permissionMode?: string
}

const short = (text: string, length = 160) => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

/** A provider's error as Codex passes it on, often its JSON body: the message inside, else the text on one line. */
function unwrapped(message: string) {
  try {
    const body = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown }
    const inner = body.error?.message ?? body.message
    if (typeof inner === 'string' && inner.trim()) return inner
  } catch {
    // Not JSON.
  }
  return message.replace(/\s+/g, ' ')
}

/** What a tool was run on, in a few words: the file, the command, the pattern, the address. */
function target(input: Record<string, unknown> = {}) {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return short(value, 200)
  }
  return ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return short(content)
  if (Array.isArray(content)) return short(content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n'))
  return ''
}

/** Reads one stream: feed it lines, take what's new with `take`. */
export class StreamReader {
  private pending = new Map<string, Step>()
  /** DeepSeek Harness's tool calls, by id: its results don't repeat what was called. */
  private calls = new Map<string, { tool_name?: string; tool_input?: Record<string, unknown> }>()
  private reading: Reading = { steps: [], said: [] }

  /** Whether it has printed any JSON events; a tool that prints plain text has its lines shown as they come. */
  private sawJson = false
  private text: string[] = []

  line(raw: string) {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw)
    } catch {
      // Plain text (OpenCode, Copilot, Pi…): its lines are what it said, shown as the session goes.
      if (!this.sawJson) {
        const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
        if (line.trim()) {
          this.text.push(line)
          this.reading.last = short(line, 300)
        }
      }
      return
    }
    if (!event || typeof event !== 'object') return
    this.sawJson = true
    const type = event.type as string | undefined

    // Claude Code ------------------------------------------------------------------------------------------------
    if (type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') this.reading.sessionId = event.session_id
    if (type === 'system' && event.subtype === 'init' && typeof event.permissionMode === 'string') this.reading.permissionMode = event.permissionMode
    if (type === 'assistant' || type === 'user') {
      const message = event.message as { content?: unknown[] } | undefined
      for (const block of message?.content ?? []) {
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }
        if (b.type === 'text' && b.text?.trim() && type === 'assistant') {
          this.reading.said.push(b.text.trim().slice(0, 1200))
          this.reading.last = short(b.text, 300)
        }
        if (b.type === 'tool_use' && b.name) {
          // Its own calls to Binders show on the card already.
          if (b.name.startsWith(`mcp__${mcpServer}__`)) continue
          const step: Step = { tool: b.name.replace(/^mcp__([^_]+)__/, '$1:'), text: target(b.input) }
          this.reading.steps.push(step)
          if (b.id) this.pending.set(b.id, step)
        }
        if (b.type === 'tool_result' && b.tool_use_id) {
          const step = this.pending.get(b.tool_use_id)
          if (step) {
            step.result = (b.is_error ? 'Failed: ' : '') + resultText(b.content)
            this.pending.delete(b.tool_use_id)
          }
        }
      }
    }
    if (type === 'result') {
      if (typeof event.total_cost_usd === 'number') this.reading.cost = event.total_cost_usd
      const usage = event.usage as Record<string, unknown> | undefined
      if (usage) this.reading.tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, k) => sum + (typeof usage[k] === 'number' ? (usage[k] as number) : 0), 0)
      if (typeof event.duration_ms === 'number') this.reading.minutes = Math.max(1, Math.round(event.duration_ms / 60_000))
      if (event.is_error) {
        this.reading.failed = true
        // What Claude Code says went wrong is its result (signed out, out of credit, rate limited), not its stderr.
        if (typeof event.result === 'string' && event.result.trim()) this.reading.error = short(unwrapped(event.result), 400)
      }
      const denials = event.permission_denials as { tool_name?: string; tool_input?: Record<string, unknown> }[] | undefined
      if (Array.isArray(denials) && denials.length) this.reading.denied = [...new Set(denials.map(deniedAs))].slice(0, 20)
      if (typeof event.result === 'string' && event.result.trim()) {
        this.reading.last = short(event.result, 300)
        this.reading.reply = event.result.trim()
      }
    }

    // DeepSeek Harness (--json) ---------------------------------------------------------------------------------------
    if (type === 'session' && typeof event.sessionId === 'string') this.reading.sessionId = event.sessionId
    if (type === 'text' && typeof event.text === 'string' && event.text.trim()) {
      this.reading.said.push(event.text.trim().slice(0, 1200))
      this.reading.last = short(event.text, 300)
    }
    if (type === 'tool_call' && typeof event.tool === 'string' && !event.tool.startsWith(`mcp__${mcpServer}__`)) {
      const input = event.input as Record<string, unknown> | undefined
      const step: Step = { tool: event.tool.replace(/^mcp__([^_]+)__/, '$1:'), text: target(input) }
      this.reading.steps.push(step)
      if (typeof event.callId === 'string') {
        this.pending.set(event.callId, step)
        this.calls.set(event.callId, { tool_name: event.tool, tool_input: input })
      }
    }
    if (type === 'tool_result' && typeof event.callId === 'string') {
      const step = this.pending.get(event.callId)
      if (step) {
        step.result = (event.status === 'error' ? 'Failed: ' : '') + short(String(event.result ?? ''))
        this.pending.delete(event.callId)
      }
      // Refused by its permissions, as distinct from a command that ran and failed: said on the card, as Claude Code's are.
      const error = event.error as { name?: string; code?: string; reason?: string } | undefined
      if (error && /denied|permission|approval|sandbox/i.test(`${error.code ?? ''} ${error.name ?? ''}`)) {
        const denial = deniedAs(this.calls.get(event.callId) ?? {})
        this.reading.denied = [...new Set([...(this.reading.denied ?? []), denial])].slice(0, 20)
      }
    }
    if (type === 'status' && event.phase === 'step_end') {
      const usage = event.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined
      if (usage) this.reading.tokens = (this.reading.tokens ?? 0) + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
    }
    if (type === 'final') {
      if (typeof event.text === 'string' && event.text.trim()) {
        this.reading.reply = event.text.trim()
        this.reading.last = short(event.text, 300)
      }
      const reason = event.reason as { kind?: string; message?: string } | null | undefined
      if (reason?.kind && reason.kind !== 'completed') {
        this.reading.failed = true
        this.reading.error = reason.message ?? `It stopped: ${reason.kind}.`
      }
    }

    // Codex ------------------------------------------------------------------------------------------------------
    if (type === 'thread.started' && typeof event.thread_id === 'string') this.reading.sessionId = event.thread_id
    if (type === 'item.completed') {
      const item = event.item as { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; changes?: { path: string; kind: string }[]; server?: string; tool?: string }
      if (item?.type === 'agent_message' && item.text?.trim()) {
        this.reading.said.push(item.text.trim().slice(0, 1200))
        this.reading.last = short(item.text, 300)
        this.reading.reply = item.text.trim()
      }
      if (item?.type === 'command_execution' && item.command) this.reading.steps.push({ tool: 'Bash', text: short(item.command, 200), result: `${item.exit_code ? `exit ${item.exit_code}: ` : ''}${short(item.aggregated_output ?? '')}` })
      if (item?.type === 'file_change') for (const change of item.changes ?? []) this.reading.steps.push({ tool: change.kind === 'add' ? 'Write' : 'Edit', text: change.path })
      if (item?.type === 'mcp_tool_call' && item.server !== mcpServer) this.reading.steps.push({ tool: `${item.server}:${item.tool}`, text: '' })
    }
    if (type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined
      if (usage) this.reading.tokens = (this.reading.tokens ?? 0) + ['input_tokens', 'output_tokens'].reduce((sum, k) => sum + (typeof usage[k] === 'number' ? (usage[k] as number) : 0), 0)
    }
    if (type === 'turn.failed' || type === 'error') {
      this.reading.failed = true
      const message = type === 'error' ? event.message : (event.error as { message?: unknown } | undefined)?.message
      if (typeof message === 'string' && message.trim()) this.reading.error = short(unwrapped(message), 400)
    }
  }

  /** What came since the last take: steps whose result is in (or that never get one), and what it said. */
  take(final = false) {
    const ready = final ? this.reading.steps : this.reading.steps.filter((s) => s.result !== undefined || ![...this.pending.values()].includes(s))
    const steps = ready
    this.reading.steps = this.reading.steps.filter((s) => !steps.includes(s))
    const said = this.reading.said
    this.reading.said = []
    if (this.text.length) {
      said.push(this.text.join('\n').slice(-2000))
      this.text = []
    }
    // What goes on the card is read by everyone on the board: a token an agent wrote into a command isn't.
    return { steps: steps.map((s) => ({ ...s, text: hideSecrets(s.text), ...(s.result !== undefined ? { result: hideSecrets(s.result) } : {}) })), said: said.map(hideSecrets) }
  }

  get summary() {
    const hidden = (text: string | undefined) => (text === undefined ? undefined : hideSecrets(text))
    return { sessionId: this.reading.sessionId, cost: this.reading.cost, minutes: this.reading.minutes, tokens: this.reading.tokens, last: hidden(this.reading.last), reply: hidden(this.reading.reply), failed: this.reading.failed, error: hidden(this.reading.error), denied: this.reading.denied, permissionMode: this.reading.permissionMode }
  }
}

/**
 * Text with the secrets an agent may have written into it hidden: GitHub's tokens (an app's ghs_, a person's ghp_ and
 * github_pat_, and the rest of gh*_), Binders' own, OpenAI's and Anthropic's keys, a password in an address
 * (https://x-access-token:…@), and what follows a Bearer. What's left still says what was done.
 */
export function hideSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@'"`]+@/g, '$1…@')
    .replace(/\b(Bearer|token)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1$2…')
    .replace(/\b(gh[opusr]_|github_pat_|bn[dw]_|sk-ant-|sk-)[A-Za-z0-9._-]{12,}/g, '$1…')
}

/** A refused tool use, as a person reads it: the command, the address, the file, or else the tool. */
export function deniedAs(denial: { tool_name?: string; tool_input?: Record<string, unknown> }) {
  const tool = denial.tool_name ?? 'a tool'
  const input = denial.tool_input ?? {}
  const say = (value: unknown) => short(String(value), 120)
  if (tool === 'Bash' && input.command) return `run \`${say(input.command)}\``
  if ((tool === 'WebFetch' || tool === 'WebSearch') && (input.url || input.query)) return `${tool === 'WebFetch' ? 'fetch' : 'search the web for'} ${say(input.url ?? input.query)}`
  if (input.file_path || input.path) return `${tool === 'Read' ? 'read' : tool === 'Write' ? 'write' : tool === 'Edit' ? 'edit' : tool} ${say(input.file_path ?? input.path)}`
  return tool.startsWith('mcp__') ? `use ${tool.split('__').slice(1).join(' ')}` : `use ${tool}`
}
