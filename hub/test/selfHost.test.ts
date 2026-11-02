import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryKV } from '../src/kv.ts'
import { nearby } from '../src/server.ts'
import { firstSpaceIn } from '../src/spaces.ts'

describe('a hub on someone’s own server', () => {
  it('keeps the first binder its store has, and has none to keep when new', async () => {
    const kv = new MemoryKV()
    assert.equal(await firstSpaceIn(kv), undefined)
    await kv.set('spaces', JSON.stringify([
      { id: '~sam', name: 'Notes', createdAt: '', createdBy: 'sam', members: [], personal: 'sam' },
      { id: 'harbor', name: 'Harbor', createdAt: '', createdBy: 'hub', members: [] },
      { id: 'mobile', name: 'Mobile', createdAt: '', createdBy: 'sam', members: [] },
    ]))
    assert.equal(await firstSpaceIn(kv), 'harbor')
  })

  it('believes forwarded addresses only from proxies on the machine or a private network', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:10.0.0.4', '172.18.0.3', '192.168.1.9', 'fd12:3456::1', 'fe80::1']) assert.ok(nearby(a), a)
    for (const a of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:db8::1', undefined]) assert.ok(!nearby(a), String(a))
  })
})

describe('who may take a ready card', () => {
  it('matches an agent’s repos to the binder’s whatever their case, and a card meant for an agent to it alone', async () => {
    const { mayTake } = await import('../../shared/work.ts')
    const state = { binders: [{ id: 'b1', repo: 'acme/Provisioning' }] }
    const agent = { id: 'a1', binders: [], repos: ['Acme/provisioning'] }
    assert.ok(mayTake(state, agent, { binderId: 'b1' }))
    assert.ok(!mayTake(state, { ...agent, repos: ['acme/other'] }, { binderId: 'b1' }))
    assert.ok(mayTake(state, { ...agent, repos: ['acme/other'] }, { binderId: 'b1', meantFor: 'a1' }), 'meant for it, wherever it works')
    assert.ok(!mayTake(state, agent, { binderId: 'b1', meantFor: 'a2' }))
  })
})

describe('cards waiting on others', () => {
  it('aren’t held up by a wait for a card that isn’t on the board', async () => {
    const { nextFor } = await import('../../shared/work.ts')
    const base = { binderId: 'b1', brief: '', doneWhen: '', size: 'S' as const, createdAt: '2026-11-01', createdBy: 'you', updatedAt: '2026-11-01', activity: [] }
    const state = { binders: [{ id: 'b1' }], cards: [
      { ...base, id: 'a', title: 'First', stage: 'ready' as const, waitsFor: ['Set up the bucket'] },
      { ...base, id: 'b', title: 'Second', stage: 'ready' as const, waitsFor: ['c'] },
      { ...base, id: 'c', title: 'Third', stage: 'working' as const, waitsFor: [] },
    ] }
    const agent = { id: 'a1', name: 'Test', provider: 'claude' as const, owner: 'you', repos: [], binders: [], skills: [], createdAt: '' }
    assert.equal(nextFor(state as never, agent as never)?.id, 'a', 'a wait naming no card holds nothing up')
    assert.equal(nextFor({ ...state, cards: state.cards.slice(1) } as never, agent as never), undefined, 'one for a card still being worked does')
  })
})

describe('agents and repos, whatever their capitals', () => {
  it('means the live agent by a name: the one written so, then in other capitals, and never a revoked one', async () => {
    const { agentNamed } = await import('../../shared/work.ts')
    const old = { id: 'a1', name: 'test', revoked: true }
    const now = { id: 'a2', name: 'Test' }
    assert.equal(agentNamed([old, now], 'test')?.id, 'a2', 'not the revoked one written the same')
    assert.equal(agentNamed([old, now], ' TEST ')?.id, 'a2')
    assert.equal(agentNamed([old], 'test'), undefined)
    assert.equal(agentNamed([{ id: 'a3', name: 'test' }, now], 'Test')?.id, 'a2', 'written so first')
  })

  it('opens a card meant for an agent that’s gone, so it isn’t stuck behind a revoked name', async () => {
    const { applyWork, emptyWork, mayTake, meantForNow, nextFor } = await import('../../shared/work.ts')
    const card = { id: 'c1', binderId: 'b1', title: 'Work', brief: '', doneWhen: '', size: 'S' as const, stage: 'ready' as const, createdAt: '2026-11-01', createdBy: 'you', updatedAt: '2026-11-01', waitsFor: [], activity: [], meantFor: 'a1' }
    const agents = [{ id: 'a1', name: 'test', provider: 'claude' as const, owner: 'you', repos: [], binders: [], skills: [], createdAt: '', revoked: true }, { id: 'a2', name: 'Test', provider: 'claude' as const, owner: 'you', repos: [], binders: [], skills: [], createdAt: '' }]
    const state = { ...emptyWork(), binders: [{ id: 'b1' }], agents, cards: [card] }
    assert.equal(meantForNow(state, card), undefined)
    assert.ok(mayTake(state, agents[1], card))
    assert.equal(nextFor(state as never, agents[1] as never)?.id, 'c1')
    const claimed = applyWork(state as never, { type: 'card.claim', id: 'c1', agentId: 'a2', at: '2026-11-01' } as never) as unknown as { cards: { agentId?: string; stage: string }[] }
    assert.equal(claimed.cards[0].agentId, 'a2', 'and the hub lets it be claimed')
    const live = { ...state, agents: [{ ...agents[0], revoked: false }, agents[1]] }
    assert.ok(!mayTake(live, agents[1], card), 'meant for a live agent, it stays that agent’s')
  })

  it('keeps one pull request when GitHub writes its repo in other capitals', async () => {
    const { Hub } = await import('../src/hub.ts')
    const { MemoryLog } = await import('../src/log.ts')
    const { Actions } = await import('../src/actions.ts')
    const { Webhooks } = await import('../src/webhooks.ts')
    const { GitHubConnection } = await import('../src/githubConnection.ts')
    const { Sealer } = await import('../src/secrets.ts')
    const hub = new Hub(new MemoryLog())
    await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'Web', repo: 'acme/web' } }])
    const actions = new Actions(hub, new GitHubConnection(new MemoryKV(), new Sealer('x'), { webUrl: 'http://unused', apiUrl: 'http://unused' }))
    const card = await actions.createCard({ kind: 'user', login: 'you' }, { binderId: 'b1', title: 'A page' })
    const linked = await actions.linkPull('acme/web', 7, { cardId: card.id })
    assert.equal((await actions.linkPull('ACME/Web', 7, {})).id, linked.id, 'linked again in other capitals')
    await new Webhooks(hub, actions).handle('pull_request', { action: 'synchronize', pull_request: { number: 7, title: 'A page', body: '', state: 'open', merged: false, html_url: 'https://github.com/Acme/Web/pull/7', head: { ref: 'b', sha: 'abc' } }, repository: { full_name: 'Acme/Web' } })
    assert.equal(hub.state.pulls.length, 1)
    assert.equal(hub.state.pulls[0].id, linked.id)
    assert.equal(hub.state.pulls[0].head, 'abc', 'what GitHub said reached it')
    assert.equal(hub.state.changeSets.filter((s) => s.prIds.includes(linked.id)).length, 1)
  })

  it('won’t have two live agents whose names differ only by capitals, but lets one change its own', async () => {
    const { Hub } = await import('../src/hub.ts')
    const { MemoryLog } = await import('../src/log.ts')
    const { Actions } = await import('../src/actions.ts')
    const { GitHubConnection } = await import('../src/githubConnection.ts')
    const { Sealer } = await import('../src/secrets.ts')
    const hub = new Hub(new MemoryLog())
    await hub.start([])
    const actions = new Actions(hub, new GitHubConnection(new MemoryKV(), new Sealer('x'), { webUrl: 'http://unused', apiUrl: 'http://unused' }))
    const made = await actions.putAgent('you', { name: 'test' })
    await assert.rejects(actions.putAgent('you', { name: 'Test' }), /an agent called test already/)
    assert.equal((await actions.putAgent('you', { name: 'Test' }, made.id)).name, 'Test')
  })
})

describe('which pull request a Challenge finding is in', () => {
  const pulls = [{ id: 'Acme/Web#7', repo: 'Acme/Web', number: 7 }, { id: 'Acme/Api#8', repo: 'Acme/Api', number: 8 }]
  const paths = ['Acme/Web#7: src/page.ts', 'Acme/Web#7: src/shared.ts', 'Acme/Api#8: src/shared.ts', 'Acme/Api#8: routes/plans.ts']
  const said = async (file: string) => (await import('../../shared/changeSet.ts')).findingPull(file, pulls, paths)

  it('reads it however a reviewer writes it', async () => {
    for (const file of ['Acme/Web#7: src/page.ts', 'acme/web#7: src/page.ts', 'web#7: src/page.ts', 'acme/web#7:src/page.ts', '`acme/web#7: src/page.ts`', 'https://github.com/Acme/Web/pull/7: src/page.ts', 'src/page.ts', 'b/src/page.ts', './src/page.ts', 'SRC/page.ts', '/Users/me/.binders/worktrees/web-c1/src/page.ts']) {
      const found = await said(file)
      assert.equal(found.pull, 'Acme/Web#7', file)
      assert.equal(found.path, 'src/page.ts', file)
    }
    assert.equal((await said('acme/web#7: lib/outside.ts')).pull, 'Acme/Web#7', 'a file outside the diff, its pull request named')
  })

  it('doesn’t guess: a file two changed, or none did, names what could be meant', async () => {
    assert.deepEqual(await said('src/shared.ts'), { path: 'src/shared.ts', among: ['Acme/Web#7', 'Acme/Api#8'] })
    assert.deepEqual(await said('lib/outside.ts'), { path: 'lib/outside.ts', among: [] })
  })
})
