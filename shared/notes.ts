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
  /**
   * The repos its agents work in, as "owner/name": each agent works in all of them, or the ones it's limited to among
   * them. None: any repo.
   */
  repos?: string[]
  /** Whether its cards are kept as issues in that repo: on unless turned off. */
  issues?: boolean
  /** Whether its notes are pushed to that repo, on their own branch (binders-notes unless named). */
  notes?: boolean
  notesBranch?: string
  /** Whether a Challenge's findings are posted as a review on its card's pull request: off unless turned on. */
  reviewComments?: boolean
  createdBy?: string
  /** The note every agent in this binder reads first (shared/guide.ts). */
  guideNoteId?: string
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
  /** Settled by a person: only they and the Binder's owners and admins change it now, and others propose. */
  locked?: { by: string; at: string }
  /** The note itself, as Markdown: GitHub's, plus [[links]] between notes. */
  text: string
  /** The work items that came from it. */
  work?: WorkLink[]
  /**
   * What a phone or Mac captured it from, when it was: a dictation (the person's own words), or a conversation or meeting
   * (anyone's words, heard in a room). Work that comes of a conversation or meeting is always read by a person first.
   */
  captured?: 'dictation' | 'conversation' | 'meeting' | 'note'
  /** The commit that saved it last, and its file in the notes repo. */
  commit?: string
  path?: string
  /**
   * On a browser only: the note's text isn't here (`text` is empty), and this stands in for it until the note is opened.
   * The hub never keeps one, and refuses a note sent with one.
   */
  left?: NoteLeft
  /** On a client only: edits are on their way to the hub. */
  saving?: boolean
  /** On a client only: the hub has the edits, and commits them when typing pauses. */
  committing?: boolean
}

/** How much of a note's start a browser keeps while its text isn't there: enough for a preview, and for when it was heard. */
export const headChars = 600

/**
 * What stands in for a note's text on a browser that hasn't asked for it: how long it is, how it starts, and the notes
 * its [[links]] name, in lower case and each once.
 */
export interface NoteLeft {
  size: number
  head: string
  links: string[]
}

export interface NotesState {
  binders: Binder[]
  folders: Folder[]
  notes: Note[]
  noteProposals: NoteProposal[]
  /** Notes deleted in the last 30 days, oldest first: the hub's, never in what a browser holds (shared/light.ts). */
  trashedNotes?: TrashedNote[]
}

/** A note deleted, as it was, with who deleted it and when: it can be put back until it's emptied from the trash. */
export interface TrashedNote {
  note: Note
  /** A person's login, an agent's name, or "hub". */
  by: string
  at: string
  /** Its proposed cards that were still new, which went with it and open again when it's put back. */
  dismissed?: string[]
}

/** How long a deleted note or card stays in the trash, and how many of each: past either, the oldest go. */
export const trashDays = 30
export const trashKept = 200

/** A change to a locked note, for someone who may change it to accept or turn down. */
export interface NoteProposal {
  id: string
  noteId: string
  binderId: string
  /** A person's login or an agent's id. */
  by: string
  at: string
  why: string
  /** The note when it was proposed: what it's a change to. */
  base: string
  text: string
  state: 'open' | 'accepted' | 'rejected'
  decidedBy?: string
  decidedAt?: string
  comments: { by: string; at: string; text: string }[]
}

/** Whether a note's lock stops someone changing it. An agent has no login: a lock always stops it. */
export const lockStops = (note: Pick<Note, 'locked'>, who: { login?: string; manager?: boolean }) =>
  !!note.locked && !who.manager && who.login?.toLowerCase() !== note.locked.by.toLowerCase()

export type Change =
  | { type: 'binder.put'; binder: Binder }
  /** Only an empty binder goes; the hub refuses the rest. */
  | { type: 'binder.delete'; id: string }
  | { type: 'folder.put'; folder: Folder }
  | { type: 'folder.delete'; id: string }
  /** `restored`: the hub put it back from the trash, which only it says, so the trash lets go of it. */
  | { type: 'note.put'; note: Note; restored?: { by: string; at: string } }
  /**
   * `changes` are Automerge changes to the note's document (base64, in order; see noteDoc.ts), and what the edit is.
   * The hub applies them, and the edit it sends on has `text` and `title` as they are merged, so `apply` here needs
   * no document. An edit sent with only `text` is made into changes by the hub before it goes in the log.
   */
  | { type: 'note.edit'; id: string; text: string; title: string; by: string; at: string; changes?: string[] }
  | { type: 'note.link'; id: string; link: WorkLink }
  | { type: 'note.move'; id: string; binderId: string; folderId?: string }
  /** `by` and `at` are the hub's, stamped on as it's written: with them, the note goes to the trash instead of nowhere. */
  | { type: 'note.delete'; id: string; by?: string; at?: string }
  /** Written by the hub, once it's checked who's asking. */
  | { type: 'note.lock'; id: string; locked?: { by: string; at: string } }
  | { type: 'noteProposal.put'; proposal: NoteProposal }
  | { type: 'noteProposal.update'; id: string; fields?: Pick<NoteProposal, 'state' | 'decidedBy' | 'decidedAt'>; comment?: NoteProposal['comments'][number] }
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
    case 'note.put': {
      // A note's lock is the hub's to change: writing the note whole neither takes one off nor puts one on. One put back
      // from the trash is the hub's own copy, so it keeps the lock it had.
      const { locked: _given, ...given } = change.note
      const was = state.notes.find((n) => n.id === given.id)
      // On a browser that holds this note without its text, it stays that way: only what stands in for the text follows.
      const note = was?.left ? lightNote(given) : given
      const locked = change.restored ? change.note.locked : was?.locked
      const trashed = change.restored ? state.trashedNotes?.filter((t) => t.note.id !== note.id) : state.trashedNotes
      return { ...state, notes: upsert(state.notes, locked ? { ...note, locked } : note), ...(trashed ? { trashedNotes: trashed } : {}) }
    }
    case 'note.lock':
      return {
        ...state,
        notes: state.notes.map((n) => {
          if (n.id !== change.id) return n
          const { locked: _was, ...note } = n
          return change.locked ? { ...note, locked: change.locked } : note
        }),
      }
    case 'noteProposal.put':
      return { ...state, noteProposals: upsert(state.noteProposals ?? [], change.proposal) }
    case 'noteProposal.update':
      return {
        ...state,
        noteProposals: (state.noteProposals ?? []).map((p) => (p.id === change.id ? { ...p, ...change.fields, comments: change.comment ? [...p.comments, change.comment].slice(-200) : p.comments } : p)),
      }
    case 'note.edit':
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === change.id
            // A browser that holds the note without its text keeps it so: what stands in for the text follows the edit.
            ? { ...n, ...(n.left ? { text: '', left: leftOf(change.text) } : { text: change.text }), title: change.title, editedAt: change.at, editedBy: change.by, editors: n.editors.includes(change.by) ? n.editors : [...n.editors, change.by] }
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
    case 'note.delete': {
      const note = state.notes.find((n) => n.id === change.id)
      if (!note) return state
      // Stamped by the hub, it goes to the trash: whole, as it was. A change without a stamp (from before there was a trash,
      // or a client's own copy of the change) just removes it, so a log read again from its start doesn't fill the trash.
      const trashed = change.at ? [...(state.trashedNotes ?? []).filter((t) => t.note.id !== note.id), { note, by: change.by ?? 'hub', at: change.at }].slice(-trashKept) : state.trashedNotes
      return { ...state, notes: without(state.notes, change.id), ...(trashed ? { trashedNotes: trashed } : {}) }
    }
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

/** What stands in for a text on a browser that hasn't asked for it. */
export const leftOf = (text: string): NoteLeft => ({ size: text.length, head: text.slice(0, headChars), links: [...new Set(linksIn(text).map((title) => title.toLowerCase()))] })

/** A note as a browser holds it before its text is asked for: everything but the text, and what stands in for it. */
export const lightNote = (note: Note): Note => (note.left ? note : { ...note, text: '', left: leftOf(note.text) })

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

/** A note's words from its file: what's after the front matter. */
export const fromMarkdown = (file: string) => file.replace(/^---\n[\s\S]*?\n---\n\n?/, '')

/** Two versions line by line, for reading: the same lines at each end, and the longest run in common between. */
export function lineDiff(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const midA = a.slice(start, a.length - end)
  const midB = b.slice(start, b.length - end)
  const lines: { kind: ' ' | '+' | '-'; text: string }[] = a.slice(0, start).map((text) => ({ kind: ' ', text }))
  // Past this many, all of what's between shows as replaced: a table this size is for a whole new note, not a change.
  if (midA.length * midB.length > 4_000_000) {
    lines.push(...midA.map((text) => ({ kind: '-' as const, text })), ...midB.map((text) => ({ kind: '+' as const, text })))
  } else {
    const longest = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1))
    for (let i = midA.length - 1; i >= 0; i--) for (let j = midB.length - 1; j >= 0; j--) longest[i][j] = midA[i] === midB[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1])
    let i = 0
    let j = 0
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        lines.push({ kind: ' ', text: midA[i] })
        i++
        j++
      } else if (j < midB.length && (i === midA.length || longest[i][j + 1] >= longest[i + 1][j])) lines.push({ kind: '+', text: midB[j++] })
      else lines.push({ kind: '-', text: midA[i++] })
    }
  }
  lines.push(...a.slice(a.length - end).map((text) => ({ kind: ' ' as const, text })))
  return lines
}

/** A note's file: Binders' own fields in front matter, so the file alone can rebuild it, then the note as written. */
export function toMarkdown(note: Note) {
  const front = ['---', `id: ${note.id}`, `binder: ${note.binderId}`, ...(note.folderId ? [`folder: ${note.folderId}`] : [])]
  if (note.locked) front.push(`locked_by: ${note.locked.by}`)
  if (note.work?.length) front.push('work:', ...note.work.map((w) => `  - { item: ${w.itemId}, quote: ${JSON.stringify(w.quote)} }`))
  front.push('---', '')
  return front.join('\n') + note.text.replace(/\s*$/, '') + '\n'
}
