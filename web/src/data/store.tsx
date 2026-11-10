import { shownName } from '../../../shared/people.ts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { emptyState, type Change, type HubState } from '../../../shared/state.ts'
import { titleOf } from '../../../shared/notes.ts'
import type { Activity, Agent, Card, Environment, Me, Note, Provider } from './model'
import { handMove, type Presence, type RunnerSettings } from '../../../shared/work.ts'
import type { BlastRadius, BlastSymbol, TestOutcome } from '../../../shared/changeSet.ts'
import { call } from './api'
import { askedReasoning } from '../components/Reasoning'
import { attempt, failure, toast } from '../components/Toast'
import { clientId, HubConnection, hold, keptTexts, queue, receive, rememberCache, rememberOutbox, settled, shown, snapshot, startingSync, withHistory, type AgentTerminals, type Connection, type Sync } from './sync'
import { isEmpty, textOf } from './noteText'
import { LiveNotes, type LiveNote, type Waiting } from './liveNote'
import { spaceHeaders } from './space'

// The web app's state: the hub's, as this tab has it (confirmed, with its own waiting changes on top), and who's signed
// in. Notes, folders, binders and cards change here at once and go to the hub; what needs the hub to do more (accept a
// proposal, approve a change set, set up an agent) is a call to it, and its result comes back through the live feed.
//
// It's held outside React, and a component subscribes to the part it shows with `useHub`: a keystroke or an agent's
// progress changes the state many times a second, and only what shows that part should draw again. `useStore` is all of
// it, for a screen that can afford to draw on every change. Actions are `useActions`: the same functions throughout,
// which read the state as it is when they run.

export interface State extends HubState {
  sync: Sync
  /** Agents' presence, live from the hub. */
  presence: Record<string, Presence>
  /** The terminals open on the agents you own, live from the hub. */
  terminals: Record<string, AgentTerminals>
  me?: Me
  /** Not signed in: the sign-in screen shows. */
  signedOut: boolean
  /** The hub gave no answer to the first request: that isn't being signed out, and the sign-in screen says so. */
  unreachable: boolean
}

type Step = (state: State) => State

const withShown = (s: State): State => ({ ...s, ...shown(s.sync, s) })

const starting = (): State => withShown({ ...emptyState(), sync: startingSync(emptyState()), presence: {}, terminals: {}, signedOut: false, unreachable: false })

let made = 0
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++made).toString(36)}`

export interface NewCard {
  binderId: string
  title: string
  brief?: string
  doneWhen?: string
  size?: Card['size']
  meantFor?: string
  noteId?: string
  quote?: string
  /** Where it starts: a person's card is Ready unless this says Proposed, where nothing picks it up. */
  stage?: Card['stage']
}

export interface NewAgent {
  name: string
  provider: Provider
  repos: string[]
  binders: string[]
  skills: string[]
  runsOn?: string
  runner?: RunnerSettings
}

/** How the hub deploys to an environment: a workflow it runs, on a branch or tag. `repo` is left out for the environment's own. */
export interface DeployFrom {
  repo?: string
  workflow: string
  ref: string
}

export interface NewEnvironment {
  repo: string
  name: string
  url?: string
  needsApproval?: boolean
  deploy?: DeployFrom
}

/** What may change on an environment. `deploy: null` stops the hub deploying to it; `order` is the place to move it to among its repo's, from 0. */
export interface EnvironmentChange {
  name?: string
  url?: string
  needsApproval?: boolean
  deploy?: DeployFrom | null
  order?: number
}

/** What looking on GitHub found: the repos it looked at, and those it couldn't, with why. */
export interface DeploymentLook {
  looked: string[]
  failed: { repo: string; why: string }[]
}

export interface NotesSaved {
  committed: number
  binders: { id: string; name: string; repo?: string; push?: { to?: string; branch?: string; at?: string; error?: string } }[]
}

export interface Actions {
  /** The state right now, for what acts on it rather than shows it. */
  current: () => State
  // Notes, folders and binders
  addNote: (binderId: string, folderId?: string, text?: string) => string
  addFolder: (binderId: string, parentId?: string) => string
  renameFolder: (id: string, name: string) => void
  /** Moves a folder under another (or to the top of a binder); into another binder, everything in it goes too. */
  moveFolder: (id: string, binderId: string, parentId?: string) => void
  /** Deletes a folder; what was in it moves up to where it was. */
  deleteFolder: (id: string) => void
  moveNote: (noteId: string, binderId: string, folderId?: string) => void
  /** Deletes a note, which the hub keeps for 30 days: the toast that follows has Undo. */
  deleteNote: (noteId: string) => void
  clearChat: (chatId: string) => void
  /**
   * An edit to a note: Automerge changes to its document, with its text after them; or the whole text, until the document
   * is here. A note whose text isn't here (it has `left`) is never written whole, as what this tab has of it is empty.
   */
  editNote: (noteId: string, text: string, changes?: string[]) => void
  /** Leaving a note nothing was written in throws it away. A note whose text isn't here has something written in it. */
  discardIfEmpty: (noteId: string) => void
  /**
   * A note's text, as the hub sent it with its `editedAt`, taken in here and never sent to the hub. False when it wasn't
   * taken: the note changed meanwhile (the feed is behind, or ahead), or it already has its text.
   */
  holdNote: (noteId: string, text: string, editedAt: string) => boolean
  /** A note was opened: its text is kept with the copy of the state this browser holds for next time (the last 20 are). */
  noteOpened: (noteId: string) => void
  /** A note's text from the hub, with its `editedAt`: one request at a time for each note, shared by whoever asks while it's out. */
  askForText: (noteId: string) => Promise<{ text: string; editedAt: string }>
  addBinder: (name: string, repo?: string) => string
  updateBinder: (id: string, fields: { guideNoteId?: string; name?: string; repo?: string; repos?: string[]; issues?: boolean; notes?: boolean; notesBranch?: string; reviewComments?: boolean; copies?: boolean }) => void
  deleteBinder: (id: string) => Promise<void>
  // Cards
  createCard: (card: NewCard) => Promise<Card>
  updateCard: (id: string, fields: Partial<Card>, note?: string) => void
  /** A person ran one of a debrief's functional tests (on a card or a change set, by its id): passed or failed, or cleared with null. */
  recordTest: (id: string, test: string, outcome: TestOutcome | null, note?: string) => void
  /** Deletes a card, which the hub keeps for 30 days: the toast that follows has Undo. */
  deleteCard: (id: string) => void
  /** Puts a deleted note or card back from the Binder's trash, as it was. */
  putBack: (kind: 'note' | 'card', id: string) => Promise<void>
  /** Moves a card to a stage; anywhere but review or done takes it from its agent, with any question it asked. */
  moveCard: (id: string, stage: Card['stage']) => void
  /** Gives a card to an agent (or opens it to any): one held by another agent goes back on the board for it. */
  giveCard: (id: string, agentId: string) => void
  comment: (cardId: string, text: string) => Promise<void>
  /** Ends an agent's work on a card and keeps it from being taken again: it waits in Proposed. */
  stopCard: (cardId: string) => Promise<void>
  /** Sends a card in review back to its agent with words on what to change: it takes it up again. */
  sendBack: (cardId: string, text: string) => Promise<void>
  answerPermission: (cardId: string, request: string, allow: boolean) => Promise<void>
  /** Splits a card into parts for a swarm of agents; each part a card, the card waiting for them. */
  splitCard: (id: string, parts: { title: string; brief?: string; agent?: string }[]) => Promise<void>
  /** Asks an agent for the card's debrief: the one named, or one the hub picks. */
  debrief: (cardId: string, agentId?: string) => Promise<void>
  /** Asks an agent that didn't write the card's work to challenge it: the one named, or one the hub picks. */
  challenge: (cardId: string, agentId?: string) => Promise<void>
  /** Asks the author of the card's work to reply, once, to its Challenge's findings. */
  replyToFindings: (cardId: string) => Promise<void>
  /** A change set's debrief and Challenge, of all its pull requests together, and each author asked to reply. */
  setDebrief: (setId: string, agentId?: string) => Promise<void>
  setChallenge: (setId: string, agentId?: string) => Promise<void>
  setReplies: (setId: string) => Promise<void>
  /** Sends a Challenge finding back to the card's agent, dismisses it (or opens it again), or makes a card of it. */
  finding: (cardId: string, findingId: string, action: 'send back' | 'dismiss' | 'card' | 'reopen') => Promise<void>
  /** Accepts a proposal: a card in Ready, which an agent can take at once. */
  acceptProposal: (id: string) => Promise<Card>
  /** Accepts a proposal as a card in Proposed instead, where nothing takes it, so a person can fix its words first. */
  editFirst: (id: string) => Promise<Card>
  dismissProposal: (id: string) => void
  /** Puts a dismissed proposal back, as it was. */
  restoreProposal: (id: string) => void
  distill: (noteId: string, agentId?: string) => Promise<Card>
  /** Save all: the hub commits every note still waiting for typing to pause, and pushes each binder's notes to its repo. */
  saveNotes: () => Promise<NotesSaved>
  // Change sets and environments
  sendForReview: (setId: string) => Promise<void>
  deleteSet: (setId: string) => Promise<void>
  approveSet: (setId: string) => Promise<void>
  promote: (envId: string) => Promise<void>
  /** Environments are for the binder's owners and admins: the hub refuses anyone else in words to show as they are. */
  addEnvironment: (environment: NewEnvironment) => Promise<Environment>
  /** Its name is part of its id, so the one it answers with may have a new id. */
  changeEnvironment: (envId: string, fields: EnvironmentChange) => Promise<Environment>
  removeEnvironment: (envId: string) => Promise<void>
  /** Has the hub ask GitHub what it has deployed, for one repo or all that count. Slow: it asks one repo after another. */
  lookForDeployments: (repo?: string) => Promise<DeploymentLook>
  // Agents
  createAgent: (agent: NewAgent) => Promise<{ agent: Agent; token: string }>
  updateAgent: (id: string, fields: Partial<NewAgent>) => Promise<void>
  newToken: (id: string) => Promise<string>
  revokeAgent: (id: string) => Promise<void>
  // Signing in
  signInByName: (login: string) => Promise<void>
  /** Asks the hub again for who you are, after it couldn't be reached, and carries on from there. */
  reconnect: () => Promise<void>
  signOut: () => Promise<void>
}

/** The state and the actions together: draws on every change, so not for what's on screen all the time. */
export interface Store extends Actions {
  state: State
  connection: Connection
}

/** The notes opened here, the last first: the ones whose texts the browser's copy of the state keeps. */
class Opened {
  ids: string[]
  constructor(ids: string[]) {
    this.ids = ids.slice(0, keptTexts)
  }
  open(noteId: string) {
    this.ids = [noteId, ...this.ids.filter((id) => id !== noteId)].slice(0, keptTexts)
  }
}

/** The state, held apart from React, and who to tell when it changes. */
class Held {
  private state: State
  private listeners = new Set<() => void>()
  constructor(state: State) {
    this.state = state
  }
  get = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  step = (step: Step) => {
    const next = step(this.state)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

const HeldContext = createContext<Held | null>(null)
const ActionsContext = createContext<Actions | null>(null)
const LiveContext = createContext<LiveNotes | null>(null)

/** How long the state can wait to be written to the browser: all of it, so not on every change. */
const cacheEveryMs = 1000
/** How long waiting changes can wait for a quiet moment to be written. */
const outboxWithinMs = 50

export function StoreProvider({ children }: { children: ReactNode }) {
  const [held] = useState(() => new Held(starting()))
  const sent = useRef(new Set<string>())
  const hub = useRef<HubConnection>(undefined)
  const flushTimer = useRef<number>(undefined)
  const flushing = useRef<Promise<void>>(undefined)
  // The notes whose texts are kept in the browser's copy: the last opened first, and to start with, those the copy had.
  const [asking] = useState(() => new Map<string, { at: number; answer: Promise<{ text: string; editedAt: string }> }>())
  const [recent] = useState(() => new Opened(held.get().sync.confirmed.notes.filter((n) => !n.left).map((n) => n.id)))
  const [lives] = useState(() => new LiveNotes({
    fetchDoc: async (noteId) => {
      const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}/doc`, { credentials: 'same-origin', headers: spaceHeaders })
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined
    },
    waiting: (noteId) => {
      const waiting: Waiting = { changes: [], whole: false }
      for (const { change } of held.get().sync.pending) {
        if (change.type === 'note.put' && change.note.id === noteId) Object.assign(waiting, { created: change.note.text, changes: [], whole: false })
        if (change.type === 'note.edit' && change.id === noteId) {
          if (change.changes) waiting.changes.push(...change.changes)
          else waiting.whole = true
        }
      }
      return waiting
    },
  }))

  /**
   * Sends what's waiting, in order; what the hub refuses outright is dropped, the rest waits for the next try. One
   * send at a time, so a note's Automerge changes reach the hub after the ones they build on.
   */
  const flush = useCallback(async (): Promise<void> => {
    if (flushing.current) {
      await flushing.current
      return flush()
    }
    const connection = hub.current
    if (!connection?.live) return
    const batch = held.get().sync.pending.filter((p) => !sent.current.has(p.id))
    if (!batch.length) return
    batch.forEach((p) => sent.current.add(p.id))
    const sending = (async () => {
      try {
        const versions = await connection.send(batch)
        const known = batch.filter((_, index) => versions[index] === 0).map((p) => p.id)
        if (known.length) held.step((s) => withShown({ ...s, sync: settled(s.sync, known) }))
      } catch (error) {
        batch.forEach((p) => sent.current.delete(p.id))
        const { status, said } = error as { status?: number; said?: string }
        if (status && status >= 400 && status < 500) {
          held.step((s) => withShown({ ...s, sync: settled(s.sync, batch.map((p) => p.id)) }))
          // An open note whose changes were refused takes the hub's document again.
          lives.reset(batch.flatMap(({ change }) => (change.type === 'note.edit' ? [change.id] : [])))
          failure(said ? `${said} It was undone here.` : 'The hub refused a change. It was undone here.')
        } else flushTimer.current = window.setTimeout(() => void flush(), 3000)
      }
    })()
    flushing.current = sending
    await sending
    flushing.current = undefined
  }, [held, lives])

  const soon = useCallback(() => {
    window.clearTimeout(flushTimer.current)
    flushTimer.current = window.setTimeout(() => void flush(), 250)
  }, [flush])

  /** A change: shown at once, kept in the outbox, sent to the hub. */
  const change = useCallback((next: Change) => {
    held.step((s) => withShown({ ...s, sync: queue(s.sync, next, sent.current) }))
    soon()
  }, [held, soon])

  const loadMe = useCallback(async () => {
    try {
      const me = await call<Me>('GET', '/api/me')
      held.step((s) => ({ ...s, me, signedOut: false, unreachable: false }))
      return true
    } catch (error) {
      // No answer, or the hub's front door answering for a hub that's down, is not the hub saying you're signed out.
      const status = (error as { status?: number }).status
      const unreachable = status === 0 || (status !== undefined && status >= 500)
      held.step((s) => ({ ...s, signedOut: true, unreachable }))
      return false
    }
  }, [held])

  useEffect(() => {
    const connection = new HubConnection({
      snapshot: (version, all) => {
        held.step((s) => withShown({ ...s, sync: snapshot(s.sync, version, all) }))
        // The edits between weren't heard: open notes merge in the hub's documents.
        lives.refresh()
      },
      entries: (entries) => {
        lives.hear(entries, (entry) => entry.client.endsWith(`:${clientId}`))
        held.step((s) => withShown({ ...s, sync: receive(s.sync, entries, sent.current) }))
      },
      status: (status) => {
        held.step((s) => ({ ...s, sync: { ...s.sync, connection: status }, signedOut: status === 'signed-out' ? true : s.signedOut }))
        if (status === 'live') {
          sent.current.clear()
          soon()
        }
      },
      version: () => held.get().sync.version,
      presence: (presence) => {
        presenceNow = presence
        held.step((s) => ({ ...s, presence }))
      },
      terminals: (agentId, open) => held.step((s) => ({ ...s, terminals: { ...s.terminals, [agentId]: open } })),
    })
    hub.current = connection
    void loadMe().then((ok) => {
      if (ok) void connection.start()
    })
    return () => connection.stop()
  }, [held, soon, loadMe, lives])

  // What's waiting goes in the browser as soon as the page has a moment: it's the only copy, but an edit carries its
  // note's whole text, so writing it on the keystroke would hold up the keystroke on a long note. The hub's state is a
  // head start for next time, and large, so it's written once things settle. Both go as the page does.
  useEffect(() => {
    let last = held.get().sync
    let timer: number | undefined
    let outboxDue = false
    const keep = () => {
      window.clearTimeout(timer)
      timer = undefined
      rememberCache(held.get().sync, recent.ids)
    }
    const keepOutbox = () => {
      if (!outboxDue) return
      outboxDue = false
      rememberOutbox(held.get().sync)
    }
    const leave = () => {
      keepOutbox()
      if (timer !== undefined) keep()
    }
    const stop = held.subscribe(() => {
      const now = held.get().sync
      if (now.pending !== last.pending && !outboxDue) {
        outboxDue = true
        if (window.requestIdleCallback) window.requestIdleCallback(keepOutbox, { timeout: outboxWithinMs })
        else window.setTimeout(keepOutbox)
      }
      if (now.confirmed !== last.confirmed && timer === undefined) timer = window.setTimeout(keep, cacheEveryMs)
      last = now
    })
    window.addEventListener('pagehide', leave)
    return () => {
      stop()
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [held, recent])

  const actions = useMemo<Actions>(() => {
    const now = held.get
    const login = () => now().me?.user.login ?? 'you'
    // The hub has to have the deletion first, as it keeps what it deleted: what's waiting is sent before this asks.
    const putBack = async (kind: 'note' | 'card', id: string) => {
      const done = await attempt(async () => {
        await flush()
        await call('POST', `/api/trash/${kind}/${encodeURIComponent(id)}/restore`)
        return true
      })
      if (done) toast('Put back.')
    }
    return {
      current: now,
      addNote: (binderId, folderId, text = '# ') => {
        const id = newId('note')
        change({ type: 'note.put', note: { id, title: titleOf(text), binderId, folderId, editedAt: new Date().toISOString(), editors: [login()], text } })
        return id
      },
      addFolder: (binderId, parentId) => {
        const id = newId('folder')
        change({ type: 'folder.put', folder: { id, binderId, parentId, name: 'New folder' } })
        return id
      },
      moveFolder: (id, binderId, parentId) => {
        const state = now()
        const folder = state.folders.find((f) => f.id === id)
        if (!folder || id === parentId) return
        // Not into itself or a folder inside it.
        const inside = (fid: string | undefined): boolean => !!fid && (fid === id || inside(state.folders.find((f) => f.id === fid)?.parentId))
        if (inside(parentId)) return
        if (folder.binderId === binderId && folder.parentId === parentId) return
        change({ type: 'folder.put', folder: { ...folder, binderId, parentId } })
        if (folder.binderId !== binderId) {
          const below = (fid: string): string[] => state.folders.filter((f) => f.parentId === fid).flatMap((f) => [f.id, ...below(f.id)])
          const all = [id, ...below(id)]
          for (const fid of all.slice(1)) {
            const f = state.folders.find((x) => x.id === fid)!
            change({ type: 'folder.put', folder: { ...f, binderId } })
          }
          for (const note of state.notes.filter((n) => n.folderId && all.includes(n.folderId))) change({ type: 'note.move', id: note.id, binderId, folderId: note.folderId })
        }
      },
      deleteFolder: (id) => change({ type: 'folder.delete', id }),
      renameFolder: (id, name) => {
        const folder = now().folders.find((f) => f.id === id)
        if (folder && name.trim() && name.trim() !== folder.name) change({ type: 'folder.put', folder: { ...folder, name: name.trim() } })
      },
      moveNote: (noteId, binderId, folderId) => change({ type: 'note.move', id: noteId, binderId, folderId }),
      deleteNote: (noteId) => {
        change({ type: 'note.delete', id: noteId })
        toast('Deleted.', { action: { label: 'Undo', run: () => void putBack('note', noteId) } })
      },
      clearChat: (chatId) => change({ type: 'chat.clear', id: chatId }),
      editNote: (noteId, text, changes) => {
        // The whole text of a note this tab doesn't have the text of would be taken by the hub as the note: nothing goes.
        // Changes to its document are only what was typed, so they go: an editor that kept its note when a snapshot took
        // the text away sends no other kind.
        if (!changes && now().notes.find((n) => n.id === noteId)?.left) return
        change({ type: 'note.edit', id: noteId, text, title: titleOf(text), by: login(), at: new Date().toISOString(), ...(changes ? { changes } : {}) })
      },
      discardIfEmpty: (noteId) => {
        const note = now().notes.find((n) => n.id === noteId)
        // Throwing away an empty note is a change, which a reader's leaving of one they only looked at must not send.
        if (note && isEmpty(note) && now().me?.role !== 'reader') change({ type: 'note.delete', id: noteId })
      },
      holdNote: (noteId, text, editedAt) => {
        let took = false
        held.step((s) => {
          const next = hold(s.sync, noteId, text, editedAt)
          if (next === s.sync) return s
          took = true
          return withShown({ ...s, sync: next })
        })
        return took
      },
      noteOpened: (noteId) => recent.open(noteId),
      askForText: (noteId) => {
        // A request that has hung is not waited on for ever: after a while the next one is a new one.
        const out = asking.get(noteId)
        if (out && Date.now() - out.at < askedForMs) return out.answer
        const answer = call<{ text?: unknown; editedAt?: unknown }>('GET', `/api/notes/${encodeURIComponent(noteId)}/text`)
          .then((body) => {
            // An answer that isn't a text and when it was written is not taken for an empty note.
            if (typeof body?.text !== 'string' || typeof body.editedAt !== 'string') throw new Error('The hub answered without the note’s text.')
            return { text: body.text, editedAt: body.editedAt }
          })
          .finally(() => {
            if (asking.get(noteId)?.answer === answer) asking.delete(noteId)
          })
        asking.set(noteId, { at: Date.now(), answer })
        return answer
      },
      addBinder: (name, repo) => {
        const id = newId('binder')
        change({ type: 'binder.put', binder: { id, name: name.trim() || 'Notes', repo: repo?.trim() || undefined, createdBy: now().me?.user.login } })
        return id
      },
      updateBinder: (id, fields) => {
        const binder = now().binders.find((b) => b.id === id)
        if (binder) change({ type: 'binder.put', binder: { ...binder, ...(fields.guideNoteId === undefined ? {} : { guideNoteId: fields.guideNoteId || undefined }), name: fields.name?.trim() || binder.name, repo: fields.repo === undefined ? binder.repo : fields.repo.trim() || undefined, repos: fields.repos === undefined ? binder.repos : fields.repos.length ? fields.repos : undefined, issues: fields.issues ?? binder.issues, notes: fields.notes ?? binder.notes, notesBranch: fields.notesBranch ?? binder.notesBranch, reviewComments: fields.reviewComments ?? binder.reviewComments, ...(fields.copies === undefined ? {} : { copies: fields.copies }) } })
      },
      deleteBinder: async (id) => {
        // Sent at once, not queued, so a refusal (it isn't empty) shows here.
        await call('POST', '/api/changes', { client: 'binder-delete', changes: [{ id: newId('delete'), change: { type: 'binder.delete', id } }] })
      },
      createCard: (card) => call<Card>('POST', '/api/cards', card),
      recordTest: (id, test, outcome, note) => change({ type: 'test.result', id, test, result: outcome ? { outcome, ...(note?.trim() ? { note: note.trim() } : {}), by: login(), at: new Date().toISOString() } : null }),
      updateCard: (id, fields, note) => change({ type: 'card.update', id, fields, activity: note ? { at: new Date().toISOString(), by: login(), kind: 'moved', text: note } : undefined }),
      deleteCard: (id) => {
        change({ type: 'card.delete', id })
        toast('Deleted.', { action: { label: 'Undo', run: () => void putBack('card', id) } })
      },
      putBack,
      moveCard: (id, stage) => {
        const state = now()
        const card = state.cards.find((c) => c.id === id)
        const fields = card && handMove(card, stage)
        if (!card || !fields) return
        const held = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
        const keep = 'agentId' in fields === false
        const names: Record<Card['stage'], string> = { proposed: 'Proposed', ready: 'Ready', working: 'Agents working', blocked: 'Blocked', review: 'In review', live: 'Done' }
        const holder = state.agents.find((a) => a.id === card.agentId)?.name ?? 'the agent'
        // Done, the diff of its worktree is of no more use to anyone.
        change({ type: 'card.update', id, fields: stage === 'live' && card.worktree ? { ...fields, worktree: undefined } : fields, activity: { at: new Date().toISOString(), by: login(), kind: 'moved', text: held && !keep ? `Took it back from ${holder}: ${names[stage]}` : `Moved it to ${names[stage]}` } })
      },
      giveCard: (id, agentId) => {
        const state = now()
        const card = state.cards.find((c) => c.id === id)
        if (!card) return
        const by = login()
        const who = agentId ? (state.agents.find((a) => a.id === agentId)?.name ?? 'an agent') : 'any agent'
        const at = new Date().toISOString()
        const held = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
        if ((held && card.agentId !== agentId) || card.stage === 'live' || card.stage === 'proposed') {
          change({ type: 'card.update', id, fields: { meantFor: agentId || undefined, stage: 'ready', agentId: undefined, needsYou: undefined, doing: undefined, progress: undefined }, activity: { at, by, kind: 'moved', text: `Gave it to ${who}` } })
        } else {
          change({ type: 'card.update', id, fields: { meantFor: agentId || undefined }, activity: { at, by, kind: 'moved', text: agentId ? `Meant it for ${who}` : 'Opened it to any agent' } })
        }
      },
      comment: (cardId, text) => call('POST', `/api/cards/${cardId}/comment`, { text }),
      stopCard: (cardId) => call('POST', `/api/cards/${cardId}/stop`),
      sendBack: (cardId, text) => call('POST', `/api/cards/${cardId}/send-back`, { text }),
      answerPermission: (cardId, request, allow) => call('POST', `/api/cards/${cardId}/permission`, { request, allow }),
      splitCard: (id, parts) => call('POST', `/api/cards/${id}/split`, { parts }).then(() => undefined),
      debrief: (cardId, agentId) => call('POST', `/api/cards/${cardId}/debrief`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      challenge: (cardId, agentId) => call('POST', `/api/cards/${cardId}/challenge`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      replyToFindings: (cardId) => call('POST', `/api/cards/${cardId}/challenge/replies`),
      setDebrief: (setId, agentId) => call('POST', `/api/sets/${setId}/debrief`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      setChallenge: (setId, agentId) => call('POST', `/api/sets/${setId}/challenge`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      setReplies: (setId) => call('POST', `/api/sets/${setId}/challenge/replies`),
      finding: (cardId, findingId, action) => call('POST', `/api/cards/${cardId}/findings/${findingId}`, { action }),
      acceptProposal: (id) => call<Card>('POST', `/api/proposals/${id}/accept`),
      editFirst: async (id) => {
        const proposal = now().proposals.find((p) => p.id === id)
        if (proposal?.state !== 'new') throw new Error('That proposal was already accepted or dismissed.')
        // Off the board's Proposed column at once, so a second press can't make a second card; put back if the hub says no.
        change({ type: 'proposal.update', id, fields: { state: 'accepted' } })
        try {
          const made = await call<Card>('POST', '/api/cards', { binderId: proposal.binderId, title: proposal.title, brief: proposal.brief, doneWhen: proposal.doneWhen, size: proposal.size, meantFor: proposal.meantFor, noteId: proposal.noteId, quote: proposal.quote, stage: 'proposed' })
          // A hub that doesn't start it in Proposed has made it Ready: moved there at once, so an agent has hardly a moment to take it.
          const fields = made.stage === 'proposed' ? undefined : handMove(made, 'proposed')
          if (fields) change({ type: 'card.update', id: made.id, fields, activity: { at: new Date().toISOString(), by: login(), kind: 'moved', text: 'Moved it to Proposed' } })
          change({ type: 'proposal.update', id, fields: { cardId: made.id } })
          return made
        } catch (error) {
          change({ type: 'proposal.update', id, fields: { state: 'new' } })
          throw error
        }
      },
      dismissProposal: (id) => change({ type: 'proposal.update', id, fields: { state: 'dismissed' } }),
      restoreProposal: (id) => change({ type: 'proposal.update', id, fields: { state: 'new' } }),
      saveNotes: () => call<NotesSaved>('POST', '/api/notes/save'),
      distill: (noteId, agentId) => {
        const note = now().notes.find((n) => n.id === noteId)
        const title = note ? note.title : 'the note'
        return call<Card>('POST', '/api/cards', {
          binderId: note?.binderId,
          title: `Distill “${title}” into work items`,
          brief: `Read the note “${title}” (get_note with id ${noteId}) and propose its work items with propose_work_items: each with the note's exact words it came from, a brief, what done looks like, a size, and who it's meant for. Leave out what's already on the board. Then complete this card.`,
          doneWhen: 'The note’s work items are proposed, each quoting its words.',
          size: 'S',
          meantFor: agentId,
          noteId,
        })
      },
      sendForReview: (setId) => call('POST', `/api/sets/${setId}/review`),
      deleteSet: (setId) => call('DELETE', `/api/sets/${setId}`),
      approveSet: (setId) => call('POST', `/api/sets/${setId}/approve`),
      // An environment's id has a / and a # in it, so it goes in the path encoded.
      promote: (envId) => call('POST', `/api/environments/${encodeURIComponent(envId)}/promote`),
      addEnvironment: (environment) => call<Environment>('POST', '/api/environments', environment),
      changeEnvironment: (envId, fields) => call<Environment>('PUT', `/api/environments/${encodeURIComponent(envId)}`, fields),
      removeEnvironment: async (envId) => {
        await call('DELETE', `/api/environments/${encodeURIComponent(envId)}`)
      },
      lookForDeployments: (repo) => call<DeploymentLook>('POST', '/api/environments/look', repo ? { repo } : {}),
      createAgent: (agent) => call('POST', '/api/agents', agent),
      updateAgent: async (id, fields) => {
        await call('PATCH', `/api/agents/${id}`, fields)
      },
      newToken: async (id) => (await call<{ token: string }>('POST', `/api/agents/${id}/token`)).token,
      revokeAgent: async (id) => {
        await call('DELETE', `/api/agents/${id}`)
      },
      signInByName: async (login) => {
        await call('POST', '/auth/dev', { login })
        // Again from the top, for the page to find the Binder you're in.
        window.location.reload()
      },
      signOut: async () => {
        await call('POST', '/auth/logout')
        window.location.reload()
      },
      reconnect: async () => {
        if (await loadMe()) await hub.current?.start()
      },
    }
  }, [held, change, flush, loadMe, recent, asking])

  return (
    <LiveContext.Provider value={lives}>
      <HeldContext.Provider value={held}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </HeldContext.Provider>
    </LiveContext.Provider>
  )
}

/** The note's live Automerge document while it's open here, for its editor; undefined for a moment at first. */
export function useLiveNote(noteId: string) {
  const lives = useContext(LiveContext)
  const [live, setLive] = useState<LiveNote>()
  useEffect(() => {
    if (!lives) return
    const taken = lives.take(noteId)
    setLive(taken)
    return () => lives.release(taken)
  }, [lives, noteId])
  // Just after moving to another note, the last one's isn't this one's.
  return live?.noteId === noteId ? live : undefined
}

/** How many times a note's text is asked for, and how long between, before it's given up on. */
const textTries = 5
const textRetryMs = 400
/** How long a request for a note's text is shared with whoever asks next. */
const askedForMs = 15_000

/**
 * A note's text, for a screen that reads it. The state a browser holds has most notes without their text and says so
 * (`left`); one that's wanted is asked for from the hub and taken into the state, where the note then stays whole. `text`
 * is undefined until it's here, and never an empty string standing in for it. The hub may answer with a text that's
 * not the one the state's note is of (it changed meanwhile, or the live feed hasn't brought the change yet): it's asked
 * for again shortly, up to five times, and then `failed` is true until `again`. Nothing is asked while the hub can't be
 * reached, or for a note that has its text.
 */
export function useNoteText(noteId: string) {
  const actions = useActions()
  const note = useHub((state) => state.notes.find((n) => n.id === noteId), sameFields<Note>('id', 'text', 'left', 'editedAt'))
  const offline = useHub((state) => state.sync.connection === 'offline')
  const light = !!note?.left
  // Where it gave up: the note, and which round of asking. A try again starts another, and so does the hub coming back or
  // the note changing here: a page still loading its state gives up on a text newer than its notes, and asks again by
  // itself once they've arrived.
  const [gaveUp, setGaveUp] = useState<string>()
  const [tries, setTries] = useState(0)
  const round = `${noteId}:${tries}:${offline}:${light ? note?.editedAt ?? '' : ''}`
  useEffect(() => actions.noteOpened(noteId), [actions, noteId])
  useEffect(() => {
    if (!light || offline) return
    let gone = false
    let timer: number | undefined
    const run = (attempt: number) => {
      actions.askForText(noteId).then(
        (answer) => {
          if (gone) return
          // Taken, or it has its text by now (another screen asked too).
          if (actions.holdNote(noteId, answer.text, answer.editedAt) || !actions.current().notes.find((n) => n.id === noteId)?.left) return
          retry(attempt)
        },
        (error: { status?: number }) => {
          if (gone) return
          // The hub saying there's no such note, or that it isn't ours to read, doesn't change by asking again.
          if (error?.status === 404 || error?.status === 401 || error?.status === 403) setGaveUp(round)
          else retry(attempt)
        },
      )
    }
    const retry = (attempt: number) => {
      if (attempt >= textTries) setGaveUp(round)
      else timer = window.setTimeout(() => run(attempt + 1), textRetryMs)
    }
    run(1)
    return () => {
      gone = true
      window.clearTimeout(timer)
    }
  }, [actions, noteId, light, offline, round])
  const again = useCallback(() => setTries((n) => n + 1), [])
  return { text: note ? textOf(note) : undefined, failed: light && gaveUp === round, again }
}

/** No notes: what a search that hasn't answered gives, the same each time. */
const noIds: ReadonlySet<string> = new Set()

/**
 * The notes with these words in their text, as the hub finds them (the browser holds most notes without it). Asked for
 * when typing has paused, for two characters or more; an answer to words no longer typed is ignored. Nothing is asked
 * while the hub can't be reached: the notes this tab has are all there is to search then.
 */
export function useNoteSearch(words: string): ReadonlySet<string> {
  const asked = words.trim()
  const offline = useHub((state) => state.sync.connection === 'offline')
  const [found, setFound] = useState<{ words: string; ids: ReadonlySet<string> }>()
  useEffect(() => {
    if (asked.length < 2 || offline) return
    let current = true
    const timer = window.setTimeout(() => {
      void call<{ ids?: string[] }>('GET', `/api/notes/search?q=${encodeURIComponent(asked)}`).then(
        (answer) => { if (current) setFound({ words: asked, ids: new Set(answer.ids ?? []) }) },
        () => { if (current) setFound(undefined) },
      )
    }, 200)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [asked, offline])
  return found && found.words === asked && asked.length >= 2 && !offline ? found.ids : noIds
}

function useHeld() {
  const held = useContext(HeldContext)
  if (!held) throw new Error('useHub outside StoreProvider')
  return held
}

/** Two lists with the same items in the same order: for a selection that makes a new list each time. */
export const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, index) => Object.is(item, b[index]))

/** Two objects alike in these fields, for a selection that only cares about those. */
export const sameFields = <T extends object>(...fields: (keyof T)[]) => (a: T | undefined, b: T | undefined) => a === b || (!!a && !!b && fields.every((field) => Object.is(a[field], b[field])))

/** Two objects with the same values, each compared as is: for a selection that gathers several things. */
export const sameValues = <T extends object>(a: T, b: T) => {
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]))
}

/**
 * A part of the state: this component draws again only when what `select` gives changes, by `same`. A selection that
 * makes something new each time (a filtered list, an object) needs a `same` that looks inside it, or it draws every time.
 */
export function useHub<T>(select: (state: State) => T, same: (a: T, b: T) => boolean = Object.is): T {
  const held = useHeld()
  const kept = useRef<{ value: T }>(undefined)
  const read = useMemo(() => {
    let seen: State | undefined
    let value: T
    return () => {
      const state = held.get()
      if (state === seen) return value
      const next = select(state)
      const before = seen === undefined ? kept.current : { value }
      seen = state
      value = before && same(before.value, next) ? before.value : next
      return value
    }
  }, [held, select, same])
  const value = useSyncExternalStore(held.subscribe, read)
  useEffect(() => {
    kept.current = { value }
  }, [value])
  return value
}

export function useActions() {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useActions outside StoreProvider')
  return actions
}

/**
 * A card's whole activity. The state holds only its recent lines and says how many it left out (`activityMore`); when
 * there are some, the rest are asked for as the card opens and put in front, and what the state gets live meanwhile
 * after them. Until they're here, or if they don't come, it's what the state has.
 */
export function useCardHistory(card: Card | undefined) {
  const id = card?.id
  const left = (card?.activityMore ?? 0) > 0
  const [got, setGot] = useState<{ id: string; activity: Activity[] }>()
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!id || !left) return
    let gone = false
    setFailed(false)
    call<{ activity: Activity[] }>('GET', `/api/cards/${encodeURIComponent(id)}/activity`).then(
      ({ activity }) => {
        if (!gone) setGot({ id, activity })
      },
      () => {
        if (!gone) setFailed(true)
      },
    )
    return () => {
      gone = true
    }
  }, [id, left, tries])
  const whole = got && got.id === id ? got.activity : undefined
  const held = card?.activity
  const activity = useMemo(() => (held && whole ? withHistory(held, whole) : held ?? []), [held, whole])
  const again = useCallback(() => setTries((n) => n + 1), [])
  return { activity, failed: failed && !whole, again }
}

/**
 * A Challenge's blast radius symbols. The state a browser holds has a blast's counts and not its symbols, so when they're
 * wanted (the list is open) and were left out, they're asked for from the card's or change set's own address. A copy is
 * kept only while the blast is the one it was asked for: a new one on the live feed is asked for again.
 */
export function useBlastSymbols(of: { kind: 'card' | 'set'; id: string }, blast: BlastRadius, wanted: boolean) {
  const left = wanted && blast.symbolCount !== undefined && blast.symbols.length === 0
  const { kind, id } = of
  const at = blast.at
  const [got, setGot] = useState<{ kind: string; id: string; at: string; symbols: BlastSymbol[] }>()
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!left) return
    let gone = false
    setFailed(false)
    call<{ blast?: BlastRadius }>('GET', `/api/${kind === 'card' ? 'cards' : 'sets'}/${encodeURIComponent(id)}/blast`).then(
      (answer) => {
        if (!gone) setGot({ kind, id, at, symbols: answer.blast?.symbols ?? [] })
      },
      () => {
        if (!gone) setFailed(true)
      },
    )
    return () => {
      gone = true
    }
  }, [left, kind, id, at, tries])
  const fresh = got && got.kind === kind && got.id === id && got.at === at ? got.symbols : undefined
  const again = useCallback(() => setTries((n) => n + 1), [])
  return { symbols: left ? fresh ?? blast.symbols : blast.symbols, loading: left && !fresh && !failed, failed: left && !fresh && failed, again }
}

const everything = (state: State) => state

/** All of it, and the actions: this draws on every change in the state. */
export function useStore(): Store {
  const state = useHub(everything)
  const actions = useActions()
  return useMemo(() => ({ ...actions, state, connection: state.sync.connection }), [actions, state])
}

/**
 * An agent, a person (by GitHub login) or the hub, as a name to show: a person by their GitHub profile's name, or their
 * login without a known enterprise shortcode. Their login stays who they are; only what's shown changes.
 */
export function nameFor(state: Pick<HubState, 'agents'> & { me?: Pick<Me, 'people' | 'emu'> }, by: string) {
  return state.agents.find((a) => a.id === by)?.name ?? (by === 'hub' ? 'Binders' : shownName(by, state.me?.people, state.me?.emu))
}

/** The hub's presence as the store last heard it, for the checks below. */
let presenceNow: Record<string, Presence> = {}

/** Listening: a runner (or an agent) is waiting for work right now. */
export const isListening = (agent: Agent) => !!presenceNow[agent.id]?.listening

/** How many runners the hub heard from lately for this agent: more than one take the same work. */
export const runnersOf = (agent: Agent) => presenceNow[agent.id]?.runners ?? 0
export const runnerPlaces = (agent: Agent) => presenceNow[agent.id]?.runnersOn ?? []

/** Online: listening, or heard from in the last two minutes. */
export const isOnline = (agent: Agent) => {
  const presence = presenceNow[agent.id]
  if (presence) return presence.listening || Date.now() - Date.parse(presence.at) < 120_000
  return !!agent.lastSeen && Date.now() - Date.parse(agent.lastSeen) < 120_000
}

const clockEveryMs = 30_000
const clockListeners = new Set<() => void>()
let clockTimer: number | undefined
let clockTicks = 0

function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  clockTimer ??= window.setInterval(() => {
    clockTicks++
    for (const tell of clockListeners) tell()
  }, clockEveryMs)
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size) return
    window.clearInterval(clockTimer)
    clockTimer = undefined
  }
}

/**
 * Draws again every half a minute, for what the time alone changes: "5m ago", an agent gone quiet. Nothing in the state
 * changes when those do, so without this they'd stay as they were until something else did.
 */
export const useClock = () => useSyncExternalStore(subscribeClock, () => clockTicks)

/** For a component that asks `isOnline` and the like: it draws when they could answer differently. */
export function usePresence() {
  useHub((state) => state.presence)
  useClock()
}
