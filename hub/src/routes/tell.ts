import { Refusal } from '../auth.ts'
import { Refused } from '../hub.ts'
import { forAttention, waitingOn } from '../../../shared/waiting.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// A Binder's channel, and what waits for a person across their Binders. The address a Binder tells is a secret: this says
// whether one is set, its host and how its last post went, takes a new one, tries it, and forgets it. Only the Binder's
// owners and admins, and the hub's admins, change it; everyone in the Binder sees how it stands.

export async function tellRoutes(app: FastifyInstance, context: Context) {
  const { spaces, sp, login, isAdmin, act } = context

  const mayManage = (request: FastifyRequest) => spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))
  const owner = (request: FastifyRequest, doing: string) => {
    if (!mayManage(request)) throw new Refusal(`Only this binder’s owners and admins ${doing} a channel.`)
  }
  const teller = (request: FastifyRequest) => {
    const tell = sp(request).tell
    if (!tell) throw new Refused('This binder can’t tell a channel.')
    return tell
  }

  app.get('/api/tell', act(async (request) => ({ ...(sp(request).tell?.status() ?? { set: false }), mayManage: mayManage(request) })))

  app.put('/api/tell', act(async (request) => {
    owner(request, 'change')
    const tell = teller(request)
    const given = (request.body as { url?: unknown } | undefined)?.url
    if (typeof given !== 'string') throw new Refused('Paste the channel’s address.')
    return { ...(await tell.configure(given)), mayManage: true }
  }))

  app.delete('/api/tell', act(async (request) => {
    owner(request, 'stop telling')
    await sp(request).tell?.forget()
  }))

  app.post('/api/tell/test', act(async (request) => {
    owner(request, 'try')
    const tell = sp(request).tell
    if (!tell?.set) return { ok: false, answered: 'No address is set yet.' }
    return tell.test()
  }))

  // How many things wait for the person, or for anyone, in each Binder they're in: the Binder switcher's numbers. Only
  // Binders that name them (or name nobody, which is open to everyone): a hub admin who isn't in a Binder isn't counted
  // there, and a hub with thousands of Binders isn't read through for each.
  app.get('/api/me/waiting', act(async (request) => {
    const who = login(request)
    const mine = spaces.forPerson(who, isAdmin(who)).filter(({ info }) => !info.members.length || info.members.some((m) => m.login.toLowerCase() === who.toLowerCase()))
    return {
      binders: mine.map(({ info, role }) => {
        const hub = spaces.get(info.id)?.hub
        // Nothing waits on a reader: they answer nothing and approve nothing.
        return { id: info.id, name: info.name, count: hub ? forAttention(waitingOn(hub.state, who, { reads: role === 'reader' })).length : 0 }
      }),
    }
  }))
}
