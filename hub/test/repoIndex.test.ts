import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryKV } from '../src/kv.ts'
import { RepoIndex, type IndexedRepo } from '../src/repoIndex.ts'
import { agentRepos, binderRepos, mayTake, outsideBinders } from '../../shared/work.ts'

/** An installation of `count` repos, acme/repo-0 onward, served a hundred a page; `fail` names pages that fail. */
function organization(count: number, fail = new Set<number>()) {
  const asked: number[] = []
  const list = async (_installation: number, page: number) => {
    asked.push(page)
    if (fail.has(page)) throw new Error('GitHub is down')
    const repos: IndexedRepo[] = []
    for (let i = (page - 1) * 100; i < Math.min(count, page * 100); i++) repos.push({ fullName: `acme/repo-${i}`, private: i % 2 === 0 })
    return { repos, total: count }
  }
  return { list, asked }
}

const quick = { pauseMs: 0, retryMs: 0 }

describe('the list of repos an installation reaches', () => {
  it('keeps what GitHub says of each repo through a restart: its description, topics, properties and archiving', async () => {
    const kv = new MemoryKV()
    const repo: IndexedRepo = { fullName: 'acme/api', private: true, description: 'The API', archived: true, topics: ['backend'], properties: { team: ['payments'] } }
    const first = new RepoIndex(kv, async () => ({ repos: [repo, { fullName: 'acme/web', private: false }] }), quick)
    await first.ensure([1])
    await first.settled([1])
    const again = new RepoIndex(kv, organization(0).list, quick)
    const { items } = await again.all([1])
    assert.deepEqual(items.map((i) => i.item), [repo, { fullName: 'acme/web', private: false }])
  })

  it('answers from a list kept before it said more of each repo, and reads it again at once', async () => {
    const kv = new MemoryKV()
    await kv.set('repo-index:1', JSON.stringify({ at: new Date().toISOString(), done: true, repos: [['acme/old', 1]] }))
    let release = () => {}
    const held = new Promise<void>((done) => { release = done })
    const index = new RepoIndex(kv, async () => {
      await held
      return { repos: [{ fullName: 'acme/old', private: true, topics: ['backend'] }] }
    }, quick)
    await index.ensure([1])
    assert.deepEqual((await index.search([1], 'old', 5)).repos, [{ fullName: 'acme/old', private: true }], 'the old list answers meanwhile')
    release()
    await index.settled([1])
    assert.deepEqual((await index.search([1], 'old', 5)).repos[0].topics, ['backend'])
  })

  it('keeps what was found once the list was read through, and runs that again each time it is', async () => {
    let runs = 0
    const index = new RepoIndex(new MemoryKV(), organization(150).list, { ...quick, staleMs: 0 }, async (_installation, repos) => {
      runs++
      repos.set('acme/repo-0', { ...repos.get('acme/repo-0')!, properties: { team: ['payments'] } })
      return { properties: 'organization' }
    })
    await index.ensure([1])
    await index.settled([1])
    assert.deepEqual((await index.status(1)).meta, { properties: 'organization' })
    assert.deepEqual((await index.search([1], 'repo-0', 1)).repos[0].properties, { team: ['payments'] })
    await index.ensure([1])
    await index.settled([1])
    assert.equal(runs, 2)
  })

  it('reads every page of a large organization, and finds a repo by name among them', async () => {
    const org = organization(2345)
    const index = new RepoIndex(new MemoryKV(), org.list, quick)
    await index.ensure([1])
    await index.settled([1])
    assert.equal(org.asked.length, 24)
    const found = await index.search([1], 'repo-2344', 10)
    assert.equal(found.complete, true)
    assert.equal(found.indexed, 2345)
    assert.equal(found.total, 2345)
    assert.equal(found.repos[0].fullName, 'acme/repo-2344')
  })

  it('puts the name itself first, then names that start with what’s typed, then names that have it', async () => {
    const list = async () => ({ repos: ['acme/web-api', 'acme/api', 'acme/old-api-tools', 'acme/api-web', 'other/api'].map((fullName) => ({ fullName, private: false })) })
    const index = new RepoIndex(new MemoryKV(), list, quick)
    await index.ensure([1])
    await index.settled([1])
    assert.deepEqual((await index.search([1], 'api', 10)).repos.map((r) => r.fullName), ['acme/api', 'other/api', 'acme/api-web', 'acme/web-api', 'acme/old-api-tools'])
    assert.deepEqual((await index.search([1], 'acme/api', 10)).repos.map((r) => r.fullName), ['acme/api', 'acme/api-web'])
    assert.deepEqual((await index.search([1], 'web api', 10)).repos.map((r) => r.fullName).sort(), ['acme/api-web', 'acme/web-api'])
    assert.equal((await index.search([1], 'API', 2)).more, 3)
    // Only what may be shown counts, before the best are taken.
    assert.deepEqual((await index.search([1], 'api', 2, (name) => name.endsWith('tools'))).repos.map((r) => r.fullName), ['acme/old-api-tools'])
  })

  it('goes on from the page it stopped at when GitHub failed, after a restart', async () => {
    const kv = new MemoryKV()
    const first = organization(1050, new Set([7]))
    const index = new RepoIndex(kv, first.list, { ...quick, saveEvery: 2 })
    await index.ensure([1])
    await index.settled([1])
    const partial = await index.search([1], '', 5000)
    assert.equal(partial.complete, false)
    assert.equal(partial.indexed, 600, 'what was read before it failed is searchable')
    // A hub started again reads from the store, and asks GitHub only for what it hadn't read.
    const again = organization(1050)
    const restarted = new RepoIndex(kv, again.list, quick)
    await restarted.ensure([1])
    await restarted.settled([1])
    assert.deepEqual(again.asked, [7, 8, 9, 10, 11])
    assert.equal((await restarted.search([1], '', 5000)).indexed, 1050)
  })

  it('reads a complete list again once it’s old, answering from the old one meanwhile', async () => {
    let clock = 0
    const kv = new MemoryKV()
    let names = ['acme/one', 'acme/two']
    let release: () => void = () => {}
    let held = false
    const list = async () => {
      if (held) await new Promise<void>((done) => { release = done })
      return { repos: names.map((fullName) => ({ fullName, private: false })) }
    }
    const index = new RepoIndex(kv, list, { ...quick, staleMs: 1000, now: () => clock })
    await index.ensure([1])
    await index.settled([1])
    names = ['acme/one', 'acme/three']
    held = true
    clock = 2000
    await index.ensure([1])
    assert.deepEqual((await index.search([1], '', 10)).repos.map((r) => r.fullName), ['acme/one', 'acme/two'])
    // GitHub's word of a change while it's read again reaches the new list too.
    await index.add(1, [{ fullName: 'acme/four', private: false }])
    await index.remove(1, ['acme/three'])
    release()
    await index.settled([1])
    assert.deepEqual((await index.search([1], '', 10)).repos.map((r) => r.fullName), ['acme/one', 'acme/four'])
  })

  it('follows repos added to and removed from an installation, and forgets an uninstalled one', async () => {
    const kv = new MemoryKV()
    const index = new RepoIndex(kv, organization(3).list, quick)
    await index.ensure([1])
    await index.settled([1])
    await index.add(1, [{ fullName: 'acme/new', private: true }])
    await index.remove(1, ['ACME/repo-0'])
    const later = new RepoIndex(kv, organization(0).list, quick)
    assert.deepEqual((await later.search([1], '', 10)).repos.map((r) => r.fullName), ['acme/new', 'acme/repo-1', 'acme/repo-2'])
    await later.forget(1)
    assert.equal((await new RepoIndex(kv, organization(0).list, quick).search([1], '', 10)).indexed, 0)
  })
})

describe('a binder’s repos and its agents’', () => {
  const binders = [
    { id: 'web', name: 'Web', repo: 'acme/board', repos: ['acme/web', 'acme/api'] },
    { id: 'ops', name: 'Ops', repos: ['acme/infra'] },
    { id: 'open', name: 'Open' },
  ]

  it('lists a binder’s own repo with the ones its agents work in, once each', () => {
    assert.deepEqual(binderRepos({ repo: 'acme/web', repos: ['ACME/web', 'acme/api'] }), ['acme/web', 'acme/api'])
  })

  it('gives an agent its binders’ repos when it isn’t limited to some, and any when one of its binders names none', () => {
    assert.deepEqual(agentRepos({ repos: [], binders: ['web', 'ops'] }, binders), ['acme/board', 'acme/web', 'acme/api', 'acme/infra'])
    assert.deepEqual(agentRepos({ repos: [], binders: [] }, binders), [])
    assert.deepEqual(agentRepos({ repos: ['acme/api'], binders: ['web'] }, binders), ['acme/api'])
  })

  it('limits an agent to repos among its binders’', () => {
    assert.equal(outsideBinders(['acme/api'], { binders: ['web'] }, binders), undefined)
    assert.match(outsideBinders(['acme/api', 'acme/other'], { binders: ['web'] }, binders) ?? '', /acme\/other isn’t among its binder’s repos/)
    assert.equal(outsideBinders(['acme/other'], { binders: ['web', 'open'] }, binders), undefined, 'a binder naming none limits nothing')
  })

  it('offers an agent limited to some of a binder’s repos that binder’s cards', () => {
    const state = { binders }
    const card = { binderId: 'web' }
    assert.equal(mayTake(state, { id: 'a', binders: ['web'], repos: ['acme/api'] }, card), true)
    assert.equal(mayTake(state, { id: 'a', binders: ['web'], repos: ['acme/infra'] }, card), false)
    assert.equal(mayTake(state, { id: 'a', binders: [], repos: [] }, card), true)
  })
})
