// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, entry, hear, hubState, mount, settle, standInHub } from './harness'
import type { Card, ChangeSet, Proposal } from '../src/data/model'
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
    press('Hide proposed')
    await waitFor(() => expect(screen.queryByText('First idea')).toBeNull()) // It animates out.
    expect(within(column('Proposed')).getByText('An agent’s suggestion')).toBeTruthy()
    expect(headerCount()).toBe('1')
    expect(chipCount()).toBe('1')
    press('Show 2 proposed')
    expect(within(column('Proposed')).getByText('First idea')).toBeTruthy()
    // What came from a note says so; the old word for it is gone.
    expect(within(column('Proposed')).getAllByText('From a note')).toHaveLength(2)
    expect(screen.queryByText('Distilled')).toBeNull()
    expect(headerCount()).toBe('3')
    expect(chipCount()).toBe('3')
  })

  it('says what’s hidden when that leaves the column empty', async () => {
    standInHub(withBoard([]))
    await open()
    press('Hide proposed')
    expect(within(column('Proposed')).getByText('2 proposed hidden')).toBeTruthy()
    expect(within(column('Ready')).getByText('Nothing here')).toBeTruthy()
  })

  it('remembers in this browser, and shows them to anyone who hasn’t chosen', async () => {
    standInHub(withBoard([]))
    await open()
    expect(within(column('Proposed')).getByText('First idea')).toBeTruthy()
    press('Hide proposed')
    cleanup()
    await open()
    expect(screen.queryByText('First idea')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show 2 proposed' })).toBeTruthy()
  })

  it('draws no card when they’re hidden', async () => {
    standInHub(withBoard([card('An agent’s suggestion', 'proposed'), card('Ready one')]))
    await open()
    await settle(50)
    const before = { ...drawn.cards }
    press('Hide proposed')
    expect(drawn.cards['Ready one']).toBe(before['Ready one'])
  })

  it('offers nothing to hide when nothing is waiting in this binder', async () => {
    standInHub(() => hubState({ proposals: [proposal('Dismissed', { state: 'dismissed' }), proposal('Elsewhere', { binderId: 'b2' })] }))
    await open()
    expect(screen.queryByRole('button', { name: /proposed/ })).toBeNull()
  })
})

describe('what waits on you, at the top of the board', () => {
  const mine = { ...agent, name: 'Mine' }
  const sams = { ...agent, id: 'a2', name: 'Sam’s', owner: 'sam' }
  const strip = () => document.querySelector('.attention') as HTMLElement
  const open = (binder = 'all') => mount(<UIContext.Provider value={ui(binder)}><Flow /></UIContext.Provider>)
  const set: ChangeSet = { id: 'cs1', binderId: 'b1', number: 4, title: 'Login work', summary: '', state: 'review', prIds: ['o/r#1'], noteIds: [] }
  const env = (name: string, order: number, over: object = {}) => ({ id: `o/r#${name}`, repo: 'o/r', name, url: '', version: '1.0', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order, ...over })

  it('says an agent of yours asks, and goes to the card, as Home does', async () => {
    window.location.hash = ''
    standInHub(() => hubState({ agents: [mine], cards: [card('q1', 'blocked', { agentId: 'a1', needsYou: 'Left or right?', title: 'Which one' })] }))
    await open()
    fireEvent.click(within(strip()).getByRole('button', { name: /Mine asks you/ }))
    expect(window.location.hash).toBe('#/work/q1')
  })

  it('leaves out a question that’s on someone else, which Home folds away', async () => {
    standInHub(() => hubState({ agents: [mine, sams], cards: [card('Sam’s question', 'blocked', { agentId: 'a2', needsYou: 'Up or down?', createdBy: 'sam' })] }))
    await open()
    expect(within(strip()).queryByText(/asks you/)).toBeNull()
    expect(within(strip()).queryByText('Sam’s question')).toBeNull()
  })

  it('counts two questions in one button, going to the first', async () => {
    window.location.hash = ''
    standInHub(() => hubState({ agents: [mine], cards: [card('first', 'blocked', { agentId: 'a1', needsYou: 'A?', updatedAt: '2026-11-01T00:00:00.000Z' }), card('second', 'blocked', { agentId: 'a1', needsYou: 'B?', updatedAt: '2026-11-02T00:00:00.000Z' })] }))
    await open()
    fireEvent.click(within(strip()).getByRole('button', { name: /2 questions for you/ }))
    expect(window.location.hash).toBe('#/work/first')
  })

  it('has a change set that’s ready to approve, and opens it', async () => {
    window.location.hash = ''
    standInHub(() => hubState({ changeSets: [set] }))
    await open()
    fireEvent.click(within(strip()).getByRole('button', { name: /Change set #4: Login work/ }))
    expect(window.location.hash).toBe('#/changes/cs1')
  })

  it('has no change set that’s still assembling with work left on it', async () => {
    standInHub(() => hubState({ changeSets: [{ ...set, state: 'assembling' }], pulls: [{ id: 'o/r#1', repo: 'o/r', number: 1, checks: [] }] as never, cards: [card('Still going', 'working', { prId: 'o/r#1' })] }))
    await open()
    expect(within(strip()).queryByText(/Change set/)).toBeNull()
  })

  it('has a promotion Promote can make, and goes to Delivery', async () => {
    window.location.hash = ''
    standInHub(() => hubState({ environments: [env('staging', 0, { version: '1.1' }), env('production', 1, { needsApproval: true, deploy: { repo: 'o/r', workflow: 'deploy.yml', ref: 'main' } })] as never }))
    await open()
    fireEvent.click(within(strip()).getByRole('button', { name: /Promote 1\.1 to production/i }))
    expect(window.location.hash).toBe('#/delivery')
  })

  it('has nothing for an environment that only differs, with no workflow to promote with', async () => {
    standInHub(() => hubState({ environments: [env('staging', 0, { version: '1.1' }), env('production', 1, { needsApproval: true })] as never }))
    await open()
    expect(within(strip()).queryByText(/Promote/)).toBeNull()
  })
})
