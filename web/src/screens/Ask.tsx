import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowUp, ArrowUpRight, Brain, Check, ChevronDown, FileText, LoaderCircle, SquareKanban } from 'lucide-react'
import { call } from '../data/api'
import { useActions, useHub } from '../data/store'
import { attempt } from '../components/Toast'
import { citeMark, Rendered } from '../components/Rendered'
import { usePhone } from '../components/bits'
import { NewCardDialog } from '../components/NewCardDialog'
import { SettingsLink } from '../components/SettingsLink'
import { space } from '../data/space'
import { go } from '../route'
import { useUI } from '../ui'

// Ask: a question answered from this binder's notes and cards, or from every binder you're in, with the notes and cards
// the answer rests on numbered under it, and from how the work stands now. Without a model on the hub, the passages that
// match best. Home's question line and ⌘K's Ask row bring a question here. Asked to do something, it says what that
// would do, in the hub's own words, and does it only when you say so here. An answer can become a note or a card.
// Every question asked in this visit stays above the box with its answer, oldest first. Each is asked alone: nothing
// before it is sent along.

interface Source {
  n: number
  binder: string
  binderName: string
  kind: 'note' | 'card'
  id: string
  title: string
  context?: string
  text: string
  url: string
}

interface Result {
  answer?: { text: string; parts: { text: string; sources: number[] }[] }
  sources: Source[]
  model?: string
  searchedBy: 'words' | 'words and meaning'
  problem?: string
  proposal?: Proposal
}

/** Something it would do, once you say so. */
interface Proposal {
  id: string
  what: string
  button: string
}

interface Turn {
  id: number
  question: string
  result: Result
  everywhere: boolean
}

/** The last question from ⌘K or Home this tab asked: this screen goes away and comes back, and asks each only once. */
let lastAsked = 0
/** Every question and answer in this tab, oldest first: opening one of the sources and coming back finds them still here. A reload clears them. */
let history: Turn[] = []

/** A source's address as this tab opens it: in place when it's in this binder, else the hub's address for it. */
function linkOf(source: Source) {
  try {
    const url = new URL(source.url)
    // The first Binder's address is the hub's bare one, and it's in place at its own too.
    if (url.origin === window.location.origin && (url.pathname === window.location.pathname || source.binder === space)) return url.hash
  } catch {
    // Not a full address: as it is.
  }
  return source.url
}

/** The answer as one piece of Markdown, each stretch's citations at its end, before any space that ends it. */
const answerMarkdown = (parts: { text: string; sources: number[] }[]) =>
  parts.map((part) => part.text.replace(/\s*$/, (space) => `${part.sources.map(citeMark).join('')}${space}`)).join('')

/** A note or card with the passages of it that were found: a source often has two, and is one row. */
function bySource(sources: Source[]) {
  const rows = new Map<string, { first: Source; passages: Source[] }>()
  for (const source of sources) {
    const key = `${source.binder}:${source.kind}:${source.id}`
    const row = rows.get(key)
    if (row) row.passages.push(source)
    else rows.set(key, { first: source, passages: [source] })
  }
  return [...rows.values()]
}

/** The answer as plain words, with no citation marks, for a note or a card's brief. */
const answerText = (parts: { text: string; sources: number[] }[]) => parts.map((part) => part.text).join('').trim()

/** A source as a link in a note: a note of the same binder by its title, as notes link to each other; anything else by its address. */
function sourceLink(source: Source, binder: string) {
  if (source.kind === 'note' && source.binder === binder && !/[[\]|#^\n]/.test(source.title)) return `[[${source.title}]]`
  return `[${source.title.replace(/[[\]\n]/g, '')}](${linkOf(source)})`
}

/** What "Save as a note" writes: the question as its title, the answer, then each source it rests on as a link. */
function noteText(turn: Turn, binder: string) {
  const links = bySource(turn.result.sources).map(({ first }) => `- ${sourceLink(first, binder)}`)
  return `# ${turn.question.replace(/\s+/g, ' ').trim()}\n\n${answerText(turn.result.answer?.parts ?? [])}\n${links.length ? `\n## Sources\n\n${links.join('\n')}\n` : ''}`
}

/** Long enough that a passage shows its start, with the rest a tap away. */
const longPassage = 320

function Passage({ turn, source, opened, onToggle }: { turn: number; source: Source; opened: boolean; onToggle: () => void }) {
  const long = source.text.length > longPassage
  return (
    <div id={`ask-source-${turn}-${source.n}`} className={`ask-passage${long && !opened ? ' clipped' : ''}`}>
      <Rendered text={source.text} compact />
      {long && (
        <button type="button" className="ask-more" aria-expanded={opened} onClick={onToggle}>
          <ChevronDown size={13} style={{ transform: opened ? 'rotate(180deg)' : undefined }} /> {opened ? 'Show less' : 'Show all of it'}
        </button>
      )}
    </div>
  )
}

function Proposed({ proposal }: { proposal: Proposal }) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string>()
  const answer = async (go: boolean) => {
    setBusy(true)
    const done = await attempt(() => call<{ said: string }>('POST', '/api/brain/do', { id: proposal.id, go }))
    setBusy(false)
    if (done) setSaid(done.said)
  }
  return (
    <div className="ask-do">
      <p>{proposal.what}</p>
      {said ? (
        <p className="ask-did" role="status"><Check size={14} /> {said}</p>
      ) : (
        <div className="ask-do-buttons">
          <button type="button" className="button primary" disabled={busy} onClick={() => void answer(true)}>{busy ? <LoaderCircle size={14} className="spin" /> : null} {proposal.button}</button>
          <button type="button" className="button" disabled={busy} onClick={() => void answer(false)}>Not now</button>
        </div>
      )}
    </div>
  )
}

/** One question and what came of it: its answer with the citations in place, what to do with it, and the sources. */
function Answer({ turn, onNote, onCard, mayKeep }: { turn: Turn; onNote: (turn: Turn) => void; onCard: (turn: Turn) => void; mayKeep: boolean }) {
  const { result } = turn
  const [shown, setShown] = useState<number>()
  const [opened, setOpened] = useState<Set<number>>(new Set())
  const titles = useMemo(() => new Map(result.sources.map((s) => [s.n, s.title])), [result])
  const rows = useMemo(() => bySource(result.sources), [result])

  /** To a source in the list, in place: the screen's address stays, so the answer does too. */
  const toSource = (n: number) => {
    setShown(n)
    setOpened((was) => new Set(was).add(n))
    document.getElementById(`ask-source-${turn.id}-${n}`)?.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  }

  return (
    <section id={`ask-turn-${turn.id}`} className="ask-result" aria-live="polite">
      <h2 className="ask-question">{turn.question}</h2>
      {result.proposal ? (
        <Proposed key={result.proposal.id} proposal={result.proposal} />
      ) : result.answer ? (
        <>
          <Rendered
            className="ask-answer"
            text={answerMarkdown(result.answer.parts)}
            cite={(n) => <button type="button" className="ask-cite" title={titles.get(n)} onClick={() => toSource(n)} aria-label={`Source ${n}${titles.get(n) ? `: ${titles.get(n)}` : ''}`}>{n}</button>}
          />
          <div className="ask-keep">
            <button type="button" className="button" disabled={!mayKeep} onClick={() => onNote(turn)}><FileText size={14} /> Save as a note</button>
            <button type="button" className="button" disabled={!mayKeep} onClick={() => onCard(turn)}><SquareKanban size={14} /> Make a card</button>
          </div>
        </>
      ) : (
        <p className="setup-note">
          {!result.sources.length ? 'Nothing in your binders matches that.' : result.problem ? `No answer: ${result.problem} The passages that match best are below.` : <>The hub has no model to answer with yet, so here are the passages that match best. An admin can set one up in <SettingsLink section="brain" />.</>}
        </p>
      )}
      {rows.length > 0 && !result.proposal && (
        <>
          <h3 className="ask-sources-title">Sources</h3>
          <ol className="ask-sources">
            {rows.map(({ first, passages }) => (
              <li key={`${first.binder}:${first.kind}:${first.id}`} className={passages.some((p) => p.n === shown) ? 'shown' : undefined}>
                <div className="ask-source-head">
                  {first.kind === 'note' ? <FileText size={14} /> : <SquareKanban size={14} />}
                  <a className="ask-source-title" href={linkOf(first)}>
                    {first.title}
                    {!linkOf(first).startsWith('#') && <ArrowUpRight size={12} />}
                  </a>
                  <span className="ask-ns num">{passages.map((p) => <span key={p.n} className="ask-n">{p.n}</span>)}</span>
                </div>
                {(first.context || turn.everywhere) && <p className="ask-source-where faint">{first.context ?? first.binderName}</p>}
                {passages.map((p) => (
                  <Passage key={p.n} turn={turn.id} source={p} opened={opened.has(p.n)} onToggle={() => setOpened((was) => {
                    const next = new Set(was)
                    if (!next.delete(p.n)) next.add(p.n)
                    return next
                  })} />
                ))}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="faint ask-how"><Brain size={12} /> Found by {result.searchedBy}{result.model ? `, answered by ${result.model}` : ''}.</p>
    </section>
  )
}

export function Ask({ asked: fromPalette }: { asked?: { question: string; at: number } }) {
  const phone = usePhone()
  const store = useActions()
  const binders = useHub((state) => state.binders)
  const { binder } = useUI()
  const fresh = fromPalette && lastAsked !== fromPalette.at
  const [question, setQuestion] = useState(fresh ? fromPalette.question : '')
  const [everywhere, setEverywhere] = useState(history.at(-1)?.everywhere ?? false)
  // The question on its way, shown where its answer will be.
  const [pending, setPending] = useState<string>()
  const [turns, setTurns] = useState(history)
  const [making, setMaking] = useState<Turn>()
  const scroller = useRef<HTMLDivElement>(null)

  // What an answer is kept in: the binder you're in, as a new note is; with all of them showing, the first.
  const target = binder !== 'all' && binders.some((b) => b.id === binder) ? binder : binders[0]?.id

  const asks = useRef(0)
  const send = useCallback(async (q: string, all: boolean) => {
    const mine = ++asks.current
    setPending(q)
    const result = await attempt(() => call<Result>('POST', '/api/brain/ask', { question: q, everywhere: all }))
    if (mine !== asks.current) return
    setPending(undefined)
    if (result) {
      history = [...history, { id: (history.at(-1)?.id ?? 0) + 1, question: q, result, everywhere: all }]
      setTurns(history)
      setQuestion('')
    }
  }, [])

  const ask = (event: FormEvent) => {
    event.preventDefault()
    const q = question.trim()
    if (q && !pending) void send(q, everywhere)
  }

  // A question from ⌘K or Home, once: coming back to this screen later doesn't ask it again.
  useEffect(() => {
    if (!fromPalette || lastAsked === fromPalette.at) return
    lastAsked = fromPalette.at
    setQuestion(fromPalette.question)
    void send(fromPalette.question.trim(), false)
  }, [fromPalette, send])

  // Coming back to the questions asked before, the latest is what's wanted; a new answer or a question on its way is
  // brought into view, as the box stays at the bottom and the page above it grows.
  useEffect(() => {
    const box = scroller.current
    if (box && history.length) box.scrollTop = box.scrollHeight
  }, [])
  const last = useRef({ turns: turns.length, pending })
  useEffect(() => {
    const now = { turns: turns.length, pending }
    const same = last.current.turns === now.turns && last.current.pending === now.pending
    last.current = now
    if (same) return
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    const at = pending ? document.getElementById('ask-pending') : document.getElementById(`ask-turn-${turns.at(-1)?.id}`)
    at?.scrollIntoView?.({ behavior, block: 'start' })
  }, [turns, pending])

  const empty = !turns.length && !pending

  return (
    <div className={`ask${empty ? ' empty' : ''}`} ref={scroller}>
      <div className="ask-column">
        {empty && (
          <header className="ask-intro">
            <h2>Ask your binders</h2>
            <p>Ask about your notes and cards, or how the work stands now. It can stop a card or start a release too, and asks you first.</p>
          </header>
        )}

        {turns.map((turn) => (
          <Answer key={turn.id} turn={turn} mayKeep={!!target} onNote={(t) => { if (target) go({ screen: 'notes', id: store.addNote(target, undefined, noteText(t, target)) }) }} onCard={setMaking} />
        ))}

        {pending && (
          <section id="ask-pending" className="ask-result">
            <h2 className="ask-question">{pending}</h2>
            <div className="ask-waiting" role="status">
              <p>Reading your notes and cards…</p>
              <i /><i /><i />
            </div>
          </section>
        )}

        <form className="ask-form" onSubmit={ask}>
          <div className="ask-box">
            <input
              id="ask-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What did we decide about the release?"
              aria-label="Ask your binders"
              autoComplete="off"
              enterKeyHint="send"
              maxLength={2000}
              autoFocus={empty && !phone}
            />
            <button type="submit" className="ask-send" disabled={!question.trim() || !!pending} aria-label={pending ? 'Asking' : 'Ask'}>
              {pending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} strokeWidth={2.6} />}
            </button>
          </div>
          <label className="switch ask-scope" htmlFor="ask-everywhere">
            <input id="ask-everywhere" type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
            <span aria-hidden="true" />
            Every binder I’m in
          </label>
        </form>
      </div>
      <AnimatePresence>
        {making?.result.answer && <NewCardDialog key="card" binderId={target} title={making.question} brief={answerText(making.result.answer.parts)} onClose={() => setMaking(undefined)} />}
      </AnimatePresence>
    </div>
  )
}
