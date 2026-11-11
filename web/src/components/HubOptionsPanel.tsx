import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { Building2, Check, GitCommitHorizontal, GitMerge, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { call } from '../data/api'
import type { HubOptions } from '../data/model'
import { useStore } from '../data/store'
import { attempt } from './Toast'
import { PeopleInput } from './PeopleInput'
import { Dialog, EmptyState, Row, Rows, Section, Skeleton } from '../kit'

type Locked = Partial<Record<keyof HubOptions, string>>
type Implied = { admins: string[]; allowedUsers: string[]; allowedOrgs: string[] }

/** Who's named, in a line: "@ana, @sam and 3 more". */
function named(people: string[], at = true) {
  const shown = people.map((p) => (at ? `@${p}` : p))
  if (shown.length <= 2) return shown.join(' and ')
  return `${shown.slice(0, 2).join(', ')} and ${shown.length - 2} more`
}

/** "Saved", or who set it on the hub itself, beside a setting: its place is always there, so a screen reader hears it. */
export function SettingNote({ locked, saved }: { locked?: string; saved: boolean }) {
  if (locked) return <span className="option-lock">Set on the hub by {locked}</span>
  return <span className="option-saved" role="status">{saved && <><Check size={12} strokeWidth={3} aria-hidden="true" /> Saved</>}</span>
}

/** On or off, for the end of a row: the row's title is its name. */
export function Switch({ label, on, disabled = false, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

/** One of a few ways a setting can be, with a line on what it means. */
export interface Choice<T extends string> {
  value: T
  name: string
  line?: string
}

/**
 * A setting's few ways, as rows to pick from in a dialog (a sheet on a phone): a radio, a name and one line each. Picking
 * one saves it at once, and the dialog says so.
 */
export function ChoiceDialog<T extends string>({ title, lead, choices, value, onPick, onClose, note }: { title: string; lead?: ReactNode; choices: Choice<T>[]; value: T; onPick: (value: T) => void; onClose: () => void; note?: ReactNode }) {
  return (
    <Dialog title={title} onClose={onClose} size="small" footer={<button type="button" className="button primary" onClick={onClose}>Done</button>}>
      <div className="choice-dialog">
        {lead && <p className="choice-dialog-lead">{lead}</p>}
        <div className="choice-rows" role="radiogroup" aria-label={title}>
          {choices.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={value === c.value} className={`model-agent-kind${value === c.value ? ' on' : ''}`} onClick={() => value !== c.value && onPick(c.value)}>
              <i className="model-agent-radio" aria-hidden="true" />
              <span>
                <b>{c.name}</b>
                {c.line && <em>{c.line}</em>}
              </span>
            </button>
          ))}
        </div>
        {note && <p className="choice-dialog-note">{note}</p>}
      </div>
    </Dialog>
  )
}

const mergeChoices: Choice<HubOptions['mergeMethod']>[] = [
  { value: 'merge', name: 'Merge commits', line: 'Keeps each pull request’s history, so the ones after it clash less, and GitHub can bring the base in without help more often.' },
  { value: 'squash', name: 'Squash', line: 'One commit for each pull request: a tidier history, and more conflicts.' },
  { value: 'rebase', name: 'Rebase', line: 'Its commits laid on top of the base: a straight history, and more conflicts.' },
]
const commitChoices: Choice<HubOptions['agentCommits']>[] = [
  { value: 'agent', name: 'Each agent chooses', line: 'Its owner picks, when setting it up on the Agents page.' },
  { value: 'owner', name: 'Always its owner', line: 'With the owner’s GitHub sign-in, as them.' },
  { value: 'app', name: 'Always the GitHub App', line: 'As the hub’s GitHub App and its bot.' },
]

/**
 * The hub's options, the same for every binder on it and an admin's to change: `access` is who gets in and who's admin,
 * and `agents` how change sets merge and who agents commit as. Each is a row saying how it stands; an admin presses it to
 * change it, in a dialog. Everyone else sees the rows as they are, with who can change them.
 */
export function HubOptionsPanel({ part }: { part: 'access' | 'agents' }) {
  const { state } = useStore()
  const [options, setOptions] = useState<HubOptions>()
  const [failed, setFailed] = useState(false)
  const [locked, setLocked] = useState<Locked>({})
  const [implied, setImplied] = useState<Implied>({ admins: [], allowedUsers: [], allowedOrgs: [] })
  const [saved, setSaved] = useState<keyof HubOptions>()
  const [open, setOpen] = useState<keyof HubOptions>()
  const admin = !!state.me?.hubAdmin

  const load = () => call<{ options?: HubOptions; locked: Locked; implied: Implied }>('GET', '/api/options').then((r) => {
    if (!r?.options) return setFailed(true)
    setOptions(r.options)
    setLocked(r.locked ?? {})
    setImplied(r.implied ?? { admins: [], allowedUsers: [], allowedOrgs: [] })
  }).catch(() => setFailed(true))
  useEffect(() => {
    void load()
  }, [])

  if (!options) {
    return failed
      ? <div className="settings-failed"><EmptyState compact icon={<TriangleAlert size={18} />} title="Couldn’t load these" line="The hub didn’t send its options." action={<button type="button" className="button" onClick={() => { setFailed(false); void load() }}>Try again</button>} /></div>
      : <div className="settings-wait" aria-busy="true"><p className="sr-only" role="status">Loading…</p><Skeleton lines={3} /></div>
  }

  const save = async (fields: Partial<HubOptions>) => {
    const result = await attempt(() => call<{ options: HubOptions; locked: Locked; implied: Implied }>('PATCH', '/api/options', fields))
    if (!result) return
    setOptions(result.options)
    setImplied(result.implied)
    setSaved(Object.keys(fields)[0] as keyof HubOptions)
    window.setTimeout(() => setSaved(undefined), 1500)
  }
  const off = (key: keyof HubOptions) => !admin || !!locked[key]
  const note = (key: keyof HubOptions) => <SettingNote locked={locked[key]} saved={saved === key} />
  // "Saved" is said in the dialog while it's open, and on the row once it's closed: never in both.
  const rowNote = (key: keyof HubOptions) => (open === key ? undefined : note(key))
  // A row an admin can press to change; for anyone else, or a setting the hub's environment fixes, it only says how it stands.
  const press = (key: keyof HubOptions) => (off(key) ? undefined : () => setOpen(key))
  const who = admin ? null : <p className="setup-note">Only the hub’s admins can change these.</p>

  if (part === 'agents') {
    const merge = mergeChoices.find((c) => c.value === options.mergeMethod)
    const commits = commitChoices.find((c) => c.value === options.agentCommits)
    return (
      <div className="hub-options">
        {who}
        <Rows label="Agents">
          <Row icon={<GitMerge size={16} />} title="Merging change sets" meta={merge?.name ?? options.mergeMethod} status={rowNote('mergeMethod')} onPress={press('mergeMethod')} trailing={off('mergeMethod') ? 'none' : undefined} label={off('mergeMethod') ? undefined : `Merging change sets: ${merge?.name}. Change it`} />
          <Row icon={<GitCommitHorizontal size={16} />} title="Agents’ commits and pull requests" meta={commits?.name ?? options.agentCommits} status={rowNote('agentCommits')} onPress={press('agentCommits')} trailing={off('agentCommits') ? 'none' : undefined} label={off('agentCommits') ? undefined : `Agents’ commits and pull requests: ${commits?.name}. Change it`} />
        </Rows>
        <AnimatePresence>
          {open === 'mergeMethod' && <ChoiceDialog key="merge" title="Merging change sets" lead="How the hub merges a change set’s pull requests." choices={mergeChoices} value={options.mergeMethod} onPick={(mergeMethod) => void save({ mergeMethod })} onClose={() => setOpen(undefined)} note={note('mergeMethod')} />}
          {open === 'agentCommits' && <ChoiceDialog key="commits" title="Agents’ commits and pull requests" lead="Who agents push and open pull requests as." choices={commitChoices} value={options.agentCommits} onPick={(agentCommits) => void save({ agentCommits })} onClose={() => setOpen(undefined)} note={note('agentCommits')} />}
        </AnimatePresence>
      </div>
    )
  }

  // Who's named here, then who's in through GitHub: named when they're few, counted when they're many.
  const people = (list: string[], also: string[], at: boolean) => {
    const through = also.length > 2 ? `${also.length} more through GitHub` : also.length ? `${named(also, at)} through GitHub` : ''
    return list.length ? `${named(list, at)}${through ? `, and ${through}` : ''}` : through || undefined
  }
  const anyone = !options.allowedUsers.length && !options.allowedOrgs.length && !implied.allowedUsers.length && !implied.allowedOrgs.length
  return (
    <div className="hub-options">
      {who}
      <Section title="Who may sign in" lead={anyone ? 'Nobody is named and there’s no GitHub App, so anyone who signs in is let in.' : 'The people named, and every member of the organizations.'}>
        <Rows label="Who may sign in">
          <Row icon={<Users size={16} />} title="People" meta={people(options.allowedUsers, implied.allowedUsers, true) ?? 'Nobody named'} status={rowNote('allowedUsers')} onPress={press('allowedUsers')} trailing={off('allowedUsers') ? 'none' : undefined} label={off('allowedUsers') ? undefined : 'People who may sign in. Change them'} />
          <Row icon={<Building2 size={16} />} title="Organizations" meta={people(options.allowedOrgs, implied.allowedOrgs, false) ?? 'None'} status={rowNote('allowedOrgs')} onPress={press('allowedOrgs')} trailing={off('allowedOrgs') ? 'none' : undefined} label={off('allowedOrgs') ? undefined : 'Organizations whose members may sign in. Change them'} />
        </Rows>
      </Section>
      <Section title="Admins" lead="They change these settings and how the hub reaches GitHub.">
        <Rows label="Admins">
          <Row icon={<ShieldCheck size={16} />} title="Admins" meta={people(options.admins, implied.admins, true) ?? 'Nobody named'} status={rowNote('admins')} onPress={press('admins')} trailing={off('admins') ? 'none' : undefined} label={off('admins') ? undefined : 'The hub’s admins. Change them'} />
        </Rows>
      </Section>
      <AnimatePresence>
        {open === 'allowedUsers' && (
          <PeopleDialog key="users" title="People who may sign in" label="People" lead="Names come from GitHub as you type: your organizations’ members first." onClose={() => setOpen(undefined)} note={note('allowedUsers')}>
            <PeopleInput id="allowed-users" kind="user" value={options.allowedUsers} implied={implied.allowedUsers} impliedWhy="through the GitHub App" disabled={off('allowedUsers')} onChange={(allowedUsers) => void save({ allowedUsers })} />
          </PeopleDialog>
        )}
        {open === 'allowedOrgs' && (
          <PeopleDialog key="orgs" title="Organizations" label="Organizations, all their members" lead="Every member of each may sign in." onClose={() => setOpen(undefined)} note={note('allowedOrgs')}>
            <PeopleInput id="allowed-orgs" kind="org" value={options.allowedOrgs} implied={implied.allowedOrgs} impliedWhy="owns the GitHub App" disabled={off('allowedOrgs')} onChange={(allowedOrgs) => void save({ allowedOrgs })} />
          </PeopleDialog>
        )}
        {open === 'admins' && (
          <PeopleDialog key="admins" title="Admins" label="People" lead="Whoever made the GitHub App is one. Naming more hands this over too: from then on only admins can change it." onClose={() => setOpen(undefined)} note={note('admins')}>
            <PeopleInput id="admins" kind="user" value={options.admins} implied={implied.admins} impliedWhy="made the GitHub App" disabled={off('admins')} onChange={(admins) => void save({ admins })} />
          </PeopleDialog>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A list of people or organizations to change, in a dialog: each change is saved as it's made. */
function PeopleDialog({ title, label, lead, note, onClose, children }: { title: string; label: string; lead: string; note: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog title={title} onClose={onClose} footer={<button type="button" className="button primary" onClick={onClose}>Done</button>}>
      <div className="choice-dialog">
        <p className="choice-dialog-lead">{lead}</p>
        <div className="field">
          <span className="field-label">{label} {note}</span>
          {children}
        </div>
      </div>
    </Dialog>
  )
}

/** A choice of a few, as buttons in a row: for a choice that sits in a form, where a dialog would be one too many. */
export function Segmented<T extends string>({ id, value, choices, disabled, onChange }: { id: string; value: T; choices: [T, string][]; disabled: boolean; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" id={id}>
      {choices.map(([choice, label]) => (
        <button key={choice} type="button" role="radio" aria-checked={value === choice} className={value === choice ? 'on' : ''} disabled={disabled} onClick={() => value !== choice && onChange(choice)}>{label}</button>
      ))}
    </div>
  )
}
