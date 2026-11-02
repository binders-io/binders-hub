import { Spaces, type Member, type Space } from '../src/spaces.ts'
import type { KV } from '../src/kv.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import { createHash, generateKeyPairSync, verify as verifySignature } from 'node:crypto'
import type { Note } from '../../shared/notes.ts'
import type { Change } from '../../shared/state.ts'

/** A throwaway Redis for one test file: its own port, nothing written to disk. */
export async function startRedis(port: number): Promise<{ url: string; stop: () => void } | undefined> {
  let child: ChildProcess
  try {
    child = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' })
  } catch {
    return undefined
  }
  const failed = await Promise.race([new Promise((done) => child.once('error', () => done(true))), sleep(400).then(() => false)])
  if (failed) return undefined
  return { url: `redis://127.0.0.1:${port}`, stop: () => child.kill() }
}

export const tempDir = (name: string) => mkdtemp(join(tmpdir(), `binders-hub-${name}-`))

export function note(id: string, title: string, extra: Partial<Note> = {}): Note {
  return { id, title, binderId: 'b1', editedAt: '2026-10-29T00:00:00.000Z', editors: ['you'], text: `# ${title}\n`, ...extra }
}

/** A binder with a folder and a note in it. */
export const seed = (): Change[] => [
  { type: 'binder.put', binder: { id: 'b1', name: 'Server' } },
  { type: 'folder.put', folder: { id: 'f1', binderId: 'b1', name: 'Planning' } },
  { type: 'note.put', note: note('n1', 'First note', { folderId: 'f1' }) },
]

/** Waits until `check` holds, or fails after a while. */
export async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error('Timed out waiting')
}

export interface GitHubCall {
  method: string
  path: string
  body?: Record<string, unknown>
  auth?: string
}

/**
 * A stand-in for GitHub: issues, a pull request with its files and checks, reviews, merges, workflow dispatches, and
 * the OAuth sign-in. It keeps every call, so tests can see what the hub asked GitHub to do.
 */
export async function fakeGitHub(options: {
  login?: string; orgs?: string[]; mergeFails?: number[]; appOwner?: { login: string; type: 'User' | 'Organization' }
  /** The app GitHub makes from a manifest (42 unless set; tests change it to make another app). */
  appId?: number
  /** Each installation's account (acme unless set), and the installation each account's repos are reached by (7). */
  installations?: Record<number, string>
  /** The kind of account each installation is on: an organization unless it's the app owner's own, or set here. */
  installationTypes?: Record<number, 'User' | 'Organization'>
  /** By a person's token: the app's installations GitHub lists for them. Unset, /user/installations refuses (a token of another app). */
  userInstallations?: Record<string, number[]>
  /** By a person's token: the organizations they're an active member of. */
  memberships?: Record<string, string[]>
  repoInstallations?: Record<string, number>
} = {}) {
  const calls: GitHubCall[] = []
  /** What the stand-in GitHub has now, for the poller's questions; tests change it between rounds. */
  const world = {
    issues: [] as Record<string, unknown>[],
    checks: undefined as Record<string, unknown>[] | undefined,
    runs: [] as Record<string, unknown>[],
    deployments: [] as Record<string, unknown>[],
    statuses: {} as Record<number, string>,
    /** Review comments on lines are refused, as when new commits moved them out of the diff. */
    linesGone: false,
    /** What the signed-in person may do in each repo (push unless set); none answers as if it weren't there. */
    access: {} as Record<string, 'push' | 'read' | 'none'>,
    /** How long a sign-in lasts, in seconds; set, it comes with a refresh token, as a GitHub App's does. */
    tokenSeconds: 0,
    renewals: 0,
    /** The commit at the head of each pull request, by number: tests move it to land new commits. */
    heads: {} as Record<number, string>,
    /** What `compare` answers, by "from...to". */
    compares: {} as Record<string, { commits: { sha: string; commit: { message: string; author?: { name?: string; date?: string } } }[]; files?: { filename: string; additions: number; deletions: number; patch?: string }[]; additions?: number; deletions?: number }>,
    /** The branch each pull request is aimed at, by number (main unless set). */
    bases: {} as Record<number, string>,
    /** Whether each pull request merges, by number: GitHub's mergeable_state (clean unless set). */
    mergeable: {} as Record<number, 'clean' | 'behind' | 'dirty'>,
  }
  let notModified = 0
  const app = Fastify()
  // ETags as GitHub sends them: a GET asked again with the same one, and nothing changed, is answered 304.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' || reply.statusCode !== 200 || typeof payload !== 'string') return payload
    const etag = `"${createHash('sha1').update(payload).digest('hex')}"`
    reply.header('etag', etag)
    if (request.headers['if-none-match'] === etag) {
      notModified++
      reply.code(304)
      return ''
    }
    return payload
  })
  app.get('/repos/:owner/:repo/issues', async () => world.issues)
  app.get('/repos/:owner/:repo/actions/runs', async () => ({ workflow_runs: world.runs }))
  app.get('/repos/:owner/:repo/deployments', async () => world.deployments)
  app.get('/repos/:owner/:repo/deployments/:id/statuses', async (request) => {
    const state = world.statuses[Number((request.params as { id: string }).id)]
    return state ? [{ state }] : []
  })
  let issues = 100
  app.addHook('preHandler', async (request) => {
    calls.push({ method: request.method, path: request.url.split('?')[0], auth: request.headers.authorization, body: request.body as Record<string, unknown> | undefined })
  })
  // A GitHub App's side: its key, the manifest conversion, installations and their tokens, each checked for the app's JWT.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const signedByApp = (authorization?: string) => {
    const [header, payload, signature] = (authorization ?? '').replace(/^Bearer /, '').split('.')
    if (!signature) return false
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))
    return ok && JSON.parse(Buffer.from(payload, 'base64url').toString()).iss === String(options.appId ?? 42)
  }
  app.post('/app-manifests/:code/conversions', async (request, reply) => {
    if ((request.params as { code: string }).code !== 'made') return reply.code(404).send({ message: 'Not Found' })
    return { id: options.appId ?? 42, slug: 'binders-test', name: 'Binders test', owner: options.appOwner ?? { login: 'octo', type: 'User' }, client_id: 'Iv1.app', client_secret: 'app-secret', webhook_secret: 'app-hook-secret', pem, html_url: 'https://github.test/apps/binders-test' }
  })
  app.patch('/app/hook/config', async (request, reply) => (signedByApp(request.headers.authorization) ? request.body : reply.code(401).send({ message: 'Bad JWT' })))
  app.get('/app/installations/:id', async (request, reply) => {
    if (!signedByApp(request.headers.authorization)) return reply.code(401).send({ message: 'Bad JWT' })
    const id = Number((request.params as { id: string }).id)
    const login = options.installations?.[id] ?? 'acme'
    const owner = options.appOwner ?? { login: 'octo', type: 'User' }
    return { id, account: { login, type: options.installationTypes?.[id] ?? (login === owner.login ? owner.type : 'Organization') } }
  })
  const bearer = (request: { headers: { authorization?: string } }) => (request.headers.authorization ?? '').replace(/^(Bearer|token) /, '')
  app.get('/user/installations', async (request, reply) => {
    if (!options.userInstallations) return reply.code(403).send({ message: 'You must authenticate with an access token authorized to a GitHub App' })
    const ids = options.userInstallations[bearer(request)] ?? []
    return { total_count: ids.length, installations: ids.map((id) => ({ id })) }
  })
  app.get('/user/memberships/orgs/:org', async (request, reply) => {
    const org = (request.params as { org: string }).org
    return options.memberships?.[bearer(request)]?.includes(org) ? { state: 'active', organization: { login: org } } : reply.code(404).send({ message: 'Not Found' })
  })
  app.get('/repos/:owner/:repo/installation', async (request, reply) => (signedByApp(request.headers.authorization) ? { id: options.repoInstallations?.[(request.params as { owner: string }).owner] ?? 7 } : reply.code(401).send({ message: 'Bad JWT' })))
  app.post('/app/installations/:id/access_tokens', async (request, reply) => (signedByApp(request.headers.authorization) ? { token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() } : reply.code(401).send({ message: 'Bad JWT' })))
  app.addHook('preHandler', async (request) => {
    calls[calls.length - 1].body = request.body as Record<string, unknown>
  })
  app.post('/repos/:owner/:repo/issues', async (request) => {
    const { owner, repo } = request.params as { owner: string; repo: string }
    issues++
    return { number: issues, html_url: `https://github.test/${owner}/${repo}/issues/${issues}` }
  })
  app.patch('/repos/:owner/:repo/issues/:n', async (request) => {
    const { owner, repo, n } = request.params as { owner: string; repo: string; n: string }
    return { number: Number(n), html_url: `https://github.test/${owner}/${repo}/issues/${n}` }
  })
  let comments = 500
  app.post('/repos/:owner/:repo/issues/:n/comments', async (request) => {
    const { owner, repo, n } = request.params as { owner: string; repo: string; n: string }
    comments++
    return { id: comments, html_url: `https://github.test/${owner}/${repo}/issues/${n}#issuecomment-${comments}` }
  })
  app.patch('/repos/:owner/:repo/issues/comments/:id', async (request) => {
    const { owner, repo, id } = request.params as { owner: string; repo: string; id: string }
    return { id: Number(id), html_url: `https://github.test/${owner}/${repo}/issues#issuecomment-${id}` }
  })
  app.get('/repos/:owner/:repo/pulls/:n', async (request) => {
    const { owner, repo, n } = request.params as { owner: string; repo: string; n: string }
    const merging = world.mergeable[Number(n)] ?? 'clean'
    return { number: Number(n), title: `Pull ${n}`, body: '', head: { ref: `agent/${n}-work`, sha: world.heads[Number(n)] ?? `sha${n}` }, html_url: `https://github.test/${owner}/${repo}/pull/${n}`, state: 'open', merged: false, additions: 12, deletions: 3, mergeable: merging !== 'dirty', mergeable_state: merging, base: { ref: world.bases[Number(n)] ?? 'main' } }
  })
  app.get('/repos/:owner/:repo/compare/:range', async (request, reply) => {
    const answer = world.compares[(request.params as { range: string }).range]
    if (!answer) return reply.code(404).send({ message: 'Not Found' })
    return answer
  })
  app.get('/repos/:owner/:repo', async (request, reply) => {
    const { owner, repo } = request.params as { owner: string; repo: string }
    const access = world.access[`${owner}/${repo}`] ?? 'push'
    if (access === 'none') return reply.code(404).send({ message: 'Not Found' })
    return { default_branch: 'main', permissions: { pull: true, push: access === 'push' } }
  })
  app.patch('/repos/:owner/:repo/pulls/:n', async (request) => {
    const n = Number((request.params as { n: string }).n)
    const base = (request.body as { base?: string })?.base
    if (base) world.bases[n] = base
    return { number: n }
  })
  app.put('/repos/:owner/:repo/pulls/:n/update-branch', async (request, reply) => {
    const n = Number((request.params as { n: string }).n)
    if (world.mergeable[n] === 'dirty') return reply.code(422).send({ message: 'merge conflict between base and head' })
    world.mergeable[n] = 'clean'
    return reply.code(202).send({ message: 'Updating pull request branch.' })
  })
  app.get('/repos/:owner/:repo/pulls/:n/files', async () => [{ filename: 'src/a.ts', additions: 2, deletions: 1, patch: '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' }])
  app.get('/repos/:owner/:repo/commits/:ref/check-runs', async () => ({ check_runs: world.checks ?? [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-10-29T00:00:00Z', completed_at: '2026-10-29T00:00:30Z', html_url: 'https://github.test/run/1' }] }))
  let reviews = 900
  app.post('/repos/:owner/:repo/pulls/:n/reviews', async (request, reply) => {
    const { owner, repo, n } = request.params as { owner: string; repo: string; n: string }
    // As GitHub does when a comment's line isn't in the pull request's diff any more.
    if (world.linesGone && ((request.body as { comments?: unknown[] })?.comments?.length ?? 0) > 0) return reply.code(422).send({ message: 'Unprocessable Entity: Line could not be resolved' })
    reviews++
    return { id: reviews, html_url: `https://github.test/${owner}/${repo}/pull/${n}#pullrequestreview-${reviews}` }
  })
  app.put('/repos/:owner/:repo/pulls/:n/merge', async (request, reply) => {
    const n = Number((request.params as { n: string }).n)
    if (options.mergeFails?.includes(n)) return reply.code(405).send({ message: 'Pull Request is not mergeable' })
    return { merged: true, sha: `merged${n}` }
  })
  app.post('/repos/:owner/:repo/actions/workflows/:workflow/dispatches', async (_request, reply) => reply.code(204).send())
  app.post('/login/oauth/access_token', async (request) => {
    const body = request.body as { code?: string; grant_type?: string; refresh_token?: string }
    const expiring = (token: string, refresh: string) => (world.tokenSeconds ? { access_token: token, expires_in: world.tokenSeconds, refresh_token: refresh, refresh_token_expires_in: 15_897_600 } : { access_token: token })
    if (body?.grant_type === 'refresh_token') {
      if (body.refresh_token !== `ghr_${world.renewals}`) return { error: 'bad_refresh_token', error_description: 'That refresh token was used already.' }
      world.renewals++
      return expiring(`gho_renewed_${world.renewals}`, `ghr_${world.renewals}`)
    }
    return body?.code === 'good' ? expiring('gho_test', 'ghr_0') : { error_description: 'bad code' }
  })
  app.get('/user', async () => ({ login: options.login ?? 'octo', name: 'Octo Person', avatar_url: 'https://github.test/a.png' }))
  app.get('/user/orgs', async () => (options.orgs ?? []).map((login) => ({ login })))
  app.get('/orgs/:org/members', async () => [{ login: 'ana', avatar_url: 'https://github.test/ana.png' }, { login: 'ben', avatar_url: '' }])
  // Only the app may make repos in an organization: its people's accounts may not, as in one of managed users.
  app.post('/orgs/:org/repos', async (request, reply) => {
    const { org } = request.params as { org: string }
    const { name } = request.body as { name: string }
    if (request.headers.authorization !== 'token ghs_installation' && request.headers.authorization !== 'Bearer ghs_installation') return reply.code(403).send({ message: 'You need admin access to the organization before adding a repository to it.' })
    return reply.code(201).send({ id: 7, full_name: `${org}/${name}`, html_url: `https://github.test/${org}/${name}` })
  })
  app.get('/search/users', async () => ({ items: [{ login: 'anabel', avatar_url: '' }] }))
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return { url, calls, world, notModified: () => notModified, close: () => app.close() }
}

/** A hub's one Binder, open to everyone it lets in, for tests of a hub that holds one. */
export function oneSpace(kv: KV, parts: Omit<Space, 'id'>, members: Member[] = []) {
  return Spaces.of(kv, [{ info: { id: 'test', name: 'Test', members }, space: { id: 'test', ...parts } }])
}
