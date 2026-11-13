import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Check, ChevronDown, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Rocket, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react'
import type { ChangeSet, Environment, PullRequest } from '../data/model'
import { call } from '../data/api'
import { nameFor, useStore } from '../data/store'
import { attempt } from '../components/Toast'
import { ConfirmButton } from '../components/ConfirmButton'
import { DebriefView, SetDebriefButton } from '../components/Debrief'
import { FindingsLink, SetChallenge } from '../components/Challenge'
import { PullDiffs } from '../components/Diffs'
import { testTally } from '../../../shared/changeSet.ts'
import { AgentAvatar, CheckGlyph, RepoTag, checksSummary, unpicked, usePhone } from '../components/bits'
import { heard } from '../data/sync'
import { href } from '../route'
import { useUI } from '../ui'
import { useMayChangeBinder } from './settings/access'
import { EmptyState, PageHeader, Row, Rows, Status, type Tone } from '../kit'

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const

const setLabel: Record<ChangeSet['state'], string> = {
  assembling: 'Assembling',
  review: 'Waiting on you',
  merging: 'Merging',
  merged: 'Deploying',
  shipped: 'Shipped',
}

/** How a set stands, as the kit's pill says it: amber waits on you, blue is on its way, green is out. */
const setTone: Record<ChangeSet['state'], Tone> = { assembling: 'off', review: 'waiting', merging: 'running', merged: 'running', shipped: 'ok' }
const setIcon: Record<ChangeSet['state'], LucideIcon> = { assembling: GitPullRequestDraft, review: ShieldCheck, merging: GitMerge, merged: Rocket, shipped: Check }

const mergeLabel: Record<NonNullable<PullRequest['mergeable']>, string> = { clean: 'Merges cleanly', behind: 'Behind its base', conflicts: 'Conflicts', blocked: 'Blocked by rules', unknown: 'Checking' }
const mergeHelp: Record<NonNullable<PullRequest['mergeable']>, string> = {
  clean: 'Merges into its base as things are now.',
  behind: 'Its base has new commits; updating the branch brings them in without help.',
  conflicts: 'Its changes clash with its base: someone has to resolve them.',
  blocked: 'The repo’s rules (reviews, required checks) don’t allow merging yet.',
  unknown: 'GitHub is working it out.',
}

/** What deleting a change set does, said under its button once it asks. */
function deleteWarning(set: ChangeSet, pulls: PullRequest[], environments: Environment[]) {
  const open = pulls.filter((p) => p.state !== 'merged' && p.state !== 'closed').length
  const on = environments.filter((e) => e.changeSetIds.includes(set.id)).map((e) => e.name)
  return [
    set.state === 'merging' ? 'Its merging stops.' : '',
    open ? `${open === 1 ? 'Its open pull request stays' : `Its ${open} open pull requests stay`} open on GitHub, outside any change set.` : '',
    on.length ? `It also leaves ${on.join(' and ')} in Delivery.` : '',
    'Its cards stay. This can’t be undone.',
  ].filter(Boolean).join(' ')
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
  // A reader sees every change set, and approves, closes and deletes none: those controls aren't drawn.
  const may = useMayChangeBinder()
  const { binder } = useUI()
  const [tab, setTab] = useState<Tab>(rememberedTab)
  const phone = usePhone()
  // The set whose approval is on its way to the hub: the button can't be pressed again meanwhile.
  const [merging, setMerging] = useState<string>()
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
  // A set deleted from its own page: the address still names it for a moment, which isn't worth a word.
  const [deleted, setDeleted] = useState<string>()
  const asked = id ? state.changeSets.find((c) => c.id === id) : undefined
  const set = asked ?? sets[0]
  // Opening a set asks GitHub whether each of its pull requests still merges.
  const setId = set?.id
  const setState = set?.state
  useEffect(() => {
    if (!setId || (setState !== 'review' && setState !== 'assembling')) return
    void call('POST', `/api/sets/${setId}/check`).catch(() => {})
  }, [setId, setState])
  if (id && !asked && id !== deleted && heard(state.sync)) {
    return (
      <div className="changes-empty">
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true"><GitPullRequestClosed size={20} /></span>
          <h2 className="empty-state-title">That change set isn’t here any more</h2>
          <p className="empty-state-line">It may have been deleted, or moved out of reach.</p>
          <div className="empty-state-action"><a className="button primary" href={href({ screen: 'changes', id: '' })}>Go to the change sets</a></div>
        </div>
      </div>
    )
  }
  if (!set) {
    return (
      <div className="changes-empty">
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true"><GitPullRequest size={20} /></span>
          <h2 className="empty-state-title">No change sets yet</h2>
          <p className="empty-state-line">When an agent finishes a card with a pull request, it goes into the binder’s change set here. You approve the set once, and the hub merges its pull requests in order.</p>
        </div>
      </div>
    )
  }
  const list = (
    <Rows className="set-rows">
      {sets.map((c) => {
        const Icon = setIcon[c.state]
        return (
          <Row key={c.id} href={href({ screen: 'changes', id: c.id })} current={!(phone && !id) && c.id === set.id} trailing={phone ? 'chevron' : 'none'}
            icon={<span className={`set-icon ${c.state}`}><Icon size={16} /></span>}
            title={`#${c.number} ${c.title}`}
            meta={`${setLabel[c.state]} · ${c.prIds.length} pull request${c.prIds.length === 1 ? '' : 's'}`} />
        )
      })}
    </Rows>
  )
  // A phone has room for one thing: the list of sets, or the one opened from it.
  if (phone && !id) {
    return (
      <div className="page changes-list">
        <div className="page-column">
          <PageHeader title="Change sets" lead="Pull requests that belong together, approved with one decision and merged in order." />
          <nav aria-label="Change sets">{list}</nav>
        </div>
      </div>
    )
  }
  const firstNote = state.notes.find((n) => n.id === set.noteIds[0])
  const conflicts = set.prIds.map((p) => state.pulls.find((x) => x.id === p)).filter((p): p is PullRequest => !!p && p.state !== 'merged' && p.mergeable === 'conflicts')
  const pulls = set.prIds.map((p) => state.pulls.find((x) => x.id === p)).filter((p) => !!p)
  const toMerge = pulls.filter((p) => p.state !== 'merged').length
  const pending = pulls.flatMap((p) => p.checks).filter((c) => c.state !== 'passed').length
  const added = pulls.flatMap((p) => p.files).reduce((n, f) => n + f.added, 0)
  const removed = pulls.flatMap((p) => p.files).reduce((n, f) => n + f.removed, 0)
  const repos = [...new Set(pulls.map((p) => p.repo))]
  const failing = pulls.some((p) => p.state !== 'merged' && p.checks.some((c) => c.state === 'failed'))
  // Diffs start open only when the whole set is small and the screen isn't a phone: a big set's every line at once is
  // more than a phone's browser holds.
  const startOpen = !phone && added + removed <= diffOpenLines
  const approvable = may && (set.state === 'review' || (set.state === 'assembling' && pulls.length > 0))

  return (
    <div className="changes">
      {!phone && <nav className="set-list" aria-label="Change sets">{list}</nav>}

      <div className="set">
        <div className="set-page">
          {phone && <a className="set-back" href={href({ screen: 'changes', id: '' })}><ArrowLeft size={16} aria-hidden="true" />All change sets</a>}
          <header className="set-head">
            <div className="set-head-text">
              <h2>Change set #{set.number} · {set.title}</h2>
              {set.summary && <p className="set-summary">{set.summary}</p>}
              <div className="set-meta">
                <Status tone={setTone[set.state]}>{setLabel[set.state]}</Status>
                {repos.map((r) => <RepoTag key={r} repo={r} />)}
                <span className="num"><span className="plus">+{added}</span> <span className="minus">−{removed}</span></span>
                {firstNote && <span>From <a href={href({ screen: 'notes', id: firstNote.id })}>{firstNote.title}</a>{set.forNote && ' only'}</span>}
                {set.debrief?.testPlan?.length ? <TestsLine set={set} /> : null}
              </div>
            </div>
            {approvable ? (
              <div className="approve">
                <ConfirmButton
                  className="button primary big"
                  question={`Merge ${toMerge} pull request${toMerge === 1 ? '' : 's'}? Press again`}
                  disabled={!pulls.length || merging === set.id || failing}
                  onConfirm={() => {
                    setMerging(set.id)
                    void attempt(() => store.approveSet(set.id)).finally(() => setMerging(undefined))
                  }}
                >
                  <ShieldCheck size={16} aria-hidden="true" /> {merging === set.id ? 'Merging…' : pulls.some((p) => p.state === 'merged') ? `Approve the other ${toMerge} and merge` : `Approve ${pulls.length} and merge`}
                </ConfirmButton>
                <span className="approve-note">{failing ? 'A check failed: nothing merges until it passes.' : pending > 0 ? `Approve now and each merges once its checks pass (${pending} running).` : conflicts.length ? 'The hub settles conflicts as it merges.' : state.me?.github.token || state.me?.github.server ? 'Every check passed. Approved and merged on GitHub in this order, then staging.' : 'Every check passed. Merges in order, then staging. (GitHub isn’t connected, so the hub records it.)'}</span>
                {set.state === 'assembling' && <button type="button" className="text-button" onClick={() => void attempt(() => store.sendForReview(set.id))}>Close it to new pull requests</button>}
              </div>
            ) : set.approvedBy ? (
              <div className="approve"><span className="approve-note done"><ShieldCheck size={14} aria-hidden="true" /> Approved by {set.approvedBy === state.me?.user.login ? 'you' : nameFor(state, set.approvedBy)}</span></div>
            ) : may ? (
              <div className="approve"><span className="approve-note">Agents add pull requests here as they finish cards.</span></div>
            ) : null}
          </header>

          {set.state === 'merging' && (
            <div className="set-train" role="status">
              <GitMerge size={16} aria-hidden="true" />
              <div>
                <b>Approved: merging as each is ready</b>
                <p>{set.waiting?.length ? 'The hub merges each pull request as soon as it can, brings the base into ones that conflict, and keeps both sides where both only added lines. What’s left:' : 'Merging now.'}</p>
                {set.waiting?.length ? <ul>{set.waiting.map((w) => <li key={w.prId}>{w.why}</li>)}</ul> : null}
                {/* Approving again sends GitHub the person's approval again, for a push that dismissed it or one sent before. */}
                {may && state.me?.github.token && set.waiting?.length ? (
                  <button type="button" className="text-button" disabled={merging === set.id} onClick={() => {
                    setMerging(set.id)
                    void attempt(() => store.approveSet(set.id)).finally(() => setMerging(undefined))
                  }}>{merging === set.id ? 'Sending…' : 'Send GitHub my approval again'}</button>
                ) : null}
              </div>
            </div>
          )}
          {set.state !== 'merging' && conflicts.length > 0 && (
            <div className="set-stopped" role="status">
              <GitMerge size={16} aria-hidden="true" />
              <div>
                <b>{conflicts.length} pull request{conflicts.length === 1 ? ' conflicts' : 's conflict'} with {conflicts.length === 1 ? 'its' : 'their'} base</b>
                <p>Approve anyway: the hub brings the base into {conflicts.length === 1 ? 'it' : 'them'} and settles what it can; only changes to the same lines go back to {conflicts.length === 1 ? 'its agent' : 'their agents'}, and the rest merge meanwhile.</p>
              </div>
            </div>
          )}

          {/* Its pull requests and their diffs, its debrief, and its Challenge: a tab each, so one reads at a time. */}
          <div className="tabs set-tabs" role="tablist" aria-label="This change set">
            {([
              ['changes', 'Pull requests', String(pulls.length)],
              ['debrief', 'Debrief', debriefNote(set)],
              ['review', 'Challenge', reviewNote(set)],
            ] as const).map(([key, label, note]) => (
              <button key={key} type="button" role="tab" id={`set-tab-${key}`} aria-selected={tab === key} aria-controls={`set-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => choose(key)} onKeyDown={(event) => {
                // Arrow keys move along the tabs, as a tab list's do.
                const keys: Tab[] = ['changes', 'debrief', 'review']
                const at = keys.indexOf(key)
                const next = event.key === 'ArrowRight' ? keys[(at + 1) % 3] : event.key === 'ArrowLeft' ? keys[(at + 2) % 3] : undefined
                if (!next) return
                event.preventDefault()
                choose(next)
                document.getElementById(`set-tab-${next}`)?.focus()
              }}>
                {label}
                {note && <span className={`set-tab-note${/high|still used|couldn’t/.test(note) ? ' bad' : /…/.test(note) ? ' busy' : ''}`}>{note}</span>}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`set-panel-${tab}`} aria-labelledby={`set-tab-${tab}`} className="set-panel">
            {tab === 'changes' && (
              pulls.length ? (
                <ol className="stack" aria-label="Pull requests, in the order they merge">
                  {pulls.map((p, index) => <PullSection key={p.id} pull={p} order={index + 1} last={index === pulls.length - 1} startOpen={startOpen} />)}
                </ol>
              ) : <div className="stack-empty"><EmptyState compact icon={<GitPullRequest size={18} />} title="No pull requests yet" line="Agents add them here as they finish cards." /></div>
            )}
            {tab === 'debrief' && (
              set.debrief ? <DebriefView set={set} /> : (
                <section className="work-section debrief" aria-label="Debrief">
                  <h2>Debrief <span className="debrief-actions"><SetDebriefButton set={set} className="button small" /></span></h2>
                  <p className="section-line">{!may ? 'No debrief has been written yet.' : pulls.length ? `An agent reads all ${pulls.length === 1 ? 'its pull request' : `${pulls.length} pull requests`} together and writes one debrief: what it does, what changed, every card’s done-when marked, what to look at, and how to try it.` : 'Once it has a pull request.'}</p>
                </section>
              )
            )}
            {tab === 'review' && (pulls.length ? (may || set.challenge ? <SetChallenge set={set} /> : <p className="section-line">No Challenge has been asked for yet.</p>) : <p className="section-line">Once it has a pull request.</p>)}
          </div>
          {/* Well away from Approve. */}
          {may && <footer className="set-foot">
            <ConfirmButton className="button quiet small danger delete-set" question={`Delete change set #${set.number}? Press again`} detail={deleteWarning(set, pulls, state.environments)} onConfirm={() => { setDeleted(set.id); void attempt(() => store.deleteSet(set.id)) }}><Trash2 size={13} aria-hidden="true" />Delete change set</ConfirmButton>
          </footer>}
        </div>
      </div>
    </div>
  )
}

/** Changed lines a set may have and still start open. */
const diffOpenLines = 800

/** One pull request in the stack: its place in the merge order on the rail beside it, what it is, its checks, and its diff. */
function PullSection({ pull, order, last, startOpen }: { pull: PullRequest; order: number; last: boolean; startOpen: boolean }) {
  const may = useMayChangeBinder()
  const [open, setOpen] = useState(startOpen)
  const { state } = useStore()
  const agent = state.agents.find((a) => a.id === pull.agentId)
  const card = state.cards.find((c) => c.id === pull.cardId)
  const summary = checksSummary(pull.checks)
  const conflicted = pull.state !== 'merged' && pull.mergeable === 'conflicts'
  const added = pull.files.reduce((n, f) => n + f.added, 0)
  const removed = pull.files.reduce((n, f) => n + f.removed, 0)
  const name = `${pull.repo.split('/')[1]}#${pull.number}`

  return (
    <li className={`stack-item ${pull.state}${conflicted ? ' conflicts' : ''}${last ? ' last' : ''}`}>
      <motion.span layout className="stack-order num" transition={spring} aria-hidden="true">{pull.state === 'merged' ? <GitMerge size={13} /> : order}</motion.span>
      <section className={`pull ${pull.state}`} aria-label={`${order}. ${pull.title}`}>
        <header className="pull-head">
          <AgentAvatar agent={agent} size={24} />
          <div className="pull-title">
            <b>{pull.title}</b>
            <span className="pull-line">
              {pull.url ? <a className="mono" href={pull.url} target="_blank" rel="noreferrer">{name}</a> : <span className="mono">{name}</span>}
              <span className="mono pull-branch"><GitBranch size={11} aria-hidden="true" /> {pull.branch}</span>
              {card && <FindingsLink card={card} />}
            </span>
          </div>
          <span className={`pull-state ${pull.state} ${summary.state}`}>{prLabel[pull.state]}</span>
          <button type="button" className="icon-button pull-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide changes' : 'Show changes'} title={open ? 'Hide changes' : 'Show changes'}>
            <ChevronDown size={16} aria-hidden="true" style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s var(--ease)' }} />
          </button>
          {(pull.checks.length > 0 || (pull.state !== 'merged' && pull.state !== 'closed' && pull.mergeable && pull.mergeable !== 'unknown') || pull.files.length > 0) && (
            <div className="pull-checks">
              {pull.checks.map((c) => (
                <span key={c.name} className={`check-pill ${c.state}`}><CheckGlyph state={c.state} size={11} /> {c.name}</span>
              ))}
              {pull.state !== 'merged' && pull.state !== 'closed' && pull.mergeable && pull.mergeable !== 'unknown' && (
                <span className={`merge-pill ${pull.mergeable}`} title={mergeHelp[pull.mergeable]}>{mergeLabel[pull.mergeable]}</span>
              )}
              {pull.files.length > 0 && <span className="pull-size num">{pull.files.length} file{pull.files.length === 1 ? '' : 's'} <span className="plus">+{added}</span> <span className="minus">−{removed}</span></span>}
            </div>
          )}
        </header>
        {pull.state !== 'merged' && (pull.mergeable === 'conflicts' || pull.mergeable === 'behind') && (
          <div className={`merge-fix ${pull.mergeable}`}>
            {pull.mergeable === 'conflicts' ? (
              <>
                <span>{card?.stage === 'ready' && card.meantFor ? `Back with ${nameFor(state, card.meantFor)} to resolve.` : card?.stage === 'working' ? `${nameFor(state, card.agentId ?? '')} is resolving it.` : 'Its changes clash with what’s on its base now.'}</span>
                {may && card && card.stage !== 'working' && !(card.stage === 'ready' && card.meantFor) && (
                  <button className="button small" onClick={() => void attempt(() => call('POST', `/api/pulls/${encodeURIComponent(pull.repo)}/${pull.number}/resolve`))}>Send back to {agent?.name ?? 'its agent'} to resolve</button>
                )}
                <a className="text-button" href={`${pull.url}/conflicts`} target="_blank" rel="noreferrer">Resolve on GitHub</a>
              </>
            ) : (
              <>
                <span>Its base has moved on; nothing clashes.</span>
                {may && <button className="button small" onClick={() => void attempt(() => call('POST', `/api/pulls/${encodeURIComponent(pull.repo)}/${pull.number}/update-branch`))}>Update the branch</button>}
              </>
            )}
          </div>
        )}
        {open && <PullDiffs pull={pull} />}
        {open && !pull.files.length && <div className="file-empty">Changes load from GitHub when you open them.</div>}
      </section>
    </li>
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
  // Asked and nothing came of it for long enough: the card's page says the same.
  if (unpicked(d)) return d.state === 'asked' ? 'not started' : 'went quiet'
  if (d.state === 'asked' || d.state === 'writing') return 'writing…'
  if (d.state === 'failed' && !d.against) return 'couldn’t'
  const met = d.against?.filter((p) => p.mark === 'met').length ?? 0
  const tests = testTally(d.testPlan)
  return d.against ? `${met} of ${d.against.length} met${tests.total ? ` · tests ${tests.passed} of ${tests.total}` : ''}` : ''
}

/** How its Challenge stands, for its tab: findings and the worst, or what else it touches. */
function reviewNote(set: ChangeSet) {
  const c = set.challenge
  if (!c) return ''
  if (unpicked(c)) return c.state === 'asked' ? 'not started' : 'went quiet'
  if (c.state === 'asked' || c.state === 'reviewing') return 'reviewing…'
  if (c.state === 'failed') return 'couldn’t'
  const findings = c.findings ?? []
  const high = findings.filter((f) => f.severity === 'high').length
  const still = c.blast?.stillUsed ?? 0
  const parts = [findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'nothing found', high ? `${high} high` : '', still ? `${still} still used` : '']
  return parts.filter(Boolean).join(', ')
}
