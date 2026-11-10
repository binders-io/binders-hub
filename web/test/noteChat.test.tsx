// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../src/data/model'

// A note's Chat talks to an agent, and to the hub's own model when the hub has one: it's offered always, and it's who
// answers when no agent is listening. The hub only reads, so it says what it can't do, and who can.

const note = { id: 'n1' }

// The chats with the hub are kept in the module for the visit, so each test loads a fresh one: a reload, in effect.
let harness: typeof import('./harness')
let NoteChat: typeof import('../src/components/NoteChat').NoteChat
const agent = (id = 'a1', name = 'Agent'): Agent => ({ id, name, provider: 'claude', owner: 'you', repos: [], binders: [], skills: [], createdAt: 'then' })
const listening = (id: string) => harness.hear({ type: 'presence', presence: { [id]: { at: new Date().toISOString(), listening: true } } })

/**
 * The chat against a hub that has the agents given, and a model of its own or not. The hub answers a question about the
 * note with `reply`, and the bodies it's sent are given back.
 */
async function open(options: { agents?: Agent[]; model?: boolean; reply?: (question: string) => unknown } = {}) {
  vi.resetModules()
  harness = await import('./harness')
  ;({ NoteChat } = await import('../src/components/NoteChat'))
  const { standInHub, standInRoute, hubState, mount } = harness
  const agents = options.agents ?? [agent()]
  standInHub(() => hubState({ agents }))
  standInRoute('GET', '/api/brain', () => ({ brain: options.model === false ? { provider: 'off' } : { inUse: 'stand-in (test)' }, admin: false }))
  const asked = standInRoute('POST', '/api/notes/n1/ask', (body) => (options.reply ?? ((question) => ({
    answer: { text: '', parts: [{ text: `About ${question}. `, sources: [1] }, { text: 'It is open.', sources: [2] }] },
    sources: [{ n: 1, binder: 'b1', binderName: 'Binder', kind: 'note', id: 'n1', title: 'This note', text: 'words', url: 'http://hub.test/#/notes/n1' }, { n: 2, binder: 'b1', binderName: 'Binder', kind: 'note', id: 'n2', title: 'Other note', text: 'more', url: 'http://hub.test/#/notes/n2' }],
    searchedBy: 'words', model: 'stand-in (test)',
  })))((body as { question: string }).question)) as { question: string; turns: { role: string; text: string }[] }[]
  const sent = standInRoute('POST', '/api/notes/n1/chat', () => ({ ok: true })) as { agentId: string; text: string }[]
  await mount(<NoteChat note={note} agents={agents} />)
  return { asked, sent }
}

const picker = () => screen.getByRole('combobox', { name: 'Who to talk with' }) as HTMLSelectElement
const options = () => [...picker().options].map((o) => o.textContent)
async function say(words: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: words } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

// The chat scrolls to its newest message, which the test browser can't do.
Element.prototype.scrollTo = () => {}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('who to talk with', () => {
  it('offers the hub when it has a model, after the agents, and chooses it when no agent is listening', async () => {
    await open()
    await waitFor(() => expect(options()).toEqual(['Agent', 'The hub']))
    expect(picker().value).toBe('hub')
    expect(screen.getByPlaceholderText('Message The hub…')).toBeTruthy()
    expect(screen.getByText(/It reads the note and your binder, and can’t change the note\. Pick an agent for that\./)).toBeTruthy()
  })

  it('chooses the agent that’s listening, and still offers the hub', async () => {
    await open()
    await waitFor(() => expect(options()).toEqual(['Agent', 'The hub']))
    await listening('a1')
    await waitFor(() => expect(picker().value).toBe('a1'))
    expect(screen.getByPlaceholderText('Message Agent…')).toBeTruthy()
    expect(screen.queryByText(/can’t change the note/)).toBeNull()
  })

  it('keeps what the person chose, even when an agent starts listening', async () => {
    await open()
    await waitFor(() => expect(picker().value).toBe('hub'))
    fireEvent.change(picker(), { target: { value: 'a1' } })
    expect(picker().value).toBe('a1')
    fireEvent.change(picker(), { target: { value: 'hub' } })
    await listening('a1')
    expect(picker().value).toBe('hub')
  })

  it('doesn’t offer the hub when it has no model, and says what’s missing and where to set it up', async () => {
    await open({ model: false })
    await screen.findByText(/No agent is listening, and the hub has no model of its own/)
    expect(options()).toEqual(['Agent'])
    const line = screen.getByText(/No agent is listening/)
    expect(within(line).getByRole('link', { name: 'Agents' }).getAttribute('href')).toBe('#/agents')
    expect(within(line).getByRole('link', { name: /Settings → Brain/ })).toBeTruthy()
    // The agent can still be sent a message, as before.
    expect(picker().value).toBe('a1')
  })

  it('says nothing about the hub’s model when an agent is listening and it has none', async () => {
    await open({ model: false })
    await listening('a1')
    await waitFor(() => expect(screen.queryByText(/No agent is listening/)).toBeNull())
    expect(options()).toEqual(['Agent'])
  })

  it('with no agents and no model, says to set one up, and where', async () => {
    await open({ agents: [], model: false })
    const line = await screen.findByText(/Set up an agent in/)
    expect(within(line).getByRole('link', { name: 'Agents' })).toBeTruthy()
    expect(within(line).getByRole('link', { name: /Settings → Brain/ })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('with no agents but a model, talks with the hub, and says an agent is set up in Agents', async () => {
    await open({ agents: [] })
    await waitFor(() => expect(picker().value).toBe('hub'))
    expect(options()).toEqual(['The hub'])
    const line = screen.getByText(/It reads the note and your binder/)
    expect(within(line).getByRole('link', { name: 'Agents' })).toBeTruthy()
  })
})

describe('talking with the hub about a note', () => {
  it('sends the question and the chat so far, and shows the answer with its sources linked', async () => {
    const { asked, sent } = await open()
    await waitFor(() => expect(picker().value).toBe('hub'))
    await say('What is open?')
    await screen.findByText(/About What is open\?\./)
    expect(asked).toEqual([{ question: 'What is open?', turns: [] }])
    expect(sent).toEqual([])
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    const reply = screen.getByText(/About What is open\?\./).closest('li')!
    expect(within(reply).getByText('The hub')).toBeTruthy()
    // Each citation is a link to its source, and the sources are listed.
    expect(within(reply).getByRole('link', { name: 'Source 1: This note' }).getAttribute('href')).toBe('http://hub.test/#/notes/n1')
    expect(within(reply).getByRole('link', { name: 'Source 2: Other note' })).toBeTruthy()
    expect(within(reply).getByRole('link', { name: '1 This note' })).toBeTruthy()
    expect(within(reply).getByRole('link', { name: '2 Other note' })).toBeTruthy()

    await say('and the second?')
    await waitFor(() => expect(asked).toHaveLength(2))
    expect(asked[1]).toEqual({ question: 'and the second?', turns: [{ role: 'user', text: 'What is open?' }, { role: 'assistant', text: 'About What is open?. It is open.' }] })
  })

  it('keeps the chat for the visit: closing the panel and coming back finds it, until it’s cleared', async () => {
    await open()
    await waitFor(() => expect(picker().value).toBe('hub'))
    await say('What is open?')
    await screen.findByText(/About What is open\?\./)
    cleanup()
    harness.standInHub(() => harness.hubState({ agents: [agent()] }))
    harness.standInRoute('GET', '/api/brain', () => ({ brain: { inUse: 'x' } }))
    await harness.mount(<NoteChat note={note} agents={[agent()]} />)
    await screen.findByText(/About What is open\?\./)
    expect(screen.getByText('What is open?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear this chat? Press again' }))
    await waitFor(() => expect(screen.queryByText(/About What is open\?\./)).toBeNull())
    expect(screen.getByText(/Ask the hub about this note/)).toBeTruthy()
  })

  it('says why when the model couldn’t answer, and says so plainly when it gave nothing', async () => {
    await open({ reply: (question) => (question === 'a' ? { sources: [], searchedBy: 'words', problem: 'The model took too long.' } : { sources: [], searchedBy: 'words' }) })
    await waitFor(() => expect(picker().value).toBe('hub'))
    await say('a')
    await screen.findByText('I couldn’t answer: The model took too long.')
    await say('b')
    await screen.findByText('I couldn’t answer that.')
  })

  it('keeps what was typed when the hub can’t be reached', async () => {
    const { asked } = await open({ reply: () => new Response(JSON.stringify({ error: 'That note isn’t there any more.' }), { status: 422 }) })
    await waitFor(() => expect(picker().value).toBe('hub'))
    await say('What is open?')
    await waitFor(() => expect(asked).toHaveLength(1))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('What is open?')
  })

  it('sends to an agent, not the hub, when one is chosen', async () => {
    const { asked, sent } = await open({ agents: [agent(), agent('a2', 'Grok')] })
    await waitFor(() => expect(options()).toEqual(['Agent', 'Grok', 'The hub']))
    fireEvent.change(picker(), { target: { value: 'a2' } })
    await say('tighten the second section')
    await waitFor(() => expect(sent).toEqual([{ agentId: 'a2', text: 'tighten the second section' }]))
    expect(asked).toEqual([])
  })
})
