import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, CornerUpLeft, FilePen, FileSearch, FileText, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Globe, Link2, ListChecks, MessageCircleQuestion, OctagonAlert, Quote, ShieldQuestionMark, Rocket, Send, ShieldCheck, Sparkles, Square, SquareTerminal, Trash2, Workflow } from 'lucide-react'
import { stages, type Card, type Environment, type HubState, type PullRequest } from '../data/model'
import { nameFor, useStore } from '../data/store'
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
import { go, href } from '../route'
import { useUI } from '../ui'
import { titleOf } from '../../../shared/notes.ts'
import { mayTake, meantForNow, repoEnvironments } from '../../../shared/work.ts'

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
    ['note', 'Written', note ? `In “${titleOf(note.text)}”` : 'Put on the board by hand', true, FileText],
    ['board', 'On the board', card.jira ? `Jira ${card.jira.key}` : card.issue ? `Issue #${card.issue.number}` : 'Ready for an agent', card.stage !== 'proposed', ListChecks],
    ['claim', 'Claimed', agent ? agent.name : meantForNow(state, card) ? `Meant for ${nameFor(state, card.meantFor!)}` : card.stage === 'ready' && !state.agents.some((a) => !a.revoked && mayTake(state, a, card)) ? 'No agent works in this binder and repo: set one’s binders and repos on the Agents page' : 'Any agent that can', !!agent || rank >= 3, Workflow],
    ['build', 'Built', card.stage === 'working' ? (card.doing ?? 'Working') : rank > 2 ? 'Finished' : 'Not started', rank > 2, SquareTerminal],
    ['pr', 'Pull request', pull ? `${pull.repo.split('/')[1]}#${pull.number}` : card.stage === 'live' && !pull ? 'None needed' : 'Not opened', !!pull || (card.stage === 'live' && !pull), GitPullRequest],
    ['checks', 'Checks', checks ? checks.text : '—', checks?.state === 'passed' || (!!pull && !pull.checks.length && pull.state !== 'open') || (card.stage === 'live' && !pull), ShieldCheck],
    ['approve', 'Approved', set ? `In change set #${set.number}` : '—', (!!pull && pull.state !== 'open') || (card.stage === 'live' && !pull), ShieldCheck],
    ['merge', 'Merged', pull?.state === 'merged' ? 'In order with its set' : '—', pull?.state === 'merged' || (card.stage === 'live' && !pull), GitMerge],
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

export function Work({ id }: { id: string }) {
  const store = useStore()
  const { state } = store
  const card = state.cards.find((c) => c.id === id)
  const { binder: inBinder, setBinder } = useUI()
  useEffect(() => {
    if (card && inBinder !== 'all' && card.binderId !== inBinder) setBinder(card.binderId)
  }, [card, inBinder, setBinder])
  const [showSession, setShowSession] = useState(true)
  // What it did: a box of its own that scrolls, opening at the latest step and following new ones while you're there.
  const stepsBox = useRef<HTMLOListElement>(null)
  const seenSteps = useRef(0)
  const stepCount = card ? card.activity.filter((x) => x.kind === 'step').length : 0
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
        <p>That card isn’t on the board, or it’s still loading.</p>
        <a href={href({ screen: 'flow' })}>Back to Work</a>
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
  const current = steps.find((s) => s.state === 'now')
  const working = card.stage === 'working'
  const tasks = card.activity.filter((a) => a.kind === 'step')
  const lines = sessionLines(card.activity)
  const held = card.stage === 'working' && !!card.agentId
  // What an agent holds, working or blocked on a question: Stop ends it, and deleting says so.
  const holds = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
  const holder = state.agents.find((a) => a.id === card.agentId)
  // Words on a card in review reach no agent on their own: sending them back does, and the hub takes that only while its pull request is open.
  const canSendBack = card.stage === 'review' && !!agent && !!pull && pull.state === 'open'
  const moveTo = (stage: Card['stage']) => store.moveCard(card.id, stage)
  // Its words are the person's to fix until an agent has them: while it's proposed or ready, or blocked with nobody on it.
  const canEdit = card.stage === 'proposed' || card.stage === 'ready' || (card.stage === 'blocked' && !card.agentId)
  const wordsFixed = card.stage === 'review' ? 'It’s in review, so its words stay as they are.' : card.stage === 'live' ? 'It’s done, so its words stay as they are.' : `${holder?.name ?? 'An agent'} is working on it, so its words stay as they are.`
  const change = (fields: Partial<Card>, said: string) => store.updateCard(card.id, fields, said)
  const sizeNames: Record<Card['size'], string> = { S: 'Small', M: 'Medium', L: 'Large' }
  const stoppedHere = stoppedBlock(card)
  const conversation = card.activity.filter((a) => a.kind === 'question' || a.kind === 'answer' || a.kind === 'comment' || a.kind === 'message')
  // The open question is shown once, in the conversation, marked; the banner is only for a question that isn't there.
  const lastQuestion = card.needsYou ? conversation.map((a) => a.kind).lastIndexOf('question') : -1
  const plan = card.plan ?? []
  const waits = card.waitsFor.map((w) => state.cards.find((c) => c.id === w)).filter((c): c is Card => !!c)
  const blocks = state.cards.filter((c) => c.waitsFor.includes(card.id))
  const envs: Environment[] = set ? state.environments.filter((e) => e.changeSetIds.includes(set.id)) : []
  const edits = tasks.filter((t) => /Edit|Write|Update/.test(t.tool ?? ''))
  const runs = tasks.filter((t) => t.tool === 'Bash')
  // Newest first, a run of the same event as one line, and the latest 30 until asked for all.
  const timeline = foldRepeats(card.activity.filter((a) => a.kind !== 'step' && a.kind !== 'said' && a.kind !== 'message')).reverse()
  const shownTimeline = allActivity ? timeline : timeline.slice(0, 30)

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

  return (
    <div className="work">
      <header className="work-head">
        <button className="icon-button" onClick={leaveCard} aria-label="Back"><ArrowLeft size={17} /></button>
        <div className="work-title">
          <div className="work-tags">
            {card.jira && (/^https:\/\//.test(card.jira.url) ? <a className="mono faint" href={card.jira.url} target="_blank" rel="noreferrer" title="Its Jira issue">{card.jira.key} <ArrowUpRight size={11} /></a> : <span className="mono faint">{card.jira.key}</span>)}
            {card.issue && (card.issue.url ? <a className="mono faint" href={card.issue.url} target="_blank" rel="noreferrer" title={`Its issue, in ${card.issue.repo}`}>#{card.issue.number} {card.issue.repo.split('/')[1]} <ArrowUpRight size={11} /></a> : <span className="mono faint">#{card.issue.number} {card.issue.repo.split('/')[1]}</span>)}
            <span className="faint">{binder?.name}</span>
            {pull ? <RepoTag repo={pull.repo} title={`Its pull request is in ${pull.repo}`} /> : !card.issue && binder?.repo && <RepoTag repo={binder.repo} />}
            <span className={`stage-pill ${stageTone[card.stage]}`}><i />{stages.find((s) => s.id === card.stage)?.title}</span>
            <span className="size-tag">{card.size}</span>
            {card.agentId && (state.terminals?.[card.agentId]?.sessions ?? []).filter((s) => s.card === card.id).map((s) => (
              <a key={s.sid} className="faint" href={href({ screen: 'terminal', id: card.agentId!, sid: s.sid })} title={s.dir}>{s.run ? 'Watch or take over its terminal' : `Its terminal: ${s.name ?? s.tool}`}</a>
            ))}
            {(() => {
              const parts = state.cards.filter((c) => c.parent === card.id)
              const parent = card.parent ? state.cards.find((c) => c.id === card.parent) : undefined
              return (
                <>
                  {parts.length > 0 && (
                    <span className="faint" title={parts.map((p) => `${p.title} — ${p.stage}`).join('\n')}>
                      Swarm of {parts.length} part{parts.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {parent && <span className="faint">Part of <a href={href({ screen: 'work', id: parent.id })}>{parent.title}</a></span>}
                </>
              )
            })()}
          </div>
          <h1>{canEdit ? <EditableText label="Title" value={card.title} required onSave={(title) => change({ title }, 'Changed the title')} /> : card.title}</h1>
        </div>
        {/* Once there's a debrief, its own section has the button. */}
        {!card.debrief && <DebriefButton card={card} />}
        {!card.challenge && <ChallengeButton card={card} pick />}
        <AgentPicker card={card} working={working} />
      </header>

      <ol className="sdlc" aria-label="Where it is" style={{ '--steps': steps.length } as CSSProperties}>
        {steps.map((step, index) => {
          const Icon = step.icon
          return (
            <li key={step.id} className={step.state}>
              {index > 0 && <span className="sdlc-line" />}
              <motion.span layout className="sdlc-dot">{step.state === 'done' ? <Check size={12} strokeWidth={3} /> : <Icon size={12} />}</motion.span>
              <b>{step.title}</b>
              <em>{step.detail}</em>
            </li>
          )
        })}
      </ol>

      <div className="work-body">
        <div className="work-main">
          {card.stopped && (
            <section className="now-card asks stopped-card">
              <span className="now-label"><OctagonAlert size={12} /> {stoppedWords(card.stopped.times)}</span>
              <p>
                <b>{card.stopped.why}</b>
                <span className="faint">{askedWords(card.stopped.at)}</span>
                {stoppedHere && <span className="faint stopped-next">Fix what’s wrong, then answer below and it goes back to Ready.</span>}
              </p>
            </section>
          )}
          {card.permission && !card.permission.answer && (
            <section className="now-card asks permission-card">
              <span className="now-label"><ShieldQuestionMark size={12} /> Asks permission</span>
              <div className="permission-body">
                <b>{card.permission.tool}</b>
                <pre className="mono">{card.permission.what}</pre>
                {holder && holder.owner.toLowerCase() === state.me?.user.login.toLowerCase() ? (
                  <div className="permission-actions">
                    <button className="button primary" onClick={() => void attempt(() => store.answerPermission(card.id, card.permission!.request, true))}>Allow</button>
                    <button className="button" onClick={() => void attempt(() => store.answerPermission(card.id, card.permission!.request, false))}>Deny</button>
                  </div>
                ) : <p className="faint small">Only {holder?.name ?? 'its agent'}’s owner{holder ? `, @${holder.owner},` : ''} can answer this.</p>}
              </div>
            </section>
          )}
          {card.needsYou && lastQuestion >= 0 ? null : card.needsYou ? (
            // Its page already says why it stopped and what to do.
            stoppedHere && card.stopped ? null : (
              <section className="now-card asks">
                <span className="now-label"><MessageCircleQuestion size={12} /> {stoppedHere ? 'Stopped twice' : 'Asks you'}</span>
                <p><b>{card.needsYou}</b></p>
              </section>
            )
          ) : current && (
            <section className="now-card">
              <span className="now-label">Now</span>
              <p>
                <b>{current.title}</b> · {current.detail}
                {working && card.progress !== undefined && <span className="now-progress"><Progress value={card.progress} /> <span className="num">{Math.round(card.progress * 100)}%</span></span>}
              </p>
            </section>
          )}

          <DebriefView card={card} />
          <ChallengeView card={card} />

          <section className="work-section conversation-section">
            <h2>Conversation <span className="num faint">{conversation.length}</span></h2>
            {conversation.length > 0 && (
              <ol className="conversation">
                {conversation.map((a, index) => (
                  <li key={index} className={`${a.kind}${index === lastQuestion ? ' open' : ''}`}>
                    <Who id={a.by} size={24} />
                    <div>
                      <b>{nameFor(state, a.by)}</b>{a.to && <span className="faint"> to {nameFor(state, a.to)}</span>} <time>{ago(a.at)}</time>
                      {index === lastQuestion && <span className="asks-tag"><MessageCircleQuestion size={11} /> {stoppedHere ? 'Stopped twice' : 'Asks you'}</span>}
                      <p>{a.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <form className="reply" onSubmit={send}>
              <input id="card-reply" autoFocus={!!card.needsYou && !onTouch()} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={stoppedHere ? 'Write anything, and it goes back to Ready…' : card.needsYou ? 'Answer the question…' : working ? 'Tell it something: it stops, reads it and carries on…' : canSendBack ? `Comment, or send it back to ${agent!.name} with these words…` : 'Add a comment…'} />
              <button className="button primary" disabled={!reply.trim() || sending}><Send size={14} /> {card.needsYou ? 'Answer' : canSendBack ? 'Comment' : 'Send'}</button>
              {canSendBack && <button type="button" className="button" disabled={!reply.trim() || sending} onClick={() => void sendBack(reply)}><CornerUpLeft size={14} /> Send back to {agent!.name}</button>}
            </form>
          </section>

          {plan.length > 0 && (
            <section className="work-section">
              <h2>Plan <span className="num faint">{plan.filter((p) => p.done).length} of {plan.length}</span></h2>
              <ul className="plan">
                {plan.map((step) => (
                  <li key={step.text} className={step.done ? 'done' : ''}><span className="plan-box">{step.done && <Check size={11} strokeWidth={3} />}</span>{step.text}</li>
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
                      <span className={`task-icon ${(task.tool ?? '').toLowerCase()}`}><Icon size={13} /></span>
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
              <button className="section-toggle" onClick={() => setShowSession(!showSession)} aria-expanded={showSession}>
                <h2>Session</h2>
                <ChevronDown size={16} style={{ transform: showSession ? 'none' : 'rotate(-90deg)' }} />
              </button>
              {showSession && <Terminal lines={lines} working={working} doing={card.doing} />}
            </section>
          )}

          {pull && pull.files.length > 0 && (
            <section className="work-section">
              <button className="section-toggle" onClick={() => setShowChanges(!changesOpen)} aria-expanded={changesOpen}>
                <h2>Changes <span className="num faint"><span className="plus">+{pull.files.reduce((n, f) => n + f.added, 0)}</span> <span className="minus">−{pull.files.reduce((n, f) => n + f.removed, 0)}</span></span></h2>
                <ChevronDown size={16} style={{ transform: changesOpen ? 'none' : 'rotate(-90deg)' }} />
              </button>
              {changesOpen && <PullDiffs pull={pull} boxed />}
            </section>
          )}
        </div>

        <aside className="work-side">
          <section className="side-card brief-card">
            <h3>Brief</h3>
            {canEdit ? <EditableText label="Brief" value={card.brief} multiline placeholder="No brief. Add one." onSave={(brief) => change({ brief }, 'Changed the brief')} /> : <p className="brief-text">{card.brief || 'No brief.'}</p>}
            {canEdit ? (
              <>
                <h3>Done when</h3>
                <EditableText label="Done when" value={card.doneWhen} placeholder="Add how you’ll know it’s finished" onSave={(doneWhen) => change({ doneWhen }, 'Changed the done-when')} />
                <h3>Size</h3>
                <select className="edit-select" aria-label="Size" value={card.size} onChange={(event) => change({ size: event.target.value as Card['size'] }, `Changed the size to ${sizeNames[event.target.value as Card['size']].toLowerCase()}`)}>
                  {(['S', 'M', 'L'] as const).map((size) => <option key={size} value={size}>{sizeNames[size]}</option>)}
                </select>
              </>
            ) : (
              <>
                {card.doneWhen && <><h3>Done when</h3><p className="brief-text">{card.doneWhen}</p></>}
                <p className="faint small">{wordsFixed}</p>
              </>
            )}
            {card.stage === 'proposed' && (
              <>
                <p className="faint small">No agent takes it while it’s proposed. Fix its words, then put it in Ready.</p>
                <button type="button" className="button primary" onClick={() => moveTo('ready')}>Put it in Ready</button>
              </>
            )}
          </section>

          <section className="side-card">
            <h3>Move it</h3>
            <div className="stage-moves" role="group" aria-label="Move to">
              {movesOf(card).map((m) => {
                const ask = moveAsk(card, m.stage, holder?.name)
                // Taking a card from its agent stops the run, so that one asks first.
                return ask
                  ? <ConfirmButton key={m.stage} className="" question={ask} onConfirm={() => moveTo(m.stage)}>{m.title}</ConfirmButton>
                  : <button key={m.stage} type="button" className={card.stage === m.stage ? 'on' : ''} disabled={card.stage === m.stage} onClick={() => moveTo(m.stage)}>{m.title}</button>
              })}
            </div>
            <div className="card-controls">
              <button type="button" className="button" onClick={() => copyCardLink(card.id)}><Link2 size={13} /> Copy link</button>
              {held && !card.needsYou && <button className="button primary" onClick={() => void attempt(() => store.comment(card.id, 'Carry on with this card.'))}><Send size={13} /> Nudge {holder?.name ?? 'the agent'}</button>}
              {holds && <button type="button" className="button" onClick={() => void stopHolding(card, store)}><Square size={13} /> Stop</button>}
              <ConfirmButton className="button danger" question={holds ? `Delete it and stop ${holder?.name ?? 'the agent'}? Press again` : 'Delete it? Press again'} onConfirm={() => { store.deleteCard(card.id); go({ screen: 'flow' }) }}><Trash2 size={14} /> Delete</ConfirmButton>
            </div>
            {held && <p className="faint small">{holder?.name ?? 'An agent'} holds it. {card.needsYou ? 'Answer its question and it carries on.' : 'Nudge sends it a comment, and it carries on as soon as its runner is listening.'}</p>}
          </section>

          {note && (
            <a className="side-card quote-card" href={href({ screen: 'notes', id: note.id })}>
              <h3><Quote size={12} /> From the note</h3>
              {card.quote ? <q>{card.quote}</q> : <p>{titleOf(note.text)}</p>}
              <span className="link-row">{titleOf(note.text)} <ArrowUpRight size={12} /></span>
            </a>
          )}

          {(waits.length || blocks.length) ? (
            <section className="side-card">
              {waits.length ? <h3>Waits for</h3> : null}
              {waits.map((other) => <a key={other.id} className={`chip ${stageTone[other.stage]}`} href={href({ screen: 'work', id: other.id })}><i />{other.title}</a>)}
              {blocks.length ? <h3>Holds up</h3> : null}
              {blocks.map((other) => <a key={other.id} className={`chip ${stageTone[other.stage]}`} href={href({ screen: 'work', id: other.id })}><i />{other.title}</a>)}
            </section>
          ) : null}

          {pull && (
            <section className="side-card">
              <h3>Pull request</h3>
              <div className="pr-card-head"><GitPullRequest size={14} className={pull.state === 'merged' ? 'merged' : 'open'} /><b>{pull.title}</b></div>
              <div className="pr-branch mono"><GitBranch size={12} /> {pull.branch || 'branch'} · {pull.url ? <a href={pull.url} target="_blank" rel="noreferrer">{pull.repo.split('/')[1]}#{pull.number}</a> : `${pull.repo.split('/')[1]}#${pull.number}`} <DebriefButton card={card} inline /> <ChallengeButton card={card} inline /></div>
              <ul className="check-list">
                {pull.checks.map((c) => (
                  <li key={c.name}>
                    <CheckGlyph state={c.state} /> <span className="mono">{c.name}</span> <em className="num">{c.seconds ? `${c.seconds}s` : c.state}</em>
                    {canSendBack && c.state === 'failed' && <button type="button" className="text-button check-fix" disabled={sending} onClick={() => void sendBack(`The check “${c.name}” failed. Fix it and push.`)}>Send back to fix</button>}
                  </li>
                ))}
                {!pull.checks.length && <li className="faint">No checks reported yet.</li>}
              </ul>
            </section>
          )}

          {set && (
            <a className="side-card" href={href({ screen: 'changes', id: set.id })}>
              <h3>Change set #{set.number}</h3>
              <p><b>{set.title}</b></p>
              <ol className="set-mini">
                {siblings.map((p) => <li key={p.id} className={p.id === pull?.id ? 'me' : ''}><span className="mono">{p.repo.split('/')[1]}#{p.number}</span> {p.title}</li>)}
              </ol>
            </a>
          )}

          <section className="side-card">
            <h3>Deployed</h3>
            {envs.length ? envs.map((e) => <p key={e.id} className="env-mini"><Globe size={12} /> <b>{e.name}</b> <span className="mono">{e.version}</span> <span className="faint">{ago(e.deployedAt)}</span></p>) : <p className="faint">{pull ? 'Not yet. It ships with its change set.' : 'Nothing to deploy yet.'}</p>}
          </section>

          <section className="side-card">
            <h3>Activity</h3>
            <ol className="activity">
              {shownTimeline.map((event, index) => {
                const Icon = event.kind === 'pr' ? GitPullRequest : event.kind === 'merged' ? GitMerge : event.kind === 'deployed' ? Rocket : event.kind === 'claimed' ? Workflow : event.kind === 'completed' ? Check : event.kind === 'created' ? Sparkles : event.kind === 'question' ? MessageCircleQuestion : GitCommitHorizontal
                return <li key={index}><Icon size={12} /> <span><b>{nameFor(state, event.by)}</b> {event.text}{event.times > 1 && <em className="times"> ×{event.times}</em>}</span><time>{ago(event.at)}</time></li>
              })}
            </ol>
            {timeline.length > shownTimeline.length && <button className="text-button" onClick={() => setAllActivity(true)}>Show all {timeline.length}</button>}
          </section>
        </aside>
      </div>
    </div>
  )
}
