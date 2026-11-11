// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leftCard } from '../../shared/work.ts'
import { FakeSocket, calledOn, card, entry, hear, hubState, me, mount, settle, standInHub, standInRoute } from './harness'
import { StoreProvider, useActions, useCardWhole, useHub } from '../src/data/store'
import { keys } from '../src/data/sync'
import { guardCard } from '../src/data/cardDetail'
import type { Card, ChangeSet, PullRequest } from '../src/data/model'
import { Work } from '../src/screens/Work'
import { Flow } from '../src/screens/Flow'
import { ChangeSets } from '../src/screens/ChangeSets'
import { DebriefButton } from '../src/components/Debrief'
import { ChallengeButton } from '../src/components/Challenge'
import { Toast } from '../src/components/Toast'
import { UIContext } from '../src/ui'

// A browser holds a card that finished a while ago without its detail (its brief, done-when, plan, debrief, Challenge and
// activity): they're asked for when the card is opened. Until then nothing may treat the empty brief as the card's own:
// not the card's page, which lets a person edit it in place, and not the store, which would send what was typed.

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const then = days(20)
const whole = (id: string, over: Partial<Card> = {}): Card => card(id, 'live', {
  brief: `brief of ${id}`, doneWhen: `done when ${id}`, updatedAt: then, plan: [{ text: 'a step', done: true }],
  debrief: { state: 'done', askedBy: 'you', askedAt: then, agentId: 'a1' } as Card['debrief'],
  activity: [{ at: then, by: 'you', kind: 'comment', text: `said on ${id}` }], ...over,
})
const held = (id: string, over: Partial<Card> = {}) => leftCard(whole(id, over))
const lightHub = (...cards: Card[]) => () => hubState({ cards })

/** Has the stand-in hub answer a card's whole: what `answer` says (a body, a Response, or a promise of either), by the card and how many times it's asked. */
function standInWhole(answer: (id: string, time: number) => unknown) {
  const hub = globalThis.fetch
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const found = /^\/api\/cards\/([^/?]+)\/whole$/.exec(String(url))
    if (!found) return hub(url, init)
    const id = decodeURIComponent(found[1])
    asked.push(id)
    const sent = await answer(id, asked.filter((a) => a === id).length)
    return sent instanceof Response ? sent : new Response(JSON.stringify(sent), { headers: { 'content-type': 'application/json' } })
  }))
  return asked
}
const sends = (c: Card) => ({ card: c })
const refused = (status: number) => new Response(JSON.stringify({ error: 'No such card.' }), { status, headers: { 'content-type': 'application/json' } })
const sentCards = (posted: ReturnType<typeof standInHub>['posted']) => posted.flatMap((p) => p.changes).map((c) => c.change).filter((c) => c.type.startsWith('card.'))

let actions: ReturnType<typeof useActions>
function Grab() {
  actions = useActions()
  return null
}
function Probe({ id }: { id: string }) {
  const { card: got, failed, again } = useCardWhole(id)
  const left = useHub((state) => state.cards.find((c) => c.id === id)?.left)
  return <><p data-testid="brief">{got === undefined ? 'none' : `brief:${got.brief}`}</p><p data-testid="failed">{String(failed)}</p><p data-testid="left">{String(!!left)}</p><button onClick={again}>again</button></>
}
const probed = () => screen.getByTestId('brief').textContent

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const page = (id: string) => mount(<UIContext.Provider value={ui}><Grab /><Work id={id} /><Toast /></UIContext.Provider>)
const editable = () => document.querySelector('.editable')
const saysNoBrief = () => /No brief/.test(document.body.textContent ?? '')

let posted: ReturnType<typeof standInHub>['posted']
beforeEach(() => {
  window.location.hash = ''
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('asking for a card whole', () => {
  beforeEach(() => {
    ;({ posted } = standInHub(lightHub(held('c1'), held('c2'), whole('whole'), card('young', 'ready'))))
  })

  it('asks the hub, and holds what it says: the card is whole from then on', async () => {
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<><Grab /><Probe id="c1" /></>)
    await waitFor(() => expect(probed()).toBe('brief:brief of c1'))
    expect(asked).toEqual(['c1'])
    expect(screen.getByTestId('left').textContent).toBe('false')
    expect(actions.current().cards.find((c) => c.id === 'c1')).toMatchObject({ brief: 'brief of c1', plan: [{ text: 'a step', done: true }] })
    // Held here, never sent.
    await settle(400)
    expect(posted).toEqual([])
  })

  it('is no card at all until it’s here, never one with an empty brief', async () => {
    let answer: (body: unknown) => void = () => {}
    standInWhole(() => new Promise((done) => { answer = done }))
    await mount(<Probe id="c1" />)
    expect(probed()).toBe('none')
    await settle(100)
    expect(probed()).toBe('none')
    await act(async () => answer(sends(whole('c1'))))
    await waitFor(() => expect(probed()).toBe('brief:brief of c1'))
  })

  it('asks nothing for a card that has its detail', async () => {
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<><Probe id="whole" /><Probe id="young" /></>)
    await settle(100)
    expect(screen.getAllByTestId('brief').map((p) => p.textContent)).toEqual(['brief:brief of whole', 'brief:'])
    expect(asked).toEqual([])
  })

  it('asks for a card once however many screens want it', async () => {
    const asked = standInWhole(async (id) => { await new Promise((done) => setTimeout(done, 50)); return sends(whole(id)) })
    await mount(<><Probe id="c1" /><Probe id="c1" /></>)
    await waitFor(() => expect(screen.getAllByTestId('brief').map((p) => p.textContent)).toEqual(['brief:brief of c1', 'brief:brief of c1']))
    expect(asked).toHaveLength(1)
  })

  it('asks again when the card is of another version than the one here, and holds the one that matches', async () => {
    const asked = standInWhole((id, time) => sends(whole(id, time < 3 ? { updatedAt: days(1), brief: 'newer words' } : {})))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(probed()).toBe('brief:brief of c1'), { timeout: 10_000 })
    expect(asked).toHaveLength(3)
  })

  it('gives up after five tries, and tries again when asked to', async () => {
    const asked = standInWhole((id) => sends(whole(id, { updatedAt: days(1) })))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), { timeout: 10_000 })
    expect(asked).toHaveLength(5)
    expect(probed()).toBe('none')
    await settle(900)
    expect(asked).toHaveLength(5)
    fireEvent.click(screen.getByText('again'))
    await waitFor(() => expect(asked.length).toBeGreaterThan(5))
    expect(screen.getByTestId('failed').textContent).toBe('false')
  })

  it('asks again by itself once the card here has caught up with the one it gave up on', async () => {
    // The hub's card is a version this tab hasn't heard of yet: its state is behind.
    const later = days(1)
    const asked = standInWhole((id) => sends(whole(id, { updatedAt: later, brief: 'newer words' })))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), { timeout: 10_000 })
    expect(asked).toHaveLength(5)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { brief: 'newer words' }, activity: { at: later, by: 'sam', kind: 'comment', text: 'hi' } })] })
    await waitFor(() => expect(probed()).toBe('brief:newer words'), { timeout: 10_000 })
    expect(screen.getByTestId('failed').textContent).toBe('false')
    expect(screen.getByTestId('left').textContent).toBe('false')
  })

  it('fails at once when the hub has no such card', async () => {
    const asked = standInWhole(() => refused(404))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'))
    expect(asked).toHaveLength(1)
    expect(probed()).toBe('none')
  })

  it('doesn’t take an answer that isn’t the card, with its words, for an empty one', async () => {
    for (const body of [{}, { card: { id: 'c1' } }, sends(whole('c2')), sends(held('c1'))]) {
      const asked = standInWhole(() => body)
      await mount(<><Grab /><Probe id="c1" /></>)
      await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), { timeout: 10_000 })
      expect(asked).toHaveLength(5)
      expect(actions.current().cards.find((c) => c.id === 'c1')).toMatchObject({ brief: '', doneWhen: '' })
      expect(actions.current().cards.find((c) => c.id === 'c1')?.left).toBeDefined()
      cleanup()
      standInHub(lightHub(held('c1'), held('c2'), whole('whole'), card('young', 'ready')))
    }
  }, 30_000)

  it('stops when the screen goes', async () => {
    const asked = standInWhole((id) => sends(whole(id, { updatedAt: days(1) })))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(asked).toHaveLength(1))
    cleanup()
    await settle(1000)
    expect(asked).toHaveLength(1)
  })

  it('stops asking for a card when the screen moves to another', async () => {
    const asked = standInWhole((id) => sends(id === 'c2' ? whole('c2') : whole(id, { updatedAt: days(1) })))
    const { rerender } = render(<StoreProvider><Probe id="c1" /></StoreProvider>)
    await waitFor(() => expect(asked).toHaveLength(1))
    rerender(<StoreProvider><Probe id="c2" /></StoreProvider>)
    await settle(1000)
    expect(asked.filter((a) => a === 'c1').length).toBeLessThanOrEqual(2)
    expect(asked).toContain('c2')
  })

  it('asks for a reader’s card too, as it’s a read', async () => {
    standInHub(lightHub(held('c1')), { ...me, role: 'reader' })
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(probed()).toBe('brief:brief of c1'))
    expect(asked).toEqual(['c1'])
  })
})

describe('a card that is held without its detail, once it leaves Done', () => {
  beforeEach(() => {
    ;({ posted } = standInHub(lightHub(held('c1'), held('c2'))))
  })

  it('isn’t asked for while it’s Done: the board lists it from what’s here', async () => {
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<Grab />)
    await settle(300)
    expect(asked).toEqual([])
  })

  it('is asked for when the hub moves it, wherever it’s shown, and is whole a moment later', async () => {
    const at = days(0.5)
    const asked = standInWhole((id) => sends(whole(id, { stage: 'ready', updatedAt: at })))
    await mount(<Grab />)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { stage: 'ready' }, activity: { at, by: 'sam', kind: 'moved', text: 'Moved it to Ready' } })] })
    await waitFor(() => expect(actions.current().cards[0].left).toBeUndefined())
    expect(actions.current().cards[0]).toMatchObject({ stage: 'ready', brief: 'brief of c1' })
    expect(actions.current().cards[1].left).toBeDefined()
    expect(asked).toEqual(['c1'])
  })

  it('is asked for once, when the card’s page wants it as well', async () => {
    const at = days(0.5)
    // The hub answers once the move has been heard, however long the page took to draw: the page's asking and the
    // move's are then for the one answer still on its way.
    let answer = () => {}
    const heard = new Promise<void>((done) => { answer = done })
    const asked = standInWhole(async (id) => { await heard; return sends(whole(id, { stage: 'ready', updatedAt: at })) })
    await page('c1')
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { stage: 'ready' }, activity: { at, by: 'sam', kind: 'moved', text: 'Moved it to Ready' } })] })
    answer()
    await waitFor(() => expect(actions.current().cards[0].left).toBeUndefined())
    expect(asked).toHaveLength(1)
  })

  it('is moved from the board by a person, which still goes, and is whole a moment later with the move on top', async () => {
    // The hub answers before it has the move: the card it has is the one here.
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<Grab />)
    await act(async () => actions.moveCard('c1', 'ready'))
    await waitFor(() => expect(actions.current().cards[0].left).toBeUndefined())
    expect(actions.current().cards[0]).toMatchObject({ stage: 'ready', brief: 'brief of c1' })
    await settle(400)
    expect(sentCards(posted)).toMatchObject([{ type: 'card.update', id: 'c1', fields: { stage: 'ready' } }])
    expect(asked).toEqual(['c1'])
  })

  it('doesn’t keep asking for a card it gave up on, until the card changes or the hub is back', async () => {
    // The hub's card is a version this tab hasn't heard of.
    const hubs = days(0.1)
    const asked = standInWhole((id) => sends(whole(id, { stage: 'ready', updatedAt: hubs })))
    await mount(<Grab />)
    const at = days(0.5)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c1', fields: { stage: 'ready' }, activity: { at, by: 'sam', kind: 'moved', text: 'Moved it to Ready' } })] })
    await waitFor(() => expect(asked).toHaveLength(5), { timeout: 10_000 })
    await settle(1200)
    expect(asked).toHaveLength(5)
    // The card changes here: it's a new version to ask for.
    const later = hubs
    await hear({ type: 'entries', entries: [entry(3, { type: 'card.update', id: 'c1', fields: { doing: 'Reading' }, activity: { at: later, by: 'sam', kind: 'comment', text: 'hi' } })] })
    await waitFor(() => expect(actions.current().cards[0].left).toBeUndefined(), { timeout: 10_000 })
    expect(asked.length).toBeGreaterThan(5)
  }, 15_000)

  it('is not asked for while the hub can’t be reached, and is once it’s back', async () => {
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<Grab />)
    standInRoute('GET', '/api/state', () => { throw new TypeError('Failed to fetch') })
    await act(async () => { FakeSocket.open.at(-1)!.readyState = 3; FakeSocket.open.at(-1)!.onclose?.() })
    await waitFor(() => expect(actions.current().sync.connection).toBe('offline'))
    await act(async () => actions.moveCard('c1', 'ready'))
    await settle(400)
    expect(actions.current().cards[0]).toMatchObject({ stage: 'ready', brief: '' })
    expect(asked).toEqual([])
    standInRoute('GET', '/api/state', () => ({ version: 1, presence: {} }))
    await waitFor(() => expect(actions.current().cards[0].left).toBeUndefined(), { timeout: 10_000 })
    expect(asked).toEqual(['c1'])
  })
})

describe('guarding a card that isn’t loaded', () => {
  beforeEach(() => {
    ;({ posted } = standInHub(lightHub(held('c1'), whole('whole'))))
  })

  it('sends nothing when its brief or done-when is written, as what’s here of them is empty', async () => {
    await mount(<Grab />)
    await act(async () => actions.updateCard('c1', { brief: 'x' }, 'Changed the brief'))
    await act(async () => actions.updateCard('c1', { doneWhen: 'y' }, 'Changed the done-when'))
    await act(async () => actions.updateCard('c1', { brief: '', doneWhen: '' }))
    await settle(400)
    expect(sentCards(posted)).toEqual([])
    expect(actions.current().cards[0]).toMatchObject({ brief: '', doneWhen: '', left: { debrief: 'done' } })
  })

  it('sends its other fields, without the brief and done-when it was given with them', async () => {
    await mount(<Grab />)
    await act(async () => actions.updateCard('c1', { size: 'L', brief: 'x', doneWhen: 'y' }, 'Changed the size'))
    await act(async () => actions.updateCard('c1', { title: 'A new title' }, 'Changed the title'))
    await settle(400)
    expect(sentCards(posted)).toMatchObject([{ type: 'card.update', id: 'c1', fields: { size: 'L' } }, { type: 'card.update', id: 'c1', fields: { title: 'A new title' } }])
    expect(sentCards(posted).every((c) => c.type === 'card.update' && !('brief' in c.fields) && !('doneWhen' in c.fields))).toBe(true)
  })

  it('moves and gives it as it would any card', async () => {
    await mount(<Grab />)
    await act(async () => actions.giveCard('c1', 'a1'))
    await settle(400)
    expect(sentCards(posted)).toMatchObject([{ type: 'card.update', id: 'c1', fields: { stage: 'ready', meantFor: 'a1' } }])
  })

  it('sends a card that has its detail as it always did', async () => {
    await mount(<Grab />)
    await act(async () => actions.updateCard('whole', { brief: 'new words' }, 'Changed the brief'))
    await settle(400)
    expect(sentCards(posted)).toMatchObject([{ type: 'card.update', id: 'whole', fields: { brief: 'new words' } }])
  })

  it('never sends a card made over it', () => {
    const put = { type: 'card.put', card: whole('c1', { brief: 'typed over' }) } as const
    expect(guardCard(held('c1'), put)).toBeUndefined()
    expect(guardCard(whole('c1'), put)).toBe(put)
    expect(guardCard(undefined, put)).toBe(put)
    const other = { type: 'comment', id: 'c1' } as never
    expect(guardCard(held('c1'), other)).toBe(other)
  })
})

describe('a card’s page, while its detail is on its way', () => {
  it('shows its title and stage at once and nothing of its words, never an empty brief to read or change', async () => {
    standInHub(lightHub(held('c1', { title: 'An old card', stage: 'ready' })))
    let answer: (body: unknown) => void = () => {}
    standInWhole(() => new Promise((done) => { answer = done }))
    const seen: string[] = []
    const watch = new MutationObserver(() => { if (saysNoBrief() || editable()) seen.push(document.body.textContent ?? '') })
    watch.observe(document.body, { subtree: true, childList: true, characterData: true })
    await page('c1')
    expect(screen.getByRole('heading', { name: 'An old card' })).toBeTruthy()
    expect(document.querySelector('.stage-pill')?.textContent).toContain('Ready')
    expect(document.querySelector('.brief-card')).toBeNull()
    expect(editable()).toBeNull()
    expect(saysNoBrief()).toBe(false)
    // Nothing shown at first, so a quick card doesn't flash.
    expect(screen.queryByText('Loading…')).toBeNull()
    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy(), { timeout: 10_000 })
    expect(document.querySelector('.brief-card')).toBeNull()
    // At no moment until it's here.
    watch.disconnect()
    expect(seen).toEqual([])
    await act(async () => answer(sends(whole('c1', { title: 'An old card', stage: 'ready' }))))
    await waitFor(() => expect(editable()).not.toBeNull())
    expect(screen.getByText('brief of c1')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('is editable once the card is here, and what’s typed goes to the hub as the brief', async () => {
    ;({ posted } = standInHub(lightHub(held('c1', { stage: 'ready' }))))
    standInWhole((id) => sends(whole(id, { stage: 'ready' })))
    await page('c1')
    await waitFor(() => expect(editable()).not.toBeNull())
    fireEvent.click(screen.getAllByTitle('Edit the brief')[0])
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'a better brief' } })
    fireEvent.blur(screen.getByLabelText('Brief'))
    await settle(400)
    expect(sentCards(posted)).toMatchObject([{ type: 'card.update', id: 'c1', fields: { brief: 'a better brief' } }])
  })

  it('shows the brief of a card that is Done as words, with its debrief, once it’s here', async () => {
    standInHub(lightHub(held('c1')))
    standInWhole((id) => sends(whole(id)))
    await page('c1')
    expect(saysNoBrief()).toBe(false)
    await screen.findByText('brief of c1')
    expect(screen.getByText('done when c1')).toBeTruthy()
    expect(screen.getByLabelText('Debrief')).toBeTruthy()
    expect(editable()).toBeNull()
  })

  it('says so when the card couldn’t be loaded, and loads it when asked to try again', async () => {
    standInHub(lightHub(held('c1', { stage: 'ready' })))
    const asked = standInWhole((id, time) => (time === 1 ? refused(404) : sends(whole(id, { stage: 'ready' }))))
    await page('c1')
    await screen.findByText(/This card couldn’t be loaded/)
    expect(editable()).toBeNull()
    expect(saysNoBrief()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(editable()).not.toBeNull())
    expect(asked).toHaveLength(2)
  })

  it('says so when the card isn’t on this device and the hub can’t be reached', async () => {
    standInHub(lightHub(held('c1', { stage: 'ready' })))
    // What was kept from last time, and a hub that doesn't answer for its state.
    window.localStorage.setItem(keys.cache, JSON.stringify({ version: 3, confirmed: hubState({ cards: [held('c1', { stage: 'ready' })] }) }))
    const asked = standInWhole(() => { throw new TypeError('Failed to fetch') })
    const hub = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).split('?')[0] === '/api/state') throw new TypeError('Failed to fetch')
      return hub(url, init)
    }))
    render(<StoreProvider><UIContext.Provider value={ui}><Work id="c1" /></UIContext.Provider></StoreProvider>)
    await screen.findByText('This card isn’t on this device yet. It loads when you’re back online.')
    await settle(300)
    expect(editable()).toBeNull()
    expect(saysNoBrief()).toBe(false)
    expect(asked.length).toBeLessThanOrEqual(1)
  })

  it('is not editable at the moment a snapshot brings the card back without its detail, and loads it again', async () => {
    let state = hubState({ cards: [held('c1', { stage: 'ready' })] })
    standInHub(() => state)
    let times = 0
    standInWhole((id) => (++times === 1 ? sends(whole(id, { stage: 'ready' })) : new Promise(() => {})))
    await page('c1')
    await waitFor(() => expect(editable()).not.toBeNull())
    // The card was changed elsewhere while this tab was away: the hub's next snapshot has it without its detail again.
    state = hubState({ cards: [held('c1', { stage: 'ready', updatedAt: days(0.2), brief: 'rewritten' })] })
    standInRoute('GET', '/api/state', () => ({ version: 2, state, presence: {} }))
    await act(async () => { FakeSocket.open.at(-1)!.readyState = 3; FakeSocket.open.at(-1)!.onclose?.() })
    await waitFor(() => expect(actions.current().cards[0].left).toBeDefined(), { timeout: 10_000 })
    expect(editable()).toBeNull()
    expect(saysNoBrief()).toBe(false)
    expect(document.querySelector('.brief-card')).toBeNull()
    // Asked for again: the one after the stand-in for the snapshot's route was made.
    expect(calledOn().filter((c) => c.endsWith('/whole'))).toHaveLength(1)
  })

  it('stays whole through a snapshot of the same version of the card', async () => {
    let state = hubState({ cards: [held('c1', { stage: 'ready' })] })
    standInHub(() => state)
    standInWhole((id) => sends(whole(id, { stage: 'ready' })))
    await page('c1')
    await waitFor(() => expect(editable()).not.toBeNull())
    state = hubState({ cards: [held('c1', { stage: 'ready' })] })
    standInRoute('GET', '/api/state', () => ({ version: 2, state, presence: {} }))
    await act(async () => { FakeSocket.open.at(-1)!.readyState = 3; FakeSocket.open.at(-1)!.onclose?.() })
    await waitFor(() => expect(actions.current().sync.version).toBe(2), { timeout: 10_000 })
    await settle(100)
    expect(actions.current().cards[0].left).toBeUndefined()
    expect(editable()).not.toBeNull()
    expect(screen.getByText('brief of c1')).toBeTruthy()
  })

  it('opens a reader’s card too, with nothing to change', async () => {
    standInHub(lightHub(held('c1')), { ...me, role: 'reader' })
    standInWhole((id) => sends(whole(id)))
    await page('c1')
    await screen.findByText('brief of c1')
    expect(editable()).toBeNull()
  })
})

describe('the copy this browser keeps for next time', () => {
  const stored = () => JSON.parse(window.localStorage.getItem(keys.cache)!).confirmed.cards as Card[]

  it('keeps the detail of an old card that was opened, and writes the others without it', async () => {
    standInHub(lightHub(held('c1'), held('c2')))
    standInWhole((id) => sends(whole(id)))
    await mount(<Probe id="c1" />)
    await waitFor(() => expect(probed()).toBe('brief:brief of c1'))
    await settle(1300)
    expect(stored().find((c) => c.id === 'c1')).toMatchObject({ brief: 'brief of c1', plan: [{ text: 'a step', done: true }] })
    expect(stored().find((c) => c.id === 'c1')?.left).toBeUndefined()
    expect(stored().find((c) => c.id === 'c2')).toMatchObject({ brief: '', left: { debrief: 'done' } })
  })

  it('writes an old card light again that this tab was given whole and didn’t open', async () => {
    standInHub(lightHub(whole('c1'), card('young', 'ready', { brief: 'young words', updatedAt: days(1) })))
    await mount(<Grab />)
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'young', fields: { doing: 'Reading' } })] })
    await settle(1300)
    expect(stored().find((c) => c.id === 'c1')).toMatchObject({ brief: '', left: { debrief: 'done' } })
    expect(stored().find((c) => c.id === 'young')).toMatchObject({ brief: 'young words' })
  })
})

describe('the board and the change sets, from what stands in for a card’s detail', () => {
  const pull: PullRequest = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'https://github.com/acme/web/pull/7', state: 'merged', checks: [], files: [], cardId: 'c1', agentId: 'a1' }

  it('lists an old card in Done by its title and agent, asks the hub for nothing and says nothing of a brief', async () => {
    standInHub(lightHub(held('c1', { title: 'Finished long ago', agentId: 'a1', prId: pull.id }), card('c2', 'ready')))
    const asked = standInWhole((id) => sends(whole(id)))
    await mount(<UIContext.Provider value={ui}><Flow /></UIContext.Provider>)
    const done = screen.getByRole('region', { name: 'Done' })
    expect(within(done).getByText('Finished long ago')).toBeTruthy()
    expect(saysNoBrief()).toBe(false)
    await settle(300)
    expect(asked).toEqual([])
  })

  it('has Debrief and Challenge say again when the card was debriefed and challenged', async () => {
    const inReview = held('c1', { stage: 'review', prId: pull.id, challenge: { state: 'done', askedBy: 'you', askedAt: then, agentId: 'a1', picked: 'hub', authors: [] } as Card['challenge'] })
    standInHub(() => hubState({ cards: [inReview], pulls: [{ ...pull, state: 'open' }] }))
    standInWhole(() => new Promise(() => {}))
    await mount(<><DebriefButton card={inReview} /><ChallengeButton card={inReview} /></>)
    expect(screen.getByRole('button', { name: /Debrief again/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Challenge again/ })).toBeTruthy()
  })

  it('has a change set’s card say it has a Challenge with nothing open, from what stands in for it', async () => {
    const challenge = { state: 'done', askedBy: 'you', askedAt: then, agentId: 'a1', picked: 'hub', authors: [], findings: [] } as Card['challenge']
    const set: ChangeSet = { id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'merged', prIds: [pull.id], noteIds: [] }
    standInHub(() => hubState({ cards: [held('c1', { title: 'Finished long ago', prId: pull.id, challenge })], pulls: [pull], changeSets: [set] }))
    await mount(<UIContext.Provider value={ui}><ChangeSets id="set-3" /></UIContext.Provider>)
    expect(screen.getByText('No open findings').getAttribute('href')).toContain('c1')
    expect(saysNoBrief()).toBe(false)
  })
})
