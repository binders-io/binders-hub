import { useEffect, useState } from 'react'
import { call } from '../data/api'
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

/**
 * Whether Binders' own agent has its model on its own machine: a server or proxy that speaks OpenAI's chat API, which the
 * runner calls itself, set in its runner settings. Then that model is used, and the hub holds no model for it.
 */
export const modelOnMachine = (agent: Agent) => usesOwnModel(agent) && !!agent.runner?.modelUrl

/** The three kinds of model, and what each is, as the forms offer them. */
export const modelKinds: { id: AgentEndpoint['kind']; name: string; help: string }[] = [
  { id: 'brain', name: 'The hub’s own model', help: 'Uses the model set up in Settings → Brain. Nothing else to fill in.' },
  { id: 'openai', name: 'A server that speaks OpenAI’s chat API', help: 'Azure OpenAI and Microsoft Foundry, OpenAI, or any server with the same API.' },
  { id: 'anthropic', name: 'Claude, by Anthropic’s API', help: 'At Anthropic, or a Claude deployment in Microsoft Foundry.' },
]

/**
 * A server on one of the hub's machines (Settings → Brain) that an agent's model can be on, with the models it has to
 * talk to: a proxy or a model server on the hub's own host among them, which the hub reaches through that machine.
 */
export interface HubServer {
  machine: string
  machineName: string
  url: string
  /** It lists cloud models: a gateway to somewhere else. */
  gateway?: boolean
  models: string[]
}

/** The fourth kind a form offers, to a hub admin whose machines serve something: an OpenAI-style server reached through one. */
export const machineKind = { name: 'A server on one of the hub’s machines', help: 'A proxy or a model server on the hub’s own host, or on a machine linked in Settings → Brain. The hub reaches it through that machine.' }

/** A server as a choice in a list: "hub-server · gateway on :4000 · 300 models". */
export function serverWords(server: HubServer) {
  let port = ''
  try {
    port = new URL(server.url).port
  } catch { /* said without */ }
  const what = server.gateway ? 'gateway' : server.url.startsWith('http://models.binders') ? 'downloaded models' : 'server'
  return `${server.machineName} · ${what}${port ? ` on :${port}` : ''} · ${server.models.length} model${server.models.length === 1 ? '' : 's'}`
}

/** An address as typed, to tell it from a server's: without the slashes at its end, in lower case. */
const tidy = (address: string) => address.trim().replace(/\/+$/, '').toLowerCase()

/** The servers on the hub's machines at an address as typed: one a machine, as two machines may serve the same address. */
export const serversAt = (servers: HubServer[], address: string) => (address.trim() ? servers.filter((s) => tidy(s.url) === tidy(address)) : [])

/**
 * The servers on the hub's machines, for the forms that give an agent a model: asked for once as a form opens. The hub
 * says none to anyone but its admins, who run those machines.
 */
export function useHubServers() {
  const [servers, setServers] = useState<HubServer[]>([])
  useEffect(() => {
    let gone = false
    call<{ servers?: HubServer[] } | undefined>('GET', '/api/agents/endpoint/servers').then((r) => { if (!gone) setServers(r?.servers ?? []) }).catch(() => {})
    return () => { gone = true }
  }, [])
  return servers
}

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
  if (endpoint.machine) return `${endpoint.model || 'A model'} on ${endpoint.machineName ?? 'one of the hub’s machines'}`
  const where = endpoint.baseUrl ? hostOf(endpoint.baseUrl) : endpoint.kind === 'anthropic' ? 'Anthropic' : ''
  const model = endpoint.model || (endpoint.kind === 'anthropic' ? 'Claude' : 'A model')
  return where ? `${model} at ${where}` : model
}

/** A model on an agent's own machine, in words: "gpt-deploy at 127.0.0.1:8000, on its machine". */
export function machineModelWords(runner: { model?: string; modelUrl?: string }) {
  const where = runner.modelUrl ? hostOf(runner.modelUrl) : ''
  return `${runner.model || 'A model'}${where ? ` at ${where}` : ''}, on its machine`
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

/**
 * Whether an address is on the machine or the private network of whoever calls it, by the hub's own rule (onOwnNetwork
 * in hub/src/brain/settings.ts): localhost, a .local, .lan or .internal name, the private ranges (10.x, 192.168.x and the
 * like), 100.64.0.0 to 100.127.255.255, which mesh VPNs such as Tailscale use, and a one-word name such as a
 * container's. For a model the hub reaches, that is the hub's own machine or network, which is rarely what a person means.
 */
export function looksLocal(address: string) {
  const host = hostOf(address).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || ['.localhost', '.local', '.lan', '.internal', '.home.arpa'].some((end) => host.endsWith(end))) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  if (host.includes(':')) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  // A name with no dot in it is reached on the caller's own network: a container's, or a machine's on the LAN.
  return /^[a-z0-9-]+$/.test(host)
}

/** What a form says of such an address, where the hub is the one that reaches the model. */
export const localMeansTheHub = 'That’s the hub’s own machine or network, not yours, and only a hub admin can add it. For a model on your own machine, set up Binders’ own agent there and choose “On this machine” for its model.'

/** A box of a model's form that the hub's words can be about. */
export type ModelBox = 'baseUrl' | 'key'

/**
 * Which box a refusal from the hub is about, by what it names, so it's said beside that box: an address (or the network
 * it's on) or a key. Anything else, such as who may do it, is said under the form.
 */
export function boxOf(message: string | undefined): ModelBox | undefined {
  if (!message || /owners|admins/i.test(message)) return undefined
  if (/address|network|\/v1\b/i.test(message)) return 'baseUrl'
  if (/\bkey\b/i.test(message)) return 'key'
  return undefined
}
