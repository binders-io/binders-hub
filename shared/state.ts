import { apply as applyNotes, type Change as NoteChange, type NotesState } from './notes.ts'
import { applyWork, emptyWork, type WorkChange, type WorkState } from './work.ts'

// Everything the hub holds, and every change to it: notes and work together, applied the same way everywhere.

/** One thing that happened in a Binder that others would want to know of later, in a sentence. */
export interface HistoryLine {
  at: string
  /** A person's login, an agent's name, or "hub". */
  by: string
  text: string
}

/** How many lines of history a Binder keeps: the newest. */
export const historyKept = 1000

/** The Binder's history, and its trash (in `NotesState` and `WorkState`): the hub's, never in what a browser holds (shared/light.ts). */
export interface KeptState {
  /** Oldest first. */
  history?: HistoryLine[]
}

export type HubState = NotesState & WorkState & KeptState

/** A page of the history as the hub answers for it: newest first, whether there are older ones, and everyone who's in it. */
export interface HistoryPage {
  lines: HistoryLine[]
  more: boolean
  people: string[]
}

/** One thing in the trash as the hub lists it, without its contents. */
export interface TrashItem {
  kind: 'note' | 'card'
  id: string
  title: string
  binderId: string
  by: string
  at: string
}

/** What the hub writes for the history and the trash, which no client sends. */
export type KeptChange =
  | { type: 'history.add'; lines: HistoryLine[] }
  /** Notes and cards let go of from the trash for good, by id. */
  | { type: 'trash.drop'; notes?: string[]; cards?: string[] }

export type Change = NoteChange | WorkChange | KeptChange

export interface Entry {
  version: number
  id: string
  client: string
  at: string
  change: Change
}

export interface Outgoing {
  id: string
  change: Change
}

export const emptyState = (): HubState => ({ binders: [], folders: [], notes: [], noteProposals: [], ...emptyWork() })

const noteTypes = new Set(['note.lock', 'noteProposal.put', 'noteProposal.update', 'binder.put', 'binder.delete', 'folder.put', 'folder.delete', 'note.put', 'note.edit', 'note.link', 'note.move', 'note.delete', 'note.saved'])

export function applyChange<S extends HubState>(state: S, change: Change): S {
  switch (change.type) {
    case 'history.add':
      return { ...state, history: [...(state.history ?? []), ...change.lines].slice(-historyKept) }
    case 'trash.drop': {
      const notes = new Set(change.notes ?? [])
      const cards = new Set(change.cards ?? [])
      return {
        ...state,
        ...(state.trashedNotes ? { trashedNotes: state.trashedNotes.filter((t) => !notes.has(t.note.id)) } : {}),
        ...(state.trashedCards ? { trashedCards: state.trashedCards.filter((t) => !cards.has(t.card.id)) } : {}),
      }
    }
    case 'note.delete': {
      const next = applyNotes(state, change)
      // What was proposed from a note that's gone has nothing to come from: dismissed, and open again with the note.
      const open = next === state ? [] : (state.proposals ?? []).filter((p) => p.noteId === change.id && p.state === 'new').map((p) => p.id)
      if (!open.length) return next
      return {
        ...next,
        proposals: next.proposals.map((p) => (open.includes(p.id) ? { ...p, state: 'dismissed' as const } : p)),
        ...(next.trashedNotes ? { trashedNotes: next.trashedNotes.map((t) => (t.note.id === change.id ? { ...t, dismissed: open } : t)) } : {}),
      }
    }
    case 'note.put': {
      const trashed = change.restored ? state.trashedNotes?.find((t) => t.note.id === change.note.id) : undefined
      const next = applyNotes(state, change)
      if (!trashed?.dismissed?.length) return next
      return { ...next, proposals: next.proposals.map((p) => (trashed.dismissed!.includes(p.id) && p.state === 'dismissed' ? { ...p, state: 'new' as const } : p)) }
    }
    default:
      return noteTypes.has(change.type) ? applyNotes(state, change as NoteChange) : applyWork(state, change as WorkChange)
  }
}
