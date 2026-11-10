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
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { SpaceBrain } from '../src/brain/brain.ts'
import { FirstAnswers } from '../src/brain/first.ts'
import type { BrainModel } from '../src/brain/models.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card } from '../../shared/work.ts'
import { note, seed } from './helpers.ts'

const people: Member[] = [{ login: 'ana', role: 'owner' }, { login: 'cy', role: 'member' }, { login: 'di', role: 'reader' }]
const at = '2026-11-08T10:00:00.000Z'
const agent: Agent = { id: 'a1', name: 'Sonnet', owner: 'ana', binders: ['b1'], repos: [], lastSeen: new Date().toISOString() } as unknown as Agent
const asking = (id: string, question: string): Card => ({ id, title: `Card ${id}`, binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'blocked', agentId: 'a1', needsYou: question, waitsFor: [], activity: [], updatedAt: at } as unknown as Card)

const work: Change[] = [
  { type: 'agent.put', agent } as Change,
  { type: 'note.put', note: note('conventions', 'How we build', { text: '# How we build\n\nWe use pnpm, never npm.\n' }) },
  { type: 'card.put', card: asking('one', 'Which package manager do we use?') },
  { type: 'card.put', card: asking('two', 'Which package manager do we use?') },
  { type: 'card.put', card: asking('three', 'Which region should the database go to?') },
  { type: 'card.put', card: { ...asking('busy', ''), needsYou: undefined, stage: 'working' } as Card },
]

async function setUp() {
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  await kv.set('spaces', JSON.stringify([{ id: 'acme', name: 'Acme', createdAt: '2026-11-01T00:00:00.000Z', createdBy: 'hub', members: people }]))
  const settings = await new BrainSettingsStore(new MemoryKV(), sealer, {}).load()
  const model: BrainModel = {
    label: 'scripted',
    summarize: async () => ({ title: '', summary: '', points: [], decisions: [], followUps: [] }),
    answer: async (question, passages) => {
      const found = passages.findIndex((p) => p.title === 'How we build')
      const text = /package manager/.test(question) ? 'FACT\npnpm, never npm.' : 'YOURS\nIt’s a choice between regions.'
      return { text, parts: [{ text, sources: /package manager/.test(question) && found >= 0 ? [found] : [] }] }
    },
    talk: async () => '',
    sortMoment: async () => ({ kind: 'none', title: '' }),
  }
  settings.useForTests(model)
  const made: Record<string, Space> = {}
  const make = async (id: string): Promise<Space> => {
    const github = new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, { webhookSecret: `shh-${id}` }, id)
    const hub = new Hub(new MemoryLog())
    await hub.start([...seed(), ...work])
    const actions = new Actions(hub, github)
    const own = new MemoryKV()
    const brain = new SpaceBrain({ id, hub, kv: own, settings, quietMs: 10 })
    brain.start()
    await brain.caughtUp()
    made[id] = { id, hub, actions, github, webhooks: new Webhooks(hub, actions), brain, first: new FirstAnswers({ hub, settings, kv: own, place: () => ({ id, name: 'Acme', brain, url: () => '' }) }) }
    return made[id]
  }
  const spaces = await new Spaces(kv, make).load({ id: 'acme', name: 'Acme', members: people })
  const app = await buildServer(spaces, { auth, brain: settings }, { publicUrl: 'http://hub.test', admins: ['root'] })
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
  const cardNow = (id: string) => made.acme.hub.state.cards.find((c) => c.id === id)!
  return { as, cardNow, first: () => made.acme.first!, close: async () => { made.acme.brain!.stop(); await app.close() } }
}

describe('what the Brain makes of what waits, over the hub’s API', () => {
  it('gives everyone in the Binder the drafts and what’s gathered, a reader too', async () => {
    const set = await setUp()
    try {
      const di = await set.as('di')
      assert.deepEqual((await di('GET', '/api/brain/first')).body.drafts, [])
      await set.first().settled()
      const seen = (await di('GET', '/api/brain/first')).body
      assert.deepEqual(seen.drafts.map((d: { card: string; kind: string }) => [d.card, d.kind]).sort(), [['one', 'answer'], ['three', 'yours'], ['two', 'answer']])
      assert.deepEqual(seen.gathered.map((g: { why: string; cards: string[] }) => [g.why, g.cards]), [['question', ['one', 'two']]])
    } finally {
      await set.close()
    }
  })

  it('sends a person’s answer to each card named, as theirs, and the agents carry on', async () => {
    const set = await setUp()
    try {
      const cy = await set.as('cy')
      const sent = await cy('POST', '/api/brain/first/send', { cards: ['one', 'two', 'busy', 'gone'], words: '  pnpm, never npm.  ' })
      assert.deepEqual(sent, { status: 200, body: { sent: 2 } }, 'one that isn’t waiting, and one that isn’t there, are left out')
      for (const id of ['one', 'two']) {
        const card = set.cardNow(id)
        assert.equal(card.needsYou, undefined)
        assert.equal(card.stage, 'working')
        assert.deepEqual([card.activity.at(-1)!.by, card.activity.at(-1)!.text], ['cy', 'pnpm, never npm.'])
      }
      assert.equal(set.cardNow('three').needsYou, 'Which region should the database go to?')
      assert.equal((await cy('POST', '/api/brain/first/send', { cards: ['one'], words: 'again' })).status, 422, 'answered already, there’s nothing to send to')
      assert.equal((await cy('POST', '/api/brain/first/send', { cards: ['three'], words: '   ' })).status, 422)
      assert.equal((await cy('POST', '/api/brain/first/send', { cards: [], words: 'x' })).status, 422)
    } finally {
      await set.close()
    }
  })

  it('stops each card named, and does neither for a reader', async () => {
    const set = await setUp()
    try {
      const [cy, di] = await Promise.all([set.as('cy'), set.as('di')])
      assert.equal((await di('POST', '/api/brain/first/send', { cards: ['three'], words: 'eu-west' })).status, 403)
      assert.equal((await di('POST', '/api/brain/first/stop', { cards: ['three'] })).status, 403)
      assert.equal(set.cardNow('three').stage, 'blocked')
      assert.deepEqual((await cy('POST', '/api/brain/first/stop', { cards: ['three', 'busy'] })).body, { stopped: 1 })
      assert.equal(set.cardNow('three').stage, 'proposed')
      assert.equal(set.cardNow('busy').stage, 'working', 'a card that isn’t waiting isn’t stopped from here')
    } finally {
      await set.close()
    }
  })
})
