import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyState, type Change, type Entry, type HubState } from '../../shared/state.ts'
import { lightNote } from '../../shared/notes.ts'
import { leftCard, type Card } from '../../shared/work.ts'
import { clientId, heard, HubConnection, hold, holdCard, keys, queue, receive, remember, rememberCache, rememberOutbox, settled, shown, snapshot, startingSync, type Sync } from '../src/data/sync'

// What the rest of the web app stands on: your changes stay on top of what the hub confirmed, whatever arrives and in
// whatever order, and what's waiting survives a reload.

const note = (id: string, text = 'words') => ({ id, title: id, binderId: 'b1', editedAt: 'then', editors: ['you'], text })
const hubState = (over: Partial<HubState> = {}): HubState => ({ ...emptyState(), notes: [note('n1')], ...over })
const start = (over: Partial<Sync> = {}): Sync => ({ confirmed: hubState(), version: 1, pending: [], unsaved: [], connection: 'live', ...over })
const edit = (id: string, text: string, changes?: string[]): Change => ({ type: 'note.edit', id, text, title: id, by: 'you', at: 'now', ...(changes ? { changes } : {}) })
const entry = (version: number, change: Change, client = 'user:sam:other-tab', id = `e${version}`): Entry => ({ version, id, client, at: 'now', change })

beforeEach(() => window.localStorage.clear())

describe('your changes waiting', () => {
  it('shows them at once, on top of what the hub confirmed', () => {
    const sync = queue(start(), edit('n1', 'mine'), new Set())
    expect(shown(sync).notes[0].text).toBe('mine')
    expect(sync.confirmed.notes[0].text).toBe('words')
    expect(shown(sync).notes[0].saving).toBe(true)
  })

  it('joins typing into a waiting edit that hasn’t gone yet, one edit in order', () => {
    const sent = new Set<string>()
    const sync = queue(queue(start(), edit('n1', 'a', ['c1']), sent), edit('n1', 'ab', ['c2']), sent)
    expect(sync.pending).toHaveLength(1)
    expect(sync.pending[0].change).toMatchObject({ text: 'ab', changes: ['c1', 'c2'] })
  })

  it('starts a new edit once the last one has been sent, so nothing already on its way changes', () => {
    const first = queue(start(), edit('n1', 'a', ['c1']), new Set())
    const sync = queue(first, edit('n1', 'ab', ['c2']), new Set([first.pending[0].id]))
    expect(sync.pending.map((p) => p.change)).toMatchObject([{ changes: ['c1'] }, { changes: ['c2'] }])
  })

  it('doesn’t join whole text to Automerge changes', () => {
    const sent = new Set<string>()
    const sync = queue(queue(start(), edit('n1', 'a', ['c1']), sent), edit('n1', 'ab'), sent)
    expect(sync.pending).toHaveLength(2)
  })

  it('sends a cleared field as null, or it would be lost in JSON', () => {
    const sync = queue(start(), { type: 'card.update', id: 'c', fields: { agentId: undefined, stage: 'ready' } }, new Set())
    expect(JSON.parse(JSON.stringify(sync.pending[0].change)).fields).toEqual({ agentId: null, stage: 'ready' })
  })
})

describe('what the hub sends', () => {
  it('confirms your own change and stops it waiting', () => {
    const sync = queue(start(), edit('n1', 'mine'), new Set())
    const { id } = sync.pending[0]
    const sent = new Set([id])
    const next = receive(sync, [entry(2, edit('n1', 'mine'), `user:you:${clientId}`, id)], sent)
    expect(next.pending).toEqual([])
    expect(next.confirmed.notes[0].text).toBe('mine')
    expect(next.version).toBe(2)
    expect(sent.size).toBe(0)
  })

  it('never loses what’s waiting to a teammate’s change arriving first', () => {
    const sync = queue(start(), { type: 'note.move', id: 'n1', binderId: 'b2' }, new Set())
    const next = receive(sync, [entry(2, edit('n1', 'theirs'))], new Set())
    expect(next.pending).toHaveLength(1)
    expect(shown(next).notes[0]).toMatchObject({ text: 'theirs', binderId: 'b2' })
  })

  it('ignores what it has already heard', () => {
    const next = receive(start({ version: 5 }), [entry(5, edit('n1', 'old'))], new Set())
    expect(next.confirmed.notes[0].text).toBe('words')
  })

  it('reads past an entry it can’t apply: the rest of the feed still arrives', () => {
    const bad = entry(2, { type: 'note.put' } as unknown as Change)
    const next = receive(start(), [bad, entry(3, edit('n1', 'after'))], new Set())
    expect(next.version).toBe(3)
    expect(next.confirmed.notes[0].text).toBe('after')
  })

  it('keeps a note marked unsaved until its commit comes back, unless more is waiting on it', () => {
    const sync = start({ unsaved: ['n1'] })
    const saved = entry(2, { type: 'note.saved', id: 'n1', commit: 'abc', path: 'a.md' })
    expect(receive(sync, [saved], new Set()).unsaved).toEqual([])
    const typing = queue(sync, edit('n1', 'more'), new Set())
    expect(receive(typing, [saved], new Set()).unsaved).toEqual(['n1'])
  })

  it('keeps what’s waiting on top of a snapshot, after the feed was missed', () => {
    const sync = queue(start(), edit('n1', 'mine'), new Set())
    const next = snapshot(sync, 9, hubState({ notes: [note('n1', 'hub’s'), note('n2')] }))
    expect(next.version).toBe(9)
    expect(shown(next).notes.map((n) => n.text)).toEqual(['mine', 'words'])
  })

  it('stops waiting on a change the hub already had', () => {
    const sync = queue(start(), edit('n1', 'mine'), new Set())
    expect(settled(sync, [sync.pending[0].id]).pending).toEqual([])
  })
})

describe('the connection', () => {
  class Socket {
    static made: Socket[] = []
    static OPEN = 1
    readyState = 1
    url: string
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    onclose?: () => void
    constructor(url: URL) {
      this.url = String(url)
      Socket.made.push(this)
      queueMicrotask(() => this.onopen?.())
    }
    close() { this.readyState = 3 }
  }

  const hub = (version: number, status = 200) => vi.fn(async () => new Response(JSON.stringify({ version, state: hubState(), presence: {} }), { status, headers: { 'content-type': 'application/json' } }))

  function connect(handlers: Partial<ConstructorParameters<typeof HubConnection>[0]> = {}, at = () => 1) {
    const heard = { status: [] as string[], snapshots: [] as number[], entries: [] as Entry[][] }
    const connection = new HubConnection({
      snapshot: (version) => heard.snapshots.push(version),
      entries: (entries) => heard.entries.push(entries),
      status: (status) => heard.status.push(status),
      version: at,
      presence: () => {},
      ...handlers,
    })
    return { connection, heard }
  }

  beforeEach(() => {
    Socket.made = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', Socket)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens the feed from the version it has, so only what it missed comes', async () => {
    vi.stubGlobal('fetch', hub(7))
    const { connection, heard } = connect({}, () => 7)
    await connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(Socket.made[0].url).toContain('since=7')
    expect(heard.status).toEqual(['connecting', 'live'])
    expect(heard.snapshots).toEqual([])
  })

  it('takes the hub’s state when its log isn’t the one it knows', async () => {
    vi.stubGlobal('fetch', hub(3))
    const { connection, heard } = connect({}, () => 7)
    await connection.start()
    expect(heard.snapshots).toEqual([3])
  })

  it('comes back after a drop, waiting longer each time, to a limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { connection } = connect()
    await connection.start()
    const fetched = () => vi.mocked(fetch).mock.calls.length
    expect(fetched()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetched()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetched()).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetched()).toBe(3)
    await vi.advanceTimersByTimeAsync(4000 + 8000 + 15_000)
    expect(fetched()).toBe(6)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fetched()).toBe(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetched()).toBe(7)
    connection.stop()
  })

  it('starts counting from the beginning again once it’s back', async () => {
    vi.stubGlobal('fetch', hub(1))
    const { connection, heard } = connect()
    await connection.start()
    await vi.advanceTimersByTimeAsync(0)
    Socket.made[0].onclose?.()
    expect(heard.status.at(-1)).toBe('offline')
    await vi.advanceTimersByTimeAsync(1000)
    expect(Socket.made).toHaveLength(2)
    expect(heard.status.at(-1)).toBe('live')
    connection.stop()
  })

  it('stops when you’re signed out, rather than asking forever', async () => {
    vi.stubGlobal('fetch', hub(1, 401))
    const { connection, heard } = connect()
    await connection.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard.status.at(-1)).toBe('signed-out')
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
  })

  it('ignores an old socket closing once a new one is open', async () => {
    vi.stubGlobal('fetch', hub(1))
    const { connection, heard } = connect()
    await connection.start()
    await vi.advanceTimersByTimeAsync(0)
    const old = Socket.made[0]
    old.onclose?.()
    await vi.advanceTimersByTimeAsync(1000)
    const count = heard.status.length
    old.onclose?.()
    expect(heard.status).toHaveLength(count)
    connection.stop()
  })
})

describe('what stays the same', () => {
  const card = (id: string) => ({ id, binderId: 'b1', title: id, brief: '', doneWhen: '', size: 'M' as const, stage: 'ready' as const, createdAt: 'then', createdBy: 'you', updatedAt: 'then', waitsFor: [], activity: [] })

  it('keeps the notes list itself when nothing in it changed, or every screen showing notes draws again', () => {
    const sync = start()
    expect(shown(sync).notes).toBe(sync.confirmed.notes)
    const before = shown(sync)
    expect(shown(receive(sync, [entry(2, { type: 'card.put', card: card('c') })], new Set()), before).notes).toBe(before.notes)
  })

  it('keeps the list while a note waits for its commit and other things change', () => {
    const sync = start({ unsaved: ['n1'] })
    const before = shown(sync)
    expect(before.notes[0].committing).toBe(true)
    const next = receive(sync, [entry(2, { type: 'card.put', card: card('c') })], new Set())
    expect(shown(next, before).notes).toBe(before.notes)
  })

  it('keeps each note that didn’t change, so only the one being typed in draws again', () => {
    const sync = start({ confirmed: hubState({ notes: [note('n1'), note('n2')] }) })
    const after = shown(queue(sync, edit('n1', 'typing'), new Set()), shown(sync))
    expect(after.notes[1]).toBe(sync.confirmed.notes[1])
    expect(after.notes[0].text).toBe('typing')
  })

  it('leaves the other lists alone when a note changes', () => {
    const sync = start({ confirmed: hubState({ cards: [card('c')] }) })
    expect(shown(queue(sync, edit('n1', 'typing'), new Set())).cards).toBe(sync.confirmed.cards)
  })
})

describe('what’s kept in the browser', () => {
  it('writes waiting changes and the cache apart, as only the changes can’t wait', () => {
    const sync = queue(start(), edit('n1', 'offline'), new Set())
    rememberOutbox(sync)
    expect(window.localStorage.getItem(keys.cache)).toBeNull()
    expect(startingSync(emptyState()).pending).toHaveLength(1)
    rememberCache(sync)
    expect(JSON.parse(window.localStorage.getItem(keys.cache)!).version).toBe(1)
  })

  it('clears each Binder’s cache of the old shape, leaving waiting changes alone', () => {
    window.localStorage.setItem('binders-hub-cache-v3:other', '{}')
    window.localStorage.setItem('binders-hub-outbox-v3:other:tab', '[]')
    startingSync(emptyState())
    expect(window.localStorage.getItem('binders-hub-cache-v3:other')).toBeNull()
    expect(window.localStorage.getItem('binders-hub-outbox-v3:other:tab')).toBe('[]')
  })

  it('gives the Binder you’re in the room when there’s none left, at the cost of other Binders’ caches and nothing else', () => {
    const storage = window.localStorage
    const set = storage.setItem.bind(storage)
    storage.setItem('binders-hub-cache-v4:other', 'x'.repeat(10))
    storage.setItem('binders-hub-outbox-v3:other:tab', '[]')
    // A browser with room only once the other Binder's cache has gone.
    const full = vi.spyOn(Object.getPrototypeOf(storage) as Storage, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (storage.getItem('binders-hub-cache-v4:other') !== null) throw new DOMException('Full', 'QuotaExceededError')
      set(key, value)
    })
    rememberCache(start({ version: 12 }))
    full.mockRestore()
    expect(JSON.parse(storage.getItem(keys.cache)!).version).toBe(12)
    expect(storage.getItem('binders-hub-cache-v4:other')).toBeNull()
    expect(storage.getItem('binders-hub-outbox-v3:other:tab')).toBe('[]')
  })

  it('carries on when even that isn’t enough', () => {
    const full = vi.spyOn(Object.getPrototypeOf(window.localStorage) as Storage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    expect(() => rememberCache(start())).not.toThrow()
    full.mockRestore()
  })

  it('brings back waiting changes and the last state after a reload', () => {
    remember(queue(start({ version: 7 }), edit('n1', 'offline'), new Set()))
    const back = startingSync(emptyState())
    expect(back.version).toBe(7)
    expect(back.pending).toHaveLength(1)
    expect(shown(back).notes[0].text).toBe('offline')
    expect(back.connection).toBe('connecting')
  })

  it('leaves a cache that doesn’t look right behind: the hub has it anyway', () => {
    window.localStorage.setItem(keys.cache, JSON.stringify({ version: 9, confirmed: { notes: [{ id: 'x' }], cards: [] } }))
    const seed = hubState()
    const back = startingSync(seed)
    expect(back.confirmed).toBe(seed)
    expect(back.version).toBe(0)
  })
})

describe('whether the hub has answered yet', () => {
  it('is no until its state or a copy kept from last time is here, or its live feed is open', () => {
    expect(heard(start({ version: 0, connection: 'connecting' }))).toBe(false)
    expect(heard(start({ version: 0, connection: 'offline' }))).toBe(false)
    expect(heard(start({ version: 4, connection: 'connecting' }))).toBe(true)
    expect(heard(start({ version: 0, connection: 'live' }))).toBe(true)
  })
})

// A note a browser holds without its text has `left` and an empty `text`: the hub's light state. Its text is asked for
// when the note is opened, and taken in here (`hold`) only if it's the text of the note as the state has it.
describe('a note’s text taken in', () => {
  const light = (id: string, text = 'words', editedAt = 'then') => lightNote({ ...note(id, text), editedAt })
  const lightSync = (over: Partial<Sync> = {}) => start({ confirmed: hubState({ notes: [light('n1'), light('n2', 'other')] }), ...over })

  it('takes the text of a note that has none, and the note stops standing in for it', () => {
    const sync = lightSync()
    const held = hold(sync, 'n1', 'words', 'then')
    expect(held).not.toBe(sync)
    expect(held.confirmed.notes[0]).toMatchObject({ id: 'n1', text: 'words' })
    expect(held.confirmed.notes[0].left).toBeUndefined()
    expect(held.confirmed.notes[1]).toBe(sync.confirmed.notes[1])
    expect(sync.confirmed.notes[0].left).toBeDefined()
  })

  it('refuses a text of another version of the note: it changed meanwhile, or the feed is behind', () => {
    const sync = lightSync()
    expect(hold(sync, 'n1', 'newer words', 'later')).toBe(sync)
  })

  it('refuses a note that is whole already, and one that isn’t there', () => {
    const sync = start()
    expect(hold(sync, 'n1', 'something else', 'then')).toBe(sync)
    expect(sync.confirmed.notes[0].text).toBe('words')
    expect(hold(lightSync(), 'missing', 'words', 'then').confirmed.notes).toHaveLength(2)
  })

  it('shows the held text, with a change waiting on top of it', () => {
    const held = hold(lightSync(), 'n1', 'words', 'then')
    expect(shown(queue(held, edit('n1', 'mine'), new Set())).notes[0].text).toBe('mine')
  })

  it('keeps a light note light through the live feed, and a whole one whole', () => {
    const sync = hold(lightSync(), 'n1', 'words', 'then')
    const next = receive(sync, [entry(2, edit('n1', 'both')), entry(3, edit('n2', 'also'))], new Set())
    expect(next.confirmed.notes[0]).toMatchObject({ text: 'both' })
    expect(next.confirmed.notes[0].left).toBeUndefined()
    expect(next.confirmed.notes[1]).toMatchObject({ text: '', left: { size: 4 } })
  })

  it('keeps a text this tab holds through a snapshot of the same version of the note, and takes the rest as they come', () => {
    const sync = hold(lightSync(), 'n1', 'words', 'then')
    const next = snapshot(sync, 5, hubState({ notes: [light('n1'), light('n2', 'other'), light('n3')] }))
    expect(next.version).toBe(5)
    expect(next.confirmed.notes[0]).toMatchObject({ id: 'n1', text: 'words' })
    expect(next.confirmed.notes[0].left).toBeUndefined()
    expect(next.confirmed.notes[1]).toMatchObject({ text: '', left: { size: 5 } })
    expect(next.confirmed.notes[2].left).toBeDefined()
  })

  it('doesn’t keep a text through a snapshot of a note that was written since', () => {
    const sync = hold(lightSync(), 'n1', 'words', 'then')
    const next = snapshot(sync, 5, hubState({ notes: [light('n1', 'rewritten', 'later')] }))
    expect(next.confirmed.notes[0]).toMatchObject({ text: '', left: { size: 9 } })
  })

  it('keeps a note this tab made and the hub hasn’t confirmed whole when the snapshot has it', () => {
    const made = { ...note('n9', '# new'), editedAt: 'just now' }
    const sync = queue(lightSync(), { type: 'note.put', note: made }, new Set())
    const next = snapshot(sync, 5, hubState({ notes: [lightNote(made)] }))
    expect(next.confirmed.notes[0]).toMatchObject({ id: 'n9', text: '# new' })
    expect(next.confirmed.notes[0].left).toBeUndefined()
    expect(shown(next).notes[0].left).toBeUndefined()
  })

  it('hands a snapshot with no light notes over as it is', () => {
    const state = hubState()
    expect(snapshot(start(), 5, state).confirmed).toBe(state)
  })
})

describe('what a note’s text costs the copy kept for next time', () => {
  const stored = () => JSON.parse(window.localStorage.getItem(keys.cache)!).confirmed.notes as { id: string; text: string; left?: { size: number } }[]
  const many = (count: number) => start({ confirmed: hubState({ notes: Array.from({ length: count }, (_, index) => note(`n${index}`, `words ${index}`)) }) })

  it('is the text of the last 20 notes opened, and the rest without theirs', () => {
    const sync = many(30)
    rememberCache(sync, Array.from({ length: 25 }, (_, index) => `n${index}`))
    const notes = stored()
    expect(notes.filter((n) => !n.left)).toHaveLength(20)
    expect(notes.filter((n) => !n.left).map((n) => n.id)).toEqual(Array.from({ length: 20 }, (_, index) => `n${index}`))
    expect(notes[25]).toMatchObject({ id: 'n25', text: '', left: { size: 'words 25'.length } })
  })

  it('leaves what’s in memory as it was', () => {
    const sync = many(3)
    const before = JSON.stringify(sync.confirmed)
    rememberCache(sync, [])
    expect(JSON.stringify(sync.confirmed)).toBe(before)
    expect(stored().every((n) => n.left && n.text === '')).toBe(true)
  })

  it('writes a note with changes waiting whole as well', () => {
    rememberCache(queue(many(3), edit('n1', 'typed'), new Set()), [])
    expect(stored().map((n) => !n.left)).toEqual([false, true, false])
  })

  it('writes a note light that it was given light, and doesn’t write every note again when none has a text to leave out', () => {
    const sync = start({ confirmed: hubState({ notes: [lightNote(note('n1'))] }) })
    rememberCache(sync, ['n1'])
    expect(stored()[0]).toMatchObject({ id: 'n1', text: '', left: { size: 5 } })
  })

  it('is read back after a reload: the light notes and the ones kept', () => {
    rememberCache(many(3), ['n2'])
    const back = startingSync(emptyState())
    expect(back.confirmed.notes.map((n) => !n.left)).toEqual([false, false, true])
    expect(back.version).toBe(1)
  })

  it('leaves the caches of older shapes behind', () => {
    window.localStorage.setItem('binders-hub-cache-v3:x', '{}')
    window.localStorage.setItem('binders-hub-cache-v4:x', '{}')
    window.localStorage.setItem('binders-hub-cache-v5:x', '{}')
    startingSync(emptyState())
    expect(window.localStorage.getItem('binders-hub-cache-v3:x')).toBeNull()
    expect(window.localStorage.getItem('binders-hub-cache-v4:x')).toBeNull()
    expect(window.localStorage.getItem('binders-hub-cache-v5:x')).toBeNull()
    expect(keys.cache).toContain('cache-v6:')
  })
})

// A card that finished a while ago is held without its detail (shared/work.ts leftCard): its brief, done-when, plan, debrief,
// Challenge and activity are asked for when it's opened.

const longAgo = '2026-10-01T00:00:00.000Z'
const rightNow = Date.parse('2026-11-09T12:00:00.000Z')
const wholeCard = (id: string, over: Partial<Card> = {}): Card => ({
  id, binderId: 'b1', title: id, brief: `brief of ${id}`, doneWhen: `done when ${id}`, size: 'M', stage: 'live', createdAt: longAgo, createdBy: 'you', updatedAt: longAgo, waitsFor: [],
  plan: [{ text: 'step', done: true }], debrief: { state: 'done', askedBy: 'you', askedAt: longAgo, agentId: 'a1' } as Card['debrief'],
  activity: [{ at: longAgo, by: 'you', kind: 'comment', text: `said on ${id}` }], ...over,
})
const heldCards = (...cards: Card[]) => start({ confirmed: hubState({ notes: [], cards: cards.map((c) => leftCard(c)) }) })

describe('taking in a card’s detail', () => {
  it('takes the card as the hub has it when it’s the same version of the card, and nothing else changes', () => {
    const sync = heldCards(wholeCard('c1'), wholeCard('c2'))
    const next = holdCard(sync, wholeCard('c1'))
    expect(next.confirmed.cards[0]).toMatchObject({ id: 'c1', brief: 'brief of c1', doneWhen: 'done when c1', plan: [{ text: 'step', done: true }] })
    expect(next.confirmed.cards[0].left).toBeUndefined()
    expect(next.confirmed.cards[0].activity).toHaveLength(1)
    expect(next.confirmed.cards[1]).toBe(sync.confirmed.cards[1])
  })

  it('refuses a card of another version: it changed meanwhile, or the feed is behind', () => {
    const sync = heldCards(wholeCard('c1'))
    expect(holdCard(sync, wholeCard('c1', { updatedAt: '2026-11-01T00:00:00.000Z' }))).toBe(sync)
    expect(sync.confirmed.cards[0].brief).toBe('')
  })

  it('refuses a card that is whole already, one that isn’t there, and one that is itself held without its detail', () => {
    const whole = start({ confirmed: hubState({ notes: [], cards: [wholeCard('c1')] }) })
    expect(holdCard(whole, wholeCard('c1', { brief: 'something else' }))).toBe(whole)
    const sync = heldCards(wholeCard('c1'))
    expect(holdCard(sync, wholeCard('missing'))).toBe(sync)
    expect(holdCard(sync, leftCard(wholeCard('c1')))).toBe(sync)
  })

  it('shows the held card with a change waiting on top of it, and keeps it held through the live feed', () => {
    const held = holdCard(heldCards(wholeCard('c1')), wholeCard('c1'))
    const moved = queue(held, { type: 'card.update', id: 'c1', fields: { stage: 'ready' }, activity: { at: 'now', by: 'you', kind: 'moved', text: 'Moved it to Ready' } }, new Set())
    expect(shown(moved).cards[0]).toMatchObject({ stage: 'ready', brief: 'brief of c1' })
    const next = receive(held, [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })], new Set())
    expect(next.confirmed.cards[0]).toMatchObject({ doing: 'Reading', brief: 'brief of c1' })
    expect(next.confirmed.cards[0].left).toBeUndefined()
  })

  it('keeps a card held without its detail through the live feed, so a change never lands on it as if it had it', () => {
    const next = receive(heldCards(wholeCard('c1')), [entry(2, { type: 'card.update', id: 'c1', fields: { brief: 'new words' } })], new Set())
    expect(next.confirmed.cards[0]).toMatchObject({ brief: '', doneWhen: '' })
    expect(next.confirmed.cards[0].left).toBeDefined()
  })
})

describe('a snapshot, for a card whose detail this tab holds', () => {
  it('keeps the detail through a snapshot of the same version of the card, and takes the rest as it comes', () => {
    const sync = holdCard(heldCards(wholeCard('c1'), wholeCard('c2')), wholeCard('c1'))
    const next = snapshot(sync, 5, hubState({ notes: [], cards: [leftCard(wholeCard('c1', { title: 'Renamed' })), leftCard(wholeCard('c2')), leftCard(wholeCard('c3'))] }))
    expect(next.version).toBe(5)
    expect(next.confirmed.cards[0]).toMatchObject({ id: 'c1', title: 'Renamed', brief: 'brief of c1', doneWhen: 'done when c1', plan: [{ text: 'step', done: true }] })
    expect(next.confirmed.cards[0].left).toBeUndefined()
    expect(next.confirmed.cards[0].activity).toHaveLength(1)
    expect(next.confirmed.cards[0].debrief).toMatchObject({ state: 'done' })
    expect(next.confirmed.cards[1]).toMatchObject({ brief: '', left: { debrief: 'done' } })
    expect(next.confirmed.cards[2].left).toBeDefined()
  })

  it('doesn’t keep the detail through a snapshot of a card that changed since', () => {
    const sync = holdCard(heldCards(wholeCard('c1')), wholeCard('c1'))
    const next = snapshot(sync, 5, hubState({ notes: [], cards: [leftCard(wholeCard('c1', { updatedAt: '2026-11-02T00:00:00.000Z' }))] }))
    expect(next.confirmed.cards[0]).toMatchObject({ brief: '', doneWhen: '' })
    expect(next.confirmed.cards[0].left).toBeDefined()
  })

  it('takes a card that comes whole as it comes, and hands a snapshot with no held cards over as it is', () => {
    const state = hubState({ notes: [], cards: [wholeCard('c1', { stage: 'ready', updatedAt: 'now' })] })
    expect(snapshot(heldCards(wholeCard('c1')), 5, state).confirmed).toBe(state)
  })
})

describe('what an old card’s detail costs the copy kept for next time', () => {
  const stored = () => JSON.parse(window.localStorage.getItem(keys.cache)!).confirmed.cards as Card[]
  const many = (count: number, over: Partial<Card> = {}) => start({ confirmed: hubState({ notes: [], cards: Array.from({ length: count }, (_, index) => wholeCard(`c${index}`, over)) }) })

  it('is the detail of the last 20 old cards opened, and the rest without it', () => {
    rememberCache(many(30), [], Array.from({ length: 25 }, (_, index) => `c${index}`), rightNow)
    const cards = stored()
    expect(cards.filter((c) => !c.left).map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, index) => `c${index}`))
    expect(cards[25]).toMatchObject({ id: 'c25', brief: '', doneWhen: '', activity: [], activityMore: 1, left: { debrief: 'done' } })
    expect(cards[25].plan).toBeUndefined()
    expect(cards[25].debrief).toBeUndefined()
  })

  it('leaves what’s in memory as it was', () => {
    const sync = many(3)
    const before = JSON.stringify(sync.confirmed)
    rememberCache(sync, [], [], rightNow)
    expect(JSON.stringify(sync.confirmed)).toBe(before)
    expect(stored().every((c) => c.left && c.brief === '')).toBe(true)
  })

  it('writes a card with changes waiting whole as well', () => {
    const change: Change = { type: 'card.update', id: 'c1', fields: { size: 'L' } }
    rememberCache(queue(many(3), change, new Set()), [], [], rightNow)
    expect(stored().map((c) => !c.left)).toEqual([false, true, false])
  })

  it('writes a card that finished lately, or isn’t done, whole, as the hub sends it so', () => {
    const sync = start({ confirmed: hubState({ notes: [], cards: [wholeCard('lately', { updatedAt: '2026-11-08T00:00:00.000Z' }), wholeCard('working', { stage: 'working' }), wholeCard('asks', { needsYou: 'which?' })] }) })
    rememberCache(sync, [], [], rightNow)
    expect(stored().map((c) => !c.left)).toEqual([true, true, true])
  })

  it('writes a card it was given held as it is, and doesn’t write every card again when none has detail to leave out', () => {
    const sync = heldCards(wholeCard('c1'))
    rememberCache(sync, [], ['c1'], rightNow)
    expect(stored()[0]).toMatchObject({ id: 'c1', brief: '', left: { debrief: 'done' } })
  })

  it('is read back after a reload: the held cards and the ones kept', () => {
    rememberCache(many(3), [], ['c2'], rightNow)
    const back = startingSync(emptyState())
    expect(back.confirmed.cards.map((c) => !c.left)).toEqual([false, false, true])
    expect(back.confirmed.cards[2]).toMatchObject({ brief: 'brief of c2', plan: [{ text: 'step', done: true }] })
  })
})
