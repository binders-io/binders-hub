import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Actions } from '../src/actions.ts'
import { Hub } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { mayMakeWork, mcpServer } from '../src/mcp.ts'
import { mayTake, nextFor, type Activity, type Agent, type Card, type Stage } from '../../shared/work.ts'
import type { Change } from '../../shared/state.ts'
import { seed, until } from './helpers.ts'

// An agent waiting for work isn't made to look over the board by what can't make work for it: a note being typed in,
// a step on someone's card, a pull request's checks. It still has a card the moment one is ready, a chat message, a
// debrief asked, and a card another agent let go.

const at = '2026-11-09T10:00:00.000Z'
const you = { kind: 'user' as const, login: 'you' }
const hubActor = { kind: 'hub' as const }
const agent = (id: string): Agent => ({ id, name: `Agent ${id}`, provider: 'other', owner: 'you', repos: [], binders: [], skills: [], createdAt: at })
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: at, createdBy: 'you', updatedAt: at, waitsFor: [], activity: [], ...extra })
const line = (kind: Activity['kind'], by = 'you', extra: Partial<Activity> = {}): Activity => ({ at, by, kind, text: kind, ...extra })

/** A hub with two agents, and a connection as the first one, that counts each time its waiting looks over the board. */
async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start([...seed(), { type: 'agent.put', agent: agent('a1') }, { type: 'agent.put', agent: agent('a2') }])
  const actions = new Actions(hub, { forRepo: async () => undefined, asUser: () => undefined } as never)
  // The last thing a look over the board does is ask what the agent was turned away from, so each ask is a look.
  const state = { looked: 0 }
  const barred = actions.barred.bind(actions)
  actions.barred = (id: string) => {
    state.looked++
    return barred(id)
  }
  const [near, far] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([mcpServer(hub, actions, 'a1').connect(far), client.connect(near)])
  const wait = async (args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name: 'wait_for_work', arguments: { timeout_seconds: 5, ...args } })) as { content: { text: string }[]; isError?: boolean }
    const words = result.content[0].text
    let value: Record<string, unknown> | undefined
    try {
      value = JSON.parse(words)
    } catch {
      value = undefined
    }
    return { words, value, error: !!result.isError }
  }
  /** Starts a wait, and returns once it's listening, with what it comes to. */
  const waiting = async (args: Record<string, unknown> = {}) => {
    const was = hub.listenerCount('entries')
    const done = { over: false }
    const result = wait(args).then((r) => {
      done.over = true
      return r
    })
    await until(() => hub.listenerCount('entries') > was)
    return { done, result }
  }
  const put = (c: Card) => hub.record(hubActor, { type: 'card.put', card: c })
  return { hub, state, wait, waiting, put, close: () => client.close() }
}

describe('a waiting agent', () => {
  it('isn’t made to look by a burst of note edits, steps on a card, progress and pull requests’ checks', async () => {
    const { hub, state, waiting, put, close } = await setUp()
    await put(card('held', { stage: 'working', agentId: 'a2' }))
    await hub.record(hubActor, { type: 'pr.put', pull: { id: 'acme/web#1', repo: 'acme/web', number: 1, title: 'One', branch: 'one', url: '', state: 'open', cardId: 'held', checks: [], files: [] } })
    const { done, result } = await waiting()
    const before = state.looked
    for (let i = 0; i < 20; i++) {
      await hub.record(you, { type: 'note.edit', id: 'n1', text: `# First note\n\n${'word '.repeat(i + 1)}\n`, title: 'First note', by: 'you', at })
      await hub.record(hubActor, { type: 'card.activity', id: 'held', activity: line('step', 'a2', { tool: 'Read' }) })
      await hub.record(hubActor, { type: 'card.activity', id: 'held', activity: line('progress', 'a2') })
      await hub.record(hubActor, { type: 'card.update', id: 'held', fields: { progress: i, doing: `Step ${i}` }, activity: line('step', 'a2') })
      await hub.record(hubActor, { type: 'pr.update', id: 'acme/web#1', fields: { checks: [{ name: 'test', state: 'running' }] as never } })
    }
    await sleep(50)
    assert.equal(state.looked, before, 'not one look')
    assert.equal(done.over, false, 'and still waiting')
    // The first card that's ready ends the wait.
    await put(card('next'))
    const found = await result
    assert.equal(found.value?.id, 'next')
    assert(state.looked > before)
    await close()
  })

  it('has a card the moment one becomes ready, whether it was moved there', async () => {
    const { hub, waiting, put, close } = await setUp()
    await put(card('proposed', { stage: 'proposed' }))
    const { result } = await waiting()
    await hub.record(you, { type: 'card.update', id: 'proposed', fields: { stage: 'ready' }, activity: line('moved') })
    assert.equal((await result).value?.id, 'proposed')
    await close()
  })

  it('has a card the moment one is put on the board', async () => {
    const { hub, waiting, close } = await setUp()
    const { result } = await waiting()
    await hub.record(hubActor, { type: 'card.put', card: card('new') })
    assert.equal((await result).value?.id, 'new')
    await close()
  })

  it('has a card another agent let go of', async () => {
    const { hub, waiting, put, close } = await setUp()
    await put(card('taken'))
    await hub.record({ kind: 'agent', id: 'a2' }, { type: 'card.claim', id: 'taken', agentId: 'a2', at })
    const { done, result } = await waiting()
    await sleep(30)
    assert.equal(done.over, false, 'held by the other, so nothing for it')
    await hub.record({ kind: 'agent', id: 'a2' }, { type: 'card.release', id: 'taken', agentId: 'a2', at, why: 'Couldn’t start' })
    const found = await result
    assert.equal(found.value?.id, 'taken')
    assert.equal(found.value?.resume, undefined)
    await close()
  })

  it('has a person’s answer or comment on a card it holds, and not a step', async () => {
    const { hub, state, waiting, put, close } = await setUp()
    await put(card('mine', { stage: 'working', agentId: 'a1' }))
    const { done, result } = await waiting()
    const before = state.looked
    await hub.record(hubActor, { type: 'card.activity', id: 'mine', activity: line('step', 'a1') })
    await sleep(30)
    assert.equal(state.looked, before)
    await hub.record(you, { type: 'card.activity', id: 'mine', activity: line('comment', 'you', { text: 'Use the other one.' }) })
    const found = await result
    assert.equal(found.value?.id, 'mine')
    assert.equal(found.value?.resume, true)
    assert.equal(done.over, true)
    await close()
  })

  it('has a chat message', async () => {
    const { hub, waiting, close } = await setUp()
    const { result } = await waiting({ chats: true })
    await hub.record(you, { type: 'chat.say', id: 'chat1', noteId: 'n1', agentId: 'a1', message: { at, by: 'you', text: 'What is this note about?' } })
    const found = await result
    assert.equal(found.value?.kind, 'chat')
    assert.equal(found.value?.id, 'chat1')
    await close()
  })

  it('has a debrief asked of it, and a Challenge', async () => {
    const { hub, waiting, put, close } = await setUp()
    await put(card('review', { stage: 'review', agentId: 'a2' }))
    const debrief = await waiting({ debriefs: true, cards: false })
    await hub.record(you, { type: 'card.update', id: 'review', fields: { debrief: { state: 'asked', askedBy: 'you', askedAt: at, agentId: 'a1' } }, activity: line('debrief') })
    const found = await debrief.result
    assert.equal(found.value?.kind, 'debrief')
    assert.equal(found.value?.id, 'review')

    await put(card('second', { stage: 'review', agentId: 'a2' }))
    const challenge = await waiting({ challenges: true, cards: false })
    await hub.record(you, { type: 'card.update', id: 'second', fields: { challenge: { state: 'asked', askedBy: 'you', askedAt: at, agentId: 'a1', picked: 'hub', authors: [], findings: [] } as never } })
    const found2 = await challenge.result
    assert.equal(found2.value?.kind, 'challenge')
    assert.equal(found2.value?.id, 'second')
    await close()
  })

  it('has a card handed to it', async () => {
    const { hub, waiting, put, close } = await setUp()
    await put(card('theirs', { meantFor: 'a2' }))
    const { result } = await waiting()
    await hub.record(you, { type: 'card.update', id: 'theirs', fields: { meantFor: 'a1' }, activity: line('moved') })
    assert.equal((await result).value?.id, 'theirs')
    await close()
  })

  it('has a card its binder’s repos now let it take', async () => {
    const { hub, waiting, put, close } = await setUp()
    await hub.record(you, { type: 'agent.put', agent: { ...agent('a1'), repos: ['acme/web'] } })
    await hub.record(you, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/api' } })
    await put(card('web'))
    const { result } = await waiting()
    await hub.record(you, { type: 'binder.put', binder: { id: 'b1', name: 'Server', repo: 'acme/web' } })
    assert.equal((await result).value?.id, 'web')
    await close()
  })

  it('is told, and doesn’t break what announced the change, when it’s revoked while waiting', async () => {
    const { hub, waiting, close } = await setUp()
    const { result } = await waiting()
    await hub.record(hubActor, { type: 'agent.revoke', id: 'a1' })
    const found = await result
    assert.equal(found.error, true)
    assert.match(found.words, /revoked/)
    assert.equal(hub.listenerCount('entries'), 0, 'and has stopped listening')
    await close()
  })
})

describe('what could make work for a waiting agent', () => {
  const changes: [string, Change, boolean][] = [
    ['a note being typed in', { type: 'note.edit', id: 'n1', text: 'x', title: 'x', by: 'you', at }, false],
    ['a note made, moved, linked, locked, saved or deleted', { type: 'note.put', note: { id: 'n2', title: 'x', binderId: 'b1', editedAt: at, editors: [], text: '' } }, false],
    ['a folder', { type: 'folder.put', folder: { id: 'f2', binderId: 'b1', name: 'x' } }, false],
    ['an agent last heard from', { type: 'agent.seen', id: 'a1', at }, false],
    ['a pull request’s checks', { type: 'pr.update', id: 'p', fields: { checks: [] } }, false],
    ['a pull request made', { type: 'pr.put', pull: {} as never }, false],
    ['an environment', { type: 'env.update', id: 'e', fields: {} }, false],
    ['a step on a card', { type: 'card.activity', id: 'c', activity: line('step') }, false],
    ['a line of progress on a card', { type: 'card.activity', id: 'c', activity: line('progress') }, false],
    ['a card’s progress and what it’s doing, with a step', { type: 'card.update', id: 'c', fields: { progress: 3, doing: 'Reading' }, activity: line('step') }, false],
    ['a card’s plan', { type: 'card.update', id: 'c', fields: { plan: [] } }, false],
    ['a card’s words edited', { type: 'card.update', id: 'c', fields: { title: 'x', brief: 'y' } }, false],
    ['a card put', { type: 'card.put', card: card('c') }, true],
    ['a card claimed', { type: 'card.claim', id: 'c', agentId: 'a2', at }, true],
    ['a card released', { type: 'card.release', id: 'c', agentId: 'a2', at, why: 'x' }, true],
    ['a card deleted', { type: 'card.delete', id: 'c' }, true],
    ['a card’s stage', { type: 'card.update', id: 'c', fields: { stage: 'ready' } }, true],
    ['a card’s holder, or who it’s meant for', { type: 'card.update', id: 'c', fields: { meantFor: 'a1' } }, true],
    ['a card’s question', { type: 'card.update', id: 'c', fields: { needsYou: 'Which?' } }, true],
    ['a card’s debrief asked', { type: 'card.update', id: 'c', fields: { debrief: {} as never } }, true],
    ['a card’s Challenge asked', { type: 'card.update', id: 'c', fields: { challenge: {} as never } }, true],
    ['a card’s progress with a person’s comment', { type: 'card.update', id: 'c', fields: { progress: 3 }, activity: line('comment') }, true],
    ['an answer or comment on a card', { type: 'card.activity', id: 'c', activity: line('answer') }, true],
    ['a card moved', { type: 'card.activity', id: 'c', activity: line('moved') }, true],
    ['a card changed with nothing said of what', { type: 'card.update', id: 'c', fields: {} }, true],
    ['a proposal', { type: 'proposal.put', proposal: {} as never }, true],
    ['an agent’s own settings', { type: 'agent.put', agent: agent('a1') }, true],
    ['an agent revoked or deleted', { type: 'agent.revoke', id: 'a1' }, true],
    ['a binder', { type: 'binder.put', binder: { id: 'b1', name: 'x' } }, true],
    ['a chat message', { type: 'chat.say', id: 'c', noteId: 'n', agentId: 'a1', message: { at, by: 'you', text: 'x' } }, true],
    ['a chat’s status', { type: 'chat.status', id: 'c', working: false }, true],
    ['a change set', { type: 'set.update', id: 's', fields: {} }, true],
    ['a debrief’s test result', { type: 'test.result', id: 'c', test: 't', result: null }, true],
    ['a schedule', { type: 'schedule.update', id: 's', fields: {} }, true],
    ['a repo’s brief', { type: 'brief.put', brief: {} as never }, true],
    ['a kind of change from a newer hub', { type: 'something.new' } as never, true],
  ]
  for (const [what, change, counts] of changes) {
    it(`${counts ? 'counts' : 'leaves out'} ${what}`, () => {
      assert.equal(mayMakeWork(change), counts)
    })
  }
})

describe('the next card an agent could take', () => {
  // What nextFor was before it looked at the board once: the answer it has to keep giving.
  const before = (state: Parameters<typeof nextFor>[0], who: Agent, busy: string[]): Card | undefined => {
    const done = new Set(state.cards.filter((c) => c.stage === 'review' || c.stage === 'live').map((c) => c.id))
    const there = new Set(state.cards.map((c) => c.id))
    const split = new Set(state.cards.flatMap((c) => (c.parent ? [c.parent] : [])))
    return state.cards
      .filter((c) => c.stage === 'ready' && !c.agentId && !busy.includes(c.id) && !split.has(c.id))
      .filter((c) => mayTake(state, who, c))
      .filter((c) => c.waitsFor.every((w) => done.has(w) || !there.has(w)))
      .sort((a, b) => Number(b.meantFor === who.id) - Number(a.meantFor === who.id) || a.createdAt.localeCompare(b.createdAt))[0]
  }

  it('is the same card as before on a few hundred boards of every mix', () => {
    let seedValue = 7
    const random = (n: number) => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648
      return seedValue % n
    }
    const stages: Stage[] = ['proposed', 'ready', 'ready', 'ready', 'working', 'blocked', 'review', 'live']
    for (let round = 0; round < 300; round++) {
      const count = 1 + random(25)
      const ids = Array.from({ length: count }, (_, i) => `c${i}`)
      const cards = ids.map((id, i) => card(id, {
        stage: stages[random(stages.length)],
        agentId: random(5) === 0 ? 'a2' : undefined,
        meantFor: random(4) === 0 ? ['a1', 'a2', 'gone'][random(3)] : undefined,
        binderId: random(6) === 0 ? 'b2' : 'b1',
        createdAt: `2026-11-0${1 + random(9)}T10:00:00.000Z`,
        waitsFor: Array.from({ length: random(3) }, () => (random(5) === 0 ? 'nowhere' : ids[random(count)])),
        parent: i > 0 && random(5) === 0 ? ids[random(i)] : undefined,
        distillRule: random(10) === 0 ? 'r' : undefined,
      }))
      const state = { ...{ agents: [agent('a1'), agent('a2')], proposals: [], pulls: [], changeSets: [], environments: [], runs: [], chats: [] }, cards, binders: [{ id: 'b1', name: 'One' }, { id: 'b2', name: 'Two' }] }
      const busy = random(3) === 0 ? [ids[random(count)]] : []
      assert.equal(nextFor(state, agent('a1'), busy)?.id, before(state, agent('a1'), busy)?.id, `round ${round}`)
    }
  })
})
