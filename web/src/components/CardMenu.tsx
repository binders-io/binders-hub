import { createElement } from 'react'
import { ArrowUpRight, GitFork, Link2, MoreHorizontal, Send, Square, Trash2 } from 'lucide-react'
import type { Card } from '../data/model'
import { useActions, type Actions } from '../data/store'
import { href } from '../route'
import { attempt, failure, toast } from './Toast'
import { AgentAvatar } from './bits'
import { openMenuUnder, type MenuItem } from './ContextMenu'
import { useMayChangeBinder } from '../screens/settings/access'

/** Where a person can move a card by hand. The card's page and its ⋯ menu both list these, so they can't differ. */
export interface Move {
  stage: Card['stage']
  title: string
  /** Its words in the ⋯ menu, where there's room to say more. */
  menu?: string
}

export const stageMoves: Move[] = [
  { stage: 'proposed', title: 'Proposed' }, { stage: 'ready', title: 'Ready' }, { stage: 'blocked', title: 'Blocked' }, { stage: 'review', title: 'In review' }, { stage: 'live', title: 'Done' },
]

/** Only a blocked card an agent holds goes back to its agent working. */
const carryOn: Move = { stage: 'working', title: 'Carry on', menu: 'Agents working (carry on)' }

/** The moves a card has, the one it's in included: a page greys that one out, a menu leaves it off. */
export const movesOf = (card: Pick<Card, 'stage' | 'agentId'>): Move[] => [...stageMoves, ...(card.stage === 'blocked' && card.agentId ? [carryOn] : [])]

/** What to ask before a move that takes a card from the agent holding it and stops its run, or nothing when it doesn't. */
export function moveAsk(card: Pick<Card, 'stage' | 'agentId'>, stage: Card['stage'], holder?: string) {
  const held = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
  return held && stage === 'ready' ? `Take it from ${holder ?? 'the agent'} and stop its run? Press again` : undefined
}

/** Puts a card's link on the clipboard, and says so. */
export const copyCardLink = (id: string) => {
  const link = new URL(href({ screen: 'work', id }), window.location.href).toString()
  void navigator.clipboard.writeText(link).then(() => toast('Link copied.'), () => failure('Couldn’t copy the link.'))
}

/** Stops the agent holding a card and says where the card went: back in Proposed, where nothing takes it. */
export async function stopHolding(card: Card, store: Actions) {
  const holder = store.current().agents.find((a) => a.id === card.agentId)?.name ?? 'the agent'
  const stopped = await attempt(async () => {
    await store.stopCard(card.id)
    return true
  })
  if (stopped) toast(`Stopped ${holder}. It waits in Proposed.`)
}

/**
 * What can be done to a card, for its ⋯ on the board and a right-click on it anywhere: open it, copy its link, move
 * it, give it to an agent, nudge the one holding it, or delete it.
 */
export function cardMenuItems(card: Card, store: Actions, open: (id: string) => void, split?: () => void, mayChange = true): MenuItem[] {
  const state = store.current()
  // A reader opens a card and copies its link: moving, giving, nudging, stopping and deleting change the Binder.
  if (!mayChange) return [
    { label: 'Open', icon: createElement(ArrowUpRight, { size: 13 }), onSelect: () => open(card.id) },
    { label: 'Copy link', icon: createElement(Link2, { size: 13 }), onSelect: () => copyCardLink(card.id) },
  ]
  const held = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
  const holder = state.agents.find((a) => a.id === card.agentId)
  return [
    { label: 'Open', icon: createElement(ArrowUpRight, { size: 13 }), onSelect: () => open(card.id) },
    { label: 'Copy link', icon: createElement(Link2, { size: 13 }), onSelect: () => copyCardLink(card.id) },
    { separator: true },
    { heading: 'Move to' },
    ...movesOf(card).filter((m) => m.stage !== card.stage).map((m): MenuItem => ({ label: m.menu ?? m.title, onSelect: () => store.moveCard(card.id, m.stage), confirm: moveAsk(card, m.stage, holder?.name) })),
    { heading: 'Give to' },
    ...state.agents.filter((a) => !a.revoked && a.id !== card.agentId).map((a): MenuItem => ({ label: a.name, icon: createElement(AgentAvatar, { agent: a, size: 16 }), onSelect: () => store.giveCard(card.id, a.id) })),
    ...(card.meantFor ? [{ label: 'Any agent', onSelect: () => store.giveCard(card.id, '') }] : []),
    ...(held && !card.needsYou ? [{ label: `Nudge ${holder?.name ?? 'the agent'}`, icon: createElement(Send, { size: 13 }), onSelect: () => void attempt(() => store.comment(card.id, 'Carry on with this card.')) }] : []),
    ...(held ? [{ label: 'Stop', icon: createElement(Square, { size: 13 }), onSelect: () => void stopHolding(card, store) }] : []),
    ...(split && !card.parent && card.stage === 'ready' && !card.agentId && !state.cards.some((c) => c.parent === card.id)
      ? [{ label: 'Split for a swarm…', icon: createElement(GitFork, { size: 13 }), onSelect: () => split() }]
      : []),
    { separator: true },
    { label: 'Delete', icon: createElement(Trash2, { size: 13 }), danger: true, confirm: 'Delete it? Press again', onSelect: () => store.deleteCard(card.id) },
  ]
}

/** A card's ⋯ on the board: the same menu as a right-click on it, drawn under the button. */
export function CardMenu({ card, open, split }: { card: Card; open: (id: string) => void; split?: () => void }) {
  const store = useActions()
  const may = useMayChangeBinder()
  return (
    <div className="card-menu" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="card-menu-button" aria-label={`Actions for ${card.title}`} aria-haspopup="menu" onClick={(event) => openMenuUnder(event, cardMenuItems(card, store, open, split, may))}>
        <MoreHorizontal size={15} />
      </button>
    </div>
  )
}
