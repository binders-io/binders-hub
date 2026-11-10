import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Actions } from '../src/actions.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { EndpointAgents, endpointRules, whatsWrongWithEndpoint } from '../src/agent/endpoint.ts'
import type { LoopTurn, Step, StepModel, ToolSpec } from '../../shared/agent.ts'
import type { AgentEndpoint } from '../../shared/work.ts'
import { note, seed, until } from './helpers.ts'

const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input })
const says = (text: string): Step => ({ text, calls: [], stop: 'end' })
const wants = (...calls: ReturnType<typeof call>[]): Step => ({ text: '', calls, stop: 'tools' })
const everything = { cards: true, chats: true, debriefs: true, challenges: true }
const foundry: AgentEndpoint = { kind: 'openai', baseUrl: 'https://acme.openai.azure.com/openai/v1', model: 'gpt-deploy', takes: everything }

/** A model that plays a script once for each piece of work it's given, and keeps what it was asked. */
function scripted() {
  const asked: { system: string; turns: LoopTurn[]; tools: ToolSpec[] }[] = []
  let play: (turns: LoopTurn[], n: number) => Step = () => says('Nothing to do.')
  let n = 0
  const model: StepModel = {
    label: 'scripted',
    step: async (input) => {
      asked.push({ system: input.system, turns: structuredClone(input.turns), tools: input.tools })
      // A new piece of work starts with one turn: the count begins again.
      if (input.turns.length === 1) n = 0
      return play(input.turns, n++)
    },
  }
  return { model, asked, plays: (next: typeof play) => { play = next } }
}

async function setUp(endpoint: AgentEndpoint = foundry, options: { steps?: number } = {}) {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const actions = new Actions(hub, new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {}))
  const settings = await new BrainSettingsStore(new MemoryKV(), sealer, {}).load()
  const script = scripted()
  const endpoints = new EndpointAgents({ hub, actions, kv, sealer, brain: settings, model: () => script.model, waitSeconds: 1, againMs: 10, limits: options.steps ? { steps: options.steps } : {} })
  const agent = await actions.putAgent('ana', { name: 'Foundry', provider: 'other', repos: [], binders: [], skills: [], runsOn: 'This hub', endpoint })
  endpoints.start()
  const cardNow = (id: string) => hub.state.cards.find((c) => c.id === id)!
  return { hub, kv, actions, endpoints, agent, cardNow, ...script, close: () => endpoints.stop() }
}

describe('an agent that is a model, run by the hub', () => {
  it('takes a card given to it by name, does it through the hub’s tools, and finishes it', async () => {
    const set = await setUp()
    try {
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Write a welcome note', brief: 'A short note welcoming new people.', stage: 'ready', meantFor: set.agent.id })
      set.plays((_turns, n) => [
        wants(call('c1', 'claim_task', { id: card.id })),
        wants(call('c2', 'create_note', { binder: 'b1', text: '# Welcome\n\nGlad you’re here.\n' })),
        wants(call('c3', 'complete_task', { id: card.id, summary: 'Wrote the note “Welcome”.' })),
        says('Done.'),
      ][n] ?? says('Done.'))
      await until(() => set.cardNow(card.id).stage === 'live')
      assert.ok(set.hub.state.notes.some((n) => n.title === 'Welcome'), 'the note it wrote is there')
      assert.equal(set.cardNow(card.id).activity.some((a) => a.kind === 'completed' && /Wrote the note/.test(a.text ?? '')), true)
      const [first] = set.asked
      assert.ok(first.system.includes(endpointRules))
      assert.match(first.system, /wait_for_work \(or list_tasks\) finds a card/, 'told what every agent is told')
      const offered = (first.turns[0] as Extract<LoopTurn, { role: 'user' }>).text
      assert.match(offered, /^This card is meant for you\. Take it with claim_task/)
      assert.ok(offered.includes(card.id))
      const names = first.tools.map((tool) => tool.name)
      for (const tool of ['claim_task', 'get_note', 'create_note', 'propose_work_items', 'complete_task', 'release_task', 'chat_reply', 'send_debrief', 'send_challenge']) assert.ok(names.includes(tool), tool)
      for (const tool of ['wait_for_work', 'repo_token', 'create_agent', 'report_diff', 'ask_permission', 'assign_task', 'message_agent']) assert.ok(!names.includes(tool), `not given ${tool}`)
    } finally {
      await set.close()
    }
  })

  it('distills a note when a folder’s rule names it: reads the note, proposes its work items, and finishes', async () => {
    const set = await setUp()
    try {
      await set.actions.setFolderRule('ana', 'f1', { distill: true, agentId: set.agent.id, quietMinutes: 1 })
      await set.hub.record({ kind: 'user', login: 'ana' }, { type: 'note.put', note: note('plan', 'Annual plans', { folderId: 'f1', editedAt: new Date().toISOString(), text: '# Annual plans\n\nShow the saving on the receipt. Email a reminder 30 days before renewal.\n' }) })
      set.plays((turns, n) => {
        const id = /"id":\s*"([^"]+)"/.exec((turns[0] as Extract<LoopTurn, { role: 'user' }>).text)?.[1] ?? ''
        return [
          wants(call('c1', 'claim_task', { id })),
          wants(call('c2', 'get_note', { id: 'plan' })),
          wants(call('c3', 'propose_work_items', { note: 'plan', items: [{ title: 'Show the saving on the receipt', quote: 'Show the saving on the receipt.', size: 'S' }, { title: 'Renewal reminder', quote: 'Email a reminder 30 days before renewal.', size: 'M' }] })),
          wants(call('c4', 'complete_task', { id, summary: 'Proposed two work items.' })),
          says('Done.'),
        ][n] ?? says('Done.')
      })
      await set.actions.distillDue(new Date(Date.now() + 3 * 60_000))
      await until(() => set.hub.state.proposals.filter((p) => p.noteId === 'plan').length === 2)
      assert.deepEqual(set.hub.state.proposals.filter((p) => p.noteId === 'plan').map((p) => [p.title, p.size, p.by]), [['Show the saving on the receipt', 'S', set.agent.id], ['Renewal reminder', 'M', set.agent.id]])
      await until(() => set.hub.state.cards.some((c) => c.distillRule && c.stage === 'live'))
      // What it read came back to it as material: the note's words were in a tool's result, not in its instructions.
      const read = set.asked.flatMap((a) => a.turns.flatMap((turn) => (turn.role === 'tool' ? turn.results.map((r) => r.text) : []))).join('\n')
      assert.match(read, /Show the saving on the receipt/)
    } finally {
      await set.close()
    }
  })

  it('leaves a card that’s open to anyone alone: it has no machine, and such a card is usually code', async () => {
    const set = await setUp()
    try {
      const open = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Fix the login page', stage: 'ready' })
      const mine = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Tidy the notes', stage: 'ready', meantFor: set.agent.id })
      set.plays((turns, n) => {
        const id = /"id":\s*"([^"]+)"/.exec((turns[0] as Extract<LoopTurn, { role: 'user' }>).text)?.[1] ?? ''
        return [wants(call('c1', 'claim_task', { id })), wants(call('c2', 'complete_task', { id, summary: 'Tidied.' })), says('Done.')][n] ?? says('Done.')
      })
      await until(() => set.cardNow(mine.id).stage === 'live')
      assert.equal(set.cardNow(open.id).stage, 'ready')
      assert.equal(set.cardNow(open.id).agentId, undefined)
      assert.equal(set.asked.every((a) => !(a.turns[0] as Extract<LoopTurn, { role: 'user' }>).text.includes(open.id)), true, 'it was never shown to the model')
    } finally {
      await set.close()
    }
  })

  it('puts a card back, saying why, when it runs out of room or stops half way', async () => {
    const set = await setUp(foundry, { steps: 2 })
    try {
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Rewrite every note', stage: 'ready', meantFor: set.agent.id })
      set.plays((_turns, n) => (n === 0 ? wants(call('c1', 'claim_task', { id: card.id })) : n === 1 ? wants(call('c2', 'list_notes', {})) : says('Still going.')))
      await until(() => set.cardNow(card.id).activity.some((a) => /ran out of room/.test(a.text ?? '')))
      assert.equal(set.cardNow(card.id).agentId, undefined, 'nobody holds it')
      assert.notEqual(set.cardNow(card.id).stage, 'working')
      // It isn't taken again by the same run: a person has it from here.
      const asked = set.asked.length
      await new Promise((done) => setTimeout(done, 1500))
      assert.equal(set.asked.length, asked)
    } finally {
      await set.close()
    }
  })

  it('leaves a card it asked a person about waiting for the answer', async () => {
    const set = await setUp()
    try {
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Name the release', stage: 'ready', meantFor: set.agent.id })
      set.plays((_turns, n) => [wants(call('c1', 'claim_task', { id: card.id })), wants(call('c2', 'ask', { id: card.id, question: 'Which name: Aurora or Borealis?' })), says('Asked.')][n] ?? says('Asked.'))
      await until(() => !!set.cardNow(card.id).needsYou)
      assert.equal(set.cardNow(card.id).needsYou, 'Which name: Aurora or Borealis?')
      assert.equal(set.cardNow(card.id).agentId, set.agent.id, 'it still holds the card')
    } finally {
      await set.close()
    }
  })

  it('takes none of what it was set not to take', async () => {
    const set = await setUp({ ...foundry, takes: { ...everything, cards: false } })
    try {
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Tidy the notes', stage: 'ready', meantFor: set.agent.id })
      await new Promise((done) => setTimeout(done, 1500))
      assert.equal(set.cardNow(card.id).stage, 'ready')
      assert.equal(set.asked.length, 0)
    } finally {
      await set.close()
    }
  })

  it('stops when it’s revoked, and starts for one added while the hub runs', async () => {
    const set = await setUp()
    try {
      await set.hub.record({ kind: 'user', login: 'ana' }, { type: 'agent.revoke', id: set.agent.id })
      const gone = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'For the one that left', stage: 'ready', meantFor: set.agent.id })
      const later = await set.actions.putAgent('ana', { name: 'Second', provider: 'other', repos: [], binders: [], skills: [], endpoint: foundry })
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'For the new one', stage: 'ready', meantFor: later.id })
      set.plays((_turns, n) => [wants(call('c1', 'claim_task', { id: card.id })), wants(call('c2', 'complete_task', { id: card.id, summary: 'Done.' })), says('Done.')][n] ?? says('Done.'))
      await until(() => set.cardNow(card.id).stage === 'live')
      assert.equal(set.cardNow(gone.id).stage, 'ready')
    } finally {
      await set.close()
    }
  })
})

describe('an endpoint, as a person gives it', () => {
  it('is the hub’s own model, an OpenAI-style server, or Claude, and nothing else', () => {
    assert.equal(whatsWrongWithEndpoint({ kind: 'brain' }), undefined)
    assert.equal(whatsWrongWithEndpoint(foundry), undefined)
    assert.equal(whatsWrongWithEndpoint({ kind: 'anthropic', model: 'claude-opus-5-5' }), undefined, 'Anthropic’s own address needs no address')
    assert.equal(whatsWrongWithEndpoint({ kind: 'anthropic', model: 'my-claude', baseUrl: 'https://acme.services.ai.azure.com/anthropic' }), undefined)
    assert.match(whatsWrongWithEndpoint({ kind: 'webhook' as never })!, /Say what it is/)
    assert.match(whatsWrongWithEndpoint({ kind: 'openai', baseUrl: 'https://acme.openai.azure.com/openai/v1' })!, /which model, or which deployment/)
    assert.match(whatsWrongWithEndpoint({ kind: 'openai', model: 'gpt' })!, /isn’t a web address/)
  })

  it('is over https when it’s out on the internet, and on the hub’s own machine or network only for a hub admin', () => {
    assert.match(whatsWrongWithEndpoint({ kind: 'openai', model: 'm', baseUrl: 'http://acme.openai.azure.com/openai/v1' })!, /https/)
    for (const address of ['https://127.0.0.1:8080/v1', 'http://127.0.0.1:8000', 'https://169.254.169.254/v1', 'http://10.0.0.5:1234/v1']) {
      assert.match(whatsWrongWithEndpoint({ kind: 'openai', model: 'm', baseUrl: address })!, /own machine or network, which only a hub admin/, address)
      assert.equal(whatsWrongWithEndpoint({ kind: 'openai', model: 'm', baseUrl: address }, { ownNetwork: true }), undefined, address)
    }
    assert.match(whatsWrongWithEndpoint({ kind: 'anthropic', model: 'm', baseUrl: 'https://10.0.0.5/anthropic' })!, /own machine or network/)
    // A hub admin's word covers the hub's own network, never plain http out on the internet.
    assert.match(whatsWrongWithEndpoint({ kind: 'openai', model: 'm', baseUrl: 'http://models.example.com/v1' }, { ownNetwork: true })!, /https/)
    assert.match(whatsWrongWithEndpoint({ kind: 'openai', model: 'm', baseUrl: 'http://user:pass@127.0.0.1:8000' }, { ownNetwork: true })!, /name or password/)
  })
})

describe('an agent’s key', () => {
  it('is kept sealed in the Binder’s own store, and never in the state', async () => {
    const set = await setUp()
    try {
      await set.endpoints.setKey(set.agent.id, '  az-key-123  ')
      assert.equal(await set.endpoints.keyFor(set.agent.id), 'az-key-123')
      const kept = await set.kv.get(`endpoint-key:${set.agent.id}`)
      assert.ok(kept && !kept.includes('az-key-123'), 'sealed, not as it was typed')
      assert.ok(!JSON.stringify(set.hub.state).includes('az-key-123'))
      await set.endpoints.setKey(set.agent.id, undefined)
      assert.equal(await set.endpoints.keyFor(set.agent.id), undefined)
    } finally {
      await set.close()
    }
  })
})

describe('an agent on a machine that has a model', () => {
  it('is left to its runner: the hub lends it its model, and takes none of its work', async () => {
    const set = await setUp()
    try {
      const onMachine = await set.actions.putAgent('ana', { name: 'On a machine', provider: 'other', repos: [], binders: [], skills: [], runner: { tool: 'binders', access: 'full', timeoutMinutes: 60, worktrees: true }, endpoint: foundry })
      const card = await set.actions.createCard({ kind: 'user', login: 'ana' }, { binderId: 'b1', title: 'Fix the header', stage: 'ready', meantFor: onMachine.id })
      set.plays(() => says('Nothing to do.'))
      await new Promise((done) => setTimeout(done, 400))
      assert.equal(set.cardNow(card.id).stage, 'ready', 'still waiting for its runner')
      assert.equal(set.asked.length, 0, 'its model was asked nothing')
    } finally {
      await set.close()
    }
  })
})
