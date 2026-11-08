import type { FastifyInstance } from 'fastify'
import { Refused } from '../hub.ts'
import { bodies } from '../schemas.ts'
import { ask, type AskPlace } from '../brain/brain.ts'
import type { BrainSettings } from '../brain/settings.ts'
import type { Capture } from '../brain/captures.ts'
import type { Context } from './context.ts'

// The hub's brain: how it's set up (an admin's), questions answered from a Binder's notes and cards, and what a phone
// or Mac captured put in as notes. A question is asked in the request's Binder, or in every Binder the person is in.

/** A phone's outbox sends a day's captures at once: more than that in a minute is something else. */
const captureLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
/** Each question reads every passage of a binder: a person asks a handful a minute. */
const askLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export async function brainRoutes(app: FastifyInstance, context: Context) {
  const { spaces, brainSettings, brainMachines, sp, login, isAdmin, act, bodyOf, webUrl, param, options } = context

  // Your machines serving the brain's models: an admin's to add and remove, with the line that sets the daemon up on one.
  const admin = (request: Parameters<typeof login>[0], what: string) => {
    if (!brainMachines) throw new Refused('This hub has no machines.')
    if (!isAdmin(login(request))) throw new Refused(`Only the hub’s admins can ${what}.`)
    return brainMachines
  }
  app.get('/api/brain/machines', act(async (request) => ({ machines: admin(request, 'see its machines').list() })))
  app.post('/api/brain/machines', act(async (request) => {
    const machines = admin(request, 'add a machine')
    const { name } = bodyOf<{ name: string }>(bodies.machine, request)
    const { machine, token } = await machines.add(login(request), name)
    brainSettings?.refresh()
    return { machine, token, install: `curl -fsSL ${options.publicUrl.replace(/\/+$/, '')}/install | sh -s -- add --token ${token}` }
  }))
  app.delete('/api/brain/machines/:id', act(async (request) => {
    await admin(request, 'remove a machine').remove(param(request, 'id'))
    // What it served says it needs a machine now.
    brainSettings?.refresh()
    return { ok: true }
  }))
  // The daemon's own: who its token is (binders add asks), and its live link, which says who it is first.
  app.get('/api/brain/machine/me', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    const machine = await brainMachines?.who(token)
    if (!machine) return reply.code(401).send({ error: 'This hub doesn’t know that token.' })
    return { id: machine.id, name: machine.name }
  })
  app.get('/api/brain/machine', { websocket: true }, (socket) => {
    if (!brainMachines) return socket.close(4004, 'This hub has no machines.')
    brainMachines.link(socket)
  })

  app.get('/api/brain', act(async (request) => {
    const view = brainSettings?.view()
    const admin = isAdmin(login(request))
    const index = request.space?.brain ? await request.space.brain.index.stats() : undefined
    // Only admins see where the models are and how they're reached; everyone sees what answers.
    const brain = view && (admin ? view : {
      provider: view.provider, summarize: view.summarize, localOnly: view.localOnly, inUse: view.inUse, embeddingsInUse: view.embeddingsInUse,
      transcriptionInUse: view.transcriptionInUse, speechInUse: view.speechInUse,
    })
    return { brain, admin, ...(index ? { index } : {}) }
  }))

  app.patch('/api/brain', act(async (request) => {
    if (!brainSettings) throw new Refused('This hub has no brain to set up.')
    if (!isAdmin(login(request))) throw new Refused('Only the hub’s admins can set up its brain.')
    type Keys = { apiKey?: string; embeddingsKey?: string; transcriptionKey?: string; speechKey?: string }
    return { brain: await brainSettings.set(bodyOf<Partial<BrainSettings> & Keys>(bodies.brain, request)), admin: true }
  }))

  app.post('/api/brain/ask', askLimit, act(async (request) => {
    if (!brainSettings) throw new Refused('This hub has no brain.')
    const body = bodyOf<{ question: string; everywhere?: boolean }>(bodies.brainAsk, request)
    const who = login(request)
    // Every binder they're in: as a member, even for a hub admin, who may open others but didn't ask about them.
    const ids = body.everywhere ? spaces.forPerson(who, false).map((s) => s.info.id) : [sp(request).id]
    const places: AskPlace[] = ids.flatMap((id) => {
      const space = spaces.get(id)
      return space?.brain ? [{ id, name: spaces.info(id)?.name ?? id, brain: space.brain, url: (kind, item) => webUrl(id, kind, item) }] : []
    })
    return ask(brainSettings, places, body.question)
  }))

  app.post('/api/captures', captureLimit, act(async (request) => {
    const space = sp(request)
    if (!space.brain) throw new Refused('This Binder doesn’t take captures.')
    const body = bodyOf<Capture & { sourceId?: string; binder?: string; folder?: string }>(bodies.capture, request)
    if (!body.text.trim()) throw new Refused('A capture needs its words.')
    const capture: Capture = { kind: body.kind, text: body.text, title: body.title, recordedAt: body.recordedAt, durationSeconds: body.durationSeconds, device: body.device, speakers: body.speakers }
    const made = await space.brain.capture(login(request), capture, { binderId: body.binder, folder: body.folder, sourceId: body.sourceId })
    const { id, title, binderId, folderId } = made.note
    return { note: { id, title, binderId, folderId }, created: made.created, summarizing: made.summarizing, url: webUrl(space.id, 'note', id) }
  }))
}
