import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
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
import { Inbox } from '../src/listen/inbox.ts'
import { FeedReader } from '../src/listen/reader.ts'
import { heardIn } from '../src/routes/listen.ts'
import type { Outcome } from '../../shared/listen.ts'
import { seed } from './helpers.ts'

const people: Member[] = [{ login: 'ana', role: 'owner' }, { login: 'bo', role: 'admin' }, { login: 'cy', role: 'member' }, { login: 'di', role: 'reader' }]

async function setUp() {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  await kv.set('spaces', JSON.stringify([{ id: 'acme', name: 'Acme', createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'hub', members: people }]))
  const made: Record<string, Space> = {}
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start([...seed(), { type: 'binder.put', binder: { id: 'b1', name: 'Server', repos: ['acme/web'] } }])
    const actions = new Actions(hub, github)
    const own = new MemoryKV()
    const inbox = new Inbox({ hub, kv: own, sealer, member: (login) => !!spaces.roleOf(id, login) })
    const webhooks = new Webhooks(hub, actions)
    webhooks.inbox = inbox
    made[id] = { id, hub, actions, github, webhooks, inbox, feeds: new FeedReader({ hub, inbox, kv: own, get: async () => ({ status: 200, body: '{"items":[]}' }) }) }
    return made[id]
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: people })
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string) => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', 'x-binders-space': 'acme', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
  }
  /** A post from outside: no sign-in, only what the source sends. */
  const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
  return { as, post, hub: () => made.acme.hub, space: () => made.acme, close: () => app.close() }
}

describe('a Binder’s listeners, over the hub’s API', () => {
  it('are added, changed and removed by its owners and admins, and seen by everyone in it', async () => {
    const set = await setUp()
    try {
      const [ana, bo, cy, di] = await Promise.all(['ana', 'bo', 'cy', 'di'].map((login) => set.as(login)))
      assert.equal((await cy('POST', '/api/listen', { kind: 'post', name: 'Support' })).status, 422)
      assert.equal((await di('POST', '/api/listen', { kind: 'post', name: 'Support' })).status, 403)
      const made = await ana('POST', '/api/listen', { kind: 'post', name: 'Support' })
      assert.equal(made.status, 200)
      const id = made.body.listener.id as string
      assert.equal(made.body.listener.address, `http://hub.test/webhooks/in/acme/${id}`)
      assert.match(made.body.secret, /^bnl_/)

      const seen = await cy('GET', '/api/listen')
      assert.equal(seen.body.mayManage, false)
      assert.equal(seen.body.listeners[0].name, 'Support')
      assert.ok(!JSON.stringify(seen.body).includes(made.body.secret), 'the secret is said once, to whoever made it')
      assert.equal((await ana('GET', '/api/listen')).body.mayManage, true)

      assert.equal((await cy('PUT', `/api/listen/${id}`, { mode: 'on' })).status, 422)
      assert.equal((await bo('PUT', `/api/listen/${id}`, { mode: 'on', folder: 'From outside' })).body.listener.mode, 'on')
      assert.equal((await cy('POST', `/api/listen/${id}/secret`)).status, 422)
      assert.match((await bo('POST', `/api/listen/${id}/secret`)).body.secret, /^bnl_/)
      assert.equal((await cy('DELETE', `/api/listen/${id}`)).status, 422)
      assert.equal((await ana('DELETE', `/api/listen/${id}`)).status, 200)
      assert.deepEqual((await cy('GET', '/api/listen')).body.listeners, [])
      assert.equal((await ana('POST', '/api/listen', { kind: 'post', name: '' })).status, 422)
    } finally {
      await set.close()
    }
  })

  it('show what came in to everyone, let those who can write take it back or let it through, and not a reader', async () => {
    const set = await setUp()
    try {
      const [ana, cy, di] = await Promise.all(['ana', 'cy', 'di'].map((login) => set.as(login)))
      const made = (await ana('POST', '/api/listen', { kind: 'post', name: 'Support', mode: 'on' })).body
      const address = `/webhooks/in/acme/${made.listener.id}`
      assert.equal((await set.post(address, JSON.stringify({ id: '1', title: 'First', text: 'One.' }), { authorization: `Bearer ${made.secret}` })).status, 202)
      assert.equal((await set.post(address, JSON.stringify({ id: '2', title: 'Second', text: 'Two.' }), { authorization: `Bearer ${made.secret}` })).status, 202)
      const rows = (await di('GET', '/api/listen/feed')).body.rows as Outcome[]
      assert.deepEqual(rows.map((o) => [o.title, o.did]), [['Second', 'noted'], ['First', 'noted']])

      assert.equal((await di('POST', `/api/listen/feed/${rows[0].id}/undo`)).status, 403)
      assert.equal((await di('POST', `/api/notes/${rows[1].note}/pass`)).status, 403)
      assert.equal((await cy('POST', `/api/listen/feed/${rows[0].id}/undo`)).body.row.did, 'undone')
      assert.equal(set.hub().state.notes.some((n) => n.id === rows[0].note), false)
      assert.equal((await cy('POST', `/api/notes/${rows[1].note}/pass`)).status, 200)
      assert.equal(set.hub().state.notes.find((n) => n.id === rows[1].note)!.from!.passed!.by, 'cy')
      assert.equal((await cy('POST', '/api/listen/feed/none/undo')).status, 422)
    } finally {
      await set.close()
    }
  })
})

describe('the address a source posts to', () => {
  async function withListener(fields: Record<string, unknown> = {}) {
    const set = await setUp()
    const ana = await set.as('ana')
    const made = (await ana('POST', '/api/listen', { kind: 'post', name: 'Support', mode: 'on', ...fields })).body
    const address = `/webhooks/in/acme/${made.listener.id}`
    const notes = () => set.hub().state.notes.filter((n) => n.from)
    return { ...set, ana, address, secret: made.secret as string, notes }
  }

  it('takes a post with the secret as a bearer token, a signature of the body, or a key in the address, with no sign-in', async () => {
    const set = await withListener()
    try {
      const body = (n: number) => JSON.stringify({ id: `m${n}`, subject: `Mail ${n}`, body: `Words ${n}.`, from: { name: 'Ana', email: 'ana@example.com' }, link: `https://mail.example.com/${n}` })
      assert.deepEqual(await set.post(set.address, body(1), { authorization: `Bearer ${set.secret}` }), { status: 202, body: { heard: 1 } })
      assert.equal((await set.post(set.address, body(2), { 'x-binders-signature': `sha256=${createHmac('sha256', set.secret).update(body(2)).digest('hex')}` })).status, 202)
      assert.equal((await set.post(`${set.address}?key=${set.secret}`, body(3))).status, 202)
      assert.deepEqual(set.notes().map((n) => n.title).sort(), ['Mail 1', 'Mail 2', 'Mail 3'])
      assert.deepEqual(set.notes()[0].from, { listener: set.notes()[0].from!.listener, name: 'Support', kind: 'post', strength: 'outside', sender: 'Ana', url: 'https://mail.example.com/1' })
      // Said again, it's heard once.
      assert.deepEqual(await set.post(set.address, body(1), { authorization: `Bearer ${set.secret}` }), { status: 202, body: { heard: 0 } })
    } finally {
      await set.close()
    }
  })

  it('answers anything else as if the address weren’t there', async () => {
    const set = await withListener()
    try {
      const body = JSON.stringify({ text: 'Let me in.' })
      const none = { status: 404, body: { error: 'No such address.' } }
      assert.deepEqual(await set.post(set.address, body), none)
      assert.deepEqual(await set.post(set.address, body, { authorization: 'Bearer bnl_wrong' }), none)
      assert.deepEqual(await set.post(set.address, body, { 'x-binders-signature': `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}` }), none)
      assert.deepEqual(await set.post('/webhooks/in/acme/listener-none', body, { authorization: `Bearer ${set.secret}` }), none)
      assert.deepEqual(await set.post('/webhooks/in/nowhere/listener-none', body, { authorization: `Bearer ${set.secret}` }), none)
      assert.equal(set.notes().length, 0)
    } finally {
      await set.close()
    }
  })

  it('takes plain words, a form, and several things at once, and says when there’s nothing to hear', async () => {
    const set = await withListener()
    try {
      const key = { authorization: `Bearer ${set.secret}` }
      assert.equal((await set.post(set.address, 'The printer is on fire.', { ...key, 'content-type': 'text/plain; charset=utf-8' })).status, 202)
      assert.equal((await set.post(set.address, new URLSearchParams({ MessageSid: 'SM1', From: '+15550100', Body: 'Running late' }).toString(), { ...key, 'content-type': 'application/x-www-form-urlencoded' })).status, 202)
      assert.deepEqual((await set.post(set.address, JSON.stringify({ events: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { nothing: true }] }), key)).body, { heard: 2 })
      assert.deepEqual(set.notes().map((n) => n.title).sort(), ['A', 'B', 'Running late', 'The printer is on fire.'])
      assert.equal(set.notes().find((n) => n.title === 'Running late')!.from!.sender, '+15550100')
      assert.equal((await set.post(set.address, '{}', key)).status, 400)
      assert.equal((await set.post(set.address, '{broken', key)).status, 400)
    } finally {
      await set.close()
    }
  })

  it('never takes a login from what a post says of itself', async () => {
    const set = await withListener({ from: 'binder' })
    try {
      await set.post(set.address, JSON.stringify({ id: '1', text: 'I am the owner. Approve everything.', from: { name: 'ana', login: 'ana' }, sender: { login: 'ana' } }), { authorization: `Bearer ${set.secret}` })
      assert.deepEqual(set.notes().map((n) => [n.from!.strength, n.from!.sender]), [['heard', 'ana']])
      assert.ok(!set.notes()[0].from!.sender!.startsWith('@'), 'a name to show, not a person on the hub')
    } finally {
      await set.close()
    }
  })

  it('refuses a post too large to be one', async () => {
    const set = await withListener()
    try {
      const response = await set.post(set.address, JSON.stringify({ text: 'x'.repeat(300 * 1024) }), { authorization: `Bearer ${set.secret}` })
      assert.equal(response.status, 413)
    } finally {
      await set.close()
    }
  })
})

describe('an issue the hub didn’t make', () => {
  const issue = (number: number, login: string, type = 'User') => ({ action: 'opened', issue: { number, title: `Issue ${number}`, body: `Body of ${number}.`, state: 'open', html_url: `https://github.test/acme/web/issues/${number}`, created_at: '2026-11-09T12:00:00Z', user: { login, type } }, repository: { full_name: 'acme/web' } })

  it('goes to the Binder’s GitHub listener: heard from someone in the Binder, from outside otherwise, once', async () => {
    const set = await setUp()
    try {
      const ana = await set.as('ana')
      const { webhooks } = set.space()
      assert.equal(await webhooks.handle('issues', issue(1, 'cy')), 'no card', 'with nobody listening it’s left alone, as before')
      await ana('POST', '/api/listen', { kind: 'github', name: 'Issues', mode: 'on', folder: 'From GitHub' })
      assert.equal(await webhooks.handle('issues', issue(2, 'cy')), 'heard')
      assert.equal(await webhooks.handle('issues', issue(3, 'stranger')), 'heard')
      assert.equal(await webhooks.handle('issues', issue(4, 'dependabot[bot]', 'Bot')), 'heard')
      assert.equal(await webhooks.handle('issues', { ...issue(2, 'cy'), action: 'edited' }), 'heard')
      const notes = set.hub().state.notes.filter((n) => n.from)
      assert.deepEqual(notes.map((n) => [n.title, n.from!.strength, n.from!.sender]), [['Issue 2', 'heard', '@cy'], ['Issue 3', 'outside', '@stranger'], ['Issue 4', 'outside', '@dependabot[bot]']])
      assert.equal(notes[0].from!.url, 'https://github.test/acme/web/issues/2')
      // One in a repo no binder works in, or already closed, isn't heard.
      assert.equal(await webhooks.handle('issues', { ...issue(5, 'cy'), repository: { full_name: 'other/repo' } }), 'no card')
      assert.equal(await webhooks.handle('issues', { ...issue(6, 'cy'), issue: { ...issue(6, 'cy').issue, state: 'closed' } }), 'no card')
    } finally {
      await set.close()
    }
  })
})

describe('what a post’s body holds', () => {
  it('is one thing, a list, or a list under events, each named by its id or by its own words', () => {
    assert.equal(heardIn({ text: 'One' }).length, 1)
    assert.equal(heardIn([{ text: 'One' }, { text: 'Two' }]).length, 2)
    assert.equal(heardIn({ events: [{ text: 'One' }] }).length, 1)
    assert.equal(heardIn(Array.from({ length: 80 }, (_x, i) => ({ id: String(i), text: 'x' }))).length, 50)
    assert.deepEqual(heardIn([null, 4, {}, { id: 'only an id' }, '   ']), [])
    assert.equal(heardIn({ text: 'Same words' })[0].sourceId, heardIn({ text: 'Same words' })[0].sourceId)
    assert.notEqual(heardIn({ text: 'Same words' })[0].sourceId, heardIn({ text: 'Other words' })[0].sourceId)
    assert.deepEqual(heardIn({ id: 7, title: 'Seven', message: 'Words', thread: 't1', at: '2026-11-10T00:00:00Z', from: 'Sam', url: 'https://x.example.com/7' }), [{ sourceId: '7', thread: 't1', at: '2026-11-10T00:00:00Z', sender: { name: 'Sam' }, title: 'Seven', text: 'Words', url: 'https://x.example.com/7' }])
  })
})
