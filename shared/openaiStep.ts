import type { LoopTurn, Step, ToolSpec } from './agent.ts'

// One step of the loop (agent.ts) as OpenAI's chat API takes it, and as the servers that speak it do: Azure's and
// Foundry's, vLLM, Ollama, LM Studio, a proxy in front of any of them. Only the shapes are here, what's sent and what
// comes back, so the hub and a runner each ask their own way, with their own key, and read the answer the same.

/** What's sent for a step: the conversation so far as messages, and the tools as functions. */
export function chatBody(model: string, { system, turns, tools }: { system: string; turns: LoopTurn[]; tools: ToolSpec[] }) {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: system }]
  for (const turn of turns) {
    if (turn.role === 'user') messages.push({ role: 'user', content: turn.text })
    else if (turn.role === 'assistant') messages.push({ role: 'assistant', content: turn.text || null, ...(turn.calls.length ? { tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) } : {}) })
    else for (const result of turn.results) messages.push({ role: 'tool', tool_call_id: result.id, content: result.failed ? `It failed: ${result.text}` : result.text })
  }
  return { model, stream: false, messages, ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input } })) } : {}) }
}

/** What such a server answers with, as far as a step reads it. */
export interface ChatAnswer {
  choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  model?: string
}

/** The step in an answer: what the model said, without its thinking, and the tools it wants run. */
export function stepFrom(answer: ChatAnswer | undefined): Step {
  const choice = answer?.choices?.[0]
  const text = (choice?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim()
  const calls = (choice?.message?.tool_calls ?? []).flatMap((call, n) => {
    if (!call.function?.name) return []
    let input: unknown = {}
    // What a model wrote for a tool's arguments may not be JSON: the tool is then called with them as they are, and says so.
    try { input = call.function.arguments ? JSON.parse(call.function.arguments) : {} } catch { input = { unreadable: call.function.arguments } }
    return [{ id: call.id || `call-${n}`, name: call.function.name, input }]
  })
  const stop: Step['stop'] = choice?.finish_reason === 'content_filter' ? 'refused' : choice?.finish_reason === 'length' ? 'length' : calls.length ? 'tools' : 'end'
  return { text, calls, stop, ...(answer?.usage ? { usage: { in: answer.usage.prompt_tokens ?? 0, out: answer.usage.completion_tokens ?? 0 } } : {}) }
}
