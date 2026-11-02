import type { KV } from './kv.ts'
import { Refusal } from './auth.ts'

// The hub's options, changed in Settings and kept in its store, taking effect at once. An environment variable set for
// one fixes it: Settings shows it as set on the hub, and it can't be changed there.

export type PollMode = 'auto' | 'on' | 'off'
export type DevLogin = 'auto' | 'on' | 'off'
export type MergeMethod = 'merge' | 'squash' | 'rebase'
/** Who agents' commits, pushes and pull requests are by: as each agent is set (agent), or the same for all. */
export type AgentCommits = 'agent' | 'owner' | 'app'

export interface HubOptions {
  /** Following GitHub by asking: while no webhook arrives (auto), always (on), or never (off). */
  pollMode: PollMode
  pollSeconds: number
  /** How long typing pauses before a note is committed, and the longest edits wait while it doesn't. */
  notesQuietSeconds: number
  notesLongestMinutes: number
  /** How change sets merge their pull requests: merge commits keep each branch's history, so later ones clash less. */
  mergeMethod: MergeMethod
  /** Who may sign in, besides the GitHub App's maker and its organization's members. */
  allowedUsers: string[]
  allowedOrgs: string[]
  /** Who may change these options and GitHub's setup, besides the app's maker. */
  admins: string[]
  /** Signing in with a name alone: on a hub run on this machine until GitHub is set up (auto), always, or never. */
  devLogin: DevLogin
  /**
   * Who agents' commits, pushes and pull requests are by: each agent's own choice on the Agents page (agent), always its
   * owner, or always the hub's GitHub App. Fixed, it wins over every agent's setting.
   */
  agentCommits: AgentCommits
}

export const defaultOptions: HubOptions = {
  pollMode: 'auto',
  pollSeconds: 30,
  notesQuietSeconds: 60,
  notesLongestMinutes: 5,
  mergeMethod: 'merge',
  allowedUsers: [],
  allowedOrgs: [],
  admins: [],
  devLogin: 'auto',
  agentCommits: 'agent',
}

/** The environment variable that fixes each option. */
export const optionVariables: Record<keyof HubOptions, string> = {
  pollMode: 'HUB_POLL',
  pollSeconds: 'HUB_POLL_SECONDS',
  notesQuietSeconds: 'NOTES_QUIET_SECONDS',
  notesLongestMinutes: 'NOTES_LONGEST_MINUTES',
  mergeMethod: 'MERGE_METHOD',
  allowedUsers: 'HUB_ALLOWED_USERS',
  allowedOrgs: 'HUB_ALLOWED_ORGS',
  admins: 'HUB_ADMINS',
  devLogin: 'HUB_DEV_LOGIN',
  agentCommits: 'HUB_AGENT_COMMITS',
}

const list = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean)
const login = /^[A-Za-z0-9-]{1,39}$/

/** What the environment sets, read as options. */
export function optionsFromEnv(env: Record<string, string | undefined>): Partial<HubOptions> {
  const out: Partial<HubOptions> = {}
  const v = optionVariables
  if (env[v.pollMode] && ['auto', 'on', 'off'].includes(env[v.pollMode]!)) out.pollMode = env[v.pollMode] as PollMode
  if (env[v.pollSeconds]) out.pollSeconds = Number(env[v.pollSeconds])
  if (env[v.notesQuietSeconds]) out.notesQuietSeconds = Number(env[v.notesQuietSeconds])
  if (env[v.notesLongestMinutes]) out.notesLongestMinutes = Number(env[v.notesLongestMinutes])
  if (env[v.mergeMethod] && ['merge', 'squash', 'rebase'].includes(env[v.mergeMethod]!)) out.mergeMethod = env[v.mergeMethod] as MergeMethod
  if (env[v.allowedUsers]) out.allowedUsers = list(env[v.allowedUsers]!)
  if (env[v.allowedOrgs]) out.allowedOrgs = list(env[v.allowedOrgs]!)
  if (env[v.admins]) out.admins = list(env[v.admins]!)
  if (env[v.devLogin]) out.devLogin = env[v.devLogin] === '1' || env[v.devLogin] === 'on' ? 'on' : env[v.devLogin] === 'auto' ? 'auto' : 'off'
  if (env[v.agentCommits] && ['agent', 'owner', 'app'].includes(env[v.agentCommits]!)) out.agentCommits = env[v.agentCommits] as AgentCommits
  return out
}

/** Each option checked, with words for what's wrong. */
function checked(fields: Partial<HubOptions>): Partial<HubOptions> {
  const out: Partial<HubOptions> = {}
  const whole = (value: unknown, low: number, high: number, what: string) => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < low || n > high) throw new Refusal(`${what} is a whole number from ${low} to ${high}.`)
    return n
  }
  const logins = (value: unknown, what: string) => {
    if (!Array.isArray(value)) throw new Refusal(`${what} is a list.`)
    const names = value.map((v) => String(v).trim().replace(/^@/, '')).filter(Boolean)
    const bad = names.find((n) => !login.test(n))
    if (bad) throw new Refusal(`“${bad}” isn’t a GitHub name.`)
    return [...new Set(names)].slice(0, 200)
  }
  if (fields.pollMode !== undefined) {
    if (!['auto', 'on', 'off'].includes(fields.pollMode)) throw new Refusal('Following GitHub is auto, on or off.')
    out.pollMode = fields.pollMode
  }
  if (fields.pollSeconds !== undefined) out.pollSeconds = whole(fields.pollSeconds, 10, 3600, 'How often to ask GitHub, in seconds,')
  if (fields.notesQuietSeconds !== undefined) out.notesQuietSeconds = whole(fields.notesQuietSeconds, 5, 3600, 'The pause before a note is committed, in seconds,')
  if (fields.notesLongestMinutes !== undefined) out.notesLongestMinutes = whole(fields.notesLongestMinutes, 1, 120, 'The longest a note waits for its commit, in minutes,')
  if (fields.mergeMethod !== undefined) {
    if (!['merge', 'squash', 'rebase'].includes(fields.mergeMethod)) throw new Refusal('Change sets merge with merge commits, squash or rebase.')
    out.mergeMethod = fields.mergeMethod
  }
  if (fields.allowedUsers !== undefined) out.allowedUsers = logins(fields.allowedUsers, 'Who may sign in')
  if (fields.allowedOrgs !== undefined) out.allowedOrgs = logins(fields.allowedOrgs, 'Organizations whose members may sign in')
  if (fields.admins !== undefined) out.admins = logins(fields.admins, 'Admins')
  if (fields.devLogin !== undefined) {
    if (!['auto', 'on', 'off'].includes(fields.devLogin)) throw new Refusal('Signing in by name is auto, on or off.')
    out.devLogin = fields.devLogin
  }
  if (fields.agentCommits !== undefined) {
    if (!['agent', 'owner', 'app'].includes(fields.agentCommits)) throw new Refusal('Agents’ commits are by each agent’s choice, its owner, or the hub’s GitHub App.')
    out.agentCommits = fields.agentCommits
  }
  return out
}

export class OptionsStore {
  private kv: KV
  private stored: Partial<HubOptions> = {}
  private fixed: Partial<HubOptions>

  constructor(kv: KV, fromEnv: Partial<HubOptions> = {}) {
    this.kv = kv
    this.fixed = checked(fromEnv)
  }

  async load() {
    try {
      this.stored = checked(JSON.parse((await this.kv.get('options')) ?? '{}'))
    } catch {
      this.stored = {}
    }
    return this
  }

  /** The options as they are now: the defaults, then what was set in Settings, then what the environment fixes. */
  get(): HubOptions {
    return { ...defaultOptions, ...this.stored, ...this.fixed }
  }

  /** Options the environment fixes, with the variable that does. */
  locked() {
    return Object.fromEntries(Object.keys(this.fixed).map((key) => [key, optionVariables[key as keyof HubOptions]])) as Partial<Record<keyof HubOptions, string>>
  }

  async set(fields: Partial<HubOptions>) {
    const fixed = Object.keys(fields).find((key) => key in this.fixed) as keyof HubOptions | undefined
    if (fixed) throw new Refusal(`That one is set on the hub by ${optionVariables[fixed]}, so it can’t be changed here.`)
    this.stored = { ...this.stored, ...checked(fields) }
    await this.kv.set('options', JSON.stringify(this.stored))
    return this.get()
  }
}
