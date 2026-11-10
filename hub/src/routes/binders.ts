import { Refused } from '../hub.ts'
import { noted } from '../history.ts'
import { bodies } from '../schemas.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// The hub's Binders and who's in them. A Binder's owners and admins run it. The hub's admins run the hub, and look after a
// Binder only while it has no owner.

/** A role as a sentence says it. */
const aRole = { owner: 'an owner', admin: 'an admin', member: 'a member', reader: 'a reader' }

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
        managers: info.members.filter((m) => m.role === 'owner' || m.role === 'admin').map(({ login, role }) => ({ login, role })),
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
    // The hub's admins stand in for the owner a Binder doesn't have.
    return { id, byOwner: spaces.roleOf(id, login(request)) === 'owner' || (admin && !spaces.hasOwner(id)) }
  }
  // Every team Binder on the hub with who owns it, for the hub's admins: the ones they don't look after too, so they can
  // name an owner for any. `yours` is whether the asker can open it: they're in it, it's open, or it has no owner.
  const hubBinders = (request: FastifyRequest) => {
    if (!isAdmin(login(request))) throw new Refused('Only the hub’s admins see every Binder.')
    return {
      binders: spaces.list().filter((info) => !info.personal).map((info) => ({
        id: info.id, name: info.name, createdAt: info.createdAt,
        ...(spaces.isFirst(info.id) ? { first: true } : {}),
        people: info.members.length,
        owners: info.members.filter((m) => m.role === 'owner').map((m) => m.login),
        admins: info.members.filter((m) => m.role === 'admin').map((m) => m.login),
        yours: !!spaces.roleFor(info.id, login(request), true),
      })),
    }
  }
  /** Revokes every agent a person owns in a Binder, as the agents route revokes one, and says which. `why` finishes the history line. */
  const revokeAgentsOf = async (id: string, owner: string, by: string, why = 'is no longer in this Binder') => {
    const hub = spaces.get(id)?.hub
    const revoked: { id: string; name: string }[] = []
    for (const agent of hub?.state.agents.filter((a) => !a.revoked && a.owner.toLowerCase() === owner.toLowerCase()) ?? []) {
      await auth.revokeAgent(agent.id)
      await hub!.record({ kind: 'user', login: by }, { type: 'agent.revoke', id: agent.id })
      await noted(hub!, { kind: 'user', login: by }, `Revoked the agent “${agent.name}”, as @${owner} ${why}.`)
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
    const was = spaces.info(id)?.name
    const info = await spaces.rename(id, bodyOf(bodies.named, request).name ?? '')
    // Its one binder goes by its name.
    const hub = spaces.get(id)?.hub
    const sole = hub?.state.binders.length === 1 ? hub.state.binders[0] : undefined
    // That change is noted as the binder renamed; with none to follow, the Binder's own new name is.
    if (hub && sole && sole.name !== info.name) await hub.record({ kind: 'user', login: login(request) }, { type: 'binder.put', binder: { ...sole, name: info.name } })
    else if (hub && was !== info.name) await noted(hub, { kind: 'user', login: login(request) }, `Renamed this Binder from “${was}” to “${info.name}”.`)
    return spaceView(request)
  }))
  app.put('/api/spaces/:id/members/:login', act(async (request) => {
    const { id, byOwner } = managing(request)
    const role = bodyOf(bodies.member, request).role ?? 'member'
    const was = spaces.info(id)?.members.find((m) => m.login.toLowerCase() === param(request, 'login').trim().replace(/^@/, '').toLowerCase())
    const info = await spaces.setMember(id, param(request, 'login'), role, byOwner)
    const now = info.members.find((m) => m.login.toLowerCase() === param(request, 'login').trim().replace(/^@/, '').toLowerCase())
    const hub = spaces.get(id)?.hub
    if (hub && now && was?.role !== role) await noted(hub, { kind: 'user', login: login(request) }, was ? `Made @${now.login} ${aRole[role]}.` : `Added @${now.login} to this Binder as ${aRole[role]}.`)
    // A reader changes nothing, and an agent acts with its owner's reach: so what they set up here stops, as when they leave.
    // Said each time, so a reader who somehow has one left loses it.
    if (role === 'reader') return { ...spaceView(request), revoked: await revokeAgentsOf(id, now?.login ?? param(request, 'login'), login(request), 'can only read this Binder now') }
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
    const was = spaces.info(id)?.members.find((m) => m.login.toLowerCase() === who.toLowerCase())
    await spaces.removeMember(id, who, byOwner)
    const hub = spaces.get(id)?.hub
    if (hub) await noted(hub, { kind: 'user', login: me }, leaving ? `@${me} left this Binder.` : `Took @${was?.login ?? who} out of this Binder.`)
    return { ...spaceView(request), revoked: await revokeAgentsOf(id, who, me) }
  }))
  app.get('/api/hub/binders', act(async (request) => hubBinders(request)))
  // A hub admin names an owner for any Binder, one they aren't in too: what a Binder with no owner waits for.
  app.put('/api/hub/binders/:id/owners/:login', act(async (request) => {
    const me = login(request)
    if (!isAdmin(me)) throw new Refused('Only the hub’s admins name a Binder’s owner.')
    const id = param(request, 'id')
    if (!spaces.info(id)) throw new Refused('No such Binder.')
    const who = param(request, 'login').trim().replace(/^@/, '')
    const was = spaces.info(id)!.members.find((m) => m.login.toLowerCase() === who.toLowerCase())
    const info = await spaces.setMember(id, who, 'owner', true)
    const now = info.members.find((m) => m.login.toLowerCase() === who.toLowerCase())
    const hub = spaces.get(id)?.hub
    if (hub && now && was?.role !== 'owner') await noted(hub, { kind: 'user', login: me }, `@${me}, one of the hub’s admins, made @${now.login} an owner of this Binder.`)
    return hubBinders(request)
  }))
  // Taking a Binder off the hub destroys nothing: it stops, and isn't listed or opened again.
  app.delete('/api/spaces/:id', act(async (request) => {
    const id = param(request, 'id')
    const me = login(request)
    const admin = isAdmin(me)
    const info = spaces.info(id)
    if (!info || !spaces.forPerson(me, admin).some((s) => s.info.id === id)) throw new Refused('No such Binder.')
    if (info.personal) throw new Refused('A personal Binder can’t be removed.')
    if (spaces.roleOf(id, me) !== 'owner' && !(admin && !spaces.hasOwner(id))) throw new Refused('Only the Binder’s owners can remove it.')
    if (spaces.isFirst(id)) throw new Refused('The hub’s first Binder can’t be removed: its files are the hub’s own.')
    if (bodyOf(bodies.removeSpace, request).name !== info.name) throw new Refused('To remove a Binder, type its name exactly as it is.')
    await spaces.remove(id, me)
    return { ...spaceView(request), removed: { id, name: info.name } }
  }))
}
