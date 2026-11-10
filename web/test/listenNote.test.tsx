// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { entry, hear, hubState, me, mount, note, standInHub } from './harness'
import { Notes } from '../src/screens/Notes'
import type { NoteFrom } from '../../shared/listen.ts'

// A note that came through a listener: the line over it, and what a note from outside waits on.

vi.mock('../src/editor/MarkdownEditor', () => ({ MarkdownEditor: () => null }))
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => null }))
vi.mock('../src/components/NoteTree', () => ({ NoteTree: () => null }))
vi.mock('../src/components/NoteChat', () => ({ NoteChat: () => null }))

const outside: NoteFrom = { listener: 'l1', name: 'Support form', kind: 'post', strength: 'outside', sender: 'sam@example.com', url: 'https://example.com/ticket/7' }
const waiting = "It’s from outside this Binder, so its folder’s rule won’t start work from it until someone here lets it through."

function noteHub(from: NoteFrom | undefined, role = 'member') {
  standInHub(() => hubState({ notes: [{ ...note('n1', '# Ticket'), ...(from ? { from } : {}) }] }), { ...me, role })
  const passed: string[] = []
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const at = /^\/api\/notes\/(.+)\/pass$/.exec(String(url))
    if (at && init?.method === 'POST') {
      passed.push(at[1])
      return new Response(null)
    }
    return stand(url, init)
  }))
  return passed
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('a note that came through a listener', () => {
  it('says which listener, from whom, and links to where it was said, in a new tab', async () => {
    noteHub(outside)
    await mount(<Notes id="n1" />)
    const line = await screen.findByText(/Came through/)
    expect(line.textContent).toBe('Came through Support form from sam@example.com')
    const link = screen.getByRole('link', { name: /Open it there/ })
    expect(link.getAttribute('href')).toBe('https://example.com/ticket/7')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows nothing over a note that came from nowhere', async () => {
    noteHub(undefined)
    await mount(<Notes id="n1" />)
    await screen.findByText(/Ticket|n1/)
    expect(screen.queryByText(/Came through/)).toBeNull()
  })

  it('never links to an address that is not a web address', async () => {
    noteHub({ ...outside, url: 'javascript:alert(1)' })
    await mount(<Notes id="n1" />)
    await screen.findByText(/Came through/)
    expect(screen.queryByRole('link', { name: /Open it there/ })).toBeNull()
  })

  it('says a note from outside starts no work until it is let through, and has a button for people who can change the Binder', async () => {
    noteHub(outside)
    await mount(<Notes id="n1" />)
    expect(await screen.findByText(waiting)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Let it through' })).toBeTruthy()
  })

  it('has no button for a reader, who is still told', async () => {
    noteHub(outside, 'reader')
    await mount(<Notes id="n1" />)
    expect(await screen.findByText(waiting)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Let it through' })).toBeNull()
  })

  it('lets it through with the pass call, and then reads who did when the hub says so', async () => {
    const passed = noteHub(outside)
    await mount(<Notes id="n1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Let it through' }))
    await waitFor(() => expect(passed).toEqual(['n1']))
    // The hub sends the note again with who let it through.
    await hear({ type: 'entries', entries: [entry(2, { type: 'note.put', note: { ...note('n1', '# Ticket'), from: { ...outside, passed: { by: 'sam', at: 'now' } } } })] })
    expect(await screen.findByText('Let through by @sam')).toBeTruthy()
    expect(screen.queryByText(waiting)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Let it through' })).toBeNull()
  })

  it.each(['heard', 'asked'] as const)('says nothing more about a note that was %s, and has no button', async (strength) => {
    noteHub({ ...outside, strength })
    await mount(<Notes id="n1" />)
    await screen.findByText(/Came through/)
    expect(screen.queryByText(waiting)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Let it through' })).toBeNull()
    expect(screen.queryByText(/Let through by/)).toBeNull()
  })
})
