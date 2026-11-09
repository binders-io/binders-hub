import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Change } from '../../shared/state.ts'
import type { Card, PullRequest } from '../../shared/work.ts'
import { checkOf, type CheckRunJSON } from './github.ts'
import type { Actions } from './actions.ts'
import { versionIn } from './actions/environments.ts'
import type { Hub } from './hub.ts'
import { readBody, readMetadata, withoutMetadata, type IssuesSaver } from './savers/issues.ts'
import { log } from './logger.ts'
import { whatsWrongWithWebhook } from './schemas.ts'
import { handMove, sameRepo } from '../../shared/work.ts'

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
type DeploymentPayload = {
  deployment_status: { state: string; environment_url?: string | null; log_url?: string | null; target_url?: string | null; created_at?: string; updated_at?: string }
  deployment: { environment: string; ref: string; sha: string; payload?: { version?: string } | string; transient_environment?: boolean }
  repository: Repo
}
interface PullJSON { number: number; title: string; body: string | null; state: 'open' | 'closed'; merged?: boolean; html_url: string; head: { ref: string; sha?: string }; merge_commit_sha?: string | null; additions?: number; deletions?: number }

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
        return this.deployment(payload as DeploymentPayload)
      default:
        return 'ignored'
    }
  }

  private cardForIssue(repo: string, number: number, body?: string | null): Card | undefined {
    const meta = readMetadata(body)
    return this.hub.state.cards.find((c) => (meta?.card && c.id === meta.card) || (sameRepo(c.issue?.repo, repo) && c.issue?.number === number))
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
    return this.hub.state.cards.find((c) => sameRepo(c.issue?.repo, repo) && issueNumbers.includes(c.issue!.number))
  }

  private async pull({ action, pull_request: p, repository }: { action: string; pull_request: PullJSON; repository: Repo }) {
    const repo = repository.full_name
    // The one the hub has already, however its repo was written when it was linked.
    const known = this.hub.state.pulls.find((x) => sameRepo(x.repo, repo) && x.number === p.number)
    const id = known?.id ?? `${repo}#${p.number}`
    const card = known?.cardId ? this.hub.state.cards.find((c) => c.id === known.cardId) : this.cardForPull(repo, { body: p.body, branch: p.head.ref })
    if (!known && !card) return 'not ours'
    const state: PullRequest['state'] = p.merged ? 'merged' : p.state === 'closed' ? 'closed' : known?.state === 'approved' || known?.state === 'queued' ? known.state : 'open'
    const pull: PullRequest = {
      ...(known ?? { checks: [], files: [] }),
      id, repo, number: p.number, title: p.title, branch: p.head.ref, url: p.html_url, state,
      cardId: card?.id ?? known?.cardId, agentId: known?.agentId ?? card?.agentId,
      head: p.head.sha ?? known?.head,
      additions: p.additions ?? known?.additions, deletions: p.deletions ?? known?.deletions,
      ...(p.merged && p.merge_commit_sha ? { mergeSha: p.merge_commit_sha } : {}),
    }
    if (!known && card) {
      // New to the hub: the actions read its files and checks and put it in the binder's change set.
      await this.actions.linkPull(repo, p.number, { cardId: card.id, agentId: card.agentId })
    }
    // New commits on it (a conflict resolved, say): whether it merges is asked again.
    const fresh = action === 'synchronize' || action === 'reopened' ? { mergeable: undefined } : {}
    await this.hub.record(hubActor, { type: 'pr.put', pull: { ...(this.hub.state.pulls.find((x) => x.id === id) ?? pull), title: pull.title, branch: pull.branch, url: pull.url, state: pull.state, head: pull.head, additions: pull.additions, deletions: pull.deletions, ...(pull.mergeSha ? { mergeSha: pull.mergeSha } : {}), ...fresh } })
    const changes: Change[] = []
    const at = new Date().toISOString()
    if (card && action === 'opened' && card.stage === 'working') changes.push({ type: 'card.update', id: card.id, fields: { stage: 'review', prId: id }, activity: { at, by: 'hub', kind: 'pr', text: `Opened ${repo.split('/')[1]}#${p.number}` } })
    if (card && p.merged && card.stage !== 'live') changes.push({ type: 'card.update', id: card.id, fields: { stage: 'live' }, activity: { at, by: 'hub', kind: 'merged', text: `Merged ${repo.split('/')[1]}#${p.number}` } })
    // Closed on GitHub without merging: out of its change set, and its card waits in Proposed for a person to decide.
    if (action === 'closed' && !p.merged) changes.push(...this.closedUnmerged(id, repo, p.number, card, at))
    if (changes.length) await this.hub.recordAll(hubActor, changes)
    return action
  }

  /**
   * What a pull request closed without merging changes. Nothing picks its card up again until a person moves it on, as it
   * may have been closed because the work was wrong. A set it leaves empty goes with it; the work that merged elsewhere
   * is left as it is.
   */
  private closedUnmerged(prId: string, repo: string, number: number, card: Card | undefined, at: string): Change[] {
    const changes: Change[] = []
    for (const set of this.hub.state.changeSets.filter((s) => s.prIds.includes(prId))) {
      const rest = set.prIds.filter((id) => id !== prId)
      changes.push(rest.length || (set.state !== 'assembling' && set.state !== 'review')
        ? { type: 'set.update', id: set.id, fields: { prIds: rest } }
        : { type: 'set.delete', id: set.id })
    }
    if (card && (card.stage === 'review' || card.stage === 'working' || card.stage === 'blocked')) {
      changes.push({ type: 'card.update', id: card.id, fields: handMove(card, 'proposed') ?? {}, activity: { at, by: 'hub', kind: 'comment', text: `${repo.split('/')[1]}#${number} was closed on GitHub without merging.` } })
    }
    return changes
  }

  private async checkRun({ check_run, repository }: { check_run: CheckRunJSON & { pull_requests: { number: number }[] }; repository: Repo }) {
    const check = checkOf(check_run)
    let touched = 0
    for (const { number } of check_run.pull_requests ?? []) {
      const pull = this.hub.state.pulls.find((p) => sameRepo(p.repo, repository.full_name) && p.number === number)
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

  /** What GitHub says of a deployment: the environments, and what's on them, are the actions'. */
  private async deployment({ deployment_status: status, deployment, repository }: DeploymentPayload) {
    return this.actions.deploymentSeen(repository.full_name, {
      environment: deployment.environment, ref: deployment.ref, sha: deployment.sha, version: versionIn(deployment.payload),
      state: status.state, url: status.environment_url ?? undefined, logUrl: status.log_url ?? status.target_url ?? undefined, at: status.created_at ?? status.updated_at, transient: deployment.transient_environment === true,
    })
  }
}
