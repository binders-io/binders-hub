import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { handleWebhook, jiraAddress, JiraConnection, stageOf } from '../src/jira.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { makeLogger } from '../src/logger.ts'
import { MemoryLog } from '../src/log.ts'
import { JiraSaver } from '../src/savers/jira.ts'
import { Webhooks } from '../src/webhooks.ts'
import { buildServer } from '../src/server.ts'
import { Spaces } from '../src/spaces.ts'
import { until } from './helpers.ts'
import type { Stage } from '../../shared/work.ts'

// Cards mirrored into Jira, and Jira talking back. The stand-in keeps to what Jira Cloud does: a stock workflow, the
// old search gone, statuses only reachable by transitions, and webhooks for anything that happens to an issue.

const actor = { kind: 'user' as const, login: 'you' }
const account = 'service-account'

interface FakeIssue {
  key: string
  summary?: string
  description?: unknown
  labels?: string[]
  project?: string
  status: string
}

async function fakeJira(options: { refuseWrites?: () => boolean; refuseSearch?: () => boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const issues = new Map<string, FakeIssue>()
  const statuses = ['To Do', 'In Progress', 'Done']
  let ids = 100
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    calls.push({ method: request.method, path: request.url.split('?')[0], body: request.body })
  })
  app.post('/rest/api/3/issue', async (request, reply) => {
    if (options.refuseWrites?.()) return reply.code(503).send({})
    const { fields } = request.body as { fields: { summary: string; description: unknown; labels: string[]; project: { key: string } } }
    let id = String(++ids)
    while (issues.has(id)) id = String(++ids)
    issues.set(id, { key: `BIND-${id}`, summary: fields.summary, description: fields.description, labels: fields.labels, project: fields.project.key, status: 'To Do' })
    return { id, key: `BIND-${id}` }
  })
  app.put('/rest/api/3/issue/:id', async (request, reply) => {
    if (options.refuseWrites?.()) return reply.code(503).send({})
    const one = issues.get((request.params as { id: string }).id)
    if (!one) return reply.code(404).send({})
    Object.assign(one, (request.body as { fields: object }).fields)
    return {}
  })
  app.get('/rest/api/3/issue/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const one = issues.get(id)
    if (!one) return reply.code(404).send({})
    return { id, key: one.key, fields: { summary: one.summary, description: one.description, status: { name: one.status } } }
  })
  app.get('/rest/api/3/issue/:id/transitions', async () => ({ transitions: statuses.map((name, i) => ({ id: String(i + 1), name, to: { name } })) }))
  app.post('/rest/api/3/issue/:id/transitions', async (request) => {
    const body = request.body as { transition: { id: string } }
    const one = issues.get((request.params as { id: string }).id)
    if (one) one.status = statuses[Number(body.transition.id) - 1]
    return {}
  })
  app.get('/rest/api/3/search', async (_request, reply) => reply.code(410).send({ errorMessages: ['This API has been removed.'] }))
  app.get('/rest/api/3/search/jql', async (request, reply) => {
    if (options.refuseSearch?.()) return reply.code(503).send({})
    const { jql } = request.query as { jql: string }
    const label = /labels = "([^"]+)"/.exec(jql)?.[1] ?? ''
    const project = /project = "([^"]+)"/.exec(jql)?.[1]
    return { issues: [...issues.entries()].filter(([, one]) => one.labels?.includes(label) && one.project === project).map(([id, one]) => ({ id, key: one.key })) }
  })
  app.get('/rest/api/3/myself', async () => ({ accountId: account, displayName: 'Binders Saver', emailAddress: 'binders@example.test' }))
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, calls, issues, close: () => app.close() }
}

async function setUp(fakeOptions: Parameters<typeof fakeJira>[0] = {}, statuses = {}) {
  const fake = await fakeJira(fakeOptions)
  const hub = new Hub(new MemoryLog())
  await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'T' } }])
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const webhooks = new Webhooks(hub, actions)
  const jira = new JiraConnection(kv, sealer, 'test')
  await jira.load()
  await jira.configure({ baseUrl: fake.url, email: 'binders@example.test', token: 'tok-ab', project: 'BIND', issueType: 'Task', statuses })
  const saver = new JiraSaver(hub, () => jira, kv, 'test', { quietMs: 5, retryMs: 10, retries: 3 })
  await saver.load()
  saver.start()
  const spaces = Spaces.of(kv, [{
    info: { id: 'test', name: 'Test', members: [{ login: 'owner', role: 'owner' }, { login: 'member', role: 'member' }] },
    space: { id: 'test', hub, actions, webhooks, github, jira, jiraIssues: saver },
  }])
  const lines: string[] = []
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['hub-admin'], logger: makeLogger({ write: (line: string) => void lines.push(line) }, 'info') })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  const card = async (id: string, stage: Stage = 'ready') => {
    const at = new Date().toISOString()
    await hub.record(actor, { type: 'card.put', card: { id, binderId: 'b1', title: 'First title', brief: 'The words.', doneWhen: 'It works.', size: 'M', stage, createdAt: at, createdBy: 'you', updatedAt: at, waitsFor: [], activity: [] } })
  }
  const edit = (id: string, fields: Record<string, unknown>) =>
    hub.record(actor, { type: 'card.update', id, fields, activity: { at: new Date().toISOString(), by: 'you', kind: 'moved', text: 'changed' } })
  const stored = (id: string) => hub.state.cards.find((c) => c.id === id)
  const someone = { accountId: 'a-person' }
  /** Someone in Jira changes the status, and Jira says so. */
  const statusChange = (id: string, status: string, user: { accountId: string } = someone) => {
    fake.issues.get(id)!.status = status
    return handleWebhook(hub, jira, saver, { webhookEvent: 'jira:issue_updated', issue: { id }, user, changelog: { items: [{ field: 'status', toString: status }] } })
  }
  const signIn = async (login: string) => {
    const response = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const sent = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await sent.text()
      return { status: sent.status, body: text ? JSON.parse(text) : undefined }
    }
  }
  return {
    hub, app, url, fake, jira, saver, kv, sealer, card, edit, stored, statusChange, signIn, lines,
    made: () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue').length,
    close: async () => { await saver.stop(); await app.close(); await fake.close() },
  }
}

type Set_ = Awaited<ReturnType<typeof setUp>>
const mirrored = (set: Set_, count = 1) => until(() => set.made() >= count, 4000)
const words = (one: FakeIssue | undefined) => JSON.stringify(one?.description)
/** Long enough for a queued write to have happened, had one been coming. */
const settled = () => sleep(40)

describe('cards in Jira', () => {
  it('makes an issue per card, with its words and a label naming it', async () => {
    const set = await setUp()
    try {
      await set.card('card-make1')
      await mirrored(set)
      const issue = set.fake.issues.get('101')!
      assert.equal(issue.summary, 'First title')
      assert.match(words(issue), /The words\./)
      assert.match(words(issue), /Done when:/)
      assert.deepEqual(issue.labels, ['binders', 'binders-card-make1'])
    } finally {
      await set.close()
    }
  })

  it('leaves proposed cards out until they’re accepted, and cards already done out altogether', async () => {
    const set = await setUp()
    try {
      await set.card('card-idea', 'proposed')
      await set.card('card-old', 'live')
      await settled()
      assert.equal(set.made(), 0)
      await set.edit('card-idea', { stage: 'ready' })
      await mirrored(set)
      assert.deepEqual(set.fake.issues.get('101')!.labels, ['binders', 'binders-card-idea'])
    } finally {
      await set.close()
    }
  })

  it('writes one edit when the typing pauses, and follows the stage', async () => {
    const set = await setUp()
    try {
      await set.card('card-move1')
      await mirrored(set)
      await settled()
      await set.edit('card-move1', { title: 'Second title' })
      await set.edit('card-move1', { title: 'Third title' })
      await until(() => set.fake.issues.get('101')!.summary === 'Third title', 4000)
      assert.equal(set.fake.calls.filter((c) => c.method === 'PUT').length, 1)

      await set.edit('card-move1', { stage: 'live' })
      await until(() => set.fake.issues.get('101')!.status === 'Done', 4000)
    } finally {
      await set.close()
    }
  })

  it('follows an agent taking a card, which is its own kind of change', async () => {
    const set = await setUp()
    try {
      await set.card('card-claim')
      await mirrored(set)
      await settled()
      await set.hub.record({ kind: 'agent', id: 'a1' }, { type: 'card.claim', id: 'card-claim', agentId: 'a1', at: new Date().toISOString() })
      assert.equal(set.stored('card-claim')?.stage, 'working')
      await until(() => set.fake.issues.get('101')!.status === 'In Progress', 4000)
    } finally {
      await set.close()
    }
  })

  it('tries a write again when Jira wouldn’t take it', async () => {
    let refusing = false
    const set = await setUp({ refuseWrites: () => refusing })
    try {
      await set.card('card-retry')
      await mirrored(set)
      await settled()
      refusing = true
      await set.edit('card-retry', { brief: 'New words.' })
      await until(() => set.fake.calls.some((c) => c.method === 'PUT'), 4000)
      assert.doesNotMatch(words(set.fake.issues.get('101')), /New words/)
      refusing = false
      await until(() => /New words/.test(words(set.fake.issues.get('101'))), 4000)
    } finally {
      await set.close()
    }
  })

  it('finds a card’s issue again when its map is lost, and never guesses when Jira won’t say', async () => {
    let refusing = false
    const set = await setUp({ refuseSearch: () => refusing })
    try {
      await set.card('card-again')
      await mirrored(set)
      await settled()
      await set.saver.stop()

      // A hub starting with nothing written down, while Jira's search is down: no second issue.
      refusing = true
      const second = new JiraSaver(set.hub, () => set.jira, new MemoryKV(), 'test', { quietMs: 5, retryMs: 10, retries: 8 })
      await second.load()
      await settled()
      assert.equal(set.made(), 1)
      assert.equal(second.cardOfIssue('101'), undefined)

      // Search back: it adopts the issue, and still makes no second one.
      refusing = false
      await until(() => second.cardOfIssue('101') === 'card-again', 4000)
      assert.equal(set.made(), 1)
      assert.equal(set.fake.calls.some((c) => c.path === '/rest/api/3/search'), false)
      await second.stop()
    } finally {
      await set.close()
    }
  })

  it('catches up when it starts, with what it missed while it was down', async () => {
    const set = await setUp()
    try {
      await set.card('card-missed')
      await mirrored(set)
      await settled()
      await set.saver.stop()
      await set.edit('card-missed', { brief: 'Changed while down.' })
      const second = new JiraSaver(set.hub, () => set.jira, set.kv, 'test', { quietMs: 5 })
      await second.load()
      await until(() => /Changed while down/.test(words(set.fake.issues.get('101'))), 4000)
      assert.equal(set.made(), 1)
      await second.stop()
    } finally {
      await set.close()
    }
  })
})

describe('Jira talking back', () => {
  it('moves nothing for an update that didn’t change the status, however far the issue lags', async () => {
    const set = await setUp()
    try {
      // A stock workflow has no review status, so the issue stays In Progress while the card is in review.
      await set.card('card-lag')
      await mirrored(set)
      await set.hub.record({ kind: 'agent', id: 'a1' }, { type: 'card.claim', id: 'card-lag', agentId: 'a1', at: new Date().toISOString() })
      await until(() => set.fake.issues.get('101')!.status === 'In Progress', 4000)
      await set.edit('card-lag', { stage: 'review' })
      await settled()
      assert.equal(set.fake.issues.get('101')!.status, 'In Progress')
      const result = await handleWebhook(set.hub, set.jira, set.saver, { webhookEvent: 'jira:issue_updated', issue: { id: '101' }, user: { accountId: 'a-person' }, changelog: { items: [{ field: 'summary' }] } })
      assert.equal(result, 'ignored')
      assert.equal(set.stored('card-lag')?.stage, 'review')
      assert.equal(set.stored('card-lag')?.agentId, 'a1')
    } finally {
      await set.close()
    }
  })

  it('knows its own transitions by who made them', async () => {
    const set = await setUp()
    try {
      await set.card('card-echo')
      await mirrored(set)
      await settled()
      await set.edit('card-echo', { stage: 'review' })
      // The hub's own earlier move comes back after the card has gone on.
      assert.equal(await set.statusChange('101', 'To Do', { accountId: account }), 'echo')
      assert.equal(set.stored('card-echo')?.stage, 'review')
    } finally {
      await set.close()
    }
  })

  it('moves the card when a person changes the status, by the board’s rules', async () => {
    const set = await setUp()
    try {
      await set.card('card-back')
      await mirrored(set)
      await settled()
      const writes = () => set.fake.calls.filter((c) => c.path.endsWith('/transitions') && c.method === 'POST').length
      const before = writes()

      // Only an agent starts work.
      assert.equal(await set.statusChange('101', 'In Progress'), 'ignored')
      assert.equal(set.stored('card-back')?.stage, 'ready')

      assert.equal(await set.statusChange('101', 'Done'), 'moved')
      assert.equal(set.stored('card-back')?.stage, 'live')
      assert(set.stored('card-back')?.activity.some((a) => a.by === 'Jira' && a.text === 'Jira moved it to Done'))
      // Jira said so: nothing to tell it back.
      await settled()
      assert.equal(writes(), before)
    } finally {
      await set.close()
    }
  })

  it('takes a card back from its agent, as moving it on the board would', async () => {
    const set = await setUp()
    try {
      await set.card('card-held')
      await mirrored(set)
      await set.hub.record({ kind: 'agent', id: 'a1' }, { type: 'card.claim', id: 'card-held', agentId: 'a1', at: new Date().toISOString() })
      await until(() => set.fake.issues.get('101')!.status === 'In Progress', 4000)
      assert.equal(await set.statusChange('101', 'To Do'), 'moved')
      assert.equal(set.stored('card-held')?.stage, 'ready')
      assert.equal(set.stored('card-held')?.agentId, undefined)
    } finally {
      await set.close()
    }
  })

  it('hears nothing about an issue it didn’t make, whatever that issue says', async () => {
    const set = await setUp()
    try {
      await set.card('card-mine')
      await mirrored(set)
      set.fake.issues.set('999', { key: 'OTHER-1', status: 'Done', labels: ['binders', 'binders-card-mine'], project: 'BIND' })
      assert.equal(await set.statusChange('999', 'Done'), 'not ours')
      assert.equal(set.stored('card-mine')?.stage, 'ready')
      const odd = await handleWebhook(set.hub, set.jira, set.saver, { webhookEvent: 'jira:issue_updated', issue: { id: '../../myself' } })
      assert.equal(odd, 'ignored')
    } finally {
      await set.close()
    }
  })

  it('lands comments as from Jira, once each, in either of Jira’s formats', async () => {
    const set = await setUp()
    try {
      await set.card('card-talk')
      await mirrored(set)
      const say = (body: unknown, created: string) => handleWebhook(set.hub, set.jira, set.saver, { webhookEvent: 'comment_created', issue: { id: '101' }, comment: { body, created, author: { displayName: 'you', accountId: 'a-person' } } })
      const document = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Red on one platform.' }] }] }
      assert.equal(await say(document, '2026-01-01T10:00:00.000Z'), 'comment')
      assert.equal(await say(document, '2026-01-01T10:00:00.000Z'), 'echo')
      assert.equal(await say('Red on one platform.', '2026-01-01T11:00:00.000Z'), 'comment')
      const comments = set.stored('card-talk')!.activity.filter((a) => a.kind === 'comment')
      assert.equal(comments.length, 2)
      // A display name is anyone's to pick: it doesn't pass for the person of that login.
      assert.equal(comments[0].by, 'you on Jira')
    } finally {
      await set.close()
    }
  })

  it('says when its issue is deleted, and doesn’t make another', async () => {
    const set = await setUp()
    try {
      await set.card('card-gone')
      await mirrored(set)
      await settled()
      set.fake.issues.delete('101')
      assert.equal(await handleWebhook(set.hub, set.jira, set.saver, { webhookEvent: 'jira:issue_deleted', issue: { id: '101', key: 'BIND-101' } }), 'deleted')
      assert(set.stored('card-gone')?.activity.some((a) => a.text === 'Its Jira issue BIND-101 was deleted.'))
      await set.edit('card-gone', { title: 'Still going' })
      await settled()
      assert.equal(set.made(), 1)
    } finally {
      await set.close()
    }
  })

  it('takes a webhook only with the binder’s secret, and keeps the secret out of the log', async () => {
    const set = await setUp()
    try {
      const secret = await set.jira.secret()
      const post = (query: string) => fetch(`${set.url}/webhooks/jira/test${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { id: '1' } }) })
      assert.equal((await post('?secret=wrong')).status, 404)
      assert.equal((await post('')).status, 404)
      assert.equal((await post(`?secret=${encodeURIComponent(secret)}`)).status, 200)
      assert.equal(set.lines.some((line) => line.includes(secret)), false)
    } finally {
      await set.close()
    }
  })

  it('reads a status by its whole name, and its own mapped status is never news', () => {
    const working = { stage: 'working' as const }
    assert.equal(stageOf('Done', {}, working), 'live')
    assert.equal(stageOf('Not Done', {}, working), undefined)
    assert.equal(stageOf('Dev Done', {}, working), undefined)
    assert.equal(stageOf('Latest', {}, working), undefined)
    assert.equal(stageOf('Ready for Test', { ready: 'Ready for Test' }, { stage: 'ready' }), undefined)
    assert.equal(stageOf('Dev Done', { review: 'Dev Done' }, working), 'review')
  })
})

describe('a binder’s Jira settings', () => {
  const settings = { baseUrl: 'https://team.atlassian.net', email: 'binders@example.test', token: 'new-token', project: 'BIND', issueType: 'Task', statuses: {} }

  it('takes Jira Cloud addresses and nothing else', () => {
    assert.equal(jiraAddress('https://team.atlassian.net/'), 'https://team.atlassian.net')
    for (const address of ['http://team.atlassian.net', 'https://169.254.169.254', 'https://localhost', 'https://team.atlassian.net.example.com', 'https://evil.example/team.atlassian.net', 'https://user@team.atlassian.net', 'https://team.atlassian.net:8443', undefined]) {
      assert.equal(jiraAddress(address), undefined, String(address))
    }
  })

  it('shows its details and its secret to owners, and only whether it’s on to everyone else', async () => {
    const set = await setUp()
    try {
      const owner = await set.signIn('owner')
      const mine = await owner('GET', '/api/jira')
      assert.equal(mine.status, 200)
      assert.equal(mine.body.mayManage, true)
      assert.equal(mine.body.hint, '…ab')
      assert.equal(mine.body.token, undefined)
      assert.match(mine.body.webhook.url, /^http:\/\/hub\.test\/webhooks\/jira\/test\?secret=/)

      const member = await set.signIn('member')
      const theirs = await member('GET', '/api/jira')
      assert.deepEqual({ on: theirs.body.on, mayManage: theirs.body.mayManage }, { on: true, mayManage: false })
      assert.equal(theirs.body.webhook, undefined)
      assert.equal(theirs.body.email, undefined)
      assert.equal(theirs.body.baseUrl, undefined)
      for (const [method, path] of [['PUT', '/api/jira'], ['POST', '/api/jira/test'], ['DELETE', '/api/jira']]) {
        assert.equal((await member(method, path, method === 'DELETE' ? undefined : settings)).status, 422, path)
      }
      assert.equal(set.jira.on(), true)
    } finally {
      await set.close()
    }
  })

  it('refuses an address it won’t send a token to, and a new address without its token', async () => {
    const set = await setUp()
    try {
      const owner = await set.signIn('owner')
      const refused = await owner('PUT', '/api/jira', { ...settings, baseUrl: 'http://169.254.169.254' })
      assert.equal(refused.status, 422)
      assert.match(refused.body.error, /Jira Cloud address/)
      const tokenless = await owner('PUT', '/api/jira', { ...settings, token: undefined })
      assert.equal(tokenless.status, 422)
      assert.match(tokenless.body.error, /token entered again/)
      assert.equal(set.jira.settings.baseUrl, set.fake.url)
    } finally {
      await set.close()
    }
  })

  it('starts a new mirror at a new address, leaving what shares an id there alone', async () => {
    const set = await setUp()
    try {
      await set.card('card-new-home')
      await mirrored(set)
      await settled()
      const other = await fakeJira()
      try {
        other.issues.set('101', { key: 'STRANGER-1', summary: 'Someone else’s', status: 'To Do' })
        await set.saver.forget()
        await set.jira.configure({ baseUrl: other.url, email: 'e@example.test', token: 'other', project: 'BIND' })
        await set.saver.load()
        await until(() => other.calls.some((c) => c.method === 'POST' && c.path === '/rest/api/3/issue'), 4000)
        await set.edit('card-new-home', { title: 'Mine' })
        await until(() => other.issues.get('102')?.summary === 'Mine', 4000)
        assert.equal(other.issues.get('101')!.summary, 'Someone else’s')
      } finally {
        await other.close()
      }
    } finally {
      await set.close()
    }
  })

  it('forgets what it wrote when the project changes, and only then', async () => {
    const set = await setUp()
    try {
      await set.card('card-project')
      await mirrored(set)
      await settled()
      // Done, so nothing is due to be written: these saves reach no Jira.
      await set.edit('card-project', { stage: 'live' })
      await until(() => set.fake.issues.get('101')!.status === 'Done', 4000)
      await settled()
      set.jira.settings.baseUrl = settings.baseUrl
      const owner = await set.signIn('owner')
      assert.equal((await owner('PUT', '/api/jira', { ...settings, token: undefined })).status, 200)
      assert.equal(set.saver.cardOfIssue('101'), 'card-project')
      assert.equal((await owner('PUT', '/api/jira', { ...settings, token: undefined, project: 'OTHER' })).status, 200)
      assert.equal(set.saver.cardOfIssue('101'), undefined)
      assert.equal(set.jira.settings.token, 'tok-ab')
    } finally {
      await set.close()
    }
  })

  it('forgets the token and the secret on disconnecting', async () => {
    const set = await setUp()
    try {
      const secret = await set.jira.secret()
      const owner = await set.signIn('owner')
      assert.equal((await owner('DELETE', '/api/jira')).status, 200)
      assert.equal(set.jira.on(), false)
      assert.equal((await owner('GET', '/api/jira')).body.tokenSet, false)
      assert.equal(await set.kv.get('jira:test:settings'), undefined)
      const late = await fetch(`${set.url}/webhooks/jira/test?secret=${encodeURIComponent(secret)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(late.status, 404)

      const restarted = new JiraConnection(set.kv, set.sealer, 'test')
      await restarted.load()
      assert.equal(restarted.on(), false)
    } finally {
      await set.close()
    }
  })

  it('keeps the token sealed where it’s stored', async () => {
    const set = await setUp()
    try {
      const stored = (await set.kv.get('jira:test:settings'))!
      assert.equal(stored.includes('tok-ab'), false)
      const restarted = new JiraConnection(set.kv, set.sealer, 'test')
      await restarted.load()
      assert.equal(restarted.settings.token, 'tok-ab')
      assert.equal(restarted.on(), true)
    } finally {
      await set.close()
    }
  })
})
