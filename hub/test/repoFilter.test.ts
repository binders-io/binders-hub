import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterRepos, linkOf, propertiesOf, topicsOf, type Link } from '../src/repoFilter.ts'
import type { IndexedRepo } from '../src/repoIndex.ts'

type Repo = IndexedRepo & Link & { push?: boolean }
const repo = (fullName: string, over: Partial<Repo> = {}): Repo => ({ fullName, private: false, ...over })
const names = (repos: { fullName: string }[]) => repos.map((r) => r.fullName)
/** Whether each can be linked, as the repo itself says, for the order. */
const asSaid = (r: Repo): Link => ({ linkable: r.linkable, why: r.why })

describe('what GitHub says of a repo', () => {
  it('keeps a custom property however GitHub gives its value', () => {
    assert.deepEqual(
      propertiesOf({ team: 'payments', regions: ['eu', 'us'], unset: null, count: 3, mixed: ['a', 4], none: [] }),
      { team: ['payments'], regions: ['eu', 'us'], mixed: ['a'] },
    )
  })

  it('has no properties for a repo GitHub gave none for', () => {
    for (const nothing of [undefined, null, 'team', []]) assert.deepEqual(propertiesOf(nothing), {})
  })

  it('keeps only the topics that are words', () => {
    assert.deepEqual(topicsOf(['backend', 3, '', null]), ['backend'])
    assert.deepEqual(topicsOf(undefined), [])
  })
})

describe('finding repos', () => {
  it('ranks the exact name, then its start, then inside the name, then the rest, the shorter first', () => {
    const repos = [
      repo('acme/docs', { description: 'The API docs' }),
      repo('acme/public-api'),
      repo('acme/api-gateway'),
      repo('acme/web', { topics: ['api'] }),
      repo('acme/api'),
      repo('acme/unrelated'),
    ]
    assert.deepEqual(names(filterRepos(repos, { q: 'api' }).repos), ['acme/api', 'acme/api-gateway', 'acme/public-api', 'acme/web', 'acme/docs'])
  })

  it('finds a repo by its whole name, whatever the case', () => {
    assert.deepEqual(names(filterRepos([repo('acme/web'), repo('Acme/API')], { q: 'acme/api' }).repos), ['Acme/API'])
  })

  it('finds a repo by a topic or a property’s value', () => {
    const repos = [repo('acme/a', { topics: ['payments'] }), repo('acme/b', { properties: { team: ['payments'] } }), repo('acme/c')]
    assert.deepEqual(names(filterRepos(repos, { q: 'PAYMENTS' }).repos), ['acme/a', 'acme/b'])
  })

  it('puts what can be linked first, and what’s archived last', () => {
    const repos = [
      repo('acme/old', { archived: true, linkable: false }),
      repo('acme/read', { linkable: false }),
      repo('acme/unknown'),
      repo('acme/zebra', { linkable: true }),
      repo('acme/apple', { linkable: true }),
    ]
    assert.deepEqual(names(filterRepos(repos, {}, asSaid).repos), ['acme/apple', 'acme/zebra', 'acme/unknown', 'acme/read', 'acme/old'])
  })

  it('finds words in any order, in the name or what GitHub says of it', () => {
    const repos = [repo('acme/api-web'), repo('acme/billing', { topics: ['web'], description: 'Payments API' }), repo('acme/web')]
    assert.deepEqual(names(filterRepos(repos, { q: 'web api' }).repos), ['acme/api-web', 'acme/billing'])
  })

  it('says whether each match can be linked, asking only of the matches', () => {
    const asked: string[] = []
    const found = filterRepos([repo('acme/a', { topics: ['x'] }), repo('acme/b')], { topic: 'x' }, (r) => {
      asked.push(r.fullName)
      return { linkable: false, why: 'Not yours' }
    })
    assert.deepEqual(asked, ['acme/a'])
    assert.equal(found.repos[0].why, 'Not yours')
  })
})

describe('filtering repos', () => {
  const a = repo('acme/a', { topics: ['backend', 'go'], properties: { team: ['payments'] } })
  const b = repo('acme/b', { topics: ['backend'], properties: { team: ['search'] } })
  const c = repo('acme/c', { topics: ['frontend'], properties: { team: ['payments'], tier: ['1'] } })
  const repos = [a, b, c]

  it('counts each topic and each property’s values, most used first', () => {
    const found = filterRepos(repos, {})
    assert.deepEqual(found.topics, [{ name: 'backend', count: 2 }, { name: 'frontend', count: 1 }, { name: 'go', count: 1 }])
    assert.deepEqual(found.properties, [
      { name: 'team', values: [{ value: 'payments', count: 2 }, { value: 'search', count: 1 }] },
      { name: 'tier', values: [{ value: '1', count: 1 }] },
    ])
  })

  it('keeps to a topic', () => {
    assert.deepEqual(names(filterRepos(repos, { topic: 'BACKEND' }).repos), ['acme/a', 'acme/b'])
  })

  it('keeps to a property’s value, among values given as a list', () => {
    const multi = repo('acme/d', { properties: { team: ['payments', 'search'] } })
    assert.deepEqual(names(filterRepos([b, c, multi], { property: 'team', value: 'search' }).repos), ['acme/b', 'acme/d'])
  })

  it('needs a repo to match every filter', () => {
    assert.deepEqual(names(filterRepos(repos, { q: 'acme/a', topic: 'backend', property: 'team', value: 'search' }).repos), [])
    assert.deepEqual(names(filterRepos(repos, { topic: 'backend', property: 'team', value: 'search' }).repos), ['acme/b'])
  })

  it('counts topics among the repos the property leaves, and the other way round', () => {
    assert.deepEqual(filterRepos(repos, { property: 'team', value: 'search' }).topics, [{ name: 'backend', count: 1 }])
    assert.deepEqual(filterRepos(repos, { topic: 'frontend' }).properties, [
      { name: 'team', values: [{ value: 'payments', count: 1 }] },
      { name: 'tier', values: [{ value: '1', count: 1 }] },
    ])
  })

  it('still offers every topic while one is chosen, so the choice can change', () => {
    assert.deepEqual(filterRepos(repos, { topic: 'go' }).topics.map((t) => t.name), ['backend', 'frontend', 'go'])
  })

  it('keeps what’s chosen among the choices when nothing matches it any more', () => {
    const found = filterRepos(repos, { q: 'nothing', topic: 'backend', property: 'team', value: 'payments' })
    assert.deepEqual(found.topics, [{ name: 'backend', count: 0 }])
    assert.deepEqual(found.properties, [{ name: 'team', values: [{ value: 'payments', count: 0 }] }])
  })

  it('offers no filters for repos with no topics or properties', () => {
    const found = filterRepos([repo('acme/a'), repo('acme/b')], {})
    assert.deepEqual(found.topics, [])
    assert.deepEqual(found.properties, [])
  })
})

describe('whether a repo can be linked', () => {
  const person = { anyReached: false, token: true, byName: false }

  it('can’t be when it’s archived, whoever asks', () => {
    assert.equal(linkOf(repo('acme/a', { archived: true, push: true }), person).linkable, false)
    assert.equal(linkOf(repo('acme/a', { archived: true }), { ...person, anyReached: true }).linkable, false)
  })

  it('can be by someone who can push to it', () => {
    assert.equal(linkOf(repo('acme/a', { push: true }), person).linkable, true)
  })

  it('can’t be by someone who can only read it, and says so', () => {
    const link = linkOf(repo('acme/a', { push: false }), person)
    assert.equal(link.linkable, false)
    assert.ok(link.why)
  })

  it('is left for GitHub to say on linking when it didn’t list the repo as theirs', () => {
    assert.deepEqual(linkOf(repo('acme/a'), person), {})
  })

  it('can be by someone who runs the binder, for a repo its app reaches', () => {
    assert.equal(linkOf(repo('acme/a', { push: false }), { ...person, anyReached: true }).linkable, true)
  })

  it('can’t be by someone with no GitHub connected', () => {
    const link = linkOf(repo('acme/a'), { ...person, token: false })
    assert.equal(link.linkable, false)
    assert.ok(link.why)
  })

  it('can be on a hub tried out by name, with no GitHub to ask', () => {
    assert.equal(linkOf(repo('acme/a'), { ...person, token: false, byName: true }).linkable, true)
  })
})
