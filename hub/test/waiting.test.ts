import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, type HubState } from '../../shared/state.ts'
import type { Challenge, Finding } from '../../shared/changeSet.ts'
import { forAttention, screenOf, waitingOn } from '../../shared/waiting.ts'
import type { Agent, Card, ChangeSet, Environment, PullRequest } from '../../shared/work.ts'

const at = '2026-11-09T10:00:00.000Z'
const agent = (id: string, owner: string): Agent => ({ id, name: `Agent ${id}`, provider: 'claude', owner, repos: [], binders: [], skills: [], createdAt: at })
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: `Card ${id}`, brief: '', doneWhen: '', size: 'M', stage: 'ready', createdAt: at, createdBy: 'ana', updatedAt: at, waitsFor: [], activity: [], ...extra })
const pull = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Pull ${number}`, branch: `b${number}`, url: '', state: 'open', cardId: `c${number}`, checks: [], files: [], ...extra })
const set = (id: string, extra: Partial<ChangeSet> = {}): ChangeSet => ({ id, binderId: 'b1', number: 1, title: 'A set', summary: '', state: 'review', prIds: ['acme/web#1'], noteIds: [], ...extra })
const env = (id: string, extra: Partial<Environment> = {}): Environment => ({ id, name: 'Production', url: '', version: '1.0', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, ...extra })
const workflow = { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }
const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, kind: 'bug', file: 'a.ts', line: 1, what: 'Breaks', confidence: 'confirmed', severity: 'high', ...extra })
const challenge = (findings: Finding[], extra: Partial<Challenge> = {}): Challenge => ({ state: 'done', askedBy: 'ana', askedAt: at, agentId: 'rev', picked: 'hub', authors: [], findings, ...extra })

const state = (over: Partial<HubState> = {}): HubState => ({
  ...emptyState(),
  binders: [{ id: 'b1', name: 'One' }, { id: 'b2', name: 'Two' }],
  agents: [agent('mine', 'ana'), agent('theirs', 'ben')],
  ...over,
})

const kinds = (rows: { kind: string; for: string }[]) => rows.map((r) => `${r.kind}:${r.for}`)

describe('what waits on a person: a question', () => {
  it('is for you when you own the agent that asks, or you made the card', () => {
    const s = state({ cards: [
      card('q1', { stage: 'blocked', agentId: 'mine', needsYou: 'Which one?', createdBy: 'ben' }),
      card('q2', { stage: 'blocked', agentId: 'theirs', needsYou: 'Which?', createdBy: 'ana' }),
    ] })
    assert.deepEqual(kinds(waitingOn(s, 'ana')), ['question:you', 'question:you'])
  })

  it('is for others when its agent’s owner or the card’s maker is someone else, and for anyone when neither is named', () => {
    const s = state({ cards: [
      card('q1', { stage: 'blocked', agentId: 'theirs', needsYou: 'Which?', createdBy: 'ben' }),
      card('q2', { stage: 'blocked', agentId: 'ghost', needsYou: 'Which?', createdBy: 'hub' }),
    ] })
    const rows = waitingOn(s, 'ana')
    assert.deepEqual(rows.map((r) => [r.about.id, r.for]), [['q2', 'anyone'], ['q1', 'others']])
  })

  it('says who asks and what, and when it was asked', () => {
    const s = state({ cards: [card('q1', { stage: 'blocked', agentId: 'mine', needsYou: 'Which?', activity: [{ at: '2026-11-09T09:00:00.000Z', by: 'mine', kind: 'question', text: 'Which?' }] })] })
    const [row] = waitingOn(s, 'ana')
    assert.equal(row.detail, 'Agent mine asks: Which?')
    assert.equal(row.since, '2026-11-09T09:00:00.000Z')
    assert.equal(row.binderId, 'b1')
    assert.deepEqual(row.about, { type: 'card', id: 'q1' })
  })

  it('doesn’t count a card that’s live', () => {
    assert.deepEqual(waitingOn(state({ cards: [card('q1', { stage: 'live', needsYou: 'Old' })] }), 'ana'), [])
  })
})

describe('what waits on a person: a card that stopped twice', () => {
  const stopped = card('s1', { stage: 'blocked', needsYou: 'It stopped twice…', stopped: { why: 'Signed out of Claude Code', at: '2026-11-09T08:00:00.000Z', times: 2 } })

  it('says why it stopped, and is for you when you made it, else anyone', () => {
    const [mine] = waitingOn(state({ cards: [stopped] }), 'ana')
    assert.equal(mine.kind, 'stopped')
    assert.equal(mine.for, 'you')
    assert.equal(mine.detail, 'Signed out of Claude Code')
    assert.equal(mine.since, '2026-11-09T08:00:00.000Z')
    assert.equal(waitingOn(state({ cards: [stopped] }), 'ben')[0].for, 'anyone')
  })

  it('isn’t also a question', () => {
    assert.deepEqual(kinds(waitingOn(state({ cards: [stopped] }), 'ana')), ['stopped:you'])
  })

  it('is a question again once an agent holds it', () => {
    assert.deepEqual(kinds(waitingOn(state({ cards: [{ ...stopped, agentId: 'mine' }] }), 'ana')), ['question:you'])
  })
})

describe('what waits on a person: a permission', () => {
  const asking = (agentId: string) => card('p1', { stage: 'working', agentId, permission: { request: 'r1', agent: agentId, tool: 'Bash', what: 'npm test', at } })

  it('is for you when you own the agent, and for others when someone else does', () => {
    assert.deepEqual(kinds(waitingOn(state({ cards: [asking('mine')] }), 'ana')), ['permission:you'])
    assert.deepEqual(kinds(waitingOn(state({ cards: [asking('theirs')] }), 'ana')), ['permission:others'])
  })

  it('is gone once answered', () => {
    const answered = asking('mine')
    answered.permission!.answer = 'allow'
    assert.deepEqual(waitingOn(state({ cards: [answered] }), 'ana'), [])
  })
})

describe('what waits on a person: a change set', () => {
  it('counts one in review', () => {
    const rows = waitingOn(state({ changeSets: [set('s1')] }), 'ana')
    assert.deepEqual(kinds(rows), ['changeSet:anyone'])
    assert.equal(rows[0].title, 'Change set #1: A set')
    assert.equal(rows[0].detail, '1 pull request to approve')
  })

  it('counts one still assembling when its pull requests are in and none of its cards is left to do', () => {
    const s = state({ changeSets: [set('s1', { state: 'assembling' })], pulls: [pull(1)], cards: [card('c1', { stage: 'review', prId: 'acme/web#1' })] })
    assert.deepEqual(kinds(waitingOn(s, 'ana')), ['changeSet:anyone'])
  })

  it('waits while one of its cards is proposed, ready, working or blocked', () => {
    for (const stage of ['proposed', 'ready', 'working', 'blocked'] as const) {
      const s = state({ changeSets: [set('s1', { state: 'assembling', prIds: ['acme/web#1', 'acme/web#2'] })], pulls: [pull(1), pull(2)], cards: [card('c1', { stage: 'review' }), card('c2', { stage })] })
      assert.deepEqual(waitingOn(s, 'ana'), [], stage)
    }
  })

  it('doesn’t count one assembling with no pull requests, or whose pull requests have all gone', () => {
    assert.deepEqual(waitingOn(state({ changeSets: [set('s1', { state: 'assembling', prIds: [] })] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ changeSets: [set('s1', { state: 'assembling' })], pulls: [pull(1, { state: 'merged' })] }), 'ana'), [])
  })

  it('waits for a note’s own set while that note has cards proposed', () => {
    const s = state({
      changeSets: [set('s1', { state: 'assembling', forNote: 'n1' })], pulls: [pull(1)], cards: [card('c1', { stage: 'review', noteId: 'n1', prId: 'acme/web#1' })],
      proposals: [{ id: 'p1', binderId: 'b1', noteId: 'n1', title: 'More', quote: '', brief: '', doneWhen: '', size: 'S', by: 'mine', state: 'new' }],
    })
    assert.deepEqual(waitingOn(s, 'ana').map((r) => r.kind), ['proposals'])
  })

  it('doesn’t count one that’s merging or merged', () => {
    assert.deepEqual(waitingOn(state({ changeSets: [set('s1', { state: 'merging' }), set('s2', { state: 'merged' })] }), 'ana'), [])
  })
})

describe('what waits on a person: cards proposed from a note', () => {
  const proposal = (id: string, noteId: string, extra = {}) => ({ id, binderId: 'b1', noteId, title: `Card ${id}`, quote: '', brief: '', doneWhen: '', size: 'S' as const, by: 'mine', state: 'new' as const, ...extra })
  const notes = [
    { id: 'n1', title: 'Plan', binderId: 'b1', editedAt: at, editors: ['ana'], text: '' },
    { id: 'n2', title: 'Ideas', binderId: 'b1', editedAt: at, editors: ['ben'], text: '' },
  ]

  it('is one row for each note with how many, for you when you edit it, else anyone', () => {
    const s = state({ notes, proposals: [proposal('a', 'n1'), proposal('b', 'n1'), proposal('c', 'n2'), proposal('d', 'n2', { state: 'dismissed' })] })
    const rows = waitingOn(s, 'ana')
    assert.deepEqual(rows.map((r) => [r.about.id, r.for, r.count]), [['n1', 'you', 2], ['n2', 'anyone', 1]])
    assert.equal(rows[0].detail, '2 proposed: Card a · Card b')
  })
})

describe('what waits on a person: a change to a locked note', () => {
  const note = { id: 'n1', title: 'Plan', binderId: 'b1', editedAt: at, editors: [], text: '', locked: { by: 'ben', at } }
  const open = (extra = {}) => ({ id: 'np1', noteId: 'n1', binderId: 'b1', by: 'mine', at, why: 'Fix a date', base: '', text: '', state: 'open' as const, comments: [], ...extra })

  it('is for you when you locked the note, else for others', () => {
    const s = state({ notes: [note], noteProposals: [open()] })
    assert.equal(waitingOn(s, 'ben')[0].for, 'you')
    assert.equal(waitingOn(s, 'ana')[0].for, 'others')
    assert.equal(waitingOn(s, 'ben')[0].detail, 'Agent mine proposes a change: Fix a date')
  })

  it('is gone once decided', () => {
    assert.deepEqual(waitingOn(state({ notes: [note], noteProposals: [open({ state: 'accepted' })] }), 'ben'), [])
  })
})

describe('what waits on a person: a Challenge’s findings', () => {
  const reviewed = (findings: Finding[], extra: Partial<Card> = {}) => card('r1', { stage: 'review', agentId: 'mine', challenge: challenge(findings, { reviewedAt: '2026-11-09T07:00:00.000Z' }), ...extra })

  it('counts findings nobody has acted on, on a card in review', () => {
    const s = state({ cards: [reviewed([finding('f1'), finding('f2', { outcome: { kind: 'dismissed', by: 'ana', at } })])] })
    const [row] = waitingOn(s, 'ana')
    assert.equal(row.kind, 'findings')
    assert.equal(row.for, 'you')
    assert.equal(row.count, 1)
    assert.equal(row.since, '2026-11-09T07:00:00.000Z')
  })

  it('is for anyone when the card’s agent and maker are someone else’s', () => {
    assert.equal(waitingOn(state({ cards: [reviewed([finding('f1')], { agentId: 'theirs', createdBy: 'ben' })] }), 'ana')[0].for, 'anyone')
  })

  it('isn’t there when all are dealt with, the Challenge isn’t done, or the card isn’t in review', () => {
    assert.deepEqual(waitingOn(state({ cards: [reviewed([finding('f1', { outcome: { kind: 'sent back', by: 'ana', at } })])] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ cards: [card('r1', { stage: 'review', challenge: challenge([finding('f1')], { state: 'reviewing' }) })] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ cards: [reviewed([finding('f1')], { stage: 'working' })] }), 'ana'), [])
  })
})

describe('what waits on a person: a promotion', () => {
  const staging = (extra: Partial<Environment> = {}) => env('acme/web#staging', { name: 'Staging', version: '1.1', repo: 'acme/web', order: 0, ...extra })
  const production = (extra: Partial<Environment> = {}) => env('acme/web#production', { repo: 'acme/web', order: 1, needsApproval: true, deploy: workflow, ...extra })

  it('is for anyone when Promote would put something on an environment that needs approval, and names it', () => {
    const rows = waitingOn(state({ environments: [staging(), production()] }), 'ana')
    assert.deepEqual(kinds(rows), ['promotion:anyone'])
    assert.equal(rows[0].title, 'Promote 1.1 to Production')
    assert.deepEqual(rows[0].about, { type: 'environment', id: 'acme/web#production' })
    assert.equal(rows[0].id, 'promotion:acme/web#production')
  })

  it('isn’t there when approval isn’t needed, or there’s nothing to promote', () => {
    assert.deepEqual(waitingOn(state({ environments: [staging(), production({ needsApproval: false })] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ environments: [staging({ version: '1.0' }), production()] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ environments: [staging(), production({ deploy: undefined })] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ environments: [staging(), production({ state: 'deploying' })] }), 'ana'), [])
    assert.deepEqual(waitingOn(state({ environments: [staging({ version: '' }), production()] }), 'ana'), [])
  })

  it('doesn’t make a promotion of the pair the hub used to set, waiting and needing approval, with nothing before it', () => {
    const rows = waitingOn(state({ environments: [env('acme/web#production', { repo: 'acme/web', state: 'waiting', needsApproval: true })] }), 'ana')
    assert.deepEqual(rows.map((r) => r.id), ['approval:acme/web#production'], 'only GitHub’s own wait is left')
  })

  it('has a row of its own when GitHub is holding a deployment for an approval, saying it’s approved there', () => {
    const rows = waitingOn(state({ environments: [staging({ state: 'waiting' })] }), 'ana')
    assert.deepEqual(kinds(rows), ['promotion:anyone'])
    assert.equal(rows[0].id, 'approval:acme/web#staging')
    assert.equal(rows[0].title, 'Staging waits for an approval')
    assert.equal(rows[0].detail, 'It’s approved on GitHub, in acme/web.')
    assert.deepEqual(rows[0].about, { type: 'environment', id: 'acme/web#staging' })
  })

  it('has both rows for one environment that can be promoted and is also held on GitHub', () => {
    const rows = waitingOn(state({ environments: [staging(), production({ state: 'waiting' })] }), 'ana')
    assert.deepEqual(rows.map((r) => r.id).sort(), ['approval:acme/web#production', 'promotion:acme/web#production'])
  })

  it('keeps either row with the binder that follows its repo', () => {
    const base = state({ binders: [{ id: 'b1', name: 'One', repo: 'acme/web' }, { id: 'b2', name: 'Two', repo: 'acme/api' }], environments: [staging({ state: 'waiting' }), production()] })
    assert.equal(waitingOn(base, 'ana', { binder: 'b1' }).length, 2)
    assert.equal(waitingOn(base, 'ana', { binder: 'b2' }).length, 0)
  })
})

describe('the order, and one binder', () => {
  const s = () => state({
    agents: [agent('mine', 'ana'), agent('theirs', 'ben')],
    cards: [
      card('old-anyone', { stage: 'blocked', agentId: 'ghost', needsYou: 'Q', createdBy: 'hub', updatedAt: '2026-11-01T00:00:00.000Z', activity: [] }),
      card('new-you', { stage: 'blocked', agentId: 'mine', needsYou: 'Q', updatedAt: '2026-11-08T00:00:00.000Z' }),
      card('old-you', { stage: 'blocked', agentId: 'mine', needsYou: 'Q', updatedAt: '2026-11-02T00:00:00.000Z' }),
      card('other', { stage: 'blocked', agentId: 'theirs', needsYou: 'Q', createdBy: 'ben', binderId: 'b2', updatedAt: '2026-10-01T00:00:00.000Z' }),
    ],
  })

  it('puts yours first, then anyone’s, then others’, the oldest first in each', () => {
    assert.deepEqual(waitingOn(s(), 'ana').map((r) => [r.about.id, r.for]), [['old-you', 'you'], ['new-you', 'you'], ['old-anyone', 'anyone'], ['other', 'others']])
  })

  it('puts a row with no date last in its group', () => {
    const rows = waitingOn(state({ cards: [card('x', { stage: 'blocked', agentId: 'mine', needsYou: 'Q', updatedAt: '' }), card('y', { stage: 'blocked', agentId: 'mine', needsYou: 'Q' })] }), 'ana')
    assert.deepEqual(rows.map((r) => r.about.id), ['y', 'x'])
  })

  it('narrows to one binder, or all of them', () => {
    assert.deepEqual(waitingOn(s(), 'ana', { binder: 'b2' }).map((r) => r.about.id), ['other'])
    assert.equal(waitingOn(s(), 'ana', { binder: 'all' }).length, 4)
    assert.equal(waitingOn(s(), 'ana', { binder: 'b1' }).length, 3)
  })

  it('keeps an environment with the binder that follows its repo', () => {
    const base = state({ binders: [{ id: 'b1', name: 'One', repo: 'acme/web' }, { id: 'b2', name: 'Two', repo: 'acme/api' }], environments: [env('acme/web#production', { repo: 'acme/web', state: 'waiting' })] })
    assert.equal(waitingOn(base, 'ana', { binder: 'b1' }).length, 1)
    assert.equal(waitingOn(base, 'ana', { binder: 'b2' }).length, 0)
    assert.equal(waitingOn(base, 'ana').length, 1)
  })

  it('finds nothing is yours when no one is signed in', () => {
    assert.deepEqual([...new Set(waitingOn(s(), undefined).map((r) => r.for))].sort(), ['anyone', 'others'])
  })

  it('gives each row an id of its own', () => {
    const ids = waitingOn(s(), 'ana').map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe('what calls for attention', () => {
  it('is what’s for you and for anyone, not what’s on others', () => {
    const rows = waitingOn(state({ cards: [card('a', { stage: 'blocked', agentId: 'mine', needsYou: 'Q' }), card('b', { stage: 'blocked', agentId: 'theirs', needsYou: 'Q', createdBy: 'ben' })] }), 'ana')
    assert.deepEqual(forAttention(rows).map((r) => r.about.id), ['a'])
  })

  it('has each kind on the screen it belongs to', () => {
    assert.deepEqual(screenOf, { question: 'flow', stopped: 'flow', permission: 'flow', findings: 'flow', changeSet: 'changes', proposals: 'notes', noteChange: 'notes', promotion: 'delivery' })
  })
})
