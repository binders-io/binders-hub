import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, FilePen, FileSearch, FileText, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Globe, ListChecks, MessageCircleQuestion, Quote, ShieldQuestionMark, Rocket, Send, ShieldCheck, Sparkles, SquareTerminal, Trash2, Workflow } from 'lucide-react'
import { stages, type Card, type Environment, type HubState, type PullRequest } from '../data/model'
import { nameFor, useStore } from '../data/store'
import { CheckGlyph, Progress, RepoTag, Who, ago, checksSummary, foldRepeats, onTouch, stageTone } from '../components/bits'
import { Terminal } from '../components/Terminal'
import { DebriefButton, DebriefView } from '../components/Debrief'
import { ChallengeButton, ChallengeView } from '../components/Challenge'
import { AgentPicker } from '../components/AgentPicker'
import { sessionLines } from '../data/session'
import { attempt } from '../components/Toast'
import { go, href } from '../route'
import { useUI } from '../ui'
import { titleOf } from '../../../shared/notes.ts'
import { mayTake, meantForNow } from '../../../shared/work.ts'

type StepState = 'done' | 'now' | 'next'

interface Step {
  id: string
  title: string
  detail: string
  state: StepState
  icon: typeof Check
}

/** The story's way through the development cycle, from the note it came from to production, worked out from where it is now. */
function lifecycle(card: Card, state: HubState): Step[] {
  const pull = state.pulls.find((p) => p.id === card.prId)
  const set = pull && state.changeSets.find((c) => c.prIds.includes(pull.id))
  const envs = state.environments.filter((e) => e.id !== 'preview')
  const last = envs[envs.length - 1]
  const first = envs[0]
  const inEnv = (env?: Environment) => !!set && !!env?.changeSetIds.includes(set.id)
  const agent = state.agents.find((a) => a.id === card.agentId)
  const note = state.notes.find((n) => n.id === card.noteId)
  const checks = pull ? checksSummary(pull.checks) : undefined
  const rank = stages.findIndex((s) => s.id === card.stage)
  const raw: [string, string, string, boolean, typeof Check][] = [
    ['note', 'Written', note ? `In “${titleOf(note.text)}”` : 'Put on the board by hand', true, FileText],
    ['board', 'On the board', card.issue ? `Issue #${card.issue.number}` : 'Ready for an agent', card.stage !== 'proposed', ListChecks],
    ['claim', 'Claimed', agent ? agent.name : meantForNow(state, card) ? `Meant for ${nameFor(state, card.meantFor!)}` : card.stage === 'ready' && !state.agents.some((a) => !a.revoked && mayTake(state, a, card)) ? 'No agent works in this binder and repo: set one’s binders and repos on the Agents page' : 'Any agent that can', !!agent || rank >= 3, Workflow],
    ['build', 'Built', card.stage === 'working' ? (card.doing ?? 'Working') : rank > 2 ? 'Finished' : 'Not started', rank > 2, SquareTerminal],
    ['pr', 'Pull request', pull ? `${pull.repo.split('/')[1]}#${pull.number}` : card.stage === 'live' && !pull ? 'None needed' : 'Not opened', !!pull || (card.stage === 'live' && !pull), GitPullRequest],
    ['checks', 'Checks', checks ? checks.text : '—', checks?.state === 'passed' || (!!pull && !pull.checks.length && pull.state !== 'open') || (card.stage === 'live' && !pull), ShieldCheck],
    ['approve', 'Approved', set ? `In change set #${set.number}` : '—', (!!pull && pull.state !== 'open') || (card.stage === 'live' && !pull), ShieldCheck],
    ['merge', 'Merged', pull?.state === 'merged' ? 'In order with its set' : '—', pull?.state === 'merged' || (card.stage === 'live' && !pull), GitMerge],
    ['staging', first?.name ?? 'Staging', inEnv(first) ? first!.version : 'After merging', inEnv(first) || (card.stage === 'live'), Globe],
    ['production', last?.name ?? 'Production', inEnv(last) || card.stage === 'live' ? (pull ? last?.version ?? '' : 'Done') : 'After your approval', inEnv(last) || card.stage === 'live', Rocket],
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
  const [allActivity, setAllActivity] = useState(false)
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
  const set = pull && state.changeSets.find((c) => c.prIds.includes(pull.id))
  const siblings = set ? set.prIds.map((p) => state.pulls.find((x) => x.id === p)).filter((p): p is PullRequest => !!p) : []
  const note = state.notes.find((n) => n.id === card.noteId)
  const binder = state.binders.find((b) => b.id === card.binderId)
  const current = steps.find((s) => s.state === 'now')
  const working = card.stage === 'working'
  const tasks = card.activity.filter((a) => a.kind === 'step')
  const lines = sessionLines(card.activity)
  const held = card.stage === 'working' && !!card.agentId
  const holder = state.agents.find((a) => a.id === card.agentId)
  const moves: { stage: Card['stage']; title: string }[] = [
    { stage: 'proposed', title: 'Proposed' }, { stage: 'ready', title: 'Ready' }, { stage: 'review', title: 'In review' }, { stage: 'live', title: 'Done' },
  ]
  const moveTo = (stage: Card['stage']) => store.moveCard(card.id, stage)
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

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!reply.trim()) return
    const text = reply
    setReply('')
    await attempt(() => store.comment(card.id, text))
  }

  return (
    <div className="work">
      <header className="work-head">
        <button className="icon-button" onClick={() => (window.history.length > 1 ? window.history.back() : go({ screen: 'flow' }))} aria-label="Back"><ArrowLeft size={17} /></button>
        <div className="work-title">
          <div className="work-tags">
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
          <h1>{card.title}</h1>
        </div>
        {/* Once there's a debrief, its own section has the button. */}
        {!card.debrief && <DebriefButton card={card} />}
        {!card.challenge && <ChallengeButton card={card} pick />}
        <AgentPicker card={card} working={working} />
      </header>

      <ol className="sdlc" aria-label="Where it is">
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
            <section className="now-card asks">
              <span className="now-label"><MessageCircleQuestion size={12} /> Asks you</span>
              <p><b>{card.needsYou}</b></p>
            </section>
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

          <section className="work-section">
            <h2>Conversation <span className="num faint">{conversation.length}</span></h2>
            {conversation.length > 0 && (
              <ol className="conversation">
                {conversation.map((a, index) => (
                  <li key={index} className={`${a.kind}${index === lastQuestion ? ' open' : ''}`}>
                    <Who id={a.by} size={24} />
                    <div>
                      <b>{nameFor(state, a.by)}</b>{a.to && <span className="faint"> to {nameFor(state, a.to)}</span>} <time>{ago(a.at)}</time>
                      {index === lastQuestion && <span className="asks-tag"><MessageCircleQuestion size={11} /> Asks you</span>}
                      <p>{a.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <form className="reply" onSubmit={send}>
              <input id="card-reply" autoFocus={!!card.needsYou && !onTouch()} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={card.needsYou ? 'Answer the question…' : working ? 'Tell it something: it stops, reads it and carries on…' : 'Comment, or tell the agent something…'} />
              <button className="button primary" disabled={!reply.trim()}><Send size={14} /> {card.needsYou ? 'Answer' : 'Send'}</button>
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
              <h2>Changes <span className="num faint"><span className="plus">+{pull.files.reduce((n, f) => n + f.added, 0)}</span> <span className="minus">−{pull.files.reduce((n, f) => n + f.removed, 0)}</span></span></h2>
              {pull.files.map((file) => (
                <div key={file.path} className="pull file-card">
                  <div className="file-head mono"><span>{file.path}</span><span className="num"><span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span></span></div>
                  <div className="diff mono">
                    {file.lines.map((line, i) => (
                      <div key={i} className={`d-line ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : line.kind === '@' ? 'hunk' : ''}`}>
                        <span className="d-sign">{line.kind === '@' ? '' : line.kind}</span>
                        <span className="d-text">{line.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>

        <aside className="work-side">
          <section className="side-card">
            <h3>Brief</h3>
            <p>{card.brief || 'No brief.'}</p>
            {card.doneWhen && <><h3>Done when</h3><p>{card.doneWhen}</p></>}
          </section>

          <section className="side-card">
            <h3>Move it</h3>
            <div className="stage-moves" role="group" aria-label="Move to">
              {moves.map((m) => (
                <button key={m.stage} type="button" className={card.stage === m.stage ? 'on' : ''} disabled={card.stage === m.stage} onClick={() => moveTo(m.stage)}>{m.title}</button>
              ))}
            </div>
            <div className="card-controls">
              {held && !card.needsYou && <button className="button primary" onClick={() => void attempt(() => store.comment(card.id, 'Carry on with this card.'))}><Send size={13} /> Nudge {holder?.name ?? 'the agent'}</button>}
              <button className="button danger" onClick={() => { store.deleteCard(card.id); go({ screen: 'flow' }) }}><Trash2 size={14} /> Delete</button>
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
                {pull.checks.map((c) => <li key={c.name}><CheckGlyph state={c.state} /> <span className="mono">{c.name}</span> <em className="num">{c.seconds ? `${c.seconds}s` : c.state}</em></li>)}
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
