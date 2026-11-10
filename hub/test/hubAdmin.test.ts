import { describe, it } from 'node:test'
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
import { Spaces, type Member, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'

// The hub's admins run the hub; a Binder's owners and admins run the Binder. A Binder with no owner is looked after by the
// hub's admins until it has one, and they see every Binder and name an owner for it.

interface Other {
  id: string
  name: string
  members: Member[]
}

/** acme is the hub's first; `others` are made as the hub's saved list holds them, so they can have no owner. */
async function setUp(acme: Member[], others: Other[] = [], admins: string[] = ['root']) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const made = (id: string, name: string, members: Member[]) => ({ id, name, createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'hub', members })
  await kv.set('spaces', JSON.stringify([made('acme', 'Acme', acme), ...others.map((o) => made(o.id, o.name, o.members))]))
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start()
    // As the hub proper says who may change a locked note.
    hub.lockManager = (login) => spaces.mayManage(id, login, spaces.hubAdmin(login))
    const actions = new Actions(hub, github)
    return { id, hub, actions, github, webhooks: new Webhooks(hub, actions) }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: acme })
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string, space?: string) => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(space ? { 'x-binders-space': space } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
  }
  return { spaces, as, close: () => app.close() }
}

type Caller = Awaited<ReturnType<Awaited<ReturnType<typeof setUp>>['as']>>

const changes = (who: Caller, ...list: { type: string; [key: string]: unknown }[]) => who('POST', '/api/changes', { client: 'tab-1234', changes: list.map((change, i) => ({ id: `c${Math.random().toString(36).slice(2, 8)}${i}`, change })) })
const putBinder = (who: Caller, binder: Record<string, unknown>) => changes(who, { type: 'binder.put', binder })
const roleIn = async (who: Caller, id: string) => ((await who('GET', '/api/spaces')).body.spaces as { id: string; role: string }[]).find((s) => s.id === id)?.role
const ids = async (who: Caller) => ((await who('GET', '/api/spaces')).body.spaces as { id: string }[]).map((s) => s.id)
/** Whether an answer is the hub saying this person may not change the Binder, in any of the words it has for that. */
const turnedAway = (answer: { status: number; body?: { error?: string } }) => answer.status === 403 || (answer.status === 422 && /^(Only|No such Binder|You can read)/.test(answer.body?.error ?? ''))
const note = (id: string) => ({ type: 'note.put', note: { id, title: id, binderId: 'p1', text: 'Words.', editedAt: new Date().toISOString(), editors: [] } })
const edit = (who: Caller, id: string, text: string) => changes(who, { type: 'note.edit', id, text, title: id, by: 'x', at: new Date().toISOString() })

describe('a hub admin who isn’t in a Binder that has an owner', () => {
  it('doesn’t have it: not listed, not entered, and none of its settings are theirs', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }])
    const root = await as('root', 'acme')
    assert.ok(!(await ids(root)).includes('acme'))
    assert.deepEqual(await ids(root), ['~root'])
    const entered = await root('GET', '/api/state')
    assert.equal(entered.status, 403)
    assert.match(entered.body.error, /not in that Binder/)

    const tries: [string, string, unknown?][] = [
      ['PUT', '/api/spaces/acme/members/cy', { role: 'member' }],
      ['DELETE', '/api/spaces/acme/members/ana'],
      ['PATCH', '/api/spaces/acme', { name: 'Mine now' }],
      ['DELETE', '/api/spaces/acme', { name: 'Acme' }],
      ['POST', '/api/github/app', {}],
      ['DELETE', '/api/github/app'],
      ['PUT', '/api/jira', { baseUrl: 'https://acme.atlassian.net', project: 'ACME' }],
      ['PUT', '/api/tell', { url: 'https://hooks.example.com/x' }],
      ['PUT', '/api/folders/f1/rule', { enabled: true }],
      ['POST', '/api/environments', { repo: 'acme/web', name: 'Staging' }],
    ]
    for (const [method, path, body] of tries) assert.ok(turnedAway(await root(method, path, body)), `${method} ${path}`)
    // Where its cards and notes go, and a locked note, through the changes.
    assert.ok(turnedAway(await putBinder(root, { id: 'p1', name: 'App', repo: 'acme/app' })))
    assert.ok(turnedAway(await root('POST', '/api/notes/n1/lock', { locked: true })))
    assert.deepEqual(spaces.info('acme')!.members, [{ login: 'ana', role: 'owner' }])
    assert.equal(spaces.info('acme')!.name, 'Acme')
    await close()
  })

  it('is seen by a hub admin in the hub’s list, who names an owner for it, and the Binder’s history says so', async () => {
    const { spaces, as, close } = await setUp(
      [{ login: 'ana', role: 'owner' }, { login: 'root', role: 'reader' }],
      [{ id: 'globex', name: 'Globex', members: [{ login: 'bo', role: 'admin' }] }, { id: 'initech', name: 'Initech', members: [{ login: 'ana', role: 'owner' }, { login: 'di', role: 'admin' }, { login: 'ed', role: 'member' }] }, { id: 'open', name: 'Open', members: [] }],
    )
    // The browser is in acme, where root only reads: the hub's routes still work.
    const root = await as('root', 'acme')
    const listed = await root('GET', '/api/hub/binders')
    assert.equal(listed.status, 200)
    const view = (body: { binders: { id: string }[] }) => body.binders.map((b) => b.id)
    assert.deepEqual(view(listed.body), ['acme', 'globex', 'initech', 'open'], 'in the order they were made, with no personal one')
    const by = (id: string) => listed.body.binders.find((b: { id: string }) => b.id === id)
    const { createdAt, ...acme } = by('acme')
    assert.ok(!Number.isNaN(Date.parse(createdAt)))
    assert.deepEqual(acme, { id: 'acme', name: 'Acme', first: true, people: 2, owners: ['ana'], admins: [], yours: true })
    assert.deepEqual([by('globex').owners, by('globex').admins, by('globex').people, by('globex').yours, by('globex').first], [[], ['bo'], 1, true, undefined], 'it has no owner, so the hub’s admins can open it')
    assert.deepEqual([by('initech').owners, by('initech').admins, by('initech').people, by('initech').yours], [['ana'], ['di'], 3, false])
    assert.deepEqual([by('open').owners, by('open').people, by('open').yours], [[], 0, true], 'open to everyone, so theirs')

    // Names one for Globex, who isn't in it: a reader in the Binder their browser is in doesn't stop it.
    const named = await root('PUT', '/api/hub/binders/globex/owners/cy')
    assert.equal(named.status, 200, JSON.stringify(named.body))
    assert.deepEqual(view(named.body), ['acme', 'globex', 'initech', 'open'])
    assert.deepEqual([named.body.binders[1].owners, named.body.binders[1].admins, named.body.binders[1].people], [['cy'], ['bo'], 2], 'the same list, as it is now')
    assert.deepEqual(spaces.info('globex')!.members, [{ login: 'bo', role: 'admin' }, { login: 'cy', role: 'owner' }])
    const history = (await (await as('cy', 'globex'))('GET', '/api/history')).body.lines as { by: string; text: string }[]
    assert.deepEqual(history.map((l) => `${l.by}: ${l.text}`), ['root: @root, one of the hub’s admins, made @cy an owner of this Binder.'])

    // A Binder with an owner, and a browser in a Binder root isn't in: the hub's routes don't care which Binder it names.
    const elsewhere = await as('root', 'initech')
    assert.equal((await elsewhere('PUT', '/api/hub/binders/initech/owners/ed')).status, 200)
    assert.equal(spaces.info('initech')!.members.find((m) => m.login === 'ed')!.role, 'owner')
    // An owner already: nothing changes, and nothing more is written.
    assert.equal((await elsewhere('PUT', '/api/hub/binders/globex/owners/CY')).status, 200)
    assert.equal(((await (await as('cy', 'globex'))('GET', '/api/history')).body.lines as unknown[]).length, 1)
    // With no header at all.
    assert.equal((await (await as('root'))('GET', '/api/hub/binders')).status, 200)
    // The first owner of an open Binder is the first member.
    assert.equal((await root('PUT', '/api/hub/binders/open/owners/ed')).status, 200)
    assert.deepEqual(spaces.info('open')!.members, [{ login: 'ed', role: 'owner' }])
    await close()
  })

  it('refuses a personal Binder, one that isn’t there and a login that isn’t one, in words', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }])
    await (await as('ana'))('GET', '/api/spaces')
    const root = await as('root', 'acme')
    const personal = await root('PUT', '/api/hub/binders/~ana/owners/root')
    assert.equal(personal.status, 422)
    assert.match(personal.body.error, /personal Binder/)
    assert.deepEqual(spaces.info('~ana')!.members, [{ login: 'ana', role: 'owner' }])
    const nowhere = await root('PUT', '/api/hub/binders/nowhere/owners/cy')
    assert.deepEqual([nowhere.status, nowhere.body.error], [422, 'No such Binder.'])
    const bad = await root('PUT', `/api/hub/binders/acme/owners/${encodeURIComponent('not a login!')}`)
    assert.equal(bad.status, 422)
    assert.match(bad.body.error, /GitHub login/)
    assert.ok(!(await root('GET', '/api/hub/binders')).body.binders.some((b: { id: string }) => b.id === '~ana'), 'no personal Binder in the list')
    await close()
  })
})

describe('the hub’s two Binder routes', () => {
  it('are refused to someone who isn’t a hub admin, an owner of that Binder or not', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }], [{ id: 'globex', name: 'Globex', members: [{ login: 'bo', role: 'admin' }] }])
    for (const login of ['ana', 'bo', 'cy']) {
      for (const space of [undefined, 'acme']) {
        const who = await as(login, space)
        const listed = await who('GET', '/api/hub/binders')
        assert.deepEqual([listed.status, listed.body.error], [422, 'Only the hub’s admins see every Binder.'], login)
        const named = await who('PUT', '/api/hub/binders/globex/owners/cy')
        assert.equal(named.status, 422, login)
        assert.match(named.body.error, /^Only the hub’s admins/)
      }
    }
    assert.deepEqual(spaces.info('globex')!.members, [{ login: 'bo', role: 'admin' }])
    await close()
  })
})

describe('a Binder with no owner', () => {
  const globex: Other = { id: 'globex', name: 'Globex', members: [{ login: 'bo', role: 'admin' }, { login: 'cy', role: 'member' }] }

  it('is looked after by a hub admin, who is its admin there and names its first owner, and not by a member', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }], [globex])
    const root = await as('root', 'globex')
    const cy = await as('cy', 'globex')
    const bo = await as('bo', 'globex')
    assert.equal(await roleIn(root, 'globex'), 'admin')
    assert.equal(await roleIn(cy, 'globex'), 'member')
    const seen = (await root('GET', '/api/spaces')).body.spaces.find((s: { id: string }) => s.id === 'globex')
    assert.ok(seen.members, 'they see who is in it')
    assert.equal((await cy('GET', '/api/spaces')).body.spaces.find((s: { id: string }) => s.id === 'globex').members, undefined)

    // A plain member changes none of its settings.
    for (const [method, path, body] of [
      ['PUT', '/api/spaces/globex/members/di', { role: 'member' }],
      ['PATCH', '/api/spaces/globex', { name: 'Mine' }],
      ['DELETE', '/api/spaces/globex', { name: 'Globex' }],
      ['POST', '/api/github/app', {}],
      ['PUT', '/api/jira', { baseUrl: 'https://acme.atlassian.net', project: 'ACME' }],
      ['PUT', '/api/tell', { url: 'https://hooks.example.com/x' }],
      ['PUT', '/api/folders/f1/rule', { enabled: true }],
      ['POST', '/api/environments', { repo: 'acme/web', name: 'Staging' }],
    ] as const) assert.equal((await cy(method, path, body)).status, 422, `${method} ${path}`)
    assert.equal((await putBinder(cy, { id: 'p1', name: 'App', repo: 'acme/app' })).status, 422)
    assert.equal(spaces.info('globex')!.name, 'Globex')

    // The hub's admin may: rename it, and make its first owner, by the Binder's own route or the hub's.
    assert.equal((await root('PATCH', '/api/spaces/globex', { name: 'Globex Corp' })).status, 200)
    assert.equal(spaces.info('globex')!.name, 'Globex Corp')
    assert.equal((await putBinder(root, { id: 'p1', name: 'App', repo: 'acme/app' })).status, 200, 'where its cards go, until the repo is checked')
    assert.equal((await root('PUT', '/api/spaces/globex/members/cy', { role: 'owner' })).status, 200)
    assert.equal(spaces.hasOwner('globex'), true)
    // Now it has an owner: the hub's admin is out of it, and its admin is its admin.
    assert.ok(!(await ids(root)).includes('globex'))
    assert.ok(turnedAway(await root('PATCH', '/api/spaces/globex', { name: 'Again' })))
    assert.equal(await roleIn(bo, 'globex'), 'admin')
    assert.equal(await roleIn(cy, 'globex'), 'owner')
    await close()
  })

  it('is, with no members at all, everyone’s as a member, and the hub admin’s as its admin, until it has an owner', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }], [{ id: 'open', name: 'Open', members: [] }])
    const root = await as('root', 'open')
    const bo = await as('bo', 'open')
    assert.equal(await roleIn(root, 'open'), 'admin')
    assert.equal(await roleIn(bo, 'open'), 'member')
    assert.equal((await bo('PATCH', '/api/spaces/open', { name: 'Mine' })).status, 422, 'a member of an open Binder can’t rename it')
    assert.equal((await putBinder(bo, { id: 'p1', name: 'App', repo: 'acme/app' })).status, 422)
    assert.equal((await root('PUT', '/api/hub/binders/open/owners/bo')).status, 200)
    assert.equal(await roleIn(bo, 'open'), 'owner')
    assert.equal(await roleIn(root, 'open'), undefined)
    assert.equal(spaces.hasOwner('open'), true)
    assert.equal((await bo('PATCH', '/api/spaces/open', { name: 'Mine' })).status, 200)
    await close()
  })

  it('is looked after by everyone on a hub where no one is named an admin, as the hub has always taken that', async () => {
    const { spaces, as, close } = await setUp([{ login: 'ana', role: 'owner' }], [globex], [])
    const zed = await as('zed', 'globex')
    assert.equal(await roleIn(zed, 'globex'), 'admin')
    assert.equal((await zed('PUT', '/api/hub/binders/globex/owners/zed')).status, 200)
    assert.equal(spaces.info('globex')!.members.find((m) => m.login === 'zed')!.role, 'owner')
    // One that has an owner isn't anyone's to look after.
    assert.ok(!(await ids(await as('who', 'acme'))).includes('acme'))
    assert.equal(await roleIn(await as('who'), 'globex'), undefined)
    await close()
  })
})

describe('a locked note', () => {
  /** A Binder with its one binder and a note a plain member locked. */
  async function locked(set: Awaited<ReturnType<typeof setUp>>, space: string, manager: string) {
    const by = await set.as(manager, space)
    assert.equal((await putBinder(by, { id: 'p1', name: 'App' })).status, 200)
    const sam = await set.as('sam', space)
    assert.equal((await changes(sam, note('n1'))).status, 200)
    assert.equal((await sam('POST', '/api/notes/n1/lock', { locked: true })).status, 200)
    return sam
  }

  it('is changed by a hub admin who is a plain member only where the Binder has no owner, and its access says the same', async () => {
    const set = await setUp(
      [{ login: 'ana', role: 'owner' }, { login: 'sam', role: 'member' }, { login: 'root', role: 'member' }],
      [{ id: 'globex', name: 'Globex', members: [{ login: 'bo', role: 'admin' }, { login: 'sam', role: 'member' }, { login: 'root', role: 'member' }] }],
    )
    await locked(set, 'acme', 'ana')
    await locked(set, 'globex', 'bo')
    const mayChange = async (who: Caller) => ((await who('GET', '/api/notes/n1/access')).body as { mayChange: boolean }).mayChange

    // With an owner, the hub's admin is a member like any, and a locked note isn't theirs.
    const inAcme = await set.as('root', 'acme')
    assert.equal(await mayChange(inAcme), false)
    const refused = await edit(inAcme, 'n1', 'Their words.')
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /locked by @sam/)
    assert.equal(set.spaces.get('acme')!.hub.state.notes.find((n) => n.id === 'n1')!.text, 'Words.')
    assert.equal(await mayChange(await set.as('ana', 'acme')), true, 'its owner’s')

    // With none, they look after it, and it is.
    const inGlobex = await set.as('root', 'globex')
    assert.equal(await mayChange(inGlobex), true)
    assert.equal((await edit(inGlobex, 'n1', 'Their words.')).status, 200)
    assert.equal(set.spaces.get('globex')!.hub.state.notes.find((n) => n.id === 'n1')!.text, 'Their words.')
    await set.close()
  })
})
