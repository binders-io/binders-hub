import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, FolderCog } from 'lucide-react'
import type { FolderRule } from '../../../../shared/work.ts'
import { call } from '../../data/api'
import type { Binder } from '../../data/model'
import { nameFor, useStore } from '../../data/store'
import { href } from '../../route'
import { ago } from '../../components/bits'
import { Environments } from '../../components/Environments'
import { FolderRuleDialog } from '../../components/FolderRules'
import { ScheduleList } from '../../components/Schedules'
import { TellChannel } from '../../components/TellChannel'
import { attempt } from '../../components/Toast'
import { Changeable, Saved, WhoCan } from './shared'
import { useBinderAccess, useSaved } from './access'
import { sectionHref } from './sections'

interface IssueStatus { on: boolean; kept: number; waiting: number; problem?: string; notes?: { to?: string; branch?: string; at?: string; error?: string } }

/**
 * What goes to GitHub as work happens (notes pushed, cards kept as issues, a Challenge's findings as review comments),
 * and what runs by itself: environments, schedules and folder rules, listed in one place.
 */
export function Flow() {
  const store = useStore()
  const { state } = store
  const { may, managers } = useBinderAccess()
  const { saved, shown } = useSaved()
  const [issues, setIssues] = useState<Record<string, IssueStatus>>()
  const refresh = () => void call<{ binders: Record<string, IssueStatus> }>('GET', '/api/issues').then((r) => setIssues(r.binders)).catch(() => {})
  // Follows the board, so counts move as cards become issues.
  useEffect(refresh, [state.sync.version, state.binders])
  const several = state.binders.length > 1
  const change = (binder: Binder, fields: Parameters<typeof store.updateBinder>[1], key: string) => {
    store.updateBinder(binder.id, fields)
    saved(`${binder.id}-${key}`)
  }
  return (
    <>
      <WhoCan may={may} managers={managers} />
      <Changeable may={may}>
        <ul className="binder-cards">
          {state.binders.map((binder) => (
            <li key={binder.id} className="settings-card">
              {several && <b className="binder-card-title">{binder.name}</b>}
              {binder.repo ? (
                <>
                  <NotesRow binder={binder} status={issues?.[binder.id]?.notes} onChange={(fields) => change(binder, fields, 'notes')} saved={<Saved show={shown(`${binder.id}-notes`)} />} />
                  <IssuesRow binderId={binder.id} repo={binder.repo} on={binder.issues !== false} status={issues?.[binder.id]} onChange={(on) => change(binder, { issues: on }, 'issues')} saved={<Saved show={shown(`${binder.id}-issues`)} />}
                    onSync={() => void attempt(() => call('POST', `/api/binders/${binder.id}/sync-issues`)).then(refresh)} />
                </>
              ) : (
                <p className="field-hint">Notes and cards go to GitHub once there’s a repo for them: <a href={sectionHref('github')}>pick one in GitHub</a>.</p>
              )}
              <ReviewCommentsRow binderId={binder.id} on={binder.reviewComments === true} onChange={(on) => change(binder, { reviewComments: on }, 'reviews')} saved={<Saved show={shown(`${binder.id}-reviews`)} />} />
            </li>
          ))}
        </ul>
      </Changeable>
      <TellChannel />
      <Environments />
      <Schedules />
      <FolderRules />
    </>
  )
}

/** A binder's notes, pushed to its repo on a branch of their own. */
function NotesRow({ binder, status, onChange, saved }: { binder: Binder; status?: IssueStatus['notes']; onChange: (fields: { notes?: boolean; notesBranch?: string }) => void; saved: ReactNode }) {
  const on = binder.notes !== false
  const branch = binder.notesBranch || 'binders-notes'
  const [changing, setChanging] = useState(false)
  return (
    <div className="issues-row">
      <div className="issues-head">
        <label className="switch" htmlFor={`binder-notes-${binder.id}`}>
          <input id={`binder-notes-${binder.id}`} type="checkbox" checked={on} onChange={(e) => onChange({ notes: e.target.checked })} />
          <span aria-hidden="true" />
          Push its notes to {binder.repo}
        </label>
        {saved}
      </div>
      {on && (
        <p className={`issues-status${status?.error && status.error !== 'No notes to push yet.' ? ' problem' : ''}`}>
          {status?.error ?? (status?.at ? `Pushed ${ago(status.at)} ago.` : 'Pushed with the next commit.')}
          {' '}<a href={`https://github.com/${binder.repo}/tree/${branch}`} target="_blank" rel="noreferrer">Notes <ArrowUpRight size={11} /></a>
          {' · '}<button type="button" className="text-button" aria-expanded={changing} onClick={() => setChanging(!changing)}>On branch <span className="mono">{branch}</span></button>
        </p>
      )}
      {on && changing && (
        <label className="field branch-field">
          <span className="field-label">Branch</span>
          <input id={`binder-branch-${binder.id}`} className="branch-input mono" defaultValue={branch} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== branch && onChange({ notesBranch: e.target.value.trim() })} />
        </label>
      )}
    </div>
  )
}

function IssuesRow({ binderId, repo, on, status, onChange, onSync, saved }: { binderId: string; repo: string; on: boolean; status?: IssueStatus; onChange: (on: boolean) => void; onSync: () => void; saved: ReactNode }) {
  return (
    <div className="issues-row">
      <div className="issues-head">
        <label className="switch" htmlFor={`binder-issues-${binderId}`}>
          <input id={`binder-issues-${binderId}`} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
          <span aria-hidden="true" />
          Keep its cards as issues in {repo}
        </label>
        {saved}
      </div>
      {on && status && (
        <p className={`issues-status${status.problem ? ' problem' : ''}`}>
          {status.problem ?? `${status.kept} card${status.kept === 1 ? '' : 's'} on GitHub${status.waiting ? `, ${status.waiting} on the way` : ''}.`}
          {' '}<a href={`https://github.com/${repo}/issues?q=label%3Abinders`} target="_blank" rel="noreferrer">Issues <ArrowUpRight size={11} /></a>
          {' · '}<button type="button" className="text-button" onClick={onSync}>Sync now</button>
        </p>
      )}
    </div>
  )
}

/** A Challenge's findings posted as a review on the card's pull request, wherever that pull request is. */
function ReviewCommentsRow({ binderId, on, onChange, saved }: { binderId: string; on: boolean; onChange: (on: boolean) => void; saved: ReactNode }) {
  return (
    <div className="issues-row">
      <div className="issues-head">
        <label className="switch" htmlFor={`binder-reviews-${binderId}`}>
          <input id={`binder-reviews-${binderId}`} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
          <span aria-hidden="true" />
          Post a Challenge’s findings as review comments on its pull request
        </label>
        {saved}
      </div>
    </div>
  )
}

/** The schedules in this binder, as the Agents page lists them: here they have a home of their own too. */
function Schedules() {
  const schedules = useStore().state.schedules ?? []
  return (
    <section className="settings-part">
      <h3 className="settings-sub">Schedules</h3>
      <p className="settings-part-detail">Notes put on the board as cards on a timer. Set one from a note’s Schedule button.</p>
      {schedules.length ? <ScheduleList schedules={schedules} /> : <p className="faint">No schedules yet.</p>}
    </section>
  )
}

/** What a folder's rule does, in a few words. */
function ruleWords(rule: FolderRule, agent: (id: string) => string) {
  if (!rule.enabled) return 'Off.'
  const parts: string[] = []
  if (rule.distill) {
    parts.push(`Distills a note once it’s had no edit for ${rule.quietMinutes} minute${rule.quietMinutes === 1 ? '' : 's'}${rule.agentId ? `, by ${agent(rule.agentId)}` : ''}`)
    if (rule.accept) parts.push(`accepts up to ${rule.accept.maxCards} card${rule.accept.maxCards === 1 ? '' : 's'} (${rule.accept.sizes.join(', ')}) without asking`)
  } else {
    parts.push('Doesn’t distill')
  }
  parts.push(rule.changeSet === 'own' ? 'gives each note its own change set' : 'adds each note’s work to the open change set')
  return `${parts.join('; ')}.`
}

/** Every folder that has a rule, with what it does, and a button that opens it as the folder's menu does. */
function FolderRules() {
  const { state } = useStore()
  const [ruling, setRuling] = useState<string>()
  // Who may open a rule is the same as in a folder's menu: its owners and admins.
  const mayRule = state.me?.role === 'owner' || state.me?.role === 'admin'
  const rules = state.folderRules ?? []
  const pathOf = (id: string) => {
    const names: string[] = []
    const seen = new Set<string>()
    for (let at = state.folders.find((f) => f.id === id); at && !seen.has(at.id); at = state.folders.find((f) => f.id === at!.parentId)) {
      seen.add(at.id)
      names.unshift(at.name)
    }
    return names.join(' / ')
  }
  return (
    <section className="settings-part">
      <h3 className="settings-sub">Folder rules</h3>
      <p className="settings-part-detail">What a folder does with the notes in it by itself. Add one from a folder’s menu in <a href={href({ screen: 'notes', id: '' })}>Notes</a>.</p>
      {!mayRule && rules.length > 0 && <p className="setup-note">Only this binder’s owners and admins open a rule.</p>}
      {rules.length ? (
        <ul className="status-list rule-list">
          {rules.map((rule) => {
            const folder = pathOf(rule.folderId) || 'A deleted folder'
            return (
              <li key={rule.id} className={rule.failing ? '' : 'ok'}>
                <span className="status-icon"><FolderCog size={12} aria-hidden="true" /></span>
                <div>
                  <b>{folder}</b>
                  <span>{ruleWords(rule, (id) => nameFor(state, id))}</span>
                  {rule.failing && <span className="schedule-failing" role="status">{rule.failing}</span>}
                </div>
                <button type="button" className="button" disabled={!mayRule} aria-label={`Open rule for ${folder}`} onClick={() => setRuling(rule.folderId)}>Open rule</button>
              </li>
            )
          })}
        </ul>
      ) : <p className="faint">No folder has a rule yet.</p>}
      {ruling && <FolderRuleDialog key={ruling} folderId={ruling} onClose={() => setRuling(undefined)} />}
    </section>
  )
}
