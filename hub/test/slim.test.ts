import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { emptyState, type HubState } from '../../shared/state.ts'
import { lightChange, lightState, newestActivity, recentActivityMs } from '../../shared/light.ts'
import type { Activity, Agent, Card, FileDiff, PullRequest } from '../../shared/work.ts'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { fakeGitHub, oneSpace, seed } from './helpers.ts'

// What a browser loads of a Binder, and what the hub keeps for good: a card's activity beyond the recent lines is asked
// for when the card opens, a card's worktree goes once its pull request has the diff, and a pull request's lines go two
// weeks after it's over, to be read from GitHub when someone opens it.

const now = Date.parse('2026-11-09T12:00:00.000Z')
const hours = (n: number) => new Date(now - n * 3_600_000).toISOString()
const days = (n: number) => hours(n * 24)

const line = (at: string, text: string, kind: Activity['kind'] = 'step'): Activity => ({ at, by: 'builder', kind, tool: 'Bash', text, result: 'ok' })
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'live', createdAt: days(30), createdBy: 'ana', updatedAt: days(30), waitsFor: [], activity: [], ...extra })
const agent: Agent = { id: 'builder', name: 'Builder', provider: 'claude', owner: 'ana', repos: [], binders: [], skills: [], createdAt: days(40) }
const diff = (path: string, lines = 6): FileDiff => ({ path, added: lines, removed: 0, lines: Array.from({ length: lines }, (_, n) => ({ kind: '+' as const, text: `line ${n} of ${path}`, n: n + 1 })) })
const pull = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Pull ${number}`, branch: `agent/${number}`, url: `https://github.test/acme/web/pull/${number}`, state: 'merged', cardId: `c${number}`, checks: [], files: [diff('src/a.ts'), diff('src/b.ts')], ...extra })

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

describe('GET /api/cards/:id/activity', () => {
  it('gives a card’s whole activity, while the state a browser loads has the recent lines, and the apps’ state all of it', async () => {
    const set = await setUp()
    const activity = Array.from({ length: 60 }, (_, n) => line(days(20 - n / 10), `step ${n}`))
    await set.hub.record({ kind: 'hub' }, { type: 'card.put', card: card('c1', { activity }) })
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
