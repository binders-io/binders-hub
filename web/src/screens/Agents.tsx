import { useMemo, useState, type FormEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { Check, ChevronDown, ChevronRight, Copy, KeyRound, Play, Plus, RotateCw, SquareTerminal, Trash2 } from 'lucide-react'
import type { Agent, Provider } from '../data/model'
import { isListening, isOnline, useStore, runnerPlaces, runnersOf } from '../data/store'
import { agentRepos, asksOf, usualRules, defaultRunner, runnerShown, toolForProvider, type RunnerSettings } from '../../../shared/work.ts'
import { accessLines, accessNames, atLeast, restartSince, toolInfo, tools, type Access, type AgentTool } from '../../../shared/agents.ts'
import { call } from '../data/api'
import { ToolIcon } from '../components/ToolIcon'
import { AgentAvatar, ago, usePhone } from '../components/bits'
import { Dialog, Field } from '../components/Dialog'
import { attempt } from '../components/Toast'
import { ConfirmButton } from '../components/ConfirmButton'
import { href } from '../route'
import { useUI } from '../ui'
import { workerPrompt } from '../data/prompts'
import { RunnerSteps } from '../components/RunnerSteps'
import { RepoInput } from '../components/RepoInput'
import { runnerState } from '../components/runnerState'
import { ScheduleList } from '../components/Schedules'
import { SettingsLink } from '../components/SettingsLink'

/** What an agent shows as, from the tool its runner starts. */
const providerFor = (tool: AgentTool): Provider => (tool === 'codex' ? 'openai' : tool === 'custom' ? 'other' : tool)
const shortAccess: Record<Access, string> = { full: 'Full access', auto: 'Auto', edits: 'Edits only' }

/** Whether an agent's settings are anything but what a new one starts with, so its "More" opens when editing it. */
const setBeyondDefaults = (agent: Agent) => {
  const run = runnerShown(agent)
  return agent.repos.length > 0 || agent.skills.length > 0 || agent.binders.length > 0 || !!run.workspace || !!run.model
    || run.access !== toolInfo(run.tool).access[0] || run.timeoutMinutes !== defaultRunner.timeoutMinutes || (run.parallel ?? 3) !== 3
    || !!run.held || !!run.live || !!run.cli || run.commitAs === 'app' || (run.allow ?? []).length > 0
}

const list = (text: string) => text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)

/** The agents set up to take work: who's online and what they hold, and setting up another. */
export function Agents() {
  const store = useStore()
  const { state } = store
  const { connectClaudeCode } = useUI()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Agent>()
  const [token, setToken] = useState<{ agent: Agent; token: string }>()
  const [starting, setStarting] = useState<Agent>()
  // Online first, then the ones set up most recently, so yours come before older ones.
  const agents = state.agents.filter((a) => !a.revoked).sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="agents-screen">
      <header className="screen-head">
        <div>
          <h2>Agents</h2>
          <p>Agents take cards from the board, say what they’re doing, and hand them back with a pull request.</p>
        </div>
        <div className="head-actions">
          {connectClaudeCode && <button className="button" onClick={connectClaudeCode}><SquareTerminal size={14} /> Add to Claude Code</button>}
          <button className="button primary" onClick={() => setAdding(true)}><Plus size={14} /> Set up an agent</button>
        </div>
      </header>

      <div className="agent-grid">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onEdit={() => setEditing(agent)}
            onToken={() => void attempt(async () => setToken({ agent, token: await store.newToken(agent.id) }))}
            onRevoke={() => void attempt(() => store.revokeAgent(agent.id))}
            onStart={() => setStarting(agent)}
          />
        ))}
        {!agents.length && (
          <div className="empty-screen">
            <h2>No agents yet</h2>
            <p>Set one up, connect it with the token it shows, and it starts taking cards from the board.</p>
          </div>
        )}
      </div>

      {(state.schedules ?? []).length > 0 && (
        <section className="schedules-section">
          <h3>Scheduled runs</h3>
          <p className="faint">Notes put on the board as cards on a timer. Set them from a note’s Schedule button.</p>
          <ScheduleList schedules={state.schedules ?? []} />
        </section>
      )}

      <AnimatePresence>
        {(adding || editing) && <AgentDialog key="agent" agent={editing} onClose={() => { setAdding(false); setEditing(undefined) }} onMade={(made) => { setAdding(false); setToken(made) }} />}
        {token && <TokenDialog key="token" agent={token.agent} token={token.token} onClose={() => setToken(undefined)} />}
        {starting && (
          <Dialog key="start" title={`Start ${starting.name}`} onClose={() => setStarting(undefined)} wide>
            <RunnerSteps agent={starting} />
          </Dialog>
        )}
      </AnimatePresence>
    </div>
  )
}

/** One agent: what it's doing first, then where it works and what it can do, as chips that fold up when there are many. */
function AgentCard({ agent, onEdit, onToken, onRevoke, onStart }: { agent: Agent; onEdit: () => void; onToken: () => void; onRevoke: () => void; onStart: () => void }) {
  const { state } = useStore()
  // On a phone what it's doing comes first, and the rest when asked for.
  const phone = usePhone()
  const [factsOpen, setFactsOpen] = useState(false)
  const holding = state.cards.filter((c) => c.agentId === agent.id && c.stage === 'working')
  // A card it asked about waits in Blocked, still its: it counts here, or an agent whose question waits reads as idle.
  const paused = state.cards.filter((c) => c.agentId === agent.id && c.stage === 'blocked')
  const holds = [...holding, ...paused]
  const asks = holds.filter((c) => asksOf(c))
  const done = state.cards.filter((c) => c.agentId === agent.id && (c.stage === 'review' || c.stage === 'live')).length
  const online = isOnline(agent)
  const listening = isListening(agent)
  // Only its owner can start it, see its token or answer its permissions, so whose it is shows when it isn't yours.
  const login = state.me?.user.login
  const theirs = !!login && login.toLowerCase() !== agent.owner.toLowerCase()
  const provider = toolInfo(agent.runner?.tool ?? toolForProvider(agent.provider)).name
  const runner = agent.runner
  // Repos grouped by owner, so an organization's name shows once.
  const owners = new Map<string, string[]>()
  for (const repo of agent.repos) {
    const [owner, name] = repo.includes('/') ? repo.split('/') : ['', repo]
    owners.set(owner, [...(owners.get(owner) ?? []), name])
  }
  const binders = agent.binders.map((b) => state.binders.find((x) => x.id === b)?.name).filter((n): n is string => !!n)
  // Its runner restarts when asked from here (0.8.1 on): what it runs goes back on the board, and it starts again on the
  // newest runner. Asked, until it's back or a few minutes go by.
  const restartable = online && atLeast(agent.runnerSeen?.version, restartSince)
  const asked = agent.restartAsked
  const restarting = !!asked && Date.now() - Date.parse(asked.at) < 3 * 60_000 && (!agent.runnerSeen || agent.runnerSeen.at < asked.at)
  // What it's working on goes back on the board, so a restart with cards in hand asks first.
  const restart = () => void attempt(() => call('POST', `/api/agents/${agent.id}/restart`))
  const restartQuestion = `Restart and stop ${holding.length === 1 ? 'a card' : `${holding.length} cards`}? Press again`
  const restartTitle = restarting ? 'Restarting its runner…'
    : restartable ? 'Restart its runner on the newest version: what it’s running goes back on the board'
      : online ? `Its runner (${agent.runnerSeen?.version ?? 'an old one'}) can’t be restarted from here: it updates itself when it’s idle`
        : 'Its runner isn’t connected'

  return (
    <article className="agent-card">
      <header>
        <AgentAvatar agent={agent} size={44} live={holding.length > 0} />
        <div className="agent-name">
          <h3>{agent.name}</h3>
          <span className="agent-meta">
            <span className={`status-dot${online ? ' online' : ''}${listening ? ' listening' : ''}`} />
            {asks.length ? `${asks.length === 1 ? 'A question' : `${asks.length} questions`} for you` : listening ? 'Listening for work' : holding.length && online ? 'Working' : online ? 'Online' : agent.lastSeen ? `Seen ${ago(agent.lastSeen)} ago` : 'Not running'}
            {provider && <span className="faint"> · {provider}</span>}
            <span className="faint agent-access"> · {shortAccess[(runner ?? defaultRunner).access]}</span>
            {theirs && <span className="faint agent-owner"> · @{agent.owner}’s</span>}
          </span>
        </div>
      </header>
      {agent.runnerSeen?.enterpriseMcp && (runner?.tool ?? 'claude') === 'claude' && <p className="agent-note" role="status">Enterprise MCP config on this machine: working without Binders’ MCP tools, its runner reporting for it.</p>}
      {agent.runnerSeen?.bypassOff && (runner?.tool ?? 'claude') === 'claude' && runner?.access === 'full' && <p className="agent-note" role="status">This machine’s Claude Code policy turns full access off: it edits files without asking, and the commands it runs follow the policy’s rules.</p>}
      {runnersOf(agent) > 1 && <p className="agent-warning" role="status">{runnersOf(agent)} runners are running as {agent.name}{runnerPlaces(agent).length ? `, on ${runnerPlaces(agent).join(' and ')}` : ''}. They take the same work, each in its own folder: stop all but one.</p>}

      <div className={`agent-doing${holding.length ? ' busy' : ''}${asks.length ? ' asks' : ''}`}>
        {holds.length ? holds.map((c) => (
          <a key={c.id} href={href({ screen: 'work', id: c.id })}>
            <b>{asksOf(c) ? 'Asks you' : c.stage === 'blocked' ? 'Blocked on' : 'Working on'}</b>
            <span>{asksOf(c) ?? c.doing ?? c.title}</span>
          </a>
        )) : <span className="faint">Waiting for work{done ? ` · ${done} finished` : ''}</span>}
      </div>

      {phone && <button type="button" className="section-toggle agent-facts-toggle" aria-expanded={factsOpen} onClick={() => setFactsOpen(!factsOpen)}><ChevronDown size={14} style={{ transform: factsOpen ? 'none' : 'rotate(-90deg)' }} /> Repos, skills and runner</button>}
      {(!phone || factsOpen) && <dl className="agent-facts">
        <dt>Repos</dt>
        <dd>{agent.repos.length ? [...owners.entries()].map(([owner, names]) => <ChipGroup key={owner} label={owner} items={names} mono />) : <span className="faint">Any repo</span>}</dd>
        {state.binders.length > 1 && <>
          <dt>Parts</dt>
          <dd>{binders.length ? <ChipGroup items={binders} /> : <span className="faint">All of it</span>}</dd>
        </>}
        <dt>Skills</dt>
        <dd>{agent.skills.length ? <ChipGroup items={agent.skills} /> : <span className="faint">Not said yet</span>}</dd>
        {agent.runsOn && <><dt>Runs on</dt><dd className="runs-on mono" title={agent.runsOn}>{agent.runsOn}</dd></>}
        <dt>Runner</dt>
        <dd className="runner-facts">{[toolInfo((runner ?? defaultRunner).tool).name, shortAccess[(runner ?? defaultRunner).access], `${(runner ?? defaultRunner).parallel ?? 3} at once`, `${(runner ?? defaultRunner).timeoutMinutes} min`].map((part) => <span key={part}>{part}</span>)}</dd>
        {runner?.model && <><dt>Model</dt><dd className="runs-on mono" title={runner.model}>{runner.model}</dd></>}
      </dl>}

      {(!listening || runnerState(agent).old) && (
        <div className="agent-start">
          <p className={online && runnerState(agent).old ? 'runner-old' : 'faint'}>{online && runnerState(agent).old ? runnerState(agent).text : 'Its runner isn’t running.'}</p>
          {restartable
            ? <ConfirmButton className="button primary" question={restartQuestion} ask={holding.length > 0} onConfirm={restart} disabled={restarting}><RotateCw size={13} /> {restarting ? 'Restarting…' : 'Update it now'}</ConfirmButton>
            : <button className="button primary" onClick={onStart}><Play size={13} /> {listening ? 'Restart the runner' : 'Start the runner'}</button>}
        </div>
      )}
      <footer>
        {state.me?.user.login.toLowerCase() === agent.owner.toLowerCase() && (runner?.tool ?? 'claude') !== 'custom' && !toolInfo(runner?.tool ?? 'claude').noTerminal && (
          <a className="button" href={href({ screen: 'terminal', id: agent.id })} title={`${toolInfo(runner?.tool ?? 'claude').name} in a terminal on its machine, as you’d use it there`}><SquareTerminal size={14} /> Terminal</a>
        )}
        <button className="button" onClick={onEdit}>Edit</button>
        <span className="agent-card-rare">
          <ConfirmButton className="button only-icon" question={restartQuestion} ask={holding.length > 0} onConfirm={restart} disabled={!restartable || restarting} title={restartTitle} label={`Restart ${agent.name}’s runner`}><RotateCw size={14} className={restarting ? 'spin' : undefined} /></ConfirmButton>
          <ConfirmButton className="button only-icon" question="Cut off its runner? Press again" onConfirm={onToken} title="New token: the old one stops working, and the runner using it is cut off" label={`New token for ${agent.name}`}><KeyRound size={14} /></ConfirmButton>
          <ConfirmButton className="button only-icon danger" question="Revoke it? Press again" onConfirm={onRevoke} title="Revoke: its token stops working at once, and what it holds goes back on the board" label={`Revoke ${agent.name}`}><Trash2 size={14} /></ConfirmButton>
        </span>
      </footer>
    </article>
  )
}

/** Chips that show the first few and fold the rest behind "+N more". */
function ChipGroup({ label, items, mono = false }: { label?: string; items: string[]; mono?: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open ? items : items.slice(0, 6)
  return (
    <div className="chip-group">
      {label && <span className="chip-owner mono">{label}/</span>}
      {shown.map((item) => <span key={item} className={`tag${mono ? ' mono' : ''}`}>{item}</span>)}
      {items.length > 6 && <button className="tag more" onClick={() => setOpen(!open)}>{open ? 'Fewer' : `+${items.length - 6} more`}</button>}
    </div>
  )
}

function AgentDialog({ agent, onClose, onMade }: { agent?: Agent; onClose: () => void; onMade: (made: { agent: Agent; token: string }) => void }) {
  const store = useStore()
  const { state } = store
  // Its name's start is the tool's, with a number when that's taken here; what's typed over it is kept.
  const [typed, setTyped] = useState(agent?.name)
  const [repos, setRepos] = useState<string[]>(agent?.repos ?? [])
  const [skills, setSkills] = useState(agent?.skills.join(', ') ?? '')
  const runsOn = agent?.runsOn ?? ''
  const [binders, setBinders] = useState<string[]>(agent?.binders ?? [])
  // What its binders limit it to, when they name their repos: it picks among those.
  const scope = useMemo(() => agentRepos({ repos: [], binders }, state.binders), [binders, state.binders])
  const [runner, setRunner] = useState<RunnerSettings>(runnerShown(agent))
  const setRun = (fields: Partial<RunnerSettings>) => setRunner((r) => ({ ...r, ...fields }))
  // Who its commits are by: the hub's admins' choice when they fixed one for every agent, else this agent's.
  const commitsFixed = state.me?.agentCommits && state.me.agentCommits !== 'agent' ? state.me.agentCommits : undefined
  const commitsBy = commitsFixed ?? runner.commitAs ?? 'owner'
  const tool = toolInfo(runner.tool)
  const taken = new Set(state.agents.filter((a) => !a.revoked && a.id !== agent?.id).map((a) => a.name.toLowerCase()))
  let suggested = tool.name
  for (let n = 2; taken.has(suggested.toLowerCase()); n++) suggested = `${tool.name} ${n}`
  const name = typed ?? suggested
  const [more, setMore] = useState(() => !!agent && setBeyondDefaults(agent))
  // Picking a tool keeps an access it allows, and drops a model meant for another tool.
  const pickTool = (id: AgentTool) => {
    const next = toolInfo(id)
    setRunner((r) => ({ ...r, tool: id, access: next.access.includes(r.access) ? r.access : next.access[0], model: id === r.tool ? r.model : undefined }))
  }
  // The models its runner found on its machine, once it has connected with this tool.
  // Found by this agent's runner, or by any runner on a machine with the tool installed, or its fixed names.
  const models = [...new Set([
    ...(agent?.models?.length && agent.runner?.tool === runner.tool ? agent.models : []),
    ...(agent?.toolModels?.[runner.tool] ?? []),
    ...state.agents.flatMap((a) => a.toolModels?.[runner.tool] ?? []),
    ...(tool.models ?? []),
  ])]

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const fields = { name, provider: providerFor(runner.tool), repos, skills: list(skills), binders, runsOn: runsOn || undefined, runner }
    if (agent) {
      const saved = await attempt(async () => {
        await store.updateAgent(agent.id, fields)
        return true
      })
      if (saved) onClose()
      return
    }
    const made = await attempt(() => store.createAgent(fields))
    if (made) onMade(made)
  }

  return (
    <Dialog title={agent ? `Edit ${agent.name}` : 'Set up an agent'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <fieldset className="field">
          <span className="field-label">Agent</span>
          <div className="tool-grid" role="radiogroup" aria-label="Agent">
            {tools.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={runner.tool === t.id} className={`tool-choice${runner.tool === t.id ? ' on' : ''}`} onClick={() => pickTool(t.id)} title={t.tried ? undefined : 'Its command line follows its maker’s documentation; it wasn’t tried here'}>
                <ToolIcon tool={t.id} size={22} />
                <span><b>{t.name}</b><em>{t.by}</em></span>
                {!t.tried && <i className="untried">not tried</i>}
              </button>
            ))}
          </div>
          {!tool.mcp && runner.tool !== 'custom' && <span className="field-hint">{tool.name} doesn’t get Binders’ tools for a run, so the runner hands it each card and note, and reports back what it prints.</span>}
        </fieldset>
        <Field label="Name"><input id="agent-name" autoFocus required value={name} onChange={(e) => setTyped(e.target.value)} placeholder={tool.name} /></Field>
        {runner.tool === 'custom' && (
          <Field label="Command" hint="{prompt}, {dir} and {mcp} (the MCP settings file) are filled in. BINDERS_CARD and BINDERS_TOKEN are set.">
            <input id="runner-command" className="mono" value={runner.command ?? ''} onChange={(e) => setRun({ command: e.target.value })} placeholder="my-agent --prompt {prompt} --cwd {dir}" />
          </Field>
        )}
        {/* Everything but the tool and its name has a good start, so it's folded away: open for an agent whose settings differ. */}
        <details className="agent-more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary><ChevronRight size={13} aria-hidden /> More</summary>
          <div className="agent-more-fields">
            <Field label="Repos it works in" hint={scope.length ? <>Among its binder’s {scope.length} repo{scope.length === 1 ? '' : 's'} (<SettingsLink section="github" />), by name, topic or custom property. None: all of them.</> : 'Search by name, topic or custom property, as many as it works in. None: any repo.'} group htmlFor="agent-repos">
              <RepoInput id="agent-repos" value={repos} within={scope} binders={binders} onChange={setRepos} />
            </Field>
            <Field label="What it can do" hint="Comma separated. The agent can add to this itself.">
              <input id="agent-skills" value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="TypeScript, React, Distill" />
            </Field>
            <Field label="Where the code is" hint="On the machine the runner runs on: a repo, or a folder of repos. Empty: the folder you start the runner in.">
              <input id="agent-workspace" className="mono" value={runner.workspace ?? ''} onChange={(e) => setRun({ workspace: e.target.value || undefined })} placeholder="~/code/my-repo" />
            </Field>
            {state.binders.length > 1 && <fieldset className="field">
              <span className="field-label">Parts it takes work from</span>
              <div className="checks">
                {state.binders.map((b) => (
                  <label key={b.id} className="check">
                    <input type="checkbox" id={`agent-binder-${b.id}`} checked={binders.includes(b.id)} onChange={(e) => setBinders(e.target.checked ? [...binders, b.id] : binders.filter((x) => x !== b.id))} />
                    {b.name}
                  </label>
                ))}
              </div>
              <span className="field-hint">None ticked: all of it.</span>
            </fieldset>}
            <fieldset className="field runner-fields">
              <span className="field-label">How the Binders runner starts it</span>
              <span className="field-hint">The runner keeps it listening, and starts it for each card on the machine where the code is.</span>
              <Field label="Access" hint={accessLines[runner.access]}>
                <select id="runner-access" value={runner.access} onChange={(e) => setRun({ access: e.target.value as Access })} disabled={tool.access.length < 2}>
                  {tool.access.map((a) => <option key={a} value={a}>{accessNames[a]}</option>)}
                </select>
              </Field>
              <div className="form-row">
                <Field label="Model" hint={runner.tool === 'dsh' ? 'As provider/name, from its settings on that machine: azure/my-deployment, my-gateway/my-model. Empty is DeepSeek Harness’s own default.' : runner.tool === 'codex' ? 'Pick one, or type a provider’s deployment as provider/name (foundry/my-deployment). A name alone goes to your ChatGPT or OpenAI sign-in.' : models.length ? undefined : `Start a runner on a machine with ${tool.name} installed, and the models it finds are suggested here.`}>
                  {/* Any name, with the models the runner found as suggestions: a provider's own (foundry/…) may not be listed. */}
                  <input id="runner-model" list="runner-models" value={runner.model ?? ''} onChange={(e) => setRun({ model: e.target.value.trim() || undefined })} placeholder={`${tool.name}’s default`} autoComplete="off" />
                  <datalist id="runner-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
                </Field>
                <Field label="Time limit, minutes"><input id="runner-timeout" type="number" min={1} max={1440} value={runner.timeoutMinutes} onChange={(e) => setRun({ timeoutMinutes: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Cards at once" group hint="Each in a worktree and branch of its own, never in your own checkout. Several agents can also work the same board.">
                <div className="segmented" role="radiogroup" id="runner-parallel">
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={(runner.parallel ?? 3) === n} className={(runner.parallel ?? 3) === n ? 'on' : ''} onClick={() => setRun({ parallel: n })}>{n}</button>
                  ))}
                </div>
              </Field>
              <Field label="Commits and pull requests by" group hint={commitsFixed ? `Set by the hub’s admins: ${commitsFixed === 'owner' ? 'each agent’s owner, with their GitHub sign-in' : 'the hub’s GitHub App and its bot'}.` : commitsBy === 'owner' ? 'You: it pushes with your GitHub sign-in to the hub, and commits carry your name and private GitHub email.' : 'The hub’s GitHub App: commits and pull requests show as its bot.'}>
                <div className="segmented" role="radiogroup" id="runner-commit-as" aria-disabled={commitsFixed ? true : undefined}>
                  {([['owner', 'You'], ['app', 'The Binders app']] as const).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={commitsBy === value} className={commitsBy === value ? 'on' : ''} disabled={!!commitsFixed} onClick={() => setRun({ commitAs: value })}>{label}</button>
                  ))}
                </div>
              </Field>
              {(runner.tool ?? 'claude') === 'claude' && (
                <Field label="Commands it may run" group hint="Claude Code permission rules, one a line, for what it may do without asking where a machine’s policy turns full access off (a work laptop, say): Bash(git:*), WebFetch(domain:github.com). The policy’s own rules still win.">
                  <textarea id="runner-allow" className="mono" rows={Math.min(8, Math.max(3, (runner.allow ?? []).length + 1))} value={(runner.allow ?? []).join('\n')} placeholder={'Bash(git:*)\nBash(npm test:*)'} onChange={(e) => setRun({ allow: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })} />
                  <button type="button" className="button" onClick={() => setRun({ allow: [...new Set([...(runner.allow ?? []), ...usualRules])] })}>Add the usual for coding</button>
                </Field>
              )}
            </fieldset>
            <fieldset className="field runner-fields">
              <span className="field-label">Experiments</span>
              <span className="field-hint">Not settled yet: they may change.</span>
              <Field label="Keep cards running through restarts" group hint="Its cards carry on while its runner stops or updates, and a restarted machine picks them up in the same conversation. Needs python3 on the machine.">
                <div className="segmented" role="radiogroup" id="runner-held">
                  {([[false, 'Off'], [true, 'On']] as const).map(([value, label]) => (
                    <button key={label} type="button" role="radio" aria-checked={!!runner.held === value} className={!!runner.held === value ? 'on' : ''} onClick={() => setRun({ held: value || undefined })}>{label}</button>
                  ))}
                </div>
              </Field>
              {runner.held && (runner.tool ?? 'claude') === 'claude' && (
                <Field label="Runs as" group hint="As a live terminal, you can open a card’s run, watch it, type to it and take over, in Claude Code’s own interface. Try it on a test card first: a first-run prompt would wait for you there.">
                  <div className="segmented" role="radiogroup" id="runner-live">
                    {([[false, 'A background process'], [true, 'A live terminal']] as const).map(([value, label]) => (
                      <button key={label} type="button" role="radio" aria-checked={!!runner.live === value} className={!!runner.live === value ? 'on' : ''} onClick={() => setRun({ live: value || undefined })}>{label}</button>
                    ))}
                  </div>
                </Field>
              )}
              <Field label="Talks to Binders through" group hint="The binders command needs no config and leaves no token in the agent’s environment, and the agent hears what people write on its card without being stopped.">
                <div className="segmented" role="radiogroup" id="runner-cli">
                  {([[false, 'MCP'], [true, 'The binders command']] as const).map(([value, label]) => (
                    <button key={label} type="button" role="radio" aria-checked={!!runner.cli === value} className={!!runner.cli === value ? 'on' : ''} onClick={() => setRun({ cli: value || undefined })}>{label}</button>
                  ))}
                </div>
              </Field>
            </fieldset>
          </div>
        </details>
        <footer className="form-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={!name.trim()}>{agent ? 'Save' : 'Set up'}</button>
        </footer>
      </form>
    </Dialog>
  )
}

function TokenDialog({ agent, token, onClose }: { agent: Agent; token: string; onClose: () => void }) {
  const { state } = useStore()
  const url = state.me?.mcpUrl ?? `${window.location.origin}/mcp`
  const [copied, setCopied] = useState<string>()
  const [byHand, setByHand] = useState(false)
  const snippets = [
    { id: 'claude', title: 'Claude Code', text: `claude mcp add --transport http binders_hub ${url} \\\n  --header "Authorization: Bearer ${token}"` },
    { id: 'codex', title: 'Codex (~/.codex/config.toml)', text: `[mcp_servers.binders_hub]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }` },
    { id: 'desktop', title: 'Claude Desktop and other apps (through mcp-remote)', text: JSON.stringify({ mcpServers: { binders_hub: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`] } } }, null, 2) },
    { id: 'start', title: 'Then tell it to keep taking cards', text: workerPrompt },
  ]
  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(id)
    window.setTimeout(() => setCopied(undefined), 1600)
  }
  return (
    <Dialog title={`Start ${agent.name}`} onClose={onClose} wide closeOnlyFromButton>
      <div className="token">
        <p>Its token, shown once: anyone with it can act as {agent.name}, so keep it where the agent runs. New token replaces it, and Revoke stops it at once.</p>
        <div className="token-value mono">
          <span>{token}</span>
          <button className="icon-button" onClick={() => void copy('token', token)} aria-label="Copy the token">{copied === 'token' ? <Check size={15} /> : <Copy size={15} />}</button>
        </div>
        <RunnerSteps agent={agent} token={token} />
        <button type="button" className="section-toggle by-hand" onClick={() => setByHand(!byHand)} aria-expanded={byHand}>
          <ChevronDown size={14} style={{ transform: byHand ? 'none' : 'rotate(-90deg)' }} /> Or connect a tool by hand, without the runner (it only takes work while you ask it to)
        </button>
        {byHand && snippets.map((s) => (
          <section key={s.id} className="snippet">
            <header>
              <h3>{s.title}</h3>
              <button className="text-button" onClick={() => void copy(s.id, s.text)}>{copied === s.id ? 'Copied' : 'Copy'}</button>
            </header>
            <pre className={`mono${s.id === 'start' ? ' wrap' : ''}`}>{s.text}</pre>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
