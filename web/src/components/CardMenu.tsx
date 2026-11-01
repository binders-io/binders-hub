import { createElement } from 'react'
import { ArrowUpRight, Link2, MoreHorizontal, Send, Trash2 } from 'lucide-react'
import type { Card } from '../data/model'
import { useActions, type Actions } from '../data/store'
import { href } from '../route'
import { attempt, toast } from './Toast'
import { AgentAvatar } from './bits'
import { openMenuUnder, type MenuItem } from './ContextMenu'

const moves: { stage: Card['stage']; title: string }[] = [
  { stage: 'proposed', title: 'Proposed' }, { stage: 'ready', title: 'Ready' }, { stage: 'blocked', title: 'Blocked' }, { stage: 'review', title: 'In review' }, { stage: 'live', title: 'Done' },
]

/**
 * What can be done to a card, for its ⋯ on the board and a right-click on it anywhere: open it, copy its link, move
 * it, give it to an agent, nudge the one holding it, or delete it.
 */
export function cardMenuItems(card: Card, store: Actions, open: (id: string) => void): MenuItem[] {
  const state = store.current()
  const held = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
  const holder = state.agents.find((a) => a.id === card.agentId)
  const link = new URL(href({ screen: 'work', id: card.id }), window.location.href).toString()
  return [
    { label: 'Open', icon: createElement(ArrowUpRight, { size: 13 }), onSelect: () => open(card.id) },
    { label: 'Copy link', icon: createElement(Link2, { size: 13 }), onSelect: () => void navigator.clipboard.writeText(link).then(() => toast('Link copied.'), () => toast('Couldn’t copy the link.')) },
    { separator: true },
    { heading: 'Move to' },
    ...moves.filter((m) => m.stage !== card.stage).map((m): MenuItem => ({ label: m.title, onSelect: () => store.moveCard(card.id, m.stage) })),
    ...(card.stage === 'blocked' && card.agentId ? [{ label: 'Agents working (carry on)', onSelect: () => store.moveCard(card.id, 'working') }] : []),
    { heading: 'Give to' },
    ...state.agents.filter((a) => !a.revoked && a.id !== card.agentId).map((a): MenuItem => ({ label: a.name, icon: createElement(AgentAvatar, { agent: a, size: 16 }), onSelect: () => store.giveCard(card.id, a.id) })),
    ...(card.meantFor ? [{ label: 'Any agent', onSelect: () => store.giveCard(card.id, '') }] : []),
    ...(held && !card.needsYou ? [{ label: `Nudge ${holder?.name ?? 'the agent'}`, icon: createElement(Send, { size: 13 }), onSelect: () => void attempt(() => store.comment(card.id, 'Carry on with this card.')) }] : []),
    { separator: true },
    { label: 'Delete', icon: createElement(Trash2, { size: 13 }), danger: true, confirm: 'Delete it? Press again', onSelect: () => store.deleteCard(card.id) },
  ]
}

/** A card's ⋯ on the board: the same menu as a right-click on it, drawn under the button. */
export function CardMenu({ card, open }: { card: Card; open: (id: string) => void }) {
  const store = useActions()
  return (
    <div className="card-menu" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="card-menu-button" aria-label={`Actions for ${card.title}`} aria-haspopup="menu" onClick={(event) => openMenuUnder(event, cardMenuItems(card, store, open))}>
        <MoreHorizontal size={15} />
      </button>
    </div>
  )
}
