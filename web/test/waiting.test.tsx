// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, entry, hear, hubState, me, mount, settle, standInHub } from './harness'
import App from '../src/App'
import { phoneQuery } from '../src/components/bits'
import { Palette } from '../src/components/Palette'
import { SideAgents } from '../src/components/SideAgents'
import { Account } from '../src/screens/Account'
import { Agents } from '../src/screens/Agents'
import { Home } from '../src/screens/Home'
import { UIContext } from '../src/ui'
import type { Agent } from '../src/data/model'
import type { HubState } from '../../shared/state.ts'

// What waits on you, wherever the app says so: Home's number and list, the sidebar's badges, ⌘K, the tab's title, a
// browser notification, and an agent that has asked something.

const ui = (binder = 'all') => ({ openItem: (id: string) => { window.location.hash = `#/work/${id}` }, openPalette: () => {}, binder, setBinder: () => {} })
const asPhone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))
const sam: Agent = { ...agent, id: 'a2', name: 'Sam’s agent', owner: 'sam' }
const soon = () => new Date().toISOString()

/** One of each: a question for you, one for someone else, a change set to approve, a card proposed from your note. */
const busy = (): HubState => hubState({
  binders: [{ id: 'b1', name: 'Binder' }, { id: 'b2', name: 'Other' }],
  agents: [{ ...agent, lastSeen: soon() }, sam],
  notes: [{ id: 'n1', title: 'The plan', binderId: 'b1', editedAt: 'then', editors: ['you'], text: 'words' }],
  cards: [
    card('Which one', 'blocked', { agentId: 'a1', needsYou: 'Left or right?' }),
    card('Sam’s question', 'blocked', { agentId: 'a2', needsYou: 'Up or down?', createdBy: 'sam' }),
    card('Being worked', 'working', { agentId: 'a1' }),
  ],
  proposals: [{ id: 'p1', binderId: 'b1', noteId: 'n1', title: 'Add a login', quote: '', brief: '', doneWhen: '', size: 'S', by: 'a1', state: 'new' }],
  changeSets: [{ id: 'cs1', binderId: 'b1', number: 4, title: 'Login work', summary: '', state: 'review', prIds: ['o/r#1', 'o/r#2'], noteIds: [] }],
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  window.location.hash = ''
})

describe('Home: what waits on you', () => {
  beforeEach(() => { standInHub(busy) })

  it('counts what’s for you and for anyone, with what’s in it, and leaves out what’s on others', async () => {
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const tile = screen.getByRole('button', { name: /Waiting on you/ })
    expect(within(tile).getByText('3')).toBeTruthy()
    expect(within(tile).getByText('1 question · 1 to approve · 1 proposed')).toBeTruthy()
  })

  // The number counts rows, so the line adds up to it: a note's nine proposed cards are one row, and the line says so.
  it('says a note’s proposed cards are one thing, so the line adds up to the number', async () => {
    cleanup()
    const proposal = (n: number) => ({ id: `p${n}`, binderId: 'b1', noteId: 'n1', title: `Card ${n}`, quote: '', brief: '', doneWhen: '', size: 'S' as const, by: 'a1', state: 'new' as const })
    const asked = Array.from({ length: 6 }, (_, n) => card(`Asked ${n}`, 'blocked', { agentId: 'a1', needsYou: 'Which?' }))
    standInHub(() => ({ ...busy(), cards: asked, proposals: Array.from({ length: 9 }, (_, n) => proposal(n)) }))
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const tile = screen.getByRole('button', { name: /Waiting on you/ })
    expect(within(tile).getByText('8')).toBeTruthy()
    expect(within(tile).getByText('6 questions · 1 to approve · 1 note with 9 proposed')).toBeTruthy()
  })

  it('says how many a card’s findings are, as one card', async () => {
    cleanup()
    const finding = (id: string) => ({ id, kind: 'bug' as const, file: 'a.ts', line: 1, what: 'Wrong', confidence: 'confirmed' as const, severity: 'high' as const })
    const reviewed = card('Reviewed', 'review', { agentId: 'a1', challenge: { state: 'done', askedBy: 'you', askedAt: 'then', agentId: 'a2', picked: 'hub', authors: ['a1'], findings: [finding('f1'), finding('f2'), finding('f3')] } })
    standInHub(() => ({ ...busy(), cards: [reviewed], proposals: [], changeSets: [] }))
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const tile = screen.getByRole('button', { name: /Waiting on you/ })
    expect(within(tile).getByText('1')).toBeTruthy()
    expect(within(tile).getByText('1 card with 3 to look at')).toBeTruthy()
  })

  it('lists it in groups: for you, for anyone here, and what’s on others folded away with its count', async () => {
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const list = screen.getByRole('region', { name: 'Waiting on you' })
    const groups = [...list.querySelectorAll('h3')].map((h) => h.textContent)
    expect(groups).toEqual(['For you', 'For anyone here'])
    const mine = within(list.querySelector('.waiting-group')! as HTMLElement)
    expect(mine.getByText('Which one')).toBeTruthy()
    expect(mine.getByText('Agent asks: Left or right?')).toBeTruthy()
    expect(mine.getByText('The plan')).toBeTruthy()
    const others = list.querySelector('details.waiting-others') as HTMLDetailsElement
    expect(others.open).toBe(false)
    expect(within(others.querySelector('summary')!).getByText('Waiting on others')).toBeTruthy()
    expect(others.querySelector('summary .count')?.textContent).toBe('1')
    expect(within(others).getByText('Sam’s question')).toBeTruthy()
    expect(within(list).getByText('Change set #4: Login work')).toBeTruthy()
  })

  it('opens what a row is about', async () => {
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting on you' })).getByText('Change set #4: Login work'))
    expect(window.location.hash).toBe('#/changes/cs1')
  })

  it('goes to the list when its count is pressed, not to the first question', async () => {
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    window.location.hash = ''
    fireEvent.click(screen.getByRole('button', { name: /Waiting on you/ }))
    expect(window.location.hash).toBe('')
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Waiting on you' }))
  })

  it('narrows to the binder you’re in', async () => {
    cleanup()
    standInHub(() => ({ ...busy(), cards: [...busy().cards, card('Elsewhere', 'blocked', { agentId: 'a1', needsYou: 'Why?', binderId: 'b2' })] }))
    await mount(<UIContext.Provider value={ui('b1')}><Home /></UIContext.Provider>)
    expect(within(screen.getByRole('button', { name: /Waiting on you/ })).getByText('3')).toBeTruthy()
    cleanup()
    standInHub(() => ({ ...busy(), cards: [...busy().cards, card('Elsewhere', 'blocked', { agentId: 'a1', needsYou: 'Why?', binderId: 'b2' })] }))
    await mount(<UIContext.Provider value={ui('all')}><Home /></UIContext.Provider>)
    expect(within(screen.getByRole('button', { name: /Waiting on you/ })).getByText('4')).toBeTruthy()
  })

  it('has the list beside the agents on a wide screen, and first on the page on a phone', async () => {
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    expect(document.querySelector('.home-side .home-waiting')).toBeTruthy()
    expect(document.querySelector('.home > .home-waiting')).toBeNull()
    cleanup()
    standInHub(busy)
    asPhone()
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const home = document.querySelector('.home')!
    expect(home.firstElementChild?.classList.contains('home-waiting')).toBe(true)
    expect(home.querySelector('.home-side .home-waiting')).toBeNull()
    expect(home.firstElementChild!.compareDocumentPosition(home.querySelector('.home-stats')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says so when nothing waits', async () => {
    cleanup()
    standInHub(() => hubState({ cards: [card('c1')] }))
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Waiting on you/ })).getByText('Nothing')).toBeTruthy()
  })
})

describe('Home: done today', () => {
  const zone = process.env.TZ
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('is the day where you are, not the day in UTC', async () => {
    process.env.TZ = 'America/New_York'
    // Eight in the evening on the 9th in New York is already the 10th in UTC.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T01:00:00.000Z'))
    standInHub(() => hubState({ cards: [card('This morning', 'review', { updatedAt: '2026-11-09T15:00:00.000Z' }), card('Yesterday', 'live', { updatedAt: '2026-11-08T15:00:00.000Z' })] }))
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    expect(within(screen.getByText('Done today').closest('.stat') as HTMLElement).getByText('1')).toBeTruthy()
  })
})

describe('an agent with a question', () => {
  beforeEach(() => { standInHub(busy) })

  it('says so on Home’s tile, not that it listens', async () => {
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const tile = screen.getByRole('heading', { name: 'Agent' }).closest('article')!
    expect(within(tile).getByText('Waiting on you')).toBeTruthy()
    expect(within(tile).getByText('Asks: Left or right?')).toBeTruthy()
  })

  it('says so on the Agents page: a question for you, and what it asks', async () => {
    await mount(<Agents />)
    const mine = screen.getByRole('heading', { name: 'Agent' }).closest('article')!
    expect(within(mine).getByText(/A question for you/)).toBeTruthy()
    expect(within(mine).getByText('Asks you')).toBeTruthy()
    expect(within(mine).queryByText(/Waiting for work/)).toBeNull()
  })

  it('says so in the sidebar, with the card under it', async () => {
    await mount(<SideAgents agents={[agent]} />)
    expect(screen.getByText('A question for you')).toBeTruthy()
    expect(screen.getByText('Which one')).toBeTruthy()
  })

  it('still reads as waiting for work when it holds nothing', async () => {
    cleanup()
    standInHub(() => hubState({ cards: [card('c1')] }))
    await mount(<Agents />)
    expect(screen.getByText(/Waiting for work/)).toBeTruthy()
  })
})

describe('⌘K’s actions', () => {
  it('are what waits on you and on anyone, each opening what it’s about', async () => {
    standInHub(busy)
    await mount(<UIContext.Provider value={ui()}><Palette onClose={() => {}} /></UIContext.Provider>)
    const actions = within(screen.getByRole('group', { name: 'Actions' }))
    expect(actions.getByText('Answer: Which one')).toBeTruthy()
    expect(actions.getByText('Review: Change set #4: Login work')).toBeTruthy()
    expect(actions.getByText('Look at what was proposed from: The plan')).toBeTruthy()
    expect(actions.queryByText(/Sam’s question/)).toBeNull()
    fireEvent.click(actions.getByText('Review: Change set #4: Login work'))
    expect(window.location.hash).toBe('#/changes/cs1')
  })
})

describe('cards proposed from a note, opened', () => {
  const distill = () => window.localStorage.getItem('binders-note-side')
  const none = { type: 'proposal.put', proposal: { id: 'p2', binderId: 'b1', noteId: 'n1', title: 'Add a logout', quote: '', brief: '', doneWhen: '', size: 'S', by: 'a1', state: 'new' } } as const

  it('opens the note on its proposed cards from Home’s row', async () => {
    standInHub(busy)
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    expect(distill()).toBeNull()
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting on you' })).getByText('The plan'))
    expect(window.location.hash).toBe('#/notes/n1')
    expect(distill()).toBe('distill')
  })

  it('opens the note on its proposed cards from ⌘K’s row', async () => {
    standInHub(busy)
    await mount(<UIContext.Provider value={ui()}><Palette onClose={() => {}} /></UIContext.Provider>)
    fireEvent.click(within(screen.getByRole('group', { name: 'Actions' })).getByText('Look at what was proposed from: The plan'))
    expect(window.location.hash).toBe('#/notes/n1')
    expect(distill()).toBe('distill')
  })

  it('opens the note on its proposed cards from a notification', async () => {
    const made: { onclick?: () => void }[] = []
    vi.stubGlobal('Notification', class { static permission = 'granted'; onclick?: () => void; constructor() { made.push(this) } close() {} })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    standInHub(() => hubState({ notes: [{ id: 'n1', title: 'The plan', binderId: 'b1', editedAt: 'then', editors: ['you'], text: 'words' }], agents: [agent] }))
    window.localStorage.setItem('binders-hub-notify', 'on')
    window.location.hash = '#/home'
    try {
      await mount(<App />)
      await settle(50)
      await hear({ type: 'entries', entries: [entry(2, none)] })
      expect(made).toHaveLength(1)
      window.localStorage.removeItem('binders-note-side')
      act(() => made[0].onclick?.())
      expect(window.location.hash).toBe('#/notes/n1')
      expect(distill()).toBe('distill')
    } finally {
      delete (document as { visibilityState?: string }).visibilityState
    }
  })

  it('leaves the note’s side panel alone for a row that isn’t about proposed cards', async () => {
    standInHub(busy)
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting on you' })).getByText('Change set #4: Login work'))
    expect(distill()).toBeNull()
  })
})

describe('the sidebar and the tab', () => {
  beforeEach(() => {
    window.location.hash = '#/home'
    standInHub(() => ({ ...busy(), cards: [...busy().cards, card('Elsewhere', 'blocked', { agentId: 'a1', needsYou: 'Why?', binderId: 'b2' })], environments: [
      { id: 'o/r#staging', repo: 'o/r', name: 'Staging', url: '', version: '1.1', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0 },
      { id: 'o/r#production', repo: 'o/r', name: 'Production', url: '', version: '1.0', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: true, deploy: { repo: 'o/r', workflow: 'deploy.yml', ref: 'main' }, order: 1 },
    ] }))
  })
  const badge = (name: string) => within(screen.getAllByRole('navigation', { name: 'Screens' })[0]).getByRole('link', { name: new RegExp(`^${name}`) }).querySelector('em.count')

  it('badge a screen for what waits on you there, and nothing else', async () => {
    await mount(<App />)
    await settle(50)
    expect(badge('Board')?.textContent).toBe('1')
    expect(badge('Notes')?.textContent).toBe('1')
    expect(badge('Change sets')?.textContent).toBe('1')
    expect(badge('Delivery')?.textContent).toBe('1')
  })

  it('doesn’t count cards being worked on Board’s badge', async () => {
    cleanup()
    standInHub(() => hubState({ cards: [card('Busy', 'working', { agentId: 'a1' })] }))
    await mount(<App />)
    await settle(50)
    expect(badge('Board')).toBeNull()
  })

  it('keeps how many agents are online, drawn quietly', async () => {
    await mount(<App />)
    await settle(50)
    const online = badge('Agents')
    expect(online?.textContent).toBe('1')
    expect(online?.classList.contains('count-agents')).toBe(true)
    expect(online?.classList.contains('count-flow')).toBe(false)
  })

  it('puts the count of what waits on you, in every binder, in the tab’s title', async () => {
    await mount(<App />)
    await settle(50)
    // Four here, and the one in the other binder.
    expect(document.title).toBe('(5) Home · Binders Hub')
  })
})

describe('a notification', () => {
  const made: { title: string; options?: NotificationOptions; onclick?: () => void; closed: boolean }[] = []
  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted'
      return FakeNotification.permission
    })
    onclick?: () => void
    closed = false
    constructor(title: string, options?: NotificationOptions) { made.push(Object.assign(this, { title, options })) }
    close() { this.closed = true }
  }
  const hide = () => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  beforeEach(() => {
    made.length = 0
    FakeNotification.permission = 'granted'
    FakeNotification.requestPermission.mockClear()
    vi.stubGlobal('Notification', FakeNotification)
    window.location.hash = '#/home'
    standInHub(() => hubState({ agents: [agent], cards: [card('Already asking', 'blocked', { agentId: 'a1', needsYou: 'Before you came' }), card('c2')] }))
    window.localStorage.setItem('binders-hub-notify', 'on')
  })
  afterEach(() => { delete (document as { visibilityState?: string }).visibilityState })

  const ask = () => hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c2', fields: { needsYou: 'Which name?', stage: 'blocked', agentId: 'a1' } })] })

  it('comes for a question that starts waiting while the tab is hidden, and not for what was there at the start', async () => {
    hide()
    await mount(<App />)
    await settle(50)
    expect(made).toEqual([])
    await ask()
    expect(made).toHaveLength(1)
    expect(made[0].title).toBe('c2')
    expect(made[0].options?.body).toBe('Agent asks: Which name?')
  })

  it('brings the tab forward and opens the card when pressed', async () => {
    hide()
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    await mount(<App />)
    await settle(50)
    await ask()
    window.location.hash = '#/home'
    act(() => made[0].onclick?.())
    expect(focus).toHaveBeenCalled()
    expect(made[0].closed).toBe(true)
    expect(window.location.hash).toBe('#/work/c2')
  })

  it('stays quiet while the tab is in front, and while the switch is off', async () => {
    await mount(<App />)
    await settle(50)
    await ask()
    expect(made).toEqual([])
    cleanup()
    window.localStorage.setItem('binders-hub-notify', 'off')
    hide()
    standInHub(() => hubState({ agents: [agent], cards: [card('c2')] }))
    await mount(<App />)
    await settle(50)
    await ask()
    expect(made).toEqual([])
  })

  it('sets the app’s badge to the count where the browser has one', async () => {
    const set = vi.fn(async () => {})
    Object.assign(navigator, { setAppBadge: set })
    await mount(<App />)
    await settle(50)
    expect(set).toHaveBeenLastCalledWith(1)
    await ask()
    expect(set).toHaveBeenLastCalledWith(2)
    delete (navigator as { setAppBadge?: unknown }).setAppBadge
  })

  it('doesn’t ask the browser’s permission until the switch is pressed', async () => {
    FakeNotification.permission = 'default'
    window.localStorage.clear()
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const box = screen.getByLabelText('Tell me when something waits on me') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    fireEvent.click(box)
    await waitFor(() => expect(box.checked).toBe(true))
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('binders-hub-notify')).toBe('on')
    fireEvent.click(box)
    await waitFor(() => expect(box.checked).toBe(false))
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('stays off, and says why, when the browser refuses', async () => {
    FakeNotification.permission = 'denied'
    await mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    const box = screen.getByLabelText('Tell me when something waits on me') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(true)
    expect(screen.getByText(/blocking them for this page/)).toBeTruthy()
  })
})

describe('the switch', () => {
  it('is on Home beside the list’s heading, and on the Account page, and one answers for both', async () => {
    vi.stubGlobal('Notification', Object.assign(class {}, { permission: 'granted' as NotificationPermission, requestPermission: async () => 'granted' as const }))
    standInHub(() => hubState(), { ...me, spaces: [], github: { mode: 'none', signIn: false, server: false, webhooks: false } })
    window.localStorage.setItem('binders-hub-notify', 'on')
    await mount(<><UIContext.Provider value={ui()}><Home /></UIContext.Provider><Account /></>)
    const boxes = screen.getAllByLabelText('Tell me when something waits on me') as HTMLInputElement[]
    expect(boxes).toHaveLength(2)
    expect(boxes.map((b) => b.checked)).toEqual([true, true])
    expect(screen.getByRole('region', { name: 'Waiting on you' }).querySelector('.waiting-head')?.contains(boxes[0])).toBe(true)
    fireEvent.click(boxes[1])
    await waitFor(() => expect(boxes.map((b) => b.checked)).toEqual([false, false]))
  })

  it('is left off Home, and explained on Account, where the browser has no notifications', async () => {
    standInHub(() => hubState(), { ...me, spaces: [], github: { mode: 'none', signIn: false, server: false, webhooks: false } })
    await mount(<><UIContext.Provider value={ui()}><Home /></UIContext.Provider><Account /></>)
    expect(screen.queryByLabelText('Tell me when something waits on me')).toBeNull()
    expect(screen.getByText('This browser can’t show notifications.')).toBeTruthy()
  })
})
