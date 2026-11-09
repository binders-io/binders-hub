import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Actions } from '../src/actions.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { GitHubPoller } from '../src/poller.ts'
import { Sealer } from '../src/secrets.ts'
import { Webhooks } from '../src/webhooks.ts'
import type { PollMode } from '../src/options.ts'
import type { Card } from '../../shared/work.ts'
import { fakeGitHub, seed } from './helpers.ts'

const card: Card = { id: 'c1', binderId: 'b1', title: 'Old title', brief: 'Old brief', doneWhen: '', size: 'M', stage: 'review', createdAt: '2026-10-29T00:00:00Z', createdBy: 'you', updatedAt: '2026-10-29T00:00:00Z', waitsFor: [], activity: [], issue: { repo: 'acme/web', number: 101, url: '' }, prId: 'acme/web#7' }

async function setUp(mode: PollMode = 'on') {
  const github = await fakeGitHub()
  const hub = new Hub(new MemoryLog())
  await hub.start([
    ...seed(),
    { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } },
    { type: 'card.put', card },
    { type: 'pr.put', pull: { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'Pull 7', branch: 'agent/7-work', url: '', state: 'open', cardId: 'c1', checks: [{ name: 'test', state: 'running' }], files: [] } },
    { type: 'env.put', environment: { id: 'acme/web#staging', repo: 'acme/web', name: 'Staging', url: '', version: '0.1.0', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0, by: 'github' } },
  ])
  const connection = new GitHubConnection(new MemoryKV(), new Sealer('x'), { webUrl: github.url, apiUrl: github.url }, { token: 'ghs_server' })
  const actions = new Actions(hub, connection)
  const poller = new GitHubPoller(hub, connection, new Webhooks(hub, actions), { settings: () => ({ mode, everyMs: 60_000 }) })
  return { github, hub, poller }
}

const now = () => new Date().toISOString()

describe('following GitHub by asking', () => {
  it('brings what a webhook would: issue edits, checks, workflow runs and new deployments', async () => {
    const { github, hub, poller } = await setUp()
    github.world.issues = [{ number: 101, title: 'Renamed on GitHub', body: 'Brief written on GitHub', state: 'open', html_url: '', updated_at: now() }]
    github.world.checks = [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:00Z', completed_at: '2026-10-30T00:00:40Z' }]
    github.world.runs = [{ id: 1, name: 'ci', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_started_at: '2026-10-30T00:00:00Z', updated_at: now(), html_url: '' }]
    github.world.deployments = [{ id: 5, environment: 'staging', ref: 'main', sha: 'abc1234', payload: { version: '0.9.0' } }]
    github.world.statuses = { 5: 'success' }

    assert.deepEqual(await poller.poll(), ['acme/web'])
    const after = hub.state.cards.find((c) => c.id === 'c1')!
    assert.equal(after.title, 'Renamed on GitHub')
    assert.equal(after.brief, 'Brief written on GitHub')
    assert.equal(hub.state.pulls[0].checks[0].state, 'passed')
    assert.equal(hub.state.runs.find((r) => r.id === 'gh-1')?.state, 'passed')
    assert.equal(hub.state.environments[0].version, '0.1.0', 'the first look notes deployments without replaying them')

    // Nothing changed: GitHub answers "Not Modified", and the hub records nothing.
    const version = hub.version
    const quiet = github.notModified()
    await poller.poll()
    assert.equal(hub.version, version)
    assert.ok(github.notModified() > quiet, 'asked with ETags')

    // A new deployment that succeeds moves the environment on; an issue closed on GitHub closes its card.
    github.world.deployments = [{ id: 6, environment: 'staging', ref: 'main', sha: 'def5678', payload: { version: '1.0.0' } }, ...github.world.deployments]
    github.world.statuses[6] = 'success'
    github.world.issues = [{ number: 101, title: 'Renamed on GitHub', body: 'Brief written on GitHub', state: 'closed', html_url: '', updated_at: new Date(Date.now() + 1000).toISOString() }]
    await poller.poll()
    assert.equal(hub.state.environments[0].version, '1.0.0')
    assert.equal(hub.state.cards.find((c) => c.id === 'c1')!.stage, 'live')
    await github.close()
  })

  it('stands down while webhooks arrive, and not at all when off', async () => {
    const auto = await setUp('auto')
    assert.equal(auto.poller.active, true)
    auto.poller.heardWebhook()
    assert.equal(auto.poller.active, false)
    assert.deepEqual(await auto.poller.poll(), [])
    await auto.github.close()
    const off = await setUp('off')
    assert.deepEqual(await off.poller.poll(), [])
    assert.equal(off.github.calls.length, 0)
    await off.github.close()
  })
})
