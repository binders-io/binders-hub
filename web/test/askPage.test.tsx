// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { phoneQuery } from '../src/components/bits'
import type { UI } from '../src/ui'

// Ask keeps what was asked and answered in this visit, and an answer can become a note or a card. Home has a line that
// takes a question there. What's kept lives in the module, so each test loads a fresh one: a reload, in effect.

const source = (n: number, over: object = {}) => ({ n, binder: 'b2', binderName: 'Other', kind: 'note', id: `n${n}`, title: `Note ${n}`, text: `Passage ${n}.`, url: `#/notes/n${n}`, ...over })
const ui = (over: Partial<UI> = {}): UI => ({ openItem: () => {}, openPalette: () => {}, binder: 'b2', setBinder: () => {}, ...over })

/** The app's pieces, loaded fresh, against a hub with two binders that answers each question with a line of its own. */
async function load(answer: (question: string) => unknown = (question) => ({ answer: { text: '', parts: [{ text: `The answer to ${question}`, sources: [1, 2] }] }, sources: [source(1), source(2, { kind: 'card', id: 'c1', title: 'Fix [it]', url: '#/work/c1' }), source(3, { binder: 'b1', binderName: 'Binder', title: 'Far away', url: 'https://hub.test/b1/#/notes/n3' })], searchedBy: 'words and meaning', model: 'stand-in' })) {
  vi.resetModules()
  const harness = await import('./harness')
  const { Ask } = await import('../src/screens/Ask')
  const { UIContext } = await import('../src/ui')
  const { standInRoute } = harness
  harness.standInHub(() => harness.hubState({ binders: [{ id: 'b1', name: 'Binder' }, { id: 'b2', name: 'Other' }] }))
  const asked = standInRoute('POST', '/api/brain/ask', (body) => answer((body as { question: string }).question)) as { question: string; everywhere: boolean }[]
  const mountAsk = (provide: UI = ui(), props: { asked?: { question: string; at: number } } = {}) => harness.mount(<UIContext.Provider value={provide}><Ask {...props} /></UIContext.Provider>)
  return { ...harness, Ask, UIContext, asked, mountAsk }
}

/** Types a question in the box and sends it. */
async function ask(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask your binders' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  await screen.findByRole('heading', { name: question })
  await waitFor(() => expect(screen.queryByText('Reading your notes and cards…')).toBeNull())
}
const questions = () => [...document.querySelectorAll('.ask-question')].map((h) => h.textContent)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('Ask keeps the visit’s questions', () => {
  it('lists each question with its answer above the box, oldest first', async () => {
    const { mountAsk } = await load()
    await mountAsk()
    await ask('What is the plan?')
    await ask('Who owns it?')
    expect(questions()).toEqual(['What is the plan?', 'Who owns it?'])
    const [first, second] = [...document.querySelectorAll('.ask-result')]
    expect(first.textContent).toContain('The answer to What is the plan?')
    expect(second.textContent).toContain('The answer to Who owns it?')
    const box = screen.getByRole('textbox', { name: 'Ask your binders' })
    expect(second.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((box as HTMLInputElement).value).toBe('')
  })

  it('sends each question alone, and doesn’t say it remembers', async () => {
    const { mountAsk, calledOn } = await load()
    await mountAsk()
    await ask('One?')
    await ask('Two?')
    const bodies = vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/brain/ask').map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([{ question: 'One?', everywhere: false }, { question: 'Two?', everywhere: false }])
    expect(calledOn().filter((c) => c === 'POST /api/brain/ask')).toHaveLength(2)
    expect(document.body.textContent).not.toMatch(/remember|follow.?up|earlier|conversation/i)
  })

  it('still has them when you come back to the screen, until the page is reloaded', async () => {
    const { mountAsk } = await load()
    await mountAsk()
    await ask('What is the plan?')
    await ask('Who owns it?')
    cleanup()
    await mountAsk()
    expect(questions()).toEqual(['What is the plan?', 'Who owns it?'])
    cleanup()
    const reloaded = await load()
    await reloaded.mountAsk()
    expect(questions()).toEqual([])
    expect(screen.getByRole('heading', { name: 'Ask your binders' })).toBeTruthy()
  })

  it('answers a question from ⌘K or Home once, and puts it with the rest', async () => {
    const { mountAsk, asked } = await load()
    await mountAsk(ui(), { asked: { question: 'From the line', at: 1 } })
    await screen.findByRole('heading', { name: 'From the line' })
    await ask('And then?')
    expect(questions()).toEqual(['From the line', 'And then?'])
    expect(asked.map((a) => a.question)).toEqual(['From the line', 'And then?'])
  })

  it('keeps each answer’s sources apart, so opening one in an answer doesn’t open it in another', async () => {
    const { mountAsk } = await load()
    await mountAsk()
    await ask('One?')
    await ask('Two?')
    const [first, second] = [...document.querySelectorAll('.ask-result')] as HTMLElement[]
    fireEvent.click(within(first).getAllByRole('button', { name: /^Source 1/ })[0])
    expect(first.querySelector('.ask-sources li.shown')).toBeTruthy()
    expect(second.querySelector('.ask-sources li.shown')).toBeNull()
    expect(document.querySelectorAll('[id^="ask-source-"]').length).toBe(new Set([...document.querySelectorAll('[id^="ask-source-"]')].map((e) => e.id)).size)
  })
})

describe('under an answer', () => {
  const noteSent = () => vi.mocked(fetch).mock.calls
    .filter(([url]) => url === '/api/changes')
    .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { changes: { change: { type: string; note?: { id: string; title: string; binderId: string; text: string } } }[] }).changes.map((c) => c.change))
    .find((c) => c.type === 'note.put')?.note

  it('Save as a note makes one in the binder you’re in, titled with the question, with the answer and its sources as links, and opens it', async () => {
    const { mountAsk } = await load()
    await mountAsk(ui({ binder: 'b2' }))
    await ask('What is the plan?')
    fireEvent.click(screen.getByRole('button', { name: 'Save as a note' }))
    await waitFor(() => expect(noteSent()).toBeTruthy())
    const note = noteSent()!
    expect(note.binderId).toBe('b2')
    expect(note.title).toBe('What is the plan?')
    expect(note.text).toBe([
      '# What is the plan?',
      '',
      'The answer to What is the plan?',
      '',
      '## Sources',
      '',
      '- [[Note 1]]',
      '- [Fix it](#/work/c1)',
      '- [Far away](https://hub.test/b1/#/notes/n3)',
      '',
    ].join('\n'))
    expect(note.text).not.toContain('')
    expect(window.location.hash).toBe(`#/notes/${note.id}`)
  })

  it('Save as a note uses the first binder when all of them are showing', async () => {
    const { mountAsk } = await load()
    await mountAsk(ui({ binder: 'all' }))
    await ask('Where?')
    fireEvent.click(screen.getByRole('button', { name: 'Save as a note' }))
    await waitFor(() => expect(noteSent()?.binderId).toBe('b1'))
  })

  it('Make a card opens the new-card dialog with the question as its title and the answer as its brief, to fix first', async () => {
    const { mountAsk, standInRoute } = await load()
    await mountAsk(ui({ binder: 'b2' }))
    const made = standInRoute('POST', '/api/cards', () => ({ id: 'c9', stage: 'ready' })) as Record<string, unknown>[]
    await ask('What is the plan?')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Make a card' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'New card' }))
    expect((dialog.getByLabelText('Title') as HTMLInputElement).value).toBe('What is the plan?')
    expect((dialog.getByLabelText(/^Brief/) as HTMLTextAreaElement).value).toBe('The answer to What is the plan?')
    expect((dialog.getByLabelText('Part') as HTMLSelectElement).value).toBe('b2')
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: 'Write the plan' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Put on the board' }))
    await waitFor(() => expect(made).toHaveLength(1))
    expect(made[0]).toMatchObject({ binderId: 'b2', title: 'Write the plan', brief: 'The answer to What is the plan?' })
    // Nothing was made until the person said so.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Make a card can be given up on, and makes nothing', async () => {
    const { mountAsk, standInRoute } = await load()
    await mountAsk()
    const made = standInRoute('POST', '/api/cards', () => ({ id: 'c9', stage: 'ready' })) as unknown[]
    await ask('What is the plan?')
    fireEvent.click(screen.getByRole('button', { name: 'Make a card' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'New card' })).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(made).toEqual([])
  })

  it('has neither button where there’s no answer to keep', async () => {
    const { mountAsk } = await load(() => ({ sources: [source(1)], searchedBy: 'words' }))
    await mountAsk()
    await ask('What is the plan?')
    expect(screen.queryByRole('button', { name: 'Save as a note' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Make a card' })).toBeNull()
  })

  it('has neither where the hub offers to do something instead', async () => {
    const { mountAsk } = await load(() => ({ answer: { text: 'Stop it.', parts: [{ text: 'Stop it.', sources: [] }] }, sources: [], searchedBy: 'words', proposal: { id: 'p1', what: 'Stop it.', button: 'Stop it' } }))
    await mountAsk()
    await ask('stop the login work')
    await screen.findByRole('button', { name: 'Stop it' })
    expect(screen.queryByRole('button', { name: 'Save as a note' })).toBeNull()
  })
})

describe('Home’s question line', () => {
  it('takes a question to Ask, and clears', async () => {
    const harness = await import('./harness')
    const { Home } = await import('../src/screens/Home')
    const { UIContext } = await import('../src/ui')
    harness.standInHub()
    const askQuestion = vi.fn()
    await harness.mount(<UIContext.Provider value={ui({ askQuestion })}><Home /></UIContext.Provider>)
    const line = screen.getByRole('textbox', { name: 'Ask your binders' }) as HTMLInputElement
    expect(line.placeholder).toBe('Ask your binders…')
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(line.form!)
    expect(askQuestion).not.toHaveBeenCalled()
    fireEvent.change(line, { target: { value: '  Why Redis?  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(askQuestion).toHaveBeenCalledWith('Why Redis?')
    expect(line.value).toBe('')
  })

  it('is at the top, and on a phone above the waiting list', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))
    const harness = await import('./harness')
    const { Home } = await import('../src/screens/Home')
    const { UIContext } = await import('../src/ui')
    harness.standInHub()
    await harness.mount(<UIContext.Provider value={ui({ askQuestion: () => {} })}><Home /></UIContext.Provider>)
    const home = document.querySelector('.home')!
    expect(home.firstElementChild).toBe(screen.getByRole('textbox', { name: 'Ask your binders' }).closest('form'))
    const waiting = screen.getByRole('region', { name: 'Waiting on you' })
    expect(screen.getByRole('textbox', { name: 'Ask your binders' }).compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('isn’t drawn where nothing can take the question', async () => {
    const harness = await import('./harness')
    const { Home } = await import('../src/screens/Home')
    const { UIContext } = await import('../src/ui')
    harness.standInHub()
    await harness.mount(<UIContext.Provider value={ui()}><Home /></UIContext.Provider>)
    expect(screen.queryByRole('textbox', { name: 'Ask your binders' })).toBeNull()
  })

  it('in the app, asks the question on Ask', async () => {
    const { standInRoute, standInHub, hubState, mount, settle } = await import('./harness')
    const App = (await import('../src/App')).default
    standInHub(() => hubState())
    const asked = standInRoute('POST', '/api/brain/ask', () => ({ sources: [], searchedBy: 'words' })) as { question: string }[]
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(100)
    const line = screen.getAllByRole('textbox', { name: 'Ask your binders' })[0]
    fireEvent.change(line, { target: { value: 'Why Redis?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(asked.map((a) => a.question)).toEqual(['Why Redis?']))
    expect(window.location.hash).toBe('#/ask')
    expect(await screen.findByRole('heading', { name: 'Why Redis?' })).toBeTruthy()
  })
})
