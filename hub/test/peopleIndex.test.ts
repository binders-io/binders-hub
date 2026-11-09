import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryKV } from '../src/kv.ts'
import { PeopleIndex, managedShortcode, type Member } from '../src/peopleIndex.ts'
import { deprovisioned } from '../../shared/people.ts'

const quick = { pauseMs: 0, retryMs: 0 }

/**
 * An organization's members as GitHub lists them, a hundred a page, by login: `gone` deprovisioned hashes first (as in
 * an enterprise of managed users), then `count` people, ana_acme-0 onward. Those gone are left out as the hub does.
 */
function organization(count: number, gone = 0) {
  const all = [
    ...Array.from({ length: gone }, (_, i) => ({ login: `${(0x1000000000000000 + i).toString(16)}_acme` })),
    ...Array.from({ length: count }, (_, i) => ({ login: `ana-${i}_acme` })),
  ]
  const asked: number[] = []
  const list = async (_installation: number, page: number) => {
    asked.push(page)
    const given = all.slice((page - 1) * 100, page * 100)
    return { items: given.filter((m) => !deprovisioned(m.login)) as Member[], size: given.length }
  }
  return { list, asked }
}

describe('the people of an organization, to suggest', () => {
  it('reads every page of five thousand, and finds someone among them as their login is typed', async () => {
    const org = organization(5200)
    const index = new PeopleIndex(new MemoryKV(), org.list, quick)
    await index.ensure([1])
    await index.settled([1])
    assert.equal(org.asked.length, 53)
    const found = await index.search([1], 'ana-5199', 5)
    assert.equal(found.complete, true)
    assert.equal(found.indexed, 5200)
    assert.equal(found.people[0].login, 'ana-5199_acme')
  })

  it('goes on past pages of people who left, though none of them is suggested', async () => {
    const org = organization(2, 150)
    const index = new PeopleIndex(new MemoryKV(), org.list, quick)
    await index.ensure([1])
    await index.settled([1])
    assert.deepEqual((await index.search([1], '', 10)).people.map((p) => p.login), ['ana-0_acme', 'ana-1_acme'])
    assert.equal(org.asked.length, 2)
  })

  it('puts the login itself first, then logins that start with what’s typed, then logins that have it', async () => {
    const list = async () => ({ items: ['joanna', 'ann', 'anna', 'an', 'dan'].map((login) => ({ login })) })
    const index = new PeopleIndex(new MemoryKV(), list, quick)
    await index.ensure([1])
    await index.settled([1])
    assert.deepEqual((await index.search([1], '@AN', 10)).people.map((p) => p.login), ['an', 'ann', 'anna', 'dan', 'joanna'])
  })

  it('keeps what it read: a hub that restarts finds them without asking GitHub', async () => {
    const kv = new MemoryKV()
    const first = new PeopleIndex(kv, organization(250).list, quick)
    await first.ensure([1])
    await first.settled([1])
    const asked = organization(0)
    const again = new PeopleIndex(kv, asked.list, quick)
    await again.ensure([1])
    assert.equal((await again.search([1], 'ana-249', 1)).people[0].login, 'ana-249_acme')
    assert.deepEqual(asked.asked, [])
  })

  it('follows people joining and leaving, as GitHub says', async () => {
    const index = new PeopleIndex(new MemoryKV(), organization(3).list, quick)
    await index.ensure([1])
    await index.settled([1])
    await index.add(1, [{ login: 'newcomer_acme' }])
    await index.remove(1, ['ANA-0_acme'])
    assert.deepEqual((await index.search([1], '', 10)).people.map((p) => p.login).sort(), ['ana-1_acme', 'ana-2_acme', 'newcomer_acme'])
  })

  it('knows an organization of managed users by its members’ logins, and another one beside it as ordinary', async () => {
    const index = new PeopleIndex(new MemoryKV(), async (installation) => ({ items: installation === 1 ? [{ login: 'ana_acme' }, { login: 'ben_acme' }] : [{ login: 'cy' }] }), quick)
    await index.ensure([1, 2])
    await index.settled([1, 2])
    assert.equal((await index.search([1, 2], '', 10)).managed, 'acme')
    assert.equal((await index.search([2], '', 10)).managed, undefined)
  })
})

describe('an organization of managed users, to suggest people from', () => {
  it('knows a deprovisioned login by its hash, not by an underscore alone', () => {
    assert.ok(deprovisioned('3f9a1c0b7d2e4a65_acme'))
    for (const login of ['jdoe_acme', 'cafe_acme', 'octocat', 'deadbeef_acme']) assert.ok(!deprovisioned(login), login)
  })

  it('knows the organization is one by its members’ logins, its setup account aside', () => {
    assert.equal(managedShortcode(['ana_acme', 'ben_acme', 'cy_acme', 'dee_acme', 'acme_admin']), 'acme')
    assert.equal(managedShortcode(['ana', 'ben', 'cy']), undefined)
    assert.equal(managedShortcode([]), undefined)
  })
})
