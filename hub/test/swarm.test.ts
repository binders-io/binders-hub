import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Actions } from '../src/actions.ts'
import { Hub } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { nextFor, type Agent, type Card, type Stage } from '../../shared/work.ts'

// A swarm: one card split into parts, each part a card of its own for the agent it names, the card waiting for every
// part and done when they all are.

const actor = { kind: 'user' as const, login: 'you' }
const find = (hub: Hub, id: string): Card | undefined => hub.state.cards.find((c) => c.id === id)
const agent: Agent = { id: 'a1', name: 'One', provider: 'other', owner: 'you', repos: [], binders: [], skills: [], createdAt: new Date().toISOString() }

async function swarm() {
  const hub = new Hub(new MemoryLog())
  await hub.start([{ type: 'binder.put', binder: { id: 'b1', name: 'T' } }, { type: 'agent.put', agent }])
  const github = { forRepo: async () => undefined, asUser: () => undefined }
  const actions = new Actions(hub, github as never)
  actions.watchSwarm()
  const parent = await actions.createCard(actor, { binderId: 'b1', title: 'The sign-out page', brief: 'Sign-out, everywhere it appears.', doneWhen: 'It signs out.' })
  const move = (id: string, stage: Stage, fields: Partial<Card> = {}) =>
    hub.record({ kind: 'hub' }, { type: 'card.update', id, fields: { stage, ...fields }, activity: { at: new Date().toISOString(), by: 'hub', kind: 'moved', text: stage } })
  return { hub, actions, parent, move }
}

describe('a card split for a swarm', () => {
  it('makes each part a card that names its parent, and the parent waits for them', async () => {
    const { hub, actions, parent } = await swarm()
    const parts = await actions.splitCard('you', parent.id, [
      { title: 'The button in the header' },
      { title: 'The endpoint', brief: 'POST /signout' },
      { title: 'The tests' },
    ])
    assert.equal(parts.length, 3)
    for (const part of parts) {
      const one = find(hub, part.id)
      assert.equal(one?.parent, parent.id)
      assert.equal(one?.stage, 'ready')
    }
    const stored = find(hub, parent.id)
    assert.deepEqual(stored?.waitsFor.slice(-3), parts.map((p) => p.id))
    assert(stored?.activity.some((a) => a.text === 'Split into 3 parts'))
  })

  it('gives each part the whole card’s brief, its note, and what the card was waiting for', async () => {
    const { hub, actions, parent } = await swarm()
    const before = await actions.createCard(actor, { binderId: 'b1', title: 'First, the schema' })
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: parent.id, fields: { waitsFor: [before.id], noteId: 'note-1' } })
    const [bare, own] = await actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B', brief: 'Only the endpoint.' }])
    assert.match(find(hub, bare.id)!.brief, /part of “The sign-out page”/)
    assert.match(find(hub, bare.id)!.brief, /Sign-out, everywhere it appears\./)
    assert.match(find(hub, bare.id)!.brief, /It signs out\./)
    assert.match(find(hub, own.id)!.brief, /^Only the endpoint\.\n\n/)
    assert.match(find(hub, own.id)!.brief, /Sign-out, everywhere it appears\./)
    assert.deepEqual(find(hub, bare.id)!.waitsFor, [before.id])
    assert.equal(find(hub, bare.id)!.noteId, 'note-1')
    // Nothing starts before what the whole was waiting for.
    assert.equal(nextFor(hub.state, agent)?.id, before.id)
  })

  it('refuses a part of a part and a second split', async () => {
    const { actions, parent } = await swarm()
    const [one] = await actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B' }])
    await assert.rejects(() => actions.splitCard('you', parent.id, [{ title: 'C' }, { title: 'D' }]), /parts already/)
    await assert.rejects(() => actions.splitCard('you', one!.id, [{ title: 'X' }, { title: 'Y' }]), /part of a swarm/)
  })

  it('refuses one part, and an agent that isn’t', async () => {
    const { actions, parent } = await swarm()
    await assert.rejects(() => actions.splitCard('you', parent.id, [{ title: 'Only' }, { title: '' }]), /at least two/)
    await assert.rejects(() => actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B', agent: 'ghost' }]), /No agent ghost/)
  })

  for (const stage of ['proposed', 'working', 'blocked', 'review', 'live'] as const) {
    it(`refuses to split a card that’s ${stage}`, async () => {
      const { hub, actions, parent, move } = await swarm()
      await move(parent.id, stage)
      await assert.rejects(() => actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B' }]), /Only a card that’s ready/)
      assert.equal(hub.state.cards.length, 1)
    })
  }

  it('never offers the whole card while it has parts, even with every part in review', async () => {
    const { hub, actions, parent, move } = await swarm()
    const parts = await actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B' }])
    assert.ok(parts.some((p) => p.id === nextFor(hub.state, agent)?.id))
    for (const part of parts) await move(part.id, 'review')
    assert.equal(nextFor(hub.state, agent), undefined)
    await assert.rejects(() => actions.claim(agent.id, parent.id), /split into parts/)
  })

  it('finishes the parent with its last part, once', async () => {
    const { hub, actions, parent, move } = await swarm()
    const parts = await actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B' }])
    await move(parts[0].id, 'live')
    await sleep(30)
    assert.equal(find(hub, parent.id)?.stage, 'ready')
    await move(parts[1].id, 'live')
    for (let at = 0; at < 100 && find(hub, parent.id)?.stage !== 'live'; at++) await sleep(10)
    assert.equal(find(hub, parent.id)?.stage, 'live')
    await sleep(30)
    assert.equal(find(hub, parent.id)?.activity.filter((a) => a.text === 'Every part is live: 2 parts').length, 1)
  })

  it('finishes the parent when the last part still going is deleted', async () => {
    const { hub, actions, parent, move } = await swarm()
    const parts = await actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B' }])
    await move(parts[0].id, 'live')
    await hub.record(actor, { type: 'card.delete', id: parts[1].id })
    for (let at = 0; at < 100 && find(hub, parent.id)?.stage !== 'live'; at++) await sleep(10)
    assert.equal(find(hub, parent.id)?.stage, 'live')
  })

  it('offers the whole card again if every part is deleted', async () => {
    const { hub, actions, parent } = await swarm()
    const parts = await actions.splitCard('you', parent.id, [{ title: 'A' }, { title: 'B' }])
    for (const part of parts) await hub.record(actor, { type: 'card.delete', id: part.id })
    await sleep(20)
    assert.equal(find(hub, parent.id)?.stage, 'ready')
    assert.equal(nextFor(hub.state, agent)?.id, parent.id)
  })
})
