import { setTimeout as sleep } from 'node:timers/promises'
import type { Change } from '../../../shared/state.ts'
import { deliveryRepos, environmentBefore, environmentId, repoEnvironments, sameRepo, type Activity, type EnvState, type Environment, type PullRequest } from '../../../shared/work.ts'
import { GitHubError, type DeploymentInfo, type DeploymentStatusInfo } from '../github.ts'
import { Refused } from '../hub.ts'
import { log } from '../logger.ts'
import { RuleService } from './rules.ts'

// Delivery: the environments GitHub deploys each repo to, what's on each, and what isn't there yet. The hub follows
// GitHub and never records a deploy GitHub didn't report. A person sets up what GitHub can't say (an address, a workflow
// the hub may run), and Promote runs that workflow.

/** What GitHub said about one deployment, from a webhook or from asking. */
export interface DeploymentReport {
  /** The environment's name, as GitHub has it. */
  environment: string
  ref: string
  sha: string
  /** The version the deploy named in its payload, if it did. */
  version?: string
  /** The status's state: queued, in_progress, pending, waiting, success, failure, error or inactive. */
  state: string
  url?: string
  logUrl?: string
  at?: string
  /** GitHub marks it as a throwaway environment (a preview for one pull request, say): not one to follow. */
  transient?: boolean
}

/** The version a deployment's payload names, if it does. */
export function versionIn(payload: unknown): string | undefined {
  let value = payload
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const version = (value as { version?: unknown } | null)?.version
  return typeof version === 'string' && version.trim() ? version.trim().slice(0, 100) : undefined
}

/** What's on an environment, as people say it: the version its deploy named, else the tag or branch, else the commit's first seven. */
export function versionOf(report: Pick<DeploymentReport, 'version' | 'ref' | 'sha'>) {
  if (report.version?.trim()) return report.version.trim().slice(0, 100)
  const ref = (report.ref ?? '').trim().replace(/^refs\/(heads|tags)\//, '')
  // A deploy of a bare commit has the commit for its ref.
  return ref && !/^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 100) : (report.sha ?? ref).slice(0, 7)
}

/** An address a person may follow from the page: http or https, nothing else. */
const webAddress = (value: unknown) => (typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim()) && value.trim().length <= 500 ? value.trim() : undefined)

const repoPattern = /^[\w.-]+\/[\w.-]+$/
/** The most environments GitHub may make in one repo: past that a new name is ignored, as a preview per pull request would flood it. */
export const mostFromGitHub = 12
/** The most merged pull requests asked about at one deployment: the newest. */
const mostAsked = 50

export abstract class EnvironmentService extends RuleService {
  /** Whether the hub looks for deployments by itself: on once `followDeliveries` has run, as the scheduler reads. */
  deliveryLooks = false
  /** Whether GitHub's webhooks are arriving: the hub only looks for what they'd have said when they aren't. */
  webhooksHeard: () => boolean = () => false
  /** How long it waits between one repo and the next while looking, so a hub with many repos stays gentle on GitHub (shorter in tests). */
  lookPauseMs = 2000
  /** How often it looks at a repo that has environments, while webhooks aren't arriving. */
  lookEveryMs = 10 * 60_000
  /** How often it looks at a repo with none, for one to turn up. */
  lookQuietMs = 60 * 60_000
  /** How long after start the first look is (shorter in tests). */
  firstLookMs = 5000
  /** When each repo (in lower case) was last looked at. */
  protected lookedAt = new Map<string, number>()
  private lookRun: Promise<unknown> = Promise.resolve()
  private lookWaiting = 0
  /** What's being told of each repo, one at a time: two reports for one environment shouldn't each work out what arrived. */
  private told = new Map<string, Promise<unknown>>()
  /** The environments turned away for being too many, so each is said once in the log. */
  private tooMany = new Set<string>()

  // Starting ---------------------------------------------------------------------------------------------------------

  /**
   * At start: environments from before they were per repo go, change sets shipped by deploys nobody made are put back,
   * and the hub begins looking for deployments by itself.
   */
  async followDeliveries() {
    const old = this.hub.state.environments.filter((e) => !e.repo)
    if (old.length) await this.hub.recordAll({ kind: 'hub' }, old.map((e): Change => ({ type: 'env.delete', id: e.id })))
    await this.settleSets()
    this.deliveryLooks = true
    setTimeout(() => void this.lookDue().catch((err: Error) => log.warn({ err }, 'Looking for deployments failed')), this.firstLookMs).unref()
  }

  // What GitHub says -------------------------------------------------------------------------------------------------

  /** Takes one deployment's status, from a webhook or from looking. Says what it did. */
  deploymentSeen(repo: string, report: DeploymentReport): Promise<string> {
    const key = repo.toLowerCase()
    const next = (this.told.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.applyReport(repo, report))
    this.told.set(key, next.catch(() => undefined))
    return next
  }

  private async applyReport(repo: string, report: DeploymentReport): Promise<string> {
    const name = (report.environment ?? '').trim()
    if (!name || report.transient) return 'ignored'
    if (!deliveryRepos(this.hub.state).some((r) => sameRepo(r, repo))) return 'not ours'
    const gh = report.state
    const state: EnvState | undefined = ['queued', 'in_progress', 'pending'].includes(gh) ? 'deploying' : gh === 'waiting' ? 'waiting' : gh === 'failure' || gh === 'error' ? 'failed' : gh === 'success' ? 'healthy' : undefined
    // Superseded, or a kind of status the hub doesn't show.
    if (!state) return 'ignored'

    const known = this.hub.state.environments.find((e) => sameRepo(e.repo, repo) && e.name.toLowerCase() === name.toLowerCase())
    if (!known && repoEnvironments(this.hub.state, repo).filter((e) => e.by !== 'person').length >= mostFromGitHub) {
      const key = environmentId(repo, name)
      if (!this.tooMany.has(key)) {
        this.tooMany.add(key)
        log.warn({ repo, environment: name }, `Ignored an environment GitHub reported: ${repo} has ${mostFromGitHub} from GitHub already`)
      }
      return 'ignored'
    }
    const siblings = repoEnvironments(this.hub.state, repo)
    const made: Environment = { id: environmentId(repo, name), repo, name, url: '', version: '', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: siblings.length ? Math.max(...siblings.map((e, at) => e.order ?? at)) + 1 : 0, by: 'github' }
    const env = known ?? made
    const url = webAddress(report.url)
    const logUrl = webAddress(report.logUrl)
    // An address a person gave stays theirs; one GitHub gave follows what GitHub says. A run's link is for the latest word.
    const fields: Partial<Environment> = { state, ...(url && (!env.url || env.by === 'github') ? { url } : {}), ...(logUrl ? { logUrl } : {}) }
    const changes: Change[] = []
    let result: string
    if (state === 'deploying') {
      Object.assign(fields, { progress: 0.3 })
      result = 'deploying'
    } else if (state === 'healthy') {
      const version = versionOf(report)
      const arrived = await this.arrived(repo, env, report.sha)
      const pullIds = [...(env.pullIds ?? []), ...arrived.map((p) => p.id)]
      const sets = this.hub.state.changeSets.filter((s) => s.prIds.some((id) => pullIds.includes(id))).map((s) => s.id)
      // A deployment with no run to link to clears the last one's, which is no longer what's on it.
      Object.assign(fields, { progress: undefined, version, sha: report.sha, deployedAt: report.at ?? this.now(), pullIds, changeSetIds: sets, logUrl })
      for (const pull of arrived) {
        if (!pull.cardId) continue
        const activity: Activity = { at: this.now(), by: 'hub', kind: 'deployed', text: `On ${env.name} in ${version}` }
        changes.push({ type: 'card.activity', id: pull.cardId, activity })
      }
      result = 'deployed'
    } else {
      Object.assign(fields, { progress: undefined })
      result = state
    }
    if (!known) changes.unshift({ type: 'env.put', environment: { ...made, ...fields } as Environment })
    else {
      // Only what's different: the same report heard again (from a webhook and from looking) writes nothing.
      const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify((env as unknown as Record<string, unknown>)[key])))
      if (Object.keys(changed).length) changes.unshift({ type: 'env.update', id: env.id, fields: changed as Partial<Environment> })
    }
    if (!changes.length) return 'unchanged'
    await this.hub.recordAll({ kind: 'hub' }, changes)
    await this.settleSets()
    return result
  }

  /**
   * The repo's merged pull requests that are on an environment now it has this commit and weren't before: the newest
   * fifty not already on it, each asked of GitHub (is the deployed commit ahead of, or the same as, its merge commit).
   * When GitHub can't be asked, or the merge commit isn't known to it or to the hub, the pull request counts as on it, as
   * the hub did before it could ask.
   */
  private async arrived(repo: string, env: Environment, sha: string): Promise<PullRequest[]> {
    const on = new Set(env.pullIds ?? [])
    const merged = this.hub.state.pulls.filter((p) => sameRepo(p.repo, repo) && p.state === 'merged' && !on.has(p.id)).sort((a, b) => b.number - a.number).slice(0, mostAsked)
    let github = merged.some((p) => p.mergeSha) && sha ? await this.github.forRepo(repo).catch(() => undefined) : undefined
    const there: PullRequest[] = []
    for (const pull of merged) {
      if (!github || !pull.mergeSha) {
        there.push(pull)
        continue
      }
      try {
        if (await github.includes(repo, pull.mergeSha, sha)) there.push(pull)
      } catch (error) {
        there.push(pull)
        // A commit GitHub doesn't know says nothing of the others; GitHub not answering at all says nothing of any.
        const status = (error as GitHubError).status
        if (status !== 404 && status !== 422) github = undefined
      }
    }
    return there
  }

  /**
   * A change set is shipped once each of its merged pull requests whose repo has environments is on that repo's last
   * one. Said again whenever a deployment, or a repo's environments, change.
   */
  async settleSets() {
    const state = this.hub.state
    const changes: Change[] = []
    for (const set of state.changeSets) {
      if (set.state !== 'merged' && set.state !== 'shipped') continue
      const followed = set.prIds
        .map((id) => state.pulls.find((p) => p.id === id))
        .filter((p): p is PullRequest => p?.state === 'merged')
        .map((pull) => ({ pull, last: repoEnvironments(state, pull.repo).at(-1) }))
        .filter((x) => x.last)
      const shipped = followed.length > 0 && followed.every(({ pull, last }) => last!.pullIds?.includes(pull.id))
      if (shipped !== (set.state === 'shipped')) changes.push({ type: 'set.update', id: set.id, fields: { state: shipped ? 'shipped' : 'merged' } })
    }
    if (changes.length) await this.hub.recordAll({ kind: 'hub' }, changes)
  }

  // Looking for itself -----------------------------------------------------------------------------------------------

  private whenToLook(repo: string, now: number) {
    const last = this.lookedAt.get(repo.toLowerCase())
    if (last === undefined) return true
    // A repo with none is looked at rarely, for one to turn up; one with some, only while webhooks aren't telling it.
    if (!repoEnvironments(this.hub.state, repo).length) return now - last >= this.lookQuietMs
    return !this.webhooksHeard() && now - last >= this.lookEveryMs
  }

  /**
   * Looks at the repos that are due, one after another with a pause between: never looked at (at start, or when a
   * binder's repos change), or looked at long enough ago. Never in the way of a person's request: the scheduler calls it
   * on its own, and a look already under way is left to finish.
   */
  async lookDue(now = Date.now()): Promise<string[]> {
    if (this.lookWaiting) return []
    const due = deliveryRepos(this.hub.state).filter((repo) => this.whenToLook(repo, now))
    if (!due.length) return []
    return (await this.looks(due, now)).looked
  }

  /** "Look on GitHub now": one repo of the binder's, or all that count. Says which it looked at and which it couldn't. */
  async lookNow(repo?: string) {
    const counted = deliveryRepos(this.hub.state)
    const repos = repo ? counted.filter((r) => sameRepo(r, repo)) : counted
    if (repo && !repos.length) throw new Refused(`${repo} isn’t one of this binder’s repos: add it to the binder’s repos in Settings → GitHub first.`)
    return this.looks(repos, Date.now())
  }

  private looks(repos: string[], now: number) {
    this.lookWaiting++
    const work = async () => {
      const looked: string[] = []
      const failed: { repo: string; why: string }[] = []
      for (const [at, repo] of repos.entries()) {
        if (at) await sleep(this.lookPauseMs)
        this.lookedAt.set(repo.toLowerCase(), now)
        try {
          await this.lookAt(repo)
          looked.push(repo)
        } catch (error) {
          const why = (error as Error).message
          failed.push({ repo, why })
          log.warn({ repo, why }, 'Couldn’t look for deployments on GitHub')
        }
      }
      return { looked, failed }
    }
    const next = this.lookRun.catch(() => undefined).then(work).finally(() => { this.lookWaiting-- })
    this.lookRun = next.catch(() => undefined)
    return next
  }

  /**
   * One repo's deployments as GitHub has them: its newest thirty, grouped by environment, and the latest status of each
   * one's newest deployment, told as a webhook would. The environment deployed to first comes first, so a new repo's
   * environments are in the order they were first deployed to.
   */
  protected async lookAt(repo: string) {
    const github = await this.github.forRepo(repo)
    if (!github) throw new Refused(`GitHub isn’t connected for ${repo}.`)
    const newest = new Map<string, DeploymentInfo>()
    const first = new Map<string, number>()
    for (const deployment of await github.deployments(repo)) {
      if (deployment.transient) continue
      const key = deployment.environment.toLowerCase()
      if (!newest.has(key)) newest.set(key, deployment)
      first.set(key, Math.min(first.get(key) ?? Infinity, deployment.id))
    }
    for (const key of [...newest.keys()].sort((a, b) => first.get(a)! - first.get(b)!)) {
      const deployment = newest.get(key)!
      const status: DeploymentStatusInfo | undefined = await github.deploymentStatus(repo, deployment.id)
      if (!status) continue
      await this.deploymentSeen(repo, { environment: deployment.environment, ref: deployment.ref, sha: deployment.sha, version: versionIn(deployment.payload), state: status.state, url: status.environmentUrl, logUrl: status.logUrl, at: status.createdAt ?? deployment.createdAt })
    }
    return newest.size
  }

  // What people do ---------------------------------------------------------------------------------------------------

  /** A repo the binder works in, as people write it: checked, since an environment of any other repo would never be heard of. */
  private repoOfDelivery(repo: unknown) {
    const named = typeof repo === 'string' ? repo.trim() : ''
    if (!repoPattern.test(named)) throw new Refused('A repo is written owner/name.')
    const known = deliveryRepos(this.hub.state).find((r) => sameRepo(r, named))
    if (!known) throw new Refused(`${named} isn’t one of this binder’s repos: add it to the binder’s repos in Settings → GitHub first.`)
    return known
  }

  private checkedDeploy(deploy: { repo?: string | null; workflow?: string | null; ref?: string | null }, home: string): NonNullable<Environment['deploy']> {
    const workflow = (deploy.workflow ?? '').trim()
    const ref = (deploy.ref ?? '').trim()
    if (!workflow || !ref) throw new Refused('Name the workflow file the hub runs to deploy, and the branch or tag to run it on.')
    if (workflow.length > 200 || ref.length > 200) throw new Refused('That workflow or ref is too long.')
    const repo = deploy.repo?.trim() ? this.repoOfDelivery(deploy.repo) : home
    return { repo, workflow, ref }
  }

  private checkedName(name: unknown) {
    const named = typeof name === 'string' ? name.trim() : ''
    if (!named) throw new Refused('Give the environment a name, as GitHub calls it.')
    if (named.length > 100) throw new Refused('An environment’s name is up to 100 characters.')
    return named
  }

  private checkedUrl(url: unknown) {
    const given = typeof url === 'string' ? url.trim() : ''
    if (!given) return ''
    const ok = webAddress(given)
    if (!ok) throw new Refused('Where it’s served is an address starting with http:// or https://.')
    return ok
  }

  /** An environment a person sets up: for a repo the binder works in, last in its order. */
  async addEnvironment(login: string, fields: { repo: string; name: string; url?: string | null; needsApproval?: boolean; deploy?: { repo?: string | null; workflow?: string | null; ref?: string | null } | null }) {
    const repo = this.repoOfDelivery(fields.repo)
    const name = this.checkedName(fields.name)
    const id = environmentId(repo, name)
    if (this.hub.state.environments.some((e) => e.id === id)) throw new Refused(`${repo} has an environment called ${name} already.`)
    const deploy = fields.deploy ? this.checkedDeploy(fields.deploy, repo) : undefined
    const siblings = repoEnvironments(this.hub.state, repo)
    const environment: Environment = {
      id, repo, name, url: this.checkedUrl(fields.url), version: '', changeSetIds: [], state: 'healthy', deployedAt: '',
      // Only the hub's own deploys wait for a person, and a person's the safe default.
      // The hub deploys only when someone presses Promote, so one it can deploy to always waits for that.
      needsApproval: !!deploy,
      ...(deploy ? { deploy } : {}),
      order: siblings.length ? Math.max(...siblings.map((e, at) => e.order ?? at)) + 1 : 0, by: 'person',
    }
    await this.hub.record({ kind: 'user', login }, { type: 'env.put', environment })
    await this.settleSets()
    return this.hub.state.environments.find((e) => e.id === id)!
  }

  /**
   * Changes one: its name, address, whether a person must press Promote, how the hub deploys to it (null: it doesn't),
   * and its place, which is the position it's moved to among its repo's, from 0. Everything in the repo is numbered
   * again, so the places are always 0, 1, 2… Its name is part of its id, so a rename gives it a new one.
   */
  async changeEnvironment(login: string, id: string, fields: { name?: string | null; url?: string | null; needsApproval?: boolean; deploy?: { repo?: string | null; workflow?: string | null; ref?: string | null } | null; order?: number | null }) {
    const env = this.hub.state.environments.find((e) => e.id === id)
    if (!env?.repo) throw new Refused('No such environment.')
    const repo = env.repo
    const name = fields.name === undefined || fields.name === null ? env.name : this.checkedName(fields.name)
    const newId = environmentId(repo, name)
    if (newId !== env.id && this.hub.state.environments.some((e) => e.id === newId)) throw new Refused(`${repo} has an environment called ${name} already.`)
    const deploy = fields.deploy === undefined ? env.deploy : fields.deploy === null ? undefined : this.checkedDeploy(fields.deploy, repo)
    // Waiting for a person is only for the hub's own deploys; a deploy newly set waits, as a person's the safe default.
    const needsApproval = !!deploy
    const url = fields.url === undefined ? env.url : this.checkedUrl(fields.url)
    const actor = { kind: 'user', login } as const
    const changes: Change[] = newId === env.id
      ? [{ type: 'env.update', id: env.id, fields: { name, url, needsApproval, deploy } }]
      : [{ type: 'env.delete', id: env.id }, { type: 'env.put', environment: { ...env, id: newId, name, url, needsApproval, ...(deploy ? { deploy } : { deploy: undefined }) } }]
    if (typeof fields.order === 'number' && Number.isFinite(fields.order)) {
      const others = repoEnvironments(this.hub.state, repo).filter((e) => e.id !== env.id)
      const place = Math.max(0, Math.min(others.length, Math.round(fields.order)))
      const ordered = [...others.slice(0, place), env, ...others.slice(place)]
      // The one that moved is told its place, and so is each of the others whose place changed.
      for (const [at, each] of ordered.entries()) if (each === env || each.order !== at) changes.push({ type: 'env.update', id: each === env ? newId : each.id, fields: { order: at } })
    }
    await this.hub.recordAll(actor, changes)
    await this.settleSets()
    return this.hub.state.environments.find((e) => e.id === newId)!
  }

  /** Takes one away. If GitHub deploys there again, it comes back by itself. */
  async removeEnvironment(login: string, id: string) {
    const env = this.hub.state.environments.find((e) => e.id === id)
    if (!env) throw new Refused('No such environment.')
    await this.hub.record({ kind: 'user', login }, { type: 'env.delete', id })
    await this.settleSets()
  }

  /** Promote what's on the environment before this one: its workflow runs with that version. Without one, there's nothing for the hub to do. */
  async promote(login: string, envId: string, token?: string) {
    const env = this.hub.state.environments.find((e) => e.id === envId)
    if (!env) throw new Refused('No such environment.')
    if (!env.deploy) throw new Refused(`${env.name} has no deploy workflow, so the hub can’t deploy to it. It shows what GitHub deploys there.`)
    const from = environmentBefore(this.hub.state, env)
    if (!from) throw new Refused('Nothing comes before that environment.')
    if (env.state === 'deploying') throw new Refused(`${env.name} is already deploying.`)
    if (!from.version) throw new Refused(`Nothing has been deployed to ${from.name} yet.`)
    if (env.version === from.version) throw new Refused(`${env.name} already has ${from.version}.`)
    const github = await this.githubAs(env.deploy.repo, token)
    if (!github) throw new Refused('GitHub isn’t set up on this hub, so its workflow can’t run.')
    try {
      await github.dispatch(env.deploy.repo, env.deploy.workflow, env.deploy.ref, { version: from.version, environment: env.name })
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error
      throw new Refused(`GitHub didn’t start ${env.deploy.workflow} on ${env.deploy.ref} in ${env.deploy.repo}: ${error.message}`)
    }
    await this.hub.record({ kind: 'user', login }, { type: 'env.update', id: env.id, fields: { state: 'deploying', progress: 0.05 } })
  }
}
