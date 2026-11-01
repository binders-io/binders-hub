import { mergeableOf } from './actions.ts'
import { checkOf, type CheckRunJSON, type GitHub } from './github.ts'
import type { Hub } from './hub.ts'
import type { RepoAccess } from './savers/issues.ts'
import type { Webhooks } from './webhooks.ts'

// Following GitHub by asking, for a hub GitHub can't send webhooks to (one on a Mac, or behind a firewall). Every so
// often it asks, for each repo the hub works with, what a webhook would have said: issues and pull requests changed
// since it last looked, the checks on the pull requests it follows, workflow runs, and deployments. What it hears goes
// through the webhooks' own handling, so the board moves the same way, only a little later. Each request sends what
// GitHub last answered (its ETag), so a quiet repo costs nothing against the rate limit. While real webhook deliveries
// arrive, it stands down.

import type { PollMode } from './options.ts'

interface IssueItem {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  html_url: string
  updated_at: string
  pull_request?: unknown
}

interface RunItem {
  id: number
  name: string
  head_branch: string
  event: string
  status: string
  conclusion: string | null
  run_started_at?: string
  updated_at?: string
  html_url: string
}

interface DeploymentItem {
  id: number
  environment: string
  ref: string
  sha: string
  payload?: { version?: string } | string
}

export interface PollerOptions {
  /** How it asks, as the hub's options say now: Settings can change it while the hub runs. */
  settings?: () => { mode: PollMode; everyMs: number }
  /** Webhook deliveries this recent mean the webhook works, and asking isn't needed. */
  webhookFreshMs?: number
}

export class GitHubPoller {
  private hub: Hub
  private github: RepoAccess
  private webhooks: Webhooks
  private settings: () => { mode: PollMode; everyMs: number }
  private webhookFreshMs: number
  private timer?: NodeJS.Timeout
  private running = false
  private readonly startedAt = new Date(Date.now() - 60_000).toISOString()
  private etags = new Map<string, string>()
  private since = new Map<string, string>()
  private seenItems = new Map<string, string>()
  private heads = new Map<string, string>()
  private seenRuns = new Map<number, string>()
  private deployments = new Map<number, string>()
  private recentDeployments = new Map<string, DeploymentItem[]>()
  private baselined = new Set<string>()
  private lastWebhook = 0
  lastPoll?: string
  lastError?: string

  constructor(hub: Hub, github: RepoAccess, webhooks: Webhooks, options: PollerOptions = {}) {
    this.hub = hub
    this.github = github
    this.webhooks = webhooks
    this.settings = options.settings ?? (() => ({ mode: 'auto', everyMs: 30_000 }))
    this.webhookFreshMs = options.webhookFreshMs ?? 15 * 60_000
  }

  /** A real webhook delivery arrived: in auto, asking stands down for a while. */
  heardWebhook() {
    this.lastWebhook = Date.now()
  }

  get active() {
    const { mode } = this.settings()
    if (mode === 'off') return false
    if (mode === 'on') return true
    return Date.now() - this.lastWebhook > this.webhookFreshMs
  }

  /** Whether a webhook delivery came recently. */
  get webhookHeard() {
    return Date.now() - this.lastWebhook <= this.webhookFreshMs
  }

  status() {
    const { mode, everyMs } = this.settings()
    return { mode, active: this.active, everySeconds: Math.round(everyMs / 1000), webhookHeard: this.webhookHeard, lastPoll: this.lastPoll, lastError: this.lastError }
  }

  /** Asks every so often, as often as the options say at each turn, and not at all while they say off. */
  start() {
    const tick = () => {
      this.timer = setTimeout(async () => {
        await this.poll().catch(() => {})
        tick()
      }, this.settings().everyMs)
    }
    setTimeout(() => void this.poll().catch(() => {}), 2000)
    tick()
  }

  stop() {
    clearTimeout(this.timer)
  }

  /** The repos the hub works with: its binders', and those of the pull requests it follows. */
  private repos() {
    const repos = new Set<string>()
    for (const binder of this.hub.state.binders) if (binder.repo) repos.add(binder.repo)
    for (const pull of this.hub.state.pulls) if (pull.state !== 'merged' && pull.state !== 'closed') repos.add(pull.repo)
    return [...repos]
  }

  /** One round of asking. Returns the repos it reached. */
  async poll() {
    if (!this.active || this.running) return []
    this.running = true
    const reached: string[] = []
    let failed: string | undefined
    try {
      for (const repo of this.repos()) {
        try {
          const github = await this.github.forRepo(repo)
          if (!github) continue
          await this.issuesAndPulls(github, repo)
          await this.checks(github, repo)
          await this.runs(github, repo)
          await this.deploymentsOf(github, repo)
          reached.push(repo)
        } catch (error) {
          failed = `${repo}: ${(error as Error).message}`
        }
      }
    } finally {
      this.running = false
      this.lastPoll = new Date().toISOString()
      this.lastError = failed
    }
    return reached
  }

  private async ask<T>(github: GitHub, path: string) {
    const answer = await github.poll<T>(path, this.etags.get(path))
    if (answer.etag) this.etags.set(path, answer.etag)
    return answer.changed ? answer.body : undefined
  }

  /** Issues and pull requests changed since last time, as the issues and pull_request webhooks would bring them. */
  private async issuesAndPulls(github: GitHub, repo: string) {
    const since = this.since.get(repo) ?? this.startedAt
    // The address stays the same until something changes, so "Not Modified" answers while nothing does.
    const items = await this.ask<IssueItem[]>(github, `/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`)
    if (!items) return
    let latest = since
    for (const item of items) {
      if (item.updated_at > latest) latest = item.updated_at
      const key = `${repo}#${item.number}`
      if (this.seenItems.get(key) === item.updated_at) continue
      this.seenItems.set(key, item.updated_at)
      if (item.pull_request) {
        const info = await github.pull(repo, item.number)
        this.heads.set(key, info.headSha)
        const known = this.hub.state.pulls.some((p) => p.id === key)
        await this.webhooks.handle('pull_request', {
          action: known ? 'synchronize' : 'opened',
          pull_request: { number: info.number, title: info.title, body: info.body, state: info.state, merged: info.merged, html_url: info.url, head: { ref: info.branch, sha: info.headSha }, additions: info.additions, deletions: info.deletions },
          repository: { full_name: repo },
        })
        // It's been asked already: whether it merges as things are now.
        if (this.hub.state.pulls.some((p) => p.id === key) && info.mergeable !== null) await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: key, fields: { mergeable: mergeableOf(info) } })
      } else {
        const card = this.hub.state.cards.find((c) => c.issue?.repo === repo && c.issue.number === item.number)
        if (!card) continue
        const action = item.state === 'closed' && card.stage !== 'live' ? 'closed' : item.state === 'open' && card.stage === 'live' ? 'reopened' : 'edited'
        await this.webhooks.handle('issues', { action, issue: item, repository: { full_name: repo } })
      }
    }
    this.since.set(repo, latest)
  }

  /** The checks on each pull request the hub follows in this repo, as check_run webhooks would bring them. */
  private async checks(github: GitHub, repo: string) {
    for (const pull of this.hub.state.pulls.filter((p) => p.repo === repo && (p.state === 'open' || p.state === 'approved' || p.state === 'queued'))) {
      let head = this.heads.get(pull.id)
      if (!head) {
        head = (await github.pull(repo, pull.number)).headSha
        this.heads.set(pull.id, head)
      }
      const runs = await this.ask<{ check_runs: CheckRunJSON[] }>(github, `/repos/${repo}/commits/${head}/check-runs?per_page=100`)
      if (!runs) continue
      const checks = runs.check_runs.map(checkOf)
      if (JSON.stringify(checks) === JSON.stringify(pull.checks)) continue
      await this.hub.record({ kind: 'hub' }, { type: 'pr.update', id: pull.id, fields: { checks } })
    }
  }

  private async runs(github: GitHub, repo: string) {
    const list = await this.ask<{ workflow_runs: RunItem[] }>(github, `/repos/${repo}/actions/runs?per_page=20`)
    if (!list) return
    for (const run of [...list.workflow_runs].reverse()) {
      const seen = `${run.status}:${run.conclusion}:${run.updated_at}`
      if (this.seenRuns.get(run.id) === seen) continue
      this.seenRuns.set(run.id, seen)
      await this.webhooks.handle('workflow_run', { workflow_run: run, repository: { full_name: repo } })
    }
  }

  /**
   * Deployments' latest statuses. The first look only notes where each one is, so old deployments aren't replayed;
   * after that, a status that changes is taken as the deployment_status webhook would bring it.
   */
  private async deploymentsOf(github: GitHub, repo: string) {
    const list = await this.ask<DeploymentItem[]>(github, `/repos/${repo}/deployments?per_page=10`)
    if (list) this.recentDeployments.set(repo, list.slice(0, 5))
    const first = !this.baselined.has(repo)
    this.baselined.add(repo)
    // With no new deployments, the recent ones still get their statuses checked.
    for (const deployment of this.recentDeployments.get(repo) ?? []) {
      const statuses = await this.ask<{ state: string }[]>(github, `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`)
      if (!statuses?.length) continue
      const state = statuses[0].state
      const before = this.deployments.get(deployment.id)
      this.deployments.set(deployment.id, state)
      if (first || before === state || !deployment.environment) continue
      await this.webhooks.handle('deployment_status', { deployment_status: { state }, deployment })
    }
  }
}
