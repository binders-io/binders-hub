import type { Agent } from '../data/model'
import type { AgentEndpoint } from '../../../shared/work.ts'

// An agent that is a model at an address, with no machine: how the page words it.

/**
 * Whether the hub runs this agent itself, as a model at an address with no machine. An agent on a machine can have a
 * model too (Binders' own agent does), but it keeps its runner, so it's not one of these: it has every runner control.
 */
export const isModelAgent = (agent: Agent): agent is Agent & { endpoint: AgentEndpoint } => !!agent.endpoint && !agent.runner

/** Whether an agent on a machine is Binders' own agent, which has no model of its own until it's given one. */
export const usesOwnModel = (agent: Agent) => agent.runner?.tool === 'binders'

/** The three kinds of model, and what each is, as the forms offer them. */
export const modelKinds: { id: AgentEndpoint['kind']; name: string; help: string }[] = [
  { id: 'brain', name: 'The hub’s own model', help: 'Uses the model set up in Settings → Brain. Nothing else to fill in.' },
  { id: 'openai', name: 'A server that speaks OpenAI’s chat API', help: 'Azure OpenAI and Microsoft Foundry, OpenAI, or any server with the same API.' },
  { id: 'anthropic', name: 'Claude, by Anthropic’s API', help: 'At Anthropic, or a Claude deployment in Microsoft Foundry.' },
]

/** Whether a model agent can do work: its model called a tool when last tried. One not tried yet counts as able. */
export const modelReady = (agent: Agent) => agent.endpoint?.ready?.ok !== false

/** The host of an address, as a person reads it: "your-resource.openai.azure.com". An address that isn't one is shown as typed. */
function hostOf(address: string) {
  try {
    return new URL(address).host
  } catch {
    return address.trim()
  }
}

/** What a model agent is, in words: "The hub’s own model", "gpt-deploy at your-resource.openai.azure.com", "claude-opus-5-5 at Anthropic". */
export function modelWords(endpoint: AgentEndpoint) {
  if (endpoint.kind === 'brain') return 'The hub’s own model'
  const where = endpoint.baseUrl ? hostOf(endpoint.baseUrl) : endpoint.kind === 'anthropic' ? 'Anthropic' : ''
  const model = endpoint.model || (endpoint.kind === 'anthropic' ? 'Claude' : 'A model')
  return where ? `${model} at ${where}` : model
}

/** How a model agent is doing, in a word: whether the hub's last try found its model answering and calling tools. */
export const modelStatus = (agent: Agent) => (modelReady(agent) ? 'Ready' : 'Needs attention')

/** What it takes, as the short names shown as chips. */
export function takesNames(takes: AgentEndpoint['takes']) {
  return [takes.cards && 'Cards', takes.chats && 'Chats', takes.debriefs && 'Debriefs', takes.challenges && 'Challenges'].filter((n): n is string => !!n)
}

/**
 * Whether an address typed in a form goes to another server than the one the model had. The hub keeps a key for the
 * server it was typed for and never sends it anywhere else, so another address needs its key typed again.
 */
export function movedTo(typed: string, had: string | undefined) {
  const host = (address: string | undefined) => (address?.trim() ? hostOf(address).toLowerCase() : '')
  return host(typed) !== host(had)
}

export const newAddressNeedsKey = 'A new address needs its key typed again: the hub never sends a key anywhere but where it was typed for.'
