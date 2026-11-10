// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import type { Proposal } from '../src/data/model'
import { Flow } from '../src/screens/Flow'
import { UIContext } from '../src/ui'

// A proposal on the board: read before it’s accepted, accepted into Ready, taken in Proposed to fix first, or dismissed
// and put back.

const proposal = (over: Partial<Proposal> = {}): Proposal => ({ id: 'p1', binderId: 'b1', noteId: 'n1', title: 'Add dark mode', quote: 'we should add a dark mode', brief: 'Follow the system setting.', doneWhen: 'It switches with the system.', size: 'L', by: 'a1', state: 'new', ...over })
const openItem = vi.fn()
const ui = { openItem, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const board = () => mount(<UIContext.Provider value={ui}><Flow /><Toast /></UIContext.Provider>)
const withProposal = (over: Partial<Proposal> = {}) => () => hubState({ cards: [], proposals: [proposal(over)] })
const changes = (posted: ReturnType<typeof standInHub>['posted']) => posted.flatMap((batch) => batch.changes.map((c) => c.change))
const proposed = () => screen.getByRole('region', { name: 'Proposed' })
const made = card('card-9', 'ready', { title: 'Add dark mode' })

afterEach(() => {
  cleanup()
  openItem.mockClear()
  vi.unstubAllGlobals()
})

describe('reading a proposal in place', () => {
  it('shows its title, closed, with Accept, Edit first and Dismiss', async () => {
    standInHub(withProposal())
    await board()
    const title = within(proposed()).getByRole('button', { name: 'Add dark mode' })
    expect(title.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Follow the system setting.')).toBeNull()
    for (const name of ['Accept', 'Edit first', 'Dismiss']) expect(within(proposed()).getByRole('button', { name })).toBeTruthy()
  })

  it('opens on its title to show the brief, done-when, size, the note’s words and a link to the note, and closes again', async () => {
    standInHub(withProposal())
    await board()
    const title = within(proposed()).getByRole('button', { name: 'Add dark mode' })
    fireEvent.click(title)
    expect(title.getAttribute('aria-expanded')).toBe('true')
    const body = document.getElementById(title.getAttribute('aria-controls')!)!
    expect(within(body).getByText('Follow the system setting.')).toBeTruthy()
    expect(within(body).getByText('It switches with the system.')).toBeTruthy()
    expect(within(body).getByText('Large')).toBeTruthy()
    expect(within(body).getByText('we should add a dark mode')).toBeTruthy()
    expect(within(body).getByRole('link', { name: /n1/ }).getAttribute('href')).toBe('#/notes/n1')
    fireEvent.click(title)
    expect(screen.queryByText('Follow the system setting.')).toBeNull()
  })

  it('says when it has no brief, and leaves out a done-when and note words it hasn’t got', async () => {
    standInHub(withProposal({ brief: '', doneWhen: '', quote: '' }))
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Add dark mode' }))
    expect(screen.getByText('No brief.')).toBeTruthy()
    expect(screen.queryByText('Done when')).toBeNull()
    expect(screen.queryByText('From the note')).toBeNull()
  })
})

describe('Accept', () => {
  it('says where the card went, with a button that opens it', async () => {
    standInHub(withProposal())
    const accepted = standInRoute('POST', '/api/proposals/p1/accept', () => made)
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(accepted).toHaveLength(1))
    expect((await screen.findAllByText('On the board, in Ready.')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(openItem).toHaveBeenCalledWith('card-9')
  })

  it('says what the hub said, and not that it worked, when it refuses', async () => {
    standInHub(withProposal())
    standInRoute('POST', '/api/proposals/p1/accept', () => new Response(JSON.stringify({ error: 'That proposal was already accepted or dismissed.' }), { status: 409 }))
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That proposal was already accepted or dismissed.'))
    expect(screen.queryByText('On the board, in Ready.')).toBeNull()
  })
})

describe('Dismiss', () => {
  it('says so, and Undo puts the proposal back as it was', async () => {
    const { posted } = standInHub(withProposal())
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Dismiss' }))
    expect((await screen.findAllByText('Dismissed.')).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add dark mode' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await within(proposed()).findByRole('button', { name: 'Add dark mode' })).toBeTruthy()
    // What the hub ends up with is that it's new again.
    await waitFor(() => expect(changes(posted).filter((c) => c.type === 'proposal.update').at(-1)).toEqual({ type: 'proposal.update', id: 'p1', fields: { state: 'new' } }))
  })
})

describe('Edit first', () => {
  it('makes the card in Proposed, where no agent takes it, links the proposal to it and opens its page', async () => {
    const { posted } = standInHub(withProposal({ meantFor: 'a1' }))
    const created = standInRoute('POST', '/api/cards', () => ({ ...made, stage: 'proposed' }))
    const accepted = standInRoute('POST', '/api/proposals/p1/accept')
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Edit first' }))
    await waitFor(() => expect(openItem).toHaveBeenCalledWith('card-9'))
    expect(created).toEqual([{ binderId: 'b1', title: 'Add dark mode', brief: 'Follow the system setting.', doneWhen: 'It switches with the system.', size: 'L', meantFor: 'a1', noteId: 'n1', quote: 'we should add a dark mode', stage: 'proposed' }])
    expect(accepted).toHaveLength(0)
    await waitFor(() => expect(changes(posted).filter((c) => c.type === 'proposal.update')).toEqual([
      { type: 'proposal.update', id: 'p1', fields: { state: 'accepted' } },
      { type: 'proposal.update', id: 'p1', fields: { cardId: 'card-9' } },
    ]))
    // No card change: it was made in Proposed.
    expect(changes(posted).some((c) => c.type === 'card.update')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Add dark mode' })).toBeNull()
  })

  it('moves the card to Proposed itself when the hub made it Ready', async () => {
    const { posted } = standInHub(withProposal())
    standInRoute('POST', '/api/cards', () => made)
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Edit first' }))
    await waitFor(() => expect(openItem).toHaveBeenCalledWith('card-9'))
    await waitFor(() => expect(changes(posted).find((c) => c.type === 'card.update')).toMatchObject({ type: 'card.update', id: 'card-9', fields: { stage: 'proposed' } }))
  })

  it('puts the proposal back and says why when the card can’t be made', async () => {
    const { posted } = standInHub(withProposal())
    standInRoute('POST', '/api/cards', () => new Response(JSON.stringify({ error: 'No binder b1.' }), { status: 404 }))
    await board()
    fireEvent.click(within(proposed()).getByRole('button', { name: 'Edit first' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No binder b1.'))
    expect(openItem).not.toHaveBeenCalled()
    expect(await within(proposed()).findByRole('button', { name: 'Add dark mode' })).toBeTruthy()
    await waitFor(() => expect(changes(posted).filter((c) => c.type === 'proposal.update').map((c) => (c as { fields: { state?: string } }).fields.state)).toEqual(['accepted', 'new']))
  })
})
