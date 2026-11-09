// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HubState } from '../../shared/state.ts'
import { StoreProvider } from '../src/data/store'
import { keys } from '../src/data/sync'
import App from '../src/App'
import { Flow } from '../src/screens/Flow'
import { Home } from '../src/screens/Home'
import { UIContext } from '../src/ui'
import { agent, card, hubState, me, settle, standInHub, standInRoute } from './harness'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = '' })

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }

/** A hub that answers its state only when told to, as one does on a first open on a new device. */
function slowHub(state: HubState) {
  standInHub(() => state)
  let answer!: () => void
  const gate = new Promise<void>((done) => { answer = done })
  standInRoute('GET', '/api/state', async () => {
    await gate
    return { version: 1, state, presence: {} }
  })
  return () => act(async () => { answer(); await new Promise((done) => setTimeout(done, 50)) })
}

describe('before the hub has answered', () => {
  it('Home says it’s loading, not that there are no agents', async () => {
    const answered = slowHub(hubState({ agents: [], cards: [] }))
    render(<StoreProvider><UIContext.Provider value={ui}><Home /></UIContext.Provider></StoreProvider>)
    await settle(50)
    expect(screen.queryByText(/No agents yet/)).toBeNull()
    expect(screen.queryByText('Nothing yet.')).toBeNull()
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull()
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0)
    await answered()
    expect(await screen.findByText(/No agents yet/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('the board says it’s loading in each column, then that they’re empty', async () => {
    const answered = slowHub(hubState({ agents: [], cards: [] }))
    render(<StoreProvider><UIContext.Provider value={ui}><Flow /></UIContext.Provider></StoreProvider>)
    await settle(50)
    expect(screen.queryByText('Nothing here')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByText('Loading…')).toBeTruthy()
    expect(screen.getAllByText('Loading…').length).toBeGreaterThanOrEqual(6)
    await answered()
    expect((await screen.findAllByText('Nothing here')).length).toBe(6)
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('leaves the real cards where they are once it has', async () => {
    const answered = slowHub(hubState({ agents: [agent], cards: [card('A card')] }))
    render(<StoreProvider><UIContext.Provider value={ui}><Flow /></UIContext.Provider></StoreProvider>)
    await settle(50)
    expect(screen.queryByText('A card')).toBeNull()
    await answered()
    expect(await screen.findByText('A card')).toBeTruthy()
  })

  it('shows what this browser kept from last time at once, empty or not, as it has heard from the hub before', async () => {
    slowHub(hubState({ agents: [], cards: [] }))
    window.localStorage.setItem(keys.cache, JSON.stringify({ version: 5, confirmed: hubState({ agents: [], cards: [] }) }))
    render(<StoreProvider><UIContext.Provider value={ui}><Home /></UIContext.Provider></StoreProvider>)
    await settle(50)
    expect(screen.getByText(/No agents yet/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})

describe('when the hub can’t be reached', () => {
  const unreachable = () => { throw new TypeError('Failed to fetch') }
  const shown = () => render(<StoreProvider><App /></StoreProvider>)

  it('says so, with a way to try again, and not that you’re signed out', async () => {
    standInHub()
    let down = true
    standInRoute('GET', '/api/me', () => (down ? unreachable() : me))
    shown()
    expect(await screen.findByText('Couldn’t reach the hub.')).toBeTruthy()
    expect(screen.queryByText(/GITHUB_CLIENT_ID/)).toBeNull()
    expect(screen.queryByText(/Sign in/)).toBeNull()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/auth/options'))).toBe(false)

    // Still down: it says so again. Then it's back, and the app opens.
    await act(async () => { screen.getByRole('button', { name: 'Try again' }).click() })
    await settle(50)
    expect(screen.getByText('Couldn’t reach the hub.')).toBeTruthy()
    down = false
    await act(async () => { screen.getByRole('button', { name: 'Try again' }).click() })
    await settle(100)
    expect(screen.queryByText('Couldn’t reach the hub.')).toBeNull()
    expect(screen.getAllByRole('navigation', { name: 'Screens' }).length).toBeGreaterThan(0)
  })

  it('says so too when what answers for the hub says it’s down', async () => {
    standInHub()
    standInRoute('GET', '/api/me', () => new Response('Bad gateway', { status: 502 }))
    shown()
    expect(await screen.findByText('Couldn’t reach the hub.')).toBeTruthy()
  })

  it('still shows sign-in to someone the hub says isn’t signed in', async () => {
    standInHub()
    standInRoute('GET', '/api/me', () => new Response(JSON.stringify({ error: 'Sign in first.' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    standInRoute('GET', '/auth/options', () => ({ github: true, dev: false }))
    shown()
    expect(await screen.findByText('Sign in with GitHub')).toBeTruthy()
    expect(screen.queryByText('Couldn’t reach the hub.')).toBeNull()
  })
})
