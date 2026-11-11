import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowUpRight, Archive, CalendarClock, CircleDot, FolderCog, GitPullRequest, NotebookPen } from 'lucide-react'
import type { FolderRule } from '../../../../shared/work.ts'
import { call } from '../../data/api'
import type { Binder } from '../../data/model'
import { nameFor, useStore } from '../../data/store'
import { href } from '../../route'
import { ago } from '../../components/bits'
import { Environments } from '../../components/Environments'
import { FolderRuleDialog } from '../../components/FolderRules'
import { ScheduleRows } from '../../components/Schedules'
import { TellChannel } from '../../components/TellChannel'
import { attempt } from '../../components/Toast'
import { Dialog, EmptyState, Row, Rows, Section, Status } from '../../kit'
import { Saved, WhoCan } from './shared'
import { useBinderAccess, useSaved } from './access'
import { sectionHref } from './sections'

/** The hub's copies of the binder you're in: its newest on its own disk, and the daily one in the binder's repo. */
interface CopiesStatus { latest?: { at: string; bytes: number; version: number }; days: number; inRepo?: { on: boolean; repo?: string; branch: string; at?: string; failed?: string } }

/** When, as a line says it: "3h ago", "just now", or "on Nov 2" once it's more than a day. */
const when = (iso: string) => {
  const how = ago(iso)
  return how === 'now' ? 'just now' : /^\d+[smh]$/.test(how) ? `${how} ago` : `on ${how}`
}

interface IssueStatus { on: boolean; kept: number; waiting: number; problem?: string; notes?: { to?: string; branch?: string; at?: string; error?: string } }

type Detail = 'notes' | 'issues' | 'copies'

/**
 * What goes to GitHub as work happens (notes pushed, cards kept as issues, a daily copy, a Challenge's findings as review
 * comments), each a row with its switch and one line on how it stands, opening to the rest; then a channel told when
 * something waits, and what runs by itself: environments, schedules and folder rules. Everyone in the binder reads it
 * all; its owners and admins change it.
 */
export function Flow() {
  const store = useStore()
  const { state } = store
  const { may, managers } = useBinderAccess()
  const { saved, shown } = useSaved()
  const [issues, setIssues] = useState<Record<string, IssueStatus>>()
  const [copies, setCopies] = useState<CopiesStatus>()
  const [open, setOpen] = useState<{ binder: string; detail: Detail }>()
  const refresh = () => void call<{ binders: Record<string, IssueStatus> }>('GET', '/api/issues').then((r) => setIssues(r?.binders)).catch(() => {})
  // Follows the board, so counts move as cards become issues.
  useEffect(refresh, [state.sync.version, state.binders])
  // Follows the binders, so the daily copy's line is the hub's after the switch is turned.
  useEffect(() => { void call<CopiesStatus>('GET', '/api/copies').then((found) => { if (found && typeof found === 'object') setCopies(found) }).catch(() => {}) }, [state.binders])
  const several = state.binders.length > 1
  const change = (binder: Binder, fields: Parameters<typeof store.updateBinder>[1], key: string) => {
    store.updateBinder(binder.id, fields)
    saved(`${binder.id}-${key}`)
  }
  const opened = open && state.binders.find((b) => b.id === open.binder)
  return (
    <div className="gh-sections flow-sections">
      <WhoCan may={may} managers={managers} />
      {state.binders.map((binder) => (
        <Section key={binder.id} title={several ? `${binder.name} on GitHub` : 'On GitHub'}>
          <Rows label={several ? `${binder.name} on GitHub` : 'On GitHub'}>
            {binder.repo ? (
              <>
                <NotesRow binder={binder} status={issues?.[binder.id]?.notes} may={may} saved={shown(`${binder.id}-notes`)} onChange={(fields) => change(binder, fields, 'notes')} onOpen={() => setOpen({ binder: binder.id, detail: 'notes' })} />
                <IssuesRow binder={binder} status={issues?.[binder.id]} may={may} saved={shown(`${binder.id}-issues`)} onChange={(on) => change(binder, { issues: on }, 'issues')} onOpen={() => setOpen({ binder: binder.id, detail: 'issues' })} />
              </>
            ) : (
              <li className="rows-item flow-no-repo">
                <p>Notes and cards go to GitHub once there’s a repo for them: <a href={sectionHref('github')}>pick one in GitHub</a>.</p>
              </li>
            )}
            <CopiesRow binder={binder} status={copies} may={may} saved={shown(`${binder.id}-copies`)} onChange={(on) => change(binder, { copies: on }, 'copies')} onOpen={() => setOpen({ binder: binder.id, detail: 'copies' })} />
            <Row icon={<GitPullRequest size={16} />} title="Post a Challenge’s findings" meta="As review comments on its pull request, wherever that is."
              trailing={<FlowSwitch id={`binder-reviews-${binder.id}`} label="Post a Challenge’s findings as review comments on its pull request" checked={binder.reviewComments === true} disabled={!may} saved={shown(`${binder.id}-reviews`)} onChange={(on) => change(binder, { reviewComments: on }, 'reviews')} />} />
          </Rows>
        </Section>
      ))}
      <TellChannel />
      <Environments />
      <Schedules />
      <FolderRules />
      <AnimatePresence>
        {opened && open.detail === 'notes' && <NotesDialog key="notes" binder={opened} status={issues?.[opened.id]?.notes} may={may} saved={shown(`${opened.id}-branch`)} onChange={(fields) => change(opened, fields, 'branch')} onClose={() => setOpen(undefined)} />}
        {opened && open.detail === 'issues' && <IssuesDialog key="issues" binder={opened} status={issues?.[opened.id]} may={may} onSync={() => void attempt(() => call('POST', `/api/binders/${opened.id}/sync-issues`)).then(refresh)} onClose={() => setOpen(undefined)} />}
        {opened && open.detail === 'copies' && <CopiesDialog key="copies" binder={opened} status={copies} onClose={() => setOpen(undefined)} />}
      </AnimatePresence>
    </div>
  )
}

/** A row's switch: named in full for a screen reader, as the row's own words are shorter; and Saved beside it. */
function FlowSwitch({ id, label, checked, disabled, saved, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; saved: boolean; onChange: (on: boolean) => void }) {
  return (
    <>
      <Saved show={saved} />
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden="true" />
      </label>
    </>
  )
}

/** A binder's notes, pushed to its repo on a branch of their own. */
function NotesRow({ binder, status, may, saved, onChange, onOpen }: { binder: Binder; status?: IssueStatus['notes']; may: boolean; saved: boolean; onChange: (fields: { notes?: boolean }) => void; onOpen: () => void }) {
  const on = binder.notes !== false
  const branch = binder.notesBranch || 'binders-notes'
  const problem = status?.error && status.error !== 'No notes to push yet.'
  const line = !on ? `Off. They’d go to ${binder.repo}, on ${branch}.` : `To ${binder.repo}, on ${branch} · ${status?.error ?? (status?.at ? `pushed ${when(status.at)}` : 'pushed with the next commit')}`
  return (
    <Row icon={<NotebookPen size={16} />} title="Push its notes" meta={line} onPress={onOpen}
      status={on && problem ? <Status tone="bad">Failing</Status> : undefined}
      trailing={<FlowSwitch id={`binder-notes-${binder.id}`} label={`Push its notes to ${binder.repo}`} checked={on} disabled={!may} saved={saved} onChange={(next) => onChange({ notes: next })} />} />
  )
}

function IssuesRow({ binder, status, may, saved, onChange, onOpen }: { binder: Binder; status?: IssueStatus; may: boolean; saved: boolean; onChange: (on: boolean) => void; onOpen: () => void }) {
  const on = binder.issues !== false
  const line = !on ? `Off. They’d be kept in ${binder.repo}.` : status ? `In ${binder.repo} · ${status.problem ?? `${status.kept} card${status.kept === 1 ? '' : 's'} on GitHub${status.waiting ? `, ${status.waiting} on the way` : ''}`}` : `In ${binder.repo}`
  return (
    <Row icon={<CircleDot size={16} />} title="Keep its cards as issues" meta={line} onPress={onOpen}
      status={on && status?.problem ? <Status tone="bad">Failing</Status> : undefined}
      trailing={<FlowSwitch id={`binder-issues-${binder.id}`} label={`Keep its cards as issues in ${binder.repo}`} checked={on} disabled={!may} saved={saved} onChange={onChange} />} />
  )
}

/** A daily copy of the whole binder in its repo, on a branch of its own. */
function CopiesRow({ binder, status, may, saved, onChange, onOpen }: { binder: Binder; status?: CopiesStatus; may: boolean; saved: boolean; onChange: (on: boolean) => void; onOpen: () => void }) {
  const repo = binder.repo
  const on = binder.copies === true
  const inRepo = status?.inRepo
  const line = !repo ? 'This binder has no repo yet.'
    : !on ? `Off. Seven days would be kept in ${repo}.`
      : `In ${repo}, on ${inRepo?.branch ?? 'binders-copies'}${inRepo?.failed ? '' : inRepo?.at ? ` · last copy ${when(inRepo.at)}` : ''}`
  return (
    <Row icon={<Archive size={16} />} title="Keep a daily copy" meta={line} onPress={onOpen}
      status={on && inRepo?.failed ? <Status tone="bad">Failing</Status> : undefined}
      trailing={<FlowSwitch id={`binder-copies-${binder.id}`} label={`Keep a daily copy of the whole binder in ${repo ?? 'its repo'}`} checked={!!repo && on} disabled={!may || !repo} saved={saved} onChange={onChange} />} />
  )
}

/** A line of how something stands, red when it's a problem. */
const Line = ({ problem, children }: { problem?: boolean; children: ReactNode }) => <p className={`issues-status${problem ? ' problem' : ''}`}>{children}</p>

function NotesDialog({ binder, status, may, saved, onChange, onClose }: { binder: Binder; status?: IssueStatus['notes']; may: boolean; saved: boolean; onChange: (fields: { notesBranch: string }) => void; onClose: () => void }) {
  const on = binder.notes !== false
  const branch = binder.notesBranch || 'binders-notes'
  return (
    <Dialog title="Its notes on GitHub" onClose={onClose} footer={(
      <>
        <a className="button" href={`https://github.com/${binder.repo}/tree/${branch}`} target="_blank" rel="noreferrer">Notes on GitHub<ArrowUpRight size={13} aria-hidden="true" /></a>
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>
    )}>
      <div className="flow-dialog">
        <Line problem={!!status?.error && status.error !== 'No notes to push yet.'}>
          {!on ? 'Off: notes stay on the hub.' : status?.error ?? (status?.at ? `Pushed ${when(status.at)}.` : 'Pushed with the next commit.')}
        </Line>
        <label className="field">
          <span className="field-head"><span className="field-label">Branch</span><Saved show={saved} /></span>
          <input id={`binder-branch-${binder.id}`} className="mono" defaultValue={branch} disabled={!may}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== branch && onChange({ notesBranch: e.target.value.trim() })} />
          <span className="field-hint">Its notes are pushed to {binder.repo} on this branch, kept apart from the code.</span>
        </label>
      </div>
    </Dialog>
  )
}

function IssuesDialog({ binder, status, may, onSync, onClose }: { binder: Binder; status?: IssueStatus; may: boolean; onSync: () => void; onClose: () => void }) {
  const on = binder.issues !== false
  return (
    <Dialog title="Its cards as issues" onClose={onClose} footer={(
      <>
        {may && on && <button type="button" className="button dialog-foot-start" onClick={onSync}>Sync now</button>}
        <a className="button" href={`https://github.com/${binder.repo}/issues?q=label%3Abinders`} target="_blank" rel="noreferrer">Issues on GitHub<ArrowUpRight size={13} aria-hidden="true" /></a>
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>
    )}>
      <div className="flow-dialog">
        <Line problem={on && !!status?.problem}>
          {!on ? `Off: cards aren’t kept in ${binder.repo}.` : status?.problem ?? (status ? `${status.kept} card${status.kept === 1 ? '' : 's'} on GitHub${status.waiting ? `, ${status.waiting} on the way` : ''}.` : 'Asking the hub…')}
        </Line>
        <p className="faint">Each card is an issue in {binder.repo}, labelled binders, kept as the card moves. Sync now has the hub go through them all at once.</p>
      </div>
    </Dialog>
  )
}

function CopiesDialog({ binder, status, onClose }: { binder: Binder; status?: CopiesStatus; onClose: () => void }) {
  const repo = binder.repo
  const on = binder.copies === true
  const inRepo = status?.inRepo
  return (
    <Dialog title="A daily copy" onClose={onClose} footer={<button type="button" className="button primary" onClick={onClose}>Done</button>}>
      <div className="flow-dialog">
        {repo ? (
          <>
            <Line>On branch <span className="mono">{inRepo?.branch ?? 'binders-copies'}</span>. Seven days are kept. Anyone who can read {repo} can read them.</Line>
            {on && (inRepo?.failed || inRepo?.at) && <Line problem={!!inRepo.failed}>{inRepo.failed ?? `Last copy ${when(inRepo.at!)}.`}</Line>}
          </>
        ) : <Line>This binder has no repo yet.</Line>}
        <p className="issues-status faint">The hub also keeps seven days of copies on its own disk.{status?.latest ? ` Last one ${when(status.latest.at)}.` : ''}</p>
      </div>
    </Dialog>
  )
}

/** The schedules in this binder, as the Agents page lists them: here they have a home of their own too. */
function Schedules() {
  const schedules = useStore().state.schedules ?? []
  return (
    <Section title="Schedules" lead="Notes put on the board as cards on a timer.">
      {schedules.length
        ? <ScheduleRows schedules={schedules} />
        : <EmptyState compact icon={<CalendarClock size={18} />} title="No schedules yet" line="Set one from a note’s Schedule button." />}
    </Section>
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

/** Every folder that has a rule, with what it does, each opening it as the folder's menu does. */
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
  const notes = <a href={href({ screen: 'notes', id: '' })}>Notes</a>
  return (
    <Section title="Folder rules" lead={<>What a folder does with the notes in it by itself. Add one from a folder’s menu in {notes}.</>}>
      {rules.length ? (
        <>
          {!mayRule && <p className="flow-who">Only this binder’s owners and admins open a rule.</p>}
          <Rows label="Folder rules">
            {rules.map((rule) => {
              const folder = pathOf(rule.folderId) || 'A deleted folder'
              return (
                <Row key={rule.id} icon={<FolderCog size={16} />} title={folder} meta={rule.failing ?? ruleWords(rule, (id) => nameFor(state, id))}
                  status={rule.failing ? <Status tone="bad">Failing</Status> : rule.enabled ? <Status tone="ok">On</Status> : <Status tone="off">Off</Status>}
                  disabled={!mayRule} onPress={() => setRuling(rule.folderId)} />
              )
            })}
          </Rows>
        </>
      ) : <EmptyState compact icon={<FolderCog size={18} />} title="No folder has a rule yet" line={<>Open a folder’s menu in {notes} to give it one.</>} />}
      <AnimatePresence>{ruling && <FolderRuleDialog key={ruling} folderId={ruling} onClose={() => setRuling(undefined)} />}</AnimatePresence>
    </Section>
  )
}
