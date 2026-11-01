import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hub, Refused } from '../src/hub.ts'
import { MemoryLog, RedisLog, type ChangeLog } from '../src/log.ts'
import { Actions } from '../src/actions.ts'
import { nextFor, type Card } from '../../shared/work.ts'
import type { Change } from '../../shared/state.ts'
import { note, seed, startRedis, until } from './helpers.ts'

let redis: Awaited<ReturnType<typeof startRedis>>
before(async () => { redis = await startRedis(6391) })
after(() => redis?.stop())

const logs: [string, (space: string) => ChangeLog | undefined][] = [
  ['memory', () => new MemoryLog()],
  ['redis', (space) => (redis ? new RedisLog(redis.url, space) : undefined)],
]

describe('a change that can’t be applied', () => {
  const folder = (id: string) => ({ type: 'folder.put', folder: { id, binderId: 'b1', name: id } }) as Change

  for (const [name, change] of Object.entries({
    'a note with no note': { type: 'note.put' },
    'a folder with no folder': { type: 'folder.put' },
    'a binder with no binder': { type: 'binder.put' },
    'a card with no activity': { type: 'card.put', card: { id: 'c', binderId: 'b1', title: 'c', stage: 'ready' } },
    'a note whose text isn’t text': { type: 'note.put', note: { id: 'n', binderId: 'b1', title: 'n', editedAt: 'now', editors: [], text: 5 } },
    'an edit with no text': { type: 'note.edit', id: 'n1' },
    'a card update without fields': { type: 'card.update', id: 'c' },
    'a card update that replaces its activity': { type: 'card.update', id: 'c', fields: { activity: 'gone' } },
    'a card update that clears its title': { type: 'card.update', id: 'c', fields: { title: null } },
    'a card update with no id': { type: 'card.update', fields: { stage: 'ready' } },
    'a card whose plan isn’t a list': { type: 'card.put', card: { id: 'c', binderId: 'b1', title: 'c', brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: 'then', createdBy: 'you', updatedAt: 'then', waitsFor: [], activity: [], plan: 'x' } },
    'a card whose plan isn’t steps': { type: 'card.put', card: { id: 'c', binderId: 'b1', title: 'c', brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: 'then', createdBy: 'you', updatedAt: 'then', waitsFor: [], activity: [], plan: ['x'] } },
    'a note whose work isn’t a list': { type: 'note.put', note: { id: 'n', binderId: 'b1', title: 'n', editedAt: 'now', editors: [], text: 't', work: 5 } },
    'a note whose work isn’t links': { type: 'note.put', note: { id: 'n', binderId: 'b1', title: 'n', editedAt: 'now', editors: [], text: 't', work: ['xy'] } },
  })) {
    it(`is refused before it reaches the log: ${name}`, async () => {
      const hub = new Hub(new MemoryLog())
      await hub.start([folder('before')])
      const version = hub.version
      await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'bad', change: change as unknown as Change }]), Refused)
      assert.equal(await hub.log.latest(), version, 'nothing went in')
      await hub.submit('you', 'tab-1', [{ id: 'after', change: folder('after') }])
      assert.ok(hub.state.folders.some((f) => f.id === 'after'), 'and the hub carries on')
    })
  }

  it('keeps taking what the web app and the Mac send: null for a cleared field, and fields it doesn’t know', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start()
    const card = { id: 'c', binderId: 'b1', title: 'c', brief: '', doneWhen: '', size: 'M', stage: 'working', agentId: 'a1', createdAt: 'then', createdBy: 'you', updatedAt: 'then', waitsFor: [], activity: [] }
    await hub.submit('you', 'tab-1', [
      { id: '1', change: { type: 'card.put', card } as Change },
      { id: '2', change: { type: 'card.update', id: 'c', fields: { stage: 'ready', agentId: null, needsYou: null, doing: null, progress: null, fromTheFuture: true } } as unknown as Change },
      { id: '3', change: { type: 'binder.put', binder: { id: 'b2', name: 'Mac', syncedFrom: 'a Mac' } } as unknown as Change },
      { id: '4', change: { type: 'card.put', card: { ...card, id: 'cleared', plan: null } } as unknown as Change },
      { id: '5', change: { type: 'card.put', card: { ...card, id: 'planned', plan: [{ text: 'One', done: false, fromTheFuture: true }] } } as unknown as Change },
      { id: '6', change: { type: 'note.put', note: { id: 'cleared', title: 'n', binderId: 'b1', editedAt: 'now', editors: [], text: 't', work: null } } as unknown as Change },
      { id: '7', change: { type: 'note.put', note: { id: 'linked', title: 'n', binderId: 'b1', editedAt: 'now', editors: [], text: 't', work: [{ itemId: 'c', quote: 't', fromTheFuture: true }] } } as unknown as Change },
    ])
    const after = hub.state.cards.find((c) => c.id === 'c')!
    assert.equal(after.stage, 'ready')
    assert.equal('agentId' in after, false, 'null clears a field')
    assert.ok(hub.state.binders.some((b) => b.id === 'b2'))
    assert.ok(['cleared', 'planned'].every((id) => hub.state.cards.some((c) => c.id === id)))
    assert.ok(['cleared', 'linked'].every((id) => hub.state.notes.some((n) => n.id === id)))
  })

  it('is judged in the order it was sent: a batch may build on itself', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start()
    const note = { id: 'n', title: 'n', binderId: 'b1', editedAt: 'now', editors: ['you'], text: 'one' }
    await hub.submit('you', 'tab-1', [
      { id: '1', change: { type: 'note.put', note } },
      { id: '2', change: { type: 'note.edit', id: 'n', text: 'two', title: 'two', by: 'you', at: 'now' } },
    ])
    assert.equal(hub.state.notes[0].text, 'two')
  })

  it('doesn’t stop a hub when one is already in the log: every reader skips it, and the changes after it apply', async () => {
    const log = new MemoryLog()
    const hub = new Hub(log)
    await hub.start([folder('before')])
    const poison = await log.append({ id: 'poison', client: 'user:you:tab-1', at: 'now', change: { type: 'note.put' } as unknown as Change })
    await hub.submit('you', 'tab-1', [{ id: 'after', change: folder('after') }])
    assert.ok(hub.state.folders.some((f) => f.id === 'after'), 'the hub read on past it')
    assert.equal(hub.version, poison + 1)
    assert.equal((await hub.read(0)).some((e) => e.version === poison), false, 'clients aren’t sent it')

    const again = new Hub(log)
    await again.start()
    assert.equal(again.version, hub.version)
    assert.deepEqual(again.state.folders, hub.state.folders, 'a hub starting on the same log agrees')
    assert.equal((await again.read(0)).some((e) => e.version === poison), false)
  })
})

for (const [kind, make] of logs) {
  describe(`a ${kind} log`, () => {
    it('numbers changes in order and replays only what a reader missed', async (t) => {
      const log = make('order')
      if (!log) return t.skip('redis-server isn’t installed')
      const at = new Date().toISOString()
      assert.equal(await log.append({ id: 'a', client: 'c1', at, change: { type: 'note.delete', id: 'x' } }), 1)
      assert.equal(await log.append({ id: 'b', client: 'c1', at, change: { type: 'note.delete', id: 'y' } }), 2)
      assert.equal(await log.append({ id: 'c', client: 'c1', at, change: { type: 'note.delete', id: 'z' } }), 3)
      assert.deepEqual((await log.read(1)).map((e) => [e.version, e.id]), [[2, 'b'], [3, 'c']])
      assert.equal(await log.latest(), 3)
      await log.close()
    })

    it('clears a field set to undefined, after a trip through the log', async (t) => {
      const log = make('clear')
      if (!log) return t.skip('redis-server isn’t installed')
      const hub = new Hub(log)
      await hub.start()
      await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'q', binderId: 'b1', title: 'q', brief: '', doneWhen: '', size: 'M', stage: 'working', agentId: 'a1', needsYou: 'Which way?', createdAt: '2026-10-29T00:00:00Z', createdBy: 'you', updatedAt: '2026-10-29T00:00:00Z', waitsFor: [], activity: [] } })
      await hub.record({ kind: 'hub' }, { type: 'card.update', id: 'q', fields: { needsYou: undefined, agentId: undefined, stage: 'ready' } })
      const again = new Hub(log)
      await again.start()
      const card = again.state.cards.find((c) => c.id === 'q')!
      assert.equal(card.stage, 'ready')
      assert.equal('needsYou' in card, false, 'the question is gone')
      assert.equal('agentId' in card, false, 'and so is its agent')
      await log.close()
    })

    it('drops a resend: the same client and id go in once', async (t) => {
      const log = make('resend')
      if (!log) return t.skip('redis-server isn’t installed')
      const entry = { id: 'same', client: 'c1', at: new Date().toISOString(), change: { type: 'note.delete', id: 'x' } as const }
      assert.equal(await log.append(entry), 1)
      assert.equal(await log.append(entry), 0)
      assert.equal(await log.append({ ...entry, client: 'c2' }), 2, 'another client may use the same id')
      await log.close()
    })
  })
}

const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: id, brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: '2026-10-29T00:00:00Z', createdBy: 'you', updatedAt: '2026-10-29T00:00:00Z', waitsFor: [], activity: [], ...extra })

describe('the hub', () => {
  it('starts from its seed once, then from its log', async () => {
    const log = new MemoryLog()
    const hub = new Hub(log)
    await hub.start(seed())
    assert.equal(hub.state.notes[0].title, 'First note')
    const again = new Hub(log)
    await again.start([{ type: 'note.put', note: note('other', 'Other') }])
    assert.deepEqual(again.state.notes.map((n) => n.id), ['n1'], 'a log that has changes ignores the seed')
  })

  it('applies a person’s changes in order and refuses what only the hub, GitHub or agents send', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await hub.submit('you', 'tab-1', [
      { id: 'e1', change: { type: 'note.edit', id: 'n1', title: 'Renamed', by: 'you', at: 'now', text: '# Renamed\n' } },
      { id: 'e2', change: { type: 'note.move', id: 'n1', binderId: 'b1' } },
    ])
    assert.equal(hub.state.notes[0].title, 'Renamed')
    assert.equal(hub.state.notes[0].folderId, undefined)
    const refused: Change[] = [
      { type: 'note.saved', id: 'n1', commit: 'abc', path: 'x.md' },
      { type: 'pr.put', pull: { id: 'o/r#1', repo: 'o/r', number: 1, title: '', branch: '', url: '', state: 'merged', checks: [], files: [] } },
      { type: 'card.claim', id: 'c', agentId: 'a', at: 'now' },
      { type: 'agent.put', agent: { id: 'a', name: 'A', provider: 'other', owner: 'x', repos: [], binders: [], skills: [], createdAt: 'now' } },
    ]
    for (const change of refused) {
      await assert.rejects(hub.submit('you', 'tab-1', [{ id: `x-${change.type}`, change }]), Refused, change.type)
    }
  })

  it('reads a card the log has in Shipping as done, as there is no such stage any more', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    const at = '2026-10-30T00:00:00Z'
    const shipping = 'shipping' as Card['stage']
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'c1', binderId: 'b1', title: 'Old', brief: '', doneWhen: '', size: 'S', stage: shipping, createdAt: at, createdBy: 'you', updatedAt: at, waitsFor: [], activity: [] } })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'c2', binderId: 'b1', title: 'Older', brief: '', doneWhen: '', size: 'S', stage: 'review', createdAt: at, createdBy: 'you', updatedAt: at, waitsFor: [], activity: [] } })
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: 'c2', fields: { stage: shipping } })
    assert.deepEqual(hub.state.cards.map((c) => c.stage), ['live', 'live'])
  })

  it('deletes only an empty binder', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    await assert.rejects(hub.submit('you', 'tab-1', [{ id: 'd', change: { type: 'binder.delete', id: 'b1' } }]), /Only an empty binder/)
    await hub.submit('you', 'tab-1', [{ id: 'b2', change: { type: 'binder.put', binder: { id: 'b2', name: 'Spare' } } }, { id: 'd2', change: { type: 'binder.delete', id: 'b2' } }])
    assert.deepEqual(hub.state.binders.map((b) => b.id), ['b1'])
  })

  it('gives a card to one agent when two claim it at once', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start([...seed(), { type: 'card.put', card: card('c1') }])
    const actions = new Actions(hub, { forRepo: async () => undefined, asUser: () => { throw new Error('unused') } })
    for (const id of ['a1', 'a2']) await actions.putAgent('you', { name: id }, undefined).then((agent) => hub.record({ kind: 'hub' }, { type: 'agent.put', agent: { ...agent, id } }))
    const results = await Promise.allSettled([actions.claim('a1', 'c1'), actions.claim('a2', 'c1')])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.match(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message), /Another agent took that card first/)
    assert.equal(hub.state.cards[0].stage, 'working')
  })

  it('gives an agent the card meant for it, even outside its repos', async () => {
    const agent = { id: 'a1', name: 'A', provider: 'other' as const, owner: 'you', repos: ['acme/api'], binders: ['b2'], skills: [], createdAt: 'now' }
    const state = { binders: [{ id: 'b1', name: 'Server', repo: 'acme/web' }], agents: [agent], cards: [card('open'), card('mine', { meantFor: 'a1', createdAt: '2026-10-30T00:00:00Z' })], proposals: [], pulls: [], changeSets: [], environments: [], runs: [], chats: [] }
    assert.equal(nextFor(state, agent)?.id, 'mine', 'meant for it: taken, though its binder and repo aren’t the agent’s')
    assert.equal(nextFor({ ...state, cards: [card('open')] }, agent), undefined, 'open to anyone: only in its own binders and repos')
  })

  it('two hubs on one Redis end up with the same state', async (t) => {
    if (!redis) return t.skip('redis-server isn’t installed')
    const one = new Hub(new RedisLog(redis.url, 'pair'))
    const two = new Hub(new RedisLog(redis.url, 'pair'))
    await one.start(seed())
    await two.start()
    await one.submit('you', 'tab-1', [{ id: 'x1', change: { type: 'note.put', note: note('n2', 'Made on one') } }])
    await two.submit('sam', 'tab-2', [{ id: 'x2', change: { type: 'card.put', card: card('c9') } }])
    await until(() => one.version === two.version && one.version === 5)
    assert.deepEqual(one.state, two.state)
    await one.log.close()
    await two.log.close()
  })
})
