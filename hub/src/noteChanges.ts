import { randomUUID } from 'node:crypto'
import { lockStops, titleOf, type NoteProposal } from '../../shared/notes.ts'
import { Refused, type Actor, type Hub } from './hub.ts'

// Locks and what comes of them. A person locks a note they've settled, and then only they and the Binder's owners and
// admins can change it. Anyone else, agents included, proposes: the proposal holds the words, people and agents talk it
// over on it, and someone who may change the note decides.

const noteOf = (hub: Hub, id: string) => {
  const note = hub.state.notes.find((n) => n.id === id)
  if (!note) throw new Refused(`No note ${id}.`)
  return note
}

export async function setLock(hub: Hub, login: string, manager: boolean, noteId: string, locked: boolean) {
  const note = noteOf(hub, noteId)
  if (locked) {
    if (note.locked) return
  } else if (lockStops(note, { login, manager })) {
    throw new Refused(`Only @${note.locked!.by} or this Binder’s owners and admins can unlock it.`)
  }
  await hub.record({ kind: 'hub' }, { type: 'note.lock', id: noteId, locked: locked ? { by: login, at: new Date().toISOString() } : undefined })
}

export async function propose(hub: Hub, actor: Actor, by: string, noteId: string, text: string, why: string) {
  const note = noteOf(hub, noteId)
  if (!note.locked) throw new Refused(`“${titleOf(note.text)}” isn’t locked: change it directly.`)
  if (!why.trim()) throw new Refused('Say why it should change.')
  if (text === note.text) throw new Refused('That’s what the note already says.')
  if (text.length > 200_000) throw new Refused('That’s too long for a note.')
  const proposal: NoteProposal = { id: `np-${randomUUID().slice(0, 8)}`, noteId, binderId: note.binderId, by, at: new Date().toISOString(), why: why.trim().slice(0, 4000), base: note.text, text, state: 'open', comments: [] }
  await hub.record(actor, { type: 'noteProposal.put', proposal })
  return proposal
}

const proposalOf = (hub: Hub, id: string) => {
  const proposal = hub.state.noteProposals.find((p) => p.id === id)
  if (!proposal) throw new Refused(`No proposal ${id}.`)
  return proposal
}

export async function commentOn(hub: Hub, actor: Actor, by: string, id: string, text: string) {
  proposalOf(hub, id)
  if (!text.trim()) throw new Refused('Say something.')
  await hub.record(actor, { type: 'noteProposal.update', id, comment: { by, at: new Date().toISOString(), text: text.trim().slice(0, 4000) } })
}

/** Whoever may change the note decides. Accepting writes the proposal's words, as long as the note hasn't moved on from what it was proposed against. */
export async function decide(hub: Hub, login: string, manager: boolean, id: string, accept: boolean) {
  const proposal = proposalOf(hub, id)
  if (proposal.state !== 'open') throw new Refused('That proposal has been decided.')
  const note = noteOf(hub, proposal.noteId)
  if (lockStops(note, { login, manager })) throw new Refused(`Only @${note.locked!.by} or this Binder’s owners and admins can decide this.`)
  const at = new Date().toISOString()
  const decided = { decidedBy: login, decidedAt: at, state: accept ? 'accepted' as const : 'rejected' as const }
  if (!accept) {
    await hub.record({ kind: 'hub' }, { type: 'noteProposal.update', id, fields: decided })
    return { proposal, note, accepted: false }
  }
  if (note.text !== proposal.base) throw new Refused('The note has changed since this was proposed, so accepting it would undo that. Ask for it to be proposed again.')
  await hub.recordAll({ kind: 'hub' }, [
    { type: 'note.edit', id: note.id, text: proposal.text, title: titleOf(proposal.text), by: proposal.by, at },
    { type: 'noteProposal.update', id, fields: decided },
  ])
  return { proposal, note, accepted: true }
}
