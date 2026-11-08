import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { ChevronDown, GitBranch, GitMerge, GitPullRequest, ShieldCheck } from 'lucide-react'
import type { ChangeSet, Environment, PullRequest } from '../data/model'
import { call } from '../data/api'
import { nameFor, useStore } from '../data/store'
import { attempt } from '../components/Toast'
import { DebriefView, SetDebriefButton } from '../components/Debrief'
import { FindingsLink, SetChallenge } from '../components/Challenge'
import { PullDiffs } from '../components/Diffs'
import { titleOf } from '../../../shared/notes.ts'
import { testTally } from '../../../shared/changeSet.ts'
import { AgentAvatar, CheckGlyph, RepoTag, checksSummary, usePhone } from '../components/bits'
import { href } from '../route'
import { useUI } from '../ui'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const

const setLabel: Record<ChangeSet['state'], string> = {
  assembling: 'Assembling',
  review: 'Waiting for you',
  merging: 'Merging',
  merged: 'Deploying',
  shipped: 'Shipped',
}

const mergeLabel: Record<NonNullable<PullRequest['mergeable']>, string> = { clean: 'Merges cleanly', behind: 'Behind its base', conflicts: 'Conflicts', blocked: 'Blocked by rules', unknown: 'Checking' }
const mergeHelp: Record<NonNullable<PullRequest['mergeable']>, string> = {
  clean: 'Merges into its base as things are now.',
  behind: 'Its base has new commits; updating the branch brings them in without help.',
  conflicts: 'Its changes clash with its base: someone has to resolve them.',
  blocked: 'The repo’s rules (reviews, required checks) don’t allow merging yet.',
  unknown: 'GitHub is working it out.',
}

/** What deleting a change set does, said before it happens. */
function deleteWarning(set: ChangeSet, pulls: PullRequest[], environments: Environment[]) {
  const open = pulls.filter((p) => p.state !== 'merged' && p.state !== 'closed').length
  const on = environments.filter((e) => e.changeSetIds.includes(set.id)).map((e) => e.name)
  return [
    `Delete change set #${set.number}?`,
    [
      set.state === 'merging' ? 'Its merging stops.' : '',
      open ? `${open === 1 ? 'Its open pull request stays' : `Its ${open} open pull requests stay`} open on GitHub, outside any change set.` : '',
      on.length ? `It also leaves ${on.join(' and ')} in Delivery.` : '',
      'Its cards stay. This can’t be undone.',
    ].filter(Boolean).join(' '),
  ].join('\n\n')
}

const prLabel: Record<PullRequest['state'], string> = { open: 'Open', approved: 'Approved', queued: 'In merge queue', merged: 'Merged', closed: 'Closed' }

/** Pull requests that belong together, read top to bottom and approved with one decision. */
type Tab = 'changes' | 'debrief' | 'review'

/** The tab last open on the Change sets page, remembered in this browser. */
const rememberedTab = (): Tab => {
  try {
    const tab = window.localStorage.getItem('binders-set-tab')
    return tab === 'debrief' || tab === 'review' ? tab : 'changes'
  } catch {
    return 'changes'
  }
}

export function ChangeSets({ id }: { id: string }) {
  const store = useStore()
  const { state } = store
  const { binder } = useUI()
  const [tab, setTab] = useState<Tab>(rememberedTab)
  const phone = usePhone()
  const choose = (next: Tab) => {
    setTab(next)
    try { window.localStorage.setItem('binders-set-tab', next) } catch { /* only a convenience */ }
  }
  // What's still in flight first (waiting on review, then merging, then still assembling), what's shipped below; the
  // newest first within each.
  const order: Record<string, number> = { review: 0, merging: 1, assembling: 2, merged: 3, shipped: 4 }
  const sets = state.changeSets
    .filter((c) => binder === 'all' || c.binderId === binder)
    .sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2) || b.number - a.number)
  const set = state.changeSets.find((c) => c.id === id) ?? sets[0]
  // Opening a set asks GitHub whether each of its pull requests still merges.
  const setId = set?.id
  const setState = set?.state
  useEffect(() => {
    if (!setId || (setState !== 'review' && setState !== 'assembling')) return
    void call('POST', `/api/sets/${setId}/check`).catch(() => {})
  }, [setId, setState])
  if (!set) {
    return (
      <div className="empty-screen">
        <h2>No change sets yet</h2>
        <p>When an agent finishes a card with a pull request, it goes into the binder’s change set here. You approve the set once, and the hub merges its pull requests in order.</p>
      </div>
    )
  }
  const firstNote = state.notes.find((n) => n.id === set.noteIds[0])
  const conflicts = set.prIds.map((p) => state.pulls.find((x) => x.id === p)).filter((p): p is PullRequest => !!p && p.state !== 'merged' && p.mergeable === 'conflicts')
  const pulls = set.prIds.map((p) => state.pulls.find((x) => x.id === p)).filter((p) => !!p)
  const pending = pulls.flatMap((p) => p.checks).filter((c) => c.state !== 'passed').length
  const added = pulls.flatMap((p) => p.files).reduce((n, f) => n + f.added, 0)
  const removed = pulls.flatMap((p) => p.files).reduce((n, f) => n + f.removed, 0)
  const repos = [...new Set(pulls.map((p) => p.repo))]
  // Diffs start open only when the whole set is small and the screen isn't a phone: a big set's every line at once is
  // more than a phone's browser holds.
  const startOpen = !phone && added + removed <= diffOpenLines

  return (
    <div className="changes">
      <nav className="set-list" aria-label="Change sets">
        {sets.map((c) => (
          <a key={c.id} href={href({ screen: 'changes', id: c.id })} className={c.id === set.id ? 'on' : undefined}>
            <span className={`set-state ${c.state}`}>{setLabel[c.state]}</span>
            <b>#{c.number} {c.title}</b>
            <em className="num">{c.prIds.length} pull request{c.prIds.length === 1 ? '' : 's'}</em>
          </a>
        ))}
      </nav>

      <div className="set">
        <header className="set-head">
          <div>
            <span className={`set-state ${set.state}`}>{setLabel[set.state]}</span>
            <h2>Change set #{set.number} · {set.title}</h2>
            <p>{set.summary}</p>
            <div className="set-meta">
              {repos.map((r) => <RepoTag key={r} repo={r} />)}
              <span className="num"><span className="plus">+{added}</span> <span className="minus">−{removed}</span></span>
              {firstNote && <span>from <a href={href({ screen: 'notes', id: firstNote.id })}>{titleOf(firstNote.text)}</a>{set.forNote && ' only'}</span>}
              {set.debrief?.testPlan?.length ? <TestsLine set={set} /> : null}
            </div>
          </div>
          <div className="approve">
            {set.state === 'review' || (set.state === 'assembling' && pulls.length > 0) ? (
              <>
                <button className="button primary big" disabled={!pulls.length || pulls.some((p) => p.state !== 'merged' && p.checks.some((c) => c.state === 'failed'))} onClick={() => void attempt(() => store.approveSet(set.id))}>
                  <ShieldCheck size={16} /> {pulls.some((p) => p.state === 'merged') ? `Approve the other ${pulls.filter((p) => p.state !== 'merged').length} and merge` : `Approve ${pulls.length} and merge`}
                </button>
                <span className="approve-note">{pulls.some((p) => p.state !== 'merged' && p.checks.some((c) => c.state === 'failed')) ? 'A check failed: nothing merges until it passes.' : pending > 0 ? `Approve now and each merges once its checks pass (${pending} running).` : conflicts.length ? 'The hub settles conflicts as it merges.' : pending > 0 ? `Waiting on ${pending} check${pending === 1 ? '' : 's'}` : state.me?.github.token || state.me?.github.server ? 'Every check passed. Approved and merged on GitHub in this order, then staging.' : 'Every check passed. Merges in order, then staging. (GitHub isn’t connected, so the hub records it.)'}</span>
                {set.state === 'assembling' && <button className="text-button" onClick={() => void attempt(() => store.sendForReview(set.id))}>Close it to new pull requests</button>}
              </>
            ) : set.approvedBy ? (
              <span className="approve-note done"><ShieldCheck size={14} /> Approved by {set.approvedBy === state.me?.user.login ? 'you' : nameFor(state, set.approvedBy)}</span>
            ) : (
              <span className="approve-note">Agents add pull requests here as they finish cards.</span>
            )}
          </div>
        </header>

        {set.state === 'merging' && (
          <div className="set-train" role="status">
            <GitMerge size={16} />
            <div>
              <b>Approved: merging as each is ready</b>
              <p>{set.waiting?.length ? 'The hub merges each pull request as soon as it can, brings the base into ones that conflict, and keeps both sides where both only added lines. What’s left:' : 'Merging now.'}</p>
              {set.waiting?.length ? <ul>{set.waiting.map((w) => <li key={w.prId}>{w.why}</li>)}</ul> : null}
            </div>
          </div>
        )}
        {set.state !== 'merging' && conflicts.length > 0 && (
          <div className="set-stopped" role="status">
            <GitMerge size={16} />
            <div>
              <b>{conflicts.length} pull request{conflicts.length === 1 ? ' conflicts' : 's conflict'} with {conflicts.length === 1 ? 'its' : 'their'} base</b>
              <p>Approve anyway: the hub brings the base into {conflicts.length === 1 ? 'it' : 'them'} and settles what it can; only changes to the same lines go back to {conflicts.length === 1 ? 'its agent' : 'their agents'}, and the rest merge meanwhile.</p>
            </div>
          </div>
        )}

        {/* Its pull requests and their diffs, its debrief, and its review: a tab each, so one reads at a time. */}
        <div className="set-tabs" role="tablist" aria-label="This change set">
          {([
            ['changes', 'Changes', `${pulls.length} pull request${pulls.length === 1 ? '' : 's'}`],
            ['debrief', 'Debrief', debriefNote(set)],
            ['review', 'Review', reviewNote(set)],
          ] as const).map(([key, label, note]) => (
            <button key={key} type="button" role="tab" id={`set-tab-${key}`} aria-selected={tab === key} aria-controls={`set-panel-${key}`} className={tab === key ? 'on' : ''} onClick={() => choose(key)}>
              {label}
              {note && <span className={`set-tab-note${/high|still used|couldn’t/.test(note) ? ' bad' : /…/.test(note) ? ' busy' : ''}`}>{note}</span>}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`set-panel-${tab}`} aria-labelledby={`set-tab-${tab}`} className="set-panel">
          {tab === 'changes' && (
            <>
              {pulls.length > 0 && (
                <ol className="merge-order" aria-label="Merge order">
                  {pulls.map((p, index) => (
                    <li key={p.id}>
                      <motion.span layout className={`node ${p.state}${p.state !== 'merged' && p.mergeable === 'conflicts' ? ' conflicts' : ''}`} transition={spring}>
                        {p.state === 'merged' ? <GitMerge size={13} /> : <GitPullRequest size={13} />}
                        <span className="mono">{p.repo.split('/')[1]}#{p.number}</span>
                        <em>{prLabel[p.state]}</em>
                      </motion.span>
                      {index < pulls.length - 1 && <span className={`edge${p.state === 'merged' ? ' done' : ''}`} />}
                    </li>
                  ))}
                </ol>
              )}
              <div className="stack">
                {pulls.map((p, index) => <PullSection key={p.id} pull={p} order={index + 1} startOpen={startOpen} />)}
                {!pulls.length && <div className="stack-empty">No pull requests yet.</div>}
              </div>
            </>
          )}
          {tab === 'debrief' && (
            set.debrief ? <DebriefView set={set} /> : (
              <section className="work-section debrief" aria-label="Debrief">
                <h2>Debrief <span className="debrief-actions"><SetDebriefButton set={set} className="text-button" /></span></h2>
                <p className="faint">{pulls.length ? `An agent reads all ${pulls.length === 1 ? 'its pull request' : `${pulls.length} pull requests`} together and writes one debrief: what it does, what changed, every card’s done-when marked, what to look at, and how to try it.` : 'Once it has a pull request.'}</p>
              </section>
            )
          )}
          {tab === 'review' && (pulls.length ? <SetChallenge set={set} /> : <p className="faint">Once it has a pull request.</p>)}
        </div>
        {/* Well away from Approve. */}
        <footer className="set-foot">
          <button className="text-button delete-set" onClick={() => { if (window.confirm(deleteWarning(set, pulls, state.environments))) void attempt(() => store.deleteSet(set.id)) }}>Delete change set</button>
        </footer>
      </div>
    </div>
  )
}

/** Changed lines a set may have and still start open. */
const diffOpenLines = 800

function PullSection({ pull, order, startOpen }: { pull: PullRequest; order: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const { state } = useStore()
  const agent = state.agents.find((a) => a.id === pull.agentId)
  const card = state.cards.find((c) => c.id === pull.cardId)
  const summary = checksSummary(pull.checks)

  return (
    <section className={`pull ${pull.state}`}>
      <header className="pull-head">
        <span className="order num">{order}</span>
        <AgentAvatar agent={agent} size={24} />
        <div className="pull-title">
          <b>{pull.title}</b>
          <span className="mono"><GitBranch size={11} /> {pull.branch} · {pull.url ? <a href={pull.url} target="_blank" rel="noreferrer">{pull.repo.split('/')[1]}#{pull.number}</a> : `${pull.repo.split('/')[1]}#${pull.number}`}{card && <> <FindingsLink card={card} /></>}</span>
        </div>
        <div className="pull-checks">
          {pull.checks.map((c) => (
            <span key={c.name} className={`check-pill ${c.state}`}><CheckGlyph state={c.state} size={11} /> {c.name}</span>
          ))}
        </div>
        {pull.state !== 'merged' && pull.state !== 'closed' && pull.mergeable && pull.mergeable !== 'unknown' && (
          <span className={`merge-pill ${pull.mergeable}`} title={mergeHelp[pull.mergeable]}>{mergeLabel[pull.mergeable]}</span>
        )}
        <span className={`pull-state ${pull.state} ${summary.state}`}>{prLabel[pull.state]}</span>
        <button className="icon-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide changes' : 'Show changes'}>
          <ChevronDown size={16} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s var(--ease)' }} />
        </button>
      </header>
      {pull.state !== 'merged' && (pull.mergeable === 'conflicts' || pull.mergeable === 'behind') && (
        <div className={`merge-fix ${pull.mergeable}`}>
          {pull.mergeable === 'conflicts' ? (
            <>
              <span>{card?.stage === 'ready' && card.meantFor ? `Back with ${nameFor(state, card.meantFor)} to resolve.` : card?.stage === 'working' ? `${nameFor(state, card.agentId ?? '')} is resolving it.` : 'Its changes clash with what’s on its base now.'}</span>
              {card && card.stage !== 'working' && !(card.stage === 'ready' && card.meantFor) && (
                <button className="button" onClick={() => void attempt(() => call('POST', `/api/pulls/${encodeURIComponent(pull.repo)}/${pull.number}/resolve`))}>Send back to {agent?.name ?? 'its agent'} to resolve</button>
              )}
              <a className="text-button" href={`${pull.url}/conflicts`} target="_blank" rel="noreferrer">Resolve on GitHub</a>
            </>
          ) : (
            <>
              <span>Its base has moved on; nothing clashes.</span>
              <button className="button" onClick={() => void attempt(() => call('POST', `/api/pulls/${encodeURIComponent(pull.repo)}/${pull.number}/update-branch`))}>Update the branch</button>
            </>
          )}
        </div>
      )}
      {open && <PullDiffs pull={pull} />}
      {open && !pull.files.length && <div className="file-empty">Changes load from GitHub when you open them.</div>}
    </section>
  )
}

/** How its functional tests stand: "Tests 3 of 7 passed, 1 failed", opening its debrief where the plan is. */
function TestsLine({ set }: { set: ChangeSet }) {
  const { total, passed, failed } = testTally(set.debrief?.testPlan)
  const open = () => {
    try { window.localStorage.setItem('binders-set-tab', 'debrief') } catch { /* only a convenience */ }
    document.getElementById('set-tab-debrief')?.click()
    window.setTimeout(() => document.getElementById('test-plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }
  return (
    <button type="button" className={`tests-line${failed ? ' failed' : passed === total ? ' passed' : ''}`} onClick={open}>
      Tests {passed} of {total} passed{failed ? `, ${failed} failed` : ''}
    </button>
  )
}

/** How its debrief stands, for its tab. */
function debriefNote(set: ChangeSet) {
  const d = set.debrief
  if (!d) return ''
  if (d.state === 'asked' || d.state === 'writing') return 'writing…'
  if (d.state === 'failed' && !d.against) return 'couldn’t'
  const met = d.against?.filter((p) => p.mark === 'met').length ?? 0
  const tests = testTally(d.testPlan)
  return d.against ? `${met} of ${d.against.length} met${tests.total ? ` · tests ${tests.passed} of ${tests.total}` : ''}` : ''
}

/** How its review stands, for its tab: findings and the worst, or what the blast radius found. */
function reviewNote(set: ChangeSet) {
  const c = set.challenge
  if (!c) return ''
  if (c.state === 'asked' || c.state === 'reviewing') return 'reviewing…'
  if (c.state === 'failed') return 'couldn’t'
  const findings = c.findings ?? []
  const high = findings.filter((f) => f.severity === 'high').length
  const still = c.blast?.stillUsed ?? 0
  const parts = [findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'nothing found', high ? `${high} high` : '', still ? `${still} still used` : '']
  return parts.filter(Boolean).join(', ')
}
