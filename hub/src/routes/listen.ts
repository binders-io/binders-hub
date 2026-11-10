import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Refusal } from '../auth.ts'
import { Refused } from '../hub.ts'
import type { Heard } from '../../../shared/listen.ts'
import type { ListenerFields } from '../listen/inbox.ts'
import type { Context } from './context.ts'

// A Binder's listeners: who is listening and how each is set (its owners' and admins' to change, everyone's in the
// Binder to see), what came in and what became of it, and the address a source posts to. That address is the one way in
// that needs no sign-in: it takes the listener's secret, as a bearer token, a signature of the body, or a key in the
// address for a source that can set neither, and anything else is answered as if the address weren't there.

/** The most one post brings, and the most it weighs. */
const mostAtOnce = 50
const mostBytes = 256 * 1024

const words = (value: unknown, most: number) => (typeof value === 'string' && value.trim() ? value.slice(0, most) : undefined)

/** One thing posted, as the inbox takes it. A post proves only that it holds the secret: who it says sent it is a name to show, never a login. */
function heardFrom(given: unknown): Heard | undefined {
  if (typeof given === 'string') return given.trim() ? { sourceId: createHash('sha256').update(given).digest('hex').slice(0, 32), text: given } : undefined
  if (!given || typeof given !== 'object' || Array.isArray(given)) return undefined
  const one = given as Record<string, unknown>
  const text = words(one.text ?? one.body ?? one.Body ?? one.message ?? one.content, 100_000)
  const title = words(one.title ?? one.subject, 300)
  if (!text && !title) return undefined
  const from = one.from ?? one.From ?? one.sender
  const sender = typeof from === 'string' ? { name: words(from, 200) } : from && typeof from === 'object' ? { name: words((from as Record<string, unknown>).name, 200), address: words((from as Record<string, unknown>).address ?? (from as Record<string, unknown>).email, 200) } : undefined
  const at = words(one.at ?? one.date ?? one.time, 60)
  const id = words(one.id ?? one.MessageSid, 500) ?? (typeof one.id === 'number' ? String(one.id) : undefined)
  // With no name of its own, the same words sent twice are one thing.
  const sourceId = id ?? createHash('sha256').update(`${title ?? ''}\u0000${text ?? ''}\u0000${at ?? ''}`).digest('hex').slice(0, 32)
  return { sourceId, ...(words(one.thread, 500) ? { thread: words(one.thread, 500) } : {}), ...(at ? { at } : {}), ...(sender?.name || sender?.address ? { sender } : {}), ...(title ? { title } : {}), text: text ?? '', ...(words(one.url ?? one.link, 2000) ? { url: words(one.url ?? one.link, 2000) } : {}) }
}

/** What a post's body holds: one thing, a list of them, or a list under `events`. */
export function heardIn(body: unknown): Heard[] {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : [body]
  return list.slice(0, mostAtOnce).flatMap((one) => heardFrom(one) ?? [])
}

export async function listenRoutes(app: FastifyInstance, context: Context) {
  const { spaces, sp, login, isAdmin, act, param, options } = context

  const mayManage = (request: FastifyRequest) => spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))
  const owner = (request: FastifyRequest, doing: string) => {
    if (!mayManage(request)) throw new Refusal(`Only this Binder’s owners and admins ${doing} a listener.`)
  }
  const inboxOf = (request: FastifyRequest) => {
    const inbox = sp(request).inbox
    if (!inbox) throw new Refused('This Binder can’t have listeners.')
    return inbox
  }
  const addressOf = (space: string, id: string) => `${options.publicUrl.replace(/\/$/, '')}/webhooks/in/${space}/${id}`
  const fieldsOf = (request: FastifyRequest): ListenerFields => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
    return { name: text(body.name), kind: text(body.kind) as ListenerFields['kind'], binderId: text(body.binderId), mode: text(body.mode) as ListenerFields['mode'], folder: text(body.folder), from: text(body.from) as ListenerFields['from'], url: text(body.url), everyMinutes: typeof body.everyMinutes === 'number' ? body.everyMinutes : undefined }
  }

  app.get('/api/listen', act(async (request) => {
    const space = sp(request)
    return { listeners: (space.inbox?.listeners() ?? []).map((listener) => ({ ...listener, ...(listener.kind === 'post' ? { address: addressOf(space.id, listener.id) } : {}) })), mayManage: mayManage(request) }
  }))

  app.post('/api/listen', act(async (request) => {
    owner(request, 'add')
    const made = await inboxOf(request).put(login(request), undefined, fieldsOf(request))
    return { listener: { ...made.listener, ...(made.listener.kind === 'post' ? { address: addressOf(sp(request).id, made.listener.id) } : {}) }, ...(made.secret ? { secret: made.secret } : {}) }
  }))

  app.put('/api/listen/:id', act(async (request) => {
    owner(request, 'change')
    const { listener } = await inboxOf(request).put(login(request), param(request, 'id'), fieldsOf(request))
    // A feed turned on or pointed elsewhere is read now, not at the next look.
    if (listener.kind === 'feed' && listener.mode !== 'off') void sp(request).feeds?.look().catch(() => undefined)
    return { listener: { ...listener, ...(listener.kind === 'post' ? { address: addressOf(sp(request).id, listener.id) } : {}) } }
  }))

  app.delete('/api/listen/:id', act(async (request) => {
    owner(request, 'remove')
    await inboxOf(request).remove(login(request), param(request, 'id'))
  }))

  app.post('/api/listen/:id/secret', act(async (request) => {
    owner(request, 'change')
    return { secret: await inboxOf(request).newSecret(param(request, 'id')) }
  }))

  // What came in, newest first: for everyone in the Binder.
  app.get('/api/listen/feed', act(async (request) => ({ rows: (await sp(request).inbox?.feed()) ?? [] })))

  app.post('/api/listen/feed/:id/undo', act(async (request) => ({ row: await inboxOf(request).undo(login(request), param(request, 'id')) })))

  // A note from outside, read by someone in the Binder and let through: its folder's rule may take it from here.
  app.post('/api/notes/:id/pass', act(async (request) => {
    await inboxOf(request).pass(login(request), param(request, 'id'))
  }))

  // The address a source posts to ------------------------------------------------------------------------------------

  await app.register(async (scope) => {
    // The body as it was sent, for the signature: read as JSON, a form or plain words afterwards.
    scope.removeContentTypeParser('application/x-www-form-urlencoded')
    scope.addContentTypeParser(['application/json', 'text/plain', 'application/x-www-form-urlencoded'], { parseAs: 'buffer', bodyLimit: mostBytes }, (_request, body, done) => done(null, body))
    scope.post('/webhooks/in/:space/:listener', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, bodyLimit: mostBytes }, async (request, reply) => {
      const { space: spaceId, listener: listenerId } = request.params as { space: string; listener: string }
      const none = () => reply.code(404).send({ error: 'No such address.' })
      // Only a Binder that's on this hub is started for a post, and only when the post holds its listener's secret.
      if (!spaces.info(spaceId)) return none()
      const space = await spaces.start(spaceId)
      const inbox = space?.inbox
      const listener = inbox?.listener(listenerId)
      if (!inbox || listener?.kind !== 'post') return none()
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('')
      const header = (name: string) => (typeof request.headers[name] === 'string' ? (request.headers[name] as string) : undefined)
      const bearer = /^Bearer\s+(\S+)$/i.exec(header('authorization') ?? '')?.[1] ?? words((request.query as { key?: unknown } | undefined)?.key, 200)
      if (!(await inbox.admits(listenerId, { bearer, signature: header('x-binders-signature'), raw }))) return none()
      const type = (header('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const sent = raw.toString('utf8')
      let body: unknown
      if (type === 'application/json') {
        try {
          body = JSON.parse(sent)
        } catch {
          return reply.code(400).send({ error: 'That isn’t JSON.' })
        }
      } else if (type === 'application/x-www-form-urlencoded') body = Object.fromEntries(new URLSearchParams(sent))
      else body = sent
      const heard = heardIn(body)
      if (!heard.length) return reply.code(400).send({ error: 'Nothing to hear: send text, or JSON with a text or a title.' })
      const rows = await inbox.take(listenerId, heard)
      return reply.code(202).send({ heard: rows.length })
    })
  })
}
