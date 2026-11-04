import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { linkedNotes, titleOf, isBlank } from '../../shared/notes.ts'
import { binderContext, howBindersWorks } from '../../shared/guide.ts'
import { commentOn, propose } from './noteChanges.ts'
import { briefText, docsFolderName, docsGiven, repoDocs } from '../../shared/briefs.ts'
import { byWorst, challengeSet, doneWhenPoints, numberedDiff, setOfCard } from '../../shared/changeSet.ts'
import { agentNamed, briefId, briefOf, goesBy, type Card, type FileDiff } from '../../shared/work.ts'
import type { Actions } from './actions.ts'
import { Refused, type Hub } from './hub.ts'
import { Refusal } from './auth.ts'

// The hub's MCP server for a person's own terminal, not an agent's: signed in through OAuth, it reads and writes the
// binders they're in as them. There is no work to take and hand back here: a person makes cards, comments, reads
// change sets, debriefs and Challenges, and edits notes. Every change is theirs, in the log.

export interface PersonSession {
  /** The binder the connection is for: the one its MCP address named. */
  binder: { id: string; name: string }
  /** The binders this person may open, with their role in each. */
  binders: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[]
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
   gives a ready card to an agent by name.
4. get_change_set, get_debrief, get_challenge_set and get_challenge show what a card's work proposes, how it was
   explained, and what a second agent found wrong with it.
5. propose_work_items is Distill: it reads a note and proposes cards, which the person accepts on the board.

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

export function personServer(hub: Hub, actions: Actions, session: PersonSession) {
  const server = new McpServer({ name: 'binders', version: '0.1.0' }, { instructions })
  const login = session.login
  const actor = { kind: 'user' as const, login }
  const allowed = new Set(session.binders.map((b) => b.id))
  const mayUse = (binderId: string) => allowed.has(binderId)
  const findBinder = (ref: string) => hub.state.binders.find((b) => allowed.has(b.id) && (b.id === ref || b.name.toLowerCase() === ref.trim().toLowerCase()))
  const findNote = (ref: string) => hub.state.notes.find((n) => n.id === ref) ?? hub.state.notes.find((n) => titleOf(n.text).toLowerCase() === ref.trim().toLowerCase())
  const findFolder = (binderId: string, ref: string) => hub.state.folders.find((f) => f.binderId === binderId && (f.id === ref || f.name.toLowerCase() === ref.trim().toLowerCase()))
  const nameOf = (id?: string) => hub.state.agents.find((a) => a.id === id)?.name ?? id ?? 'a person'

  const run = <A>(work: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) => async (args: A) => {
    try {
      return await work(args)
    } catch (error) {
      if (error instanceof Refused || error instanceof Refusal) return failure(error.message)
      throw error
    }
  }

  const summary = (card: Card) => ({
    id: card.id, title: card.title, binder: hub.state.binders.find((b) => b.id === card.binderId)?.name, repo: actions.repoOf(card), stage: stageFor(card.stage), size: card.size,
    holder: hub.state.agents.find((a) => a.id === card.agentId)?.name, holder_id: card.agentId, meant_for: hub.state.agents.find((a) => a.id === card.meantFor)?.name,
    issue: card.issue?.url, waits_for: card.waitsFor, needs_you: card.needsYou,
  })
  const conversationOf = (card: Card) => card.activity.filter((a) => a.kind === 'question' || a.kind === 'answer' || a.kind === 'comment').slice(-200).map((a) => ({ at: a.at, by: hub.state.agents.find((x) => x.id === a.by)?.name ?? a.by, from_agent: hub.state.agents.some((x) => x.id === a.by), kind: a.kind, text: a.text }))
  const full = (card: Card) => ({
    ...summary(card),
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
    conversation: conversationOf(card),
  })

  server.registerTool('whoami', { description: 'You, as Binders knows you: your login, the binder this connection is for, and every binder you may open.', inputSchema: {} }, run(async () =>
    text({ login, name: session.name, binder: session.binder, binders: session.binders })))

  server.registerTool('list_binders', { description: 'The binder this connection is for, with its GitHub repo, how many cards are ready, and your role in it.', inputSchema: {} }, run(async () =>
    text(session.binders.map((b) => {
      const binder = hub.state.binders.find((x) => x.id === b.id)
      return { id: b.id, name: b.name, role: b.role, repo: binder?.repo, ready: hub.state.cards.filter((c) => c.binderId === b.id && c.stage === 'ready').length }
    }))))

  // Notes ------------------------------------------------------------------------------------------------------------

  server.registerTool('list_notes', { description: 'Notes in a binder you may open (or all of them): id, title, folder.', inputSchema: { binder: z.string().optional() } }, run(async ({ binder }: { binder?: string }) => {
    const only = binder ? findBinder(binder) : undefined
    if (binder && !only) throw new Refused(`No binder ${binder} you may open.`)
    return text(hub.state.notes.filter((n) => mayUse(n.binderId) && (!only || n.binderId === only.id)).map((n) => ({ id: n.id, title: titleOf(n.text), binder: hub.state.binders.find((b) => b.id === n.binderId)?.name, folder: hub.state.folders.find((f) => f.id === n.folderId)?.name, edited: n.editedAt })))
  }))

  const openProposals = (noteId: string) => hub.state.noteProposals.filter((p) => p.noteId === noteId && p.state === 'open').map((p) => ({ id: p.id, by: hub.state.agents.find((x) => x.id === p.by)?.name ?? p.by, why: p.why, comments: p.comments.length }))

  server.registerTool('get_binder_context', {
    description: 'What to read before working in a binder: how Binders works, the binder’s guide, and where to look. of: a binder, card, change set or note (id or name); left out, the binders you work in.',
    inputSchema: { of: z.string().optional() },
  }, run(async ({ of }: { of?: string }) => {
    // Not about anything in particular, a terminal say: the one binder it works in, or which ones there are to ask about.
    if (!of) {
      const mine = hub.state.binders.filter((b) => mayUse(b.id))
      if (mine.length === 1) return text(binderContext(hub.state, mine[0].id))
      return text(`${howBindersWorks}\n\nYou work in these binders. Before working in one, get_binder_context with its name: ${mine.map((b) => b.name).join(', ') || 'none yet'}.`)
    }
    const card = hub.state.cards.find((c) => c.id === of)
    const set = hub.state.changeSets.find((c) => c.id === of)
    const noteOf = hub.state.notes.find((n) => n.id === of)
    const binderId = card?.binderId ?? set?.binderId ?? noteOf?.binderId ?? hub.state.binders.find((b) => b.id === of || b.name.toLowerCase() === of.trim().toLowerCase())?.id
    if (!binderId || !mayUse(binderId)) throw new Refused(`Nothing called ${of} you may read.`)
    return text(binderContext(hub.state, binderId, card?.noteId ?? noteOf?.id))
  }))

  server.registerTool('propose_note_change', {
    description: 'Proposes a change to a locked note, for a person to review, when you can’t edit it yourself: find and replace one exact passage (find must appear once), or text for the whole note. why: what’s wrong or out of date.',
    inputSchema: { id: z.string(), why: z.string(), find: z.string().optional(), replace: z.string().optional(), text: z.string().optional() },
  }, run(async ({ id, why, find, replace, text: whole }: { id: string; why: string; find?: string; replace?: string; text?: string }) => {
    const note = findNote(id)
    if (!note || !mayUse(note.binderId)) throw new Refused(`No note ${id} you may read.`)
    let next: string
    if (find !== undefined) {
      const at = note.text.indexOf(find)
      if (at < 0) throw new Refused('That passage isn’t in the note (it may have changed): get_note and try again.')
      if (note.text.indexOf(find, at + 1) >= 0) throw new Refused('That passage is in the note more than once: give more of it.')
      next = note.text.slice(0, at) + (replace ?? '') + note.text.slice(at + find.length)
    } else if (whole !== undefined) next = whole
    else throw new Refused('Give find and replace, or the whole text.')
    const proposal = await propose(hub, actor, login, note.id, next, why)
    return text({ id: proposal.id, state: 'open', note: 'A person reviews it. Carry on without it.' })
  }))

  server.registerTool('reply_to_note_proposal', {
    description: 'Says something on a proposed change to a locked note, to talk it over with who’s reviewing it. id: the proposal’s, from get_note’s open_proposals.',
    inputSchema: { id: z.string(), text: z.string() },
  }, run(async ({ id, text: said }: { id: string; text: string }) => {
    const proposal = hub.state.noteProposals.find((p) => p.id === id)
    if (!proposal || !mayUse(proposal.binderId)) throw new Refused(`No proposal ${id}.`)
    await commentOn(hub, actor, login, id, said)
    return text('Said.')
  }))

  server.registerTool('get_note', { description: 'A note’s Markdown, by id or title, with the cards that came from it and, in full, the notes it links to. Words a work item quotes come from the note itself.', inputSchema: { id: z.string() } }, run(async ({ id }: { id: string }) => {
    const note = findNote(id)
    if (!note || !mayUse(note.binderId)) throw new Refused(`No note ${id} you may read.`)
    const cards = (note.work ?? []).map((w) => hub.state.cards.find((c) => c.id === w.itemId)).filter((c): c is Card => !!c).map(summary)
    const { linked, left } = linkedNotes(hub.state.notes, note)
    return text({ id: note.id, title: titleOf(note.text), text: note.text, cards, ...(linked.length ? { linked: linked.map((n) => ({ id: n.id, title: titleOf(n.text), text: n.text })) } : {}), ...(left.length ? { linked_too_long: left } : {}), ...(note.locked ? { locked: { by: note.locked.by, note: 'Propose changes to this note with propose_note_change.' } } : {}), ...(openProposals(note.id).length ? { open_proposals: openProposals(note.id) } : {}) })
  }))

  server.registerTool('create_note', { description: 'Makes a note in a binder from Markdown.', inputSchema: { binder: z.string(), text: z.string() } }, run(async ({ binder, text: body }: { binder: string; text: string }) => {
    const target = findBinder(binder)
    if (!target) throw new Refused(`No binder ${binder} you may write in.`)
    if (isBlank(body)) throw new Refused('The note is empty.')
    const id = `note-${Date.now().toString(36)}`
    await hub.record(actor, { type: 'note.put', note: { id, title: titleOf(body), binderId: target.id, editedAt: new Date().toISOString(), editors: [login], text: body } })
    return text({ id, title: titleOf(body) })
  }))

  server.registerTool('append_to_note', { description: 'Adds Markdown at the end of a note.', inputSchema: { id: z.string(), text: z.string() } }, run(async ({ id, text: more }: { id: string; text: string }) => {
    const note = findNote(id)
    if (!note || !mayUse(note.binderId)) throw new Refused(`No note ${id} you may write in.`)
    const next = `${note.text.replace(/\s*$/, '')}\n\n${more.trim()}\n`
    await hub.record(actor, { type: 'note.edit', id: note.id, text: next, title: titleOf(next), by: login, at: new Date().toISOString() })
    return text('Added.')
  }))

  server.registerTool('edit_note', {
    description: 'Changes a note: find and replace one exact passage (find must appear once), or text to replace the whole note. Prefer find and replace, so someone typing elsewhere in it keeps their words.',
    inputSchema: { id: z.string(), find: z.string().optional(), replace: z.string().optional(), text: z.string().optional() },
  }, run(async ({ id, find, replace, text: whole }: { id: string; find?: string; replace?: string; text?: string }) => {
    const note = findNote(id)
    if (!note || !mayUse(note.binderId)) throw new Refused(`No note ${id} you may write in.`)
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
    await hub.record(actor, { type: 'note.edit', id: note.id, text: next, title: titleOf(next), by: login, at: new Date().toISOString() })
    return text('Changed.')
  }))

  server.registerTool('create_folder', {
    description: 'Makes a folder in a binder, inside another with parent (its name or id). A folder of that name already there is returned instead of a second one.',
    inputSchema: { binder: z.string(), name: z.string(), parent: z.string().optional() },
  }, run(async ({ binder, name, parent }: { binder: string; name: string; parent?: string }) => {
    const target = findBinder(binder)
    if (!target) throw new Refused(`No binder ${binder} you may write in.`)
    const clean = name.trim()
    if (!clean) throw new Refused('A folder needs a name.')
    const under = parent ? findFolder(target.id, parent) : undefined
    if (parent && !under) throw new Refused(`No folder ${parent} in ${target.name}.`)
    const there = hub.state.folders.find((f) => f.binderId === target.id && f.parentId === under?.id && f.name.toLowerCase() === clean.toLowerCase())
    if (there) return text({ id: there.id, name: there.name, made: false })
    const id = `folder-${Date.now().toString(36)}`
    await hub.record(actor, { type: 'folder.put', folder: { id, binderId: target.id, name: clean, parentId: under?.id } })
    return text({ id, name: clean, made: true })
  }))

  server.registerTool('move_note', {
    description: 'Moves a note (its id or title) into a folder (its name or id), or to the top of its binder with no folder. With binder, into another binder you may write in.',
    inputSchema: { id: z.string(), folder: z.string().optional(), binder: z.string().optional() },
  }, run(async ({ id, folder, binder }: { id: string; folder?: string; binder?: string }) => {
    const note = findNote(id)
    if (!note || !mayUse(note.binderId)) throw new Refused(`No note ${id} you may write in.`)
    const target = binder ? findBinder(binder) : hub.state.binders.find((b) => b.id === note.binderId)
    if (!target || !mayUse(target.id)) throw new Refused(`No binder ${binder} you may write in.`)
    const into = folder ? findFolder(target.id, folder) : undefined
    if (folder && !into) throw new Refused(`No folder ${folder} in ${target.name}: create_folder makes it.`)
    await hub.record(actor, { type: 'note.move', id: note.id, binderId: target.id, folderId: into?.id })
    return text(`Moved “${titleOf(note.text)}” to ${target.name}${into ? ` / ${into.name}` : ''}.`)
  }))

  // Cards ------------------------------------------------------------------------------------------------------------

  server.registerTool('list_tasks', {
    description: 'Cards on the boards you may open. stage: proposed, ready, working, blocked (waiting on a person), review, done.',
    inputSchema: { binder: z.string().optional(), stage: z.enum(['proposed', 'ready', 'working', 'blocked', 'review', 'done']).optional() },
  }, run(async ({ binder, stage }: { binder?: string; stage?: 'proposed' | 'ready' | 'working' | 'blocked' | 'review' | 'done' }) => {
    const only = binder ? findBinder(binder) : undefined
    const cards = hub.state.cards.filter((c) => mayUse(c.binderId) && (!only || c.binderId === only.id) && (!stage || c.stage === (stage === 'done' ? 'live' : stage)))
    return text(cards.slice(0, 200).map(summary))
  }))

  server.registerTool('get_task', { description: 'A card in full: brief, done when, the note’s words it came from, what it waits for, its plan, its pull request, how its debrief and Challenge stand, and the conversation. Given a change set’s id: how its debrief and Challenge stand.', inputSchema: { id: z.string() } }, run(async ({ id }: { id: string }) => {
    const set = hub.state.changeSets.find((s) => s.id === id)
    if (set && mayUse(set.binderId)) {
      return text({ id: set.id, title: `Change set #${set.number}: ${set.title}`, stage: 'review', debrief: set.debrief ? { state: set.debrief.state } : undefined, challenge: set.challenge ? { state: set.challenge.state } : undefined })
    }
    const card = hub.state.cards.find((c) => c.id === id)
    if (!card || !mayUse(card.binderId)) throw new Refused(`No card ${id} you may see.`)
    return text(full(card))
  }))

  server.registerTool('create_task', {
    description: 'Puts a card on a binder’s board, ready for an agent to take (a person’s card, not a suggestion). waits_for: cards it needs first, by id.',
    inputSchema: { binder: z.string(), title: z.string(), brief: z.string().optional(), done_when: z.string().optional(), size: z.enum(['S', 'M', 'L']).optional(), waits_for: z.array(z.string()).optional() },
  }, run(async ({ binder, title, brief, done_when, size, waits_for }: { binder: string; title: string; brief?: string; done_when?: string; size?: Card['size']; waits_for?: string[] }) => {
    const target = findBinder(binder)
    if (!target) throw new Refused(`No binder ${binder} you may write in.`)
    return text(summary(await actions.createCard(actor, { binderId: target.id, title, brief, doneWhen: done_when, size, waitsFor: waits_for })))
  }))

  server.registerTool('comment_task', { description: 'Leaves a comment on a card, as you.', inputSchema: { id: z.string(), text: z.string() } }, run(async ({ id, text: body }: { id: string; text: string }) => {
    const card = hub.state.cards.find((c) => c.id === id)
    if (!card || !mayUse(card.binderId)) throw new Refused(`No card ${id} you may see.`)
    await actions.comment(login, card.id, body)
    return text('Commented.')
  }))

  server.registerTool('list_agents', { description: 'The agents that work in this binder, by name, so you can give one a card.', inputSchema: {} }, run(async () =>
    text(hub.state.agents.filter((a) => !a.revoked && (!a.binders.length || a.binders.includes(session.binder.id))).map((a) => ({ id: a.id, name: a.name, owner: a.owner, online: a.lastSeen ? Date.now() - Date.parse(a.lastSeen) < 120_000 : false })))))

  server.registerTool('assign_task', {
    description: 'Gives a ready or proposed card to an agent (by name or id), so its runner takes it next, as a person giving it on the board would; or to any agent, with agent "any".',
    inputSchema: { id: z.string(), agent: z.string().describe('the agent’s name or id, or "any"') },
  }, run(async ({ id, agent: ref }: { id: string; agent: string }) => {
    const card = hub.state.cards.find((c) => c.id === id || goesBy(c, id))
    if (!card || !mayUse(card.binderId)) throw new Refused(`No card ${id} you may see.`)
    const any = ref.trim().toLowerCase() === 'any'
    const to = any ? undefined : hub.state.agents.find((a) => !a.revoked && a.id === ref) ?? agentNamed(hub.state.agents, ref)
    if (!any && !to) throw new Refused(`No agent ${ref}. These are: ${hub.state.agents.filter((a) => !a.revoked).map((a) => a.name).join(', ')}.`)
    if (to && to.binders.length && !to.binders.includes(session.binder.id)) throw new Refused(`${to.name} doesn’t work in this binder.`)
    if (card.agentId && (card.stage === 'working' || card.stage === 'blocked')) throw new Refused(`${nameOf(card.agentId)} is working on it: give it back first.`)
    if (card.stage !== 'ready' && card.stage !== 'proposed') throw new Refused(`That card is ${card.stage}: only a ready or proposed card is given to an agent.`)
    const who = to?.name ?? 'any agent'
    await hub.record(actor, { type: 'card.update', id: card.id, fields: { meantFor: to?.id, stage: 'ready', agentId: undefined, needsYou: undefined, doing: undefined, progress: undefined }, activity: { at: new Date().toISOString(), by: login, kind: 'moved', text: to ? `Gave it to ${who}` : 'Opened it to any agent' } })
    return text(`Gave “${card.title}” to ${who}.`)
  }))

  // What a card's work proposes, and how it was explained and reviewed ------------------------------------------------

  server.registerTool('get_change_set', {
    description: 'A card’s Change Set: its pull request’s diff and checks, or before there is one its worktree’s diff; its brief, its done-when as points, the note’s words; the agent’s plan and log; and the debrief on it. Given a change set’s id: all its pull requests together. outline: true gives each file’s size instead of its diff; file then gives one file’s diff.',
    inputSchema: { id: z.string(), outline: z.boolean().optional(), file: z.string().optional().describe('one file’s path, as the outline names it'), part: z.number().int().min(1).optional() },
  }, run(async ({ id, outline, file, part }: { id: string; outline?: boolean; file?: string; part?: number }) => {
    const whole = hub.state.changeSets.find((s) => s.id === id)
    const card = whole ? undefined : hub.state.cards.find((c) => c.id === id)
    if (whole ? !mayUse(whole.binderId) : !card || !mayUse(card.binderId)) throw new Refused(`No card or change set ${id} you may see.`)
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
    inputSchema: { id: z.string() },
  }, run(async ({ id }: { id: string }) => {
    const card = hub.state.cards.find((c) => c.id === id)
    if (!card || !mayUse(card.binderId)) throw new Refused(`No card ${id} you may see.`)
    const debrief = card.debrief ?? (setOfCard(hub.state, card)?.debrief)
    if (!debrief) return text(`Card ${id} has no debrief: a person asks for one with Debrief on the card.`)
    const agent = nameOf(debrief.agentId)
    return text({
      card: { id: card.id, title: card.title, stage: stageFor(card.stage) },
      state: debrief.state,
      by: agent,
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
      speech: actions.debriefOf(card.id).speech,
    })
  }))

  server.registerTool('get_challenge_set', {
    description: 'A card’s or change set’s Challenge set: its diff (each line numbered as in the file), the pull request and its checks, the brief, its done-when points and the note’s words, and the blast radius when its runner worked one out. Not the author’s plan or log.',
    inputSchema: { id: z.string(), outline: z.boolean().optional().describe('true: each file’s size instead of its diff'), file: z.string().optional(), part: z.number().int().min(1).optional() },
  }, run(async ({ id, outline, file, part }: { id: string; outline?: boolean; file?: string; part?: number }) => {
    const whole = hub.state.changeSets.find((s) => s.id === id)
    const card = whole ? undefined : hub.state.cards.find((c) => c.id === id)
    if (whole ? !mayUse(whole.binderId) : !card || !mayUse(card.binderId)) throw new Refused(`No card or change set ${id} you may see.`)
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
    inputSchema: { id: z.string() },
  }, run(async ({ id }: { id: string }) => {
    const card = hub.state.cards.find((c) => c.id === id)
    if (!card || !mayUse(card.binderId)) throw new Refused(`No card ${id} you may see.`)
    const challenge = card.challenge ?? setOfCard(hub.state, card)?.challenge
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
    description: 'Distill: proposes work items read from a note. Each needs the note’s exact words it came from (quote). They wait on the board until the person accepts them. meant_for: an agent’s name.',
    inputSchema: {
      note: z.string(),
      items: z.array(z.object({ title: z.string(), quote: z.string(), brief: z.string().optional(), done_when: z.string().optional(), size: z.enum(['S', 'M', 'L']).optional(), meant_for: z.string().optional() })).min(1).max(60),
    },
  }, run(async ({ note: ref, items }: { note: string; items: { title: string; quote: string; brief?: string; done_when?: string; size?: Card['size']; meant_for?: string }[] }) => {
    const note = findNote(ref)
    if (!note || !mayUse(note.binderId)) throw new Refused(`No note ${ref} you may read.`)
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

  const mayReadRepo = (repo: string) => {
    const wanted = briefId(repo)
    return hub.state.binders.some((b) => allowed.has(b.id) && (
      (b.repo && briefId(b.repo) === wanted) ||
      hub.state.agents.some((a) => !a.revoked && (a.binders.length === 0 || a.binders.includes(b.id)) && a.repos.some((r) => briefId(r) === wanted))
    ))
  }
  const briefView = (repo: string) => {
    if (!mayReadRepo(repo)) throw new Refused(`${repo} isn’t a repo in a binder you may open.`)
    const brief = briefOf(hub.state, repo)
    const name = (id?: string) => nameOf(id)
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
    inputSchema: { repo: z.string().describe('owner/name') },
  }, run(async ({ repo }: { repo: string }) => text(briefView(repo))))

  server.registerTool('add_repo_lesson', {
    description: 'Something you learned about a repo that the next agent there should know, in one line: a command that fails and what works, a rule the code keeps that isn’t written down, a trap. Never a secret.',
    inputSchema: { repo: z.string(), text: z.string() },
  }, run(async ({ repo, text: lesson }: { repo: string; text: string }) => {
    if (!mayReadRepo(repo)) throw new Refused(`${repo} isn’t a repo in a binder you may open.`)
    const brief = await actions.addLesson(actor, repo, lesson)
    return text({ repo: brief.repo, lessons: brief.lessons?.length ?? 0 })
  }))

  return server
}
