import { useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowUp, ArrowUpRight, Bot, Brain, CircleCheck, Hand, History, Inbox, Play, type LucideIcon } from 'lucide-react'
import type { Activity, Agent, Card } from '../data/model'
import { isListening, isOnline, nameFor, sameList, useHub, usePresence } from '../data/store'
import { heard } from '../data/sync'
import { useWaiting } from '../data/notify'
import { AgentAvatar, Progress, Who, ago, usePhone } from '../components/bits'
import { WaitingList } from '../components/Waiting'
import { whatWaits } from '../components/waitingWords'
import { AgentActivity } from '../components/AgentActivity'
import { toolInfo } from '../../../shared/agents.ts'
import { isModelAgent, modelReady, modelWords } from '../components/modelAgent'
import { asksOf } from '../../../shared/work.ts'
import { useUI } from '../ui'
import { runnerState } from '../components/runnerState'
import { go, href } from '../route'
import { isPersonal, PersonalRepo } from '../components/PersonalRepo'
import { EmptyState, PageHeader, Row, Rows, Section, Skeleton, Status, type Tone } from '../kit'

const dayOf = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
/** Whether a time was today, by the clock where you are: not by UTC's, which turns over at seven in the evening in New York. */
const isToday = (iso: string) => !Number.isNaN(Date.parse(iso)) && dayOf(new Date(iso)) === dayOf(new Date())

/** Good morning, afternoon or evening, by the clock where you are, with your first name when the hub knows it. */
function greeting(name: string | undefined, now: Date) {
  const hour = now.getHours()
  const part = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening'
  const first = name?.trim().split(/\s+/)[0]
  return `Good ${part}${first ? `, ${first.charAt(0).toUpperCase()}${first.slice(1)}` : ''}`
}

/** How many of the latest happenings show at first; the rest are a press away. */
const feedFirst = 6

/**
 * Home: what the agents are doing right now, each with its card and its last few steps, what waits on you, and what's
 * been happening. For the binder you're in, or all of them. On a phone what waits on you comes first, as it's what
 * people come back for.
 */
export function Home() {
  const { binder, openItem, askQuestion } = useUI()
  const allCards = useHub((state) => state.cards)
  const allAgents = useHub((state) => state.agents)
  const name = useHub((state) => state.me?.user.name || state.me?.user.login)
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
  const busyAgents = new Set(working.map((c) => c.agentId)).size
  // Busiest first: working, then listening, then the rest.
  const order = (a: Agent) => (holds(a, cards).length ? 0 : isListening(a) ? 1 : isOnline(a) || (isModelAgent(a) && modelReady(a)) ? 2 : 3)
  const sorted = [...agents].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  // An agent holding a card has a panel of its own; the rest are a line each under them.
  const atWork = sorted.filter((a) => holds(a, cards).length)
  const free = sorted.filter((a) => !holds(a, cards).length)
  const feed = useMemo(() => cards
    .flatMap((card) => card.activity.filter((a) => a.kind !== 'step' && a.kind !== 'said' && a.kind !== 'ran').map((a) => ({ ...a, card })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30), [cards])
  const [allFeed, setAllFeed] = useState(false)
  // When the page was opened: the greeting and the date are of then.
  const [opened] = useState(() => new Date())
  const today = opened.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  // Pressing the count goes to the list: on a phone it's the first thing on the page, beside the agents it's in the column.
  const showList = () => {
    list.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    list.current?.focus({ preventScroll: true })
  }
  const waiting = <WaitingList rows={rows} showBinder={binder === 'all'} loaded={loaded} ref={list} />

  return (
    <div className="page home-page">
      <div className="page-column home">
        <PageHeader title={greeting(name, opened)} lead={today} action={askQuestion && <AskLine ask={askQuestion} />} />
        {isPersonal && <PersonalRepo />}
        {phone && waiting}
        <section className="home-stats" aria-label="Now">
          <Stat icon={Play} label="Working now" value={working.length} detail={`${busyAgents} agent${busyAgents === 1 ? '' : 's'}`} tone="blue" onClick={() => go({ screen: 'flow' })} />
          <Stat icon={Hand} label="Waiting on you" value={calls.length} detail={whatWaits(calls) || 'Nothing'} tone="amber" onClick={showList} />
          <Stat icon={Inbox} label="Ready" value={ready.length} detail="For the next agent free" onClick={() => go({ screen: 'flow' })} />
          <Stat icon={CircleCheck} label="Done today" value={doneToday.length} detail={`${doneToday.length === 1 ? 'Card' : 'Cards'} to review or shipped`} tone="green" />
        </section>

        <AgentActivity agents={agents} cards={cards} chats={chats} />

        <div className="home-body">
          <Section title="Agents" card={false} className="home-agents" action={agents.length > 0 && <a className="button small quiet" href={href({ screen: 'agents' })}>All agents</a>}>
            {!agents.length && !loaded && (
              <div className="home-panels" role="status" aria-label="Loading the agents">
                {[0, 1].map((i) => <div key={i} className="agent-tile loading"><Skeleton width={160} height={14} /><Skeleton lines={3} /></div>)}
              </div>
            )}
            {!agents.length && loaded && (
              <div className="home-empty">
                <EmptyState icon={<Bot size={20} />} title="No agents yet" line="Add a machine: one line, run in the folder with the code, and an agent there takes cards from the board as they come."
                  action={<a className="button primary" href={href({ screen: 'agents' })}>Add an agent</a>} />
              </div>
            )}
            {atWork.length > 0 && (
              <div className="home-panels">
                {atWork.map((agent) => <AgentPanel key={agent.id} agent={agent} cards={cards} onOpen={openItem} />)}
              </div>
            )}
            {free.length > 0 && (
              <Rows label={atWork.length ? 'Not on a card' : 'Agents'} className="home-free">
                {free.map((agent) => <FreeAgent key={agent.id} agent={agent} cards={cards} />)}
              </Rows>
            )}
          </Section>

          <div className="home-side">
            {!phone && waiting}
            <Section title="What’s been happening" className="home-happening">
              {feed.length ? (
                <>
                  <ol className="home-feed">
                    {feed.slice(0, allFeed ? feed.length : feedFirst).map((event) => (
                      <li key={`${event.card.id}-${event.at}-${event.text}`}>
                        <Who id={event.by} size={22} />
                        <p><b>{nameFor({ agents: allAgents }, event.by)}</b> {event.text.length > 90 ? `${event.text.slice(0, 90)}…` : event.text} <button type="button" className="feed-card" onClick={() => openItem(event.card.id)}>{event.card.title}</button></p>
                        <time className="num" dateTime={event.at}>{ago(event.at)}</time>
                      </li>
                    ))}
                  </ol>
                  {!allFeed && feed.length > feedFirst && <button type="button" className="text-button home-feed-more" onClick={() => setAllFeed(true)}>Show {feed.length - feedFirst} more</button>}
                </>
              ) : loaded ? (
                <EmptyState compact icon={<History size={18} />} title="Nothing yet" line="What agents and people do on the board shows here." />
              ) : (
                <div className="home-feed-loading" role="status" aria-label="Loading"><Skeleton lines={3} /></div>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The cards an agent holds: those it's working on, and those it asked about, which wait in Blocked until someone answers. */
const holds = (agent: Agent, cards: Card[]) => cards.filter((c) => c.agentId === agent.id && (c.stage === 'working' || c.stage === 'blocked'))

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
        <button type="submit" className="ask-send" disabled={!question.trim()} aria-label="Ask"><ArrowUp size={16} strokeWidth={2.6} /></button>
      </div>
    </form>
  )
}

/**
 * One of the counts at the top: an icon and label, the number large, a line on what's in it. Its tone (blue running,
 * amber waiting on you, green done) tints it while there's something to count; at nothing it steps back. One that
 * leads somewhere shows an arrow. Its line keeps to one line, whole on hover.
 */
function Stat({ icon: Icon, label, value, detail, tone, onClick }: { icon: LucideIcon; label: string; value: number; detail: string; tone?: 'blue' | 'amber' | 'green'; onClick?: () => void }) {
  return (
    <button type="button" className={['stat', tone, value === 0 && 'zero'].filter(Boolean).join(' ')} onClick={onClick} disabled={!onClick}>
      <span className="stat-head">
        <span className="stat-icon" aria-hidden><Icon size={14} strokeWidth={2.4} /></span>
        <span className="stat-label">{label}</span>
        {onClick && <ArrowUpRight className="stat-go" size={15} aria-hidden />}
      </span>
      <b className="num">{value}</b>
      <span className="stat-detail" title={detail}>{detail}</span>
    </button>
  )
}

/** A step an agent took, or something it said, as its session has it. */
interface Step {
  tool?: string
  text: string
  result?: string
}

/** The last few steps of a card's session, oldest first. */
function lastSteps(activity: Activity[], most: number): Step[] {
  const steps: Step[] = []
  for (const a of activity) {
    if (a.kind === 'step') steps.push({ tool: a.tool ?? 'Step', text: a.text, result: a.result })
    else if (a.kind === 'said') steps.push({ text: a.text })
  }
  return steps.slice(-most)
}

/** What an agent is doing, in a word or two, and the colour that says it. */
function standing(agent: Agent, cards: Card[]): { tone: Tone; words: string } {
  const holding = holds(agent, cards)
  const asking = holding.filter((c) => asksOf(c))
  const busy = holding.filter((c) => c.stage === 'working')
  // One the hub runs as a model at an address has no runner: it's ready, or its last try says what's wrong.
  if (asking.length) return { tone: 'waiting', words: 'Waiting on you' }
  if (busy.length) return { tone: 'running', words: busy.length === 1 ? 'Working' : `Working on ${busy.length}` }
  if (isModelAgent(agent)) return modelReady(agent) ? { tone: 'ok', words: 'Ready' } : { tone: 'bad', words: 'Needs attention' }
  if (isListening(agent)) return { tone: 'ok', words: 'Listening' }
  if (isOnline(agent)) return { tone: 'off', words: 'Online' }
  return { tone: 'off', words: agent.lastSeen ? `Seen ${ago(agent.lastSeen)} ago` : 'Not running' }
}

/** Where an agent runs, in a line: its tool and machine, or the model the hub runs it with. */
const whereItRuns = (agent: Agent) => (isModelAgent(agent) ? `Runs on this hub · ${modelWords(agent.endpoint)}` : `${toolInfo(agent.runner?.tool ?? 'claude').name}${agent.runsOn ? ` · ${agent.runsOn}` : ''}`)

/** An agent at work: who it is and how it stands, the cards it holds with how far along each is, and its last few steps. */
function AgentPanel({ agent, cards, onOpen }: { agent: Agent; cards: Card[]; onOpen: (id: string) => void }) {
  const holding = holds(agent, cards)
  const busy = holding.filter((c) => c.stage === 'working')
  const done = cards.filter((c) => c.agentId === agent.id && c.stage !== 'working' && isToday(c.updatedAt)).length
  const hosted = isModelAgent(agent)
  const online = hosted ? modelReady(agent) : isOnline(agent)
  const { tone, words } = standing(agent, cards)
  // Its latest card's session, newest steps last.
  const latest = [...holding].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const steps = latest ? lastSteps(latest.activity, 4) : []
  const runner = runnerState(agent)
  return (
    <motion.article layout className={`agent-tile${tone === 'waiting' ? ' asks' : ''}${!online ? ' off' : ''}`}>
      <header>
        <AgentAvatar agent={agent} size={32} live={busy.length > 0} />
        <div className="agent-tile-who">
          <h3>{agent.name}</h3>
          <span>{whereItRuns(agent)}</span>
        </div>
        <Status tone={tone}>{words}</Status>
      </header>
      <ul className="tile-cards">
        {holding.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)}>
              <span className="tile-card-title"><b>{c.title}</b><ArrowUpRight size={13} aria-hidden="true" /></span>
              <span className="tile-card-doing">{asksOf(c) ? `Asks: ${asksOf(c)}` : c.doing ?? (c.stage === 'blocked' ? 'Blocked' : 'Working')}</span>
              {c.progress !== undefined && <Progress value={c.progress} />}
            </button>
          </li>
        ))}
      </ul>
      {steps.length > 0 && (
        <ol className="tile-steps" aria-label={`Last steps on ${latest!.title}`}>
          {steps.map((step, index) => (
            <li key={index} className={step.tool ? undefined : 'said'}>
              {step.tool ? <><b>{step.tool}</b> <span>{step.text}</span>{step.result && <em> · {step.result}</em>}</> : <span>{step.text}</span>}
            </li>
          ))}
        </ol>
      )}
      <footer className="num">
        <span>{done} done today</span>
        {online && !hosted && <span className={runner.old ? 'runner-old' : undefined}>{runner.text}{runner.old && <> <a href={href({ screen: 'agents' })}>How</a></>}</span>}
      </footer>
    </motion.article>
  )
}

/** An agent holding no card: where it runs and what it would do next, and a press to Agents, where its runner is started. */
function FreeAgent({ agent, cards }: { agent: Agent; cards: Card[] }) {
  const meant = cards.filter((c) => c.meantFor === agent.id && c.stage === 'ready').length
  const hosted = isModelAgent(agent)
  const listening = hosted ? false : isListening(agent)
  const online = hosted ? modelReady(agent) : isOnline(agent)
  const { tone, words } = standing(agent, cards)
  const runner = runnerState(agent)
  const cardsMeant = `${meant} card${meant === 1 ? '' : 's'} meant for it`
  const line = hosted
    ? (agent.endpoint?.ready && !agent.endpoint.ready.ok ? agent.endpoint.ready.why || 'It didn’t answer as it needs to.' : meant ? `${cardsMeant}.` : 'Nothing for it right now.')
    : meant ? `${cardsMeant}, waiting for its runner.` : listening ? 'Takes the next card it can do as soon as one is ready.' : online ? 'Online, but its runner isn’t running.' : 'Its runner isn’t running.'
  return (
    <Row icon={<AgentAvatar agent={agent} size={32} />} title={agent.name} href={href({ screen: 'agents' })}
      meta={<>{whereItRuns(agent)} · <span>{line}</span>{online && !hosted && runner.old && <> <span className="runner-old">{runner.text}</span></>}</>}
      status={<Status tone={tone}>{words}</Status>} />
  )
}
