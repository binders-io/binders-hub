// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, me, mount, settle, standInHub, standInRoute } from './harness'
import App from '../src/App'
import { phoneQuery } from '../src/components/bits'
import { Palette } from '../src/components/Palette'
import { UIContext } from '../src/ui'

// How a person finds their way: the sidebar and the phone's tab bar in the order the work runs, the number keys that
// follow it, Ask having a place, the binder's name on a phone, Add to Claude Code where it's used, and ⌘K's lists.

const asPhone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))
const spaces = { ...me, space: 'acme', spaces: [{ id: 'acme', name: 'Acme' }] }
const open = async (hash: string) => {
  window.location.hash = hash
  await mount(<App />)
  await settle(100)
}
const sidebar = () => within(screen.getAllByRole('navigation', { name: 'Screens' })[0])
/** A link's name with the count or the key beside it left off: the first of its spans. */
const nameOf = (link: HTMLElement) => link.querySelector('span')!.textContent

beforeEach(() => {
  standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder' }, { id: 'b2', name: 'Other' }], cards: [card('c1', 'ready', { title: 'Fix the login' })] }), spaces)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('the sidebar', () => {
  it('follows the work: the board is called Board, and Ask has its place', async () => {
    await open('#/home')
    expect(sidebar().getAllByRole('link').map(nameOf)).toEqual(['Home', 'Ask', 'Notes', 'Board', 'Change sets', 'Delivery', 'Agents', 'Settings'])
    expect(sidebar().getByRole('link', { name: /^Board/ }).getAttribute('href')).toBe('#/flow')
    expect(sidebar().getByRole('link', { name: /^Ask/ }).getAttribute('href')).toBe('#/ask')
    expect(sidebar().queryByRole('link', { name: /^Work/ })).toBeNull()
  })

  it('has the number keys in that order', async () => {
    await open('#/home')
    const hashes: string[] = []
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      fireEvent.keyDown(window, { key })
      hashes.push(window.location.hash)
    }
    expect(hashes).toEqual(['#/home', '#/ask', '#/notes', '#/flow', '#/changes', '#/delivery', '#/agents', '#/settings'])
  })

  it('shows each screen’s key beside its name, and marks the one you’re on', async () => {
    await open('#/flow')
    const board = sidebar().getByRole('link', { name: /^Board/ })
    expect(board.getAttribute('aria-current')).toBe('page')
    expect(board.querySelector('kbd')?.textContent).toBe('4')
    expect(sidebar().getByRole('link', { name: /^Ask/ }).getAttribute('aria-current')).toBeNull()
    cleanup()
    await open('#/ask')
    expect(sidebar().getByRole('link', { name: /^Ask/ }).getAttribute('aria-current')).toBe('page')
  })
})

describe('the board’s name', () => {
  it('is Board in the page’s title and the tab’s, and a card’s own page stays Card', async () => {
    await open('#/flow')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board')
    expect(document.title).toBe('Board · Binders Hub')
    cleanup()
    await open('#/work/c1')
    expect(document.querySelector('.topbar-title')?.textContent).toBe('Card')
    expect(document.title).toBe('Fix the login · Binders Hub')
  })
})

describe('on a phone', () => {
  beforeEach(asPhone)

  it('has Home, Notes, Board, Changes and Agents in the tab bar, the rest in the menu', async () => {
    await open('#/flow')
    const bar = within(screen.getByRole('navigation', { name: 'Main screens' }))
    expect(bar.getAllByRole('link').map(nameOf)).toEqual(['Home', 'Notes', 'Board', 'Changes', 'Agents'])
    expect(bar.getByRole('link', { name: /^Board/ }).getAttribute('aria-current')).toBe('page')
    expect(bar.queryByRole('link', { name: /^Ask/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const menu = within(await screen.findByRole('dialog', { name: 'Menu' }))
    expect(menu.getByRole('link', { name: /^Ask/ }).getAttribute('href')).toBe('#/ask')
  })

  it('says which binder you’re in beside the screen’s name, and opens the menu when it’s pressed', async () => {
    await open('#/notes')
    const topbar = within(document.querySelector('.topbar') as HTMLElement)
    const where = topbar.getByRole('button', { name: 'Acme: open the menu' })
    expect(where.textContent).toBe('Acme')
    expect(topbar.getByRole('heading', { level: 1 }).textContent).toBe('Notes')
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
    fireEvent.click(where)
    expect(await screen.findByRole('dialog', { name: 'Menu' })).toBeTruthy()
  })
})

describe('on a bigger screen', () => {
  it('has no binder name in the top bar: the switcher is in the sidebar', async () => {
    await open('#/notes')
    expect(document.querySelector('.topbar-binder')).toBeNull()
  })
})

describe('Add to Claude Code', () => {
  it('has left the top bar', async () => {
    await open('#/home')
    expect(within(document.querySelector('.topbar') as HTMLElement).queryByRole('button', { name: 'Add to Claude Code' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to Claude Code' })).toBeNull()
  })

  it('is on the Agents page, beside Set up an agent, and opens its dialog', async () => {
    await open('#/agents')
    const buttons = screen.getByRole('button', { name: 'Set up an agent' }).parentElement!
    const add = within(buttons).getByRole('button', { name: 'Add to Claude Code' })
    fireEvent.click(add)
    const dialog = await screen.findByRole('dialog', { name: 'Add the hub to Claude Code' })
    expect(dialog.querySelector('pre')?.textContent).toBe(`claude mcp add --transport http --scope user binders-hub ${window.location.origin}/mcp`)
  })

  it('is on Your account, where it talks about connecting a terminal', async () => {
    standInRoute('GET', '/api/tokens', () => ({ tokens: [] }))
    await open('#/account')
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Claude Code' }))
    expect(await screen.findByRole('dialog', { name: 'Add the hub to Claude Code' })).toBeTruthy()
  })
})

describe('⌘K', () => {
  const ui = (binder: string) => ({ openItem: () => {}, openPalette: () => {}, binder, setBinder: () => {} })
  const sent = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/changes').flatMap(([, init]) => (JSON.parse(String(init?.body)) as { changes: { change: { type: string; note?: { binderId: string; id: string } } }[] }).changes.map((c) => c.change))

  it('goes to the screens in the sidebar’s order, Board and Ask among them', async () => {
    await mount(<UIContext.Provider value={ui('b1')}><Palette onClose={() => {}} /></UIContext.Provider>)
    const go = within(screen.getByRole('group', { name: 'Go to' }))
    expect(go.getAllByRole('option').map((o) => o.querySelector('span')!.textContent)).toEqual(['Home', 'Ask', 'Notes', 'Board', 'Change sets', 'Delivery', 'Agents', 'Settings', 'Your account'])
    fireEvent.click(go.getByRole('option', { name: /^Board/ }))
    expect(window.location.hash).toBe('#/flow')
  })

  it('makes New note in the binder you’re in, as N does', async () => {
    await mount(<UIContext.Provider value={ui('b2')}><Palette onClose={() => {}} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('option', { name: /^New note/ }))
    await waitFor(() => expect(sent().find((c) => c.type === 'note.put')?.note?.binderId).toBe('b2'))
    expect(window.location.hash).toBe(`#/notes/${sent().find((c) => c.type === 'note.put')!.note!.id}`)
  })

  it('makes it in the first binder when all of them are showing', async () => {
    await mount(<UIContext.Provider value={ui('all')}><Palette onClose={() => {}} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('option', { name: /^New note/ }))
    await waitFor(() => expect(sent().find((c) => c.type === 'note.put')?.note?.binderId).toBe('b1'))
  })
})
