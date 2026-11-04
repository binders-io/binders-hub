import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { call } from '../data/api'
import { BookOpen, Check, Copy, Plug, Plus, RefreshCw, Server, ShieldCheck, Trash2, Bot, Users, X, } from 'lucide-react'
import { useStore } from '../data/store'
import { ago } from '../components/bits'
import type { Binder } from '../../../shared/notes.ts'
import { attempt } from '../components/Toast'
import { GitHubSetup } from '../components/GitHubSetup'
import { HubOptionsPanel } from '../components/HubOptionsPanel'
import { RepoInput } from '../components/RepoInput'
import { RepoBriefs } from '../components/RepoBriefs'
import { Github } from '../components/Github'
import { SpacePanel } from '../components/SpacePanel'
import { PersonalGitHub } from '../components/PersonalGitHub'
import { isPersonal } from '../components/PersonalRepo'

type Part = 'binder' | 'github' | 'briefs' | 'access' | 'sync' | 'agents' | 'jira' | 'hub'

const parts: { id: Part; label: string; icon: (props: { size?: number }) => ReactNode; detail: string }[] = [
  { id: 'binder', label: 'Binder', icon: Users, detail: 'This binder: its name, who’s in it, and its GitHub repo. Its cards are kept there as issues and its notes on a branch, and agents’ pull requests there come back to its cards.' },
  { id: 'github', label: 'GitHub', icon: Github, detail: 'This binder’s own GitHub App, the repos it’s installed on, and anything GitHub still needs from you. No other binder uses it or sees its repos.' },
  { id: 'briefs', label: 'Repo briefs', icon: BookOpen, detail: 'What agents are told about each repo before they work or review there: its map, the rules its code keeps, how to build and test it, where it breaks. Each is a note in Repo docs, saved to the repo with your other notes; agents also get any other notes you put in a repo’s folder there. An agent writes it the first time one works in the repo, and again as the repo moves on.' },
  { id: 'access', label: 'Access', icon: ShieldCheck, detail: 'Who may sign in, and who may change how the hub works.' },
  { id: 'sync', label: 'Syncing', icon: RefreshCw, detail: 'How the hub follows GitHub, and when your notes are committed.' },
  { id: 'agents', label: 'Agents', icon: Bot, detail: 'Where agents connect. Each agent’s own settings are on the Agents page.' },
  { id: 'jira', label: 'Jira', icon: Plug, detail: 'Mirrors this binder’s cards into one Jira Cloud project: a card becomes an issue, its stage the issue’s status, and what people do there comes back: a status they change moves the card, a comment lands on it. The hub keeps the words; Jira’s copy is written, never read back.' },
  { id: 'hub', label: 'This hub', icon: Server, detail: 'Where the hub keeps things, and how this browser is connected to it.' },
]

const remembered = (): Part => {
  try {
    const stored = window.localStorage.getItem('binders-settings-part')
    const part = (stored === 'binders' ? 'binder' : stored) as Part | null
    return part && parts.some((p) => p.id === part) ? part : 'binder'
  } catch {
    return 'binder'
  }
}

/**
 * A binder's Settings, a section at a time: this binder (its members and repo), GitHub, access, syncing, agents and the
 * hub. What's yours rather than the binder's (who you're signed in as, your GitHub, your apps) is on your account page.
 */
export function Settings() {
  const { state } = useStore()
  const [part, setPart] = useState<Part>(remembered)
  const choose = (next: Part) => {
    setPart(next)
    try { window.localStorage.setItem('binders-settings-part', next) } catch { /* only a convenience */ }
  }
  const current = parts.find((p) => p.id === part)!
  const github = state.me?.github
  const warn: Partial<Record<Part, boolean>> = {
    github: !github?.signIn || !github?.server,
    binder: state.binders.some((b) => !b.repo),
    hub: state.me?.log !== 'redis',
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings">
        {parts.map((p) => (
          <button key={p.id} type="button" className={p.id === part ? 'on' : ''} aria-current={p.id === part ? 'page' : undefined} onClick={() => choose(p.id)}>
            <p.icon size={15} /> {p.label}
            {warn[p.id] && <i className="settings-warn" title="Needs a look" />}
          </button>
        ))}
      </nav>
      <div className="settings-pane" key={part}>
        <header>
          <h2>{current.label}</h2>
          <p>{current.detail}</p>
        </header>
        {part === 'binder' && <><SpacePanel /><Binders /></>}
        {part === 'github' && (isPersonal ? <PersonalGitHub /> : <GitHubPart />)}
        {part === 'briefs' && <RepoBriefs />}
        {part === 'access' && <HubOptionsPanel part="access" />}
        {part === 'sync' && <HubOptionsPanel part="sync" />}
        {part === 'agents' && <AgentsPart />}
        {part === 'jira' && <JiraPart />}
        {part === 'hub' && <HubPart />}
      </div>
    </div>
  )
}

function Binders() {
  const store = useStore()
  const { state } = store
  const [name, setName] = useState('')
  const [repo, setRepo] = useState<string[]>([])
  const [issues, setIssues] = useState<Record<string, IssueStatus>>()
  const refresh = () => void call<{ binders: Record<string, IssueStatus> }>('GET', '/api/issues').then((r) => setIssues(r.binders)).catch(() => {})
  // Follows the board, so counts move as cards become issues.
  useEffect(refresh, [state.sync.version, state.binders])
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    store.addBinder(name, repo[0] ?? '')
    setName('')
    setRepo([])
  }
  // A binder is one notebook; one made before that may still hold several, each shown with its own name.
  const several = state.binders.length > 1
  return (
    <>
      <ul className="binder-cards">
        {state.binders.map((binder) => {
          const notes = state.notes.filter((n) => n.binderId === binder.id).length
          const cards = state.cards.filter((c) => c.binderId === binder.id).length
          return (
            <li key={binder.id} className="settings-card">
              <div className="binder-card-head">
                {several ? <input id={`binder-name-${binder.id}`} className="binder-name" aria-label="Name" defaultValue={binder.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== binder.name && store.updateBinder(binder.id, { name: e.target.value })} /> : <b>Its notes and board</b>}
                <span className="faint num">{notes} note{notes === 1 ? '' : 's'} · {cards} card{cards === 1 ? '' : 's'}</span>
                {several && <button className="icon-button" disabled={notes + cards > 0} title={notes + cards > 0 ? 'Only an empty part can be deleted' : 'Delete this part'} aria-label="Delete" onClick={() => void attempt(() => store.deleteBinder(binder.id))}><Trash2 size={14} /></button>}
              </div>
              <label className="field-label" htmlFor={`binder-repo-${binder.id}`}>GitHub repo</label>
              <RepoInput id={`binder-repo-${binder.id}`} single value={binder.repo ? [binder.repo] : []} placeholder="Pick the repo its cards go to…" onChange={(repos) => store.updateBinder(binder.id, { repo: repos[0] ?? '' })} />
              {binder.repo && <NotesRow binder={binder} status={issues?.[binder.id]?.notes} onChange={(fields) => store.updateBinder(binder.id, fields)} />}
              {binder.repo && <IssuesRow binderId={binder.id} repo={binder.repo} on={binder.issues !== false} status={issues?.[binder.id]} onChange={(on) => store.updateBinder(binder.id, { issues: on })} onSync={() => void attempt(() => call('POST', `/api/binders/${binder.id}/sync-issues`)).then(refresh)} />}
              <ReviewCommentsRow binderId={binder.id} on={binder.reviewComments === true} onChange={(on) => store.updateBinder(binder.id, { reviewComments: on })} />
            </li>
          )
        })}
      </ul>
      {!state.binders.length && (
        <form className="settings-card binder-add" onSubmit={add}>
          <h3>Its notes and board</h3>
          <input id="new-binder-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Its name" />
          <RepoInput id="new-binder-repo" single value={repo} placeholder="Its GitHub repo (optional)" onChange={setRepo} />
          <button className="button primary" disabled={!name.trim()}><Plus size={14} /> Start it</button>
        </form>
      )}
    </>
  )
}

interface IssueStatus { on: boolean; kept: number; waiting: number; problem?: string; notes?: { to?: string; branch?: string; at?: string; error?: string } }

/** A binder's notes, pushed to its repo on a branch of their own. */
function NotesRow({ binder, status, onChange }: { binder: Binder; status?: IssueStatus['notes']; onChange: (fields: { notes?: boolean; notesBranch?: string }) => void }) {
  const on = binder.notes !== false
  const branch = binder.notesBranch || 'binders-notes'
  return (
    <div className="issues-row">
      <label className="switch" htmlFor={`binder-notes-${binder.id}`}>
        <input id={`binder-notes-${binder.id}`} type="checkbox" checked={on} onChange={(e) => onChange({ notes: e.target.checked })} />
        <span aria-hidden="true" />
        Push its notes to {binder.repo}, on the branch
        <input id={`binder-branch-${binder.id}`} className="branch-input mono" defaultValue={branch} disabled={!on} onClick={(e) => e.preventDefault()} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== branch && onChange({ notesBranch: e.target.value.trim() })} aria-label="Branch" />
      </label>
      {on && (
        <p className={`issues-status${status?.error && status.error !== 'No notes to push yet.' ? ' problem' : ''}`}>
          {status?.error ?? (status?.at ? `Pushed ${ago(status.at)} ago.` : 'Pushed with the next commit.')}
          {' '}<a href={`https://github.com/${binder.repo}/tree/${branch}`} target="_blank" rel="noreferrer">Notes <ArrowUpRight size={11} /></a>
        </p>
      )}
    </div>
  )
}

function IssuesRow({ binderId, repo, on, status, onChange, onSync }: { binderId: string; repo: string; on: boolean; status?: IssueStatus; onChange: (on: boolean) => void; onSync: () => void }) {
  return (
    <div className="issues-row">
      <label className="switch" htmlFor={`binder-issues-${binderId}`}>
        <input id={`binder-issues-${binderId}`} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden="true" />
        Keep its cards as issues in {repo}
      </label>
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
function ReviewCommentsRow({ binderId, on, onChange }: { binderId: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="issues-row">
      <label className="switch" htmlFor={`binder-reviews-${binderId}`}>
        <input id={`binder-reviews-${binderId}`} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden="true" />
        Post a Challenge’s findings as review comments on its pull request
      </label>
    </div>
  )
}

function GitHubPart() {
  const me = useStore().state.me
  return (
    <>
      <GitHubSetup />
      {me?.github.server && <ul className="status-list">
        <Status ok={!!me.github.polling?.webhookHeard || !!me.github.polling?.active} label="GitHub’s news" detail={!me?.github.server ? 'Once the app is installed.' : me.github.polling?.webhookHeard ? 'Webhooks arrive as things happen on GitHub.' : me.github.polling?.active ? `Asked for every ${me.github.polling.everySeconds} seconds, as webhooks don’t reach this hub. See Syncing.` : 'Neither webhooks nor asking: see Syncing.'} />
      </ul>}
    </>
  )
}

function AgentsPart() {
  const me = useStore().state.me
  if (!me) return null
  const runner = `${window.location.origin}/runner/binders-runner.mjs`
  // The binder's own address, for a person's terminal: OAuth signs them in as themselves, and an agent's token being
  // replaced doesn't touch it.
  const mine = me.space ? new URL(`/${me.space}/mcp`, window.location.origin).toString() : me.mcpUrl
  return (
    <div className="copy-rows">
      <CopyRow label="MCP for you, in this binder" value={mine} hint={`Add it in Claude Code with: claude mcp add --transport http binders ${mine}. It opens a browser to sign in with GitHub: no token to copy, and an agent’s token being replaced doesn’t touch it.`} />
      <CopyRow label="MCP address for agents" value={me.mcpUrl} hint="With an agent’s token, from its Agents page." />
      <CopyRow label="The runner" value={runner} hint="Keeps an agent taking cards. Start the runner on an agent’s card shows the whole command." />
    </div>
  )
}

type JiraStatus = { on?: boolean; mayManage?: boolean; baseUrl?: string; email?: string; tokenSet?: boolean; hint?: string; project?: string; issueType?: string; statuses?: Record<string, string>; stages?: string[]; webhook?: { url: string } }

function JiraPart() {
  const [jira, setJira] = useState<JiraStatus>()
  const [baseUrl, setBaseUrl] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [project, setProject] = useState('')
  const [issueType, setIssueType] = useState('Task')
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [tested, setTested] = useState<{ ok: boolean; who?: string; error?: string }>()
  const load = () => void call<JiraStatus>('GET', '/api/jira').then((next) => {
    if (!next) return
    setJira(next)
    setBaseUrl(next.baseUrl ?? '')
    setEmail(next.email ?? '')
    setProject(next.project ?? '')
    setIssueType(next.issueType ?? 'Task')
    setStatuses(next.statuses ?? {})
  })
  useEffect(load, [])
  if (!jira) return null

  const save = () => void attempt(() => call('PUT', '/api/jira', {
    baseUrl, email, ...(token.trim() ? { token } : {}), project, issueType, statuses,
  })).then((next) => {
    if (!next) return
    setToken('')
    setTested(undefined)
    void call<JiraStatus>('GET', '/api/jira').then(setJira)
  })
  const test = () => void attempt(() => call<{ ok: boolean; who?: string; error?: string }>('POST', '/api/jira/test', {})).then((r) => r && setTested(r))
  const disconnect = () => void attempt(() => call('DELETE', '/api/jira')).then((done) => {
    if (!done) return
    setToken('')
    setTested(undefined)
    load()
  })
  const stages = jira.stages ?? []

  if (!jira.mayManage) {
    return (
      <div className="settings-card">
        <p className="faint">{jira.on ? 'This binder’s cards are mirrored into Jira.' : 'This binder isn’t mirrored into Jira.'} Its owners and admins set this up.</p>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <form className="form" onSubmit={(e) => { e.preventDefault(); save() }}>
        <p className="faint">
          Cards still going are mirrored into one Jira Cloud project once you save; ones already done stay out. The hub
          keeps the words: a card’s brief and done-when are the issue’s description, its stage the status named below, and
          what comes back is a status someone changes, and comments. Only an agent starts work, so moving an issue to In
          Progress in Jira doesn’t move its card.
        </p>
        <label className="field">
          <span className="field-label">Jira address</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://yourcompany.atlassian.net" inputMode="url" />
        </label>
        <div className="form-row">
          <label className="field"><span className="field-label">Service account</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="its email" autoComplete="off" />
          </label>
          <label className="field"><span className="field-label">API token {jira.tokenSet ? `(set, ${jira.hint})` : ''}</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={jira.tokenSet ? 'Leave it to keep what’s set, at the same address' : 'The token'} autoComplete="new-password" />
          </label>
        </div>
        <div className="form-row">
          <label className="field"><span className="field-label">Project key</span>
            <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="BIND" className="mono" />
          </label>
          <label className="field"><span className="field-label">Issue type</span>
            <input value={issueType} onChange={(e) => setIssueType(e.target.value)} placeholder="Task" />
          </label>
        </div>
        <fieldset className="field">
          <legend className="field-label">What each stage is in this project’s workflow</legend>
          <div className="form-row" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
            {stages.map((stage) => (
              <label key={stage} className="field">
                <span className="field-label">{stage}</span>
                <input value={statuses[stage] ?? ''} onChange={(e) => setStatuses((was) => ({ ...was, [stage]: e.target.value }))} placeholder={({ ready: 'To Do', working: 'In Progress', blocked: 'Blocked', review: 'In Review', live: 'Done' } as Record<string, string>)[stage]} />
              </label>
            ))}
          </div>
        </fieldset>
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <button className="button primary" disabled={!baseUrl.trim() || !email.trim() || (!token.trim() && !jira.tokenSet) || !project.trim()}>Save</button>
          <button type="button" className="button" disabled={!jira.on} onClick={test}>Try it</button>
          {jira.baseUrl && <button type="button" className="button" onClick={disconnect}>Disconnect</button>}
          {tested && <span className={tested.ok ? 'ok faint' : 'faint'}>{tested.ok ? `Jira knows it: ${tested.who}` : tested.error}</span>}
        </div>
      </form>
      {jira.on && jira.webhook && (
        <div className="copy-row" style={{ marginTop: '.75rem' }}>
          <span className="field-label">Jira’s webhook, to this hub</span>
          <div className="token-value mono"><span>{jira.webhook.url}</span><CopyWebhook url={jira.webhook.url} /></div>
          <span className="field-hint">In Jira: Settings → System → WebHooks → Create. Use this address, with the events Issue updated, Issue deleted and Comment created, limited to this project. The address holds a secret: keep it like a password.</span>
        </div>
      )}
    </div>
  )
}

function CopyWebhook({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(url).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return <button className="icon-button" onClick={() => void copy()} aria-label="Copy the webhook address">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
}

function HubPart() {
  const { state } = useStore()
  const me = state.me
  return (
    <ul className="status-list">
      <Status ok={me?.log === 'redis'} label="Change log" detail={me?.log === 'redis' ? 'On Redis: everything is kept across restarts.' : 'In memory: set REDIS_URL, or everything is gone when the hub stops.'} />
      <Status ok={state.sync.connection === 'live'} label="Live connection" detail={state.sync.connection === 'live' ? `Up to date, at change ${state.sync.version}.` : 'Reconnecting. Your changes wait in this browser meanwhile.'} />
      {me && <Status ok label="Address" detail={me.publicUrl} />}
      <Status ok={!me?.updateFailed} label="Version" detail={me?.version
        ? <>Commit {me.version.repo ? <a className="mono" href={`${me.version.repo}/commit/${me.version.commit}`} target="_blank" rel="noreferrer">{me.version.commit.slice(0, 7)}</a> : <span className="mono">{me.version.commit.slice(0, 7)}</span>}{me.version.subject ? `: ${me.version.subject}` : ''}</>
        : 'Not built by the server’s updater, so it doesn’t know its commit.'} />
      {me?.updateFailed && (
        <Status ok={false} label="Didn’t update" detail={<>
          <span className="mono">{me.updateFailed.commit.slice(0, 7)}</span>{me.updateFailed.subject ? ` (${me.updateFailed.subject})` : ''} failed its tests{me.updateFailed.at ? ` on ${new Date(me.updateFailed.at).toLocaleString()}` : ''}, so the hub stayed on the version above. A newer commit that passes goes in by itself.
          {me.updateFailed.log && <details className="update-log"><summary>How the tests ended</summary><pre className="mono">{me.updateFailed.log}</pre></details>}
        </>} />
      )}
    </ul>
  )
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: ReactNode }) {
  return (
    <li className={ok ? 'ok' : ''}>
      <span className="status-icon">{ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}</span>
      <div>
        <b>{label}</b>
        <span>{detail}</span>
      </div>
    </li>
  )
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="copy-row">
      <span className="field-label">{label}</span>
      <div className="token-value mono">
        <span>{value}</span>
        <button className="icon-button" onClick={() => void copy()} aria-label={`Copy the ${label.toLowerCase()}`}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}
