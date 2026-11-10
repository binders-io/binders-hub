import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { historyPage, noted } from '../src/history.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Spaces, type Member, type Space } from '../src/spaces.ts'
import { Webhooks } from '../src/webhooks.ts'
import { historyKept } from '../../shared/state.ts'
import { lightState, withoutKept } from '../../shared/light.ts'
import type { Card } from '../../shared/work.ts'
import { note, seed } from './helpers.ts'

// A Binder's history: what people and agents did that others would want to know of later, in sentences, newest first,
// kept with the Binder's state and out of what a browser loads.

const at = '2026-11-09T10:00:00.000Z'
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: at, createdBy: 'ana', updatedAt: at, waitsFor: [], activity: [], ...extra })

async function setUp(members: Member[] = [{ login: 'ana', role: 'owner' }]) {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const actions = new Actions(hub, github)
    return { id, hub, actions, github, webhooks: new Webhooks(hub, actions), stop: async () => undefined }
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members })
  const app = await buildServer(spaces, { auth }, { publicUrl: 'http://hub.test', admins: ['root'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const as = async (login: string, space = 'acme') => {
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', 'x-binders-space': space, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
  }
  const hub = () => spaces.get('acme')!.hub
  const actions = () => spaces.get('acme')!.actions
  return { spaces, as, hub, actions, close: () => app.close() }
}

type Caller = Awaited<ReturnType<Awaited<ReturnType<typeof setUp>>['as']>>
const send = (who: Caller, ...list: { type: string; [key: string]: unknown }[]) => who('POST', '/api/changes', { client: 'tab-1234', changes: list.map((change, i) => ({ id: `c${Math.random().toString(36).slice(2, 8)}${i}`, change })) })
/** The history as the route gives it, newest first, as "who: sentence". */
const read = async (who: Caller, query = '') => ((await who('GET', `/api/history${query}`)).body.lines as { by: string; text: string }[]).map((l) => `${l.by}: ${l.text}`)

describe('what the history notes', () => {
  it('a note, a card and a folder deleted, each with its title, by whoever deleted it', async () => {
    const { as, hub, close } = await setUp()
    const ana = await as('ana')
    await send(ana, { type: 'note.put', note: note('n2', 'Launch plan') }, { type: 'card.put', card: card('c1', { title: 'Write the plan' }) })
    assert.deepEqual(await read(ana), [], 'making things isn’t noted')
    assert.equal((await send(ana, { type: 'note.delete', id: 'n2' }, { type: 'card.delete', id: 'c1' }, { type: 'folder.delete', id: 'f1' })).status, 200)
    assert.deepEqual(await read(ana), ['ana: Deleted the folder “Planning”.', 'ana: Deleted the card “Write the plan”.', 'ana: Deleted the note “Launch plan”.'])
    // The Mac and the iPhone delete with the change alone, and an agent through the hub: both are noted the same way.
    await hub().record({ kind: 'hub' }, { type: 'note.put', note: note('n3', 'Old idea') })
    await hub().record({ kind: 'user', login: 'bo' }, { type: 'note.delete', id: 'n3' })
    await close()
    assert.equal(hub().state.history?.at(-1)?.by, 'bo')
    assert.equal(hub().state.history?.at(-1)?.text, 'Deleted the note “Old idea”.')
  })

  it('a note an agent deletes is by the agent’s name, and the hub’s own by "hub"', async () => {
    const { as, hub, close } = await setUp()
    const ana = await as('ana')
    await hub().record({ kind: 'hub' }, { type: 'agent.put', agent: { id: 'a1', name: 'Builder', provider: 'claude', owner: 'ana', repos: [], binders: [], skills: [], createdAt: at } })
    await hub().record({ kind: 'hub' }, { type: 'note.put', note: note('n2', 'Scratch') })
    await hub().record({ kind: 'agent', id: 'a1' }, { type: 'note.delete', id: 'n2' })
    await hub().record({ kind: 'hub' }, { type: 'note.put', note: note('n3', 'Other') })
    await hub().record({ kind: 'hub' }, { type: 'note.delete', id: 'n3' })
    assert.deepEqual(await read(ana), ['hub: Deleted the note “Other”.', 'Builder: Deleted the note “Scratch”.'])
    await close()
  })

  it('a note edited, a card moved and a card’s activity aren’t noted', async () => {
    const { as, hub, close } = await setUp()
    const ana = await as('ana')
    await send(ana, { type: 'card.put', card: card('c1') })
    await send(ana, { type: 'note.edit', id: 'n1', text: '# New words\n', title: 'New words', by: 'ana', at }, { type: 'card.update', id: 'c1', fields: { stage: 'review' }, activity: { at, by: 'ana', kind: 'moved', text: 'Moved it' } }, { type: 'card.activity', id: 'c1', activity: { at, by: 'ana', kind: 'comment', text: 'Hello' } })
    await hub().record({ kind: 'hub' }, { type: 'card.activity', id: 'c1', activity: { at, by: 'hub', kind: 'said', text: 'Hi' } })
    assert.deepEqual(await read(ana), [])
    await close()
  })

  it('a binder renamed, and where its cards and notes go changed, each in words', async () => {
    const { as, close } = await setUp()
    const ana = await as('ana')
    const binder = { id: 'b1', name: 'Server' }
    await send(ana, { type: 'binder.put', binder: { ...binder, name: 'Backend' } })
    await send(ana, { type: 'binder.put', binder: { ...binder, name: 'Backend', repo: 'acme/web' } })
    await send(ana, { type: 'binder.put', binder: { ...binder, name: 'Backend', repo: 'acme/api' } })
    await send(ana, { type: 'binder.put', binder: { ...binder, name: 'Backend', repo: 'acme/api', repos: ['acme/api', 'acme/web'], notes: false, notesBranch: 'docs', issues: false, reviewComments: true } })
    // The same again, with defaults written out in full, changes nothing.
    await send(ana, { type: 'binder.put', binder: { ...binder, name: 'Backend', repo: 'ACME/api', repos: ['acme/api', 'acme/web'], notes: false, notesBranch: 'docs', issues: false, reviewComments: true } })
    await send(ana, { type: 'binder.put', binder: { ...binder, name: 'Backend', notes: true, issues: true } })
    assert.deepEqual((await read(ana)).reverse(), [
      'ana: Renamed the binder “Server” to “Backend”.',
      'ana: Set the repo of “Backend” to acme/web.',
      'ana: Changed the repo of “Backend” from acme/web to acme/api.',
      'ana: Changed the repos agents work in for “Backend”.',
      'ana: Turned off pushing the notes of “Backend” to GitHub.',
      'ana: Set the notes branch of “Backend” to docs.',
      'ana: Turned off keeping the cards of “Backend” as GitHub issues.',
      'ana: Turned on review comments on the pull requests of “Backend”.',
      'ana: Took the repo off “Backend”.',
      'ana: Changed the repos agents work in for “Backend”.',
      'ana: Turned on pushing the notes of “Backend” to GitHub.',
      'ana: Put the notes branch of “Backend” back to the usual one.',
      'ana: Turned on keeping the cards of “Backend” as GitHub issues.',
      'ana: Turned off review comments on the pull requests of “Backend”.',
    ])
    await close()
  })

  it('people added, given another role, taken out and leaving, and the agents revoked with them', async () => {
    const { as, close } = await setUp()
    const ana = await as('ana')
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'member' })
    await ana('PUT', '/api/spaces/acme/members/cy', { role: 'admin' })
    await ana('PUT', '/api/spaces/acme/members/dee', { role: 'owner' })
    const cy = await as('cy')
    await cy('POST', '/api/agents', { name: 'Builder' })
    await ana('DELETE', '/api/spaces/acme/members/cy')
    const dee = await as('dee')
    await dee('DELETE', '/api/spaces/acme/members/dee')
    assert.deepEqual((await read(ana)).reverse(), [
      'ana: Added @cy to this Binder as a member.',
      'ana: Made @cy an admin.',
      'ana: Added @dee to this Binder as an owner.',
      'cy: Set up the agent “Builder”.',
      'ana: Took @cy out of this Binder.',
      'ana: Revoked the agent “Builder”, as @cy is no longer in this Binder.',
      'dee: @dee left this Binder.',
    ])
    await close()
  })

  it('a Binder renamed', async () => {
    const { as, hub, close } = await setUp()
    const ana = await as('ana')
    await ana('PATCH', '/api/spaces/acme', { name: 'Acme Ltd' })
    assert.deepEqual(await read(ana), ['ana: Renamed the binder “Server” to “Acme Ltd”.'], 'its one binder goes by its name')
    // With more than one binder none is renamed with it, and the Binder’s own name is what's noted.
    await hub().record({ kind: 'hub' }, { type: 'binder.put', binder: { id: 'b2', name: 'Second' } })
    await ana('PATCH', '/api/spaces/acme', { name: 'Acme Inc' })
    assert.equal((await read(ana))[0], 'ana: Renamed this Binder from “Acme Ltd” to “Acme Inc”.')
    await close()
  })

  it('an agent set up, given a new token and revoked, and a change set approved and deleted, and environments', async () => {
    const { as, hub, actions, close } = await setUp()
    const ana = await as('ana')
    const made = (await ana('POST', '/api/agents', { name: 'Builder' })).body
    await ana('POST', `/api/agents/${made.agent.id}/token`)
    await ana('DELETE', `/api/agents/${made.agent.id}`)
    await hub().record({ kind: 'hub' }, { type: 'set.put', set: { id: 'set-1', binderId: 'b1', number: 1, title: 'Billing', summary: '', state: 'review', prIds: [], noteIds: [] } })
    await hub().record({ kind: 'hub' }, { type: 'set.put', set: { id: 'set-2', binderId: 'b1', number: 2, title: 'Search', summary: '', state: 'review', prIds: [], noteIds: [] } })
    await actions().approveSet('ana', 'set-1')
    await actions().deleteSet('ana', 'set-2')
    await hub().record({ kind: 'user', login: 'ana' }, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } })
    await actions().addEnvironment('ana', { repo: 'acme/web', name: 'Staging' })
    await actions().addEnvironment('ana', { repo: 'acme/web', name: 'Production', deploy: { workflow: 'deploy.yml', ref: 'main' } })
    await actions().changeEnvironment('ana', 'acme/web#staging', { url: 'https://staging.test' })
    await actions().changeEnvironment('ana', 'acme/web#staging', { name: 'QA' })
    await hub().record({ kind: 'hub' }, { type: 'env.update', id: 'acme/web#qa', fields: { version: 'v1.0.0', deployedAt: at } })
    await actions().removeEnvironment('ana', 'acme/web#production')
    assert.deepEqual((await read(ana)).reverse(), [
      'ana: Set up the agent “Builder”.',
      'ana: Gave the agent “Builder” a new token.',
      'ana: Revoked the agent “Builder”.',
      'ana: Approved change set #1 “Billing”.',
      'ana: Deleted change set #2 “Search”.',
      'ana: Set the repo of “Server” to acme/web.',
      'ana: Added the environment “Staging” for acme/web.',
      'ana: Added the environment “Production” for acme/web.',
      'ana: Changed the environment “Staging” in acme/web.',
      'ana: Renamed the environment “Staging” in acme/web to “QA”.',
      'ana: Removed the environment “Production” from acme/web.',
    ])
    await close()
  })
})

describe('reading the history', () => {
  it('is for anyone in the Binder and no one else, in pages of 50 from the newest, and one person’s on request', async () => {
    const { as, hub, close } = await setUp([{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }])
    const ana = await as('ana')
    const cy = await as('cy')
    for (let n = 0; n < 60; n++) await noted(hub(), { kind: 'user', login: n % 3 === 0 ? 'cy' : 'ana' }, `Line ${n}.`)
    const first = (await cy('GET', '/api/history')).body
    assert.equal(first.lines.length, historyPage)
    assert.equal(first.lines[0].text, 'Line 59.')
    assert.equal(first.lines[0].by, 'ana')
    assert.equal(first.more, true)
    assert.deepEqual(first.people, ['ana', 'cy'])
    const next = (await ana('GET', `/api/history?before=${encodeURIComponent(first.lines.at(-1).at)}`)).body
    assert.equal(next.lines.length, 10)
    assert.equal(next.lines[0].text, 'Line 9.')
    assert.equal(next.more, false)
    const hisOwn = (await ana('GET', '/api/history?who=@CY')).body
    assert.equal(hisOwn.lines.length, 20)
    assert.ok(hisOwn.lines.every((l: { by: string }) => l.by === 'cy'))
    const hisOlder = (await ana('GET', `/api/history?who=cy&before=${encodeURIComponent(hisOwn.lines[4].at)}`)).body
    assert.deepEqual(hisOlder.lines.map((l: { text: string }) => l.text).slice(0, 2), ['Line 42.', 'Line 39.'])
    assert.equal((await ana('GET', '/api/history?before=yesterday')).status, 422)
    const stranger = await as('mal')
    assert.equal((await stranger('GET', '/api/history')).status, 403)
    await close()
  })

  it('gives each line its own time, so a page never starts in the middle of two', async () => {
    const { hub, close } = await setUp()
    await noted(hub(), { kind: 'hub' }, ['One.', 'Two.', 'Three.'])
    await noted(hub(), { kind: 'hub' }, 'Four.')
    const times = hub().state.history!.map((l) => l.at)
    assert.equal(new Set(times).size, 4)
    assert.deepEqual(times, [...times].sort())
    await close()
  })

  it('keeps the last thousand, and no one writes or deletes a line', async () => {
    const { as, hub, close } = await setUp()
    const ana = await as('ana')
    await noted(hub(), { kind: 'hub' }, Array.from({ length: historyKept + 25 }, (_, n) => `Line ${n}.`))
    assert.equal(hub().state.history!.length, historyKept)
    assert.equal(hub().state.history![0].text, 'Line 25.')
    // A client may not send one, nor put its own into the state.
    assert.equal((await send(ana, { type: 'history.add', lines: [{ at, by: 'ana', text: 'Nothing happened.' }] })).status, 422)
    assert.equal((await send(ana, { type: 'trash.drop', notes: ['n1'] })).status, 422)
    assert.equal((await ana('DELETE', '/api/history')).status, 404)
    assert.equal((await ana('PUT', '/api/history', {})).status, 404)
    await close()
  })

  it('is kept with the state, and out of what a browser loads and what the apps read', async () => {
    const { as, hub, close } = await setUp()
    const ana = await as('ana')
    await send(ana, { type: 'note.delete', id: 'n1' })
    assert.ok(hub().state.history?.length)
    assert.ok(hub().state.trashedNotes?.length)
    for (const path of ['/api/state', '/api/state?light=1']) {
      const state = (await ana('GET', path)).body.state
      assert.equal(state.history, undefined, path)
      assert.equal(state.trashedNotes, undefined, path)
      assert.equal(state.trashedCards, undefined, path)
      assert.ok(state.binders.length, path)
    }
    assert.equal('history' in lightState(hub().state), false)
    assert.equal('trashedNotes' in withoutKept(hub().state), false)
    await close()
  })
})

describe('the history across a start from the saved state', () => {
  it('comes back with it, and a state saved before there was a history loads', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'note.delete', id: 'n1' })
    const saved = JSON.parse(JSON.stringify({ version: hub.version, state: hub.state }))
    const again = new Hub(new MemoryLog())
    await again.start(undefined, saved)
    assert.equal(again.state.history?.length, 1)
    assert.equal(again.state.trashedNotes?.length, 1)
    const { history: _h, trashedNotes: _t, trashedCards: _c, ...before } = saved.state
    const old = new Hub(new MemoryLog())
    await old.start(undefined, { version: saved.version, state: before })
    await old.record({ kind: 'user', login: 'ana' }, { type: 'note.put', note: note('n9', 'New') })
    await old.record({ kind: 'user', login: 'ana' }, { type: 'note.delete', id: 'n9' })
    assert.equal(old.state.history?.length, 1)
    assert.equal(old.state.trashedNotes?.length, 1)
  })
})
