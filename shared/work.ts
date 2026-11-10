import { tools, type AgentTool } from './agents.ts'
import { trashKept } from './notes.ts'
import { withTestResult, type Challenge, type Debrief, type TestResult, type WorktreeDiff } from './changeSet.ts'
import { runsKept, type Schedule, type ScheduleRun } from './schedule.ts'
import type { Listener } from './listen.ts'
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

export type ActivityKind = 'created' | 'claimed' | 'released' | 'progress' | 'step' | 'said' | 'comment' | 'question' | 'answer' | 'pr' | 'completed' | 'moved' | 'merged' | 'deployed' | 'ran' | 'permission' | 'debrief' | 'challenge' | 'message'

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
  /** For a message: the agent it's to. */
  to?: string
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
  /** Its Jira issue, once the binder's project has one for it. */
  jira?: { key: string; url: string; imported?: boolean }
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
  /**
   * The last time its work stopped without finishing: why, when, and how many times running. Twice running and it
   * waits in Blocked for a person, with why as its question. Gone once it's finished or a person moves it on.
   */
  stopped?: { why: string; at: string; times: number }
  /** A live run waiting on a permission: what it wants to do, until its agent's owner answers or the run moves on. */
  permission?: { request: string; agent: string; tool: string; what: string; at: string; answer?: 'allow' | 'deny'; by?: string }
  activity: Activity[]
  /** In a browser's light state: how many older lines of its activity were left out, which the card's page asks for when it opens. */
  activityMore?: number
  /**
   * On a browser only: this card finished a while ago and its detail isn't here (its brief and done-when are empty, and it
   * has no plan, debrief, Challenge or activity), until the card is opened. This says how its debrief and Challenge stood.
   * The hub never keeps one, and refuses a card sent with one.
   */
  left?: CardLeft
  cost?: number
  /** Tokens its runs used, all told. */
  tokens?: number
  minutes?: number
  /** The schedule that put it on the board, for a scheduled run of a note. */
  scheduleId?: string
  /** A Distill the hub started under a folder's rule: the rule, whose limits say what's accepted without a person. */
  distillRule?: string
  /** Accepted without a person, under a folder's rule: the rule, and who set it. */
  acceptedBy?: { rule: string; setBy: string }
  /** Suggested by an agent on work nobody had read: that card. It's proposed until a person moves it on, whichever agent is asked. */
  madeUnread?: string
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
  /** Who accepted it, by the log's say (see proposal.take), and the rule it counted against. */
  claim?: string
  rule?: string
}

/** What a folder does with the notes in it (and in folders inside it, unless one has its own rule). Only people set these. */
export interface FolderRule {
  id: string
  binderId: string
  folderId: string
  enabled: boolean
  /** Distill a note here without being asked, once, when it's finished. */
  distill: boolean
  /** The agent that distills them; none for the first one free. */
  agentId?: string
  /** A person's note counts as finished after this long with no edit. A scheduled run's note, when its run is over. */
  quietMinutes: number
  /** Accept what's proposed without a person, up to these limits. What's over them waits for a person. It never approves a change set. */
  accept?: { maxCards: number; sizes: Card['size'][]; agents: string[] }
  /** Whether a note's work joins the change set that's open, or gets one of its own. */
  changeSet: 'shared' | 'own'
  /** Notes last edited before this are left alone: a rule isn't for what's already there. */
  since: string
  createdAt: string
  createdBy: string
  /** Why it can't do what it says, until a person changes it. */
  failing?: string
}

/** What the hub knows of a note beyond its words. */
export interface NoteWork {
  noteId: string
  /** A person's choice for this one note; the folder's rule when there's none. */
  changeSet?: 'shared' | 'own'
  /** The scheduled run that wrote it. */
  fromRun?: { scheduleId: string; cardId: string }
  /** Its one automatic Distill: taken by whichever hub's `claim` is first, with the id its card gets, and `made` once it has it. */
  distill?: { rule: string; claim: string; at: string; cardId: string; made?: boolean }
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
  /** The commit it made on its base when it merged, as GitHub says: what an environment's deployed commit is compared with. Missing from before it was kept. */
  mergeSha?: string
  /** When the hub first saw it merged or closed, if its card didn't say: what the weeks its diff is kept for are counted from. */
  endedAt?: string
  /** The lines of its files were dropped from the state, once it had been over for a while: GitHub has them, and the hub asks when they're opened. */
  linesDropped?: boolean
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
  /** A note's own: only that note's work goes in it, and open work elsewhere stays out. */
  forNote?: string
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
  /** `<owner/name>#<name>`, in lower case (`environmentId`). */
  id: string
  /** The repo it's an environment of, as owner/name. One without is from before environments were per repo, and is dropped. */
  repo?: string
  /** As GitHub names it. */
  name: string
  /** Where it's served, when GitHub or a person says: an http or https address, else empty. */
  url: string
  /** What's on it: the version its deploy named, else the tag or branch, else the commit's first seven. Empty until GitHub reports a deployment to it. */
  version: string
  /** The commit that's on it. */
  sha?: string
  /** The pull requests of its repo that are on it. */
  pullIds?: string[]
  /** The change sets with a pull request on it. */
  changeSetIds: string[]
  state: EnvState
  /** When it was deployed, as GitHub says; empty until it has been. */
  deployedAt: string
  /** The run that deployed it, on GitHub. */
  logUrl?: string
  /** A person presses Promote before the hub deploys to it. Only with `deploy`. */
  needsApproval: boolean
  progress?: number
  /** How the hub deploys to it: a workflow run with the version. None: the hub only follows what GitHub deploys there. */
  deploy?: { repo: string; workflow: string; ref: string }
  /** Its place among its repo's environments: lower is deployed to first. */
  order?: number
  /** Found on GitHub, or set up by a person. */
  by?: 'github' | 'person'
}

/** An environment's id: its repo and its name, in lower case, so GitHub's capitals and a person's are the same one. */
export const environmentId = (repo: string, name: string) => `${repo.trim().toLowerCase()}#${name.trim().toLowerCase()}`

/** A repo's environments, in the order they're deployed to. One with no place yet comes after those that have one. */
export function repoEnvironments(state: Pick<WorkState, 'environments'>, repo: string | undefined): Environment[] {
  if (!repo) return []
  return state.environments
    .map((env, at) => ({ env, at }))
    .filter(({ env }) => sameRepo(env.repo, repo))
    .sort((a, b) => (a.env.order ?? Infinity) - (b.env.order ?? Infinity) || a.at - b.at)
    .map(({ env }) => env)
}

/** The environment a deploy to this one comes from: the one before it in its repo. */
export function environmentBefore(state: Pick<WorkState, 'environments'>, env: Pick<Environment, 'id' | 'repo'>): Environment | undefined {
  const all = repoEnvironments(state, env.repo)
  return all[all.findIndex((e) => e.id === env.id) - 1]
}

/** What Promote would put on an environment: the one before it's version, when it has a deploy workflow and differs. */
export function promotion(state: Pick<WorkState, 'environments'>, env: Environment): { from: Environment; version: string } | undefined {
  const from = environmentBefore(state, env)
  if (!env.deploy || !from || !from.version || from.version === env.version || env.state === 'deploying') return undefined
  return { from, version: from.version }
}

/**
 * The repos a binder's delivery follows: its own, those its agents work in, its agents' own, and those its pull requests
 * are in. Each once, as it was first written.
 */
export function deliveryRepos(state: Pick<WorkState, 'agents' | 'pulls'> & { binders: { repo?: string; repos?: string[] }[] }): string[] {
  const all = [
    ...state.binders.flatMap((b) => binderRepos(b)),
    ...state.agents.filter((a) => !a.revoked).flatMap((a) => a.repos),
    ...state.pulls.map((p) => p.repo),
  ].filter(Boolean)
  return all.filter((r, i) => all.findIndex((x) => sameRepo(x, r)) === i)
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
  folderRules?: FolderRule[]
  /** What brings things in from outside (shared/listen.ts). Missing from logs written before there were any. */
  listeners?: Listener[]
  noteWork?: NoteWork[]
  /** Cards deleted in the last 30 days, oldest first: the hub's, never in what a browser holds (shared/light.ts). */
  trashedCards?: TrashedCard[]
}

/** A card deleted, whole with its activity, with who deleted it and when: it can be put back until it's emptied from the trash. */
export interface TrashedCard {
  card: Card
  /** A person's login, an agent's name, or "hub". */
  by: string
  at: string
}

/** The card as it's put back: in its stage, held by no agent, and a card that was being worked waiting in Ready. */
export function cardPutBack(card: Card, by: string, at: string): Card {
  const { agentId: _holder, permission: _permission, doing: _doing, progress: _progress, ...rest } = card
  return withActivity({ ...rest, stage: card.stage === 'working' ? 'ready' : card.stage }, { at, by, kind: 'moved', text: 'Put back from the trash' })
}

export const emptyWork = (): WorkState => ({ agents: [], cards: [], proposals: [], pulls: [], changeSets: [], environments: [], runs: [], chats: [], schedules: [], briefs: [], folderRules: [], noteWork: [] })

/** How many messages a chat keeps; older ones are dropped. */
export const chatKept = 200

export type WorkChange =
  | { type: 'agent.put'; agent: Agent }
  | { type: 'agent.seen'; id: string; at: string }
  | { type: 'agent.revoke'; id: string }
  /** `restored`: the hub put it back from the trash, which only it says, so the trash lets go of it. */
  | { type: 'card.put'; card: Card; restored?: { by: string; at: string } }
  | { type: 'card.update'; id: string; fields: Partial<Omit<Card, 'id' | 'activity'>>; activity?: Activity }
  /** An agent taking a card: only the first one applied gets it, so two agents asking at once never both do. */
  | { type: 'card.claim'; id: string; agentId: string; at: string }
  | { type: 'card.release'; id: string; agentId: string; at: string; why: string; failed?: boolean }
  | { type: 'card.activity'; id: string; activity: Activity }
  /** `by` and `at` are the hub's, stamped on as it's written: with them, the card goes to the trash instead of nowhere. */
  | { type: 'card.delete'; id: string; by?: string; at?: string }
  | { type: 'proposal.put'; proposal: Proposal }
  | { type: 'proposal.update'; id: string; fields: Partial<Pick<Proposal, 'state' | 'cardId' | 'meantFor' | 'claim' | 'rule'>> }
  /** A proposal accepted: only the first counts, and under a rule, only up to its limit for the note. */
  | { type: 'proposal.take'; id: string; claim: string; rule?: string; limit?: number }
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
  /** A schedule's time taken: only the first for each `due`, and never one before it, so a run fires once however many hubs share the log. */
  | { type: 'schedule.fire'; id: string; due: string; claim: string; at: string }
  /** What came of a firing, kept with the schedule. */
  | { type: 'schedule.ran'; id: string; fields: Partial<Omit<Schedule, 'id' | 'runs'>>; run: ScheduleRun }
  | { type: 'rule.put'; rule: FolderRule }
  | { type: 'rule.delete'; id: string }
  | { type: 'listener.put'; listener: Listener }
  | { type: 'listener.delete'; id: string }
  | { type: 'note.work'; noteId: string; fields: Partial<Omit<NoteWork, 'noteId' | 'distill'>> }
  /** A note's automatic Distill taken: only the first counts, or one taking over from a `replaces` that never made its card. */
  | { type: 'note.distill'; noteId: string; rule: string; claim: string; at: string; cardId: string; made?: boolean; replaces?: string }
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
/** How many runs in a row may fail before the card waits for a person instead of going back to Ready. */
export const stoppedTwice = 2

/** What a card stopped by failing runs asks, in Blocked: why, and that any answer puts it back in Ready. */
export const stoppedQuestion = (why: string) => {
  const reason = why.trim().slice(0, 600)
  return `It stopped twice without finishing: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} Fix what’s wrong, then answer here and it goes back to Ready.`
}

const withActivity = (card: Card, activity: Activity): Card => ({ ...card, activity: [...card.activity, activity].slice(-activityKept), updatedAt: activity.at })

/** What stands in for a finished card's detail on a browser that hasn't opened it: how its debrief and Challenge stood. */
export interface CardLeft {
  debrief?: Debrief['state']
  challenge?: Challenge['state']
}

/** How long after it finished a card's detail stops being sent with a browser's first load. */
export const oldAfterMs = 14 * 86_400_000

const underWay = (state: 'asked' | 'writing' | 'reviewing' | 'done' | 'failed' | undefined) => state === 'asked' || state === 'writing' || state === 'reviewing'

/**
 * A card whose detail a list no longer needs: it's live, it was last changed more than two weeks ago, and nothing in it
 * waits on a person or is under way (no question, no permission, no finding still open, no debrief or Challenge being
 * written). A date that isn't one, as in sample data, is never old.
 */
export const isOld = (card: Card, now: number) =>
  card.stage === 'live' && now - Date.parse(card.updatedAt) > oldAfterMs && !card.needsYou && !card.permission &&
  !card.challenge?.findings?.some((finding) => !finding.outcome) && !underWay(card.debrief?.state) && !underWay(card.challenge?.state)

/** A card as a browser holds it before it's opened: what a list shows of it, and what stands in for the rest. */
export function leftCard(card: Card): Card {
  if (card.left) return card
  const { plan: _plan, worktree: _worktree, debrief, challenge, permission: _permission, ...rest } = card
  return {
    ...rest,
    brief: '',
    doneWhen: '',
    activity: [],
    activityMore: (card.activityMore ?? 0) + card.activity.length,
    left: { ...(debrief ? { debrief: debrief.state } : {}), ...(challenge ? { challenge: challenge.state } : {}) },
  }
}

/**
 * A card a browser holds without its detail, after a change to it: still without, what stands in following the change.
 * A card written whole says how its debrief and Challenge stand by itself; a change to some of it leaves the rest of what
 * stands in as it was, and takes away what the change took away.
 */
function keptLeft(was: Card, now: Card, change: WorkChange): Card {
  const light = leftCard({ ...now, left: undefined })
  if (change.type === 'card.put') return light
  const left = { ...was.left, ...light.left }
  const said: object = change.type === 'card.update' ? change.fields : {}
  if ('debrief' in said && !now.debrief) delete left.debrief
  if ('challenge' in said && !now.challenge) delete left.challenge
  return { ...light, left }
}

/**
 * A change applied. On a browser, a card held without its detail stays that way whatever the change brings (a brief, a
 * debrief, a line of activity): its detail is asked for when the card is opened. The hub's cards are never held so.
 */
export function applyWork<S extends WorkState>(state: S, change: WorkChange): S {
  const next = applyWhole(state, change)
  if (next.cards === state.cards) return next
  let before: Map<string, Card> | undefined
  let cards: Card[] | undefined
  next.cards.forEach((card, at) => {
    const was = state.cards[at]?.id === card.id ? state.cards[at] : (before ??= new Map(state.cards.map((c) => [c.id, c]))).get(card.id)
    if (!was?.left || was === card) return
    cards ??= next.cards.slice()
    cards[at] = keptLeft(was, card, change)
  })
  return cards ? { ...next, cards } : next
}

function applyWhole<S extends WorkState>(state: S, change: WorkChange): S {
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
    case 'card.put': {
      const trashed = change.restored ? state.trashedCards?.filter((t) => t.card.id !== change.card.id) : state.trashedCards
      return { ...state, cards: upsert(state.cards, { ...change.card, stage: current(change.card.stage) }), ...(trashed ? { trashedCards: trashed } : {}) }
    }
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
          if (c.meantFor && c.meantFor !== change.agentId && pinned(state, c)) return c
          const agent = state.agents.find((a) => a.id === change.agentId)
          return withActivity({ ...c, agentId: change.agentId, stage: 'working', progress: 0 }, { at: change.at, by: change.agentId, kind: 'claimed', text: `${agent?.name ?? 'An agent'} took it` })
        }),
      }
    case 'card.release':
      return {
        ...state,
        cards: state.cards.map((c) => {
          if (c.id !== change.id || c.agentId !== change.agentId) return c
          // A run that failed is counted; the second one in a row stops the card, in Blocked, for a person to look at.
          const times = change.failed ? (c.stopped?.times ?? 0) + 1 : 0
          const stopped = change.failed ? { why: change.why, at: change.at, times } : c.stopped
          const waits = times >= stoppedTwice
          const back = { ...c, agentId: undefined, stage: waits ? 'blocked' as const : 'ready' as const, doing: undefined, progress: undefined, permission: undefined, ...(stopped ? { stopped } : {}), ...(waits ? { needsYou: stoppedQuestion(change.why) } : {}) }
          return withActivity(back, { at: change.at, by: change.agentId, kind: 'released', text: change.why })
        }),
      }
    case 'card.activity':
      return { ...state, cards: state.cards.map((c) => (c.id === change.id ? withActivity(c, change.activity) : c)) }
    case 'card.delete': {
      const card = state.cards.find((c) => c.id === change.id)
      if (!card) return state
      // Stamped by the hub, it goes to the trash, whole; without a stamp (from before there was a trash, or a client's own
      // copy of the change) it's just removed, so a log read again from its start doesn't fill the trash.
      const trashed = change.at ? [...(state.trashedCards ?? []).filter((t) => t.card.id !== card.id), { card, by: change.by ?? 'hub', at: change.at }].slice(-trashKept) : state.trashedCards
      return { ...state, cards: state.cards.filter((c) => c.id !== change.id), ...(trashed ? { trashedCards: trashed } : {}) }
    }
    case 'proposal.put':
      return { ...state, proposals: upsert(state.proposals, change.proposal) }
    case 'proposal.update':
      return { ...state, proposals: patch(state.proposals, change.id, change.fields) }
    case 'proposal.take': {
      const proposal = state.proposals.find((p) => p.id === change.id)
      if (proposal?.state !== 'new') return state
      if (change.rule && change.limit !== undefined && state.proposals.filter((p) => p.noteId === proposal.noteId && p.rule === change.rule).length >= change.limit) return state
      return { ...state, proposals: patch(state.proposals, change.id, { state: 'accepted', claim: change.claim, ...(change.rule ? { rule: change.rule } : {}) }) }
    }
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
    case 'schedule.fire':
      return { ...state, schedules: (state.schedules ?? []).map((x) => (x.id === change.id && (!x.lastDue || change.due > x.lastDue) ? { ...x, lastDue: change.due, lastClaim: change.claim, lastRun: change.at } : x)) }
    case 'schedule.ran':
      return { ...state, schedules: (state.schedules ?? []).map((x) => (x.id === change.id ? { ...merge(x, change.fields), runs: [change.run, ...(x.runs ?? [])].slice(0, runsKept) } : x)) }
    case 'rule.put':
      return { ...state, folderRules: upsert(state.folderRules ?? [], change.rule) }
    case 'rule.delete':
      return { ...state, folderRules: (state.folderRules ?? []).filter((r) => r.id !== change.id) }
    case 'listener.put':
      return { ...state, listeners: upsert(state.listeners ?? [], change.listener) }
    case 'listener.delete':
      return { ...state, listeners: (state.listeners ?? []).filter((l) => l.id !== change.id) }
    case 'note.work': {
      const was = (state.noteWork ?? []).find((w) => w.noteId === change.noteId) ?? { noteId: change.noteId }
      return { ...state, noteWork: [...(state.noteWork ?? []).filter((w) => w.noteId !== change.noteId), merge(was, change.fields)] }
    }
    case 'note.distill': {
      const was = (state.noteWork ?? []).find((w) => w.noteId === change.noteId) ?? { noteId: change.noteId }
      if (was.distill && was.distill.claim !== change.claim && was.distill.claim !== change.replaces) return state
      const distill = { rule: change.rule, claim: change.claim, at: change.at, cardId: change.cardId, ...(change.made ? { made: true } : {}) }
      return { ...state, noteWork: [...(state.noteWork ?? []).filter((w) => w.noteId !== change.noteId), { ...was, distill }] }
    }
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
/**
 * Work that went out with nobody reading it, which only the agent a person chose may take: a rule's Distill and what it
 * accepted, and a run that writes into a folder. If that agent goes, it waits for a person, rather than being open to all.
 */
export function pinned(state: { schedules?: Schedule[] }, card: Pick<Card, 'distillRule' | 'acceptedBy' | 'scheduleId' | 'madeUnread'>) {
  return !!card.distillRule || !!card.acceptedBy || !!card.madeUnread || (!!card.scheduleId && !!(state.schedules ?? []).find((s) => s.id === card.scheduleId)?.folderId)
}

/**
 * The work an agent has out with nobody having read it, up to a person's review of it. What it asks for meanwhile can come
 * from what it read, so what it suggests stays a suggestion.
 */
export function unreadWorkOf(state: { schedules?: Schedule[]; cards: Card[] }, agentId: string) {
  return state.cards.find((c) => c.agentId === agentId && (c.stage === 'working' || c.stage === 'blocked' || c.stage === 'review') && pinned(state, c))
}

/** The rule a folder's notes go by: its own, or the nearest one above it that's on. */
export function ruleFor(state: WorkState & { folders: { id: string; parentId?: string }[] }, folderId?: string): FolderRule | undefined {
  const seen = new Set<string>()
  for (let id = folderId; id && !seen.has(id); id = state.folders.find((f) => f.id === id)?.parentId) {
    seen.add(id)
    const rule = (state.folderRules ?? []).find((r) => r.folderId === id && r.enabled)
    if (rule) return rule
  }
  return undefined
}

/** Whether a note's work gets a change set of its own: the note's say, then its folder's rule. */
export function changeSetOf(state: WorkState & { folders: { id: string; parentId?: string }[] }, note: { id: string; folderId?: string }): 'shared' | 'own' {
  return (state.noteWork ?? []).find((w) => w.noteId === note.id)?.changeSet ?? ruleFor(state, note.folderId)?.changeSet ?? 'shared'
}

export function resumeFor(state: WorkState, agent: Agent, busy: string[] = []): Card | undefined {
  // A card it holds, not asking anything, where a person had the last word: an answer, a comment such as a nudge, or
  // moving it back from blocked.
  const people = (by: string) => by !== 'hub' && !state.agents.some((a) => a.id === by)
  return state.cards.find((c) => {
    if (c.agentId !== agent.id || c.stage !== 'working' || c.needsYou || busy.includes(c.id)) return false
    // Someone asking for its debrief or a Challenge isn't talking to the agent working it. Read from the end, as the last
    // line is the one wanted and a card keeps hundreds.
    let last: Activity | undefined
    for (let i = c.activity.length - 1; i >= 0 && !last; i--) if (c.activity[i].kind !== 'debrief' && c.activity[i].kind !== 'challenge' && c.activity[i].kind !== 'message') last = c.activity[i]
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
  return { stage, needsYou: undefined, permission: undefined, doing: undefined, stopped: undefined, ...(keep ? {} : { agentId: undefined, progress: undefined }) }
}

/** What a card is waiting on from a person, in a line: an agent's question, or a permission nobody has answered yet. */
export const asksOf = (card: Pick<Card, 'needsYou' | 'permission'>) =>
  card.needsYou ?? (card.permission && !card.permission.answer ? `Allow ${card.permission.tool}: ${card.permission.what}` : undefined)

export function nextFor(state: WorkState & { binders: { id: string; repo?: string }[] }, agent: Agent, busy: string[] = []): Card | undefined {
  // The cards it could take, found first and on their own: on a board of thousands few are ready, and everything else
  // the board has to say is looked up only for these.
  const open = state.cards.filter((c) => c.stage === 'ready' && !c.agentId && !busy.includes(c.id) && mayTake(state, agent, c))
  if (!open.length) return undefined
  const names = new Set(open.map((c) => c.id))
  const waitedOn = new Set(open.flatMap((c) => c.waitsFor))
  // One pass over the board for the two things asked of the rest of it: which of these were split into parts, and where
  // the cards they wait on stand.
  const split = new Set<string>()
  const finished = new Map<string, boolean>()
  for (const c of state.cards) {
    if (c.parent && names.has(c.parent)) split.add(c.parent)
    if (waitedOn.has(c.id)) finished.set(c.id, !!finished.get(c.id) || c.stage === 'review' || c.stage === 'live')
  }
  // A card split into parts isn't offered whole, however far along the parts are: it follows them. A wait for a card that
  // isn't on the board (deleted, or never a card's id) holds nothing up.
  const meant = (c: Card) => Number(c.meantFor === agent.id)
  let best: Card | undefined
  for (const c of open) {
    if (split.has(c.id) || !c.waitsFor.every((w) => finished.get(w) ?? true)) continue
    if (!best || meant(c) > meant(best) || (meant(c) === meant(best) && c.createdAt.localeCompare(best.createdAt) < 0)) best = c
  }
  return best
}

/**
 * Whether an agent may take a card, as the board offers them: one meant for it, whatever its binders and repos (a
 * person's to give), or one meant for nobody in a binder and repo it works in.
 */
export function mayTake(state: { binders: { id: string; repo?: string; repos?: string[] }[]; agents?: { id: string; revoked?: boolean }[]; schedules?: Schedule[] }, agent: Pick<Agent, 'id' | 'binders' | 'repos'>, card: Pick<Card, 'meantFor' | 'binderId' | 'distillRule' | 'acceptedBy' | 'scheduleId'>) {
  const meant = meantForNow(state, card)
  if (meant) return meant === agent.id
  if (card.meantFor && pinned(state, card)) return false
  const binder = state.binders.find((b) => b.id === card.binderId)
  if (!worksIn(agent, card.binderId, state.binders)) return false
  const theirs = binderRepos(binder)
  return !agent.repos.length || !theirs.length || agent.repos.some((r) => theirs.some((t) => sameRepo(r, t)))
}

/** A binder's repos: the one its cards are kept in, and those its agents work in. */
export function binderRepos(binder: { repo?: string; repos?: string[] } | undefined) {
  const all = [...(binder?.repo ? [binder.repo] : []), ...(binder?.repos ?? [])]
  return all.filter((r, i) => all.findIndex((x) => sameRepo(x, r)) === i)
}

/**
 * The repos an agent may work in: those it's limited to; or else, when every binder it works in names its repos, all
 * of those; or else any (an empty list).
 */
export function agentRepos(agent: Pick<Agent, 'repos' | 'binders'>, binders: { id: string; repo?: string; repos?: string[] }[]) {
  if (agent.repos.length) return agent.repos
  const mine = binders.filter((b) => worksIn(agent, b.id, binders))
  if (!mine.length || mine.some((b) => !b.repos?.length)) return []
  return binderRepos({ repos: mine.flatMap((b) => binderRepos(b)) })
}

/**
 * Why an agent can't be limited to these repos, if it can't: each must be one of its binders' repos, when every
 * binder it works in names them. Undefined when it can.
 */
export function outsideBinders(repos: string[], agent: Pick<Agent, 'binders'>, binders: { id: string; name: string; repo?: string; repos?: string[] }[]) {
  const scope = agentRepos({ repos: [], binders: agent.binders }, binders)
  if (!scope.length) return undefined
  const outside = repos.filter((r) => !scope.some((s) => sameRepo(s, r)))
  if (!outside.length) return undefined
  return `${outside.join(', ')} ${outside.length === 1 ? 'isn’t' : 'aren’t'} among its binder’s repos: add ${outside.length === 1 ? 'it' : 'them'} to the binder in Settings → GitHub first, or pick from ${scope.length === 1 ? scope[0] : 'its repos'}.`
}

/**
 * Whether an agent works in a binder: every binder, unless it's limited to some that still exist. A limit naming only
 * binders gone since (projects folded into their binder, say) limits nothing, rather than leaving it nothing to do.
 */
export function worksIn(agent: { binders: string[] }, binderId: string, binders: { id: string }[]) {
  const live = agent.binders.filter((id) => binders.some((b) => b.id === id))
  return !live.length || live.includes(binderId)
}

/** Whether a card goes by this name: its GitHub issue as #12, or its Jira issue's key. */
export const goesBy = (card: Pick<Card, 'jira' | 'issue'>, name: string) => (!!card.issue && `#${card.issue.number}` === name.trim()) || card.jira?.key === name.trim().toUpperCase()

/** The number a card goes by: its Jira issue's, or its GitHub issue's. */
export const cardNumber = (card: Pick<Card, 'jira' | 'issue'>) => card.jira?.key ?? (card.issue ? `#${card.issue.number}` : undefined)
