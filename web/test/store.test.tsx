// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, entry, hear, mount, standInHub } from './harness'
import { isOnline, useActions, useClock, useHub, useStore, type State } from '../src/data/store'
import { keys } from '../src/data/sync'

// The store as the app uses it: one component subscribing to one part of the hub's state, and what changes it.

let posted: ReturnType<typeof standInHub>['posted']

beforeEach(() => {
  ({ posted } = standInHub())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Renders({ name, select, counts }: { name: string; select: (state: State) => unknown; counts: Record<string, number> }) {
  const value = useHub(select)
  counts[name] = (counts[name] ?? 0) + 1
  return <p data-testid={name}>{JSON.stringify(value)}</p>
}

describe('subscribing to part of the state', () => {
  it('draws only what’s subscribed to the part that changed', async () => {
    const counts: Record<string, number> = {}
    const cards = (s: State) => s.cards
    const notes = (s: State) => s.notes
    const presence = (s: State) => s.presence
    await mount(<><Renders name="cards" select={cards} counts={counts} /><Renders name="notes" select={notes} counts={counts} /><Renders name="presence" select={presence} counts={counts} /></>)
    const base = { ...counts }

    await hear({ type: 'presence', presence: { a1: { at: new Date().toISOString(), listening: true } } })
    expect(counts.presence).toBe(base.presence + 1)
    expect(counts.cards).toBe(base.cards)
    expect(counts.notes).toBe(base.notes)

    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })] })
    expect(counts.cards).toBe(base.cards + 1)
    expect(counts.notes).toBe(base.notes)
    expect(screen.getByTestId('cards').textContent).toContain('Reading')
  })

  it('doesn’t draw for a change a selection comes out the same on', async () => {
    const counts: Record<string, number> = {}
    const ready = (s: State) => s.cards.filter((c) => c.stage === 'ready').length
    await mount(<><Renders name="ready-count" select={ready} counts={counts} /></>)
    const base = counts['ready-count']
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })] })
    expect(counts['ready-count']).toBe(base)
  })

  it('can compare a derived selection by its contents', async () => {
    const renders = { count: 0 }
    const sameIds = (a: string[], b: string[]) => a.join() === b.join()
    function Ids() {
      const ids = useHub((s) => s.cards.map((c) => c.id), sameIds)
      renders.count++
      return <p>{ids.join()}</p>
    }
    await mount(<><Ids /></>)
    const base = renders.count
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })] })
    expect(renders.count).toBe(base)
  })

  it('keeps useStore for whatever wants all of it', async () => {
    function All() {
      const { state, connection } = useStore()
      return <p data-testid="all">{connection}:{state.cards.length}</p>
    }
    await mount(<><All /></>)
    expect(screen.getByTestId('all').textContent).toBe('live:2')
  })
})

describe('actions', () => {
  it('are the same functions throughout, so what’s handed one needn’t draw again', async () => {
    const seen = new Set<unknown>()
    function Keeps() {
      seen.add(useActions())
      useHub((s) => s.cards)
      return null
    }
    await mount(<><Keeps /></>)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })] })
    expect(seen.size).toBe(1)
  })

  it('work from the state as it is now, not as it was when they were made', async () => {
    const actions: { move?: ReturnType<typeof useActions>['moveCard'] } = {}
    function Grab() {
      const { moveCard } = useActions()
      const once = useRef(moveCard)
      useEffect(() => { actions.move = once.current }, [])
      return null
    }
    await mount(<><Grab /></>)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.put', card: card('c3', 'blocked', { agentId: 'a1' }) })] })
    await act(async () => { actions.move!('c3', 'ready') })
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    const sent = posted.flatMap((p) => p.changes).find((c) => c.change.type === 'card.update')
    expect(sent?.change).toMatchObject({ id: 'c3', fields: { stage: 'ready', agentId: null } })
  })

  it('show at once, and go to the hub in order, with typing joined', async () => {
    function Editor() {
      const { editNote } = useActions()
      const text = useHub((s) => s.notes[0]?.text)
      return <><button onClick={() => { editNote('n1', 'a'); editNote('n1', 'ab') }}>type</button><p data-testid="text">{text}</p></>
    }
    await mount(<><Editor /></>)
    await act(async () => screen.getByText('type').click())
    expect(screen.getByTestId('text').textContent).toBe('ab')
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    expect(posted).toHaveLength(1)
    expect(posted[0].changes).toHaveLength(1)
    expect(posted[0].changes[0].change).toMatchObject({ type: 'note.edit', text: 'ab' })
  })
})

describe('agents coming and going', () => {
  const heardAt = (ago: number) => new Date(Date.now() - ago).toISOString()

  it('says who’s online from the presence the store last heard, with nothing rendering it', async () => {
    await mount(null)
    expect(isOnline(agent)).toBe(false)
    await hear({ type: 'presence', presence: { a1: { at: heardAt(0), listening: false } } })
    expect(isOnline(agent)).toBe(true)
  })

  it('draws again with the clock, so someone gone quiet stops showing as online', async () => {
    function Status() {
      useHub((s) => s.presence)
      useClock()
      return <p data-testid="status">{isOnline(agent) ? 'online' : 'offline'}</p>
    }
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    await mount(<><Status /></>)
    await hear({ type: 'presence', presence: { a1: { at: heardAt(0), listening: false } } })
    expect(screen.getByTestId('status').textContent).toBe('online')
    await act(async () => { vi.advanceTimersByTime(121_000) })
    expect(screen.getByTestId('status').textContent).toBe('offline')
  })
})

describe('what’s kept in the browser as changes arrive', () => {
  const outbox = () => Object.keys(window.localStorage).find((k) => k.startsWith(keys.outbox))

  it('keeps a waiting change the moment it’s made, and the hub’s state a little later', async () => {
    function Typer() {
      const { editNote } = useActions()
      return <button onClick={() => editNote('n1', 'offline')}>type</button>
    }
    await mount(<><Typer /></>)
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    window.localStorage.removeItem(keys.cache)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await act(async () => screen.getByText('type').click())
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(JSON.parse(window.localStorage.getItem(outbox()!)!)).toHaveLength(1)
    expect(window.localStorage.getItem(keys.cache)).toBeNull()
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })] })
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    expect(JSON.parse(window.localStorage.getItem(keys.cache)!).version).toBe(2)
  })

  it('doesn’t lose a keystroke to the page going, in the moment before it’s written', async () => {
    function Typer() {
      const { editNote } = useActions()
      return <button onClick={() => editNote('n1', 'last words')}>type</button>
    }
    await mount(<><Typer /></>)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await act(async () => screen.getByText('type').click())
    window.dispatchEvent(new Event('pagehide'))
    const kept = JSON.parse(window.localStorage.getItem(outbox()!)!) as { change: { text: string } }[]
    expect(kept[0].change.text).toBe('last words')
  })

  it('writes the state straight away when the page goes', async () => {
    await mount(null)
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    window.localStorage.removeItem(keys.cache)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' } })] })
    expect(window.localStorage.getItem(keys.cache)).toBeNull()
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(window.localStorage.getItem(keys.cache)!).version).toBe(2)
  })
})
