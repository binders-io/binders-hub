import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { LayoutGroup, motion, AnimatePresence } from 'motion/react'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Eye, EyeOff, GitPullRequest, MessageCircleQuestion, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { stages, type Agent, type Card, type Proposal, type Stage } from '../data/model'
import { asksOf, cardNumber, mayTake, meantForNow } from '../../../shared/work.ts'
import { nameFor, sameValues, useActions, useClock, useHub, type State } from '../data/store'
import { forAttention, type WaitKind, type Waiting } from '../../../shared/waiting.ts'
import { routeOf, useWaiting } from '../data/notify'
import { heard } from '../data/sync'
import { AgentAvatar, CheckDots, Progress, RepoTag, Who, ago, checksSummary, codeRepo, stageTone, stoppedBlock, stoppedWords } from '../components/bits'
import { NewCardDialog } from '../components/NewCardDialog'
import { DebriefButton } from '../components/Debrief'
import { CardMenu, cardMenuItems } from '../components/CardMenu'
import { openMenu } from '../components/ContextMenu'
import { attempt, toast } from '../components/Toast'
import { useUI } from '../ui'
import { go, href } from '../route'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const
const noProposals: Proposal[] = []
/** Done shows what finished in the last month: a board that keeps everything ever finished only grows. */
const doneShownMs = 30 * 24 * 3600_000
const doneCutoff = () => Date.now() - doneShownMs
const filterKey = 'binders-board-filter'
/** The kinds of row that are a card asking a person something, which the strip says in one button. */
const asks: WaitKind[] = ['question', 'stopped', 'permission']
const rowIcons: Record<WaitKind, LucideIcon> = { question: MessageCircleQuestion, stopped: MessageCircleQuestion, permission: MessageCircleQuestion, findings: GitPullRequest, changeSet: GitPullRequest, proposals: Sparkles, noteChange: Sparkles, promotion: Check }
const sameLogin = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Everything on its way from a note to production, one column per stage, with what's happening beside it. */
export function Flow() {
  const allCards = useHub((state) => state.cards)
  const allProposals = useHub((state) => state.proposals)
  const agents = useHub((state) => state.agents)
  const noBinders = useHub((state) => !state.binders.length)
  // Until the hub has answered once, an empty column means nothing has arrived yet.
  const loaded = useHub((state) => heard(state.sync))
  const me = useHub((state) => state.me?.user.login)
  const { binder } = useUI()
  const [adding, setAdding] = useState(false)
  const [feedOpen, setFeedOpen] = useState(false)
  // What Distill proposed can be set aside to see the rest of the board. It's still waiting on you, so everything that
  // counts what's waiting (Home, the nav, the notes list) goes on counting it. This browser remembers.
  const [showDistilled, setShowDistilled] = useState(() => {
    try { return window.localStorage.getItem('binders-show-distilled') !== '0' } catch { return true }
  })
  const chooseDistilled = (next: boolean) => {
    setShowDistilled(next)
    try { window.localStorage.setItem('binders-show-distilled', next ? '1' : '0') } catch { /* only a convenience */ }
  }
  // Dragging a card to another column moves it there; agents take cards themselves, so "working" isn't a drop. Which
  // card is only asked during the drag, so it's kept where changing it draws nothing.
  const dragging = useRef<string>(undefined)
  const [dropOn, setDropOn] = useState<Stage>()
  // The board can be narrowed to what's mine, or to one agent's. This browser remembers which.
  const [pick, setPick] = useState(() => {
    try { return window.localStorage.getItem(filterKey) ?? '' } catch { return '' }
  })
  const choose = (next: string) => {
    setPick(next)
    try { if (next) window.localStorage.setItem(filterKey, next); else window.localStorage.removeItem(filterKey) } catch { /* only a convenience */ }
  }
  const [olderShown, setOlderShown] = useState(false)
  const toggleOlder = useCallback(() => setOlderShown((now) => !now), [])
  const cards = useMemo(() => allCards.filter((c) => binder === 'all' || c.binderId === binder), [allCards, binder])
  const mineAgents = useMemo(() => new Set(agents.filter((a) => sameLogin(a.owner, me)).map((a) => a.id)), [agents, me])
  const filterAgents = useMemo(() => agents.filter((a) => cards.some((c) => c.agentId === a.id || c.meantFor === a.id)), [agents, cards])
  // A choice that has nothing behind it any more (an agent whose cards are all gone) isn't applied.
  const active = pick === 'mine' ? (me ? 'mine' : '') : filterAgents.some((a) => `agent:${a.id}` === pick) ? pick : ''
  const agentOf = active.startsWith('agent:') ? active.slice(6) : undefined
  // Mine: cards I made, and what an agent I own holds or is meant for. A proposal is mine when I or an agent of mine made it, or it's meant for one.
  const shownCards = useMemo(() => cards.filter((c) => !active || (agentOf ? c.agentId === agentOf || c.meantFor === agentOf : sameLogin(c.createdBy, me) || mineAgents.has(c.agentId ?? '') || mineAgents.has(c.meantFor ?? ''))), [cards, active, agentOf, me, mineAgents])
  const proposals = useMemo(() => allProposals.filter((p) => p.state === 'new' && (binder === 'all' || p.binderId === binder) && (!active || (agentOf ? p.by === agentOf || p.meantFor === agentOf : sameLogin(p.by, me) || mineAgents.has(p.by) || mineAgents.has(p.meantFor ?? '')))), [allProposals, binder, active, agentOf, me, mineAgents])
  const shownProposals = showDistilled ? proposals : noProposals
  const columns = useMemo(() => {
    const cutoff = doneCutoff()
    return stages.map((stage) => {
      const all = shownCards.filter((c) => c.stage === stage.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      if (stage.id !== 'live') return { stage, cards: all, older: 0 }
      // A time that can't be read counts as recent: better one too many than one lost.
      const recent = all.filter((c) => !(Date.parse(c.updatedAt) < cutoff))
      return { stage, cards: olderShown ? all : recent, older: all.length - recent.length }
    })
  }, [shownCards, olderShown])
  // What waits on you, as Home lists it: the same rows, each going where Home sends it. Questions, a card that stopped
  // and a permission are one button, each of the rest has its own.
  const attention = forAttention(useWaiting(binder))
  const asking = attention.filter((r) => asks.includes(r.kind))
  const elsewhere = attention.filter((r) => !asks.includes(r.kind))
  const askedBy = (row: Waiting) => {
    const card = allCards.find((c) => c.id === row.about.id)
    if (row.kind === 'stopped' || (card && stoppedBlock(card))) return card?.stopped ? stoppedWords(card.stopped.times) : 'Stopped twice'
    return `${nameFor({ agents }, (row.kind === 'permission' ? card?.permission?.agent : card?.agentId) ?? '')} asks you`
  }
  const board = useRef<HTMLDivElement>(null)
  const stageCounts = useMemo(() => columns.map(({ stage, cards: here }) => here.length + (stage.id === 'proposed' ? shownProposals.length : 0)), [columns, shownProposals])

  return (
    <div className={`flow${feedOpen ? ' feed-open' : ''}`}>
      <div className="flow-main">
        <div className="flow-summary">
          <div className="attention">
            {asking.length > 0 && (
              // Questions are one line each here; the whole question and the answer box are on the card.
              <button className="attention-card ready asks" onClick={() => go(routeOf(asking[0]))} title={asking.map((r) => `${r.title}: ${r.detail}`).join('\n\n')}>
                <MessageCircleQuestion size={15} />
                <span>
                  <b>{asking.length === 1 ? askedBy(asking[0]) : `${asking.length} questions for you`}</b>
                  <em>{asking.length === 1 ? asking[0].title : asking.map((r) => r.title).join(' · ')}</em>
                </span>
                <ArrowRight size={14} />
              </button>
            )}
            {elsewhere.map((row) => {
              const Icon = rowIcons[row.kind]
              return (
                <button key={row.id} className="attention-card ready" onClick={() => go(routeOf(row))}>
                  <Icon size={15} />
                  <span>
                    <b>{row.title}</b>
                    <em>{row.detail}</em>
                  </span>
                  <ArrowRight size={14} />
                </button>
              )
            })}
            {proposals.length > 0 && (
              <button className="distilled-toggle" onClick={() => chooseDistilled(!showDistilled)}>
                {showDistilled ? <EyeOff size={14} /> : <Eye size={14} />} {showDistilled ? 'Hide proposed' : `Show ${proposals.length} proposed`}
              </button>
            )}
            <button className="feed-toggle" onClick={() => setFeedOpen(!feedOpen)} aria-expanded={feedOpen}>
              <span className="live-dot" /> {feedOpen ? 'Hide activity' : 'Activity'}
            </button>
            <button className="button primary" onClick={() => setAdding(true)} disabled={noBinders}><Plus size={14} /> New card</button>
          </div>
        </div>

        <StageChips counts={stageCounts} board={board} />

        {cards.length > 0 && (me || filterAgents.length > 0) && (
          <div className="board-filters" role="group" aria-label="Show only">
            {me && <button type="button" aria-pressed={active === 'mine'} onClick={() => choose(active === 'mine' ? '' : 'mine')}>Mine</button>}
            {filterAgents.map((a) => {
              const key = `agent:${a.id}`
              return <button key={a.id} type="button" aria-pressed={active === key} onClick={() => choose(active === key ? '' : key)}><AgentAvatar agent={a} size={16} /> {a.name}</button>
            })}
          </div>
        )}

        <LayoutGroup>
          <div className="columns" ref={board}>
            {columns.map(({ stage, cards: here, older }) => (
              <Column key={stage.id} stage={stage} cards={here} proposals={stage.id === 'proposed' ? shownProposals : noProposals} hidden={stage.id === 'proposed' ? proposals.length - shownProposals.length : 0} older={older} olderShown={olderShown} toggleOlder={toggleOlder} agents={agents} loaded={loaded} drop={dropOn === stage.id} dragging={dragging} setDropOn={setDropOn} />
            ))}
          </div>
        </LayoutGroup>
      </div>

      <Feed cards={cards} agents={agents} />

      <AnimatePresence>{adding && <NewCardDialog key="new" binderId={binder === 'all' ? undefined : binder} onClose={() => setAdding(false)} />}</AnimatePresence>
    </div>
  )
}

const shortTitles: Partial<Record<Stage, string>> = { working: 'Working', review: 'Review' }

/** A phone's board is a column a screen: this says what's in the others, and goes to them. Hidden wider up, where they show. */
function StageChips({ counts, board }: { counts: number[]; board: RefObject<HTMLDivElement | null> }) {
  const row = useRef<HTMLElement>(null)
  const [at, setAt] = useState(0)

  useEffect(() => {
    const columns = board.current
    if (!columns) return
    const moved = () => {
      const [first, second] = columns.children as unknown as HTMLElement[]
      setAt(Math.round(columns.scrollLeft / ((second?.offsetLeft ?? 0) - (first?.offsetLeft ?? 0) || 1)))
    }
    columns.addEventListener('scroll', moved, { passive: true })
    return () => columns.removeEventListener('scroll', moved)
  }, [board])

  // The chip for the column in view stays in view too. Set directly: it mustn't interrupt the board's own smooth scroll.
  useEffect(() => {
    const chip = row.current?.children[at] as HTMLElement | undefined
    row.current?.scrollTo?.({ left: (chip?.offsetLeft ?? 0) - 14 })
  }, [at])

  const go = (index: number) => {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    board.current?.children[index]?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', inline: 'start', block: 'nearest' })
  }

  return (
    <nav className="stage-chips" aria-label="Stages" ref={row}>
      {stages.map((stage, index) => (
        <button key={stage.id} type="button" aria-current={index === at ? 'true' : undefined} onClick={() => go(index)}>
          <i className={`dot ${stageTone[stage.id]}`} />{shortTitles[stage.id] ?? stage.title}<span className="num">{counts[index]}</span>
        </button>
      ))}
    </nav>
  )
}

interface ColumnProps {
  stage: (typeof stages)[number]
  cards: Card[]
  proposals: Proposal[]
  /** How many proposals are set aside, for saying why an empty column is empty. */
  hidden: number
  /** Done only: how many finished before the last month. */
  older: number
  olderShown: boolean
  toggleOlder: () => void
  agents: Agent[]
  /** The hub has answered: an empty column is empty, not still on its way. */
  loaded: boolean
  drop: boolean
  dragging: RefObject<string | undefined>
  setDropOn: Dispatch<SetStateAction<Stage | undefined>>
}

/** One stage: drawn again when its cards change or a drag comes over it, not for what happens in the others. */
const Column = memo(function Column({ stage, cards, proposals, hidden, older, olderShown, toggleOlder, agents, loaded, drop, dragging, setDropOn }: ColumnProps) {
  const store = useActions()
  const count = cards.length + proposals.length
  // Only a card an agent holds, blocked, can go back to working.
  const pausedHere = (id: string) => store.current().cards.some((c) => c.id === id && c.stage === 'blocked' && !!c.agentId)
  return (
    <section className={`column ${stage.id}${drop ? ' drop' : ''}`} aria-label={stage.title}
      onDragOver={(e) => { if (dragging.current && (stage.id !== 'working' || pausedHere(dragging.current))) { e.preventDefault(); setDropOn(stage.id) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn(undefined) }}
      onDrop={(e) => { e.preventDefault(); setDropOn(undefined); if (dragging.current) store.moveCard(dragging.current, stage.id); dragging.current = undefined }}>
      <header>
        <i className={`dot ${stageTone[stage.id]}`} />
        <h2>{stage.title}</h2>
        <span className="num">{count}</span>
      </header>
      <p className="column-hint">{stage.hint}</p>
      <div className="column-cards">
        {stage.id === 'proposed' && (
          <AnimatePresence initial={false}>
            {proposals.map((p) => {
              const agent = agents.find((a) => a.id === p.meantFor)
              return <ProposalCard key={p.id} proposal={p} agent={agent} />
            })}
          </AnimatePresence>
        )}
        {cards.map((card) => (
          <div key={card.id} className="card-drag" draggable onDragStart={(e) => { e.dataTransfer.setData('text/binders-card', card.id); e.dataTransfer.effectAllowed = 'move'; dragging.current = card.id }} onDragEnd={() => { dragging.current = undefined; setDropOn(undefined) }}>
            <CardView card={card} stage={stage.id} />
          </div>
        ))}
        {count === 0 && <div className="column-empty">{!loaded ? 'Loading…' : hidden ? `${hidden} proposed hidden` : 'Nothing here'}</div>}
        {older > 0 && (
          <div className="column-more">
            <button type="button" className="text-button" onClick={toggleOlder}>{olderShown ? 'Hide older' : 'Show older'}</button>
            <span className="faint num">{older} from before the last 30 days</span>
          </div>
        )}
      </div>
    </section>
  )
})

const sizeNames: Record<Proposal['size'], string> = { S: 'Small', M: 'Medium', L: 'Large' }

/**
 * What an agent suggested from a note. Its title opens it in place to read what it says and the words it came from;
 * it's accepted into Ready, where an agent takes it at once, or taken in Proposed first, to fix its words, or dismissed.
 */
function ProposalCard({ proposal: p, agent }: { proposal: Proposal; agent?: Agent }) {
  const store = useActions()
  const { openItem } = useUI()
  const binder = useHub((state) => state.binders.find((b) => b.id === p.binderId)?.name)
  const note = useHub((state) => state.notes.find((n) => n.id === p.noteId))
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const accept = async () => {
    const made = await attempt(() => store.acceptProposal(p.id))
    if (made) toast('On the board, in Ready.', made.id ? { action: { label: 'Open', run: () => openItem(made.id) } } : {})
  }
  const dismiss = () => {
    store.dismissProposal(p.id)
    toast('Dismissed.', { action: { label: 'Undo', run: () => store.restoreProposal(p.id) } })
  }
  const editFirst = async () => {
    setWorking(true)
    const made = await attempt(() => store.editFirst(p.id))
    setWorking(false)
    if (made) openItem(made.id)
  }
  return (
    <motion.div layout className="card proposal" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }} transition={spring}>
      <div className="card-top">
        <Sparkles size={12} className="amber" />
        <span className="faint">From a note</span>
        <span className="faint">· {binder}</span>
      </div>
      <h3>
        <button type="button" className="proposal-open" aria-expanded={open} aria-controls={`proposal-${p.id}`} onClick={() => setOpen(!open)}>
          <span>{p.title}</span>
          <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
      </h3>
      {open && (
        <div className="proposal-body" id={`proposal-${p.id}`}>
          <h4>Brief</h4>
          <p>{p.brief || 'No brief.'}</p>
          {p.doneWhen && <><h4>Done when</h4><p>{p.doneWhen}</p></>}
          <h4>Size</h4>
          <p>{sizeNames[p.size]}</p>
          {p.quote && <><h4>From the note</h4><q>{p.quote}</q></>}
          {note && <a className="link-row" href={href({ screen: 'notes', id: note.id })}>{note.title} <ArrowUpRight size={12} /></a>}
        </div>
      )}
      <div className="proposal-actions">
        <button className="mini-button primary" onClick={() => void accept()}>Accept</button>
        <button className="mini-button" disabled={working} onClick={() => void editFirst()} title="Put it on the board in Proposed, where no agent takes it, and open it to change its words">Edit first</button>
        <button className="mini-button" onClick={dismiss}>Dismiss</button>
        {agent && <AgentAvatar agent={agent} size={20} />}
      </div>
    </motion.div>
  )
}

/** What's been happening: every card's activity, newest first. */
const Feed = memo(function Feed({ cards, agents }: { cards: Card[]; agents: Agent[] }) {
  useClock()
  const loaded = useHub((state) => heard(state.sync))
  const feed = useMemo(() => cards
    .flatMap((card) => card.activity.filter((a) => a.kind !== 'step' && a.kind !== 'ran').map((a) => ({ ...a, card })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 40), [cards])
  return (
    <aside className="feed" aria-label="Activity">
      <header>
        <h2>Activity</h2>
        <span className="live-dot" />
      </header>
      <ol>
        <AnimatePresence initial={false}>
          {feed.map((event) => (
            <motion.li key={`${event.card.id}-${event.at}-${event.text}`} layout initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={spring} className={`feed-row ${event.kind === 'question' ? 'ship' : ''}`}>
              <Who id={event.by} size={22} />
              <p>
                <b>{nameFor({ agents }, event.by)}</b> {event.text.length > 120 ? `${event.text.slice(0, 120)}…` : event.text}
                <button className="feed-card" onClick={() => go({ screen: 'work', id: event.card.id })}>{event.card.title}</button>
              </p>
              <time className="num">{ago(event.at)}</time>
            </motion.li>
          ))}
        </AnimatePresence>
        {!feed.length && <li className="feed-empty">{loaded ? 'Nothing yet. Cards show what agents do here as they do it.' : 'Loading…'}</li>}
      </ol>
    </aside>
  )
})

/** What a card shows from elsewhere in the state: it draws again when one of these changes, or the card itself does. */
function cardFacts(state: State, card: Card) {
  const pull = state.pulls.find((p) => p.id === card.prId)
  return {
    agent: state.agents.find((a) => a.id === (card.agentId ?? meantForNow(state, card))),
    pull,
    set: pull && state.changeSets.find((c) => c.prIds.includes(pull.id)),
    binder: state.binders.find((b) => b.id === card.binderId),
    noteTitle: state.notes.find((n) => n.id === card.noteId)?.title,
    // Ready and nobody's: whether any agent may take it at all, by its binders and repos.
    untakeable: card.stage === 'ready' && !card.agentId && !state.agents.some((a) => !a.revoked && mayTake(state, a, card)),
  }
}

const CardView = memo(function CardView({ card, stage }: { card: Card; stage: Stage }) {
  const store = useActions()
  const { openItem, splitCard } = useUI()
  const split = splitCard ? () => splitCard(card.id) : undefined
  const select = useCallback((state: State) => cardFacts(state, card), [card])
  const { agent, pull, set, binder, noteTitle, untakeable } = useHub(select, sameValues)

  return (
    // The whole card opens it for a pointer, and its title's button for a keyboard or a screen reader: a button can't hold the card's others.
    <motion.article layout layoutId={card.id} className={`card ${stage}${asksOf(card) ? ' asks' : ''}`} onClick={() => openItem(card.id)} onContextMenu={(e) => openMenu(e, cardMenuItems(card, store, openItem, split))} transition={spring} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
      <div className="card-top">
        <span className="mono faint" title={card.jira ? `Its Jira issue: ${card.jira.key}` : card.issue ? `Its issue: #${card.issue.number} in ${card.issue.repo}` : undefined}>{cardNumber(card) ?? binder?.name}</span>
        {(() => {
          const code = codeRepo(card, pull?.repo, binder?.repo)
          return code ? <RepoTag repo={code} title={pull ? `Its pull request is in ${code}` : `The binder’s repo: ${code}`} /> : null
        })()}
        {set && !card.jira && <span className="set-tag">CS-{set.number}</span>}
        <CardMenu card={card} open={openItem} split={split} />
      </div>
      <h3><button type="button" className="card-open">{card.title}</button></h3>
      {card.stopped
        ? <p className="card-stopped" title={`${stoppedWords(card.stopped.times)}: ${card.stopped.why}`}>{stoppedWords(card.stopped.times)}: {card.stopped.why}</p>
        // Its long question says what to do, which its page does; the board says who it's waiting on, which isn't an agent.
        : stoppedBlock(card) ? <p className="card-stopped">Stopped twice</p>
        : asksOf(card) && <p className="card-asks">Asks: {asksOf(card)}</p>}
      {card.stopped && !stoppedBlock(card) && asksOf(card) && <p className="card-asks">Asks: {asksOf(card)}</p>}
      {stage === 'working' && card.progress !== undefined && (
        <div className="card-work">
          <Progress value={card.progress} />
          <span className="doing">{card.doing ?? 'Working'}</span>
        </div>
      )}
      <div className="card-foot">
        {agent ? <AgentAvatar agent={agent} size={20} live={stage === 'working'} /> : <span className={untakeable ? 'unclaimed none' : 'unclaimed'} title={untakeable ? 'No agent works in this binder and its repo: set an agent’s binders and repos on the Agents page, or mean this card for one.' : undefined}>{stage === 'ready' ? (untakeable ? 'No agent can take it' : 'Any agent') : ''}</span>}
        {pull ? (
          <span className={`pr-mini ${checksSummary(pull.checks).state}`}>
            <DebriefButton card={card} inline />
            <span className="mono">#{pull.number}</span>
            <CheckDots checks={pull.checks} />
          </span>
        ) : stage === 'working' || stage === 'review' ? (
          <DebriefButton card={card} inline />
        ) : (
          <span className="from-note">{noteTitle}</span>
        )}
      </div>
    </motion.article>
  )
})
