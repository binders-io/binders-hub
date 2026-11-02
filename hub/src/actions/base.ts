import { tools } from '../../../shared/agents.ts'
import { barredBecause, type AgentReach } from '../reach.ts'
import type { Change } from '../../../shared/state.ts'
import { cardChangeSet, type AskedEffort, type BlastRadius, type BlastSymbol, cardsOfSet, setChangeSet, setOfCard, type Challenge, type Debrief } from '../../../shared/changeSet.ts'
import { defaultRunner, type Activity, type Agent, type Card, type ChangeSet, type PullRequest, type RunnerSettings } from '../../../shared/work.ts'
import type { GitHub } from '../github.ts'
import { Refused, type Actor, type Hub } from '../hub.ts'

// What people and agents do that's more than one change: accepting a proposal, taking and finishing a card, approving
// a change set, promoting a version. Each works out its changes from the hub's state and records them in order. With
// GitHub set up, the ones that touch GitHub do so first; without it, the hub records what GitHub would have said.

/** GitHub as the hub for a repo (its app's installation, or the token it was given), and as a person. */
export interface GitHubAccess {
  forRepo(repo: string): Promise<GitHub | undefined>
  asUser(token: string): GitHub
}

/** What a debrief or Challenge is of: a whole change set (all its pull requests together), or a card with no set yet. */
export type Subject =
  | { kind: 'card'; id: string; card: Card; cards: Card[]; binderId: string; title: string; debrief?: Debrief; challenge?: Challenge }
  | { kind: 'set'; id: string; set: ChangeSet; cards: Card[]; binderId: string; title: string; debrief?: Debrief; challenge?: Challenge }

/** A blast radius as kept: within what a change set's log should carry. */
export function keptBlast(blast: BlastRadius): BlastRadius {
  const text = (value: unknown, most: number) => String(value ?? '').slice(0, most)
  const symbols = (Array.isArray(blast.symbols) ? blast.symbols : []).slice(0, 80).map((s) => ({
    name: text(s.name, 120), file: text(s.file, 300), change: (['added', 'changed', 'removed'].includes(s.change) ? s.change : 'changed') as BlastSymbol['change'],
    uses: (Array.isArray(s.uses) ? s.uses : []).slice(0, 20).map((u) => ({ file: text(u.file, 300), line: Math.max(0, Math.floor(Number(u.line)) || 0), text: text(u.text, 200) })),
    ...(Number(s.more) > 0 ? { more: Math.floor(Number(s.more)) } : {}),
    tests: (Array.isArray(s.tests) ? s.tests : []).slice(0, 10).map((t) => text(t, 300)),
  }))
  const count = (value: unknown) => Math.max(0, Math.floor(Number(value)) || 0)
  return tidy<BlastRadius>({
    at: text(blast.at, 40), repo: blast.repo ? text(blast.repo, 200) : undefined, symbols,
    outside: count(blast.outside), stillUsed: count(blast.stillUsed), untested: count(blast.untested),
    elsewhere: Array.isArray(blast.elsewhere) ? blast.elsewhere.slice(0, 20).map((r) => text(r, 200)) : undefined,
    cut: blast.cut ? count(blast.cut) : undefined,
  })
}

/** A change set that hasn't shipped: one a debrief or Challenge is still worth having. */
export const openSet = (set: ChangeSet) => set.state !== 'merged' && set.state !== 'shipped'

/** "low reasoning for 24 changed lines" (picked by size), or "high reasoning" (picked by a person). */
export const reasoningText = (r: AskedEffort) => `${r.level} reasoning${r.auto ? ` for ${r.lines} changed line${r.lines === 1 ? '' : 's'}` : ''}`

/** The most findings a Challenge keeps. */
export const maxFindings = 80

/** The same words, as a done-when point is matched: case, spacing and a trailing full stop aside. */
export const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').replace(/[.。]$/, '').toLowerCase() === b.trim().replace(/\s+/g, ' ').replace(/[.。]$/, '').toLowerCase()


/** Without the fields left undefined, as they'd be in the log once read back. */
export function tidy<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** GitHub's word on whether a pull request merges, in the hub's terms. */
export function mergeableOf(info: { mergeable: boolean | null; mergeableState: string }): NonNullable<PullRequest['mergeable']> {
  if (info.mergeable === false || info.mergeableState === 'dirty') return 'conflicts'
  if (info.mergeableState === 'behind') return 'behind'
  if (info.mergeableState === 'blocked') return 'blocked'
  return info.mergeable === null ? 'unknown' : 'clean'
}

/** A runner's settings, checked: only the choices there are, and a time limit that makes sense. */
export function checkedRunner(runner: Partial<RunnerSettings>): RunnerSettings {
  const tool = runner.tool ?? defaultRunner.tool
  const access = runner.access ?? defaultRunner.access
  if (!tools.some((t) => t.id === tool)) throw new Refused(`The runner’s tool is one of ${tools.map((t) => t.id).join(', ')}.`)
  if (!['full', 'auto', 'edits'].includes(access)) throw new Refused('The runner’s access is full, auto or edits.')
  const timeoutMinutes = Number(runner.timeoutMinutes ?? defaultRunner.timeoutMinutes)
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 24 * 60) throw new Refused('A card’s time limit is from 1 minute to a day.')
  if (tool === 'custom' && !runner.command?.trim()) throw new Refused('A custom tool needs its command.')
  const parallel = Math.max(1, Math.min(8, Math.round(Number(runner.parallel ?? 3)) || 1))
  // How long it may say nothing before its run is stopped as stuck: left to the runner (15) unless set.
  const idle = runner.idleMinutes === undefined || runner.idleMinutes === null ? undefined : Number(runner.idleMinutes)
  if (idle !== undefined && !(idle > 0 && idle <= 24 * 60)) throw new Refused('How long an agent may say nothing is from a moment to a day, in minutes.')
  return { tool, access, timeoutMinutes, ...(idle !== undefined ? { idleMinutes: idle } : {}), parallel, worktrees: true, model: runner.model?.trim() || undefined, command: tool === 'custom' ? runner.command!.trim() : undefined, workspace: runner.workspace?.trim() || undefined, ...(runner.commitAs === 'app' ? { commitAs: 'app' as const } : {}) }
}

/** 0.1.0 → 0.2.0: what a recorded deploy calls the next version. */
export function bump(version: string) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return parts ? `${parts[1]}.${Number(parts[2]) + 1}.0` : '0.1.0'
}

/** What every part of the hub's actions stands on: the hub, GitHub, and finding what an action is about. */
export abstract class ActionsBase {
  protected hub: Hub
  protected github: GitHubAccess

  /** What agents may reach on GitHub: their owners' reach. None: no limit (a hub without GitHub, and tests). */
  reach?: AgentReach
  /** Cards an agent was turned away from for its owner's reach, until when, so they aren't offered again meanwhile. */
  protected turnedAway = new Map<string, number>()

  constructor(hub: Hub, github: GitHubAccess) {
    this.hub = hub
    this.github = github
  }

  /** The repo a card's work is in: its project's. */
  repoOf(card: Card) {
    return this.hub.state.binders.find((b) => b.id === card.binderId)?.repo
  }

  /** Cards this agent was turned away from lately, to leave out of what it's offered. */
  barred(agentId: string) {
    const now = Date.now()
    const out: string[] = []
    for (const [key, until] of this.turnedAway) {
      if (until < now) this.turnedAway.delete(key)
      else if (key.startsWith(`${agentId}/`)) out.push(key.slice(agentId.length + 1))
    }
    return out
  }

  /**
   * Throws when the agent's owner can't push to the repo (the card's project's, unless named), or GitHub can't say, and
   * keeps the card from being offered to it for a while.
   */
  protected async mayWorkOn(agent: Agent, card: Card, repo = this.repoOf(card)) {
    if (!repo || !this.reach) return
    let why: string | undefined
    let forMs = 10 * 60_000
    try {
      why = barredBecause(await this.reach.owner(agent.owner, repo), agent.owner, repo)
    } catch {
      why = `GitHub didn’t say whether ${agent.owner}, who set this agent up, can push to ${repo}. Try again in a moment.`
      forMs = 60_000
    }
    if (!why) return
    this.turnedAway.set(`${agent.id}/${card.id}`, Date.now() + forMs)
    throw new Refused(why)
  }

  /**
   * A token for a card the agent holds, for its run: for the repo it works in (named, as the runner's workspace's; it
   * must be the card's project's or one of the agent's own) or else the project's, for an hour, while the agent's owner
   * can still push there.
   */
  async runToken(agentId: string, cardId: string, named?: string) {
    const agent = this.agent(agentId)
    const card = this.held(agentId, cardId)
    const project = this.repoOf(card)
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
    if (named && !same(named, project) && !agent.repos.some((r) => same(r, named))) throw new Refused(`${named} isn’t this card’s binder’s repo or one of ${agent.name}’s repos: add it to the agent’s repos to work there.`)
    const repo = named ?? project
    if (!repo) throw new Refused('That card’s binder has no repo, and no repo was named.')
    if (!this.reach) throw new Refused('This hub doesn’t hand out repo tokens: use this machine’s own GitHub login.')
    await this.mayWorkOn(agent, card, repo)
    // As its owner (the default): their own sign-in, so commits, pushes and pull requests are theirs. As the app, or
    // when the hub holds no sign-in of theirs: the app's token for that repo alone.
    const wanted = agent.runner?.commitAs === 'app' ? 'app' : 'owner'
    const owned = wanted === 'owner' ? await this.reach.ownerToken?.(agent.owner).catch(() => undefined) : undefined
    const made = owned ? { token: owned, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() } : await this.reach.runToken(repo)
    if (!made) throw new Refused(`This hub can’t make a token for ${repo} alone (no GitHub App, or it isn’t installed there): use this machine’s own GitHub login.`)
    const as = owned ? 'owner' : 'app'
    const author = await this.reach.author?.(as, made.token).catch(() => undefined)
    return { repo, token: made.token, expires_at: made.expiresAt, github: this.reach.webUrl, as, ...(author ? { author } : {}) }
  }

  /** GitHub as this person, with their token from signing in, or as the hub for the repo. */
  async githubAs(repo: string, token?: string) {
    return token ? this.github.asUser(token) : this.github.forRepo(repo)
  }

  protected card(id: string) {
    const card = this.hub.state.cards.find((c) => c.id === id)
    if (!card) throw new Refused(`No card ${id}.`)
    return card
  }

  /** What a debrief or Challenge is of, exactly as named: a change set, or a card. */
  protected exact(id: string): Subject {
    const set = this.hub.state.changeSets.find((s) => s.id === id)
    if (set) {
      // Named as people say it: "change set 3", and its title when it has one of its own.
      const title = new RegExp(`^change set #?${set.number}$`, 'i').test(set.title.trim()) || !set.title.trim() ? `change set ${set.number}` : `change set ${set.number}, ${set.title}`
      return { kind: 'set', id: set.id, set, cards: cardsOfSet(this.hub.state, set), binderId: set.binderId, title, debrief: set.debrief, challenge: set.challenge }
    }
    const card = this.card(id)
    return { kind: 'card', id: card.id, card, cards: [card], binderId: card.binderId, title: card.title, debrief: card.debrief, challenge: card.challenge }
  }

  /**
   * What a person asking for a debrief or Challenge means: a card in a change set means its set, as they're of all its
   * pull requests together; a card not in one yet (its worktree only) is its own.
   */
  protected subject(id: string): Subject {
    const named = this.exact(id)
    const set = named.kind === 'card' ? setOfCard(this.hub.state, named.card) : undefined
    return set ? this.exact(set.id) : named
  }

  /** Its Change Set as one piece of work: a card's, or all of a change set's pull requests together. */
  protected reviewOf(subject: Subject) {
    return subject.kind === 'set' ? setChangeSet(this.hub.state, subject.id) : cardChangeSet(this.hub.state, subject.id)
  }

  /** Keeps a debrief or Challenge on what it's of; a change set's activity goes on each of its cards. */
  protected async keep(subject: Subject, actor: Actor, fields: { debrief?: Debrief; challenge?: Challenge }, activity?: Activity) {
    if (subject.kind === 'card') {
      await this.hub.record(actor, { type: 'card.update', id: subject.id, fields, ...(activity ? { activity } : {}) })
      return
    }
    const told = activity ? subject.cards.map((c): Change => ({ type: 'card.activity', id: c.id, activity: { ...activity, text: `${activity.text} (change set #${subject.set.number})` } })) : []
    await this.hub.recordAll(actor, [{ type: 'set.update', id: subject.id, fields }, ...told])
  }

  protected held(agentId: string, cardId: string) {
    const card = this.card(cardId)
    if (card.agentId !== agentId) throw new Refused('Take the card first with claim_task: it isn’t yours.')
    return card
  }

  protected agent(id: string) {
    const agent = this.hub.state.agents.find((a) => a.id === id && !a.revoked)
    if (!agent) throw new Refused('That agent isn’t set up here, or was revoked.')
    return agent
  }

  protected now() {
    return new Date().toISOString()
  }
}

// What a secret looks like, so one copied out of a config file never goes into a brief every agent reads, or a debrief everyone sees.
const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\bhf_[A-Za-z0-9]{30,}/,
]
export const looksSecret = (text: string) => secretPatterns.some((p) => p.test(text))
