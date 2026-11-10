import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Actions } from '../src/actions.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { ask, askSteps, SpaceBrain, type AskPlace } from '../src/brain/brain.ts'
import { boardFor, type WorkPlace } from '../src/brain/board.ts'
import type { BrainModel, StepInput } from '../src/brain/models.ts'
import { toolRules } from '../src/brain/tools.ts'
import type { LoopTurn, Step } from '../../shared/agent.ts'
import type { Outcome } from '../../shared/listen.ts'
import type { Change } from '../../shared/state.ts'
import type { Agent, Card } from '../../shared/work.ts'
import { note, seed } from './helpers.ts'

const at = '2026-11-08T10:00:00.000Z'
const agent: Agent = { id: 'a1', name: 'Sonnet', owner: 'you', binders: ['b1'], repos: [], lastSeen: new Date().toISOString() } as unknown as Agent
const card = (id: string, title: string, fields: Partial<Card> = {}): Card => ({ id, title, binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'ready', waitsFor: [], activity: [], updatedAt: at, ...fields } as Card)

const work: Change[] = [
  { type: 'agent.put', agent } as Change,
  { type: 'note.put', note: note('conventions', 'How we build', { text: '# How we build\n\nWe use pnpm, never npm. Deploys go out on Tuesdays.\n' }) },
  { type: 'note.put', note: note('secret', 'Salaries', { text: '# Salaries\n\nNot for everyone.\n' }) },
  { type: 'card.put', card: card('login', 'Fix the login page', { stage: 'working', agentId: 'a1', doing: 'running the tests', brief: 'The login form loses its focus ring.', doneWhen: 'The ring shows on every field.', activity: [{ at, by: 'a1', kind: 'said', text: 'Found it in forms.css.' }] as Card['activity'] }) },
  { type: 'card.put', card: card('asking', 'Move the database', { stage: 'blocked', agentId: 'a1', needsYou: 'Which region should it go to?' }) },
  { type: 'card.put', card: card('later', 'Write the changelog') },
  { type: 'set.put', set: { id: 'set-18', binderId: 'b1', number: 18, title: 'The November release', summary: 'Login fixes.', state: 'review', prIds: [], noteIds: [] } },
]

const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input })
const says = (text: string): Step => ({ text, calls: [], stop: 'end' })
const wants = (...calls: ReturnType<typeof call>[]): Step => ({ text: '', calls, stop: 'tools' })
const results = (turns: LoopTurn[]) => turns.flatMap((turn) => (turn.role === 'tool' ? turn.results : []))

async function setUp(options: { canStep?: boolean; keep?: AskPlace['keep'] } = {}) {
  const hub = new Hub(new MemoryLog())
  await hub.start([...seed(), ...work])
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const actions = new Actions(hub, new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {}))
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const asked: StepInput[] = []
  let oneGo = 0
  let script: (Step | ((turns: LoopTurn[]) => Step))[] = [says('Nothing to say.')]
  const model: BrainModel = {
    label: 'scripted',
    summarize: async () => ({ title: '', summary: '', points: [], decisions: [], followUps: [] }),
    answer: async () => {
      oneGo++
      return { text: 'Answered in one go.', parts: [{ text: 'Answered in one go.', sources: [] }] }
    },
    talk: async () => '',
    sortMoment: async () => ({ kind: 'none', title: '' }),
    ...(options.canStep === undefined ? {} : {
      steps: async () => options.canStep!,
      step: async (input: StepInput) => {
        asked.push({ ...input, turns: structuredClone(input.turns) })
        const next = script[Math.min(asked.length - 1, script.length - 1)]
        return typeof next === 'function' ? next(input.turns) : next
      },
    }),
  }
  settings.useForTests(model)
  const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
  brain.start()
  await brain.caughtUp()
  const place: WorkPlace = { id: 'test', name: 'Server', hub, actions }
  const places: AskPlace[] = [{ id: 'test', name: 'Server', brain, url: (kind, id) => `http://hub.test/${kind}/${id}`, work: place, ...(options.keep ? { keep: options.keep } : {}) }]
  const markOf = (words: string) => new RegExp(`\\[([a-z]\\d+(?:-\\d+)?)\\][^\\n]*${words}`).exec(boardFor([place], 'you').passage.text)![1]
  const heard = async (): Promise<Outcome[]> => [{ id: 'o1', listener: 'l1', listenerName: 'Support mail', at: '2026-11-10T09:00:00.000Z', sender: 'Ana', title: 'Refund for order 41', strength: 'outside', did: 'noted', line: 'Filed under Inbox.', note: 'note-in-1' }]
  const go = (question: string, more: Parameters<typeof ask>[3] = {}) => ask(settings, places, question, { person: 'you', may: true, views: true, loop: true, heard, ...more })
  return { hub, asked, go, markOf, oneGo: () => oneGo, plays: (...steps: typeof script) => { script = steps }, close: () => brain.stop() }
}

describe('the Brain answering in steps', () => {
  it('is given what was found, numbered, how the work stands, its tools and its rules', async () => {
    const set = await setUp({ canStep: true })
    try {
      set.plays(says('We use pnpm [1].'))
      const result = await set.go('Which package manager do we use?')
      const [first] = set.asked
      assert.match(first.system, /Cite the documents you use with their numbers/)
      assert.ok(first.system.includes(toolRules))
      assert.match(first.system, /```view/, 'the page can draw a view, so it’s told how')
      assert.match(first.system, /only tell them how things stand/, 'a question is only answered, as in one go: the lines for doing things go with a request')
      const said = (first.turns[0] as Extract<LoopTurn, { role: 'user' }>).text
      assert.match(said, /^<documents>\n\[1\] /)
      assert.match(said, /<document title="What’s going on now">/)
      assert.ok(said.endsWith('Which package manager do we use?'))
      assert.deepEqual(first.tools.map((tool) => tool.name), ['find', 'read_note', 'read_card', 'list_cards', 'read_change_set', 'what_waits', 'came_in'])
      assert.equal(result.answer?.text, 'We use pnpm.')
      assert.deepEqual(result.answer?.parts[0].sources, [1])
      assert.equal(result.looked, undefined, 'it looked nothing up')
      assert.equal(set.oneGo(), 0)
    } finally {
      set.close()
    }
  })

  it('reads a note it asks for, and cites it by the number the tool gave it', async () => {
    const set = await setUp({ canStep: true })
    try {
      let given = ''
      set.plays(wants(call('c1', 'read_note', { id: 'conventions' })), (turns) => {
        given = results(turns)[0].text
        const n = /^\[(\d+)\]/.exec(given)![1]
        return says(`Deploys go out on Tuesdays [${n}].`)
      })
      const result = await set.go('When do we deploy?')
      assert.match(given, /^\[\d+\] Note “How we build”/)
      assert.match(given, /Deploys go out on Tuesdays\./)
      const cited = result.answer!.parts[0].sources[0]
      const source = result.sources.find((s) => s.n === cited)!
      assert.deepEqual({ kind: source.kind, id: source.id, title: source.title, url: source.url }, { kind: 'note', id: 'conventions', title: 'How we build', url: 'http://hub.test/note/conventions' })
      assert.deepEqual(result.looked, [{ what: 'Read the note “How we build”' }])
      assert.equal(result.answer?.text, 'Deploys go out on Tuesdays.')
    } finally {
      set.close()
    }
  })

  it('finds more with its own words, and what it finds becomes sources too', async () => {
    const set = await setUp({ canStep: true })
    try {
      let given = ''
      set.plays(wants(call('c1', 'find', { query: 'login focus ring' })), (turns) => {
        given = results(turns)[0].text
        return says(`It’s the focus ring [${/\[(\d+)\] Card “Fix the login page”/.exec(given)![1]}].`)
      })
      const result = await set.go('What is wrong with signing in?')
      assert.match(given, /Card “Fix the login page”.*id login/)
      assert.equal(result.sources.find((s) => s.n === result.answer!.parts[0].sources[0])!.id, 'login')
      assert.deepEqual(result.looked, [{ what: 'Looked for “login focus ring”' }])
      assert.deepEqual(result.sources.map((s) => s.n), result.sources.map((_s, i) => i + 1), 'numbered in order, with no gap')
    } finally {
      set.close()
    }
  })

  it('reads a card by its mark on the board or by its id, lists cards, and reads a change set', async () => {
    const set = await setUp({ canStep: true })
    try {
      let read: string[] = []
      set.plays(wants(call('c1', 'read_card', { id: set.markOf('Fix the login page') }), call('c2', 'read_card', { id: 'asking' }), call('c3', 'list_cards', { stage: 'ready' }), call('c4', 'read_change_set', { number: 18 }), call('c5', 'read_card', { id: 'nope' })), (turns) => {
        read = results(turns).map((r) => r.text)
        return says('Read them.')
      })
      const result = await set.go('Tell me about the login work')
      assert.match(read[0], /Card login · “Fix the login page” · In progress · Sonnet/)
      assert.match(read[0], /Brief: The login form loses its focus ring\./)
      assert.match(read[0], /Done when: The ring shows on every field\./)
      assert.match(read[0], /- a1: Found it in forms\.css\./)
      assert.match(read[1], /It waits on a person: Which region should it go to\?/)
      assert.equal(read[2], 'later · “Write the changelog” · Ready')
      assert.match(read[3], /^Change set #18 “The November release”: review\nSummary: Login fixes\.\nNo pull requests\./)
      assert.equal(read[4], 'There is no card with that id here.')
      assert.deepEqual(result.looked!.map((l) => l.what), ['Read the card “Fix the login page”', 'Read the card “Move the database”', 'Listed the cards in Ready', 'Read change set #18'])
    } finally {
      set.close()
    }
  })

  it('sees what waits on the person, and what came in through listeners', async () => {
    const set = await setUp({ canStep: true })
    try {
      let read: string[] = []
      set.plays(wants(call('c1', 'what_waits'), call('c2', 'came_in')), (turns) => {
        read = results(turns).map((r) => r.text)
        return says('Seen.')
      })
      await set.go('Anything new?')
      assert.match(read[0], /question · “Move the database” · Sonnet asks: Which region should it go to\? · card asking/)
      assert.equal(read[1], '2026-11-10 09:00 · Support mail · from Ana · “Refund for order 41” · Filed under Inbox. · note note-in-1 · from outside the Binder')
    } finally {
      set.close()
    }
  })

  it('reads only what the person asking can: a note their place doesn’t show them isn’t read', async () => {
    const set = await setUp({ canStep: true, keep: (kind, id) => !(kind === 'note' && id === 'secret') })
    try {
      let read: string[] = []
      set.plays(wants(call('c1', 'read_note', { id: 'secret' }), call('c2', 'find', { query: 'salaries' })), (turns) => {
        read = results(turns).map((r) => r.text)
        return says('Nothing I can read.')
      })
      const result = await set.go('What are the salaries?')
      assert.equal(read[0], 'There is no note with that id here.')
      assert.ok(!read[1].includes('Not for everyone'))
      assert.ok(result.sources.every((s) => s.id !== 'secret'))
    } finally {
      set.close()
    }
  })

  it('still only proposes when told to do something, and still shows a view', async () => {
    const set = await setUp({ canStep: true })
    try {
      set.plays(wants(call('c1', 'what_waits')), () => says(`DO stop ${set.markOf('Fix the login page')}`))
      const stopping = await set.go('Stop the login page work')
      assert.match(set.asked[0].system, /DO stop MARK/)
      assert.equal(stopping.proposal?.button, 'Stop it')
      assert.equal(set.hub.state.cards.find((c) => c.id === 'login')!.stage, 'working')

      set.plays(says(`One card is being worked on.\n\n\`\`\`view\n${JSON.stringify({ root: 'a', elements: { a: { type: 'Thing', props: { ref: set.markOf('Fix the login page') } } } })}\n\`\`\``))
      const shown = await set.go('What is being worked on?')
      assert.equal(shown.answer?.text, 'One card is being worked on.')
      assert.equal(shown.view?.elements.a.props.id, 'login')
    } finally {
      set.close()
    }
  })

  it('stops after its steps, and still answers from what it found', async () => {
    const set = await setUp({ canStep: true })
    try {
      set.plays((turns) => (turns.at(-1)?.role === 'user' && turns.length > 1 ? says('From what I found: it’s Tuesdays.') : wants(call(`c${turns.length}`, 'list_cards'))))
      const result = await set.go('When do we deploy?')
      assert.equal(result.answer?.text, 'From what I found: it’s Tuesdays.')
      assert.equal(set.asked.length, askSteps.steps + 1)
      assert.deepEqual(set.asked.at(-1)!.tools, [])
    } finally {
      set.close()
    }
  })

  it('says so when the model declines', async () => {
    const set = await setUp({ canStep: true })
    try {
      set.plays({ text: '', calls: [], stop: 'refused' })
      const result = await set.go('Something it won’t answer')
      assert.equal(result.answer, undefined)
      assert.equal(result.problem, 'The model declined to answer that.')
    } finally {
      set.close()
    }
  })
})

describe('the Brain answering in one go, as before', () => {
  it('does so with a model that can’t call tools, or doesn’t say it can', async () => {
    for (const canStep of [false, undefined]) {
      const set = await setUp({ canStep })
      try {
        const result = await set.go('Which package manager do we use?')
        assert.equal(result.answer?.text, 'Answered in one go.')
        assert.equal(set.oneGo(), 1)
        assert.equal(set.asked.length, 0)
        assert.equal(result.looked, undefined)
      } finally {
        set.close()
      }
    }
  })

  it('does so where steps weren’t asked for, though the model could', async () => {
    const set = await setUp({ canStep: true })
    try {
      const result = await set.go('Which package manager do we use?', { loop: false })
      assert.equal(result.answer?.text, 'Answered in one go.')
      assert.equal(set.asked.length, 0)
    } finally {
      set.close()
    }
  })
})
