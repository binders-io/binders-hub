import { useEffect, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { call } from '../data/api'
import type { HubOptions } from '../data/model'
import { useStore } from '../data/store'
import { attempt } from './Toast'
import { PeopleInput } from './PeopleInput'


type Locked = Partial<Record<keyof HubOptions, string>>

/**
 * The hub's options: `access` is who gets in and who's admin, and `github`, tucked away and only an admin's to see, how
 * change sets merge and who agents commit as.
 */
export function HubOptionsPanel({ part }: { part: 'access' | 'github' }) {
  const { state } = useStore()
  const [options, setOptions] = useState<HubOptions>()
  const [locked, setLocked] = useState<Locked>({})
  const [implied, setImplied] = useState<{ admins: string[]; allowedUsers: string[]; allowedOrgs: string[] }>({ admins: [], allowedUsers: [], allowedOrgs: [] })
  const [saved, setSaved] = useState<keyof HubOptions>()
  const admin = !!state.me?.hubAdmin

  useEffect(() => {
    void call<{ options: HubOptions; locked: Locked; implied: typeof implied}>('GET', '/api/options').then((r) => {
      setOptions(r.options)
      setLocked(r.locked)
      setImplied(r.implied)
    }).catch(() => {})
  }, [])

  if (!options || (part === 'github' && !admin)) return null

  const save = async (fields: Partial<HubOptions>) => {
    const result = await attempt(() => call<{ options: HubOptions; locked: Locked; implied: typeof implied}>('PATCH', '/api/options', fields))
    if (!result) return
    setOptions(result.options)
    setImplied(result.implied)
    setSaved(Object.keys(fields)[0] as keyof HubOptions)
    window.setTimeout(() => setSaved(undefined), 1500)
  }
  const off = (key: keyof HubOptions) => !admin || !!locked[key]
  const note = (key: keyof HubOptions) => (locked[key] ? <span className="option-lock">Set on the hub by {locked[key]}</span> : saved === key ? <span className="option-saved"><Check size={12} strokeWidth={3} /> Saved</span> : null)

  if (part === 'github') {
    return (
      <details className="settings-more">
        <summary>Merging, and who agents commit as</summary>
        <div className="options">
      <Option title="Merging change sets" detail="Merge commits keep each pull request’s history, so the ones after it clash less, and GitHub can bring the base in without help more often. Squash and rebase make a tidier history and more conflicts." aside={note('mergeMethod')}>
        <Segmented id="merge-method" value={options.mergeMethod} disabled={off('mergeMethod')} onChange={(mergeMethod) => void save({ mergeMethod })} choices={[['merge', 'Merge commits'], ['squash', 'Squash'], ['rebase', 'Rebase']]} />
      </Option>

      <Option title="Agents’ commits and pull requests" detail="Who agents push and open pull requests as. Each agent’s owner chooses on the Agents page, or set one for every agent here: their owner’s GitHub sign-in, or the hub’s GitHub App and its bot." aside={note('agentCommits')}>
        <Segmented id="agent-commits" value={options.agentCommits} disabled={off('agentCommits')} onChange={(agentCommits) => void save({ agentCommits })} choices={[['agent', 'Each agent chooses'], ['owner', 'Always its owner'], ['app', 'Always the GitHub App']]} />
      </Option>
        </div>
      </details>
    )
  }

  return (
    <div className="options">
      {!admin && <p className="setup-note">Only the hub’s admins can change these.</p>}
      <Option title="Who may sign in" detail="Names come from GitHub as you type: your organizations’ members first. With nobody here and no GitHub App, anyone who signs in is let in." aside={note('allowedUsers')}>
        <div className="field">
          <span className="field-label">People</span>
          <PeopleInput id="allowed-users" kind="user" value={options.allowedUsers} implied={implied.allowedUsers} impliedWhy="through the GitHub App" disabled={off('allowedUsers')} onChange={(allowedUsers) => void save({ allowedUsers })} />
        </div>
        <div className="field">
          <span className="field-label">Organizations, all their members {note('allowedOrgs')}</span>
          <PeopleInput id="allowed-orgs" kind="org" value={options.allowedOrgs} implied={implied.allowedOrgs} impliedWhy="owns the GitHub App" disabled={off('allowedOrgs')} onChange={(allowedOrgs) => void save({ allowedOrgs })} />
        </div>
      </Option>

      <Option title="Admins" detail="Who may change these options and how the hub reaches GitHub. Whoever made the GitHub App is one. Naming more hands this over too: from then on only admins can." aside={note('admins')}>
        <div className="field">
          <span className="field-label">People</span>
          <PeopleInput id="admins" kind="user" value={options.admins} implied={implied.admins} impliedWhy="made the GitHub App" disabled={off('admins')} onChange={(admins) => void save({ admins })} />
        </div>
      </Option>
    </div>
  )
}

export function Option({ title, detail, aside, children }: { title: string; detail: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="option">
      <header>
        <h3>{title}</h3>
        {aside}
      </header>
      <p>{detail}</p>
      <div className="option-controls">{children}</div>
    </section>
  )
}

export function Segmented<T extends string>({ id, value, choices, disabled, onChange }: { id: string; value: T; choices: [T, string][]; disabled: boolean; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" id={id}>
      {choices.map(([choice, label]) => (
        <button key={choice} role="radio" aria-checked={value === choice} className={value === choice ? 'on' : ''} disabled={disabled} onClick={() => value !== choice && onChange(choice)}>{label}</button>
      ))}
    </div>
  )
}

