// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, me, settle } from './harness'
import { phoneQuery } from '../src/components/bits'
import { parse, href } from '../src/route'
import type { UI } from '../src/ui'

// The Brain's own page: its name and address, the rail beside the conversation, the switch on a narrow screen, how the
// box sends, the starters, and the view an answer can carry. What an answer holds and how the conversation is kept are
// in askPage.test.tsx. The page keeps its conversation in the module, so each test loads a fresh one.

// The view is another piece's: stood in for here, with a button that asks something from it.
vi.mock('../src/brain/view/BrainView', async () => {
  const { createElement } = await import('react')
  const BrainView = ({ view, onAsk }: { view: unknown; onAsk?: (question: string) => void }) => createElement('button', { type: 'button', onClick: () => onAsk?.('And the rest?') }, `View ${JSON.stringify(view)}`)
  return { BrainView, default: BrainView }
})

const ui = (over: Partial<UI> = {}): UI => ({ openItem: () => {}, openPalette: () => {}, binder: 'b1', setBinder: () => {}, ...over })
const asNarrow = (query: string) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === query, media: q, addEventListener() {}, removeEventListener() {} }))
const now = () => new Date().toISOString()

/** A hub with a question waiting on you, one agent asking it, one working, one idle and one not running. */
const busy = () => hubState({
  cards: [
    card('c1', 'blocked', { title: 'Which way?', agentId: 'a1', needsYou: 'Left or right?', updatedAt: now() }),
    card('c2', 'working', { title: 'Being built', agentId: 'a2', updatedAt: now() }),
  ],
  agents: [
    { ...agent, id: 'a1', name: 'Asker', lastSeen: now() },
    { ...agent, id: 'a2', name: 'Builder', lastSeen: now() },
    { ...agent, id: 'a3', name: 'Resting', lastSeen: now() },
    { ...agent, id: 'a4', name: 'Away', lastSeen: '2020-01-01T00:00:00Z' },
  ],
})

/**
 * The Brain, loaded fresh against a hub whose state is `state`. `asked` has each question the hub was sent, and a
 * question is held until `release()` when `hold` is set.
 */
async function load(state = busy, over: { hold?: boolean; answer?: (question: string) => unknown } = {}) {
  vi.resetModules()
  const harness = await import('./harness')
  const { BrainScreen } = await import('../src/screens/Brain')
  const { UIContext } = await import('../src/ui')
  harness.standInHub(state, me)
  harness.standInRoute('GET', '/api/brain/conversation', () => ({ turns: [] }))
  let release = () => {}
  const held = new Promise<void>((done) => { release = done })
  const asked = harness.standInRoute('POST', '/api/brain/ask', async (body) => {
    if (over.hold) await held
    return (over.answer ?? ((question: string) => ({ answer: { text: '', parts: [{ text: `The answer to ${question}`, sources: [] }] }, sources: [], searchedBy: 'words' })))((body as { question: string }).question)
  }) as { question: string; everywhere: boolean }[]
  const show = (provide: UI = ui()) => harness.mount(<UIContext.Provider value={provide}><BrainScreen /></UIContext.Provider>)
  return { ...harness, show, asked, release }
}
const box = () => screen.getByRole('textbox', { name: 'Ask or tell the Brain' }) as HTMLTextAreaElement
const rail = () => within(screen.getByRole('complementary', { name: 'Now' }))

beforeEach(() => {
  window.location.hash = ''
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('the Brain’s name and address', () => {
  it('is Brain in the sidebar, the page’s title and the tab’s, at an address ending in /brain', async () => {
    const { mount, standInHub } = await import('./harness')
    standInHub(() => hubState(), me)
    const App = (await import('../src/App')).default
    window.location.hash = '#/brain'
    await mount(<App />)
    await settle(100)
    const link = within(screen.getAllByRole('navigation', { name: 'Screens' })[0]).getByRole('link', { name: /^Brain/ })
    expect(link.getAttribute('href')).toBe('#/brain')
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Brain')
    expect(document.title).toBe('Brain · Binders Hub')
  })

  it('still opens from the old address ending in /ask', async () => {
    expect(parse('#/ask')).toEqual({ screen: 'brain' })
    expect(parse('#/brain')).toEqual({ screen: 'brain' })
    expect(href({ screen: 'brain' })).toBe('#/brain')
    const { mount, standInHub } = await import('./harness')
    standInHub(() => hubState(), me)
    const App = (await import('../src/App')).default
    window.location.hash = '#/ask'
    await mount(<App />)
    await settle(100)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Brain')
    expect(screen.getByRole('log', { name: 'Conversation with the Brain' })).toBeTruthy()
  })
})

describe('the rail', () => {
  it('lists what needs you, and each agent with whether it is online and what it is doing', async () => {
    const { show } = await load()
    await show()
    const needs = rail().getByRole('region', { name: /^Needs you/ })
    expect(within(needs).getByRole('button', { name: /Which way\?/ }).textContent).toContain('Asker asks: Left or right?')
    const agents = rail().getByRole('region', { name: /^Agents/ })
    const line = (name: string) => within(agents).getByRole('link', { name: new RegExp(`^${name}`) }).textContent
    expect(line('Asker')).toContain('Online')
    expect(line('Asker')).toContain('Waiting on you: Which way?')
    expect(line('Builder')).toContain('Working on Being built')
    expect(line('Resting')).toContain('Idle')
    expect(line('Away')).toContain('Offline')
    expect(line('Away')).toContain('Idle')
    expect(within(agents).getAllByRole('link')[0].getAttribute('href')).toBe('#/agents')
  })

  it('has real headings, each with its count', async () => {
    const { show } = await load()
    await show()
    const headings = rail().getAllByRole('heading')
    expect(headings.map((h) => h.tagName)).toEqual(['H2', 'H2', 'H2'])
    expect(headings.map((h) => h.textContent)).toEqual(['Needs you 1', 'Agents 4', 'Came in 0'])
  })

  it('opens what needs you when its row is pressed', async () => {
    const { show } = await load()
    await show()
    fireEvent.click(rail().getByRole('button', { name: /Which way\?/ }))
    expect(window.location.hash).toBe('#/work/c1')
  })

  it('says so when nothing needs you and there are no agents', async () => {
    const { show } = await load(() => hubState({ cards: [], agents: [] }))
    await show()
    expect(rail().getByText('Nothing needs you.')).toBeTruthy()
    expect(rail().getByText('No agents yet.')).toBeTruthy()
    expect(rail().getAllByRole('heading').map((h) => h.textContent)).toEqual(['Needs you 0', 'Agents 0', 'Came in 0'])
  })
})

describe('on a narrow screen', () => {
  const narrow = () => asNarrow('(max-width: 1099px)')

  it('has no switch where the two fit side by side', async () => {
    const { show } = await load()
    await show()
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
    expect(screen.getByRole('log')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Now' })).toBeTruthy()
  })

  it('shows Talk or Now, one at a time, with how many need you beside Now', async () => {
    const { show } = await load()
    narrow()
    await show()
    const pick = within(screen.getByRole('group', { name: 'Show' }))
    expect(pick.getByRole('button', { name: 'Talk' }).getAttribute('aria-pressed')).toBe('true')
    expect(pick.getByRole('button', { name: 'Now 1' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('log')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Now' })).toBeNull()
    fireEvent.click(pick.getByRole('button', { name: 'Now 1' }))
    expect(screen.getByRole('complementary', { name: 'Now' })).toBeTruthy()
    expect(screen.queryByRole('log')).toBeNull()
    fireEvent.click(pick.getByRole('button', { name: 'Talk' }))
    expect(screen.getByRole('log')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Now' })).toBeNull()
  })

  it('does the same on a phone, and keeps what was typed while Now shows', async () => {
    const { show } = await load()
    asNarrow(phoneQuery)
    await show()
    fireEvent.change(box(), { target: { value: 'half a thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'Now 1' }))
    expect(screen.queryByRole('textbox', { name: 'Ask or tell the Brain' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Talk' }))
    expect(box().value).toBe('half a thought')
  })
})

describe('the box', () => {
  it('sends on Enter, and takes the words as a question', async () => {
    const { show, asked } = await load()
    await show()
    fireEvent.change(box(), { target: { value: 'Why Redis?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await screen.findByText('The answer to Why Redis?')
    expect(asked.map((a) => a.question)).toEqual(['Why Redis?'])
    expect(box().value).toBe('')
  })

  it('makes a new line on Shift+Enter and sends nothing', async () => {
    const { show, asked } = await load()
    await show()
    fireEvent.change(box(), { target: { value: 'One' } })
    const pressed = fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    // Not stopped, so the browser makes the new line.
    expect(pressed).toBe(true)
    await settle(50)
    expect(asked).toEqual([])
  })

  it('doesn’t send on the Enter that picks a word with an input method', async () => {
    const { show, asked } = await load()
    await show()
    fireEvent.change(box(), { target: { value: 'にほん' } })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    await settle(50)
    expect(asked).toEqual([])
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('sends nothing for an empty box, and nothing while a question is on its way', async () => {
    const { show, asked, release } = await load(busy, { hold: true })
    await show()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(asked).toEqual([])
    fireEvent.change(box(), { target: { value: 'First' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(asked).toHaveLength(1))
    fireEvent.keyDown(box(), { key: 'Enter' })
    await settle(50)
    expect(asked).toHaveLength(1)
    release()
  })
})

describe('before anything is asked', () => {
  it('says what it is, in a heading and a line', async () => {
    const { show } = await load()
    await show()
    expect(screen.getByRole('heading', { name: 'Brain' })).toBeTruthy()
    expect(screen.getByText(/It answers from your notes and cards/).textContent).toContain('it asks you first')
    expect(box().placeholder).toBe('Ask or tell the Brain…')
  })

  it('sends a starter’s words as the question, with the scope that is set', async () => {
    const { show, asked } = await load()
    await show()
    const starters = ['What needs me?', 'What are my agents working on?', 'What’s in review?', 'Draw how the open work fits together']
    for (const text of starters) expect(screen.getByRole('button', { name: text })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Every binder I’m in' }))
    fireEvent.click(screen.getByRole('button', { name: 'What needs me?' }))
    expect(await screen.findByText('The answer to What needs me?')).toBeTruthy()
    expect(asked).toEqual([{ question: 'What needs me?', everywhere: true, turns: [] }])
    // With something asked, the starters go.
    expect(screen.queryByRole('button', { name: 'What needs me?' })).toBeNull()
  })
})

describe('an answer’s view', () => {
  const withView = (question: string) => ({ answer: { text: '', parts: [{ text: `The answer to ${question}`, sources: [] }] }, sources: [], searchedBy: 'words', view: { kind: 'flow' } })

  it('is drawn under the answer’s words, by the view piece', async () => {
    const { show } = await load(busy, { answer: withView })
    await show()
    fireEvent.change(box(), { target: { value: 'Draw it' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    const drawn = await screen.findByRole('button', { name: 'View {"kind":"flow"}' })
    const words = screen.getByText('The answer to Draw it')
    expect(words.compareDocumentPosition(drawn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('draws nothing for an answer that has no view', async () => {
    const { show } = await load()
    await show()
    fireEvent.change(box(), { target: { value: 'Plain' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await screen.findByText('The answer to Plain')
    expect(screen.queryByRole('button', { name: /^View / })).toBeNull()
  })

  it('sends what is asked from it as the next question, with the scope that is set', async () => {
    const { show, asked } = await load(busy, { answer: withView })
    await show()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Every binder I’m in' }))
    fireEvent.change(box(), { target: { value: 'Draw it' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: /^View / }))
    await waitFor(() => expect(asked.map((a) => a.question)).toEqual(['Draw it', 'And the rest?']))
    expect(asked[1].everywhere).toBe(true)
  })

  it('isn’t sent while a question is already on its way', async () => {
    const { show, asked, release } = await load(busy, { answer: withView })
    await show()
    fireEvent.change(box(), { target: { value: 'Draw it' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    const drawn = await screen.findByRole('button', { name: /^View / })
    // A second question goes and is held there, so it's on its way when the view is pressed.
    const stand = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/brain/ask' ? new Promise<Response>(() => {}) : stand(url, init))))
    fireEvent.change(box(), { target: { value: 'Second' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await screen.findByText('Reading your notes and cards…')
    const before = vi.mocked(fetch).mock.calls.length
    fireEvent.click(drawn)
    await settle(50)
    expect(vi.mocked(fetch).mock.calls.length).toBe(before)
    expect(asked.map((a) => a.question)).toEqual(['Draw it'])
    release()
  })
})

describe('an answer’s sources', () => {
  const source = (n: number, title: string) => ({ n, binder: 'b1', binderName: 'Harbor', kind: 'note', id: `note-${n}`, title, text: `Words of ${title}`, url: `#/notes/note-${n}` })
  const found = [source(1, 'Pricing'), source(2, 'Renewals'), source(3, 'Refunds')]

  it('lists what the answer rests on, and folds away what was found and not used', async () => {
    const { show } = await load(busy, { answer: () => ({ answer: { text: '', parts: [{ text: 'Ten times the monthly price.', sources: [1] }] }, sources: found, searchedBy: 'words' }) })
    await show()
    fireEvent.change(box(), { target: { value: 'What is the annual price?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    const used = within((await screen.findByRole('heading', { name: 'Sources' })).nextElementSibling as HTMLElement)
    expect(used.getByRole('link', { name: /Pricing/ })).toBeTruthy()
    expect(used.queryByRole('link', { name: /Renewals/ })).toBeNull()
    const rest = screen.getByText('Also read').closest('details')!
    expect(rest.open).toBe(false)
    expect(within(rest.querySelector('summary')!).getByText('2')).toBeTruthy()
    expect(within(rest).getByText('Renewals')).toBeTruthy()
    expect(within(rest).getByText('Refunds')).toBeTruthy()
  })

  it('has no Sources heading when the answer cites nothing, only what was read', async () => {
    const { show } = await load(busy, { answer: () => ({ answer: { text: '', parts: [{ text: 'Four things need you.', sources: [] }] }, sources: found, searchedBy: 'words' }) })
    await show()
    fireEvent.change(box(), { target: { value: 'What needs me?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await screen.findByText('Four things need you.')
    expect(screen.queryByRole('heading', { name: 'Sources' })).toBeNull()
    expect(within(screen.getByText('Also read').closest('summary')!).getByText('3')).toBeTruthy()
  })

  it('shows every passage when there is no answer: they are the answer', async () => {
    const { show } = await load(busy, { answer: () => ({ sources: found, searchedBy: 'words' }) })
    await show()
    fireEvent.change(box(), { target: { value: 'pricing' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    const all = within((await screen.findByRole('heading', { name: 'Sources' })).nextElementSibling as HTMLElement)
    expect(all.getAllByRole('listitem').length).toBe(3)
    expect(screen.queryByText('Also read')).toBeNull()
  })
})

describe('Home’s waiting list, shared with the rail', () => {
  it('is the same as before: yours first, with what each is, and a press opens it', async () => {
    const { standInHub, mount } = await import('./harness')
    const { Home } = await import('../src/screens/Home')
    standInHub(busy, me)
    await mount(<Home />)
    const list = within(screen.getByRole('region', { name: 'Waiting on you' }))
    expect(list.getByRole('heading', { name: 'For you' })).toBeTruthy()
    const row = list.getByRole('button', { name: /Which way\?/ })
    expect(row.textContent).toContain('Asker asks: Left or right?')
    expect(row.closest('ul')?.className).toBe('waiting')
    fireEvent.click(row)
    expect(window.location.hash).toBe('#/work/c1')
  })

  it('says nothing is waiting when nothing is', async () => {
    const { standInHub, mount } = await import('./harness')
    const { Home } = await import('../src/screens/Home')
    standInHub(() => hubState({ cards: [] }), me)
    await mount(<Home />)
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy()
  })
})
