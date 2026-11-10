import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Refused } from '../hub.ts'
import { captureHome } from '../appLink.ts'
import { log } from '../logger.ts'
import { bodies } from '../schemas.ts'
import { personalId, readerWords } from '../spaces.ts'
import { ask, search, type AskPlace, type AskResult } from '../brain/brain.ts'
import { carryOut, takeProposal } from '../brain/board.ts'
import type { BrainSettings } from '../brain/settings.ts'
import { candidates, isGateway, jobs, offers } from '../brain/autoPick.ts'
import { runnerVersion } from '../../../shared/agents.ts'
import { viewBinders } from '../../../shared/view.ts'
import { chosenHome, type Capture } from '../brain/captures.ts'
import type { Context } from './context.ts'

// The hub's brain: how it's set up (an admin's), questions answered from a Binder's notes and cards, and what a phone
// or Mac captured put in as notes. A question is asked in the request's Binder, or in every Binder the person is in.
// Ask's conversation is kept for each person, in the Binder it was asked in.

/** A phone's outbox sends a day's captures at once: more than that in a minute is something else. */
const captureLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
/** Each question reads every passage of a binder: a person asks a handful a minute. */
const askLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
/** Searching as someone types in ⌘K: a request each time they pause. */
const searchLimit = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }

export async function brainRoutes(app: FastifyInstance, context: Context) {
  const { spaces, auth, brainSettings, brainMachines, sp, login, isAdmin, act, bodyOf, webUrl, param, options } = context

  // Your machines serving the brain's models: an admin's to add and remove, with the line that sets the daemon up on one.
  const admin = (request: Parameters<typeof login>[0], what: string) => {
    if (!brainMachines) throw new Refused('This hub has no machines.')
    if (!isAdmin(login(request))) throw new Refused(`Only the hub’s admins can ${what}.`)
    return brainMachines
  }
  app.get('/api/brain/machines', act(async (request) => {
    const machines = admin(request, 'see its machines').list()
      .map((m) => ({ ...m, servers: (m.servers ?? []).map((s) => (isGateway(s, m.facts?.memoryGb) ? { ...s, gateway: true } : s)) }))
    // For each job no machine can do, a model to download, on a machine with Ollama: none while one is downloading.
    const downloading = new Set(machines.flatMap((m) => (m.downloads ?? []).filter((d) => !d.done && !d.error).map((d) => `${m.id} ${d.model}`)))
    const offered = brainSettings ? offers(machines, brainSettings.openJobs()).filter((o) => !downloading.has(`${o.machine} ${o.action === 'serve' ? (o.runtime === 'mlx-audio' ? 'mlx-audio' : 'LM Studio') : o.model}`)) : []
    // For each job, every model your machines can do it with, best first: what Settings lists to choose from.
    const all = candidates(machines)
    const choices = Object.fromEntries(jobs.map((job) => [job, all[job].slice(0, 40)]))
    return { machines, offers: offered, candidates: choices, latest: runnerVersion }
  }))
  app.post('/api/brain/machines/:id/pull', act(async (request) => {
    const machines = admin(request, 'download models')
    const { model, job, source } = bodyOf<{ model: string; job: string; source?: 'ollama' | 'hf' }>(bodies.pull, request)
    return { download: machines.pull(param(request, 'id'), model, job, source ?? 'ollama') }
  }))
  // A runtime started on a machine, to serve the models already downloaded there.
  app.post('/api/brain/machines/:id/serve', act(async (request) => {
    const machines = admin(request, 'serve models')
    const { runtime, job } = bodyOf<{ runtime: 'mlx-audio' | 'lmstudio'; job: string }>(bodies.serve, request)
    return { task: machines.serve(param(request, 'id'), runtime, job) }
  }))
  const installLine = (token: string) => `curl -fsSL ${options.publicUrl.replace(/\/+$/, '')}/install | sh -s -- add --token ${token}`
  app.post('/api/brain/machines', act(async (request) => {
    const machines = admin(request, 'add a machine')
    const { name } = bodyOf<{ name: string }>(bodies.machine, request)
    const { machine, token } = await machines.add(login(request), name)
    brainSettings?.refresh()
    return { machine, token, install: installLine(token) }
  }))
  // The command for adding machines: one line, run on as many as you like for a day. Each joins on its own.
  app.post('/api/brain/machines/command', act(async (request) => {
    const { token, expiresAt } = await admin(request, 'add machines').joinToken(login(request))
    return { install: installLine(token), expiresAt }
  }))
  // A machine running that command: it joins under its host's name, with a token of its own (binders add asks).
  app.post('/api/brain/machines/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      if (!brainMachines) throw new Refused('This hub has no machines.')
      const body = (request.body ?? {}) as { token?: unknown; host?: unknown }
      const { machine, token } = await brainMachines.join(String(body.token ?? ''), String(body.host ?? '').slice(0, 120))
      brainSettings?.refresh()
      return { id: machine.id, name: machine.name, token }
    } catch (error) {
      if (error instanceof Refused) return reply.code(401).send({ error: error.message })
      throw error
    }
  })
  // Jobs handed back to the hub, to choose from your machines.
  app.post('/api/brain/choose', act(async (request) => {
    if (!brainSettings) throw new Refused('This hub has no brain to set up.')
    if (!isAdmin(login(request))) throw new Refused('Only the hub’s admins can set up its brain.')
    const { jobs } = bodyOf<{ jobs: ('chat' | 'embeddings' | 'transcription' | 'speech')[] }>(bodies.chooseJobs, request)
    return { brain: await brainSettings.letHubChoose(jobs), admin: true }
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
    const space = request.space?.brain
    const index = space ? { ...await space.index.stats(), ...(space.files ? { kept: space.files.status() } : {}) } : undefined
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

  // Started on the way, when one is the person's own personal Binder that nothing has needed yet.
  const placesFor = async (request: Parameters<typeof login>[0], everywhere?: boolean): Promise<AskPlace[]> => {
    // Every binder they're in: as a member, even for a hub admin, who may open others but didn't ask about them.
    const ids = everywhere ? spaces.forPerson(login(request), false).map((s) => s.info.id) : [sp(request).id]
    const started = await Promise.all(ids.map((id) => spaces.start(id)))
    return ids.flatMap((id, i) => {
      const space = started[i]
      if (!space?.brain) return []
      const info = spaces.info(id)
      const name = info?.name ?? id
      const who = login(request)
      // A reader asks and is told how things stand, and has nothing done: the brain refuses to offer them a change here.
      const readOnly = spaces.roleOf(id, who) === 'reader'
      return [{ id, name, brain: space.brain, url: (kind, item) => webUrl(id, kind, item), work: { id, name, hub: space.hub, actions: space.actions, github: () => (info?.personal ? Promise.resolve(undefined) : auth.githubFor(who, id)), ...(readOnly ? { readOnly } : {}) } }]
    })
  }

  /** What was said before, as a client sends it: the hub cuts it to the last few turns and a length it can use. */
  const said = z.array(z.looseObject({ role: z.enum(['user', 'assistant']), text: z.string().max(20_000) })).max(60)
  const asking = bodies.brainAsk.extend({ turns: said.optional() })

  app.post('/api/brain/ask', askLimit, act(async (request) => {
    if (!brainSettings) throw new Refused('This hub has no brain.')
    const body = bodyOf<{ question: string; everywhere?: boolean; turns?: z.infer<typeof said> }>(asking, request)
    const result = await ask(brainSettings, await placesFor(request, body.everywhere), body.question, { person: login(request), may: true, turns: body.turns, views: true })
    // Ask's own page sends the conversation so far, even when it's empty: what it asks is kept for the person, to open
    // again on any device. An offer to do something isn't, as it can't be taken up later. Another client asking alone
    // adds nothing to it.
    if (body.turns && !result.proposal) {
      try {
        await sp(request).brain?.keepTurn(login(request), { question: body.question.trim().slice(0, 2000), everywhere: !!body.everywhere, result })
      } catch (err) {
        log.warn({ why: err instanceof Error ? err.message : String(err) }, 'Couldn’t keep a question to Ask')
      }
    }
    return result
  }))

  // The person's conversation with Ask in this Binder, oldest first. Only theirs, and only what rests on Binders they're
  // still in: a turn that drew on one they've left isn't shown, even to them.
  app.get('/api/brain/conversation', act(async (request) => {
    const who = login(request)
    const mine = new Set([sp(request).id, ...spaces.forPerson(who, false).map((s) => s.info.id)])
    const turns = (await sp(request).brain?.thread(who)) ?? []
    // A view's Things name what's in a Binder too: one from a Binder they've left is shown without it.
    const seen = (result: AskResult): AskResult => {
      if (!result.view || viewBinders(result.view).every((binder) => mine.has(binder))) return result
      const { view: _left, ...rest } = result
      return rest
    }
    return { turns: turns.filter((t) => t.result.sources.every((s) => mine.has(s.binder))).map((t) => ({ ...t, result: seen(t.result) })) }
  }))
  app.delete('/api/brain/conversation', act(async (request) => {
    await sp(request).brain?.forgetThread(login(request))
  }))

  // A question about one note, from its Chat when no agent can answer: the note in front of the brain, in full, and the
  // rest of this Binder to draw on. The brain only reads here; the note is changed by an agent. The chat's turns are the
  // page's, for the visit.
  const aboutNote = z.looseObject({ question: z.string().min(1).max(2000), turns: said.optional() })
  app.post('/api/notes/:id/ask', askLimit, act(async (request) => {
    if (!brainSettings) throw new Refused('This hub has no brain.')
    const body = bodyOf<{ question: string; turns?: z.infer<typeof said> }>(aboutNote, request)
    return ask(brainSettings, await placesFor(request), body.question, { about: { place: sp(request).id, note: param(request, 'id') }, turns: body.turns })
  }))

  // A person's answer to what a question came to: theirs alone, once, and still in a Binder they can open.
  app.post('/api/brain/do', askLimit, act(async (request) => {
    const body = bodyOf<{ id: string; go: boolean }>(bodies.brainDo, request)
    const who = login(request)
    const proposal = takeProposal(who, body.id)
    if (!proposal || !spaces.forPerson(who, isAdmin(who)).some((s) => s.info.id === proposal.place)) throw new Refused('That isn’t waiting any more: ask again.')
    // Asked about a Binder they could change, and since made a reader of: not carried out. The hook leaves this address to
    // say so, as the Binder it's for is the proposal's, not the request's.
    if (body.go && spaces.roleOf(proposal.place, who) === 'reader') throw new Refused(readerWords)
    return { said: body.go ? await carryOut(proposal) : 'All right, I’ve left it.' }
  }))

  // The passages that match, by their words and what they mean, with no model's answer: ⌘K's, as someone types.
  app.post('/api/brain/search', searchLimit, act(async (request) => {
    if (!brainSettings) throw new Refused('This hub has no brain.')
    const body = bodyOf<{ query: string; everywhere?: boolean }>(bodies.brainSearch, request)
    return search(brainSettings, await placesFor(request, body.everywhere), body.query)
  }))

  app.post('/api/captures', captureLimit, act(async (request) => {
    const body = bodyOf<Capture & { sourceId?: string; binder?: string; folder?: string }>(bodies.capture, request)
    const who = login(request)
    let space = sp(request)
    // One that names no Binder (by its address or a binder in its body) goes where the person chose their captures to
    // go, while they're still in it. With no choice made, it goes where it always has.
    const named = request.headers['x-binders-space'] || (request.query as { space?: string } | undefined)?.space || body.binder
    if (!named) {
      const own = (await spaces.start(personalId(who)))?.brain?.kv
      const home = own && (await chosenHome(own)) ? await spaces.start(await captureHome(spaces, who)) : undefined
      if (home?.brain) space = home
    }
    // Where it goes is only known here, so the hook leaves this address to say so: a reader's capture is refused.
    if (spaces.roleOf(space.id, who) === 'reader') throw new Refused(readerWords)
    if (!space.brain) throw new Refused('This Binder doesn’t take captures.')
    if (!body.text.trim()) throw new Refused('A capture needs its words.')
    const capture: Capture = { kind: body.kind, text: body.text, title: body.title, recordedAt: body.recordedAt, durationSeconds: body.durationSeconds, device: body.device, speakers: body.speakers }
    const made = await space.brain.capture(who, capture, { binderId: body.binder, folder: body.folder, sourceId: body.sourceId })
    const { id, title, binderId, folderId } = made.note
    return { note: { id, title, binderId, folderId }, created: made.created, summarizing: made.summarizing, url: webUrl(space.id, 'note', id) }
  }))
}
