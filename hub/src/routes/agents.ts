import { checkedRunner } from '../actions/base.ts'
import { Refused } from '../hub.ts'
import { readerWords } from '../spaces.ts'
import { noted } from '../history.ts'
import { bodies } from '../schemas.ts'
import { agentRepos, defaultRunner, runnerShown, sameRepo, type Agent, type Provider, type RunnerSettings } from '../../../shared/work.ts'
import { findable, preferred, type AgentTool } from '../../../shared/agents.ts'
import { hostName } from '../brain/machines.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// Agents set up by people, and their terminals.

/** The provider the Agents page gives an agent that runs a tool. */
const providerFor = (tool: AgentTool): Provider => (tool === 'codex' ? 'openai' : tool === 'custom' ? 'other' : tool)

export async function agentRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, options, terminals, sp, login, param, isAdmin, namedAdmin, act, bodyOf, mayLinkAll, brainMachines, brainSettings } = context
  // Agents: set up by people, each with a token shown once.
  app.post('/api/agents', act(async (request) => {
    const body = bodyOf(bodies.newAgent, request)
    await mayLinkAll(request, body.repos)
    const agent = await sp(request).actions.putAgent(login(request), body as Partial<Agent> & { name: string })
    const token = await auth.issueAgentToken(agent.id, sp(request).id)
    await noted(sp(request).hub, { kind: 'user', login: login(request) }, `Set up the agent “${agent.name}”.`)
    return { agent, token }
  }))
  // One line to add machines with code on them, made by anyone in the Binder: it works on any number of machines for a day.
  // Each machine that runs it joins below: the hub chooses its tool and makes its agent.
  app.post('/api/agents/join-line', act(async (request) => {
    if (!brainMachines) throw new Refused('This hub can’t add machines.')
    const { token, expiresAt } = await brainMachines.agentLine(login(request), sp(request).id)
    const hub = options.publicUrl.replace(/\/+$/, '')
    return { token, expiresAt, command: { unix: `curl -fsSL ${hub}/install | sh -s -- join ${token}`, windows: `& ([scriptblock]::Create((irm ${hub}/install.ps1))) join ${token}` } }
  }))
  // A machine running that line: no sign-in, as the line is the proof. It says which agent tools and repos it found, and
  // the hub makes its agent (or finds the one it made for it before), with a token of its own.
  app.post('/api/machines/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const turnedAway = (status: number, error: string) => reply.code(status).send({ error })
    try {
      const body = bodyOf<{ token: string; host?: string; tools: string[]; folder?: string; repos?: string[] }>(bodies.machineJoin, request)
      const line = await brainMachines?.lineFor(body.token)
      if (!brainMachines || !line) {
        if (await brainMachines?.isBrainLine(body.token)) return turnedAway(401, 'That line is from Settings → Brain, for a machine that only lends models: run it with binders add --token. To add a machine with code on it, make a line on the Agents page.')
        return turnedAway(401, 'That line has run out or was replaced. Make a new one on the Agents page: Add a machine.')
      }
      const space = spaces.get(line.binder)
      const info = spaces.info(line.binder)
      if (!space || !info) return turnedAway(401, 'The Binder that line was made for isn’t on this hub any more. Make a new line in one that is.')
      // Its maker speaks for the agent, so they must still be in the Binder (a hub admin may open any team Binder), and able to change it.
      if (spaces.roleOf(info.id, line.by) === 'reader') return turnedAway(401, `@${line.by} can only read ${info.name}, so the line they made can’t add a machine to it. Ask a member of ${info.name} to make a new one.`)
      if (!spaces.roleOf(info.id, line.by) && !(namedAdmin(line.by) && !info.personal)) return turnedAway(401, `@${line.by} isn’t in ${info.name} any more, so the line they made can’t add a machine to it. Ask a member of ${info.name} to make a new one.`)
      const tool = preferred(body.tools)
      if (!tool) return turnedAway(422, `None of the tools Binders works with is installed on this machine. Install one (${findable.map((t) => t.name).join(', ')}), then run the same line again.`)
      const host = hostName(body.host ?? '') || 'A machine'
      const agents = space.hub.state.agents.filter((a) => !a.revoked)
      // The same machine again is the same agent: its owner's, in this Binder, on this host, running this tool.
      const again = agents.find((a) => a.owner.toLowerCase() === line.by.toLowerCase() && a.runsOn?.toLowerCase() === host.toLowerCase() && runnerShown(a).tool === tool.id)
      let agent = again
      if (!agent) {
        // Only repos the Binder’s own list allows, when it has one: else the folder's, as they are.
        const found = [...new Set((body.repos ?? []).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))]
        const allowed = agentRepos({ repos: [], binders: [] }, space.hub.state.binders)
        const repos = allowed.length ? found.filter((r) => allowed.some((a) => sameRepo(a, r))) : found
        const taken = new Set(agents.map((a) => a.name.toLowerCase()))
        let name = `${tool.name} on ${host}`
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${tool.name} on ${host} (${n})`
        const folder = body.folder?.trim()
        agent = await space.actions.putAgent(line.by, { name, provider: providerFor(tool.id), runsOn: host, repos, skills: [], runner: { ...defaultRunner, tool: tool.id, ...(folder ? { workspace: folder } : {}) } })
        await noted(space.hub, { kind: 'user', login: line.by }, `Set up the agent “${agent.name}”, from a machine that joined.`)
      }
      const answer: Record<string, unknown> = { agent: { id: agent.id, name: agent.name, tool: tool.id, token: await auth.issueAgentToken(agent.id, space.id) }, binder: { id: info.id, name: info.name } }
      // A hub admin's line also lends the machine's models to the brain, as Settings → Brain's own line does.
      if (isAdmin(line.by)) {
        try {
          const { machine, token } = await brainMachines.joinAs(line.by, (body.host ?? '').slice(0, 120))
          brainSettings?.refresh()
          answer.machine = { id: machine.id, name: machine.name, token }
        } catch (error) {
          if (!(error instanceof Refused)) throw error
          answer.machineWhy = error.message
        }
      }
      return answer
    } catch (error) {
      if (error instanceof Refused) return turnedAway(422, error.message)
      throw error
    }
  })
  // Agents' terminals: a runner's live link, and its owner's terminal in the web app, passed between them.
  app.get('/api/runner/live', { websocket: true }, (socket) => {
    terminals.runner(socket, async (token) => {
      const agent = await auth.agentFor(token)
      const spaceId = agent && (agent.space ?? spaces.list()[0]?.id)
      const space = spaceId ? spaces.get(spaceId) : undefined
      // An agent acts with its owner's reach, so not for one who can only read the Binder.
      const there = space?.hub.state.agents.find((a) => a.id === agent?.id && !a.revoked)
      return agent && there && spaces.roleOf(spaceId!, there.owner) !== 'reader' ? `${spaceId}/${agent.id}` : undefined
    })
  })
  const isOwner = (request: FastifyRequest, agent: Agent) => agent.owner.toLowerCase() === login(request).toLowerCase()
  /** What a runner's settings come to once saved, with its defaults in what they leave out. */
  const comesTo = (runner: object) => JSON.stringify(checkedRunner(runner as Partial<RunnerSettings>))
  /** Who may rename an agent, point it elsewhere or revoke it: its owner, and the Binder's owners and admins. */
  const mayManageAgent = (request: FastifyRequest, agent: Agent) => isOwner(request, agent) || spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))
  /** The agent, when the person asking owns it: only its owner opens a terminal on its machine. */
  const ownAgent = (request: FastifyRequest, id: string) => {
    // A terminal runs commands on its owner's machine, which a reader's browser has no business with.
    if (request.role === 'reader') throw new Refused(readerWords)
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
    const token = await auth.issueAgentToken(agent.id, sp(request).id)
    await noted(sp(request).hub, { kind: 'user', login: login(request) }, `Gave the agent “${agent.name}” a new token.`)
    return { token }
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
    await noted(sp(request).hub, { kind: 'user', login: login(request) }, `Revoked the agent “${agent.name}”.`)
  }))
}
