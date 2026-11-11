// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appCss } from './css'
import { calledOn, card, hubState, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import { ContextMenuHost, openMenu } from '../src/components/ContextMenu'
import { cardMenuItems } from '../src/components/CardMenu'
import { useActions } from '../src/data/store'
import { Terminal } from '../src/components/Terminal'
import { Work } from '../src/screens/Work'
import { UIContext } from '../src/ui'
import type { PullRequest } from '../src/data/model'

// A card's own page: what it asks before, stopping an agent, sending a card back, and not losing what was typed.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const page = (id: string) => mount(<UIContext.Provider value={ui}><Work id={id} /><Toast /></UIContext.Provider>)
const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'https://github.com/acme/web/pull/7', state: 'open', checks: [], files: [], cardId: 'c1', agentId: 'a1', ...over })
const inReview = (over: Partial<PullRequest> = {}) => () => hubState({ cards: [card('c1', 'review', { agentId: 'a1', prId: 'acme/web#7' })], pulls: [pull(over)] })
const working = () => hubState({ cards: [card('c1', 'working', { agentId: 'a1', title: 'Fix the login' })] })
const gone = () => calledOn().filter((c) => c.startsWith('POST /api/changes')).length
const reply = () => screen.getByRole('textbox') as HTMLInputElement

beforeEach(() => {
  window.location.hash = ''
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Delete on a card’s page', () => {
  it('asks first, and says an agent is working on it when one is', async () => {
    standInHub(working)
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Delete it and stop Agent? Press again' })).toBeTruthy()
    expect(gone()).toBe(0)
  })

  it('deletes on the second press, and leaves the page', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(gone()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Delete it? Press again' }))
    await waitFor(() => expect(gone()).toBe(1))
    expect(window.location.hash).toContain('flow')
  })
})

describe('Stop', () => {
  it('is on a card an agent is working on, and not on one nobody holds', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    await page('c1')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    cleanup()
    standInHub(working)
    await page('c1')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  })

  it('is on a card blocked on a question too', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'blocked', { agentId: 'a1', needsYou: 'Left or right?' })] }))
    await page('c1')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  })

  it('calls the hub’s stop and says where the card waits', async () => {
    standInHub(working)
    const stops = standInRoute('POST', '/api/cards/c1/stop')
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stops).toHaveLength(1))
    expect((await screen.findAllByText('Stopped Agent. It waits in Proposed.')).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('status').map((r) => r.textContent)).toContain('Stopped Agent. It waits in Proposed.')
  })

  it('shows what the hub said when it can’t', async () => {
    standInHub(working)
    standInRoute('POST', '/api/cards/c1/stop', () => new Response(JSON.stringify({ error: 'Not yours to stop.' }), { status: 403 }))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not yours to stop.'))
  })

  it('is in the card’s ⋯ menu when an agent holds it', async () => {
    standInHub(working)
    const stops = standInRoute('POST', '/api/cards/c1/stop')
    function Menu() {
      const store = useActions()
      return <button onClick={(e) => openMenu(e, cardMenuItems(store.current().cards[0], store, () => {}))}>Menu</button>
    }
    await mount(<><Menu /><ContextMenuHost /><Toast /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Stop' }))
    await waitFor(() => expect(stops).toHaveLength(1))
  })

  it('isn’t in the menu of a card nobody holds', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'review', { agentId: 'a1' })] }))
    function Menu() {
      const store = useActions()
      return <button onClick={(e) => openMenu(e, cardMenuItems(store.current().cards[0], store, () => {}))}>Menu</button>
    }
    await mount(<><Menu /><ContextMenuHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Stop' })).toBeNull()
  })
})

describe('the answer box', () => {
  it('keeps the words when the hub can’t be reached, and says so plainly', async () => {
    standInHub(working)
    standInRoute('POST', '/api/cards/c1/comment', () => { throw new TypeError('Failed to fetch') })
    await page('c1')
    fireEvent.change(reply(), { target: { value: 'Use the other one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Couldn’t reach the hub. Try again in a moment.'))
    expect(reply().value).toBe('Use the other one')
  })

  it('keeps the words when the hub says no', async () => {
    standInHub(working)
    standInRoute('POST', '/api/cards/c1/comment', () => new Response(JSON.stringify({ error: 'That card is gone.' }), { status: 404 }))
    await page('c1')
    fireEvent.change(reply(), { target: { value: 'Use the other one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That card is gone.'))
    expect(reply().value).toBe('Use the other one')
  })

  it('clears once the hub has taken the words, not before', async () => {
    standInHub(working)
    let take!: () => void
    const taken = new Promise<void>((done) => { take = done })
    const sent = standInRoute('POST', '/api/cards/c1/comment', async () => { await taken; return {} })
    await page('c1')
    fireEvent.change(reply(), { target: { value: 'Use the other one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(sent).toEqual([{ text: 'Use the other one' }]))
    expect(reply().value).toBe('Use the other one')
    // A second press while it's on its way sends nothing more.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { take() })
    await waitFor(() => expect(reply().value).toBe(''))
    expect(sent).toHaveLength(1)
  })
})

describe('Send back', () => {
  it('is beside Comment on a card in review with an agent and an open pull request', async () => {
    standInHub(inReview())
    await page('c1')
    expect(screen.getByRole('button', { name: 'Comment' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send back to Agent' })).toBeTruthy()
    expect(reply().placeholder).toContain('send it back to Agent')
  })

  it('posts the words to the hub’s send-back, clears the box and says so', async () => {
    standInHub(inReview())
    const back = standInRoute('POST', '/api/cards/c1/send-back')
    await page('c1')
    fireEvent.change(reply(), { target: { value: 'Rename the helper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back to Agent' }))
    await waitFor(() => expect(back).toEqual([{ text: 'Rename the helper' }]))
    await waitFor(() => expect(reply().value).toBe(''))
    expect(calledOn()).not.toContain('POST /api/cards/c1/comment')
    expect((await screen.findAllByText('Sent back to Agent.')).length).toBeGreaterThan(0)
  })

  it('keeps the words when sending back fails', async () => {
    standInHub(inReview())
    standInRoute('POST', '/api/cards/c1/send-back', () => new Response(JSON.stringify({ error: 'Its agent is gone.' }), { status: 409 }))
    await page('c1')
    fireEvent.change(reply(), { target: { value: 'Rename the helper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back to Agent' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Its agent is gone.'))
    expect(reply().value).toBe('Rename the helper')
  })

  it('leaves a plain comment as it was: a comment, not a send back', async () => {
    standInHub(inReview())
    const comments = standInRoute('POST', '/api/cards/c1/comment')
    await page('c1')
    fireEvent.change(reply(), { target: { value: 'Looks fine to me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(comments).toEqual([{ text: 'Looks fine to me' }]))
    expect(calledOn()).not.toContain('POST /api/cards/c1/send-back')
  })

  it('needs words to send', async () => {
    standInHub(inReview())
    await page('c1')
    expect((screen.getByRole('button', { name: 'Send back to Agent' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('isn’t offered once the pull request is merged, or when it has none, or no agent has the card', async () => {
    standInHub(inReview({ state: 'merged' }))
    await page('c1')
    expect(screen.queryByRole('button', { name: /Send back/ })).toBeNull()
    expect(reply().placeholder).toBe('Add a comment…')
    cleanup()
    standInHub(() => hubState({ cards: [card('c1', 'review', { agentId: 'a1' })] }))
    await page('c1')
    expect(screen.queryByRole('button', { name: /Send back/ })).toBeNull()
    cleanup()
    standInHub(() => hubState({ cards: [card('c1', 'review', { prId: 'acme/web#7' })], pulls: [pull()] }))
    await page('c1')
    expect(screen.queryByRole('button', { name: /Send back/ })).toBeNull()
  })

  it('has a send back to fix beside a failed check, which names the check', async () => {
    standInHub(inReview({ checks: [{ name: 'lint', state: 'passed' }, { name: 'unit tests', state: 'failed' }] }))
    const back = standInRoute('POST', '/api/cards/c1/send-back')
    await page('c1')
    expect(screen.getAllByRole('button', { name: 'Send back to fix' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send back to fix' }))
    await waitFor(() => expect(back).toEqual([{ text: 'The check “unit tests” failed. Fix it and push.' }]))
  })

  it('has no send back to fix when the card can’t be sent back', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'working', { agentId: 'a1', prId: 'acme/web#7' })], pulls: [pull({ checks: [{ name: 'unit tests', state: 'failed' }] })] }))
    await page('c1')
    expect(screen.queryByRole('button', { name: 'Send back to fix' })).toBeNull()
  })
})

const changes = (posted: ReturnType<typeof standInHub>['posted']) => posted.flatMap((batch) => batch.changes.map((c) => c.change))
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

describe('a card’s words', () => {
  const words = { title: 'Fix the login', brief: 'The login page drops the session.', doneWhen: 'Signing in keeps you in.' }
  const editable = (stage: 'proposed' | 'ready' | 'blocked' | 'working' | 'review' | 'live', over = {}) => () => hubState({ cards: [card('c1', stage, { ...words, ...over })] })

  it('can be changed while the card is proposed, ready, or blocked with no agent holding it', async () => {
    for (const stage of ['proposed', 'ready', 'blocked'] as const) {
      standInHub(editable(stage))
      await page('c1')
      for (const name of [words.title, words.brief, words.doneWhen]) expect(screen.getByRole('button', { name })).toBeTruthy()
      expect(screen.getByRole('combobox', { name: 'Size' })).toBeTruthy()
      expect(screen.queryByText(/so its words stay as they are/)).toBeNull()
      cleanup()
    }
  })

  it('stays as it is while an agent works on it, is blocked with its agent, is in review or is done, and says why', async () => {
    const why: [Parameters<typeof editable>[0], object, RegExp][] = [
      ['working', { agentId: 'a1' }, /Agent is working on it, so its words stay as they are\./],
      ['blocked', { agentId: 'a1', needsYou: 'Left or right?' }, /Agent is working on it, so its words stay as they are\./],
      ['review', { agentId: 'a1' }, /It’s in review, so its words stay as they are\./],
      ['live', {}, /It’s done, so its words stay as they are\./],
    ]
    for (const [stage, over, line] of why) {
      standInHub(editable(stage, over))
      await page('c1')
      expect(screen.getAllByText(line)).toHaveLength(1)
      expect(screen.queryByRole('button', { name: words.title })).toBeNull()
      expect(screen.queryByRole('button', { name: words.brief })).toBeNull()
      expect(screen.queryByRole('combobox', { name: 'Size' })).toBeNull()
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(words.title)
      expect(screen.getByText(words.brief)).toBeTruthy()
      cleanup()
    }
  })

  it('opens on a press of the words, and keeps the change on leaving the box, with a line saying what changed', async () => {
    const { posted } = standInHub(editable('ready'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: words.brief }))
    const box = screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe(words.brief)
    fireEvent.change(box, { target: { value: 'The login page drops the session on refresh.' } })
    fireEvent.blur(box)
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
    expect(changes(posted)[0]).toMatchObject({ type: 'card.update', id: 'c1', fields: { brief: 'The login page drops the session on refresh.' }, activity: { text: 'Changed the brief', by: 'you' } })
    expect(screen.queryByRole('textbox', { name: 'Brief' })).toBeNull()
    expect(screen.getByRole('button', { name: 'The login page drops the session on refresh.' })).toBeTruthy()
  })

  it('keeps the change with the Save button', async () => {
    const { posted } = standInHub(editable('proposed'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: words.doneWhen }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Done when' }), { target: { value: 'Signing in keeps you in for a week.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
    expect(changes(posted)[0]).toMatchObject({ fields: { doneWhen: 'Signing in keeps you in for a week.' }, activity: { text: 'Changed the done-when' } })
  })

  it('keeps a title with Enter, and says so', async () => {
    const { posted } = standInHub(editable('ready'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: words.title }))
    const box = screen.getByRole('textbox', { name: 'Title' })
    fireEvent.change(box, { target: { value: '  Fix the sign-in  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
    expect(changes(posted)[0]).toMatchObject({ fields: { title: 'Fix the sign-in' }, activity: { text: 'Changed the title' } })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fix the sign-in')
  })

  it('puts the old words back on Escape, sends nothing, and keeps focus on the words', async () => {
    const { posted } = standInHub(editable('ready'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: words.brief }))
    const box = screen.getByRole('textbox', { name: 'Brief' })
    fireEvent.change(box, { target: { value: 'Something else' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Brief' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: words.brief }))
    await new Promise((done) => setTimeout(done, 350))
    expect(changes(posted)).toHaveLength(0)
  })

  it('sends nothing when nothing changed, and won’t take a title with nothing in it', async () => {
    const { posted } = standInHub(editable('ready'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: words.brief }))
    fireEvent.blur(screen.getByRole('textbox', { name: 'Brief' }))
    fireEvent.click(screen.getByRole('button', { name: words.title }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '   ' } })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Title' }))
    await new Promise((done) => setTimeout(done, 350))
    expect(changes(posted)).toHaveLength(0)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(words.title)
  })

  it('lets the done-when be emptied, since a card needs none', async () => {
    const { posted } = standInHub(editable('ready'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: words.doneWhen }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Done when' }), { target: { value: '' } })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Done when' }))
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
    expect(changes(posted)[0]).toMatchObject({ fields: { doneWhen: '' } })
  })

  it('changes the size as soon as one is chosen', async () => {
    const { posted } = standInHub(editable('ready'))
    await page('c1')
    fireEvent.change(screen.getByRole('combobox', { name: 'Size' }), { target: { value: 'L' } })
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
    expect(changes(posted)[0]).toMatchObject({ fields: { size: 'L' }, activity: { text: 'Changed the size to large' } })
  })

  it('has a button in Proposed that puts it in Ready, and none elsewhere', async () => {
    const { posted } = standInHub(editable('proposed'))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Put it in Ready' }))
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
    expect(changes(posted)[0]).toMatchObject({ type: 'card.update', id: 'c1', fields: { stage: 'ready' } })
    cleanup()
    standInHub(editable('ready'))
    await page('c1')
    expect(screen.queryByRole('button', { name: 'Put it in Ready' })).toBeNull()
  })

  it('can be reached by Tab: the words are buttons, and the box is a field', async () => {
    standInHub(editable('ready'))
    await page('c1')
    for (const name of [words.title, words.brief, words.doneWhen]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).tabIndex).toBe(0)
    expect(screen.getByRole('button', { name: words.title }).getAttribute('title')).toBe('Edit the title')
  })
})

describe('the card’s page at one column', () => {
  // jsdom has no layout, so this reads the order the page asks for in app.css, and that the page's parts carry it.
  const css = appCss()
  const narrow = css.split('@media (max-width: 1180px)').find((block) => block.includes('.brief-card { order'))!
  const order = (selector: string) => Number(new RegExp(`(?:^|\\n)\\s*${selector.replace('.', '\\.')} \\{ order: (\\d+)`).exec(narrow)?.[1])

  it('starts with what’s happening now and the answer box, then the brief, then where it is, then the rest', () => {
    expect(order('.now-card')).toBeLessThan(order('.brief-card'))
    expect(order('.brief-card')).toBeLessThan(order('.sdlc'))
    expect(order('.sdlc')).toBeLessThan(order('.work-section, .work-history'))
    expect(order('.work-section, .work-history')).toBeLessThan(order('.side-card'))
    expect(narrow).toMatch(/\.work-body, \.work-main, \.work-side \{ display: contents; \}/)
  })

  it('has the parts that order names: the brief and done-when, and the now card with the question and the reply box', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'blocked', { agentId: 'a1', needsYou: 'Left or right?', brief: 'The brief', doneWhen: 'It is done' })] }))
    await page('c1')
    const brief = document.querySelector('.side-card.brief-card')!
    expect(within(brief as HTMLElement).getByText('Brief')).toBeTruthy()
    expect(within(brief as HTMLElement).getByText('The brief')).toBeTruthy()
    expect(within(brief as HTMLElement).getByText('Done when')).toBeTruthy()
    const now = document.querySelector('.now-card.asks') as HTMLElement
    expect(within(now).getByText('Left or right?')).toBeTruthy()
    expect(within(now).getByRole('textbox')).toBeTruthy()
    // Said once: the question is at the top, and there's no other box for words.
    expect(screen.getAllByText('Left or right?')).toHaveLength(1)
    expect(document.querySelector('.conversation-section')).toBeNull()
  })
})

describe('why a card stopped', () => {
  const stoppedTwice = (over = {}) => () => hubState({
    cards: [card('c1', 'blocked', { needsYou: 'It stopped twice without finishing: Signed out of Claude Code. Fix what’s wrong, then answer here and it goes back to Ready.', stopped: { why: 'Signed out of Claude Code.', at: minutesAgo(5), times: 2 }, ...over })],
  })

  it('is at the top of the page with when and how many times, and the page doesn’t say an agent asks', async () => {
    standInHub(stoppedTwice())
    await page('c1')
    const top = document.querySelector('.work-main > :first-child') as HTMLElement
    expect(top.className).toContain('stopped-card')
    expect(within(top).getByText('Stopped twice')).toBeTruthy()
    expect(within(top).getByText('Signed out of Claude Code.')).toBeTruthy()
    expect(within(top).getByText('5m ago')).toBeTruthy()
    expect(within(top).getByText(/Fix what’s wrong, then answer below and it goes back to Ready\./)).toBeTruthy()
    expect(screen.queryByText(/Asks you/)).toBeNull()
    expect(reply().placeholder).toBe('Write anything, and it goes back to Ready…')
  })

  it('says it once for a stop that didn’t block the card, with how often', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'ready', { stopped: { why: 'Ran out of time.', at: minutesAgo(3), times: 1 } })] }))
    await page('c1')
    expect(screen.getByText('Stopped once')).toBeTruthy()
    expect(screen.getByText('Ran out of time.')).toBeTruthy()
    expect(screen.queryByText(/Fix what’s wrong/)).toBeNull()
  })

  it('shows the hub’s own question under “Stopped twice” when the card has no stop recorded', async () => {
    standInHub(stoppedTwice({ stopped: undefined }))
    await page('c1')
    expect(screen.getByText('Stopped twice')).toBeTruthy()
    expect(screen.getByText(/It stopped twice without finishing: Signed out/)).toBeTruthy()
    expect(screen.queryByText(/Asks you/)).toBeNull()
  })

  it('still says an agent asks when one holds the card and asked', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'blocked', { agentId: 'a1', needsYou: 'Left or right?', stopped: { why: 'Out of time.', at: minutesAgo(5), times: 1 } })] }))
    await page('c1')
    expect(screen.getAllByText('Asks you').length).toBeGreaterThan(0)
    expect(screen.getByText('Stopped once')).toBeTruthy()
    expect(screen.queryByText('Stopped twice')).toBeNull()
  })
})

describe('Ready for a card an agent holds', () => {
  const held = (stage: 'working' | 'blocked') => () => hubState({ cards: [card('c1', stage, { agentId: 'a1', ...(stage === 'blocked' ? { needsYou: 'Left or right?' } : {}) })] })

  it('asks first, in words that say it takes the card from the agent and stops its run', async () => {
    for (const stage of ['working', 'blocked'] as const) {
      const { posted } = standInHub(held(stage))
      await page('c1')
      fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
      expect(screen.getByRole('button', { name: 'Take it from Agent and stop its run? Press again' })).toBeTruthy()
      expect(changes(posted)).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: 'Take it from Agent and stop its run? Press again' }))
      await waitFor(() => expect(changes(posted)).toHaveLength(1))
      expect(changes(posted)[0]).toMatchObject({ type: 'card.update', id: 'c1', fields: { stage: 'ready', agentId: null } })
      cleanup()
    }
  })

  it('doesn’t ask for a card nobody holds', async () => {
    const { posted } = standInHub(() => hubState({ cards: [card('c1', 'review')] }))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
  })

  it('asks in the card’s ⋯ menu too, from the same list', async () => {
    const { posted } = standInHub(held('working'))
    function Menu() {
      const store = useActions()
      return <button onClick={(e) => openMenu(e, cardMenuItems(store.current().cards[0], store, () => {}))}>Menu</button>
    }
    await mount(<><Menu /><ContextMenuHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Ready' }))
    expect(changes(posted)).toHaveLength(0)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Take it from Agent and stop its run? Press again' }))
    await waitFor(() => expect(changes(posted)).toHaveLength(1))
  })
})

describe('the list of places a card can move to', () => {
  const inMenu = async () => {
    function Menu() {
      const store = useActions()
      return <button onClick={(e) => openMenu(e, cardMenuItems(store.current().cards[0], store, () => {}))}>Menu</button>
    }
    await mount(<><Menu /><ContextMenuHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent!)
    return items
  }
  const onPage = (c: ReturnType<typeof card>) => async () => {
    standInHub(() => hubState({ cards: [c] }))
    await page('c1')
    return within(screen.getByRole('group', { name: 'Move to' })).getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled).map((b) => b.textContent!)
  }

  it('is the same on the page and in the menu, but for the one it’s in', async () => {
    const c = card('c1', 'ready')
    standInHub(() => hubState({ cards: [c] }))
    const menu = await inMenu()
    cleanup()
    const pageMoves = await onPage(c)()
    expect(pageMoves).toEqual(['Proposed', 'Blocked', 'In review', 'Done'])
    for (const move of pageMoves) expect(menu).toContain(move)
  })

  it('offers Blocked on the page as the menu does, and Carry on for a blocked card an agent holds, as the menu does', async () => {
    const c = card('c1', 'blocked', { agentId: 'a1', needsYou: 'Left or right?' })
    standInHub(() => hubState({ cards: [c] }))
    const menu = await inMenu()
    cleanup()
    const pageMoves = await onPage(c)()
    expect(pageMoves).toEqual(['Proposed', 'Ready', 'In review', 'Done', 'Carry on'])
    expect(menu).toContain('Agents working (carry on)')
    expect(menu).toEqual(expect.arrayContaining(['Proposed', 'Ready', 'In review', 'Done']))
  })
})

describe('Copy link on the card’s page', () => {
  it('puts its link on the clipboard and says so', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    standInHub(() => hubState({ cards: [card('c1')] }))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toMatch(/#\/work\/c1$/)
    expect((await screen.findAllByText('Link copied.')).length).toBeGreaterThan(0)
  })

  it('says plainly when it can’t', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('no') } }, configurable: true })
    standInHub(() => hubState({ cards: [card('c1')] }))
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Couldn’t copy the link.'))
  })
})

describe('Back', () => {
  const entry = (appDepth?: number) => window.history.replaceState(appDepth === undefined ? null : { appDepth }, '')

  it('goes to the board when the page before this card wasn’t this app', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    entry(0)
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(back).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/flow')
  })

  it('goes back in history when the page before was in this app', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    entry(2)
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('treats an entry nobody marked as one a link opened', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    entry(undefined)
    await page('c1')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(back).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/flow')
  })

  it('marks each screen the app moves to as one further in', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    entry(0)
    window.location.hash = '#/flow'
    await new Promise((done) => setTimeout(done, 50))
    expect(window.history.state?.appDepth).toBeGreaterThan(0)
  })
})

describe('the session on the card’s page', () => {
  it('doesn’t say “esc to interrupt”: Escape doesn’t do that here', () => {
    Element.prototype.scrollTo = () => {}
    render(<Terminal lines={['⏺ Read(a.ts)', '⏺ Looking at it']} working doing="Reading" />)
    expect(screen.getByText(/Reading…/)).toBeTruthy()
    expect(screen.queryByText(/esc to interrupt/)).toBeNull()
    cleanup()
  })
})

describe('Send back and the pull request’s state', () => {
  it('is offered only while the pull request is open', async () => {
    for (const state of ['approved', 'queued', 'merged', 'closed'] as const) {
      standInHub(inReview({ state, checks: [{ name: 'unit tests', state: 'failed' }] }))
      await page('c1')
      expect(screen.queryByRole('button', { name: /Send back/ }), state).toBeNull()
      cleanup()
    }
    standInHub(inReview({ state: 'open' }))
    await page('c1')
    expect(screen.getByRole('button', { name: 'Send back to Agent' })).toBeTruthy()
  })
})

describe('the debrief and the Challenge on a card’s page', () => {
  it('are sections with a way to ask for them before either has been written, under the same kind of heading', async () => {
    standInHub(inReview())
    await page('c1')
    const debrief = screen.getByRole('region', { name: 'Debrief' })
    const challenge = screen.getByRole('region', { name: 'Challenge' })
    expect(within(debrief).getByRole('heading', { level: 2 }).textContent).toMatch(/^Debrief/)
    expect(within(challenge).getByRole('heading', { level: 2 }).textContent).toMatch(/^Challenge/)
    expect(within(debrief).getByRole('button', { name: /^Debrief$/ })).toBeTruthy()
    expect(within(challenge).getByRole('button', { name: /^Challenge$/ })).toBeTruthy()
  })

  it('aren’t there for a card that has nothing to read yet', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'ready')] }))
    await page('c1')
    expect(screen.queryByRole('region', { name: 'Debrief' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Challenge' })).toBeNull()
  })
})

describe('the facts of a card', () => {
  it('are one block: who made it, its repo, branch, pull request and checks', async () => {
    standInHub(inReview({ checks: [{ name: 'test', state: 'passed', seconds: 12 }] }))
    await page('c1')
    const facts = document.querySelector('.details-card dl') as HTMLElement
    expect([...facts.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(expect.arrayContaining(['Repo', 'Branch', 'Pull request', 'Checks', 'Deployed']))
    expect(within(facts).getByRole('link', { name: /web#7/ }).getAttribute('href')).toBe('https://github.com/acme/web/pull/7')
    expect(within(facts).getByText('test')).toBeTruthy()
  })
})
