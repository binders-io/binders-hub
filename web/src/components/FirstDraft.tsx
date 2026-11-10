import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, FileText, MessageCircleQuestion, Sparkles } from 'lucide-react'
import { sendFirst, stopFirst, type Draft, type Gathered } from '../data/first'
import { href } from '../route'
import { useMayChangeBinder } from '../screens/settings/access'
import { ConfirmButton } from './ConfirmButton'

// What the Brain drafted for the cards that wait on a person, drawn under their rows in the list of what waits: Home's
// list and the Brain's "Needs you" both use these. The Brain only drafts. Nothing goes to an agent until a person presses
// a button, and it goes as that person. Someone who can only read the Binder sees the drafts and no buttons.

/** Doing one thing at a time: whether it's under way, the hub's words when it was refused, and whether it went through. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const running = useRef(false)
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await work()
      setDone(true)
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : 'That didn’t go through. Try again.')
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { busy, error, done, run }
}

/** Said in place, and read out when it appears. */
const Refusal = ({ error }: { error: string }) => (error ? <p className="first-error" role="alert">{error}</p> : null)

/** What a draft rests on, each a link to that note or card. */
function Sources({ draft }: { draft: Draft }) {
  if (!draft.sources.length) return null
  return (
    <div className="first-from">
      <span>From</span>
      <ul>
        {draft.sources.map((source) => (
          <li key={`${source.kind}:${source.id}`}>
            <a href={href(source.kind === 'note' ? { screen: 'notes', id: source.id } : { screen: 'work', id: source.id })}>{source.title || (source.kind === 'note' ? 'A note' : 'A card')}</a>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The words of an answer, kept to about three lines until "More" is pressed. */
function Words({ words }: { words: string }) {
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const box = useRef<HTMLParagraphElement>(null)
  const id = useId()
  // The browser says whether the words are cut off at this width; where it can't say, a long text counts as cut off.
  useLayoutEffect(() => {
    const el = box.current
    if (el && !open && el.scrollHeight > el.clientHeight + 1) setOverflows(true)
  }, [words, open])
  const long = overflows || words.split('\n').length > 3 || words.length > 400
  return (
    <>
      <p className={open ? 'first-words open' : 'first-words'} id={id} ref={box}>{words}</p>
      {long && <button type="button" className="first-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>}
    </>
  )
}

/** The box a person changes the words in. Enter adds a line; only the button sends. */
function Editor({ text, setText, busy, label }: { text: string; setText: (text: string) => void; busy: boolean; label: string }) {
  return <textarea className="first-edit" aria-label={label} rows={4} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
}

/**
 * The Brain's answer to a card, or to several that ask the same thing (`all` is how many). Send puts it to the cards as
 * it is; Edit lets the words be changed first.
 */
export function AnswerDraft({ draft, cards, all }: { draft: Draft; cards: string[]; all?: number }) {
  const may = useMayChangeBinder()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(draft.words)
  const act = useAction()
  const label = all ? `Send to all ${all}` : 'Send'
  const send = (words: string) => void act.run(() => sendFirst(cards, words))
  const id = useId()
  return (
    <section className="first first-answer" aria-labelledby={id}>
      <p className="first-label" id={id}><Sparkles size={12} aria-hidden />The Brain would answer</p>
      {editing ? <Editor text={text} setText={setText} busy={act.busy} label="Your answer" /> : <Words words={draft.words} />}
      <Sources draft={draft} />
      {act.done ? <p className="first-sent" role="status">Sent.</p> : may && (
        <div className="first-actions">
          <button type="button" className="button primary" disabled={act.busy || (editing && !text.trim())} onClick={() => send(editing ? text.trim() : draft.words)}>{label}</button>
          {editing
            ? <button type="button" className="button" disabled={act.busy} onClick={() => { setEditing(false); setText(draft.words) }}>Cancel</button>
            : <button type="button" className="button" disabled={act.busy} onClick={() => { setText(draft.words); setEditing(true) }}>Edit</button>}
        </div>
      )}
      <Refusal error={act.error} />
    </section>
  )
}

/** For cards that ask the same thing and have no draft: a button that opens a box to answer them all at once. */
export function AnswerAll({ cards }: { cards: string[] }) {
  const may = useMayChangeBinder()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const act = useAction()
  const n = cards.length
  if (act.done) return <p className="first-sent" role="status">Sent.</p>
  if (!may) return null
  return (
    <div className="first first-answer-all">
      {editing && <Editor text={text} setText={setText} busy={act.busy} label={`Your answer to all ${n}`} />}
      <div className="first-actions">
        {editing ? (
          <>
            <button type="button" className="button primary" disabled={act.busy || !text.trim()} onClick={() => void act.run(() => sendFirst(cards, text.trim()))}>{`Send to all ${n}`}</button>
            <button type="button" className="button" disabled={act.busy} onClick={() => { setEditing(false); setText('') }}>Cancel</button>
          </>
        ) : <button type="button" className="button" onClick={() => setEditing(true)}>{`Answer all ${n}`}</button>}
      </div>
      <Refusal error={act.error} />
    </div>
  )
}

/** The Brain's note that another try will probably pass, with a button that says so to the card. */
function AgainDraft({ draft }: { draft: Draft }) {
  const may = useMayChangeBinder()
  const act = useAction()
  return (
    <section className="first first-again" aria-label="The Brain’s note">
      <p className="first-line"><Sparkles size={12} aria-hidden />{draft.words}</p>
      {act.done ? <p className="first-sent" role="status">Sent.</p> : may && (
        <div className="first-actions">
          <button type="button" className="button" disabled={act.busy} onClick={() => void act.run(() => sendFirst([draft.card], 'Try again.'))}>Try again</button>
        </div>
      )}
      <Refusal error={act.error} />
    </section>
  )
}

/** What the Brain has for a card, drawn by what kind of draft it is. A line that's the person's to decide has no button. */
export function DraftBlock({ draft }: { draft: Draft }) {
  if (draft.kind === 'answer') return <AnswerDraft draft={draft} cards={[draft.card]} />
  if (draft.kind === 'again') return <AgainDraft draft={draft} />
  return (
    <section className="first first-yours" aria-label="The Brain’s note">
      <p className="first-line">{`Yours to decide: ${draft.words}`}</p>
    </section>
  )
}

/** The cards of a group, folded away until asked for: a real disclosure, so the keyboard and a screen reader have it. */
function Cards({ n, children }: { n: number; children: ReactNode }) {
  return (
    <details className="first-cards">
      <summary><ChevronRight size={13} aria-hidden />{`Show the ${n} cards`}</summary>
      {children}
    </details>
  )
}

/**
 * Several cards that wait for the same thing, as one row. `rows` is what the list draws for each (a row that opens its
 * card, and for a note's cards its own draft); `answer` is the one draft for a question they all ask, if the Brain has it.
 */
export function GroupRow({ group, cards, answer, rows }: { group: Gathered; cards: string[]; answer?: Draft; rows: ReactNode }) {
  const may = useMayChangeBinder()
  const n = cards.length
  const stop = useAction()
  const asked = group.why === 'question'
  const Icon = asked ? MessageCircleQuestion : FileText
  return (
    <li className="first-group">
      <div className="first-group-head">
        <Icon size={14} className="amber" aria-hidden />
        <span>
          <b>{asked ? `${n} cards ask the same thing` : `${n} cards from “${group.title}” are waiting on you`}</b>
          {asked && <em>{group.title}</em>}
        </span>
      </div>
      {asked && (answer ? <AnswerDraft draft={answer} cards={cards} all={n} /> : <AnswerAll cards={cards} />)}
      {!asked && may && (
        stop.done ? <p className="first-sent" role="status">Stopped.</p> : (
          <div className="first-stop">
            <ConfirmButton question={`Stop all ${n}? Press again`} disabled={stop.busy} onConfirm={() => void stop.run(() => stopFirst(cards))}>{`Stop all ${n}`}</ConfirmButton>
            <small>Stopping moves them to Proposed, where no agent picks them up.</small>
            <Refusal error={stop.error} />
          </div>
        )
      )}
      <Cards n={n}>{rows}</Cards>
    </li>
  )
}
