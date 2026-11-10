import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Refusal } from '../auth.ts'
import { save } from '../../../shared/noteDoc.ts'
import { Refused } from '../hub.ts'
import { captureFolders } from '../brain/brain.ts'
import { commentOn, decide, propose, setLock } from '../noteChanges.ts'
import { fromMarkdown, lockStops, slug, titleOf, type Binder, type Note } from '../../../shared/notes.ts'
import { readerWords, type Space } from '../spaces.ts'
import { bodies } from '../schemas.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// Cards, change sets, schedules and what else people ask of the work: a note's lock, versions, sending and summing up too.

export async function workRoutes(app: FastifyInstance, context: Context) {
  const { sp, login, param, act, bodyOf, spaces, isAdmin, fail, webUrl } = context
  /** Asking an agent for a debrief or a Challenge: the one named, or one the hub picks. */
  const askFor = <T>(request: FastifyRequest, ask: (login: string, id: string, agentId?: string, effort?: string) => Promise<T>) => {
    const { agentId, effort } = bodyOf(bodies.ask, request)
    return ask.call(sp(request).actions, login(request), param(request, 'id'), agentId || undefined, effort)
  }
  app.post('/api/cards', act(async (request) => {
    return sp(request).actions.createCard({ kind: 'user', login: login(request) }, bodyOf(bodies.newCard, request))
  }))
  // A card's whole activity: a browser's state has the recent lines and the newest few, and asks for the rest when the card opens.
  app.get('/api/cards/:id/activity', async (request, reply) => {
    const card = sp(request).hub.state.cards.find((c) => c.id === param(request, 'id'))
    if (!card) return reply.code(404).send({ error: 'No such card.' })
    return { activity: card.activity }
  })
  // A Challenge's whole blast radius: a browser's state has its counts and not its symbols, and asks for them when they're shown.
  // Reads, so a reader may ask too: the hook lets every GET through.
  app.get('/api/cards/:id/blast', async (request, reply) => {
    const card = sp(request).hub.state.cards.find((c) => c.id === param(request, 'id'))
    if (!card) return reply.code(404).send({ error: 'No such card.' })
    return { blast: card.challenge?.blast }
  })
  app.get('/api/sets/:id/blast', async (request, reply) => {
    const set = sp(request).hub.state.changeSets.find((s) => s.id === param(request, 'id'))
    if (!set) return reply.code(404).send({ error: 'No such change set.' })
    return { blast: set.challenge?.blast }
  })
  app.get('/api/cards/:id/change-set', act(async (request) => sp(request).actions.changeSet(param(request, 'id'))))
  app.get('/api/cards/:id/debrief', act(async (request) => sp(request).actions.debriefOf(param(request, 'id'))))
  app.post('/api/cards/:id/debrief', act(async (request) => askFor(request, sp(request).actions.askDebrief)))
  app.post('/api/cards/:id/challenge', act(async (request) => askFor(request, sp(request).actions.askChallenge)))
  // A change set's debrief and Challenge, of all its pull requests together (a card's id asks for its set's too).
  app.get('/api/sets/:id/debrief', act(async (request) => sp(request).actions.debriefOf(param(request, 'id'))))
  app.post('/api/sets/:id/debrief', act(async (request) => askFor(request, sp(request).actions.askDebrief)))
  app.post('/api/sets/:id/challenge', act(async (request) => askFor(request, sp(request).actions.askChallenge)))
  app.post('/api/sets/:id/challenge/replies', act(async (request) => sp(request).actions.askSetReplies(login(request), param(request, 'id'))))
  app.post('/api/cards/:id/challenge/replies', act(async (request) => sp(request).actions.askReplies(login(request), param(request, 'id'))))
  app.post('/api/cards/:id/findings/:finding', act(async (request) => {
    const { action } = bodyOf(bodies.finding, request)
    if (action !== 'send back' && action !== 'dismiss' && action !== 'card' && action !== 'reopen') throw new Refused('A finding is sent back, dismissed, made a card of, or opened again.')
    return sp(request).actions.actOnFinding(login(request), param(request, 'id'), param(request, 'finding'), action)
  }))
  app.post('/api/cards/:id/comment', act(async (request) => sp(request).actions.comment(login(request), param(request, 'id'), bodyOf(bodies.comment, request).text ?? '')))
  // Stops what an agent is doing on a card, which then waits in Proposed.
  app.post('/api/cards/:id/stop', act(async (request) => sp(request).actions.stopCard(login(request), param(request, 'id'))))
  // A card in review goes back to its agent, with what to change.
  app.post('/api/cards/:id/send-back', act(async (request) => sp(request).actions.sendBackFromReview(login(request), param(request, 'id'), bodyOf(bodies.sendBack, request).text)))
  // Splits a card into parts for a swarm of agents; each part a card of its own, the card waiting for them.
  app.post('/api/cards/:id/permission', act(async (request) => {
    const { request: asked, allow } = bodyOf(bodies.permission, request)
    return sp(request).actions.answerPermission(login(request), param(request, 'id'), asked, allow)
  }))
  app.post('/api/cards/:id/split', act(async (request) => {
    const body = request.body as { parts?: { title?: unknown; brief?: unknown; agent?: unknown }[] } | undefined
    const parts = Array.isArray(body?.parts) ? body!.parts : []
    return sp(request).actions.splitCard(login(request), param(request, 'id'), parts.map((part) => ({
      title: String(part?.title ?? ''),
      ...(part?.brief == null ? {} : { brief: String(part.brief) }),
      ...(part?.agent == null ? {} : { agent: String(part.agent) }),
    })))
  }))
  app.post('/api/notes/:id/chat', act(async (request) => {
    const body = bodyOf(bodies.chat, request)
    return sp(request).actions.say(login(request), param(request, 'id'), body.agentId ?? '', body.text ?? '')
  }))
  // Scheduled runs: a note run as a card on a timer.
  app.post('/api/schedules', act(async (request) => {
    const body = bodyOf(bodies.newSchedule, request)
    return sp(request).actions.addSchedule(login(request), { noteId: body.noteId ?? '', agentId: body.agentId || undefined, cron: body.cron ?? '', tz: body.tz ?? '', enabled: body.enabled, folderId: body.folderId || undefined, staleHours: body.staleHours })
  }))
  app.patch('/api/schedules/:id', act(async (request) => {
    const body = bodyOf(bodies.changeSchedule, request)
    return sp(request).actions.updateSchedule(login(request), param(request, 'id'), { agentId: body.agentId, cron: body.cron, tz: body.tz, enabled: body.enabled, folderId: body.folderId, staleHours: body.staleHours })
  }))
  app.delete('/api/schedules/:id', act(async (request) => sp(request).actions.deleteSchedule(login(request), param(request, 'id'))))
  app.post('/api/schedules/:id/run', act(async (request) => sp(request).actions.runSchedule(param(request, 'id'), login(request))))
  // Repos' briefs: written by an agent when asked, with lessons people and agents add meanwhile.
  // A folder's rule sends work to agents with nobody reading it first, under its owner's sign-in: a Binder's owners' and
  // admins' to set.
  const mayManage = (request: FastifyRequest) => {
    if (!spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))) throw new Refused('Only this Binder’s owners and admins can set a folder’s rules.')
  }
  app.put('/api/folders/:id/rule', act(async (request) => {
    mayManage(request)
    const body = bodyOf(bodies.folderRule, request)
    return sp(request).actions.setFolderRule(login(request), param(request, 'id'), { enabled: body.enabled, distill: body.distill, agentId: body.agentId, quietMinutes: body.quietMinutes, accept: body.accept as never, changeSet: body.changeSet })
  }))
  app.delete('/api/folders/:id/rule', act(async (request) => {
    mayManage(request)
    return sp(request).actions.deleteFolderRule(login(request), param(request, 'id'))
  }))
  // Whether one note's work stays together is its people's to say.
  app.put('/api/notes/:id/change-set', act(async (request) => sp(request).actions.setNoteChangeSet(login(request), param(request, 'id'), bodyOf(bodies.noteChangeSet, request).changeSet)))

  const repoParam = (request: FastifyRequest) => `${param(request, 'owner')}/${param(request, 'name')}`
  app.post('/api/briefs/:owner/:name/ask', act(async (request) => {
    const { agentId, refresh } = bodyOf(bodies.briefAsk, request)
    return (await sp(request).actions.askBrief({ kind: 'user', login: login(request) }, repoParam(request), agentId || undefined, refresh)).brief
  }))
  app.post('/api/briefs/:owner/:name/lessons', act(async (request) => sp(request).actions.addLesson({ kind: 'user', login: login(request) }, repoParam(request), bodyOf(bodies.lesson, request).text ?? '')))
  app.delete('/api/briefs/:owner/:name/lessons/:at', act(async (request) => sp(request).actions.removeLesson(login(request), repoParam(request), param(request, 'at'))))
  app.delete('/api/briefs/:owner/:name', act(async (request) => sp(request).actions.forgetBrief(login(request), repoParam(request))))
  app.post('/api/proposals/:id/accept', act(async (request) => sp(request).actions.acceptProposal({ kind: 'user', login: login(request) }, param(request, 'id'))))
  app.delete('/api/sets/:id', act(async (request) => sp(request).actions.deleteSet(login(request), param(request, 'id'))))
  app.post('/api/sets/:id/review', act(async (request) => sp(request).actions.sendForReview(login(request), param(request, 'id'))))
  app.post('/api/sets/:id/order', act(async (request) => sp(request).actions.reorderSet(login(request), param(request, 'id'), bodyOf(bodies.order, request).prIds)))
  app.post('/api/sets/:id/check', act(async (request) => sp(request).actions.checkSet(param(request, 'id'), request.githubToken)))
  // A pull request's diff, with its lines: a browser's state leaves them out until it's opened. One that's been over for
  // a while has none in the state, and they're read from GitHub, and not put back.
  app.get('/api/pulls/:repo/:number/files', async (request, reply) => {
    const id = `${decodeURIComponent(param(request, 'repo'))}#${param(request, 'number')}`
    const pull = sp(request).hub.state.pulls.find((p) => p.id === id)
    if (!pull) return reply.code(404).send({ error: 'No such pull request.' })
    try {
      return { files: await sp(request).actions.pullFiles(pull) }
    } catch (error) {
      return fail(reply, error)
    }
  })
  app.post('/api/pulls/:repo/:number/update-branch', act(async (request) => sp(request).actions.updateBranch(`${decodeURIComponent(param(request, 'repo'))}#${param(request, 'number')}`, request.githubToken)))
  app.post('/api/pulls/:repo/:number/resolve', act(async (request) => sp(request).actions.sendBackToResolve(login(request), `${decodeURIComponent(param(request, 'repo'))}#${param(request, 'number')}`)))
  app.post('/api/sets/:id/approve', act(async (request) => sp(request).actions.approveSet(login(request), param(request, 'id'), request.githubToken)))

  // Delivery: the environments each repo is deployed to. GitHub says what's on them; a Binder's owners and admins say
  // what GitHub can't (where one is served, a workflow the hub may run to deploy to it, their order), as they run its
  // GitHub, and may have the hub look at GitHub now. Anyone in the Binder reads them, in its state, and promotes.
  const mayChangeDelivery = (request: FastifyRequest) => {
    if (!spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))) throw new Refused('Only this Binder’s owners and admins can change its environments.')
  }
  // An environment's id has a # and a / in it, so it comes encoded.
  const environmentOf = (request: FastifyRequest) => {
    try {
      return decodeURIComponent(param(request, 'id'))
    } catch {
      return param(request, 'id')
    }
  }
  app.post('/api/environments', act(async (request) => {
    mayChangeDelivery(request)
    const body = bodyOf(bodies.newEnvironment, request)
    return sp(request).actions.addEnvironment(login(request), { repo: body.repo, name: body.name, url: body.url, needsApproval: body.needsApproval, deploy: body.deploy })
  }))
  app.post('/api/environments/look', act(async (request) => {
    mayChangeDelivery(request)
    return sp(request).actions.lookNow(bodyOf(bodies.lookNow, request).repo || undefined)
  }))
  app.put('/api/environments/:id', act(async (request) => {
    mayChangeDelivery(request)
    const body = bodyOf(bodies.changeEnvironment, request)
    return sp(request).actions.changeEnvironment(login(request), environmentOf(request), { name: body.name, url: body.url, needsApproval: body.needsApproval, deploy: body.deploy, order: body.order })
  }))
  app.delete('/api/environments/:id', act(async (request) => {
    mayChangeDelivery(request)
    return sp(request).actions.removeEnvironment(login(request), environmentOf(request))
  }))
  app.post('/api/environments/:id/promote', act(async (request) => sp(request).actions.promote(login(request), environmentOf(request), request.githubToken)))

  // A note's Automerge document as the hub has it now: an editor makes its changes on top of it and sends them in a
  // note.edit, then keeps it in step with the edits' changes from the live feed.
  app.get('/api/notes/:id/doc', async (request, reply) => {
    const { hub } = sp(request)
    const doc = hub.noteDoc(param(request, 'id'))
    if (!doc) return reply.code(404).send({ error: 'No such note' })
    return reply.type('application/octet-stream').header('x-binders-version', String(hub.version)).send(Buffer.from(save(doc)))
  })
  app.get('/api/notes/:id/history', async (request, reply) => {
    const { notes } = sp(request)
    if (!notes) return reply.code(404).send({ error: 'Notes aren’t kept in Git on this hub' })
    return { commits: await notes.history(param(request, 'id')) }
  })
  app.get('/api/notes/:id/at/:sha', async (request, reply) => {
    const { notes } = sp(request)
    if (!notes) return reply.code(404).send({ error: 'Notes aren’t kept in Git on this hub' })
    const markdown = await notes.at(param(request, 'id'), param(request, 'sha')).catch(() => undefined)
    return markdown === undefined ? reply.code(404).send({ error: 'No such version' }) : reply.type('text/markdown; charset=utf-8').send(markdown)
  })

  const manager = (request: FastifyRequest) => spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))
  const nameOf = (request: FastifyRequest, id: string) => sp(request).hub.state.agents.find((a) => a.id === id)?.name ?? `@${id}`
  // Whether this person may change this note, and decide what's proposed for it.
  app.get('/api/notes/:id/access', act(async (request) => {
    const note = sp(request).hub.state.notes.find((n) => n.id === param(request, 'id'))
    if (!note) throw new Refused('No such note.')
    return { mayChange: !lockStops(note, { login: login(request), manager: manager(request) }) }
  }))
  app.post('/api/notes/:id/lock', act(async (request) => {
    const { hub, notes } = sp(request)
    const locked = (request.body as { locked?: unknown } | undefined)?.locked === true
    const id = param(request, 'id')
    await setLock(hub, login(request), manager(request), id, locked)
    await notes?.version(id, `${locked ? 'Locked' : 'Unlocked'} by @${login(request)}`)
    return { ok: true }
  }))
  app.post('/api/notes/:id/proposals', act(async (request) => {
    const body = (request.body ?? {}) as { text?: unknown; why?: unknown }
    if (typeof body.text !== 'string' || typeof body.why !== 'string') throw new Refused('A proposal needs its words and why.')
    return propose(sp(request).hub, { kind: 'user', login: login(request) }, login(request), param(request, 'id'), body.text, body.why)
  }))
  app.post('/api/note-proposals/:id/comments', act(async (request) => {
    const text = (request.body as { text?: unknown } | undefined)?.text
    if (typeof text !== 'string') throw new Refused('Say something.')
    await commentOn(sp(request).hub, { kind: 'user', login: login(request) }, login(request), param(request, 'id'), text)
    return { ok: true }
  }))
  app.post('/api/note-proposals/:id/decide', act(async (request) => {
    const { hub, notes } = sp(request)
    const accept = (request.body as { accept?: unknown } | undefined)?.accept === true
    const { proposal, accepted } = await decide(hub, login(request), manager(request), param(request, 'id'), accept)
    if (accepted) await notes?.version(proposal.noteId, `Accepted from ${nameOf(request, proposal.by)}, by @${login(request)}: ${proposal.why.split('\n')[0].slice(0, 120)}`)
    return { ok: true }
  }))
  // Back to a version: a change like any other, so a lock stops it for whoever it stops, and the version it replaces stays.
  app.post('/api/notes/:id/restore', act(async (request) => {
    const { hub, notes } = sp(request)
    if (!notes) throw new Refused('This hub keeps no versions.')
    const sha = (request.body as { sha?: unknown } | undefined)?.sha
    if (typeof sha !== 'string') throw new Refused('Which version?')
    const id = param(request, 'id')
    const file = await notes.at(id, sha).catch(() => undefined)
    if (file === undefined) throw new Refused('No such version.')
    const text = fromMarkdown(file)
    await hub.record({ kind: 'user', login: login(request) }, { type: 'note.edit', id, text, title: titleOf(text), by: login(request), at: new Date().toISOString() })
    await notes.version(id, `Restored ${sha.slice(0, 7)} by @${login(request)}`)
    return { ok: true }
  }))

  // Sending a note to another of the person's Binders ---------------------------------------------------------------------
  // A note moves only inside its Binder, so making what a phone heard the team's work is a copy: the words, the pictures
  // in them, and a line each way saying where it came from and where it went. Only Binders they're a member of count.
  app.get('/api/notes/send-to', act(async (request) => {
    const here = sp(request).id
    // Not one they can only read: a note sent there would be a note written there.
    const own = spaces.forPerson(login(request), false).filter(({ info, role }) => info.id !== here && role !== 'reader' && spaces.get(info.id))
    return { binders: own.map(({ info }) => ({ id: info.id, name: info.name, personal: !!info.personal })).sort((a, b) => Number(b.personal) - Number(a.personal)) }
  }))
  app.post('/api/notes/:id/send', act(async (request) => {
    const me = login(request)
    const body = (request.body ?? {}) as { binder?: unknown }
    if (typeof body.binder !== 'string' || !body.binder) throw new Refused('Say which Binder to send it to.')
    const mine = spaces.forPerson(me, false)
    const from = sp(request)
    if (!mine.some((s) => s.info.id === from.id)) throw new Refused('You’re not in the Binder this note is in, so you can’t send it from there.')
    const chosen = mine.find((s) => s.info.id === body.binder)
    const target = chosen?.info
    if (!target) throw new Refused('You’re not in that Binder.')
    if (chosen.role === 'reader') throw new Refused(readerWords)
    if (target.id === from.id) throw new Refused('That note is in that Binder already.')
    const to = spaces.get(target.id)
    if (!to) throw new Refused('That Binder isn’t available just now. Try again in a moment.')
    const note = from.hub.state.notes.find((n) => n.id === param(request, 'id'))
    if (!note) throw new Refused('That note isn’t there any more.')
    const part = to.hub.state.binders[0]
    if (!part) throw new Refused('That Binder has no place for notes yet.')
    // At the top of its notes, or in the folder it keeps captures in, when it has one: no folder is made for this.
    const folder = to.hub.state.folders.find((f) => f.binderId === part.id && !f.parentId && f.name.toLowerCase() === captureFolders.conversation.toLowerCase())
    const at = new Date().toISOString()
    const fromUrl = webUrl(from.id, 'note', note.id)
    const copy: Note = {
      id: `note-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`, title: note.title, binderId: part.id, ...(folder ? { folderId: folder.id } : {}),
      editedAt: at, editedBy: me, editors: [me], text: '',
      // What was heard in a room is still read by a person before work comes of it, wherever it's kept.
      ...(note.captured ? { captured: note.captured } : {}),
    }
    copy.text = copyWords(note, `Sent from [${asLinkText(note.title || titleOf(note.text))}](${fromUrl}) in ${asWords(spaceName(spaces.info(from.id)))} by @${me} on ${when(at)}.`)
    // Sending it twice makes a second copy, and says so.
    const again = to.hub.state.notes.some((n) => n.text.split('\n').some((line) => line.startsWith('_Sent from ') && line.includes(`](${fromUrl})`)))
    await copyPictures(note.text, from, to, part, mine.map((s) => spaces.get(s.info.id)).filter((s): s is Space => !!s))
    await to.hub.record({ kind: 'user', login: me }, { type: 'note.put', note: copy })
    // The original keeps where it went, unless it's locked against this person: then it's left exactly as it is.
    const marked = !lockStops(note, { login: me, manager: manager(request) })
    if (marked) {
      const there = webUrl(to.id, 'note', copy.id)
      const text = `${note.text.replace(/\n+$/, '')}\n\n_Sent to ${asWords(spaceName(target))} on ${when(at)}: [${asLinkText(copy.title || titleOf(copy.text))}](${there})._\n`
      await from.hub.record({ kind: 'user', login: me }, { type: 'note.edit', id: note.id, text, title: note.title, by: me, at })
    }
    return { id: copy.id, binder: target.id, binderName: spaceName(target), again, ...(folder ? { folder: folder.name } : {}), marked, url: webUrl(to.id, 'note', copy.id) }
  }))
  // Sums up any note, with the hub's model: the summary is put in beside its words, as the hub's.
  app.post('/api/notes/:id/sum-up', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, act(async (request) => {
    const { brain } = sp(request)
    if (!brain) throw new Refused('This Binder doesn’t sum notes up.')
    await brain.sumUp(param(request, 'id'), { login: login(request), manager: manager(request) })
    return { ok: true }
  }))

  // Each binder's cards as issues: how many are on GitHub, and what last went wrong.
  app.get('/api/issues', async (request) => {
    const { hub, issues, notes } = sp(request)
    return {
      binders: Object.fromEntries(hub.state.binders.map((b) => [b.id, {
        on: !!b.repo && b.issues !== false,
        kept: hub.state.cards.filter((c) => c.binderId === b.id && c.issue).length,
        waiting: hub.state.cards.filter((c) => c.binderId === b.id && !c.issue && c.stage !== 'proposed').length,
        problem: issues?.problems.get(b.id),
        notes: notes?.pushed[b.id],
      }])),
    }
  })
  // Save all: the notes still waiting for typing to pause are committed now, and each binder's pushed to its repo.
  app.post('/api/notes/save', act(async (request) => {
    const { hub, notes } = sp(request)
    if (!notes) throw new Refusal('This hub keeps no notes in Git.')
    const { committed } = await notes.saveAll()
    return { committed, binders: hub.state.binders.map((b) => ({ id: b.id, name: b.name, repo: b.repo, push: notes.pushed[b.id] })) }
  }))
  app.post('/api/binders/:id/sync-issues', act(async (request) => {
    const { issues, notes } = sp(request)
    issues?.syncBinder(param(request, 'id'))
    await notes?.push()
    return { ok: true }
  }))
}

/** A Binder's name as people read it: a personal one is just "Personal". */
const spaceName = (info?: { name: string; personal?: string }) => (info?.personal ? 'Personal' : info?.name ?? 'a Binder')

/** Words in the line a note carries, as they read: nothing in them is taken for Markdown. */
const asWords = (words: string) => words.replace(/([\\_*`[\]<>])/g, '\\$1')
const asLinkText = asWords

/** A time as the quiet lines in a note give it. */
const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** A note's words for its copy: its title, the line saying where it came from, then the rest as it was. */
function copyWords(note: Note, line: string) {
  const first = note.text.split('\n', 1)[0]
  const heading = /^#\s/.test(first)
  const rest = (heading ? note.text.slice(first.length) : note.text).replace(/^\n+/, '')
  return `${heading ? first : `# ${note.title || titleOf(note.text)}`}\n\n_${line}_\n\n${rest}`.replace(/\n+$/, '') + '\n'
}

/**
 * The pictures a note shows, put in the notes of the Binder it's sent to: they're kept by their contents' hash in the
 * Binder they were put in, and only the people of a Binder find them there. One that can't be found is left out.
 */
async function copyPictures(text: string, from: Space, to: Space, part: Binder, theirs: Space[]) {
  const names = [...new Set([...text.matchAll(/\/api\/files\/([a-f0-9]{24}\.[a-z0-9]+)/g)].map((m) => m[1]))]
  if (!names.length || !to.filesDir) return
  const dirsOf = async (space: Space) => {
    if (!space.filesDir) return []
    const top = join(space.filesDir, '..')
    return [space.filesDir, ...(await readdir(top, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(top, d.name, 'files'))]
  }
  const searched = (await Promise.all([from, ...theirs.filter((s) => s !== from)].map(dirsOf))).flat()
  const into = join(to.filesDir, '..', slug(part.name), 'files')
  await mkdir(into, { recursive: true })
  for (const name of names) {
    for (const dir of searched) {
      const file = await readFile(join(dir, name)).catch(() => undefined)
      if (!file) continue
      await writeFile(join(into, name), file)
      break
    }
  }
}
