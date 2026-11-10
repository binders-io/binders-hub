import type { Change, HubState } from './state.ts'
import type { BlastRadius, Challenge } from './changeSet.ts'
import { lightNote } from './notes.ts'
import { isOld, leftCard, type Card, type ChangeSet, type FileDiff, type PullRequest } from './work.ts'

// What a browser holds of the state: all of it but each note's text, the detail of each card that finished a while ago,
// the lines of its diffs, the older lines of each card's activity and the symbols of each Challenge's blast radius, which
// are most of its weight and which a screen asks for when they're opened. A finished card keeps what a list shows of it
// (shared/work.ts). A note keeps how it starts, its length and what it links to (shared/notes.ts), each file keeps
// its name and counts, so lists and totals still add up, a card says how many of its lines were left out, and a blast
// keeps its counts and says how many symbols it has. A note's changes on the live feed are sent whole: a browser that has
// the note's text takes the new one, and one that doesn't keeps what stands in for it. The Binder's history and its trash
// are left out altogether: they're asked for in Settings, when someone looks. The apps and agents that ask for the state as
// it is still get everything else.

/**
 * How far back every line of a card's activity is kept: two days and an hour. Home's chart of the day's work compares
 * with the same hours yesterday, so it reads back to the start of yesterday, and a day with the clocks changed is an
 * hour longer.
 */
export const recentActivityMs = 49 * 3_600_000

/** Beyond those, how many of a card's newest lines are kept, so even a quiet card shows how it ended. */
export const newestActivity = 12

/** Diffs that were in the log before files were checked, or came from a client, may not be lists: they're passed along. */
const listed = <T,>(files: T): T =>
  (Array.isArray(files) ? files.map((file: FileDiff) => (file?.lines?.length ? { ...file, lines: [] } : file)) : files) as T

const lightPull = (pull: PullRequest): PullRequest => (pull.files ? { ...pull, files: listed(pull.files) } : pull)

/** A card's activity as a browser holds it: the recent lines and the newest few, in their order, and how many were left out. */
function lightActivity(card: Card, now: number): Card {
  const lines = card.activity
  // From before activity was kept as a list, or sent by a client: passed along.
  if (!Array.isArray(lines) || lines.length <= newestActivity) return card
  const since = now - recentActivityMs
  const kept = lines.filter((line, at) => at >= lines.length - newestActivity || Date.parse(line?.at) >= since)
  return kept.length === lines.length ? card : { ...card, activity: kept, activityMore: lines.length - kept.length }
}

/** A blast radius without its symbols, which are the most of it, and how many there were. Anything else is passed along. */
const lightBlast = (blast: BlastRadius | undefined): BlastRadius | undefined =>
  Array.isArray(blast?.symbols) && blast.symbols.length ? { ...blast, symbols: [], symbolCount: blast.symbols.length } : blast

/** A Challenge as a browser holds it: the same, with a lighter blast radius when it has one. */
const lightChallenge = (challenge: Challenge | undefined): Challenge | undefined => {
  const blast = lightBlast(challenge?.blast)
  return challenge && blast !== challenge.blast ? { ...challenge, blast } : challenge
}

const lightCard = (card: Card, now: number): Card => {
  const trimmed = lightActivity(card, now)
  const challenge = lightChallenge(trimmed.challenge)
  const worked = challenge === trimmed.challenge ? trimmed : { ...trimmed, challenge }
  return worked.worktree?.files ? { ...worked, worktree: { ...worked.worktree, files: listed(worked.worktree.files) } } : worked
}

const lightSet = (set: ChangeSet): ChangeSet => {
  const challenge = lightChallenge(set.challenge)
  return challenge === set.challenge ? set : { ...set, challenge }
}

/**
 * The state without the Binder's history and trash, which are rarely looked at and up to a thousand lines and four hundred
 * notes and cards long: the apps ask for the state whole, and don't read either.
 */
export function withoutKept<S extends HubState>(state: S): S {
  const { history: _history, trashedNotes: _notes, trashedCards: _cards, ...rest } = state
  return rest as unknown as S
}

/** The state for a browser. `now` is the clock, for tests. */
export const lightState = <S extends HubState>(state: S, now = Date.now()): S => ({ ...withoutKept(state), notes: state.notes.map(lightNote), pulls: state.pulls.map(lightPull), changeSets: state.changeSets.map(lightSet), cards: state.cards.map((card) => (isOld(card, now) ? leftCard(lightCard(card, now)) : lightCard(card, now))) })

/** A change as the live feed sends it to a browser holding the light state. */
export function lightChange(change: Change, now = Date.now()): Change {
  switch (change.type) {
    case 'pr.put':
      return { ...change, pull: lightPull(change.pull) }
    case 'pr.update':
      return change.fields?.files ? { ...change, fields: { ...change.fields, files: listed(change.fields.files) } } : change
    case 'card.put':
      return { ...change, card: lightCard(change.card, now) }
    case 'set.put':
      return { ...change, set: lightSet(change.set) }
    case 'set.update': {
      const challenge = lightChallenge(change.fields?.challenge)
      return challenge === change.fields?.challenge ? change : { ...change, fields: { ...change.fields, challenge } }
    }
    // Who deleted it and when are for the trash, which a browser doesn't hold: its own copy of the change is the plain one.
    case 'note.delete':
    case 'card.delete':
      return { type: change.type, id: change.id }
    case 'card.update': {
      const worktree = change.fields?.worktree
      const challenge = lightChallenge(change.fields?.challenge)
      if (!worktree?.files && challenge === change.fields?.challenge) return change
      return {
        ...change,
        fields: { ...change.fields, ...(worktree?.files ? { worktree: { ...worktree, files: listed(worktree.files) } } : {}), ...(challenge !== change.fields?.challenge ? { challenge } : {}) },
      }
    }
    default:
      return change
  }
}
