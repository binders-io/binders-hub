import { cardPutBack } from '../../shared/work.ts'
import { trashDays } from '../../shared/notes.ts'
import type { Binder } from '../../shared/notes.ts'
import type { Change, HistoryLine, HistoryPage, HubState, TrashItem } from '../../shared/state.ts'
import { Refused, type Actor, type Hub } from './hub.ts'

// A Binder's history and its trash. The history is a short list of what people and agents did that others would want to
// know of later, in plain sentences; the trash holds what was deleted, whole, for thirty days, to be put back. Both are
// kept in the Binder's state, so they last as it does, and both are the hub's: a browser asks for them when someone looks.

/** How long what's deleted can be put back. */
export const trashMs = trashDays * 86_400_000

/** A page of history, and how many of the trash's notes and cards one pass of the scheduler lets go of. */
export const historyPage = 50
export const emptyBatch = 20

/** Who an actor is, as the history names them: a person's login, an agent's name, or the hub. */
export const whoIs = (state: HubState, actor: Actor) => (actor.kind === 'user' ? actor.login : actor.kind === 'hub' ? 'hub' : state.agents.find((a) => a.id === actor.id)?.name ?? actor.id)

/** A name or title as a sentence quotes it: short, in curly quotes. */
const quoted = (text: string) => `“${text.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Untitled'}”`

/** A deleted note or card goes to the trash with who deleted it and when: stamped as the hub writes it, whoever sent it. */
export function stamped(change: Change, by: string, at: string): Change {
  return change.type === 'note.delete' || change.type === 'card.delete' ? { ...change, by, at } : change
}

const lower = (text: string | undefined) => text?.trim().toLowerCase() || undefined
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What changed in a binder where its cards and notes go, in words. A field left out is what it comes to (on unless turned off). */
function binderLines(was: Binder, now: Binder): string[] {
  const lines: string[] = []
  const name = quoted(now.name)
  if (now.name !== was.name) lines.push(`Renamed the binder ${quoted(was.name)} to ${name}.`)
  if (lower(now.repo) !== lower(was.repo)) {
    lines.push(!now.repo?.trim() ? `Took the repo off ${name}.` : !was.repo?.trim() ? `Set the repo of ${name} to ${now.repo}.` : `Changed the repo of ${name} from ${was.repo} to ${now.repo}.`)
  }
  if (!same((now.repos ?? []).map(lower), (was.repos ?? []).map(lower))) lines.push(`Changed the repos agents work in for ${name}.`)
  if ((now.notes !== false) !== (was.notes !== false)) lines.push(`${now.notes !== false ? 'Turned on' : 'Turned off'} pushing the notes of ${name} to GitHub.`)
  if ((now.notesBranch || undefined) !== (was.notesBranch || undefined)) lines.push(now.notesBranch ? `Set the notes branch of ${name} to ${now.notesBranch}.` : `Put the notes branch of ${name} back to the usual one.`)
  if ((now.issues !== false) !== (was.issues !== false)) lines.push(`${now.issues !== false ? 'Turned on' : 'Turned off'} keeping the cards of ${name} as GitHub issues.`)
  if ((now.reviewComments === true) !== (was.reviewComments === true)) lines.push(`${now.reviewComments === true ? 'Turned on' : 'Turned off'} review comments on the pull requests of ${name}.`)
  if ((now.copies === true) !== (was.copies === true)) lines.push(`${now.copies === true ? 'Turned on' : 'Turned off'} keeping a daily copy of ${name} in GitHub.`)
  return lines
}

/** The sentences a change is noted as, from the state before it. Most changes aren't noted: edits, cards moving, agents at work. */
export function describe(state: HubState, change: Change): string[] {
  switch (change.type) {
    case 'note.delete': {
      const note = state.notes.find((n) => n.id === change.id)
      return note ? [`Deleted the note ${quoted(note.title)}.`] : []
    }
    case 'card.delete': {
      const card = state.cards.find((c) => c.id === change.id)
      return card ? [`Deleted the card ${quoted(card.title)}.`] : []
    }
    case 'folder.delete': {
      const folder = state.folders.find((f) => f.id === change.id)
      return folder ? [`Deleted the folder ${quoted(folder.name)}.`] : []
    }
    case 'binder.delete': {
      const binder = state.binders.find((b) => b.id === change.id)
      return binder ? [`Deleted the binder ${quoted(binder.name)}.`] : []
    }
    case 'binder.put': {
      const was = state.binders.find((b) => b.id === change.binder.id)
      return was ? binderLines(was, change.binder) : []
    }
    default:
      return []
  }
}

/** The last time a line was given in each Binder's history, so two lines never share one and a page can start after either. */
const lastGiven = new WeakMap<Hub, number>()

/** Notes what happened, in the Binder's history: one line a sentence, newest last. */
export async function noted(hub: Hub, actor: Actor, texts: string | string[]) {
  const sentences = [texts].flat().filter(Boolean)
  if (!sentences.length) return
  const by = whoIs(hub.state, actor)
  let at = Math.max(Date.now(), (lastGiven.get(hub) ?? 0) + 1, Date.parse(hub.state.history?.at(-1)?.at ?? '') + 1 || 0)
  const lines: HistoryLine[] = sentences.map((text) => ({ at: new Date(at++).toISOString(), by, text }))
  lastGiven.set(hub, at - 1)
  await hub.record(actor, { type: 'history.add', lines })
}

/** A page of the history, newest first: the lines before a time, and only one person's when asked, and who's in it. */
export function historyOf(state: HubState, query: { before?: string; who?: string }): HistoryPage {
  const before = query.before ? Date.parse(query.before) : undefined
  if (before !== undefined && Number.isNaN(before)) throw new Refused('“before” is a time, such as 2026-11-09T12:00:00.000Z.')
  const who = query.who?.trim().replace(/^@/, '').toLowerCase()
  const all = state.history ?? []
  const wanted = all.filter((line) => (!who || line.by.toLowerCase() === who) && (before === undefined || Date.parse(line.at) < before))
  return {
    lines: wanted.slice(-historyPage).reverse(),
    more: wanted.length > historyPage,
    people: [...new Set(all.map((line) => line.by))].sort((a, b) => a.localeCompare(b)),
  }
}

/** What's in the trash, newest first, without its contents. What can't be put back, its binder gone, isn't offered. */
export function trashOf(state: HubState): TrashItem[] {
  const here = (binderId: string) => state.binders.some((b) => b.id === binderId)
  return [
    ...(state.trashedNotes ?? []).filter((t) => here(t.note.binderId)).map((t): TrashItem => ({ kind: 'note', id: t.note.id, title: t.note.title, binderId: t.note.binderId, by: t.by, at: t.at })),
    ...(state.trashedCards ?? []).filter((t) => here(t.card.binderId)).map((t): TrashItem => ({ kind: 'card', id: t.card.id, title: t.card.title, binderId: t.card.binderId, by: t.by, at: t.at })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/**
 * Puts a note or a card back from the trash, as it was. A note goes to its folder, or the top of its binder when the
 * folder is gone; a card to its stage with no agent holding it, a card that was being worked waiting in Ready.
 */
export async function putBack(hub: Hub, login: string, kind: 'note' | 'card', id: string) {
  const actor: Actor = { kind: 'user', login }
  const restored = { by: login, at: new Date().toISOString() }
  const gone = new Refused('That isn’t in the trash any more.')
  const state = hub.state
  if (kind === 'note') {
    const trashed = state.trashedNotes?.find((t) => t.note.id === id)
    if (!trashed) throw gone
    if (!state.binders.some((b) => b.id === trashed.note.binderId)) throw new Refused('The binder it was in is gone, so it can’t be put back.')
    const { folderId, ...rest } = trashed.note
    const note = folderId && state.folders.some((f) => f.id === folderId) ? { ...rest, folderId } : rest
    await hub.record(actor, { type: 'note.put', note, restored })
    await noted(hub, actor, `Put back the note ${quoted(note.title)}.`)
    return { kind, id, title: note.title }
  }
  const trashed = state.trashedCards?.find((t) => t.card.id === id)
  if (!trashed) throw gone
  if (!state.binders.some((b) => b.id === trashed.card.binderId)) throw new Refused('The binder it was in is gone, so it can’t be put back.')
  const card = cardPutBack(trashed.card, login, restored.at)
  await hub.record(actor, { type: 'card.put', card, restored })
  await noted(hub, actor, `Put back the card ${quoted(card.title)}.`)
  return { kind, id, title: card.title }
}

/** Lets go of what's been in the trash longer than it's kept, the oldest first and a few at a time. Returns how many. */
export async function emptyTrash(hub: Hub, now = Date.now(), keptMs = trashMs, batch = emptyBatch) {
  const cut = now - keptMs
  const notes = (hub.state.trashedNotes ?? []).filter((t) => Date.parse(t.at) < cut).slice(0, batch).map((t) => t.note.id)
  const cards = (hub.state.trashedCards ?? []).filter((t) => Date.parse(t.at) < cut).slice(0, batch - notes.length).map((t) => t.card.id)
  if (!notes.length && !cards.length) return 0
  await hub.record({ kind: 'hub' }, { type: 'trash.drop', notes, cards })
  return notes.length + cards.length
}
