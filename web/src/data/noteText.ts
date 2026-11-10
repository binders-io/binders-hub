import { headChars, isBlank, linksIn, type Note } from '../../../shared/notes.ts'

// What of a note a screen may read. A browser holds most notes without their text (`note.left` is set and `text` is
// empty), so a screen never reads `note.text` for itself: it asks here, and gets nothing back for a note whose text isn't
// here, so an empty text is never taken for the note's own.

type Text = Pick<Note, 'text' | 'left'>

/** The note's text, or undefined when it isn't here yet. */
export const textOf = (note: Text) => (note.left ? undefined : note.text)

/** How the note starts: the first characters of its text, from what stands in for it when the text isn't here. */
export const headOf = (note: Text) => (note.left ? note.left.head : note.text.slice(0, headChars))

/** How many characters the note has, here or not. */
export const sizeOf = (note: Text) => (note.left ? note.left.size : note.text.length)

const linked = new WeakMap<object, string[]>()

/** The notes a note's [[links]] name, in lower case. Worked out once for each version of a whole note: it's asked of every note on every change. */
export function linksOf(note: Text) {
  if (note.left) return note.left.links
  let titles = linked.get(note)
  if (!titles) {
    titles = linksIn(note.text).map((t) => t.toLowerCase())
    linked.set(note, titles)
  }
  return titles
}

/** Nothing written in it. A note whose text isn't here is never empty: its text is somewhere else. */
export const isEmpty = (note: Text) => !note.left && isBlank(note.text)
