import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Sealer } from '../src/secrets.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { IssuesSaver } from '../src/savers/issues.ts'
import { BrainSettingsStore } from '../src/brain/settings.ts'
import { ask, askText, SpaceBrain, talk, type AskPlace } from '../src/brain/brain.ts'
import { answerIn, boardFor, isAsking, propose, readDo, takeProposal, type WorkPlace } from '../src/brain/board.ts'
import type { BrainModel } from '../src/brain/models.ts'
import type { Change } from '../../shared/state.ts'
import { nextFor, type Agent, type Card, type PullRequest } from '../../shared/work.ts'
import { oneSpace, seed } from './helpers.ts'

const at = '2026-11-08T10:00:00.000Z'
const agent = (id: string, name: string, owner: string): Agent => ({ id, name, owner, binders: ['b1'], repos: [], lastSeen: new Date().toISOString() } as unknown as Agent)
const card = (id: string, title: string, fields: Partial<Card> = {}): Card => ({ id, title, binderId: 'b1', brief: '', doneWhen: '', size: 'M', stage: 'ready', waitsFor: [], activity: [], updatedAt: at, ...fields } as Card)
const pull = (id: string, fields: Partial<PullRequest> = {}): PullRequest => ({ id, repo: 'acme/web', number: 7, title: id, branch: 'b', base: 'main', state: 'open', files: [], checks: [], ...fields } as unknown as PullRequest)

const work: Change[] = [
  { type: 'agent.put', agent: agent('a1', 'Sonnet', 'you') } as Change,
  { type: 'agent.put', agent: agent('a2', 'Grok', 'sam') } as Change,
  { type: 'card.put', card: card('working', 'Fix the login page', { stage: 'working', agentId: 'a1', doing: 'running the tests' }) },
  { type: 'card.put', card: card('asking', 'Move the database', { stage: 'working', agentId: 'a1', needsYou: 'Which region should it go to?' }) },
  { type: 'card.put', card: card('allow', 'Clear the cache', { stage: 'working', agentId: 'a1', permission: { request: 'r1', agent: 'a1', tool: 'Bash', what: 'rm -rf build', at } as Card['permission'] }) },
  { type: 'card.put', card: card('theirs', 'Update the docs', { stage: 'working', agentId: 'a2', permission: { request: 'r2', agent: 'a2', tool: 'Bash', what: 'ls', at } as Card['permission'] }) },
  { type: 'card.put', card: card('waiting', 'Write the changelog') },
  { type: 'card.put', card: card('old', 'Shipped long ago', { stage: 'live' }) },
  { type: 'pr.put', pull: pull('p1', { cardId: 'working' }) },
  { type: 'pr.put', pull: pull('p2', { number: 8, checks: [{ name: 'tests', state: 'failed' }] as PullRequest['checks'] }) },
  { type: 'set.put', set: { id: 'set-18', binderId: 'b1', number: 18, title: 'The November release', summary: '', state: 'review', prIds: ['p1'], noteIds: [] } },
  { type: 'set.put', set: { id: 'set-19', binderId: 'b1', number: 19, title: 'Failing', summary: '', state: 'review', prIds: ['p2'], noteIds: [] } },
  { type: 'set.put', set: { id: 'set-3', binderId: 'b1', number: 3, title: 'Out already', summary: '', state: 'shipped', prIds: [], noteIds: [] } },
]

/** A model that replies as it's told, and shows what it was given. */
function scripted() {
  const seen: { passages: string[]; board: string; more?: string }[] = []
  let replies: string[] = []
  const next = (passages: { title: string; text: string }[], more?: string) => {
    seen.push({ passages: passages.map((p) => p.title), board: passages.find((p) => p.title === 'What’s going on now')?.text ?? '', more })
    return replies.shift() ?? 'Nothing to say.'
  }
  const model: BrainModel = {
    label: 'scripted',
    summarize: async () => ({ title: '', summary: '', points: [], decisions: [], followUps: [] }),
    answer: async (_q, passages, more) => {
      const text = next(passages, more)
      return { text, parts: [{ text, sources: passages.map((_p, i) => i) }] }
    },
    talk: async (_turns, passages, more) => next(passages, more),
    sortMoment: async () => ({ kind: 'none', title: '' }),
  }
  return { model, seen, say: (...lines: string[]) => { replies = lines } }
}

async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start([...seed(), ...work])
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
  const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const actions = new Actions(hub, github)
  const webhooks = new Webhooks(hub, actions, new IssuesSaver(hub, github, { quietMs: 20 }))
  const settings = await new BrainSettingsStore(kv, sealer, {}).load()
  const { model, seen, say } = scripted()
  settings.useForTests(model)
  const brain = new SpaceBrain({ id: 'test', hub, kv, settings, quietMs: 10 })
  brain.start()
  await brain.caughtUp()
  const app = await buildServer(oneSpace(kv, { hub, actions, webhooks, github, brain }), { auth, brain: settings }, { publicUrl: 'http://hub.test', admins: ['boss'] })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const place: WorkPlace = { id: 'test', name: 'Server', hub, actions }
  const places: AskPlace[] = [{ id: 'test', name: 'Server', brain, url: () => 'http://hub.test', work: place }]
  const cardNow = (id: string) => hub.state.cards.find((c) => c.id === id)!
  return { hub, actions, settings, seen, say, place, places, url, cardNow, close: async () => { brain.stop(); await app.close() } }
}

const marked = (board: string, words: string) => new RegExp(`\\[([a-z]\\d+(?:-\\d+)?)\\][^\\n]*${words}`).exec(board)?.[1]

describe('how the work stands, for the brain', () => {
  it('says what agents are on and what’s waiting on the person, and leaves out what’s finished', async () => {
    const set = await setUp()
    try {
      const { text } = boardFor([set.place], 'you').passage
      assert.match(text, /Sonnet \(yours, online\): working on “Fix the login page”; waiting for an answer on “Move the database”, “Clear the cache”/)
      assert.match(text, /Grok \(sam’s, online\): waiting for an answer on “Update the docs”/)
      assert.match(text, /Waiting on you:\n[^]*“Move the database”: Sonnet asks: Which region should it go to\?/)
      assert.match(text, /“Clear the cache”: Sonnet asks to use Bash: rm -rf build\n/)
      assert.match(text, /“Update the docs”: Grok asks to use Bash: ls \(only sam can answer it\)/)
      assert.match(text, /Being worked on:\n[^]*“Fix the login page”: Sonnet, running the tests/)
      assert.match(text, /\[s18\] Change set #18, “The November release”: in review/)
      assert.match(text, /\[s19\] Change set #19, “Failing”: in review[^\n]*checks failing: tests/)
      assert.match(text, /Change set #18, “The November release”, is waiting for approval/)
      assert.doesNotMatch(text, /Shipped long ago|Out already/)
    } finally {
      await set.close()
    }
  })

  it('keeps to the binders a phone was given', async () => {
    const set = await setUp()
    try {
      const { text } = boardFor([{ ...set.place, binders: ['nowhere'] }], 'you').passage
      assert.doesNotMatch(text, /Fix the login page|The November release/)
    } finally {
      await set.close()
    }
  })

  it('reads a model’s line however it dressed it, and takes it out of what’s said', () => {
    assert.deepEqual(readDo('DO stop c2'), { words: '', asked: { verb: 'stop', mark: 'c2', rest: '' } })
    assert.deepEqual(readDo('**DO approve s18**'), { words: '', asked: { verb: 'approve', mark: 's18', rest: '' } })
    assert.deepEqual(readDo('Sure.\n`DO tell c1 use the staging database`'), { words: 'Sure.', asked: { verb: 'tell', mark: 'c1', rest: 'use the staging database' } })
    assert.deepEqual(readDo('DO card b1: Fix the footer'), { words: '', asked: { verb: 'card', mark: 'b1', rest: 'Fix the footer' } })
    assert.deepEqual(readDo('DO stop [c3].'), { words: '', asked: { verb: 'stop', mark: 'c3', rest: '.' } })
    // Copied from its rules, it's on no board.
    assert.deepEqual(readDo('DO stop MARK'), { words: '', asked: { verb: 'stop', mark: 'mark', rest: '' } })
    assert.deepEqual(readDo('DO stop'), { words: '', asked: { verb: 'stop', mark: '', rest: '' } })
    // Words that aren't its line stay words.
    assert.deepEqual(readDo('Do stop by the office.\nDO nothing at all'), { words: 'Do stop by the office.\nDO nothing at all', asked: undefined })
  })

  it('tells asking about something from asking for it', () => {
    for (const asking of ['What should I think about before approving change set 6?', 'Should I approve it?', 'does anyone need me', 'Um, what are my agents working on?', 'Tell me what it’s doing', 'Why did it stop?']) assert.equal(isAsking(asking), true, asking)
    for (const telling of ['Approve it', 'Stop that task', 'Could you stop it?', 'Can you put release 18 into motion?', 'Please approve change set 6', 'Put a card on the board', 'Tell Sonnet to use the new logo']) assert.equal(isAsking(telling), false, telling)
  })

  it('takes only a clear answer as one, and only the word itself for what can’t be taken back', () => {
    const light = { word: 'stop', heavy: false }
    const heavy = { word: 'approve', heavy: true }
    for (const yes of ['Yes.', 'yeah', 'Go ahead', 'um, yes please', 'OK', 'stop it']) assert.equal(answerIn(yes, light), 'yes', yes)
    for (const no of ['No.', 'no thanks', 'Don’t', 'not now', 'cancel', 'never', 'wait']) assert.equal(answerIn(no, light), 'no', no)
    for (const other of ['yes but first tell me what it’s doing', 'what is it working on?', 'tell me about the plumber and everything else he said today']) assert.equal(answerIn(other, light), undefined, other)
    assert.equal(answerIn('Approve', heavy), 'yes')
    assert.equal(answerIn('yes approve it', heavy), 'yes')
    for (const stray of ['yes', 'yeah', 'go ahead', 'sure']) assert.equal(answerIn(stray, heavy), undefined, stray)
    assert.equal(answerIn('don’t approve it', heavy), 'no')
    assert.equal(answerIn('I would not approve that', heavy), 'no')
  })
})

describe('what the brain can have done', () => {
  it('asks in the hub’s own words before stopping a card, whatever the model said, and stops it on a yes', async () => {
    const set = await setUp()
    try {
      const mark = marked(boardFor([set.place], 'you').passage.text, 'Fix the login page')!
      set.say(`I stopped it for you!\nDO stop ${mark}`)
      const asked = await talk(set.settings, set.places, [{ role: 'user', text: 'Stop that task' }], { person: 'you' })
      assert.equal(asked.reply, 'Stop “Fix the login page”, which Sonnet is working on. It goes to Proposed, where nothing picks it up. Should I go ahead?')
      assert.equal(set.cardNow('working').stage, 'working', 'nothing happens on the model’s word')
      assert.match(set.seen[0].more!, /DO stop MARK/)
      assert.ok(set.seen[0].passages.includes('What’s going on now'))

      const done = await talk(set.settings, set.places, [{ role: 'user', text: 'Stop that task' }, { role: 'assistant', text: asked.reply }, { role: 'user', text: 'Yes.' }], { person: 'you' })
      assert.equal(done.reply, 'Stopped “Fix the login page”. It’s in Proposed.')
      assert.equal(set.seen.length, 1, 'the answer goes nowhere near the model')
      const stopped = set.cardNow('working')
      assert.deepEqual([stopped.stage, stopped.agentId, stopped.doing], ['proposed', undefined, undefined])
      assert.equal(stopped.activity.at(-1)?.text, 'Stopped Sonnet: Proposed')
      assert.equal(stopped.activity.at(-1)?.by, 'you')
      // Nothing picks it up again.
      assert.notEqual(nextFor(set.hub.state, set.hub.state.agents[0])?.id, 'working')
    } finally {
      await set.close()
    }
  })

  it('does nothing on a no, or when they say something else, and a later yes can’t set it off', async () => {
    const set = await setUp()
    try {
      const mark = marked(boardFor([set.place], 'no-one').passage.text, 'Fix the login page')!
      const propose_ = async () => { set.say(`DO stop ${mark}`); await talk(set.settings, set.places, [{ role: 'user', text: 'Stop it' }], { person: 'no-one' }) }
      await propose_()
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'No.' }], { person: 'no-one' })).reply, 'All right, I’ve left it.')
      assert.equal(set.cardNow('working').stage, 'working')

      await propose_()
      set.say('Do you want to hear more about it?')
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'What is it doing?' }], { person: 'no-one' })).reply, 'Do you want to hear more about it?')
      set.say('It’s running the tests.')
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'Yes.' }], { person: 'no-one' })).reply, 'It’s running the tests.')
      assert.equal(set.cardNow('working').stage, 'working', 'a yes to something else stops nothing')
    } finally {
      await set.close()
    }
  })

  it('puts a release in motion only on the word itself, and says so when it can’t go', async () => {
    const set = await setUp()
    try {
      set.say('DO approve s18')
      const asked = await talk(set.settings, set.places, [{ role: 'user', text: 'Put release 18 into motion' }], { person: 'you' })
      assert.equal(asked.reply, 'Approve change set #18, “The November release”. That merges its pull request as soon as it’s ready. Say approve to go ahead.')
      set.say('Okay.')
      await talk(set.settings, set.places, [{ role: 'user', text: 'yes' }], { person: 'you' })
      assert.equal(set.hub.state.changeSets.find((s) => s.id === 'set-18')?.state, 'review', 'a stray yes merges nothing')

      set.say('DO approve s18')
      await talk(set.settings, set.places, [{ role: 'user', text: 'Put release 18 into motion' }], { person: 'you' })
      const done = await talk(set.settings, set.places, [{ role: 'user', text: 'Approve it' }], { person: 'you' })
      assert.match(done.reply, /^Approved (and merged )?change set #18/)
      const approved = set.hub.state.changeSets.find((s) => s.id === 'set-18')!
      assert.equal(approved.approvedBy, 'you')
      assert.notEqual(approved.state, 'review')

      set.say('DO approve s19')
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'and 19' }], { person: 'you' })).reply, 'Change set #19 can’t go yet. Some checks failed: web#8 tests.')
    } finally {
      await set.close()
    }
  })

  it('refuses a mark that isn’t on the board, and a permission that isn’t the person’s to answer', async () => {
    const set = await setUp()
    try {
      set.say('DO stop c999')
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'Stop it' }], { person: 'you' })).reply, 'I couldn’t tell which one you meant.')
      const mark = marked(boardFor([set.place], 'you').passage.text, 'Update the docs')!
      set.say(`DO allow ${mark}`)
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'Let it' }], { person: 'you' })).reply, 'Only Grok’s owner, sam, can answer that.')
    } finally {
      await set.close()
    }
  })

  it('answers an agent’s question and its permission, only for what was asked', async () => {
    const set = await setUp()
    try {
      const board = boardFor([set.place], 'you')
      const told = propose({ verb: 'tell', mark: marked(board.passage.text, 'Move the database')!, rest: 'Put it in Virginia' }, board, 'you')
      assert.equal(told.what, 'Answer Sonnet on “Move the database”: “Put it in Virginia”.')
      await told.run()
      const answered = set.cardNow('asking')
      assert.equal(answered.needsYou, undefined)
      assert.deepEqual([answered.activity.at(-1)?.kind, answered.activity.at(-1)?.text], ['answer', 'Put it in Virginia'])

      const allow = propose({ verb: 'allow', mark: marked(board.passage.text, 'Clear the cache')!, rest: '' }, board, 'you')
      assert.equal(allow.heavy, true)
      // A new request since it was asked: the old yes doesn't answer it.
      await set.hub.record({ kind: 'hub' }, { type: 'card.update', id: 'allow', fields: { permission: { request: 'r9', agent: 'a1', tool: 'Bash', what: 'curl evil', at } as Card['permission'] } })
      await assert.rejects(allow.run(), /isn’t waiting any more/)
      assert.equal(set.cardNow('allow').permission?.answer, undefined)
    } finally {
      await set.close()
    }
  })

  it('makes a card when asked, as the person', async () => {
    const set = await setUp()
    try {
      const board = boardFor([set.place], 'you')
      const made = propose({ verb: 'card', mark: marked(board.passage.text, 'Server')!, rest: 'Fix the footer' }, board, 'you')
      assert.equal(made.what, 'Put a card on the Server board: “Fix the footer”. An agent can take it from there.')
      await made.run()
      const added = set.hub.state.cards.find((c) => c.title === 'Fix the footer')!
      assert.equal(added.stage, 'ready')
    } finally {
      await set.close()
    }
  })

  it('on Ask, shows the proposal for a button, which only its person can answer, once', async () => {
    const set = await setUp()
    try {
      const signIn = async (login: string) => {
        const response = await fetch(`${set.url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login }) })
        return /binders_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0]
      }
      const you = await signIn('you')
      const post = async (cookie: string, path: string, body: unknown) => {
        const response = await fetch(`${set.url}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify(body) })
        return { status: response.status, body: await response.json() as Record<string, unknown> & { proposal?: { id: string; what: string; button: string }; answer?: { text: string; parts: { sources: number[] }[] }; sources?: unknown[] } }
      }
      const mark = marked(boardFor([set.place], 'you').passage.text, 'Fix the login page')!
      set.say(`DO stop ${mark}`)
      const asked = await post(you, '/api/brain/ask', { question: 'Stop the login page work' })
      assert.equal(asked.status, 200)
      assert.equal(asked.body.proposal?.button, 'Stop it')
      assert.match(asked.body.proposal!.what, /^Stop “Fix the login page”/)
      assert.equal(set.cardNow('working').stage, 'working')

      const someoneElse = await signIn('sam')
      assert.equal((await post(someoneElse, '/api/brain/do', { id: asked.body.proposal!.id, go: true })).status, 422, 'not theirs')
      assert.equal(set.cardNow('working').stage, 'working')

      const done = await post(you, '/api/brain/do', { id: asked.body.proposal!.id, go: true })
      assert.deepEqual(done.body, { said: 'Stopped “Fix the login page”. It’s in Proposed.' })
      assert.equal(set.cardNow('working').stage, 'proposed')
      assert.equal((await post(you, '/api/brain/do', { id: asked.body.proposal!.id, go: true })).status, 422, 'only once')
    } finally {
      await set.close()
    }
  })

  it('answers from the board when nothing in the notes matches, and doesn’t show it as a source', async () => {
    const set = await setUp()
    try {
      set.say('Sonnet is on the login page.')
      const result = await ask(set.settings, set.places, 'zzzqqq', { person: 'you' })
      assert.equal(result.answer?.text, 'Sonnet is on the login page.')
      assert.deepEqual(result.sources, [])
      assert.deepEqual(result.answer?.parts[0].sources, [], 'the board is no source')
      assert.equal(askText(result), 'Sonnet is on the login page.')
      assert.match(set.seen[0].more!, /only tell them how things stand/)
      assert.doesNotMatch(set.seen[0].more!, /DO stop/)
    } finally {
      await set.close()
    }
  })

  it('doesn’t offer the lines for a question, and does nothing when a model gives one anyway', async () => {
    const set = await setUp()
    try {
      const mark = marked(boardFor([set.place], 'you').passage.text, 'The November release')!
      set.say(`You should check its checks.\nDO approve ${mark}`)
      const talked = await talk(set.settings, set.places, [{ role: 'user', text: 'What should I think about before approving it?' }], { person: 'you' })
      assert.equal(talked.reply, 'You should check its checks.')
      assert.doesNotMatch(set.seen[0].more!, /DO stop/)
      set.say(`DO approve ${mark}`)
      const asked = await ask(set.settings, set.places, 'Should I approve it?', { person: 'you', may: true })
      assert.equal(asked.proposal, undefined)
      assert.match(asked.answer!.text, /That’s a question/)
      assert.equal(set.hub.state.changeSets.find((s) => s.id === 'set-18')?.state, 'review')
      assert.equal(await (async () => { set.say('Sure.'); return (await talk(set.settings, set.places, [{ role: 'user', text: 'approve' }], { person: 'you' })).reply })(), 'Sure.', 'nothing was waiting for an answer')
    } finally {
      await set.close()
    }
  })

  it('does nothing with a line where the person can’t answer it', async () => {
    const set = await setUp()
    try {
      const mark = marked(boardFor([set.place], 'you').passage.text, 'Fix the login page')!
      set.say(`DO stop ${mark}`)
      const result = await ask(set.settings, set.places, 'zzzqqq', { person: 'you' })
      assert.equal(result.proposal, undefined)
      assert.match(result.answer!.text, /can’t do that from here/)
      assert.equal(takeProposal('you', 'anything'), undefined)
      assert.equal(set.cardNow('working').stage, 'working')
    } finally {
      await set.close()
    }
  })

  it('without a person, answers as before, from the notes alone', async () => {
    const set = await setUp()
    try {
      set.say('From the notes.')
      assert.equal((await talk(set.settings, set.places, [{ role: 'user', text: 'first note' }])).reply, 'From the notes.')
      assert.ok(!set.seen[0].passages.includes('What’s going on now'))
      assert.equal(set.seen[0].more, undefined)
    } finally {
      await set.close()
    }
  })
})
