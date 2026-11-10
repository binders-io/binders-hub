import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Actions } from '../src/actions.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { SpaceBrain } from '../src/brain/brain.ts'
import { askAgainAfterMs, askOf, draftsPerLook, FirstAnswers, firstRules, gather, passes, readDraft, waitsOnPerson } from '../src/brain/first.ts'
import type { BrainModel, Passage } from '../src/brain/models.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card } from '../../shared/work.ts'
import { note, seed } from './helpers.ts'

const at = '2026-11-08T10:00:00.000Z'
const agent: Agent = { id: 'a1', name: 'Sonnet', owner: 'you', binders: ['b1'], repos: [], lastSeen: new Date().toISOString() } as unknown as Agent
const card = (id: string, title: string, fields: Partial<Card> = {}): Card => ({ id, title, binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'working', agentId: 'a1', waitsFor: [], activity: [], updatedAt: at, ...fields } as Card)
const asking = (id: string, title: string, question: string, fields: Partial<Card> = {}) => card(id, title, { stage: 'blocked', needsYou: question, ...fields })
const stopped = (id: string, why: string, times = 1) => card(id, `Stopped ${id}`, { stage: 'blocked', agentId: undefined, stopped: { why, at, times } })

const work: Change[] = [
  { type: 'agent.put', agent } as Change,
  { type: 'note.put', note: note('conventions', 'How we build', { text: '# How we build\n\nWe use pnpm, never npm. Beta customers keep their 20% discount on annual plans until March.\n' }) },
  { type: 'card.put', card: asking('beta', 'Annual price for the beta customers', 'Do beta customers keep their 20% discount on annual plans?', { brief: 'Work out the annual price for customers in the beta.' }) },
]

async function setUp(more: Change[] = []) {
  const hub = new Hub(new MemoryLog())
  await hub.start([...seed(), ...work, ...more])
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const seen: { question: string; passages: Passage[]; more?: string }[] = []
  let reply: (passages: Passage[]) => { text: string; cites?: string[] } = () => ({ text: 'YOURS\nNothing here says.' })
  /** What the model waits for before it answers: nothing, unless a test holds it. */
  let held: Promise<void> = Promise.resolve()
  const hold = () => {
    let release = () => {}
    held = new Promise<void>((done) => { release = done })
    return release
  }
  const model: BrainModel = {
    label: 'scripted',
    summarize: async () => ({ title: '', summary: '', points: [], decisions: [], followUps: [] }),
    answer: async (question, passages, more) => {
      seen.push({ question, passages, more })
      await held
      const said = reply(passages)
      // It cites documents by their titles here, as a real model does by their place.
      const sources = (said.cites ?? []).map((title) => passages.findIndex((p) => p.title === title)).filter((n) => n >= 0)
      return { text: said.text, parts: [{ text: said.text, sources }] }
    },
    talk: async () => '',
    sortMoment: async () => ({ kind: 'none', title: '' }),
  }
  settings.useForTests(model)
  const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
  brain.start()
  await brain.caughtUp()
  let now = Date.parse('2026-11-10T09:00:00.000Z')
  const first = new FirstAnswers({ hub, settings, kv, place: () => ({ id: 'test', name: 'Server', brain, url: () => '' }), now: () => now })
  const said: string[] = []
  hub.on('first', (cardId: string) => said.push(cardId))
  const actions = new Actions(hub, new GitHubConnection(new MemoryKV(), sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {}))
  /** Looks, lets what was started finish, and looks again: what a page sees once the drafts are ready. */
  const ready = async () => {
    await first.look()
    await first.settled()
    return first.look()
  }
  return { hub, first, settings, seen, said, actions, ready, hold, says: (next: typeof reply) => { reply = next }, later: (ms: number) => { now += ms }, close: () => { first.stop(); brain.stop() } }
}

describe('what stopped a card', () => {
  it('reads as passing when a provider was busy, a connection dropped or something timed out, and not otherwise', () => {
    for (const why of ['Anthropic is busy: rate limit reached', 'HTTP 429 Too Many Requests', 'The model is overloaded', 'Request timed out after 120 s', 'ECONNRESET', 'socket hang up', '503 Service Unavailable', 'The network was unreachable', 'Temporary failure, try again']) assert.equal(passes(why), true, why)
    for (const why of ['The tests failed: 3 of 40', 'It went quiet for 20 minutes', 'It has no permission to push', 'A merge conflict in src/app.ts', '']) assert.equal(passes(why), false, why)
  })
})

describe('a model’s draft, read', () => {
  it('takes its first line for what kind it is, however it was dressed', () => {
    assert.deepEqual(readDraft('FACT\nUse pnpm.'), { kind: 'answer', words: 'Use pnpm.' })
    assert.deepEqual(readDraft('**FACT**: Use pnpm.'), { kind: 'answer', words: 'Use pnpm.' })
    assert.deepEqual(readDraft('  yours\n\nIt’s a choice between two regions.'), { kind: 'yours', words: 'It’s a choice between two regions.' })
    assert.deepEqual(readDraft('> YOURS - Nothing says.'), { kind: 'yours', words: 'Nothing says.' })
  })

  it('is nothing without that line, or with nothing after it', () => {
    assert.equal(readDraft('Use pnpm.'), undefined)
    assert.equal(readDraft('FACT'), undefined)
    assert.equal(readDraft('FACTS are stubborn things.'), undefined)
    assert.equal(readDraft(''), undefined)
  })
})

describe('cards that wait for the same thing', () => {
  const notes = [{ id: 'n-rebrand', title: 'Website rebrand' }]

  it('gathers the same question, whatever its case and punctuation', () => {
    const cards = [asking('a', 'A', 'Which package manager do we use?'), asking('b', 'B', 'which package manager do we use'), asking('c', 'C', 'Which region?')]
    assert.deepEqual(gather({ cards, notes }), [{ key: gather({ cards, notes })[0].key, why: 'question', title: 'Which package manager do we use?', cards: ['a', 'b'] }])
  })

  it('gathers three or more from one note, and leaves two alone', () => {
    const from = (id: string, noteId: string) => asking(id, id, `A question only ${id} asks, about its own part`, { noteId })
    const cards = [from('a', 'n-rebrand'), from('b', 'n-rebrand'), from('c', 'n-rebrand'), from('d', 'n-other'), from('e', 'n-other')]
    assert.deepEqual(gather({ cards, notes }), [{ key: 'note:n-rebrand', why: 'note', title: 'Website rebrand', cards: ['a', 'b', 'c'] }])
  })

  it('puts a card in one group, the question’s first, and counts only cards that wait', () => {
    const cards = [
      asking('a', 'A', 'Light or dark first?', { noteId: 'n-rebrand' }), asking('b', 'B', 'Light or dark first?', { noteId: 'n-rebrand' }),
      asking('c', 'C', 'Something of its own to ask', { noteId: 'n-rebrand' }), asking('d', 'D', 'Another thing of its own', { noteId: 'n-rebrand' }),
      card('working', 'Not waiting', { noteId: 'n-rebrand' }),
    ]
    const groups = gather({ cards, notes })
    assert.deepEqual(groups.map((g) => [g.why, g.cards]), [['question', ['a', 'b']]], 'two left from the note aren’t enough for a group of their own')
    assert.equal(waitsOnPerson(cards[4]), false)
  })
})

describe('the Brain’s first look at what waits on a person', () => {
  it('drafts an answer to an agent’s question from the Binder’s notes, and says where it’s from', async () => {
    const set = await setUp()
    try {
      set.says(() => ({ text: 'FACT\nYes. Beta customers keep their 20% discount on annual plans until March.', cites: ['How we build'] }))
      assert.deepEqual(await set.first.look(), { drafts: [], gathered: [] }, 'the first look starts the draft and doesn’t wait for it')
      await set.first.settled()
      const { drafts } = await set.first.look()
      assert.deepEqual(drafts.map((d) => ({ ...d, for: 'x' })), [{ card: 'beta', for: 'x', kind: 'answer', words: 'Yes. Beta customers keep their 20% discount on annual plans until March.', sources: [{ kind: 'note', id: 'conventions', title: 'How we build' }], at: '2026-11-10T09:00:00.000Z', model: 'scripted' }])
      assert.deepEqual(set.said, ['beta'], 'the hub says when the draft is ready')
      assert.equal(set.hub.state.cards.find((c) => c.id === 'beta')!.needsYou, 'Do beta customers keep their 20% discount on annual plans?', 'nothing was sent: the card still waits')
    } finally {
      set.close()
    }
  })

  it('gives the model the card first, then what it found, with its rules, and not the card twice', async () => {
    const set = await setUp()
    try {
      await set.ready()
      const [asked] = set.seen
      assert.equal(asked.question, 'Sonnet asks, on the card “Annual price for the beta customers”: Do beta customers keep their 20% discount on annual plans?')
      assert.equal(asked.more, firstRules)
      assert.equal(asked.passages[0].title, 'The card “Annual price for the beta customers”')
      assert.match(asked.passages[0].text, /Work out the annual price/)
      assert.ok(asked.passages.some((p) => p.title === 'How we build'))
      assert.equal(asked.passages.filter((p) => p.title === 'Annual price for the beta customers').length, 0)
    } finally {
      set.close()
    }
  })

  it('calls it the person’s when the model says so, and when an answer rests on nothing but the card itself', async () => {
    const set = await setUp([{ type: 'card.put', card: asking('region', 'Move the database', 'Which region should it go to?') }])
    try {
      set.says((passages) => (passages[0].title.includes('Move the database') ? { text: 'YOURS\nIt’s a choice between regions, and nothing here names one.' } : { text: 'FACT\nYes, they keep it.', cites: ['The card “Annual price for the beta customers”'] }))
      const { drafts } = await set.ready()
      assert.deepEqual(drafts.map((d) => [d.card, d.kind, d.sources.length]).sort(), [['beta', 'yours', 0], ['region', 'yours', 0]])
      assert.equal(drafts.find((d) => d.card === 'region')!.words, 'It’s a choice between regions, and nothing here names one.')
    } finally {
      set.close()
    }
  })

  it('keeps nothing from a model that doesn’t say which it is', async () => {
    const set = await setUp()
    try {
      set.says(() => ({ text: 'Probably yes, I would think.', cites: ['How we build'] }))
      assert.deepEqual((await set.ready()).drafts, [])
    } finally {
      set.close()
    }
  })

  it('says another try may pass for a card stopped on something that passes, without asking a model', async () => {
    const set = await setUp([{ type: 'card.put', card: stopped('busy', 'Anthropic is busy: rate limit reached') }, { type: 'card.put', card: stopped('red', 'The tests failed: 3 of 40') }, { type: 'card.put', card: stopped('thrice', 'Request timed out', 3) }])
    try {
      set.says(() => ({ text: 'YOURS\nNothing says.' }))
      const { drafts } = await set.ready()
      assert.deepEqual(drafts.filter((d) => d.card !== 'beta').map((d) => [d.card, d.kind, d.words]), [['busy', 'again', 'It stopped on something that often passes on another try: Anthropic is busy: rate limit reached']])
      assert.equal(set.seen.length, 1, 'only the question went to the model')
    } finally {
      set.close()
    }
  })

  it('drops a draft when the card asks something else, and drafts for the new question', async () => {
    const set = await setUp()
    try {
      set.says(() => ({ text: 'FACT\nYes, until March.', cites: ['How we build'] }))
      assert.equal((await set.ready()).drafts.length, 1)
      const before = askOf(set.hub.state.cards.find((c) => c.id === 'beta')!)
      await set.hub.record({ kind: 'agent', id: 'a1' }, { type: 'card.update', id: 'beta', fields: { needsYou: 'Which package manager do we use?' } })
      assert.notEqual(askOf(set.hub.state.cards.find((c) => c.id === 'beta')!), before)
      set.says(() => ({ text: 'FACT\npnpm, never npm.', cites: ['How we build'] }))
      assert.deepEqual((await set.first.look()).drafts, [], 'the old answer isn’t shown for the new question')
      await set.first.settled()
      assert.deepEqual((await set.first.look()).drafts.map((d) => d.words), ['pnpm, never npm.'])
    } finally {
      set.close()
    }
  })

  it('keeps no draft for a card answered while the model was reading', async () => {
    const set = await setUp()
    try {
      set.says(() => ({ text: 'FACT\nYes, until March.', cites: ['How we build'] }))
      const release = set.hold()
      await set.first.look()
      await set.actions.comment('you', 'beta', 'Yes, keep it.')
      release()
      await set.first.settled()
      assert.deepEqual(await set.first.look(), { drafts: [], gathered: [] })
      assert.deepEqual(set.said, [])
    } finally {
      set.close()
    }
  })

  it('drafts nothing with no model, and still says what may pass on another try', async () => {
    const set = await setUp([{ type: 'card.put', card: stopped('busy', 'socket hang up') }])
    try {
      set.settings.useForTests(undefined)
      assert.deepEqual((await set.ready()).drafts.map((d) => [d.card, d.kind]), [['busy', 'again']])
    } finally {
      set.close()
    }
  })

  it('asks no model when the hub’s admins have turned the drafts off, and still reads a stop', async () => {
    const set = await setUp([{ type: 'card.put', card: stopped('busy', 'HTTP 429 Too Many Requests') }])
    try {
      await set.settings.set({ first: false })
      set.says(() => ({ text: 'FACT\nYes, until March.', cites: ['How we build'] }))
      assert.deepEqual((await set.ready()).drafts.map((d) => [d.card, d.kind]), [['busy', 'again']])
      assert.equal(set.seen.length, 0)
      await set.settings.set({ first: true })
      assert.deepEqual((await set.ready()).drafts.map((d) => d.kind).sort(), ['again', 'answer'])
    } finally {
      set.close()
    }
  })

  it('starts only a few at a look, and the rest at the next', async () => {
    const many = Array.from({ length: draftsPerLook + 3 }, (_x, i): Change => ({ type: 'card.put', card: asking(`q${i}`, `Card ${i}`, `What about part ${i} of the plan, exactly?`) }))
    const set = await setUp(many)
    try {
      set.says(() => ({ text: 'YOURS\nNothing says.' }))
      await set.first.look()
      await set.first.settled()
      assert.equal(set.seen.length, draftsPerLook)
      await set.first.look()
      await set.first.settled()
      assert.equal(set.seen.length, draftsPerLook + 4, 'the three that were left, and the first card')
      assert.equal((await set.first.look()).drafts.length, draftsPerLook + 4)
    } finally {
      set.close()
    }
  })

  it('asks again about what was the person’s to decide once a note has been written since, and not in a loop', async () => {
    const set = await setUp()
    const heard = (id: string, words: string) => set.hub.record({ kind: 'hub' }, { type: 'note.put', note: note(id, `Heard ${id}`, { text: `# Heard ${id}\n\n${words}\n` }) })
    try {
      set.says(() => ({ text: 'YOURS\nNothing here says.' }))
      assert.deepEqual((await set.ready()).drafts.map((d) => d.kind), ['yours'])
      set.later(askAgainAfterMs + 1)
      assert.equal((await set.ready()).drafts.length, 1)
      assert.equal(set.seen.length, 1, 'with no note written since, what was said stands')

      // A note arrives that doesn't help: it's read, as the draft is old enough, and the answer is still theirs.
      await heard('one', 'The office is closed on Friday.')
      assert.equal((await set.ready()).drafts[0].kind, 'yours')
      assert.equal(set.seen.length, 2)

      // Another, a moment later, isn't read yet: the model was asked seconds ago.
      set.later(1000)
      await heard('two', 'Beta customers keep their discount until March.')
      assert.equal((await set.ready()).drafts[0].kind, 'yours')
      assert.equal(set.seen.length, 2)

      set.later(askAgainAfterMs + 1)
      set.says(() => ({ text: 'FACT\nYes, until March.', cites: ['Heard two'] }))
      const { drafts } = await set.ready()
      assert.deepEqual(drafts.map((d) => [d.kind, d.words, d.sources.map((s) => s.id)]), [['answer', 'Yes, until March.', ['two']]])
      assert.equal(set.seen.length, 3)
      // An answer isn't asked for again, whatever is written after it.
      set.later(askAgainAfterMs + 1)
      await heard('three', 'Something else entirely.')
      await set.ready()
      assert.equal(set.seen.length, 3)
    } finally {
      set.close()
    }
  })

  it('says which cards wait for the same thing', async () => {
    const set = await setUp([{ type: 'card.put', card: asking('a', 'A', 'Which package manager do we use?') }, { type: 'card.put', card: asking('b', 'B', 'Which package manager do we use?') }])
    try {
      assert.deepEqual((await set.first.look()).gathered.map((g) => [g.why, g.title, g.cards]), [['question', 'Which package manager do we use?', ['a', 'b']]])
    } finally {
      set.close()
    }
  })
})
