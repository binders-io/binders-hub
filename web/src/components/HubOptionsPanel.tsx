import { useEffect, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { call } from '../data/api'
import type { HubOptions } from '../data/model'
import { useStore } from '../data/store'
import { ago } from './bits'
import { attempt } from './Toast'
import { PeopleInput } from './PeopleInput'


type Locked = Partial<Record<keyof HubOptions, string>>

/**
 * The hub's options: `access` is who gets in and who's admin. What most hubs never change is tucked away and only an
 * admin's to see: `github`, how change sets merge and who agents commit as, and `advanced`, how the hub follows GitHub, when
 * notes are committed, and signing in by name.
 */
export function HubOptionsPanel({ part }: { part: 'access' | 'github' | 'advanced' }) {
  const { state } = useStore()
  const [options, setOptions] = useState<HubOptions>()
  const [locked, setLocked] = useState<Locked>({})
  const [implied, setImplied] = useState<{ admins: string[]; allowedUsers: string[]; allowedOrgs: string[] }>({ admins: [], allowedUsers: [], allowedOrgs: [] })
  const [saved, setSaved] = useState<keyof HubOptions>()
  const admin = !!state.me?.hubAdmin
  const polling = state.me?.github.polling

  useEffect(() => {
    void call<{ options: HubOptions; locked: Locked; implied: typeof implied}>('GET', '/api/options').then((r) => {
      setOptions(r.options)
      setLocked(r.locked)
      setImplied(r.implied)
    }).catch(() => {})
  }, [])

  if (!options || (part !== 'access' && !admin)) return null

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
      {part === 'access' && <>
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
      </>}

      {part === 'advanced' && <>
      <Option title="Following GitHub" detail="When GitHub can’t send this hub webhooks (it’s on a Mac, or behind a firewall), the hub asks GitHub for the same news instead." aside={note('pollMode')}>
        <Segmented id="poll-mode" value={options.pollMode} disabled={off('pollMode')} onChange={(pollMode) => void save({ pollMode })} choices={[['auto', 'While no webhook arrives'], ['on', 'Always'], ['off', 'Webhooks only']]} />
        <label className="inline-number">
          Ask every
          <input id="poll-seconds" type="number" min={10} max={3600} defaultValue={options.pollSeconds} disabled={off('pollSeconds') || options.pollMode === 'off'} onBlur={(e) => Number(e.target.value) !== options.pollSeconds && void save({ pollSeconds: Number(e.target.value) })} />
          seconds {note('pollSeconds')}
        </label>
        {polling && (
          <p className="option-status">
            {!state.me?.github.server ? 'Nothing to ask yet: GitHub isn’t connected.' : polling.webhookHeard ? 'Webhooks are arriving, so the hub isn’t asking.' : polling.active ? `Asking now${polling.lastPoll ? `, last ${ago(polling.lastPoll)} ago` : ''}.` : 'Not asking.'}
            {polling.lastError && <span className="option-error"> Last error: {polling.lastError}</span>}
          </p>
        )}
      </Option>

      <Option title="Committing notes" detail="Every note is saved to the hub as you type. Its commit to the notes repo waits for a pause, so typing makes one commit, not dozens.">
        <label className="inline-number">
          Commit after a pause of
          <input id="notes-quiet" type="number" min={5} max={3600} defaultValue={options.notesQuietSeconds} disabled={off('notesQuietSeconds')} onBlur={(e) => Number(e.target.value) !== options.notesQuietSeconds && void save({ notesQuietSeconds: Number(e.target.value) })} />
          seconds {note('notesQuietSeconds')}
        </label>
        <label className="inline-number">
          and at least every
          <input id="notes-longest" type="number" min={1} max={120} defaultValue={options.notesLongestMinutes} disabled={off('notesLongestMinutes')} onBlur={(e) => Number(e.target.value) !== options.notesLongestMinutes && void save({ notesLongestMinutes: Number(e.target.value) })} />
          minutes while typing goes on {note('notesLongestMinutes')}
        </label>
      </Option>

      <Option title="Signing in by name" detail="For trying the hub out: no GitHub needed. Auto allows it on a hub run on this machine until GitHub is set up." aside={note('devLogin')}>
        <Segmented id="dev-login" value={options.devLogin} disabled={off('devLogin')} onChange={(devLogin) => void save({ devLogin })} choices={[['auto', 'Auto'], ['on', 'Allowed'], ['off', 'Off']]} />
      </Option>
      </>}
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

