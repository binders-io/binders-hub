import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorsOf, byWorst, challengeReview, findingAnchor, numberedDiff, patchLines, repliable, type Challenge, type Finding } from '../../shared/changeSet.ts'
import { emptyState } from '../../shared/state.ts'
import { repliesFor, type Card } from '../../shared/work.ts'

describe('a Challenge’s pieces', () => {
  it('numbers each diff line as in its file, new for added and unchanged, old for removed', () => {
    const lines = patchLines('@@ -10,3 +10,3 @@ function a() {\n keep\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n@@ -40 +40,2 @@\n x\n+y')
    assert.deepEqual(lines.map((l) => [l.kind, l.text, l.n]), [['@', 'function a() {', undefined], [' ', 'keep', 10], ['-', 'old', 11], [' ', ' No newline at end of file', undefined], ['+', 'new', 11], [' ', ' No newline at end of file', undefined], ['@', '', undefined], [' ', 'x', 40], ['+', 'y', 41]])
    assert.equal(numberedDiff({ path: 'a.ts', added: 1, removed: 0, lines: patchLines('@@ -1 +1,2 @@\n a\n+b') }), '@@ \n  1  a\n  2 +b')
    // Lines kept from before they were numbered still read.
    assert.equal(numberedDiff({ path: 'a.ts', added: 1, removed: 0, lines: [{ kind: '+', text: 'b' }] }), '    +b')
  })

  it('puts the worst first: by severity, then confirmed before plausible, else as the reviewer gave them', () => {
    const f = (id: string, severity: Finding['severity'], confidence: Finding['confidence']): Finding => ({ id, kind: 'bug', file: 'a.ts', line: 1, what: id, severity, confidence })
    assert.deepEqual([f('a', 'low', 'confirmed'), f('b', 'high', 'plausible'), f('c', 'high', 'confirmed'), f('d', 'medium', 'plausible'), f('e', 'high', 'plausible')].sort(byWorst).map((x) => x.id), ['c', 'b', 'e', 'd', 'a'])
  })

  it('knows a card’s authors: its holder, its pull request’s agent, and any agent that worked it before', () => {
    const state = emptyState()
    state.agents = ['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, name: id, provider: 'claude', owner: 'you', repos: [], binders: [], skills: [], createdAt: '' }) as never)
    const card = { id: 'c1', binderId: 'b1', title: 't', brief: '', doneWhen: '', stage: 'review', size: 'M', waitsFor: [], agentId: 'a1', activity: [
      { at: '', by: 'a2', kind: 'claimed', text: 'Took it' }, { at: '', by: 'a2', kind: 'released', text: 'Let it go' },
      { at: '', by: 'a4', kind: 'debrief', text: 'Wrote the debrief' }, { at: '', by: 'you', kind: 'comment', text: 'Hi' },
    ] } as unknown as Card
    state.cards = [card]
    state.pulls = [{ id: 'acme/web#7', repo: 'acme/web', number: 7, title: '', branch: '', url: '', state: 'open', cardId: 'c1', agentId: 'a3', checks: [], files: [] }]
    assert.deepEqual(authorsOf(state, card), ['a1', 'a3', 'a2'])
  })

  it('anchors a finding on its line in the diff: the new file’s side unless only a removed line has that number', () => {
    const files = [{ path: 'src/a.ts', added: 2, removed: 2, lines: patchLines('@@ -1,4 +1,4 @@\n a\n-b\n+c\n x\n-y\n-z\n+w') }]
    assert.deepEqual(findingAnchor(files, { file: 'src/a.ts', line: 2 }), { path: 'src/a.ts', line: 2, side: 'RIGHT' }, 'added, and removed, both 2: the new file’s')
    assert.deepEqual(findingAnchor(files, { file: 'src/a.ts', line: 3 }), { path: 'src/a.ts', line: 3, side: 'RIGHT' }, 'unchanged')
    assert.deepEqual(findingAnchor(files, { file: 'src/a.ts', line: 5 }), { path: 'src/a.ts', line: 5, side: 'LEFT' }, 'only a removed line is 5')
    assert.equal(findingAnchor(files, { file: 'src/a.ts', line: 9 }), undefined, 'not in the diff')
    assert.equal(findingAnchor(files, { file: 'src/b.ts', line: 1 }), undefined, 'not a file of the diff')

    const f = (id: string, line: number): Finding => ({ id, kind: 'bug', file: 'src/a.ts', line, what: `What ${id}.`, confidence: 'confirmed', severity: 'medium' })
    const challenge: Challenge = { state: 'done', askedBy: 'you', askedAt: '', agentId: 'a1', picked: 'hub', authors: [], findings: [f('f1', 5), f('f2', 9)] }
    const review = challengeReview(challenge, files, { agent: 'Reviewer' })
    assert.deepEqual(review.comments, [{ path: 'src/a.ts', line: 5, side: 'LEFT', body: '**Medium** · confirmed · bug\n\nWhat f1.' }])
    assert.match(review.body, /^### Challenge: 2 findings\n/)
    assert.ok(review.body.endsWith('**Not on a line of this diff**\n\n- `src/a.ts:9` **Medium** · confirmed · bug\n  What f2.'))
    assert.equal(challengeReview(challenge, [], { agent: 'Reviewer' }).comments.length, 0, 'no diff: all in the body')
  })

  it('lets the author be asked to reply once: after findings, not while a round is under way, never after it answered', () => {
    const finding: Finding = { id: 'f1', kind: 'bug', file: 'a.ts', line: 1, what: 'w', severity: 'low', confidence: 'plausible' }
    const done: Challenge = { state: 'done', askedBy: 'you', askedAt: '', agentId: 'r', picked: 'hub', authors: ['a'], findings: [finding] }
    const round = (state: NonNullable<Challenge['replies']>['state'], askedAt = new Date().toISOString()) => ({ ...done, replies: { state, askedBy: 'you', askedAt, agentId: 'a' } })
    assert.equal(repliable(done), true)
    assert.equal(repliable({ ...done, findings: [] }), false, 'nothing found, nothing to reply to')
    assert.equal(repliable({ ...done, findings: [{ ...finding, outcome: { kind: 'dismissed', by: 'you', at: '' } }] }), false, 'every finding dismissed')
    assert.equal(repliable({ ...done, state: 'reviewing' }), false)
    assert.equal(repliable(round('asked')), false)
    assert.equal(repliable(round('replying')), false)
    assert.equal(repliable(round('done')), false, 'one round only')
    assert.equal(repliable(round('failed')), true, 'a failed round brought no replies')
    assert.equal(repliable(round('replying', new Date(Date.now() - 31 * 60_000).toISOString())), true, 'an author that went quiet for half an hour')
  })

  it('gives the author its round of replies, but not while its runner works the card itself in the same worktree', () => {
    const state = emptyState()
    const agent = { id: 'a1', name: 'a1', provider: 'claude', owner: 'you', repos: [], binders: [], skills: [], createdAt: '' } as never
    const challenge: Challenge = { state: 'done', askedBy: 'you', askedAt: '', agentId: 'r', picked: 'hub', authors: ['a1'], findings: [], replies: { state: 'asked', askedBy: 'you', askedAt: '', agentId: 'a1' } }
    state.cards = [{ id: 'c1', binderId: 'b1', title: 't', brief: '', doneWhen: '', stage: 'working', size: 'M', waitsFor: [], agentId: 'a1', activity: [], challenge } as unknown as Card]
    assert.equal(repliesFor(state, agent)?.id, 'c1')
    assert.equal(repliesFor(state, agent, ['c1']), undefined, 'the card is being worked')
    assert.equal(repliesFor(state, agent, ['replies:c1']), undefined, 'already replying')
  })
})
