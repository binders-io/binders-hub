import { useMemo } from 'react'
import { motion } from 'motion/react'
import { ArrowUpRight, CircleCheck, GitPullRequest, Hand, Inbox, MessageCircleQuestion, Play, Sparkles, type LucideIcon } from 'lucide-react'
import type { Agent, Card } from '../data/model'
import { isListening, isOnline, nameFor, sameList, useHub, usePresence } from '../data/store'
import { sessionLines } from '../data/session'
import { AgentAvatar, Progress, Who, ago } from '../components/bits'
import { Terminal } from '../components/Terminal'
import { AgentActivity } from '../components/AgentActivity'
import { toolInfo } from '../../../shared/agents.ts'
import { useUI } from '../ui'
import { runnerState } from '../components/runnerState'
import { go, href } from '../route'
import { isPersonal, PersonalRepo } from '../components/PersonalRepo'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Home: what the agents are doing right now, each with its cards and a live view of its session, what waits on you, and
 * what's been happening. For the binder you're in, or all of them.
 */
export function Home() {
  const { binder, openItem } = useUI()
  const allCards = useHub((state) => state.cards)
  const allAgents = useHub((state) => state.agents)
  const allProposals = useHub((state) => state.proposals)
  const changeSets = useHub((state) => state.changeSets)
  usePresence()
  const here = (binderId: string) => binder === 'all' || binderId === binder
  const chats = useHub((state) => (state.chats ?? []).filter((c) => here(state.notes.find((n) => n.id === c.noteId)?.binderId ?? '')), sameList)
  const cards = useMemo(() => allCards.filter((c) => binder === 'all' || c.binderId === binder), [allCards, binder])
  const agents = useMemo(() => allAgents.filter((a) => !a.revoked), [allAgents])
  const working = cards.filter((c) => c.stage === 'working')
  const asks = cards.filter((c) => c.needsYou)
  const proposals = allProposals.filter((p) => p.state === 'new' && here(p.binderId))
  const sets = changeSets.filter((s) => s.state === 'review' && here(s.binderId))
  const ready = cards.filter((c) => c.stage === 'ready')
  const doneToday = cards.filter((c) => (c.stage === 'live' || c.stage === 'review') && c.updatedAt.startsWith(today()))
  // Busiest first: working, then listening, then the rest.
  const order = (a: Agent) => (cards.some((c) => c.agentId === a.id && c.stage === 'working') ? 0 : isListening(a) ? 1 : isOnline(a) ? 2 : 3)
  const sorted = [...agents].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  const feed = useMemo(() => cards
    .flatMap((card) => card.activity.filter((a) => a.kind !== 'step' && a.kind !== 'said' && a.kind !== 'ran').map((a) => ({ ...a, card })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30), [cards])

  return (
    <div className="home">
      {isPersonal && <PersonalRepo />}
      <section className="home-stats" aria-label="Now">
        <Stat icon={Play} label="Working now" value={working.length} detail={`${new Set(working.map((c) => c.agentId)).size} agent${new Set(working.map((c) => c.agentId)).size === 1 ? '' : 's'}`} tone="blue" onClick={() => go({ screen: 'flow' })} />
        <Stat icon={Hand} label="Waiting on you" value={asks.length + proposals.length + sets.length} detail={[asks.length && `${asks.length} question${asks.length === 1 ? '' : 's'}`, proposals.length && `${proposals.length} proposed`, sets.length && `${sets.length} to approve`].filter(Boolean).join(' · ') || 'Nothing'} tone="amber" onClick={() => (asks[0] ? openItem(asks[0].id) : go({ screen: 'flow' }))} />
        <Stat icon={Inbox} label="Ready" value={ready.length} detail="for the next agent free" onClick={() => go({ screen: 'flow' })} />
        <Stat icon={CircleCheck} label="Done today" value={doneToday.length} detail={`${doneToday.length === 1 ? 'card' : 'cards'} to review or shipped`} tone="green" />
      </section>

      <AgentActivity agents={agents} cards={cards} chats={chats} />

      <div className="home-body">
        <section className="home-agents" aria-label="Agents">
          {sorted.map((agent) => <AgentTile key={agent.id} agent={agent} cards={cards} onOpen={openItem} />)}
          {!agents.length && (
            <div className="home-empty">
              <p>No agents yet. Set one up, start its runner, and it takes cards from the board as they come.</p>
              <a className="button primary" href={href({ screen: 'agents' })}>Set up an agent</a>
            </div>
          )}
        </section>

        <aside className="home-side">
          {(asks.length > 0 || proposals.length > 0 || sets.length > 0) && (
            <section>
              <h2>Waiting on you</h2>
              <ul className="waiting">
                {asks.map((c) => (
                  <li key={c.id}><button onClick={() => openItem(c.id)}><MessageCircleQuestion size={14} className="amber" /><span><b>{c.title}</b><em>{nameFor({ agents: allAgents }, c.agentId ?? '')} asks: {c.needsYou}</em></span></button></li>
                ))}
                {sets.map((s) => (
                  <li key={s.id}><button onClick={() => go({ screen: 'changes', id: s.id })}><GitPullRequest size={14} /><span><b>Change set #{s.number}</b><em>{s.prIds.length} pull request{s.prIds.length === 1 ? '' : 's'} to approve</em></span></button></li>
                ))}
                {proposals.length > 0 && (
                  <li><button onClick={() => go({ screen: 'notes', id: proposals[0].noteId })}><Sparkles size={14} /><span><b>{proposals.length} proposed</b><em>{proposals.slice(0, 3).map((p) => p.title).join(' · ')}</em></span></button></li>
                )}
              </ul>
            </section>
          )}
          <section>
            <h2>What’s been happening</h2>
            <ol className="home-feed">
              {feed.map((event) => (
                <li key={`${event.card.id}-${event.at}-${event.text}`}>
                  <Who id={event.by} size={20} />
                  <p><b>{nameFor({ agents: allAgents }, event.by)}</b> {event.text.length > 90 ? `${event.text.slice(0, 90)}…` : event.text} <button className="feed-card" onClick={() => openItem(event.card.id)}>{event.card.title}</button></p>
                  <time className="num">{ago(event.at)}</time>
                </li>
              ))}
              {!feed.length && <li className="feed-empty">Nothing yet.</li>}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}

/**
 * One of the counts at the top: an icon and label, the number large, a line on what's in it. Its tone (blue running,
 * amber waiting on you, green done) tints it while there's something to count; at nothing it steps back. One that
 * leads somewhere shows an arrow.
 */
function Stat({ icon: Icon, label, value, detail, tone, onClick }: { icon: LucideIcon; label: string; value: number; detail: string; tone?: 'blue' | 'amber' | 'green'; onClick?: () => void }) {
  return (
    <button type="button" className={['stat', tone, value === 0 && 'zero'].filter(Boolean).join(' ')} onClick={onClick} disabled={!onClick}>
      <span className="stat-head">
        <span className="stat-icon" aria-hidden><Icon size={15} strokeWidth={2.4} /></span>
        <span className="stat-label">{label}</span>
        {onClick && <ArrowUpRight className="stat-go" size={15} aria-hidden />}
      </span>
      <b className="num">{value}</b>
      <span className="stat-detail">{detail}</span>
    </button>
  )
}

/** One agent: what it is and where it runs, the cards it holds with how far along each is, and its session live. */
function AgentTile({ agent, cards, onOpen }: { agent: Agent; cards: Card[]; onOpen: (id: string) => void }) {
  const holding = cards.filter((c) => c.agentId === agent.id && c.stage === 'working')
  const meant = cards.filter((c) => c.meantFor === agent.id && c.stage === 'ready')
  const done = cards.filter((c) => c.agentId === agent.id && c.stage !== 'working' && c.updatedAt.startsWith(today())).length
  const listening = isListening(agent)
  const online = isOnline(agent)
  const status = holding.some((c) => c.needsYou) ? 'Waiting on you' : holding.length ? `Working on ${holding.length}` : listening ? 'Listening for work' : online ? 'Online' : agent.lastSeen ? `Seen ${ago(agent.lastSeen)} ago` : 'Not started'
  // Its latest card's session, newest lines.
  const latest = [...holding].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const lines = latest ? sessionLines(latest.activity).slice(-14) : []
  const tool = toolInfo(agent.runner?.tool ?? 'claude')
  const runner = runnerState(agent)
  return (
    <motion.article layout className={`agent-tile${holding.length ? ' busy' : ''}${!online ? ' off' : ''}`}>
      <header>
        <AgentAvatar agent={agent} size={34} live={holding.length > 0} />
        <div>
          <h3>{agent.name}</h3>
          <span className="faint">{tool.name}{agent.runsOn ? ` · ${agent.runsOn}` : ''}</span>
        </div>
        <span className={`agent-status${holding.some((c) => c.needsYou) ? ' asks' : holding.length ? ' working' : listening ? ' listening' : ''}`}><i />{status}</span>
      </header>
      {holding.length > 0 ? (
        <ul className="tile-cards">
          {holding.map((c) => (
            <li key={c.id}>
              <button onClick={() => onOpen(c.id)}>
                <span className="tile-card-title"><b>{c.title}</b><ArrowUpRight size={12} /></span>
                <span className="tile-card-doing">{c.needsYou ? `Asks: ${c.needsYou}` : c.doing ?? 'Working'}</span>
                {c.progress !== undefined && <Progress value={c.progress} />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tile-idle">
          {meant.length ? `${meant.length} card${meant.length === 1 ? '' : 's'} meant for it, waiting for it to listen.` : listening ? 'It takes the next card it can do as soon as one is ready.' : online ? 'Connected, not listening.' : 'Its runner isn’t running.'}
          {!listening && <a href={href({ screen: 'agents' })}><Play size={11} /> Start the runner</a>}
        </p>
      )}
      {latest && lines.length > 0 && <div className="tile-terminal"><Terminal lines={lines} working={!latest.needsYou} doing={latest.doing} /></div>}
      <footer className="num">
        <span className="faint">{done} done today</span>
        {online && <span className={runner.old ? 'runner-old' : 'faint'}>{runner.text}{runner.old && <> <a href={href({ screen: 'agents' })}>How</a></>}</span>}
      </footer>
    </motion.article>
  )
}
