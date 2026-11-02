import type { Merger } from '../merger.ts'
import type { Change } from '../../../shared/state.ts'
import { titleOf } from '../../../shared/notes.ts'
import { cardChangeSet, setChangeSet, pullOf } from '../../../shared/changeSet.ts'
import type { Activity, ChangeSet, PullRequest } from '../../../shared/work.ts'
import { GitHubError } from '../github.ts'
import { Refused, type Actor } from '../hub.ts'
import { CardService } from './cards.ts'
import { mergeableOf, bump } from './base.ts'
import { sameRepo } from '../../../shared/work.ts'

// Change sets: a card's work as one thing, pull requests in order, approving and merging them, and promoting a version.

export abstract class ChangeSetService extends CardService {
  /**
   * A card's Change Set: its pull request's diff (read from GitHub if the hub has none of its files yet) or its
   * worktree's, its brief and done-when, and the agent's log.
   */
  async changeSet(cardId: string) {
    if (this.hub.state.changeSets.some((s) => s.id === cardId)) return this.setReview(cardId)
    const card = this.card(cardId)
    const pull = pullOf(this.hub.state, card)
    if (pull && !pull.files.length) {
      const github = await this.github.forRepo(pull.repo).catch(() => undefined)
      const files = await github?.files(pull.repo, pull.number).catch(() => undefined)
      if (files?.length) await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { files } })
    }
    const set = cardChangeSet(this.hub.state, card.id)!
    // New commits since the debrief that's on the card: what they are, so writing it again can say what changed since.
    const gap = set.debrief?.outOfDate
    if (gap && pull) {
      const compared = await this.compareGap(pull.repo, gap.from, gap.to)
      if (compared) set.debrief!.outOfDate = { ...gap, commits: compared.commits, files: compared.files }
    }
    return set
  }

  /** A change set's pull requests together, their files and heads read from GitHub where the hub hasn't them yet. */
  protected async setReview(setId: string) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)!
    for (const id of set.prIds) {
      const pull = this.hub.state.pulls.find((p) => p.id === id)
      if (!pull) continue
      if (!pull.files.length) {
        const github = await this.github.forRepo(pull.repo).catch(() => undefined)
        const files = await github?.files(pull.repo, pull.number).catch(() => undefined)
        if (files?.length) await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { files } })
      }
      if (!pull.head) await this.readHead(pull)
    }
    const review = setChangeSet(this.hub.state, setId)!
    // One pull request: what landed on it since the last debrief, as for a card.
    const gap = review.debrief?.outOfDate
    const only = set.prIds.length === 1 ? this.hub.state.pulls.find((p) => p.id === set.prIds[0]) : undefined
    if (gap && only) {
      const compared = await this.compareGap(only.repo, gap.from, gap.to)
      if (compared) review.debrief!.outOfDate = { ...gap, commits: compared.commits, files: compared.files }
    }
    return review
  }

  /** What landed on a pull request between two commits, when the hub can reach GitHub to read it. */
  protected async compareGap(repo: string, from: string, to: string) {
    const github = await this.github.forRepo(repo).catch(() => undefined)
    const compared = await github?.compare(repo, from, to).catch(() => undefined)
    return compared ? { commits: compared.commits, files: compared.files.map((f) => f.path) } : undefined
  }

  /**
   * The commit at a pull request's head, read from GitHub when the hub hasn't heard of it yet (a pull request opened
   * before the hub kept heads), and recorded so the card can see it move.
   */
  protected async readHead(pull: PullRequest) {
    const github = await this.github.forRepo(pull.repo).catch(() => undefined)
    const info = await github?.pull(pull.repo, pull.number).catch(() => undefined)
    if (!info) return undefined
    if (this.hub.state.pulls.find((p) => p.id === pull.id)?.head !== info.headSha) await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { head: info.headSha } })
    return info.headSha
  }

  /** A pull request into the hub: read from GitHub when it can be, linked to its card, and put in its binder's change set. */
  async linkPull(repo: string, number: number, link: { cardId?: string; agentId?: string }): Promise<PullRequest> {
    // The one the hub has already, however its repo was written (a webhook says it as GitHub does; a person may not).
    const known = this.hub.state.pulls.find((p) => sameRepo(p.repo, repo) && p.number === number)
    const id = known?.id ?? `${repo}#${number}`
    let pull: PullRequest = known ?? { id, repo, number, title: `Pull request ${number}`, branch: '', url: `https://github.com/${repo}/pull/${number}`, state: 'open', checks: [], files: [] }
    const github = await this.github.forRepo(repo).catch(() => undefined)
    if (github) {
      try {
        const info = await github.pull(repo, number)
        const [files, checks] = await Promise.all([github.files(repo, number).catch(() => pull.files), github.checks(repo, info.headSha).catch(() => pull.checks)])
        pull = { ...pull, title: info.title, branch: info.branch, url: info.url, head: info.headSha, state: info.merged ? 'merged' : info.state === 'closed' ? 'closed' : pull.state, additions: info.additions, deletions: info.deletions, files, checks }
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error
      }
    }
    pull = { ...pull, cardId: link.cardId ?? pull.cardId, agentId: link.agentId ?? pull.agentId }
    await this.hub.record({ kind: 'hub' }, { type: 'pr.put', pull })
    const card = pull.cardId ? this.hub.state.cards.find((c) => c.id === pull.cardId) : undefined
    if (card && !this.hub.state.changeSets.some((s) => s.prIds.includes(pull.id))) await this.addToSet(card.binderId, pull.id, card.noteId)
    return this.hub.state.pulls.find((p) => p.id === id)!
  }

  /** The binder's change set that's taking pull requests, made when there isn't one. */
  protected async addToSet(binderId: string, prId: string, noteId?: string) {
    const open = this.hub.state.changeSets.find((s) => s.binderId === binderId && s.state === 'assembling')
    if (open) {
      await this.hub.record({ kind: 'hub' }, { type: 'set.update', id: open.id, fields: { prIds: [...open.prIds, prId], noteIds: noteId && !open.noteIds.includes(noteId) ? [...open.noteIds, noteId] : open.noteIds } })
      return
    }
    const number = Math.max(0, ...this.hub.state.changeSets.map((s) => s.number)) + 1
    const note = noteId ? this.hub.state.notes.find((n) => n.id === noteId) : undefined
    const set: ChangeSet = { id: `set-${number}`, binderId, number, title: note ? titleOf(note.text) : `Change set ${number}`, summary: '', state: 'assembling', prIds: [prId], noteIds: noteId ? [noteId] : [] }
    await this.hub.record({ kind: 'hub' }, { type: 'set.put', set })
  }

  // Change sets and environments -----------------------------------------------------------------------------------

  async sendForReview(login: string, setId: string) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)
    if (!set) throw new Refused(`No change set ${setId}.`)
    if (set.state !== 'assembling') throw new Refused('That change set isn’t taking pull requests any more.')
    await this.hub.record({ kind: 'user', login }, { type: 'set.update', id: set.id, fields: { state: 'review' } })
  }

  async reorderSet(login: string, setId: string, prIds: string[]) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)
    if (!set || [...prIds].sort().join() !== [...set.prIds].sort().join()) throw new Refused('Give the same pull requests in their new order.')
    await this.hub.record({ kind: 'user', login }, { type: 'set.update', id: set.id, fields: { prIds } })
  }

  /** One approval for the set: each pull request approved and merged on GitHub in order, then staging. */
  /**
   * Whether a pull request merges into its base as things are now. GitHub works it out after each push or merge, so a
   * "not yet" is asked again a few times.
   */
  async checkMergeable(pullId: string, token?: string): Promise<PullRequest['mergeable']> {
    const pull = this.hub.state.pulls.find((p) => p.id === pullId)
    if (!pull || pull.state === 'merged' || pull.state === 'closed') return pull?.mergeable
    const github = await this.githubAs(pull.repo, token)
    if (!github) return pull.mergeable
    let info = await github.pull(pull.repo, pull.number)
    for (let tries = 0; info.mergeable === null && tries < 4; tries++) {
      await new Promise((done) => setTimeout(done, this.mergeWaitMs))
      info = await github.pull(pull.repo, pull.number)
    }
    const mergeable = mergeableOf(info)
    if (mergeable !== pull.mergeable) await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { mergeable } })
    return mergeable
  }

  /** How long to wait for GitHub to work out whether a pull request merges (shorter in tests). */
  mergeWaitMs = 1500

  /** Every pull request in a change set, checked: what a person sees before approving. */
  async checkSet(setId: string, token?: string) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)
    if (!set) throw new Refused(`No change set ${setId}.`)
    for (const id of set.prIds) await this.checkMergeable(id, token).catch(() => undefined)
    return this.hub.state.changeSets.find((s) => s.id === setId)!
  }

  /** Brings a pull request's branch up to date with its base, when that needs no help. */
  async updateBranch(pullId: string, token?: string) {
    const pull = this.hub.state.pulls.find((p) => p.id === pullId)
    if (!pull) throw new Refused(`No pull request ${pullId}.`)
    const github = await this.githubAs(pull.repo, token)
    if (!github) throw new Refused('GitHub isn’t connected for that repo.')
    try {
      await github.updateBranch(pull.repo, pull.number)
    } catch (error) {
      if ((error as GitHubError).status === 422) {
        await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { mergeable: 'conflicts' } })
        throw new Refused(`${pull.repo}#${pull.number} conflicts with its base: it needs resolving, not just updating.`)
      }
      throw error
    }
    await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { mergeable: 'unknown' } })
  }

  /**
   * A pull request that conflicts goes back to the agent that made it: its card is ready again, meant for that agent,
   * with what to do. Its runner takes it as it would any card, in the same worktree.
   */
  async sendBackToResolve(login: string, pullId: string, why?: string) {
    const pull = this.hub.state.pulls.find((p) => p.id === pullId)
    if (!pull) throw new Refused(`No pull request ${pullId}.`)
    const card = pull.cardId ? this.hub.state.cards.find((c) => c.id === pull.cardId) : undefined
    if (!card) throw new Refused(`${pull.repo}#${pull.number} has no card to send back.`)
    const agentId = pull.agentId ?? card.agentId ?? card.meantFor
    const text = `${why ? `${why} ` : ''}${pull.repo}#${pull.number} conflicts with its base branch. Bring the base into ${pull.branch} (git fetch, then merge it in), resolve the conflicts keeping what both sides meant, run the tests, and push to the same branch so the pull request updates. Then complete_task with ${pull.id}.`
    await this.hub.record({ kind: 'user', login }, {
      type: 'card.update', id: card.id,
      fields: { stage: 'ready', agentId: undefined, meantFor: agentId, needsYou: undefined, doing: undefined, progress: undefined },
      activity: { at: this.now(), by: login, kind: 'comment', text },
    })
    await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { mergeable: 'conflicts' } })
    return this.card(card.id)
  }

  /** Settles conflicts the hub can (both sides only added lines) by merging the base into a pull request's branch. */
  merger?: Merger
  /** How change sets merge: merge commits unless the hub's options say otherwise. */
  mergeMethod: () => 'merge' | 'squash' | 'rebase' = () => 'merge'
  protected trains = new Map<string, Promise<unknown>>()
  protected trainTimers = new Map<string, NodeJS.Timeout>()

  /**
   * Approving a change set starts its merge train: every pull request in it merges as soon as it's ready, in order
   * where it can, without stopping for the ones that aren't. Failing checks refuse it, as nothing should merge then.
   */
  async approveSet(login: string, setId: string, token?: string) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)
    if (!set) throw new Refused(`No change set ${setId}.`)
    if (set.state !== 'review' && set.state !== 'assembling') throw new Refused('That change set was already approved.')
    const pulls = set.prIds.map((id) => this.hub.state.pulls.find((p) => p.id === id)).filter((p): p is PullRequest => !!p)
    const failing = pulls.filter((p) => p.state !== 'merged').flatMap((p) => p.checks.filter((c) => c.state === 'failed').map((c) => `${p.repo.split('/')[1]}#${p.number} ${c.name}`))
    if (failing.length) throw new Refused(`Some checks failed: ${failing.join(', ')}.`)
    await this.hub.record({ kind: 'user', login }, { type: 'set.update', id: set.id, fields: { state: 'merging', approvedBy: login, waiting: undefined } })
    await this.runTrain(set.id, login, token)
    return this.hub.state.changeSets.find((s) => s.id === set.id)!
  }

  /** Runs a set's train once, one run at a time per set: merges what's ready, and says what the rest wait for. */
  runTrain(setId: string, login = 'hub', token?: string) {
    const before = this.trains.get(setId) ?? Promise.resolve()
    const next = before.catch(() => undefined).then(() => this.trainOnce(setId, login, token))
    this.trains.set(setId, next.catch(() => undefined))
    return next
  }

  /**
   * Follows the board: when a pull request in an approved set changes (checks finish, its agent pushes a fix, GitHub
   * says it merges now), the train runs again a moment later.
   */
  watchTrains() {
    this.hub.on('entries', (entries) => {
      for (const { change } of entries) {
        const pullId = change.type === 'pr.update' ? change.id : change.type === 'pr.put' ? change.pull.id : undefined
        if (!pullId) continue
        const set = this.hub.state.changeSets.find((s) => s.state === 'merging' && s.prIds.includes(pullId))
        if (!set) continue
        clearTimeout(this.trainTimers.get(set.id))
        this.trainTimers.set(set.id, setTimeout(() => { this.trainTimers.delete(set.id); void this.runTrain(set.id).catch(() => undefined) }, this.trainDelayMs))
      }
    })
  }

  /** How long the train waits after a change before running again (shorter in tests). */
  trainDelayMs = 3000

  protected async trainOnce(setId: string, login: string, token?: string) {
    const set = this.hub.state.changeSets.find((s) => s.id === setId)
    if (!set || set.state !== 'merging') return
    const actor: Actor = login === 'hub' ? { kind: 'hub' } : { kind: 'user', login }
    const by = set.approvedBy ?? login
    const waiting: { prId: string; why: string }[] = []
    for (const id of set.prIds) {
      const pull = this.hub.state.pulls.find((p) => p.id === id)
      if (!pull || pull.state === 'merged' || pull.state === 'closed') continue
      const short = `${pull.repo.split('/')[1]}#${pull.number}`
      if (pull.checks.some((c) => c.state === 'failed')) {
        waiting.push({ prId: id, why: `${short}: a check failed` })
        continue
      }
      if (pull.checks.some((c) => c.state !== 'passed')) {
        waiting.push({ prId: id, why: `${short}: checks running` })
        continue
      }
      const github = await this.githubAs(pull.repo, token)
      if (!github) {
        await this.recordMerged(actor, set, pull, by)
        continue
      }
      // A change set lands on the repo's default branch. A pull request stacked on another one's branch waits for that
      // one, then is pointed at the default branch, so nothing merges into a branch that's already gone in.
      const info = await github.pull(pull.repo, pull.number).catch(() => undefined)
      const main = await github.defaultBranch(pull.repo).catch(() => undefined)
      if (info && main && info.base !== main) {
        const parent = this.hub.state.pulls.find((p) => sameRepo(p.repo, pull.repo) && p.branch === info.base && p.state !== 'merged' && p.state !== 'closed')
        if (parent) {
          waiting.push({ prId: id, why: `${short}: built on ${pull.repo.split('/')[1]}#${parent.number}, merges after it` })
          continue
        }
        await github.retarget(pull.repo, pull.number, main)
        if (pull.cardId) await this.hub.record({ kind: 'hub' }, { type: 'card.activity', id: pull.cardId, activity: { at: this.now(), by: 'hub', kind: 'said', text: `Pointed ${short} at ${main}: it was opened against ${info.base}.` } })
      }
      let mergeable = await this.checkMergeable(id, token).catch(() => 'unknown' as const)
      if (mergeable === 'conflicts') {
        const settled = await this.settleConflicts(pull, token)
        if (settled === 'pushed') {
          waiting.push({ prId: id, why: `${short}: brought up to date, checks running again` })
          continue
        }
        waiting.push({ prId: id, why: `${short}: ${settled}` })
        continue
      }
      if (mergeable === 'blocked') {
        waiting.push({ prId: id, why: `${short}: the repo’s rules don’t allow merging yet` })
        continue
      }
      try {
        await this.hub.record(actor, { type: 'pr.update', id, fields: { state: 'approved' } })
        await github.approve(pull.repo, pull.number).catch((error: GitHubError) => {
          // Approving your own pull request isn't allowed on GitHub; the merge still goes ahead.
          if (error.status !== 422) throw error
        })
        await this.hub.record(actor, { type: 'pr.update', id, fields: { state: 'queued' } })
        await github.merge(pull.repo, pull.number, this.mergeMethod())
        await this.recordMerged(actor, set, pull, by)
      } catch (error) {
        const status = (error as GitHubError).status
        await this.hub.record(actor, { type: 'pr.update', id, fields: { state: 'open', ...(status === 405 || status === 409 ? { mergeable: 'conflicts' as const } : {}) } })
        mergeable = status === 405 || status === 409 ? 'conflicts' : mergeable
        waiting.push({ prId: id, why: `${short}: ${mergeable === 'conflicts' ? 'conflicts with what merged before it; settling it next' : `GitHub didn’t merge it (${(error as Error).message})`}` })
      }
    }
    const now = this.hub.state.changeSets.find((s) => s.id === setId)!
    if (waiting.length) {
      await this.hub.record(actor, { type: 'set.update', id: setId, fields: { waiting } })
      return
    }
    await this.hub.record(actor, { type: 'set.update', id: setId, fields: { state: 'merged', waiting: undefined } })
    // Without a deploy workflow, the hub records staging having it; with one, GitHub's deployment says so.
    const staging = this.hub.state.environments.find((e) => !e.needsApproval && e.id !== 'preview')
    if (staging && !staging.deploy) await this.recordDeployed(actor, staging.id, [now.id, ...staging.changeSetIds.filter((s) => s !== now.id)], bump(staging.version))
  }

  protected async recordMerged(actor: Actor, set: ChangeSet, pull: PullRequest, by: string) {
    await this.hub.recordAll(actor, [
      { type: 'pr.update', id: pull.id, fields: { state: 'merged', mergeable: undefined } },
      ...(pull.cardId ? [{ type: 'card.update', id: pull.cardId, fields: { stage: 'live' }, activity: { at: this.now(), by, kind: 'merged', text: `Merged with change set #${set.number}` } } satisfies Change] : []),
    ])
  }

  /**
   * A pull request that conflicts: the hub brings the base into its branch, keeping both sides where both only added
   * lines. What's left goes to the agent that made it, once. Says what happened, or 'pushed'.
   */
  protected async settleConflicts(pull: PullRequest, token?: string): Promise<string> {
    const card = pull.cardId ? this.hub.state.cards.find((c) => c.id === pull.cardId) : undefined
    // Already with its agent: nothing more to do until it pushes.
    if (card && (card.stage === 'working' || (card.stage === 'ready' && card.meantFor))) return `with ${this.hub.state.agents.find((a) => a.id === (card.agentId ?? card.meantFor))?.name ?? 'its agent'} to resolve`
    const github = await this.githubAs(pull.repo, token)
    const info = await github?.pull(pull.repo, pull.number).catch(() => undefined)
    if (this.merger && info) {
      try {
        const result = await this.merger.pullBaseInto(pull.repo, info.base, info.branch)
        if (result.pushed) {
          await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { mergeable: 'unknown', checks: pull.checks.map((c) => ({ ...c, state: 'queued' as const })) } })
          if (card) await this.hub.record({ kind: 'hub' }, { type: 'card.activity', id: card.id, activity: { at: this.now(), by: 'hub', kind: 'said', text: result.kept.length ? `Brought ${info.base} into ${info.branch}. Both sides added lines in ${result.kept.join(', ')}: both are kept.` : `Brought ${info.base} into ${info.branch}.` } })
          return 'pushed'
        }
        if (card) await this.sendBackToResolve('hub', pull.id, `The hub brought ${info.base} in, but ${result.left.join(', ')} ${result.left.length === 1 ? 'has' : 'have'} changes on both sides to the same lines.`)
        return `with its agent to resolve ${result.left.join(', ')}`
      } catch (error) {
        if (card) await this.sendBackToResolve('hub', pull.id).catch(() => undefined)
        return `with its agent to resolve (the hub couldn’t: ${(error as Error).message.split('\n')[0]})`
      }
    }
    if (card) await this.sendBackToResolve('hub', pull.id).catch(() => undefined)
    return 'with its agent to resolve'
  }

  /** Promote what's on the environment before this one: GitHub's workflow when there is one, else recorded here. */
  async promote(login: string, envId: string, token?: string) {
    const envs = this.hub.state.environments
    const index = envs.findIndex((e) => e.id === envId)
    const env = envs[index]
    const from = envs[index - 1]
    if (!env || !from) throw new Refused('Nothing comes before that environment.')
    if (env.state === 'deploying') throw new Refused(`${env.name} is already deploying.`)
    if (env.version === from.version) throw new Refused(`${env.name} already has ${from.version}.`)
    const actor: Actor = { kind: 'user', login }
    if (env.deploy) {
      const github = await this.githubAs(env.deploy.repo, token)
      if (!github) throw new Refused('GitHub isn’t set up on this hub, so its workflow can’t run.')
      await github.dispatch(env.deploy.repo, env.deploy.workflow, env.deploy.ref, { version: from.version, environment: env.id })
      await this.hub.record(actor, { type: 'env.update', id: env.id, fields: { state: 'deploying', progress: 0.05 } })
      return
    }
    await this.recordDeployed(actor, env.id, from.changeSetIds, from.version)
  }

  /** An environment now has these change sets at this version: their cards are live there when it's the last one. */
  async recordDeployed(actor: Actor, envId: string, changeSetIds: string[], version: string) {
    const env = this.hub.state.environments.find((e) => e.id === envId)
    if (!env) return
    const last = this.hub.state.environments[this.hub.state.environments.length - 1]?.id === envId
    const fresh = changeSetIds.filter((s) => !env.changeSetIds.includes(s))
    const changes: Change[] = [{ type: 'env.update', id: env.id, fields: { state: 'healthy', progress: undefined, version, changeSetIds, deployedAt: this.now() } }]
    const next = this.hub.state.environments.find((_e, i, all) => all[i - 1]?.id === env.id)
    if (next?.needsApproval && next.version !== version) changes.push({ type: 'env.update', id: next.id, fields: { state: 'waiting' } })
    for (const setId of fresh) {
      const set = this.hub.state.changeSets.find((s) => s.id === setId)
      if (!set) continue
      if (last) changes.push({ type: 'set.update', id: set.id, fields: { state: 'shipped' } })
      for (const prId of set.prIds) {
        const cardId = this.hub.state.pulls.find((p) => p.id === prId)?.cardId
        if (!cardId) continue
        const activity: Activity = { at: this.now(), by: 'hub', kind: 'deployed', text: `On ${env.name.toLowerCase()} in ${version}` }
        changes.push(last ? { type: 'card.update', id: cardId, fields: { stage: 'live' }, activity } : { type: 'card.activity', id: cardId, activity })
      }
    }
    await this.hub.recordAll(actor, changes)
  }

}
