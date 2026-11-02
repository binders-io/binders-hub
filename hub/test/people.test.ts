import { describe, it, after } from 'node:test'
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
import { Webhooks } from '../src/webhooks.ts'
import { loginsIn, shortcodesOf, shownName, withoutShortcode } from '../../shared/people.ts'
import type { Card } from '../../shared/work.ts'
import { note, oneSpace, seed } from './helpers.ts'

describe('how a person is shown', () => {
  it('shows their profile’s name, or their login without a known enterprise shortcode', () => {
    const people = { 'jdoe_acme': { name: 'Jane Doe' }, ana: { name: '  ' } }
    assert.equal(shownName('jdoe_acme', people, []), 'Jane Doe', 'the profile’s name first')
    assert.equal(shownName('JDOE_ACME', people), 'Jane Doe', 'whatever the case')
    assert.equal(shownName('bo_acme', people, ['acme']), 'bo', 'a known shortcode left off')
    assert.equal(shownName('bo_acme', people, ['other']), 'bo_acme', 'an underscore alone says nothing')
    assert.equal(shownName('ana', people, ['acme']), 'ana', 'a blank name is no name')
    assert.equal(withoutShortcode('snake_case_name', ['name']), 'snake_case', 'only the last part')
    assert.equal(withoutShortcode('_acme', ['acme']), '_acme', 'never down to nothing')
    assert.deepEqual(shortcodesOf(['acme-labs', 'Octo', 'we.ird']), ['acme', 'octo'], 'letters and digits only, as GitHub’s are')
  })

  it('finds everyone a binder’s state names', () => {
    const card = { createdBy: 'ana', activity: [{ by: 'hub' }, { by: 'Bo' }, { by: 'agent-1' }], debrief: { askedBy: 'cy' } }
    const found = loginsIn({ cards: [card], notes: [{ editors: ['dee'], editedBy: 'eve' }], agents: [{ owner: 'fay' }], changeSets: [{ approvedBy: 'gus' }] })
    assert.deepEqual([...found].sort(), ['agent-1', 'ana', 'bo', 'cy', 'dee', 'eve', 'fay', 'gus'])
  })
})

describe('the people a binder shows', () => {
  const was = process.env.HUB_EMU_SHORTCODES
  after(() => { if (was === undefined) delete process.env.HUB_EMU_SHORTCODES; else process.env.HUB_EMU_SHORTCODES = was })

  it('gives its people their GitHub profiles, nobody else’s, and the shortcodes to leave off', async () => {
    process.env.HUB_EMU_SHORTCODES = 'Corp'
    const card: Card = { id: 'c1', binderId: 'b1', title: 'A card', brief: '', doneWhen: '', size: 'S', stage: 'ready', createdAt: '2026-11-01T00:00:00Z', createdBy: 'jdoe_acme', updatedAt: '2026-11-01T00:00:00Z', waitsFor: [], activity: [] }
    const hub = new Hub(new MemoryLog())
    await hub.start([...seed(), { type: 'card.put', card }, { type: 'note.put', note: note('n2', 'Second', { editors: ['bo'] }) }])
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' })
    const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const actions = new Actions(hub, github)
    const app = await buildServer(oneSpace(kv, { hub, actions, webhooks: new Webhooks(hub, actions), github }), { auth }, { publicUrl: 'http://hub.test' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

    await auth.rememberPerson({ login: 'jdoe_acme', name: 'Jane Doe', avatar: 'https://github.test/j.png' })
    await auth.rememberPerson({ login: 'bo' })
    await auth.rememberPerson({ login: 'zed', name: 'Zed Elsewhere' })
    await auth.rememberPerson({ login: 'jdoe_acme', name: 'Jane Q. Doe', avatar: 'https://github.test/j.png' })
    const { id } = await auth.startSession({ login: 'you', name: 'You' })
    const me = await (await fetch(`${url}/api/me`, { headers: { cookie: `binders_session=${id}` } })).json() as { people: Record<string, { name?: string; avatar?: string }>; emu: string[]; user: { login: string } }
    assert.equal(me.user.login, 'you', 'the login stays who they are')
    assert.deepEqual(me.people, { jdoe_acme: { name: 'Jane Q. Doe', avatar: 'https://github.test/j.png' }, bo: {} }, 'the binder’s people, as last seen; not zed')
    assert.ok(me.emu.includes('corp'), 'the hub’s own setting')
    await app.close()
  })
})
