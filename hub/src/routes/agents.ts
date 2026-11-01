import { checkedRunner } from '../actions/base.ts'
import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import { runnerShown, type Agent, type RunnerSettings } from '../../../shared/work.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// Agents set up by people, and their terminals.

export async function agentRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, options, terminals, sp, login, param, isAdmin, act, bodyOf, mayLinkAll } = context
  // Agents: set up by people, each with a token shown once.
  app.post('/api/agents', act(async (request) => {
    const body = bodyOf(bodies.newAgent, request)
    await mayLinkAll(request, body.repos)
    const agent = await sp(request).actions.putAgent(login(request), body as Partial<Agent> & { name: string })
    return { agent, token: await auth.issueAgentToken(agent.id, sp(request).id) }
  }))
  // Agents' terminals: a runner's live link, and its owner's terminal in the web app, passed between them.
  app.get('/api/runner/live', { websocket: true }, (socket) => {
    terminals.runner(socket, async (token) => {
      const agent = await auth.agentFor(token)
      const spaceId = agent && (agent.space ?? spaces.list()[0]?.id)
      const space = spaceId ? spaces.get(spaceId) : undefined
      return agent && space?.hub.state.agents.some((a) => a.id === agent.id && !a.revoked) ? `${spaceId}/${agent.id}` : undefined
    })
  })
  const isOwner = (request: FastifyRequest, agent: Agent) => agent.owner.toLowerCase() === login(request).toLowerCase()
  /** What a runner's settings come to once saved, with its defaults in what they leave out. */
  const comesTo = (runner: object) => JSON.stringify(checkedRunner(runner as Partial<RunnerSettings>))
  /** Who may rename an agent, point it elsewhere or revoke it: its owner, and the Binder's owners and admins. */
  const mayManageAgent = (request: FastifyRequest, agent: Agent) => isOwner(request, agent) || spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))
  /** The agent, when the person asking owns it: only its owner opens a terminal on its machine. */
  const ownAgent = (request: FastifyRequest, id: string) => {
    const agent = sp(request).hub.state.agents.find((a) => a.id === id && !a.revoked)
    if (!agent) throw new Refused('No such agent.')
    if (agent.owner.toLowerCase() !== login(request).toLowerCase()) throw new Refused(`Only ${agent.name}’s owner, @${agent.owner}, opens a terminal on its machine.`)
    return agent
  }
  app.get('/api/agents/:id/terminals', act(async (request) => terminals.list(`${sp(request).id}/${ownAgent(request, param(request, 'id')).id}`)))
  app.get('/api/terminal', { websocket: true }, (socket, request) => {
    const query = request.query as { agent?: string; sid?: string; cols?: string; rows?: string }
    // Only from the web app's own pages: another site's page can't open one with your cookie.
    const origin = String(request.headers.origin ?? '')
    const fromHere = (() => {
      try {
        return new URL(origin).origin === new URL(options.publicUrl).origin || new URL(origin).host === request.headers.host
      } catch {
        return false
      }
    })()
    try {
      if (!fromHere) throw new Refused('A terminal opens from the hub’s own pages only.')
      const agent = ownAgent(request, String(query.agent ?? ''))
      terminals.viewer(socket, `${sp(request).id}/${agent.id}`, login(request), { sid: query.sid || undefined, cols: query.cols, rows: query.rows })
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', text: (error as Error).message }))
      socket.close(1000)
    }
  })

  app.patch('/api/agents/:id', act(async (request) => {
    const existing = sp(request).hub.state.agents.find((a) => a.id === param(request, 'id'))
    if (!existing) throw new Refused('No such agent.')
    if (!mayManageAgent(request, existing)) throw new Refused(`Only ${existing.name}’s owner, @${existing.owner}, or this Binder’s owners and admins can change it.`)
    const { runner, ...fields } = bodyOf(bodies.changeAgent, request)
    // What it runs runs on its owner's machine, as them: that's theirs alone, whoever else may manage the agent. What's
    // left out of a runner goes back to its default, and the Agents page sends one with every edit, so it's what it would
    // come to that counts. Someone else's is never kept, so saving an edit can't change it either.
    const own = isOwner(request, existing)
    if (!own && runner && comesTo(runner) !== comesTo(runnerShown(existing))) throw new Refused(`Only ${existing.name}’s owner, @${existing.owner}, can change what it runs on their machine.`)
    await mayLinkAll(request, fields.repos, existing.repos)
    return sp(request).actions.putAgent(login(request), { ...existing, ...fields, ...(own && runner ? { runner } : {}) } as Partial<Agent> & { name: string }, existing.id)
  }))
  app.post('/api/agents/:id/token', act(async (request) => {
    const agent = sp(request).hub.state.agents.find((a) => a.id === param(request, 'id') && !a.revoked)
    if (!agent) throw new Refused('No such agent.')
    // A token speaks as the agent, with what it can reach.
    if (!isOwner(request, agent)) throw new Refused(`Only ${agent.name}’s owner, @${agent.owner}, can take a token for it.`)
    return { token: await auth.issueAgentToken(agent.id, sp(request).id) }
  }))
  app.post('/api/agents/:id/restart', act(async (request) => {
    const agent = sp(request).hub.state.agents.find((a) => a.id === param(request, 'id') && !a.revoked)
    if (!agent) throw new Refused('No such agent.')
    if (!mayManageAgent(request, agent)) throw new Refused(`Only ${agent.name}’s owner, @${agent.owner}, or this Binder’s owners and admins can restart its runner.`)
    return sp(request).actions.restartRunner(login(request), agent.id)
  }))
  app.delete('/api/agents/:id', act(async (request) => {
    const agent = sp(request).hub.state.agents.find((a) => a.id === param(request, 'id'))
    if (!agent) throw new Refused('No such agent.')
    if (!mayManageAgent(request, agent)) throw new Refused(`Only ${agent.name}’s owner, @${agent.owner}, or this Binder’s owners and admins can revoke it.`)
    await auth.revokeAgent(agent.id)
    await sp(request).hub.record({ kind: 'user', login: login(request) }, { type: 'agent.revoke', id: agent.id })
  }))
}
