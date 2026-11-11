import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, CornerUpLeft, FilePen, FileSearch, FileText, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Globe, Link2, ListChecks, MessageCircleQuestion, OctagonAlert, Quote, ShieldQuestionMark, Rocket, Send, ShieldCheck, Sparkles, Square, SquareDashed, SquareTerminal, Trash2, Workflow } from 'lucide-react'
import { stages, type Card, type Environment, type HubState, type PullRequest } from '../data/model'
import { nameFor, useCardHistory, useCardWhole, useHub, useStore } from '../data/store'
import { CheckGlyph, Progress, RepoTag, Who, ago, askedWords, checksSummary, foldRepeats, leaveCard, onTouch, stageTone, stoppedBlock, stoppedWords, usePhone } from '../components/bits'
import { PullDiffs } from '../components/Diffs'
import { Terminal } from '../components/Terminal'
import { DebriefButton, DebriefView } from '../components/Debrief'
import { ChallengeButton, ChallengeView } from '../components/Challenge'
import { AgentPicker } from '../components/AgentPicker'
import { sessionLines } from '../data/session'
import { attempt, toast } from '../components/Toast'
import { ConfirmButton } from '../components/ConfirmButton'
import { copyCardLink, moveAsk, movesOf, stopHolding } from '../components/CardMenu'
import { EditableText } from '../components/EditableText'
import { CardLoading } from '../components/CardLoading'
import { briefOf, doneWhenOf } from '../data/cardDetail'
import { go, href } from '../route'
import { useUI } from '../ui'
import { mayTake, meantForNow, repoEnvironments } from '../../../shared/work.ts'
import { useMayChangeBinder } from './settings/access'
import { EmptyState, Status, type Tone } from '../kit'

type StepState = 'done' | 'now' | 'next'

interface Step {
  id: string
  title: string
  detail: string
  state: StepState
  icon: typeof Check
}

/**
 * The story's way through the development cycle, from the note it came from to the last environment its repo is
 * deployed to, worked out from where it is now. Each environment is a step of its own, done once the card's pull request
 * is on it; a repo with no environments adds none.
 */
function lifecycle(card: Card, state: HubState): Step[] {
  const pull = state.pulls.find((p) => p.id === card.prId)
  const set = pull && state.changeSets.find((c) => c.prIds.includes(pull.id))
  const envs = pull ? repoEnvironments(state, pull.repo) : []
  const agent = state.agents.find((a) => a.id === card.agentId)
  const note = state.notes.find((n) => n.id === card.noteId)
  const checks = pull ? checksSummary(pull.checks) : undefined
  const rank = stages.findIndex((s) => s.id === card.stage)
  const raw: [string, string, string, boolean, typeof Check][] = [
    ['note', 'Written', note ? `In “${note.title}”` : 'Put on the board by hand', true, FileText],
    ['board', 'On the board', card.jira ? `Jira ${card.jira.key}` : card.issue ? `Issue #${card.issue.number}` : 'Ready for an agent', card.stage !== 'proposed', ListChecks],
    ['claim', 'Claimed', agent ? agent.name : meantForNow(state, card) ? `Meant for ${nameFor(state, card.meantFor!)}` : card.stage === 'ready' && !state.agents.some((a) => !a.revoked && mayTake(state, a, card)) ? 'No agent works in this binder and repo: set one’s binders and repos on the Agents page' : 'Any agent that can', !!agent || rank >= 3, Workflow],
    ['build', 'Built', card.stage === 'working' ? (card.doing ?? 'Working') : rank > 2 ? 'Finished' : 'Not started', rank > 2, SquareTerminal],
    ['pr', 'Pull request', pull ? `${pull.repo.split('/')[1]}#${pull.number}` : card.stage === 'live' && !pull ? 'None needed' : 'Not opened', !!pull || (card.stage === 'live' && !pull), GitPullRequest],
    ['checks', 'Checks', checks ? checks.text : 'Not yet', checks?.state === 'passed' || (!!pull && !pull.checks.length && pull.state !== 'open') || (card.stage === 'live' && !pull), ShieldCheck],
    ['approve', 'Approved', set ? `In change set #${set.number}` : 'Not yet', (!!pull && pull.state !== 'open') || (card.stage === 'live' && !pull), ShieldCheck],
    ['merge', 'Merged', pull?.state === 'merged' ? 'In order with its set' : 'Not yet', pull?.state === 'merged' || (card.stage === 'live' && !pull), GitMerge],
    ...envs.map((env, at): [string, string, string, boolean, typeof Check] => {
      const on = !!pull && !!env.pullIds?.includes(pull.id)
      return [`env:${env.id}`, env.name, on ? env.version || 'Deployed' : at ? `After ${envs[at - 1].name}` : 'After merging', on, at > 0 && at === envs.length - 1 ? Rocket : Globe]
    }),
  ]
  let now = false
  return raw.map(([id, title, detail, done, icon]) => {
    const stepState: StepState = done ? 'done' : now ? 'next' : 'now'
    if (!done) now = true
    return { id, title, detail, state: stepState, icon }
  })
}

const taskIcon: Record<string, typeof Check> = { Read: FileSearch, Fetch: Globe, WebFetch: Globe, Write: FilePen, Edit: FilePen, Update: FilePen, Bash: SquareTerminal }
const taskVerb: Record<string, string> = { Read: 'Read', Fetch: 'Looked up', WebFetch: 'Looked up', Write: 'Wrote', Edit: 'Edited', Update: 'Edited', Bash: 'Ran', Grep: 'Searched', Glob: 'Listed' }


/** Changed lines a card's pull request may have and still start open. */
const changesOpenLines = 400

const sizeNames: Record<Card['size'], string> = { S: 'Small', M: 'Medium', L: 'Large' }
/** A stage's state, as the kit's pill says it: amber waits on a person, blue runs, violet is in review, green is done. */
const stageStatus: Record<Card['stage'], Tone> = { proposed: 'waiting', ready: 'off', working: 'running', blocked: 'bad', review: 'review', live: 'ok' }
const pullWords: Record<PullRequest['state'], string> = { open: 'Open', approved: 'Approved', queued: 'In the merge queue', merged: 'Merged', closed: 'Closed' }

export function Work({ id }: { id: string }) {
  const store = useStore()
  const { state } = store
  // A reader sees the whole card, and moves, answers, edits and deletes none of it: those controls aren't drawn.
  const may = useMayChangeBinder()
  const card = state.cards.find((c) => c.id === id)
  // A card that finished a while ago is held without its detail, which is asked for when it opens: until it's here the
  // page has its title, stage and links, and nothing of its words to read or change.
  const { card: whole, failed: wholeFailed, again: loadWhole } = useCardWhole(id)
  const offline = useHub((state) => state.sync.connection === 'offline')
  // Its whole activity: the state has the recent lines, and the rest are asked for when the card opens.
  const { activity, failed: historyFailed, again: loadHistory } = useCardHistory(whole)
  const { binder: inBinder, setBinder } = useUI()
  useEffect(() => {
    if (card && inBinder !== 'all' && card.binderId !== inBinder) setBinder(card.binderId)
  }, [card, inBinder, setBinder])
  const [showSession, setShowSession] = useState(true)
  // What it did: a box of its own that scrolls, opening at the latest step and following new ones while you're there.
  const stepsBox = useRef<HTMLOListElement>(null)
  const seenSteps = useRef(0)
  const stepCount = activity.filter((x) => x.kind === 'step').length
  useEffect(() => {
    const box = stepsBox.current
    if (!box) return
    const atEnd = seenSteps.current === 0 || box.scrollHeight - box.scrollTop - box.clientHeight < 80
    if (atEnd) box.scrollTop = box.scrollHeight
    seenSteps.current = stepCount
  }, [stepCount])
  const [reply, setReply] = useState('')
  // While the hub has the words, so a second press can't send them twice.
  const [sending, setSending] = useState(false)
  const [allActivity, setAllActivity] = useState(false)
  // A big diff, or any on a phone, waits to be asked for.
  const phone = usePhone()
  const [showChanges, setShowChanges] = useState<boolean>()
  // Worked out from a good part of the state: only when one of those parts changes, not on each of an agent's reports.
  const steps = useMemo(() => (card ? lifecycle(card, state) : []), [card, state.pulls, state.changeSets, state.environments, state.agents, state.notes]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!card) {
    return (
      <div className="work-missing">
        <EmptyState icon={<SquareDashed size={20} />} title="That card isn’t on the board" line="It may have been deleted, or it’s still on its way." action={<a className="button" href={href({ screen: 'flow' })}>Back to the board</a>} />
      </div>
    )
  }
  const agent = state.agents.find((a) => a.id === card.agentId)
  const pull = state.pulls.find((p) => p.id === card.prId)
  const changesOpen = showChanges ?? (!phone && !!pull && pull.files.reduce((n, f) => n + f.added + f.removed, 0) <= changesOpenLines)
  const set = pull && state.changeSets.find((c) => c.prIds.includes(pull.id))
  const siblings = set ? set.prIds.map((p) => state.pulls.find((x) => x.id === p)).filter((p): p is PullRequest => !!p) : []
  const note = state.notes.find((n) => n.id === card.noteId)
  const binder = state.binders.find((b) => b.id === card.binderId)
  const stageTitle = stages.find((s) => s.id === card.stage)?.title
  const parts = state.cards.filter((c) => c.parent === card.id)
  const parent = card.parent ? state.cards.find((c) => c.id === card.parent) : undefined
  // What the card is, in one quiet line over its title: where it stands first, then where it lives.
  const tags = (
    <div className="work-tags">
      <span className="stage-pill"><Status tone={stageStatus[card.stage]}>{stageTitle}</Status></span>
      {card.jira && (/^https:\/\//.test(card.jira.url) ? <a className="mono" href={card.jira.url} target="_blank" rel="noreferrer" title="Its Jira issue">{card.jira.key} <ArrowUpRight size={11} aria-hidden="true" /></a> : <span className="mono">{card.jira.key}</span>)}
      {card.issue && (card.issue.url ? <a className="mono" href={card.issue.url} target="_blank" rel="noreferrer" title={`Its issue, in ${card.issue.repo}`}>#{card.issue.number} {card.issue.repo.split('/')[1]} <ArrowUpRight size={11} aria-hidden="true" /></a> : <span className="mono">#{card.issue.number} {card.issue.repo.split('/')[1]}</span>)}
      {binder && inBinder === 'all' && <span>{binder.name}</span>}
      {pull ? <RepoTag repo={pull.repo} title={`Its pull request is in ${pull.repo}`} /> : !card.issue && binder?.repo && <RepoTag repo={binder.repo} />}
      <span className="size-tag" title={`Size: ${sizeNames[card.size].toLowerCase()}`}>{sizeNames[card.size]}</span>
      {card.agentId && (state.terminals?.[card.agentId]?.sessions ?? []).filter((s) => s.card === card.id).map((s) => (
        <a key={s.sid} href={href({ screen: 'terminal', id: card.agentId!, sid: s.sid })} title={s.dir}>{s.run ? 'Watch or take over its terminal' : `Its terminal: ${s.name ?? s.tool}`}</a>
      ))}
      {parts.length > 0 && <span title={parts.map((p) => `${p.title}: ${p.stage}`).join('\n')}>Swarm of {parts.length} part{parts.length === 1 ? '' : 's'}</span>}
      {parent && <span>Part of <a href={href({ screen: 'work', id: parent.id })}>{parent.title}</a></span>}
    </div>
  )
  const back = <button type="button" className="icon-button work-back" onClick={leaveCard} aria-label="Back"><ArrowLeft size={18} /></button>
  const copy = <button type="button" className="button quiet small work-copy" onClick={() => copyCardLink(card.id)}><Link2 size={14} aria-hidden="true" />Copy link</button>
  // Its detail isn't here: nothing below is shown or can be changed until it is, so an empty brief is never taken for the card's own.
  if (card.left) {
    return (
      <div className="work">
        <header className="work-head">
          {back}
          <div className="work-title">
            {tags}
            <h1>{card.title}</h1>
          </div>
        </header>
        <CardLoading failed={wholeFailed} offline={offline} again={loadWhole} />
      </div>
    )
  }
  const current = steps.find((s) => s.state === 'now')
  const working = card.stage === 'working'
  const tasks = activity.filter((a) => a.kind === 'step')
  const lines = sessionLines(activity)
  const held = card.stage === 'working' && !!card.agentId
  // What an agent holds, working or blocked on a question: Stop ends it, and deleting says so.
  const holds = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
  const holder = state.agents.find((a) => a.id === card.agentId)
  // Words on a card in review reach no agent on their own: sending them back does, and the hub takes that only while its pull request is open.
  const canSendBack = may && card.stage === 'review' && !!agent && !!pull && pull.state === 'open'
  const moveTo = (stage: Card['stage']) => store.moveCard(card.id, stage)
  // Its words are the person's to fix until an agent has them: while it's proposed or ready, or blocked with nobody on it.
  const canEdit = card.stage === 'proposed' || card.stage === 'ready' || (card.stage === 'blocked' && !card.agentId)
  // Its words, once they're here: a card whose detail isn't is never shown as having none, or editable.
  const brief = briefOf(card)
  const doneWhen = doneWhenOf(card)
  const editable = canEdit && may && brief !== undefined && doneWhen !== undefined
  const wordsFixed = card.stage === 'review' ? 'It’s in review, so its words stay as they are.' : card.stage === 'live' ? 'It’s done, so its words stay as they are.' : `${holder?.name ?? 'An agent'} is working on it, so its words stay as they are.`
  const change = (fields: Partial<Card>, said: string) => store.updateCard(card.id, fields, said)
  const stoppedHere = stoppedBlock(card)
  const conversation = activity.filter((a) => a.kind === 'question' || a.kind === 'answer' || a.kind === 'comment' || a.kind === 'message')
  // The open question is the first thing on the page, with the box to answer it; the conversation has the rest.
  const lastQuestion = card.needsYou ? conversation.map((a) => a.kind).lastIndexOf('question') : -1
  // A card stopped twice says why at the top already; its question is that.
  const asking = !!card.needsYou && !(stoppedHere && card.stopped)
  const openQuestion = asking && lastQuestion >= 0 ? conversation[lastQuestion] : undefined
  const earlier = conversation.filter((_, index) => !(openQuestion && index === lastQuestion))
  // The one box for words to the card: with what it asks when it asks, under the conversation otherwise.
  const boxUp = !!card.needsYou
  const plan = card.plan ?? []
  const waits = card.waitsFor.map((w) => state.cards.find((c) => c.id === w)).filter((c): c is Card => !!c)
  const blocks = state.cards.filter((c) => c.waitsFor.includes(card.id))
  const envs: Environment[] = set ? state.environments.filter((e) => e.changeSetIds.includes(set.id)) : []
  const edits = tasks.filter((t) => /Edit|Write|Update/.test(t.tool ?? ''))
  const runs = tasks.filter((t) => t.tool === 'Bash')
  // Newest first, a run of the same event as one line, and the latest 30 until asked for all.
  const timeline = foldRepeats(activity.filter((a) => a.kind !== 'step' && a.kind !== 'said' && a.kind !== 'message')).reverse()
  const shownTimeline = allActivity ? timeline : timeline.slice(0, 30)
  const maker = card.createdBy && card.createdBy !== 'hub' ? nameFor(state, card.createdBy) : undefined

  /** Sends words to the hub, and clears the box only once it has taken them: if it fails they're still there to send again. */
  const deliver = async (words: string, give: (text: string) => Promise<void>) => {
    if (sending) return
    setSending(true)
    const sent = await attempt(async () => {
      await give(words)
      return true
    })
    setSending(false)
    // Not if more was typed meanwhile.
    if (sent) setReply((now) => (now === words ? '' : now))
    return sent
  }
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (reply.trim()) void deliver(reply, (text) => store.comment(card.id, text))
  }
  const sendBack = async (words: string) => {
    if (await deliver(words, (text) => store.sendBack(card.id, text))) toast(`Sent back to ${agent!.name}.`)
  }
  const replyBox = may && (
    <form className="reply" onSubmit={send}>
      <input id="card-reply" aria-label={card.needsYou ? 'Your answer' : 'Your comment'} autoFocus={!!card.needsYou && !onTouch()} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={stoppedHere ? 'Write anything, and it goes back to Ready…' : card.needsYou ? 'Answer the question…' : working ? 'Tell it something: it stops, reads it and carries on…' : canSendBack ? `Comment, or send it back to ${agent!.name} with these words…` : 'Add a comment…'} />
      <button className="button primary" disabled={!reply.trim() || sending}><Send size={14} aria-hidden="true" /> {card.needsYou ? 'Answer' : canSendBack ? 'Comment' : 'Send'}</button>
      {canSendBack && <button type="button" className="button" disabled={!reply.trim() || sending} onClick={() => void sendBack(reply)}><CornerUpLeft size={14} aria-hidden="true" /> Send back to {agent!.name}</button>}
    </form>
  )

  return (
    <div className="work">
      <header className="work-head">
        {back}
        <div className="work-title">
          {tags}
          <h1>{editable ? <EditableText label="Title" value={card.title} required onSave={(title) => change({ title }, 'Changed the title')} /> : card.title}</h1>
        </div>
        <div className="work-head-end">
          {copy}
          <AgentPicker card={card} working={working} />
        </div>
      </header>

      <ol className="sdlc" aria-label="Where it is" style={{ '--steps': steps.length } as CSSProperties}>
        {steps.map((step, index) => {
          const Icon = step.icon
          return (
            <li key={step.id} className={step.state} aria-current={step.state === 'now' ? 'step' : undefined}>
              {index > 0 && <span className="sdlc-line" aria-hidden="true" />}
              <motion.span layout className="sdlc-dot" aria-hidden="true">{step.state === 'done' ? <Check size={12} strokeWidth={3} /> : <Icon size={12} />}</motion.span>
              <b>{step.title}</b>
              <em>{step.detail}</em>
            </li>
          )
        })}
      </ol>

      <div className="work-body">
        <div className="work-main">
          {card.stopped && (
            <section className="now-card asks stopped-card" aria-label={stoppedWords(card.stopped.times)}>
              <div className="now-head">
                <span className="now-label"><OctagonAlert size={13} aria-hidden="true" />{stoppedWords(card.stopped.times)}</span>
                <span className="now-when">{askedWords(card.stopped.at)}</span>
              </div>
              <p className="now-text">{card.stopped.why}</p>
              {may && stoppedHere && <p className="now-hint stopped-next">Fix what’s wrong, then answer below and it goes back to Ready.</p>}
              {stoppedHere && replyBox}
            </section>
          )}
          {card.permission && !card.permission.answer && (
            <section className="now-card asks permission-card" aria-label="Asks permission">
              <div className="now-head">
                <span className="now-label"><ShieldQuestionMark size={13} aria-hidden="true" />Asks permission</span>
                <b className="now-who">{card.permission.tool}</b>
              </div>
              <pre className="mono permission-what">{card.permission.what}</pre>
              {may && holder && holder.owner.toLowerCase() === state.me?.user.login.toLowerCase() ? (
                <div className="permission-actions">
                  <button className="button" onClick={() => void attempt(() => store.answerPermission(card.id, card.permission!.request, false))}>Deny</button>
                  <button className="button primary" onClick={() => void attempt(() => store.answerPermission(card.id, card.permission!.request, true))}>Allow</button>
                </div>
              ) : <p className="now-hint">Only {holder?.name ?? 'its agent'}’s owner{holder ? `, @${holder.owner},` : ''} can answer this.</p>}
            </section>
          )}
          {asking ? (
            <section className="now-card asks question-card" aria-label={stoppedHere ? 'Stopped twice' : 'Asks you'}>
              <div className="now-head">
                <span className="now-label"><MessageCircleQuestion size={13} aria-hidden="true" />{stoppedHere ? 'Stopped twice' : 'Asks you'}</span>
                {openQuestion && <span className="now-when"><Who id={openQuestion.by} size={18} /><b>{nameFor(state, openQuestion.by)}</b>{ago(openQuestion.at)}</span>}
              </div>
              <p className="now-text">{openQuestion?.text ?? card.needsYou}</p>
              {replyBox}
            </section>
          ) : !card.needsYou && current && (
            <section className="now-card" aria-label="Now">
              <div className="now-head">
                <span className="now-label">Now</span>
                <p className="now-step"><b>{current.title}</b><span>{current.detail}</span></p>
                {working && card.progress !== undefined && <span className="now-progress"><Progress value={card.progress} /> <span className="num">{Math.round(card.progress * 100)}%</span></span>}
              </div>
            </section>
          )}

          <DebriefView card={card} offer />
          <ChallengeView card={card} offer />

          {historyFailed && <p className="faint small work-history" role="status">The older part of what it did didn’t load. <button type="button" className="text-button" onClick={loadHistory}>Try again</button></p>}

          {(earlier.length > 0 || (may && !boxUp)) && (
            <section className="work-section conversation-section">
              <h2>Conversation <span className="num faint">{earlier.length}</span></h2>
              {earlier.length > 0 && (
                <ol className="conversation">
                  {earlier.map((a, index) => {
                    // The open question when it's here and not at the top: a card stopped twice, whose top says why.
                    const open = !openQuestion && conversation.indexOf(a) === lastQuestion
                    return (
                      <li key={index} className={`${a.kind}${open ? ' open' : ''}`}>
                        <Who id={a.by} size={24} />
                        <div>
                          <div className="conversation-head">
                            <b>{nameFor(state, a.by)}</b>{a.to && <span className="faint"> to {nameFor(state, a.to)}</span>} <time>{ago(a.at)}</time>
                            {open && <span className="asks-tag"><MessageCircleQuestion size={11} aria-hidden="true" /> {stoppedHere ? 'Stopped twice' : 'Asks you'}</span>}
                          </div>
                          <p>{a.text}</p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
              {!boxUp && replyBox}
            </section>
          )}

          {plan.length > 0 && (
            <section className="work-section">
              <h2>Plan <span className="num faint">{plan.filter((p) => p.done).length} of {plan.length}</span></h2>
              <ul className="plan">
                {plan.map((step) => (
                  <li key={step.text} className={step.done ? 'done' : ''}><span className="plan-box" aria-hidden="true">{step.done && <Check size={11} strokeWidth={3} />}</span><span>{step.text}</span>{step.done && <span className="sr-only"> (done)</span>}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="work-section">
            <h2>What it did <span className="num faint">{tasks.length} steps · {edits.length} edits · {runs.length} commands</span></h2>
            {tasks.length ? (
              <ol className="tasks" ref={stepsBox}>
                {tasks.map((task, index) => {
                  const Icon = taskIcon[task.tool ?? ''] ?? SquareTerminal
                  return (
                    <motion.li key={index} initial={index >= seenSteps.current ? { opacity: 0, y: 4 } : false} animate={{ opacity: 1, y: 0 }}>
                      <span className={`task-icon ${(task.tool ?? '').toLowerCase()}`} aria-hidden="true"><Icon size={13} /></span>
                      <span className="task-text"><b>{taskVerb[task.tool ?? ''] ?? task.tool ?? 'Did'}</b> <code>{task.text}</code></span>
                      {task.result && <span className={`task-result${/✓|passed|SUCCEEDED/.test(task.result) ? ' ok' : ''}`}>{task.result}</span>}
                    </motion.li>
                  )
                })}
              </ol>
            ) : (
              <p className="empty-line">{agent ? 'Nothing reported yet.' : 'No agent has taken it yet. The first one free that can do it will.'}</p>
            )}
            {(card.minutes !== undefined || card.cost !== undefined) && <p className="run-stats num">{working ? 'Running for' : 'Took'} {card.minutes ?? '?'} min{card.tokens ? ` · ${card.tokens.toLocaleString()} tokens` : ''}{card.cost !== undefined ? ` · ≈ $${card.cost.toFixed(2)} at API prices` : ''}</p>}
          </section>

          {lines.length > 0 && (
            <section className="work-section">
              <h2>
                <button type="button" className="section-toggle" onClick={() => setShowSession(!showSession)} aria-expanded={showSession}>
                  Session <ChevronDown size={16} aria-hidden="true" style={{ transform: showSession ? 'none' : 'rotate(-90deg)' }} />
                </button>
              </h2>
              {showSession && <Terminal lines={lines} working={working} doing={card.doing} />}
            </section>
          )}

          {pull && pull.files.length > 0 && (
            <section className="work-section">
              <h2>
                <button type="button" className="section-toggle" onClick={() => setShowChanges(!changesOpen)} aria-expanded={changesOpen}>
                  Changes <span className="num faint"><span className="plus">+{pull.files.reduce((n, f) => n + f.added, 0)}</span> <span className="minus">−{pull.files.reduce((n, f) => n + f.removed, 0)}</span></span> <ChevronDown size={16} aria-hidden="true" style={{ transform: changesOpen ? 'none' : 'rotate(-90deg)' }} />
                </button>
              </h2>
              {changesOpen && <PullDiffs pull={pull} boxed />}
            </section>
          )}
        </div>

        <aside className="work-side" aria-label="About this card">
          <section className="side-card brief-card">
            <h3>Brief</h3>
            {brief === undefined ? null : editable ? <EditableText label="Brief" value={brief} multiline placeholder="No brief. Add one." onSave={(next) => change({ brief: next }, 'Changed the brief')} /> : <p className="brief-text">{brief || 'No brief.'}</p>}
            {editable ? (
              <>
                <h4>Done when</h4>
                <EditableText label="Done when" value={doneWhen} placeholder="Add how you’ll know it’s finished" onSave={(next) => change({ doneWhen: next }, 'Changed the done-when')} />
                <h4><label htmlFor="card-size-pick">Size</label></h4>
                <select id="card-size-pick" className="select edit-select" aria-label="Size" value={card.size} onChange={(event) => change({ size: event.target.value as Card['size'] }, `Changed the size to ${sizeNames[event.target.value as Card['size']].toLowerCase()}`)}>
                  {(['S', 'M', 'L'] as const).map((size) => <option key={size} value={size}>{sizeNames[size]}</option>)}
                </select>
              </>
            ) : (
              <>
                {doneWhen && <><h4>Done when</h4><p className="brief-text">{doneWhen}</p></>}
                {!canEdit && <p className="side-note">{wordsFixed}</p>}
              </>
            )}
            {may && card.stage === 'proposed' && (
              <div className="brief-ready">
                <p className="side-note">No agent takes it while it’s proposed. Fix its words, then put it in Ready.</p>
                <button type="button" className="button primary" onClick={() => moveTo('ready')}>Put it in Ready</button>
              </div>
            )}
          </section>

          {may && (
            <section className="side-card move-card">
              <h3>Move it</h3>
              <div className="stage-moves" role="group" aria-label="Move to">
                {movesOf(card).map((m) => {
                  const ask = moveAsk(card, m.stage, holder?.name)
                  // Taking a card from its agent stops the run, so that one asks first.
                  return ask
                    ? <ConfirmButton key={m.stage} className="" question={ask} onConfirm={() => moveTo(m.stage)}>{m.title}</ConfirmButton>
                    : <button key={m.stage} type="button" className={card.stage === m.stage ? 'on' : ''} aria-pressed={card.stage === m.stage} disabled={card.stage === m.stage} onClick={() => moveTo(m.stage)}>{m.title}</button>
                })}
              </div>
              {(held || holds) && (
                <div className="card-controls">
                  {held && !card.needsYou && <button type="button" className="button small" onClick={() => void attempt(() => store.comment(card.id, 'Carry on with this card.'))}><Send size={13} aria-hidden="true" /> Nudge {holder?.name ?? 'the agent'}</button>}
                  {holds && <button type="button" className="button small" onClick={() => void stopHolding(card, store)}><Square size={13} aria-hidden="true" /> Stop</button>}
                </div>
              )}
              {held && <p className="side-note">{holder?.name ?? 'An agent'} holds it. {card.needsYou ? 'Answer its question and it carries on.' : 'Nudge sends it a comment, and it carries on as soon as its runner is listening.'}</p>}
              <div className="move-foot">
                <ConfirmButton className="button quiet small danger" question={holds ? `Delete it and stop ${holder?.name ?? 'the agent'}? Press again` : 'Delete it? Press again'} onConfirm={() => { store.deleteCard(card.id); go({ screen: 'flow' }) }}><Trash2 size={13} aria-hidden="true" /> Delete</ConfirmButton>
              </div>
            </section>
          )}

          <section className="side-card details-card">
            <h3>Details</h3>
            <dl className="facts">
              {maker && <div><dt>Made by</dt><dd>{maker}</dd></div>}
              {(pull?.repo ?? binder?.repo) && <div><dt>Repo</dt><dd className="mono">{pull?.repo ?? binder?.repo}</dd></div>}
              {pull && <div><dt>Branch</dt><dd className="mono"><GitBranch size={12} aria-hidden="true" /> {pull.branch || 'branch'}</dd></div>}
              {pull && (
                <div className="fact-pull">
                  <dt>Pull request</dt>
                  <dd>
                    <span className="fact-line">
                      <GitPullRequest size={13} className={pull.state === 'merged' ? 'merged' : 'open'} aria-hidden="true" />
                      {pull.url ? <a href={pull.url} target="_blank" rel="noreferrer">{pull.repo.split('/')[1]}#{pull.number} <ArrowUpRight size={11} aria-hidden="true" /></a> : <span>{pull.repo.split('/')[1]}#{pull.number}</span>}
                      <span className="faint">{pullWords[pull.state]}</span>
                    </span>
                    <span className="fact-title">{pull.title}</span>
                    <span className="fact-chips"><DebriefButton card={card} inline /><ChallengeButton card={card} inline /></span>
                  </dd>
                </div>
              )}
              {pull && (
                <div>
                  <dt>Checks</dt>
                  <dd>
                    <ul className="check-list">
                      {pull.checks.map((c) => (
                        <li key={c.name}>
                          <CheckGlyph state={c.state} /> <span className="mono">{c.name}</span> <em className="num">{c.seconds ? `${c.seconds}s` : c.state}</em>
                          {canSendBack && c.state === 'failed' && <button type="button" className="text-button check-fix" disabled={sending} onClick={() => void sendBack(`The check “${c.name}” failed. Fix it and push.`)}>Send back to fix</button>}
                        </li>
                      ))}
                      {!pull.checks.length && <li className="faint">No checks reported yet.</li>}
                    </ul>
                  </dd>
                </div>
              )}
              {set && (
                <div>
                  <dt>Change set</dt>
                  <dd>
                    <a href={href({ screen: 'changes', id: set.id })}>#{set.number} {set.title}</a>
                    {siblings.length > 1 && (
                      <ol className="set-mini" aria-label="Its pull requests, in merge order">
                        {siblings.map((p) => <li key={p.id} className={p.id === pull?.id ? 'me' : ''}><span className="mono">{p.repo.split('/')[1]}#{p.number}</span> {p.title}</li>)}
                      </ol>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>Deployed</dt>
                <dd>{envs.length ? envs.map((e) => <span key={e.id} className="env-mini"><Globe size={12} aria-hidden="true" /> <b>{e.name}</b> <span className="mono">{e.version}</span> <span className="faint">{ago(e.deployedAt)}</span></span>) : <span className="faint">{pull ? 'Not yet. It ships with its change set.' : 'Nothing to deploy yet.'}</span>}</dd>
              </div>
              {note && (
                <div>
                  <dt>From the note</dt>
                  <dd className="fact-note">
                    {card.quote && <q>{card.quote}</q>}
                    <a className="link-row" href={href({ screen: 'notes', id: note.id })}><Quote size={12} aria-hidden="true" /> {note.title} <ArrowUpRight size={12} aria-hidden="true" /></a>
                  </dd>
                </div>
              )}
              {waits.length > 0 && <div><dt>Waits for</dt><dd className="fact-cards">{waits.map((other) => <a key={other.id} className={`chip ${stageTone[other.stage]}`} href={href({ screen: 'work', id: other.id })}><i />{other.title}</a>)}</dd></div>}
              {blocks.length > 0 && <div><dt>Holds up</dt><dd className="fact-cards">{blocks.map((other) => <a key={other.id} className={`chip ${stageTone[other.stage]}`} href={href({ screen: 'work', id: other.id })}><i />{other.title}</a>)}</dd></div>}
            </dl>
          </section>

          <section className="side-card activity-card">
            <h3>Activity</h3>
            <ol className="activity">
              {shownTimeline.map((event, index) => {
                const Icon = event.kind === 'pr' ? GitPullRequest : event.kind === 'merged' ? GitMerge : event.kind === 'deployed' ? Rocket : event.kind === 'claimed' ? Workflow : event.kind === 'completed' ? Check : event.kind === 'created' ? Sparkles : event.kind === 'question' ? MessageCircleQuestion : GitCommitHorizontal
                return <li key={index}><Icon size={12} aria-hidden="true" /> <span><b>{nameFor(state, event.by)}</b> {event.text}{event.times > 1 && <em className="times"> ×{event.times}</em>}</span><time>{ago(event.at)}</time></li>
              })}
            </ol>
            {timeline.length > shownTimeline.length && <button className="text-button" onClick={() => setAllActivity(true)}>Show all {timeline.length}</button>}
          </section>
        </aside>
      </div>
    </div>
  )
}
