import { rm } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { copyLimit, copyName, makeCopy, pausedState, readCopy, takenOn } from '../copies.ts'
import { Refused } from '../hub.ts'
import { noted } from '../history.ts'
import { writeSaved } from '../kept.ts'
import { hubBindersFor } from './binders.ts'
import type { Context } from './context.ts'

// A Binder's copies: download one, see the days kept on the hub's disk, and start a new Binder from one.

const tooLarge = `That file is bigger than ${copyLimit / 1024 / 1024} MB, the most a copy can be.`
const perMinute = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } })

export async function copyRoutes(app: FastifyInstance, context: Context) {
  const { spaces, login, isAdmin, sp, param, fail } = context

  // The Binder's copies on the hub's disk, for anyone in it, and whether they're kept in its repo too.
  app.get('/api/copies', async (request) => (await sp(request).copies?.status()) ?? { days: 0 })

  // The Binder as one file: its owners' and admins' to take, the hub's admins' too while it has no owner.
  app.get('/api/spaces/:id/copy', { config: perMinute(10) }, async (request, reply) => {
    try {
      const id = param(request, 'id')
      const me = login(request)
      const admin = isAdmin(me)
      const info = spaces.info(id)
      if (!info || !spaces.forPerson(me, admin).some((s) => s.info.id === id)) throw new Refused('No such Binder.')
      if (!spaces.mayManage(id, me, admin)) throw new Refused('Only the Binder’s owners and admins can download a copy of it.')
      const hub = (await spaces.start(id))?.hub
      if (!hub) throw new Refused('No such Binder.')
      const now = new Date()
      const { bytes } = await makeCopy(hub, { id, name: info.name, people: info.members }, now)
      await noted(hub, { kind: 'user', login: me }, `@${me} downloaded a copy of this Binder.`)
      return reply.header('content-disposition', `attachment; filename="${copyName(id, now)}"`).type('application/gzip').send(bytes)
    } catch (error) {
      return fail(reply, error)
    }
  })

  // A new Binder from a copy's file, as the whole body: the hub's admins' only. It's checked before anything is made, and
  // a file that's refused leaves no Binder behind. The file may be as large as a Binder is, so only this route takes
  // it, and a size that's too large is turned away from the request's own header, before any of it is read.
  await app.register(async (scope) => {
    scope.addContentTypeParser(['application/gzip', 'application/x-gzip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: copyLimit }, (_request, body, done) => done(null, body))
    scope.post('/api/hub/binders/from-copy', {
      bodyLimit: copyLimit,
      config: perMinute(10),
      onRequest: async (request, reply) => {
        if (!isAdmin(login(request))) return reply.code(422).send({ error: 'Only the hub’s admins start a Binder from a copy.' })
        if (Number(request.headers['content-length']) > copyLimit) return reply.code(413).send({ error: tooLarge })
      },
      errorHandler: (error, _request, reply) => (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? reply.code(413).send({ error: tooLarge }) : reply.send(error)),
    }, async (request, reply) => {
      try {
        const me = login(request)
        if (!isAdmin(me)) throw new Refused('Only the hub’s admins start a Binder from a copy.')
        const name = String((request.query as { name?: string }).name ?? '').trim()
        if (!name) throw new Refused('Give the new Binder a name.')
        if (!Buffer.isBuffer(request.body) || !request.body.length) throw new Refused('Send the copy’s file as the body of the request.')
        const copy = await readCopy(request.body)
        const dirOf = spaces.dirOf
        if (!dirOf) throw new Refused('This hub can’t start a Binder from a copy.')
        let planted: string | undefined
        let info
        try {
          // Put where a Binder's saved state is, so the ordinary start takes it, as a hub with an empty Redis does.
          info = await spaces.create({ name, owner: me }, me, async (id) => {
            planted = dirOf(id)
            await writeSaved(planted, pausedState(copy, name), copy.docs)
          })
        } catch (error) {
          // Nothing of it stays: the folder it was put in goes, as the Binder never came to be.
          if (planted) await rm(planted, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
        const hub = spaces.get(info.id)?.hub
        if (hub) await noted(hub, { kind: 'user', login: me }, `Made from a copy of “${copy.meta.binder.name}” taken ${takenOn(copy.meta.madeAt)}, by @${me}. It doesn’t write to GitHub until that’s turned on in Settings.`)
        return { ...hubBindersFor(context, request), created: { id: info.id, name: info.name } }
      } catch (error) {
        return fail(reply, error)
      }
    })
  })
}
