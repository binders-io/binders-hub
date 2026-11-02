import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mcpServer, StreamReader } from './stream.ts'
import { blastRadius, blastSummary } from './blast.ts'
import { behindBy, briefCheckout, briefDue, briefPrompt, briefSection, changesSince, type BriefJSON, type BriefRead } from './briefs.ts'
import type { BlastRadius, Effort } from '../../shared/changeSet.ts'
import { runnerVersion, toolInfo, tools } from '../../shared/agents.ts'
import { Terminals, type Started } from './terminal.ts'
import { briefMost, defaultRunner, type RunnerSettings } from '../../shared/work.ts'

// The Binders runner: stays connected to the hub as one agent, so work reaches it within a second, and for each card
// starts the agent's command line headless in the workspace, with Binders' MCP tools attached. It relays what the agent
// does to the card as it goes, and never leaves a card stuck: an agent that stops without finishing, crashes or runs
// too long puts it back with why. An agent that asks a person and stops is started again on that card with the answer.

const run = promisify(execFile)

// The runner's files are never in the system's temp folder, which hardened machines lock down and agents' own sandboxes
// may not reach. What the runner alone (or the agent's tool) reads goes in ~/.binders (BINDERS_HOME); what the agent
// writes goes in a .binders folder in the folder it works in, which ignores itself in git.
const runnerHome = () => process.env.BINDERS_HOME ?? join(homedir(), '.binders')

/** A file of the runner's own, in ~/.binders/run. */
async function ownFile(name: string) {
  const dir = join(runnerHome(), 'run')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return join(dir, name)
}

/**
 * A file for the agent to write, in the folder it runs in (so a tool that keeps to its own folder may write it): in its
 * .binders folder, which ignores itself in git, so nothing in it is ever committed or counted as part of the work.
 */
export async function agentFile(dir: string, name: string) {
  const folder = join(dir, '.binders')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined)
  return join(folder, name)
}

/**
 * A checkout's copy of the permissions its person gave Claude Code in their own folder of the repo (each "don't ask
 * again", kept in .claude/settings.local.json, which git ignores): a worktree is a new folder without it, so a run
 * there would be refused what the person's own sessions in that repo may do. Left alone when the checkout has one.
 */
export async function carryClaudeSettings(fromDirs: string[], to: string) {
  const target = join(to, '.claude', 'settings.local.json')
  if (existsSync(target)) return false
  for (const from of fromDirs) {
    const text = await readFile(join(from, '.claude', 'settings.local.json'), 'utf8').catch(() => '')
    if (!text) continue
    await mkdir(join(to, '.claude'), { recursive: true })
    await writeFile(target, text, { mode: 0o600 })
    // Never part of the work: kept out of git here, unless git ignores it already.
    const ignored = await run('git', ['-C', to, 'check-ignore', '-q', '.claude/settings.local.json']).then(() => true, () => false)
    if (!ignored) {
      const exclude = await run('git', ['-C', to, 'rev-parse', '--git-path', 'info/exclude']).then((r) => resolve(to, r.stdout.trim()), () => '')
      if (exclude) {
        await mkdir(join(exclude, '..'), { recursive: true })
        const before = await readFile(exclude, 'utf8').catch(() => '')
        await writeFile(exclude, `${before}${before && !before.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`)
      }
    }
    return true
  }
  return false
}

/**
 * The name of Binders' server in an enterprise MCP config, when the config lists one: by its address (this hub's
 * /mcp) or by the name the README gives it. Claude Code then has Binders' tools from the config itself.
 */
export async function managedBinders(file: string, hubUrl: string) {
  const text = await readFile(file, 'utf8').catch(() => '')
  if (!text) return undefined
  let servers: Record<string, { url?: string }> = {}
  try {
    servers = (JSON.parse(text) as { mcpServers?: Record<string, { url?: string }> }).mcpServers ?? {}
  } catch {
    return undefined
  }
  const ours = `${hubUrl.replace(/\/$/, '')}/mcp`.toLowerCase()
  return Object.entries(servers).find(([name, server]) => server?.url?.replace(/\/$/, '').toLowerCase() === ours || name === mcpServer)?.[0]
}

/**
 * Stops an agent and everything it started: its process group where there is one (a command run through a shell
 * leaves the program under the shell running when only the shell is stopped, as on Linux), else the process itself.
 */
function stopTree(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (child.pid && process.platform !== 'win32') return void process.kill(-child.pid, signal)
  } catch {
    // Gone already, or not a group: the process itself, below.
  }
  child.kill(signal)
}

/** The GitHub repo a folder is a clone of (owner/name, from its origin), if it is one. */
async function repoOf(dir: string) {
  const origin = await run('git', ['-C', dir, 'remote', 'get-url', 'origin']).then((r) => r.stdout.trim(), () => '')
  return /^(?:https?:\/\/[^/]+\/|[\w.-]+@[^:]+:|ssh:\/\/[\w.-]+@[^/]+\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin)?.[1]
}

export type { RunnerSettings }

/** The hub's token for a card's repo, for its run. */
interface RepoToken {
  repo: string
  token: string
  expires_at: string
  github: string
  /** Whose token it is (the agent's owner's, or the app's), and who commits are by. */
  as?: 'owner' | 'app'
  author?: { name: string; email: string }
}

interface CardJSON {
  id: string
  title: string
  stage: string
  brief?: string
  done_when?: string
  holder?: string
  /** The holder's id, from a hub that says it: a rename leaves it as it was. */
  holder_id?: string
  /** The repo its work is in: its project's. */
  repo?: string
  needs_you?: string
  resume?: boolean
  note?: { id: string; title: string }
  quote?: string
  conversation?: { at?: string; by: string; from_agent?: boolean; kind: string; text: string }[]
  /** Cards it waits for, and how far each has got (review: its pull request is open, not merged yet). */
  waits_for?: { id: string; title?: string; stage?: string }[]
}

interface ChatJSON {
  kind: 'chat'
  id: string
  note?: { id: string; title: string; binder?: string }
  messages: { from: string; at: string; text: string }[]
}

interface DebriefJSON {
  kind: 'debrief'
  id: string
  title: string
  stage: string
  /** How hard to reason over it, as the person asked (or the hub picked by its size). */
  effort?: Effort
  asked_by?: string
}

interface ChallengeJSON {
  kind: 'challenge'
  id: string
  title: string
  stage: string
  effort?: Effort
  asked_by?: string
}

/** What get_challenge_set gives a reviewer: the Change Set without its authors' plan and log. */
interface ChallengeSetJSON {
  brief: string
  doneWhen: string
  done_when_points: string[]
  source: string
  pull?: { repo: string; number: number; title: string; url: string; branch: string; checks: { name: string; state: string }[] }
  worktree?: { branch: string }
  note?: { title?: string; quote?: string }
  files: { path: string; added: number; removed: number; diff: string }[]
}

interface RepliesJSON {
  kind: 'replies'
  id: string
  title: string
  stage: string
  asked_by?: string
  findings?: number
}

/** A card's Challenge as get_challenge gives it, as much as a reply's prompt needs. */
interface ChallengeJSONRead {
  summary?: string
  findings?: { id: string; kind: string; file: string; line: number; what: string; confidence: string; severity: string; fix?: string }[]
}

/** The author's replies to a Challenge's findings, as reply_to_findings takes them. */
interface FindingReplies {
  replies: { finding: string; verdict: string; why: string }[]
}

/** A Challenge's findings, as send_challenge takes them. */
interface ChallengeFindings {
  summary: string
  findings: { kind: string; file: string; line: number; what: string; confidence: string; severity: string; fix?: string }[]
}

/** A card's Change Set as get_change_set gives it, as much as a debrief's prompt needs. */
interface ChangeSetJSON {
  brief: string
  doneWhen: string
  done_when_points: string[]
  source: string
  pull?: { repo: string; number: number; title: string; url: string; checks: { name: string; state: string }[] }
  note?: { title?: string; quote?: string }
  files: { path: string; added: number; removed: number; diff: string }[]
  log: { by: string; kind: string; tool?: string; text: string; result?: string }[]
}

/** A debrief's sections, as send_debrief takes them. */
interface DebriefSections {
  does: string
  changes: { area: string; what: string }[]
  against: { point: string; mark: string; where: string }[]
  look_at: string[]
  try_it: string
  test_plan?: { title: string; point?: string; setup?: string; steps: string[]; expect: string; risk?: string }[]
}

export interface RunnerOptions {
  hubUrl: string
  token: string
  workspace: string
  /** Shown with the agent as where it runs. */
  machine?: string
  log?: (line: string) => void
  /** How long each wait for work lasts, in seconds (at most 50). */
  waitSeconds?: number
  /** Whether --workspace was given; if not, the agent's runner settings may name it. */
  workspaceGiven?: boolean
  /** Where cards' worktrees go (~/.binders/worktrees). */
  worktreesDir?: string
  /** Minutes without a word from the agent before a run is stopped as stuck, unless its settings say otherwise (15). */
  idleMinutes?: number
  /** The runner's own file, when it may replace itself with a newer one from the hub and ask to be started again. */
  selfUpdate?: string
  /** Where an enterprise's managed MCP config would be (this platform's place); tests point it elsewhere. */
  managedMcp?: string
  /**
   * The managed config lists Binders' server (as binders_hub), so Claude Code has Binders' tools from it and the runner
   * adds no config of its own (BINDERS_MANAGED_MCP=allowed).
   */
  managedMcpAllowed?: boolean
  /** Claude Code's managed settings files, to see whether they turn full access off (where Claude Code keeps them, unless set). */
  managedSettings?: string[]
}

/** Whether version a is newer than b ("0.6.10" than "0.6.9"). */
export const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map((n) => Number(n) || 0))
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** How often, at most, a card's worktree diff is sent while the agent works. */
const diffEvery = 60_000
/** The most of a diff sent at once; the hub keeps less still. */
const diffMost = 4_000_000

/**
 * What a card's worktree changes: everything against the commit its branch left the workspace at, committed or not,
 * new files too. Undefined when the folder isn't a git worktree.
 */
export async function worktreeDiff(dir: string, workspace: string): Promise<{ branch: string; base: string; diff: string } | undefined> {
  const git = (args: string[], cwd = dir) => run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout)
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim()
  if (!branch) return undefined
  const from = (await git(['rev-parse', 'HEAD'], workspace).catch(() => '')).trim()
  const base = (from ? await git(['merge-base', 'HEAD', from]).catch(() => '') : '').trim() || (await git(['rev-parse', 'HEAD'])).trim()
  let diff = await git(['diff', '--no-color', '--no-ext-diff', base])
  // New files git doesn't follow yet: `git diff --no-index` says it found a difference by exiting 1.
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  for (const file of untracked.slice(0, 200)) {
    if (diff.length > diffMost) break
    diff += await git(['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file]).catch((error: { stdout?: string }) => error.stdout ?? '')
  }
  return { branch, base, diff: diff.slice(0, diffMost) }
}

/**
 * A checkout of a card's work for a Challenge's reviewer to read, apart from where its author worked: the pull
 * request's head, fetched; else the author's worktree as it stands, committed or not, new files too, snapshotted
 * without touching its index or branches. Not the author's own folder, so nothing kept beside it (notes, an agent's
 * memory of that folder) reaches the reviewer. Undefined when neither can be had.
 */
export async function reviewCheckout(workspace: string, own: string | undefined, pull: { repo: string; branch: string } | undefined, into: string): Promise<{ dir: string; remove: () => Promise<void> } | undefined> {
  const git = (args: string[], cwd: string, env?: Record<string, string>) => run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined }).then((r) => r.stdout.trim())
  const add = async (repo: string, commit: string) => {
    await git(['worktree', 'add', '--detach', '--quiet', into, commit], repo)
    return { dir: into, remove: () => git(['worktree', 'remove', '--force', into], repo).then(() => {}, () => rm(into, { recursive: true, force: true })) }
  }
  // The pull request's branch, from the workspace's origin when that's the pull request's repo.
  const origin = pull ? await git(['remote', 'get-url', 'origin'], workspace).catch(() => '') : ''
  if (pull && origin.replace(/\.git$/, '').toLowerCase().endsWith(pull.repo.toLowerCase())) {
    const fetched = await git(['fetch', '--quiet', 'origin', pull.branch], workspace).then(() => git(['rev-parse', 'FETCH_HEAD'], workspace), () => '')
    if (fetched) return add(workspace, fetched).catch(() => undefined)
  }
  if (!own || !(await git(['rev-parse', '--git-dir'], own).catch(() => ''))) return undefined
  const index = await ownFile(`review-index-${randomBytes(6).toString('hex')}`)
  try {
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Binders', GIT_AUTHOR_EMAIL: 'binders@localhost', GIT_COMMITTER_NAME: 'Binders', GIT_COMMITTER_EMAIL: 'binders@localhost' }
    await git(['read-tree', 'HEAD'], own, env)
    await git(['add', '-A'], own, env)
    const tree = await git(['write-tree'], own, env)
    const commit = await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'The work as a Challenge reads it'], own, env)
    return await add(own, commit)
  } catch {
    return undefined
  } finally {
    await rm(index, { force: true })
  }
}

const short = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Why an agent exited with an error: what it said went wrong, else its last line of errors. Lines about another MCP
 * server of the user's (one that wants a sign-in, say) are left out: the agent carries on without it, so they're not why.
 */
export function stoppedWith(ran: { exit: { code: number | null }; errors: string; reader: StreamReader; cutOff?: string; managedMcp?: boolean }, hubUrl: string) {
  if (ran.cutOff) return ran.cutOff
  if (ran.managedMcp) return 'Claude Code on this machine has an enterprise MCP config, which doesn’t let Binders add its MCP server. Its runner works without it from now on, reporting for it: try again.'
  const host = new URL(hubUrl).host
  const line = ran.errors.trim().split('\n').reverse().find((l) => l.trim() && (!/\brmcp::/.test(l) || l.includes(host)))
  const why = (ran.reader.summary.error ?? line?.trim())?.replace(/\.$/, '')
  return `The agent stopped with exit code ${ran.exit.code}${why ? `: ${why}` : ''}.`
}

/**
 * Where an enterprise's managed MCP config is on this machine, when it has one: with it, Claude Code takes no MCP servers
 * but the ones it lists, and refuses the one the runner adds for each run (Binders').
 */
export function managedMcpPath(platform: NodeJS.Platform = process.platform) {
  return platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-mcp.json'
    : platform === 'win32' ? 'C:\\ProgramData\\ClaudeCode\\managed-mcp.json'
      : '/etc/claude-code/managed-mcp.json'
}

/** Claude Code saying no to Binders' MCP server because an enterprise MCP config manages its servers. */
/**
 * Binders actions an agent without Binders' tools may ask the runner to take for it, as JSON at the end of its reply:
 * what a card may need beyond its code (Distill's proposals, say). The runner takes them with the agent's own token,
 * so an agent can do no more this way than it could with the tools.
 */
const proxied: Record<string, string> = {
  propose_work_items: '{"note": "<the note’s id>", "items": [{"title": "…", "quote": "the note’s exact words it came from", "brief": "…", "done_when": "…", "size": "S | M | L", "meant_for": "an agent’s name, optional"}]}',
  create_task: '{"binder": "<binder id or name>", "title": "…", "brief": "…", "done_when": "…", "size": "S | M | L"}',
  append_to_note: '{"id": "<the note’s id>", "text": "Markdown to add at its end"}',
  ask: '{"question": "what a person has to decide or answer before the card can be finished"}: the card waits in Blocked for them, rather than being finished',
}

/** The Binders actions at the end of an agent's reply, between <binders-actions> and </binders-actions> (the last such block), and the reply without them. */
export function actionsFromReply(text: string) {
  const blocks = [...text.matchAll(/<binders-actions>\s*([\s\S]*?)\s*<\/binders-actions>/g)]
  const last = blocks.at(-1)
  if (!last) return { actions: [] as { tool: string; args: Record<string, unknown> }[], rest: text }
  let actions: { tool: string; args: Record<string, unknown> }[] = []
  try {
    const parsed = JSON.parse(last[1]) as unknown
    actions = (Array.isArray(parsed) ? parsed : [parsed]).filter((a): a is { tool: string; args: Record<string, unknown> } => !!a && typeof a === 'object' && typeof (a as { tool?: unknown }).tool === 'string' && typeof (a as { args?: unknown }).args === 'object')
  } catch {
    actions = []
  }
  return { actions, rest: (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim() }
}

/**
 * Claude Code's MCP servers, as `claude mcp list` says (its enterprise, user and project ones): each line
 * `name: url (HTTP) - ✓ Connected`.
 */
export function parseMcpList(text: string) {
  return text.split('\n').map((line) => /^\s*([^:\s][^:]*?):\s+(https?:\/\/\S+)/.exec(line)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ name: m[1].trim(), url: m[2] }))
}

/** Every server among them that's a Binders hub's: at this hub's address, or named for Binders, at an /mcp path. */
export function allBindersAmong(servers: { name: string; url: string }[], hubUrl: string) {
  const host = (url: string) => { try { return new URL(url).host.toLowerCase() } catch { return '' } }
  const mcpPath = (url: string) => { try { return /\/mcp\/?$/.test(new URL(url).pathname) } catch { return false } }
  return servers.filter((s) => mcpPath(s.url) && (host(s.url) === host(hubUrl) || /binders/i.test(s.name))).map((s) => s.name)
}

/** The server among them that's this hub's: at its address, or else named for Binders, at an /mcp path. */
export function bindersAmong(servers: { name: string; url: string }[], hubUrl: string) {
  const host = (url: string) => { try { return new URL(url).host.toLowerCase() } catch { return '' } }
  const mcpPath = (url: string) => { try { return /\/mcp\/?$/.test(new URL(url).pathname) } catch { return false } }
  return servers.find((s) => mcpPath(s.url) && host(s.url) === host(hubUrl))?.name
    ?? servers.find((s) => mcpPath(s.url) && /binders/i.test(s.name))?.name
}

/** Where an organization keeps Claude Code's managed settings on each kind of machine. */
export function managedSettingsPaths(platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json']
  return ['/etc/claude-code/managed-settings.json']
}

/**
 * Whether an organization's managed settings turn Claude Code's full access (bypassPermissions) off. Asked for it then,
 * Claude Code falls back to asking before every write, which a run without a person can't answer.
 */
export async function bypassTurnedOff(files = managedSettingsPaths()) {
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (!text) continue
    try {
      if ((JSON.parse(text) as { permissions?: { disableBypassPermissionsMode?: string } }).permissions?.disableBypassPermissionsMode === 'disable') return true
    } catch {
      // Not JSON: Claude Code wouldn't read it either.
    }
  }
  return false
}

/** Without Binders' tools, Claude Code may write the files it's asked for in its .binders folder, and nowhere new. */
const plainEdits = '--allowedTools=Edit(.binders/**),Write(.binders/**)'

/** The most of a note that goes into a chat's prompt; a longer one goes in as a file. */
const noteInPrompt = 40_000

/**
 * A changed note at the end of an agent's reply, between <note> and </note> (the last such block), and the reply
 * without it. So an agent without Binders' tools changes a note without writing a file, which hardened machines and
 * tools' permissions may not let it do.
 */
export function noteFromReply(text: string) {
  const blocks = [...text.matchAll(/<note>\n?([\s\S]*?)\n?<\/note>/g)]
  const last = blocks.at(-1)
  if (!last) return { rest: text }
  return { note: last[1], rest: (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim() }
}

export const refusedByManagedMcp = (text: string) => /cannot dynamically configure MCP servers|enterprise MCP config is present/i.test(text)

/** Claude Code's thinking budget for each reasoning level a person can ask for. */
const thinkingTokens: Record<Effort, number> = { low: 4_000, medium: 12_000, high: 32_000 }

/** Whether a run stopped because its model's output limit cut its answer off. */
export function cutOff(ran: { exit: { code: number | null }; errors: string; reader: StreamReader; timedOut?: boolean }, hubUrl: string) {
  return !!ran.exit.code && !ran.timedOut && /max_output_tokens|max_tokens|output token limit|maximum output tokens/i.test(stoppedWith(ran, hubUrl))
}

export class Runner {
  private options: RunnerOptions
  private client?: Client
  private stopped = false
  /** The agents running now, by the card or chat each works on. */
  private children = new Map<string, ChildProcess>()
  /** The agent's session for each card and chat, to carry on with it after a person answers. */
  private sessions = new Map<string, string>()
  /** The tool whose models were last told to the hub. */
  private modelsFor?: string
  private log: (line: string) => void
  name = ''
  /** The agent's id, which a rename leaves as it was: how the runner knows a card is still its own. */
  private agentId?: string
  /** Whether this agent holds a card, as the hub says: by id, or by name from a hub that doesn't say its id. */
  private holds(card: { holder?: string; holder_id?: string }) {
    if (card.holder_id && this.agentId) return card.holder_id === this.agentId
    return !!card.holder && card.holder.toLowerCase() === this.name.toLowerCase()
  }
  /** This runner's own id, so the hub can tell it from another runner for the same agent. */
  readonly id = process.env.BINDERS_RUNNER_ID ?? randomBytes(6).toString('hex')
  /** This machine has an enterprise MCP config: Claude Code runs without Binders' MCP server. */
  private enterpriseMcp = false
  /** Its enterprise MCP config lists Binders' server: Claude Code has Binders' tools from it, and no config is added. */
  private get managedAllowed() {
    return this.options.managedMcpAllowed ?? (process.env.BINDERS_MANAGED_MCP === 'allowed' || !!this.managedServer)
  }
  /** Binders' server as the enterprise MCP config names it, when it lists it. */
  private managedServer?: string
  /**
   * Other Binders servers in Claude Code's own settings (one set up by hand, with another agent's token, say): kept
   * out of the runs that have the runner's own, so the agent calls Binders as itself and isn't refused.
   */
  private otherBinders: string[] = []
  /**
   * This machine's managed settings turn full access off: Claude Code asked for it runs with edits accepted instead
   * (files in its folder written without asking; the commands it runs follow the organization's rules).
   */
  private bypassOff = false
  /** Where card worktrees and the checkouts reviews and briefs read go. */
  private worktreesRoot() {
    return this.options.worktreesDir ?? process.env.BINDERS_WORKTREES_DIR ?? join(runnerHome(), 'worktrees')
  }
  /** How many cards it takes at once, as it last told the hub. */
  private parallel = 3

  constructor(options: RunnerOptions) {
    this.options = { ...options, workspace: resolve(options.workspace), hubUrl: options.hubUrl.replace(/\/$/, '') }
    this.log = options.log ?? ((line) => console.log(line))
  }

  private async call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.client!.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = result.content[0]?.text ?? ''
    if (result.isError) throw new Error(text)
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  /** Who its token is, as the hub says (the agent's name and id): for setting an agent up on a machine. */
  async identity() {
    await this.connect()
    try {
      return await this.call<{ id?: string; name: string }>('whoami')
    } finally {
      await this.client?.close().catch(() => undefined)
    }
  }

  /**
   * Whether a tool takes Binders' MCP server for its runs on this machine. Claude Code doesn't where an enterprise MCP
   * config manages its servers: it gets the plain prompts, and the runner reports its steps, words and answers for it.
   */
  usesMcp(settings: Pick<RunnerSettings, 'tool'>) {
    return toolInfo(settings.tool).mcp && !(settings.tool === 'claude' && this.enterpriseMcp)
  }

  /** What the runner tells the hub of itself: its version, how many cards it takes, and an enterprise MCP config. */
  private profile(parallel: number) {
    this.parallel = parallel
    return { version: runnerVersion, parallel, id: this.id, ...(this.enterpriseMcp ? { enterprise_mcp: true } : {}), ...(this.bypassOff ? { bypass_off: true } : {}) }
  }

  /** An enterprise MCP config found (its file, or Claude Code refusing Binders' server): said once, here and to the hub. */
  private async enterpriseMcpFound(how: string) {
    if (this.enterpriseMcp) return
    // Claude Code may have Binders' server already, from that config or its own: then it's Binders' tools from it.
    const listed = this.managedServer ?? await claudeBinders(this.options.workspace, this.options.hubUrl)
    if (listed) {
      this.managedServer = listed
      this.log(`${how}, and Claude Code has Binders’ server (${listed}): it uses Binders’ tools from it.`)
      return
    }
    this.enterpriseMcp = true
    this.log(`${how}: Claude Code works here without Binders’ MCP tools, and the runner reports for it. An admin can allow Binders’ server in the managed config instead (see the README).`)
    if (this.client) await this.call('update_profile', { runner: this.profile(this.parallel) }).catch(() => undefined)
  }

  async connect() {
    this.bypassOff = await bypassTurnedOff(this.options.managedSettings)
    if (this.bypassOff) this.log('This machine’s Claude Code policy turns full access off: Claude Code edits files without asking, and the commands it runs follow the policy’s rules.')
    const managedFile = this.options.managedMcp ?? managedMcpPath()
    // An enterprise MCP config that lists Binders' server gives Claude Code its tools: nothing to work around.
    if (existsSync(managedFile)) {
      // Binders' server in the config itself, or among the servers Claude Code says it has (its address may be the
      // hub's public one where this runner reaches it at another).
      this.managedServer = await managedBinders(managedFile, this.options.hubUrl) ?? await claudeBinders(this.options.workspace, this.options.hubUrl)
      if (this.managedServer) this.log(`The enterprise MCP config on this machine lists Binders’ server (${this.managedServer}): Claude Code uses Binders’ tools from it.`)
    }
    // An enterprise MCP config that doesn't list Binders' server (or that this runner can't read) isn't taken to mean
    // Claude Code refuses the runner's: runs start with Binders' tools, and only Claude Code refusing them (said in its
    // own error) turns them off, the run then starting again without them.
    this.client = new Client({ name: 'binders-runner', version: '0.2.0' })
    await this.client.connect(new StreamableHTTPClientTransport(new URL(`${this.options.hubUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${this.options.token}` } } }))
    const me = await this.call<{ id?: string; name: string; runner?: RunnerSettings }>('whoami')
    this.name = me.name
    this.agentId = me.id
    // Not given a workspace, it works where the agent's settings say the code is.
    if (!this.options.workspaceGiven && me.runner?.workspace) this.options.workspace = resolve(me.runner.workspace.replace(/^~(?=\/|$)/, homedir()))
    await this.call('update_profile', { runs_on: `${this.options.machine ?? hostname().replace(/\.local$/, '')} · ${this.options.workspace.replace(homedir(), '~')}` })
    if (me.runner) await this.tellModels(me.runner)
    // Claude Code's own Binders servers, learned beside the work rather than before it (it checks each server it has).
    if ((me.runner?.tool ?? defaultRunner.tool) === 'claude') void this.learnOtherBinders()
    // Its version and how many cards it takes at once, so the app can tell an old runner from a busy one.
    const parallel = Math.max(1, me.runner?.parallel ?? 3)
    const told = await this.call<{ other_runners?: { on?: string; at: string }[] }>('update_profile', { runner: this.profile(parallel) }).catch(() => undefined)
    // Two runners for one agent take the same work, each in its own folder: say so, plainly.
    const others = typeof told === 'object' ? told?.other_runners ?? [] : []
    if (others.length) this.log(`Warning: ${others.length === 1 ? 'another runner is' : `${others.length} other runners are`} already running as ${me.name}${others[0].on ? ` (${others.map((o) => o.on).filter(Boolean).join('; ')})` : ''}. Two runners for one agent take the same work: stop the one you don’t need.`)
    void this.tellAllModels()
    this.log(`Connected to ${this.options.hubUrl} as ${me.name} (runner ${runnerVersion}), working in ${this.options.workspace}, up to ${parallel} card${parallel === 1 ? '' : 's'} at once.`)
  }

  /** Other Binders servers in Claude Code's own settings, to keep out of runs that have the runner's. */
  private async learnOtherBinders() {
    this.otherBinders = allBindersAmong(await claudeServers(this.options.workspace), this.options.hubUrl).filter((name) => name !== mcpServer)
    if (this.otherBinders.length) this.log(`Claude Code here has its own Binders server${this.otherBinders.length === 1 ? '' : 's'} (${this.otherBinders.join(', ')}): its runs use the runner’s, as this agent.`)
  }

  /** The models the agent's tool can use on this machine, for the Agents page to offer by name. */
  private async tellModels(settings: RunnerSettings) {
    if (this.modelsFor === settings.tool) return
    this.modelsFor = settings.tool
    const models = await modelsOf(settings.tool)
    if (models.length) await this.call('update_profile', { models }).catch(() => {})
  }

  /** Every agent tool installed on this machine and its models, so the Agents page can offer them for any agent. */
  private async tellAllModels() {
    const found: Record<string, string[]> = {}
    for (const tool of tools) {
      if (!tool.command) continue
      if (!(await whereIs(tool.command))) continue
      found[tool.id] = await modelsOf(tool.id)
    }
    await this.call('update_profile', { tool_models: found }).catch(() => {})
  }

  /**
   * Waits for work and does it until stopped: as many cards at once as the agent's settings say, each in a worktree of
   * its own, and chats, debriefs and Challenges as they come. With `once`, one card and done.
   */
  async start(once = false) {
    if (!this.client) await this.connect()
    // Terminals its owner opens from the web app, beside the work.
    if (!once && !this.terminals) {
      this.terminals = new Terminals({ hubUrl: this.options.hubUrl, token: this.options.token, version: runnerVersion, log: (line) => this.log(line), start: (sid, by) => this.terminal(sid, by) })
      this.terminals.start()
    }
    const cards = new Map<string, Promise<void>>()
    const chats = new Map<string, Promise<void>>()
    // Keyed debrief:<card id>, so a debrief of a card this agent is also working isn't taken for the card.
    const debriefs = new Map<string, Promise<void>>()
    // Keyed challenge:<card id> the same way.
    const challenges = new Map<string, Promise<void>>()
    // Keyed replies:<card id>. A reply works in the card's own worktree and session, so the card itself counts as busy
    // meanwhile, and a card being worked isn't replied to until it's done (the hub sees it in busy).
    const replying = new Map<string, Promise<void>>()
    // Keyed brief:<repo>: one at a time, as writing one reads a whole repo.
    const briefing = new Map<string, Promise<void>>()
    while (!this.stopped) {
      let most = 1
      try {
        const settings = await this.settings()
        // Idle, and the hub hands out a newer runner: this one replaces itself and is started again on it.
        if ([cards, chats, debriefs, challenges, replying, briefing].every((m) => m.size === 0) && await this.updateIfNewer()) break
        // Asked to restart from the Agents page: whatever it's doing.
        if (this.restartWanted) {
          const by = this.restartWanted
          this.restartWanted = undefined
          if (await this.restartNow(by)) break
        }
        // Several at once only when each card gets its own worktree; otherwise they'd edit the same files.
        most = Math.max(1, settings.parallel ?? 3)
      } catch {
        // The hub will answer again in a moment.
      }
      // Cards up to the agent's limit; chats, debriefs and Challenges beside them, so a person is answered while cards
      // are worked.
      const takeCards = cards.size < most
      const takeChats = chats.size < 2
      const takeDebriefs = debriefs.size < 2
      const takeChallenges = challenges.size < 2
      const takeReplies = replying.size < 2
      const takeBriefs = briefing.size < 1
      const all = [cards, chats, debriefs, challenges, replying, briefing]
      if (!takeCards && !takeChats && !takeDebriefs && !takeChallenges && !takeReplies && !takeBriefs) {
        await Promise.race(all.flatMap((m) => [...m.values()]))
        continue
      }
      let found: CardJSON | ChatJSON | DebriefJSON | ChallengeJSON | RepliesJSON | BriefJSON | string
      try {
        found = await this.call<CardJSON | ChatJSON | DebriefJSON | ChallengeJSON | RepliesJSON | BriefJSON | string>('wait_for_work', {
          runner_id: this.id,
          timeout_seconds: this.options.waitSeconds ?? (all.some((m) => m.size) ? 20 : 50),
          chats: takeChats, debriefs: takeDebriefs, challenges: takeChallenges, replies: takeReplies, briefs: takeBriefs, cards: takeCards,
          busy: [...all.flatMap((m) => [...m.keys()]), ...[...replying.keys()].map((key) => key.slice('replies:'.length))],
        })
      } catch (error) {
        this.log(`The hub didn’t answer (${(error as Error).message}); trying again in 5 s.`)
        await new Promise((done) => setTimeout(done, 5000))
        continue
      }
      if (typeof found === 'string') continue
      const kind = 'kind' in found ? found.kind : 'card'
      const key = kind === 'debrief' || kind === 'challenge' || kind === 'replies' || kind === 'brief' ? `${kind}:${found.id}` : found.id
      const into = kind === 'chat' ? chats : kind === 'debrief' ? debriefs : kind === 'challenge' ? challenges : kind === 'replies' ? replying : kind === 'brief' ? briefing : cards
      const task = (kind === 'chat' ? this.chat(found as ChatJSON) : kind === 'debrief' ? this.debrief(found as DebriefJSON)
        : kind === 'challenge' ? this.challenge(found as ChallengeJSON) : kind === 'replies' ? this.replies(found as RepliesJSON)
          : kind === 'brief' ? this.brief(found as BriefJSON) : this.work(found as CardJSON))
        .catch((error) => this.log(`Something went wrong with ${key}: ${(error as Error).message}`))
        .finally(() => { into.delete(key) })
      into.set(key, task)
      if (once && into === cards) {
        await task
        return
      }
    }
    await Promise.allSettled([...cards.values(), ...chats.values(), ...debriefs.values(), ...challenges.values(), ...replying.values(), ...briefing.values()])
  }

  /**
   * When the hub hands out a newer runner and this one may update itself: its file replaced with the new one, and it
   * stops so it's started again on it (by the runner's own supervisor, see main.ts). Tried at most every two minutes.
   */
  private async updateIfNewer() {
    if (!this.options.selfUpdate || !this.latest || !newer(this.latest, runnerVersion) || Date.now() - this.lastUpdateTry < 2 * 60_000) return false
    this.lastUpdateTry = Date.now()
    if (!(await this.download(this.latest))) return false
    this.log(`Updating from runner ${runnerVersion} to ${this.latest}: starting again on it.`)
    this.updated = true
    this.stopped = true
    return true
  }

  /** The hub's runner in place of this one's file, when it's the version the hub said it has. False when it isn't. */
  private async download(version: string) {
    const file = this.options.selfUpdate!
    try {
      const response = await fetch(new URL('/runner/binders-runner.mjs', this.options.hubUrl), { headers: { 'cache-control': 'no-cache' } })
      const code = response.ok ? await response.text() : ''
      // Only the version it was told of: a cached older file, or a page that isn't the runner, is left alone.
      if (!code.includes(`runnerVersion = "${version}"`)) {
        this.log(`The hub has runner ${version}, but the file it sent isn’t it${response.ok ? '' : ` (${response.status})`}: staying on ${runnerVersion} for now.`)
        return false
      }
      await writeFile(`${file}.new`, code)
      await rename(`${file}.new`, file)
      return true
    } catch (error) {
      this.log(`Couldn’t update to runner ${version}: ${(error as Error).message}. Staying on ${runnerVersion}.`)
      return false
    }
  }

  /**
   * A person asked this agent's runners to restart, from the Agents page: what it's running stops (cards go back on the
   * board with why, terminals end), it takes the hub's newest runner, and its supervisor starts it again. One started
   * by hand, not as the file the hub hands out, can't start itself again: it says so and carries on.
   */
  private async restartNow(by: string) {
    if (!this.options.selfUpdate) {
      this.log(`${by} asked for this runner to restart, but it was started by hand, not as the file the hub hands out: restart it where it runs.`)
      return false
    }
    this.log(`${by} asked for this runner to restart: stopping what it’s running and starting again${this.latest && newer(this.latest, runnerVersion) ? ` on runner ${this.latest}` : ''}.`)
    if (this.latest && this.latest !== runnerVersion) await this.download(this.latest)
    this.stopWhy = `Its runner was restarted by ${by}, so this went back on the board.`
    this.updated = true
    this.stop()
    return true
  }

  /** The restart asked for before this runner started, which it leaves be; undefined until it first looks. */
  private restartBefore?: string
  /** Who asked for a restart since it started, not acted on yet. */
  private restartWanted?: string
  /** Why its runs stopped, when it stopped them itself: said on what they were doing. */
  private stopWhy?: string

  stop() {
    this.stopped = true
    this.terminals?.stop()
    for (const child of this.children.values()) stopTree(child, 'SIGTERM')
  }

  /** The runner the hub hands out now, as whoami last said. */
  private latest?: string
  /** Set once it has replaced its own file with a newer runner: it stops, to be started again on the new one. */
  updated = false
  private lastUpdateTry = 0

  private async settings() {
    const me = await this.call<{ name?: string; runner: RunnerSettings; latest_runner?: string; restartAsked?: { at: string; by: string } }>('whoami')
    this.latest = me.latest_runner
    // Renamed since it connected: it goes by its name now.
    if (me.name) this.name = me.name
    const asked = me.restartAsked?.at ?? ''
    if (this.restartBefore === undefined) this.restartBefore = asked
    else if (asked !== this.restartBefore) {
      this.restartBefore = asked
      this.restartWanted = me.restartAsked!.by
    }
    const settings = me.runner
    await this.tellModels(settings)
    return settings
  }

  /** One card: take it (unless it's one we hold and a person just answered), run the agent, and settle it. */
  async work(card: CardJSON) {
    const settings = await this.settings()
    if (!card.resume) {
      try {
        await this.call('claim_task', { id: card.id })
      } catch (error) {
        this.log(`Couldn’t take “${card.title}”: ${(error as Error).message}`)
        return
      }
    }
    const tool = toolInfo(settings.tool)
    this.log(`${card.resume ? 'Carrying on with' : 'Taking'} “${card.title}” (${tool.name}, ${settings.access} access, ${this.running + 1} running).`)
    this.running++
    try {
      await this.workTaken(card, settings, tool)
    } finally {
      this.running--
    }
  }

  private running = 0

  private async workTaken(card: CardJSON, settings: RunnerSettings, tool: ReturnType<typeof toolInfo>) {
    let dir: string
    try {
      dir = await this.directoryFor(card, settings)
    } catch (error) {
      // What git said (fatal: …), not just the command that failed.
      const lines = String((error as Error).message).split('\n').map((l) => l.trim()).filter(Boolean)
      const why = `Couldn’t make its worktree: ${lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? 'git failed'}`
      await this.call('release_task', { id: card.id, reason: why }).catch(() => {})
      this.log(`Put “${card.title}” back: ${why}`)
      return
    }
    const github = await this.repoAccess(card.id, card.title, dir)
    try {
      await this.workIn(card, settings, tool, dir, github.env)
    } finally {
      await github.done()
    }
  }

  private async workIn(card: CardJSON, settings: RunnerSettings, tool: ReturnType<typeof toolInfo>, dir: string, githubEnv: Record<string, string>): Promise<void> {
    // With Binders' tools, or (a tool without MCP, or an enterprise MCP config here) with the runner reporting for it.
    const mcp = tool.mcp && this.usesMcp(settings)
    // What the team knows about its repo, unless it's carrying on in a session that has it already.
    const brief = card.resume && mcp && this.sessions.has(card.id) ? '' : await this.briefFor(card.repo ?? await repoOf(dir), mcp)
    const prompt = mcp ? this.prompt(card, dir, brief) : await this.plainPrompt(card, dir, brief)
    // A person writing on the card while it runs steers it, as Esc and a message would in the tool: the run stops,
    // and the same session carries on with what they wrote.
    let next = prompt
    let resume = !!card.resume
    // In a worktree of its own, what the card changes so far goes to the hub now and then, for its Change Set.
    const own = dir !== this.options.workspace
    let diffSent = Date.now()
    for (;;) {
      // What people have written so far; anything after this steers. Counted, so the hub's clock and this one needn't agree.
      const people = (c: { kind: string; by: string; from_agent?: boolean }) => (c.kind === 'comment' || c.kind === 'answer') && (c.from_agent === undefined ? c.by.toLowerCase() !== this.name.toLowerCase() : !c.from_agent)
      const before = ((await this.call<CardJSON>('get_task', { id: card.id }).catch(() => card)).conversation ?? []).filter(people).length
      let steer: string | undefined
      let ticks = 0
      let ran: Awaited<ReturnType<Runner['run']>>
      try {
        ran = await this.run(settings, card.id, next, dir, { ...githubEnv, BINDERS_CARD: card.id, BINDERS_RESUME: resume ? '1' : '' }, settings.timeoutMinutes,
        (reader, stop) => {
          void this.relay(card.id, reader)
          if (own && Date.now() - diffSent > diffEvery) {
            diffSent = Date.now()
            void this.sendDiff(card.id, dir)
          }
          if (++ticks % 2) return
          void this.call<CardJSON>('get_task', { id: card.id }).then((now) => {
            if (now.stage === 'blocked' && this.holds(now) && !now.needs_you) return stop(`“${card.title}” was put in Blocked: stopping its run until it’s moved back.`)
            if (now.stage !== 'working' && now.stage !== 'blocked') return stop(`“${card.title}” was taken back: stopping its run.`)
            if (!this.holds(now)) return stop(`“${card.title}” was taken back: stopping its run.`)
            const all = (now.conversation ?? []).filter(people)
            const said = all.slice(before)
            if (said.length && !steer) {
              steer = said.map((c) => `${c.by}: ${c.text}`).join('\n')
              stop(`A person wrote on “${card.title}”: carrying on with it.`)
            }
          }).catch(() => {})
        })
      } catch (error) {
        // It couldn't start (the tool isn't there, say): the card goes back on the board with why.
        await this.call('release_task', { id: card.id, reason: (error as Error).message }).catch(() => {})
        this.log(`Put “${card.title}” back: ${(error as Error).message}`)
        return
      }
      // Claude Code refused Binders' MCP server for an enterprise MCP config: the runner works without it from now on,
      // so the card runs again at once, on the plain prompt, rather than going back on the board (where the hub would
      // keep it from this agent for a while, as it does any card given back).
      if (ran.managedMcp && !this.stopped) {
        this.log(`“${card.title}”: running it again without Binders’ MCP tools.`)
        this.sessions.delete(card.id)
        return this.workIn(card, settings, tool, dir, githubEnv)
      }
      await this.relay(card.id, ran.reader, true)
      // What Claude Code refused it, on the card for its people (without Binders' tools, settle blocks it on them).
      const refused = ran.reader.summary.denied ?? []
      if (refused.length && this.usesMcp(settings)) await this.call('report_progress', { id: card.id, said: `Claude Code wasn’t allowed to ${refused.join('; ')}. Allow what it needs in the agent’s settings on the Agents page (Commands it may run).` }).catch(() => {})
      if (own) await this.sendDiff(card.id, dir)
      if (!steer || this.stopped) {
        await this.settle(card, ran, settings, dir, githubEnv)
        return
      }
      resume = true
      next = mcp && this.sessions.has(card.id)
        ? `A person wrote on Binders card ${card.id} while you were working on it:\n${steer}\n\nTake it into account and carry on with the card (get_task has the whole conversation).`
        : `${await this.plainPrompt({ ...card, resume: false }, dir, brief)}\n\nWhile you were working on it, a person wrote:\n${steer}\nTake it into account.`
    }
  }

  /**
   * A person talking about a note: the agent reads the note and the chat, does what they ask, and its last words are
   * the reply. The same session carries on through the chat, so it remembers what was said. An agent without
   * Binders' tools gets the note in its prompt and ends its reply with the note as it should be, which the runner puts
   * back: no file to write (a very long note goes in as a file in its .binders folder instead).
   */
  async chat(chat: ChatJSON): Promise<void> {
    const settings = await this.settings()
    const mcp = this.usesMcp(settings)
    const from = [...chat.messages].reverse().find((m) => m.from !== 'you')
    this.log(`${from?.from ?? 'Someone'} says about “${chat.note?.title ?? 'a note'}”: ${short(from?.text ?? '', 80)}`)
    await this.call('chat_reply', { id: chat.id, working: true, doing: 'Reading the note' }).catch(() => {})
    const resumed = this.sessions.has(chat.id)
    let noteFile: string | undefined
    let before = ''
    const inline = !mcp && !!chat.note
    if (inline) {
      before = (await this.call<{ text?: string }>('get_note', { id: chat.note!.id }).catch(() => ({ text: '' }))).text ?? ''
      if (before.length > noteInPrompt) {
        noteFile = await agentFile(this.options.workspace, `note-${randomBytes(6).toString('hex')}.md`)
        await writeFile(noteFile, before, { mode: 0o600 })
      }
    }
    const said = [
      resumed
        ? `${from?.from ?? 'The person'} says, in the chat about the note “${chat.note?.title}”:`
        : `You're ${this.name}. ${from?.from ?? 'A person'} is working on the note “${chat.note?.title}”${chat.note?.binder ? ` in the ${chat.note.binder} binder` : ''} in Binders and is talking with you about it.`,
      '',
      ...(resumed ? [] : ['What has been said so far:', ...chat.messages.slice(0, -1).map((m) => `${m.from}: ${m.text}`), '', 'Their new message:']),
      from?.text ?? '',
      '',
      ...(noteFile
        ? [`The note is in ${noteFile}. Read it, and change that file when they ask you to change the note: what you write there goes back into it.`]
        : inline
          ? ['The note as it is now:', '<note>', before, '</note>', '', 'When they ask you to change it, end your reply with the whole note as it should be, between <note> and </note> on lines of their own: it replaces the note. Leave that out when you don’t change it. Don’t write the note to a file.']
          : [`Read the note with get_note (id ${chat.note?.id}) first: they may have changed it. Change it with edit_note (find and replace) or append_to_note when they ask, make cards with create_task, or look at the code here.`]),
      'Your last message is sent to them as your reply: keep it short and plain, and say what you changed.',
    ].join('\n')
    let reply = ''
    try {
      const ran = await this.runWithRoom(settings, chat.id, said, this.options.workspace, { BINDERS_CHAT: chat.id }, Math.min(settings.timeoutMinutes, 20), (reader) => {
        const { steps, said } = reader.take(false)
        const step = steps[steps.length - 1]
        const words = said[said.length - 1]?.split('\n').filter((l) => l.trim()).pop()
        const doing = step ? `${step.tool} ${step.text}` : words
        if (doing) void this.call('chat_reply', { id: chat.id, working: true, doing: short(doing, 120) }).catch(() => {})
      })
      // Claude Code refused Binders' tools here: it's started again without them.
      if (ran.managedMcp) return this.chat(chat)
      // Its final answer when it says one apart (Claude Code, Codex); else the end of what it printed.
      reply = ran.reader.summary.reply ?? lastWords(ran.output) ?? ran.reader.summary.last ?? ''
      const refused = ran.reader.summary.denied ?? []
      if (inline && !noteFile && chat.note) {
        // The note as it should be, from the end of its reply (or, cut from the reply, from all it printed).
        const fromReply = noteFromReply(reply)
        const changed = fromReply.note ?? noteFromReply(ran.output).note
        reply = fromReply.rest
        if (changed !== undefined && changed.trim() && changed !== before) {
          await this.call('edit_note', { id: chat.note.id, text: changed }).catch((error) => this.log(`Couldn’t put the note back: ${(error as Error).message}`))
          if (!reply.trim()) reply = 'I changed the note.'
        }
      }
      if (noteFile && chat.note) {
        const after = await readFile(noteFile, 'utf8').catch(() => before)
        if (after !== before && after.trim()) await this.call('edit_note', { id: chat.note.id, text: after }).catch((error) => this.log(`Couldn’t put the note back: ${(error as Error).message}`))
      }
      if (refused.length) reply = `${reply.trim()}\n\n(Claude Code wasn’t allowed to ${refused.join('; ')}. Allow what it needs in the agent’s settings on the Agents page: Commands it may run.)`
    } catch (error) {
      reply = `I couldn’t start: ${(error as Error).message}`
    } finally {
      if (noteFile) await rm(noteFile, { force: true })
    }
    await this.call('chat_reply', { id: chat.id, text: reply.trim() || 'I couldn’t answer that: the agent stopped without a reply.' }).catch(() => {})
  }

  /**
   * A person asked for a card's debrief: the agent reads its Change Set, changes nothing, and sends the five sections.
   * It reads the code in the card's own worktree when this machine has it. An agent without Binders' tools gets the
   * Change Set in its prompt and ends with the sections as JSON, which the runner sends. One that stops without a
   * debrief says so on the card.
   */
  async debrief(job: DebriefJSON): Promise<void> {
    const settings = { ...(await this.settings()), effort: job.effort }
    const mcp = this.usesMcp(settings)
    this.log(`${job.asked_by ?? 'Someone'} asked for a debrief of “${job.title}”.`)
    const doing = (text: string) => this.call('send_debrief', { id: job.id, doing: short(text, 120) }).catch(() => {})
    await doing('Reading the Change Set')
    const own = await this.cardWorktree(job.id)
    const dir = await run('git', ['-C', own, 'rev-parse', '--git-dir']).then(() => own, () => this.options.workspace)
    const key = `debrief-${job.id}`
    // Each debrief starts fresh, not anchored on the last one.
    this.sessions.delete(key)
    let why: string | undefined
    // Without Binders' tools, the agent writes the sections to a file of its own.
    const answer = mcp ? undefined : await agentFile(dir, `debrief-${randomBytes(6).toString('hex')}.json`)
    try {
      const brief = await this.briefFor(await repoOf(dir), mcp)
      const prompt = answer ? await this.plainDebriefPrompt(job, dir, answer, brief) : this.debriefPrompt(job, dir, brief)
      const ran = await this.runWithRoom(settings, key, prompt, dir, { BINDERS_DEBRIEF: job.id }, job.id.startsWith('set-') ? settings.timeoutMinutes : Math.min(settings.timeoutMinutes, 20), (reader) => {
        const { steps } = reader.take(false)
        const step = steps[steps.length - 1]
        if (step) void doing(`${step.tool} ${step.text}`)
      })
      // Claude Code refused Binders' tools here: it's started again without them.
      if (ran.managedMcp) return this.debrief(job)
      if (answer && !ran.timedOut && !ran.cutOff) {
        const sections = debriefSections(await readFile(answer, 'utf8').catch(() => '')) ?? debriefSections(ran.reader.summary.reply ?? ran.output)
        if (!sections) why = 'The agent didn’t write the debrief’s sections as JSON.'
        else await this.call('send_debrief', { id: job.id, ...sections }).catch((error) => { why = (error as Error).message })
      }
      why ??= ran.idle
        ? this.idleWhy(ran, settings)
        : ran.timedOut
        ? `It ran past ${job.id.startsWith('set-') ? `its ${settings.timeoutMinutes}-minute limit` : '20 minutes'} and was stopped.`
        : ran.exit.code
          ? stoppedWith(ran, this.options.hubUrl)
          : `The agent stopped without sending it${ran.reader.summary.last ? `. Its last words: ${ran.reader.summary.last}` : ''}.`
    } catch (error) {
      why = (error as Error).message
    } finally {
      if (answer) await Promise.all([rm(answer, { force: true }), rm(`${answer}.diffs`, { recursive: true, force: true })])
    }
    const now = await this.call<CardJSON & { debrief?: { state: string } }>('get_task', { id: job.id }).catch(() => undefined)
    if (now?.debrief?.state === 'asked' || now?.debrief?.state === 'writing') {
      await this.call('send_debrief', { id: job.id, failed: why }).catch(() => {})
      this.log(`Couldn’t write the debrief of “${job.title}”: ${why}`)
    } else {
      this.log(`Wrote the debrief of “${job.title}”.`)
    }
  }

  debriefPrompt(job: DebriefJSON, dir: string, brief = '') {
    return [
      `You're ${this.name}, one of this team's agents. ${job.asked_by ?? 'A person'} asked for a debrief of Binders card ${job.id} (“${job.title}”), ${job.stage === 'review' ? 'in review' : 'still being built'}: what its work proposes, for a person deciding whether it's right.`,
      '',
      ...(brief ? [brief] : []),
      'Write it as you go, never all at the end: each answer you give has an output limit, and your thinking counts toward it, so one big answer at the end can be cut off.',
      '',
      `1. The whole first: get_change_set (id ${job.id}, outline: true) gives the brief, its done-when points, the note's words, the agent's plan and log, the pull request and its checks, and each file with its size. Plan how the files fit together before reading any. You may read the code in ${dir}; change nothing.`,
      `2. Then a file at a time: get_change_set with file (and part, for a file in parts) gives its diff. After each file or a few related ones, add_to_debrief (id ${job.id}) with what you've learned: changes (by area, not by file), done-when points you can mark now, and things to look at. Keep in mind what earlier files did: an area can span files.`,
      `3. Last, over the whole: send_debrief (id ${job.id}) with what's left: does (what it does, now that you've read it all), try_it, test_plan, the done-when points still unmarked or whose mark changed, and look_at for what goes wrong between files. What add_to_debrief kept is taken in. Its sections:`,
      ...debriefSectionsHelp,
      ...testPlanHelp,
      '   Judge from the diff, not from what the log says was done.',
      '4. If you can\'t write it, send_debrief with failed and why.',
    ].join('\n')
  }

  /** For an agent without Binders' tools: the Change Set written out, and the sections asked for as JSON. */
  async plainDebriefPrompt(job: DebriefJSON, dir: string, answer: string, brief = '') {
    const set = await this.call<ChangeSetJSON>('get_change_set', { id: job.id })
    const folder = await diffFolder(`${answer}.diffs`, set.files)
    const steps = set.log.filter((a) => a.kind === 'step' || a.kind === 'said' || a.kind === 'completed').slice(-60).map((a) => `- ${a.tool ? `${a.tool} ` : ''}${short(a.text, 200)}${a.result ? ` → ${short(a.result, 120)}` : ''}`)
    return [
      `You're ${this.name}, one of this team's agents. ${job.asked_by ?? 'A person'} asked for a debrief of the card “${job.title}”: what its work proposes, for a person deciding whether it's right. You may read the code in ${dir}; change nothing.`,
      brief ? `\n${brief}` : '',
      `\nWhat it asks:\n${set.brief || '(no brief)'}`,
      set.done_when_points.length ? `\nDone when, point by point:\n${set.done_when_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '\nIt has no done-when: mark the brief\'s points instead.',
      set.note?.quote ? `\nFrom the note, word for word:\n> ${set.note.quote}` : '',
      set.pull ? `\nIts pull request: ${set.pull.repo}#${set.pull.number} “${set.pull.title}”. Checks: ${set.pull.checks.map((c) => `${c.name} ${c.state}`).join(', ') || 'none yet'}.` : `\nIts diff comes from ${set.source === 'worktree' ? 'its worktree, before a pull request' : 'nowhere yet: there is no diff'}.`,
      folder.list ? `\nIts diff is in ${folder.dir}, a file for each changed file:\n${folder.list}` : '',
      steps.length ? `\nWhat its agent did:\n${steps.join('\n')}` : '',
      '\nWrite the debrief as you go, never all at the end: each answer you give has an output limit, and your thinking counts toward it. Judge from the diff, not from what the log says was done.',
      `1. Plan how the files fit together from the list above, then read the diff files one at a time.`,
      `2. After each file or a few related ones, add a line to ${answer}: one JSON object with what you learned, any of changes ([{ "area", "what" }], by area, not by file), against ([{ "point", "mark", "where" }], the done-when points you can mark now; a point marked again takes the new mark) and look_at ([...]). Keep earlier files in mind: an area can span files.`,
      `3. Last, over the whole, a final line with does (what it does), try_it and test_plan, and any points still unmarked or things to look at between files.`,
      'The sections:',
      ...debriefSectionsHelp,
      ...testPlanHelp,
      '   test_plan is a list of { "title", "point", "setup", "steps": [...], "expect", "risk" }.',
      'Change nothing else.',
    ].filter(Boolean).join('\n')
  }

  /**
   * A person asked this agent to challenge a card another agent wrote: it reads the diff, the brief and the done-when,
   * never the author's plan or log, in a checkout of its own, changes nothing, and sends what it finds wrong. An agent
   * without Binders' tools gets the diff in its prompt and writes the findings as JSON, which the runner sends.
   */
  async challenge(job: ChallengeJSON): Promise<void> {
    const settings = { ...(await this.settings()), effort: job.effort }
    const mcp = this.usesMcp(settings)
    this.log(`${job.asked_by ?? 'Someone'} asked for a Challenge of “${job.title}”.`)
    const doing = (text: string) => this.call('send_challenge', { id: job.id, doing: short(text, 120) }).catch(() => {})
    await doing('Reading the diff')
    const key = `challenge-${job.id}`
    // Each Challenge starts fresh: not anchored on the last one, nor on any session in the author's folder.
    this.sessions.delete(key)
    let why: string | undefined
    let checkout: Awaited<ReturnType<typeof reviewCheckout>>
    let answer: string | undefined
    try {
      const set = await this.call<ChallengeSetJSON>('get_challenge_set', { id: job.id })
      const own = await this.cardWorktree(job.id)
      checkout = await reviewCheckout(this.options.workspace, own, set.pull, join(this.worktreesRoot(), `challenge-${job.id}-${randomBytes(4).toString('hex')}`))
      const dir = checkout?.dir ?? this.options.workspace
      if (checkout) await carryClaudeSettings([own, this.options.workspace], checkout.dir).catch(() => false)
      if (!mcp) answer = await agentFile(dir, `challenge-${randomBytes(6).toString('hex')}.json`)
      // What the change touches beyond itself, worked out here before the review, for the reviewer and the people.
      let blast: BlastRadius | undefined
      if (await run('git', ['-C', dir, 'rev-parse', '--git-dir']).then(() => true, () => false)) {
        await doing('Mapping the blast radius')
        blast = await blastRadius(set.files, dir, await repoOf(dir)).catch(() => undefined)
        if (blast) await this.call('send_challenge', { id: job.id, doing: 'Mapping the blast radius', blast_radius: blast }).catch(() => {})
      }
      // What the team knows about the repo: a reviewer that knows its rules finds what breaks them.
      const brief = await this.briefFor(set.pull?.repo ?? await repoOf(dir), mcp)
      const prompt = answer ? await this.plainChallengePrompt(job, set, checkout?.dir, answer, blast, brief) : this.challengePrompt(job, checkout?.dir, !!blast, brief)
      // A card's Challenge has 20 minutes; a whole change set's, the agent's own limit.
      const minutes = job.id.startsWith('set-') ? settings.timeoutMinutes : Math.min(settings.timeoutMinutes, 20)
      const ran = await this.runWithRoom(settings, key, prompt, dir, { BINDERS_CHALLENGE: job.id }, minutes, (reader) => {
        const { steps } = reader.take(false)
        const step = steps[steps.length - 1]
        if (step) void doing(`${step.tool} ${step.text}`)
      })
      // Claude Code refused Binders' tools here: it's started again without them.
      if (ran.managedMcp) return this.challenge(job)
      if (answer && !ran.timedOut && !ran.cutOff) {
        const found = challengeFindings(await readFile(answer, 'utf8').catch(() => '')) ?? challengeFindings(ran.reader.summary.reply ?? ran.output)
        if (!found) why = 'The agent didn’t write its findings as JSON.'
        else await this.call('send_challenge', { id: job.id, ...found }).catch((error) => { why = (error as Error).message })
      }
      why ??= ran.idle
        ? this.idleWhy(ran, settings)
        : ran.timedOut
        ? `It ran past ${job.id.startsWith('set-') ? `its ${settings.timeoutMinutes}-minute limit` : '20 minutes'} and was stopped.`
        : ran.exit.code
          ? stoppedWith(ran, this.options.hubUrl)
          : `The agent stopped without sending its findings${ran.reader.summary.last ? `. Its last words: ${ran.reader.summary.last}` : ''}.`
    } catch (error) {
      why = (error as Error).message
    } finally {
      if (answer) await Promise.all([rm(answer, { force: true }), rm(`${answer}.diffs`, { recursive: true, force: true })])
      await checkout?.remove()
    }
    const now = await this.call<{ challenge?: { state: string } }>('get_task', { id: job.id }).catch(() => undefined)
    if (now?.challenge?.state === 'asked' || now?.challenge?.state === 'reviewing') {
      await this.call('send_challenge', { id: job.id, failed: why }).catch(() => {})
      this.log(`Couldn’t challenge “${job.title}”: ${why}`)
    } else {
      this.log(`Challenged “${job.title}”.`)
    }
  }

  challengePrompt(job: ChallengeJSON, dir: string | undefined, blast = false, brief = '') {
    return [
      `You're ${this.name}, one of this team's agents. ${job.asked_by ?? 'A person'} asked you to challenge Binders ${job.title.startsWith('Change set') ? '' : 'card '}${job.id} (“${job.title}”): another agent wrote its work, and your job is to find what's wrong with it before it's approved.`,
      '',
      ...(brief ? [brief, 'Its "Rules it keeps" and "Reviewing a change here" are where to look hardest: a change that breaks one of those rules is a finding.', ''] : []),
      'Send findings as you go, never all at the end: each answer you give has an output limit, and your thinking counts toward it, so one big answer at the end can be cut off. Think as hard as each file needs.',
      '',
      `1. The whole first: get_challenge_set (id ${job.id}, outline: true) gives the brief, its done-when points, the note's words, the pull request and its checks, and each file with its size. Not the author's plan or log: judge the code, not their reasoning. ${checkedOut(dir)} Plan how the files fit together before reading any.`,
      '   When it says too_big_to_send, it gives the overview instead: read the diffs yourself as it says, one pull request at a time, each change once.',
      ...(blast ? ['   Its blast_radius lists what the change touches beyond itself: each symbol it changed or removed, its uses elsewhere that it didn\'t touch, and the tests that mention it. Read those uses: a removed symbol still used, or a changed one whose callers weren\'t updated, is where things break. It\'s found by name, so check each before you report it.'] : []),
      `2. Then a file at a time: get_challenge_set with file (and part, for a file in parts) gives its numbered diff. After each file or a few related ones, add_findings (id ${job.id}) with what's wrong there. Keep earlier files in mind: a finding can be about how this file works with one you read before.`,
      `3. Last, over the whole: send_challenge (id ${job.id}) with the summary, how it stands against each done-when point, and any findings that only show across files or pull requests (what one changes that another relies on). What add_findings kept is taken in. Each finding:`,
      ...challengeHelp,
      '4. If you can\'t review it, send_challenge with failed and why.',
    ].join('\n')
  }

  /** For an agent without Binders' tools: the diff, brief and done-when written out, and the findings asked for as JSON. */
  async plainChallengePrompt(job: ChallengeJSON, set: ChallengeSetJSON, dir: string | undefined, answer: string, blast?: BlastRadius, brief = '') {
    const folder = await diffFolder(`${answer}.diffs`, set.files)
    return [
      `You're ${this.name}, one of this team's agents. ${job.asked_by ?? 'A person'} asked you to challenge the card “${job.title}”: another agent wrote its work, and your job is to find what's wrong with it before it's approved. ${checkedOut(dir)}`,
      brief ? `\n${brief}\nIts "Rules it keeps" and "Reviewing a change here" are where to look hardest: a change that breaks one of those rules is a finding.` : '',
      `\nWhat it asks:\n${set.brief || '(no brief)'}`,
      set.done_when_points.length ? `\nDone when, point by point:\n${set.done_when_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
      set.note?.quote ? `\nFrom the note, word for word:\n> ${set.note.quote}` : '',
      set.pull ? `\nIts pull request: ${set.pull.repo}#${set.pull.number} “${set.pull.title}”. Checks: ${set.pull.checks.map((c) => `${c.name} ${c.state}`).join(', ') || 'none yet'}.` : '',
      folder.list ? `\nIts diff is in ${folder.dir}, a file for each changed file, each line numbered as in its file:\n${folder.list}` : '\nThere is no diff yet.',
      blast ? `\n${blastSummary(blast)}\nRead those uses: a removed symbol still used, or a changed one whose callers weren't updated, is where things break.` : '',
      '\nFind what\'s wrong with it, writing findings as you go, never all at the end: each answer you give has an output limit, and your thinking counts toward it. Think as hard as each file needs.',
      '1. Plan how the files fit together from the list above, then read the diff files one at a time.',
      `2. After each file or a few related ones, add a line to ${answer} for each finding there: one JSON object, { "finding": { "kind", "file", "line", "what", "confidence", "severity", "fix" } }, file as the list names it. Keep earlier files in mind: a finding can be about how this file works with one you read before.`,
      `3. Last, over the whole, a final line { "summary": "..." }: how it stands against each done-when point, and what goes wrong between files; and a finding line for anything only the whole shows.`,
      'The findings:',
      ...challengeHelp,
      'Change nothing else.',
    ].filter(Boolean).join('\n')
  }

  /**
   * A person asked this agent, which wrote a card's work, to reply to its Challenge's findings: one round, each finding
   * fixed or disagreed with and why. It works in the card's own worktree, carrying on its session for the card when
   * there is one, so it can fix what's wrong there. An agent without Binders' tools gets the findings in its prompt and
   * writes its replies as JSON, which the runner sends. Nothing goes back to the reviewer.
   */
  async replies(job: RepliesJSON): Promise<void> {
    const settings = await this.settings()
    const mcp = this.usesMcp(settings)
    this.log(`${job.asked_by ?? 'Someone'} asked for replies to the findings on “${job.title}”.`)
    const doing = (text: string) => this.call('reply_to_findings', { id: job.id, doing: short(text, 120) }).catch(() => {})
    await doing('Reading the findings')
    const own = await this.cardWorktree(job.id)
    const dir = await run('git', ['-C', own, 'rev-parse', '--git-dir']).then(() => own, () => this.options.workspace)
    let why: string | undefined
    const answer = mcp ? undefined : await agentFile(dir, `replies-${randomBytes(6).toString('hex')}.json`)
    try {
      const challenge = await this.call<ChallengeJSONRead>('get_challenge', { id: job.id })
      const prompt = answer ? this.plainRepliesPrompt(job, challenge, dir, answer) : this.repliesPrompt(job, dir)
      // The card's own session, so it answers with what it knew when it did the work.
      // Replies may push fixes to the card's branch: with the same token for its repo alone.
      const github = await this.repoAccess(job.id, job.title, dir)
      const ran = await this.runWithRoom(settings, job.id, prompt, dir, { ...github.env, BINDERS_CARD: job.id, BINDERS_REPLIES: job.id }, Math.min(settings.timeoutMinutes, 30), (reader) => {
        const { steps } = reader.take(false)
        const step = steps[steps.length - 1]
        if (step) void doing(`${step.tool} ${step.text}`)
      }).finally(() => github.done())
      // Claude Code refused Binders' tools here: it's started again without them.
      if (ran.managedMcp) return this.replies(job)
      if (dir !== this.options.workspace) await this.sendDiff(job.id, dir)
      if (answer && !ran.timedOut && !ran.cutOff) {
        const found = findingReplies(await readFile(answer, 'utf8').catch(() => '')) ?? findingReplies(ran.reader.summary.reply ?? ran.output)
        if (!found) why = 'The agent didn’t write its replies as JSON.'
        else await this.call('reply_to_findings', { id: job.id, ...found }).catch((error) => { why = (error as Error).message })
      }
      why ??= ran.idle
        ? this.idleWhy(ran, settings)
        : ran.timedOut
        ? 'It ran past 30 minutes and was stopped.'
        : ran.exit.code
          ? stoppedWith(ran, this.options.hubUrl)
          : `The agent stopped without sending its replies${ran.reader.summary.last ? `. Its last words: ${ran.reader.summary.last}` : ''}.`
    } catch (error) {
      why = (error as Error).message
    } finally {
      if (answer) await Promise.all([rm(answer, { force: true }), rm(`${answer}.diffs`, { recursive: true, force: true })])
    }
    const now = await this.call<{ challenge?: { replies?: string } }>('get_task', { id: job.id }).catch(() => undefined)
    if (now?.challenge?.replies === 'asked' || now?.challenge?.replies === 'replying') {
      await this.call('reply_to_findings', { id: job.id, failed: why }).catch(() => {})
      this.log(`Couldn’t reply to the findings on “${job.title}”: ${why}`)
    } else {
      this.log(`Replied to the findings on “${job.title}”.`)
    }
  }

  repliesPrompt(job: RepliesJSON, dir: string) {
    return [
      `You're ${this.name}, one of this team's agents. You wrote the work on Binders card ${job.id} (“${job.title}”), and another agent challenged it: ${job.asked_by ?? 'a person'} asks you to reply to its findings.`,
      '',
      `1. get_challenge (id ${job.id}) gives the findings, each with its id (f1, f2…), file and line, what goes wrong and a fix if the reviewer saw one. get_task (id ${job.id}) gives the card.`,
      `2. For each finding, check it against the code in ${dir}:`,
      ...repliesHelp,
      `3. reply_to_findings (id ${job.id}) with one reply to every finding, all in one call. There is one round: the reviewer won't answer back, so say all you need to.`,
      '4. If you can\'t reply, reply_to_findings with failed and why.',
    ].join('\n')
  }

  /** For an agent without Binders' tools: the findings written out, and the replies asked for as JSON. */
  plainRepliesPrompt(job: RepliesJSON, challenge: ChallengeJSONRead, dir: string, answer: string) {
    const findings = (challenge.findings ?? []).map((f) => `- ${f.id} (${f.severity}, ${f.confidence}, ${f.kind}) ${f.file}:${f.line}: ${f.what}${f.fix ? `\n  Fix: ${f.fix}` : ''}`)
    return [
      `You're ${this.name}, one of this team's agents. You wrote the work on the card “${job.title}”, and another agent challenged it: ${job.asked_by ?? 'a person'} asks you to reply to its findings. The code is in ${dir}.`,
      challenge.summary ? `\nThe reviewer's summary: ${challenge.summary}` : '',
      `\nThe findings:\n${findings.join('\n')}`,
      '\nFor each finding, check it against the code:',
      ...repliesHelp,
      `Write your replies to ${answer} as one JSON object: { "replies": [{ "finding": "f1", "verdict": "fixed" or "disagree", "why": "..." }] }, one for every finding. There is one round: the reviewer won't answer back.`,
    ].filter(Boolean).join('\n')
  }

  /** Starts the agent and waits for it, reading what it prints; `tick` runs every couple of seconds meanwhile. */
  /**
   * GitHub for a card's run: the hub's token for the card's repo alone, for an hour and renewed while the run lasts,
   * given only while the agent's owner can push there. The agent's git reads it through a credential helper (SSH
   * addresses of that GitHub go over HTTPS, so they use it too), gh through GH_TOKEN; this machine's own GitHub login
   * isn't used. A hub that hands out no such token leaves the machine's login in place, and the log says so.
   */
  private async repoAccess(cardId: string, title: string, dir: string): Promise<{ env: Record<string, string>; done: () => Promise<void> }> {
    const none = { env: {}, done: async () => {} }
    // The token is for the repo it works in: the folder's origin. A folder of repos, or one not on GitHub, keeps the
    // machine's login, as one token can't cover them.
    const repo = await repoOf(dir)
    if (!repo) {
      this.log(`“${title}” runs with this machine’s own GitHub login: its folder isn’t one GitHub repo.`)
      return none
    }
    let first: RepoToken
    try {
      first = await this.call<RepoToken>('repo_token', { id: cardId, repo })
    } catch (error) {
      this.log(`“${title}” runs with this machine’s own GitHub login: ${(error as Error).message}`)
      return none
    }
    if (!first?.token) return none
    await mkdir(join(runnerHome(), 'run'), { recursive: true, mode: 0o700 })
    const keep = await mkdtemp(join(runnerHome(), 'run', 'github-'))
    const file = join(keep, 'token')
    await writeFile(file, first.token, { mode: 0o600 })
    const web = (first.github || 'https://github.com').replace(/\/$/, '')
    const host = new URL(web).host
    const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf 'password=%s\\n' "$(cat '${file}')"; }; f`
    // An empty helper first clears the machine's own (a keychain, gh's) for that GitHub.
    const config = [[`credential.${web}.helper`, ''], [`credential.${web}.helper`, helper], [`url.${web}/.insteadOf`, `git@${host}:`], [`url.${web}/.insteadOf`, `ssh://git@${host}/`]]
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
      ...(host === 'github.com' ? { GH_TOKEN: first.token, GITHUB_TOKEN: first.token } : { GH_HOST: host, GH_ENTERPRISE_TOKEN: first.token, GITHUB_TOKEN: first.token }),
      // Its commits are by whoever the agent commits as: its owner, or the app's bot.
      ...(first.author ? { GIT_AUTHOR_NAME: first.author.name, GIT_AUTHOR_EMAIL: first.author.email, GIT_COMMITTER_NAME: first.author.name, GIT_COMMITTER_EMAIL: first.author.email } : {}),
    }
    // git asks the helper each time, so a renewed token reaches it; gh keeps the first, good for its hour.
    const renew = setInterval(() => {
      void this.call<RepoToken>('repo_token', { id: cardId, repo })
        .then((next) => writeFile(file, next.token, { mode: 0o600 }))
        .catch((error) => this.log(`Couldn’t renew “${title}”’s GitHub token: ${(error as Error).message}`))
    }, 45 * 60_000)
    this.log(`“${title}” works in ${first.repo}${first.as === 'owner' ? ', pushing as its owner' : ' with a token for that repo alone'}${first.author ? `, committing as ${first.author.name}` : ''}.`)
    return { env, done: async () => { clearInterval(renew); await rm(keep, { recursive: true, force: true }) } }
  }

  /**
   * A run that its model's output limit cut off (its thinking and its answer share it, and a careful think over a big
   * diff can use it all) is tried once more, thinking as hard as before and told to keep what it writes short. Cut off
   * again, it says what to change: Codex has no setting for the limit, so a model with a larger one.
   */
  private async runWithRoom(settings: RunnerSettings, key: string, prompt: string, dir: string, env: Record<string, string>, minutes: number, tick: (reader: StreamReader, stop: (why: string) => void) => void) {
    const ran = await this.run(settings, key, prompt, dir, env, minutes, tick)
    if (!cutOff(ran, this.options.hubUrl)) return ran
    this.log(`${key}: the model’s output limit cut it off; trying once more.`)
    this.sessions.delete(key)
    const again = await this.run(settings, key, `${prompt}\n\nA try before this one was cut off at the model's output limit. Think it through as carefully as you need, but keep what you write and send short.`, dir, env, minutes, tick)
    if (cutOff(again, this.options.hubUrl)) again.cutOff = `Its model’s output limit cut it off twice${settings.model ? ` (${settings.model})` : ''}: its reasoning and its answer share that limit, and this one needs more. Pick a model with a larger output limit in the agent’s settings.`
    return again
  }

  private async run(settings: RunnerSettings, key: string, prompt: string, dir: string, env: Record<string, string>, minutes: number, tick: (reader: StreamReader, stop: (why: string) => void) => void) {
    const reader = new StreamReader()
    const config = await this.mcpConfig(settings)
    let output = ''
    let errors = ''
    let timedOut = false
    // An agent that says nothing for a long while is stuck (a model it can't reach, a prompt waiting in its own app):
    // stopped, so its card, debrief or Challenge says so rather than sitting at working for its whole time limit.
    const idleMinutes = settings.idleMinutes ?? this.options.idleMinutes ?? 15
    let heard = Date.now()
    let idle = false
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null }
    try {
      const built = this.commandFor(settings, key, dir, config.path, prompt, config.quiet)
      const { args, shell, env: extra } = built
      let command = built.command
      if (!shell) {
        const found = await whereIs(command)
        if (!found) throw new Error(`${toolInfo(settings.tool).name} isn’t installed on this machine (no “${command}” on the PATH or in the usual places). Install it, or pick another tool in the agent’s settings.`)
        command = found
      }
      exit = await new Promise((done) => {
        // In a process group of its own, so stopping it stops what it started too (a shell's command, a tool's helpers).
        const child = spawn(command, args, { cwd: dir, shell, detached: process.platform !== 'win32', env: { ...process.env, ...extra, ...config.env, ...env, BINDERS_URL: this.options.hubUrl, BINDERS_TOKEN: this.options.token }, stdio: ['ignore', 'pipe', 'pipe'] })
        this.children.set(key, child)
        const stop = (why: string) => {
          this.log(why)
          stopTree(child, 'SIGTERM')
          setTimeout(() => stopTree(child, 'SIGKILL'), 10_000).unref()
        }
        let buffer = ''
        const line = (text: string) => {
          reader.line(text)
          if (!text.trimStart().startsWith('{')) output = (output + text + '\n').slice(-20_000)
        }
        child.stdout!.on('data', (chunk: Buffer) => {
          heard = Date.now()
          buffer += chunk.toString('utf8')
          let at
          while ((at = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, at))
            buffer = buffer.slice(at + 1)
          }
        })
        child.stderr!.on('data', (chunk: Buffer) => {
          heard = Date.now()
          errors = (errors + chunk.toString('utf8')).slice(-2000)
        })
        const limit = setTimeout(() => {
          timedOut = true
          stopTree(child, 'SIGTERM')
          setTimeout(() => stopTree(child, 'SIGKILL'), 10_000).unref()
        }, minutes * 60_000)
        const every = setInterval(() => {
          if (!idle && Date.now() - heard > idleMinutes * 60_000) {
            idle = true
            timedOut = true
            stop(`${toolInfo(settings.tool).name} said nothing for ${idleMinutes} minutes: stopping it as stuck.`)
            return
          }
          tick(reader, stop)
        }, 2000)
        child.on('error', (error) => { errors += error.message })
        child.on('close', (code, signal) => {
          if (buffer.trim()) line(buffer)
          clearTimeout(limit)
          clearInterval(every)
          if (errors.trim() && code) this.log(errors.trim().split('\n').slice(-3).join('\n'))
          done({ code, signal })
        })
      })
    } finally {
      this.children.delete(key)
      if (config.path) await rm(config.path, { force: true })
    }
    if (reader.summary.sessionId) this.sessions.set(key, reader.summary.sessionId)
    // Claude Code refusing Binders' MCP server for an enterprise MCP config the runner didn't find by its file: from now
    // on its runs go without it, and this one stops saying why.
    // Full access asked for, and Claude Code started in another mode: a policy turned it off without the runner seeing
    // the file. From now on it asks for edits accepted, which a run without a person can use.
    const started = reader.summary.permissionMode
    if (settings.tool === 'claude' && settings.access === 'full' && !this.bypassOff && started && started !== 'bypassPermissions') {
      this.bypassOff = true
      this.log(`Claude Code started in “${started}” though full access was asked for: this machine’s policy turns it off. From now on it runs with edits accepted, and the commands it runs follow the policy’s rules.`)
      if (this.client) await this.call('update_profile', { runner: this.profile(this.parallel) }).catch(() => undefined)
    }
    // Only what Claude Code itself says went wrong: never the agent's own words, which may quote that error.
    const managedMcp = settings.tool === 'claude' && !!config.path && !!exit.code && refusedByManagedMcp(`${errors}\n${reader.summary.error ?? ''}`)
    if (managedMcp) await this.enterpriseMcpFound('Claude Code refused Binders’ MCP server for an enterprise MCP config')
    return { reader, exit, errors, output, timedOut, idle, idleMinutes, cutOff: undefined as string | undefined, managedMcp }
  }

  /** Why a run was stopped as stuck, and where to look. */
  private idleWhy(ran: { idleMinutes: number }, settings: RunnerSettings) {
    return `${toolInfo(settings.tool).name} said nothing for ${ran.idleMinutes} minutes and was stopped as stuck. Check that its model is on and reachable, and that its own app isn't waiting on a prompt or a sign-in.`
  }

  /** Steps and words since the last time, onto the card (a tool printing plain text has its lines as words). */
  private async relay(cardId: string, reader: StreamReader, final = false) {
    const { steps, said } = reader.take(final)
    const summary = reader.summary
    if (!steps.length && !said.length && !(final && (summary.cost !== undefined || summary.minutes !== undefined || summary.tokens !== undefined))) return
    try {
      await this.call('report_progress', {
        id: cardId,
        steps: steps.map((s) => ({ tool: s.tool, text: s.text || s.tool, result: s.result })),
        said: said.length ? said.join('\n\n').slice(0, 2000) : undefined,
        ...(final && summary.cost !== undefined ? { cost: summary.cost } : {}),
        ...(final && summary.minutes !== undefined ? { minutes: summary.minutes } : {}),
        ...(final && summary.tokens !== undefined ? { tokens: summary.tokens } : {}),
      })
    } catch {
      // The card may already be done or given back; what's left doesn't matter then.
    }
  }

  /**
   * After the agent stops: done, waiting on a person, or given back with why. An agent without Binders' tools that
   * finished cleanly is done, with what it printed last as the summary.
   */
  /**
   * A card's work sent the way Binders expects, for an agent without its tools: what it changed in the card's worktree
   * committed on the card's branch (with "binders-card: <id>"), pushed with the card's own token, and its pull request
   * opened against the default branch, or the open one for that branch found. Nothing changed and nothing ahead of the
   * default branch: nothing to send.
   */
  private async ship(card: CardJSON, dir: string, env: Record<string, string>, summary: string): Promise<{ url?: string; failed?: string }> {
    // Only in a card's own worktree: never commits in the person's own checkout (an agent that runs without worktrees).
    if (resolve(dir) === this.options.workspace || !(await run('git', ['-C', dir, 'rev-parse', '--git-dir']).then(() => true, () => false))) return {}
    const repo = await repoOf(dir)
    const git = (args: string[]) => run('git', ['-C', dir, ...args], { env: { ...process.env, ...env } }).then((r) => r.stdout.trim())
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') return {}
    if (await git(['status', '--porcelain'])) {
      await git(['add', '-A'])
      await git(['commit', '-q', '-m', `${card.title}\n\n${short(summary, 1500)}\n\nbinders-card: ${card.id}`])
    }
    const base = (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => 'origin/main')).replace(/^origin\//, '') || 'main'
    const ahead = Number(await git(['rev-list', '--count', `origin/${base}..HEAD`]).catch(() => '0')) || 0
    if (!ahead) return {}
    try {
      await git(['push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`])
    } catch (error) {
      return { failed: `git push said: ${short((error as { stderr?: string }).stderr || (error as Error).message, 400)}` }
    }
    // Not on GitHub: sent, with no pull request to open.
    if (!repo) return {}
    const token = env.GH_TOKEN ?? env.GH_ENTERPRISE_TOKEN ?? env.GITHUB_TOKEN
    if (!token) return { failed: 'this hub gave no GitHub token for the card’s repo, so the pull request couldn’t be opened.' }
    const api = env.GH_HOST ? `https://${env.GH_HOST}/api/v3` : 'https://api.github.com'
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }
    const owner = repo.split('/')[0]
    const open = await fetch(`${api}/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, { headers }).then((r) => r.ok ? r.json() as Promise<{ html_url: string }[]> : []).catch(() => [] as { html_url: string }[])
    if (open[0]?.html_url) return { url: open[0].html_url }
    const made = await fetch(`${api}/repos/${repo}/pulls`, { method: 'POST', headers, body: JSON.stringify({ title: card.title, head: branch, base, body: `${summary.trim()}\n\nbinders-card: ${card.id}` }) })
    const body = await made.json().catch(() => ({})) as { html_url?: string; message?: string; errors?: { message?: string }[] }
    if (!made.ok || !body.html_url) return { failed: `GitHub didn’t open the pull request: ${body.errors?.[0]?.message ?? body.message ?? made.status}.` }
    return { url: body.html_url }
  }

  private async settle(card: CardJSON, ran: { exit: { code: number | null }; errors: string; output: string; timedOut: boolean; idle: boolean; idleMinutes: number; reader: StreamReader }, settings: RunnerSettings, dir = this.options.workspace, githubEnv: Record<string, string> = {}) {
    let now: CardJSON
    try {
      now = await this.call<CardJSON>('get_task', { id: card.id })
    } catch {
      return
    }
    if (now.stage !== 'working' || !this.holds(now)) {
      this.log(`“${card.title}” is ${now.stage}.`)
      return
    }
    if (now.needs_you) {
      this.log(`“${card.title}” waits for an answer: ${now.needs_you}`)
      return
    }
    const last = ran.reader.summary.last
    if (!this.usesMcp(settings) && !ran.timedOut && ran.exit.code === 0) {
      // The Binders actions it asked for, taken for it; what came of them goes on the card with its summary.
      const asked = actionsFromReply(ran.reader.summary.reply ?? ran.output)
      const done: string[] = []
      let question: string | undefined
      for (const action of asked.actions) {
        if (!(action.tool in proxied)) { done.push(`${action.tool}: not one the runner takes for an agent.`); continue }
        // Asking is the card's own question: it waits in Blocked for the answer, once the rest is taken.
        if (action.tool === 'ask') { question = String(action.args.question ?? '').trim() || question; continue }
        const result = await this.call<unknown>(action.tool, action.args).then((r) => `${action.tool}: ${short(typeof r === 'string' ? r : JSON.stringify(r), 300)}`, (error) => `${action.tool} didn’t work: ${(error as Error).message}`)
        done.push(result)
        this.log(`“${card.title}”: ${result}`)
      }
      // What Claude Code refused it: the card waits for a person to allow it, rather than passing for done.
      const denied = ran.reader.summary.denied ?? []
      if (question || denied.length) {
        const blocked = [
          question,
          denied.length ? `Claude Code wasn’t allowed to ${denied.join('; ')}. Allow what it needs in the agent’s settings on the Agents page (Commands it may run), then answer here and it carries on.` : '',
          done.length ? `Taken for it meanwhile:\n${done.map((d) => `- ${d}`).join('\n')}` : '',
        ].filter(Boolean).join('\n\n')
        await this.call('ask', { id: card.id, question: short(blocked, 3000) }).catch((error) => this.log(`Couldn’t ask on “${card.title}”: ${(error as Error).message}`))
        this.log(`“${card.title}” waits for a person: ${short(question ?? `refused ${denied.join('; ')}`, 160)}`)
        return
      }
      const reply = asked.actions.length ? asked.rest : undefined
      const summary = [reply ?? ran.reader.summary.reply ?? lastWords(ran.output) ?? 'Done.', ...(done.length ? ['', 'Binders actions taken for it:', ...done.map((d) => `- ${d}`)] : [])].join('\n')
      // Its changes, shipped as an agent with Binders' tools would: committed on the card's branch, pushed, and its
      // pull request opened, so the card goes to review and the pull request into its change set, never straight to done.
      const shipped = await this.ship(card, dir, githubEnv, reply ?? ran.reader.summary.reply ?? '').catch((error) => ({ url: undefined, failed: (error as Error).message }))
      if (shipped.failed) {
        await this.call('ask', { id: card.id, question: short(`The work is done in its worktree (${dir}), but the runner couldn’t send it: ${shipped.failed} Fix that, or push it and open its pull request by hand, then answer here.`, 3000) }).catch(() => {})
        this.log(`“${card.title}” waits for a person: couldn’t send its work: ${shipped.failed}`)
        return
      }
      await this.call('complete_task', { id: card.id, summary: short(summary, 4000), ...(shipped.url ? { pull_request: shipped.url } : {}) }).catch((error) => this.log(`Couldn’t finish “${card.title}”: ${(error as Error).message}`))
      this.log(`Finished “${card.title}”.`)
      return
    }
    const why = this.stopWhy ?? (ran.idle
      ? this.idleWhy(ran, settings)
      : ran.timedOut
      ? `It ran past its ${settings.timeoutMinutes}-minute limit and was stopped.`
      : ran.exit.code
        ? stoppedWith(ran, this.options.hubUrl)
        : `The agent stopped without finishing it${last ? `. Its last words: ${last}` : ''}.`)
    await this.call('release_task', { id: card.id, reason: why }).catch(() => {})
    this.log(`Put “${card.title}” back: ${why}`)
  }

  /** The diff of a card's worktree to the hub. A card that's no longer held, or a hub that can't take it, is let go. */
  private async sendDiff(cardId: string, dir: string) {
    try {
      const diff = await worktreeDiff(dir, this.options.workspace)
      if (diff) await this.call('report_diff', { id: cardId, ...diff })
    } catch (error) {
      this.log(`Couldn’t send the worktree’s diff: ${(error as Error).message}`)
    }
  }

  /**
   * Where a card is worked on: always a worktree on the card's own branch, so changes never land in the workspace's own
   * checkout. A workspace that's one repo gets the card's worktree of it; a folder of repos gets a folder of the card's
   * own, laid out as the workspace is, with a worktree of each repo in it. A workspace with no repo at all is worked in
   * as it is. Paths are compared as they really are (on a Mac /var is /private/var), and worktrees are made one at a
   * time, as git locks the repo.
   */
  private async directoryFor(card: CardJSON, _settings: RunnerSettings) {
    const workspace = this.options.workspace
    const root = this.worktreesRoot()
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: workspace }).then((r) => r.stdout.trim(), () => '')
    if (top) {
      const [realTop, realWorkspace] = await Promise.all([realpath(top), realpath(workspace)])
      // A folder inside a repo: the card's worktree of that repo, and the same folder in it.
      const inside = realWorkspace.slice(realTop.length).replace(/^\//, '')
      const dir = await this.makeWorktree(card, realTop, join(root, `${basename(realTop)}-${card.id}`))
      return inside ? join(dir, inside) : dir
    }
    const repos = await this.reposIn(workspace)
    if (!repos.length) return workspace
    const folder = join(root, `${basename(workspace)}-${card.id}`)
    await mkdir(folder, { recursive: true })
    for (const repo of repos) await this.makeWorktree(card, join(workspace, repo), join(folder, repo))
    this.log(`“${card.title}”: a worktree of ${repos.join(', ')} in ${folder}`)
    return folder
  }

  /** The repos directly inside a folder that isn't one itself, by folder name (at most a dozen). */
  private async reposIn(folder: string) {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const repos: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const isRepo = await run('git', ['-C', join(folder, entry.name), 'rev-parse', '--show-toplevel']).then((r) => r.stdout.trim(), () => '')
      if (isRepo && (await realpath(isRepo)) === (await realpath(join(folder, entry.name)))) repos.push(entry.name)
      if (repos.length >= 12) break
    }
    return repos
  }

  /** The card's worktree of one repo, at `dir` unless its branch is already checked out elsewhere. */
  private async makeWorktree(card: CardJSON, repo: string, wanted: string) {
    let dir = wanted
    const branch = `binders/${card.id}`
    const made = this.worktreeQueue.then(async () => {
      // Worktrees whose folders are gone don't hold their branches any more.
      await run('git', ['-C', repo, 'worktree', 'prune']).catch(() => undefined)
      // The card's branch may be checked out already: by this runner before, or by one in another worktree of the same
      // repo (git won't check one branch out twice). Its work is there, so it carries on there.
      const held = await this.worktreeHolding(branch, repo)
      if (held) {
        dir = held
        return
      }
      await mkdir(join(wanted, '..'), { recursive: true })
      const exists = await run('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(() => true, () => false)
      if (exists) {
        // Its branch, with what was done on it so far, in a fresh folder.
        await run('git', ['-C', repo, 'worktree', 'add', dir, branch])
        return
      }
      // From the default branch as the remote has it, so each card's branch (and its pull request) starts from main,
      // not from whatever the workspace has checked out. A card waiting on one whose pull request isn't merged yet
      // starts from that card's branch instead, so it builds on its work (its pull request then carries both until the
      // first merges).
      await run('git', ['-C', repo, 'fetch', '-q', 'origin']).catch(() => undefined)
      let start = await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD']).then((r) => r.stdout.trim(), () => '')
      for (const before of (card.waits_for ?? []).filter((w) => w.stage === 'review').reverse()) {
        const theirs = `binders/${before.id}`
        if (await run('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${theirs}`]).then(() => true, () => false)) {
          start = theirs
          this.log(`“${card.title}” builds on “${before.title ?? before.id}”, not merged yet: starting from its branch.`)
          break
        }
      }
      await run('git', ['-C', repo, 'worktree', 'add', '-b', branch, dir, ...(start ? [start] : [])])
    })
    this.worktreeQueue = made.catch(() => {})
    await made
    await carryClaudeSettings([repo, this.options.workspace], dir).catch(() => false)
    return dir
  }

  /** The folder of the worktree that has a branch checked out, if one does. */
  private async worktreeHolding(branch: string, workspace = this.options.workspace) {
    const listed = await run('git', ['-C', workspace, 'worktree', 'list', '--porcelain']).then((r) => r.stdout, () => '')
    let path = ''
    for (const line of listed.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line === `branch refs/heads/${branch}`) return path
    }
    return undefined
  }

  /** Where a card's worktree is: the one holding its branch, else where this runner would make it. */
  private async cardWorktree(cardId: string) {
    return (await this.worktreeHolding(`binders/${cardId}`)) ?? join(this.worktreesRoot(), `${basename(this.options.workspace)}-${cardId}`)
  }

  private worktreeQueue: Promise<void> = Promise.resolve()


  /**
   * Binders' MCP server for one run, in the form the tool reads, in a file only this user can read, gone when the run
   * ends: Claude Code's and Copilot's MCP settings, or OpenCode's config. Codex takes it on its command line. Named
   * `mcpServer`, so it can't merge into a server of the user's own called "binders" (the Mac app's, on stdio).
   */
  private async mcpConfig(settings: RunnerSettings): Promise<{ path?: string; env: Record<string, string>; quiet?: string[] }> {
    // An enterprise MCP config on this machine: Claude Code refuses any other server, so it runs without Binders', or
    // with Binders' from the managed config when it lists it.
    if (!this.usesMcp(settings) && toolInfo(settings.tool).mcp) return { env: {} }
    if (settings.tool === 'claude' && this.managedAllowed) return { env: {} }
    // Codex on another provider's model: the user's own MCP servers stay off for the run, as one tool schema such a
    // provider refuses (a top-level anyOf, say) fails every request. The hub's is the one it needs.
    if (settings.tool === 'codex' && settings.model && /^[A-Za-z][\w-]*\//.test(settings.model)) return { env: {}, quiet: (await codexServers()).filter((n) => n !== mcpServer) }
    const url = `${this.options.hubUrl}/mcp`
    const headers = { Authorization: `Bearer ${this.options.token}` }
    const config = settings.tool === 'opencode'
      ? { $schema: 'https://opencode.ai/config.json', mcp: { [mcpServer]: { type: 'remote', url, headers, enabled: true } } }
      : settings.tool === 'claude' || settings.tool === 'copilot' || settings.tool === 'custom'
        ? { mcpServers: { [mcpServer]: { type: 'http', url, headers, ...(settings.tool === 'copilot' ? { tools: ['*'] } : {}) } } }
        : undefined
    if (!config) return { env: {} }
    const path = await ownFile(`mcp-${randomBytes(6).toString('hex')}.json`)
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    return { path, env: settings.tool === 'opencode' ? { OPENCODE_CONFIG: path } : {} }
  }

  prompt(card: CardJSON, dir: string, brief = '') {
    const answer = card.resume ? [...(card.conversation ?? [])].reverse().find((c) => c.kind === 'answer' || c.kind === 'comment') : undefined
    return [
      card.resume
        ? `A person wrote on Binders card ${card.id} (“${card.title}”): “${answer?.text ?? ''}”. Carry on with the card.`
        : `You're ${this.name}, one of this team's agents, and you've taken Binders card ${card.id}: “${card.title}”.`,
      '',
      ...(brief ? [brief] : []),
      `1. Read it with get_task (id ${card.id})${card.note ? `, and its note with get_note (id ${card.note.id})` : ''}.`,
      `2. Do what it asks, in ${dir}.`,
      '3. Say what you are doing and your plan with report_progress (your tool steps are reported for you).',
      '4. If you need a person, use ask, then stop: you will be started again with their answer.',
      `5. When it's done, complete_task with a summary, and the pull request if you opened one: against the default branch (main), never another card's branch, with "binders-card: ${card.id}" in its description. If you can't do it, release_task with why.`,
    ].join('\n')
  }

  /** For an agent without Binders' tools: the card and its note written out, and what to print when done. */
  async plainPrompt(card: CardJSON, dir: string, brief = '') {
    const full = await this.call<CardJSON>('get_task', { id: card.id }).catch(() => card)
    const note = full.note ? await this.call<{ text?: string }>('get_note', { id: full.note.id }).catch(() => undefined) : undefined
    const answer = card.resume ? [...(full.conversation ?? [])].reverse().find((c) => c.kind === 'answer' || c.kind === 'comment') : undefined
    return [
      `You're ${this.name}, one of this team's agents, working on a card from its board: “${full.title}”.`,
      brief ? `\n${brief}` : '',
      full.brief ? `\nWhat it asks:\n${full.brief}` : '',
      full.done_when ? `\nDone when:\n${full.done_when}` : '',
      full.quote ? `\nFrom the note, word for word:\n> ${full.quote}` : '',
      note?.text ? `\nThe note it came from:\n\n${note.text.slice(0, 20_000)}` : '',
      answer ? `\nA person just wrote on it: “${answer.text}”` : '',
      `\nDo it in ${dir}. When you're done, end with a short summary of what you did: it goes on the card.`,
      `\nLeave what you change in that folder: don't commit, push or open a pull request yourself, in a browser or otherwise. The runner commits your changes on the card's branch, pushes them and opens the card's pull request for you, so it's linked to the card and joins its change set.`,
      `\nBinders' own tools aren't available here. Where the card asks for a Binders action (proposing work items, making a card, adding to a note), don't call it: end your reply with the actions as JSON between <binders-actions> and </binders-actions>, a list of {"tool": …, "args": …}, and the runner takes them for you. When the card needs a person to decide or answer something, ask them (the ask action) rather than deciding it yourself or finishing: the card waits for them. The ones it takes:\n${Object.entries(proxied).map(([tool, args]) => `- ${tool}: ${args}`).join('\n')}${full.note ? `\nThe note's id is ${full.note.id}.` : ''}`,
    ].filter(Boolean).join('\n')
  }

  /**
   * A repo's brief for the top of a prompt, with what agents learned since. A repo with none, or one far behind its
   * default branch, has this agent asked to write it, beside its other work, when this machine has a clone of it: the
   * next agent there gets it.
   */
  async briefFor(repo: string | undefined, lessonsTool: boolean) {
    if (!repo) return ''
    const brief = await this.call<BriefRead>('get_repo_brief', { repo }).catch(() => undefined)
    if (!brief) return ''
    const clone = await this.cloneOf(repo)
    const behind = brief.text && brief.written_from && clone ? await behindBy(clone, brief.written_from).catch(() => undefined) : undefined
    const asked = brief.ask && (brief.ask.state === 'asked' || brief.ask.state === 'writing')
    if (clone && !asked && (!brief.text || briefDue(brief, behind))) {
      void this.call('request_repo_brief', { repo, refresh: !!brief.text }).then(() => this.log(`Asked to ${brief.text ? 'write again' : 'write'} ${repo}’s brief.`), () => {})
    }
    return briefSection(brief, { behind, lessonsTool })
  }

  /** This machine's clone of a repo: the runner's workspace, or a repo directly in it. */
  private async cloneOf(repo: string) {
    const want = repo.toLowerCase()
    const workspace = this.options.workspace
    const top = await run('git', ['-C', workspace, 'rev-parse', '--show-toplevel']).then((r) => r.stdout.trim(), () => '')
    if (top) return (await repoOf(top))?.toLowerCase() === want ? top : undefined
    const entries = await readdir(workspace, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).slice(0, 200)) {
      const dir = join(workspace, entry.name)
      if ((await repoOf(dir))?.toLowerCase() === want) return dir
    }
    return undefined
  }

  /**
   * A repo's brief to write: the agent reads its default branch in a checkout of its own, changes nothing, and writes
   * the brief to a file, which the runner sends. Written again, it starts from the last one and what's changed since.
   */
  async brief(job: BriefJSON): Promise<void> {
    const settings = await this.settings()
    this.log(`${job.asked_by ?? 'Someone'} asked for ${job.repo}’s brief${job.refresh ? ' to be written again' : ''}.`)
    const send = (args: Record<string, unknown>) => this.call('send_repo_brief', { repo: job.repo, ...args })
    const doing = (text: string) => send({ doing: short(text, 120) }).catch(() => {})
    const key = `brief-${job.id}`
    this.sessions.delete(key)
    let answer = ''
    let checkout: Awaited<ReturnType<typeof briefCheckout>> | undefined
    let why: string | undefined
    try {
      const clone = await this.cloneOf(job.repo)
      if (!clone) throw new Error(`${job.repo} isn’t on this machine: there’s no clone of it in ${this.options.workspace}.`)
      await doing('Checking out its default branch')
      checkout = await briefCheckout(clone, join(this.worktreesRoot(), `brief-${randomBytes(4).toString('hex')}`))
      answer = await agentFile(checkout.dir, `brief-${randomBytes(6).toString('hex')}.md`)
      await carryClaudeSettings([clone, this.options.workspace], checkout.dir).catch(() => false)
      const before = await this.call<BriefRead>('get_repo_brief', { repo: job.repo }).catch(() => undefined)
      const since = before?.text && before.written_from ? await changesSince(checkout.dir, before.written_from, checkout.sha) : undefined
      const prompt = briefPrompt({ name: this.name, job, dir: checkout.dir, sha: checkout.sha, branch: checkout.branch, answer, before, since })
      await doing(before?.text ? 'Reading what changed since the last brief' : 'Reading the repo')
      const ran = await this.runWithRoom(settings, key, prompt, checkout.dir, { BINDERS_BRIEF: job.repo }, Math.min(settings.timeoutMinutes, 30), (reader) => {
        const step = reader.take(false).steps.at(-1)
        if (step) void doing(`${step.tool} ${step.text}`)
      })
      // Claude Code refused Binders' tools here: it's started again without them.
      if (ran.managedMcp) return this.brief(job)
      const text = !ran.timedOut && !ran.cutOff ? (await readFile(answer, 'utf8').catch(() => '')).trim() : ''
      if (text) await send({ text: text.slice(0, briefMost), sha: checkout.sha }).catch((error) => { why = (error as Error).message })
      else {
        why = ran.idle
          ? this.idleWhy(ran, settings)
          : ran.timedOut
            ? 'It ran past 30 minutes and was stopped.'
            : ran.exit.code
              ? stoppedWith(ran, this.options.hubUrl)
              : `The agent stopped without writing the brief to its file${ran.reader.summary.last ? `. Its last words: ${ran.reader.summary.last}` : ''}.`
      }
    } catch (error) {
      why = (error as Error).message
    } finally {
      if (answer) await rm(answer, { force: true })
      await checkout?.remove()
    }
    if (why) {
      await send({ failed: why }).catch(() => {})
      this.log(`Couldn’t write ${job.repo}’s brief: ${why}`)
    } else {
      this.log(`Wrote ${job.repo}’s brief.`)
    }
  }

  private terminals?: Terminals

  /**
   * A terminal its owner opened from the web app: the agent's tool as they'd start it themselves, with its access, model
   * and Binders' MCP tools, in a worktree of its own (left behind if anything was changed or committed in it).
   */
  private async terminal(sid: string, by: string): Promise<Started> {
    const settings = await this.settings()
    const tool = toolInfo(settings.tool)
    const dir = await this.directoryFor({ id: sid, title: `${tool.name} for ${by}` } as CardJSON, settings)
    const config = await this.mcpConfig(settings)
    const built = this.interactiveFor(settings, dir, config.path, config.quiet)
    const command = await whereIs(built.command)
    if (!command) throw new Error(`${tool.name} isn’t installed on this machine (no “${built.command}” on the PATH or in the usual places).`)
    return {
      command, args: built.args, cwd: dir, tool: tool.name,
      env: { ...config.env, BINDERS_URL: this.options.hubUrl, BINDERS_TOKEN: this.options.token },
      done: async () => {
        if (config.path) await rm(config.path, { force: true })
        await this.tidyWorktree(dir, sid)
      },
    }
  }

  /** A terminal's worktree, gone once it ends if nothing was changed or committed in it; kept otherwise. */
  private async tidyWorktree(dir: string, sid: string) {
    if (dir === this.options.workspace) return
    const git = (...args: string[]) => run('git', ['-C', dir, ...args]).then((r) => r.stdout.trim())
    const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => '')
    if (!common) return
    const changed = await git('status', '--porcelain').catch(() => '?')
    const ahead = await git('rev-list', '--count', 'HEAD', '--not', '--remotes').catch(() => '?')
    if (changed || ahead !== '0') {
      this.log(`Kept the terminal’s worktree, with its work: ${dir}`)
      return
    }
    const repo = join(common, '..')
    await run('git', ['-C', repo, 'worktree', 'remove', '--force', dir]).catch(() => undefined)
    await run('git', ['-C', repo, 'branch', '-D', `binders/${sid}`]).catch(() => undefined)
  }

  /** The agent's tool as a person starts it in a terminal: its access, model and Binders' MCP tools, no prompt. */
  /**
   * What Claude Code may do beside its access: the agent's own rules (its owner's "commands it may run"), and the
   * runner's workspace to read, so the other repos there (a card's worktree is one) can be read too.
   */
  private claudeRules(settings: RunnerSettings, dir: string) {
    return [...(settings.allow?.length ? ['--allowedTools', ...settings.allow] : []), ...(resolve(dir) !== this.options.workspace ? ['--add-dir', this.options.workspace] : [])]
  }

  interactiveFor(settings: RunnerSettings, dir: string, mcp: string | undefined, quiet: string[] = []): { command: string; args: string[] } {
    const full = settings.access === 'full'
    const model = settings.model
    const plain = (command: string, args: string[]) => ({ command, args })
    switch (settings.tool) {
      case 'claude': {
        const access = full && !this.bypassOff ? 'bypassPermissions' : settings.access === 'auto' ? 'auto' : 'acceptEdits'
        // Binders' tools allowed up front, whatever its access: they're how it works with the hub.
        return plain('claude', [...(mcp ? ['--mcp-config', mcp] : []), ...(mcp || this.managedAllowed ? [`--allowedTools=mcp__${mcp ? mcpServer : this.managedServer ?? mcpServer}`] : []), ...(!mcp && !this.managedAllowed ? [plainEdits] : []), ...(mcp && this.otherBinders.length ? [`--disallowedTools=${this.otherBinders.map((n) => `mcp__${n}`).join(',')}`] : []), ...this.claudeRules(settings, dir), '--permission-mode', access, ...(model ? ['--model', model] : [])])
      }
      case 'codex': {
        const routed = model ? /^([A-Za-z][\w-]*)\/(.+)$/.exec(model) : null
        const off = quiet.flatMap((n) => ['-c', `mcp_servers.${/^[\w-]+$/.test(n) ? n : JSON.stringify(n)}.enabled=false`])
        const codexModel = routed ? ['-c', `model_provider=${JSON.stringify(routed[1])}`, '-m', routed[2], '--disable', 'plugins', ...off] : model ? ['-m', model] : []
        return plain('codex', ['-C', dir, ...(full ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']), ...codexModel,
          '-c', `mcp_servers.${mcpServer}.url=${JSON.stringify(`${this.options.hubUrl}/mcp`)}`, '-c', `mcp_servers.${mcpServer}.bearer_token_env_var="BINDERS_TOKEN"`])
      }
      case 'opencode':
        return plain('opencode', [...(model ? ['-m', model] : [])])
      case 'copilot':
        return plain('copilot', [full ? '--allow-all' : '--allow-all-tools', ...(mcp ? ['--additional-mcp-config', `@${mcp}`] : []), ...(model ? ['--model', model] : [])])
      case 'pi':
        return plain('pi', [...(model ? ['--model', model] : [])])
      case 'gemini':
        return plain('gemini', [...(full ? ['-y'] : ['--approval-mode', 'auto_edit']), ...(model ? ['-m', model] : [])])
      case 'cursor':
        return plain('cursor-agent', [...(full ? ['--force'] : []), ...(model ? ['--model', model] : [])])
      case 'amp':
        return plain('amp', full ? ['--dangerously-allow-all'] : [])
      case 'goose':
        return plain('goose', ['session'])
      case 'aider':
        return plain('aider', [...(model ? ['--model', model] : [])])
      case 'qwen':
        return plain('qwen', [...(full ? ['-y'] : []), ...(model ? ['-m', model] : [])])
      default:
        throw new Error('This agent runs a command of its own, which has no terminal form: pick one of the tools in its settings to open it in a terminal.')
    }
  }

  /** The command line for the agent's tool, with its access, model and session, or the custom one filled in. */
  commandFor(settings: RunnerSettings, key: string, dir: string, mcp: string | undefined, prompt: string, quiet: string[] = []): { command: string; args: string[]; shell: boolean; env: Record<string, string> } {
    const full = settings.access === 'full'
    const model = settings.model
    const session = this.sessions.get(key)
    const effort = (settings as RunnerSettings & { effort?: Effort }).effort
    const plain = (command: string, args: string[], env: Record<string, string> = {}) => ({ command, args, shell: false, env })
    switch (settings.tool) {
      case 'claude': {
        const access = full && !this.bypassOff ? 'bypassPermissions' : settings.access === 'auto' ? 'auto' : 'acceptEdits'
        // Binders' tools allowed up front: run headless, a tool that needs asking is refused, and with Edits or Auto
        // access an MCP tool does.
        return plain('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...(mcp ? ['--mcp-config', mcp] : []), ...(mcp || this.managedAllowed ? [`--allowedTools=mcp__${mcp ? mcpServer : this.managedServer ?? mcpServer}`] : []), ...(!mcp && !this.managedAllowed ? [plainEdits] : []), ...(mcp && this.otherBinders.length ? [`--disallowedTools=${this.otherBinders.map((n) => `mcp__${n}`).join(',')}`] : []), ...this.claudeRules(settings, dir), '--permission-mode', access, ...(model ? ['--model', model] : []), ...(session ? ['--resume', session] : [])],
          // The reasoning asked for, as how much it may think before each answer.
          effort ? { MAX_THINKING_TOKENS: String(thinkingTokens[effort]) } : {})
      }
      case 'codex': {
        // "foundry/gpt-5.3-codex": the provider named in ~/.codex/config.toml ([model_providers.foundry]) and its model,
        // for this run alone, so the machine's own Codex default stays as it is.
        const routed = model ? /^([A-Za-z][\w-]*)\/(.+)$/.exec(model) : null
        // Plugins and the user's own MCP servers stay off for another provider's model: their tools (an iMessage
        // plugin's send_message, say) can carry schemas such a provider refuses, failing the whole request.
        const off = quiet.flatMap((n) => ['-c', `mcp_servers.${/^[\w-]+$/.test(n) ? n : JSON.stringify(n)}.enabled=false`])
        const codexModel = routed ? ['-c', `model_provider=${JSON.stringify(routed[1])}`, '-m', routed[2], '--disable', 'plugins', ...off] : model ? ['-m', model] : []
        // The reasoning asked for (a debrief's or Challenge's), over the model's own default.
        if (effort) codexModel.push('-c', `model_reasoning_effort="${effort}"`)
        return plain('codex', ['exec', '--json', '--skip-git-repo-check', '-C', dir, ...(full ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']), ...codexModel,
          '-c', `mcp_servers.${mcpServer}.url=${JSON.stringify(`${this.options.hubUrl}/mcp`)}`, '-c', `mcp_servers.${mcpServer}.bearer_token_env_var="BINDERS_TOKEN"`, prompt])
      }
      case 'opencode':
        // Its config (with Binders' MCP server) comes from OPENCODE_CONFIG.
        return plain('opencode', ['run', ...(full ? ['--auto'] : []), ...(model ? ['-m', model] : []), ...(session ? ['--session', session] : []), prompt])
      case 'copilot':
        return plain('copilot', ['-p', prompt, '-s', full ? '--allow-all' : '--allow-all-tools', ...(mcp ? ['--additional-mcp-config', `@${mcp}`] : []), ...(model ? ['--model', model] : [])])
      case 'pi':
        return plain('pi', ['-p', '--no-session', ...(model ? ['--model', model] : []), prompt])
      case 'gemini':
        return plain('gemini', ['-p', prompt, ...(full ? ['-y'] : ['--approval-mode', 'auto_edit']), ...(model ? ['-m', model] : [])])
      case 'cursor':
        return plain('cursor-agent', ['-p', prompt, '--output-format', 'text', ...(full ? ['--force'] : []), ...(model ? ['--model', model] : [])])
      case 'amp':
        return plain('amp', ['-x', prompt, '--dangerously-allow-all'])
      case 'goose':
        return plain('goose', ['run', '-t', prompt])
      case 'aider':
        return plain('aider', ['--message', prompt, '--yes-always', ...(model ? ['--model', model] : [])])
      case 'qwen':
        return plain('qwen', ['-p', prompt, ...(full ? ['-y'] : []), ...(model ? ['-m', model] : [])])
      default: {
        const filled = (settings.command ?? '').replaceAll('{prompt}', shellQuote(prompt)).replaceAll('{dir}', shellQuote(dir)).replaceAll('{mcp}', shellQuote(mcp ?? ''))
        return { command: filled, args: [], shell: true, env: {} }
      }
    }
  }
}

const debriefSectionsHelp = [
  '   - does: what it does, in a few plain lines.',
  '   - changes: what changed, grouped by area (each an area and what changed there), not a list of files.',
  '   - against: each done-when point, in order, marked "met", "partly met" or "not met", with where: the file or test that shows it, or what\'s missing.',
  '   - look_at: risky spots, changes outside the brief, new dependencies, migrations, settings, deleted code, missing tests, failing checks. Empty if nothing stands out.',
  '   - try_it: how to try it: the build or command to run, and what to click.',
]

const testPlanHelp = [
  '   - test_plan: its functional test plan, 3 to 10 tests a person (or an agent) runs against the running product to see that it does what the done-when says, riskiest first. Each has a title; point, the done-when point it proves in its own words (leave it out for an edge case the points only imply); setup, what has to be true first (an account, a plan, some data); steps, the exact inputs and clicks, one a step; expect, what they should see when it works; and risk, "high", "medium" or "low". Test behaviour someone can see, not functions: cover every done-when point, then the edge cases the diff and the points imply (boundaries, empty and wrong input, someone without access, doing it twice). No unit tests, and nothing that needs reading the code to judge.',
]

/** The JSON objects an agent may have written its answer as: all it printed, its ```json blocks from the last, its {…}. */
function* jsonIn(output: string): Generator<Record<string, unknown>> {
  const blocks = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  const from = output.indexOf('{')
  for (const candidate of [output, ...blocks.reverse(), ...(from >= 0 ? [output.slice(from, output.lastIndexOf('}') + 1)] : [])]) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) yield value
    } catch {
      // Not this one.
    }
  }
}

/** The JSON objects an agent wrote a line at a time, as it went. */
function jsonLines(output: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  for (const line of output.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) lines.push(value)
    } catch {
      // Not a line of its answer.
    }
  }
  return lines
}

const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : value && typeof value === 'object' ? [value as T] : [])

/**
 * A debrief's sections from what an agent wrote: its lines, added as it went (areas, points and things to look at
 * gathered, a point marked again as it says last), or else one JSON object, its last ```json block, or its last {…}.
 */
export function debriefSections(output: string): DebriefSections | undefined {
  const lines = jsonLines(output).filter((l) => ['does', 'changes', 'against', 'look_at', 'try_it', 'test_plan'].some((k) => k in l))
  if (lines.length > 1) {
    const sections: DebriefSections = { does: '', changes: [], against: [], look_at: [], try_it: '' }
    for (const line of lines) {
      if (typeof line.does === 'string') sections.does = line.does
      if (typeof line.try_it === 'string') sections.try_it = line.try_it
      if (Array.isArray(line.test_plan)) sections.test_plan = line.test_plan as DebriefSections['test_plan']
      sections.changes.push(...listOf<DebriefSections['changes'][number]>(line.changes))
      sections.look_at.push(...listOf<string>(line.look_at).filter((l) => typeof l === 'string'))
      for (const point of listOf<DebriefSections['against'][number]>(line.against)) {
        const at = sections.against.findIndex((p) => String(p.point).trim().toLowerCase() === String(point.point).trim().toLowerCase())
        if (at >= 0) sections.against[at] = point
        else sections.against.push(point)
      }
    }
    return sections
  }
  for (const value of jsonIn(output) as Generator<Partial<DebriefSections>>) {
    if (typeof value.does === 'string') return { does: value.does, changes: value.changes ?? [], against: value.against ?? [], look_at: value.look_at ?? [], try_it: value.try_it ?? '', ...(Array.isArray(value.test_plan) ? { test_plan: value.test_plan } : {}) }
  }
  return undefined
}

/**
 * A change set's diff as files, one for each changed file, for an agent without Binders' tools to read a file at a
 * time rather than all of it in its prompt. Gone with its answer once the run ends.
 */
async function diffFolder(dir: string, files: { path: string; added: number; removed: number; diff: string }[]) {
  if (!files.length) return { dir, list: '' }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const lines: string[] = []
  for (const [i, f] of files.entries()) {
    const name = `${String(i + 1).padStart(3, '0')}-${f.path.replace(/[^\w.-]+/g, '_').slice(-80)}.diff`
    await writeFile(join(dir, name), `${f.path}\n${f.diff}\n`)
    lines.push(`- ${name}: ${f.path} (+${f.added} −${f.removed})`)
  }
  return { dir, list: lines.join('\n') }
}

/** Where a reviewer may read and run the work, if this machine could check it out. */
const checkedOut = (dir: string | undefined) => (dir ? `The work is checked out in ${dir} for you to read and run; change nothing there.` : 'The work isn\'t checked out on this machine: judge it from the diff, and change nothing.')

const challengeHelp = [
  '   - Look for bugs, done-when points it doesn\'t meet, security problems, edge cases, what it breaks elsewhere (callers, other repos), and simpler ways to do it. Try it: run its tests, trace the code.',
  '   - Each finding: kind ("bug", "done-when", "security", "edge case", "breaks" or "simpler"); file and line (the numbers beside the diff, or the line in the file you read); what goes wrong (the inputs or state, and the wrong result); confidence ("confirmed" if you showed it, by a test or tracing the code, "plausible" if it could); severity ("high", "medium" or "low"); and fix, if you see one.',
  '   - Only real problems: no style notes, nothing you can\'t point to. No findings at all is a fine answer when that\'s the truth; say so in the summary.',
]

const repliesHelp = [
  '   - If it\'s right, fix it there, run the tests, commit, and push to the pull request\'s branch if there is one; reply "fixed" and say what you changed.',
  '   - If it\'s wrong, change nothing for it; reply "disagree" and say why, pointing at the code or test that shows it.',
  '   - Judge each on the code, not on who found it. Don\'t fix what isn\'t wrong to make a finding go away.',
]

/** The author's replies to a Challenge's findings from what an agent wrote, found as a debrief's sections are. */
export function findingReplies(output: string): FindingReplies | undefined {
  for (const value of jsonIn(output) as Generator<Partial<FindingReplies>>) {
    if (!Array.isArray(value.replies)) continue
    return { replies: value.replies.filter((r) => r && typeof r === 'object').map((r) => ({ finding: String(r.finding ?? ''), verdict: String(r.verdict ?? '').toLowerCase(), why: String(r.why ?? '') })) }
  }
  return undefined
}

/** A Challenge's findings from what an agent wrote, found as a debrief's sections are. */
export function challengeFindings(output: string): ChallengeFindings | undefined {
  // Its lines, a finding at a time as it went, and the summary last.
  const lines = jsonLines(output).filter((l) => 'finding' in l || 'findings' in l || 'summary' in l)
  if (lines.length > 1 || lines.some((l) => 'finding' in l)) {
    const all = lines.flatMap((l) => [...listOf<Record<string, unknown>>(l.finding), ...listOf<Record<string, unknown>>(l.findings)])
    const summary = [...lines].reverse().find((l) => typeof l.summary === 'string')?.summary as string | undefined
    return challengeFindings(JSON.stringify({ summary: summary ?? '', findings: all }))
  }
  for (const value of jsonIn(output) as Generator<Partial<ChallengeFindings>>) {
    if (!Array.isArray(value.findings)) continue
    // As send_challenge takes them: a line as a number, and no fix rather than a null one.
    const findings = value.findings.filter((f) => f && typeof f === 'object').map((f) => ({ kind: String(f.kind ?? ''), file: String(f.file ?? ''), line: Number(f.line), what: String(f.what ?? ''), confidence: String(f.confidence ?? ''), severity: String(f.severity ?? ''), ...(typeof f.fix === 'string' && f.fix ? { fix: f.fix } : {}) }))
    return { summary: typeof value.summary === 'string' ? value.summary : '', findings }
  }
  return undefined
}

/**
 * Where a tool's command is: on the PATH, or where installers put it when they don't add it to the PATH a runner
 * started from a terminal or a service sees (~/.opencode/bin, ~/.local/bin, Homebrew, Bun, npm's global folder).
 */
async function whereIs(command: string) {
  if (command.includes('/')) return command
  const onPath = await run('/bin/sh', ['-c', `command -v ${shellQuote(command)}`]).then((r) => r.stdout.trim(), () => '')
  if (onPath) return onPath
  const home = homedir()
  for (const dir of [`${home}/.${command}/bin`, `${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${home}/.bun/bin`, `${home}/.npm-global/bin`, `${home}/.cargo/bin`, `${home}/go/bin`]) {
    const path = join(dir, command)
    if (await run('/bin/test', ['-x', path]).then(() => true, () => false)) return path
  }
  return undefined
}

/** The last paragraph an agent printed, as its reply or summary. */
function lastWords(output: string) {
  const text = output.trim()
  if (!text) return undefined
  const paragraphs = text.split(/\n\s*\n/)
  return paragraphs.slice(-3).join('\n\n').slice(-4000)
}

/** The providers set up in Codex's config besides its own: only the names of its [model_providers.…] tables. */
export async function codexProviders(home = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  const config = await readFile(join(home, 'config.toml'), 'utf8').catch(() => '')
  const names = [...config.matchAll(/^\s*\[model_providers\.(?:"([^"]+)"|([\w-]+))\]\s*$/gm)].map((m) => m[1] ?? m[2])
  return [...new Set(names)].filter((n) => n !== 'openai')
}

/** The MCP servers in Codex's config (plugins' aside), by name. */
async function codexServers(): Promise<string[]> {
  try {
    const { stdout } = await run((await whereIs('codex')) ?? 'codex', ['mcp', 'list', '--json', '--disable', 'plugins'], { timeout: 20_000 })
    return (JSON.parse(stdout) as { name?: string }[]).map((s) => s.name).filter((n): n is string => !!n)
  } catch {
    return []
  }
}

/** What Codex lists for a provider (its own when none is named): each model it offers, as provider/model for another's. */
async function codexModels(provider?: string) {
  const { stdout } = await run((await whereIs('codex')) ?? 'codex', ['debug', 'models', ...(provider ? ['-c', `model_provider=${JSON.stringify(provider)}`] : [])], { timeout: 20_000 })
  const models = (JSON.parse(stdout) as { models?: { slug?: string; visibility?: string }[] }).models ?? []
  return models.filter((m) => m.slug && m.visibility !== 'hide').map((m) => (provider ? `${provider}/${m.slug}` : m.slug!))
}

/** The models a tool can use on this machine: fixed names for Claude Code, and what Codex, OpenCode and Pi list. */
async function modelsOf(tool: string): Promise<string[]> {
  const fixed = toolInfo(tool as RunnerSettings['tool']).models
  if (fixed) return fixed
  try {
    if (tool === 'codex') {
      const lists = await Promise.all([undefined, ...(await codexProviders())].map((p) => codexModels(p).catch(() => [] as string[])))
      return lists.flat()
    }
    if (tool === 'opencode') {
      const { stdout } = await run((await whereIs('opencode')) ?? 'opencode', ['models'], { timeout: 20_000 })
      return stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l))
    }
    if (tool === 'pi') {
      const { stdout } = await run((await whereIs('pi')) ?? 'pi', ['--list-models'], { timeout: 20_000 })
      return stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] && c[1]).map(([provider, id]) => `${provider}/${id}`)
    }
  } catch {
    // Not installed, or it couldn't say.
  }
  return []
}

/** Claude Code's MCP servers here (`claude mcp list`), when it's installed; none when it can't say. */
async function claudeServers(dir: string) {
  const claude = await whereIs('claude')
  if (!claude) return []
  const listed = await run(claude, ['mcp', 'list'], { cwd: dir, timeout: 30_000 }).then((r) => r.stdout, () => '')
  return parseMcpList(listed)
}

/** Binders' server among Claude Code's own, when it lists one. */
async function claudeBinders(dir: string, hubUrl: string) {
  return bindersAmong(await claudeServers(dir), hubUrl)
}
