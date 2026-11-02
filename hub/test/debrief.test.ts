import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { debriefMarkdown, debriefSpeech, debriefToComment, testPlanMarkdown, testTally, withTestResult, type Debrief, type TestCase } from '../../shared/changeSet.ts'
import { Hub } from '../src/hub.ts'
import { MemoryLog, RedisLog, type ChangeLog } from '../src/log.ts'
import { startRedis } from './helpers.ts'

let redis: Awaited<ReturnType<typeof startRedis>>
before(async () => { redis = await startRedis(6393) })
after(() => redis?.stop())

const written: Debrief = {
  state: 'done',
  askedBy: 'you',
  askedAt: '2026-10-30T10:00:00.000Z',
  agentId: 'a1',
  writtenAt: '2026-10-30T10:05:00.000Z',
  source: 'pull',
  does: 'Adds `GET /health`, answering **200**.\nNothing else.',
  changes: [{ area: 'Server', what: 'A /health route.' }, { area: 'Tests', what: 'One for the route.' }],
  against: [{ point: 'GET /health answers 200.', mark: 'met', where: 'src/a.ts' }, { point: 'A test covers it.', mark: 'partly met', where: 'Not of the body.' }],
  lookAt: ['Nothing checks Redis.'],
  tryIt: '```sh\nnpm start\n```',
  comment: { repo: 'acme/web', id: 501, url: 'https://github.test/acme/web/issues/3#issuecomment-501', writtenAt: '2026-10-30T10:05:00.000Z' },
}

const logs: [string, (space: string) => ChangeLog | undefined][] = [
  ['memory', () => new MemoryLog()],
  ['redis', (space) => (redis ? new RedisLog(redis.url, space) : undefined)],
]

for (const [kind, make] of logs) {
  it(`keeps a card’s debrief through a restart of the hub (${kind} log)`, async (t) => {
    const log = make(`debrief-${Date.now()}`)
    if (!log) return t.skip('redis-server isn’t installed')
    const hub = new Hub(log)
    await hub.start()
    await hub.record({ kind: 'hub' }, { type: 'card.put', card: { id: 'c1', binderId: 'b1', title: 'Add a health check', brief: '', doneWhen: '', size: 'M', stage: 'review', createdAt: '2026-10-30T00:00:00Z', createdBy: 'you', updatedAt: '2026-10-30T00:00:00Z', waitsFor: [], activity: [] } })
    await hub.record({ kind: 'hub' }, { type: 'card.update', id: 'c1', fields: { debrief: written } })
    const again = new Hub(log)
    await again.start()
    assert.deepEqual(again.state.cards.find((c) => c.id === 'c1')!.debrief, written)
    await log.close()
  })
}

describe('a debrief as words', () => {
  it('says it aloud in plain sentences: what it does, against the brief, what to look at, what changed, how to try it', () => {
    const speech = debriefSpeech(written, { title: 'Add a health check', agent: 'Writer' })
    assert.equal(speech, [
      'Debrief of Add a health check, by Writer.',
      'What it does: Adds GET /health, answering 200. Nothing else.',
      'Against the brief, 1 of 2 done-when points are met.',
      'Met: GET /health answers 200.',
      'Partly met: A test covers it. Not of the body.',
      'Things to look at: Nothing checks Redis.',
      'What changed: Server: A /health route. Tests: One for the route.',
      'How to try it: npm start.',
    ].join(' '))
  })

  it('says when one is being written, couldn’t be, or is being written again', () => {
    const about = { title: 'Add a health check', agent: 'Writer' }
    assert.equal(debriefSpeech({ state: 'writing', askedBy: 'you', askedAt: '', agentId: 'a1' }, about), 'Writer is still writing the debrief of Add a health check.')
    assert.equal(debriefSpeech({ state: 'failed', askedBy: 'you', askedAt: '', agentId: 'a1', failed: 'The pull request was closed.' }, about), 'Writer couldn’t write the debrief of Add a health check: The pull request was closed.')
    assert.match(debriefSpeech({ ...written, state: 'asked' }, about), /^Debrief of Add a health check, by Writer\. A new one is being written; this is the last one\. What it does/)
    assert.match(debriefSpeech({ ...written, lookAt: [] }, about), /Nothing stood out to look at\./)
  })

  it('writes the comment for the card’s issue, and knows when the comment is behind', () => {
    const markdown = debriefMarkdown(written, { agent: 'Writer', link: 'http://hub.test/#/work/c1' })
    assert.ok(markdown.startsWith('### Debrief: 1 of 2 done-when points met\n\n_By Writer on 2026-10-30, asked by you. [Open in Binders](http://hub.test/#/work/c1)_'))
    assert.ok(markdown.includes('- ✅ **met:** GET /health answers 200. (src/a.ts)'))
    assert.ok(markdown.includes('- **Tests:** One for the route.'))
    assert.equal(debriefToComment(written), false)
    assert.equal(debriefToComment({ ...written, writtenAt: '2026-10-30T11:00:00.000Z' }), true, 'written again')
    assert.equal(debriefToComment({ ...written, comment: undefined }), true, 'never kept')
    assert.equal(debriefToComment({ state: 'asked', askedBy: 'you', askedAt: '', agentId: 'a1' }), false, 'nothing written yet')
  })

  it('keeps a functional test plan: in the comment, aloud, as Markdown, with each result', () => {
    const plan: TestCase[] = [
      { id: 't1', title: 'Health answers 200', point: 'GET /health answers 200.', setup: 'The preview running.', steps: ['curl -i /health'], expect: 'HTTP 200.', risk: 'high' },
      { id: 't2', title: 'Ready fails without Redis', steps: ['Stop Redis.', 'curl -i /ready'], expect: 'HTTP 503.' },
    ]
    const run = withTestResult({ ...written, testPlan: plan }, 't1', { outcome: 'passed', by: 'you', at: '2026-10-30T12:00:00.000Z' })
    assert.deepEqual(testTally(run.testPlan), { total: 2, passed: 1, failed: 0 })
    assert.equal(withTestResult(run, 't9', { outcome: 'failed', by: 'you', at: '' }), run, 'no such test, nothing changes')
    assert.equal(withTestResult(run, 't1', null).testPlan![0].result, undefined, 'cleared')
    const comment = debriefMarkdown(run, { agent: 'Writer' })
    assert.ok(comment.includes('**Functional test plan** (2 tests)'))
    assert.ok(comment.includes('- [x] **Health answers 200** (high risk): proves “GET /health answers 200.”'))
    assert.ok(comment.includes('  1. Stop Redis.\n  2. curl -i /ready\n  Expect: HTTP 503.'))
    assert.match(debriefSpeech(run, { title: 'the card', agent: 'Writer' }), /Its test plan has 2 functional tests: 1 passed, 0 failed\. Health answers 200\. Ready fails without Redis\./)
    const markdown = testPlanMarkdown(run.testPlan!, 'change set #4')
    assert.ok(markdown.startsWith('## Functional test plan: change set #4\n\n### t1. Health answers 200 (high risk)\nProves: GET /health answers 200.\nSetup: The preview running.\n\n1. curl -i /health\n\nExpect: HTTP 200.\nResult: passed (you, 2026-10-30)'))
  })
})
