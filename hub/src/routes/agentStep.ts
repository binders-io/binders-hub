import type { FastifyInstance } from 'fastify'
import type { LoopTurn, ToolSpec } from '../../../shared/agent.ts'
import type { Context } from './context.ts'

// One step of an agent's model, taken by the hub for an agent working on a machine. Its runner has the code; the hub has
// the model's address and its key, sealed. The runner sends the conversation so far and the tools its agent may call,
// with the agent's own token, and gets back what the model said and the calls it wants: the key never leaves the hub,
// and a machine needs no model credentials of its own.

/** The most one step carries: how many turns and tools, and how long its instructions run. */
const most = { turns: 600, tools: 120, system: 120_000, bytes: 8 * 1024 * 1024 }

const isTurn = (turn: unknown): turn is LoopTurn => {
  const t = turn as { role?: unknown; text?: unknown; calls?: unknown; results?: unknown } | null
  if (!t || typeof t !== 'object') return false
  if (t.role === 'user') return typeof t.text === 'string'
  if (t.role === 'assistant') return typeof t.text === 'string' && Array.isArray(t.calls)
  return t.role === 'tool' && Array.isArray(t.results)
}
const isTool = (tool: unknown): tool is ToolSpec => {
  const t = tool as { name?: unknown; description?: unknown; input?: unknown } | null
  return !!t && typeof t === 'object' && typeof t.name === 'string' && /^[\w.-]{1,64}$/.test(t.name) && typeof t.description === 'string' && !!t.input && typeof t.input === 'object'
}

export async function agentStepRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth } = context

  app.post('/api/agent/step', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } }, bodyLimit: most.bytes }, async (request, reply) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    const known = await auth.agentFor(token)
    if (!known) return reply.code(401).send({ error: 'This hub doesn’t know that token.' })
    // The agent's token is proof enough to start its Binder, as it is for its tools.
    const space = await spaces.start(known.space ?? spaces.list()[0]?.id ?? '')
    const agent = space?.hub.state.agents.find((a) => a.id === known.id && !a.revoked)
    if (!space || !agent) return reply.code(401).send({ error: 'This hub doesn’t know that token.' })
    if (!space.endpoints) return reply.code(422).send({ error: 'This Binder can’t lend an agent a model.' })
    const body = (request.body ?? {}) as { system?: unknown; turns?: unknown; tools?: unknown }
    if (typeof body.system !== 'string' || body.system.length > most.system) return reply.code(400).send({ error: 'A step needs its instructions, as text.' })
    if (!Array.isArray(body.turns) || !body.turns.length || body.turns.length > most.turns || !body.turns.every(isTurn)) return reply.code(400).send({ error: 'A step needs the conversation so far.' })
    if (!Array.isArray(body.tools) || body.tools.length > most.tools || !body.tools.every(isTool)) return reply.code(400).send({ error: 'A step’s tools each need a name, a description and the shape of what they take.' })
    try {
      return await space.endpoints.step(agent, { system: body.system, turns: body.turns, tools: body.tools })
    } catch (err) {
      // What the model's server said, or why there's no model: for the agent's run to stop on, in words.
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Its model couldn’t be asked.' })
    }
  })
}
