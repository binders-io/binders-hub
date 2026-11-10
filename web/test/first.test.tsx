// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, card, entry, hear, hubState, me, mount, standInHub, standInRoute } from './harness'
import { NeedsYou } from '../src/brain/rail/NeedsYou'
import { Home } from '../src/screens/Home'
import { UIContext } from '../src/ui'
import type { Draft, Gathered } from '../src/data/first'

// What the Brain drafted for the cards that wait on you, under their rows in the list of what waits (Home's list and the
// Brain's "Needs you" draw it the same way), and the cards that wait for the same thing as one row.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const home = () => <UIContext.Provider value={ui}><Home /></UIContext.Provider>
const asks = (n: number, question = 'Left or right?') => Array.from({ length: n }, (_, i) => card(`c${i + 1}`, 'blocked', { title: `Card ${i + 1}`, agentId: 'a1', needsYou: question }))
const draft = (over: Partial<Draft> = {}): Draft => ({ card: 'c1', for: 'you', kind: 'answer', words: 'Use the left one.', sources: [], at: 'now', ...over })
const group = (over: Partial<Gathered> = {}): Gathered => ({ key: 'g1', why: 'question', title: 'Left or right?', cards: ['c1', 'c2', 'c3'], ...over })

/** A hub with `n` cards asking you, the Brain's `view`, and what it's sent: the calls to send and to stop. */
function setup(n: number, view: { drafts?: Draft[]; gathered?: Gathered[] }, who: unknown = me, cards = asks(n)) {
  standInHub(() => hubState({ agents: [{ ...agent, lastSeen: new Date().toISOString() }], cards }), who)
  const current = { view }
  const loads = standInRoute('GET', '/api/brain/first', () => ({ drafts: current.view.drafts ?? [], gathered: current.view.gathered ?? [] }))
  const sent = standInRoute('POST', '/api/brain/first/send', () => ({ sent: 1 })) as { cards: string[]; words: string }[]
  const stopped = standInRoute('POST', '/api/brain/first/stop', () => ({ stopped: 1 })) as { cards: string[] }[]
  return { current, loads, sent, stopped }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('a draft answer under a card', () => {
  const view = { drafts: [draft({ sources: [{ kind: 'note', id: 'n1', title: 'The plan' }, { kind: 'card', id: 'c2', title: 'Other card' }] })] }

  it('shows under its row, from the Brain, with the notes and cards it rests on as links', async () => {
    setup(2, view)
    await mount(home())
    const block = await screen.findByRole('region', { name: 'The Brain would answer' })
    expect(within(block).getByText('Use the left one.')).toBeTruthy()
    expect(within(block).getByText('From')).toBeTruthy()
    expect(within(block).getByRole('link', { name: 'The plan' }).getAttribute('href')).toBe('#/notes/n1')
    expect(within(block).getByRole('link', { name: 'Other card' }).getAttribute('href')).toBe('#/work/c2')
    // Only the card it is for has one, and it sits in that card's row.
    expect(screen.getAllByRole('region', { name: 'The Brain would answer' })).toHaveLength(1)
    expect(block.closest('li')?.querySelector('button')?.textContent).toContain('Card 1')
  })

  it('is sent as it is when Send is pressed', async () => {
    const { sent } = setup(2, view)
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(sent).toEqual([{ cards: ['c1'], words: 'Use the left one.' }]))
    expect(await screen.findByText('Sent.')).toBeTruthy()
  })

  it('disables its buttons while it is sending', async () => {
    const { sent } = setup(2, view)
    let release = () => {}
    const held = new Promise<void>((done) => { release = done })
    standInRoute('POST', '/api/brain/first/send', async (body) => { sent.push(body as never); await held; return { sent: 1 } })
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true)
    release()
    expect(await screen.findByText('Sent.')).toBeTruthy()
  })

  it('lets the words be changed before they are sent, and Enter adds a line rather than sending', async () => {
    const { sent } = setup(2, view)
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const box = screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement
    expect(box.value).toBe('Use the left one.')
    fireEvent.change(box, { target: { value: 'Use the right one.\nIt is newer.' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(sent).toEqual([{ cards: ['c1'], words: 'Use the right one.\nIt is newer.' }]))
  })

  it('goes back to the draft when Cancel is pressed in the box', async () => {
    const { sent } = setup(2, view)
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Something else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Use the left one.')).toBeTruthy()
    expect(sent).toEqual([])
  })

  it('says in place why the hub refused, and keeps the draft to try again', async () => {
    setup(2, view)
    standInRoute('POST', '/api/brain/first/send', () => new Response(JSON.stringify({ error: 'None of those is waiting any more.' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('None of those is waiting any more.')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps a long draft to a few lines with More to see the rest', async () => {
    setup(2, { drafts: [draft({ words: 'one\ntwo\nthree\nfour\nfive' })] })
    await mount(home())
    const more = await screen.findByRole('button', { name: 'More' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(screen.getByRole('button', { name: 'Less' }).getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.first-words')?.classList.contains('open')).toBe(true)
  })

  it('is in the Brain’s rail too', async () => {
    const { sent } = setup(2, view)
    await mount(<NeedsYou />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(sent).toEqual([{ cards: ['c1'], words: 'Use the left one.' }]))
  })
})

describe('a note that another try will probably pass, and one that is yours to decide', () => {
  it('shows the Brain’s line with a Try again button that sends “Try again.” to that card', async () => {
    const { sent } = setup(2, { drafts: [draft({ kind: 'again', words: 'The model was busy; another try will probably pass.' })] })
    await mount(home())
    expect(await screen.findByText('The model was busy; another try will probably pass.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(sent).toEqual([{ cards: ['c1'], words: 'Try again.' }]))
  })

  it('shows one quiet line and no button', async () => {
    setup(1, { drafts: [draft({ kind: 'yours', words: 'It is a choice of taste.' })] })
    await mount(home())
    const line = await screen.findByText('Yours to decide: It is a choice of taste.')
    const block = line.closest('.first') as HTMLElement
    expect(within(block).queryByRole('button')).toBeNull()
  })
})

describe('cards that ask the same thing', () => {
  const asked = { gathered: [group()] }

  it('are one row that says how many, with the question, and lists the cards when opened', async () => {
    setup(3, asked)
    await mount(home())
    expect(await screen.findByText('3 cards ask the same thing')).toBeTruthy()
    // Their rows are not drawn on their own: they are inside the disclosure.
    const details = document.querySelector('details.first-cards') as HTMLDetailsElement
    expect(screen.getByRole('region', { name: 'Waiting on you' }).querySelector('ul.waiting')!.children).toHaveLength(1)
    expect(details.open).toBe(false)
    fireEvent.click(within(details).getByText('Show the 3 cards'))
    expect(details.open).toBe(true)
    expect(within(details).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('Card 1'), expect.stringContaining('Card 2'), expect.stringContaining('Card 3'),
    ])
    fireEvent.click(within(details).getByRole('button', { name: /Card 2/ }))
    expect(window.location.hash).toBe('#/work/c2')
  })

  it('has one draft for all of them, which Send to all 3 puts to every card', async () => {
    const { sent } = setup(3, { ...asked, drafts: [draft({ card: 'c2' })] })
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Send to all 3' }))
    await waitFor(() => expect(sent).toEqual([{ cards: ['c1', 'c2', 'c3'], words: 'Use the left one.' }]))
  })

  it('has Answer all 3, which opens a box, when the Brain has no draft', async () => {
    const { sent } = setup(3, asked)
    await mount(home())
    fireEvent.click(await screen.findByRole('button', { name: 'Answer all 3' }))
    const send = screen.getByRole('button', { name: 'Send to all 3' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer to all 3' }), { target: { value: 'Left.' } })
    fireEvent.click(send)
    await waitFor(() => expect(sent).toEqual([{ cards: ['c1', 'c2', 'c3'], words: 'Left.' }]))
  })

  it('leave a lone card as an ordinary row', async () => {
    setup(1, { gathered: [group({ cards: ['c1', 'c9'] })] })
    await mount(home())
    expect(await within(await screen.findByRole('region', { name: 'Waiting on you' })).findByRole('button', { name: /Card 1/ })).toBeTruthy()
    expect(screen.queryByText(/ask the same thing/)).toBeNull()
  })
})

describe('three or more cards from one note', () => {
  const fromNote = { gathered: [group({ why: 'note', title: 'The plan' })], drafts: [draft({ card: 'c2', kind: 'again', words: 'Another try will probably pass.' })] }

  it('are one row with each card’s own draft inside, and Stop all 3 that asks before it stops them', async () => {
    const { stopped } = setup(3, fromNote)
    await mount(home())
    expect(await screen.findByText('3 cards from “The plan” are waiting on you')).toBeTruthy()
    expect(screen.getByText('Stopping moves them to Proposed, where no agent picks them up.')).toBeTruthy()
    const details = document.querySelector('details.first-cards') as HTMLDetailsElement
    expect(within(details).getAllByRole('button', { name: /Card/ })).toHaveLength(3)
    expect(within(details).getByText('Another try will probably pass.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop all 3' }))
    expect(stopped).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Stop all 3? Press again' }))
    await waitFor(() => expect(stopped).toEqual([{ cards: ['c1', 'c2', 'c3'] }]))
    expect(await screen.findByText('Stopped.')).toBeTruthy()
  })
})

describe('someone who can only read the Binder', () => {
  it('sees the drafts and no buttons', async () => {
    setup(3, { drafts: [draft({ card: 'c1' }), draft({ card: 'c2', kind: 'again', words: 'Try once more.' })], gathered: [group({ why: 'note', title: 'The plan' })] }, { ...me, role: 'reader' })
    await mount(home())
    expect(await screen.findByText('Use the left one.')).toBeTruthy()
    expect(screen.getByText('Try once more.')).toBeTruthy()
    for (const name of ['Send', 'Edit', 'Try again', 'Stop all 3', 'Answer all 3']) expect(screen.queryByRole('button', { name })).toBeNull()
  })
})

describe('keeping the drafts fresh', () => {
  it('asks again when the hub says a draft is ready', async () => {
    const { current, loads } = setup(2, {})
    await mount(home())
    await waitFor(() => expect(loads.length).toBeGreaterThan(0))
    expect(screen.queryByRole('region', { name: 'The Brain would answer' })).toBeNull()
    const before = loads.length
    current.view = { drafts: [draft()] }
    await hear({ type: 'first' })
    expect(await screen.findByText('Use the left one.')).toBeTruthy()
    expect(loads.length).toBe(before + 1)
  })

  it('asks again when the set of waiting cards changes', async () => {
    const { loads } = setup(1, {}, me, [...asks(1), card('c2')])
    await mount(home())
    await waitFor(() => expect(loads.length).toBeGreaterThan(0))
    const before = loads.length
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.update', id: 'c2', fields: { needsYou: 'Which name?', stage: 'blocked', agentId: 'a1' } })] })
    await waitFor(() => expect(loads.length).toBe(before + 1))
  })
})

describe('with nothing drafted', () => {
  it('is the list as it was: a button for each row and nothing else', async () => {
    setup(2, { drafts: [], gathered: [] })
    await mount(home())
    const list = screen.getByRole('region', { name: 'Waiting on you' })
    await waitFor(() => expect(within(list).getByRole('button', { name: /Card 1/ })).toBeTruthy())
    expect(list.querySelectorAll('.first, .first-group, details.first-cards')).toHaveLength(0)
    expect([...list.querySelectorAll('ul.waiting > li')].map((li) => li.children.length)).toEqual([1, 1])
  })

  it('still lists what waits when the hub has no drafts to give', async () => {
    setup(1, {})
    standInRoute('GET', '/api/brain/first', () => new Response(JSON.stringify({ error: 'No.' }), { status: 404 }))
    await mount(home())
    expect(await within(await screen.findByRole('region', { name: 'Waiting on you' })).findByRole('button', { name: /Card 1/ })).toBeTruthy()
    expect(document.querySelector('.first')).toBeNull()
  })
})
