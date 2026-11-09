import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { linkedNotes, titleOf, isBlank } from '../../shared/notes.ts'
import { binderContext, howBindersWorks } from '../../shared/guide.ts'
import { commentOn, propose } from './noteChanges.ts'
import { briefText, docsFolderName, docsGiven, repoDocs } from '../../shared/briefs.ts'
import { byWorst, challengeSet, doneWhenPoints, numberedDiff, setOfCard } from '../../shared/changeSet.ts'
import { agentNamed, binderRepos, briefId, briefOf, goesBy, type Card, type FileDiff } from '../../shared/work.ts'
import type { Actions } from './actions.ts'
import { Refused, type Hub } from './hub.ts'
import { Refusal } from './auth.ts'
import { ask, askText, type SpaceBrain } from './brain/brain.ts'
import type { BrainSettingsStore } from './brain/settings.ts'

// The hub's MCP server for a person's own terminal, not an agent's: signed in through OAuth, it reads and writes the
// binders they're in as them. There is no work to take and hand back here: a person makes cards, comments, reads
// change sets, debriefs and Challenges, and edits notes. Every change is theirs, in the log.
//
// One connection reaches the Binders its person allowed when they connected it, each kept apart: every call works in
// one of them, found by the binder it names or by where the card, note or change set it names is, and nothing moves or
// points from one to another. An id or a name found in more than one is refused until the call says which.

/** A Binder the connection reaches: its address and name, the person's role there, and its log and actions. */
export interface PersonPlace {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
  hub: Hub
  actions: Actions
  /** Its brain, to answer questions from and to put captures in. */
  brain?: SpaceBrain
}

/** The hub's brain, as the server reaches it: its models, and where notes and cards are on the web. */
export interface PersonBrain {
  settings: BrainSettingsStore
  url: (space: string, kind: 'note' | 'card', id: string) => string
}

export interface PersonSession {
  login: string
  name: string
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })

const instructions = `Binders is where this team's work lives: notes in binders, and cards on each binder's board that come
from them. You are connected as a person, not an agent: what you do here is theirs, in the log, and the board is theirs
to see and move.

How to work:
1. list_binders, list_notes, list_tasks and get_task show what's here. get_note reads a note in full.
2. create_note, append_to_note, edit_note, create_folder and move_note write notes, as the person would in the editor.
3. create_task puts a card on a binder's board (ready for an agent); comment_task says something on a card; assign_task
   gives a ready card to an agent by name; stop_task ends the work on a card and keeps it from being picked up.
4. get_change_set, get_debrief, get_challenge_set and get_challenge show what a card's work proposes, how it was
   explained, and what a second agent found wrong with it.
5. propose_work_items is Distill: it reads a note and proposes cards, which the person accepts on the board.
6. ask answers a question from the binders' notes and cards, citing them. capture puts a dictation, a conversation or a
   meeting's transcript in a binder as a note, summed up when the hub has a model; its folder's rules then apply.

Connected to several binders: list_binders gives each one's id. A tool that works in a binder takes it as binder; one
given a card's, note's or change set's id finds it where it is, and takes binder too when that id is in more than one.
Each binder is kept apart: a note moves, a card waits and an agent takes work only within its own.

There is no wait_for_work, claim_task or complete_task here: those are an agent's, and its runner does them.`

const stageFor = (stage: Card['stage']) => (stage === 'live' ? 'done' : stage)

/** A change set's file as plain diff lines, for reading. */
const plain = (file: FileDiff) => file.lines.map((line) => (line.kind === '@' ? `@@ ${line.text}` : `${line.kind}${line.text}`)).join('\n')
const partSize = 40_000
const partsOf = (diff: string) => Math.max(1, Math.ceil(diff.length / partSize))

/** One file of a change set, or one part of it, by the path its outline names. */
function oneFile<F extends { path: string; added: number; removed: number }>(files: F[], path: string, part: number | undefined, diffOf: (f: F) => string) {
  const wanted = path.trim().replace(/^[ab]\//, '')
  const found = files.find((f) => f.path === path.trim()) ?? files.find((f) => f.path === wanted) ?? files.find((f) => f.path.endsWith(`: ${wanted}`))
  if (!found) throw new Refused(`No file ${path} in it. Its files: ${files.map((f) => f.path).slice(0, 60).join(', ')}.`)
  const diff = diffOf(found)
  const parts = partsOf(diff)
  const n = Math.min(Math.max(1, part ?? 1), parts)
  return { path: found.path, added: found.added, removed: found.removed, part: n, parts, diff: diff.slice((n - 1) * partSize, n * partSize), ...(n < parts ? { next: `part ${n + 1} of ${parts}` } : {}) }
}

export function personServer(places: PersonPlace[], session: PersonSession, brain?: PersonBrain) {
  const server = new McpServer({ name: 'binders', version: '0.1.0' }, { instructions })
  const login = session.login
  const actor = { kind: 'user' as const, login }
  const several = places.length > 1

  // Binders by the id this connection shows: as its log has it when it reaches one Binder (as before it reached more);
  // else the Binder's address, and its log's id after a slash for a Binder of several binders.
  type Spot = { place: PersonPlace; binder: { id: string; name: string; repo?: string; repos?: string[] } }
  const idOf = (place: PersonPlace, binderId: string) => (!several ? binderId : place.hub.state.binders.length === 1 ? place.id : `${place.id}/${binderId}`)
  const spots = (): Spot[] => places.flatMap((place) => place.hub.state.binders.map((binder) => ({ place, binder })))
  const findBinder = (ref: string) => {
    const wanted = ref.trim().toLowerCase()
    const hits = spots().filter(({ place, binder }) => [idOf(place, binder.id), `${place.id}/${binder.id}`, binder.name, ...(several ? [] : [binder.id]), ...(place.hub.state.binders.length === 1 ? [place.id, place.name] : [])].some((name) => name.toLowerCase() === wanted))
    if (hits.length > 1) throw new Refused(`${ref} names more than one binder: give its id, one of ${hits.map((h) => idOf(h.place, h.binder.id)).join(', ')}.`)
    return hits[0]
  }
  const binderNamed = (ref: string, verb = 'open') => {
    const found = findBinder(ref)
    if (!found) throw new Refused(`No binder ${ref} you may ${verb}. Yours: ${spots().map((s) => `${idOf(s.place, s.binder.id)} (${s.binder.name})`).join(', ') || 'none'}.`)
    return found
  }
  /** The places to look in: the binder named's, or all of them. */
  const within = (binder?: string) => (binder ? [binderNamed(binder).place] : places)
  /**
   * Where something named by id is: the one place that has it, among those `binder` leaves. Found in more than one, the
   * call says which.
   */
  const locate = <T>(find: (place: PersonPlace) => T | undefined, binder: string | undefined) => {
    const hits = within(binder).flatMap((place) => {
      const item = find(place)
      return item ? [{ place, item }] : []
    })
    if (hits.length > 1) throw new Refused(`That’s in more than one of your binders (${hits.map((h) => h.place.name).join(', ')}): say which with binder.`)
    return hits[0]
  }
  const whichBinder = z.string().optional().describe('the binder it’s in, when you’re connected to several and it’s in more than one')

  const findNote = (place: PersonPlace, ref: string) => place.hub.state.notes.find((n) => n.id === ref) ?? place.hub.state.notes.find((n) => titleOf(n.text).toLowerCase() === ref.trim().toLowerCase())
  const findFolder = (place: PersonPlace, binderId: string, ref: string) => place.hub.state.folders.find((f) => f.binderId === binderId && (f.id === ref || f.name.toLowerCase() === ref.trim().toLowerCase()))
  const nameIn = (place: PersonPlace) => (id?: string) => place.hub.state.agents.find((a) => a.id === id)?.name ?? id ?? 'a person'
  const binderOf = (place: PersonPlace, binderId: string) => {
    const binder = place.hub.state.binders.find((b) => b.id === binderId)
    return { binder: binder?.name, binder_id: idOf(place, binderId) }
  }

  const run = <A>(work: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) => async (args: A) => {
    try {
      return await work(args)
    } catch (error) {
      if (error instanceof Refused || error instanceof Refusal) return failure(error.message)
      throw error
    }
  }

  const summary = (place: PersonPlace, card: Card) => {
    const { hub, actions } = place
    return {
      id: card.id, title: card.title, ...binderOf(place, card.binderId), repo: actions.repoOf(card), stage: stageFor(card.stage), size: card.size,
      holder: hub.state.agents.find((a) => a.id === card.agentId)?.name, holder_id: card.agentId, meant_for: hub.state.agents.find((a) => a.id === card.meantFor)?.name,
      issue: card.issue?.url, waits_for: card.waitsFor, needs_you: card.needsYou,
    }
  }
  const conversationOf = (place: PersonPlace, card: Card) => card.activity.filter((a) => a.kind === 'question' || a.kind === 'answer' || a.kind === 'comment').slice(-200).map((a) => ({ at: a.at, by: place.hub.state.agents.find((x) => x.id === a.by)?.name ?? a.by, from_agent: place.hub.state.agents.some((x) => x.id === a.by), kind: a.kind, text: a.text }))
  const full = (place: PersonPlace, card: Card) => {
    const { hub } = place
    return {
      ...summary(place, card),
      brief: card.brief, done_when: card.doneWhen,
      note: card.noteId ? { id: card.noteId, title: titleOf(hub.state.notes.find((n) => n.id === card.noteId)?.text ?? '') } : undefined,
      quote: card.quote,
      waits_for: card.waitsFor.map((w) => {
        const other = hub.state.cards.find((c) => c.id === w)
        return { id: w, title: other?.title, stage: other ? stageFor(other.stage) : undefined }
      }),
      plan: card.plan,
      pull_request: card.prId,
      debrief: card.debrief ? { state: card.debrief.state, by: hub.state.agents.find((a) => a.id === card.debrief!.agentId)?.name } : undefined,
      challenge: card.challenge ? { state: card.challenge.state, by: hub.state.agents.find((a) => a.id === card.challenge!.agentId)?.name, findings: card.challenge.findings?.length, replies: card.challenge.replies?.state } : undefined,
      conversation: conversationOf(place, card),
    }
  }
  const listed = () => spots().map(({ place, binder }) => ({
    id: idOf(place, binder.id), name: binder.name, ...(several ? { address: place.id } : {}), role: place.role, repo: binder.repo, ...(binder.repos?.length ? { repos: binder.repos } : {}),
    ready: place.hub.state.cards.filter((c) => c.binderId === binder.id && c.stage === 'ready').length,
  }))

  server.registerTool('whoami', { description: 'You, as Binders knows you: your login, and every binder this connection reaches.', inputSchema: {} }, run(async () => {
    const binders = listed().map(({ id, name, role }) => ({ id, name, role }))
    return text({ login, name: session.name, ...(binders.length === 1 ? { binder: { id: binders[0].id, name: binders[0].name } } : {}), binders })
  }))

  server.registerTool('list_binders', { description: 'The binders this connection reaches, each with its id (what other tools take as binder), its GitHub repo and the repos its agents work in, how many cards are ready, and your role in it.', inputSchema: {} }, run(async () => text(listed())))

  // Notes ------------------------------------------------------------------------------------------------------------

  server.registerTool('list_notes', { description: 'Notes in a binder you may open (or all of them): id, title, folder.', inputSchema: { binder: z.string().optional() } }, run(async ({ binder }: { binder?: string }) => {
    const only = binder ? binderNamed(binder) : undefined
    return text((only ? [only.place] : places).flatMap((place) => place.hub.state.notes
      .filter((n) => !only || n.binderId === only.binder.id)
      .map((n) => ({ id: n.id, title: titleOf(n.text), ...binderOf(place, n.binderId), folder: place.hub.state.folders.find((f) => f.id === n.folderId)?.name, edited: n.editedAt }))))
  }))

  const openProposals = (place: PersonPlace, noteId: string) => place.hub.state.noteProposals.filter((p) => p.noteId === noteId && p.state === 'open').map((p) => ({ id: p.id, by: place.hub.state.agents.find((x) => x.id === p.by)?.name ?? p.by, why: p.why, comments: p.comments.length }))

  server.registerTool('get_binder_context', {
    description: 'What to read before working in a binder: how Binders works, the binder’s guide, and where to look. of: a binder, card, change set or note (id or name); left out, the binders you work in.',
    inputSchema: { of: z.string().optional(), binder: whichBinder },
  }, run(async ({ of, binder }: { of?: string; binder?: string }) => {
    // Not about anything in particular, a terminal say: the one binder it works in, or which ones there are to ask about.
    if (!of) {
      const mine = binder ? [binderNamed(binder)] : spots()
      if (mine.length === 1) return text(binderContext(mine[0].place.hub.state, mine[0].binder.id))
      return text(`${howBindersWorks}\n\nYou work in these binders. Before working in one, get_binder_context with its id: ${mine.map((s) => `${idOf(s.place, s.binder.id)} (${s.binder.name})`).join(', ') || 'none yet'}.`)
    }
    const named = findBinder(of)
    if (named && (!binder || named.place === binderNamed(binder).place)) return text(binderContext(named.place.hub.state, named.binder.id))
    const found = locate((place) => {
      const state = place.hub.state
      const card = state.cards.find((c) => c.id === of)
      const set = state.changeSets.find((c) => c.id === of)
      const note = state.notes.find((n) => n.id === of)
      const binderId = card?.binderId ?? set?.binderId ?? note?.binderId
      return binderId ? { binderId, noteId: card?.noteId ?? note?.id } : undefined
    }, binder)
    if (!found) throw new Refused(`Nothing called ${of} you may read.`)
    return text(binderContext(found.place.hub.state, found.item.binderId, found.item.noteId))
  }))

  const noteAt = (id: string, binder: string | undefined, verb: string) => {
    const found = locate((place) => findNote(place, id), binder)
    if (!found) throw new Refused(`No note ${id} you may ${verb}.`)
    return { place: found.place, note: found.item }
  }

  server.registerTool('propose_note_change', {
    description: 'Proposes a change to a locked note, for a person to review, when you can’t edit it yourself: find and replace one exact passage (find must appear once), or text for the whole note. why: what’s wrong or out of date.',
    inputSchema: { id: z.string(), why: z.string(), find: z.string().optional(), replace: z.string().optional(), text: z.string().optional(), binder: whichBinder },
  }, run(async ({ id, why, find, replace, text: whole, binder }: { id: string; why: string; find?: string; replace?: string; text?: string; binder?: string }) => {
    const { place, note } = noteAt(id, binder, 'read')
    let next: string
    if (find !== undefined) {
      const at = note.text.indexOf(find)
      if (at < 0) throw new Refused('That passage isn’t in the note (it may have changed): get_note and try again.')
      if (note.text.indexOf(find, at + 1) >= 0) throw new Refused('That passage is in the note more than once: give more of it.')
      next = note.text.slice(0, at) + (replace ?? '') + note.text.slice(at + find.length)
    } else if (whole !== undefined) next = whole
    else throw new Refused('Give find and replace, or the whole text.')
    const proposal = await propose(place.hub, actor, login, note.id, next, why)
    return text({ id: proposal.id, state: 'open', note: 'A person reviews it. Carry on without it.' })
  }))

  server.registerTool('reply_to_note_proposal', {
    description: 'Says something on a proposed change to a locked note, to talk it over with who’s reviewing it. id: the proposal’s, from get_note’s open_proposals.',
    inputSchema: { id: z.string(), text: z.string(), binder: whichBinder },
  }, run(async ({ id, text: said, binder }: { id: string; text: string; binder?: string }) => {
    const found = locate((place) => place.hub.state.noteProposals.find((p) => p.id === id), binder)
    if (!found) throw new Refused(`No proposal ${id}.`)
    await commentOn(found.place.hub, actor, login, id, said)
    return text('Said.')
  }))

  server.registerTool('get_note', { description: 'A note’s Markdown, by id or title, with the cards that came from it and, in full, the notes it links to. Words a work item quotes come from the note itself.', inputSchema: { id: z.string(), binder: whichBinder } }, run(async ({ id, binder }: { id: string; binder?: string }) => {
    const { place, note } = noteAt(id, binder, 'read')
    const { hub } = place
    const cards = (note.work ?? []).map((w) => hub.state.cards.find((c) => c.id === w.itemId)).filter((c): c is Card => !!c).map((c) => summary(place, c))
    const { linked, left } = linkedNotes(hub.state.notes, note)
    return text({ id: note.id, title: titleOf(note.text), ...(several ? binderOf(place, note.binderId) : {}), text: note.text, cards, ...(linked.length ? { linked: linked.map((n) => ({ id: n.id, title: titleOf(n.text), text: n.text })) } : {}), ...(left.length ? { linked_too_long: left } : {}), ...(note.locked ? { locked: { by: note.locked.by, note: 'Propose changes to this note with propose_note_change.' } } : {}), ...(openProposals(place, note.id).length ? { open_proposals: openProposals(place, note.id) } : {}) })
  }))

  server.registerTool('create_note', { description: 'Makes a note in a binder from Markdown.', inputSchema: { binder: z.string(), text: z.string() } }, run(async ({ binder, text: body }: { binder: string; text: string }) => {
    const { place, binder: target } = binderNamed(binder, 'write in')
    if (isBlank(body)) throw new Refused('The note is empty.')
    const id = `note-${Date.now().toString(36)}`
    await place.hub.record(actor, { type: 'note.put', note: { id, title: titleOf(body), binderId: target.id, editedAt: new Date().toISOString(), editors: [login], text: body } })
    return text({ id, title: titleOf(body) })
  }))

  server.registerTool('append_to_note', { description: 'Adds Markdown at the end of a note.', inputSchema: { id: z.string(), text: z.string(), binder: whichBinder } }, run(async ({ id, text: more, binder }: { id: string; text: string; binder?: string }) => {
    const { place, note } = noteAt(id, binder, 'write in')
    const next = `${note.text.replace(/\s*$/, '')}\n\n${more.trim()}\n`
    await place.hub.record(actor, { type: 'note.edit', id: note.id, text: next, title: titleOf(next), by: login, at: new Date().toISOString() })
    return text('Added.')
  }))

  server.registerTool('edit_note', {
    description: 'Changes a note: find and replace one exact passage (find must appear once), or text to replace the whole note. Prefer find and replace, so someone typing elsewhere in it keeps their words.',
    inputSchema: { id: z.string(), find: z.string().optional(), replace: z.string().optional(), text: z.string().optional(), binder: whichBinder },
  }, run(async ({ id, find, replace, text: whole, binder }: { id: string; find?: string; replace?: string; text?: string; binder?: string }) => {
    const { place, note } = noteAt(id, binder, 'write in')
    let next: string
    if (find !== undefined) {
      const at = note.text.indexOf(find)
      if (at < 0) throw new Refused('That passage isn’t in the note (it may have changed): get_note and try again.')
      if (note.text.indexOf(find, at + 1) >= 0) throw new Refused('That passage is in the note more than once: give more of it.')
      next = note.text.slice(0, at) + (replace ?? '') + note.text.slice(at + find.length)
    } else if (whole !== undefined) {
      next = whole
    } else {
      throw new Refused('Give find and replace, or the whole text.')
    }
    await place.hub.record(actor, { type: 'note.edit', id: note.id, text: next, title: titleOf(next), by: login, at: new Date().toISOString() })
    return text('Changed.')
  }))

  server.registerTool('create_folder', {
    description: 'Makes a folder in a binder, inside another with parent (its name or id). A folder of that name already there is returned instead of a second one.',
    inputSchema: { binder: z.string(), name: z.string(), parent: z.string().optional() },
  }, run(async ({ binder, name, parent }: { binder: string; name: string; parent?: string }) => {
    const { place, binder: target } = binderNamed(binder, 'write in')
    const clean = name.trim()
    if (!clean) throw new Refused('A folder needs a name.')
    const under = parent ? findFolder(place, target.id, parent) : undefined
    if (parent && !under) throw new Refused(`No folder ${parent} in ${target.name}.`)
    const there = place.hub.state.folders.find((f) => f.binderId === target.id && f.parentId === under?.id && f.name.toLowerCase() === clean.toLowerCase())
    if (there) return text({ id: there.id, name: there.name, made: false })
    const id = `folder-${Date.now().toString(36)}`
    await place.hub.record(actor, { type: 'folder.put', folder: { id, binderId: target.id, name: clean, parentId: under?.id } })
    return text({ id, name: clean, made: true })
  }))

  server.registerTool('move_note', {
    description: 'Moves a note (its id or title) into a folder (its name or id), or to the top of its binder with no folder. With binder, into another binder of the same Binder you may write in.',
    inputSchema: { id: z.string(), folder: z.string().optional(), binder: z.string().optional() },
  }, run(async ({ id, folder, binder }: { id: string; folder?: string; binder?: string }) => {
    // Found anywhere; a title in more than one binder, in the binder it's moved within.
    let found
    try {
      found = locate((place) => findNote(place, id), undefined)
    } catch (error) {
      if (!binder || !(error instanceof Refused)) throw error
      found = locate((place) => findNote(place, id), binder)
    }
    if (!found) throw new Refused(`No note ${id} you may write in.`)
    const { place, item: note } = found
    const target = binder ? binderNamed(binder, 'write in') : { place, binder: place.hub.state.binders.find((b) => b.id === note.binderId)! }
    if (!target.binder) throw new Refused(`No binder for ${id}.`)
    if (target.place !== place) throw new Refused(`A note stays in its own Binder (${place.name}): to have it in ${target.place.name}, get_note and create_note there.`)
    const into = folder ? findFolder(place, target.binder.id, folder) : undefined
    if (folder && !into) throw new Refused(`No folder ${folder} in ${target.binder.name}: create_folder makes it.`)
    await place.hub.record(actor, { type: 'note.move', id: note.id, binderId: target.binder.id, folderId: into?.id })
    return text(`Moved “${titleOf(note.text)}” to ${target.binder.name}${into ? ` / ${into.name}` : ''}.`)
  }))

  // Cards ------------------------------------------------------------------------------------------------------------

  const cardAt = (id: string, binder: string | undefined) => {
    const found = locate((place) => place.hub.state.cards.find((c) => c.id === id), binder)
    if (!found) throw new Refused(`No card ${id} you may see.`)
    return { place: found.place, card: found.item }
  }

  server.registerTool('list_tasks', {
    description: 'Cards on the boards you may open. stage: proposed, ready, working, blocked (waiting on a person), review, done.',
    inputSchema: { binder: z.string().optional(), stage: z.enum(['proposed', 'ready', 'working', 'blocked', 'review', 'done']).optional() },
  }, run(async ({ binder, stage }: { binder?: string; stage?: 'proposed' | 'ready' | 'working' | 'blocked' | 'review' | 'done' }) => {
    const only = binder ? binderNamed(binder) : undefined
    const cards = (only ? [only.place] : places).flatMap((place) => place.hub.state.cards
      .filter((c) => (!only || c.binderId === only.binder.id) && (!stage || c.stage === (stage === 'done' ? 'live' : stage)))
      .map((c) => summary(place, c)))
    return text(cards.slice(0, 200))
  }))

  server.registerTool('get_task', { description: 'A card in full: brief, done when, the note’s words it came from, what it waits for, its plan, its pull request, how its debrief and Challenge stand, and the conversation. Given a change set’s id: how its debrief and Challenge stand.', inputSchema: { id: z.string(), binder: whichBinder } }, run(async ({ id, binder }: { id: string; binder?: string }) => {
    const set = locate((place) => place.hub.state.changeSets.find((s) => s.id === id), binder)
    if (set) return text({ id: set.item.id, title: `Change set #${set.item.number}: ${set.item.title}`, stage: 'review', debrief: set.item.debrief ? { state: set.item.debrief.state } : undefined, challenge: set.item.challenge ? { state: set.item.challenge.state } : undefined })
    const { place, card } = cardAt(id, binder)
    return text(full(place, card))
  }))

  server.registerTool('create_task', {
    description: 'Puts a card on a binder’s board, ready for an agent to take (a person’s card, not a suggestion). waits_for: cards it needs first, by id, in the same binder.',
    inputSchema: { binder: z.string(), title: z.string(), brief: z.string().optional(), done_when: z.string().optional(), size: z.enum(['S', 'M', 'L']).optional(), waits_for: z.array(z.string()).optional() },
  }, run(async ({ binder, title, brief, done_when, size, waits_for }: { binder: string; title: string; brief?: string; done_when?: string; size?: Card['size']; waits_for?: string[] }) => {
    const { place, binder: target } = binderNamed(binder, 'write in')
    const elsewhere = (waits_for ?? []).filter((w) => !place.hub.state.cards.some((c) => c.id === w && c.binderId === target.id))
    if (elsewhere.length) throw new Refused(`A card waits only for cards in its own binder: ${elsewhere.join(', ')} ${elsewhere.length === 1 ? 'isn’t' : 'aren’t'} in ${target.name}.`)
    return text(summary(place, await place.actions.createCard(actor, { binderId: target.id, title, brief, doneWhen: done_when, size, waitsFor: waits_for })))
  }))

  server.registerTool('comment_task', { description: 'Leaves a comment on a card, as you.', inputSchema: { id: z.string(), text: z.string(), binder: whichBinder } }, run(async ({ id, text: body, binder }: { id: string; text: string; binder?: string }) => {
    const { place, card } = cardAt(id, binder)
    await place.actions.comment(login, card.id, body)
    return text('Commented.')
  }))

  server.registerTool('list_agents', { description: 'The agents that work in a binder (or each of yours), by name, so you can give one a card.', inputSchema: { binder: z.string().optional() } }, run(async ({ binder }: { binder?: string }) => {
    const mine = binder ? [binderNamed(binder)] : spots()
    return text(mine.flatMap(({ place, binder: b }) => place.hub.state.agents
      .filter((a) => !a.revoked && (!a.binders.length || a.binders.includes(b.id)))
      .map((a) => ({ id: a.id, name: a.name, owner: a.owner, ...(mine.length > 1 ? { binder_id: idOf(place, b.id) } : {}), online: a.lastSeen ? Date.now() - Date.parse(a.lastSeen) < 120_000 : false }))))
  }))

  server.registerTool('assign_task', {
    description: 'Gives a ready or proposed card to an agent of its binder (by name or id), so its runner takes it next, as a person giving it on the board would; or to any agent, with agent "any".',
    inputSchema: { id: z.string(), agent: z.string().describe('the agent’s name or id, or "any"'), binder: whichBinder },
  }, run(async ({ id, agent: ref, binder }: { id: string; agent: string; binder?: string }) => {
    const found = locate((place) => place.hub.state.cards.find((c) => c.id === id || goesBy(c, id)), binder)
    if (!found) throw new Refused(`No card ${id} you may see.`)
    const { place, item: card } = found
    const { hub } = place
    const nameOf = nameIn(place)
    const any = ref.trim().toLowerCase() === 'any'
    const to = any ? undefined : hub.state.agents.find((a) => !a.revoked && a.id === ref) ?? agentNamed(hub.state.agents, ref)
    if (!any && !to) throw new Refused(`No agent ${ref} in ${place.name}. These are: ${hub.state.agents.filter((a) => !a.revoked).map((a) => a.name).join(', ')}.`)
    if (to && to.binders.length && !to.binders.includes(card.binderId)) throw new Refused(`${to.name} doesn’t work in this binder.`)
    if (card.agentId && (card.stage === 'working' || card.stage === 'blocked')) throw new Refused(`${nameOf(card.agentId)} is working on it: stop_task first.`)
    if (card.stage !== 'ready' && card.stage !== 'proposed') throw new Refused(`That card is ${card.stage}: only a ready or proposed card is given to an agent.`)
    const who = to?.name ?? 'any agent'
    await hub.record(actor, { type: 'card.update', id: card.id, fields: { meantFor: to?.id, stage: 'ready', agentId: undefined, needsYou: undefined, doing: undefined, progress: undefined }, activity: { at: new Date().toISOString(), by: login, kind: 'moved', text: to ? `Gave it to ${who}` : 'Opened it to any agent' } })
    return text(`Gave “${card.title}” to ${who}.`)
  }))

  server.registerTool('stop_task', {
    description: 'Stops a card: its agent’s run ends, and the card waits in Proposed, where nothing picks it up, until a person moves it back to Ready. A ready card is held back the same way.',
    inputSchema: { id: z.string(), binder: whichBinder },
  }, run(async ({ id, binder }: { id: string; binder?: string }) => {
    const { place, card } = cardAt(id, binder)
    await place.actions.stopCard(login, card.id)
    return text(`Stopped “${card.title}”. It’s in Proposed.`)
  }))

  // What a card's work proposes, and how it was explained and reviewed ------------------------------------------------

  /** A card or a change set, by id: the place it's in, and which it is. */
  const workAt = (id: string, binder: string | undefined) => {
    const found = locate((place) => {
      const whole = place.hub.state.changeSets.find((s) => s.id === id)
      const card = whole ? undefined : place.hub.state.cards.find((c) => c.id === id)
      return whole || card ? { whole, card } : undefined
    }, binder)
    if (!found) throw new Refused(`No card or change set ${id} you may see.`)
    return { place: found.place, ...found.item }
  }

  server.registerTool('get_change_set', {
    description: 'A card’s Change Set: its pull request’s diff and checks, or before there is one its worktree’s diff; its brief, its done-when as points, the note’s words; the agent’s plan and log; and the debrief on it. Given a change set’s id: all its pull requests together. outline: true gives each file’s size instead of its diff; file then gives one file’s diff.',
    inputSchema: { id: z.string(), outline: z.boolean().optional(), file: z.string().optional().describe('one file’s path, as the outline names it'), part: z.number().int().min(1).optional(), binder: whichBinder },
  }, run(async ({ id, outline, file, part, binder }: { id: string; outline?: boolean; file?: string; part?: number; binder?: string }) => {
    const { place } = workAt(id, binder)
    const { hub, actions } = place
    const nameOf = nameIn(place)
    const set = await actions.changeSet(id)
    if (file) return text(oneFile(set.files, file, part, plain))
    const gap = set.debrief?.outOfDate
    return text({
      ...set,
      card: { ...set.card, stage: stageFor(set.card.stage), agent: set.card.agentId ? nameOf(set.card.agentId) : undefined, agentId: undefined },
      done_when_points: doneWhenPoints(set.doneWhen),
      note: set.note ? { ...set.note, title: titleOf(hub.state.notes.find((n) => n.id === set.note!.id)?.text ?? '') } : undefined,
      debrief: set.debrief
        ? {
            state: set.debrief.state,
            written_at: set.debrief.writtenAt,
            written_at_commit: set.debrief.head,
            out_of_date: gap ? { from: gap.from, to: gap.to, commits: gap.commits ?? [], files: gap.files ?? [] } : undefined,
          }
        : undefined,
      files: set.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, ...(outline ? { parts: partsOf(plain(f)) } : { diff: plain(f) }) })),
      ...(outline ? { read_each: 'get_change_set with file (and part, for a file in parts) gives each file’s diff.' } : {}),
      log: set.log.slice(-200).map((a) => ({ at: a.at, by: nameOf(a.by), kind: a.kind, ...(a.tool ? { tool: a.tool } : {}), text: a.text, ...(a.result ? { result: a.result } : {}) })),
    })
  }))

  server.registerTool('get_debrief', {
    description: 'A card’s debrief, as kept: its five sections, who wrote it and when, where it is on GitHub, and speech: the debrief as plain sentences to say aloud.',
    inputSchema: { id: z.string(), binder: whichBinder },
  }, run(async ({ id, binder }: { id: string; binder?: string }) => {
    const { place, card } = cardAt(id, binder)
    const debrief = card.debrief ?? (setOfCard(place.hub.state, card)?.debrief)
    if (!debrief) return text(`Card ${id} has no debrief: a person asks for one with Debrief on the card.`)
    return text({
      card: { id: card.id, title: card.title, stage: stageFor(card.stage) },
      state: debrief.state,
      by: nameIn(place)(debrief.agentId),
      asked_by: debrief.askedBy,
      written_at: debrief.writtenAt,
      doing: debrief.doing,
      failed: debrief.failed,
      does: debrief.does,
      changes: debrief.changes,
      against: debrief.against,
      look_at: debrief.lookAt,
      try_it: debrief.tryIt,
      test_plan: debrief.testPlan,
      on_github: debrief.comment?.url,
      speech: place.actions.debriefOf(card.id).speech,
    })
  }))

  server.registerTool('get_challenge_set', {
    description: 'A card’s or change set’s Challenge set: its diff (each line numbered as in the file), the pull request and its checks, the brief, its done-when points and the note’s words, and the blast radius when its runner worked one out. Not the author’s plan or log.',
    inputSchema: { id: z.string(), outline: z.boolean().optional().describe('true: each file’s size instead of its diff'), file: z.string().optional(), part: z.number().int().min(1).optional(), binder: whichBinder },
  }, run(async ({ id, outline, file, part, binder }: { id: string; outline?: boolean; file?: string; part?: number; binder?: string }) => {
    const { place, whole, card } = workAt(id, binder)
    const { hub, actions } = place
    const set = challengeSet(await actions.changeSet(id))
    const challenge = whole?.challenge ?? card?.challenge ?? (card ? setOfCard(hub.state, card)?.challenge : undefined)
    const blast = challenge?.blast
    if (file) return text(oneFile(set.files, file, part, (f) => numberedDiff(f)))
    const files = set.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, diff: numberedDiff(f) }))
    const size = files.reduce((n, f) => n + f.diff.length, 0)
    const tooBig = size > 250_000
    if (outline && !tooBig) {
      return text({
        ...set, blast_radius: blast, card: { ...set.card, stage: stageFor(set.card.stage) }, done_when_points: doneWhenPoints(set.doneWhen),
        note: set.note ? { ...set.note, title: titleOf(hub.state.notes.find((n) => n.id === set.note!.id)?.text ?? '') } : undefined,
        files: files.map(({ diff, ...f }) => ({ ...f, parts: partsOf(diff) })),
        read_each: 'get_challenge_set with file (and part, for a file in parts) gives each file’s numbered diff.',
      })
    }
    return text({
      ...set, blast_radius: blast, card: { ...set.card, stage: stageFor(set.card.stage) }, done_when_points: doneWhenPoints(set.doneWhen),
      note: set.note ? { ...set.note, title: titleOf(hub.state.notes.find((n) => n.id === set.note!.id)?.text ?? '') } : undefined,
      ...(tooBig ? { too_big_to_send: `Its diff is too big to send at once (${files.length} files). Read it in your folder, one pull request at a time, or ask for file and part.`, files: files.map(({ diff: _diff, ...f }) => f) } : { files }),
    })
  }))

  server.registerTool('get_challenge', {
    description: 'A card’s Challenge, as kept: who reviewed it, its summary, and its findings worst first, each with its id, file and line, what goes wrong, confidence, severity, and the author’s reply once it has answered.',
    inputSchema: { id: z.string(), binder: whichBinder },
  }, run(async ({ id, binder }: { id: string; binder?: string }) => {
    const { place, card } = cardAt(id, binder)
    const nameOf = nameIn(place)
    const challenge = card.challenge ?? setOfCard(place.hub.state, card)?.challenge
    if (!challenge) return text(`Card ${id} has no Challenge: a person asks for one with Challenge on the card.`)
    return text({
      card: { id: card.id, title: card.title, stage: stageFor(card.stage) },
      state: challenge.state,
      by: nameOf(challenge.agentId),
      asked_by: challenge.askedBy,
      reviewed_at: challenge.reviewedAt,
      doing: challenge.doing,
      failed: challenge.failed,
      summary: challenge.summary,
      findings: challenge.findings ? [...challenge.findings].sort(byWorst).map((f) => f.reply ? { ...f, reply: { ...f.reply, by: nameOf(f.reply!.by) } } : f) : undefined,
      replies: challenge.replies ? { state: challenge.replies.state, by: nameOf(challenge.replies.agentId), asked_by: challenge.replies.askedBy, replied_at: challenge.replies.repliedAt, failed: challenge.replies.failed } : undefined,
    })
  }))

  // Distill and repo briefs ------------------------------------------------------------------------------------------

  server.registerTool('propose_work_items', {
    description: 'Distill: proposes work items read from a note. Each needs the note’s exact words it came from (quote). They wait on the board until the person accepts them. meant_for: an agent’s name, of the note’s binder.',
    inputSchema: {
      note: z.string(),
      items: z.array(z.object({ title: z.string(), quote: z.string(), brief: z.string().optional(), done_when: z.string().optional(), size: z.enum(['S', 'M', 'L']).optional(), meant_for: z.string().optional() })).min(1).max(60),
      binder: whichBinder,
    },
  }, run(async ({ note: ref, items, binder }: { note: string; items: { title: string; quote: string; brief?: string; done_when?: string; size?: Card['size']; meant_for?: string }[]; binder?: string }) => {
    const { place, note } = noteAt(ref, binder, 'read')
    const { hub } = place
    const taken = new Set([...hub.state.proposals.filter((p) => p.noteId === note.id && p.state !== 'dismissed').map((p) => p.quote), ...(note.work ?? []).map((w) => w.quote)])
    const added: string[] = []
    const skipped: string[] = []
    for (const [index, item] of items.entries()) {
      if (!note.text.includes(item.quote)) {
        skipped.push(`${item.title}: its quote isn’t in the note word for word`)
        continue
      }
      if (taken.has(item.quote)) {
        skipped.push(`${item.title}: already proposed or on the board`)
        continue
      }
      const meant = item.meant_for ? agentNamed(hub.state.agents, item.meant_for)?.id : undefined
      const id = `prop-${Date.now().toString(36)}-${index}`
      await hub.record(actor, { type: 'proposal.put', proposal: { id, binderId: note.binderId, noteId: note.id, title: item.title.slice(0, 200), quote: item.quote, brief: item.brief ?? '', doneWhen: item.done_when ?? '', size: item.size ?? 'M', meantFor: meant, by: login, state: 'new' } })
      taken.add(item.quote)
      added.push(id)
    }
    return text({ proposed: added.length, skipped })
  }))

  const mayReadRepo = (place: PersonPlace, repo: string) => {
    const wanted = briefId(repo)
    const { hub } = place
    return hub.state.binders.some((b) =>
      binderRepos(b).some((r) => briefId(r) === wanted) ||
      hub.state.agents.some((a) => !a.revoked && (a.binders.length === 0 || a.binders.includes(b.id)) && a.repos.some((r) => briefId(r) === wanted)),
    )
  }
  /** The one place whose binders hold a repo, among those `binder` leaves. */
  const repoAt = (repo: string, binder: string | undefined) => {
    const found = locate((place) => (mayReadRepo(place, repo) ? place : undefined), binder)
    if (!found) throw new Refused(`${repo} isn’t a repo in a binder you may open.`)
    return found.place
  }
  const briefView = (place: PersonPlace, repo: string) => {
    const { hub } = place
    const brief = briefOf(hub.state, repo)
    const name = nameIn(place)
    const ask = brief?.ask ? { state: brief.ask.state, by: name(brief.ask.agentId), refresh: brief.ask.refresh, doing: brief.ask.doing, failed: brief.ask.failed } : undefined
    const lessons = brief?.lessons?.map((l) => ({ at: l.at, by: name(l.by), text: l.text }))
    const { given, left } = docsGiven(repoDocs(hub.state, repo, brief), (n) => titleOf(n.text))
    const docs = given.length ? { folder: `${docsFolderName} / ${brief?.repo ?? repo}`, notes: given, ...(left ? { more: `${left} more: get_note reads any by id` } : {}) } : undefined
    const written = briefText(hub.state, brief)
    if (!written) return { repo: brief?.repo ?? repo, none: 'No brief yet.', lessons, docs, ask }
    return { repo: brief!.repo, text: written, note: brief!.noteId, written_from: brief!.sha, written_at: brief!.writtenAt, written_by: name(brief!.writtenBy), lessons, docs, ask }
  }

  server.registerTool('get_repo_brief', {
    description: 'A repo’s brief: what agents are told about it before they work or review there, the commit it was written from, lessons agents added since, and the team’s other notes for the repo.',
    inputSchema: { repo: z.string().describe('owner/name'), binder: whichBinder },
  }, run(async ({ repo, binder }: { repo: string; binder?: string }) => text(briefView(repoAt(repo, binder), repo))))

  server.registerTool('add_repo_lesson', {
    description: 'Something you learned about a repo that the next agent there should know, in one line: a command that fails and what works, a rule the code keeps that isn’t written down, a trap. Never a secret.',
    inputSchema: { repo: z.string(), text: z.string(), binder: whichBinder },
  }, run(async ({ repo, text: lesson, binder }: { repo: string; text: string; binder?: string }) => {
    const place = repoAt(repo, binder)
    const brief = await place.actions.addLesson(actor, repo, lesson)
    return text({ repo: brief.repo, lessons: brief.lessons?.length ?? 0 })
  }))


  // The brain ----------------------------------------------------------------------------------------------------------

  /** The notes and cards of one binder in a place, read once for a question. */
  const keepIn = (place: PersonPlace, binderId: string) => {
    const ids = new Set([...place.hub.state.notes.filter((n) => n.binderId === binderId).map((n) => `note:${n.id}`), ...place.hub.state.cards.filter((c) => c.binderId === binderId).map((c) => `card:${c.id}`)])
    return (kind: 'note' | 'card', id: string) => ids.has(`${kind}:${id}`)
  }

  if (brain) {
    server.registerTool('ask', {
      description: 'Answers a question from the notes and cards in your binders (or the one named), citing them, and how the work stands now: what agents are on, what’s waiting on you. The answer, then the notes and cards it rests on, with their ids for get_note and get_task. Without a model on the hub, the passages that match best.',
      inputSchema: { question: z.string().max(2000), binder: z.string().optional() },
    }, run(async ({ question, binder }: { question: string; binder?: string }) => {
      const only = binder ? binderNamed(binder) : undefined
      const asking = (only ? [only.place] : places).flatMap((place) => (place.brain ? [{
        id: place.id,
        name: only ? only.binder.name : place.name,
        brain: place.brain,
        url: (kind: 'note' | 'card', id: string) => brain.url(place.id, kind, id),
        ...(only ? { keep: keepIn(place, only.binder.id) } : {}),
        work: { id: place.id, name: only ? only.binder.name : place.name, hub: place.hub, actions: place.actions, ...(only ? { binders: [only.binder.id] } : {}) },
      }] : []))
      if (!asking.length) throw new Refused('These binders have no brain to ask.')
      return text(askText(await ask(brain.settings, asking, question, { person: login })))
    }))

    server.registerTool('capture', {
      description: 'Puts something captured in a binder as a note: a dictation (your own words), a conversation, or a meeting’s transcript. It goes in the folder for its kind (Dictations, Captures, Meetings) unless one is named, and a conversation or meeting is summed up at the top when the hub has a model. The folder’s rules then apply, such as Distill.',
      inputSchema: { binder: z.string(), kind: z.enum(['dictation', 'conversation', 'meeting']), text: z.string().max(400_000), title: z.string().max(300).optional(), folder: z.string().max(120).optional() },
    }, run(async ({ binder, kind, text: words, title, folder }: { binder: string; kind: 'dictation' | 'conversation' | 'meeting'; text: string; title?: string; folder?: string }) => {
      const spot = binderNamed(binder, 'write in')
      if (!spot.place.brain) throw new Refused('That binder doesn’t take captures.')
      if (!words.trim()) throw new Refused('A capture needs its words.')
      const made = await spot.place.brain.capture(login, { kind, text: words, title }, { binderId: spot.binder.id, folder })
      return text({ note: made.note.id, title: made.note.title, binder: idOf(spot.place, spot.binder.id), summarizing: made.summarizing, url: brain.url(spot.place.id, 'note', made.note.id) })
    }))
  }

  return server
}
