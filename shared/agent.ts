// A model that works in steps: it is asked, it may call tools, it's given what they returned, and it goes on until it
// has an answer or runs out of room. This is the whole of it, with no model's API in it: a model is anything that takes
// the conversation so far and gives back words and the tools it wants called (the hub's Brain, an endpoint that is an
// agent, a runner working in a repo). What a tool returns is material for the model to read, never an instruction, and
// a tool is only ever one this loop was given: a model can't reach anything else by naming it.

/** A tool as a model is told of it: its name, what it does, and the shape of what it takes (a JSON Schema object). */
export interface ToolSpec {
  name: string
  description: string
  input: Record<string, unknown>
}

/** One call a model asked for. */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  id: string
  name: string
  text: string
  /** It couldn't be done: the text says why, for the model to go on from. */
  failed?: boolean
}

/** The conversation, as the loop keeps it. `raw` is a model's own message as its API gave it, sent back as it was. */
export type LoopTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResult[] }

export interface Usage {
  in: number
  out: number
}

/** What one call to a model came to. */
export interface Step {
  text: string
  calls: ToolCall[]
  /** end: it's done. tools: it wants tools called. length: it was cut off. refused: it declined. */
  stop: 'end' | 'tools' | 'length' | 'refused'
  usage?: Usage
  raw?: unknown
  /** Which model answered, when it says. */
  model?: string
}

export interface StepModel {
  readonly label: string
  step(input: { system: string; turns: LoopTurn[]; tools: ToolSpec[]; signal?: AbortSignal }): Promise<Step>
}

/** A tool the loop can run. What it returns goes to the model as text; what it throws goes as why it failed. */
export interface Tool {
  spec: ToolSpec
  run(input: unknown, signal?: AbortSignal): Promise<string>
}

export interface LoopLimits {
  /** How many times the model is asked, at most. */
  steps: number
  /** How long the whole of it may take. */
  ms: number
  /** The most of one tool's result the model is given. */
  resultChars: number
  /** The most tools run for one step: a model that asks for more is told which were left. */
  callsPerStep: number
}

export const loopLimits: LoopLimits = { steps: 8, ms: 120_000, resultChars: 8000, callsPerStep: 8 }

/** One thing the loop did, for whoever is watching. */
export type LoopEvent =
  | { type: 'said'; text: string }
  | { type: 'call'; call: ToolCall }
  | { type: 'result'; result: ToolResult }

export interface LoopOutcome {
  /** What the model said last. */
  text: string
  /** done: it answered. steps, time: it ran out and was asked to answer with what it had. length, refused: as its last step ended. */
  stopped: 'done' | 'steps' | 'time' | 'length' | 'refused'
  steps: number
  /** Every tool call made, in order, with what came back. */
  calls: { call: ToolCall; result: ToolResult }[]
  usage: Usage
  model?: string
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}\n(The rest was left out: ${text.length - most} more characters.)` : text)

/**
 * Asks a model, runs the tools it calls, and goes on until it answers. When it runs out of steps or time it's asked once
 * more, with no tools, to answer from what it found, so the person is never left with nothing.
 */
export async function runLoop(options: {
  model: StepModel
  system: string
  ask: string
  tools: Tool[]
  limits?: Partial<LoopLimits>
  on?: (event: LoopEvent) => void
  signal?: AbortSignal
  now?: () => number
  /**
   * Asked when the model answers with no tool to call: words to go on with, when its work isn't done (a card it still
   * holds), or nothing to let it end. Asked again each time, so it says how often it reminds.
   */
  keepGoing?: (text: string) => Promise<string | undefined>
}): Promise<LoopOutcome> {
  const limits = { ...loopLimits, ...options.limits }
  const now = options.now ?? (() => Date.now())
  const started = now()
  const byName = new Map(options.tools.map((tool) => [tool.spec.name, tool]))
  const specs = options.tools.map((tool) => tool.spec)
  const turns: LoopTurn[] = [{ role: 'user', text: options.ask }]
  const calls: LoopOutcome['calls'] = []
  const usage: Usage = { in: 0, out: 0 }
  let model: string | undefined
  let steps = 0

  const ask = async (tools: ToolSpec[]) => {
    const step = await options.model.step({ system: options.system, turns, tools, signal: options.signal })
    steps++
    usage.in += step.usage?.in ?? 0
    usage.out += step.usage?.out ?? 0
    model = step.model ?? model
    if (step.text) options.on?.({ type: 'said', text: step.text })
    return step
  }
  const outcome = (text: string, stopped: LoopOutcome['stopped']): LoopOutcome => ({ text, stopped, steps, calls, usage, ...(model ? { model } : {}) })

  for (;;) {
    const step = await ask(specs)
    if (step.stop === 'refused') return outcome(step.text, 'refused')
    if (!step.calls.length || step.stop === 'end') {
      const more = step.stop !== 'length' && !step.calls.length ? await options.keepGoing?.(step.text).catch(() => undefined) : undefined
      if (!more) return outcome(step.text, step.stop === 'length' ? 'length' : 'done')
      turns.push({ role: 'assistant', text: step.text, calls: [], ...(step.raw !== undefined ? { raw: step.raw } : {}) })
      turns.push({ role: 'user', text: more })
      continue
    }
    turns.push({ role: 'assistant', text: step.text, calls: step.calls, ...(step.raw !== undefined ? { raw: step.raw } : {}) })

    const results: ToolResult[] = []
    for (const [n, call] of step.calls.entries()) {
      options.on?.({ type: 'call', call })
      let result: ToolResult
      const tool = byName.get(call.name)
      if (n >= limits.callsPerStep) result = { id: call.id, name: call.name, text: `Not run: at most ${limits.callsPerStep} tools are run at once. Ask again if it's still needed.`, failed: true }
      else if (!tool) result = { id: call.id, name: call.name, text: `There is no tool called ${call.name}. The tools are: ${specs.map((spec) => spec.name).join(', ')}.`, failed: true }
      else {
        try {
          result = { id: call.id, name: call.name, text: cut(await tool.run(call.input, options.signal), limits.resultChars) || '(Nothing.)' }
        } catch (err) {
          result = { id: call.id, name: call.name, text: err instanceof Error ? err.message : String(err), failed: true }
        }
      }
      results.push(result)
      calls.push({ call, result })
      options.on?.({ type: 'result', result })
    }
    turns.push({ role: 'tool', results })

    const out = steps >= limits.steps ? 'steps' : now() - started >= limits.ms ? 'time' : undefined
    if (out) {
      turns.push({ role: 'user', text: 'That is all the looking up there is room for. Answer now from what you have found, and say plainly what you could not find.' })
      const last = await ask([])
      return outcome(last.text, last.stop === 'refused' ? 'refused' : out)
    }
  }
}
