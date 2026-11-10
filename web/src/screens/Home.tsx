import { useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowUp, ArrowUpRight, Brain, CircleCheck, Hand, Inbox, Play, type LucideIcon } from 'lucide-react'
import type { Agent, Card } from '../data/model'
import { isListening, isOnline, nameFor, sameList, useHub, usePresence } from '../data/store'
import { heard } from '../data/sync'
import { useWaiting } from '../data/notify'
import { sessionLines } from '../data/session'
import { AgentAvatar, Progress, Who, ago, usePhone } from '../components/bits'
import { WaitingList } from '../components/Waiting'
import { whatWaits } from '../components/waitingWords'
import { Terminal } from '../components/Terminal'
import { AgentActivity } from '../components/AgentActivity'
import { toolInfo } from '../../../shared/agents.ts'
import { isModelAgent, modelReady, modelWords } from '../components/modelAgent'
import { asksOf } from '../../../shared/work.ts'
import { useUI } from '../ui'
import { runnerState } from '../components/runnerState'
import { go, href } from '../route'
import { isPersonal, PersonalRepo } from '../components/PersonalRepo'

const dayOf = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
/** Whether a time was today, by the clock where you are: not by UTC's, which turns over at seven in the evening in New York. */
const isToday = (iso: string) => !Number.isNaN(Date.parse(iso)) && dayOf(new Date(iso)) === dayOf(new Date())

/**
 * Home: what the agents are doing right now, each with its cards and a live view of its session, what waits on you, and
 * what's been happening. For the binder you're in, or all of them.
 */
export function Home() {
  const { binder, openItem, askQuestion } = useUI()
  const allCards = useHub((state) => state.cards)
  const allAgents = useHub((state) => state.agents)
  // Until the hub has answered once, an empty list means nothing has arrived yet.
  const loaded = useHub((state) => heard(state.sync))
  const phone = usePhone()
  const rows = useWaiting(binder)
  const list = useRef<HTMLElement>(null)
  usePresence()
  const here = (binderId: string) => binder === 'all' || binderId === binder
  const chats = useHub((state) => (state.chats ?? []).filter((c) => here(state.notes.find((n) => n.id === c.noteId)?.binderId ?? '')), sameList)
  const cards = useMemo(() => allCards.filter((c) => binder === 'all' || c.binderId === binder), [allCards, binder])
  const agents = useMemo(() => allAgents.filter((a) => !a.revoked), [allAgents])
  const working = cards.filter((c) => c.stage === 'working')
  const calls = rows.filter((r) => r.for !== 'others')
  const ready = cards.filter((c) => c.stage === 'ready')
  const doneToday = cards.filter((c) => (c.stage === 'live' || c.stage === 'review') && isToday(c.updatedAt))
  // Busiest first: working, then listening, then the rest.
  const order = (a: Agent) => (cards.some((c) => c.agentId === a.id && (c.stage === 'working' || (c.stage === 'blocked' && asksOf(c)))) ? 0 : isListening(a) ? 1 : isOnline(a) || (isModelAgent(a) && modelReady(a)) ? 2 : 3)
  const sorted = [...agents].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  const feed = useMemo(() => cards
    .flatMap((card) => card.activity.filter((a) => a.kind !== 'step' && a.kind !== 'said' && a.kind !== 'ran').map((a) => ({ ...a, card })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30), [cards])

  // Pressing the count goes to the list: on a phone it's the first thing on the page, beside the agents it's in the column.
  const showList = () => {
    list.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    list.current?.focus({ preventScroll: true })
  }
  const waiting = <WaitingList rows={rows} showBinder={binder === 'all'} loaded={loaded} ref={list} />

  return (
    <div className="home">
      {askQuestion && <AskLine ask={askQuestion} />}
      {isPersonal && <PersonalRepo />}
      {phone && waiting}
      <section className="home-stats" aria-label="Now">
        <Stat icon={Play} label="Working now" value={working.length} detail={`${new Set(working.map((c) => c.agentId)).size} agent${new Set(working.map((c) => c.agentId)).size === 1 ? '' : 's'}`} tone="blue" onClick={() => go({ screen: 'flow' })} />
        <Stat icon={Hand} label="Waiting on you" value={calls.length} detail={whatWaits(calls) || 'Nothing'} tone="amber" onClick={showList} />
        <Stat icon={Inbox} label="Ready" value={ready.length} detail="for the next agent free" onClick={() => go({ screen: 'flow' })} />
        <Stat icon={CircleCheck} label="Done today" value={doneToday.length} detail={`${doneToday.length === 1 ? 'card' : 'cards'} to review or shipped`} tone="green" />
      </section>

      <AgentActivity agents={agents} cards={cards} chats={chats} />

      <div className="home-body">
        <section className="home-agents" aria-label="Agents">
          {sorted.map((agent) => <AgentTile key={agent.id} agent={agent} cards={cards} onOpen={openItem} />)}
          {!agents.length && !loaded && <div className="home-empty"><p className="faint" role="status">Loading…</p></div>}
          {!agents.length && loaded && (
            <div className="home-empty">
              <p>No agents yet. Add a machine: one line, run in the folder with the code, and an agent there takes cards from the board as they come.</p>
              <a className="button primary" href={href({ screen: 'agents' })}>Add a machine</a>
            </div>
          )}
        </section>

        <aside className="home-side">
          {!phone && waiting}
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
              {!feed.length && <li className="feed-empty">{loaded ? 'Nothing yet.' : 'Loading…'}</li>}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}

/** One line to ask the binders something: the question goes to the Brain, which answers it. */
function AskLine({ ask }: { ask: (question: string) => void }) {
  const [question, setQuestion] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const q = question.trim()
    if (!q) return
    setQuestion('')
    ask(q)
  }
  return (
    <form className="home-ask" onSubmit={submit}>
      <div className="ask-box">
        <Brain size={16} className="faint" aria-hidden="true" />
        <input id="home-ask" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask your binders…" aria-label="Ask your binders" autoComplete="off" enterKeyHint="send" maxLength={2000} />
        <button type="submit" className="ask-send" disabled={!question.trim()} aria-label="Ask"><ArrowUp size={17} strokeWidth={2.6} /></button>
      </div>
    </form>
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
  // What it holds: cards it's working on, and cards it asked about, which wait in Blocked until someone answers.
  const holding = cards.filter((c) => c.agentId === agent.id && (c.stage === 'working' || c.stage === 'blocked'))
  const asking = holding.filter((c) => asksOf(c))
  const busy = holding.filter((c) => c.stage === 'working')
  const meant = cards.filter((c) => c.meantFor === agent.id && c.stage === 'ready')
  const done = cards.filter((c) => c.agentId === agent.id && c.stage !== 'working' && isToday(c.updatedAt)).length
  // One the hub runs as a model at an address has no runner: it's ready, or its last try says what's wrong.
  const hosted = isModelAgent(agent)
  const listening = hosted ? false : isListening(agent)
  const online = hosted ? modelReady(agent) : isOnline(agent)
  const status = asking.length ? 'Waiting on you' : busy.length ? `Working on ${busy.length}` : hosted ? (online ? 'Ready' : 'Needs attention') : listening ? 'Listening for work' : online ? 'Online' : agent.lastSeen ? `Seen ${ago(agent.lastSeen)} ago` : 'Not running'
  // Its latest card's session, newest lines.
  const latest = [...holding].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const lines = latest ? sessionLines(latest.activity).slice(-14) : []
  const tool = toolInfo(agent.runner?.tool ?? 'claude')
  const runner = runnerState(agent)
  return (
    <motion.article layout className={`agent-tile${holding.length ? ' busy' : ''}${!online ? ' off' : ''}`}>
      <header>
        <AgentAvatar agent={agent} size={34} live={busy.length > 0} />
        <div>
          <h3>{agent.name}</h3>
          <span className="faint">{isModelAgent(agent) ? `Runs on this hub · ${modelWords(agent.endpoint)}` : <>{tool.name}{agent.runsOn ? ` · ${agent.runsOn}` : ''}</>}</span>
        </div>
        <span className={`agent-status${asking.length ? ' asks' : busy.length ? ' working' : listening ? ' listening' : ''}`}><i />{status}</span>
      </header>
      {holding.length > 0 ? (
        <ul className="tile-cards">
          {holding.map((c) => (
            <li key={c.id}>
              <button onClick={() => onOpen(c.id)}>
                <span className="tile-card-title"><b>{c.title}</b><ArrowUpRight size={12} /></span>
                <span className="tile-card-doing">{asksOf(c) ? `Asks: ${asksOf(c)}` : c.doing ?? (c.stage === 'blocked' ? 'Blocked' : 'Working')}</span>
                {c.progress !== undefined && <Progress value={c.progress} />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tile-idle">
          {hosted ? (agent.endpoint?.ready && !agent.endpoint.ready.ok ? agent.endpoint.ready.why || 'It didn’t answer as it needs to.' : meant.length ? `${meant.length} card${meant.length === 1 ? '' : 's'} meant for it.` : 'Nothing for it right now.') : meant.length ? `${meant.length} card${meant.length === 1 ? '' : 's'} meant for it, waiting for its runner.` : listening ? 'It takes the next card it can do as soon as one is ready.' : online ? 'Online, but its runner isn’t running.' : 'Its runner isn’t running.'}
          {!listening && !hosted && <a href={href({ screen: 'agents' })}><Play size={11} /> Start the runner</a>}
          {hosted && !online && <a href={href({ screen: 'agents' })}>Put it right</a>}
        </p>
      )}
      {latest && lines.length > 0 && <div className="tile-terminal"><Terminal lines={lines} working={!asksOf(latest)} doing={latest.doing} /></div>}
      <footer className="num">
        <span className="faint">{done} done today</span>
        {online && !hosted && <span className={runner.old ? 'runner-old' : 'faint'}>{runner.text}{runner.old && <> <a href={href({ screen: 'agents' })}>How</a></>}</span>}
      </footer>
    </motion.article>
  )
}
