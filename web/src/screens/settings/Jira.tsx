import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { call } from '../../data/api'
import { useHub } from '../../data/store'
import { attempt, toast } from '../../components/Toast'
import { useBinderAccess } from './access'
import { WhoCan } from './shared'

type JiraPoints = { S: number | string; M: number | string; L: number | string }
type JiraPointsKind = 'number' | 'option' | 'string'
const usualPoints = (kind: JiraPointsKind): JiraPoints => (kind === 'number' ? { S: 1, M: 3, L: 5 } : { S: 'S', M: 'M', L: 'L' })
const pointsKindLabel: Record<JiraPointsKind, string> = { number: 'number', option: 'dropdown', string: 'text' }

type JiraStatus = { on?: boolean; mayManage?: boolean; baseUrl?: string; email?: string; tokenSet?: boolean; hint?: string; noteIssueType?: string; inbound?: Record<string, string>; pointsField?: string; pointsKind?: JiraPointsKind; points?: JiraPoints; agentWrites?: boolean; sprintBoard?: number; project?: string; issueType?: string; statuses?: Record<string, string>; stages?: string[]; webhook?: { url: string } }

/** This binder's Jira: the connection, how a card's stage maps to an issue's status, and bringing in work already there. */
export function JiraPart() {
  const { managers } = useBinderAccess()
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
      <>
        <div className="settings-card">
          <p className="faint">{jira.on ? 'This binder’s cards are mirrored into Jira.' : 'This binder isn’t mirrored into Jira.'}</p>
        </div>
        <WhoCan may={false} managers={managers} />
      </>
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
