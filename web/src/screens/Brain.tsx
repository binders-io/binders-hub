import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowUp, ArrowUpRight, Brain, Check, ChevronDown, FileText, LoaderCircle, MessageSquarePlus, SquareKanban } from 'lucide-react'
import { call } from '../data/api'
import { useActions, useHub } from '../data/store'
import { useMayChangeBinder } from './settings/access'
import { attempt } from '../components/Toast'
import { ConfirmButton } from '../components/ConfirmButton'
import { citeMark, Rendered } from '../components/Rendered'
import { onTouch, usePhone } from '../components/bits'
import { NewCardDialog } from '../components/NewCardDialog'
import { SettingsLink } from '../components/SettingsLink'
import { useKeyboardRoom } from '../components/useKeyboardRoom'
import { Rail } from '../brain/rail/Rail'
import { useNeedsYou } from '../brain/rail/useNeedsYou'
import { space } from '../data/space'
import { go } from '../route'
import { useUI } from '../ui'

// The Brain: where the hub's questions and its doings meet. Ask it about this binder's notes and cards, or every
// binder you're in, and it answers with the notes and cards the answer rests on numbered under it, and from how the work
// stands now. Without a model on the hub, the passages that match best. Home's question line and ⌘K's "Ask the Brain"
// row bring a question here. Asked to do something, it says what that would do, in the hub's own words, and does it only
// when you say so here. An answer can become a note or a card, and can carry a view (a picture of how things fit
// together) drawn under its words. Every question asked stays above the box with its answer, oldest first, and a question
// is asked with the last few before it, so a follow-up means what it follows. The hub keeps the conversation for the
// person, in this Binder, so it's here again on another device and after a reload; "New conversation" starts afresh.
// Beside the conversation, on a wide screen, is the rail called Now: what needs you, and what the agents are doing.
// On a narrow screen the two take turns, behind a switch at the top.

/** Below this width the conversation and the rail can't sit side by side: one shows at a time. */
export const narrowQuery = '(max-width: 1099px)'

/** Whether the window is too narrow for two columns: a phone, or anything under the width the rail needs. */
function useNarrow() {
  const phone = usePhone()
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches)
  useEffect(() => {
    const media = window.matchMedia(narrowQuery)
    const change = () => setNarrow(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return phone || narrow
}

/** What an answer draws under its words. It's loaded when the first one is shown: most answers have none. */
const BrainView = lazy(() => import('../brain/view/BrainView'))

/** What a person can start with, before anything is asked. */
const starters = ['What needs me?', 'What are my agents working on?', 'What’s in review?', 'Draw how the open work fits together']

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
  /** What to draw under the words, as the hub gave it: BrainView reads it, and draws nothing it can't make sense of. */
  view?: unknown
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
/** The conversation as this tab last had it, oldest first: shown at once when you come back, while the hub's is read again. */
let history: Turn[] = []

/** What the hub keeps of a turn: its question and what came of it. */
interface Kept {
  question: string
  result: Result
  everywhere: boolean
}

/** How many questions, with their answers, go along with a new one: the hub takes the last six. */
const taken = 6
/** The most of any one question or answer that goes along. */
const cutAt = 1200

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

/** The conversation so far, as the hub takes it with a new question: what was asked and what was answered, the latest few. */
const earlier = (list: Turn[]) => list.slice(-taken).flatMap((t) => [
  { role: 'user', text: t.question.slice(0, cutAt) },
  ...(t.result.answer ? [{ role: 'assistant', text: answerText(t.result.answer.parts).slice(0, cutAt) }] : []),
])

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
function Answer({ turn, onNote, onCard, onAsk, mayKeep }: { turn: Turn; onNote: (turn: Turn) => void; onCard: (turn: Turn) => void; onAsk: (question: string) => void; mayKeep: boolean }) {
  // Keeping an answer as a note or a card writes to the Binder: a reader reads it, and asks again.
  const may = useMayChangeBinder()
  const { result } = turn
  const [shown, setShown] = useState<number>()
  const [opened, setOpened] = useState<Set<number>>(new Set())
  const titles = useMemo(() => new Map(result.sources.map((s) => [s.n, s.title])), [result])
  const rows = useMemo(() => bySource(result.sources), [result])
  // What an answer rests on is listed under it; what was found and not used folds away, a press from being read. With
  // no answer, the passages are the answer, and all of them show.
  const cited = useMemo(() => new Set(result.answer?.parts.flatMap((part) => part.sources) ?? []), [result])
  const used = result.answer ? rows.filter((row) => row.passages.some((p) => cited.has(p.n))) : rows
  const unused = result.answer ? rows.filter((row) => !row.passages.some((p) => cited.has(p.n))) : []

  /** To a source in the list, in place: the screen's address stays, so the answer does too. */
  const toSource = (n: number) => {
    setShown(n)
    setOpened((was) => new Set(was).add(n))
    document.getElementById(`ask-source-${turn.id}-${n}`)?.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  }

  const list = (some: typeof rows) => (
    <ol className="ask-sources">
      {some.map(({ first, passages }) => (
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
  )

  // Its view, if the hub gave it one, drawn under the words. Asking from it sends that question as the next one.
  const drawn = result.view != null ? <Suspense fallback={null}><BrainView view={result.view} onAsk={onAsk} /></Suspense> : null

  return (
    <section id={`ask-turn-${turn.id}`} className="ask-result">
      <h2 className="ask-question">{turn.question}</h2>
      {result.proposal ? (
        <>
          <Proposed key={result.proposal.id} proposal={result.proposal} />
          {drawn}
        </>
      ) : result.answer ? (
        <>
          <Rendered
            className="ask-answer"
            text={answerMarkdown(result.answer.parts)}
            cite={(n) => <button type="button" className="ask-cite" title={titles.get(n)} onClick={() => toSource(n)} aria-label={`Source ${n}${titles.get(n) ? `: ${titles.get(n)}` : ''}`}>{n}</button>}
          />
          {drawn}
          {may && (
            <div className="ask-keep">
              <button type="button" className="button" disabled={!mayKeep} onClick={() => onNote(turn)}><FileText size={14} /> Save as a note</button>
              <button type="button" className="button" disabled={!mayKeep} onClick={() => onCard(turn)}><SquareKanban size={14} /> Make a card</button>
            </div>
          )}
        </>
      ) : (
        <p className="setup-note">
          {!result.sources.length ? 'Nothing in your binders matches that.' : result.problem ? `No answer: ${result.problem} The passages that match best are below.` : <>The hub has no model to answer with yet, so here are the passages that match best. An admin can set one up in <SettingsLink section="brain" />.</>}
        </p>
      )}
      {!result.proposal && used.length > 0 && (
        <>
          <h3 className="ask-sources-title">Sources</h3>
          {list(used)}
        </>
      )}
      {!result.proposal && unused.length > 0 && (
        <details className="ask-read">
          <summary>Also read <span className="num">{unused.length}</span></summary>
          {list(unused)}
        </details>
      )}
      <p className="faint ask-how"><Brain size={12} /> Found by {result.searchedBy}{result.model ? `, answered by ${result.model}` : ''}.</p>
    </section>
  )
}

export function BrainScreen({ asked: fromPalette }: { asked?: { question: string; at: number } }) {
  const phone = usePhone()
  const narrow = useNarrow()
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
  // On a narrow screen, which of the two is showing; the conversation stays where it was while the other does.
  const [tab, setTab] = useState<'talk' | 'now'>('talk')
  const [typing, setTyping] = useState(false)
  const needs = useNeedsYou().length
  const scroller = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  // While a question is typed on a phone, the page is as tall as what the keyboard leaves, so the box stays in view.
  useKeyboardRoom(narrow && typing && onTouch())

  // What an answer is kept in: the binder you're in, as a new note is; with all of them showing, the first.
  const target = binder !== 'all' && binders.some((b) => b.id === binder) ? binder : binders[0]?.id

  const asks = useRef(0)
  /** Whether a question has been answered here since this screen opened: the conversation read from the hub is then older. */
  const changed = useRef(false)
  /** The conversation the hub has, being read: a question waits for it, so it goes with what it follows. */
  const reading = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    let current = true
    reading.current = call<{ turns?: Kept[] }>('GET', '/api/brain/conversation').then((kept) => {
      // Something answered meanwhile is the newest word: the hub's list will have it next time.
      if (!current || changed.current || !kept?.turns) return
      history = kept.turns.map((t, i) => ({ id: i + 1, question: t.question, result: t.result, everywhere: t.everywhere }))
      setTurns(history)
      if (history.length) setEverywhere(history.at(-1)!.everywhere)
    }).catch(() => {})
    return () => { current = false }
  }, [])

  /** Sends a question. What's typed in the box is cleared once it's answered, unless the question didn't come from the box. */
  const send = useCallback(async (q: string, all: boolean, clear = true) => {
    const mine = ++asks.current
    setPending(q)
    await reading.current
    const result = await attempt(() => call<Result>('POST', '/api/brain/ask', { question: q, everywhere: all, turns: earlier(history) }))
    if (mine !== asks.current) return
    setPending(undefined)
    if (result) {
      changed.current = true
      history = [...history, { id: (history.at(-1)?.id ?? 0) + 1, question: q, result, everywhere: all }]
      setTurns(history)
      if (clear) setQuestion('')
    }
  }, [])

  // The hub forgets it, and so does this page.
  const startOver = async () => {
    if (!(await attempt(() => call('DELETE', '/api/brain/conversation')))) return
    asks.current++
    changed.current = true
    history = []
    setTurns(history)
    setQuestion('')
  }

  const submit = () => {
    const q = question.trim()
    if (q && !pending) void send(q, everywhere)
  }
  const ask = (event: FormEvent) => {
    event.preventDefault()
    submit()
  }
  // Enter sends and Shift+Enter makes a new line. While an input method is composing, Enter picks a candidate: it
  // doesn't send (some browsers report that as key code 229 once the composing has just ended).
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }
  /** A question put to it from a button or an answer's view: sent as the next one, unless one is already on its way. */
  const askNext = (q: string) => {
    if (!pending) void send(q, everywhere, false)
  }

  // A question from ⌘K or Home, once: coming back to this screen later doesn't ask it again.
  useEffect(() => {
    if (!fromPalette || lastAsked === fromPalette.at) return
    lastAsked = fromPalette.at
    setQuestion(fromPalette.question)
    setTab('talk')
    void send(fromPalette.question.trim(), false)
  }, [fromPalette, send])

  // The box grows with what's typed, from one line to about six, then scrolls.
  useLayoutEffect(() => {
    const field = box.current
    if (!field) return
    field.style.height = 'auto'
    const style = window.getComputedStyle(field)
    const line = parseFloat(style.lineHeight) || 22
    const room = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    field.style.height = `${Math.min(field.scrollHeight, line * 6 + room)}px`
  }, [question])

  // Coming back to the questions asked before, the latest is what's wanted; a new answer or a question on its way is
  // brought into view, as the box stays at the bottom and the page above it grows.
  useEffect(() => {
    const column = scroller.current
    if (column && history.length) column.scrollTop = column.scrollHeight
  }, [])
  const last = useRef({ turns: turns.length, pending })
  useEffect(() => {
    const now = { turns: turns.length, pending }
    const same = last.current.turns === now.turns && last.current.pending === now.pending
    last.current = now
    if (same) return
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    const at = pending ? document.getElementById('ask-pending') : document.getElementById(`ask-turn-${turns.at(-1)?.id}`)
    // Only the conversation moves: scrollIntoView would also shift the page behind it, whose own overflow is hidden.
    const box = scroller.current
    if (at && box) box.scrollTo?.({ top: at.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12, behavior })
    following.current = at?.id
  }, [turns, pending])

  // What's above the latest turn can still grow after it's brought into view: an earlier answer's view is drawn a
  // moment later, and a drawing later still. The latest stays where it was put until the person scrolls for themselves.
  const following = useRef<string>(undefined)
  useEffect(() => {
    const box = scroller.current
    const column = box?.firstElementChild
    if (!box || !column || typeof ResizeObserver === 'undefined') return
    const settle = () => {
      const at = following.current ? document.getElementById(following.current) : null
      if (at) box.scrollTop = at.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
    }
    const watch = new ResizeObserver(settle)
    watch.observe(column)
    const letGo = () => { following.current = undefined }
    box.addEventListener('wheel', letGo, { passive: true })
    box.addEventListener('touchmove', letGo, { passive: true })
    box.addEventListener('keydown', letGo)
    box.addEventListener('pointerdown', letGo)
    return () => {
      watch.disconnect()
      box.removeEventListener('wheel', letGo)
      box.removeEventListener('touchmove', letGo)
      box.removeEventListener('keydown', letGo)
      box.removeEventListener('pointerdown', letGo)
    }
  }, [])

  const empty = !turns.length && !pending

  return (
    <div className={`brain${narrow ? ' narrow' : ''}`}>
      {narrow && (
        <div className="brain-switch" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === 'talk'} onClick={() => setTab('talk')}>Talk</button>
          <button type="button" aria-pressed={tab === 'now'} onClick={() => setTab('now')}>Now{needs > 0 && <> <span className="count brain-count alert">{needs}</span></>}</button>
        </div>
      )}
      <div className="brain-talk" hidden={narrow && tab !== 'talk'}>
        <div className={`brain-scroll${empty ? ' empty' : ''}`} ref={scroller}>
          <div className="brain-column">
            {empty && (
              <header className="ask-intro">
                <h2>Brain</h2>
                <p>It answers from your notes and cards, and from how the work stands now. It can do things too, such as stop a card or start a release, and it asks you first.</p>
                <div className="brain-starters">
                  {starters.map((text) => <button key={text} type="button" className="brain-starter" onClick={() => askNext(text)}>{text}</button>)}
                </div>
              </header>
            )}

            <div className="brain-log" role="log" aria-live="polite" aria-label="Conversation with the Brain">
              {turns.map((turn) => (
                <Answer key={turn.id} turn={turn} mayKeep={!!target} onAsk={askNext} onNote={(t) => { if (target) go({ screen: 'notes', id: store.addNote(target, undefined, noteText(t, target)) }) }} onCard={setMaking} />
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
            </div>
          </div>
        </div>

        <form className="ask-form brain-compose" onSubmit={ask} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setTyping(false) }}>
          <div className="brain-column">
            <div className="ask-box">
              <textarea
                id="ask-question"
                ref={box}
                rows={1}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setTyping(true)}
                placeholder="Ask or tell the Brain…"
                aria-label="Ask or tell the Brain"
                autoComplete="off"
                enterKeyHint="send"
                maxLength={2000}
                autoFocus={empty && !phone && !narrow}
              />
              {/* Pressing it leaves the box focused, so the keyboard on a phone stays up and the page doesn't move under the finger. */}
              <button type="submit" className="ask-send" disabled={!question.trim() || !!pending} aria-label={pending ? 'Asking' : 'Ask'} onPointerDown={(e) => e.preventDefault()}>
                {pending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} strokeWidth={2.6} />}
              </button>
            </div>
            <div className="ask-foot">
              <label className="switch ask-scope" htmlFor="ask-everywhere">
                <input id="ask-everywhere" type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
                <span aria-hidden="true" />
                Every binder I’m in
              </label>
              {!empty && <ConfirmButton className="button ask-new" question="Start over? Press again" disabled={!!pending} onConfirm={() => void startOver()}><MessageSquarePlus size={14} /> New conversation</ConfirmButton>}
            </div>
            <p className="faint ask-follows">It remembers this conversation, so you can ask a follow-up.</p>
          </div>
        </form>
      </div>

      <aside className="brain-rail" aria-label="Now" hidden={narrow && tab !== 'now'}>
        <Rail />
      </aside>

      <AnimatePresence>
        {making?.result.answer && <NewCardDialog key="card" binderId={target} title={making.question} brief={answerText(making.result.answer.parts)} onClose={() => setMaking(undefined)} />}
      </AnimatePresence>
    </div>
  )
}
