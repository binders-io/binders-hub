import { act, configure, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { emptyState, type Change, type Entry, type HubState } from '../../shared/state.ts'
import type { Agent, Card } from '../src/data/model'
import { StoreProvider, useHub } from '../src/data/store'

// A test that starts the app afresh (vi.resetModules) gets this file afresh too, and its own copy of the testing
// library, so the longer wait test/setup.ts gives is given again here.
configure({ asyncUtilTimeout: 10_000 })

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
    if (url.split('?')[0] === '/api/state') return json({ version: 1, state: state(), presence: {} })
    if (url === '/api/changes') {
      const body = JSON.parse(String(init?.body)) as { changes: { id: string; change: Change }[] }
      posted.push(body)
      return json({ versions: body.changes.map(() => ++version + 1) })
    }
    return json({})
  }))
  return { posted }
}

/**
 * Has the stand-in hub answer for GitHub's repos too, as `answer` says: what to send, or a promise of it, or an Error
 * to fail with. Every match by name (`all=1`) comes from the same answer, and checking repos to add together finds
 * them all linkable but those `refuse` names. Gives what each call asked for.
 */
export function standInRepos(answer: (query: URLSearchParams) => unknown, refuse: Record<string, string> = {}) {
  const hub = globalThis.fetch
  const asked: URLSearchParams[] = []
  const checked: string[][] = []
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/github/repos/check')) {
      const repos = (JSON.parse(String(init?.body ?? '{}')) as { repos: string[] }).repos
      checked.push(repos)
      return reply({ ok: repos.filter((r) => !refuse[r]), refused: repos.filter((r) => refuse[r]).map((repo) => ({ repo, why: refuse[repo] })) })
    }
    if (!url.startsWith('/api/github/repos')) return hub(url, init)
    const query = new URL(url, 'http://hub.test').searchParams
    const body = await answer(query)
    if (body instanceof Error) return reply({ error: body.message }, 500)
    if (query.get('all')) {
      const repos = ((body as { repos?: { fullName: string; linkable?: boolean }[] }).repos ?? [])
      return reply({ names: repos.filter((r) => r.linkable !== false).map((r) => r.fullName), total: repos.length })
    }
    asked.push(query)
    return reply(body)
  }))
  return Object.assign(asked, { checked })
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

/**
 * Has the stand-in hub answer one address its own way: `answer` gives what to send back (a body, or a Response for a
 * status), or throws, as the browser's fetch does when the hub can't be reached. Gives the bodies it was sent.
 */
export function standInRoute(method: string, path: string | RegExp, answer: (body: unknown) => unknown = () => ({})) {
  const hub = globalThis.fetch
  const calls: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const at = String(url).split('?')[0]
    if ((init?.method ?? 'GET') !== method || !(typeof path === 'string' ? at === path : path.test(at))) return hub(url, init)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(body)
    const sent = await answer(body)
    return sent instanceof Response ? sent : new Response(JSON.stringify(sent), { headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

/** The calls the app has made to the hub so far, as "METHOD /path". */
export const calledOn = () => vi.mocked(fetch).mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).split('?')[0]}`)
