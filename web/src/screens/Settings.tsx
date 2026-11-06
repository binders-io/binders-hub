import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { call } from '../data/api'
import { BookOpen, Check, Copy, Plug, Plus, RefreshCw, Server, ShieldCheck, Trash2, Bot, Users, X, } from 'lucide-react'
import { useHub, useStore } from '../data/store'
import { ago } from '../components/bits'
import type { Binder } from '../../../shared/notes.ts'
import { attempt, toast } from '../components/Toast'
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
              <label className="field-label" htmlFor={`binder-repos-${binder.id}`}>Repos its agents work in</label>
              <RepoInput id={`binder-repos-${binder.id}`} value={binder.repos ?? []} placeholder="Add repos… (none: any repo)" onChange={(repos) => store.updateBinder(binder.id, { repos })} />
              <span className="field-hint">Each agent works in all of these, or the ones it’s limited to on the Agents page.</span>
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

type JiraPoints = { S: number | string; M: number | string; L: number | string }
type JiraPointsKind = 'number' | 'option' | 'string'
const usualPoints = (kind: JiraPointsKind): JiraPoints => (kind === 'number' ? { S: 1, M: 3, L: 5 } : { S: 'S', M: 'M', L: 'L' })
const pointsKindLabel: Record<JiraPointsKind, string> = { number: 'number', option: 'dropdown', string: 'text' }

type JiraStatus = { on?: boolean; mayManage?: boolean; baseUrl?: string; email?: string; tokenSet?: boolean; hint?: string; noteIssueType?: string; inbound?: Record<string, string>; pointsField?: string; pointsKind?: JiraPointsKind; points?: JiraPoints; agentWrites?: boolean; sprintBoard?: number; project?: string; issueType?: string; statuses?: Record<string, string>; stages?: string[]; webhook?: { url: string } }

function JiraPart() {
  const [jira, setJira] = useState<JiraStatus>()
  const [baseUrl, setBaseUrl] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [project, setProject] = useState('')
  const [issueType, setIssueType] = useState('Story')
  const [noteIssueType, setNoteIssueType] = useState('')
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [inbound, setInbound] = useState<Record<string, string>>({})
  const [pointsField, setPointsField] = useState('')
  const [pointsKind, setPointsKind] = useState<JiraPointsKind>('number')
  const [points, setPoints] = useState<JiraPoints>(usualPoints('number'))
  const [sprintBoard, setSprintBoard] = useState('')
  const [agentWrites, setAgentWrites] = useState(true)
  const [found, setFound] = useState<JiraFound>()
  const [filled, setFilled] = useState(false)

  /** A field for a card's size: what each size is in it starts over when the sort of field changes. */
  const pickPoints = (id: string, fields: JiraPointField[] | undefined) => {
    const kind = fields?.find((f) => f.id === id)?.kind ?? 'number'
    setPointsField(id)
    if (kind !== pointsKind) setPoints(usualPoints(kind))
    setPointsKind(kind)
  }
  /** Fills the mapping in with what Jira suggests for a card type. */
  const fillStages = (type: JiraFoundType | undefined, fields?: JiraPointField[]) => {
    setStatuses(type?.suggested.statuses ?? {})
    setInbound(type?.suggested.inbound ?? {})
    pickPoints(type?.suggested.pointsField ?? '', fields)
  }
  const fill = (next: NonNullable<JiraFound['project']>) => {
    const cards = next.suggested.issueType ?? next.types[0]?.name ?? ''
    setProject(next.key)
    setIssueType(cards)
    setNoteIssueType(next.suggested.noteIssueType ?? '')
    setSprintBoard(next.sprintBoard ? String(next.sprintBoard) : '')
    fillStages(next.types.find((t) => t.name === cards), next.pointFields)
    setFilled(true)
  }
  const read = (wanted: string, typedToken: string, shouldFill: boolean, address = baseUrl, account = email) => call<JiraFound>('POST', '/api/jira/discover', {
    baseUrl: address, email: account, ...(typedToken.trim() ? { token: typedToken } : {}), ...(wanted.trim() ? { project: wanted } : {}),
  }).then((next) => {
    if (!next) return
    setFound(next)
    if (next.project && shouldFill) fill(next.project)
  })

  const load = () => void call<JiraStatus>('GET', '/api/jira').then((next) => {
    if (!next) return
    setJira(next)
    setBaseUrl(next.baseUrl ?? '')
    setEmail(next.email ?? '')
    setProject(next.project ?? '')
    setIssueType(next.issueType ?? 'Story')
    setNoteIssueType(next.noteIssueType ?? '')
    setStatuses(next.statuses ?? {})
    setInbound(next.inbound ?? {})
    setPointsField(next.pointsField ?? '')
    setPointsKind(next.pointsKind ?? 'number')
    setPoints(next.points ?? usualPoints(next.pointsKind ?? 'number'))
    setSprintBoard(next.sprintBoard ? String(next.sprintBoard) : '')
    setAgentWrites(next.agentWrites !== false)
    // Connected before: what Jira has now, for the lists, leaving what's saved as it is.
    if (next.mayManage && next.baseUrl && next.tokenSet) void read(next.project ?? '', '', false, next.baseUrl, next.email ?? '').catch(() => undefined)
  })
  useEffect(load, [])
  if (!jira) return null

  const save = () => void attempt(() => call('PUT', '/api/jira', {
    baseUrl, email, ...(token.trim() ? { token } : {}), project, issueType, noteIssueType, statuses, inbound, pointsField, pointsKind, points, sprintBoard: sprintBoard ? Number(sprintBoard) : undefined, agentWrites,
  })).then((next) => {
    if (!next) return
    setToken('')
    void call<JiraStatus>('GET', '/api/jira').then(setJira)
  })
  const connect = () => void attempt(() => read(project, token, !jira.on))
  const pickProject = (key: string) => {
    setProject(key)
    if (key) void attempt(() => read(key, token, true))
  }
  const pickCards = (name: string) => {
    setIssueType(name)
    fillStages(types.find((t) => t.name === name), found?.project?.pointFields)
  }
  const disconnect = () => void attempt(() => call('DELETE', '/api/jira')).then((done) => {
    if (!done) return
    setToken('')
    setFound(undefined)
    setFilled(false)
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

  const types = found?.project?.types ?? []
  const noteTypes = types.filter((t) => t.level === 1)
  const cardTypes = types.filter((t) => t.level === 0)
  const workflow = types.find((t) => t.name === issueType)?.statuses ?? []
  const unmatched = stages.filter((stage) => !statuses[stage])
  const counted = Object.entries(inbound)
  const pointFields = found?.project?.pointFields ?? []
  const sprintBoards = found?.project?.sprintBoards ?? []
  const canConnect = !!baseUrl.trim() && !!email.trim() && (!!token.trim() || !!jira.tokenSet)

  return (
    <div className="settings-card">
      <form className="form" onSubmit={(e) => { e.preventDefault(); save() }}>
        <p className="faint">
          Connect a service account and the hub reads your project from Jira and fills in the rest. Cards still going are
          mirrored once you save; ones already done stay out. Stages, points and comments go to Jira; a status someone changes and comments come back, within a minute. Only
          an agent starts work, so moving an issue to In Progress in Jira doesn’t move its card.
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
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="button" disabled={!canConnect} onClick={connect}>{found ? 'Read it again' : 'Connect to Jira'}</button>
          {found && <span className="ok faint">Connected as {found.who}.</span>}
        </div>

        {(found || jira.project) && (
          <>
            <div className="form-row">
              <label className="field"><span className="field-label">Project</span>
                {found?.projects.length
                  ? <select id="jira-project" value={project} onChange={(e) => pickProject(e.target.value)}>
                      <option value="">Pick a project…</option>
                      {withSaved(found.projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })), project).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  : <input id="jira-project" value={project} onChange={(e) => setProject(e.target.value)} placeholder="BIND" className="mono" />}
              </label>
            </div>
            <div className="form-row">
              <label className="field"><span className="field-label">A note becomes</span>
                {types.length
                  ? <select id="jira-note-type" value={noteIssueType} onChange={(e) => setNoteIssueType(e.target.value)}>
                      <option value="">Nothing: its cards stand alone</option>
                      {withSaved(noteTypes.map((t) => ({ value: t.name, label: t.name })), noteIssueType).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  : <input id="jira-note-type" value={noteIssueType} onChange={(e) => setNoteIssueType(e.target.value)} placeholder="Epic" />}
              </label>
              <label className="field"><span className="field-label">A card becomes</span>
                {types.length
                  ? <select id="jira-card-type" value={issueType} onChange={(e) => pickCards(e.target.value)}>
                      {withSaved(cardTypes.map((t) => ({ value: t.name, label: t.name })), issueType).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  : <input id="jira-card-type" value={issueType} onChange={(e) => setIssueType(e.target.value)} placeholder="Story" />}
              </label>
            </div>
            {noteIssueType && <span className="field-hint">A note’s title and words go to Jira as its {noteIssueType} when its first card is accepted, and its cards go under it.</span>}
            <fieldset className="field">
              <legend className="field-label">What each stage is in this project’s workflow</legend>
              <div className="form-row" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
                {stages.map((stage) => (
                  <label key={stage} className="field">
                    <span className="field-label">{stage}</span>
                    {workflow.length
                      ? <select id={`jira-stage-${stage}`} value={statuses[stage] ?? ''} onChange={(e) => setStatuses((was) => ({ ...was, [stage]: e.target.value }))}>
                          <option value="">Leave the issue where it is</option>
                          {withSaved(workflow.map((s) => ({ value: s.name, label: s.name })), statuses[stage]).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      : <input id={`jira-stage-${stage}`} value={statuses[stage] ?? ''} onChange={(e) => setStatuses((was) => ({ ...was, [stage]: e.target.value }))} />}
                  </label>
                ))}
              </div>
              {filled && <span className="field-hint">Filled in from your Jira: check it reads right, then save.{unmatched.length ? ` Nothing in this workflow looks like ${unmatched.join(' or ')}.` : ''}</span>}
              {counted.length > 0 && <span className="field-hint">When someone moves an issue in Jira, these count too: {counted.map(([name, stage]) => `${name} as ${stage}`).join(', ')}.</span>}
            </fieldset>
            <fieldset className="field">
              <legend className="field-label">Points, from a card’s size</legend>
              <div className="form-row" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
                <label className="field"><span className="field-label">Field</span>
                  {/* A custom field needs Jira's list to be picked; without it, its id is typed. */}
                  {pointFields.length
                    ? <select id="jira-points-field" value={pointsField} onChange={(e) => pickPoints(e.target.value, pointFields)}>
                        <option value="">Don’t set points</option>
                        {withSaved(pointFields.map((f) => ({ value: f.id, label: `${f.name} (${pointsKindLabel[f.kind]}, ${f.id})` })), pointsField || undefined).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    : <input id="jira-points-field" className="mono" value={pointsField} onChange={(e) => setPointsField(e.target.value)} placeholder="customfield_10016" />}
                </label>
                {pointsField && (['S', 'M', 'L'] as const).map((size) => (
                  <label key={size} className="field"><span className="field-label">{size}</span>
                    <input id={`jira-points-${size}`} type={pointsKind === 'number' ? 'number' : 'text'} {...(pointsKind === 'number' ? { min: 0, step: 'any' } : {})} value={points[size]} onChange={(e) => setPoints((was) => ({ ...was, [size]: e.target.value }))} />
                  </label>
                ))}
              </div>
              {pointsField && pointsKind === 'option' && <span className="field-hint">Use the dropdown’s options exactly as Jira has them. If Jira won’t take one, the card says so.</span>}
            </fieldset>
            <label className="field"><span className="field-label">Sprints, from this board</span>
              <select id="jira-sprint-board" value={sprintBoard} onChange={(e) => setSprintBoard(e.target.value)}>
                <option value="">Leave sprints alone</option>
                {withSaved(sprintBoards.map((b) => ({ value: String(b.id), label: b.name })), sprintBoard || undefined).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {sprintBoard && <span className="field-hint">Once work on a card starts, its issue joins this board’s active sprint. Planning stays in Jira.</span>}
            </label>
            <label className="field">
              <span><input id="jira-agent-writes" type="checkbox" checked={agentWrites} onChange={(e) => setAgentWrites(e.target.checked)} /> Agents make their own changes in Jira</span>
              <span className="field-hint">An agent with its own Jira connection assigns the issue, moves it and adds its comments, so Jira shows the person it works for. Whatever it hasn’t done after two minutes, this service account does, and comments name who said them.</span>
            </label>
            <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="button primary" disabled={!canConnect || !project.trim()}>Save</button>
              {found?.project && <button type="button" className="button" onClick={() => fill(found.project!)}>Fill in from Jira again</button>}
              {jira.baseUrl && <button type="button" className="button" onClick={disconnect}>Disconnect</button>}
            </div>
          </>
        )}
      </form>
      {jira.on && <JiraImport />}
      {jira.on && jira.webhook && (
        <div className="copy-row" style={{ marginTop: '.75rem' }}>
          <span className="field-label">Jira’s webhook, to this hub (optional)</span>
          <div className="token-value mono"><span>{jira.webhook.url}</span><CopyWebhook url={jira.webhook.url} /></div>
          <span className="field-hint">The hub asks Jira every minute without one. For news as it happens, in Jira: Settings → System → WebHooks → Create. Use this address, with the events Issue updated, Issue deleted and Comment created, limited to this project. The address holds a secret: keep it like a password.</span>
        </div>
      )}
    </div>
  )
}

interface JiraFeature {
  key: string
  title: string
  status?: string
  stories: number
  stages: Record<string, number>
  leftOut: number
  here: number
  noted: boolean
}

const stageWords: Record<string, string> = { ready: 'not started', working: 'in progress', blocked: 'blocked', review: 'in review', live: 'done' }

/** A team's existing work: its features and their stories, onto the board where they stand. */
function JiraImport() {
  const [features, setFeatures] = useState<JiraFeature[]>()
  const [chosen, setChosen] = useState<string[]>([])
  const [mayTake, setMayTake] = useState(false)
  const [busy, setBusy] = useState(false)
  const binders = useHub((state) => state.binders)
  const [binderId, setBinderId] = useState('')
  const into = binderId || binders[0]?.id || ''
  const read = () => void attempt(() => call<{ features: JiraFeature[] }>('GET', '/api/jira/features')).then((found) => { if (found) setFeatures(found.features) })
  const bring = () => {
    setBusy(true)
    void attempt(() => call<{ features: number; stories: number; already: number; leftOut: string[] }>('POST', '/api/jira/import', { binderId: into, keys: chosen, agentsMayTake: mayTake })).then((done) => {
      setBusy(false)
      if (!done) return
      toast(`Brought in ${done.stories} ${done.stories === 1 ? 'story' : 'stories'}${done.already ? `. ${done.already} ${done.already === 1 ? 'was' : 'were'} already here` : ''}${done.leftOut.length ? `. Left out, as ended without being done: ${done.leftOut.join(', ')}` : ''}.`)
      setChosen([])
      read()
    })
  }
  return (
    <div className="jira-import">
      <span className="field-label">Bring in existing work</span>
      {!features && (
        <>
          <span className="field-hint">Bring a feature and its stories onto the board, each where it stands in Jira.</span>
          <div><button type="button" className="button" onClick={read}>See what’s in Jira</button></div>
        </>
      )}
      {features && !features.length && <span className="field-hint">No features in this project. It looks for the type you chose under “A note becomes”.</span>}
      {features && features.length > 0 && (
        <>
          <ul className="jira-features">
            {features.map((f) => (
              <li key={f.key}>
                <label>
                  <input id={`jira-feature-${f.key}`} type="checkbox" checked={chosen.includes(f.key)} onChange={(e) => setChosen((was) => (e.target.checked ? [...was, f.key] : was.filter((k) => k !== f.key)))} />
                  <span>
                    <b className="mono">{f.key}</b> {f.title}
                    <em className="faint">
                      {f.stories} {f.stories === 1 ? 'story' : 'stories'}{f.stories ? `: ${Object.entries(f.stages).map(([stage, count]) => `${count} ${stageWords[stage] ?? stage}`).join(', ')}` : ''}
                      {f.leftOut ? `, ${f.leftOut} left out` : ''}{f.here ? `, ${f.here} already here` : ''}
                    </em>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {binders.length > 1 && (
            <label className="field"><span className="field-label">Into</span>
              <select id="jira-import-binder" value={into} onChange={(e) => setBinderId(e.target.value)}>
                {binders.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <label className="jira-import-take">
            <input id="jira-import-take" type="checkbox" checked={mayTake} onChange={(e) => setMayTake(e.target.checked)} /> Let agents take what hasn’t started
          </label>
          <span className="field-hint">{mayTake ? 'Stories not started go to Ready, and any agent working in this binder can take them straight away.' : 'Stories not started go to Proposed, so no agent starts them until someone moves them to Ready.'} Their descriptions in Jira aren’t changed. Each issue gets a “binders” label, so the hub can follow it.</span>
          <div><button type="button" className="button primary" disabled={!chosen.length || busy} onClick={bring}>{busy ? 'Bringing them in…' : `Bring in ${chosen.length || ''} ${chosen.length === 1 ? 'feature' : 'features'}`}</button></div>
        </>
      )}
    </div>
  )
}

interface JiraPointField {
  id: string
  name: string
  kind: JiraPointsKind
}

interface JiraFoundType {
  name: string
  level: number
  statuses: { name: string; category?: string }[]
  suggested: { statuses: Record<string, string>; inbound: Record<string, string>; unmatched: string[]; pointsField?: string }
}

interface JiraFound {
  who?: string
  projects: { key: string; name: string }[]
  project?: { key: string; name: string; pointFields?: JiraPointField[]; sprintBoards?: { id: number; name: string }[]; sprintBoard?: number; types: JiraFoundType[]; suggested: { noteIssueType?: string; issueType?: string } }
}

/** A list from Jira, with what's saved kept on it even if Jira no longer has it, so opening the page never changes a setting. */
const withSaved = (options: { value: string; label: string }[], saved: string | undefined) =>
  saved && !options.some((o) => o.value === saved) ? [{ value: saved, label: saved }, ...options] : options

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
