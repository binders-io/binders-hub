import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { Bot, Check, ChevronRight, Cloud, Copy, FolderGit2, Inbox, KeyRound, Laptop, Play, Plus, RotateCw, Server, SlidersHorizontal, SquareTerminal, Trash2, TriangleAlert } from 'lucide-react'
import type { Agent, Provider } from '../data/model'
import { isListening, isOnline, useStore, runnerPlaces, runnersOf } from '../data/store'
import { agentRepos, asksOf, usualRules, defaultRunner, runnerShown, toolForProvider, type RunnerSettings } from '../../../shared/work.ts'
import { accessLines, accessNames, atLeast, restartSince, toolInfo, tools, type Access, type AgentTool } from '../../../shared/agents.ts'
import { call } from '../data/api'
import { ToolIcon } from '../components/ToolIcon'
import { AgentAvatar, ago } from '../components/bits'
import { attempt } from '../components/Toast'
import { ConfirmButton } from '../components/ConfirmButton'
import { href } from '../route'
import { workerPrompt } from '../data/prompts'
import { RunnerSteps } from '../components/RunnerSteps'
import { MachineLine } from '../components/AddMachine'
import { AddModelForm } from '../components/AddModel'
import { EditModel } from '../components/EditModel'
import { MachineModel } from '../components/MachineModel'
import { ClaudeCodeDialog, ClaudeCodeSteps } from '../components/ClaudeCode'
import { isModelAgent, machineModelWords, modelOnMachine, modelReady, modelWords, takesNames, usesOwnModel } from '../components/modelAgent'
import { RepoInput } from '../components/RepoInput'
import { runnerState } from '../components/runnerState'
import { ScheduleList } from '../components/Schedules'
import { SettingsLink } from '../components/SettingsLink'
import { Dialog, EmptyState, Field, Guided, MenuButton, More, PageHeader, Section, type GuidedOption, type GuidedStep, type MenuItem } from '../kit'
import { useMayChangeBinder, useMayManageBinder } from './settings/access'

/** What an agent shows as, from the tool its runner starts. */
const providerFor = (tool: AgentTool): Provider => (tool === 'codex' ? 'openai' : tool === 'custom' || tool === 'binders' ? 'other' : tool)
const shortAccess: Record<Access, string> = { full: 'Full access', auto: 'Auto', edits: 'Edits only' }

/** Whether an agent's settings are anything but what a new one starts with, so its "More" opens when editing it. */
const setBeyondDefaults = (agent: Agent) => {
  const run = runnerShown(agent)
  return agent.repos.length > 0 || agent.skills.length > 0 || agent.binders.length > 0 || !!run.workspace || !!run.model
    || run.access !== toolInfo(run.tool).access[0] || run.timeoutMinutes !== defaultRunner.timeoutMinutes || (run.parallel ?? 3) !== 3
    || !!run.modelUrl || !!run.held || !!run.live || !!run.cli || run.commitAs === 'app' || (run.allow ?? []).length > 0
}

const list = (text: string) => text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)

/** A list in words: "a, b and c". */
const inWords = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '')

/** The agents set up to take work: who's online and what they hold, and the one way in to adding another. */
export function Agents() {
  const store = useStore()
  const { state } = store
  // A reader sees the agents and what they're doing; setting one up, editing, tokens and revoking are for those who may change the Binder.
  const may = useMayChangeBinder()
  const [adding, setAdding] = useState(false)
  // A reader's one way in: the hub in their own Claude Code, which acts as them and takes no cards.
  const [claudeCode, setClaudeCode] = useState(false)
  const [editingModel, setEditingModel] = useState<string>()
  // The model of an agent on a machine, which has a runner as well.
  const [modelOf, setModelOf] = useState<string>()
  const [editing, setEditing] = useState<Agent>()
  const [token, setToken] = useState<{ agent: Agent; token: string }>()
  const [starting, setStarting] = useState<Agent>()
  const foundModel = state.agents.find((a) => a.id === editingModel && !a.revoked)
  const editingModelAgent = foundModel && isModelAgent(foundModel) ? foundModel : undefined
  const machineModelAgent = state.agents.find((a) => a.id === modelOf && !a.revoked && !isModelAgent(a))
  // Online first, then the ones set up most recently, so yours come before older ones.
  const up = (a: Agent) => (isModelAgent(a) ? modelReady(a) : isOnline(a))
  const agents = state.agents.filter((a) => !a.revoked).sort((a, b) => Number(up(b)) - Number(up(a)) || b.createdAt.localeCompare(a.createdAt))
  const addButton = (
    <button type="button" className="button primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add an agent</button>
  )
  // With none yet, the way in is in the empty state, said once; a reader has only Claude Code, quieter.
  const action = !may ? <button type="button" className="button" onClick={() => setClaudeCode(true)}><SquareTerminal size={16} aria-hidden="true" />Use from Claude Code</button>
    : agents.length ? addButton : undefined

  return (
    <div className="page agents-screen">
      <div className="page-column">
        <PageHeader title="Agents" lead="Agents take cards from the board and hand them back as pull requests." action={action} />

        {agents.length ? (
          <div className="agent-grid">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onEdit={() => (isModelAgent(agent) ? setEditingModel(agent.id) : setEditing(agent))}
                onModel={() => setModelOf(agent.id)}
                onToken={() => void attempt(async () => setToken({ agent, token: await store.newToken(agent.id) }))}
                onRevoke={() => void attempt(() => store.revokeAgent(agent.id))}
                onStart={() => setStarting(agent)}
              />
            ))}
          </div>
        ) : (
          <div className="agents-empty">
            <EmptyState icon={<Bot size={20} />} title="No agents yet" line="An agent takes cards from the board, works them where the code is, and hands them back as a pull request."
              action={may ? addButton : undefined} />
          </div>
        )}

        {(state.schedules ?? []).length > 0 && (
          <Section title="Scheduled runs" className="schedules-section" lead={may ? 'Notes put on the board as cards on a timer. Set them from a note’s Schedule button.' : undefined}>
            <ScheduleList schedules={state.schedules ?? []} />
          </Section>
        )}
      </div>

      <AnimatePresence>
        {adding && <AddAgent key="add" onClose={() => setAdding(false)} onMade={(made) => { setAdding(false); setToken(made) }} />}
        {claudeCode && <ClaudeCodeDialog key="claude-code" onClose={() => setClaudeCode(false)} />}
        {machineModelAgent && <MachineModel key={`machine-model-${machineModelAgent.id}`} agent={machineModelAgent} onClose={() => setModelOf(undefined)} />}
        {editingModelAgent && <EditModel key={`model-${editingModelAgent.id}`} agent={editingModelAgent} onClose={() => setEditingModel(undefined)} />}
        {editing && (
          <Dialog key="agent" title={`Edit ${editing.name}`} onClose={() => setEditing(undefined)}>
            <AgentForm agent={editing} onCancel={() => setEditing(undefined)} onDone={() => setEditing(undefined)} />
          </Dialog>
        )}
        {token && <TokenDialog key="token" agent={token.agent} token={token.token} onClose={() => setToken(undefined)} />}
        {starting && (
          <Dialog key="start" title={`Start ${starting.name}`} onClose={() => setStarting(undefined)} size="large">
            <RunnerSteps agent={starting} />
          </Dialog>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * The one way in to adding an agent: first what kind, then that kind's own steps. A machine with the code on it is the
 * usual one; a model with no machine is its Binder's owners' and admins' to add, so anyone else sees why it isn't theirs;
 * setting one up by hand ends with its token, shown once, in a dialog only its own Close shuts; and Claude Code is here
 * because people look for it here, said plainly not to be an agent.
 */
function AddAgent({ onClose, onMade }: { onClose: () => void; onMade: (made: { agent: Agent; token: string }) => void }) {
  const manager = useMayManageBinder()
  const options: GuidedOption[] = [
    { id: 'machine', icon: <Laptop size={18} />, name: 'A machine with your code on it', line: 'Run one line where your repos are. It works there with Claude Code, Codex or another tool.', recommended: true },
    { id: 'model', icon: <Cloud size={18} />, name: 'A model, with no machine', disabled: !manager,
      line: manager ? 'The hub runs it: it distills, writes notes, answers chats, debriefs and challenges. It can’t read or change code.' : 'Only this binder’s owners and admins can add one: it reads the binder’s notes and spends a key.' },
    { id: 'hand', icon: <SlidersHorizontal size={18} />, name: 'Set one up by hand', line: 'Choose its tool, repos and limits first, then start it with its token.' },
    { id: 'claude-code', icon: <SquareTerminal size={18} />, name: 'Use this hub from Claude Code', line: 'Adds the hub to your own Claude Code, working as you. It isn’t an agent: it takes no cards.' },
  ]
  const done = (nav: { close: () => void }) => <button type="button" className="button primary" onClick={nav.close}>Done</button>
  const steps = (id: string): GuidedStep[] => {
    if (id === 'machine') return [{ title: 'Run this on each machine', lead: 'In a terminal, in the folder with the code. Each machine that runs it joins as an agent of yours.', content: <MachineLine />, footer: done, closeOnlyFromButton: true }]
    if (id === 'model') return [{ title: 'Which model?', lead: 'Try it to see that it answers and calls tools, then add it.', content: (nav) => <AddModelForm onClose={nav.close} />, closeOnlyFromButton: true }]
    if (id === 'hand') return [{ title: 'Its tool and its name', lead: 'Everything else starts as most agents want it, under More.', content: <AgentForm onMade={onMade} />, closeOnlyFromButton: true }]
    return [{ title: 'Paste one command', lead: 'Claude Code then works in your binders as you, when you ask it to.', content: (nav) => <ClaudeCodeSteps onLeave={nav.close} />, footer: done }]
  }
  return <Guided title="Add an agent" question="What kind of agent?" options={options} steps={steps} onClose={onClose} />
}

/** How an agent stands, in a few words and a tone: what its line under its name says, and the colour of its dot. */
function standing(agent: Agent, holding: number, asks: number): { words: string; tone: 'ok' | 'running' | 'waiting' | 'bad' | 'off' } {
  if (asks) return { words: `${asks === 1 ? 'A question' : `${asks} questions`} for you`, tone: 'waiting' }
  if (isModelAgent(agent)) return holding ? { words: 'Working', tone: 'running' } : modelReady(agent) ? { words: 'Ready', tone: 'ok' } : { words: 'Needs attention', tone: 'bad' }
  const online = isOnline(agent)
  if (isListening(agent)) return { words: holding ? 'Working' : 'Listening for work', tone: holding ? 'running' : 'ok' }
  if (holding && online) return { words: 'Working', tone: 'running' }
  if (online) return { words: 'Online', tone: 'ok' }
  return { words: agent.lastSeen ? `Seen ${ago(agent.lastSeen)} ago` : 'Not running', tone: 'off' }
}

/**
 * One agent, calm and even: who it is and how it stands, what it's doing now, then two lines of facts (where it runs,
 * with what, and its repos). The rest is under Details, and in its edit dialog. Its actions are named; the rare ones
 * (restarting its runner, a new token, its model, revoking it) are in its menu.
 */
function AgentCard({ agent, onEdit, onModel, onToken, onRevoke, onStart }: { agent: Agent; onEdit: () => void; onModel: () => void; onToken: () => void; onRevoke: () => void; onStart: () => void }) {
  const { state } = useStore()
  const may = useMayChangeBinder()
  const manager = useMayManageBinder()
  // One the hub runs, as a model at an address: no machine, no runner, no terminal, no token.
  const hosted = isModelAgent(agent)
  // Binders' own agent works on a machine, and takes its steps from a model the hub holds: it has none until it's given one.
  const ownModel = usesOwnModel(agent)
  // A model on the agent's own machine is the one used, so the card's own model, and what's wrong with it, don't matter.
  const onItsMachine = modelOnMachine(agent)
  const fixModel = hosted ? onEdit : onModel
  const holding = state.cards.filter((c) => c.agentId === agent.id && c.stage === 'working')
  // A card it asked about waits in Blocked, still its: it counts here, or an agent whose question waits reads as idle.
  const paused = state.cards.filter((c) => c.agentId === agent.id && c.stage === 'blocked')
  const holds = [...holding, ...paused]
  const asks = holds.filter((c) => asksOf(c))
  const done = state.cards.filter((c) => c.agentId === agent.id && (c.stage === 'review' || c.stage === 'live')).length
  const online = hosted ? modelReady(agent) : isOnline(agent)
  const listening = hosted ? false : isListening(agent)
  const stands = standing(agent, holding.length, asks.length)
  // Only its owner can start it, see its token or answer its permissions, so whose it is shows when it isn't yours.
  const login = state.me?.user.login
  const mine = !!login && login.toLowerCase() === agent.owner.toLowerCase()
  const theirs = !!login && !mine
  const runner = agent.runner
  const run = runner ?? defaultRunner
  const tool = toolInfo(runner?.tool ?? toolForProvider(agent.provider))
  const binders = agent.binders.map((b) => state.binders.find((x) => x.id === b)?.name).filter((n): n is string => !!n)
  // Its model, in words: on its machine, the one the hub holds for Binders' own agent, or the name its tool is given.
  const model = hosted ? modelWords(agent.endpoint)
    : ownModel ? (onItsMachine && runner ? machineModelWords(runner) : agent.endpoint ? modelWords(agent.endpoint) : undefined)
      : runner?.model
  // Its runner restarts when asked from here (0.8.1 on): what it runs goes back on the board, and it starts again on the
  // newest runner. Asked, until it's back or a few minutes go by.
  const restartable = online && atLeast(agent.runnerSeen?.version, restartSince)
  const asked = agent.restartAsked
  const restarting = !!asked && Date.now() - Date.parse(asked.at) < 3 * 60_000 && (!agent.runnerSeen || agent.runnerSeen.at < asked.at)
  // What it's working on goes back on the board, so a restart with cards in hand asks first.
  const restart = () => void attempt(() => call('POST', `/api/agents/${agent.id}/restart`))
  const restartQuestion = `Restart and stop ${holding.length === 1 ? 'a card' : `${holding.length} cards`}? Press again`
  const old = runnerState(agent)
  const terminal = !hosted && !agent.sandbox && mine && run.tool !== 'custom' && !toolInfo(run.tool).noTerminal
  // Its repos, the first two by name and the rest counted; all of them under Details when there are more.
  const repos = agent.repos.length > 2 ? `${agent.repos.slice(0, 2).join(', ')} and ${agent.repos.length - 2} more` : inWords(agent.repos)
  const takes = hosted ? takesNames(agent.endpoint.takes) : []

  const menu = (): MenuItem[] => [
    ...(!hosted && (restartable || restarting) ? [restarting
      ? { label: 'Restarting its runner…', icon: <RotateCw size={14} />, disabled: true, onSelect: () => {} }
      : { label: 'Restart its runner', icon: <RotateCw size={14} />, confirm: holding.length ? restartQuestion : undefined, onSelect: restart }] : []),
    ...(!hosted && !agent.sandbox ? [{ label: 'New token', icon: <KeyRound size={14} />, confirm: 'Cut off its runner? Press again', onSelect: onToken }] : []),
    ...(ownModel && manager && agent.endpoint && !onItsMachine ? [{ label: 'Change its model', icon: <Bot size={14} />, onSelect: onModel }] : []),
    // A machine this hub keeps for it: the Binder's repo cloned in a sandbox, with the Binders runner in it. A model
    // agent with none yet may be given one; one with a machine here has it taken away again the same way.
    ...(isModelAgent(agent) && manager ? [{ label: 'Give it a machine on this hub', icon: <Server size={14} />, onSelect: () => void attempt(() => call('POST', `/api/agents/${agent.id}/sandbox`, { enabled: true })) }] : []),
    ...(agent.sandbox && manager ? [{ label: 'Take its machine on this hub away', icon: <Server size={14} />, onSelect: () => void attempt(() => call('POST', `/api/agents/${agent.id}/sandbox`, { enabled: false })) }] : []),
    ...(hosted ? [] : [{ separator: true as const }]),
    { label: 'Revoke', icon: <Trash2 size={14} />, danger: true, confirm: 'Revoke it? Press again', onSelect: onRevoke },
  ]

  const notes: ReactNode[] = []
  if (agent.runnerSeen?.enterpriseMcp && run.tool === 'claude') notes.push(<p key="mcp" className="agent-note" role="status">Enterprise MCP config on this machine: working without Binders’ MCP tools, its runner reporting for it.</p>)
  if (agent.runnerSeen?.bypassOff && run.tool === 'claude' && runner?.access === 'full') notes.push(<p key="policy" className="agent-note" role="status">This machine’s Claude Code policy turns full access off: it edits files without asking, and the commands it runs follow the policy’s rules.</p>)
  if (agent.endpoint?.ready && !agent.endpoint.ready.ok && !onItsMachine) notes.push(
    <p key="ready" className="agent-warning model-agent-warning" role="status">
      <span>{agent.endpoint.ready.why || 'It didn’t answer as it needs to.'}</span>
      {manager && <button type="button" className="button small model-agent-fix" onClick={fixModel}>Put it right</button>}
    </p>,
  )
  if (ownModel && !agent.endpoint && !onItsMachine) notes.push(
    <p key="none" className="agent-warning model-agent-warning" role="status">
      <span>{manager ? 'No model yet. It can’t work until it has one.' : 'No model yet. It can’t work until it has one. Ask one of this Binder’s owners or admins to give it a model.'}</span>
      {manager && <button type="button" className="button small model-agent-fix" onClick={onModel}>Give it a model</button>}
    </p>,
  )
  if (runnersOf(agent) > 1) notes.push(<p key="runners" className="agent-warning" role="status">{runnersOf(agent)} runners are running as {agent.name}{runnerPlaces(agent).length ? `, on ${runnerPlaces(agent).join(' and ')}` : ''}. They take the same work, each in its own folder: stop all but one.</p>)

  return (
    <article className="agent-card">
      <header>
        <AgentAvatar agent={agent} size={40} live={holding.length > 0} />
        <div className="agent-name">
          <h3>{agent.name}</h3>
          {/* Each piece stays whole and the line wraps between them: the separators are drawn after a piece, so none starts a line. */}
          <span className="agent-meta">
            <span className={`agent-piece agent-state ${stands.tone}`}><span className={`status-dot${online ? ' online' : ''}${listening ? ' listening' : ''}`} />{stands.words}</span>
            {theirs && <span className="agent-piece faint agent-owner">@{agent.owner}’s</span>}
          </span>
        </div>
      </header>

      <div className={`agent-doing${holding.length ? ' busy' : ''}${asks.length ? ' asks' : ''}`}>
        {holds.length ? holds.map((c) => (
          <a key={c.id} href={href({ screen: 'work', id: c.id })}>
            <b>{asksOf(c) ? 'Asks you' : c.stage === 'blocked' ? 'Blocked on' : 'Working on'}</b>
            <span>{asksOf(c) ?? c.doing ?? c.title}</span>
          </a>
        )) : <span className="agent-idle">Waiting for work{done ? ` · ${done} finished` : ''}</span>}
      </div>

      {notes}

      {may && !hosted && (!listening || old.old) && (
        <div className="agent-start">
          <p className={online && old.old ? 'runner-old' : undefined}>{online && old.old ? old.text : 'Its runner isn’t running.'}</p>
          {restartable
            ? <ConfirmButton className="button small" question={restartQuestion} ask={holding.length > 0} onConfirm={restart} disabled={restarting}><RotateCw size={13} aria-hidden="true" /> {restarting ? 'Restarting…' : 'Update it now'}</ConfirmButton>
            : <button type="button" className="button small primary" onClick={onStart}><Play size={13} aria-hidden="true" /> {listening ? 'Restart the runner' : 'Start the runner'}</button>}
        </div>
      )}

      <dl className="agent-facts">
        <div>
          <dt>{hosted ? <Cloud size={14} aria-hidden="true" /> : <Server size={14} aria-hidden="true" />}<span className="sr-only">Runs on</span></dt>
          <dd className="agent-where" title={[hosted ? 'This hub' : agent.runsOn, hosted ? undefined : tool.name, model].filter(Boolean).join(' · ')}>
            {hosted ? <span>Runs on this hub</span> : agent.runsOn && <span>{agent.runsOn}</span>}
            {!hosted && <span>{tool.name}</span>}
            {model && <span className="mono agent-model">{model}</span>}
          </dd>
        </div>
        <div>
          <dt>{hosted ? <Inbox size={14} aria-hidden="true" /> : <FolderGit2 size={14} aria-hidden="true" />}<span className="sr-only">{hosted ? 'Takes' : 'Repos'}</span></dt>
          <dd title={hosted ? undefined : agent.repos.join(', ') || undefined}>
            {hosted ? (takes.length ? `Takes ${inWords(takes).toLowerCase()}` : <span className="faint">Takes nothing: all four are off</span>)
              : agent.repos.length ? repos : <span className="faint">Any repo</span>}
          </dd>
        </div>
      </dl>

      {!hosted && (
        <More summary="Details">
          <dl className="agent-details">
            {agent.repos.length > 2 && <><dt>Repos</dt><dd><ChipGroup items={agent.repos} mono /></dd></>}
            {state.binders.length > 1 && <><dt>Parts</dt><dd>{binders.length ? inWords(binders) : 'All of it'}</dd></>}
            <dt>Skills</dt>
            <dd>{agent.skills.length ? <ChipGroup items={agent.skills} /> : 'Not said yet'}</dd>
            <dt>Access</dt>
            <dd className="agent-access">{shortAccess[run.access]}</dd>
            <dt>Runner</dt>
            <dd className="runner-facts">{[`${run.parallel ?? 3} at once`, `${run.timeoutMinutes} min a card`, agent.runnerSeen && `version ${agent.runnerSeen.version}`].filter(Boolean).join(' · ')}</dd>
            {run.workspace && <><dt>Folder</dt><dd className="mono">{run.workspace}</dd></>}
          </dl>
        </More>
      )}

      {may && (
        <footer>
          {terminal && (
            <a className="button" href={href({ screen: 'terminal', id: agent.id })} title={`${tool.name} in a terminal on its machine, as you’d use it there`}><SquareTerminal size={14} aria-hidden="true" />Terminal</a>
          )}
          {(!hosted || manager) && <button type="button" className="button" onClick={onEdit}>Edit</button>}
          <MenuButton className="agent-card-more" label={`More for ${agent.name}`} items={menu} />
        </footer>
      )}
    </article>
  )
}

/** Chips that show the first few and fold the rest behind "+N more". */
function ChipGroup({ items, mono = false }: { items: string[]; mono?: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open ? items : items.slice(0, 6)
  return (
    <div className="chip-group">
      {shown.map((item) => <span key={item} className={`tag${mono ? ' mono' : ''}`}>{item}</span>)}
      {items.length > 6 && <button type="button" className="tag more" onClick={() => setOpen(!open)}>{open ? 'Fewer' : `+${items.length - 6} more`}</button>}
    </div>
  )
}

/**
 * An agent's tool, name and runner settings: setting one up by hand (a step of adding an agent) or editing one (in its
 * own dialog). Everything but the tool and its name has a good start, so it's under More. A refusal is the hub's words,
 * shown in the form where the person is looking, and what was typed stays.
 */
function AgentForm({ agent, onCancel, onDone, onMade }: { agent?: Agent; onCancel?: () => void; onDone?: () => void; onMade?: (made: { agent: Agent; token: string }) => void }) {
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
  // Binders' own agent's model: on the hub, which holds its key, or on the agent's own machine, where the runner calls it.
  const [onMachine, setOnMachine] = useState(() => !!agent?.runner?.modelUrl)
  const chooseWhere = (machine: boolean) => {
    setOnMachine(machine)
    // On the hub, there is no address and no name here: the hub's own model is set from the agent's card.
    if (!machine) setRun({ modelUrl: undefined, model: undefined })
  }
  const [problem, setProblem] = useState<string>()
  // Picking a tool keeps an access it allows, and drops a model meant for another tool.
  const pickTool = (id: AgentTool) => {
    const next = toolInfo(id)
    setRunner((r) => ({ ...r, tool: id, access: next.access.includes(r.access) ? r.access : next.access[0], model: id === r.tool ? r.model : undefined, modelUrl: id === r.tool ? r.modelUrl : undefined }))
    if (id !== runner.tool) setOnMachine(false)
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
    setProblem(undefined)
    const fields = { name, provider: providerFor(runner.tool), repos, skills: list(skills), binders, runsOn: runsOn || undefined, runner }
    // A refusal is the hub's words, shown here where the person is looking, and what was typed stays.
    try {
      if (agent) {
        await store.updateAgent(agent.id, fields)
        onDone?.()
        return
      }
      const made = await store.createAgent(fields)
      onMade?.(made)
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : 'The hub couldn’t save that. Try again.')
    }
  }

  return (
    <form className="form agent-form" onSubmit={submit} aria-label={agent ? undefined : 'Set up an agent'}>
      <fieldset className="field">
        <span className="field-label">Tool</span>
        <div className="tool-grid" role="radiogroup" aria-label="Tool">
          {tools.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={runner.tool === t.id} className={`tool-choice${runner.tool === t.id ? ' on' : ''}`} onClick={() => pickTool(t.id)} title={t.tried ? undefined : 'Its command line follows its maker’s documentation; it wasn’t tried here'}>
              <ToolIcon tool={t.id} size={22} />
              <span><b>{t.name}</b><em>{t.tried ? t.by : `${t.by} · not tried`}</em></span>
            </button>
          ))}
        </div>
        {runner.tool === 'binders' && <span className="field-hint">Binders’ own agent works in the repo on this machine. Nothing else is installed there. Its model is on the hub, or on the machine itself: choose below.</span>}
        {!tool.mcp && runner.tool !== 'custom' && <span className="field-hint">{tool.name} doesn’t get Binders’ tools for a run, so the runner hands it each card and note, and reports back what it prints.</span>}
      </fieldset>
      {runner.tool === 'binders' && (
        <div className="field" role="radiogroup" aria-label="Its model">
          <span className="field-label" aria-hidden="true">Its model</span>
          <div className="model-agent-kinds">
            {([[false, 'On the hub', 'The hub reaches the model and keeps its key. Give it one from its card.'], [true, 'On this machine', 'A model server or a proxy on the machine itself, or on a network only it reaches. The runner calls it directly.']] as const).map(([machine, name, help]) => (
              <button key={name} type="button" role="radio" aria-checked={onMachine === machine} className={`model-agent-kind${onMachine === machine ? ' on' : ''}`} onClick={() => chooseWhere(machine)}>
                <i className="model-agent-radio" aria-hidden="true" />
                <span>
                  <b>{name}</b>
                  <em>{help}</em>
                </span>
              </button>
            ))}
          </div>
          {onMachine && (
            <div className="model-agent-own">
              <Field label="Address on the machine" hint="As the machine sees it. http is fine here.">
                <input id="runner-model-url" className="mono" required inputMode="url" value={runner.modelUrl ?? ''} onChange={(e) => setRun({ modelUrl: e.target.value.trim() || undefined })} placeholder="http://127.0.0.1:8000" autoComplete="off" autoCapitalize="none" spellCheck={false} />
              </Field>
              <Field label="Model or deployment">
                <input id="runner-own-model" className="mono" required value={runner.model ?? ''} onChange={(e) => setRun({ model: e.target.value.trim() || undefined })} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              </Field>
              <p className="field-hint">If the server wants a key, put it in BINDERS_MODEL_KEY in the runner’s environment on that machine. It never leaves the machine.</p>
            </div>
          )}
        </div>
      )}
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
              {/* Binders' own agent's model is the one the hub holds for it, given from its card, not a name on the machine. */}
              {runner.tool !== 'binders' && (
                <Field label="Model" hint={runner.tool === 'dsh' ? 'As provider/name, from its settings on that machine: azure/my-deployment, my-gateway/my-model. Empty is DeepSeek Harness’s own default.' : runner.tool === 'codex' ? 'Pick one, or type a provider’s deployment as provider/name (foundry/my-deployment). A name alone goes to your ChatGPT or OpenAI sign-in.' : models.length ? undefined : `Start a runner on a machine with ${tool.name} installed, and the models it finds are suggested here.`}>
                  {/* Any name, with the models the runner found as suggestions: a provider's own (foundry/…) may not be listed. */}
                  <input id="runner-model" list="runner-models" value={runner.model ?? ''} onChange={(e) => setRun({ model: e.target.value.trim() || undefined })} placeholder={`${tool.name}’s default`} autoComplete="off" />
                  <datalist id="runner-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
                </Field>
              )}
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
      {problem && <p className="model-agent-result bad" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {problem}</p>}
      <footer className="form-actions">
        {onCancel && <button type="button" className="button" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="button primary" disabled={!name.trim()}>{agent ? 'Save' : 'Set up'}</button>
      </footer>
    </form>
  )
}

function TokenDialog({ agent, token, onClose }: { agent: Agent; token: string; onClose: () => void }) {
  const { state } = useStore()
  const url = state.me?.mcpUrl ?? `${window.location.origin}/mcp`
  const [copied, setCopied] = useState<string>()
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
    <Dialog title={`Start ${agent.name}`} onClose={onClose} size="large" closeOnlyFromButton footer={<button type="button" className="button primary" onClick={onClose}>Done</button>}>
      <div className="token">
        <p>Its token, shown once: anyone with it can act as {agent.name}, so keep it where the agent runs. New token replaces it, and Revoke stops it at once.</p>
        <div className="token-value mono">
          <span>{token}</span>
          <button type="button" className="icon-button" onClick={() => void copy('token', token)} aria-label="Copy the token" title="Copy the token">{copied === 'token' ? <Check size={15} /> : <Copy size={15} />}</button>
        </div>
        <RunnerSteps agent={agent} token={token} />
        <More summary="Or connect a tool by hand, without the runner">
          <p>It only takes work while you ask it to.</p>
          {snippets.map((s) => (
            <section key={s.id} className="snippet">
              <header>
                <h3>{s.title}</h3>
                <button type="button" className="text-button" onClick={() => void copy(s.id, s.text)}>{copied === s.id ? 'Copied' : 'Copy'}</button>
              </header>
              <pre className={`mono${s.id === 'start' ? ' wrap' : ''}`}>{s.text}</pre>
            </section>
          ))}
        </More>
      </div>
    </Dialog>
  )
}
