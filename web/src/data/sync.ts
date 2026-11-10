import type { TerminalInfo } from '../../../shared/terminal.ts'
import { applyChange as apply, type Change, type Entry, type HubState, type Outgoing } from '../../../shared/state.ts'
import { forWire, isOld, leftCard, type Activity, type Card, type Presence } from '../../../shared/work.ts'
import { lightNote, type Note } from '../../../shared/notes.ts'
import { firstEvent } from './first'
import { heardEvent } from './listen'
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
export const keys = { cache: `binders-hub-cache-v6:${space}`, outbox: `binders-hub-outbox-v3:${space}`, client: 'binders-hub-client' }
const cachePrefix = 'binders-hub-cache-'
/** Each Binder's cache from before old cards' detail was left out of it (v5), notes' texts were (v4) and diffs' lines were (v3): all in the way of what replaces them. */
const oldCaches = [`${cachePrefix}v3:`, `${cachePrefix}v4:`, `${cachePrefix}v5:`]
/** How many notes keep their text in the copy kept for next time: the ones opened last. */
export const keptTexts = 20
/** How many old cards keep their detail in the copy kept for next time: the ones opened last. */
export const keptCards = 20

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

/**
 * Whether the hub has answered this tab at least once: its state is in hand (a copy kept here from last time counts), or
 * its live feed is open. Until then an empty list means nothing has arrived yet, not that there's nothing.
 */
export const heard = (sync: Sync) => sync.version > 0 || sync.connection === 'live'

/** Each tab's waiting changes are its own, so two tabs never write over each other's. */
const outboxKey = `${keys.outbox}:${clientId}`

export function startingSync(seed: HubState): Sync {
  try {
    for (const key of Object.keys(window.localStorage)) if (oldCaches.some((old) => key.startsWith(old))) window.localStorage.removeItem(key)
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
 * The texts of the notes in `keep` (the last ones opened, at most 20) go with it, and of those with changes waiting, and
 * every other note is written without its text, as the hub sends it: what's held in memory is as it was. The same goes for
 * an old card's detail: the cards in `keepCards` (the last ones opened, at most 20) and those with changes waiting keep
 * it, and every other old card is written as the hub sends it, without. Every Binder at this address shares the browser's
 * room for it. When there's none left, the one you're in gets it.
 */
export function rememberCache(sync: Sync, keep: readonly string[] = [], keepCards: readonly string[] = [], now = Date.now()) {
  try {
    // A note with changes waiting keeps its text as well: offline, it's the only place its words can be read.
    const kept = new Set([...keep.slice(0, keptTexts), ...sync.pending.flatMap(({ change }) => noteOf(change) ?? [])])
    const notes = sync.confirmed.notes.map((n) => (n.left || kept.has(n.id) ? n : lightNote(n)))
    // A card with changes waiting keeps its detail too: offline, it's the only place its words can be read.
    const cardsKept = new Set([...keepCards.slice(0, keptCards), ...sync.pending.flatMap(({ change }) => cardOf(change) ?? [])])
    const cards = sync.confirmed.cards.map((c) => (c.left || cardsKept.has(c.id) || !isOld(c, now) ? c : leftCard(c)))
    const confirmed = notes.some((n, index) => n !== sync.confirmed.notes[index]) || cards.some((c, index) => c !== sync.confirmed.cards[index]) ? { ...sync.confirmed, notes, cards } : sync.confirmed
    const text = JSON.stringify({ version: sync.version, confirmed })
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

export function remember(sync: Sync, keep: readonly string[] = [], keepCards: readonly string[] = []) {
  rememberCache(sync, keep, keepCards)
  rememberOutbox(sync)
}

const noteOf = (change: Change) => (change.type === 'note.put' ? change.note.id : 'id' in change && change.type.startsWith('note.') ? change.id : undefined)
const cardOf = (change: Change) => (change.type === 'card.put' ? change.card.id : 'id' in change && change.type.startsWith('card.') ? change.id : undefined)

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

/** A line of a card's activity as it's told apart from the others: it has no id of its own. */
const lineKey = (a: Activity) => `${a.at}|${a.by}|${a.kind}|${a.tool ?? ''}|${a.text}`

/**
 * A card's whole activity, from the hub when the card was opened, with what this tab holds of it: lines that came live
 * since are added at the end, and the ones in both are shown once. A line that happens twice, the same words at the same
 * moment, is shown as often as it is in the whole.
 */
export function withHistory(held: Activity[], whole: Activity[]): Activity[] {
  const left = new Map<string, number>()
  for (const line of whole) left.set(lineKey(line), (left.get(lineKey(line)) ?? 0) + 1)
  const later: Activity[] = []
  for (const line of held) {
    const key = lineKey(line)
    const count = left.get(key) ?? 0
    if (count > 0) left.set(key, count - 1)
    else later.push(line)
  }
  return later.length ? [...whole, ...later] : whole
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

/**
 * A note's text, as the hub sent it, taken into this tab: the note stops being one without its text. Only when it's the
 * note's text as of now (the hub's `editedAt` is the confirmed note's), as the note may have changed since it was asked
 * for, and only for a note that doesn't have its text yet. Anything else gives the same `sync` back.
 */
export function hold(sync: Sync, noteId: string, text: string, editedAt: string): Sync {
  const index = sync.confirmed.notes.findIndex((n) => n.id === noteId)
  const note = sync.confirmed.notes[index]
  if (!note?.left || note.editedAt !== editedAt) return sync
  const { left: _left, ...whole } = note
  const notes = sync.confirmed.notes.slice()
  notes[index] = { ...whole, text }
  return { ...sync, confirmed: { ...sync.confirmed, notes } }
}

/**
 * A card's detail, as the hub sent it (the card as the hub has it), taken into this tab: the card stops being one without
 * its detail. Only when it's the card as of now (the hub's `updatedAt` is the confirmed card's), as the card may have
 * changed since it was asked for, and only for a card that doesn't have its detail yet. Anything else gives the same
 * `sync` back.
 */
export function holdCard(sync: Sync, card: Card): Sync {
  if (card.left) return sync
  const index = sync.confirmed.cards.findIndex((c) => c.id === card.id)
  const held = sync.confirmed.cards[index]
  if (!held?.left || held.updatedAt !== card.updatedAt) return sync
  const cards = sync.confirmed.cards.slice()
  cards[index] = card
  return { ...sync, confirmed: { ...sync.confirmed, cards } }
}

/** A card the hub sends without its detail, with the detail this tab holds of the same version of it: all else is the hub's. */
function withDetail(sent: Card, had: Card): Card {
  const { left: _left, ...rest } = sent
  const { plan, worktree, debrief, challenge, permission } = had
  return { ...rest, brief: had.brief, doneWhen: had.doneWhen, activity: had.activity, activityMore: had.activityMore, plan, worktree, debrief, challenge, permission }
}

/**
 * Everything the hub has, as of a version: what you were waiting on stays on top. A note this tab holds the text of keeps
 * it when the hub's copy is the same version of it (the same `editedAt`), as is one this tab made and the hub hasn't
 * confirmed yet; any other comes without its text, to be asked for when it's opened. A card this tab holds the detail of
 * keeps it when the hub's copy is the same version of it (the same `updatedAt`); any other comes without it.
 */
export function snapshot(sync: Sync, version: number, state: HubState): Sync {
  if (state.cards.some((c) => c.left)) {
    const before = new Map(sync.confirmed.cards.map((c) => [c.id, c]))
    let changed = false
    const cards = state.cards.map((c) => {
      if (!c.left) return c
      const had = before.get(c.id)
      if (!had || had.left || had.updatedAt !== c.updatedAt) return c
      changed = true
      return withDetail(c, had)
    })
    if (changed) state = { ...state, cards }
  }
  if (!state.notes.some((n) => n.left)) return { ...sync, confirmed: state, version }
  const before = new Map(sync.confirmed.notes.map((n) => [n.id, n]))
  const made = new Map<string, Note>()
  for (const { change } of sync.pending) if (change.type === 'note.put') made.set(change.note.id, change.note)
  let changed = false
  const notes = state.notes.map((n) => {
    if (!n.left) return n
    const had = before.get(n.id)
    const ours = made.get(n.id)
    const text = had && !had.left && had.editedAt === n.editedAt ? had.text : ours && !ours.left && ours.editedAt === n.editedAt ? ours.text : undefined
    if (text === undefined) return n
    changed = true
    const { left: _left, ...whole } = n
    return { ...whole, text }
  })
  return { ...sync, confirmed: changed ? { ...state, notes } : state, version }
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
      // The hub's log doesn't go back to where this page is: the state is asked for whole, and the feed opened again from it.
      if (message.type === 'behind') {
        if (this.socket === socket) {
          this.socket = undefined
          this.following = false
          socket.close()
          void this.start()
        }
        return
      }
      if (message.type === 'terminals' && message.agentId) this.onTerminals?.(message.agentId, { online: !!message.online, sessions: message.sessions ?? [] })
      if (message.type === 'entries' && message.entries) this.onEntries(message.entries)
      if (message.type === 'presence' && message.presence) this.onPresence(message.presence)
      // Something came in through a listener, or was taken back: whatever shows it asks again.
      if (message.type === 'heard') window.dispatchEvent(new Event(heardEvent))
      // The Brain has a draft ready for a card that waits on someone: the list of waiting cards asks again.
      if (message.type === 'first') window.dispatchEvent(new Event(firstEvent))
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
