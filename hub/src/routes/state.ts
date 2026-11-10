import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lightChange, lightState, withoutKept } from '../../../shared/light.ts'
import { slug } from '../../../shared/notes.ts'
import { historyOf, putBack, trashOf } from '../history.ts'
import { isChange } from '../log.ts'
import { Refused, type Hub } from '../hub.ts'
import type { FastifyInstance } from 'fastify'
import type { Binder } from '../../../shared/notes.ts'
import type { Change, Entry, Outgoing } from '../../../shared/state.ts'
import type { Context } from './context.ts'

const repoName = /^[\w.-]+\/[\w.-]+$/

/**
 * Where a binder's cards and notes go, as a change would leave them: a field left out or cleared is what it comes to
 * (notes and issues are on, review comments and copies off, unless set), so a client that writes a default out in full isn't
 * taken to have changed anything.
 */
const whereItGoes = (binder?: Binder) => JSON.stringify([
  binder?.repo?.toLowerCase() || undefined,
  binder?.repos ?? undefined,
  binder?.notes !== false,
  binder?.notesBranch || undefined,
  binder?.issues !== false,
  binder?.reviewComments === true,
  binder?.copies === true,
])

// The state, its changes and its live feed, and the pictures in notes.

const clientPattern = /^[A-Za-z0-9_-]{6,64}$/

export async function stateRoutes(app: FastifyInstance, context: Context) {
  const { spaces, terminals, sp, login, param, isAdmin, fail, act, mayLink, mayLinkAll } = context
  // The state and its changes ----------------------------------------------------------------------------------------

  app.get('/api/state', async (request) => {
    const { hub } = sp(request)
    const query = request.query as { light?: string; have?: string; replay?: string }
    // Without the history and the trash, which are asked for when someone looks (and which the apps don't read).
    if (query.light !== '1') return { version: hub.version, state: withoutKept(hub.state), presence: hub.presence() }
    // A browser's, without the lines of its diffs. Nothing more when it has this version already, or is coming back on
    // a page that's been following along and the live feed can bring it the rest.
    const have = Number(query.have)
    const current = have === hub.version || (query.replay === '1' && await canCatchUp(hub, have))
    return { version: hub.version, ...(current ? {} : { state: lightState(hub.state) }), presence: hub.presence() }
  })

  // What happened in the Binder and what was deleted from it, for anyone in it: kept apart from the state a browser loads.
  app.get('/api/history', act(async (request) => {
    const query = request.query as { before?: string; who?: string }
    return historyOf(sp(request).hub.state, { before: typeof query.before === 'string' ? query.before : undefined, who: typeof query.who === 'string' ? query.who : undefined })
  }))
  app.get('/api/trash', act(async (request) => ({ items: trashOf(sp(request).hub.state) })))
  app.post('/api/trash/:kind/:id/restore', act(async (request) => {
    const kind = param(request, 'kind')
    if (kind !== 'note' && kind !== 'card') throw new Refused('Only notes and cards are kept in the trash.')
    return putBack(sp(request).hub, login(request), kind, param(request, 'id'))
  }))

  app.post('/api/changes', async (request, reply) => {
    const body = request.body as { client?: unknown; changes?: unknown } | undefined
    const client = typeof body?.client === 'string' ? body.client : ''
    if (!clientPattern.test(client)) return reply.code(400).send({ error: 'client must be 6 to 64 letters, digits, - or _' })
    if (!Array.isArray(body?.changes) || body.changes.length > 500) return reply.code(400).send({ error: 'changes must be a list of at most 500' })
    const changes = body.changes as Outgoing[]
    if (!changes.every((c) => typeof c?.id === 'string' && c.id.length <= 100 && isChange(c.change))) return reply.code(400).send({ error: 'each change needs an id and a change' })
    try {
      // A tab's changes are its own: the log knows them by the tab and the person.
      const { hub } = sp(request)
      // A project's repo changes only to one the person can push to.
      // Its agents' repos too, at most 500: each new one, only by someone who can push to it, as an agent's own repos.
      const vet = async (change: Change) => {
        // A note held without its text is a browser's own: writing it whole would replace the note with nothing.
        if (change.type === 'note.put' && change.note?.left) throw new Refused('This note’s text isn’t loaded in this browser, so it can’t be saved from it.')
        // A card held without its detail is a browser's own: writing it whole would replace the card with a shell.
        if (change.type === 'card.put' && change.card?.left) throw new Refused('This card isn’t loaded in this browser, so it can’t be saved from it.')
        // Where a Binder's cards and notes go, and taking a binder away, are its owners' and admins' to change (the
        // hub's admins', while it has no owner).
        if (change.type === 'binder.delete' || (change.type === 'binder.put' && whereItGoes(change.binder) !== whereItGoes(hub.state.binders.find((b) => b.id === change.binder.id)))) {
          const info = spaces.info(sp(request).id)
          if (info && !spaces.mayManage(info.id, login(request), isAdmin(login(request)))) throw new Refused('Only this Binder’s owners and admins can change where its cards and notes go.')
        }
        if (change.type !== 'binder.put') return
        const was = hub.state.binders.find((b) => b.id === change.binder.id)
        if (change.binder.repo && was?.repo?.toLowerCase() !== change.binder.repo.toLowerCase()) await mayLink(request, change.binder.repo, true)
        const repos = change.binder.repos
        if (repos === undefined) return
        if (!Array.isArray(repos) || repos.length > 500 || !repos.every((r) => typeof r === 'string' && repoName.test(r))) throw new Refused('A binder’s repos are a list of at most 500, each as owner/name.')
        await mayLinkAll(request, repos, was?.repos ?? [])
      }
      const versions = await hub.submit(request.user!.login, client, changes, vet)
      // A Binder goes by its one binder's name: renamed there (on the web or a Mac), it's renamed too.
      const info = spaces.info(sp(request).id)
      const sole = hub.state.binders.length === 1 ? hub.state.binders[0] : undefined
      if (info && !info.personal && sole && sole.name.trim() && sole.name !== info.name) await spaces.rename(info.id, sole.name).catch(() => undefined)
      return { versions, version: hub.version }
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/live', { websocket: true }, (socket, request) => {
    const { hub, id: spaceId } = sp(request)
    // The terminals open on the agents they own, now and as they change: the sidebar lists them.
    const me = request.user!.login.toLowerCase()
    const terminalsOf = (key: string) => {
      const [inSpace, agentId] = key.split('/')
      // A terminal runs commands on its owner's machine: a reader's browser is never told of one.
      if (request.role === 'reader') return
      const agent = inSpace === spaceId && hub.state.agents.find((a) => a.id === agentId && !a.revoked && a.owner.toLowerCase() === me)
      if (agent && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'terminals', agentId, ...terminals.list(key) }))
    }
    for (const agent of hub.state.agents) if (!agent.revoked && agent.owner.toLowerCase() === me) terminalsOf(`${spaceId}/${agent.id}`)
    terminals.on('change', terminalsOf)
    const { since: from, light } = request.query as { since?: string; light?: string }
    const since = Number(from ?? 0)
    let sent = Number.isFinite(since) && since >= 0 ? since : 0
    const send = (entries: Entry[]) => {
      const fresh = entries.filter((e) => e.version > sent)
      if (!fresh.length || socket.readyState !== socket.OPEN) return
      sent = fresh[fresh.length - 1].version
      socket.send(JSON.stringify({ type: 'entries', entries: light === '1' ? fresh.map((e) => ({ ...e, change: lightChange(e.change) })) : fresh }))
    }
    // What happens while it's catching up waits its turn: sent at once it would go ahead of the changes before it, and
    // those would then be taken for old and left out.
    let caughtUp = false
    const waiting: Entry[] = []
    const live = (entries: Entry[]) => {
      if (caughtUp) send(entries)
      else waiting.push(...entries)
    }
    hub.on('entries', live)
    void (async () => {
      try {
        // The log may not go back as far as this client, or the client may be ahead of a log that started over: it's
        // told, so it asks for the state whole and comes back, and until then it gets what happens from now.
        if (sent > hub.version || (sent < hub.version && (await hub.read(sent, 1))[0]?.version !== sent + 1)) {
          sent = hub.version
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'behind', version: sent }))
        } else {
          // Everything it missed, a few thousand at a time, however far behind it is.
          const upTo = hub.version
          while (sent < upTo && socket.readyState === socket.OPEN) {
            const missed = await hub.read(sent, liveBatch)
            if (!missed.length) break
            send(missed)
          }
        }
      } catch {
        // The log couldn't be read just now: what happens from here still goes.
      }
      caughtUp = true
      send(waiting.splice(0))
    })()
    // Agents' presence: what it is now, then each change.
    const presence = (now: Record<string, unknown>) => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: 'presence', presence: now }))
    presence(hub.presence())
    hub.on('presence', presence)
    // Something came in through a listener, or was taken back: the page asks for the rows again.
    const heard = () => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: 'heard' }))
    hub.on('heard', heard)
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000)
    socket.on('close', () => {
      terminals.off('change', terminalsOf)
      hub.off('entries', live)
      hub.off('presence', presence)
      hub.off('heard', heard)
      clearInterval(ping)
    })
  })

  // Pictures in notes: kept by their contents' hash, so the same picture twice is one file.
  const pictureTypes: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' }
  await app.register(async (scope) => {
    scope.addContentTypeParser(Object.keys(pictureTypes), { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_request, body, done) => done(null, body))
    scope.post('/api/files', async (request, reply) => {
      const ext = pictureTypes[String(request.headers['content-type'] ?? '').split(';')[0].trim()]
      const { hub, filesDir } = sp(request)
      if (!filesDir) return reply.code(503).send({ error: 'This hub keeps no files.' })
      if (!ext || !Buffer.isBuffer(request.body) || !request.body.length) return reply.code(400).send({ error: 'Send a picture: PNG, JPEG, GIF, WebP, SVG or AVIF, up to 20 MB.' })
      const name = `${createHash('sha256').update(request.body).digest('hex').slice(0, 24)}.${ext}`
      // Kept in the note's binder, so they go to its repo with its notes.
      const note = hub.state.notes.find((n) => n.id === (request.query as { note?: string }).note)
      const binder = note && hub.state.binders.find((b) => b.id === note.binderId)
      const dir = binder ? join(filesDir, '..', slug(binder.name), 'files') : filesDir
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), request.body)
      return { url: `/api/files/${name}`, name }
    })
  })
  app.get('/api/files/:name', async (request, reply) => {
    const name = param(request, 'name')
    const ext = /^[a-f0-9]{24}\.([a-z]+)$/.exec(name)?.[1]
    const type = Object.entries(pictureTypes).find(([, e]) => e === ext)?.[0]
    // Looked for in the Binders the person may open: a picture's name is its hash, so it's found wherever it was put.
    const dirs = (await Promise.all(spaces.forPerson(login(request), isAdmin(login(request))).map(async ({ info }) => (await spaces.start(info.id))?.filesDir))).filter((d): d is string => !!d)
    if (!dirs.length || !type) return reply.code(404).send({ error: 'No such file.' })
    try {
      const file = await findFile(dirs, name)
      // SVG can carry script: shown only as a picture, never as a page.
      return reply.type(type).header('cache-control', 'private, max-age=31536000, immutable').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox").header('x-content-type-options', 'nosniff').send(file)
    } catch {
      return reply.code(404).send({ error: 'No such file.' })
    }
  })
}

/** How far behind a page may be and still catch up from the live feed, which replays up to 5000 changes. */
const catchUpMost = 2000
/** How many changes the live feed reads from the log at a time for a client that's behind. */
const liveBatch = 2000

/** Whether the log still has every change after this version: the next one is there, or it was lost with its Redis. */
export async function canCatchUp(hub: Hub, have: number) {
  if (!Number.isInteger(have) || have <= 0 || have > hub.version || hub.version - have > catchUpMost) return false
  return (await hub.read(have, 1))[0]?.version === have + 1
}

/** A picture by its name: in one of these Binders' files folders, or one of their projects'. */
async function findFile(filesDirs: string[], name: string) {
  for (const filesDir of filesDirs) {
    const top = join(filesDir, '..')
    for (const dir of [filesDir, ...(await readdir(top, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(top, d.name, 'files'))]) {
      const file = await readFile(join(dir, name)).catch(() => undefined)
      if (file) return file
    }
  }
  throw new Error('No such file.')
}
