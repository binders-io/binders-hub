import type { Change, HubState } from './state.ts'
import type { Card, FileDiff, PullRequest } from './work.ts'

// What a browser holds of the state: all of it but the lines of its diffs, which are most of its weight and which a
// screen asks for when they're opened. Each file keeps its name and counts, so lists and totals still add up. The apps
// and agents that ask for the state as it is still get all of it.

/** Diffs that were in the log before files were checked, or came from a client, may not be lists: they're passed along. */
const listed = <T,>(files: T): T =>
  (Array.isArray(files) ? files.map((file: FileDiff) => (file?.lines?.length ? { ...file, lines: [] } : file)) : files) as T

const lightPull = (pull: PullRequest): PullRequest => (pull.files ? { ...pull, files: listed(pull.files) } : pull)
const lightCard = (card: Card): Card => (card.worktree?.files ? { ...card, worktree: { ...card.worktree, files: listed(card.worktree.files) } } : card)

export const lightState = <S extends HubState>(state: S): S => ({ ...state, pulls: state.pulls.map(lightPull), cards: state.cards.map(lightCard) })

/** A change as the live feed sends it to a browser holding the light state. */
export function lightChange(change: Change): Change {
  switch (change.type) {
    case 'pr.put':
      return { ...change, pull: lightPull(change.pull) }
    case 'pr.update':
      return change.fields?.files ? { ...change, fields: { ...change.fields, files: listed(change.fields.files) } } : change
    case 'card.put':
      return { ...change, card: lightCard(change.card) }
    case 'card.update': {
      const worktree = change.fields?.worktree
      return worktree?.files ? { ...change, fields: { ...change.fields, worktree: { ...worktree, files: listed(worktree.files) } } } : change
    }
    default:
      return change
  }
}
