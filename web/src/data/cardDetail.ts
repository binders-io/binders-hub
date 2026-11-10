import type { Change } from '../../../shared/state.ts'
import type { Card } from '../../../shared/work.ts'

// What of a card a screen may read. A browser holds a card that finished a while ago without its detail (`card.left` is
// set, its `brief` and `done-when` are empty, and it has no plan, debrief, Challenge, permission or activity), so a screen
// never reads those for itself: it asks here, and gets nothing back for a card whose detail isn't here, so an empty brief
// is never taken for the card's own.

type Detail = Pick<Card, 'left'>

/** Whether the card's detail is here. */
export const isWhole = (card: Detail) => !card.left

/** The card's brief, or undefined when it isn't here yet. */
export const briefOf = (card: Pick<Card, 'brief' | 'left'>) => (card.left ? undefined : card.brief ?? '')

/** What done looks like, or undefined when it isn't here yet. */
export const doneWhenOf = (card: Pick<Card, 'doneWhen' | 'left'>) => (card.left ? undefined : card.doneWhen ?? '')

/** How the card's debrief stands, here or from what stands in for it. */
export const debriefStateOf = (card: Pick<Card, 'debrief' | 'left'>) => (card.left ? card.left.debrief : card.debrief?.state)

/** How the card's Challenge stands, here or from what stands in for it. */
export const challengeStateOf = (card: Pick<Card, 'challenge' | 'left'>) => (card.left ? card.left.challenge : card.challenge?.state)

/** The fields a card whose detail isn't here must never send: what's here of them is empty, and the hub would take it as the card's. */
const unsent = ['brief', 'doneWhen'] as const

/**
 * A change to a card as it may go to the hub. For a card whose detail isn't here, a `card.put` is never sent, and a
 * `card.update` goes without its brief and done-when (and not at all when they were all it had): its stage, title, size and
 * who it's meant for still go. Any other change, or a card that has its detail, comes back as it was.
 */
export function guardCard(card: Card | undefined, change: Change): Change | undefined {
  if (!card?.left) return change
  if (change.type === 'card.put') return undefined
  if (change.type !== 'card.update' || !unsent.some((field) => field in change.fields)) return change
  const fields = { ...change.fields }
  for (const field of unsent) delete fields[field]
  return Object.keys(fields).length ? { ...change, fields } : undefined
}
