import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import { fakeGitHub, seed } from './helpers.ts'

// The repo and people pickers' routes against a stand-in GitHub: a binder with its own app on the organization acme,
// run by ana, with bo as a member. Repos found by topic and custom property come from the list the hub keeps.

// As GitHub gives them to an installation.
const web = { full_name: 'acme/web', private: false, description: 'The site', archived: false, topics: ['frontend'], custom_properties: { team: 'growth' } }
const api = { full_name: 'acme/api', private: true, description: null, archived: false, topics: ['backend', 'go'], custom_properties: { team: 'payments', regions: ['eu', 'us'] } }
const docs = { full_name: 'acme/docs', private: false, description: null, archived: false, topics: ['backend'], custom_properties: { team: null } }
const old = { full_name: 'acme/old', private: false, description: null, archived: true, topics: ['backend'], custom_properties: {} }
const secret = { full_name: 'acme/secret', private: true, description: null, archived: false, topics: ['acquisition'], custom_properties: { team: 'legal' } }

// As GitHub gives them to a person: with what they may do, and no custom properties.
const theirs = (repo: Record<string, unknown>, permissions: Record<string, boolean>) => {
  const { custom_properties: _, ...rest } = repo
  return { ...rest, permissions }
}

async function setUp(installed: Record<string, unknown>[] = [web, api, docs, old, secret]) {
  const github = await fakeGitHub({ installations: { 7: 'acme' } })
  github.world.installed = installed
  github.world.mine = {
    gho_bo: [theirs(web, { push: true }), theirs(api, { admin: true }), theirs(docs, { pull: true }), theirs(old, { push: true })],
    gho_ana: [],
  }
  github.world.access = { 'acme/docs': 'read' }
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const connection = new GitHubConnection(new MemoryKV(), sealer, { webUrl: github.url, apiUrl: github.url }, {}, 'team', undefined, { pauseMs: 0, retryMs: 60_000 })
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const actions = new Actions(hub, connection)
  const spaces = Spaces.of(kv, [{ info: { id: 'team', name: 'Team', members: [{ login: 'ana', role: 'owner' }, { login: 'bo', role: 'member' }] }, space: { id: 'team', hub, actions, webhooks: new Webhooks(hub, actions), github: connection } }])
  const { action } = await connection.startCreating('ana', true, 'https://hub.test', { org: 'acme' })
  await connection.finishCreating('made', new URL(action).searchParams.get('state')!)
  await connection.installed(7)
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => false })
  const app = await buildServer(spaces, { auth }, { publicUrl: 'https://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  // Signed in as a person, with the token their GitHub sign-in left (null: no GitHub connected here).
  const as = async (who: string, token: string | null = `gho_${who}`) => {
    const { id } = await auth.startSession({ login: who, name: who }, token ?? undefined, 'team')
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie: `binders_session=${id}`, 'x-binders': '1', 'x-binders-space': 'team', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: response.status, body: (await response.json()) as any }
    }
  }
  const close = async () => { await app.close(); await github.close() }
  opened.push(close)
  return { github, hub, connection, as, close }
}

// Closed after each test, though it failed before closing them itself.
const opened: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of opened.splice(0)) await close().catch(() => undefined) })

const names = (body: { repos: { fullName: string }[] }) => body.repos.map((r) => r.fullName)
const row = (body: { repos: { fullName: string; linkable?: boolean; why?: string; topics: string[]; properties: Record<string, string[]> }[] }, name: string) => body.repos.find((r) => r.fullName === name)!

describe('finding repos for the picker', () => {
  it('filters the repos the app reaches by topic', async () => {
    const { as, close } = await setUp()
    const bo = await as('bo')
    const { status, body } = await bo('GET', '/api/github/repos?topic=backend')
    assert.equal(status, 200)
    assert.deepEqual(names(body), ['acme/api', 'acme/docs', 'acme/old'])
    assert.equal(body.total, 3)
    await close()
  })

  it('filters them by a custom property, given as a string or a list', async () => {
    const { as, close } = await setUp()
    const bo = await as('bo')
    assert.deepEqual(names((await bo('GET', '/api/github/repos?property=team&value=growth')).body), ['acme/web'])
    assert.deepEqual(names((await bo('GET', '/api/github/repos?property=regions&value=us')).body), ['acme/api'])
    await close()
  })

  it('finds a repo by what’s typed, in its topics and properties too', async () => {
    const { as, close } = await setUp()
    const bo = await as('bo')
    assert.deepEqual(names((await bo('GET', '/api/github/repos?q=payments')).body), ['acme/api'])
    assert.deepEqual(names((await bo('GET', '/api/github/repos?q=frontend')).body), ['acme/web'])
    await close()
  })

  it('offers what can be chosen, with how many each gives', async () => {
    const { as, close } = await setUp()
    const bo = await as('bo')
    const { body } = await bo('GET', '/api/github/repos')
    assert.deepEqual(body.topics, [{ name: 'backend', count: 3 }, { name: 'frontend', count: 1 }, { name: 'go', count: 1 }])
    assert.deepEqual(body.properties, [
      { name: 'regions', values: [{ value: 'eu', count: 1 }, { value: 'us', count: 1 }] },
      { name: 'team', values: [{ value: 'growth', count: 1 }, { value: 'payments', count: 1 }] },
    ])
    await close()
  })

  it('takes a filter given twice without failing', async () => {
    const { as, close } = await setUp()
    const bo = await as('bo')
    assert.equal((await bo('GET', '/api/github/repos?topic=backend&topic=go&q=a&q=b')).status, 200)
    await close()
  })

  it('sends the first fifty and says how many more match', async () => {
    const { as, close } = await setUp(Array.from({ length: 512 }, (_, n) => ({ ...web, full_name: `acme/r${n}` })))
    const bo = await as('bo')
    const { body } = await bo('GET', '/api/github/repos')
    assert.equal(body.repos.length, 50)
    assert.equal(body.total, 512)
    assert.equal(body.more, 462)
    await close()
  })

  it('reads the app’s list from GitHub once, however often the picker asks', async () => {
    const { github, as, close } = await setUp()
    const bo = await as('bo')
    await bo('GET', '/api/github/repos')
    await bo('GET', '/api/github/repos?q=web')
    await bo('GET', '/api/github/repos?topic=backend')
    assert.equal(github.calls.filter((c) => c.path === '/installation/repositories').length, 1)
    await close()
  })
})

describe('an agent’s repos, among its binder’s', () => {
  it('offers only the binder’s repos, with their filters counted among them alone', async () => {
    const { hub, as, close } = await setUp()
    await hub.submit('ana', 'tab-one', [{ id: 'x1', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repos: ['acme/api', 'acme/docs', 'acme/handmade'] } } }])
    const bo = await as('bo')
    const { body } = await bo('GET', '/api/github/repos?binders=b1')
    assert.deepEqual(names(body).sort(), ['acme/api', 'acme/docs', 'acme/handmade'])
    assert.deepEqual(body.topics.map((t: { name: string }) => t.name), ['backend', 'go'])
    assert.deepEqual(names((await bo('GET', '/api/github/repos?binders=b1&topic=go')).body), ['acme/api'])
    await close()
  })
})

describe('what a person sees of a repo in the picker', () => {
  it('keeps a private repo’s topics and properties from someone GitHub doesn’t list it for', async () => {
    const { as, close } = await setUp()
    const bo = await as('bo')
    const { body } = await bo('GET', '/api/github/repos')
    assert.deepEqual(row(body, 'acme/secret').topics, [])
    assert.deepEqual(row(body, 'acme/secret').properties, {})
    assert.ok(!body.topics.some((t: { name: string }) => t.name === 'acquisition'))
    assert.ok(!body.properties.find((p: { name: string }) => p.name === 'team').values.some((v: { value: string }) => v.value === 'legal'))
    assert.deepEqual(names((await bo('GET', '/api/github/repos?topic=acquisition')).body), [])
    assert.deepEqual(names((await bo('GET', '/api/github/repos?q=legal')).body), [])
    await close()
  })

  it('shows a private repo’s topics to someone GitHub lists it for, and to whoever runs the binder’s GitHub', async () => {
    const { as, close } = await setUp()
    assert.deepEqual(row((await (await as('bo'))('GET', '/api/github/repos')).body, 'acme/api').topics, ['backend', 'go'])
    assert.deepEqual(names((await (await as('ana'))('GET', '/api/github/repos?topic=acquisition')).body), ['acme/secret'])
    await close()
  })

  it('shows them on the repos the binder named itself', async () => {
    const { hub, as, close } = await setUp()
    await hub.submit('ana', 'tab-one', [{ id: 'x1', change: { type: 'binder.put', binder: { id: 'b1', name: 'Server', repos: ['acme/secret'] } } }])
    assert.deepEqual(names((await (await as('bo'))('GET', '/api/github/repos?topic=acquisition')).body), ['acme/secret'])
    await close()
  })
})

describe('which repos the picker offers to link', () => {
  it('says so for an agent, by what GitHub says the person can do', async () => {
    const { as, close } = await setUp()
    const { body } = await (await as('bo'))('GET', '/api/github/repos')
    assert.equal(row(body, 'acme/web').linkable, true)
    assert.equal(row(body, 'acme/docs').linkable, false)
    assert.ok(row(body, 'acme/docs').why)
    assert.equal(row(body, 'acme/old').linkable, false)
    assert.equal(row(body, 'acme/secret').linkable, undefined, 'GitHub didn’t list it, so linking asks')
    await close()
  })

  it('offers those who run the binder any repo its app reaches, for the binder’s own repo, but not for an agent’s', async () => {
    const { as, close } = await setUp()
    const ana = await as('ana')
    const { body } = await ana('GET', '/api/github/repos?for=binder')
    assert.equal(row(body, 'acme/secret').linkable, true)
    assert.equal(row(body, 'acme/old').linkable, false, 'archived, whoever asks')
    assert.equal(row((await ana('GET', '/api/github/repos')).body, 'acme/secret').linkable, undefined)
    await close()
  })

  it('refuses someone with no GitHub connected, and says why', async () => {
    const { as, close } = await setUp()
    const { body } = await (await as('bo', null))('GET', '/api/github/repos')
    assert.equal(row(body, 'acme/web').linkable, false)
    assert.ok(row(body, 'acme/web').why)
    await close()
  })
})

describe('adding every match at once', () => {
  it('names every match not known to be refused', async () => {
    const { as, close } = await setUp()
    const { body } = await (await as('bo'))('GET', '/api/github/repos?topic=backend&all=1')
    assert.deepEqual(body.names, ['acme/api'])
    assert.equal(body.total, 3)
    await close()
  })

  it('checks them as saving will, a few at a time, and says which can’t be linked and why', async () => {
    const { github, as, close } = await setUp()
    github.world.accessPause = 15
    github.world.access = { 'acme/r9': 'read', 'acme/r11': 'none' }
    const many = Array.from({ length: 14 }, (_, n) => `acme/r${n}`)
    const { status, body } = await (await as('bo'))('POST', '/api/github/repos/check', { repos: many })
    assert.equal(status, 200)
    assert.deepEqual(body.ok, many.filter((r) => r !== 'acme/r9' && r !== 'acme/r11'))
    assert.deepEqual(body.refused.map((r: { repo: string }) => r.repo).sort(), ['acme/r11', 'acme/r9'])
    assert.equal(body.refused.find((r: { repo: string }) => r.repo === 'acme/r9').why, 'you can only read it')
    assert.equal(body.refused.find((r: { repo: string }) => r.repo === 'acme/r11').why, 'GitHub doesn’t let you reach it')
    assert.ok(github.world.accessPeak > 1 && github.world.accessPeak <= 8, `asked ${github.world.accessPeak} at once`)
    await close()
  })

  it('links many to an agent a few at a time, and refuses them all for one that can’t be linked, naming it', async () => {
    const { github, as, close } = await setUp()
    github.world.accessPause = 15
    github.world.access = {}
    const many = Array.from({ length: 14 }, (_, n) => `acme/r${n}`)
    const bo = await as('bo')
    const made = await bo('POST', '/api/agents', { name: 'Bulk', repos: many })
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.ok(github.world.accessPeak > 1 && github.world.accessPeak <= 8)
    // One GitHub hasn't been asked about yet: what it said of the others is kept a couple of minutes.
    github.world.access['acme/r99'] = 'read'
    const refused = await bo('POST', '/api/agents', { name: 'Bulk two', repos: many.map((r) => `${r}x`).concat('acme/r99') })
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /acme\/r99/)
    await close()
  })
})

describe('when GitHub doesn’t answer the picker', () => {
  it('says so rather than showing no repos, and reads it again when asked to', async () => {
    const { github, as, close } = await setUp()
    github.world.installedFailsOn = 1
    const bo = await as('bo')
    const first = await bo('GET', '/api/github/repos')
    assert.equal(first.status, 200)
    assert.equal(first.body.failed, true)
    assert.deepEqual(first.body.repos, [])
    github.world.installedFailsOn = 0
    const again = await bo('GET', '/api/github/repos?again=1')
    assert.equal(again.body.failed, undefined)
    assert.equal(again.body.total, 5)
    await close()
  })

  it('keeps what GitHub gave before a later page failed, and says the list is short', async () => {
    const { github, as, close } = await setUp(Array.from({ length: 150 }, (_, n) => ({ ...web, full_name: `acme/r${n}` })))
    github.world.installedFailsOn = 2
    const { body } = await (await as('bo'))('GET', '/api/github/repos')
    assert.equal(body.failed, true)
    assert.equal(body.total, 100)
    await close()
  })
})

describe('custom properties the list doesn’t carry', () => {
  const bare = (repo: Record<string, unknown>) => {
    const { custom_properties: _, ...rest } = repo
    return rest
  }

  it('come from the organization’s own list of them, when GitHub gives the app that', async () => {
    const { github, connection, as, close } = await setUp([bare(web), bare(api)])
    github.world.orgProperties = [
      { repository_full_name: 'acme/api', properties: [{ property_name: 'team', value: 'payments' }, { property_name: 'tier', value: null }] },
    ]
    const ana = await as('ana')
    await ana('GET', '/api/github/repos')
    await until(async () => (await ana('GET', '/api/github/lists')).body.installations[0].properties === 'organization')
    assert.deepEqual(names((await ana('GET', '/api/github/repos?property=team&value=payments')).body), ['acme/api'])
    assert.ok(connection)
    await close()
  })

  it('say so when GitHub won’t give them, so Settings can say which permission it takes', async () => {
    const { as, close } = await setUp([bare(web), bare(api)])
    const ana = await as('ana')
    await ana('GET', '/api/github/repos')
    await until(async () => (await ana('GET', '/api/github/lists')).body.installations[0].properties === 'denied')
    const { body } = await ana('GET', '/api/github/lists')
    assert.equal(body.installations[0].account, 'acme')
    assert.equal(body.installations[0].indexed, 2)
    assert.equal(body.installations[0].complete, true)
    assert.match(body.permissionsUrl, /settings\/apps\/.+\/permissions$/)
    await close()
  })

  it('are asked for when the list carries them all empty, as it may for an app that can’t see them', async () => {
    const { github, as, close } = await setUp([{ ...web, custom_properties: {} }, { ...api, custom_properties: {} }])
    github.world.orgProperties = [{ repository_full_name: 'acme/web', properties: [{ property_name: 'team', value: 'growth' }] }]
    const ana = await as('ana')
    await ana('GET', '/api/github/repos')
    await until(async () => (await ana('GET', '/api/github/lists')).body.installations[0].properties === 'organization')
    assert.deepEqual(names((await ana('GET', '/api/github/repos?property=team&value=growth')).body), ['acme/web'])
    await close()
  })

  it('aren’t asked for when the list carries them', async () => {
    const { github, as, close } = await setUp()
    const ana = await as('ana')
    await ana('GET', '/api/github/repos')
    await until(async () => (await ana('GET', '/api/github/lists')).body.installations[0].properties === 'listed')
    assert.equal(github.calls.filter((c) => c.path.endsWith('/properties/values')).length, 0)
    await close()
  })
})

describe('people to suggest, from an organization of thousands', () => {
  it('reads its members once into the hub’s list, and finds someone as their login is typed', async () => {
    const { github, as, close } = await setUp()
    github.world.members = Array.from({ length: 2500 }, (_, n) => ({ login: `person-${n}` }))
    const ana = await as('ana')
    await ana('GET', '/api/github/people?kind=user&q=')
    await until(async () => (await ana('GET', '/api/github/people?kind=user&q=person-2499')).body.people[0]?.login === 'person-2499')
    const { body } = await ana('GET', '/api/github/people?kind=user&q=person-2499')
    assert.equal(body.people[0].why, 'In acme')
    assert.equal(body.reading, undefined)
    await ana('GET', '/api/github/people?kind=user&q=person-1')
    // Twenty-five pages of a hundred, and the empty one after that says it's all.
    assert.equal(github.calls.filter((c) => c.path === '/orgs/acme/members').length, 26)
    await close()
  })

  it('follows GitHub’s word of someone joining and leaving', async () => {
    const { connection, as, close } = await setUp()
    const ana = await as('ana')
    await ana('GET', '/api/github/people?kind=user&q=')
    await until(async () => (await ana('GET', '/api/github/people?kind=user&q=ben')).body.people.length === 1)
    await connection.heardOrganization({ action: 'member_added', installation: { id: 7 }, membership: { user: { login: 'cyd' } } })
    await connection.heardOrganization({ action: 'member_removed', installation: { id: 7 }, membership: { user: { login: 'ben' } } })
    const logins = (await ana('GET', '/api/github/people?kind=user&q=')).body.people.map((p: { login: string }) => p.login)
    assert.ok(logins.includes('cyd'))
    assert.ok(!logins.includes('ben'))
    await close()
  })
})

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error('Timed out waiting')
}
