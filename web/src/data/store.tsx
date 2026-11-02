import { shownName } from '../../../shared/people.ts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { emptyState, type Change, type HubState } from '../../../shared/state.ts'
import { isBlank, titleOf } from '../../../shared/notes.ts'
import type { Agent, Card, Me, Note, Provider } from './model'
import type { Presence, RunnerSettings } from '../../../shared/work.ts'
import type { TestOutcome } from '../../../shared/changeSet.ts'
import { call } from './api'
import { askedReasoning } from '../components/Reasoning'
import { clientId, HubConnection, queue, receive, rememberCache, rememberOutbox, settled, shown, snapshot, startingSync, type AgentTerminals, type Connection, type Sync } from './sync'
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
}

type Step = (state: State) => State

const withShown = (s: State): State => ({ ...s, ...shown(s.sync, s) })

const starting = (): State => withShown({ ...emptyState(), sync: startingSync(emptyState()), presence: {}, terminals: {}, signedOut: false })

export const isEmpty = (note: Note) => isBlank(note.text)

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
  deleteNote: (noteId: string) => void
  clearChat: (chatId: string) => void
  /** An edit to a note: Automerge changes to its document, with its text after them; or the whole text, until the document is here. */
  editNote: (noteId: string, text: string, changes?: string[]) => void
  discardIfEmpty: (noteId: string) => void
  addBinder: (name: string, repo?: string) => string
  updateBinder: (id: string, fields: { name?: string; repo?: string; issues?: boolean; notes?: boolean; notesBranch?: string; reviewComments?: boolean }) => void
  deleteBinder: (id: string) => Promise<void>
  // Cards
  createCard: (card: NewCard) => Promise<Card>
  updateCard: (id: string, fields: Partial<Card>, note?: string) => void
  /** A person ran one of a debrief's functional tests (on a card or a change set, by its id): passed or failed, or cleared with null. */
  recordTest: (id: string, test: string, outcome: TestOutcome | null, note?: string) => void
  deleteCard: (id: string) => void
  /** Moves a card to a stage; anywhere but review or done takes it from its agent, with any question it asked. */
  moveCard: (id: string, stage: Card['stage']) => void
  /** Gives a card to an agent (or opens it to any): one held by another agent goes back on the board for it. */
  giveCard: (id: string, agentId: string) => void
  comment: (cardId: string, text: string) => Promise<void>
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
  acceptProposal: (id: string) => Promise<void>
  dismissProposal: (id: string) => void
  distill: (noteId: string, agentId?: string) => Promise<Card>
  /** Save all: the hub commits every note still waiting for typing to pause, and pushes each binder's notes to its repo. */
  saveNotes: () => Promise<NotesSaved>
  // Change sets and environments
  sendForReview: (setId: string) => Promise<void>
  deleteSet: (setId: string) => Promise<void>
  approveSet: (setId: string) => Promise<void>
  promote: (envId: string) => Promise<void>
  // Agents
  createAgent: (agent: NewAgent) => Promise<{ agent: Agent; token: string }>
  updateAgent: (id: string, fields: Partial<NewAgent>) => Promise<void>
  newToken: (id: string) => Promise<string>
  revokeAgent: (id: string) => Promise<void>
  // Signing in
  signInByName: (login: string) => Promise<void>
  signOut: () => Promise<void>
}

/** The state and the actions together: draws on every change, so not for what's on screen all the time. */
export interface Store extends Actions {
  state: State
  connection: Connection
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
          window.dispatchEvent(new CustomEvent('binders-refused', { detail: said ? `${said} It was undone here.` : 'The hub refused a change. It was undone here.' }))
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
      held.step((s) => ({ ...s, me, signedOut: false }))
      return true
    } catch {
      held.step((s) => ({ ...s, signedOut: true }))
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
      rememberCache(held.get().sync)
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
  }, [held])

  const actions = useMemo<Actions>(() => {
    const now = held.get
    const login = () => now().me?.user.login ?? 'you'
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
      deleteNote: (noteId) => change({ type: 'note.delete', id: noteId }),
      clearChat: (chatId) => change({ type: 'chat.clear', id: chatId }),
      editNote: (noteId, text, changes) => change({ type: 'note.edit', id: noteId, text, title: titleOf(text), by: login(), at: new Date().toISOString(), ...(changes ? { changes } : {}) }),
      discardIfEmpty: (noteId) => {
        const note = now().notes.find((n) => n.id === noteId)
        if (note && isEmpty(note)) change({ type: 'note.delete', id: noteId })
      },
      addBinder: (name, repo) => {
        const id = newId('binder')
        change({ type: 'binder.put', binder: { id, name: name.trim() || 'Notes', repo: repo?.trim() || undefined, createdBy: now().me?.user.login } })
        return id
      },
      updateBinder: (id, fields) => {
        const binder = now().binders.find((b) => b.id === id)
        if (binder) change({ type: 'binder.put', binder: { ...binder, name: fields.name?.trim() || binder.name, repo: fields.repo === undefined ? binder.repo : fields.repo.trim() || undefined, issues: fields.issues ?? binder.issues, notes: fields.notes ?? binder.notes, notesBranch: fields.notesBranch ?? binder.notesBranch, reviewComments: fields.reviewComments ?? binder.reviewComments } })
      },
      deleteBinder: async (id) => {
        // Sent at once, not queued, so a refusal (it isn't empty) shows here.
        await call('POST', '/api/changes', { client: 'binder-delete', changes: [{ id: newId('delete'), change: { type: 'binder.delete', id } }] })
      },
      createCard: (card) => call<Card>('POST', '/api/cards', card),
      recordTest: (id, test, outcome, note) => change({ type: 'test.result', id, test, result: outcome ? { outcome, ...(note?.trim() ? { note: note.trim() } : {}), by: login(), at: new Date().toISOString() } : null }),
      updateCard: (id, fields, note) => change({ type: 'card.update', id, fields, activity: note ? { at: new Date().toISOString(), by: login(), kind: 'moved', text: note } : undefined }),
      deleteCard: (id) => change({ type: 'card.delete', id }),
      moveCard: (id, stage) => {
        const state = now()
        const card = state.cards.find((c) => c.id === id)
        if (!card || card.stage === stage) return
        const held = (card.stage === 'working' || card.stage === 'blocked') && !!card.agentId
        // Only a card an agent holds, blocked, goes back to working: its agent carries on.
        if (stage === 'working' && !(card.stage === 'blocked' && card.agentId)) return
        // Blocked, working (again), review and done keep its agent; anywhere else takes it back.
        const keep = stage === 'review' || stage === 'live' || stage === 'blocked' || stage === 'working'
        const names: Record<Card['stage'], string> = { proposed: 'Proposed', ready: 'Ready', working: 'Agents working', blocked: 'Blocked', review: 'In review', live: 'Done' }
        const holder = state.agents.find((a) => a.id === card.agentId)?.name ?? 'the agent'
        change({ type: 'card.update', id, fields: { stage, needsYou: undefined, doing: undefined, ...(keep ? {} : { agentId: undefined, progress: undefined }) }, activity: { at: new Date().toISOString(), by: login(), kind: 'moved', text: held && !keep ? `Took it back from ${holder}: ${names[stage]}` : `Moved it to ${names[stage]}` } })
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
      debrief: (cardId, agentId) => call('POST', `/api/cards/${cardId}/debrief`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      challenge: (cardId, agentId) => call('POST', `/api/cards/${cardId}/challenge`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      replyToFindings: (cardId) => call('POST', `/api/cards/${cardId}/challenge/replies`),
      setDebrief: (setId, agentId) => call('POST', `/api/sets/${setId}/debrief`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      setChallenge: (setId, agentId) => call('POST', `/api/sets/${setId}/challenge`, { ...(agentId ? { agentId } : {}), ...askedReasoning() }),
      setReplies: (setId) => call('POST', `/api/sets/${setId}/challenge/replies`),
      finding: (cardId, findingId, action) => call('POST', `/api/cards/${cardId}/findings/${findingId}`, { action }),
      acceptProposal: (id) => call('POST', `/api/proposals/${id}/accept`),
      dismissProposal: (id) => change({ type: 'proposal.update', id, fields: { state: 'dismissed' } }),
      saveNotes: () => call<NotesSaved>('POST', '/api/notes/save'),
      distill: (noteId, agentId) => {
        const note = now().notes.find((n) => n.id === noteId)
        const title = note ? titleOf(note.text) : 'the note'
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
      promote: (envId) => call('POST', `/api/environments/${envId}/promote`),
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
    }
  }, [held, change])

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
