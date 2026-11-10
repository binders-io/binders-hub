import { useState, type MouseEvent } from 'react'
import { ReasoningPicker, reasoningWords } from './Reasoning'
import { ArrowUpRight, Ban, CornerUpLeft, MessageSquareReply, SquarePlus, Swords, Undo2 } from 'lucide-react'
import { authorOf, authorsOf, byWorst, cardsOfSet, challengeable, openFindings, pullOf, repliable, replying, setOfCard, type BlastRadius, type Challenge, type Finding } from '../../../shared/changeSet.ts'
import type { Card, ChangeSet, PullRequest } from '../data/model'
import { nameFor, useBlastSymbols, useClock, useStore } from '../data/store'
import { ago, quietWords, unpicked } from './bits'
import { attempt } from './Toast'
import { href } from '../route'
import { useMayChangeBinder } from '../screens/settings/access'
import { challengeStateOf } from '../data/cardDetail'

// A Challenge: an adversarial review by an agent that didn't write the work, which gets the diff, the brief and the
// done-when but never the authors' plan or log. Of a whole change set, all its pull requests together, so what goes
// wrong between them shows (a card not in a set yet has its own, of its worktree); asking on a card in a set asks for
// its set's. Each card then has the findings on its own pull request, worst first, each to be sent back to the agent
// that wrote it, dismissed, or made a card of.

// Asked, and nothing came of it for half an hour (nobody started, or it started and went quiet), is not pending: the hub takes a new ask then, so the page does too.
const pending = (challenge?: Challenge) => !!challenge && (challenge.state === 'asked' || challenge.state === 'reviewing') && !unpicked(challenge)

/** Whether there's anything to challenge: a card being built or in review, with a pull request or a worktree diff. */
const canChallenge = (state: Parameters<typeof pullOf>[0], card: Card) => challengeable(card.stage) && (!!card.worktree || !!pullOf(state, card))

/**
 * Asks for a Challenge of the card. With `pick`, a choice of reviewer beside it: any agent that works in the binder
 * and didn't write the work, or the hub's pick. `inline` is a chip for inside another control, as Debrief's is.
 */
export function ChallengeButton({ card, inline = false, pick = false, className = 'button' }: { card: Card; inline?: boolean; pick?: boolean; className?: string }) {
  const store = useStore()
  const { state } = store
  // Asking an agent to review changes the Binder: a reader has the findings that are there, and no button for more.
  const may = useMayChangeBinder()
  const [reviewer, setReviewer] = useState('')
  if (!may || !canChallenge(state, card)) return null
  // In a change set, the set's: all its pull requests, all their authors. A new one waits for replies to the last.
  const set = setOfCard(state, card)
  const cards = set ? cardsOfSet(state, set) : [card]
  const live = set ? set.challenge : card.challenge
  const answering = cards.map((c) => c.challenge?.replies).find((r) => replying(r))
  const busy = pending(live) || !!answering
  const authors = [...new Set(cards.flatMap((c) => authorsOf(state, c)))]
  // Any agent may review, an author too: the hub prefers one that didn't write it.
  const reviewers = state.agents.filter((a) => !a.revoked && (!a.binders.length || a.binders.includes(card.binderId)))
  const title = busy
    ? pending(live) ? `${nameFor(state, live!.agentId)} is challenging ${set ? `change set #${set.number}` : 'it'}` : `${nameFor(state, answering!.agentId)} is replying to the findings`
    : !reviewers.length ? 'No agent works in this binder: set one up in Agents to challenge it'
    : set ? `An agent with a reviewer’s instructions and a fresh session reviews all of change set #${set.number}’s pull requests together against their briefs, without the authors’ log` : 'An agent with a reviewer’s instructions and a fresh session reviews its diff against the brief, without the author’s log, and says what’s wrong'
  const ask = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    if (!busy && reviewers.length) void attempt(() => store.challenge(card.id, reviewer || undefined))
  }
  if (inline) {
    return (
      <button type="button" aria-disabled={busy || !reviewers.length} className={`debrief-chip${busy ? ' busy' : ''}`} title={title} onClick={ask}>
        <Swords size={11} /> {busy ? 'Challenging' : 'Challenge'}
      </button>
    )
  }
  // A card held without its detail still says how its Challenge stood.
  const label = busy ? 'Challenging…' : (live ? live.state : challengeStateOf(card)) === 'done' ? 'Challenge again' : 'Challenge'
  const button = <button type="button" className={className} disabled={busy || !reviewers.length} title={title} onClick={ask}><Swords size={13} /> {label}</button>
  if (busy || !reviewers.length) return button
  if (!pick) return <span className="challenge-ask"><ReasoningPicker />{button}</span>
  return (
    <span className="challenge-ask">
      <ReasoningPicker />
      <select aria-label="Who challenges it" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
        <option value="">The hub picks</option>
        {reviewers.map((a) => <option key={a.id} value={a.id}>{a.name}{authors.includes(a.id) ? ' (wrote part of it)' : ''}</option>)}
      </select>
      {button}
    </span>
  )
}

const kindText: Record<Finding['kind'], string> = { bug: 'Bug', 'done-when': 'Done-when', security: 'Security', 'edge case': 'Edge case', simpler: 'Simpler', breaks: 'Breaks' }

/** A finding's file and line on GitHub, when the work has a pull request there. */
function lineUrl(pull: PullRequest | undefined, finding: Finding) {
  if (!pull?.url || !pull.branch) return undefined
  const base = pull.url.replace(/\/pull\/\d+.*$/, '')
  return `${base}/blob/${encodeURIComponent(pull.branch).replace(/%2F/g, '/')}/${finding.file.split('/').map(encodeURIComponent).join('/')}#L${finding.line}`
}

/** Asks the author to reply to the findings: one round, so the button goes once it's answered. */
function RepliesButton({ card, challenge }: { card: Card; challenge: Challenge }) {
  const store = useStore()
  const may = useMayChangeBinder()
  if (!may || !repliable(challenge)) return null
  const author = authorOf(store.state, card, challenge)
  if (!author) return null
  const name = nameFor(store.state, author)
  return (
    <button type="button" className="text-button" title={`${name} answers each finding once: fixed, or disagrees and why. The reviewer doesn’t answer back.`} onClick={() => void attempt(() => store.replyToFindings(card.id))}>
      <MessageSquareReply size={13} /> Ask {name} to reply
    </button>
  )
}

/** The Challenge on the card's full screen: who's reviewing, or its findings worst first. */
export function ChallengeView({ card, under = false }: { card: Card; under?: boolean }) {
  const store = useStore()
  const { state } = store
  const may = useMayChangeBinder()
  // Whether it has waited long enough to be asked again changes with the time alone.
  useClock()
  const challenge = card.challenge
  if (!challenge) return null
  const agent = nameFor(state, challenge.agentId)
  const reviewed = challenge.findings !== undefined
  const findings = [...(challenge.findings ?? [])].sort(byWorst)
  const pull = pullOf(state, card)
  const replies = challenge.replies
  const open = openFindings(challenge).length
  const set = challenge.fromSet ? state.changeSets.find((s) => s.id === challenge.fromSet) : undefined
  const again = set && pending(set.challenge) ? set.challenge : undefined
  return (
    <section className={`work-section debrief challenge${under ? ' under' : ''}`} aria-label={under ? `Findings on ${card.title}` : 'Challenge'}>
      {under ? (
        <h3>
          <a href={href({ screen: 'work', id: card.id })}>{card.title}</a>
          {pull && <span className="mono faint"> {pull.repo.split('/')[1]}#{pull.number}</span>}
          {reviewed && <span className="num faint"> · {findings.length} finding{findings.length === 1 ? '' : 's'}{open < findings.length ? `, ${open} open` : ''}</span>}
        </h3>
      ) : (
        <h2>
          Challenge
          {reviewed && <span className="num faint">{findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}${open < findings.length ? `, ${open} open` : ''}` : 'nothing found'}</span>}
          <span className="debrief-actions"><RepliesButton card={card} challenge={challenge} /><ChallengeButton card={card} pick className="text-button" /></span>
        </h2>
      )}
      {!under && !set && challenge.blast && <BlastView blast={challenge.blast} of={{ kind: 'card', id: card.id }} />}
      {set && !under && <p className="faint small">From change set #{set.number}’s Challenge of all its pull requests together: these are the findings on this one. <a href={href({ screen: 'changes', id: set.id })} onClick={() => { try { window.localStorage.setItem('binders-set-tab', 'review') } catch { /* only a convenience */ } }}>All of them</a>.</p>}
      {again && <p className="debrief-status working">{nameFor(state, again.agentId)} is challenging change set #{set!.number} again. The last findings are below.</p>}
      {pending(challenge) && <p className="debrief-status working">{agent} {challenge.state === 'asked' ? 'will review it as soon as its runner is listening' : `is reviewing it${challenge.doing ? `: ${challenge.doing}` : ''}`}.{reviewed ? ' The last findings are below.' : ''}</p>}
      {unpicked(challenge) && !again && !under && (
        <p className="debrief-status moved">
          {quietWords(agent, challenge)}{reviewed ? ' The last findings are below.' : ''}{' '}
          {may && <button type="button" className="text-button" onClick={() => void attempt(() => store.challenge(card.id))}>Ask again</button>}
        </p>
      )}
      {challenge.state === 'failed' && <p className="debrief-status failed">{agent} couldn’t review it: {challenge.failed}{reviewed ? ' The last findings are below.' : ''}</p>}
      {replies && challenge.state === 'done' && (replies.state === 'asked' || replies.state === 'replying') && <p className="debrief-status working">{nameFor(state, replies.agentId)} {replies.state === 'asked' ? 'will reply to the findings as soon as its runner is listening' : `is replying to the findings${replies.doing ? `: ${replies.doing}` : ''}`}.</p>}
      {replies && challenge.state === 'done' && replies.state === 'failed' && <p className="debrief-status failed">{nameFor(state, replies.agentId)} couldn’t reply to the findings: {replies.failed}</p>}
      {replies?.state === 'done' && <p className="faint small">{nameFor(state, replies.agentId)} replied to each finding{replies.repliedAt ? ` ${ago(replies.repliedAt)}` : ''}. That was the one round: the reviewer doesn’t answer back.</p>}
      {reviewed && (
        <>
          <p className="faint small">By {agent}{challenge.picked === 'hub' ? ', picked by the hub' : ''}{challenge.reviewedAt ? `, ${ago(challenge.reviewedAt)}` : ''}, from the diff, brief and done-when alone: not {challenge.authors.length ? challenge.authors.map((id) => nameFor(state, id)).join(' or ') + '’s' : 'the author’s'} log. Asked by {nameFor(state, challenge.askedBy)}{challenge.effort ? `, ${reasoningWords(challenge.effort)}` : ''}.</p>
          {!under && challenge.summary && <p className="debrief-does">{challenge.summary}</p>}
          {challenge.review && (challenge.review.url
            ? <p className="faint small">Posted as a review on <a href={challenge.review.url} target="_blank" rel="noreferrer">{challenge.review.repo.split('/')[1]}#{challenge.review.number} <ArrowUpRight size={11} /></a>{challenge.review.onLines !== findings.length ? `, ${challenge.review.onLines ?? 0} of ${findings.length} on their lines` : ''}.</p>
            : challenge.review.failed && <p className="debrief-status failed">Couldn’t post it on {challenge.review.repo.split('/')[1]}#{challenge.review.number}: {challenge.review.failed}</p>)}
          {findings.length > 0 && (
            <ol className="findings">
              {findings.map((f) => {
                const url = lineUrl(pull, f)
                const where = `${f.file}:${f.line}`
                return (
                  <li key={f.id} className={`finding sev-${f.severity}${f.outcome ? ` settled ${f.outcome.kind === 'dismissed' ? 'dismissed' : ''}` : ''}`}>
                    <div className="finding-head">
                      <span className="finding-sev">{f.severity}</span>
                      <span className={`finding-sure ${f.confidence}`}>{f.confidence}</span>
                      <span className="finding-kind">{kindText[f.kind]}</span>
                      {url ? <a className="mono" href={url} target="_blank" rel="noreferrer">{where}</a> : <span className="mono">{where}</span>}
                    </div>
                    <p>{f.what}</p>
                    {f.fix && <p className="finding-fix"><b>Fix:</b> {f.fix}</p>}
                    {f.reply && (
                      <div className={`finding-reply ${f.reply.verdict}`}>
                        <span className="finding-verdict">{f.reply.verdict === 'fixed' ? 'Fixed' : 'Disagrees'}</span> <b>{nameFor(state, f.reply.by)}:</b> {f.reply.why}
                      </div>
                    )}
                    <FindingActions card={card} finding={f} />
                  </li>
                )
              })}
            </ol>
          )}
        </>
      )}
    </section>
  )
}

/**
 * What can be done with a finding: Send back (a comment to the agent that wrote the work, and the card goes back to In
 * progress), Dismiss, or Make a card. Once one is done, what was done, and for a dismissed one, a way to open it again.
 */
function FindingActions({ card, finding }: { card: Card; finding: Finding }) {
  const store = useStore()
  const { state } = store
  // A reader sees what was done with a finding, and has nothing to do with one.
  const may = useMayChangeBinder()
  const act = (action: Parameters<typeof store.finding>[2]) => void attempt(() => store.finding(card.id, finding.id, action))
  const outcome = finding.outcome
  if (outcome) {
    const who = outcome.by === state.me?.user.login ? 'you' : nameFor(state, outcome.by)
    const made = outcome.cardId ? state.cards.find((c) => c.id === outcome.cardId) : undefined
    return (
      <div className="finding-actions done">
        {outcome.kind === 'sent back' && <span>Sent back to {nameFor(state, outcome.agentId ?? '')} by {who}, {ago(outcome.at)}</span>}
        {outcome.kind === 'card' && <span>Made a card by {who}: {made ? <a href={href({ screen: 'work', id: made.id })}>{made.title}</a> : 'since deleted'}</span>}
        {outcome.kind === 'dismissed' && <><span>Dismissed by {who}, {ago(outcome.at)}</span> {may && <button type="button" className="text-button" onClick={() => act('reopen')}><Undo2 size={12} /> Open again</button>}</>}
      </div>
    )
  }
  if (!may) return null
  // As the hub picks it: the card's holder, or its pull request's agent when the holder is gone or revoked.
  const live = (id?: string) => (id && state.agents.some((a) => a.id === id && !a.revoked) ? id : undefined)
  const author = live(card.agentId) ?? live(pullOf(state, card)?.agentId)
  const backable = challengeable(card.stage) && !!author
  const backTitle = !challengeable(card.stage)
    ? 'The card is past review: make a card of it instead'
    : author ? `A comment to ${nameFor(state, author)} with this finding, and the card goes back to In progress` : 'No agent wrote this work to send it back to'
  return (
    <div className="finding-actions">
      <button type="button" className="text-button" disabled={!backable} title={backTitle} onClick={() => act('send back')}><CornerUpLeft size={12} /> Send back</button>
      <button type="button" className="text-button" title="It’s wrong, or doesn’t matter" onClick={() => act('dismiss')}><Ban size={12} /> Dismiss</button>
      <button type="button" className="text-button" title="A new card on the board from this finding" onClick={() => act('card')}><SquarePlus size={12} /> Make a card</button>
    </div>
  )
}

/** On the Change sets screen: how many of the card's last Challenge's findings are still open, linking to them. */
export function FindingsLink({ card }: { card: Card }) {
  // A card held without its detail has no findings open (one with some is sent whole), and its count isn't here.
  if (card.left) return card.left.challenge === 'done' ? <a className="findings-link" href={href({ screen: 'work', id: card.id })} onClick={(e) => e.stopPropagation()}>No open findings</a> : null
  const findings = card.challenge?.findings
  if (!findings) return null
  const open = openFindings(card.challenge)
  const high = open.filter((f) => f.severity === 'high').length
  const text = !findings.length ? 'No findings' : open.length ? `${open.length} open finding${open.length === 1 ? '' : 's'}${high ? `, ${high} high` : ''}` : `${findings.length} finding${findings.length === 1 ? '' : 's'}, all settled`
  return <a className={`findings-link${high ? ' high' : ''}`} href={href({ screen: 'work', id: card.id })} onClick={(e) => e.stopPropagation()}>{text}</a>
}

/**
 * A change set's Challenge, on its page: who to ask, how it stands, the reviewer's verdict, and the findings on each of
 * its pull requests, on their cards, each acted on there. One ask has every author reply to the findings on theirs.
 */
export function SetChallenge({ set }: { set: ChangeSet }) {
  const store = useStore()
  const { state } = store
  const may = useMayChangeBinder()
  useClock()
  const [reviewer, setReviewer] = useState('')
  const cards = cardsOfSet(state, set)
  if (!cards.length) return null
  const challenge = set.challenge
  // Nothing has been asked, and a reader can't ask: nothing to show.
  if (!may && !challenge) return null
  const authors = [...new Set(cards.flatMap((c) => authorsOf(state, c)))]
  const reviewers = state.agents.filter((a) => !a.revoked && (!a.binders.length || a.binders.includes(set.binderId)))
  const answering = cards.map((c) => c.challenge?.replies).find((r) => replying(r))
  const busy = pending(challenge) || !!answering
  const done = challenge?.state === 'done'
  const withFindings = cards.filter((c) => c.challenge?.fromSet === set.id && (c.challenge.findings?.length ?? 0) > 0)
  const canReply = withFindings.some((c) => repliable(c.challenge!))
  const total = challenge?.findings?.length ?? 0
  return (
    <section className="work-section debrief challenge" aria-label="Challenge">
      <h2>
        Challenge
        {done && <span className="num faint">{total ? `${total} finding${total === 1 ? '' : 's'}` : 'nothing found'}</span>}
        <span className="debrief-actions">
          {may && canReply && <button type="button" className="text-button" title="Each card’s author answers the findings on its pull request once: fixed, or disagrees and why." onClick={() => void attempt(() => store.setReplies(set.id))}><MessageSquareReply size={13} /> Ask the authors to reply</button>}
          {may && !busy && reviewers.length > 0 && (
            <span className="challenge-ask">
              <ReasoningPicker />
              <select aria-label="Who challenges it" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
                <option value="">The hub picks</option>
                {reviewers.map((a) => <option key={a.id} value={a.id}>{a.name}{authors.includes(a.id) ? ' (wrote part of it)' : ''}</option>)}
              </select>
              <button type="button" className="text-button" onClick={() => void attempt(() => store.setChallenge(set.id, reviewer || undefined))}><Swords size={13} /> {challenge ? 'Challenge again' : 'Challenge'}</button>
            </span>
          )}
        </span>
      </h2>
      {!challenge && <p className="faint">An agent with a reviewer’s instructions and a fresh session reviews all {cards.length === 1 ? 'its pull request' : `${cards.length} pull requests`} together against their briefs and done-when, without the authors’ log, so what goes wrong between them shows too.{!reviewers.length ? ' No agent works in this part yet: set one up in Agents.' : ''}</p>}
      {pending(challenge) && <p className="debrief-status working">{nameFor(state, challenge!.agentId)} {challenge!.state === 'asked' ? 'will review it as soon as its runner is listening' : `is reviewing it${challenge!.doing ? `: ${challenge!.doing}` : ''}`}.</p>}
      {unpicked(challenge) && (
        <p className="debrief-status moved">
          {quietWords(nameFor(state, challenge!.agentId), challenge!)}{' '}
          {may && <button type="button" className="text-button" onClick={() => void attempt(() => store.setChallenge(set.id, reviewer || undefined))}>Ask again</button>}
        </p>
      )}
      {challenge?.state === 'failed' && <p className="debrief-status failed">{nameFor(state, challenge.agentId)} couldn’t review it: {challenge.failed}</p>}
      {answering && <p className="debrief-status working">{nameFor(state, answering.agentId)} is replying to the findings.</p>}
      {challenge?.blast && <BlastView blast={challenge.blast} of={{ kind: 'set', id: set.id }} />}
      {done && challenge!.summary && <p className="debrief-does">{challenge!.summary}</p>}
      {withFindings.map((card) => <ChallengeView key={card.id} card={card} under />)}
      {/* A card that finished a while ago is held without its findings, which are all settled: its page has them. */}
      {cards.filter((c) => c.left?.challenge).map((card) => <p key={card.id} className="faint small"><a href={href({ screen: 'work', id: card.id })}>{card.title}</a> has a Challenge with nothing open. Open it to read it.</p>)}
    </section>
  )
}

/**
 * A change's blast radius, as the reviewer's runner worked it out before the review: how many symbols it changed, how
 * often they're used elsewhere, which removed ones are still used, and which no test mentions; each symbol's uses on
 * asking. Found by name with git grep, so a first look and not a proof, which it says.
 */
export function BlastView({ blast, of }: { blast: BlastRadius; of: { kind: 'card' | 'set'; id: string } }) {
  const [open, setOpen] = useState(false)
  // The state a browser holds leaves the symbols out and counts them: they're asked for when the list is opened.
  const { symbols, loading, failed, again } = useBlastSymbols(of, blast, open)
  const count = blast.symbolCount ?? blast.symbols.length
  const worth = symbols.filter((s) => s.uses.length > 0 || s.change === 'removed' || !s.tests.length)
  return (
    <div className="blast">
      <button type="button" className="blast-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>What else this touches</b>
        <span className="blast-chip">{count} changed symbol{count === 1 ? '' : 's'}</span>
        <span className="blast-chip">{blast.outside} use{blast.outside === 1 ? '' : 's'} outside the change</span>
        {blast.stillUsed > 0 && <span className="blast-chip bad">{blast.stillUsed} removed but still used</span>}
        {blast.untested > 0 && <span className="blast-chip warn">{blast.untested} with no test</span>}
        <span className="faint small">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <>
          <p className="faint small">Found by name with git grep in {blast.repo ?? 'the reviewer’s folder'}, so a first look rather than a proof: a name used for two things counts both.{blast.elsewhere?.length ? ` Not searched: ${blast.elsewhere.join(', ')} (not on the reviewer’s machine).` : ''}{blast.cut ? ` ${blast.cut} more symbols weren’t followed.` : ''}</p>
          {loading && <p className="faint small">Loading…</p>}
          {failed && <p className="faint small">The symbols couldn’t be loaded. <button type="button" className="text-button" onClick={again}>Try again</button></p>}
          {!loading && !failed && <ul className="blast-list">
            {worth.map((sym) => (
              <li key={`${sym.file}:${sym.name}`} className={sym.change === 'removed' && sym.uses.length ? 'bad' : ''}>
                <div><code>{sym.name}</code> <span className="faint">{sym.change} in {sym.file}</span>{!sym.tests.length && sym.change !== 'removed' && <span className="blast-chip warn">no test</span>}</div>
                {sym.uses.length > 0 && (
                  <ul>
                    {sym.uses.map((u) => <li key={`${u.file}:${u.line}`}><span className="mono">{u.file}:{u.line}</span> <span className="faint mono">{u.text}</span></li>)}
                    {sym.more ? <li className="faint">and {sym.more} more</li> : null}
                  </ul>
                )}
              </li>
            ))}
            {!worth.length && <li className="faint">Nothing it changed is used elsewhere, and every change has a test that mentions it.</li>}
          </ul>}
        </>
      )}
    </div>
  )
}
