import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// The hub's Binders and who's in them.

export async function binderRoutes(app: FastifyInstance, context: Context) {
  const { spaces, login, param, isAdmin, act, bodyOf } = context
  // The hub's Binders: each person sees the ones they're in, with who's in them where they may change that. The hub's
  // admins make them, each with its first owner; its owners and admins add and remove people.
  const spaceView = (request: FastifyRequest) => {
    const admin = isAdmin(login(request))
    return {
      spaces: spaces.forPerson(login(request), admin).map(({ info, role }) => ({
        id: info.id, name: info.name, role, createdAt: info.createdAt,
        members: spaces.mayManage(info.id, login(request), admin) ? info.members : undefined,
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
  app.delete('/api/spaces/:id/members/:login', act(async (request) => {
    const { id, byOwner } = managing(request)
    await spaces.removeMember(id, param(request, 'login'), byOwner)
    return spaceView(request)
  }))
}
