import { apply as applyNotes, type Change as NoteChange, type NotesState } from './notes.ts'
import { applyWork, emptyWork, type WorkChange, type WorkState } from './work.ts'

// Everything the hub holds, and every change to it: notes and work together, applied the same way everywhere.

export type HubState = NotesState & WorkState
export type Change = NoteChange | WorkChange

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

export const emptyState = (): HubState => ({ binders: [], folders: [], notes: [], ...emptyWork() })

const noteTypes = new Set(['binder.put', 'binder.delete', 'folder.put', 'folder.delete', 'note.put', 'note.edit', 'note.link', 'note.move', 'note.delete', 'note.saved'])

export function applyChange<S extends HubState>(state: S, change: Change): S {
  return noteTypes.has(change.type) ? applyNotes(state, change as NoteChange) : applyWork(state, change as WorkChange)
}
