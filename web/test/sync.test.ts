import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyState, type Change, type Entry, type HubState } from '../../shared/state.ts'
import { clientId, HubConnection, keys, queue, receive, remember, rememberCache, rememberOutbox, settled, shown, snapshot, startingSync, type Sync } from '../src/data/sync'

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
