import assert from 'node:assert/strict'
import { it } from 'node:test'
import { applyChange, emptyState } from '../shared/state.ts'
import { environmentId, promotion, repoEnvironments, sameRepo } from '../shared/work.ts'
import { demoChanges, demoIds, demoPeople } from './data.ts'
import { realWords } from './shoot.ts'

const state = () => demoChanges().reduce(applyChange, emptyState())

it('holds together: everything named exists', () => {
  const s = state()
  for (const set of s.changeSets) for (const id of set.prIds) assert.ok(s.pulls.some((p) => p.id === id), `${set.id} names ${id}`)
  for (const pull of s.pulls) assert.ok(s.cards.some((c) => c.id === pull.cardId && c.prId === pull.id), `${pull.id} has its card`)
  for (const card of s.cards) if (card.agentId) assert.ok(s.agents.some((a) => a.id === card.agentId), `${card.id}'s agent`)
  for (const card of s.cards) if (card.noteId) assert.ok(s.notes.some((n) => n.id === card.noteId), `${card.id}'s note`)
  assert.ok(s.cards.some((c) => c.id === demoIds.card))
  assert.ok(s.changeSets.some((c) => c.id === demoIds.set))
  for (const schedule of s.schedules ?? []) {
    assert.ok(s.notes.some((n) => n.id === schedule.noteId), `${schedule.id}'s note`)
    if (schedule.agentId) assert.ok(s.agents.some((a) => a.id === schedule.agentId), `${schedule.id}'s agent`)
    if (schedule.folderId) assert.ok(s.folders.some((f) => f.id === schedule.folderId), `${schedule.id}'s folder`)
    if (schedule.lastCardId) assert.ok(s.cards.some((c) => c.id === schedule.lastCardId), `${schedule.id}'s last card`)
  }
  for (const rule of s.folderRules ?? []) {
    assert.ok(s.folders.some((f) => f.id === rule.folderId), `${rule.id}'s folder`)
    if (rule.agentId) assert.ok(s.agents.some((a) => a.id === rule.agentId), `${rule.id}'s agent`)
  }
  for (const chat of s.chats) {
    assert.ok(s.notes.some((n) => n.id === chat.noteId), `${chat.id}'s note`)
    assert.ok(s.agents.some((a) => a.id === chat.agentId), `${chat.id}'s agent`)
    assert.ok(chat.messages.some((m) => m.by === chat.agentId), `${chat.id} has the agent's reply`)
  }
  for (const proposal of s.noteProposals ?? []) {
    const note = s.notes.find((n) => n.id === proposal.noteId)
    assert.ok(note, `${proposal.id}'s note`)
    assert.ok(note.locked, `${proposal.id} is on a locked note`)
    assert.equal(proposal.base, note.text, `${proposal.id} is proposed against the note as it is`)
    assert.ok(s.agents.some((a) => a.id === proposal.by) || demoPeople.includes(proposal.by), `${proposal.id}'s author`)
  }
})

it('delivers by repo: each environment is one of a repo the demo works in, and what it names exists', () => {
  const s = state()
  assert.ok(s.environments.length >= 2)
  for (const env of s.environments) {
    assert.ok(env.repo, `${env.id} has a repo`)
    assert.ok(s.pulls.some((p) => sameRepo(p.repo, env.repo)) || s.binders.some((b) => sameRepo(b.repo, env.repo)), `${env.id}'s repo is one the demo uses`)
    assert.equal(env.id, environmentId(env.repo, env.name), `${env.id} follows environmentId`)
    assert.equal(typeof env.order, 'number', `${env.id} has its place`)
    assert.ok(!env.url || /^https:\/\/([\w-]+\.)*harbor\.example$/.test(env.url), `${env.id}'s address is an invented one`)
    for (const id of env.changeSetIds) assert.ok(s.changeSets.some((c) => c.id === id), `${env.id} names ${id}`)
    for (const id of env.pullIds ?? []) {
      const pull = s.pulls.find((p) => p.id === id)
      assert.ok(pull, `${env.id} names ${id}`)
      assert.equal(pull.state, 'merged', `${id} is on ${env.id}, so it's merged`)
      assert.ok(sameRepo(pull.repo, env.repo), `${id} is of ${env.id}'s repo`)
    }
  }
  assert.equal(new Set(s.environments.map((e) => e.id)).size, s.environments.length)
  for (const pull of s.pulls) assert.equal(!!pull.mergeSha, pull.state === 'merged', `${pull.id}'s merge commit`)
})

it('delivers the story: change set #11 is on staging and waits for production, which has a Promote', () => {
  const s = state()
  const set = (id: string) => s.changeSets.find((c) => c.id === id)!
  const merged = s.pulls.filter((p) => p.state === 'merged')
  for (const repo of new Set(s.environments.map((e) => e.repo!))) {
    const [first, ...later] = repoEnvironments(s, repo)
    assert.ok(later.length, `${repo} has more than one environment`)
    assert.deepEqual(merged.filter((p) => sameRepo(p.repo, repo)).map((p) => p.id).sort(), [...(first.pullIds ?? [])].sort(), `${first.name} has what ${repo} merged`)
  }
  const [staging, production] = repoEnvironments(s, 'example/api')
  assert.equal(staging.name, 'Staging')
  assert.equal(production.name, 'Production')
  assert.ok(staging.changeSetIds.includes('cs-11'))
  assert.ok(!production.changeSetIds.includes('cs-11'))
  assert.ok(set('cs-11').prIds.every((id) => staging.pullIds?.includes(id) && !production.pullIds?.includes(id)))
  assert.ok(set('cs-10').prIds.every((id) => production.pullIds?.includes(id)))
  assert.ok(!s.environments.some((e) => e.changeSetIds.includes('cs-12')), 'change set #12 is still in review')
  assert.equal(promotion(s, production)?.version, staging.version)
  assert.equal(promotion(s, staging), undefined)
})

it('is one piece of work: every change set and card comes from the one note', () => {
  const s = state()
  assert.ok(s.changeSets.every((c) => c.noteIds.includes(demoIds.note)))
  assert.ok(s.cards.every((c) => c.noteId === demoIds.note))
})

it('names no one and nothing real', () => {
  const text = JSON.stringify(demoChanges()).toLowerCase()
  for (const word of realWords()) assert.ok(!text.includes(word), `the data says ${word}`)
  assert.ok(demoPeople.length)
})

it('dates everything before the moment it runs, so the pictures never look old or from the future', () => {
  const now = Date.now()
  const dates = JSON.stringify(demoChanges(now)).match(/\d{4}-\d\d-\d\dT[\d:.]+Z/g) ?? []
  assert.ok(dates.length > 20)
  assert.ok(dates.every((d) => Date.parse(d) <= now))
})
