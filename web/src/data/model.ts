// The web app's view of the hub: the shared types, and how the board names its stages.
export type { Binder, Folder, Note, WorkLink, NotesState } from '../../../shared/notes.ts'
export type { Activity, Agent, Card, ChangeSet, Check, CheckState, DiffLine, Environment, FileDiff, PlanStep, Proposal, Provider, PullRequest, Run, Stage } from '../../../shared/work.ts'
export type { Change, Entry, HubState, Outgoing } from '../../../shared/state.ts'
import type { Profile } from '../../../shared/people.ts'
import type { Stage } from '../../../shared/work.ts'

export const stages: { id: Stage; title: string; hint: string }[] = [
  { id: 'proposed', title: 'Proposed', hint: 'Distilled from notes or suggested by agents, waiting for you' },
  { id: 'ready', title: 'Ready', hint: 'An agent can take these' },
  { id: 'working', title: 'Agents working', hint: 'Claimed, being built' },
  { id: 'blocked', title: 'Blocked', hint: 'Waiting on you: an agent’s question, or put here. Answer, or write on it, to carry on' },
  { id: 'review', title: 'In review', hint: 'Pull request open, checks running' },
  { id: 'live', title: 'Done', hint: 'Merged, or finished' },
]

export interface Me {
  user: { login: string; name: string; avatar?: string }
  /** The GitHub profiles of the people this binder names, by login in lower case: how they're shown. */
  people?: Record<string, Profile>
  /** Enterprise shortcodes left off managed users' logins when they're shown (`jdoe_acme` as `jdoe`). */
  emu?: string[]
  /** Their own GitHub, connected through the hub's OAuth App for their personal binder's repo; possible: the hub has one. */
  ownGitHub?: { connected: boolean; possible: boolean }
  github: {
    /** app: made from Settings; manual: set by hand on the hub; none: not yet. */
    mode: 'app' | 'manual' | 'none'
    app?: { name: string; slug: string; owner: string; ownerType: 'User' | 'Organization'; htmlUrl: string; installations: string[]; installUrl: string; hookUrl?: string; madeLocally: boolean; settingsUrl: string; /** Another binder's app, used here. */ borrowedFrom?: string; /** Of a borrowed app, the installations used here, by account. */ borrowedAccounts?: string[]; /** Made here and installed: other binders may use its installations their people can reach. */ shareable?: boolean; /** The binders it's lent to, and which installations: its owners may end each. */ lentTo?: { binder: string; by: string; at: string; accounts?: string[] }[] }
    signIn: boolean
    server: boolean
    webhooks: boolean
    /** Another binder's app this one used, which it can't any more, and why. */
    lost?: { from: string; why: string }
    /** This session has the person's own GitHub token. */
    token: boolean
    /** This person may change how the hub reaches GitHub. */
    admin: boolean
    /** The hub's public address is this machine's, which GitHub can't reach. */
    local: boolean
    /** Following GitHub by asking, when webhooks don't reach the hub. */
    polling?: { mode: 'auto' | 'on' | 'off'; active: boolean; everySeconds: number; webhookHeard: boolean; lastPoll?: string; lastError?: string }
  }
  publicUrl: string
  mcpUrl: string
  webhookUrl: string
  log?: 'redis' | 'memory'
  /** May run the hub: make Binders, change its options. */
  hubAdmin?: boolean
  /** Who agents' commits are by: each agent's choice (agent), or fixed for all by the hub's admins. */
  agentCommits?: 'agent' | 'owner' | 'app'
  /** The commit the hub runs, when it was built by the server's updater. */
  version?: { commit: string; subject?: string; repo?: string }
  /** For its admins: a newer commit the server didn't put in, because its tests failed, and how they ended. */
  updateFailed?: { commit: string; at?: string; subject?: string; log: string }
  /** The Binder this page is for, and what you are in it. */
  space?: string
  role?: Role
  /** The Binders you may open. */
  spaces: { id: string; name: string; role: Role }[]
}

export type Role = 'owner' | 'admin' | 'member'

/** A Binder as Settings shows it: its members only where you may change them. */
export interface SpaceView {
  id: string
  name: string
  role: Role
  createdAt: string
  members?: { login: string; role: Role }[]
}

/** The hub's options, as Settings changes them. */
export interface HubOptions {
  mergeMethod: 'merge' | 'squash' | 'rebase'
  allowedUsers: string[]
  allowedOrgs: string[]
  admins: string[]
  agentCommits: 'agent' | 'owner' | 'app'
}
