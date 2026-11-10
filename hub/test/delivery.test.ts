import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { GitHubError, type GitHub } from '../src/github.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { GitHubPoller } from '../src/poller.ts'
import { Scheduler } from '../src/scheduler.ts'
import { log } from '../src/logger.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { boardFor, carryOut, propose, type WorkPlace } from '../src/brain/board.ts'
import { mostFromGitHub, versionOf } from '../src/actions/environments.ts'
import type { Change } from '../../shared/state.ts'
import { startingSeed } from '../../shared/seed.ts'
import { environmentBefore, promotion, repoEnvironments, type Card, type Environment, type PullRequest } from '../../shared/work.ts'
import { fakeGitHub, oneSpace, seed, until } from './helpers.ts'

// Delivery: the environments GitHub deploys each repo to. The hub follows what GitHub says and never records a deploy
// it didn't report.

const at = '2026-11-09T10:00:00.000Z'
const cardOf = (n: number, fields: Partial<Card> = {}): Change => ({ type: 'card.put', card: { id: `c${n}`, binderId: 'b1', title: `Card ${n}`, brief: '', doneWhen: '', size: 'M', stage: 'live', createdAt: at, createdBy: 'you', updatedAt: at, waitsFor: [], activity: [], ...fields } })
/** A merged pull request with its card, and the commit it made when it merged (m<number>). */
const mergedPull = (repo: string, n: number, fields: Partial<PullRequest> = {}): Change[] => [
  cardOf(n),
  { type: 'pr.put', pull: { id: `${repo}#${n}`, repo, number: n, title: `Pull ${n}`, branch: `agent/${n}-work`, url: '', state: 'merged', cardId: `c${n}`, checks: [], files: [], mergeSha: `m${n}`, ...fields } },
]
const setOf = (id: string, prIds: string[], state: 'merged' | 'merging' | 'shipped' = 'merged'): Change => ({ type: 'set.put', set: { id, binderId: 'b1', number: Number(id.replace(/\D/g, '')), title: `Set ${id}`, summary: '', state, prIds, noteIds: [] } })
const environment = (repo: string, name: string, fields: Partial<Environment> = {}): Change => ({ type: 'env.put', environment: { id: `${repo.toLowerCase()}#${name.toLowerCase()}`, repo, name, url: '', version: '', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0, by: 'github', ...fields } })

/** A hub for the binder acme/web, whose agents also work in acme/api, with a stand-in GitHub. */
async function setUp(extra: Change[] = []) {
  const github = await fakeGitHub()
  const hub = new Hub(new MemoryLog())
  await hub.start([...seed(), { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web', repos: ['acme/api'] } }, ...extra])
  const connection = new GitHubConnection(new MemoryKV(), new Sealer('x'), { webUrl: github.url, apiUrl: github.url }, { token: 'ghs_server' })
  const actions = new Actions(hub, connection)
  actions.lookPauseMs = 0
  actions.firstLookMs = 60_000
  const webhooks = new Webhooks(hub, actions)
  const deployed = (repo: string, environment: string, fields: { state?: string; ref?: string; sha?: string; payload?: unknown; status?: Record<string, unknown> } = {}) => webhooks.handle('deployment_status', {
    deployment_status: { state: fields.state ?? 'success', ...fields.status },
    deployment: { environment, ref: fields.ref ?? 'main', sha: fields.sha ?? 'abc1234def5678', ...(fields.payload ? { payload: fields.payload } : {}) },
    repository: { full_name: repo },
  })
  const env = (id: string) => hub.state.environments.find((e) => e.id === id)!
  return { github, hub, actions, webhooks, deployed, env, connection, close: () => github.close() }
}

describe('a new hub', () => {
  it('starts with no environments, and a welcome note that points at Settings → GitHub', () => {
    const changes = startingSeed('you')
    assert.ok(!changes.some((c) => c.type === 'env.put'))
    const note = changes.find((c) => c.type === 'note.put')
    assert.ok(note && note.type === 'note.put')
    assert.ok(note.note.text.includes('Link this binder to a GitHub repo in Settings → GitHub, and its cards become issues there.'))
    assert.ok(!note.note.text.includes('Settings → Projects'))
  })
})

describe('environments from before they were per repo', () => {
  it('go at start, and the change sets they shipped go back to merged, since no deploy was reported', async () => {
    const { hub, actions, close } = await setUp([
      ...mergedPull('acme/web', 1, { mergeSha: undefined }),
      setOf('set-1', ['acme/web#1'], 'shipped'),
      { type: 'env.put', environment: { id: 'staging', name: 'Staging', url: '', version: '0.5.0', changeSetIds: ['set-1'], state: 'healthy', deployedAt: '', needsApproval: false } },
      { type: 'env.put', environment: { id: 'production', name: 'Production', url: '', version: '0.5.0', changeSetIds: ['set-1'], state: 'healthy', deployedAt: '', needsApproval: true } },
    ])
    // Nothing throws on them before they're dropped: no repo, no order, and a pull request with no merge commit.
    assert.deepEqual(repoEnvironments(hub.state, 'acme/web'), [])
    assert.equal(environmentBefore(hub.state, hub.state.environments[1]), undefined)
    assert.equal(promotion(hub.state, hub.state.environments[1]), undefined)
    assert.doesNotMatch(boardFor([{ id: 'test', name: 'Server', hub, actions }], 'you').passage.text, /Environments|0\.5\.0/)
    await assert.rejects(actions.promote('you', 'production'), /no deploy workflow/)
    await assert.rejects(actions.changeEnvironment('you', 'staging', { name: 'Stage' }), /No such environment/)
    await actions.followDeliveries()
    assert.deepEqual(hub.state.environments, [])
    assert.equal(hub.state.changeSets[0].state, 'merged')
    await close()
  })
})

describe('GitHub’s word on a deployment', () => {
  it('makes the environment when there is none, last in its repo’s order, with its address, and finds it again whatever the capitals', async () => {
    const { hub, deployed, env, close } = await setUp()
    assert.equal(await deployed('acme/web', 'Staging', { state: 'in_progress', status: { environment_url: 'https://staging.acme.test' } }), 'deploying')
    assert.deepEqual({ ...env('acme/web#staging') }, {
      id: 'acme/web#staging', repo: 'acme/web', name: 'Staging', url: 'https://staging.acme.test', version: '', changeSetIds: [], state: 'deploying', deployedAt: '', needsApproval: false, order: 0, by: 'github', progress: 0.3,
    })
    await deployed('Acme/Web', 'STAGING', { state: 'success', ref: 'v1.0.0' })
    await deployed('acme/web', 'production', { state: 'queued' })
    assert.deepEqual(hub.state.environments.map((e) => [e.id, e.name, e.order, e.state]), [['acme/web#staging', 'Staging', 0, 'healthy'], ['acme/web#production', 'production', 1, 'deploying']])
    // Another repo of the binder has its own.
    await deployed('acme/api', 'Staging', { state: 'success' })
    assert.deepEqual(repoEnvironments(hub.state, 'acme/api').map((e) => [e.id, e.order]), [['acme/api#staging', 0]])
    await close()
  })

  it('takes only the repos that count: the binder’s, its agents’, and those of its pull requests', async () => {
    const { hub, deployed, close } = await setUp([
      { type: 'agent.put', agent: { id: 'a1', name: 'Sonnet', provider: 'claude', owner: 'you', repos: ['acme/tools'], binders: [], skills: [], createdAt: at } },
      { type: 'agent.put', agent: { id: 'a2', name: 'Gone', provider: 'claude', owner: 'you', repos: ['acme/gone'], binders: [], skills: [], createdAt: at, revoked: true } },
      ...mergedPull('acme/site', 3),
    ])
    assert.equal(await deployed('other/thing', 'staging'), 'not ours')
    assert.equal(await deployed('acme/gone', 'staging'), 'not ours')
    for (const repo of ['acme/web', 'acme/api', 'acme/tools', 'acme/site']) assert.equal(await deployed(repo, 'staging'), 'deployed', repo)
    assert.equal(hub.state.environments.length, 4)
    await close()
  })

  it('shows what GitHub says: deploying, waiting with the run’s link, failed, and a success with its version, commit, address, run and time', async () => {
    const { deployed, env, hub, close } = await setUp()
    await deployed('acme/web', 'staging', { state: 'pending' })
    assert.equal(env('acme/web#staging').state, 'deploying')
    assert.equal(await deployed('acme/web', 'staging', { state: 'waiting', status: { log_url: 'https://github.test/acme/web/actions/runs/9' } }), 'waiting')
    assert.equal(env('acme/web#staging').state, 'waiting')
    assert.equal(env('acme/web#staging').logUrl, 'https://github.test/acme/web/actions/runs/9')
    assert.equal(env('acme/web#staging').progress, undefined)
    assert.equal(await deployed('acme/web', 'staging', { state: 'failure' }), 'failed')
    assert.equal(env('acme/web#staging').state, 'failed')
    assert.equal(await deployed('acme/web', 'staging', { state: 'error' }), 'unchanged', 'it’s failed already')
    // Superseded: nothing to show.
    const before = hub.version
    assert.equal(await deployed('acme/web', 'staging', { state: 'inactive' }), 'ignored')
    assert.equal(hub.version, before)
    assert.equal(await deployed('acme/web', 'staging', { state: 'success', ref: 'main', sha: 'abc1234def5678', payload: { version: '2.4.0' }, status: { environment_url: 'https://staging.acme.test', log_url: 'https://github.test/acme/web/actions/runs/10', created_at: '2026-11-09T09:00:00Z' } }), 'deployed')
    assert.deepEqual({ ...env('acme/web#staging') }, {
      id: 'acme/web#staging', repo: 'acme/web', name: 'staging', url: 'https://staging.acme.test', version: '2.4.0', sha: 'abc1234def5678', pullIds: [], changeSetIds: [], state: 'healthy',
      deployedAt: '2026-11-09T09:00:00Z', logUrl: 'https://github.test/acme/web/actions/runs/10', needsApproval: false, order: 0, by: 'github',
    })
    // The same word again, from a webhook and from looking, writes nothing.
    const version = hub.version
    assert.equal(await deployed('acme/web', 'staging', { state: 'success', ref: 'main', sha: 'abc1234def5678', payload: { version: '2.4.0' }, status: { environment_url: 'https://staging.acme.test', log_url: 'https://github.test/acme/web/actions/runs/10', created_at: '2026-11-09T09:00:00Z' } }), 'unchanged')
    assert.equal(hub.version, version)
    await close()
  })

  it('says what’s on it as the version its deploy named, else the tag or branch, else the commit’s first seven', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    assert.equal(versionOf({ version: '2.4.0', ref: 'main', sha }), '2.4.0')
    assert.equal(versionOf({ ref: 'v1.2.3', sha }), 'v1.2.3')
    assert.equal(versionOf({ ref: 'refs/tags/v3', sha }), 'v3')
    assert.equal(versionOf({ ref: 'main', sha }), 'main')
    assert.equal(versionOf({ ref: sha, sha }), '0123456')
    assert.equal(versionOf({ ref: '', sha }), '0123456')
  })

  it('reads the version from a payload sent as text, and only follows addresses that are http or https', async () => {
    const { deployed, env, close } = await setUp()
    await deployed('acme/web', 'staging', { payload: '{"version":"9.9.9"}', ref: 'main', status: { environment_url: 'javascript:alert(1)', log_url: 'ftp://x' } })
    assert.equal(env('acme/web#staging').version, '9.9.9')
    assert.equal(env('acme/web#staging').url, '')
    assert.equal(env('acme/web#staging').logUrl, undefined)
    await close()
  })

  it('leaves an address a person gave alone, and a person’s environment stays theirs', async () => {
    const { actions, deployed, env, close } = await setUp()
    await actions.addEnvironment('boss', { repo: 'acme/web', name: 'Staging', url: 'https://mine.test' })
    await deployed('acme/web', 'staging', { status: { environment_url: 'https://github.test/env' } })
    assert.equal(env('acme/web#staging').url, 'https://mine.test')
    assert.equal(env('acme/web#staging').by, 'person')
    assert.equal(env('acme/web#staging').version, 'main')
    await close()
  })
})

describe('which pull requests are on an environment', () => {
  const pulls = (...numbers: number[]) => numbers.flatMap((n) => mergedPull('acme/web', n))

  it('asks GitHub whether the deployed commit is ahead of, or the same as, each one’s merge commit, and puts a line on the cards of those that arrive', async () => {
    const { github, hub, deployed, env, close } = await setUp([...pulls(1, 2, 3, 4), ...mergedPull('acme/web', 5, { mergeSha: undefined }), ...mergedPull('acme/web', 6, { state: 'open', mergeSha: undefined }), setOf('set-1', ['acme/web#1']), setOf('set-2', ['acme/web#3']), setOf('set-3', ['acme/web#2', 'acme/web#5'])])
    github.world.compares['m1...abc1234def5678'] = { status: 'ahead', commits: [] }
    github.world.compares['m2...abc1234def5678'] = { status: 'identical', commits: [] }
    github.world.compares['m3...abc1234def5678'] = { status: 'behind', commits: [] }
    github.world.compares['m4...abc1234def5678'] = { status: 'diverged', commits: [] }
    await deployed('acme/web', 'staging', { ref: 'v1.0.0' })
    // 1 and 2 are behind the deployed commit; 3 and 4 are on a line it isn't; 5 has no merge commit known; 6 isn't merged.
    assert.deepEqual(env('acme/web#staging').pullIds, ['acme/web#5', 'acme/web#2', 'acme/web#1'], 'newest first')
    assert.deepEqual(env('acme/web#staging').changeSetIds, ['set-1', 'set-3'])
    const lines = (n: number) => hub.state.cards.find((c) => c.id === `c${n}`)!.activity.filter((a) => a.kind === 'deployed').map((a) => a.text)
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(lines), [['On staging in v1.0.0'], ['On staging in v1.0.0'], [], [], ['On staging in v1.0.0'], []])
    assert.equal(hub.state.cards.find((c) => c.id === 'c1')!.stage, 'live', 'its card was live when it merged, and deploying doesn’t change that')

    // A later deployment asks only of those not on it yet, and a line goes on a card once.
    github.world.compares['m3...fedcba9876543'] = { status: 'ahead', commits: [] }
    github.world.compares['m4...fedcba9876543'] = { status: 'diverged', commits: [] }
    const asked = github.calls.filter((c) => c.path.includes('/compare/')).length
    await deployed('acme/web', 'staging', { ref: 'v1.1.0', sha: 'fedcba9876543' })
    assert.equal(github.calls.filter((c) => c.path.includes('/compare/')).length - asked, 2, 'only 3 and 4')
    assert.deepEqual(env('acme/web#staging').pullIds, ['acme/web#5', 'acme/web#2', 'acme/web#1', 'acme/web#3'])
    assert.deepEqual([1, 3, 4].map(lines), [['On staging in v1.0.0'], ['On staging in v1.1.0'], []])
    assert.deepEqual(env('acme/web#staging').changeSetIds, ['set-1', 'set-2', 'set-3'])
    await close()
  })

  it('counts every merged pull request of the repo as on it when GitHub can’t be asked, or doesn’t know the commit', async () => {
    const { github, hub, deployed, env } = await setUp([...mergedPull('acme/web', 1), ...mergedPull('acme/web', 2), ...mergedPull('acme/web', 3)])
    // 3 is the newest: GitHub doesn't know its commit (404), which says nothing of 2, which is behind; 1 is ahead of nothing known.
    github.world.compares['m2...abc1234def5678'] = { status: 'diverged', commits: [] }
    github.world.compares['m1...abc1234def5678'] = { status: 'diverged', commits: [] }
    await deployed('acme/web', 'staging')
    assert.deepEqual(env('acme/web#staging').pullIds, ['acme/web#3'])
    // GitHub not answering at all: nothing can be told apart, so all of them.
    await github.close()
    await deployed('acme/web', 'production')
    assert.deepEqual(env('acme/web#production').pullIds, ['acme/web#3', 'acme/web#2', 'acme/web#1'])
    assert.equal(hub.state.cards.find((c) => c.id === 'c1')!.activity.filter((a) => a.kind === 'deployed').length, 1)
  })

  it('asks about the newest fifty at a time, and the rest arrive with the next deployment', async () => {
    const many = Array.from({ length: 55 }, (_, i) => i + 1).flatMap((n) => mergedPull('acme/web', n, { mergeSha: undefined }))
    const { deployed, env, close } = await setUp(many)
    await deployed('acme/web', 'staging')
    assert.equal(env('acme/web#staging').pullIds!.length, 50)
    assert.ok(!env('acme/web#staging').pullIds!.includes('acme/web#5'))
    assert.ok(env('acme/web#staging').pullIds!.includes('acme/web#6'))
    await deployed('acme/web', 'staging', { sha: 'fedcba9876543' })
    assert.equal(env('acme/web#staging').pullIds!.length, 55)
    await close()
  })

  it('leaves a repo’s pull requests off the environments of another repo', async () => {
    const { deployed, env, close } = await setUp([...mergedPull('acme/api', 1), ...mergedPull('acme/web', 2, { mergeSha: undefined })])
    await deployed('acme/web', 'staging')
    assert.deepEqual(env('acme/web#staging').pullIds, ['acme/web#2'])
    await close()
  })
})

describe('a change set shipping', () => {
  it('happens once each of its merged pull requests whose repo has environments is on that repo’s last one', async () => {
    const { github, hub, deployed, actions, close } = await setUp([
      ...mergedPull('acme/web', 1, { mergeSha: undefined }),
      ...mergedPull('acme/api', 2, { mergeSha: undefined }),
      ...mergedPull('acme/api', 3, { mergeSha: undefined }),
      ...mergedPull('acme/web', 4, { mergeSha: undefined }),
      setOf('set-1', ['acme/web#1', 'acme/api#2']),
      setOf('set-2', ['acme/api#3']),
      setOf('set-3', ['acme/web#4'], 'merging'),
    ])
    void github
    const state = (id: string) => hub.state.changeSets.find((s) => s.id === id)!.state
    // acme/web has two environments, acme/api has none: only acme/web's pull request counts.
    await actions.addEnvironment('boss', { repo: 'acme/web', name: 'Staging' })
    await actions.addEnvironment('boss', { repo: 'acme/web', name: 'Production' })
    await deployed('acme/web', 'staging', { sha: 'aaa1111' })
    assert.equal(state('set-1'), 'merged', 'on the first, not the last')
    await deployed('acme/web', 'production', { sha: 'aaa1111' })
    assert.equal(state('set-1'), 'shipped')
    assert.equal(state('set-2'), 'merged', 'no repo of it has environments, so nothing says it shipped')
    assert.equal(state('set-3'), 'merging', 'not merged yet')
    // A new environment, last in the repo, and it hasn't got there.
    await actions.addEnvironment('boss', { repo: 'acme/web', name: 'Canary' })
    assert.equal(state('set-1'), 'merged')
    await actions.removeEnvironment('boss', 'acme/web#canary')
    assert.equal(state('set-1'), 'shipped')
    // A repo with environments of its own: the set waits for both.
    await deployed('acme/api', 'staging', { sha: 'bbb2222' })
    assert.equal(state('set-2'), 'shipped')
    await actions.addEnvironment('boss', { repo: 'acme/api', name: 'Production' })
    assert.equal(state('set-1'), 'merged', 'its acme/api pull request isn’t on the last environment')
    assert.equal(state('set-2'), 'merged')
    await close()
  })
})

describe('promoting', () => {
  const two = (second: Partial<Environment> = {}) => [
    environment('acme/web', 'Staging', { version: 'v1.0.0', order: 0, deployedAt: at }),
    environment('acme/web', 'Production', { version: 'v0.9.0', order: 1, needsApproval: true, deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, ...second }),
  ]

  it('refuses where the hub has no workflow, saying so, and records nothing', async () => {
    const { hub, actions, github, close } = await setUp(two())
    const before = hub.version
    await assert.rejects(actions.promote('you', 'acme/web#staging'), { message: 'Staging has no deploy workflow, so the hub can’t deploy to it. It shows what GitHub deploys there.' })
    await actions.changeEnvironment('boss', 'acme/web#production', { deploy: null })
    await assert.rejects(actions.promote('you', 'acme/web#production'), { message: 'Production has no deploy workflow, so the hub can’t deploy to it. It shows what GitHub deploys there.' })
    assert.ok(hub.version > before)
    assert.equal(hub.state.environments.find((e) => e.id === 'acme/web#production')!.version, 'v0.9.0')
    assert.equal(github.calls.filter((c) => c.path.includes('/dispatches')).length, 0)
    await close()
  })

  it('runs the workflow with the version of the environment before it, and waits for GitHub to say it’s deployed', async () => {
    const { hub, actions, github, deployed, env, close } = await setUp(two())
    await actions.promote('sam', 'acme/web#production')
    const dispatch = github.calls.find((c) => c.path.includes('/dispatches'))!
    assert.equal(dispatch.path, '/repos/acme/web/actions/workflows/deploy.yml/dispatches')
    assert.deepEqual(dispatch.body, { ref: 'main', inputs: { version: 'v1.0.0', environment: 'Production' } })
    assert.equal(env('acme/web#production').state, 'deploying')
    assert.equal(env('acme/web#production').version, 'v0.9.0', 'it has what GitHub says it has')
    await assert.rejects(actions.promote('sam', 'acme/web#production'), /already deploying/)
    await deployed('acme/web', 'production', { ref: 'v1.0.0' })
    assert.equal(env('acme/web#production').version, 'v1.0.0')
    await assert.rejects(actions.promote('sam', 'acme/web#production'), /already has v1.0.0/)
    assert.equal(hub.state.environments.length, 2)
    await close()
  })

  it('refuses when nothing comes before it or the one before has nothing yet', async () => {
    const first = await setUp([environment('acme/web', 'Staging', { deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' } })])
    await assert.rejects(first.actions.promote('you', 'acme/web#staging'), /Nothing comes before that environment/)
    await first.close()
    const empty = await setUp(two({}).map((c) => (c.type === 'env.put' && c.environment.name === 'Staging' ? environment('acme/web', 'Staging', { version: '', order: 0 }) : c)))
    await assert.rejects(empty.actions.promote('you', 'acme/web#production'), /Nothing has been deployed to Staging yet/)
    await assert.rejects(empty.actions.promote('you', 'acme/web#nowhere'), /No such environment/)
    await empty.close()
  })

  it('says what GitHub said when it won’t start the workflow', async () => {
    const { hub, close } = await setUp(two())
    const refusing = new Actions(hub, { forRepo: async () => ({ dispatch: async () => { throw new GitHubError(404, 'Not Found') } }) as unknown as GitHub, asUser: () => { throw new Error('no') } })
    await assert.rejects(refusing.promote('you', 'acme/web#production'), { message: 'GitHub didn’t start deploy.yml on main in acme/web: Not Found' })
    assert.equal(hub.state.environments.find((e) => e.id === 'acme/web#production')!.state, 'healthy')
    await close()
  })

  it('is only between two environments of one repo: another repo’s is never the one before', async () => {
    const { actions, close } = await setUp([
      environment('acme/api', 'Staging', { version: 'v7', order: 0 }),
      environment('acme/web', 'Production', { version: '', order: 0, deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' } }),
    ])
    await assert.rejects(actions.promote('you', 'acme/web#production'), /Nothing comes before that environment/)
    await close()
  })
})

describe('the environments’ addresses', () => {
  async function server() {
    const github = await fakeGitHub()
    const hub = new Hub(new MemoryLog())
    await hub.start([...seed(), { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web', repos: ['acme/api'] } }])
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    const connection = new GitHubConnection(kv, sealer, { webUrl: github.url, apiUrl: github.url }, { clientId: 'id', clientSecret: 'secret', token: 'ghs_server' })
    const auth = new Auth(kv, sealer, { github: () => connection.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const actions = new Actions(hub, connection)
    actions.lookPauseMs = 0
    const webhooks = new Webhooks(hub, actions)
    const app = await buildServer(oneSpace(kv, { hub, actions, webhooks, github: connection }, [{ login: 'sam', role: 'member' }, { login: 'boss', role: 'admin' }, { login: 'ola', role: 'owner' }]), { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const as = async (login: string) => {
      const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
      const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
      return async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      }
    }
    return { github, hub, actions, as, close: async () => { await app.close(); await github.close() } }
  }
  const id = (value: string) => encodeURIComponent(value)

  it('are the Binder’s owners’ and admins’, not the hub’s admins’, and a member only reads and promotes', async () => {
    const { hub, actions, as, close } = await server()
    const [member, admin, owner, root] = [await as('sam'), await as('boss'), await as('ola'), await as('root')]
    for (const [method, path, body] of [['POST', '/api/environments', { repo: 'acme/web', name: 'Staging' }], ['POST', '/api/environments/look', {}], ['PUT', `/api/environments/${id('acme/web#staging')}`, { url: '' }], ['DELETE', `/api/environments/${id('acme/web#staging')}`, undefined]] as const) {
      const refused = await member(method, path, body)
      assert.equal(refused.status, 422, `${method} ${path}`)
      assert.match(refused.body.error, /Only this Binder’s owners and admins can change its environments/)
    }
    assert.equal(hub.state.environments.length, 0)
    assert.equal((await admin('POST', '/api/environments', { repo: 'acme/web', name: 'Staging' })).status, 200)
    assert.equal((await owner('POST', '/api/environments', { repo: 'acme/web', name: 'QA' })).status, 200)
    // The hub's admin runs the hub, not this Binder, which has an owner.
    assert.equal((await root('POST', '/api/environments', { repo: 'acme/web', name: 'Canary' })).status, 403)
    assert.equal((await admin('POST', '/api/environments', { repo: 'acme/web', name: 'Canary' })).status, 200)
    // Promote is anyone's in the Binder: the refusal here is the hub's, for no workflow, not for who asked.
    const promoted = await member('POST', `/api/environments/${id('acme/web#qa')}/promote`)
    assert.equal(promoted.status, 422)
    assert.match(promoted.body.error, /QA has no deploy workflow/)
    await actions.deploymentSeen('acme/web', { environment: 'qa', ref: 'v1', sha: 'aaa1111', state: 'success' })
    await admin('PUT', `/api/environments/${id('acme/web#canary')}`, { deploy: { workflow: 'deploy.yml', ref: 'main' } })
    assert.equal((await member('POST', `/api/environments/${id('acme/web#canary')}/promote`)).status, 200)
    await close()
  })

  it('adds one for a repo the Binder works in, last in its order, with a deploy workflow that waits for a person', async () => {
    const { hub, as, close } = await server()
    const admin = await as('boss')
    const staging = await admin('POST', '/api/environments', { repo: 'acme/web', name: ' Staging ', url: 'https://staging.acme.test' })
    assert.equal(staging.status, 200, JSON.stringify(staging.body))
    assert.deepEqual(staging.body, { id: 'acme/web#staging', repo: 'acme/web', name: 'Staging', url: 'https://staging.acme.test', version: '', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0, by: 'person' })
    const production = await admin('POST', '/api/environments', { repo: 'ACME/web', name: 'Production', deploy: { workflow: 'deploy.yml', ref: 'main' } })
    assert.deepEqual(production.body.deploy, { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' })
    assert.equal(production.body.needsApproval, true)
    assert.equal(production.body.order, 1)
    const open = await admin('POST', '/api/environments', { repo: 'acme/api', name: 'Prod', needsApproval: true, deploy: { repo: 'acme/web', workflow: 'x.yml', ref: 'main' } })
    assert.equal(open.status, 200)
    assert.equal(open.body.order, 0, 'each repo has its own order')
    // Waiting for a person is for the hub's own deploys only.
    assert.equal((await admin('POST', '/api/environments', { repo: 'acme/api', name: 'QA', needsApproval: true })).body.needsApproval, false)
    // One the hub can deploy to always waits for a person, whatever's asked: nothing deploys by itself.
    assert.equal((await admin('POST', '/api/environments', { repo: 'acme/api', name: 'Beta', deploy: { workflow: 'b.yml', ref: 'main' }, needsApproval: false })).body.needsApproval, true)
    assert.equal(hub.state.environments.length, 5)
    await close()
  })

  it('refuses what it can’t use, in words', async () => {
    const { as, close } = await server()
    const admin = await as('boss')
    await admin('POST', '/api/environments', { repo: 'acme/web', name: 'Staging' })
    const refusal = async (body: unknown) => (await admin('POST', '/api/environments', body)).body.error as string
    assert.match(await refusal({ repo: 'other/thing', name: 'Staging' }), /other\/thing isn’t one of this binder’s repos/)
    assert.match(await refusal({ repo: 'acme', name: 'Staging' }), /owner\/name/)
    assert.match(await refusal({ repo: 'acme/web', name: 'STAGING' }), /acme\/web has an environment called STAGING already/)
    assert.match(await refusal({ repo: 'acme/web', name: '  ' }), /Give the environment a name/)
    assert.match(await refusal({ repo: 'acme/web', name: 'QA', url: 'javascript:alert(1)' }), /http:\/\/ or https:\/\//)
    assert.match(await refusal({ repo: 'acme/web', name: 'QA', deploy: { workflow: 'deploy.yml' } }), /workflow file.*branch or tag/)
    assert.match(await refusal({ repo: 'acme/web', name: 'QA', deploy: { repo: 'other/thing', workflow: 'd.yml', ref: 'main' } }), /other\/thing isn’t one of this binder’s repos/)
    assert.match(await refusal({ name: 'QA' }), /can’t be used/)
    await close()
  })

  it('changes one, and moves it up and down in its repo’s order, which is renumbered', async () => {
    const { hub, as, close } = await server()
    const admin = await as('boss')
    for (const name of ['Dev', 'Staging', 'Production']) await admin('POST', '/api/environments', { repo: 'acme/web', name })
    const order = () => repoEnvironments(hub.state, 'acme/web').map((e) => `${e.name}:${e.order}`)
    assert.deepEqual(order(), ['Dev:0', 'Staging:1', 'Production:2'])
    const moved = await admin('PUT', `/api/environments/${id('acme/web#production')}`, { order: 0 })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.deepEqual(order(), ['Production:0', 'Dev:1', 'Staging:2'])
    await admin('PUT', `/api/environments/${id('acme/web#production')}`, { order: 99 })
    assert.deepEqual(order(), ['Dev:0', 'Staging:1', 'Production:2'])
    await admin('PUT', `/api/environments/${id('acme/web#dev')}`, { order: 1 })
    assert.deepEqual(order(), ['Staging:0', 'Dev:1', 'Production:2'])

    const set = await admin('PUT', `/api/environments/${id('acme/web#production')}`, { url: 'https://acme.test', deploy: { workflow: 'deploy.yml', ref: 'main' } })
    assert.equal(set.body.url, 'https://acme.test')
    assert.equal(set.body.needsApproval, true, 'a workflow newly set waits for a person')
    assert.equal((await admin('PUT', `/api/environments/${id('acme/web#production')}`, { needsApproval: false })).body.needsApproval, true, 'and goes on waiting for one, as nothing deploys by itself')
    const cleared = await admin('PUT', `/api/environments/${id('acme/web#production')}`, { url: '', deploy: null, needsApproval: true })
    assert.equal(cleared.body.url, '')
    assert.equal(cleared.body.deploy, undefined)
    assert.equal(cleared.body.needsApproval, false)

    // Its name is part of its id: renamed, it's a new id, with its place and what's on it kept.
    const renamed = await admin('PUT', `/api/environments/${id('acme/web#production')}`, { name: 'Live' })
    assert.equal(renamed.body.id, 'acme/web#live')
    assert.deepEqual(order(), ['Staging:0', 'Dev:1', 'Live:2'])
    assert.ok(!hub.state.environments.some((e) => e.id === 'acme/web#production'))
    assert.match((await admin('PUT', `/api/environments/${id('acme/web#live')}`, { name: 'dev' })).body.error, /already/)
    assert.match((await admin('PUT', `/api/environments/${id('acme/web#nowhere')}`, { url: '' })).body.error, /No such environment/)
    assert.match((await admin('PUT', `/api/environments/${id('acme/web#live')}`, { url: 'ftp://x' })).body.error, /http/)
    await close()
  })

  it('removes one, and says when there isn’t one', async () => {
    const { hub, as, close } = await server()
    const admin = await as('boss')
    await admin('POST', '/api/environments', { repo: 'acme/web', name: 'Staging' })
    assert.equal((await admin('DELETE', `/api/environments/${id('acme/web#staging')}`)).status, 200)
    assert.equal(hub.state.environments.length, 0)
    assert.equal((await admin('DELETE', `/api/environments/${id('acme/web#staging')}`)).status, 422)
    await close()
  })

  it('looks at GitHub now for the repos asked, and says which it couldn’t reach; and a person’s other requests never ask GitHub for deployments', async () => {
    const { github, hub, as, close } = await server()
    const admin = await as('boss')
    github.world.deployments = [{ id: 2, environment: 'production', ref: 'v1', sha: 'aaa1111' }, { id: 1, environment: 'staging', ref: 'v1', sha: 'aaa1111' }]
    github.world.statuses = { 1: 'success', 2: 'in_progress' }
    await admin('POST', '/api/environments', { repo: 'acme/web', name: 'Dev' })
    await admin('PUT', `/api/environments/${id('acme/web#dev')}`, { order: 0 })
    await admin('DELETE', `/api/environments/${id('acme/web#dev')}`)
    assert.equal(github.calls.filter((c) => c.path.endsWith('/deployments')).length, 0)

    const one = await admin('POST', '/api/environments/look', { repo: 'ACME/web' })
    assert.equal(one.status, 200, JSON.stringify(one.body))
    assert.deepEqual(one.body, { looked: ['acme/web'], failed: [] })
    assert.deepEqual(repoEnvironments(hub.state, 'acme/web').map((e) => [e.name, e.state, e.version]), [['staging', 'healthy', 'v1'], ['production', 'deploying', '']])
    const all = await admin('POST', '/api/environments/look')
    assert.deepEqual(all.body.looked, ['acme/web', 'acme/api'])
    assert.equal(repoEnvironments(hub.state, 'acme/api').length, 2)
    assert.match((await admin('POST', '/api/environments/look', { repo: 'other/thing' })).body.error, /other\/thing isn’t one of this binder’s repos/)
    await close()
  })
})

describe('looking for itself', () => {
  const deployments = (github: Awaited<ReturnType<typeof fakeGitHub>>) => github.calls.filter((c) => c.path.endsWith('/deployments')).length

  it('reads each environment’s newest deployment’s latest status, the first deployed to coming first, and asks for no more than it needs', async () => {
    const { github, hub, actions, close } = await setUp()
    github.world.deployments = [
      { id: 12, environment: 'production', ref: 'v2', sha: 'p222222', created_at: '2026-11-09T09:00:00Z' },
      { id: 11, environment: 'staging', ref: 'v2', sha: 's222222' },
      { id: 10, environment: 'production', ref: 'v1', sha: 'p111111' },
      { id: 9, environment: 'staging', ref: 'v1', sha: 's111111' },
    ]
    github.world.statuses = { 12: 'success', 11: 'success', 10: 'success', 9: 'success' }
    github.world.statusFields = { 12: { environment_url: 'https://acme.test', log_url: 'https://github.test/runs/12', created_at: '2026-11-09T09:30:00Z' } }
    const result = await actions.lookNow('acme/web')
    assert.deepEqual(result, { looked: ['acme/web'], failed: [] })
    assert.deepEqual(repoEnvironments(hub.state, 'acme/web').map((e) => [e.name, e.order, e.version, e.sha]), [['staging', 0, 'v2', 's222222'], ['production', 1, 'v2', 'p222222']])
    const production = hub.state.environments.find((e) => e.id === 'acme/web#production')!
    assert.deepEqual([production.url, production.logUrl, production.deployedAt, production.by], ['https://acme.test', 'https://github.test/runs/12', '2026-11-09T09:30:00Z', 'github'])
    assert.equal(deployments(github), 1)
    assert.deepEqual(github.calls.filter((c) => c.path.includes('/statuses')).map((c) => c.path), ['/repos/acme/web/deployments/11/statuses', '/repos/acme/web/deployments/12/statuses'])
    await close()
  })

  it('looks at a repo that’s new to it, but not at one that has no environments and was looked at in the last hour, and at one that has some only while webhooks aren’t arriving', async () => {
    const { github, actions, hub, close } = await setUp()
    const minute = 60_000
    const t = Date.parse(at)
    // At start, and when a repo starts to count: the first look. Two repos count, a pause apart.
    assert.deepEqual(await actions.lookDue(t), ['acme/web', 'acme/api'])
    assert.equal(deployments(github), 2)
    // Nothing reported, so no environments: left alone for an hour.
    assert.deepEqual(await actions.lookDue(t + 59 * minute), [])
    assert.equal(deployments(github), 2)
    assert.deepEqual(await actions.lookDue(t + 61 * minute), ['acme/web', 'acme/api'])
    assert.equal(deployments(github), 4)

    // acme/web has environments now: every ten minutes, while webhooks aren't arriving.
    await actions.deploymentSeen('acme/web', { environment: 'staging', ref: 'v1', sha: 'aaa1111', state: 'success' })
    assert.ok(repoEnvironments(hub.state, 'acme/web').length)
    const start = t + 61 * minute
    assert.deepEqual(await actions.lookDue(start + 9 * minute), [])
    assert.deepEqual(await actions.lookDue(start + 11 * minute), ['acme/web'])
    actions.webhooksHeard = () => true
    assert.deepEqual(await actions.lookDue(start + 30 * minute), [], 'webhooks are telling it')
    actions.webhooksHeard = () => false
    assert.deepEqual(await actions.lookDue(start + 31 * minute), ['acme/web'])
    // The binder starts to work in another repo: it's looked at at the next chance, the others left alone.
    await hub.record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web', repos: ['acme/api', 'acme/new'] } })
    assert.deepEqual(await actions.lookDue(start + 32 * minute), ['acme/new'])
    await close()
  })

  it('goes one repo at a time with a pause between, and a look under way isn’t started again', async () => {
    const { actions, close } = await setUp()
    actions.lookPauseMs = 150
    const started = Date.now()
    const first = actions.lookDue(Date.now())
    assert.deepEqual(await actions.lookDue(Date.now()), [], 'one is under way')
    assert.deepEqual(await first, ['acme/web', 'acme/api'])
    assert.ok(Date.now() - started >= 140, 'a pause between the repos')
    await close()
  })

  it('says which repos it couldn’t reach', async () => {
    const { hub, close } = await setUp()
    // A hub GitHub isn't set up on.
    const bare = new Actions(hub, { forRepo: async () => undefined, asUser: () => { throw new Error('no') } })
    bare.lookPauseMs = 0
    assert.deepEqual(await bare.lookNow(), { looked: [], failed: [{ repo: 'acme/web', why: 'GitHub isn’t connected for acme/web.' }, { repo: 'acme/api', why: 'GitHub isn’t connected for acme/api.' }] })
    await close()
  })

  it('is the scheduler’s to start, once the hub has begun following deliveries, and never waited for', async () => {
    const { github, hub, actions, close } = await setUp()
    const scheduler = new Scheduler(hub, actions, { now: () => new Date(at) })
    await scheduler.tick()
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(deployments(github), 0, 'not before it’s switched on')
    await actions.followDeliveries()
    assert.equal(actions.deliveryLooks, true)
    await scheduler.tick()
    await until(() => deployments(github) === 2)
    await close()
  })
})

describe('a pull request’s merge commit', () => {
  const pr = { number: 7, title: 'Pull 7', state: 'closed', merged: true, html_url: '', head: { ref: 'agent/7-work', sha: 'h7' }, merge_commit_sha: 'abc123' }
  const open = [environment('acme/web', 'Staging', { version: 'v1' }), cardOf(7, { stage: 'review' })]

  it('is kept from the webhook when it merges, and not from a pull request that hasn’t', async () => {
    const { hub, webhooks, close } = await setUp([...open, { type: 'pr.put', pull: { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'Pull 7', branch: 'agent/7-work', url: '', state: 'open', cardId: 'c7', checks: [], files: [] } }])
    await webhooks.handle('pull_request', { action: 'synchronize', pull_request: { ...pr, state: 'open', merged: false, merge_commit_sha: 'testmerge' }, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.pulls[0].mergeSha, undefined, 'a test merge commit is nobody’s')
    await webhooks.handle('pull_request', { action: 'closed', pull_request: pr, repository: { full_name: 'acme/web' } })
    assert.equal(hub.state.pulls[0].state, 'merged')
    assert.equal(hub.state.pulls[0].mergeSha, 'abc123')
    assert.deepEqual(hub.state.environments[0].pullIds, undefined, 'merging puts nothing on an environment')
    await close()
  })

  it('is kept when the hub follows GitHub by asking', async () => {
    const { github, hub, actions, webhooks, connection, close } = await setUp([...open, { type: 'pr.put', pull: { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'Pull 7', branch: 'agent/7-work', url: '', state: 'open', cardId: 'c7', checks: [], files: [] } }])
    void actions
    const poller = new GitHubPoller(hub, connection, webhooks, { settings: () => ({ mode: 'on', everyMs: 60_000 }) })
    github.world.mergedPulls[7] = 'm7'
    github.world.issues = [{ number: 7, title: 'Pull 7', body: '', state: 'closed', html_url: '', updated_at: new Date().toISOString(), pull_request: {} }]
    await poller.poll()
    assert.equal(hub.state.pulls[0].state, 'merged')
    assert.equal(hub.state.pulls[0].mergeSha, 'm7')
    await close()
  })

  it('is kept when the hub links a pull request that has merged already, with the environments’ view of it unchanged until GitHub deploys', async () => {
    const { github, actions, close } = await setUp([cardOf(7, { stage: 'review' })])
    github.world.mergedPulls[7] = 'm7'
    const linked = await actions.linkPull('acme/web', 7, { cardId: 'c7' })
    assert.equal(linked.state, 'merged')
    assert.equal(linked.mergeSha, 'm7')
    await close()
  })
})

describe('what the poller hears of a deployment', () => {
  it('is told as a webhook would, with its repo, address, run and time', async () => {
    const { github, hub, connection, webhooks, close } = await setUp([mergedPull('acme/web', 1)[0], ...mergedPull('acme/web', 1, { mergeSha: undefined }).slice(1)])
    const poller = new GitHubPoller(hub, connection, webhooks, { settings: () => ({ mode: 'on', everyMs: 60_000 }) })
    github.world.deployments = [{ id: 5, environment: 'staging', ref: 'v1', sha: 'abc1234' }]
    github.world.statuses = { 5: 'in_progress' }
    await poller.poll()
    assert.equal(hub.state.environments.length, 0, 'the first look notes deployments without replaying them')
    github.world.statuses = { 5: 'success' }
    github.world.statusFields = { 5: { environment_url: 'https://staging.acme.test', log_url: 'https://github.test/runs/5', created_at: '2026-11-09T09:00:00Z' } }
    await poller.poll()
    const staging = hub.state.environments[0]
    assert.deepEqual([staging.id, staging.version, staging.url, staging.logUrl, staging.deployedAt, staging.pullIds], ['acme/web#staging', 'v1', 'https://staging.acme.test', 'https://github.test/runs/5', '2026-11-09T09:00:00Z', ['acme/web#1']])
    await close()
  })
})

describe('the brain’s board', () => {
  const place = (hub: Hub, actions: Actions): WorkPlace => ({ id: 'test', name: 'Server', hub, actions })
  const markOf = (text: string, words: string) => new RegExp(`\\[([a-z]\\d+)\\][^\\n]*${words}`).exec(text)?.[1]

  it('names each environment with its repo, and marks only one the hub can promote to', async () => {
    const { hub, actions, close } = await setUp([
      environment('acme/web', 'Staging', { version: 'v2', order: 0 }),
      environment('acme/web', 'Production', { version: 'v1', order: 1, needsApproval: true, deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' } }),
      environment('acme/api', 'Staging', { version: 'v9', order: 0 }),
      environment('acme/api', 'Production', { version: 'v8', order: 1 }),
      environment('acme/api', 'Canary', { version: '', order: 2 }),
    ])
    const board = boardFor([place(hub, actions)], 'you')
    const text = board.passage.text
    assert.match(text, /Environments:\n- acme\/web Staging: v2, healthy\n- \[e1\] acme\/web Production: v1, healthy; Staging before it has v2\n- acme\/api Staging: v9, healthy\n- acme\/api Production: v8, healthy\n- acme\/api Canary: nothing deployed yet, healthy/)
    const promoted = propose({ verb: 'promote', mark: markOf(text, 'acme\\/web Production')!, rest: '' }, board, 'you')
    assert.equal(promoted.what, 'Promote v2 from Staging to Production in acme/web.')
    assert.equal(await carryOut(promoted), 'Promoting v2 to Production.')
    assert.equal(hub.state.environments.find((e) => e.id === 'acme/web#production')!.state, 'deploying')
    await close()
  })

  it('refuses to promote to one that has lost its workflow since it was offered, in the same words as the address', async () => {
    const { hub, actions, close } = await setUp([environment('acme/web', 'Staging', { version: 'v2', order: 0 }), environment('acme/web', 'Production', { version: 'v1', order: 1 })])
    // No workflow, so nothing to offer: no mark for it.
    assert.equal(markOf(boardFor([place(hub, actions)], 'you').passage.text, 'Production'), undefined)
    await actions.changeEnvironment('boss', 'acme/web#production', { deploy: { workflow: 'deploy.yml', ref: 'main' } })
    const board = boardFor([place(hub, actions)], 'you')
    const mark = markOf(board.passage.text, 'Production')!
    await actions.changeEnvironment('boss', 'acme/web#production', { deploy: null })
    assert.throws(() => propose({ verb: 'promote', mark, rest: '' }, board, 'you'), { message: 'Production has no deploy workflow, so the hub can’t deploy to it. It shows what GitHub deploys there.' })
    await close()
  })
})

describe('preview environments', () => {
  it('are skipped when GitHub marks the deployment as transient, in a webhook, in looking, and in the poller’s pass', async () => {
    const { github, hub, webhooks, actions, connection, close } = await setUp()
    // A webhook.
    const delivery = (environment: string, transient: boolean, state = 'success') => webhooks.handle('deployment_status', { deployment_status: { state }, deployment: { environment, ref: 'pr-9', sha: 'abc1234', transient_environment: transient }, repository: { full_name: 'acme/web' } })
    assert.equal(await delivery('pr-9', true), 'ignored')
    assert.equal(hub.state.environments.length, 0)
    assert.equal(await delivery('staging', false), 'deployed')
    // Looking: a transient deployment's status isn't even asked for.
    github.world.deployments = [{ id: 21, environment: 'pr-21', ref: 'pr-21', sha: 'p21', transient_environment: true }, { id: 20, environment: 'staging', ref: 'v1', sha: 's20', transient_environment: false }]
    github.world.statuses = { 20: 'success', 21: 'success' }
    await actions.lookNow('acme/web')
    assert.deepEqual(hub.state.environments.map((e) => e.name), ['staging'])
    assert.deepEqual(github.calls.filter((c) => c.path.includes('/statuses')).map((c) => c.path), ['/repos/acme/web/deployments/20/statuses'])
    // The poller: the first pass notes where deployments are, and a transient one that then succeeds is left out.
    const poller = new GitHubPoller(hub, connection, webhooks, { settings: () => ({ mode: 'on', everyMs: 60_000 }) })
    github.world.deployments = [{ id: 30, environment: 'pr-30', ref: 'pr-30', sha: 'p30', transient_environment: true }, { id: 31, environment: 'qa', ref: 'v2', sha: 's31' }]
    github.world.statuses = { 30: 'in_progress', 31: 'in_progress' }
    await poller.poll()
    github.world.statuses = { 30: 'success', 31: 'success' }
    const asked = github.calls.filter((c) => c.path.includes('/deployments/30/statuses')).length
    await poller.poll()
    assert.deepEqual(hub.state.environments.map((e) => e.name), ['staging', 'qa'])
    assert.equal(github.calls.filter((c) => c.path.includes('/deployments/30/statuses')).length, asked, 'the transient one costs no more requests')
    await close()
  })

  it('can’t flood a repo: GitHub makes at most 12, a new name past that is ignored with one warning, and a person can still add one', async () => {
    const warned = mock.method(log, 'warn', () => undefined)
    try {
      const { hub, actions, deployed, env, close } = await setUp()
      for (let n = 1; n <= mostFromGitHub; n++) assert.equal(await deployed('acme/web', `env-${n}`), 'deployed')
      assert.equal(hub.state.environments.length, 12)
      const before = hub.version
      assert.equal(await deployed('acme/web', 'env-13'), 'ignored')
      assert.equal(await deployed('acme/web', 'ENV-13'), 'ignored')
      assert.equal(hub.version, before)
      const named = warned.mock.calls.filter((c) => JSON.stringify(c.arguments).includes('env-13') || JSON.stringify(c.arguments).includes('ENV-13'))
      assert.equal(named.length, 1, 'one warning for the name')
      assert.deepEqual(named[0].arguments[0], { repo: 'acme/web', environment: 'env-13' })
      // The ones it has go on being followed; another repo has its own twelve; a person adds by hand.
      assert.equal(await deployed('acme/web', 'env-3', { ref: 'v9' }), 'deployed')
      assert.equal(env('acme/web#env-3').version, 'v9')
      assert.equal(await deployed('acme/api', 'staging'), 'deployed')
      await actions.addEnvironment('boss', { repo: 'acme/web', name: 'Mine' })
      assert.equal(repoEnvironments(hub.state, 'acme/web').length, 13)
      assert.equal(await deployed('acme/web', 'env-14'), 'ignored', 'a person’s don’t make room')
      await close()
    } finally {
      warned.mock.restore()
    }
  })
})
