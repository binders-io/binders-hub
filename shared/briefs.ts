import type { Folder, Note, NotesState } from './notes.ts'
import type { RepoBrief } from './work.ts'

// Where repos' briefs live: notes, in a folder of the binder's, "Repo docs", with a folder for each repo in it. They're
// saved to the repo with the binder's other notes, and people read and edit them like any note. An agent working or
// reviewing in a repo gets every note in its folder: its brief first, then whatever else the team put there, and the
// notes in Repo docs itself, which are for every repo.

export const docsFolderName = 'Repo docs'
/** The brief's note, in its repo's folder: its title, as its first line. */
export const briefTitle = 'Brief'
/** The most of a repo's other docs an agent is given, all told, and of any one of them. */
export const docsMost = 24_000
export const docMost = 8_000

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The binder a repo's docs go in: the one whose repo it is, else the first. */
export function docsBinder(state: NotesState, repo: string) {
  return state.binders.find((b) => b.repo && same(b.repo, repo)) ?? state.binders[0]
}

/** Repo docs, and the repo's folder in it, as far as they're there. */
export function repoFolders(state: NotesState, repo: string): { binderId?: string; docs?: Folder; folder?: Folder } {
  const binder = docsBinder(state, repo)
  if (!binder) return {}
  const docs = state.folders.find((f) => f.binderId === binder.id && !f.parentId && same(f.name, docsFolderName))
  const folder = docs ? state.folders.find((f) => f.parentId === docs.id && same(f.name, repo)) : undefined
  return { binderId: binder.id, docs, folder }
}

/** A brief's words: its note's, without the title line. A brief from before they were notes has its own. */
export function briefText(state: Pick<NotesState, 'notes'>, brief: RepoBrief | undefined) {
  if (!brief) return undefined
  const note = brief.noteId ? state.notes.find((n) => n.id === brief.noteId) : undefined
  if (note) return note.text.replace(/^\s*#\s+[^\n]*\n+/, '').trim() || undefined
  return brief.noteId ? undefined : brief.text
}

/** The note a brief is kept in, as its text: its title line, then the brief. */
export const briefNoteText = (text: string) => `# ${briefTitle}\n\n${text.trim()}\n`

/**
 * What the team keeps for a repo besides its brief: the notes in its folder (and folders in it), then those in Repo docs
 * itself, for every repo. Newest first in each, within what an agent is given.
 */
export function repoDocs(state: NotesState, repo: string, brief?: RepoBrief): Note[] {
  const { docs, folder } = repoFolders(state, repo)
  if (!docs) return []
  const inside = new Set<string>()
  if (folder) {
    const walk = (id: string) => {
      inside.add(id)
      for (const f of state.folders) if (f.parentId === id && !inside.has(f.id)) walk(f.id)
    }
    walk(folder.id)
  }
  const newest = (a: Note, b: Note) => (b.editedAt ?? '').localeCompare(a.editedAt ?? '')
  const own = state.notes.filter((n) => n.folderId && inside.has(n.folderId) && n.id !== brief?.noteId).sort(newest)
  const shared = state.notes.filter((n) => n.folderId === docs.id).sort(newest)
  return [...own, ...shared]
}

/** A repo's docs as an agent is given them: each cut to fit, and as many as fit. */
export function docsGiven(notes: Note[], title: (note: Note) => string) {
  const given: { id: string; title: string; text: string; cut?: boolean }[] = []
  let room = docsMost
  for (const note of notes) {
    if (room < 500) break
    const most = Math.min(docMost, room)
    const cut = note.text.length > most
    const text = note.text.slice(0, most)
    given.push({ id: note.id, title: title(note), text, ...(cut ? { cut: true } : {}) })
    room -= text.length
  }
  return { given, left: notes.length - given.length }
}
