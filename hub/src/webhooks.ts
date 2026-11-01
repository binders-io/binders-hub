import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Change } from '../../shared/state.ts'
import type { Card, PullRequest } from '../../shared/work.ts'
import { checkOf, type CheckRunJSON } from './github.ts'
import type { Actions } from './actions.ts'
import type { Hub } from './hub.ts'
import { readBody, readMetadata, withoutMetadata, type IssuesSaver } from './savers/issues.ts'
import { log } from './logger.ts'
import { whatsWrongWithWebhook } from './schemas.ts'

// GitHub telling the hub what happened there: an issue edited or closed, a pull request opened or merged, a check
// finished, a workflow run, a deployment. Each becomes changes in the log. A delivery whose signature doesn't match the
// hub's secret is refused before anything is read.

export function verify(secret: string, raw: Buffer, signature: string | undefined) {
  if (!signature?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

interface Repo { full_name: string }
interface IssueJSON { number: number; title: string; body: string | null; state: 'open' | 'closed'; html_url: string; pull_request?: unknown }
interface PullJSON { number: number; title: string; body: string | null; state: 'open' | 'closed'; merged?: boolean; html_url: string; head: { ref: string; sha?: string }; additions?: number; deletions?: number }

const hubActor = { kind: 'hub' } as const

export class Webhooks {
  private hub: Hub
  private actions: Actions
  private issues?: IssuesSaver

  constructor(hub: Hub, actions: Actions, issues?: IssuesSaver) {
    this.hub = hub
    this.actions = actions
    this.issues = issues
  }

  async handle(event: string, payload: Record<string, unknown>) {
    const wrong = whatsWrongWithWebhook(event, payload)
    if (wrong) {
      log.warn({ event, wrong }, 'Ignored a delivery from GitHub in a shape the hub doesn’t know')
      return 'ignored'
    }
    switch (event) {
      case 'issues':
        return this.issue(payload as { action: string; issue: IssueJSON; repository: Repo })
      case 'pull_request':
        return this.pull(payload as { action: string; pull_request: PullJSON; repository: Repo })
      case 'check_run':
        return this.checkRun(payload as { check_run: CheckRunJSON & { pull_requests: { number: number }[] }; repository: Repo })
      case 'workflow_run':
        return this.workflowRun(payload as { workflow_run: { id: number; name: string; head_branch: string; event: string; status: string; conclusion: string | null; run_started_at?: string; updated_at?: string; html_url: string }; repository: Repo })
      case 'deployment_status':
        return this.deployment(payload as { deployment_status: { state: string }; deployment: { environment: string; ref: string; sha: string; payload?: { version?: string } | string } })
      default:
        return 'ignored'
    }
  }

  private cardForIssue(repo: string, number: number, body?: string | null): Card | undefined {
    const meta = readMetadata(body)
    return this.hub.state.cards.find((c) => (meta?.card && c.id === meta.card) || (c.issue?.repo === repo && c.issue.number === number))
  }

  private async issue({ action, issue, repository }: { action: string; issue: IssueJSON; repository: Repo }) {
    if (issue.pull_request) return 'ignored'
    const repo = repository.full_name
    const card = this.cardForIssue(repo, issue.number, issue.body)
    if (!card) return 'no card'
    const at = new Date().toISOString()
    if (action === 'edited') {
      if (this.issues?.isEcho(repo, issue.number, issue.title, issue.body ?? '')) return 'echo'
      const { brief, doneWhen } = readBody(issue.body ?? '')
      const fields: Partial<Card> = {}
      if (issue.title !== card.title) fields.title = issue.title
      if (brief && brief !== card.brief && brief !== '_No brief yet._') fields.brief = brief
      if (doneWhen && doneWhen !== card.doneWhen) fields.doneWhen = doneWhen
      if (!Object.keys(fields).length) return 'unchanged'
      await this.hub.record(hubActor, { type: 'card.update', id: card.id, fields, activity: { at, by: 'hub', kind: 'comment', text: 'Edited on GitHub' } })
      return 'updated'
    }
    if (action === 'closed' && card.stage !== 'live') {
      await this.hub.record(hubActor, { type: 'card.update', id: card.id, fields: { stage: 'live', agentId: card.agentId }, activity: { at, by: 'hub', kind: 'moved', text: 'Closed on GitHub' } })
      return 'closed'
    }
    if (action === 'reopened' && card.stage === 'live') {
      await this.hub.record(hubActor, { type: 'card.update', id: card.id, fields: { stage: 'ready', agentId: undefined }, activity: { at, by: 'hub', kind: 'moved', text: 'Reopened on GitHub' } })
      return 'reopened'
    }
    void withoutMetadata
    return 'ignored'
  }

  /** Which card a pull request is for: Binders' marker in its body, "Closes #12" naming a card's issue, or "12-" in its branch. */
  cardForPull(repo: string, pull: { body: string | null; branch: string }): Card | undefined {
    const body = pull.body ?? ''
    const marked = /binders[- ]card:\s*([\w-]+)/i.exec(body)?.[1] ?? (readMetadata(body)?.card as string | undefined)
    if (marked) {
      const card = this.hub.state.cards.find((c) => c.id === marked)
      if (card) return card
    }
    const issueNumbers = [...body.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => Number(m[1]))
    const fromBranch = /(?:^|\/)(\d+)-/.exec(pull.branch)?.[1]
    if (fromBranch) issueNumbers.push(Number(fromBranch))
    return this.hub.state.cards.find((c) => c.issue?.repo === repo && issueNumbers.includes(c.issue.number))
  }

  private async pull({ action, pull_request: p, repository }: { action: string; pull_request: PullJSON; repository: Repo }) {
    const repo = repository.full_name
    const id = `${repo}#${p.number}`
    const known = this.hub.state.pulls.find((x) => x.id === id)
    const card = known?.cardId ? this.hub.state.cards.find((c) => c.id === known.cardId) : this.cardForPull(repo, { body: p.body, branch: p.head.ref })
    if (!known && !card) return 'not ours'
    const state: PullRequest['state'] = p.merged ? 'merged' : p.state === 'closed' ? 'closed' : known?.state === 'approved' || known?.state === 'queued' ? known.state : 'open'
    const pull: PullRequest = {
      ...(known ?? { checks: [], files: [] }),
      id, repo, number: p.number, title: p.title, branch: p.head.ref, url: p.html_url, state,
      cardId: card?.id ?? known?.cardId, agentId: known?.agentId ?? card?.agentId,
      head: p.head.sha ?? known?.head,
      additions: p.additions ?? known?.additions, deletions: p.deletions ?? known?.deletions,
    }
    if (!known && card) {
      // New to the hub: the actions read its files and checks and put it in the binder's change set.
      await this.actions.linkPull(repo, p.number, { cardId: card.id, agentId: card.agentId })
    }
    // New commits on it (a conflict resolved, say): whether it merges is asked again.
    const fresh = action === 'synchronize' || action === 'reopened' ? { mergeable: undefined } : {}
    await this.hub.record(hubActor, { type: 'pr.put', pull: { ...(this.hub.state.pulls.find((x) => x.id === id) ?? pull), title: pull.title, branch: pull.branch, url: pull.url, state: pull.state, head: pull.head, additions: pull.additions, deletions: pull.deletions, ...fresh } })
    const changes: Change[] = []
    const at = new Date().toISOString()
    if (card && action === 'opened' && card.stage === 'working') changes.push({ type: 'card.update', id: card.id, fields: { stage: 'review', prId: id }, activity: { at, by: 'hub', kind: 'pr', text: `Opened ${repo.split('/')[1]}#${p.number}` } })
    if (card && p.merged && card.stage !== 'live') changes.push({ type: 'card.update', id: card.id, fields: { stage: 'live' }, activity: { at, by: 'hub', kind: 'merged', text: `Merged ${repo.split('/')[1]}#${p.number}` } })
    if (changes.length) await this.hub.recordAll(hubActor, changes)
    return action
  }

  private async checkRun({ check_run, repository }: { check_run: CheckRunJSON & { pull_requests: { number: number }[] }; repository: Repo }) {
    const check = checkOf(check_run)
    let touched = 0
    for (const { number } of check_run.pull_requests ?? []) {
      const pull = this.hub.state.pulls.find((p) => p.id === `${repository.full_name}#${number}`)
      if (!pull) continue
      const checks = pull.checks.some((c) => c.name === check.name) ? pull.checks.map((c) => (c.name === check.name ? check : c)) : [...pull.checks, check]
      await this.hub.record(hubActor, { type: 'pr.update', id: pull.id, fields: { checks } })
      touched++
    }
    return touched ? 'updated' : 'not ours'
  }

  private async workflowRun({ workflow_run: run, repository }: { workflow_run: { id: number; name: string; head_branch: string; event: string; status: string; conclusion: string | null; run_started_at?: string; updated_at?: string; html_url: string }; repository: Repo }) {
    const check = checkOf({ name: run.name, status: run.status, conclusion: run.conclusion, started_at: run.run_started_at, completed_at: run.status === 'completed' ? run.updated_at : null })
    await this.hub.record(hubActor, {
      type: 'run.put',
      run: { id: `gh-${run.id}`, workflow: run.name, target: `${run.head_branch} · ${run.event}`, repo: repository.full_name, state: check.state, seconds: check.seconds ?? 0, at: run.updated_at ?? new Date().toISOString(), url: run.html_url },
    })
    return 'recorded'
  }

  private async deployment({ deployment_status: status, deployment }: { deployment_status: { state: string }; deployment: { environment: string; ref: string; sha: string; payload?: { version?: string } | string } }) {
    const envs = this.hub.state.environments
    const env = envs.find((e) => e.id.toLowerCase() === deployment.environment.toLowerCase() || e.name.toLowerCase() === deployment.environment.toLowerCase())
    if (!env) return 'no environment'
    if (status.state === 'queued' || status.state === 'in_progress' || status.state === 'pending') {
      await this.hub.record(hubActor, { type: 'env.update', id: env.id, fields: { state: 'deploying', progress: 0.3 } })
      return 'deploying'
    }
    if (status.state === 'failure' || status.state === 'error') {
      await this.hub.record(hubActor, { type: 'env.update', id: env.id, fields: { state: 'failed', progress: undefined } })
      return 'failed'
    }
    if (status.state !== 'success') return 'ignored'
    const payload = typeof deployment.payload === 'string' ? (() => { try { return JSON.parse(deployment.payload as string) } catch { return {} } })() : deployment.payload ?? {}
    const version = (payload as { version?: string }).version ?? deployment.ref ?? deployment.sha.slice(0, 7)
    // What it now has: what the environment before it had, or, for the first after previews, every merged set.
    const index = envs.indexOf(env)
    const before = envs[index - 1]
    const sets = before && before.id !== 'preview'
      ? before.changeSetIds
      : this.hub.state.changeSets.filter((s) => s.state === 'merged' || s.state === 'shipped').map((s) => s.id)
    await this.actions.recordDeployed(hubActor, env.id, sets, version)
    return 'deployed'
  }
}
