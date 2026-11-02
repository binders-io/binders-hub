import { useEffect, useState, type MouseEvent } from 'react'
import { ReasoningPicker, reasoningWords } from './Reasoning'
import { Check, CircleDashed, ClipboardList, Copy, FlaskConical, Square, Volume2, X } from 'lucide-react'
import { Github } from './Github'
import { debriefable, debriefSpeech, outOfDate, setChangeSet, setOfCard, testPlanMarkdown, testTally, testTextMost, type Debrief, type Mark, type TestCase, type TestOutcome } from '../../../shared/changeSet.ts'
import type { Card, ChangeSet } from '../data/model'
import { nameFor, useActions, useHub, useStore } from '../data/store'
import { ago } from './bits'
import { attempt, toast } from './Toast'
import { href } from '../route'

// A debrief: what a change set proposes, all its pull requests together, written by an agent when a person asks (a card
// not in a set yet has its own, of its worktree). Asking on a card in a set asks for its set's. The view shows its five
// sections, on the card's full screen and the change set's, and reads them aloud.

const pending = (debrief?: Debrief) => !!debrief && (debrief.state === 'asked' || debrief.state === 'writing')

/** Asks an agent for the card's debrief. `inline` is a chip for a card on the board: the click doesn't open the card too. */
export function DebriefButton({ card, inline = false, className = 'button' }: { card: Card; inline?: boolean; className?: string }) {
  const { debrief } = useActions()
  // In a change set, the set's: all its pull requests together.
  const set = useHub((state) => (debriefable(card.stage) ? setOfCard(state, card) : undefined))
  const live = set ? set.debrief : card.debrief
  const writer = useHub((state) => (live ? nameFor(state, live.agentId) : ''))
  if (!debriefable(card.stage)) return null
  const busy = pending(live)
  const label = busy ? 'Debriefing…' : live?.state === 'done' ? 'Debrief again' : 'Debrief'
  const title = busy ? `${writer} is writing its debrief` : set ? `An agent reads all of change set #${set.number}’s pull requests together and writes one debrief` : 'An agent reads what this card’s work proposes and writes a debrief'
  const ask = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    if (!busy) void attempt(() => debrief(card.id))
  }
  if (inline) {
    return (
      <button type="button" aria-disabled={busy} className={`debrief-chip${busy ? ' busy' : ''}`} title={title} onClick={ask}>
        <ClipboardList size={11} /> {busy ? 'Debriefing' : 'Debrief'}
      </button>
    )
  }
  const button = <button type="button" className={className} disabled={busy} title={title} onClick={ask}><ClipboardList size={13} /> {label}</button>
  return busy ? button : <span className="challenge-ask"><ReasoningPicker />{button}</span>
}

const markIcon: Record<Mark, typeof Check> = { met: Check, 'partly met': CircleDashed, 'not met': X }
const markTone: Record<Mark, string> = { met: 'mark-met', 'partly met': 'mark-partly', 'not met': 'mark-not' }
const sourceText = { pull: 'the pull request', worktree: 'the worktree, before a pull request', none: 'the card alone: there was no diff yet' }

/** Reads a debrief aloud in the browser's voice (on a phone too), and stops when asked or when the card is left. */
function ReadAloud({ words }: { words: string }) {
  const speech = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const [speaking, setSpeaking] = useState(false)
  // Leaving the card, or a new writing of it, stops what's being said.
  useEffect(() => () => speech?.cancel(), [speech, words])
  if (!speech) return null
  const toggle = () => {
    speech.cancel()
    if (speaking) return setSpeaking(false)
    const utterance = new SpeechSynthesisUtterance(words)
    utterance.onend = utterance.onerror = () => setSpeaking(false)
    setSpeaking(true)
    speech.speak(utterance)
  }
  return (
    <button type="button" className="text-button" aria-pressed={speaking} title={speaking ? 'Stop reading it' : 'Read the debrief aloud'} onClick={toggle}>
      {speaking ? <Square size={12} /> : <Volume2 size={13} />} {speaking ? 'Stop' : 'Read aloud'}
    </button>
  )
}

/** Asks for a change set's debrief, from its page. */
export function SetDebriefButton({ set, className = 'button' }: { set: ChangeSet; className?: string }) {
  const store = useStore()
  const busy = pending(set.debrief)
  const label = busy ? 'Debriefing…' : set.debrief?.state === 'done' ? 'Debrief again' : 'Debrief'
  const button = (
    <button type="button" className={className} disabled={busy} title={busy ? `${nameFor(store.state, set.debrief!.agentId)} is writing its debrief` : 'An agent reads all its pull requests together and writes one debrief'}
      onClick={() => void attempt(() => store.setDebrief(set.id))}>
      <ClipboardList size={13} /> {label}
    </button>
  )
  return busy ? button : <span className="challenge-ask"><ReasoningPicker />{button}</span>
}

/**
 * A debrief: a change set's (on its page, or on one of its cards, as the card's copy of it), or a card's own. Who's
 * writing it, or its five sections; out of date once new commits land.
 */
export function DebriefView({ card, set }: { card?: Card; set?: ChangeSet }) {
  const { state } = useStore()
  // On a card in a set, the set's: as it's being written, and its last one.
  const inSet = set ?? (card ? setOfCard(state, card) : undefined)
  // A set's keeps its last sections while it's written again; a card from before it was in a set shows its own.
  const debrief = set ? set.debrief : inSet?.debrief ?? card?.debrief
  if (!debrief) return null
  // Whose it is: the set's, or the card's own from before it was in one.
  const of = set ?? (inSet?.debrief ? inSet : undefined)
  const title = of ? `change set ${of.number}` : card!.title
  const agent = nameFor(state, debrief.agentId)
  const written = debrief.does !== undefined
  const met = debrief.against?.filter((p) => p.mark === 'met').length ?? 0
  const pull = card ? state.pulls.find((p) => p.id === card.prId) ?? state.pulls.find((p) => p.cardId === card.id) : undefined
  const head = of ? setChangeSet(state, of.id)?.head : pull?.head
  const moved = outOfDate(debrief, head)
  const again = inSet ? <SetDebriefButton set={inSet} className="text-button" /> : <DebriefButton card={card!} className="text-button" />
  const since = debrief.since
  return (
    <section className="work-section debrief" aria-label="Debrief">
      <h2>
        Debrief
        {written && debrief.against && <span className="num faint">{met} of {debrief.against.length} met</span>}
        <span className="debrief-actions">
          {written && <ReadAloud words={debriefSpeech(debrief, { title, agent })} />}
          {again}
        </span>
      </h2>
      {of && <p className="faint small">Of change set #{of.number}: all {of.prIds.length === 1 ? 'its pull request' : `its ${of.prIds.length} pull requests`} together{card && !set ? <>, <a href={href({ screen: 'changes', id: of.id })} onClick={() => { try { window.localStorage.setItem('binders-set-tab', 'debrief') } catch { /* only a convenience */ } }}>on its page</a></> : null}.</p>}
      {moved && !pending(debrief) && <p className="debrief-status moved">{of ? 'Its pull requests have' : 'The pull request has'} new commits since this debrief. Debrief again to see what changed.</p>}
      {pending(debrief) && <p className="debrief-status working">{agent} {debrief.state === 'asked' ? `will write it as soon as its runner is listening` : `is writing it${debrief.doing ? `: ${debrief.doing}` : ''}`}.{written ? ' The last one is below.' : ''}</p>}
      {debrief.state === 'failed' && <p className="debrief-status failed">{agent} couldn’t write it: {debrief.failed}{written ? ' The last one is below.' : ''}</p>}
      {written && (
        <>
          <p className="faint small">By {agent}{debrief.writtenAt ? `, ${ago(debrief.writtenAt)}` : ''}, from {sourceText[debrief.source ?? 'none']}. Asked by {nameFor(state, debrief.askedBy)}{debrief.effort ? `, ${reasoningWords(debrief.effort)}` : ''}.{debrief.comment && <> <a href={debrief.comment.url} target="_blank" rel="noreferrer"><Github size={11} /> On GitHub</a></>}</p>
          {since && (
            <div className="debrief-since">
              <h3>Since last debrief</h3>
              <p className="debrief-does">{since.what}</p>
              <ul className="debrief-commits">
                {since.commits.map((c) => (
                  <li key={c.sha}>
                    <code>{c.sha.slice(0, 7)}</code> {c.title}
                    {c.by && <span className="faint"> · {c.by}</span>}
                  </li>
                ))}
              </ul>
              {since.files?.length ? <p className="faint small">{since.files.length} file{since.files.length === 1 ? '' : 's'} touched: {since.files.slice(0, 12).join(', ')}{since.files.length > 12 ? ` and ${since.files.length - 12} more` : ''}</p> : null}
            </div>
          )}
          <h3>What it does</h3>
          <p className="debrief-does">{debrief.does}</p>
          <h3>What changed</h3>
          <dl className="debrief-changes">
            {debrief.changes?.map((c, i) => <div key={i}><dt>{c.area}</dt><dd>{c.what}</dd></div>)}
          </dl>
          <h3>Against the brief</h3>
          <ul className="debrief-against">
            {debrief.against?.map((p, i) => {
              const Icon = markIcon[p.mark]
              return (
                <li key={i} className={markTone[p.mark]}>
                  <span className="debrief-mark"><Icon size={11} strokeWidth={3} /> {p.mark}</span>
                  <div><b>{p.point}</b>{p.where && <span>{p.where}</span>}</div>
                </li>
              )
            })}
          </ul>
          <h3>Things to look at</h3>
          {debrief.lookAt?.length ? <ul className="debrief-look">{debrief.lookAt.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="faint">Nothing stood out.</p>}
          <h3>How to try it</h3>
          <p className="debrief-try">{debrief.tryIt}</p>
          {debrief.testPlan?.length ? <TestPlan id={of?.id ?? card!.id} plan={debrief.testPlan} title={of ? `change set #${of.number}: ${of.title}` : card!.title} /> : null}
        </>
      )}
    </section>
  )
}

const riskTone = { high: 'risk-high', medium: 'risk-medium', low: 'risk-low' } as const

/**
 * A debrief's functional test plan: what to run against the product to see it does what the spec says, riskiest first.
 * Whoever runs a test marks it passed or failed (with a line on what they saw when it fails); marking it again clears it.
 */
export function TestPlan({ id, plan, title }: { id: string; plan: TestCase[]; title: string }) {
  const { recordTest } = useActions()
  const { state } = useStore()
  const [noting, setNoting] = useState<string>()
  const [note, setNote] = useState('')
  const { total, passed, failed } = testTally(plan)
  const mark = (test: TestCase, outcome: TestOutcome, why?: string) => {
    recordTest(id, test.id, test.result?.outcome === outcome && why === undefined ? null : outcome, why)
    setNoting(undefined)
    setNote('')
  }
  const copy = () => void navigator.clipboard.writeText(testPlanMarkdown(plan, title)).then(() => toast('Test plan copied as Markdown.'), () => toast('Couldn’t copy the test plan.'))
  return (
    <div className="test-plan" id="test-plan">
      <h3>
        <FlaskConical size={12} /> Functional test plan
        <span className={`test-tally${failed ? ' failed' : passed === total ? ' passed' : ''}`}>Tests {passed} of {total} passed{failed ? `, ${failed} failed` : ''}</span>
        <button type="button" className="text-button" onClick={copy}><Copy size={12} /> Copy as Markdown</button>
      </h3>
      <ol className="tests">
        {plan.map((test) => (
          <li key={test.id} className={test.result ? `test ${test.result.outcome}` : 'test'}>
            <div className="test-head">
              <span className="test-id num">{test.id}</span>
              <b>{test.title}</b>
              {test.risk && <span className={`test-risk ${riskTone[test.risk]}`}>{test.risk} risk</span>}
            </div>
            {test.point ? <p className="test-point">Proves: {test.point}</p> : <p className="test-point">An edge case the done-when implies</p>}
            {test.setup && <p className="test-setup"><span>Setup</span> {test.setup}</p>}
            <ol className="test-steps">{test.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
            <p className="test-expect"><span>Expect</span> {test.expect}</p>
            {test.result && (
              <p className={`test-result ${test.result.outcome}`}>
                {test.result.outcome === 'passed' ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
                {test.result.outcome === 'passed' ? 'Passed' : 'Failed'} for {nameFor(state, test.result.by)}, {ago(test.result.at)}{test.result.note ? `: ${test.result.note}` : ''}
              </p>
            )}
            {noting === test.id ? (
              <form className="test-note" onSubmit={(event) => { event.preventDefault(); mark(test, 'failed', note) }}>
                <input autoFocus aria-label={`What went wrong in ${test.title}`} placeholder="What you saw instead, in one line" value={note} maxLength={testTextMost} onChange={(event) => setNote(event.target.value)} />
                <button type="submit" className="button">Fail it</button>
                <button type="button" className="text-button" onClick={() => setNoting(undefined)}>Cancel</button>
              </form>
            ) : (
              <div className="test-actions">
                <button type="button" className={`test-pass${test.result?.outcome === 'passed' ? ' on' : ''}`} aria-pressed={test.result?.outcome === 'passed'} onClick={() => mark(test, 'passed')}><Check size={12} strokeWidth={3} /> Pass</button>
                <button type="button" className={`test-fail${test.result?.outcome === 'failed' ? ' on' : ''}`} aria-pressed={test.result?.outcome === 'failed'} onClick={() => (test.result?.outcome === 'failed' ? mark(test, 'failed') : setNoting(test.id))}><X size={12} strokeWidth={3} /> Fail</button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
