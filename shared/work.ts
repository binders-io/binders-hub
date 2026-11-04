import { tools, type AgentTool } from './agents.ts'
import { withTestResult, type Challenge, type Debrief, type TestResult, type WorktreeDiff } from './changeSet.ts'
import type { Schedule } from './schedule.ts'
// The work: cards on a binder's board, the agents that take them, their pull requests, the change sets those are
// approved in, and the environments they ship to. Like notes, all of it moves by changes in the hub's log, applied in
// order with the same `applyWork` on the hub and in every browser.

// Blocked: held, but waiting on a person (an agent's question, or put there by someone). Merged work is live: there's
// no shipping stage any more, and a card the log has in it reads as live.
export type Stage = 'proposed' | 'ready' | 'working' | 'blocked' | 'review' | 'live'
export const stageOrder: Stage[] = ['proposed', 'ready', 'working', 'blocked', 'review', 'live']
const current = (stage: string | undefined) => (stage === 'shipping' ? 'live' : stage) as Stage

export type Provider = 'claude' | 'openai' | 'copilot' | 'opencode' | 'dsh' | 'cursor' | 'gemini' | 'pi' | 'amp' | 'goose' | 'aider' | 'qwen' | 'other'

/** How the Binders runner starts an agent for each card, set on the Agents page. */
export interface RunnerSettings {
  /** The command line it runs: Claude Code, Codex, or one of your own. */
  tool: AgentTool
  /** full: no permission prompts at all; auto: Claude Code decides what's safe; edits: file edits only. */
  access: 'full' | 'auto' | 'edits'
  model?: string
  /** A card that runs longer is stopped and put back. */
  timeoutMinutes: number
  /** Minutes without a word from the agent before its run is stopped as stuck (15): a model it can't reach, a prompt
   * waiting in its app, a login gone stale. */
  idleMinutes?: number
  /** Always true: cards are always worked in worktrees. Kept for runners and logs from before. */
  worktrees: boolean
  /**
   * Who its commits, pushes and pull requests are by: its owner (their GitHub name and private email, pushed with their
   * own sign-in), the default, or the hub's GitHub App (its bot).
   */
  commitAs?: 'owner' | 'app'
  /** For a custom tool: the command, with {prompt}, {dir} and {mcp} filled in. */
  command?: string
  /**
   * An experiment: its cards run in holders of their own, so they carry on while its runner stops, updates or crashes,
   * and pick up in the same conversation if the machine restarts. Needs python3 on the machine, as terminals do.
   */
  held?: boolean
  /**
   * An experiment: it works its cards through a binders command on its PATH instead of MCP, with no config and no
   * token in its environment, and hears what people write without being stopped.
   */
  cli?: boolean
  /**
   * An experiment, with held runs: each card runs as a live terminal its owner can watch and take over, the tool in its
   * own interface, with what it does reaching the card through the tool's hooks.
   */
  live?: boolean
  /** Where the code is on the machine the runner runs on, used when it isn't given --workspace. */
  workspace?: string
  /** How many cards it works on at once, each in a worktree of its own (one, without worktrees). */
  parallel?: number
  /**
   * Claude Code permission rules its runs get beside its access (`Bash(git:*)`, `WebFetch(domain:github.com)`): what it
   * may do without asking where a machine's policy turns full access off. The policy's own deny rules still win.
   */
  allow?: string[]
}

/** A Claude Code permission rule, as a runner's settings take it: a tool's name, and what it covers in brackets. */
export const allowRule = /^[A-Za-z][\w-]*(\([^()\n]{1,200}\))?$/
/** What most coding needs, offered on the Agents page in one click: reading, searching, git, GitHub, tests, builds. */
export const usualRules = ['Bash(git:*)', 'Bash(gh:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(node:*)', 'Bash(make:*)', 'Bash(terraform fmt:*)', 'Bash(terraform validate:*)', 'Bash(terraform plan:*)', 'WebFetch(domain:github.com)', 'WebFetch(domain:raw.githubusercontent.com)']

export const defaultRunner: RunnerSettings = { tool: 'claude', access: 'full', timeoutMinutes: 60, worktrees: true, parallel: 3 }

/** The tool an agent's maker points to, when it has no runner to say. */
export const toolForProvider = (provider: Provider | undefined): AgentTool => (provider === 'openai' ? 'codex' : provider && tools.some((t) => t.id === provider) ? (provider as AgentTool) : 'claude')
/** An agent's runner as the Agents page shows it: what's set, or what the form starts from when nothing is. */
export const runnerShown = (agent?: Pick<Agent, 'runner' | 'provider'>): RunnerSettings => agent?.runner ?? { ...defaultRunner, tool: toolForProvider(agent?.provider) }

/** An agent set up to take work. Its token is kept apart, hashed, and never in the log. */
export interface Agent {
  id: string
  name: string
  provider: Provider
  /** Who set it up (a GitHub login). */
  owner: string
  /** Where it works, e.g. "acme/web"; empty for anywhere. */
  repos: string[]
  /** Binders it may take work from; empty for all. */
  binders: string[]
  skills: string[]
  /** Where it runs, as it says: "Studio Mac", "Cloud runner"… */
  runsOn?: string
  /** The models its runner found it can use, on its machine, for its tool. */
  models?: string[]
  /**
   * The runner it last connected with: its version, how many cards it takes at once, and whether its machine has an
   * enterprise MCP config (Claude Code there works without Binders' MCP tools, the runner reporting for it).
   */
  runnerSeen?: { version: string; parallel: number; at: string; enterpriseMcp?: boolean; bypassOff?: boolean }
  /** The models its runner found for every agent tool installed on its machine, by tool. */
  toolModels?: Partial<Record<AgentTool, string[]>>
  createdAt: string
  lastSeen?: string
  revoked?: boolean
  /** How the Binders runner starts it, when it runs under one. */
  runner?: RunnerSettings
  /**
   * A person asked its runners to restart, on the newest runner the hub has: what they're running stops (cards go back
   * on the board), and they start again. A runner acts on one asked after it started.
   */
  restartAsked?: { at: string; by: string }
}

/** Live, kept by the hub and not in the log: when each agent last called, and whether a runner is listening for work. */
export interface Presence {
  at: string
  listening: boolean
  /** Runners heard from lately for this agent: more than one take the same work. */
  runners?: number
  /** Where they run, as each says. */
  runnersOn?: string[]
}

export type ActivityKind = 'created' | 'claimed' | 'released' | 'progress' | 'step' | 'said' | 'comment' | 'question' | 'answer' | 'pr' | 'completed' | 'moved' | 'merged' | 'deployed' | 'ran' | 'permission' | 'debrief' | 'challenge'

export interface Activity {
  at: string
  /** A GitHub login, an agent's id, or "hub". */
  by: string
  kind: ActivityKind
  text: string
  /** For a step: what came back. */
  result?: string
  /** For a step: Read, Edit, Write, Bash… */
  tool?: string
  /** For a run ending ("ran"): what it used. */
  tokens?: number
  cost?: number
}

export interface PlanStep {
  text: string
  done: boolean
}

export interface Card {
  id: string
  binderId: string
  title: string
  brief: string
  doneWhen: string
  size: 'S' | 'M' | 'L'
  stage: Stage
  createdAt: string
  createdBy: string
  updatedAt: string
  /** The note and words it came from. */
  noteId?: string
  quote?: string
  /** The agent holding it. */
  agentId?: string
  /** The agent it's meant for, before anyone holds it. */
  meantFor?: string
  waitsFor: string[]
  /** The card this is a part of, when it was split from one for a swarm of agents. */
  parent?: string
  /** Its GitHub issue, once the binder's repo has one for it. */
  issue?: { repo: string; number: number; url: string }
  prId?: string
  /** Before there's a pull request: the diff of the card's worktree, as its runner last saw it. */
  worktree?: WorktreeDiff
  /** What its Change Set proposes, as an agent wrote it when a person asked. */
  debrief?: Debrief
  /** An adversarial review of its Change Set, by an agent that didn't write it. */
  challenge?: Challenge
  progress?: number
  doing?: string
  plan?: PlanStep[]
  /** A question waiting for a person. */
  needsYou?: string
  /** A live run waiting on a permission: what it wants to do, until its agent's owner answers or the run moves on. */
  permission?: { request: string; agent: string; tool: string; what: string; at: string; answer?: 'allow' | 'deny'; by?: string }
  activity: Activity[]
  cost?: number
  /** Tokens its runs used, all told. */
  tokens?: number
  minutes?: number
  /** The schedule that put it on the board, for a scheduled run of a note. */
  scheduleId?: string
}

export interface Proposal {
  id: string
  binderId: string
  noteId: string
  title: string
  quote: string
  brief: string
  doneWhen: string
  size: 'S' | 'M' | 'L'
  meantFor?: string
  by: string
  state: 'new' | 'accepted' | 'dismissed'
  cardId?: string
}

export type CheckState = 'queued' | 'running' | 'passed' | 'failed'

export interface Check {
  name: string
  state: CheckState
  seconds?: number
  url?: string
}

export interface DiffLine {
  kind: ' ' | '+' | '-' | '@'
  text: string
  /** Its line in the file: the new file's for an added or unchanged line, the old file's for a removed one. */
  n?: number
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  lines: DiffLine[]
}

export type PRState = 'open' | 'approved' | 'queued' | 'merged' | 'closed'

export interface PullRequest {
  /** "owner/repo#number". */
  id: string
  repo: string
  number: number
  title: string
  branch: string
  url: string
  state: PRState
  cardId?: string
  agentId?: string
  checks: Check[]
  files: FileDiff[]
  additions?: number
  deletions?: number
  /** The commit at the head of its branch, as the hub last saw it: new ones make a debrief out of date. */
  head?: string
  /**
   * Whether it merges into its base as things are now, as GitHub says: cleanly, behind (it can be brought up to date
   * without help), with conflicts someone has to resolve, blocked by the repo's rules, or not known yet.
   */
  mergeable?: 'clean' | 'behind' | 'conflicts' | 'blocked' | 'unknown'
}

export type ChangeSetState = 'assembling' | 'review' | 'merging' | 'merged' | 'shipped'

export interface ChangeSet {
  id: string
  binderId: string
  number: number
  title: string
  summary: string
  state: ChangeSetState
  /** In merge order. */
  prIds: string[]
  noteIds: string[]
  approvedBy?: string
  issue?: { repo: string; number: number; url: string }
  /** Approved, and merging as each pull request is ready: those it's waiting on, and for what. */
  waiting?: { prId: string; why: string }[]
  /** Its debrief and Challenge: of all its pull requests together. A Challenge's findings also go to each one's card. */
  debrief?: Debrief
  challenge?: Challenge
}

export type EnvState = 'healthy' | 'deploying' | 'waiting' | 'failed'

export interface Environment {
  id: string
  name: string
  url: string
  version: string
  changeSetIds: string[]
  state: EnvState
  deployedAt: string
  needsApproval: boolean
  progress?: number
  /** How a promotion is carried out: a GitHub Actions workflow run with the version. None: the hub records it. */
  deploy?: { repo: string; workflow: string; ref: string }
}

export interface Run {
  id: string
  workflow: string
  target: string
  repo: string
  state: CheckState
  seconds: number
  at: string
  url?: string
}

/** A message in a chat beside a note: from a person or the agent. */
export interface ChatMessage {
  at: string
  by: string
  text: string
}

/** A person talking with one agent about one note, while they work on it. */
export interface Chat {
  id: string
  noteId: string
  agentId: string
  messages: ChatMessage[]
  /** The agent has it, and what it's doing now. */
  working?: boolean
  doing?: string
}

/**
 * What an agent should know about a repo before it works or reviews there, as an engineer who's worked in it for months
 * would: its map, the rules its code keeps, how to build and test it, where it breaks, its conventions. Written by an
 * agent from the repo's default branch, the first time an agent needs it, and again as the repo moves on; what agents
 * learn meanwhile is kept beside it as lessons until then. Every agent working or reviewing in the repo gets it in its
 * prompt. Kept in each binder's own log: one binder's never reaches another.
 */
export interface RepoBrief {
  /** The repo in lower case, owner/name: GitHub's names don't care about case. */
  id: string
  /** The repo as first named. */
  repo: string
  /** The note it's kept in, in Repo docs: people read and edit it there (shared/briefs.ts). */
  noteId?: string
  /** The brief itself, from before briefs were kept in notes. */
  text?: string
  /** The commit of its default branch it was written from. */
  sha?: string
  writtenAt?: string
  /** The agent that wrote it. */
  writtenBy?: string
  /** What agents and people learned since it was written, to be folded in the next time it's written. */
  lessons?: RepoLesson[]
  /** Its writing, asked of an agent: what it's doing, or why it couldn't. */
  ask?: BriefAsk
}

export interface RepoLesson {
  at: string
  /** A GitHub login or an agent's id. */
  by: string
  text: string
}

export interface BriefAsk {
  agentId: string
  /** A GitHub login or an agent's id. */
  askedBy: string
  at: string
  state: 'asked' | 'writing' | 'failed'
  /** Written again from the one there, as the repo has moved on since. */
  refresh?: boolean
  doing?: string
  failed?: string
}

/** The most a brief holds, and lessons beside it. */
export const briefMost = 20_000
export const lessonsKept = 40
export const lessonMost = 400

/** A repo's brief's id: its name in lower case. */
export const briefId = (repo: string) => repo.trim().toLowerCase()
/** The same repo, as GitHub takes it: owner/name without regard to capitals. */
export const sameRepo = (a: string | undefined, b: string | undefined) => !!a && !!b && briefId(a) === briefId(b)

/**
 * The live agent a name means: the one written so, or else the one written so in other capitals. A revoked agent is
 * nobody to give work to, whatever it was called.
 */
export function agentNamed<T extends { name: string; revoked?: boolean }>(agents: T[], name: string): T | undefined {
  const live = agents.filter((a) => !a.revoked)
  const wanted = name.trim()
  return live.find((a) => a.name === wanted) ?? live.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
}

/** Who a card is meant for, if that agent is still there: one meant for an agent since revoked or gone is open again. */
export function meantForNow(state: { agents?: { id: string; revoked?: boolean }[] }, card: { meantFor?: string }) {
  if (!card.meantFor) return undefined
  return !state.agents || state.agents.some((a) => a.id === card.meantFor && !a.revoked) ? card.meantFor : undefined
}
export const briefOf = (state: Pick<WorkState, 'briefs'>, repo: string | undefined) => (repo ? (state.briefs ?? []).find((b) => b.id === briefId(repo)) : undefined)

/** A brief a person or an agent asked this agent to write, not started yet: after replies, before cards. */
export function briefJobFor(state: WorkState, agent: Agent, busy: string[] = []): RepoBrief | undefined {
  return (state.briefs ?? []).find((b) => b.ask?.agentId === agent.id && b.ask.state === 'asked' && !busy.includes(`brief:${b.id}`))
}

export interface WorkState {
  agents: Agent[]
  cards: Card[]
  proposals: Proposal[]
  pulls: PullRequest[]
  changeSets: ChangeSet[]
  /** The highest number a change set has had: a deleted one's number isn't used again, as cards' findings still name it. */
  setsMade?: number
  environments: Environment[]
  runs: Run[]
  chats: Chat[]
  /** Notes run as cards on a timer. Missing from logs written before there were any. */
  schedules?: Schedule[]
  /** Each repo's brief. Missing from logs written before there were any. */
  briefs?: RepoBrief[]
}

export const emptyWork = (): WorkState => ({ agents: [], cards: [], proposals: [], pulls: [], changeSets: [], environments: [], runs: [], chats: [], schedules: [], briefs: [] })

/** How many messages a chat keeps; older ones are dropped. */
export const chatKept = 200

export type WorkChange =
  | { type: 'agent.put'; agent: Agent }
  | { type: 'agent.seen'; id: string; at: string }
  | { type: 'agent.revoke'; id: string }
  | { type: 'card.put'; card: Card }
  | { type: 'card.update'; id: string; fields: Partial<Omit<Card, 'id' | 'activity'>>; activity?: Activity }
  /** An agent taking a card: only the first one applied gets it, so two agents asking at once never both do. */
  | { type: 'card.claim'; id: string; agentId: string; at: string }
  | { type: 'card.release'; id: string; agentId: string; at: string; why: string }
  | { type: 'card.activity'; id: string; activity: Activity }
  | { type: 'card.delete'; id: string }
  | { type: 'proposal.put'; proposal: Proposal }
  | { type: 'proposal.update'; id: string; fields: Partial<Pick<Proposal, 'state' | 'cardId' | 'meantFor'>> }
  | { type: 'pr.put'; pull: PullRequest }
  | { type: 'pr.update'; id: string; fields: Partial<Omit<PullRequest, 'id'>> }
  | { type: 'set.put'; set: ChangeSet }
  | { type: 'set.update'; id: string; fields: Partial<Omit<ChangeSet, 'id'>> }
  | { type: 'env.put'; environment: Environment }
  | { type: 'env.update'; id: string; fields: Partial<Omit<Environment, 'id'>> }
  | { type: 'run.put'; run: Run }
  | { type: 'chat.say'; id: string; noteId: string; agentId: string; message: ChatMessage }
  | { type: 'chat.status'; id: string; working: boolean; doing?: string }
  | { type: 'chat.clear'; id: string }
  | { type: 'schedule.put'; schedule: Schedule }
  | { type: 'schedule.update'; id: string; fields: Partial<Omit<Schedule, 'id'>> }
  | { type: 'schedule.delete'; id: string }
  | { type: 'brief.put'; brief: RepoBrief }
  | { type: 'brief.delete'; id: string }
  /** A person ran one of a debrief's functional tests (by its card or change set's id): its result, or none to clear it. */
  | { type: 'test.result'; id: string; test: string; result: TestResult | null }
  | { type: 'agent.delete' | 'proposal.delete' | 'pr.delete' | 'set.delete' | 'env.delete' | 'run.delete'; id: string }

/** How many activity lines a card keeps; older ones are dropped. */
export const activityKept = 400

/**
 * Fields merged in, where a field set to undefined (or null, as undefined travels in JSON) is cleared. JSON drops
 * undefined, so changes go out through `forWire`, which writes those as null.
 */
const merge = <T extends object>(item: T, fields: object): T => {
  const next = { ...item } as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) delete next[key]
    else next[key] = value
  }
  return next as T
}

/** A change ready for JSON: fields cleared with undefined are sent as null, so the clearing isn't lost. */
export function forWire<C extends { type: string }>(change: C): C {
  if (!('fields' in change) || !change.fields || typeof change.fields !== 'object') return change
  return { ...change, fields: Object.fromEntries(Object.entries(change.fields).map(([k, v]) => [k, v === undefined ? null : v])) }
}

const upsert = <T extends { id: string }>(list: T[], item: T) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item])
const patch = <T extends { id: string }>(list: T[], id: string, fields: object): T[] => list.map((x) => (x.id === id ? merge(x, fields) : x))
const withActivity = (card: Card, activity: Activity): Card => ({ ...card, activity: [...card.activity, activity].slice(-activityKept), updatedAt: activity.at })

export function applyWork<S extends WorkState>(state: S, change: WorkChange): S {
  switch (change.type) {
    case 'agent.put':
      return { ...state, agents: upsert(state.agents, change.agent) }
    case 'agent.seen':
      return { ...state, agents: patch(state.agents, change.id, { lastSeen: change.at }) }
    case 'agent.revoke':
      return {
        ...state,
        agents: patch(state.agents, change.id, { revoked: true }),
        // What it held goes back on the board.
        cards: state.cards.map((c) => (c.agentId === change.id && c.stage === 'working' ? { ...c, permission: undefined, agentId: undefined, stage: 'ready', doing: undefined, progress: undefined } : c)),
      }
    case 'card.put':
      return { ...state, cards: upsert(state.cards, { ...change.card, stage: current(change.card.stage) }) }
    case 'card.update':
      return {
        ...state,
        cards: state.cards.map((c) => {
          if (c.id !== change.id) return c
          const fields = change.fields.stage ? { ...change.fields, stage: current(change.fields.stage) } : change.fields
          const next = { ...merge(c, fields), updatedAt: change.activity?.at ?? c.updatedAt }
          // A permission belongs to the run that asked: given to another agent, nobody is waiting on it any more.
          if ('agentId' in fields && (fields.agentId ?? undefined) !== c.agentId) delete next.permission
          return change.activity ? withActivity(next, change.activity) : next
        }),
      }
    case 'card.claim':
      return {
        ...state,
        cards: state.cards.map((c) => {
          if (c.id !== change.id) return c
          // Taken already, done, or meant for someone else: the claim does nothing.
          if (c.agentId && c.agentId !== change.agentId) return c
          if (c.stage !== 'ready' && !(c.stage === 'working' && c.agentId === change.agentId)) return c
          const meant = meantForNow(state, c)
          if (meant && meant !== change.agentId) return c
          const agent = state.agents.find((a) => a.id === change.agentId)
          return withActivity({ ...c, agentId: change.agentId, stage: 'working', progress: 0 }, { at: change.at, by: change.agentId, kind: 'claimed', text: `${agent?.name ?? 'An agent'} took it` })
        }),
      }
    case 'card.release':
      return {
        ...state,
        cards: state.cards.map((c) => (c.id === change.id && c.agentId === change.agentId
          ? withActivity({ ...c, agentId: undefined, stage: 'ready', doing: undefined, progress: undefined, permission: undefined }, { at: change.at, by: change.agentId, kind: 'released', text: change.why })
          : c)),
      }
    case 'card.activity':
      return { ...state, cards: state.cards.map((c) => (c.id === change.id ? withActivity(c, change.activity) : c)) }
    case 'card.delete':
      return { ...state, cards: state.cards.filter((c) => c.id !== change.id) }
    case 'proposal.put':
      return { ...state, proposals: upsert(state.proposals, change.proposal) }
    case 'proposal.update':
      return { ...state, proposals: patch(state.proposals, change.id, change.fields) }
    case 'pr.put':
      return { ...state, pulls: upsert(state.pulls, change.pull) }
    case 'pr.update':
      return { ...state, pulls: patch(state.pulls, change.id, change.fields) }
    case 'set.put':
      return { ...state, changeSets: upsert(state.changeSets, change.set), setsMade: Math.max(state.setsMade ?? 0, change.set.number) }
    case 'set.update':
      return { ...state, changeSets: patch(state.changeSets, change.id, change.fields) }
    case 'env.put':
      return { ...state, environments: upsert(state.environments, change.environment) }
    case 'env.update':
      return { ...state, environments: patch(state.environments, change.id, change.fields) }
    case 'run.put':
      return { ...state, runs: [change.run, ...state.runs.filter((r) => r.id !== change.run.id)].slice(0, 60) }
    case 'chat.say': {
      const chats = state.chats ?? []
      const was = chats.find((c) => c.id === change.id) ?? { id: change.id, noteId: change.noteId, agentId: change.agentId, messages: [] }
      // The agent's reply ends its turn.
      const byAgent = change.message.by === change.agentId
      const next: Chat = { ...was, messages: [...was.messages, change.message].slice(-chatKept), working: byAgent ? undefined : was.working, doing: byAgent ? undefined : was.doing }
      if (byAgent) { delete next.working; delete next.doing }
      return { ...state, chats: [...chats.filter((c) => c.id !== change.id), next] }
    }
    case 'chat.status':
      return { ...state, chats: patch(state.chats ?? [], change.id, { working: change.working || undefined, doing: change.working ? change.doing : undefined }) }
    case 'chat.clear':
      return { ...state, chats: (state.chats ?? []).filter((c) => c.id !== change.id) }
    case 'schedule.put':
      return { ...state, schedules: upsert(state.schedules ?? [], change.schedule) }
    case 'schedule.update':
      return { ...state, schedules: patch(state.schedules ?? [], change.id, change.fields) }
    case 'schedule.delete':
      return { ...state, schedules: (state.schedules ?? []).filter((x) => x.id !== change.id) }
    case 'brief.put':
      return { ...state, briefs: upsert(state.briefs ?? [], change.brief) }
    case 'brief.delete':
      return { ...state, briefs: (state.briefs ?? []).filter((b) => b.id !== change.id) }
    case 'test.result': {
      // A change set's debrief is also on each of its cards: a result goes on all of them.
      const set = state.changeSets.find((s) => s.id === change.id)?.id ?? state.cards.find((c) => c.id === change.id)?.debrief?.fromSet
      const mark = <T extends { debrief?: Debrief }>(item: T): T => (item.debrief ? { ...item, debrief: withTestResult(item.debrief, change.test, change.result) } : item)
      return {
        ...state,
        changeSets: set ? state.changeSets.map((s) => (s.id === set ? mark(s) : s)) : state.changeSets,
        cards: state.cards.map((c) => (set ? c.debrief?.fromSet === set : c.id === change.id) ? mark(c) : c),
      }
    }
    case 'agent.delete':
      return { ...state, agents: state.agents.filter((a) => a.id !== change.id) }
    case 'proposal.delete':
      return { ...state, proposals: state.proposals.filter((p) => p.id !== change.id) }
    case 'pr.delete':
      return { ...state, pulls: state.pulls.filter((p) => p.id !== change.id) }
    case 'set.delete':
      return { ...state, changeSets: state.changeSets.filter((s) => s.id !== change.id) }
    case 'env.delete':
      return { ...state, environments: state.environments.filter((e) => e.id !== change.id) }
    case 'run.delete':
      return { ...state, runs: state.runs.filter((r) => r.id !== change.id) }
    default:
      // A kind of change from a newer hub than this code: left as it is, so a tab open across an update carries on.
      return state
  }
}

/** A chat where a person spoke last and the agent hasn't started on it: it comes before any card. */
export function chatFor(state: WorkState, agent: Agent, busy: string[] = []): Chat | undefined {
  return (state.chats ?? []).find((c) => c.agentId === agent.id && !busy.includes(c.id) && !c.working && c.messages.length > 0 && c.messages[c.messages.length - 1].by !== agent.id)
}

/** A card whose debrief a person asked this agent for, not started yet: it comes after chats, before cards. */
export function debriefFor(state: WorkState, agent: Agent, busy: string[] = []): Card | undefined {
  return state.cards.find((c) => c.debrief?.agentId === agent.id && c.debrief.state === 'asked' && !busy.includes(`debrief:${c.id}`))
}

/** A change set whose debrief a person asked this agent for, not started yet: before cards' debriefs. */
export function setDebriefFor(state: WorkState, agent: Agent, busy: string[] = []): ChangeSet | undefined {
  return state.changeSets.find((s) => s.debrief?.agentId === agent.id && s.debrief.state === 'asked' && !busy.includes(`debrief:${s.id}`))
}

/** A change set a person asked this agent to challenge, not started yet: before cards' Challenges. */
export function setChallengeFor(state: WorkState, agent: Agent, busy: string[] = []): ChangeSet | undefined {
  return state.changeSets.find((s) => s.challenge?.agentId === agent.id && s.challenge.state === 'asked' && !busy.includes(`challenge:${s.id}`))
}

/** A card a person asked this agent to challenge, not started yet: it comes after debriefs, before cards. */
export function challengeFor(state: WorkState, agent: Agent, busy: string[] = []): Card | undefined {
  return state.cards.find((c) => c.challenge?.agentId === agent.id && c.challenge.state === 'asked' && !busy.includes(`challenge:${c.id}`))
}

/** A card whose Challenge findings a person asked this agent, their author, to reply to: after Challenges, before cards. */
export function repliesFor(state: WorkState, agent: Agent, busy: string[] = []): Card | undefined {
  // Not while its runner works the card itself: the reply uses the same worktree and session.
  return state.cards.find((c) => c.challenge?.replies?.agentId === agent.id && c.challenge.replies.state === 'asked' && !busy.includes(`replies:${c.id}`) && !busy.includes(c.id))
}

/** A card the agent holds whose question a person just answered: the agent goes on with it. */
export function resumeFor(state: WorkState, agent: Agent, busy: string[] = []): Card | undefined {
  // A card it holds, not asking anything, where a person had the last word: an answer, a comment such as a nudge, or
  // moving it back from blocked.
  const people = (by: string) => by !== 'hub' && !state.agents.some((a) => a.id === by)
  return state.cards.find((c) => {
    if (c.agentId !== agent.id || c.stage !== 'working' || c.needsYou || busy.includes(c.id)) return false
    // Someone asking for its debrief or a Challenge isn't talking to the agent working it.
    const last = c.activity.filter((a) => a.kind !== 'debrief' && a.kind !== 'challenge').at(-1)
    return !!last && (last.kind === 'answer' || last.kind === 'comment' || last.kind === 'moved') && people(last.by)
  })
}

/**
 * The next card an agent could take, waiting on nothing unfinished: one a person meant for it, wherever it is, or one open
 * to anyone in its binders and repos.
 */
/**
 * What moving a card by hand changes, or undefined for a move the board doesn't allow: only an agent starts work, and
 * only a blocked card it holds goes back to working. Blocked, working, review and done keep its agent; anywhere else
 * takes it back.
 */
export function handMove(card: Pick<Card, 'stage' | 'agentId'>, stage: Stage): Partial<Card> | undefined {
  if (card.stage === stage) return undefined
  if (stage === 'working' && !(card.stage === 'blocked' && card.agentId)) return undefined
  const keep = stage === 'review' || stage === 'live' || stage === 'blocked' || stage === 'working'
  return { stage, needsYou: undefined, permission: undefined, doing: undefined, ...(keep ? {} : { agentId: undefined, progress: undefined }) }
}

/** What a card is waiting on from a person, in a line: an agent's question, or a permission nobody has answered yet. */
export const asksOf = (card: Pick<Card, 'needsYou' | 'permission'>) =>
  card.needsYou ?? (card.permission && !card.permission.answer ? `Allow ${card.permission.tool}: ${card.permission.what}` : undefined)

export function nextFor(state: WorkState & { binders: { id: string; repo?: string }[] }, agent: Agent, busy: string[] = []): Card | undefined {
  const done = new Set(state.cards.filter((c) => c.stage === 'review' || c.stage === 'live').map((c) => c.id))
  // A wait for a card that isn't on the board (deleted, or never a card's id) holds nothing up.
  const there = new Set(state.cards.map((c) => c.id))
  // A card split into parts isn't offered whole, however far along the parts are: it follows them.
  const split = new Set(state.cards.flatMap((c) => (c.parent ? [c.parent] : [])))
  return state.cards
    .filter((c) => c.stage === 'ready' && !c.agentId && !busy.includes(c.id) && !split.has(c.id))
    .filter((c) => mayTake(state, agent, c))
    .filter((c) => c.waitsFor.every((w) => done.has(w) || !there.has(w)))
    .sort((a, b) => Number(b.meantFor === agent.id) - Number(a.meantFor === agent.id) || a.createdAt.localeCompare(b.createdAt))[0]
}

/**
 * Whether an agent may take a card, as the board offers them: one meant for it, whatever its binders and repos (a
 * person's to give), or one meant for nobody in a binder and repo it works in.
 */
export function mayTake(state: { binders: { id: string; repo?: string }[]; agents?: { id: string; revoked?: boolean }[] }, agent: Pick<Agent, 'id' | 'binders' | 'repos'>, card: Pick<Card, 'meantFor' | 'binderId'>) {
  const meant = meantForNow(state, card)
  if (meant) return meant === agent.id
  const repo = state.binders.find((b) => b.id === card.binderId)?.repo
  return worksIn(agent, card.binderId, state.binders) && (!agent.repos.length || !repo || agent.repos.some((r) => sameRepo(r, repo)))
}

/**
 * Whether an agent works in a binder: every binder, unless it's limited to some that still exist. A limit naming only
 * binders gone since (projects folded into their binder, say) limits nothing, rather than leaving it nothing to do.
 */
export function worksIn(agent: { binders: string[] }, binderId: string, binders: { id: string }[]) {
  const live = agent.binders.filter((id) => binders.some((b) => b.id === id))
  return !live.length || live.includes(binderId)
}
