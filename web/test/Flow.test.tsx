// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, entry, hear, hubState, mount, settle, standInHub } from './harness'
import type { Card, Proposal } from '../src/data/model'
import { UIContext } from '../src/ui'
import { Flow } from '../src/screens/Flow'

// The menu sits inside every card, so it draws when its card does: that's what's counted here.
const drawn = vi.hoisted(() => ({ cards: {} as Record<string, number> }))
vi.mock('../src/components/CardMenu', () => ({
  CardMenu: ({ card: { id } }: { card: { id: string } }) => {
    drawn.cards[id] = (drawn.cards[id] ?? 0) + 1
    return null
  },
  cardMenuItems: () => [],
}))

const board = () => hubState({
  binders: [{ id: 'b1', name: 'Binder' }, { id: 'b2', name: 'Other' }],
  cards: [card('Ready one'), card('Blocked by a person', 'blocked'), card('Paused', 'blocked', { agentId: 'a1' }), card('Under review', 'review'), card('Elsewhere', 'ready', { binderId: 'b2' })],
})

const ui = (binder = 'all') => ({ openItem: () => {}, openPalette: () => {}, binder, setBinder: () => {} })
const column = (name: string) => screen.getByRole('region', { name })
const dataTransfer = { setData() {}, getData: () => '', types: [], effectAllowed: '' }
const cardNamed = (name: string) => screen.getByText(name).closest('.card-drag')!

let posted: ReturnType<typeof standInHub>['posted']

beforeEach(() => {
  drawn.cards = {}
  ;({ posted } = standInHub(board))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the board', () => {
  it('puts each card in its stage, in the binder you’re in', async () => {
    await mount(<UIContext.Provider value={ui('b1')}><Flow /></UIContext.Provider>)
    expect(within(column('Ready')).getByText('Ready one')).toBeTruthy()
    expect(within(column('In review')).getByText('Under review')).toBeTruthy()
    expect(screen.queryByText('Elsewhere')).toBeNull()
    expect(within(column('Agents working')).getByText('Nothing here')).toBeTruthy()
  })

  it('shows a card’s Jira key in place of its change set’s number', async () => {
    standInHub(() => hubState({
      changeSets: [{ id: 'cs1', number: 7, title: 'A set', state: 'open', binderId: 'b1', prIds: ['p1', 'p2'] }] as never,
      pulls: [{ id: 'p1', repo: 'o/r', number: 1, checks: [] }, { id: 'p2', repo: 'o/r', number: 2, checks: [] }] as never,
      cards: [card('In Jira', 'review', { prId: 'p1', jira: { key: 'PROJ-12', url: 'https://acme.atlassian.net/browse/PROJ-12' } }), card('Not in Jira', 'review', { prId: 'p2' })],
    }))
    await mount(<UIContext.Provider value={ui('b1')}><Flow /></UIContext.Provider>)
    expect(screen.getByText('PROJ-12')).toBeTruthy()
    expect(screen.getAllByText('CS-7')).toHaveLength(1)
    expect(within(screen.getByText('In Jira').closest('.card')! as HTMLElement).queryByText('CS-7')).toBeNull()
  })

  it('moves a card dropped on another column, and takes it from its agent', async () => {
    await mount(<UIContext.Provider value={ui()}><Flow /></UIContext.Provider>)
    fireEvent.dragStart(cardNamed('Paused'), { dataTransfer })
    fireEvent.dragOver(column('Ready'), { dataTransfer })
    expect(column('Ready').className).toContain('drop')
    fireEvent.drop(column('Ready'), { dataTransfer })
    expect(column('Ready').className).not.toContain('drop')
    await settle()
    expect(posted.flatMap((p) => p.changes)[0].change).toMatchObject({ type: 'card.update', id: 'Paused', fields: { stage: 'ready', agentId: null } })
  })

  it('doesn’t take a drop on Agents working: agents take cards themselves', async () => {
    await mount(<UIContext.Provider value={ui()}><Flow /></UIContext.Provider>)
    fireEvent.dragStart(cardNamed('Ready one'), { dataTransfer })
    fireEvent.dragOver(column('Agents working'), { dataTransfer })
    expect(column('Agents working').className).not.toContain('drop')
  })

  it('takes a card back to Agents working only when an agent holds it, blocked', async () => {
    await mount(<UIContext.Provider value={ui()}><Flow /></UIContext.Provider>)
    fireEvent.dragStart(cardNamed('Blocked by a person'), { dataTransfer })
    fireEvent.dragOver(column('Agents working'), { dataTransfer })
    expect(column('Agents working').className).not.toContain('drop')
    fireEvent.dragEnd(cardNamed('Blocked by a person'), { dataTransfer })
    fireEvent.dragStart(cardNamed('Paused'), { dataTransfer })
    fireEvent.dragOver(column('Agents working'), { dataTransfer })
    expect(column('Agents working').className).toContain('drop')
  })

  it('draws only the card that changed when an agent reports', async () => {
    await mount(<UIContext.Provider value={ui()}><Flow /></UIContext.Provider>)
    await settle(50)
    const before = { ...drawn.cards }
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'Ready one', fields: { doing: 'Reading' } })] })
    expect(drawn.cards['Ready one']).toBeGreaterThan(before['Ready one'])
    expect(drawn.cards['Under review']).toBe(before['Under review'])
    expect(drawn.cards.Paused).toBe(before.Paused)
  })

  it('draws no card while one is dragged over a column', async () => {
    await mount(<UIContext.Provider value={ui()}><Flow /></UIContext.Provider>)
    await settle(50)
    const before = { ...drawn.cards }
    fireEvent.dragStart(cardNamed('Paused'), { dataTransfer })
    fireEvent.dragOver(column('Ready'), { dataTransfer })
    fireEvent.dragOver(column('In review'), { dataTransfer })
    expect(drawn.cards).toEqual(before)
  })
})

describe('what Distill proposed', () => {
  const proposal = (id: string, over: Partial<Proposal> = {}): Proposal => ({ id, binderId: 'b1', noteId: 'n1', title: id, quote: '', brief: '', doneWhen: '', size: 'S', by: 'a1', state: 'new', ...over })
  const waiting = [proposal('First idea'), proposal('Second idea'), proposal('In the other binder', { binderId: 'b2' }), proposal('Already dismissed', { state: 'dismissed' })]
  const withBoard = (cards: Card[]) => () => hubState({ binders: [{ id: 'b1', name: 'Binder' }, { id: 'b2', name: 'Other' }], cards, proposals: waiting })
  const open = () => mount(<UIContext.Provider value={ui('b1')}><Flow /></UIContext.Provider>)
  const headerCount = () => column('Proposed').querySelector('header .num')?.textContent
  const chipCount = () => document.querySelector('.stage-chips .num')?.textContent
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  it('sets them aside and brings them back, and leaves an agent’s card where it is', async () => {
    standInHub(withBoard([card('An agent’s suggestion', 'proposed')]))
    await open()
    expect(headerCount()).toBe('3')
    press('Hide distilled')
    await waitFor(() => expect(screen.queryByText('First idea')).toBeNull()) // It animates out.
    expect(within(column('Proposed')).getByText('An agent’s suggestion')).toBeTruthy()
    expect(headerCount()).toBe('1')
    expect(chipCount()).toBe('1')
    press('Show 2 distilled')
    expect(within(column('Proposed')).getByText('First idea')).toBeTruthy()
    expect(headerCount()).toBe('3')
    expect(chipCount()).toBe('3')
  })

  it('says what’s hidden when that leaves the column empty', async () => {
    standInHub(withBoard([]))
    await open()
    press('Hide distilled')
    expect(within(column('Proposed')).getByText('2 distilled hidden')).toBeTruthy()
    expect(within(column('Ready')).getByText('Nothing here')).toBeTruthy()
  })

  it('remembers in this browser, and shows them to anyone who hasn’t chosen', async () => {
    standInHub(withBoard([]))
    await open()
    expect(within(column('Proposed')).getByText('First idea')).toBeTruthy()
    press('Hide distilled')
    cleanup()
    await open()
    expect(screen.queryByText('First idea')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show 2 distilled' })).toBeTruthy()
  })

  it('draws no card when they’re hidden', async () => {
    standInHub(withBoard([card('An agent’s suggestion', 'proposed'), card('Ready one')]))
    await open()
    await settle(50)
    const before = { ...drawn.cards }
    press('Hide distilled')
    expect(drawn.cards['Ready one']).toBe(before['Ready one'])
  })

  it('offers nothing to hide when nothing is waiting in this binder', async () => {
    standInHub(() => hubState({ proposals: [proposal('Dismissed', { state: 'dismissed' }), proposal('Elsewhere', { binderId: 'b2' })] }))
    await open()
    expect(screen.queryByRole('button', { name: /distilled/ })).toBeNull()
  })
})
