// Notes as the hub and the web app both hold them, and the changes that move them. Both sides apply a change with the
// same `apply`, so a client that applied its own change at once ends up where the hub does.

/** A work item that came from a note, and the note's words it came from. */
export interface WorkLink {
  itemId: string
  quote: string
}

export interface Binder {
  id: string
  name: string
  /** The GitHub repo its cards are kept in as issues, as "owner/name". */
  repo?: string
  /** Whether its cards are kept as issues in that repo: on unless turned off. */
  issues?: boolean
  /** Whether its notes are pushed to that repo, on their own branch (binders-notes unless named). */
  notes?: boolean
  notesBranch?: string
  /** Whether a Challenge's findings are posted as a review on its card's pull request: off unless turned on. */
  reviewComments?: boolean
  createdBy?: string
}

/** Folders nest; each is a folder in the notes repo, so a note's place is its path. */
export interface Folder {
  id: string
  binderId: string
  name: string
  parentId?: string
}

export interface Note {
  id: string
  title: string
  binderId: string
  folderId?: string
  /** When it last changed: an ISO date from the hub, or a label in sample data. */
  editedAt: string
  /** Who made the last edit: a person's login or an agent's id. */
  editedBy?: string
  editors: string[]
  /** The note itself, as Markdown: GitHub's, plus [[links]] between notes. */
  text: string
  /** The work items that came from it. */
  work?: WorkLink[]
  /** The commit that saved it last, and its file in the notes repo. */
  commit?: string
  path?: string
  /** On a client only: edits are on their way to the hub. */
  saving?: boolean
  /** On a client only: the hub has the edits, and commits them when typing pauses. */
  committing?: boolean
}

export interface NotesState {
  binders: Binder[]
  folders: Folder[]
  notes: Note[]
}

export type Change =
  | { type: 'binder.put'; binder: Binder }
  /** Only an empty binder goes; the hub refuses the rest. */
  | { type: 'binder.delete'; id: string }
  | { type: 'folder.put'; folder: Folder }
  | { type: 'folder.delete'; id: string }
  | { type: 'note.put'; note: Note }
  /**
   * `changes` are Automerge changes to the note's document (base64, in order; see noteDoc.ts), and what the edit is.
   * The hub applies them, and the edit it sends on has `text` and `title` as they are merged, so `apply` here needs
   * no document. An edit sent with only `text` is made into changes by the hub before it goes in the log.
   */
  | { type: 'note.edit'; id: string; text: string; title: string; by: string; at: string; changes?: string[] }
  | { type: 'note.link'; id: string; link: WorkLink }
  | { type: 'note.move'; id: string; binderId: string; folderId?: string }
  | { type: 'note.delete'; id: string }
  /** The saver committed the note: written by the hub, never by a client. */
  | { type: 'note.saved'; id: string; commit: string; path: string }

const without = <T extends { id: string }>(list: T[], id: string) => list.filter((x) => x.id !== id)
const upsert = <T extends { id: string }>(list: T[], item: T) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item])

export function apply<S extends NotesState>(state: S, change: Change): S {
  switch (change.type) {
    case 'binder.put':
      return { ...state, binders: upsert(state.binders, change.binder) }
    case 'binder.delete':
      return { ...state, binders: without(state.binders, change.id) }
    case 'folder.put':
      return { ...state, folders: upsert(state.folders, change.folder) }
    case 'folder.delete': {
      // A folder goes with what's inside it moved up to where the folder was.
      const folder = state.folders.find((f) => f.id === change.id)
      if (!folder) return state
      return {
        ...state,
        folders: without(state.folders, change.id).map((f) => (f.parentId === change.id ? { ...f, parentId: folder.parentId } : f)),
        notes: state.notes.map((n) => (n.folderId === change.id ? { ...n, folderId: folder.parentId } : n)),
      }
    }
    case 'note.put':
      return { ...state, notes: upsert(state.notes, change.note) }
    case 'note.edit':
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === change.id
            ? { ...n, text: change.text, title: change.title, editedAt: change.at, editedBy: change.by, editors: n.editors.includes(change.by) ? n.editors : [...n.editors, change.by] }
            : n),
      }
    case 'note.link':
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === change.id && !n.work?.some((w) => w.itemId === change.link.itemId) ? { ...n, work: [...(n.work ?? []), change.link] } : n),
      }
    case 'note.move':
      return { ...state, notes: state.notes.map((n) => (n.id === change.id ? { ...n, binderId: change.binderId, folderId: change.folderId } : n)) }
    case 'note.delete':
      return { ...state, notes: without(state.notes, change.id) }
    case 'note.saved':
      return { ...state, notes: state.notes.map((n) => (n.id === change.id ? { ...n, commit: change.commit, path: change.path } : n)) }
  }
}

/** A note's title: its first top heading, or the start of its first words with the Markdown taken off. */
export function titleOf(text: string) {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1]
  if (heading?.trim()) return heading.trim().slice(0, 120)
  const first = text.split('\n').map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, '').replace(/[*_`~\[\]]/g, '').trim()).find(Boolean)
  return first ? first.slice(0, 60) : 'Untitled'
}

/** Nothing written yet: no words besides an empty heading. */
export const isBlank = (text: string) => !text.replace(/^#+\s*$/gm, '').trim()

/** The notes a note's [[links]] name, by title, alias and heading taken off. */
export function linksIn(text: string) {
  return [...text.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim())
}

/** [[Links]] as words, for somewhere they don't link: what they show, or the note they name. */
export const linksAsWords = (text: string) => text.replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, title: string, shown?: string) => (shown?.trim() || title).trim())

/**
 * The notes a note links to and those they link to, nearest first and each once. Only its own binder's: a link doesn't
 * carry one binder's words into another's. What doesn't fit in `room` is named instead, whole notes being kept whole.
 */
export function linkedNotes(notes: Note[], note: Note, room = 30_000) {
  const seen = new Set([note.id])
  const queue = [note]
  const linked: Note[] = []
  const left: string[] = []
  for (let at = queue.shift(); at; at = queue.shift()) {
    for (const title of linksIn(at.text)) {
      const found = notes.find((n) => n.binderId === note.binderId && !seen.has(n.id) && n.title.toLowerCase() === title.toLowerCase())
      if (!found) continue
      seen.add(found.id)
      queue.push(found)
      // A little over its length, for what introduces it.
      const size = found.text.length + 200
      if (size > room) left.push(found.title)
      else {
        room -= size
        linked.push(found)
      }
    }
  }
  return { linked, left }
}

export const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'

/** Where a note lives in the notes repo: its binder, its folders, its title. */
export function pathOf(state: NotesState, note: Note) {
  const names: string[] = []
  let folder = state.folders.find((f) => f.id === note.folderId)
  const seen = new Set<string>()
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id)
    names.unshift(folder.name)
    folder = state.folders.find((f) => f.id === folder!.parentId)
  }
  const binder = state.binders.find((b) => b.id === note.binderId)
  return [binder?.name ?? note.binderId, ...names].map(slug).join('/') + `/${slug(note.title)}.md`
}

/** A note's file: Binders' own fields in front matter, so the file alone can rebuild it, then the note as written. */
export function toMarkdown(note: Note) {
  const front = ['---', `id: ${note.id}`, `binder: ${note.binderId}`, ...(note.folderId ? [`folder: ${note.folderId}`] : [])]
  if (note.work?.length) front.push('work:', ...note.work.map((w) => `  - { item: ${w.itemId}, quote: ${JSON.stringify(w.quote)} }`))
  front.push('---', '')
  return front.join('\n') + note.text.replace(/\s*$/, '') + '\n'
}
