import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// The hub's Binders and who's in them.

export async function binderRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, login, param, isAdmin, act, bodyOf } = context
  // The hub's Binders: each person sees the ones they're in, with who's in them where they may change that. The hub's
  // admins make them, each with its first owner; its owners and admins add and remove people.
  const spaceView = (request: FastifyRequest) => {
    const admin = isAdmin(login(request))
    return {
      spaces: spaces.forPerson(login(request), admin).map(({ info, role }) => ({
        id: info.id, name: info.name, role, createdAt: info.createdAt,
        // The hub's own: it can't be taken off the hub, so the web app offers nothing for that.
        ...(spaces.isFirst(info.id) ? { first: true } : {}),
        members: spaces.mayManage(info.id, login(request), admin) ? info.members : undefined,
        // Everyone in a Binder sees who runs it.
        managers: info.members.filter((m) => m.role !== 'member').map(({ login, role }) => ({ login, role })),
      })),
      // Anyone makes a Binder; the hub's admins may make one for someone else.
      mayCreate: true,
      mayCreateFor: admin,
    }
  }
  const managing = (request: FastifyRequest) => {
    const id = param(request, 'id')
    const admin = isAdmin(login(request))
    if (!spaces.info(id) || !spaces.forPerson(login(request), admin).some((s) => s.info.id === id)) throw new Refused('No such Binder.')
    if (!spaces.mayManage(id, login(request), admin)) throw new Refused('Only the Binder’s owners and admins can change who’s in it.')
    return { id, byOwner: admin || spaces.roleOf(id, login(request)) === 'owner' }
  }
  /** Revokes every agent a person owns in a Binder, as the agents route revokes one, and says which. */
  const revokeAgentsOf = async (id: string, owner: string, by: string) => {
    const hub = spaces.get(id)?.hub
    const revoked: { id: string; name: string }[] = []
    for (const agent of hub?.state.agents.filter((a) => !a.revoked && a.owner.toLowerCase() === owner.toLowerCase()) ?? []) {
      await auth.revokeAgent(agent.id)
      await hub!.record({ kind: 'user', login: by }, { type: 'agent.revoke', id: agent.id })
      revoked.push({ id: agent.id, name: agent.name })
    }
    return revoked
  }
  app.get('/api/spaces', async (request) => spaceView(request))
  // Anyone makes a Binder, and owns it (the hub's admins may make one for someone else). It reaches GitHub through the
  // hub's app.
  app.post('/api/spaces', act(async (request) => {
    const body = bodyOf(bodies.newSpace, request)
    const me = login(request)
    const owner = isAdmin(me) && body.owner ? String(body.owner) : me
    // Its GitHub is its own, set up in its Settings → GitHub: it borrows no other binder's app or repos.
    const info = await spaces.create({ id: body.id ? String(body.id) : undefined, name: String(body.name ?? ''), owner }, me)
    return { ...spaceView(request), created: { id: info.id, name: info.name } }
  }))
  app.patch('/api/spaces/:id', act(async (request) => {
    const { id } = managing(request)
    const info = await spaces.rename(id, bodyOf(bodies.named, request).name ?? '')
    // Its one binder goes by its name.
    const hub = spaces.get(id)?.hub
    const sole = hub?.state.binders.length === 1 ? hub.state.binders[0] : undefined
    if (hub && sole && sole.name !== info.name) await hub.record({ kind: 'user', login: login(request) }, { type: 'binder.put', binder: { ...sole, name: info.name } })
    return spaceView(request)
  }))
  app.put('/api/spaces/:id/members/:login', act(async (request) => {
    const { id, byOwner } = managing(request)
    await spaces.setMember(id, param(request, 'login'), bodyOf(bodies.member, request).role ?? 'member', byOwner)
    return spaceView(request)
  }))
  // Taking someone out takes their agents with them: a token is checked against its agent, so it would go on working.
  // A member may take themselves out; only an owner may leave an owner's place, and the last owner can't.
  app.delete('/api/spaces/:id/members/:login', act(async (request) => {
    const id = param(request, 'id')
    const who = param(request, 'login')
    const me = login(request)
    const leaving = spaces.info(id) && who.toLowerCase() === me.toLowerCase() && spaces.info(id)!.members.some((m) => m.login.toLowerCase() === me.toLowerCase())
    const byOwner = leaving ? spaces.roleOf(id, me) === 'owner' : managing(request).byOwner
    await spaces.removeMember(id, who, byOwner)
    return { ...spaceView(request), revoked: await revokeAgentsOf(id, who, me) }
  }))
  // Taking a Binder off the hub destroys nothing: it stops, and isn't listed or opened again.
  app.delete('/api/spaces/:id', act(async (request) => {
    const id = param(request, 'id')
    const me = login(request)
    const admin = isAdmin(me)
    const info = spaces.info(id)
    if (!info || !spaces.forPerson(me, admin).some((s) => s.info.id === id)) throw new Refused('No such Binder.')
    if (info.personal) throw new Refused('A personal Binder can’t be removed.')
    if (!admin && spaces.roleOf(id, me) !== 'owner') throw new Refused('Only the Binder’s owners and the hub’s admins can remove it.')
    if (spaces.isFirst(id)) throw new Refused('The hub’s first Binder can’t be removed: its files are the hub’s own.')
    if (bodyOf(bodies.removeSpace, request).name !== info.name) throw new Refused('To remove a Binder, type its name exactly as it is.')
    await spaces.remove(id, me)
    return { ...spaceView(request), removed: { id, name: info.name } }
  }))
}
