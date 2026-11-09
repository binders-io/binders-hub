import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { handMove, resumeFor, type Agent, type Card, type PullRequest } from '../../shared/work.ts'
import { Actions } from '../src/actions.ts'
import { Auth } from '../src/auth.ts'
import { GitHubConnection } from '../src/githubConnection.ts'
import { Hub } from '../src/hub.ts'
import { MemoryKV } from '../src/kv.ts'
import { MemoryLog } from '../src/log.ts'
import { mcpServer } from '../src/mcp.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Sealer } from '../src/secrets.ts'
import { buildServer } from '../src/server.ts'
import { Webhooks } from '../src/webhooks.ts'
import { oneSpace, seed } from './helpers.ts'

const agent = (id: string, name = id): Agent => ({ id, name, provider: 'claude', owner: 'ana', repos: [], binders: [], skills: [], createdAt: '2026-10-01T00:00:00.000Z' })
const at = '2026-11-09T10:00:00.000Z'
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: at, createdBy: 'ana', updatedAt: at, waitsFor: [], activity: [], ...extra })
const pull = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Pull ${number}`, branch: `agent/${number}`, url: `https://github.test/acme/web/pull/${number}`, state: 'open', cardId: `c${number}`, checks: [], files: [], ...extra })

const closers: (() => Promise<void>)[] = []
after(async () => {
  for (const close of closers) await close()
})

/** A hub, its actions, and each agent's own MCP tools. */
async function setUp() {
  const hub = new Hub(new MemoryLog())
  await hub.start(seed())
  const actions = new Actions(hub, { forRepo: async () => undefined } as never)
  for (const id of ['builder', 'other']) await hub.record({ kind: 'hub' }, { type: 'agent.put', agent: agent(id, id === 'builder' ? 'Builder' : 'Other') })
  const tools = async (agentId: string) => {
    const server = mcpServer(hub, actions, agentId, { issueToken: async () => 'unused', publicUrl: 'http://hub.test' })
    const [ours, theirs] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: agentId, version: '1' })
    await Promise.all([server.connect(theirs), client.connect(ours)])
    closers.push(() => client.close())
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      return { error: !!result.isError, text: result.content[0]?.text ?? '' }
    }
  }
  const find = (id: string) => hub.state.cards.find((c) => c.id === id)!
  return { hub, actions, tools, find }
}

describe('a card that keeps failing', () => {
  it('goes back to Ready after one failed run, and waits in Blocked for a person after the second', async () => {
    const { hub, tools, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { meantFor: 'builder' }) })
    const builder = await tools('builder')

    await builder('claim_task', { id: 'c1' })
    await builder('release_task', { id: 'c1', reason: 'The tool exited with code 1', failed: true })
    assert.equal(find('c1').stage, 'ready')
    assert.equal(find('c1').agentId, undefined)
    assert.equal(find('c1').stopped?.times, 1)
    assert.equal(find('c1').stopped?.why, 'The tool exited with code 1')
    assert.equal(find('c1').needsYou, undefined)

    await builder('claim_task', { id: 'c1' })
    await builder('release_task', { id: 'c1', reason: 'Ran past its 60 minute limit.', failed: true })
    const stopped = find('c1')
    assert.equal(stopped.stage, 'blocked')
    assert.equal(stopped.agentId, undefined)
    assert.equal(stopped.stopped?.times, 2)
    assert.equal(stopped.needsYou, 'It stopped twice without finishing: Ran past its 60 minute limit. Fix what’s wrong, then answer here and it goes back to Ready.')
    assert.equal(stopped.activity.at(-1)?.kind, 'released')
  })

  it('isn’t counted when it’s handed back for a reason that isn’t the card’s', async () => {
    const { hub, tools, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { meantFor: 'builder' }) })
    const builder = await tools('builder')
    await builder('claim_task', { id: 'c1' })
    await builder('release_task', { id: 'c1', reason: 'The tool signed out', failed: true })
    // Restarted or updated: the card stays as it was, and so does its count.
    await builder('claim_task', { id: 'c1' })
    await builder('release_task', { id: 'c1', reason: 'Its runner restarted' })
    assert.equal(find('c1').stage, 'ready')
    assert.deepEqual(find('c1').stopped && { why: find('c1').stopped!.why, times: find('c1').stopped!.times }, { why: 'The tool signed out', times: 1 })
    await builder('claim_task', { id: 'c1' })
    await builder('release_task', { id: 'c1', reason: 'Its runner updated', failed: false })
    assert.equal(find('c1').stage, 'ready', 'two hand-backs that weren’t failures don’t stop it')
    assert.equal(find('c1').stopped?.times, 1)
  })

  it('goes back to Ready when a person answers or comments, and its count starts again', async () => {
    const { hub, actions, tools, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { meantFor: 'builder' }) })
    const builder = await tools('builder')
    for (let i = 0; i < 2; i++) {
      await builder('claim_task', { id: 'c1' })
      await builder('release_task', { id: 'c1', reason: 'It couldn’t start', failed: true })
    }
    assert.equal(find('c1').stage, 'blocked')
    await actions.comment('ana', 'c1', 'Signed the tool in again.')
    const back = find('c1')
    assert.equal(back.stage, 'ready')
    assert.equal(back.agentId, undefined)
    assert.equal(back.needsYou, undefined)
    assert.equal(back.stopped, undefined)
    assert.equal(back.activity.at(-1)?.kind, 'answer')
    assert.equal(back.activity.at(-1)?.text, 'Signed the tool in again.')

    // One failure after that is the first again, not the third.
    await builder('claim_task', { id: 'c1' })
    await builder('release_task', { id: 'c1', reason: 'It couldn’t start', failed: true })
    assert.equal(find('c1').stage, 'ready')
    assert.equal(find('c1').stopped?.times, 1)
  })

  it('stays Blocked for the agent when a person answers a card it holds, as before', async () => {
    const { hub, actions, tools, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { meantFor: 'builder' }) })
    const builder = await tools('builder')
    await builder('claim_task', { id: 'c1' })
    await builder('ask', { id: 'c1', question: 'Which database?' })
    assert.equal(find('c1').stage, 'blocked')
    await actions.comment('ana', 'c1', 'Postgres.')
    assert.equal(find('c1').stage, 'working')
    assert.equal(find('c1').agentId, 'builder')
  })

  it('has its count cleared when a person moves it by hand, stops it, or it’s finished', async () => {
    const { hub, actions, tools, find } = await setUp()
    const stopped = { why: 'It couldn’t start', at, times: 1 }
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('moved', { stopped }) })
    const fields = handMove(find('moved'), 'proposed')!
    assert.ok('stopped' in fields && fields.stopped === undefined)
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.update', id: 'moved', fields: handMove(find('moved'), 'proposed')! })
    assert.equal(find('moved').stopped, undefined)

    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('halted', { stopped }) })
    await actions.stopCard('ana', 'halted')
    assert.equal(find('halted').stage, 'proposed')
    assert.equal(find('halted').stopped, undefined)

    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('finished', { meantFor: 'builder', stopped }) })
    const builder = await tools('builder')
    await builder('claim_task', { id: 'finished' })
    await builder('complete_task', { id: 'finished', summary: 'Done without a pull request.' })
    assert.equal(find('finished').stage, 'live')
    assert.equal(find('finished').stopped, undefined)
  })
})

describe('a card whose agent has gone quiet', () => {
  /** A scheduler whose clock is ahead of the real one by `ahead`, as if that long had passed. */
  const scheduler = (hub: Hub, actions: Actions, ahead: { ms: number }, quietMs?: number) => new Scheduler(hub, actions, { now: () => new Date(Date.now() + ahead.ms), ...(quietMs ? { quietMs } : {}) })
  const minutes = (n: number) => n * 60_000

  it('goes back on the board after 20 minutes, not as a failure, and says why', async () => {
    const { hub, actions, tools, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { meantFor: 'builder' }) })
    const builder = await tools('builder')
    await builder('claim_task', { id: 'c1' })
    assert.equal(find('c1').stage, 'working')
    const ahead = { ms: minutes(19) }
    const timer = scheduler(hub, actions, ahead)

    await timer.tick()
    assert.equal(find('c1').stage, 'working', 'heard from 19 minutes ago')

    ahead.ms = minutes(21)
    await timer.tick()
    const back = find('c1')
    assert.equal(back.stage, 'ready')
    assert.equal(back.agentId, undefined)
    assert.equal(back.stopped, undefined, 'not a failure')
    assert.equal(back.activity.at(-1)?.kind, 'released')
    assert.equal(back.activity.at(-1)?.text, 'Builder hasn’t been heard from for 20 minutes, so this went back on the board.')
  })

  it('isn’t counted from before the hub started, so a restart doesn’t put back every card', async () => {
    const { hub, actions, find } = await setUp()
    // Held by an agent the hub has never heard from since it started, as after a restart: the hub's own start is the clock.
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder', updatedAt: '2026-01-01T00:00:00.000Z' }) })
    const ahead = { ms: minutes(19) }
    const timer = scheduler(hub, actions, ahead)
    await timer.tick()
    assert.equal(find('c1').stage, 'working')
    ahead.ms = minutes(21)
    await timer.tick()
    assert.equal(find('c1').stage, 'ready')
  })

  it('stays with an agent that has a wait open, or that called lately', async () => {
    const { hub, actions, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder' }) })
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c2', { stage: 'working', agentId: 'other' }) })
    const ahead = { ms: minutes(60) }
    const timer = scheduler(hub, actions, ahead)
    // Listening for more work: it's there, even if it said nothing else.
    hub.touch('builder', 1)
    await timer.tick()
    assert.equal(find('c1').stage, 'working')
    assert.equal(find('c2').stage, 'ready')
    hub.touch('builder', -1)
  })

  it('leaves a blocked card alone: it waits on a person, not an agent', async () => {
    const { hub, actions, tools, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { meantFor: 'builder' }) })
    const builder = await tools('builder')
    await builder('claim_task', { id: 'c1' })
    await builder('ask', { id: 'c1', question: 'Which database?' })
    assert.equal(find('c1').stage, 'blocked')
    await scheduler(hub, actions, { ms: minutes(120) }).tick()
    assert.equal(find('c1').stage, 'blocked')
    assert.equal(find('c1').agentId, 'builder')
    assert.equal(find('c1').needsYou, 'Which database?')
  })

  it('takes the time it waits from its options', async () => {
    const { hub, actions, find } = await setUp()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder' }) })
    const timer = scheduler(hub, actions, { ms: minutes(6) }, minutes(5))
    await timer.tick()
    assert.equal(find('c1').stage, 'ready')
    assert.match(find('c1').activity.at(-1)!.text, /for 5 minutes/)
  })
})

describe('a pull request closed on GitHub without merging', () => {
  const closed = (number: number, merged = false) => ({ action: 'closed', pull_request: { number, title: `Pull ${number}`, body: null, state: 'closed', merged, html_url: `https://github.test/acme/web/pull/${number}`, head: { ref: `agent/${number}` } }, repository: { full_name: 'acme/web' } })

  /** Two cards in review, each with an open pull request, both in one change set. */
  async function inReview() {
    const world = await setUp()
    const { hub } = world
    const you = { kind: 'user', login: 'ana' } as const
    await hub.recordAll(you, [
      { type: 'card.put', card: card('c1', { stage: 'review', agentId: 'builder', prId: 'acme/web#1' }) },
      { type: 'card.put', card: card('c2', { stage: 'review', agentId: 'builder', prId: 'acme/web#2' }) },
      { type: 'pr.put', pull: pull(1, { agentId: 'builder' }) },
      { type: 'pr.put', pull: pull(2, { agentId: 'builder' }) },
      { type: 'set.put', set: { id: 'set-1', binderId: 'b1', number: 1, title: 'Two', summary: '', state: 'review', prIds: ['acme/web#1', 'acme/web#2'], noteIds: [] } },
    ])
    return { ...world, webhooks: new Webhooks(hub, world.actions) }
  }

  it('comes out of its change set, and its card waits in Proposed with a line saying why', async () => {
    const { hub, find, webhooks } = await inReview()
    assert.equal(await webhooks.handle('pull_request', closed(1)), 'closed')
    assert.equal(hub.state.pulls.find((p) => p.id === 'acme/web#1')?.state, 'closed')
    assert.deepEqual(hub.state.changeSets[0].prIds, ['acme/web#2'])
    const moved = find('c1')
    assert.equal(moved.stage, 'proposed')
    assert.equal(moved.agentId, undefined)
    assert.equal(moved.activity.at(-1)?.by, 'hub')
    assert.equal(moved.activity.at(-1)?.text, 'web#1 was closed on GitHub without merging.')
    assert.equal(find('c2').stage, 'review', 'the other card is as it was')
  })

  it('takes the last pull request’s change set with it, and does nothing twice', async () => {
    const { hub, find, webhooks } = await inReview()
    await webhooks.handle('pull_request', closed(1))
    await webhooks.handle('pull_request', closed(2))
    assert.equal(hub.state.changeSets.length, 0)
    assert.equal(find('c2').stage, 'proposed')
    const lines = find('c2').activity.length
    await webhooks.handle('pull_request', closed(2))
    assert.equal(find('c2').activity.length, lines, 'a delivery GitHub sends again writes nothing more')
  })

  it('leaves a merged one as it was: its card is live', async () => {
    const { hub, find, webhooks } = await inReview()
    await webhooks.handle('pull_request', closed(1, true))
    assert.equal(find('c1').stage, 'live')
    assert.deepEqual(hub.state.changeSets[0].prIds, ['acme/web#1', 'acme/web#2'])
  })

  it('no longer counts in the failed-checks test when the set is approved', async () => {
    const { hub, actions, webhooks } = await inReview()
    const failed = [{ name: 'test', state: 'failed' as const }]
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: 'acme/web#2', fields: { checks: failed as never } })
    await assert.rejects(actions.approveSet('ana', 'set-1'), /Some checks failed: web#2 test/)
    // Closed with its failed check still on it, and nothing else holding the set up.
    await hub.record({ kind: 'hub' }, { type: 'pr.update', id: 'acme/web#2', fields: { state: 'closed' } })
    await webhooks.handle('pull_request', closed(1, true))
    await assert.doesNotReject(actions.approveSet('ana', 'set-1'))
  })
})

describe('stopping and sending back, from the web', () => {
  async function server() {
    const world = await setUp()
    const kv = new MemoryKV()
    const sealer = new Sealer('test-secret')
    const github = new GitHubConnection(kv, sealer, { webUrl: 'http://unused', apiUrl: 'http://unused' }, {})
    const auth = new Auth(kv, sealer, { github: () => github.signIn(), allowed: () => ({ users: [], orgs: [] }), devLogin: () => true })
    const app = await buildServer(oneSpace(kv, { hub: world.hub, actions: world.actions, webhooks: new Webhooks(world.hub, world.actions), github }), { auth }, { publicUrl: 'http://hub.test' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    closers.push(() => app.close())
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const signedIn = await fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-binders': '1' }, body: JSON.stringify({ login: 'ana' }) })
    const cookie = /binders_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0]
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-binders': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    }
    return { ...world, call }
  }

  it('stops a card an agent is working on: it waits in Proposed, and the card comes back', async () => {
    const { hub, call, find } = await server()
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'card.put', card: card('c1', { stage: 'working', agentId: 'builder', stopped: { why: 'x', at, times: 1 } }) })
    const stopped = await call('POST', '/api/cards/c1/stop')
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    assert.equal(stopped.body.id, 'c1')
    assert.equal(stopped.body.stage, 'proposed')
    assert.equal(stopped.body.agentId, undefined)
    assert.equal(find('c1').activity.at(-1)?.text, 'Stopped Builder: Proposed')
    const again = await call('POST', '/api/cards/c1/stop')
    assert.equal(again.status, 422)
    assert.match(again.body.error, /isn’t being worked on/)
  })

  it('sends a card in review back to its agent with what the person said, and the agent’s runner picks it up', async () => {
    const { hub, call, find } = await server()
    await hub.recordAll({ kind: 'user', login: 'ana' }, [
      { type: 'card.put', card: card('c1', { stage: 'review', agentId: 'builder', prId: 'acme/web#1' }) },
      { type: 'pr.put', pull: pull(1, { agentId: 'builder' }) },
    ])
    const sent = await call('POST', '/api/cards/c1/send-back', { text: 'The empty case still throws.' })
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(sent.body.stage, 'working')
    assert.equal(sent.body.agentId, 'builder')
    const [words, line] = find('c1').activity.slice(-2)
    assert.deepEqual([words.by, words.kind, words.text], ['ana', 'comment', 'The empty case still throws.'])
    assert.deepEqual([line.by, line.kind, line.text], ['ana', 'comment', '@ana sent it back to Builder.'])
    assert.equal(resumeFor(hub.state, hub.state.agents.find((a) => a.id === 'builder')!)?.id, 'c1', 'the agent’s runner resumes it')
  })

  it('sends it back with no words too, and says who did', async () => {
    const { hub, call, find } = await server()
    await hub.recordAll({ kind: 'user', login: 'ana' }, [
      { type: 'card.put', card: card('c1', { stage: 'review', agentId: 'builder', prId: 'acme/web#1' }) },
      { type: 'pr.put', pull: pull(1, { agentId: 'builder' }) },
    ])
    const sent = await call('POST', '/api/cards/c1/send-back')
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(find('c1').stage, 'working')
    assert.equal(find('c1').activity.at(-1)?.text, '@ana sent it back to Builder to take another look.')
    assert.equal(find('c1').activity.filter((a) => a.kind === 'comment').length, 1)
  })

  it('refuses, in words, a card that isn’t in review, has no agent, or whose pull request isn’t open', async () => {
    const { hub, call, find } = await server()
    await hub.recordAll({ kind: 'user', login: 'ana' }, [
      { type: 'card.put', card: card('ready', { stage: 'ready' }) },
      { type: 'card.put', card: card('nobody', { stage: 'review', prId: 'acme/web#3' }) },
      { type: 'pr.put', pull: pull(3, { cardId: 'nobody' }) },
      { type: 'card.put', card: card('closed', { stage: 'review', agentId: 'builder', prId: 'acme/web#4' }) },
      { type: 'pr.put', pull: pull(4, { cardId: 'closed', state: 'closed' }) },
      { type: 'card.put', card: card('bare', { stage: 'review', agentId: 'builder' }) },
    ])
    const refused = async (id: string) => call('POST', `/api/cards/${id}/send-back`, { text: 'Again.' })
    const notReview = await refused('ready')
    assert.equal(notReview.status, 422)
    assert.match(notReview.body.error, /isn’t in review/)
    const noAgent = await refused('nobody')
    assert.equal(noAgent.status, 422)
    assert.match(noAgent.body.error, /No agent holds this card/)
    const notOpen = await refused('closed')
    assert.equal(notOpen.status, 422)
    assert.match(notOpen.body.error, /web#4 isn’t open/)
    const noPull = await refused('bare')
    assert.equal(noPull.status, 422)
    assert.match(noPull.body.error, /no pull request/)
    for (const id of ['ready', 'nobody', 'closed', 'bare']) assert.equal(find(id).activity.length, 0, `${id} wasn’t written on`)
    assert.equal(find('closed').stage, 'review')
  })
})
