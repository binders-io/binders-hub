import assert from 'node:assert/strict'
import { it } from 'node:test'
import { applyChange, emptyState } from '../shared/state.ts'
import { demoChanges, demoIds, demoPeople } from './data.ts'
import { realWords } from './shoot.ts'

const state = () => demoChanges().reduce(applyChange, emptyState())

it('holds together: everything named exists', () => {
  const s = state()
  for (const set of s.changeSets) for (const id of set.prIds) assert.ok(s.pulls.some((p) => p.id === id), `${set.id} names ${id}`)
  for (const env of s.environments) for (const id of env.changeSetIds) assert.ok(s.changeSets.some((c) => c.id === id), `${env.id} names ${id}`)
  for (const pull of s.pulls) assert.ok(s.cards.some((c) => c.id === pull.cardId && c.prId === pull.id), `${pull.id} has its card`)
  for (const card of s.cards) if (card.agentId) assert.ok(s.agents.some((a) => a.id === card.agentId), `${card.id}'s agent`)
  for (const card of s.cards) if (card.noteId) assert.ok(s.notes.some((n) => n.id === card.noteId), `${card.id}'s note`)
  assert.ok(s.cards.some((c) => c.id === demoIds.card))
  assert.ok(s.changeSets.some((c) => c.id === demoIds.set))
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
