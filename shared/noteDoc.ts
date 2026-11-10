import * as A from '@automerge/automerge'
import { titleOf, type Change, type NotesState } from './notes.ts'

// A note as an Automerge document, so two people typing in the same paragraph both keep their words. The hub keeps one
// per note; a `note.edit` carries Automerge changes to it, and the hub, the web app and Binders for Mac apply them the
// same way.
//
// The document is laid out as Binders for Mac's NoteDocument has it: `text`, the note's Markdown, and `props`, what
// travels with it. Its first change, the skeleton that makes them, is made under the note's own actor at time 0, so it's
// the same change everywhere. A note starts its document from its text as it is when the document is first needed: a
// second change of the note's actor, at time 0 too, puts the text in, so anyone with the note's id and that text makes
// the same two changes. Every change after them is made under an actor of its own.

export type NoteDoc = A.Doc<{ text: string; props: Record<string, unknown> }>

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The note's own actor: its id's bytes when the id is a UUID (as the Mac's are), else the id itself in UTF-8. */
export function noteActor(noteId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noteId)
  return uuid ? noteId.replace(/-/g, '').toLowerCase() : hex(new TextEncoder().encode(noteId))
}

/** A fresh actor for one writer's changes: random, so no two writers ever write as one. */
export const newActor = () => hex(crypto.getRandomValues(new Uint8Array(16)))

/** A note's document, the same everywhere for the same id and text: the skeleton, then the text when there is some. */
export function noteDoc(noteId: string, text: string): NoteDoc {
  const skeleton = A.change(A.init<{ text: string; props: Record<string, unknown> }>({ actor: noteActor(noteId) }), { time: 0 }, (d) => {
    d.text = ''
    d.props = {}
  })
  return text ? A.change(skeleton, { time: 0 }, (d) => A.updateText(d, ['text'], text)) : skeleton
}

export const textOf = (doc: NoteDoc) => String(doc.text ?? '')

/** The changes that take the document to `text`, made under `actor` on a copy: the document given is left as it was. */
export function changesTo(doc: NoteDoc, text: string, actor: string = newActor()): string[] {
  if (textOf(doc) === text) return []
  const next = A.change(A.clone(doc, { actor }), (d) => A.updateText(d, ['text'], text))
  const change = A.getLastLocalChange(next)
  return change ? [toBase64(change)] : []
}

/** The changes, in order, applied: ones it has already change nothing. */
export const applyChanges = (doc: NoteDoc, changes: string[]) => A.applyChanges(doc, changes.map(fromBase64))[0]

/**
 * A change to a note's text as an editor makes it: replace `from` to `to` with `insert`. Positions count UTF-16 code
 * units, as JavaScript strings, CodeMirror and Automerge's JavaScript do. In a list, each is made after the ones before.
 */
export interface TextEdit {
  from: number
  to: number
  insert: string
}

/** The document to edit from, under a fresh actor of its own. */
export const editable = (doc: NoteDoc): NoteDoc => A.clone(doc, { actor: newActor() })

/** Edits made on the document, as one change to send; no change when they change nothing. */
export function edit(doc: NoteDoc, edits: TextEdit[]): { doc: NoteDoc; change?: string } {
  const before = A.getHeads(doc)
  const next = A.change(doc, (d) => {
    for (const e of edits) A.splice(d, ['text'], e.from, e.to - e.from, e.insert)
  })
  const change = A.getLastLocalChange(next)
  return sameHeads(before, A.getHeads(next)) || !change ? { doc: next } : { doc: next, change: toBase64(change) }
}

/**
 * What changed in the text since `before` (the document's heads then), as edits in order; undefined when it can't be
 * said that way (the text written whole), so the editor takes the text as it is.
 */
export function editsSince(doc: NoteDoc, before: A.Heads): TextEdit[] | undefined {
  const edits: TextEdit[] = []
  for (const patch of A.diff(doc, before, A.getHeads(doc))) {
    if (patch.path[0] !== 'text') continue
    const at = patch.path[1]
    if (patch.path.length !== 2 || typeof at !== 'number') return undefined
    if (patch.action === 'splice') edits.push({ from: at, to: at, insert: patch.value })
    else if (patch.action === 'del') edits.push({ from: at, to: at + (patch.length ?? 1), insert: '' })
    else return undefined
  }
  return edits
}

/** Two documents of the same note, together: what either has, both keep. */
export const merge = (doc: NoteDoc, other: NoteDoc): NoteDoc => A.merge(doc, other)

export const heads = (doc: NoteDoc) => A.getHeads(doc)
export const sameHeads = (a: A.Heads, b: A.Heads) => a.length === b.length && a.every((h) => b.includes(h))

export interface CheckedChanges {
  /** Changes that build on something the document doesn't have (yet). */
  missing: string[]
  /** Changes made under the note's own actor, which only ever makes its first two. */
  forged: boolean
}

/** Whether these changes can be applied to the document now: each one's deps are in it, or come earlier in the list. */
export function check(doc: NoteDoc, noteId: string, changes: string[]): CheckedChanges {
  const own = noteActor(noteId)
  const coming = new Set<string>()
  const missing = new Set<string>()
  let forged = false
  for (const change of changes) {
    const decoded = A.decodeChange(fromBase64(change))
    if (decoded.actor === own) forged = true
    for (const dep of decoded.deps) if (!coming.has(dep) && !A.hasHeads(doc, [dep])) missing.add(dep)
    if (decoded.hash) coming.add(decoded.hash)
  }
  return { missing: [...missing], forged }
}

/**
 * Every note's document, kept in step with the log. A document is made when it's first needed, from the note's text
 * at that point in the log, so every reader of the same log makes the same one.
 */
export class NoteDocs {
  private docs = new Map<string, NoteDoc>()
  /** Notes whose document changed, or went, since `takeChanged` was last asked: what there is to save. */
  private changed = new Set<string>()

  /** A document kept from before, put back as it was saved. */
  put(noteId: string, doc: NoteDoc) {
    this.docs.set(noteId, doc)
  }

  /** The note's document if it has one already: none is made. */
  peek(noteId: string): NoteDoc | undefined {
    return this.docs.get(noteId)
  }

  /** Sets a note's document aside: the next one starts from the note's text. */
  drop(noteId: string) {
    if (this.docs.delete(noteId)) this.changed.add(noteId)
  }

  /** Every document counts as changed: for the first time they're saved. */
  changeAll() {
    for (const id of this.docs.keys()) this.changed.add(id)
  }

  /**
   * What changed since this was last asked: each note's document as it is now, or undefined where it has none any
   * more. A document made from a note's text and not edited since isn't among them: it's made again the same.
   */
  takeChanged(): Map<string, NoteDoc | undefined> {
    const out = new Map<string, NoteDoc | undefined>()
    for (const id of this.changed) out.set(id, this.docs.get(id))
    this.changed.clear()
    return out
  }

  /** Counts these as changed again: saving them failed, so they're tried with the next save. */
  changedAgain(ids: Iterable<string>) {
    for (const id of ids) this.changed.add(id)
  }

  /** The note's document, made from its text now if it has none yet; undefined for a note that isn't there. */
  get(state: NotesState, noteId: string): NoteDoc | undefined {
    const known = this.docs.get(noteId)
    if (known) return known
    const note = state.notes.find((n) => n.id === noteId)
    if (!note) return undefined
    const doc = noteDoc(noteId, note.text)
    this.docs.set(noteId, doc)
    return doc
  }

  /**
   * A change from the log, before it's applied to `state`: an edit's Automerge changes go into the note's document,
   * and the edit comes back with the note's text and title as the document has them now, merged with everyone else's.
   * Text written whole (a note put again, or an edit from before Automerge) sets the document aside, and the next one
   * starts from that text. Which notes have a document then follows from the log alone, so every reader agrees.
   */
  apply<C extends { type: string }>(state: NotesState, given: C): C {
    const change = given as unknown as Change
    switch (change.type) {
      case 'note.edit': {
        if (!change.changes) {
          this.drop(change.id)
          return given
        }
        const doc = this.get(state, change.id)
        if (!doc) return given
        const next = applyChanges(doc, change.changes)
        this.docs.set(change.id, next)
        this.changed.add(change.id)
        const text = textOf(next)
        return { ...given, text, title: titleOf(text) }
      }
      case 'note.put':
        this.drop(change.note.id)
        return given
      case 'note.delete':
        this.drop(change.id)
        return given
      default:
        return given
    }
  }
}

/** The document whole, as Automerge saves it: what a client edits from. */
export const save = (doc: NoteDoc) => A.save(doc)
export const load = (bytes: Uint8Array, actor: string = newActor()): NoteDoc => A.load(bytes, { actor })

// Changes travel in JSON as base64. btoa and atob are in browsers and in Node alike.
export function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}
