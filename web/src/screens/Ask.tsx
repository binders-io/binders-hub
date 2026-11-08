import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, Brain, FileText, SquareKanban } from 'lucide-react'
import { call } from '../data/api'
import { attempt } from '../components/Toast'

// Ask: a question answered from this binder's notes and cards, or from every binder you're in, with the notes and cards
// the answer rests on numbered beside it. Without a model on the hub, the passages that match best. ⌘K is the way in:
// it searches as you type, and its Ask row brings the question here.

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
}

/** A source's address as this tab opens it: in place when it's in this binder, else the hub's address for it. */
function linkOf(source: Source) {
  try {
    const url = new URL(source.url)
    if (url.origin === window.location.origin && url.pathname === window.location.pathname) return url.hash
  } catch {
    // Not a full address: as it is.
  }
  return source.url
}

/** The last question from ⌘K this tab asked: this screen goes away and comes back, and asks each only once. */
let lastAsked = 0

export function Ask({ asked: fromPalette }: { asked?: { question: string; at: number } }) {
  const [question, setQuestion] = useState(fromPalette?.question ?? '')
  const [everywhere, setEverywhere] = useState(false)
  const [asking, setAsking] = useState(false)
  const [result, setResult] = useState<Result>()
  const [asked, setAsked] = useState('')
  const [shown, setShown] = useState<number>()

  /** To a source in the list, in place: the screen's address stays, so the answer does too. */
  const toSource = (n: number) => {
    setShown(n)
    document.getElementById(`ask-source-${n}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  }

  const asks = useRef(0)
  const send = useCallback(async (q: string, all: boolean) => {
    const mine = ++asks.current
    setAsking(true)
    const answered = await attempt(() => call<Result>('POST', '/api/brain/ask', { question: q, everywhere: all }))
    if (mine !== asks.current) return
    setAsking(false)
    if (answered) {
      setResult(answered)
      setAsked(q)
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

  return (
    <div className="ask">
      <form className="ask-form" onSubmit={ask}>
        <label className="field-label" htmlFor="ask-question">Ask your binders</label>
        <div className="ask-row">
          <input id="ask-question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What did we decide about the release?" autoComplete="off" maxLength={2000} />
          <button type="submit" className="button primary" disabled={!question.trim() || asking}>{asking ? 'Asking…' : 'Ask'}</button>
        </div>
        <label className="ask-scope">
          <input id="ask-everywhere" type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> Every binder I’m in, not only this one
        </label>
      </form>

      {result && (
        <section className="ask-result" aria-live="polite">
          <h2 className="ask-question">{asked}</h2>
          {result.answer ? (
            <p className="ask-answer">
              {result.answer.parts.map((part, i) => (
                <span key={i}>
                  {part.text}
                  {part.sources.map((n) => <button key={n} type="button" className="ask-cite" onClick={() => toSource(n)} aria-label={`Source ${n}`}>{n}</button>)}
                </span>
              ))}
            </p>
          ) : (
            <p className="setup-note">
              {!result.sources.length ? 'Nothing in your binders matches that.' : result.problem ? `No answer: ${result.problem} The passages that match best:` : 'The hub has no model to answer with yet, so here are the passages that match best. An admin can set one up in Settings, under Brain.'}
            </p>
          )}
          {result.sources.length > 0 && (
            <ol className="ask-sources">
              {result.sources.map((source) => (
                <li key={source.n} id={`ask-source-${source.n}`} className={shown === source.n ? 'shown' : undefined}>
                  <span className="ask-n num">{source.n}</span>
                  <div>
                    <a className="ask-source-title" href={linkOf(source)}>
                      {source.kind === 'note' ? <FileText size={13} /> : <SquareKanban size={13} />} {source.title}
                      {!linkOf(source).startsWith('#') && <ArrowUpRight size={12} />}
                    </a>
                    <span className="faint"> {source.binderName}{source.context ? ` · ${source.context}` : ''}</span>
                    <p className="ask-passage">{source.text.length > 420 ? `${source.text.slice(0, 420)}…` : source.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="faint ask-how"><Brain size={12} /> Found by {result.searchedBy}{result.model ? `, answered by ${result.model}` : ''}.</p>
        </section>
      )}
    </div>
  )
}
