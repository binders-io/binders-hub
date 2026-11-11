// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, mount, standInHub } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { Flow } from '../src/screens/Flow'
import { UIContext } from '../src/ui'

// The board as someone without a mouse gets it. Flow.test.tsx has how it moves cards, with the menus stood in for;
// these need the real ones.

const openItem = vi.fn()
const board = () => hubState({ cards: [card('Ready one'), card('Under review', 'review'), card('Blocked one', 'blocked'), card('Blocked two', 'blocked')] })
const ui = { openItem, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const opened = () => mount(<UIContext.Provider value={ui}><Flow /><ContextMenuHost /></UIContext.Provider>)
const scrolled = vi.fn()

beforeEach(() => {
  standInHub(board)
  openItem.mockClear()
  scrolled.mockClear()
  Element.prototype.scrollIntoView = scrolled
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a card on the board', () => {
  it('has no control inside another, which a screen reader can’t reach', async () => {
    await opened()
    expect(document.querySelectorAll('button button, button [role="button"], a button, button a')).toHaveLength(0)
  })

  it('has a button named after it that opens it', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Under review' }))
    expect(openItem).toHaveBeenCalledTimes(1)
    expect(openItem).toHaveBeenCalledWith('Under review')
  })

  it('opens from anywhere on it, for a pointer', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Under review' }).closest('.card')!.querySelector('.card-foot')!)
    expect(openItem).toHaveBeenCalledWith('Under review')
  })

  it('has its title as a heading under its column’s', async () => {
    await opened()
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByRole('heading', { level: 3, name: 'Ready one' })).toBeTruthy()
  })

  it('opens its menu from a real button, named for the card, without opening the card', async () => {
    await opened()
    const actions = screen.getByRole('button', { name: 'Actions for Ready one' })
    expect(actions.tagName).toBe('BUTTON')
    fireEvent.click(actions)
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(openItem).not.toHaveBeenCalled()
  })

  it('moves to another stage from that menu, as dragging needs a mouse', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ready one' }))
    expect(await screen.findByRole('menuitem', { name: 'Done' })).toBeTruthy()
  })

  it('asks for a debrief from a real button, without opening the card', async () => {
    await opened()
    const debrief = screen.getByRole('button', { name: 'Debrief' })
    expect(debrief.tagName).toBe('BUTTON')
    fireEvent.click(debrief)
    expect(openItem).not.toHaveBeenCalled()
  })
})

describe('the stages on a phone', () => {
  const stages = () => screen.getByRole('navigation', { name: 'Stages' })
  const stage = (name: RegExp) => within(stages()).getByRole('button', { name })

  it('says what’s in each stage, so an empty first column isn’t all you see', async () => {
    await opened()
    expect(within(stages()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Proposed0', 'Ready1', 'Working0', 'Blocked2', 'Review1', 'Done0'])
  })

  it('goes to a stage’s column when pressed', async () => {
    await opened()
    fireEvent.click(stage(/Blocked/))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(screen.getByRole('region', { name: 'Blocked' }))
  })

  it('doesn’t animate that for someone who’s asked for less motion', async () => {
    await opened()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener() {}, removeEventListener() {} }))
    fireEvent.click(stage(/Blocked/))
    expect(scrolled.mock.calls[0][0]).toMatchObject({ behavior: 'auto' })
  })

  it('marks the stage in view as you swipe', async () => {
    await opened()
    const columns = document.querySelector('.columns') as HTMLElement
    const [first, second] = [...columns.children] as HTMLElement[]
    Object.defineProperty(first, 'offsetLeft', { value: 0 })
    Object.defineProperty(second, 'offsetLeft', { value: 300 })
    columns.scrollLeft = 900
    fireEvent.scroll(columns)
    expect(await within(stages()).findByRole('button', { current: true })).toBe(stage(/Blocked/))
  })
})

describe('the board’s tools', () => {
  const two = () => hubState({ agents: [{ ...agent, name: 'Builder' }], cards: [card('Built by it', 'working', { agentId: 'a1' }), card('Nobody’s')] })

  it('has the filters in a menu too, for a phone, ticking the one shown and narrowing the board as the chips do', async () => {
    standInHub(two)
    await opened()
    const view = screen.getByRole('button', { name: 'Show only: Everyone' })
    expect(view.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(view)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Everyone', 'Mine', 'Builder'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Builder' }))
    expect(screen.queryByText('Nobody’s')).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Show only' })).getByRole('button', { name: 'Builder' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Show only: Builder' })).toBeTruthy()
  })

  it('opens the activity over the board, and closes it from its own button and on Escape', async () => {
    await opened()
    const toggle = screen.getByRole('button', { name: 'Activity' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.flow')!.className).toContain('feed-open')
    fireEvent.click(screen.getByRole('button', { name: 'Close activity' }))
    expect(document.querySelector('.flow')!.className).not.toContain('feed-open')
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.flow')!.className).not.toContain('feed-open')
  })

  it('names each column’s stage by its title and says what it means with it', async () => {
    await opened()
    const ready = screen.getByRole('region', { name: 'Ready' })
    expect(document.getElementById(ready.getAttribute('aria-describedby')!)!.textContent).toBe('An agent can take these')
    expect(ready.querySelector('header')!.getAttribute('title')).toBe('An agent can take these')
  })
})
