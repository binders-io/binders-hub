import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { applyChange, emptyState, type HubState } from '../../shared/state.ts'
import { headChars, leftOf, type Note } from '../../shared/notes.ts'
import { lightChange, lightState, newestActivity, recentActivityMs } from '../../shared/light.ts'
import type { BlastRadius, BlastSymbol, Challenge } from '../../shared/changeSet.ts'
import { isOld, leftCard, oldAfterMs, type Activity, type Agent, type Card, type ChangeSet, type FileDiff, type PullRequest } from '../../shared/work.ts'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { fakeGitHub, note, oneSpace, seed } from './helpers.ts'

// What a browser loads of a Binder, and what the hub keeps for good: a card's activity beyond the recent lines is asked
// for when the card opens, a card's worktree goes once its pull request has the diff, and a pull request's lines go two
// weeks after it's over, to be read from GitHub when someone opens it.

const now = Date.parse('2026-11-09T12:00:00.000Z')
const hours = (n: number) => new Date(now - n * 3_600_000).toISOString()
const days = (n: number) => hours(n * 24)

const line = (at: string, text: string, kind: Activity['kind'] = 'step'): Activity => ({ at, by: 'builder', kind, tool: 'Bash', text, result: 'ok' })
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'live', createdAt: days(30), createdBy: 'ana', updatedAt: days(10), waitsFor: [], activity: [], ...extra })
const agent: Agent = { id: 'builder', name: 'Builder', provider: 'claude', owner: 'ana', repos: [], binders: [], skills: [], createdAt: days(40) }
const diff = (path: string, lines = 6): FileDiff => ({ path, added: lines, removed: 0, lines: Array.from({ length: lines }, (_, n) => ({ kind: '+' as const, text: `line ${n} of ${path}`, n: n + 1 })) })
const pull = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Pull ${number}`, branch: `agent/${number}`, url: `https://github.test/acme/web/pull/${number}`, state: 'merged', cardId: `c${number}`, checks: [], files: [diff('src/a.ts'), diff('src/b.ts')], ...extra })

const symbol = (name: string): BlastSymbol => ({ name, file: 'src/a.ts', change: 'changed', uses: [{ file: 'src/b.ts', line: 3, text: `${name}()` }], more: 2, tests: ['test/a.test.ts'] })
const blast = (count = 4): BlastRadius => ({ at: hours(2), repo: 'acme/web', symbols: Array.from({ length: count }, (_, n) => symbol(`fn${n}`)), outside: 9, stillUsed: 1, untested: 2, elsewhere: ['acme/api'], cut: 5 })
const challenged = (b?: BlastRadius): Challenge => ({ state: 'done', askedBy: 'ana', askedAt: hours(3), agentId: 'builder', authors: [], picked: 'person', ...(b ? { blast: b } : {}) }) as Challenge
const set = (id: string, challenge?: Challenge): ChangeSet => ({ id, binderId: 'b1', number: 1, title: `Set ${id}`, summary: '', state: 'review', prIds: [], noteIds: [], ...(challenge ? { challenge } : {}) })

/** A hub and its actions, with the clock at `now`. */
async function setUp(github?: Awaited<ReturnType<typeof fakeGitHub>>) {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const kv = new MemoryKV()
  const sealer = new Sealer('test-secret')
  const connection = new GitHubConnection(kv, sealer, { webUrl: github?.url ?? 'http://unused', apiUrl: github?.url ?? 'http://unused' }, github ? { clientId: 'id', clientSecret: 'secret', token: 'ghs_server' } : {})
  const actions = new Actions(hub, connection)
  ;(actions as unknown as { now: () => string }).now = () => new Date(now).toISOString()
  await hub.record({ kind: 'hub' }, { type: 'agent.put', agent })
  return { hub, kv, sealer, connection, actions }
}

async function serve(set: Awaited<ReturnType<typeof setUp>>) {
  const auth = new Auth(set.kv, set.sealer, { github: () => set.connection.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
  const app = await buildServer(oneSpace(set.kv, { hub: set.hub, actions: set.actions, github: set.connection } as never), { auth }, { publicUrl: 'http://hub.test' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const login = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'you' }) })
  const cookie = /binders_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  const as = async (path: string) => {
    const response = await fetch(`${url}${path}`, { headers: { cookie, 'x-binders': '1' } })
    return { status: response.status, body: await response.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return { as, close: () => app.close() }
}

describe('a card in a browser’s state', () => {
  it('has the lines from the last two days and its newest few, in order, and says how many it left out', () => {
    const activity = [
      ...Array.from({ length: 30 }, (_, n) => line(days(10 - n / 10), `old ${n}`)),
      line(hours(50), 'just over two days ago'),
      line(hours(48), 'two days ago'),
      ...Array.from({ length: 20 }, (_, n) => line(hours(30 - n), `recent ${n}`)),
    ]
    const light = lightState({ ...emptyState(), cards: [card('c1', { activity })] }, now).cards[0]
    // All of the last two days, though that's more than the newest few; nothing older, but for the newest few.
    assert.deepEqual(light.activity.map((a) => a.text), ['two days ago', ...Array.from({ length: 20 }, (_, n) => `recent ${n}`)])
    assert.ok(light.activity.length > newestActivity)
    assert.equal(light.activityMore, 31)
    assert.equal(light.activity.length + light.activityMore!, activity.length)
    assert.ok(Date.parse(light.activity[0].at) >= now - recentActivityMs)
  })

  it('keeps all the recent lines of a busy card, however many, and just the newest few of a quiet one', () => {
    const busy = card('busy', { stage: 'working', activity: Array.from({ length: 300 }, (_, n) => line(hours(20 - n / 20), `busy ${n}`)) })
    const quiet = card('quiet', { activity: Array.from({ length: 100 }, (_, n) => line(days(20 - n / 10), `quiet ${n}`)) })
    const [b, q] = lightState({ ...emptyState(), cards: [busy, quiet] }, now).cards
    assert.equal(b.activity.length, 300)
    assert.equal(b.activityMore, undefined, 'nothing left out')
    assert.equal(q.activity.length, newestActivity)
    assert.deepEqual(q.activity.map((a) => a.text), quiet.activity.slice(-newestActivity).map((a) => a.text))
    assert.equal(q.activityMore, 100 - newestActivity)
  })

  it('is left as it is when it has few lines, and a state from before this goes through', () => {
    const short = card('short', { activity: [line(days(9), 'one'), line(days(8), 'two')] })
    const odd = { ...card('odd'), activity: undefined } as unknown as Card
    const { cards } = lightState({ ...emptyState(), cards: [short, odd] }, now)
    assert.equal(cards[0], short)
    assert.equal(cards[1].activity, undefined)
  })

  it('is cut in the live feed’s card.put, and a line that arrives live is as it was', () => {
    const quiet = card('quiet', { activity: Array.from({ length: 50 }, (_, n) => line(days(20 - n / 10), `quiet ${n}`)) })
    const put = lightChange({ type: 'card.put', card: quiet }, now)
    assert.equal(put.type === 'card.put' && put.card.activity.length, newestActivity)
    const added = { type: 'card.activity' as const, id: 'quiet', activity: line(hours(0), 'live') }
    assert.equal(lightChange(added, now), added)
  })

  it('makes the state a browser loads well under half of what it was, at the size measured on the live hub', () => {
    const cards = Array.from({ length: 101 }, (_, n) => {
      // Mostly finished weeks ago, a few worked on today; some with a lot of lines, the largest at the most kept.
      const count = n === 0 ? 400 : 60 + ((n * 37) % 200)
      const recent = n % 10 === 0
      return card(`c${n}`, {
        stage: recent ? 'working' : 'live',
        activity: Array.from({ length: count }, (_, i) => line(recent ? hours((count - i) / 20) : days(5 + (count - i) / 10), `Ran the checks for part ${i} of the work and read what they said back, then went on to the next file`)),
      })
    })
    const notes = Array.from({ length: 32 }, (_, n) => ({ id: `n${n}`, title: `Note ${n}`, binderId: 'b1', editedAt: days(2), editors: ['ana'], text: `# Note ${n}\n\n${'Words about what to build. '.repeat(80)}` }))
    const state: HubState = { ...emptyState(), notes, cards }
    // A clock at the start of time keeps every line, which is the light state as it was before activity was cut.
    const before = JSON.stringify(lightState(state, 0)).length
    const after = JSON.stringify(lightState(state, now)).length
    console.log(`light state: ${(before / 1e6).toFixed(2)} MB before, ${(after / 1e6).toFixed(2)} MB after`)
    assert.ok(before > 3_000_000, 'about the size measured')
    assert.ok(after < before / 2, `${after} of ${before}`)
    assert.ok(after < before / 4, 'well under half')
  })
})

describe('a Challenge’s blast radius in a browser’s state', () => {
  it('keeps its counts and loses its symbols, saying how many there were, on a card and on a change set', () => {
    const light = lightState({ ...emptyState(), cards: [card('c1', { challenge: challenged(blast(4)) })], changeSets: [set('s1', challenged(blast(7)))] }, now)
    const { symbols, symbolCount, ...counts } = light.cards[0].challenge!.blast!
    assert.deepEqual(symbols, [])
    assert.equal(symbolCount, 4)
    const { symbols: _symbols, ...whole } = blast(4)
    assert.deepEqual(counts, whole, 'outside, stillUsed, untested, cut, repo, elsewhere and at stay')
    const forSet = light.changeSets[0].challenge!.blast!
    assert.deepEqual(forSet.symbols, [])
    assert.equal(forSet.symbolCount, 7)
    assert.equal(forSet.outside, 9)
    assert.equal(light.cards[0].challenge!.state, 'done')
  })

  it('leaves what it can’t cut as the same object: no blast, no symbols, a card with no Challenge', () => {
    const bare = card('c1')
    const noBlast = card('c2', { challenge: challenged() })
    const empty = card('c3', { challenge: challenged(blast(0)) })
    const odd = card('c4', { challenge: challenged({ ...blast(), symbols: undefined } as unknown as BlastRadius) })
    const mine = set('s1', challenged(blast(0)))
    const none = set('s2')
    const light = lightState({ ...emptyState(), cards: [bare, noBlast, empty, odd], changeSets: [mine, none] }, now)
    assert.deepEqual(light.cards, [bare, noBlast, empty, odd])
    light.cards.forEach((c, n) => assert.equal(c, [bare, noBlast, empty, odd][n]))
    assert.equal(light.changeSets[0], mine)
    assert.equal(light.changeSets[1], none)
  })

  it('is cut in the live feed’s card.put, card.update, set.put and set.update, and passed along when there’s nothing to cut', () => {
    const put = lightChange({ type: 'card.put', card: card('c1', { challenge: challenged(blast(3)) }) }, now)
    assert.ok(put.type === 'card.put' && put.card.challenge!.blast!.symbols.length === 0 && put.card.challenge!.blast!.symbolCount === 3)
    const update = lightChange({ type: 'card.update', id: 'c1', fields: { challenge: challenged(blast(3)), title: 'New' } }, now)
    assert.ok(update.type === 'card.update' && update.fields.title === 'New' && update.fields.challenge!.blast!.symbolCount === 3 && update.fields.challenge!.blast!.symbols.length === 0)
    const setPut = lightChange({ type: 'set.put', set: set('s1', challenged(blast(5))) }, now)
    assert.ok(setPut.type === 'set.put' && setPut.set.challenge!.blast!.symbolCount === 5 && setPut.set.challenge!.blast!.symbols.length === 0)
    const setUpdate = lightChange({ type: 'set.update', id: 's1', fields: { challenge: challenged(blast(5)) } }, now)
    assert.ok(setUpdate.type === 'set.update' && setUpdate.fields.challenge!.blast!.symbolCount === 5 && setUpdate.fields.challenge!.blast!.symbols.length === 0)

    // Nothing to cut: the same change, or the same card, back.
    const cardChange = { type: 'card.update' as const, id: 'c1', fields: { challenge: challenged(blast(0)) } }
    assert.equal(lightChange(cardChange, now), cardChange)
    const noChallenge = { type: 'card.update' as const, id: 'c1', fields: { title: 'New' } }
    assert.equal(lightChange(noChallenge, now), noChallenge)
    const cleared = { type: 'card.update' as const, id: 'c1', fields: { challenge: undefined } }
    assert.equal(lightChange(cleared, now), cleared)
    const bare = card('c2')
    const putBare = { type: 'card.put' as const, card: bare }
    assert.equal((lightChange(putBare, now) as typeof putBare).card, bare)
    const quiet = set('s2', challenged(blast(0)))
    assert.equal((lightChange({ type: 'set.put', set: quiet }, now) as { set: ChangeSet }).set, quiet)
    const setNone = { type: 'set.update' as const, id: 's2', fields: { title: 'New' } }
    assert.equal(lightChange(setNone, now), setNone)
  })
})

describe('GET /api/cards/:id/blast and /api/sets/:id/blast', () => {
  it('give the whole blast radius, while the state a browser loads has the counts alone, and the apps’ state all of it', async () => {
    const set0 = await setUp()
    await set0.hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { updatedAt: new Date().toISOString(), challenge: challenged(blast(4)) }) })
    await set0.hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c2') })
    await set0.hub.record({ kind: 'hub' }, { type: 'set.put', set: set('s1', challenged(blast(6))) })
    await set0.hub.record({ kind: 'hub' }, { type: 'set.put', set: set('s2') })
    const { as, close } = await serve(set0)
    assert.deepEqual((await as('/api/cards/c1/blast')).body.blast, blast(4))
    assert.deepEqual((await as('/api/sets/s1/blast')).body.blast, blast(6))
    // No Challenge, so no blast: an answer, with nothing in it.
    const none = await as('/api/cards/c2/blast')
    assert.equal(none.status, 200)
    assert.equal(none.body.blast, undefined)
    assert.equal((await as('/api/sets/s2/blast')).body.blast, undefined)
    assert.equal((await as('/api/cards/nope/blast')).status, 404)
    assert.equal((await as('/api/cards/nope/blast')).body.error, 'No such card.')
    assert.equal((await as('/api/sets/nope/blast')).status, 404)
    assert.equal((await as('/api/sets/nope/blast')).body.error, 'No such change set.')
    const light = (await as('/api/state?light=1')).body.state
    assert.equal(light.cards[0].challenge.blast.symbols.length, 0)
    assert.equal(light.cards[0].challenge.blast.symbolCount, 4)
    assert.equal(light.changeSets[0].challenge.blast.symbolCount, 6)
    const whole = (await as('/api/state')).body.state
    assert.equal(whole.cards[0].challenge.blast.symbols.length, 4, 'the Mac app sees no change')
    assert.equal(whole.cards[0].challenge.blast.symbolCount, undefined)
    assert.equal(whole.changeSets[0].challenge.blast.symbols.length, 6)
    await close()
  })
})

describe('GET /api/cards/:id/activity', () => {
  it('gives a card’s whole activity, while the state a browser loads has the recent lines, and the apps’ state all of it', async () => {
    const set = await setUp()
    const activity = Array.from({ length: 60 }, (_, n) => line(days(20 - n / 10), `step ${n}`))
    await set.hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { updatedAt: new Date().toISOString(), activity }) })
    const { as, close } = await serve(set)
    const all = (await as('/api/cards/c1/activity')).body.activity as Activity[]
    assert.equal(all.length, 60)
    assert.deepEqual(all.map((a) => a.text), activity.map((a) => a.text))
    const light = (await as('/api/state?light=1')).body.state.cards[0] as Card
    assert.equal(light.activity.length, newestActivity)
    assert.equal(light.activityMore, 48)
    const whole = (await as('/api/state')).body.state.cards[0] as Card
    assert.equal(whole.activity.length, 60, 'the Mac app sees no change')
    assert.equal(whole.activityMore, undefined)
    assert.equal((await as('/api/cards/nope/activity')).status, 404)
    await close()
  })
})

describe('a card’s worktree', () => {
  const worktree = { branch: 'agent/1', base: 'main', files: [diff('src/a.ts')], at: hours(3) }

  it('goes when the card is finished with no pull request, and when it’s finished with one that has the diff', async () => {
    const github = await fakeGitHub()
    const { hub, actions } = await setUp(github)
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder', worktree }) })
    await actions.complete('builder', 'c1', 'Nothing to push.')
    assert.equal(hub.state.cards[0].stage, 'live')
    assert.equal(hub.state.cards[0].worktree, undefined)

    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c7', { stage: 'working', agentId: 'builder', worktree }) })
    await actions.complete('builder', 'c7', 'Added it.', 'acme/web#7')
    const done = hub.state.cards.find((c) => c.id === 'c7')!
    assert.equal(done.stage, 'review')
    assert.ok(hub.state.pulls[0].files.length, 'the pull request has the diff')
    assert.equal(done.worktree, undefined)
    await github.close()
  })

  it('stays while its pull request has no files yet, since that’s then the only diff, and goes once it has them', async () => {
    const { hub, actions } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder', worktree }) })
    // No GitHub to read the files from.
    await actions.linkPull('acme/web', 1, { cardId: 'c1', agentId: 'builder' })
    assert.deepEqual(hub.state.cards[0].worktree, worktree)
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: 'acme/web#1', fields: { files: [diff('src/a.ts')] } })
    // Nothing clears it in the meantime: the tidying does.
    assert.equal(await actions.clearDoneWorktrees(), 1)
    assert.equal(hub.state.cards[0].worktree, undefined)
    assert.equal(await actions.clearDoneWorktrees(), 0)
  })

  it('isn’t kept again when the runner reports once the pull request has the diff, and is while there’s none', async () => {
    const { hub, actions } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder' }) })
    const report = { branch: 'agent/1', base: 'main', diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n a\n+b\n' }
    const made = await actions.reportDiff('builder', 'c1', report)
    assert.equal(made.files.length, 1)
    assert.equal(hub.state.cards[0].worktree?.files.length, 1)
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: 'c1', fields: { worktree: undefined } })
    await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(1, { state: 'open', cardId: 'c1' }) })
    const again = await actions.reportDiff('builder', 'c1', report)
    assert.equal(again.files.length, 1, 'the runner is still answered')
    assert.equal(hub.state.cards[0].worktree, undefined)
  })

  it('is let go of for cards that were already done or already in a pull request, a few at a time', async () => {
    const { hub, actions } = await setUp()
    for (let n = 0; n < 25; n++) await hub.record({ kind: 'hub' }, { type: 'card.put', card: card(`d${n}`, { worktree }) })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('busy', { stage: 'working', agentId: 'builder', worktree }) })
    assert.equal(await actions.clearDoneWorktrees(20), 20)
    assert.equal(await actions.clearDoneWorktrees(20), 5)
    assert.ok(hub.state.cards.find((c) => c.id === 'busy')!.worktree, 'one being worked on keeps its own')
  })
})

describe('a merged pull request’s diff', () => {
  const week = 7 * 86_400_000

  it('is kept for two weeks, then only its files’ names and counts are, and it says so', async () => {
    const { hub, actions } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { activity: [line(days(20), 'Merged with change set #1', 'merged')] }) })
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c2', { activity: [line(days(5), 'Merged with change set #2', 'merged')] }) })
    await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(1) })
    await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(2) })
    let clock = new Date(now)
    const scheduler = new Scheduler(hub, actions, { now: () => clock })
    await scheduler.tick()
    const [old, recent] = hub.state.pulls
    assert.deepEqual(old.files.map((f) => [f.path, f.added, f.removed, f.lines.length]), [['src/a.ts', 6, 0, 0], ['src/b.ts', 6, 0, 0]])
    assert.equal(old.linesDropped, true)
    assert.equal(recent.files[0].lines.length, 6, 'five days is too soon')
    assert.equal(recent.linesDropped, undefined)

    // Ten days on, it's been over for fifteen.
    clock = new Date(now + 10 * 86_400_000)
    await scheduler.tick()
    assert.equal(hub.state.pulls[1].linesDropped, true)
    assert.equal(hub.state.pulls[1].files[0].lines.length, 0)
  })

  it('can be given a shorter wait and a clock, and counts a closed one too, from when the hub first saw it over when its card doesn’t say', async () => {
    const { hub, actions } = await setUp()
    await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(3, { state: 'closed', cardId: undefined }) })
    await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(4, { state: 'open', cardId: undefined }) })
    let clock = new Date(now)
    const scheduler = new Scheduler(hub, actions, { now: () => clock, diffKeptMs: week })
    await scheduler.tick()
    assert.equal(hub.state.pulls[0].endedAt, new Date(now).toISOString())
    assert.equal(hub.state.pulls[0].linesDropped, undefined)
    clock = new Date(now + week - 1000)
    await scheduler.tick()
    assert.equal(hub.state.pulls[0].linesDropped, undefined)
    clock = new Date(now + week + 1000)
    await scheduler.tick()
    assert.equal(hub.state.pulls[0].linesDropped, true)
    assert.equal(hub.state.pulls[1].files[0].lines.length, 6, 'an open one keeps its lines however old')
    assert.equal(hub.state.pulls[1].endedAt, undefined)
  })

  it('is done 20 pull requests a pass, each pass one change of that size at most', async () => {
    const { hub, actions } = await setUp()
    for (let n = 1; n <= 45; n++) await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(n, { endedAt: days(30), cardId: undefined }) })
    const scheduler = new Scheduler(hub, actions, { now: () => new Date(now) })
    const before = hub.version
    await scheduler.tick()
    assert.equal(hub.state.pulls.filter((p) => p.linesDropped).length, 20)
    assert.equal(hub.version - before, 20, 'twenty small changes, not one for all')
    await scheduler.tick()
    assert.equal(hub.state.pulls.filter((p) => p.linesDropped).length, 40)
    await scheduler.tick()
    assert.equal(hub.state.pulls.filter((p) => p.linesDropped).length, 45)
    const version = hub.version
    await scheduler.tick()
    assert.equal(hub.version, version, 'then nothing to do')
  })

  it('is read from GitHub when it’s opened, and not put back in the state', async () => {
    const github = await fakeGitHub()
    const set = await setUp(github)
    await set.hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(7, { files: [{ path: 'src/a.ts', added: 2, removed: 1, lines: [] }], linesDropped: true }) })
    await set.hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(8) })
    const { as, close } = await serve(set)
    const files = (await as('/api/pulls/acme%2Fweb/7/files')).body.files as FileDiff[]
    assert.equal(files[0].path, 'src/a.ts')
    assert.ok(files[0].lines.length > 0, 'its lines are here')
    assert.equal(set.hub.state.pulls[0].files[0].lines.length, 0, 'and not in the state')
    assert.equal(set.hub.state.pulls[0].linesDropped, true)
    // One that still has its lines answers from the state, and GitHub isn't asked.
    const asked = github.calls.length
    assert.equal(((await as('/api/pulls/acme%2Fweb/8/files')).body.files as FileDiff[])[0].lines.length, 6)
    assert.equal(github.calls.length, asked)
    await close()
    await github.close()
  })

  it('says, in plain words, when GitHub can’t be reached', async () => {
    const github = await fakeGitHub()
    const set = await setUp(github)
    await set.hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(7, { files: [{ path: 'src/a.ts', added: 2, removed: 1, lines: [] }], linesDropped: true }) })
    const { as, close } = await serve(set)
    await github.close()
    const down = await as('/api/pulls/acme%2Fweb/7/files')
    assert.equal(down.status, 422)
    assert.match(down.body.error, /GitHub didn’t answer/)
    await close()

    // The hub with no GitHub at all.
    const none = await setUp()
    await none.hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(7, { linesDropped: true }) })
    const bare = await serve(none)
    const refused = await bare.as('/api/pulls/acme%2Fweb/7/files')
    assert.equal(refused.status, 422)
    assert.match(refused.body.error, /can’t reach GitHub/)
    await bare.close()
  })

  it('has its lines back when it’s read again, as the hub reads a pull request it links', async () => {
    const github = await fakeGitHub()
    const { hub, actions } = await setUp(github)
    await hub.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(7, { files: [{ path: 'src/a.ts', added: 2, removed: 1, lines: [] }], linesDropped: true }) })
    const linked = await actions.linkPull('acme/web', 7, {})
    assert.equal(linked.linesDropped, undefined)
    assert.ok(linked.files[0].lines.length > 0)
    await github.close()
  })

  it('loads from a state saved before any of this, which has none of the new fields', async () => {
    const log = new MemoryLog()
    const first = new Hub(log)
    await first.start(seed())
    await first.record({ kind: 'hub' }, { type: 'pr.put', pull: pull(1) })
    await first.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { worktree: { branch: 'b', base: 'main', files: [diff('x.ts')], at: days(40) } }) })
    const second = new Hub(log)
    await second.start(seed())
    assert.equal(second.state.pulls[0].files[0].lines.length, 6)
    const actions = new Actions(second, { forRepo: async () => undefined } as never)
    assert.equal(await actions.clearDoneWorktrees(), 1)
    assert.equal(await actions.dropOldDiffs(now, 14 * 86_400_000), 1, 'dated first')
  })
})

describe('a note in a browser’s state', () => {
  const long = `# Long\n\nSee [[Plan]] and [[plan|the plan]] and [[Other#Part]].\n\n${'More words. '.repeat(100)}`
  const withNote = (n: Note): HubState => ({ ...emptyState(), notes: [n] })
  const only = (state: HubState) => state.notes[0]

  it('has no text, and says how long it is, how it starts and what it links to', () => {
    const state = withNote(note('n1', 'Long', { text: long }))
    const light = only(lightState(state))
    assert.equal(light.text, '')
    assert.equal(light.title, 'Long')
    assert.equal(light.left?.size, long.length)
    assert.equal(light.left?.head, long.slice(0, headChars))
    assert.equal(light.left?.head.length, headChars)
    assert.deepEqual(light.left?.links, ['plan', 'other'], 'in lower case, each once')
    assert.deepEqual(light.left, leftOf(long))
  })

  it('leaves the hub’s own state whole', () => {
    const state = withNote(note('n1', 'Long', { text: long }))
    lightState(state)
    assert.equal(only(state).text, long)
    assert.equal(only(state).left, undefined)
    // A note already light is not worked out again.
    const light = lightState(state)
    assert.equal(only(lightState(light)), only(light))
  })

  it('stays light when it’s edited, and what stands in for its text follows', () => {
    const light = lightState(withNote(note('n1', 'Long', { text: long })))
    const edited = '# Longer\n\nNow it links [[Third]] only.\n'
    const next = only(applyChange(light, { type: 'note.edit', id: 'n1', text: edited, title: 'Longer', by: 'sam', at: '2026-11-10T08:00:00.000Z' }))
    assert.equal(next.text, '')
    assert.equal(next.title, 'Longer')
    assert.deepEqual(next.left, { size: edited.length, head: edited, links: ['third'] })
    assert.deepEqual(next.editors, ['you', 'sam'])
  })

  it('stays light when it’s put whole, and what stands in for its text follows', () => {
    const light = lightState(withNote(note('n1', 'Long', { text: long })))
    const put = note('n1', 'Renamed', { text: '# Renamed\n\nA [[Fourth]] link.\n', editedAt: '2026-11-10T09:00:00.000Z' })
    const next = only(applyChange(light, { type: 'note.put', note: put }))
    assert.equal(next.text, '')
    assert.equal(next.title, 'Renamed')
    assert.equal(next.editedAt, '2026-11-10T09:00:00.000Z')
    assert.deepEqual(next.left, leftOf(put.text))
  })

  it('takes the text as before when it’s held whole, on an edit and on a put', () => {
    const whole = withNote(note('n1', 'Long', { text: long }))
    const edited = only(applyChange(whole, { type: 'note.edit', id: 'n1', text: '# New\n', title: 'New', by: 'you', at: '2026-11-10T08:00:00.000Z' }))
    assert.equal(edited.text, '# New\n')
    assert.equal(edited.left, undefined)
    const put = only(applyChange(whole, { type: 'note.put', note: note('n1', 'Put', { text: '# Put\n' }) }))
    assert.equal(put.text, '# Put\n')
    assert.equal(put.left, undefined)
  })

  it('arrives whole when it’s new to a browser, even one holding every other note light', () => {
    const light = lightState(withNote(note('n1', 'Long', { text: long })))
    const next = applyChange(light, { type: 'note.put', note: note('n2', 'Fresh', { text: '# Fresh\n\nJust written.\n' }) })
    assert.equal(next.notes.find((n) => n.id === 'n2')?.text, '# Fresh\n\nJust written.\n')
    assert.equal(next.notes.find((n) => n.id === 'n2')?.left, undefined)
    assert.equal(next.notes.find((n) => n.id === 'n1')?.text, '')
  })
})

describe('a card that finished a while ago', () => {
  const written = { state: 'done', askedBy: 'ana', askedAt: days(20), agentId: 'builder', writtenAt: days(20) } as Card['debrief']
  const finding = (id: string, outcome?: { kind: 'dismissed'; by: string; at: string }) => ({ id, kind: 'bug', file: 'src/a.ts', line: 3, what: 'It breaks.', confidence: 'high', severity: 'high', ...(outcome ? { outcome } : {}) })
  const reviewed = (findings: unknown[], state: 'done' | 'asked' | 'reviewing' = 'done') => ({ ...challenged(), state, findings }) as unknown as Card['challenge']
  const plan = [{ id: 'p1', text: 'Do it', done: true }] as unknown as Card['plan']
  const detail = (extra: Partial<Card> = {}) => card('c1', {
    brief: 'The whole brief.', doneWhen: 'It works.', updatedAt: days(15), activity: [line(days(16), 'one'), line(days(15), 'two'), line(days(15), 'three')],
    debrief: written, challenge: reviewed([finding('f1', { kind: 'dismissed', by: 'ana', at: days(16) })]), plan,
    worktree: { branch: 'agent/1', base: 'main', files: [diff('src/a.ts')], at: days(16) }, ...extra,
  })
  const wholeState = (c: Card): HubState => ({ ...emptyState(), cards: [c] })
  const only = (state: HubState) => state.cards[0]

  describe('isOld', () => {
    it('is true for a live card last changed 15 days ago, and false for 13', () => {
      assert.equal(isOld(card('c1', { updatedAt: days(15) }), now), true)
      assert.equal(isOld(card('c1', { updatedAt: days(13) }), now), false)
      assert.equal(oldAfterMs, 14 * 86_400_000)
      assert.equal(isOld(card('c1', { updatedAt: new Date(now - oldAfterMs).toISOString() }), now), false, 'exactly 14 days is not over')
    })

    it('is false for a stage other than live', () => {
      for (const stage of ['ready', 'working', 'review', 'blocked'] as const) assert.equal(isOld(card('c1', { stage, updatedAt: days(30) }), now), false, stage)
    })

    it('is false while a person is waited on', () => {
      assert.equal(isOld(card('c1', { updatedAt: days(30), needsYou: 'Which one?' }), now), false)
      assert.equal(isOld(card('c1', { updatedAt: days(30), permission: { request: 'r1', agent: 'builder', tool: 'Bash', what: 'rm', at: days(30) } }), now), false)
    })

    it('is false while a Challenge finding has no outcome, and true once each has one', () => {
      assert.equal(isOld(card('c1', { updatedAt: days(30), challenge: reviewed([finding('f1')]) }), now), false)
      assert.equal(isOld(card('c1', { updatedAt: days(30), challenge: reviewed([finding('f1', { kind: 'dismissed', by: 'ana', at: days(29) }), finding('f2')]) }), now), false)
      assert.equal(isOld(card('c1', { updatedAt: days(30), challenge: reviewed([finding('f1', { kind: 'dismissed', by: 'ana', at: days(29) })]) }), now), true)
      assert.equal(isOld(card('c1', { updatedAt: days(30), challenge: reviewed([]) }), now), true, 'nothing found, nothing open')
    })

    it('is false while a debrief is asked for or being written, and true when it’s written or failed', () => {
      for (const state of ['asked', 'writing'] as const) assert.equal(isOld(card('c1', { updatedAt: days(30), debrief: { ...written!, state } }), now), false, state)
      for (const state of ['done', 'failed'] as const) assert.equal(isOld(card('c1', { updatedAt: days(30), debrief: { ...written!, state } }), now), true, state)
    })

    it('is false while a Challenge is asked for or under review', () => {
      for (const state of ['asked', 'reviewing'] as const) assert.equal(isOld(card('c1', { updatedAt: days(30), challenge: reviewed([], state) }), now), false, state)
      assert.equal(isOld(card('c1', { updatedAt: days(30), challenge: { ...challenged(), state: 'failed' } }), now), true)
    })

    it('is false for a date that isn’t a date', () => {
      assert.equal(isOld(card('c1', { updatedAt: 'now' }), now), false)
      assert.equal(isOld(card('c1', { updatedAt: '' }), now), false)
    })
  })

  describe('leftCard', () => {
    it('keeps what a list shows of it', () => {
      const full = detail({
        noteId: 'n1', quote: 'the words', agentId: 'builder', issue: { repo: 'acme/web', number: 4, url: 'https://github.test/4' }, jira: { key: 'WEB-4', url: 'https://jira.test/WEB-4' },
        prId: 'acme/web#4', parent: 'c0', waitsFor: ['c2'], cost: 1.5, tokens: 1200, minutes: 7,
      })
      const left = leftCard(full)
      for (const key of ['id', 'binderId', 'title', 'stage', 'size', 'createdAt', 'createdBy', 'updatedAt', 'noteId', 'quote', 'agentId', 'issue', 'jira', 'prId', 'parent', 'waitsFor', 'cost', 'tokens', 'minutes'] as const) {
        assert.deepEqual(left[key], full[key], key)
      }
    })

    it('empties its brief, done-when and activity, and drops its plan, worktree, debrief, Challenge and permission', () => {
      const left = leftCard(detail({ permission: { request: 'r1', agent: 'builder', tool: 'Bash', what: 'rm', at: days(20) } }))
      assert.equal(left.brief, '')
      assert.equal(left.doneWhen, '')
      assert.deepEqual(left.activity, [])
      for (const key of ['plan', 'worktree', 'debrief', 'challenge', 'permission'] as const) assert.equal(key in left, false, key)
    })

    it('counts every line of the activity it left out, on top of what was already left out', () => {
      assert.equal(leftCard(detail()).activityMore, 3)
      assert.equal(leftCard(detail({ activityMore: 40 })).activityMore, 43)
      assert.equal(leftCard(card('c1')).activityMore, 0)
    })

    it('says how its debrief and Challenge stood, and says nothing of ones it never had', () => {
      assert.deepEqual(leftCard(detail()).left, { debrief: 'done', challenge: 'done' })
      assert.deepEqual(leftCard(detail({ debrief: { ...written!, state: 'failed' }, challenge: undefined })).left, { debrief: 'failed' })
      assert.deepEqual(leftCard(card('c1')).left, {})
    })

    it('leaves the card it was given as it was, and a card that’s already light as the same object', () => {
      const full = detail()
      const before = JSON.stringify(full)
      const left = leftCard(full)
      assert.equal(JSON.stringify(full), before)
      assert.equal(full.left, undefined)
      assert.equal(leftCard(left), left)
    })
  })

  describe('through the reducer, on a card held light', () => {
    const light = () => wholeState(leftCard(detail()))
    const at = days(1)

    it('stays light when a card.update brings a brief, a done-when, a plan, a worktree and a permission', () => {
      const next = only(applyChange(light(), { type: 'card.update', id: 'c1', fields: { brief: 'New brief.', doneWhen: 'New check.', plan, worktree: { branch: 'b', base: 'main', files: [], at }, permission: { request: 'r1', agent: 'builder', tool: 'Bash', what: 'rm', at }, title: 'Renamed', size: 'L' } }))
      assert.equal(next.brief, '')
      assert.equal(next.doneWhen, '')
      assert.equal(next.plan, undefined)
      assert.equal(next.worktree, undefined)
      assert.equal(next.permission, undefined)
      assert.equal(next.title, 'Renamed', 'what a list shows still follows')
      assert.equal(next.size, 'L')
      assert.deepEqual(next.activity, [])
      assert.ok(next.left)
    })

    it('stays light when a card.update brings a debrief, and says how the debrief stands', () => {
      const next = only(applyChange(light(), { type: 'card.update', id: 'c1', fields: { debrief: { ...written!, state: 'writing' } } }))
      assert.equal(next.debrief, undefined)
      assert.deepEqual(next.left, { debrief: 'writing', challenge: 'done' })
    })

    it('stays light when a card.update brings a Challenge, and says how the Challenge stands', () => {
      const next = only(applyChange(light(), { type: 'card.update', id: 'c1', fields: { challenge: reviewed([finding('f1')], 'reviewing') } }))
      assert.equal(next.challenge, undefined)
      assert.deepEqual(next.left, { debrief: 'done', challenge: 'reviewing' })
    })

    it('counts the activity line a card.update carries, and moves its date, and keeps no line', () => {
      const next = only(applyChange(light(), { type: 'card.update', id: 'c1', fields: { progress: 50 }, activity: line(at, 'new') }))
      assert.deepEqual(next.activity, [])
      assert.equal(next.activityMore, 4)
      assert.equal(next.updatedAt, at)
      assert.equal(next.progress, 50)
    })

    it('counts the line a card.activity brings and keeps none of it', () => {
      let state = light()
      state = applyChange(state, { type: 'card.activity', id: 'c1', activity: line(at, 'one') })
      state = applyChange(state, { type: 'card.activity', id: 'c1', activity: line(at, 'two') })
      assert.deepEqual(only(state).activity, [])
      assert.equal(only(state).activityMore, 5)
      assert.equal(only(state).updatedAt, at)
      assert.ok(only(state).left)
    })

    it('stores a card.put over it as the light of the new card, with how its debrief and Challenge stand', () => {
      const put = detail({ title: 'Put', brief: 'From the hub.', debrief: { ...written!, state: 'asked' }, challenge: undefined, activity: [line(at, 'a'), line(at, 'b')] })
      const next = only(applyChange(light(), { type: 'card.put', card: put }))
      assert.equal(next.title, 'Put')
      assert.equal(next.brief, '')
      assert.equal(next.doneWhen, '')
      assert.deepEqual(next.activity, [])
      assert.equal(next.activityMore, 2, 'the new card’s own lines, as a put replaces the card')
      for (const key of ['plan', 'worktree', 'debrief', 'challenge'] as const) assert.equal(key in next, false, key)
      assert.equal(next.left?.debrief, 'asked')
      assert.equal(next.left && 'challenge' in next.left, false, 'the new card has no Challenge, so nothing says it has')
    })

    it('stops saying it has a debrief once a change takes the debrief away, and keeps saying so through a change to something else', () => {
      const titled = only(applyChange(light(), { type: 'card.update', id: 'c1', fields: { title: 'Renamed' } }))
      assert.deepEqual(titled.left, only(light()).left, 'a change to its title leaves what stands in as it was')
      const cleared = only(applyChange(light(), { type: 'card.update', id: 'c1', fields: { debrief: undefined } }))
      assert.equal(cleared.left && 'debrief' in cleared.left, false)
      assert.equal(cleared.left?.challenge, only(light()).left?.challenge, 'and its Challenge still stands as it did')
    })

    it('leaves the other cards alone, and a card that is new to the browser comes whole', () => {
      const other = card('c2', { brief: 'Whole.', activity: [line(at, 'x')] })
      const state: HubState = { ...emptyState(), cards: [leftCard(detail()), other] }
      const next = applyChange(state, { type: 'card.update', id: 'c1', fields: { brief: 'X' } })
      assert.equal(next.cards[1], other)
      const fresh = applyChange(next, { type: 'card.put', card: card('c3', { brief: 'Fresh.', activity: [line(at, 'y')] }) })
      assert.equal(fresh.cards[2].brief, 'Fresh.')
      assert.equal(fresh.cards[2].left, undefined)
      assert.equal(fresh.cards[2].activity.length, 1)
    })

    it('takes a card.delete as before', () => {
      assert.deepEqual(applyChange(light(), { type: 'card.delete', id: 'c1' }).cards, [])
    })
  })

  describe('through the reducer, on a card held whole', () => {
    const at = days(1)

    it('takes everything as before', () => {
      const whole = wholeState(detail())
      const updated = only(applyChange(whole, { type: 'card.update', id: 'c1', fields: { brief: 'New brief.', doneWhen: 'New check.', debrief: { ...written!, state: 'writing' } }, activity: line(at, 'new') }))
      assert.equal(updated.brief, 'New brief.')
      assert.equal(updated.doneWhen, 'New check.')
      assert.equal(updated.debrief?.state, 'writing')
      assert.equal(updated.activity.length, 4)
      assert.equal(updated.left, undefined)
      const put = only(applyChange(whole, { type: 'card.put', card: card('c1', { brief: 'Put whole.', activity: [line(at, 'a')] }) }))
      assert.equal(put.brief, 'Put whole.')
      assert.equal(put.activity.length, 1)
      assert.equal(put.left, undefined)
      const activity = only(applyChange(whole, { type: 'card.activity', id: 'c1', activity: line(at, 'more') }))
      assert.equal(activity.activity.length, 4)
      assert.equal(activity.activityMore, undefined)
    })

    it('is byte for byte what the old reducer gave, when no card has left', () => {
      const cards = [detail(), card('c2', { stage: 'working', agentId: 'builder', brief: 'Busy.' })]
      const state: HubState = { ...emptyState(), cards }
      const changes = [
        { type: 'card.update' as const, id: 'c1', fields: { brief: 'Edited.' }, activity: line(at, 'edit') },
        { type: 'card.activity' as const, id: 'c2', activity: line(at, 'step') },
        { type: 'card.put' as const, card: card('c3', { brief: 'Three.' }) },
        { type: 'card.delete' as const, id: 'c2' },
      ]
      let next = state
      for (const change of changes) next = applyChange(next, change)
      assert.deepEqual(next.cards.map((c) => c.id), ['c1', 'c3'])
      assert.equal(next.cards[0].brief, 'Edited.')
      assert.equal(next.cards[0].activity.length, 4)
      assert.equal(JSON.stringify(next).includes('"left"'), false)
      // A change that touches no card hands the same cards back.
      assert.equal(applyChange(state, { type: 'card.update', id: 'nope', fields: { brief: 'X' } }).cards.length, 2)
      assert.equal(applyChange(state, { type: 'agent.put', agent }).cards, state.cards)
    })
  })

  describe('lightState', () => {
    it('sends an old card light, with what a list shows of it', () => {
      const old = detail({ noteId: 'n1', quote: 'q', prId: 'acme/web#1', cost: 2, tokens: 10, minutes: 3 })
      const light = only(lightState(wholeState(old), now))
      assert.deepEqual(light, leftCard(old))
      assert.deepEqual(light.left, { debrief: 'done', challenge: 'done' })
      assert.equal(light.brief, '')
      assert.equal(light.noteId, 'n1')
      assert.equal(light.activityMore, 3)
    })

    it('adds the lines the browser’s own cut leaves out to the count', () => {
      const many = detail({ activity: Array.from({ length: 40 }, (_, n) => line(days(20 - n / 10), `step ${n}`)) })
      const light = only(lightState(wholeState(many), now))
      assert.deepEqual(light.activity, [])
      assert.equal(light.activityMore, 40)
    })

    it('sends a card that finished yesterday whole', () => {
      const recent = detail({ updatedAt: days(1) })
      const light = only(lightState(wholeState(recent), now))
      assert.equal(light.left, undefined)
      assert.equal(light.brief, 'The whole brief.')
      assert.ok(light.debrief && light.challenge && light.plan)
    })

    it('sends a card with a finding still open whole, however long ago it finished', () => {
      const open = detail({ challenge: reviewed([finding('f1')]) })
      const light = only(lightState(wholeState(open), now))
      assert.equal(light.left, undefined)
      assert.equal(light.brief, 'The whole brief.')
      assert.equal(light.challenge?.findings?.length, 1)
    })

    it('leaves the hub’s own state as it was, the same objects', () => {
      const old = detail()
      const recent = card('c2', { brief: 'Recent.', updatedAt: days(1) })
      const state: HubState = { ...emptyState(), cards: [old, recent] }
      const before = JSON.stringify(state)
      const light = lightState(state, now)
      assert.equal(JSON.stringify(state), before)
      assert.equal(state.cards[0], old)
      assert.equal(old.left, undefined)
      assert.equal(old.brief, 'The whole brief.')
      assert.equal(light.cards[1], recent, 'a whole card is the same object')
      assert.equal(only(lightState(light, now)), only(light), 'a card already light is not worked out again')
    })
  })
})
