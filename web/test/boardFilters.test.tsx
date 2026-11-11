// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import type { Proposal } from '../src/data/model'
import { Flow } from '../src/screens/Flow'
import { UIContext } from '../src/ui'

// The board narrowed to what’s mine or one agent’s, Done keeping to the last month, what a card says of why it
// stopped, and where a new card went.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const board = () => mount(<UIContext.Provider value={ui}><Flow /><Toast /></UIContext.Provider>)
const mine = { ...agent, id: 'a1', name: 'Mine agent', owner: 'you' }
const theirs = { ...agent, id: 'a2', name: 'Their agent', owner: 'sam' }
const idle = { ...agent, id: 'a3', name: 'Idle agent', owner: 'sam' }
const column = (name: string) => screen.getByRole('region', { name })
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600_000).toISOString()
const filters = () => screen.getByRole('group', { name: 'Show only' })
const press = (name: string) => fireEvent.click(within(filters()).getByRole('button', { name }))
const proposal = (id: string, over: Partial<Proposal> = {}): Proposal => ({ id, binderId: 'b1', noteId: 'n1', title: id, quote: '', brief: '', doneWhen: '', size: 'S', by: 'sam', state: 'new', ...over })

beforeEach(() => {
  standInHub(() => hubState({
    agents: [mine, theirs, idle],
    cards: [
      card('Made by me', 'ready', { createdBy: 'you' }),
      card('Held by my agent', 'working', { createdBy: 'sam', agentId: 'a1' }),
      card('Meant for my agent', 'ready', { createdBy: 'sam', meantFor: 'a1' }),
      card('Held by their agent', 'working', { createdBy: 'sam', agentId: 'a2' }),
      card('Nobody’s', 'ready', { createdBy: 'sam' }),
    ],
    proposals: [proposal('Mine proposed', { by: 'you' }), proposal('Theirs proposed', { by: 'sam' }), proposal('For my agent', { by: 'sam', meantFor: 'a1' })],
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('narrowing the board', () => {
  it('has Mine and one filter for each agent that has cards, and none for an agent without', async () => {
    await board()
    expect(within(filters()).getAllByRole('button').map((b) => b.textContent!.trim())).toEqual(['Mine', 'Mine agent', 'Their agent'])
    for (const b of within(filters()).getAllByRole('button')) expect(b.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows cards I made, and ones an agent I own holds or is meant for, under Mine', async () => {
    await board()
    press('Mine')
    expect(within(filters()).getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('true')
    for (const title of ['Made by me', 'Held by my agent', 'Meant for my agent']) expect(screen.getByText(title)).toBeTruthy()
    for (const title of ['Held by their agent', 'Nobody’s']) expect(screen.queryByText(title)).toBeNull()
  })

  it('narrows proposals the same way, by who made them or who they’re for', async () => {
    await board()
    press('Mine')
    await waitFor(() => expect(screen.queryByText('Theirs proposed')).toBeNull())
    expect(within(column('Proposed')).getByText('Mine proposed')).toBeTruthy()
    expect(within(column('Proposed')).getByText('For my agent')).toBeTruthy()
  })

  it('shows one agent’s cards, whoever owns it, and the counts follow', async () => {
    await board()
    press('Their agent')
    expect(screen.getByText('Held by their agent')).toBeTruthy()
    for (const title of ['Made by me', 'Held by my agent', 'Nobody’s']) expect(screen.queryByText(title)).toBeNull()
    expect(column('Ready').querySelector('header .num')!.textContent).toBe('0')
    expect(column('Agents working').querySelector('header .num')!.textContent).toBe('1')
  })

  it('goes back to everything when the same one is pressed again', async () => {
    await board()
    press('Mine')
    press('Mine')
    expect(screen.getByText('Nobody’s')).toBeTruthy()
    expect(within(filters()).getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('is remembered in this browser', async () => {
    await board()
    press('Mine agent')
    cleanup()
    await board()
    expect(within(filters()).getByRole('button', { name: 'Mine agent' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('Nobody’s')).toBeNull()
    expect(window.localStorage.getItem('binders-board-filter')).toBe('agent:a1')
  })

  it('isn’t applied once what it was set to has no cards any more', async () => {
    window.localStorage.setItem('binders-board-filter', 'agent:a3')
    await board()
    expect(screen.getByText('Nobody’s')).toBeTruthy()
    expect(within(filters()).queryByRole('button', { pressed: true })).toBeNull()
  })

  it('can be reached with the keyboard: they’re buttons that say whether they’re on', async () => {
    await board()
    for (const b of within(filters()).getAllByRole('button')) expect((b as HTMLButtonElement).tabIndex).toBe(0)
  })
})

describe('Done', () => {
  const finished = () => hubState({ agents: [mine], cards: [card('Last week', 'live', { updatedAt: daysAgo(7) }), card('Last month', 'live', { updatedAt: daysAgo(29) }), card('Long ago', 'live', { updatedAt: daysAgo(31) }), card('Years ago', 'live', { updatedAt: daysAgo(900) }), card('Unreadable time', 'live', { updatedAt: 'then' })] })

  it('shows the last 30 days, with Show older under it for the rest', async () => {
    standInHub(finished)
    await board()
    const done = column('Done')
    for (const title of ['Last week', 'Last month', 'Unreadable time']) expect(within(done).getByText(title)).toBeTruthy()
    for (const title of ['Long ago', 'Years ago']) expect(within(done).queryByText(title)).toBeNull()
    expect(within(done).getByText('2 from before the last 30 days')).toBeTruthy()
    expect(done.querySelector('header .num')!.textContent).toBe('3')
  })

  it('shows them all once asked, and hides them again', async () => {
    standInHub(finished)
    await board()
    fireEvent.click(within(column('Done')).getByRole('button', { name: 'Show older' }))
    for (const title of ['Long ago', 'Years ago']) expect(within(column('Done')).getByText(title)).toBeTruthy()
    fireEvent.click(within(column('Done')).getByRole('button', { name: 'Hide older' }))
    expect(within(column('Done')).queryByText('Long ago')).toBeNull()
  })

  it('has no button when nothing is older, and it’s only on Done', async () => {
    standInHub(() => hubState({ cards: [card('Recent', 'live', { updatedAt: daysAgo(2) }), card('Old but not done', 'review', { updatedAt: daysAgo(100) })] }))
    await board()
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull()
    expect(within(column('In review')).getByText('Old but not done')).toBeTruthy()
  })
})

describe('why a card stopped, on the board', () => {
  const twice = 'It stopped twice without finishing: Signed out of Claude Code. Fix what’s wrong, then answer here and it goes back to Ready.'

  it('is one line on the card, with how often', async () => {
    standInHub(() => hubState({ cards: [card('Ran long', 'ready', { stopped: { why: 'Ran out of time.', at: daysAgo(0), times: 1 } })] }))
    await board()
    const line = within(column('Ready')).getByText('Stopped once: Ran out of time.').closest('p')!
    expect(line.className).toBe('card-stopped')
    expect(line.getAttribute('title')).toBe('Stopped once: Ran out of time.')
  })

  it('says “Stopped twice” and the reason, not that an agent asks, on a blocked card nobody holds', async () => {
    standInHub(() => hubState({ cards: [card('Stuck', 'blocked', { needsYou: twice, stopped: { why: 'Signed out of Claude Code.', at: daysAgo(0), times: 2 } })] }))
    await board()
    expect(within(column('Blocked')).getByText('Stopped twice: Signed out of Claude Code.')).toBeTruthy()
    expect(screen.queryByText(/Asks:/)).toBeNull()
    // The line at the top of the board says what waits: a card that stopped, not that an agent asks.
    const strip = document.querySelector('.waiting-strip') as HTMLElement
    expect(strip.textContent).toContain('1 stopped card · Stuck')
    expect(strip.textContent).not.toMatch(/asks/)
  })

  it('says it for a card the hub blocked before it kept the reason, from its question', async () => {
    standInHub(() => hubState({ cards: [card('Stuck', 'blocked', { needsYou: twice })] }))
    await board()
    expect(within(column('Blocked')).getByText('Stopped twice')).toBeTruthy()
    expect(screen.queryByText(/Asks:/)).toBeNull()
  })

  it('still says an agent asks when one holds the card', async () => {
    standInHub(() => hubState({ agents: [mine], cards: [card('Question', 'blocked', { agentId: 'a1', needsYou: 'Left or right?' })] }))
    await board()
    expect(within(column('Blocked')).getByText('Asks: Left or right?')).toBeTruthy()
    expect((document.querySelector('.waiting-strip') as HTMLElement).textContent).toContain('1 question · Question')
  })
})

describe('a new card', () => {
  const made = card('card-9', 'ready', { title: 'Write the docs' })
  const add = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Write the docs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Put on the board' }))
  }

  it('says which column it’s in, with a button that opens it', async () => {
    standInHub(() => hubState({ cards: [] }))
    const created = standInRoute('POST', '/api/cards', () => made)
    window.location.hash = ''
    await board()
    await add()
    await waitFor(() => expect(created).toHaveLength(1))
    expect((await screen.findAllByText('On the board, in Ready.')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(window.location.hash).toBe('#/work/card-9')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('names the column the hub put it in', async () => {
    standInHub(() => hubState({ cards: [] }))
    standInRoute('POST', '/api/cards', () => ({ ...made, stage: 'proposed' }))
    await board()
    await add()
    expect((await screen.findAllByText('On the board, in Proposed.')).length).toBeGreaterThan(0)
  })

  it('says what went wrong, and not that it worked, when the hub refuses', async () => {
    standInHub(() => hubState({ cards: [] }))
    standInRoute('POST', '/api/cards', () => new Response(JSON.stringify({ error: 'No binder b1.' }), { status: 404 }))
    await board()
    await add()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No binder b1.'))
    expect(screen.queryByText(/On the board, in/)).toBeNull()
    expect(screen.getByRole('dialog', { name: 'New card' })).toBeTruthy()
  })
})
