import { titleOf, type Note, type NotesState } from './notes.ts'

// What an agent is told before it does anything in a binder: how Binders works, which the hub writes so it always
// matches this version; the binder's guide, a note the team and its agents keep; and where to look, worked out from the
// binder as it is now so it can't go stale. Only ever the binder's own: one binder's notes don't reach another's agents.

/** The most of a guide every run is given, and of the map. Every run pays for these in tokens. */
export const guideMost = 4_000
const mapMost = 3_000

export const howBindersWorks = `This binder's notes are the team's shared knowledge base, kept by the agents doing the work as much as by people. When you learn something the next agent will need (a decision, a rule, how something works), put it in the note it belongs in, or a new one, as part of finishing your work: edit_note, append_to_note or create_note (with the binders command: binders note-append). Keep it short and correct what's out of date.
Some notes are locked: people have settled them. You can't edit those. Follow them, and if one is wrong or out of date, propose_note_change with why, for a person to review (binders note-propose).
get_note reads any note below by its id or title, with the notes it links to.`

export const guideTemplate = (binder: string) => `# ${binder} guide

Every agent working in this binder reads this first. Keep it short, and link to the rest with [[links]].

## What this is

What the project is, who it's for, and what matters most right now.

## How we work

The few rules that apply to everything.

## Where things are

The notes worth reading first, as [[links]].
`

/** What a binder's guide says, within what every run is given. Past that, the note is there to read in full. */
export function guideOf(state: Pick<NotesState, 'binders' | 'notes'>, binderId: string) {
  const id = state.binders.find((b) => b.id === binderId)?.guideNoteId
  const note = id ? state.notes.find((n) => n.id === id && n.binderId === binderId) : undefined
  if (!note) return undefined
  const words = note.text.trim()
  const cut = words.length > guideMost
  return { note, text: cut ? `${words.slice(0, guideMost)}\n\n(The guide goes on: get_note ${note.id} has the rest.)` : words }
}

const marked = (note: Note) => `${titleOf(note.text)} (${note.id})${note.locked ? ', locked' : ''}`

/** The binder's notes by folder, newest first in each, within what every run is given. */
function mapOf(state: NotesState, binderId: string, skip?: string) {
  const newest = (a: Note, b: Note) => (b.editedAt ?? '').localeCompare(a.editedAt ?? '')
  const notes = state.notes.filter((n) => n.binderId === binderId && n.id !== skip).sort(newest)
  const folderPath = (id?: string): string => {
    const folder = state.folders.find((f) => f.id === id && f.binderId === binderId)
    return folder ? [folderPath(folder.parentId), folder.name].filter(Boolean).join(' / ') : ''
  }
  const places = new Map<string, Note[]>()
  for (const note of notes) {
    const place = folderPath(note.folderId)
    places.set(place, [...(places.get(place) ?? []), note])
  }
  const lines: string[] = []
  let used = 0
  let left = 0
  for (const place of [...places.keys()].sort()) {
    for (const [index, note] of places.get(place)!.entries()) {
      const line = `${index === 0 && place ? `${place}: ` : place ? '  ' : ''}${marked(note)}`
      if (used + line.length > mapMost) {
        left++
        continue
      }
      used += line.length
      lines.push(line)
    }
  }
  return { lines, left }
}

/** All three, as an agent reads them. `noteId`: the note its work came from. */
export function binderContext(state: NotesState, binderId: string, noteId?: string) {
  const binder = state.binders.find((b) => b.id === binderId)
  if (!binder) return ''
  const guide = guideOf(state, binderId)
  const { lines, left } = mapOf(state, binderId, guide?.note.id)
  const yours = noteId ? state.notes.find((n) => n.id === noteId && n.binderId === binderId) : undefined
  return [
    '## How to work in Binders',
    howBindersWorks,
    '',
    `## This binder: ${binder.name}`,
    guide ? guide.text : 'It has no guide yet. If you learn what the next agent should read first, tell a person.',
    ...(guide?.note.locked ? [`(This guide is locked. To change it, propose_note_change on ${guide.note.id}.)`] : guide ? [`(You can improve this guide: it's note ${guide.note.id}.)`] : []),
    '',
    '## Where to look',
    ...(binder.repo ? [`Repo: ${binder.repo} (its brief: get_repo_brief)`] : []),
    ...(yours ? [`The note your work came from: ${marked(yours)}`] : []),
    ...(lines.length ? ['Notes:', ...lines] : ['No other notes yet.']),
    ...(left ? [`${left} more: list_notes has them.`] : []),
  ].join('\n')
}
