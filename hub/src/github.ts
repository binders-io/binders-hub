import type { Check, CheckState, FileDiff } from '../../shared/work.ts'
import { patchLines, type Commit } from '../../shared/changeSet.ts'

// GitHub's REST API, as much as the hub uses: issues for cards, pull requests with their files and checks, reviews and
// merges for change sets, and workflow runs for deploying. `apiUrl` is api.github.com, a GitHub Enterprise server's,
// or a stand-in in tests.

export class GitHubError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface IssueFields {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  labels?: string[]
}

export interface PullInfo {
  number: number
  title: string
  body: string
  branch: string
  url: string
  state: 'open' | 'closed'
  merged: boolean
  /** null while GitHub is still working it out. */
  mergeable: boolean | null
  mergeableState: string
  /** The branch it merges into. */
  base: string
  headSha: string
  additions: number
  deletions: number
  /** The commit a merged pull request made on its base. */
  mergeSha?: string
}

/** A deployment GitHub lists for a repo. */
export interface DeploymentInfo {
  id: number
  environment: string
  ref: string
  sha: string
  payload?: { version?: string } | string
  createdAt?: string
  /** A throwaway environment, as GitHub marks it. */
  transient?: boolean
}

/** A deployment's status, as GitHub gives it. */
export interface DeploymentStatusInfo {
  state: string
  /** Where the environment is served. */
  environmentUrl?: string
  /** The run that deployed it. */
  logUrl?: string
  createdAt?: string
}

/** How long a call to GitHub may take: a slow GitHub shouldn't hold up whatever is waiting on it for good. */
const callLimitMs = 20_000

export class GitHub {
  private token: string
  private apiUrl: string

  constructor(token: string, apiUrl = 'https://api.github.com') {
    this.token = token
    this.apiUrl = apiUrl.replace(/\/$/, '')
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'binders-hub',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(callLimitMs),
    })
    if (response.status === 204) return undefined as T
    const text = await response.text()
    const json = text ? JSON.parse(text) : undefined
    if (!response.ok) throw new GitHubError(response.status, (json as { message?: string })?.message ?? `GitHub answered ${response.status}`)
    return json as T
  }

  /**
   * A GET that sends what GitHub last said (its ETag): an answer of "Not Modified" costs nothing against the rate limit,
   * which is what makes following GitHub by asking affordable.
   */
  async poll<T>(path: string, etag?: string): Promise<{ changed: false; etag?: string } | { changed: true; etag?: string; body: T }> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'binders-hub',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      signal: AbortSignal.timeout(callLimitMs),
    })
    if (response.status === 304) return { changed: false, etag }
    const text = await response.text()
    const json = text ? JSON.parse(text) : undefined
    if (!response.ok) throw new GitHubError(response.status, (json as { message?: string })?.message ?? `GitHub answered ${response.status}`)
    return { changed: true, etag: response.headers.get('etag') ?? undefined, body: json as T }
  }

  /** The branch a repo's work lands on (main, usually). */
  async defaultBranch(repo: string) {
    return (await this.call<{ default_branch: string }>('GET', `/repos/${repo}`)).default_branch
  }

  /** Points a pull request at another base branch. */
  retarget(repo: string, number: number, base: string) {
    return this.call<{ number: number }>('PATCH', `/repos/${repo}/pulls/${number}`, { base })
  }

  /** A plain POST or PUT, for the few calls without a method of their own. */
  send<T>(method: 'POST' | 'PUT', path: string, body?: unknown) {
    return this.call<T>(method, path, body)
  }

  /** A plain GET, for lists such as an organization's members. */
  get<T>(path: string) {
    return this.call<T>('GET', path)
  }

  createIssue(repo: string, fields: IssueFields) {
    return this.call<{ number: number; html_url: string }>('POST', `/repos/${repo}/issues`, fields)
  }

  updateIssue(repo: string, number: number, fields: IssueFields) {
    return this.call<{ number: number; html_url: string }>('PATCH', `/repos/${repo}/issues/${number}`, fields)
  }

  createComment(repo: string, number: number, body: string) {
    return this.call<{ id: number; html_url: string }>('POST', `/repos/${repo}/issues/${number}/comments`, { body })
  }

  updateComment(repo: string, id: number, body: string) {
    return this.call<{ id: number; html_url: string }>('PATCH', `/repos/${repo}/issues/comments/${id}`, { body })
  }

  async pull(repo: string, number: number): Promise<PullInfo> {
    const p = await this.call<{ number: number; title: string; body: string | null; head: { ref: string; sha: string }; base?: { ref: string }; html_url: string; state: 'open' | 'closed'; merged: boolean; merge_commit_sha?: string | null; additions: number; deletions: number; mergeable: boolean | null; mergeable_state?: string }>('GET', `/repos/${repo}/pulls/${number}`)
    return { number: p.number, title: p.title, body: p.body ?? '', branch: p.head.ref, headSha: p.head.sha, url: p.html_url, state: p.state, merged: p.merged, additions: p.additions, deletions: p.deletions, mergeable: p.mergeable, mergeableState: p.mergeable_state ?? 'unknown', base: p.base?.ref ?? 'main', ...(p.merged && p.merge_commit_sha ? { mergeSha: p.merge_commit_sha } : {}) }
  }

  async files(repo: string, number: number): Promise<FileDiff[]> {
    const files = await this.call<{ filename: string; additions: number; deletions: number; patch?: string }[]>('GET', `/repos/${repo}/pulls/${number}/files?per_page=100`)
    return files.map((f) => ({ path: f.filename, added: f.additions, removed: f.deletions, lines: patchLines(f.patch ?? '') }))
  }

  /** What landed between two commits on a branch: the commits themselves, and the files they touch. */
  async compare(repo: string, from: string, to: string): Promise<{ commits: Commit[]; files: FileDiff[]; additions: number; deletions: number }> {
    const c = await this.call<{
      commits?: { sha: string; commit: { message: string; author?: { name?: string; date?: string } } }[]
      files?: { filename: string; additions: number; deletions: number; patch?: string }[]
      additions?: number
      deletions?: number
    }>('GET', `/repos/${repo}/compare/${from}...${to}?per_page=100`)
    return {
      commits: (c.commits ?? []).map((commit) => ({
        sha: commit.sha,
        title: (commit.commit.message ?? '').split('\n')[0].slice(0, 200),
        by: commit.commit.author?.name,
        at: commit.commit.author?.date,
      })),
      files: (c.files ?? []).map((f) => ({ path: f.filename, added: f.additions, removed: f.deletions, lines: patchLines(f.patch ?? '') })),
      additions: c.additions ?? 0,
      deletions: c.deletions ?? 0,
    }
  }

  /**
   * Whether `head` has `base` in its history (it's ahead of it, or the same commit). Not known when GitHub can't say: a
   * commit it has lost, or no answer.
   */
  async includes(repo: string, base: string, head: string): Promise<boolean> {
    const c = await this.call<{ status?: string }>('GET', `/repos/${repo}/compare/${base}...${head}?per_page=1`)
    return c.status === 'ahead' || c.status === 'identical'
  }

  /** A repo's newest deployments, newest first. */
  async deployments(repo: string, count = 30): Promise<DeploymentInfo[]> {
    const list = await this.call<{ id: number; environment: string; ref: string; sha: string; payload?: { version?: string } | string; created_at?: string; transient_environment?: boolean }[]>('GET', `/repos/${repo}/deployments?per_page=${count}`)
    return list.map((d) => ({ id: d.id, environment: d.environment, ref: d.ref, sha: d.sha, payload: d.payload, createdAt: d.created_at, ...(d.transient_environment ? { transient: true } : {}) }))
  }

  /** A deployment's latest status, if it has one. */
  async deploymentStatus(repo: string, id: number): Promise<DeploymentStatusInfo | undefined> {
    const list = await this.call<{ state: string; environment_url?: string; log_url?: string; target_url?: string; created_at?: string }[]>('GET', `/repos/${repo}/deployments/${id}/statuses?per_page=1`)
    const latest = list[0]
    return latest ? { state: latest.state, environmentUrl: latest.environment_url || undefined, logUrl: latest.log_url || latest.target_url || undefined, createdAt: latest.created_at } : undefined
  }

  async checks(repo: string, ref: string): Promise<Check[]> {
    const body = await this.call<{ check_runs: CheckRunJSON[] }>('GET', `/repos/${repo}/commits/${ref}/check-runs?per_page=100`)
    return body.check_runs.map(checkOf)
  }

  approve(repo: string, number: number, body = 'Approved in Binders as part of a change set.') {
    return this.call('POST', `/repos/${repo}/pulls/${number}/reviews`, { event: 'APPROVE', body })
  }

  /** A review that only comments: a line comment for each of `comments`, at its line on the side of the diff given. */
  review(repo: string, number: number, review: { body: string; comments: { path: string; line: number; side: 'RIGHT' | 'LEFT'; body: string }[] }) {
    return this.call<{ id: number; html_url: string }>('POST', `/repos/${repo}/pulls/${number}/reviews`, { event: 'COMMENT', ...review })
  }

  /** Brings a pull request's branch up to date with its base, when that needs no help (GitHub refuses with conflicts). */
  updateBranch(repo: string, number: number) {
    return this.call<{ message: string }>('PUT', `/repos/${repo}/pulls/${number}/update-branch`, {})
  }

  merge(repo: string, number: number, method: 'squash' | 'merge' | 'rebase' = 'merge') {
    return this.call<{ merged: boolean; sha: string }>('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: method })
  }

  dispatch(repo: string, workflow: string, ref: string, inputs: Record<string, string>) {
    return this.call('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs })
  }
}

export interface CheckRunJSON {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: string | null
  started_at?: string | null
  completed_at?: string | null
  html_url?: string
}

export function checkOf(run: CheckRunJSON): Check {
  let state: CheckState = 'queued'
  if (run.status === 'in_progress') state = 'running'
  if (run.status === 'completed') state = run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped' ? 'passed' : 'failed'
  const seconds = run.started_at && run.completed_at ? Math.round((Date.parse(run.completed_at) - Date.parse(run.started_at)) / 1000) : undefined
  return { name: run.name, state, seconds, url: run.html_url }
}

/** "owner/repo#12", or a pull request's address, as a repo and a number. */
export function parsePullRef(ref: string): { repo: string; number: number } | undefined {
  const url = /github\.[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(ref)
  if (url) return { repo: url[1], number: Number(url[2]) }
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim())
  if (short) return { repo: short[1], number: Number(short[2]) }
  return undefined
}
