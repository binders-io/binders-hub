import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { LayoutGroup, motion, AnimatePresence } from 'motion/react'
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Eye, EyeOff, GitPullRequest, ListFilter, MessageCircleQuestion, OctagonAlert, Plus, Sparkles, X } from 'lucide-react'
import { stages, type Agent, type Card, type Proposal, type Stage } from '../data/model'
import { asksOf, cardNumber, mayTake, meantForNow } from '../../../shared/work.ts'
import { nameFor, sameList, sameValues, useActions, useClock, useHub, type State } from '../data/store'
import { forAttention, type Waiting } from '../../../shared/waiting.ts'
import { useWaiting } from '../data/notify'
import { useFirst } from '../data/first'
import { heard } from '../data/sync'
import { AgentAvatar, CheckGlyph, Progress, RepoTag, Who, ago, checksSummary, codeRepo, stageTone, stoppedBlock, stoppedWords } from '../components/bits'
import { NewCardDialog } from '../components/NewCardDialog'
import { useMayChangeBinder } from './settings/access'
import { DebriefButton } from '../components/Debrief'
import { CardMenu, cardMenuItems } from '../components/CardMenu'
import { openMenu, openMenuUnder, type MenuItem } from '../components/ContextMenu'
import { attempt, toast } from '../components/Toast'
import { WaitingItems } from '../components/Waiting'
import { whatWaits } from '../components/waitingWords'
import { Dialog, Skeleton } from '../kit'
import { useUI } from '../ui'
import { go, href } from '../route'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const
const noProposals: Proposal[] = []
/** Done shows what finished in the last month: a board that keeps everything ever finished only grows. */
const doneShownMs = 30 * 24 * 3600_000
const doneCutoff = () => Date.now() - doneShownMs
const filterKey = 'binders-board-filter'
const sameLogin = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Everything on its way from a note to production, one column per stage, with what's happening beside it. */
export function Flow() {
  const allCards = useHub((state) => state.cards)
  const allProposals = useHub((state) => state.proposals)
  const agents = useHub((state) => state.agents)
  const noBinders = useHub((state) => !state.binders.length)
  // A reader sees the whole board and changes none of it: no New card, no dragging, no Accept or Dismiss.
  const may = useMayChangeBinder()
  // Until the hub has answered once, an empty column means nothing has arrived yet.
  const loaded = useHub((state) => heard(state.sync))
  const me = useHub((state) => state.me?.user.login)
  const { binder } = useUI()
  const [adding, setAdding] = useState(false)
  const [feedOpen, setFeedOpen] = useState(false)
  const [waitingOpen, setWaitingOpen] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
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
  // What waits on you, as Home lists it: one slim line over the board, and the list itself a press away.
  const attention = forAttention(useWaiting(binder))
  const board = useRef<HTMLDivElement>(null)
  const stageCounts = useMemo(() => columns.map(({ stage, cards: here }) => here.length + (stage.id === 'proposed' ? shownProposals.length : 0)), [columns, shownProposals])
  const filtering = cards.length > 0 && (!!me || filterAgents.length > 0)
  const activeName = active === 'mine' ? 'Mine' : agentOf ? filterAgents.find((a) => a.id === agentOf)?.name ?? 'Everyone' : 'Everyone'

  // Over the board, the activity panel closes on Escape, as anything else laid over it does.
  useEffect(() => {
    if (!feedOpen) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) setFeedOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [feedOpen])

  // A phone has no room for a chip each: the same choices in a menu, the one shown ticked.
  const viewItems = (): MenuItem[] => {
    const tick = (on: boolean) => (on ? <Check size={14} /> : <span className="menu-tick-space" />)
    return [
      { label: 'Everyone', icon: tick(!active), onSelect: () => choose('') },
      ...(me ? [{ label: 'Mine', icon: tick(active === 'mine'), onSelect: () => choose('mine') }] : []),
      ...filterAgents.map((a) => ({ label: a.name, icon: tick(active === `agent:${a.id}`), onSelect: () => choose(`agent:${a.id}`) })),
    ]
  }

  return (
    <div className={`flow${feedOpen ? ' feed-open' : ''}`}>
      <div className="flow-main">
        <div className="board-bar">
          {attention.length > 0 && <WaitingStrip rows={attention} onOpen={() => setWaitingOpen(true)} />}
          <div className="board-tools">
            {filtering && (
              <>
                <div className="board-filters" role="group" aria-label="Show only">
                  {me && <button type="button" aria-pressed={active === 'mine'} onClick={() => choose(active === 'mine' ? '' : 'mine')}>Mine</button>}
                  {filterAgents.map((a) => {
                    const key = `agent:${a.id}`
                    return <button key={a.id} type="button" aria-pressed={active === key} onClick={() => choose(active === key ? '' : key)}><AgentAvatar agent={a} size={16} /> {a.name}</button>
                  })}
                </div>
                <button type="button" className={`button small board-view${active ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={viewOpen} aria-label={`Show only: ${activeName}`} onClick={(event) => { if (openMenuUnder(event, viewItems(), { onClose: () => setViewOpen(false) })) setViewOpen(true) }}>
                  <ListFilter size={14} aria-hidden="true" /><span>{activeName}</span><ChevronDown size={14} aria-hidden="true" />
                </button>
              </>
            )}
            <div className="board-tools-end">
              {proposals.length > 0 && (
                <button type="button" className="button quiet small distilled-toggle" onClick={() => chooseDistilled(!showDistilled)}>
                  {showDistilled ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{showDistilled ? 'Hide proposed' : `Show ${proposals.length} proposed`}
                </button>
              )}
              <button type="button" className="button quiet small feed-toggle" onClick={() => setFeedOpen(!feedOpen)} aria-expanded={feedOpen} aria-controls="board-feed">
                <span className="live-dot" aria-hidden="true" />{feedOpen ? 'Hide activity' : 'Activity'}
              </button>
              {may && <button type="button" className="button primary board-new" onClick={() => setAdding(true)} disabled={noBinders}><Plus size={16} aria-hidden="true" /><span>New card</span></button>}
            </div>
          </div>
        </div>

        <StageSwitch counts={stageCounts} board={board} />

        <LayoutGroup>
          <div className="columns" ref={board}>
            {columns.map(({ stage, cards: here, older }) => (
              <Column key={stage.id} stage={stage} cards={here} proposals={stage.id === 'proposed' ? shownProposals : noProposals} hidden={stage.id === 'proposed' ? proposals.length - shownProposals.length : 0} older={older} olderShown={olderShown} toggleOlder={toggleOlder} agents={agents} loaded={loaded} drop={dropOn === stage.id} dragging={dragging} setDropOn={setDropOn} />
            ))}
          </div>
        </LayoutGroup>
      </div>

      <Feed cards={cards} agents={agents} close={() => setFeedOpen(false)} />

      <AnimatePresence>
        {adding && may && <NewCardDialog key="new" binderId={binder === 'all' ? undefined : binder} onClose={() => setAdding(false)} />}
        {waitingOpen && <WaitingDialog key="waiting" rows={attention} onClose={() => setWaitingOpen(false)} />}
      </AnimatePresence>
    </div>
  )
}

/**
 * What waits on you, in one line over the board: how many, and what they are. Pressing it opens the list, which is the
 * same as Home's, each row going where Home sends it.
 */
function WaitingStrip({ rows, onOpen }: { rows: Waiting[]; onOpen: () => void }) {
  // One thing waiting says which; several say what kinds.
  const what = rows.length === 1 ? `${whatWaits(rows)} · ${rows[0].title}` : whatWaits(rows)
  return (
    <button type="button" className="waiting-strip" aria-haspopup="dialog" onClick={onOpen}>
      <span className="waiting-strip-mark" aria-hidden="true" />
      <b>{rows.length} waiting on you</b>
      <span className="waiting-strip-what">{what}</span>
      <ChevronRight size={16} className="waiting-strip-go" aria-hidden="true" />
    </button>
  )
}

/** The list the strip opens: a dialog on a wide window, a sheet on a phone, with the Brain's drafts where it has them. */
function WaitingDialog({ rows, onClose }: { rows: Waiting[]; onClose: () => void }) {
  const first = useFirst(rows)
  const binders = useHub((state) => state.binders, sameList)
  const { binder } = useUI()
  return (
    <Dialog title="Waiting on you" onClose={onClose}>
      <div className="board-waiting">
        <WaitingItems rows={rows} first={first} binders={binder === 'all' && binders.length > 1 ? binders : []} />
      </div>
    </Dialog>
  )
}

const shortTitles: Partial<Record<Stage, string>> = { working: 'Working', review: 'Review' }

/**
 * A phone's board is a column a screen: this switch says what's in each stage and goes to it, and follows the board as
 * it's swiped. Hidden wider up, where every column shows.
 */
function StageSwitch({ counts, board }: { counts: number[]; board: RefObject<HTMLDivElement | null> }) {
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

  const go = (index: number) => {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    board.current?.children[index]?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', inline: 'start', block: 'nearest' })
  }

  return (
    <nav className="stage-chips" aria-label="Stages">
      {stages.map((stage, index) => (
        <button key={stage.id} type="button" aria-current={index === at ? 'true' : undefined} onClick={() => go(index)}>
          <span className="stage-chip-name">{shortTitles[stage.id] ?? stage.title}</span><span className="num"><i className={`dot ${stageTone[stage.id]}`} aria-hidden="true" />{counts[index]}</span>
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
  const may = useMayChangeBinder()
  const count = cards.length + proposals.length
  // Only a card an agent holds, blocked, can go back to working.
  const pausedHere = (id: string) => store.current().cards.some((c) => c.id === id && c.stage === 'blocked' && !!c.agentId)
  // A drop can't ask first like the buttons do, so one that takes a card from its agent says so after.
  const dropCard = (id: string) => {
    const state = store.current()
    const card = state.cards.find((c) => c.id === id)
    const held = !!card && (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
    store.moveCard(id, stage.id)
    if (held && stage.id === 'ready') toast(`Took it from ${state.agents.find((a) => a.id === card?.agentId)?.name ?? 'the agent'} and stopped its run.`)
  }
  const hint = `column-hint-${stage.id}`
  return (
    <section className={`column ${stage.id}${drop ? ' drop' : ''}`} aria-label={stage.title} aria-describedby={hint}
      onDragOver={(e) => { if (may && dragging.current && (stage.id !== 'working' || pausedHere(dragging.current))) { e.preventDefault(); setDropOn(stage.id) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn(undefined) }}
      onDrop={(e) => { e.preventDefault(); setDropOn(undefined); if (may && dragging.current) dropCard(dragging.current); dragging.current = undefined }}>
      {/* Its name and count; what the stage means is a hover away, and read out with it. */}
      <header title={stage.hint}>
        <i className={`dot ${stageTone[stage.id]}`} aria-hidden="true" />
        <h2>{stage.title}</h2>
        <span className="num">{count}</span>
      </header>
      <p className="sr-only" id={hint}>{stage.hint}</p>
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
          <div key={card.id} className="card-drag" draggable={may} onDragStart={(e) => { e.dataTransfer.setData('text/binders-card', card.id); e.dataTransfer.effectAllowed = 'move'; dragging.current = card.id }} onDragEnd={() => { dragging.current = undefined; setDropOn(undefined) }}>
            <CardView card={card} stage={stage.id} />
          </div>
        ))}
        {count === 0 && (!loaded
          ? (
            <div className="column-loading" role="status">
              <span className="sr-only">Loading…</span>
              <span className="card-skeleton" aria-hidden="true"><Skeleton width="40%" height={10} /><Skeleton lines={2} height={12} /></span>
              <span className="card-skeleton" aria-hidden="true"><Skeleton width="30%" height={10} /><Skeleton width="80%" height={12} /></span>
            </div>
          )
          : <div className="column-empty">{hidden ? `${hidden} proposed hidden` : 'Nothing here'}</div>)}
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
  const may = useMayChangeBinder()
  const { openItem, binder: inBinder } = useUI()
  // Which binder it's in says something only on a board of them all.
  const everyBinder = inBinder === 'all'
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
        <span className="card-facts">
          <span className="proposal-from"><Sparkles size={12} aria-hidden="true" />From a note</span>
          {binder && everyBinder && <span>{binder}</span>}
        </span>
        {agent && <span className="proposal-for" title={`Meant for ${agent.name}`}><AgentAvatar agent={agent} size={18} /></span>}
        {may && <button type="button" className="card-dismiss" aria-label="Dismiss" title="Dismiss" onClick={dismiss}><X size={14} /></button>}
      </div>
      <h3>
        <button type="button" className="proposal-open" aria-expanded={open} aria-controls={`proposal-${p.id}`} onClick={() => setOpen(!open)}>
          <span>{p.title}</span>
          <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
      </h3>
      {open && (
        <dl className="proposal-body" id={`proposal-${p.id}`}>
          <dt>Brief</dt>
          <dd>{p.brief || 'No brief.'}</dd>
          {p.doneWhen && <><dt>Done when</dt><dd>{p.doneWhen}</dd></>}
          <dt>Size</dt>
          <dd>{sizeNames[p.size]}</dd>
          {agent && <><dt>For</dt><dd>{agent.name}</dd></>}
          {p.quote && <><dt>From the note</dt><dd><q>{p.quote}</q></dd></>}
          {note && <dd><a className="link-row" href={href({ screen: 'notes', id: note.id })}>{note.title} <ArrowUpRight size={12} aria-hidden="true" /></a></dd>}
        </dl>
      )}
      {may && (
        <div className="proposal-actions">
          <button type="button" className="button small primary" onClick={() => void accept()}>Accept</button>
          <button type="button" className="button small" disabled={working} onClick={() => void editFirst()} title="Put it on the board in Proposed, where no agent takes it, and open it to change its words">Edit first</button>
        </div>
      )}
    </motion.div>
  )
}

/** What's been happening: every card's activity, newest first. Beside the board on a wide window, over it on the rest. */
const Feed = memo(function Feed({ cards, agents, close }: { cards: Card[]; agents: Agent[]; close: () => void }) {
  useClock()
  const loaded = useHub((state) => heard(state.sync))
  const feed = useMemo(() => cards
    .flatMap((card) => card.activity.filter((a) => a.kind !== 'step' && a.kind !== 'ran').map((a) => ({ ...a, card })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 40), [cards])
  return (
    <aside className="feed" id="board-feed" aria-label="Activity">
      <header>
        <h2>Activity</h2>
        <span className="live-dot" aria-hidden="true" />
        <button type="button" className="icon-button feed-close" aria-label="Close activity" onClick={close}><X size={16} /></button>
      </header>
      <ol>
        <AnimatePresence initial={false}>
          {feed.map((event) => (
            <motion.li key={`${event.card.id}-${event.at}-${event.text}`} layout initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={spring} className={`feed-row ${event.kind === 'question' ? 'ship' : ''}`}>
              <Who id={event.by} size={22} />
              <p>
                <b>{nameFor({ agents }, event.by)}</b> {event.text.length > 120 ? `${event.text.slice(0, 120)}…` : event.text}
                <button type="button" className="feed-card" onClick={() => go({ screen: 'work', id: event.card.id })}>{event.card.title}</button>
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

/**
 * A card on the board: one quiet line of facts, its title, a line for what's happening when something is, and a foot
 * with who has it and its pull request. What it waits for is in its colour and its line, so it shows across the room.
 */
const CardView = memo(function CardView({ card, stage }: { card: Card; stage: Stage }) {
  const store = useActions()
  const { openItem, splitCard } = useUI()
  const may = useMayChangeBinder()
  const split = splitCard && may ? () => splitCard(card.id) : undefined
  const select = useCallback((state: State) => cardFacts(state, card), [card])
  const { agent, pull, set, binder, noteTitle, untakeable } = useHub(select, sameValues)
  const asks = asksOf(card)
  const code = codeRepo(card, pull?.repo, binder?.repo)
  const checks = pull && checksSummary(pull.checks)

  return (
    // The whole card opens it for a pointer, and its title's button for a keyboard or a screen reader: a button can't hold the card's others.
    <motion.article layout layoutId={card.id} className={`card ${stage}${asks ? ' asks' : ''}${card.stopped || stoppedBlock(card) ? ' stopped' : ''}`} onClick={() => openItem(card.id)} onContextMenu={(e) => openMenu(e, cardMenuItems(card, store, openItem, split, may))} transition={spring} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
      <div className="card-top">
        <span className="card-facts">
          <span className="mono" title={card.jira ? `Its Jira issue: ${card.jira.key}` : card.issue ? `Its issue: #${card.issue.number} in ${card.issue.repo}` : undefined}>{cardNumber(card) ?? binder?.name}</span>
          {code && <RepoTag repo={code} title={pull ? `Its pull request is in ${code}` : `The binder’s repo: ${code}`} />}
          {set && !card.jira && <span className="set-tag" title={`In change set #${set.number}`}>CS-{set.number}</span>}
        </span>
        <CardMenu card={card} open={openItem} split={split} />
      </div>
      <h3><button type="button" className="card-open"><span>{card.title}</span></button></h3>
      {card.stopped
        ? <p className="card-stopped" title={`${stoppedWords(card.stopped.times)}: ${card.stopped.why}`}><OctagonAlert size={12} aria-hidden="true" /><span>{stoppedWords(card.stopped.times)}: {card.stopped.why}</span></p>
        // Its long question says what to do, which its page does; the board says who it's waiting on, which isn't an agent.
        : stoppedBlock(card) ? <p className="card-stopped"><OctagonAlert size={12} aria-hidden="true" /><span>Stopped twice</span></p>
        : asks && <p className="card-asks"><MessageCircleQuestion size={12} aria-hidden="true" /><span>Asks: {asks}</span></p>}
      {card.stopped && !stoppedBlock(card) && asks && <p className="card-asks"><MessageCircleQuestion size={12} aria-hidden="true" /><span>Asks: {asks}</span></p>}
      {stage === 'working' && card.progress !== undefined && (
        <div className="card-work">
          <Progress value={card.progress} />
          <span className="doing">{card.doing ?? 'Working'}</span>
        </div>
      )}
      <div className="card-foot">
        <span className="card-who">
          {agent
            ? <AgentAvatar agent={agent} size={20} live={stage === 'working'} />
            : <span className={untakeable ? 'unclaimed none' : 'unclaimed'} title={untakeable ? 'No agent works in this binder and its repo: set an agent’s binders and repos on the Agents page, or mean this card for one.' : undefined}>{stage === 'ready' ? (untakeable ? 'No agent can take it' : 'Any agent') : ''}</span>}
        </span>
        <span className="card-links">
          {(pull || stage === 'working' || stage === 'review') && <DebriefButton card={card} inline />}
          {pull && checks ? (
            <span className={`pr-mini ${checks.state}`} title={`Pull request #${pull.number}: ${checks.text}`}>
              <GitPullRequest size={12} aria-hidden="true" />
              <span className="mono">#{pull.number}</span>
              <CheckGlyph state={checks.state} size={12} />
              <span className="sr-only">{checks.text}</span>
            </span>
          ) : stage !== 'working' && stage !== 'review' && noteTitle ? (
            <span className="from-note" title={`From the note ${noteTitle}`}>{noteTitle}</span>
          ) : null}
        </span>
      </div>
    </motion.article>
  )
})
