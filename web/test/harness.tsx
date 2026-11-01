import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { emptyState, type Change, type Entry, type HubState } from '../../shared/state.ts'
import type { Agent, Card } from '../src/data/model'
import { StoreProvider, useHub } from '../src/data/store'

// The app against a hub that isn't there: its API and live feed stood in for, so a test can say what the hub has, hear
// what it's sent, and tell the tab what happened.

export class FakeSocket {
  static open: FakeSocket[] = []
  static OPEN = 1
  readyState = 1
  url: string
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  constructor(url: string | URL) {
    this.url = String(url)
    FakeSocket.open.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  close() { this.readyState = 3 }
}

export const card = (id: string, stage: Card['stage'] = 'ready', over: Partial<Card> = {}): Card => ({ id, binderId: 'b1', title: id, brief: '', doneWhen: '', size: 'M', stage, createdAt: 'then', createdBy: 'you', updatedAt: 'then', waitsFor: [], activity: [], ...over })
export const agent: Agent = { id: 'a1', name: 'Agent', provider: 'claude', owner: 'you', repos: [], binders: [], skills: [], createdAt: 'then' }
export const note = (id = 'n1', text = 'words') => ({ id, title: id, binderId: 'b1', editedAt: 'then', editors: ['you'], text })
export const hubState = (over: Partial<HubState> = {}): HubState => ({ ...emptyState(), binders: [{ id: 'b1', name: 'Binder' }], notes: [note()], cards: [card('c1'), card('c2')], agents: [agent], ...over })
export const me = { user: { login: 'you', name: 'You', avatar: '' }, github: {} }

export const entry = (version: number, change: Change): Entry => ({ version, id: `e${version}`, client: 'user:sam:other', at: 'now', change })

/** Stands in for the hub. `posted` has every batch of changes it's sent. */
export function standInHub(state: () => HubState = hubState, you: unknown = me) {
  const posted: { changes: { id: string; change: Change }[] }[] = []
  let version = 0
  window.localStorage.clear()
  FakeSocket.open = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url === '/api/me') return json(you)
    if (url.endsWith('/doc')) return new Response(null, { status: 404 })
    if (url === '/api/state') return json({ version: 1, state: state(), presence: {} })
    if (url === '/api/changes') {
      const body = JSON.parse(String(init?.body)) as { changes: { id: string; change: Change }[] }
      posted.push(body)
      return json({ versions: body.changes.map(() => ++version + 1) })
    }
    return json({})
  }))
  return { posted }
}

export const hear = (message: unknown) => act(async () => { FakeSocket.open.at(-1)!.onmessage?.({ data: JSON.stringify(message) }) })

export function Ready() {
  const loaded = useHub((s) => s.sync.version > 0 && s.sync.connection === 'live')
  return loaded ? <p data-testid="ready" style={{ display: 'none' }}>ready</p> : null
}

/** The app's store around `children`, once it has heard from the hub. */
export async function mount(children: ReactNode) {
  render(<StoreProvider><Ready />{children}</StoreProvider>)
  await screen.findByTestId('ready')
}

export const settle = (ms = 300) => act(async () => { await new Promise((done) => setTimeout(done, ms)) })
