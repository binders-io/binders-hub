import { useMemo } from 'react'
import type { Agent, Card } from '../../data/model'
import { isListening, isOnline, useHub, usePresence } from '../../data/store'
import { asksOf } from '../../../../shared/work.ts'
import { AgentAvatar } from '../../components/bits'
import { href } from '../../route'
import { useUI } from '../../ui'
import { isModelAgent, modelReady } from '../../components/modelAgent'
import { RailSection } from './RailSection'

/** What an agent is doing, in a line: waiting on you, working on a card, or idle. */
function agentLine(agent: Agent, cards: Card[]) {
  // What it holds: cards it's working on, and cards it asked about, which wait in Blocked until someone answers.
  const holding = cards.filter((c) => c.agentId === agent.id && (c.stage === 'working' || c.stage === 'blocked'))
  const asking = holding.filter((c) => asksOf(c))
  const busy = holding.filter((c) => c.stage === 'working')
  if (asking.length) return `Waiting on you: ${asking[0].title}`
  if (busy.length) return `Working on ${busy[0].title}${busy.length > 1 ? ` and ${busy.length - 1} more` : ''}`
  return 'Idle'
}

/** The rail's second part: each agent in the hub, whether it's online, and what it's doing. A row opens the Agents page. */
export function AgentsNow() {
  const { binder } = useUI()
  const allAgents = useHub((state) => state.agents)
  const allCards = useHub((state) => state.cards)
  usePresence()
  const cards = useMemo(() => allCards.filter((c) => binder === 'all' || c.binderId === binder), [allCards, binder])
  const agents = useMemo(() => allAgents.filter((a) => !a.revoked), [allAgents])
  // Busiest first: asking you, working, listening, online, then the rest, as Home orders them.
  const order = (a: Agent) => (cards.some((c) => c.agentId === a.id && c.stage === 'blocked' && asksOf(c)) ? 0 : cards.some((c) => c.agentId === a.id && c.stage === 'working') ? 1 : isListening(a) ? 2 : isOnline(a) || (isModelAgent(a) && modelReady(a)) ? 3 : 4)
  const sorted = [...agents].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  return (
    <RailSection id="agents" title="Agents" count={agents.length}>
      {sorted.length ? (
        <ul className="brain-agents">
          {sorted.map((agent) => {
            // One the hub runs as a model has no runner to be online: it's ready, or it needs attention.
            const hosted = isModelAgent(agent)
            const online = hosted ? modelReady(agent) : isOnline(agent)
            const line = agentLine(agent, cards)
            return (
              <li key={agent.id}>
                <a href={href({ screen: 'agents' })}>
                  <AgentAvatar agent={agent} size={26} live={line.startsWith('Working')} />
                  <span className="brain-agent-text">
                    <span className="brain-agent-head"><b>{agent.name}</b><span className={`brain-online ${online ? 'on' : 'off'}`}><i aria-hidden="true" />{hosted ? (online ? 'Ready' : 'Needs attention') : online ? 'Online' : 'Offline'}</span></span>
                    <span className="brain-agent-doing">{line}</span>
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="faint brain-rail-none">No agents yet.</p>
      )}
    </RailSection>
  )
}
