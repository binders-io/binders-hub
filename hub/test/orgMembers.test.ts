import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { orgMembers } from '../src/routes/github.ts'
import { deprovisioned } from '../../shared/people.ts'

describe('an organization of managed users, to suggest people from', () => {
  it('reads every page of its members, and leaves out the accounts of people who left', async () => {
    // GitHub lists members by login: 150 deprovisioned hashes first, then the people who are there.
    const all = [
      ...Array.from({ length: 150 }, (_, i) => ({ login: `${(0x1000000000000000 + i).toString(16)}_acme` })),
      { login: 'ana_acme' }, { login: 'ben_acme' },
    ]
    const asked: string[] = []
    const client = { get: async <T>(path: string) => {
      asked.push(path)
      const page = Number(new URL(path, 'https://api.github.test').searchParams.get('page'))
      return all.slice((page - 1) * 100, page * 100) as T
    } }
    assert.deepEqual((await orgMembers(client, 'acme')).map((m) => m.login), ['ana_acme', 'ben_acme'])
    assert.equal(asked.length, 2)
  })

  it('knows a deprovisioned login by its hash, not by an underscore alone', () => {
    assert.ok(deprovisioned('3f9a1c0b7d2e4a65_acme'))
    for (const login of ['jdoe_acme', 'cafe_acme', 'octocat', 'deadbeef_acme']) assert.ok(!deprovisioned(login), login)
  })
})

describe('people to add in an organization of managed users', () => {
  it('knows the organization is one by its members’ logins, its setup account aside', async () => {
    const { managedShortcode } = await import('../src/routes/github.ts')
    assert.equal(managedShortcode(['ana_acme', 'ben_acme', 'cy_acme', 'dee_acme', 'acme_admin']), 'acme')
    assert.equal(managedShortcode(['ana', 'ben', 'cy']), undefined)
    assert.equal(managedShortcode([]), undefined)
  })
})
