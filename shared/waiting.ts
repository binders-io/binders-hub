import type { HubState } from './state.ts'
import { openFindings } from './changeSet.ts'
import { binderRepos, promotion, sameRepo, type Card, type ChangeSet } from './work.ts'

// What waits on a person. Home, ⌘K, the sidebar's badges, the tab's title and the browser's notifications all ask this
// one function, so they can't disagree. It reads the hub's state and nothing else, so the web app and the hub both use it.

export type WaitKind = 'question' | 'stopped' | 'permission' | 'changeSet' | 'proposals' | 'noteChange' | 'findings' | 'promotion'

/** you: it's on this person in particular. anyone: nobody in particular, so anyone in the binder can. others: it's on someone else. */
export type WaitFor = 'you' | 'anyone' | 'others'

/** What a row is about, to open it: a card, change set, note or environment. */
export interface WaitAbout {
  type: 'card' | 'changeSet' | 'note' | 'environment'
  id: string
}

export interface Waiting {
  /** Stable while the same thing waits, and gone when it's dealt with: what a notification is remembered by. */
  id: string
  kind: WaitKind
  for: WaitFor
  about: WaitAbout
  /** The binder it's in. An environment has none of its own, so it's missing there. */
  binderId?: string
  title: string
  /** One line on what's wanted. */
  detail: string
  /** When it began waiting, as an ISO date; empty when nothing says. */
  since: string
  /** How many things the row stands for: the cards proposed from one note, else 1. */
  count: number
}

export interface WaitingOptions {
  /** Only what's in this binder; none, or "all", for every one. */
  binder?: string
  /** The person can only read: nothing waits on them, so every row is on someone else, and still there to see. */
  reads?: boolean
}

const lower = (text: string | undefined) => (text ?? '').toLowerCase()
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Whichever of the people given is `login`, else the first who is someone else, else nobody in particular. */
function whoseIs(login: string | undefined, people: (string | undefined)[]): WaitFor {
  const named = people.filter((p): p is string => !!p)
  if (login && named.some((p) => lower(p) === lower(login))) return 'you'
  return named.length ? 'others' : 'anyone'
}

/** The change set's cards: those whose pull request is in it, and, for a note's own set, the note's cards. */
function cardsOfSet(state: HubState, set: ChangeSet): Card[] {
  const pulls = new Set(set.prIds)
  const fromPulls = new Set(state.pulls.filter((p) => pulls.has(p.id) && p.cardId).map((p) => p.cardId))
  return state.cards.filter((c) => (c.prId && pulls.has(c.prId)) || fromPulls.has(c.id) || (!!set.forNote && c.noteId === set.forNote && !c.scheduleId))
}

/**
 * Whether a change set is ready for a person to approve: in review, or still assembling with pull requests and nothing
 * of its cards left to do. Its pull requests may all have gone already, and then there's nothing to approve.
 */
function toApprove(state: HubState, set: ChangeSet) {
  if (set.state === 'review') return true
  if (set.state !== 'assembling' || !set.prIds.length) return false
  const pulls = state.pulls.filter((p) => set.prIds.includes(p.id))
  if (pulls.length && pulls.every((p) => p.state === 'merged' || p.state === 'closed')) return false
  if (cardsOfSet(state, set).some((c) => ['proposed', 'ready', 'working', 'blocked'].includes(c.stage))) return false
  return !(set.forNote && state.proposals.some((p) => p.noteId === set.forNote && p.state === 'new'))
}

const time = (iso: string) => (Number.isNaN(Date.parse(iso)) ? Infinity : Date.parse(iso))
/** Oldest first, a row with no date after the rest (Infinity minus Infinity isn't a number). */
const oldest = (a: string, b: string) => (time(a) === time(b) ? 0 : time(a) < time(b) ? -1 : 1)
const order: Record<WaitFor, number> = { you: 0, anyone: 1, others: 2 }

/**
 * Everything waiting on `login`, or on anyone in the binders they're in, or on someone else, theirs first and the
 * oldest first within each. Rows with no date go last in their group.
 */
export function waitingOn(state: HubState, login: string | undefined, options: WaitingOptions = {}): Waiting[] {
  const here = (binderId: string | undefined) => !options.binder || options.binder === 'all' || binderId === options.binder
  const agentName = (id: string | undefined) => state.agents.find((a) => a.id === id)?.name ?? 'An agent'
  const ownerOf = (id: string | undefined) => state.agents.find((a) => a.id === id)?.owner
  // A card's maker is a person unless the hub or an agent made it.
  const makerOf = (card: Card) => (card.createdBy && card.createdBy !== 'hub' && !state.agents.some((a) => a.id === card.createdBy) ? card.createdBy : undefined)
  const rows: Waiting[] = []

  for (const card of state.cards) {
    if (!here(card.binderId)) continue
    const about = { type: 'card' as const, id: card.id }
    // A card that stopped twice has no agent and its question is the reason, which the row says in its own words.
    const stopped = card.stage === 'blocked' && !card.agentId && !!card.stopped
    if (stopped) {
      rows.push({ id: `stopped:${card.id}`, kind: 'stopped', for: lower(makerOf(card)) === lower(login) && !!login ? 'you' : 'anyone', about, binderId: card.binderId, title: card.title, detail: card.stopped!.why, since: card.stopped!.at, count: 1 })
    } else if (card.needsYou && card.stage !== 'live') {
      const asked = [...card.activity].reverse().find((a) => a.kind === 'question')
      rows.push({ id: `question:${card.id}`, kind: 'question', for: whoseIs(login, [ownerOf(card.agentId), makerOf(card)]), about, binderId: card.binderId, title: card.title, detail: `${agentName(card.agentId)} asks: ${card.needsYou}`, since: asked?.at ?? card.updatedAt, count: 1 })
    }
    if (card.permission && !card.permission.answer) {
      // Only the owner of the agent that asks can answer.
      const owner = ownerOf(card.permission.agent)
      rows.push({ id: `permission:${card.id}`, kind: 'permission', for: login && lower(owner) === lower(login) ? 'you' : 'others', about, binderId: card.binderId, title: card.title, detail: `${agentName(card.permission.agent)} asks to use ${card.permission.tool}: ${card.permission.what}`, since: card.permission.at, count: 1 })
    }
    const open = card.stage === 'review' && card.challenge?.state === 'done' ? openFindings(card.challenge) : []
    if (open.length) {
      rows.push({ id: `findings:${card.id}`, kind: 'findings', for: whoseIs(login, [ownerOf(card.agentId), makerOf(card)]) === 'you' ? 'you' : 'anyone', about, binderId: card.binderId, title: card.title, detail: `A Challenge found ${plural(open.length, 'thing')} to look at`, since: card.challenge!.reviewedAt ?? card.challenge!.askedAt, count: open.length })
    }
  }

  for (const set of state.changeSets) {
    if (!here(set.binderId) || !toApprove(state, set)) continue
    rows.push({ id: `changeSet:${set.id}`, kind: 'changeSet', for: 'anyone', about: { type: 'changeSet', id: set.id }, binderId: set.binderId, title: set.title ? `Change set #${set.number}: ${set.title}` : `Change set #${set.number}`, detail: `${plural(set.prIds.length, 'pull request')} to approve`, since: cardsOfSet(state, set).map((c) => c.updatedAt).filter((t) => !Number.isNaN(Date.parse(t))).sort().at(-1) ?? '', count: 1 })
  }

  // One row for each note, with how many cards were proposed from it.
  const proposed = new Map<string, typeof state.proposals>()
  for (const p of state.proposals) if (p.state === 'new' && here(p.binderId)) proposed.set(p.noteId, [...(proposed.get(p.noteId) ?? []), p])
  for (const [noteId, list] of proposed) {
    const note = state.notes.find((n) => n.id === noteId)
    const shown = list.slice(0, 3).map((p) => p.title).join(' · ')
    rows.push({ id: `proposals:${noteId}`, kind: 'proposals', for: login && note?.editors.some((e) => lower(e) === lower(login)) ? 'you' : 'anyone', about: { type: 'note', id: noteId }, binderId: list[0].binderId, title: note?.title || 'A note', detail: `${list.length} proposed: ${shown}${list.length > 3 ? ' …' : ''}`, since: note?.editedAt ?? '', count: list.length })
  }

  for (const proposal of state.noteProposals ?? []) {
    if (proposal.state !== 'open' || !here(proposal.binderId)) continue
    const note = state.notes.find((n) => n.id === proposal.noteId)
    if (!note) continue
    const by = state.agents.find((a) => a.id === proposal.by)?.name ?? proposal.by
    // The one who locked it decides. A note that isn't locked now has no one in particular.
    const to: WaitFor = !note.locked ? 'anyone' : login && lower(note.locked.by) === lower(login) ? 'you' : 'others'
    rows.push({ id: `noteChange:${proposal.id}`, kind: 'noteChange', for: to, about: { type: 'note', id: note.id }, binderId: note.binderId, title: note.title, detail: `${by} proposes a change${proposal.why ? `: ${proposal.why}` : ''}`, since: proposal.at, count: 1 })
  }

  for (const env of state.environments) {
    // An environment is a repo's, not a binder's: it's here when this binder follows that repo, or says nothing of repos.
    const repos = options.binder && options.binder !== 'all' ? binderRepos(state.binders.find((b) => b.id === options.binder)) : []
    if (repos.length && !repos.some((r) => sameRepo(r, env.repo))) continue
    const about = { type: 'environment' as const, id: env.id }
    // Promote is the hub's own step: it waits when the environment before has a version this one doesn't, and says it needs a person.
    const move = promotion(state, env)
    if (move && env.needsApproval) {
      rows.push({ id: `promotion:${env.id}`, kind: 'promotion', for: 'anyone', about, title: `Promote ${move.version} to ${env.name}`, detail: env.repo ?? '', since: '', count: 1 })
    }
    // GitHub's own: a deployment held for an approval that's given there, which Promote here can't give.
    if (env.state === 'waiting') {
      rows.push({ id: `approval:${env.id}`, kind: 'promotion', for: 'anyone', about, title: `${env.name} waits for an approval`, detail: `It’s approved on GitHub${env.repo ? `, in ${env.repo}` : ''}.`, since: '', count: 1 })
    }
  }

  const sorted = rows.sort((a, b) => order[a.for] - order[b.for] || oldest(a.since, b.since))
  return options.reads ? sorted.map((row) => ({ ...row, for: 'others' as const })) : sorted
}

/** The rows that call for attention: everything but what's on someone else. */
export const forAttention = (rows: Waiting[]) => rows.filter((r) => r.for !== 'others')

/** The screen each kind of row belongs to, for the count beside its name. */
export const screenOf: Record<WaitKind, 'flow' | 'notes' | 'changes' | 'delivery'> = {
  question: 'flow', stopped: 'flow', permission: 'flow', findings: 'flow', changeSet: 'changes', proposals: 'notes', noteChange: 'notes', promotion: 'delivery',
}
