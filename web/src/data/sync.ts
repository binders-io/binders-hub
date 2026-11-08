import type { TerminalInfo } from '../../../shared/terminal.ts'
import { applyChange as apply, type Change, type Entry, type HubState, type Outgoing } from '../../../shared/state.ts'
import { forWire, type Presence } from '../../../shared/work.ts'
import type { Note } from '../../../shared/notes.ts'
import { space, spaceHeaders } from './space'

// Notes as this browser holds them: what the hub has confirmed, and this browser's own changes on top, waiting to be
// confirmed. What you see is always the confirmed notes with your waiting changes applied again on top, so a teammate's
// change arriving first never loses yours. The waiting changes are kept in the browser, so an edit made offline goes
// to the hub when it's back.

export type Connection = 'connecting' | 'live' | 'offline' | 'signed-out'

export interface Sync {
  confirmed: HubState
  version: number
  pending: Outgoing[]
  /** Notes edited here whose commit hasn't come back yet. */
  unsaved: string[]
  connection: Connection
}

// Bumped when what's kept changes shape, so an older browser cache is left behind, not read wrong. Each Binder's own.
export const keys = { cache: `binders-hub-cache-v4:${space}`, outbox: `binders-hub-outbox-v3:${space}`, client: 'binders-hub-client' }
const cachePrefix = 'binders-hub-cache-'
/** Each Binder's cache from before diffs' lines were left out of it: all in the way of what replaces them. */
const oldCaches = `${cachePrefix}v3:`

function read<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private windows and blocked storage: this tab still works, it just doesn't remember.
  }
}

/** This tab's name to the hub, so its resends are recognised. Each tab has its own, kept across reloads. */
export const clientId: string = (() => {
  try {
    const known = window.sessionStorage.getItem(keys.client)
    if (known) return known
  } catch {
    // No session storage: a new name each load.
  }
  const made = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    window.sessionStorage.setItem(keys.client, made)
  } catch {
    // As above.
  }
  return made
})()

/** Each tab's waiting changes are its own, so two tabs never write over each other's. */
const outboxKey = `${keys.outbox}:${clientId}`

export function startingSync(seed: HubState): Sync {
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(oldCaches)) window.localStorage.removeItem(key)
  } catch {
    // Blocked storage: nothing to clear.
  }
  let cache = read<{ version: number; confirmed: HubState }>(keys.cache)
  // Anything that doesn't look like notes as they are now is dropped: the hub has them anyway.
  if (!Array.isArray(cache?.confirmed?.notes) || !Array.isArray(cache?.confirmed?.cards) || !cache.confirmed.notes.every((n) => typeof n?.text === 'string')) cache = undefined
  return {
    confirmed: cache?.confirmed ?? seed,
    version: cache?.version ?? 0,
    pending: read<Outgoing[]>(outboxKey) ?? [],
    unsaved: [],
    connection: 'connecting',
  }
}

/** What's waiting for the hub: written at once, as it's the only copy. */
export const rememberOutbox = (sync: Sync) => write(outboxKey, sync.pending)

/**
 * The hub's state, to start from next time: all of it, so it's written now and then. The hub has it if this is behind.
 * Every Binder at this address shares the browser's room for it. When there's none left, the one you're in gets it.
 */
export function rememberCache(sync: Sync) {
  try {
    const text = JSON.stringify({ version: sync.version, confirmed: sync.confirmed })
    try {
      window.localStorage.setItem(keys.cache, text)
    } catch {
      for (const key of Object.keys(window.localStorage)) if (key.startsWith(cachePrefix) && key !== keys.cache) window.localStorage.removeItem(key)
      window.localStorage.setItem(keys.cache, text)
    }
  } catch {
    // Private windows, blocked storage, or more than a browser keeps: this tab still works, and starts from the hub next time.
  }
}

export function remember(sync: Sync) {
  rememberCache(sync)
  rememberOutbox(sync)
}

const noteOf = (change: Change) => (change.type === 'note.put' ? change.note.id : 'id' in change && change.type.startsWith('note.') ? change.id : undefined)

/** A note with its marks, the same object each time for the same note and marks: this runs on every change. */
const marked = new WeakMap<Note, { saving: boolean; committing: boolean; note: Note }>()
function mark(note: Note, saving: boolean, committing: boolean) {
  const known = marked.get(note)
  if (known?.saving === saving && known.committing === committing) return known.note
  const made = { ...note, saving, committing }
  marked.set(note, { saving, committing, note: made })
  return made
}

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((item, index) => item === b[index])

/**
 * The notes you see: the hub's, with your waiting changes on top. What didn't change stays the same object, here and
 * from `before` (what was shown last), so a screen can tell that it needn't draw again.
 */
export function shown(sync: Sync, before?: HubState): HubState {
  const state = sync.pending.reduce((acc, { change }) => apply(acc, change), sync.confirmed)
  const sending = new Set(sync.pending.map(({ change }) => noteOf(change)).filter((id): id is string => !!id))
  const committing = new Set(sync.unsaved.filter((id) => !sending.has(id)))
  const notes = state.notes.map((n) => (sending.has(n.id) || committing.has(n.id) || n.saving || n.committing ? mark(n, sending.has(n.id), committing.has(n.id)) : n))
  if (before && sameList(notes, before.notes)) return before.notes === state.notes ? state : { ...state, notes: before.notes }
  return sameList(notes, state.notes) ? state : { ...state, notes }
}

let made = 0
export const changeId = () => `${Date.now().toString(36)}-${(++made).toString(36)}`

/**
 * Your change, waiting for the hub. Typing into the same note joins a waiting edit that hasn't gone yet: Automerge
 * changes go on after the ones it has, and the whole text (before the note's document is here) replaces it.
 */
export function queue(sync: Sync, change: Change, sent: Set<string>): Sync {
  // Kept and sent as JSON, so a field cleared with undefined goes as null.
  change = forWire(change)
  const last = sync.pending[sync.pending.length - 1]
  const note = noteOf(change)
  const unsaved = note && !sync.unsaved.includes(note) ? [...sync.unsaved, note] : sync.unsaved
  if (change.type === 'note.edit' && last && !sent.has(last.id) && last.change.type === 'note.edit' && last.change.id === change.id && !last.change.changes === !change.changes) {
    const joined = change.changes ? { ...change, changes: [...last.change.changes!, ...change.changes] } : change
    return { ...sync, unsaved, pending: [...sync.pending.slice(0, -1), { id: last.id, change: joined }] }
  }
  return { ...sync, unsaved, pending: [...sync.pending, { id: changeId(), change }] }
}

/** The hub's changes, in order: each is now confirmed, and yours stop waiting. */
export function receive(sync: Sync, entries: Entry[], sent: Set<string>): Sync {
  let next = sync
  for (const entry of entries) {
    if (entry.version <= next.version) continue
    // The hub names a tab's changes user:login:tab.
    const mine = entry.client.endsWith(`:${clientId}`)
    if (mine) sent.delete(entry.id)
    const pending = mine ? next.pending.filter((p) => p.id !== entry.id) : next.pending
    let unsaved = next.unsaved
    if (entry.change.type === 'note.saved') {
      const id = entry.change.id
      if (!pending.some((p) => noteOf(p.change) === id)) unsaved = unsaved.filter((u) => u !== id)
    }
    let confirmed = next.confirmed
    try {
      confirmed = apply(confirmed, entry.change)
    } catch {
      // The hub skips what can't be applied, and so does this: the rest of the feed still has to arrive.
    }
    next = { ...next, confirmed, version: entry.version, pending, unsaved }
  }
  return next
}

/** Everything the hub has, as of a version: what you were waiting on stays on top. */
export function snapshot(sync: Sync, version: number, state: HubState): Sync {
  return { ...sync, confirmed: state, version }
}

/** Changes the hub already had (a resend after a reload): nothing to wait for. */
export function settled(sync: Sync, ids: string[]): Sync {
  return { ...sync, pending: sync.pending.filter((p) => !ids.includes(p.id)) }
}

/**
 * The connection: the state once, then the live feed from that version, and back again after a drop. Changes go out
 * with `send`, which says whether the hub took them.
 */
export class HubConnection {
  private socket?: WebSocket
  private stopped = false
  private retry = 1000
  /** This page has the hub's state and has been following it: coming back, it needs only what it missed. */
  private following = false
  private onSnapshot: (version: number, state: HubState) => void
  private onEntries: (entries: Entry[]) => void
  private onPresence: (presence: Record<string, Presence>) => void
  private onStatus: (connection: Connection) => void
  private onTerminals?: (agentId: string, open: AgentTerminals) => void
  private version: () => number

  constructor(handlers: {
    snapshot: (version: number, state: HubState) => void
    entries: (entries: Entry[]) => void
    status: (connection: Connection) => void
    version: () => number
    presence: (presence: Record<string, Presence>) => void
    terminals?: (agentId: string, open: AgentTerminals) => void
  }) {
    this.onTerminals = handlers.terminals
    this.onSnapshot = handlers.snapshot
    this.onEntries = handlers.entries
    this.onPresence = handlers.presence
    this.onStatus = handlers.status
    this.version = handlers.version
  }

  async start() {
    if (this.stopped) return
    this.onStatus('connecting')
    try {
      // Without diffs' lines, which a screen asks for when they're opened (see Diffs).
      const response = await fetch(`/api/state?light=1&have=${this.version()}${this.following ? '&replay=1' : ''}`, { headers: { accept: 'application/json', ...spaceHeaders } })
      if (response.status === 401) {
        this.onStatus('signed-out')
        return
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error(`hub answered ${response.status}`)
      const body = (await response.json()) as { version: number; state?: HubState; presence?: Record<string, Presence> }
      if (body.presence) this.onPresence(body.presence)
      // A hub whose log was cleared starts over: take what it has. No state means this is current, or the feed will make it so.
      if (body.state && body.version !== this.version()) this.onSnapshot(body.version, body.state)
      this.following = true
      this.open()
    } catch {
      this.again()
    }
  }

  private open() {
    const url = new URL(`/api/live?since=${this.version()}&light=1${space ? `&space=${space}` : ''}`, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      this.retry = 1000
      this.onStatus('live')
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; entries?: Entry[]; presence?: Record<string, Presence>; agentId?: string; online?: boolean; sessions?: TerminalInfo[] }
      if (message.type === 'terminals' && message.agentId) this.onTerminals?.(message.agentId, { online: !!message.online, sessions: message.sessions ?? [] })
      if (message.type === 'entries' && message.entries) this.onEntries(message.entries)
      if (message.type === 'presence' && message.presence) this.onPresence(message.presence)
    }
    socket.onclose = () => {
      if (this.socket === socket) this.again()
    }
  }

  private again() {
    if (this.stopped) return
    this.onStatus('offline')
    window.setTimeout(() => void this.start(), this.retry)
    this.retry = Math.min(this.retry * 2, 15_000)
  }

  get live() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Sends changes in order. Resolves with each one's version (0 when the hub already had it), or throws. */
  async send(changes: Outgoing[]) {
    const response = await fetch('/api/changes', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-binders': '1', ...spaceHeaders }, body: JSON.stringify({ client: clientId, changes }) })
    if (!response.ok) {
      // Why, as the hub said it, for the person to read.
      const said = await response.json().then((b: { error?: string }) => b.error, () => undefined)
      throw Object.assign(new Error(said ?? `hub answered ${response.status}`), { status: response.status, said })
    }
    return ((await response.json()) as { versions: number[] }).versions
  }

  stop() {
    this.stopped = true
    this.socket?.close()
  }
}

/** An agent's terminals, for its owner: whether its runner is linked, and those open on its machine. */
export interface AgentTerminals {
  online: boolean
  sessions: TerminalInfo[]
}
