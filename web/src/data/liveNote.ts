import type { Entry } from '../../../shared/state.ts'
import type { NoteDoc, TextEdit } from '../../../shared/noteDoc.ts'

// The note open in the editor, as an Automerge document (shared/noteDoc.ts): what you type becomes changes to it, sent
// in a note.edit, and the changes in teammates' edits from the live feed go into it, so two people typing in the same
// paragraph both keep their words. The editor shows the document's text, and is told each change in it as edits, so
// your caret stays where you were typing.
//
// The document comes from the hub (`GET /api/notes/:id/doc`), with this tab's changes it hasn't confirmed yet on top. A
// note made here and not yet confirmed starts from its first text, as the hub will start it. Until the document is
// here (offline, say), what you type goes as the whole text, which the hub makes into changes; the document is taken
// once those have gone.
//
// Automerge is several megabytes of WebAssembly, so it's fetched with the first note opened, not with the app. Failing
// to fetch it is like not having the document yet: what you type goes as the whole text until it's here.

let docs: typeof import('../../../shared/noteDoc.ts') | undefined

/** Automerge, loaded. Anything with a document has it, so `docs!` below is safe wherever `this.doc` is set. */
export async function loadDocs() {
  docs ??= await import('../../../shared/noteDoc.ts')
  return docs
}

/** What a live note needs from the store. */
export interface Source {
  /** The note's document as the hub has it now; undefined when it can't be had (offline, or not on the hub yet). */
  fetchDoc: (noteId: string) => Promise<Uint8Array | undefined>
  /** This tab's changes to the note the hub hasn't confirmed yet. */
  waiting: (noteId: string) => Waiting
}

export interface Waiting {
  /** The note's first text, when this tab made it and the hub hasn't confirmed it yet. */
  created?: string
  /** Automerge changes in edits waiting, in order. */
  changes: string[]
  /** An edit waiting as the whole text, made before the document was here. */
  whole: boolean
}

/** Edits to make in the editor, then the text it should have; no edits means take the text as it is. */
export type Listener = (edits: TextEdit[] | undefined, text: string) => void

const retryMs = 1000

export class LiveNote {
  private doc?: NoteDoc
  /** Changes heard before the document was here. */
  private heard: string[] = []
  private listeners = new Set<Listener>()
  private loading?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  readonly noteId: string
  private source: Source

  constructor(noteId: string, source: Source) {
    this.noteId = noteId
    this.source = source
  }

  get ready() {
    return !!this.doc
  }

  get text() {
    return this.doc ? docs!.textOf(this.doc) : undefined
  }

  /** Called with each change to the text, and once when the document is here. */
  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Gets the document: from the hub, or made here for a note the hub doesn't have yet. */
  open(): Promise<void> {
    if (this.doc || this.closed) return Promise.resolve()
    this.loading ??= this.load().finally(() => (this.loading = undefined))
    return this.loading
  }

  private async load() {
    const am = await loadDocs().catch(() => undefined)
    if (this.closed) return
    if (!am) {
      this.later()
      return
    }
    let doc: NoteDoc | undefined
    const before = this.source.waiting(this.noteId)
    if (!before.whole) {
      if (before.created !== undefined) doc = am.editable(am.noteDoc(this.noteId, before.created))
      else {
        const bytes = await this.source.fetchDoc(this.noteId).catch(() => undefined)
        if (bytes) doc = am.load(bytes)
      }
    }
    if (this.closed) return
    // Typed as whole text meanwhile: wait for that to go, or the same words would go twice.
    const waiting = this.source.waiting(this.noteId)
    if (!doc || waiting.whole) {
      this.later()
      return
    }
    try {
      doc = am.applyChanges(doc, [...waiting.changes, ...this.heard])
    } catch {
      this.later()
      return
    }
    this.heard = []
    this.doc = doc
    this.tell(undefined)
  }

  private later() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.open(), retryMs)
  }

  /** What you typed, as the editor made it. Returns the change to send, or undefined when it changed nothing. */
  edit(edits: TextEdit[]): string | undefined {
    if (!this.doc) return undefined
    try {
      const made = docs!.edit(this.doc, edits)
      this.doc = made.doc
      return made.change
    } catch {
      // Out of step with the editor, which shouldn't be: the hub's document puts it right.
      void this.reset()
      return undefined
    }
  }

  /** Changes from an edit in the live feed, ours or a teammate's: ones the document has already change nothing. */
  hear(changes: string[]) {
    if (!this.doc) {
      this.heard.push(...changes)
      return
    }
    const am = docs!
    const before = am.heads(this.doc)
    try {
      this.doc = am.applyChanges(this.doc, changes)
    } catch {
      void this.reset()
      return
    }
    if (!am.sameHeads(before, am.heads(this.doc))) this.tell(am.editsSince(this.doc, before))
  }

  /** The hub's document again, merged with this one: after the live feed was missed, nothing is lost either way. */
  async refresh() {
    if (!this.doc) return this.open()
    const bytes = await this.source.fetchDoc(this.noteId).catch(() => undefined)
    if (!bytes || !this.doc || this.closed) return
    const am = docs!
    const before = am.heads(this.doc)
    try {
      this.doc = am.merge(this.doc, am.load(bytes))
    } catch {
      // Not the same document any more (the note was written again whole): start over from the hub's.
      return this.reset()
    }
    if (!am.sameHeads(before, am.heads(this.doc))) this.tell(am.editsSince(this.doc, before))
  }

  /** Drops this document for the hub's: after the hub refused our changes, or the note was written again whole. */
  reset() {
    this.doc = undefined
    this.heard = []
    return this.open()
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private tell(edits: TextEdit[] | undefined) {
    const text = docs!.textOf(this.doc!)
    for (const listener of this.listeners) listener(edits, text)
  }
}

/** The notes open in editors in this tab, kept in step with the live feed. */
export class LiveNotes {
  private open = new Map<string, { live: LiveNote; users: number }>()
  private source: Source

  constructor(source: Source) {
    this.source = source
  }

  /** The note's live document, shared by every editor of it in this tab; `release` when done with it. */
  take(noteId: string) {
    const known = this.open.get(noteId)
    if (known) {
      known.users++
      return known.live
    }
    const live = new LiveNote(noteId, this.source)
    this.open.set(noteId, { live, users: 1 })
    void live.open()
    return live
  }

  release(live: LiveNote) {
    const known = this.open.get(live.noteId)
    if (!known || known.live !== live || --known.users > 0) return
    this.open.delete(live.noteId)
    live.close()
  }

  get(noteId: string) {
    return this.open.get(noteId)?.live
  }

  /** Entries from the live feed: edits' changes go into their notes; a note someone else wrote again whole starts over. */
  hear(entries: Entry[], mine: (entry: Entry) => boolean) {
    for (const entry of entries) {
      const change = entry.change
      if (change.type === 'note.edit' && change.changes?.length) this.get(change.id)?.hear(change.changes)
      else if (change.type === 'note.edit' && !change.changes && !mine(entry)) void this.get(change.id)?.reset()
      else if (change.type === 'note.put' && !mine(entry)) void this.get(change.note.id)?.reset()
    }
  }

  /** After a snapshot of the hub's state, when the feed between was missed. */
  refresh() {
    for (const { live } of this.open.values()) void live.refresh()
  }

  reset(noteIds: Iterable<string>) {
    for (const id of noteIds) void this.get(id)?.reset()
  }
}
