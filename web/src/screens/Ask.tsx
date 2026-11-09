import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, ArrowUpRight, Brain, Check, ChevronDown, FileText, LoaderCircle, SquareKanban } from 'lucide-react'
import { call } from '../data/api'
import { attempt } from '../components/Toast'
import { citeMark, Rendered } from '../components/Rendered'
import { usePhone } from '../components/bits'
import { space } from '../data/space'

// Ask: a question answered from this binder's notes and cards, or from every binder you're in, with the notes and cards
// the answer rests on numbered under it, and from how the work stands now. Without a model on the hub, the passages that
// match best. ⌘K is the way in: it searches as you type, and its Ask row brings the question here. Asked to do something,
// it says what that would do, in the hub's own words, and does it only when you say so here.

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

interface Answered {
  question: string
  result: Result
  everywhere: boolean
}

/** The last question from ⌘K this tab asked: this screen goes away and comes back, and asks each only once. */
let lastAsked = 0
/** The last answer, in this tab: opening one of its sources and coming back finds it still here. */
let kept: Answered | undefined

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

/** Long enough that a passage shows its start, with the rest a tap away. */
const longPassage = 320

function Passage({ source, opened, onToggle }: { source: Source; opened: boolean; onToggle: () => void }) {
  const long = source.text.length > longPassage
  return (
    <div id={`ask-source-${source.n}`} className={`ask-passage${long && !opened ? ' clipped' : ''}`}>
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

export function Ask({ asked: fromPalette }: { asked?: { question: string; at: number } }) {
  const phone = usePhone()
  const fresh = fromPalette && lastAsked !== fromPalette.at
  const [question, setQuestion] = useState(fresh ? fromPalette.question : kept?.question ?? '')
  const [everywhere, setEverywhere] = useState(kept?.everywhere ?? false)
  const [asking, setAsking] = useState(false)
  const [answered, setAnswered] = useState<Answered | undefined>(fresh ? undefined : kept)
  const [shown, setShown] = useState<number>()
  const [opened, setOpened] = useState<Set<number>>(new Set())

  const asks = useRef(0)
  const send = useCallback(async (q: string, all: boolean) => {
    const mine = ++asks.current
    setAsking(true)
    setShown(undefined)
    setOpened(new Set())
    const result = await attempt(() => call<Result>('POST', '/api/brain/ask', { question: q, everywhere: all }))
    if (mine !== asks.current) return
    setAsking(false)
    if (result) {
      kept = { question: q, result, everywhere: all }
      setAnswered(kept)
    }
  }, [])

  const ask = (event: FormEvent) => {
    event.preventDefault()
    const q = question.trim()
    if (q && !asking) void send(q, everywhere)
  }

  // A question from ⌘K, once: coming back to this screen later doesn't ask it again.
  useEffect(() => {
    if (!fromPalette || lastAsked === fromPalette.at) return
    lastAsked = fromPalette.at
    setQuestion(fromPalette.question)
    void send(fromPalette.question.trim(), false)
  }, [fromPalette, send])

  /** To a source in the list, in place: the screen's address stays, so the answer does too. */
  const toSource = (n: number) => {
    setShown(n)
    setOpened((was) => new Set(was).add(n))
    document.getElementById(`ask-source-${n}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  }

  const result = answered?.result
  const titles = useMemo(() => new Map(result?.sources.map((s) => [s.n, s.title])), [result])
  const rows = useMemo(() => bySource(result?.sources ?? []), [result])
  const empty = !answered && !asking

  return (
    <div className={`ask${empty ? ' empty' : ''}`}>
      <div className="ask-column">
        {empty && (
          <header className="ask-intro">
            <h2>Ask your binders</h2>
            <p>Ask about your notes and cards, or how the work stands now. It can stop a card or start a release too, and asks you first.</p>
          </header>
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
            <button type="submit" className="ask-send" disabled={!question.trim() || asking} aria-label={asking ? 'Asking' : 'Ask'}>
              {asking ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} strokeWidth={2.6} />}
            </button>
          </div>
          <label className="switch ask-scope" htmlFor="ask-everywhere">
            <input id="ask-everywhere" type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
            <span aria-hidden="true" />
            Every binder I’m in
          </label>
        </form>

        {asking && (
          <div className="ask-waiting" role="status">
            <p>Reading your notes and cards…</p>
            <i /><i /><i />
          </div>
        )}

        {!asking && answered && result && (
          <section className="ask-result" aria-live="polite">
            <h2 className="ask-question">{answered.question}</h2>
            {result.proposal ? (
              <Proposed key={result.proposal.id} proposal={result.proposal} />
            ) : result.answer ? (
              <Rendered
                className="ask-answer"
                text={answerMarkdown(result.answer.parts)}
                cite={(n) => <button type="button" className="ask-cite" title={titles.get(n)} onClick={() => toSource(n)} aria-label={`Source ${n}${titles.get(n) ? `: ${titles.get(n)}` : ''}`}>{n}</button>}
              />
            ) : (
              <p className="setup-note">
                {!result.sources.length ? 'Nothing in your binders matches that.' : result.problem ? `No answer: ${result.problem} The passages that match best are below.` : 'The hub has no model to answer with yet, so here are the passages that match best. An admin can set one up in Settings, under Brain.'}
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
                      {(first.context || answered.everywhere) && <p className="ask-source-where faint">{first.context ?? first.binderName}</p>}
                      {passages.map((p) => (
                        <Passage key={p.n} source={p} opened={opened.has(p.n)} onToggle={() => setOpened((was) => {
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
        )}
      </div>
    </div>
  )
}
