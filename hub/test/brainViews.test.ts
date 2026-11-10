import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { ask, SpaceBrain, type AskPlace } from '../src/brain/brain.ts'
import { boardFor, carryOut, takeProposal, type WorkPlace } from '../src/brain/board.ts'
import { OpenAICompatibleModel, type BrainModel } from '../src/brain/models.ts'
import { viewFrom, viewRules } from '../src/brain/view.ts'
import { takeView, takeViewFromParts } from '../src/brain/viewBlock.ts'
import { readView, viewBinders, viewMost, viewOffers } from '../../shared/view.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card } from '../../shared/work.ts'
import { seed } from './helpers.ts'

const at = '2026-11-08T10:00:00.000Z'
const agent = (id: string, name: string, owner: string): Agent => ({ id, name, owner, binders: ['b1'], repos: [], lastSeen: new Date().toISOString() } as unknown as Agent)
const card = (id: string, title: string, fields: Partial<Card> = {}): Card => ({ id, title, binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'ready', waitsFor: [], activity: [], updatedAt: at, ...fields } as Card)

const work: Change[] = [
  { type: 'agent.put', agent: agent('a1', 'Sonnet', 'you') } as Change,
  { type: 'card.put', card: card('working', 'Fix the login page', { stage: 'working', agentId: 'a1', doing: 'running the tests' }) },
  { type: 'card.put', card: card('asking', 'Move the database', { stage: 'working', agentId: 'a1', needsYou: 'Which region should it go to?' }) },
  { type: 'card.put', card: card('waiting', 'Write the changelog') },
  { type: 'set.put', set: { id: 'set-18', binderId: 'b1', number: 18, title: 'The November release', summary: '', state: 'review', prIds: [], noteIds: [] } },
]

const text = (words: string) => ({ type: 'Text', props: { text: words } })
const block = (view: unknown) => `\`\`\`view\n${JSON.stringify(view)}\n\`\`\``

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start([...seed(), ...work])
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const actions = new Actions(hub, github)
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const seen: { more?: string }[] = []
  let reply = 'Nothing to say.'
  const model: BrainModel = {
    label: 'scripted',
    summarize: async () => ({ title: '', summary: '', points: [], decisions: [], followUps: [] }),
    answer: async (_q, _passages, more) => {
      seen.push({ more })
      const taken = takeView(reply)
      return { text: taken.words, parts: [{ text: taken.words, sources: [] }], ...(taken.raw ? { view: taken.raw } : {}) }
    },
    talk: async () => reply,
    sortMoment: async () => ({ kind: 'none', title: '' }),
  }
  settings.useForTests(model)
  const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
  brain.start()
  await brain.caughtUp()
  const place: WorkPlace = { id: 'test', name: 'Server', hub, actions }
  const places: AskPlace[] = [{ id: 'test', name: 'Server', brain, url: () => 'http://hub.test', work: place }]
  const board = () => boardFor([place], 'you')
  const markOf = (words: string) => new RegExp(`\\[([a-z]\\d+(?:-\\d+)?)\\][^\\n]*${words}`).exec(board().passage.text)![1]
  return { hub, settings, seen, say: (words: string) => { reply = words }, place, places, board, markOf, close: () => brain.stop() }
}

describe('a view, read', () => {
  it('keeps the parts on the list, with their props and children', () => {
    const view = readView({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['a', 'b'] }, a: text('Hello'), b: { type: 'Stat', props: { label: 'Open', value: '4' } } } })
    assert.deepEqual(view, { root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['a', 'b'] }, a: { type: 'Text', props: { text: 'Hello' }, children: [] }, b: { type: 'Stat', props: { label: 'Open', value: '4' }, children: [] } } })
  })

  it('leaves out a part that isn’t on the list, with everything under it', () => {
    const view = readView({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['bad', 'a'] }, bad: { type: 'Script', props: { src: 'x' }, children: ['under'] }, under: text('hidden'), a: text('Shown') } })
    assert.deepEqual(Object.keys(view!.elements), ['all', 'a'])
    assert.deepEqual(view!.elements.all.children, ['a'])
  })

  it('leaves out a part whose props aren’t of its shape, and drops props a part doesn’t have', () => {
    const view = readView({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['wrong', 'more'] }, wrong: { type: 'Text', props: { text: 5 } }, more: { type: 'Text', props: { text: 'Fine', html: '<b>x</b>', onClick: 'alert(1)' } } } })
    assert.deepEqual(view!.elements.all.children, ['more'])
    assert.deepEqual(view!.elements.more.props, { text: 'Fine' })
  })

  it('keeps nothing that could set something off: no actions, conditions, repeats or state', () => {
    const view = readView({ root: 'a', state: { x: 1 }, elements: { a: { type: 'Text', props: { text: 'Hi' }, on: { press: { action: 'approve' } }, visible: { $state: '/x' }, repeat: { statePath: '/x' }, watch: {} } } } as unknown)
    assert.deepEqual(view, { root: 'a', elements: { a: { type: 'Text', props: { text: 'Hi' }, children: [] } } })
  })

  it('gives a part that isn’t a group no children', () => {
    const view = readView({ root: 'a', elements: { a: { type: 'Text', props: { text: 'Hi' }, children: ['b'] }, b: text('under') } })
    assert.deepEqual(view!.elements, { a: { type: 'Text', props: { text: 'Hi' }, children: [] } })
  })

  it('leaves out a part that is above itself, and a group with nothing left in it', () => {
    const loop = readView({ root: 'a', elements: { a: { type: 'Stack', props: {}, children: ['b', 't'] }, b: { type: 'Section', props: { title: 'Round' }, children: ['a'] }, t: text('Still here') } })
    assert.deepEqual(Object.keys(loop!.elements), ['a', 't'])
    assert.equal(readView({ root: 'a', elements: { a: { type: 'Stack', props: {}, children: ['gone'] } } }), undefined)
  })

  it('shows each part once, though two groups name it', () => {
    const view = readView({ root: 'a', elements: { a: { type: 'Stack', props: {}, children: ['t', 's'] }, s: { type: 'Section', props: { title: 'Again' }, children: ['t', 'u'] }, t: text('Once'), u: text('Other') } })
    assert.deepEqual(view!.elements.s.children, ['u'])
  })

  it('stops at its limits: how deep, how many, how big', () => {
    const deep: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) deep[`s${i}`] = { type: 'Stack', props: {}, children: [`t${i}`, `s${i + 1}`] }
    for (let i = 0; i < 10; i++) deep[`t${i}`] = text(`Level ${i}`)
    const cut = readView({ root: 's0', elements: deep })!
    assert.ok(!Object.hasOwn(cut.elements, `t${viewMost.depth}`), 'nothing below the deepest level')
    assert.ok(Object.hasOwn(cut.elements, 't0'))

    const many: Record<string, unknown> = { all: { type: 'Stack', props: {}, children: Array.from({ length: 200 }, (_x, i) => `t${i}`) } }
    for (let i = 0; i < 200; i++) many[`t${i}`] = text(`Line ${i}`)
    assert.equal(Object.keys(readView({ root: 'all', elements: many })!.elements).length, viewMost.elements)

    const big: Record<string, unknown> = { all: { type: 'Stack', props: {}, children: Array.from({ length: 40 }, (_x, i) => `t${i}`) } }
    for (let i = 0; i < 40; i++) big[`t${i}`] = text('x'.repeat(1000))
    assert.equal(readView({ root: 'all', elements: big }), undefined)
  })

  it('reads nothing from what isn’t a view', () => {
    for (const not of [undefined, null, 'view', 4, [], {}, { root: 'a' }, { root: 'a', elements: [] }, { root: 'a', elements: {} }, { root: 5, elements: { a: text('x') } }, { root: '__proto__', elements: { a: text('x') } }]) assert.equal(readView(not), undefined)
  })

  it('refuses a chart’s numbers that aren’t numbers, and a table wider than it may be', () => {
    const chart = (values: unknown) => readView({ root: 'c', elements: { c: { type: 'Chart', props: { kind: 'bar', labels: ['a', 'b'], series: [{ name: 'Cards', values }] } } } })
    assert.ok(chart([1, 2]))
    assert.equal(chart(['1', '2']), undefined)
    assert.equal(chart([1, Number.NaN]), undefined)
    assert.equal(readView({ root: 't', elements: { t: { type: 'Table', props: { columns: Array.from({ length: 9 }, (_x, i) => `c${i}`), rows: [['x']] } } } }), undefined)
  })

  it('names the Binders its Things are in', () => {
    const thing = (binder: string, id: string) => ({ type: 'Thing', props: { kind: 'card', binder, id, title: 'A card' } })
    const view = readView({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['a', 'b', 'c', 't'] }, a: thing('one', '1'), b: thing('two', '2'), c: thing('one', '3'), t: text('x') } })!
    assert.deepEqual(viewBinders(view).sort(), ['one', 'two'])
  })
})

describe('a model’s view block', () => {
  it('comes out of its words, which stand without it', () => {
    const { words, raw } = takeView(`Two things are open.\n\n${block({ root: 'a', elements: { a: text('x') } })}`)
    assert.equal(words, 'Two things are open.')
    assert.deepEqual(JSON.parse(raw!), { root: 'a', elements: { a: text('x') } })
  })

  it('leaves words with no block as they are', () => {
    assert.deepEqual(takeView('Use ```code``` like this.\n\n```js\nlet a = 1\n```'), { words: 'Use ```code``` like this.\n\n```js\nlet a = 1\n```' })
  })

  it('keeps what was said after it, and takes a block the model never closed', () => {
    assert.equal(takeView(`Before.\n\n${block({ root: 'a' })}\n\nAfter.`).words, 'Before.\n\nAfter.')
    const cut = takeView('Before.\n```view\n{"root":"a","elem')
    assert.equal(cut.words, 'Before.')
    assert.equal(cut.raw, '{"root":"a","elem')
  })

  it('comes out of an answer in parts, each keeping its sources', () => {
    const view = block({ root: 'a', elements: { a: text('x') } })
    const one = takeViewFromParts([{ text: 'Cited words. ', sources: [0] }, { text: `Plain words.\n\n${view}`, sources: [] }])
    assert.deepEqual(one.parts, [{ text: 'Cited words. ', sources: [0] }, { text: 'Plain words.', sources: [] }])
    assert.ok(one.raw)

    const half = Math.floor(view.length / 2)
    const split = takeViewFromParts([{ text: `First.\n\n${view.slice(0, half)}`, sources: [1] }, { text: view.slice(half), sources: [] }, { text: '\n\nLast.', sources: [2] }])
    assert.deepEqual(split.parts.map((p) => p.sources), [[1], [2]])
    assert.equal(split.parts.map((p) => p.text).join(''), 'First.\n\nLast.')
    assert.deepEqual(JSON.parse(split.raw!), { root: 'a', elements: { a: text('x') } })

    const none = [{ text: 'Only words.', sources: [0] }]
    assert.deepEqual(takeViewFromParts(none), { parts: none })
  })

  it('isn’t read for citations by a model that numbers its sources: a chart’s numbers stay', async () => {
    const view = { root: 'c', elements: { c: { type: 'Chart', props: { kind: 'bar', labels: ['Ready', 'Done'], series: [{ name: 'Cards', values: [3, 12] }] } } } }
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: `Most are done [1].\n\n${block(view)}` } }] }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const model = new OpenAICompatibleModel({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'local-model' })
      const answer = await model.answer('How many are done?', [{ title: 'Board', text: 'Three ready, twelve done.' }])
      assert.equal(answer.text, 'Most are done.')
      assert.deepEqual(answer.parts, [{ text: 'Most are done.', sources: [0] }])
      assert.deepEqual(viewFrom(answer.view!)!.elements.c.props.series, [{ name: 'Cards', values: [3, 12] }])
    } finally {
      server.close()
    }
  })
})

describe('what a view’s Things stand for', () => {
  it('turns a mark into the thing itself, from the hub’s state', async () => {
    const set = await setUp()
    try {
      const board = set.board()
      const view = viewFrom(JSON.stringify({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['c', 'q', 's'] }, c: { type: 'Thing', props: { ref: set.markOf('Fix the login page') } }, q: { type: 'Thing', props: { ref: `[${set.markOf('Move the database').toUpperCase()}]` } }, s: { type: 'Thing', props: { ref: set.markOf('The November release') } } } }), board, [set.place])!
      assert.deepEqual(view.elements.c.props, { kind: 'card', binder: 'test', id: 'working', title: 'Fix the login page', detail: 'In progress · Sonnet · running the tests' })
      assert.deepEqual(view.elements.q.props, { kind: 'card', binder: 'test', id: 'asking', title: 'Move the database', detail: 'In progress · Sonnet · asks: Which region should it go to?' })
      assert.deepEqual(view.elements.s.props, { kind: 'set', binder: 'test', id: 'set-18', title: 'Change set #18: The November release', detail: 'In review · 0 pull requests' })
    } finally {
      set.close()
    }
  })

  it('finds an agent by its name, whatever its case', async () => {
    const set = await setUp()
    try {
      const view = viewFrom(JSON.stringify({ root: 'a', elements: { a: { type: 'Thing', props: { agent: 'sonnet' } } } }), set.board(), [set.place])!
      assert.equal(view.elements.a.props.kind, 'agent')
      assert.equal(view.elements.a.props.id, 'a1')
      assert.equal(view.elements.a.props.title, 'Sonnet')
      assert.match(String(view.elements.a.props.detail), /Online · working on “Fix the login page”, “Move the database”/)
    } finally {
      set.close()
    }
  })

  it('leaves out a Thing that isn’t on the board, and never takes what a model wrote for one', async () => {
    const set = await setUp()
    try {
      const made = { type: 'Thing', props: { kind: 'card', binder: 'someone-elses', id: 'secret', title: 'A card it made up', ref: 'c99' } }
      const view = viewFrom(JSON.stringify({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['made', 'nobody', 't'] }, made, nobody: { type: 'Thing', props: { agent: 'Nobody' } }, t: text('Still shown') } }), set.board(), [set.place])!
      assert.deepEqual(Object.keys(view.elements), ['all', 't'])
      assert.deepEqual(viewBinders(view), [])
      // With no board at all, a Thing has nothing to stand for.
      assert.equal(viewFrom(JSON.stringify({ root: 'a', elements: { a: { type: 'Thing', props: { ref: 'c1' } } } })), undefined)
    } finally {
      set.close()
    }
  })

  it('reads a block with a word or two around its JSON, and nothing from one that isn’t JSON', () => {
    assert.ok(viewFrom(`Here it is:\n${JSON.stringify({ root: 'a', elements: { a: text('x') } })}\nDone.`))
    assert.equal(viewFrom('{"root":"a","elem'), undefined)
    assert.equal(viewFrom('no json here'), undefined)
  })
})

describe('asking, where a view can be drawn', () => {
  it('tells the model how, and gives back the view with its Things filled in', async () => {
    const set = await setUp()
    try {
      set.say(`Sonnet is on it.\n\n${block({ root: 'all', elements: { all: { type: 'Stack', props: {}, children: ['who', 'what', 'next'] }, who: { type: 'Thing', props: { agent: 'Sonnet' } }, what: { type: 'Thing', props: { ref: set.markOf('Fix the login page') } }, next: { type: 'Suggest', props: { questions: ['What is waiting on me?'] } } } })}`)
      const result = await ask(set.settings, set.places, 'What is Sonnet doing?', { person: 'you', may: true, views: true })
      assert.ok(set.seen[0].more?.includes(viewRules))
      assert.equal(result.answer?.text, 'Sonnet is on it.')
      assert.deepEqual(result.view?.elements.all.children, ['who', 'what', 'next'])
      assert.equal(result.view?.elements.what.props.id, 'working')
      assert.equal(result.view?.elements.who.props.id, 'a1')
    } finally {
      set.close()
    }
  })

  it('says nothing of views, and gives none back, where one can’t be drawn', async () => {
    const set = await setUp()
    try {
      set.say(`Sonnet is on it.\n\n${block({ root: 'a', elements: { a: text('x') } })}`)
      const result = await ask(set.settings, set.places, 'What is Sonnet doing?', { person: 'you', may: true })
      assert.ok(!set.seen[0].more?.includes('```view'))
      assert.equal(result.view, undefined)
      assert.equal(result.answer?.text, 'Sonnet is on it.')
    } finally {
      set.close()
    }
  })

  it('answers in words alone when the view doesn’t read', async () => {
    const set = await setUp()
    try {
      set.say('Sonnet is on it.\n\n```view\n{"root":"a","elements":{"a":{"type":"Iframe","props":{"src":"https://example.com"}}}}\n```')
      const result = await ask(set.settings, set.places, 'What is Sonnet doing?', { person: 'you', may: true, views: true })
      assert.equal(result.view, undefined)
      assert.equal(result.answer?.text, 'Sonnet is on it.')
    } finally {
      set.close()
    }
  })

  it('still asks first when told to do something, view or no view', async () => {
    const set = await setUp()
    try {
      set.say(`DO stop ${set.markOf('Fix the login page')}\n\n${block({ root: 'a', elements: { a: text('Stopped it.') } })}`)
      const result = await ask(set.settings, set.places, 'Stop the login page work', { person: 'you', may: true, views: true })
      assert.ok(result.proposal)
      // The offer is in the view, above what the model drew, and nothing has happened.
      const view = readView(result.view)!
      assert.deepEqual(viewOffers(view).map((offer) => [offer.id, offer.button]), [[result.proposal!.id, 'Stop it']])
      assert.equal(view.elements[view.root].children[0], 'hub-offer-1')
      assert.equal(set.hub.state.cards.find((c) => c.id === 'working')!.stage, 'working')
    } finally {
      set.close()
    }
  })
})

describe('what the Brain offers to do, as buttons', () => {
  /** What a small model wrote, the lines inside its sentences: taken from a real answer, with this board's marks. */
  const inSentences = (set: Awaited<ReturnType<typeof setUp>>) => [
    'Nothing is lost by stopping. You’d have to tell me which to act on:',
    '',
    `Stop the cards in progress: DO stop ${set.markOf('Fix the login page')} ${set.markOf('Move the database')}`,
    '',
    `Stop the ready one too: DO stop ${set.markOf('Write the changelog')}`,
    '',
    `Change set #18 has no discard. Approve it (DO approve ${set.markOf('The November release')}) to merge, or leave it as is.`,
  ].join('\n')

  it('makes a button of every line, wherever the model wrote it, and shows no line and no mark', async () => {
    const set = await setUp()
    try {
      set.say(inSentences(set))
      const result = await ask(set.settings, set.places, 'Get rid of the rebrand work', { person: 'you', may: true, views: true })
      const said = result.answer!.text
      assert.doesNotMatch(said, /\bDO\b/, 'no line reaches the person')
      assert.doesNotMatch(said, /\b[cs]\d+\b/, 'and no mark')
      assert.match(said, /Stop the cards in progress\.\n\nStop the ready one too\.\n\nChange set #18 has no discard\. Approve it to merge, or leave it as is\./)

      const view = readView(result.view)!
      const offers = viewOffers(view)
      assert.deepEqual(offers.map((offer) => offer.button), ['Stop all 2', 'Stop it', 'Approve and merge'])
      assert.deepEqual(offers.map((offer) => (offer.about ?? []).map((thing) => `${thing.kind}:${thing.title}`)), [['card:Fix the login page', 'card:Move the database'], ['card:Write the changelog'], ['set:Change set #18: The November release']])
      assert.match(offers[0].what, /^Stop 2 cards: “Fix the login page”, “Move the database”\./)
      assert.equal(offers[2].heavy, true)
      assert.deepEqual(result.proposals!.map((p) => p.id), offers.map((offer) => offer.id))
      // Nothing has happened: each waits for its own button.
      assert.deepEqual(['working', 'asking', 'waiting'].map((id) => set.hub.state.cards.find((c) => c.id === id)!.stage), ['working', 'working', 'ready'])

      // Each button works by its own id, once, and only for the person it was made for.
      assert.equal(takeProposal('someone-else', offers[1].id), undefined)
      const second = takeProposal('you', offers[1].id)!
      assert.match(await carryOut(second), /^Stopped “Write the changelog”/)
      assert.equal(set.hub.state.cards.find((c) => c.id === 'waiting')!.stage, 'proposed')
      assert.equal(takeProposal('you', offers[1].id), undefined, 'pressed once')
      const first = takeProposal('you', offers[0].id)!
      assert.equal(await carryOut(first), 'Stopped 2 cards. They’re in Proposed.')
      assert.equal(set.hub.state.changeSets[0].state, 'review', 'the one not pressed is left alone')
    } finally {
      set.close()
    }
  })

  it('offers nothing for a question, or to someone who only reads: the lines go, and no button comes', async () => {
    const set = await setUp()
    try {
      set.say(inSentences(set))
      const asked = await ask(set.settings, set.places, 'What would stopping the rebrand lose?', { person: 'you', may: true, views: true })
      assert.equal(asked.proposal, undefined)
      assert.equal(asked.view, undefined)
      assert.doesNotMatch(asked.answer!.text, /\bDO\b/)
      const reader = await ask(set.settings, [{ ...set.places[0], work: { ...set.place, readOnly: true } }], 'Get rid of the rebrand work', { person: 'you', may: true, views: true })
      assert.equal(reader.proposals, undefined)
      assert.doesNotMatch(reader.answer!.text, /\bDO\b/)
    } finally {
      set.close()
    }
  })

  it('takes an Offer a model put in its view, makes it the hub’s own, and offers the same thing only once', async () => {
    const set = await setUp()
    try {
      const login = set.markOf('Fix the login page')
      const drawn = block({ root: 'all', elements: {
        all: { type: 'Stack', props: {}, children: ['say', 'go', 'made-up'] },
        say: text('This is what stopping would do.'),
        go: { type: 'Offer', props: { do: 'stop', refs: [login], what: 'Delete everything', button: 'Yes!!', id: 'my-own-id' } },
        'made-up': { type: 'Offer', props: { do: 'stop', refs: ['c99'] } },
      } })
      set.say(`I can stop it.\nDO stop ${login}\n\n${drawn}`)
      const result = await ask(set.settings, set.places, 'Stop the login page work', { person: 'you', may: true, views: true })
      const view = readView(result.view)!
      const offers = viewOffers(view)
      assert.equal(offers.length, 1, 'the line and the part ask for the same thing')
      // Its words, its button and its id are the hub's, whatever the model wrote for them.
      assert.equal(offers[0].button, 'Stop it')
      assert.match(offers[0].what, /^Stop “Fix the login page”, which Sonnet is working on\./)
      assert.equal(offers[0].id, result.proposal!.id)
      assert.deepEqual(view.elements.all.children, ['say', 'go'], 'one for a thing that isn’t on the board is left out')

      // Where nothing may be offered, a model's Offer part is left out like any other it made up.
      const asked = await ask(set.settings, set.places, 'What is Sonnet doing?', { person: 'you', may: true, views: true })
      assert.equal(viewOffers(readView(asked.view)!).length, 0)
    } finally {
      set.close()
    }
  })

  it('says why, in words, when what a line asks for can’t be done, and keeps what else was said', async () => {
    const set = await setUp()
    try {
      set.say(`Here is what I can do.\nDO approve ${set.markOf('Fix the login page')}`)
      const result = await ask(set.settings, set.places, 'Approve the login page', { person: 'you', may: true, views: true })
      assert.equal(result.proposal, undefined)
      assert.equal(result.answer!.text, 'Here is what I can do.\n\nI couldn’t tell which one you meant.')
    } finally {
      set.close()
    }
  })

  it('keeps a turn without its offers: a button doesn’t outlive its few minutes', async () => {
    const set = await setUp()
    try {
      set.say(`${inSentences(set)}\n\n${block({ root: 'a', elements: { a: text('How it stands.') } })}`)
      const result = await ask(set.settings, set.places, 'Get rid of the rebrand work', { person: 'you', may: true, views: true })
      assert.equal(viewOffers(readView(result.view)!).length, 3)
      const brain = set.places[0].brain
      await brain.keepTurn('you', { question: 'Get rid of the rebrand work', everywhere: false, result })
      const [kept] = await brain.thread('you')
      assert.equal(kept.result.proposal, undefined)
      assert.equal(kept.result.proposals, undefined)
      const view = readView(kept.result.view)!
      assert.equal(viewOffers(view).length, 0)
      assert.deepEqual(Object.values(view.elements).filter((e) => e.type === 'Text').map((e) => e.props.text), ['How it stands.'])
      assert.match(kept.result.answer!.text, /Stop the cards in progress\./, 'what was said is kept')
    } finally {
      set.close()
    }
  })
})

