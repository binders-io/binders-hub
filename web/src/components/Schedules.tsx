import { useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { CalendarClock, FileText, Pause, Play, Trash2, TriangleAlert, Zap } from 'lucide-react'
import { cronPreset, defaultStaleHours, describeCron, nextRun, presetCron, weekdays, type Preset, type Schedule } from '../../../shared/schedule.ts'
import { call } from '../data/api'
import { nameFor, useStore } from '../data/store'
import { href } from '../route'
import { ConfirmButton } from './ConfirmButton'
import { Dialog, Field } from './Dialog'
import { MenuButton, Row, Rows, Status } from '../kit'
import { attempt, toast } from './Toast'
import { ago } from './bits'
import { useMayChangeBinder } from '../screens/settings/access'

// Scheduled runs: a note run as a card on a timer, for an agent. Set from the note (its Schedule button), and listed
// with every other schedule on the Agents page.

const stageWords: Record<string, string> = { proposed: 'Proposed', ready: 'Waiting for an agent', working: 'Running', blocked: 'Blocked', review: 'In review' }

const here = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const when = (at: Date, tz: string) => at.toLocaleString(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The next few times a rule fires, or why it can't. */
function upcoming(cron: string, tz: string, count = 3): { times: Date[]; error?: string } {
  try {
    const times: Date[] = []
    let after = new Date()
    for (let i = 0; i < count; i++) {
      const next = nextRun(cron, tz, after)
      if (!next) break
      times.push(next)
      after = next
    }
    return { times }
  } catch (error) {
    return { times: [], error: (error as Error).message }
  }
}

/** A note's schedules, and a form for a new one (or one being changed). */
export function ScheduleDialog({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const { state } = useStore()
  // A reader sees when each runs, and changes none of them.
  const may = useMayChangeBinder()
  const note = state.notes.find((n) => n.id === noteId)
  const mine = (state.schedules ?? []).filter((s) => s.noteId === noteId)
  const [editing, setEditing] = useState<Schedule | 'new' | undefined>(mine.length || !may ? undefined : 'new')
  return (
    <Dialog title={`Schedule “${note ? note.title : 'note'}”`} onClose={onClose} wide>
      <div className="schedule-dialog">
        <p className="schedule-intro">Each time it runs, the hub puts this note on the board as a card, for the agent you pick: the note’s words as they are then are its instructions. A run still going when the next is due makes that one skip.</p>
        {mine.length > 0 && <ScheduleList schedules={mine} onEdit={(s) => setEditing(s)} showNote={false} />}
        {editing ? (
          <ScheduleForm key={editing === 'new' ? 'new' : editing.id} noteId={noteId} schedule={editing === 'new' ? undefined : editing} onDone={() => setEditing(undefined)} />
        ) : may && (
          <div><button type="button" className="button" onClick={() => setEditing('new')}><CalendarClock size={14} aria-hidden="true" /> Add a schedule</button></div>
        )}
      </div>
    </Dialog>
  )
}

function ScheduleForm({ noteId, schedule, onDone }: { noteId: string; schedule?: Schedule; onDone: () => void }) {
  const { state } = useStore()
  const agents = state.agents.filter((a) => !a.revoked)
  const binderId = state.notes.find((n) => n.id === noteId)?.binderId
  const folders = state.folders.filter((f) => f.binderId === binderId)
  const folderPath = (id: string) => {
    const names: string[] = []
    const seen = new Set<string>()
    for (let at = state.folders.find((f) => f.id === id); at && !seen.has(at.id); at = state.folders.find((f) => f.id === at!.parentId)) {
      seen.add(at.id)
      names.unshift(at.name)
    }
    return names.join(' / ')
  }
  const [preset, setPreset] = useState<Preset>(() => (schedule ? cronPreset(schedule.cron) : { kind: 'weekdays', time: '09:00' }))
  const [agentId, setAgentId] = useState(schedule?.agentId ?? '')
  const [tz, setTz] = useState(schedule?.tz ?? here)
  const [folderId, setFolderId] = useState(schedule?.folderId ?? '')
  const [staleHours, setStaleHours] = useState(schedule?.staleHours ?? defaultStaleHours)
  const [busy, setBusy] = useState(false)
  const cron = presetCron(preset)
  const { times, error } = upcoming(cron, tz)
  const timeOf = (p: Preset) => ('time' in p ? p.time : '09:00')
  const pick = (kind: Preset['kind']) => {
    const time = timeOf(preset)
    setPreset(kind === 'hourly' ? { kind, minute: 0 } : kind === 'weekly' ? { kind, day: 1, time } : kind === 'cron' ? { kind, cron } : { kind, time })
  }
  const save = async () => {
    setBusy(true)
    const done = await attempt(() => (schedule
      ? call('PATCH', `/api/schedules/${schedule.id}`, { agentId: agentId || null, cron, tz, folderId: folderId || null, staleHours })
      : call('POST', '/api/schedules', { noteId, agentId: agentId || undefined, cron, tz, folderId: folderId || undefined, staleHours })))
    setBusy(false)
    if (done !== undefined) {
      toast(schedule ? 'Schedule changed.' : 'Scheduled.')
      onDone()
    }
  }
  return (
    <div className="form schedule-form">
      <div className="form-row">
        <Field label="Runs">
          <select id="schedule-kind" value={preset.kind} onChange={(e) => pick(e.target.value as Preset['kind'])}>
            <option value="hourly">Every hour</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Every week</option>
            <option value="cron">Custom times</option>
          </select>
        </Field>
        {preset.kind === 'hourly' && (
          <Field label="At minute">
            <input id="schedule-minute" type="number" min={0} max={59} value={preset.minute} onChange={(e) => setPreset({ kind: 'hourly', minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
          </Field>
        )}
        {(preset.kind === 'daily' || preset.kind === 'weekdays') && (
          <Field label="At">
            <input id="schedule-time" type="time" value={preset.time} onChange={(e) => setPreset({ kind: preset.kind, time: e.target.value || '09:00' })} />
          </Field>
        )}
        {preset.kind === 'cron' && (
          <Field label="Cron" hint="Minute, hour, day of the month, month, day of the week: 0 */6 * * * is every six hours.">
            <input id="schedule-cron" className="mono" value={preset.cron} onChange={(e) => setPreset({ kind: 'cron', cron: e.target.value })} spellCheck={false} autoComplete="off" />
          </Field>
        )}
      </div>
      {preset.kind === 'weekly' && (
        <div className="form-row">
          <Field label="On">
            <select id="schedule-day" value={preset.day} onChange={(e) => setPreset({ ...preset, day: Number(e.target.value) })}>
              {weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
          <Field label="At">
            <input id="schedule-week-time" type="time" value={preset.time} onChange={(e) => setPreset({ ...preset, time: e.target.value || '09:00' })} />
          </Field>
        </div>
      )}
      <div className="form-row">
        <Field label="For">
          <select id="schedule-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Any agent (the first one free)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Time zone">
          <input id="schedule-tz" value={tz} onChange={(e) => setTz(e.target.value.trim())} spellCheck={false} autoComplete="off" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Write its findings to">
          <select id="schedule-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">Nowhere: the run’s card is enough</option>
            {folders.map((f) => <option key={f.id} value={f.id}>A new note in {folderPath(f.id)}</option>)}
          </select>
        </Field>
        <Field label="Start the next run anyway after (hours with no activity)">
          <input id="schedule-stale" type="number" min={1} max={720} value={staleHours} onChange={(e) => setStaleHours(Number(e.target.value))} />
        </Field>
      </div>
      <p className={`schedule-next${error ? ' bad' : ''}`}>{error ?? (times.length ? `Next: ${times.map((t) => when(t, tz)).join(' · ')}` : 'It never comes round.')}</p>
      <div className="schedule-actions">
        <button type="button" className="button primary" disabled={busy || !!error || !times.length} onClick={() => void save()}>{schedule ? 'Save' : 'Schedule it'}</button>
        <button type="button" className="text-button" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

/** When a schedule next runs, or why it won't: none while it's off, and none for a rule that never comes round. */
function nextOf(s: Schedule) {
  try {
    return s.enabled ? nextRun(s.cron, s.tz, new Date(Math.max(Date.now(), Date.parse(s.lastRun ?? s.createdAt)))) : undefined
  } catch {
    return undefined
  }
}

/**
 * Schedules as Settings lists them: a row each (its note, when and for whom, when it next runs), pressed to open its
 * note's schedules, with what can be done to it behind a ⋯ for whoever may change the Binder.
 */
export function ScheduleRows({ schedules }: { schedules: Schedule[] }) {
  const { state } = useStore()
  const may = useMayChangeBinder()
  const [open, setOpen] = useState<string>()
  return (
    <>
      <Rows label="Schedules">
        {schedules.map((s) => {
          const note = state.notes.find((n) => n.id === s.noteId)
          const next = nextOf(s)
          const name = note ? note.title : 'A deleted note'
          return (
            <Row key={s.id} icon={<CalendarClock size={16} />} title={name}
              meta={`${describeCron(s.cron)} · ${s.agentId ? nameFor(state, s.agentId) : 'any agent'} · ${s.failing ?? (s.enabled ? (next ? `next ${when(next, s.tz)}` : 'never comes round') : 'off')}`}
              status={s.failing ? <Status tone="bad">Failing</Status> : s.enabled ? undefined : <Status tone="off">Off</Status>}
              onPress={note ? () => setOpen(s.noteId) : undefined}
              trailing={may ? <MenuButton label={`More for ${name}`} items={[
                ...(note ? [{ label: 'Open the note', icon: <FileText size={14} />, onSelect: () => { window.location.hash = href({ screen: 'notes', id: s.noteId }) } }] : []),
                { label: 'Run now', icon: <Zap size={14} />, onSelect: () => void attempt(() => call('POST', `/api/schedules/${s.id}/run`)).then((card) => { if (card) toast('On the board.') }) },
                { label: s.enabled ? 'Turn off' : 'Turn on', icon: s.enabled ? <Pause size={14} /> : <Play size={14} />, onSelect: () => void attempt(() => call('PATCH', `/api/schedules/${s.id}`, { enabled: !s.enabled })) },
                { separator: true },
                { label: 'Delete', icon: <Trash2 size={14} />, danger: true, confirm: 'Delete it? Press again', onSelect: () => void attempt(() => call('DELETE', `/api/schedules/${s.id}`)) },
              ]} /> : undefined} />
          )
        })}
      </Rows>
      <AnimatePresence>{open && <ScheduleDialog key={open} noteId={open} onClose={() => setOpen(undefined)} />}</AnimatePresence>
    </>
  )
}

/** Schedules as rows: when, for whom, what came of the last run, and what can be done to each. */
export function ScheduleList({ schedules, onEdit, showNote = true }: { schedules: Schedule[]; onEdit?: (schedule: Schedule) => void; showNote?: boolean }) {
  const { state } = useStore()
  // Running, pausing, editing and deleting a schedule change the Binder: a reader reads when each one runs.
  const may = useMayChangeBinder()
  return (
    <ul className="schedule-list">
      {schedules.map((s) => {
        const note = state.notes.find((n) => n.id === s.noteId)
        const last = s.lastCardId ? state.cards.find((c) => c.id === s.lastCardId) : undefined
        const next = nextOf(s)
        return (
          <li key={s.id} className={s.enabled ? '' : 'off'}>
            <CalendarClock size={16} />
            <div className="schedule-text">
              {showNote && <a href={href({ screen: 'notes', id: s.noteId })}>{note ? note.title : 'A deleted note'}</a>}
              <b>{describeCron(s.cron)} <span className="faint">({s.tz})</span> · {s.agentId ? nameFor(state, s.agentId) : 'any agent'}</b>
              <span className="faint">
                {s.enabled ? (next ? `Next ${when(next, s.tz)}` : 'Never comes round') : 'Off'}
                {s.lastSkipped && !s.failing ? ` · ${s.lastSkipped}` : last ? <> · last run <a href={href({ screen: 'work', id: last.id })}>{ago(s.lastRun)}</a></> : ''}
                {s.folderId && ` · writes to ${state.folders.find((f) => f.id === s.folderId)?.name ?? 'a deleted folder'}`}
              </span>
              {s.failing && <span className="schedule-failing" role="status"><TriangleAlert size={13} /> {s.failing}</span>}
              {!!s.runs?.length && (
                <details className="schedule-runs">
                  <summary>Last {s.runs.length === 1 ? 'run' : `${s.runs.length} runs`}</summary>
                  <ol>
                    {s.runs.map((run, index) => {
                      const card = run.cardId ? state.cards.find((c) => c.id === run.cardId) : undefined
                      const wrote = (state.noteWork ?? []).find((w) => run.cardId && w.fromRun?.cardId === run.cardId)
                      return (
                        <li key={index} className={run.failed ? 'bad' : ''}>
                          <time>{ago(run.at)}</time>
                          <span>
                            {run.failed ?? run.skipped ?? (card ? <a href={href({ screen: 'work', id: card.id })}>{card.stage === 'live' ? 'Done' : stageWords[card.stage] ?? card.stage}</a> : 'Its card was deleted')}
                            {wrote && <> · <a href={href({ screen: 'notes', id: wrote.noteId })}>its note</a></>}
                            {run.by !== 'timer' && ` · run by @${run.by}`}
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                </details>
              )}
            </div>
            {may && <div className="schedule-buttons">
              <button type="button" className="icon-button" title="Run now" aria-label="Run now" onClick={() => void attempt(() => call('POST', `/api/schedules/${s.id}/run`)).then((card) => { if (card) toast('On the board.') })}><Zap size={15} /></button>
              <button type="button" className="icon-button" title={s.enabled ? 'Turn off' : 'Turn on'} aria-label={s.enabled ? 'Turn off' : 'Turn on'} onClick={() => void attempt(() => call('PATCH', `/api/schedules/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
              {onEdit && <button type="button" className="text-button" onClick={() => onEdit(s)}>Edit</button>}
              <ConfirmButton className="icon-button" question="Delete it? Press again" title="Delete" label="Delete the schedule" onConfirm={() => void attempt(() => call('DELETE', `/api/schedules/${s.id}`))}><Trash2 size={15} /></ConfirmButton>
            </div>}
          </li>
        )
      })}
    </ul>
  )
}
