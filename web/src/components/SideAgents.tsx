import { useState } from 'react'
import { ChevronRight, CircleAlert, SquareTerminal } from 'lucide-react'
import type { Agent, Card } from '../data/model'
import { isListening, isOnline, sameList, useActions, useHub, usePresence, type State } from '../data/store'
import { toolInfo } from '../../../shared/agents.ts'
import type { TerminalInfo } from '../../../shared/terminal.ts'
import { href } from '../route'
import { AgentAvatar, stageTone } from './bits'

const closedKey = 'binders-hub-side-agents-closed'

function readClosed(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(closedKey) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

const workingCards = (state: State) => state.cards.filter((c) => c.stage === 'working')

/** A terminal's name in a list: its own, else its tool's. */
export const terminalLabel = (session: TerminalInfo) => session.name || session.tool

/**
 * Who's working on what: each agent, how it stands, and under it the cards it holds (a question for you first) and,
 * on the agents you own, the terminals open on its machine, with a button to open one. Drop a card on an agent to give
 * it the card.
 */
export function SideAgents({ agents }: { agents: Agent[] }) {
  const { giveCard } = useActions()
  const working = useHub(workingCards, sameList)
  const terminals = useHub((state) => state.terminals)
  const me = useHub((state) => state.me?.user.login.toLowerCase())
  usePresence()
  const [closed, setClosed] = useState(readClosed)
  const [dropOn, setDropOn] = useState<string>()
  const toggle = (id: string) => {
    const next = new Set(closed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setClosed(next)
    try { window.localStorage.setItem(closedKey, JSON.stringify([...next])) } catch { /* only a convenience */ }
  }

  // Busiest first: asking you, then working, then online.
  const held = (agent: Agent) => working.filter((c) => c.agentId === agent.id)
    .sort((a, b) => Number(!!b.needsYou) - Number(!!a.needsYou) || b.updatedAt.localeCompare(a.updatedAt))
  const order = (agent: Agent) => {
    const cards = held(agent)
    return cards.some((c) => c.needsYou) ? 0 : cards.length ? 1 : isOnline(agent) ? 2 : 3
  }
  const sorted = [...agents].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))

  return (
    <div className="side-section side-agents">
      <h2>Agents</h2>
      {sorted.map((agent) => {
        const cards = held(agent)
        const mine = agent.owner.toLowerCase() === me
        const terminalTool = (agent.runner?.tool ?? 'claude') !== 'custom'
        const open = mine ? terminals[agent.id]?.sessions ?? [] : []
        const asks = cards.filter((c) => c.needsYou).length
        const has = cards.length + open.length > 0
        const shown = has && !closed.has(agent.id)
        const status = asks ? `${asks === 1 ? 'A question' : `${asks} questions`} for you`
          : cards.length ? (cards.length === 1 ? (cards[0].doing ?? 'Working') : `Working on ${cards.length}`)
            : isListening(agent) ? 'Listening for work' : isOnline(agent) ? 'Online' : 'Not connected'
        return (
          <div key={agent.id} className={`side-agent-group${dropOn === agent.id ? ' drop' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('text/binders-card')) { e.preventDefault(); setDropOn(agent.id) } }}
            onDragLeave={() => setDropOn(undefined)}
            onDrop={(e) => { e.preventDefault(); setDropOn(undefined); const id = e.dataTransfer.getData('text/binders-card'); if (id) giveCard(id, agent.id) }}>
            <div className="side-agent-row">
              <button type="button" className="side-agent-toggle" onClick={() => toggle(agent.id)} disabled={!has} aria-expanded={shown} aria-label={shown ? `Hide what ${agent.name} has` : `Show what ${agent.name} has`}>
                {has && <ChevronRight size={12} className={shown ? 'open' : ''} />}
              </button>
              <a className="side-agent" href={href({ screen: 'agents' })} title={`${agent.name}: drop a card here to give it to it`}>
                <AgentAvatar agent={agent} size={22} live={cards.length > 0} />
                <span className="side-agent-text">
                  <b>{agent.name}</b>
                  <span className={asks ? 'asks' : undefined}>{status}</span>
                </span>
                {isOnline(agent) && <i className="online" title="Online" />}
              </a>
              {mine && terminalTool && (
                <a className="side-terminal" href={href({ screen: 'terminal', id: agent.id })} title={`${toolInfo(agent.runner?.tool ?? 'claude').name} in a terminal on its machine`} aria-label={`Open ${agent.name} in a terminal`}>
                  <SquareTerminal size={14} />
                </a>
              )}
            </div>
            {shown && (
              <ul className="side-agent-items">
                {cards.map((card) => <CardItem key={card.id} card={card} />)}
                {open.map((session) => (
                  <li key={session.sid}>
                    <a href={href({ screen: 'terminal', id: agent.id, sid: session.sid })} title={session.dir}>
                      <SquareTerminal size={12} className="side-item-icon" />
                      <span>{terminalLabel(session)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      {!agents.length && <a className="side-empty" href={href({ screen: 'agents' })}>Set up an agent</a>}
    </div>
  )
}

function CardItem({ card }: { card: Card }) {
  return (
    <li>
      <a href={href({ screen: 'work', id: card.id })} title={card.needsYou ? `Asks: ${card.needsYou}` : card.doing ?? card.title} className={card.needsYou ? 'asks' : undefined}>
        {card.needsYou ? <CircleAlert size={12} className="side-item-icon" /> : <i className="side-item-dot" style={{ color: `var(--${stageTone[card.stage]})` }} />}
        <span>{card.title}</span>
      </a>
    </li>
  )
}
