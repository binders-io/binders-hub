// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, entry, hear, hubState, mount, note, Ready, settle, standInHub, standInRoute } from './harness'
import { phoneQuery } from '../src/components/bits'
import { openOnDistill } from '../src/components/notesLayout'
import { StoreProvider, useActions } from '../src/data/store'
import type { Marks } from '../src/editor/workMarks'
import { Notes } from '../src/screens/Notes'

// A note on a phone has its chat and its Distill: three views of one note, each filling the screen, and a way in to
// Distill from elsewhere. Also what happens to a note that's gone, and to one nobody wrote in.

const seen = vi.hoisted(() => ({ marks: undefined as unknown }))
vi.mock('../src/editor/MarkdownEditor', () => ({
  MarkdownEditor: (props: { marks: Marks }) => {
    seen.marks = props.marks
    return <div data-testid="editor" />
  },
}))
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => null }))

const widthIs = (phone: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))
const asPhone = () => widthIs(true)

const proposal = (id: string, state: 'new' | 'accepted' | 'dismissed' = 'new') => ({ id, binderId: 'b1', noteId: 'n1', title: `Do ${id}`, quote: `Quote ${id}`, brief: '', doneWhen: '', size: 'S' as const, by: 'a1', state })
const second = { ...agent, id: 'a2', name: 'Other' }
const world = (over: object = {}) => hubState({ notes: [note('n1', '# One\n\nwords')], proposals: [proposal('p1'), proposal('p2')], agents: [agent, second], ...over })

let actions: ReturnType<typeof useActions>
function Grab() {
  actions = useActions()
  return null
}

const views = () => within(screen.getByRole('group', { name: 'Show' }))
// By name, which carries the count: "Distill, 2 proposed" is the Distill button.
const pressed = () => views().getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label')!.split(',')[0])

beforeEach(() => {
  // The chat scrolls to its newest message, which jsdom has no layout for.
  Element.prototype.scrollTo = () => {}
  standInHub(world)
  widthIs(false)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('a note on a phone', () => {
  it('has a switch at its top between the note, its chat and Distill, and says which is showing', async () => {
    asPhone()
    await mount(<Notes id="n1" />)
    expect(views().getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Note', 'Chat', 'Distill, 2 proposed'])
    expect(pressed()).toEqual(['Note'])
    expect(screen.getByTestId('editor')).toBeTruthy()
    expect(document.querySelector('.distill')).toBeNull()
  })

  it('leaves the switch out of the way of a keyboard: its buttons are ordinary buttons in the tab order', async () => {
    asPhone()
    await mount(<Notes id="n1" />)
    for (const button of views().getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('tabindex')).toBeNull()
    }
  })

  it('shows the chat filling the screen, with the switch still there to go back', async () => {
    asPhone()
    await mount(<Notes id="n1" />)
    fireEvent.click(views().getByRole('button', { name: 'Chat' }))
    expect(pressed()).toEqual(['Chat'])
    const panel = screen.getByRole('complementary', { name: 'Chat about the note' })
    expect(within(panel).getByRole('combobox', { name: 'Who to talk with' })).toBeTruthy()
    expect(within(panel).getByPlaceholderText('Message Agent…')).toBeTruthy()
    expect(document.querySelector('article.note')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(views().getByRole('button', { name: 'Note' }))
    expect(pressed()).toEqual(['Note'])
    expect(document.querySelector('article.note')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('.distill')).toBeNull()
  })

  it('shows Distill filling the screen, with a count of what waits, and none when nothing does', async () => {
    asPhone()
    await mount(<><Grab /><Notes id="n1" /></>)
    fireEvent.click(views().getByRole('button', { name: 'Distill, 2 proposed' }))
    expect(pressed()).toEqual(['Distill'])
    const panel = screen.getByRole('complementary', { name: 'Distill the note' })
    expect(within(panel).getByText('Do p1')).toBeTruthy()
    expect(within(panel).getByText('Do p2')).toBeTruthy()
    await act(async () => actions.dismissProposal('p1'))
    await act(async () => actions.dismissProposal('p2'))
    expect(views().getByRole('button', { name: 'Distill' }).querySelector('.waiting')).toBeNull()
  })

  it('does in Distill all it does beside a note: choosing the agent, asking, accepting, dismissing, accepting all', async () => {
    asPhone()
    const asked = standInRoute('POST', '/api/cards', () => ({}))
    const accepted = standInRoute('POST', /^\/api\/proposals\/[^/]+\/accept$/)
    await mount(<><Grab /><Notes id="n1" /></>)
    fireEvent.click(views().getByRole('button', { name: 'Distill, 2 proposed' }))
    const panel = within(screen.getByRole('complementary', { name: 'Distill the note' }))

    fireEvent.change(panel.getByRole('combobox'), { target: { value: 'a2' } })
    fireEvent.click(panel.getByRole('button', { name: 'Distill again' }))
    await settle(20)
    expect(asked).toEqual([expect.objectContaining({ meantFor: 'a2', noteId: 'n1' })])

    fireEvent.click(panel.getAllByRole('button', { name: 'Dismiss' })[1])
    expect(actions.current().proposals.find((p) => p.id === 'p2')?.state).toBe('dismissed')

    fireEvent.click(panel.getAllByRole('button', { name: 'Accept' })[0])
    await settle(20)
    expect(accepted).toHaveLength(1)
  })

  it('accepts every proposed card from one button', async () => {
    asPhone()
    const urls: string[] = []
    const hub = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (/^\/api\/proposals\/[^/]+\/accept$/.test(url)) {
        urls.push(url)
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      }
      return hub(url, init)
    }))
    await mount(<Notes id="n1" />)
    fireEvent.click(views().getByRole('button', { name: 'Distill, 2 proposed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }))
    await settle(20)
    expect(urls).toEqual(['/api/proposals/p1/accept', '/api/proposals/p2/accept'])
  })

  it('makes room for the keyboard while writing in the chat, and gives it back on leaving', async () => {
    asPhone()
    vi.stubGlobal('visualViewport', { height: 420, addEventListener() {}, removeEventListener() {} })
    await mount(<Notes id="n1" />)
    fireEvent.click(views().getByRole('button', { name: 'Chat' }))
    const box = screen.getByPlaceholderText('Message Agent…')
    fireEvent.focus(box)
    expect(document.documentElement.classList.contains('writing')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--room')).toBe('420px')
    fireEvent.click(views().getByRole('button', { name: 'Note' }))
    expect(document.documentElement.classList.contains('writing')).toBe(false)
  })

  it('opens every note on the note, not on the view the last one was left on', async () => {
    standInHub(() => world({ notes: [note('n1', '# One\n\nwords'), note('n2', '# Two\n\nwords')] }))
    asPhone()
    function Both() {
      const [id, setId] = useState('n1')
      return <><button onClick={() => setId('n2')}>Other note</button><Notes id={id} /></>
    }
    await mount(<Both />)
    fireEvent.click(views().getByRole('button', { name: /^Distill/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Other note' }))
    expect(pressed()).toEqual(['Note'])
  })
})

describe('above 900px', () => {
  it('has no switch, and the panel is beside the note as it was', async () => {
    await mount(<Notes id="n1" />)
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
    expect(document.querySelector('article.note')?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByRole('complementary', { name: 'Beside the note' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Chat/ }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('opening a note on Distill from elsewhere', () => {
  it('shows the panel, open and on Distill, on a desktop where it was closed and on Chat', async () => {
    window.localStorage.setItem('binders-notes-layout', JSON.stringify({ sideOpen: false }))
    window.localStorage.setItem('binders-note-side', 'chat')
    openOnDistill('n1')
    await mount(<Notes id="n1" />)
    const panel = screen.getByRole('complementary', { name: 'Beside the note' })
    expect(within(panel).getByRole('tab', { name: /Distill/ }).getAttribute('aria-selected')).toBe('true')
    expect(within(panel).getByText('Do p1')).toBeTruthy()
  })

  it('shows the Distill view on a phone', async () => {
    asPhone()
    openOnDistill('n1')
    await mount(<Notes id="n1" />)
    expect(pressed()).toEqual(['Distill'])
    expect(screen.getByRole('complementary', { name: 'Distill the note' })).toBeTruthy()
  })

  it('does it too when the note is already showing', async () => {
    asPhone()
    await mount(<Notes id="n1" />)
    expect(pressed()).toEqual(['Note'])
    act(() => openOnDistill('n1'))
    expect(pressed()).toEqual(['Distill'])
  })

  it('is for the note it was asked for, and only for a few seconds', async () => {
    asPhone()
    openOnDistill('n2')
    await mount(<Notes id="n1" />)
    expect(pressed()).toEqual(['Note'])
    cleanup()
    const now = Date.now()
    openOnDistill('n1')
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
    await mount(<Notes id="n1" />)
    expect(pressed()).toEqual(['Note'])
    vi.restoreAllMocks()
  })

  it('is what pressing a Proposed mark in the note does', async () => {
    asPhone()
    await mount(<Notes id="n1" />)
    expect(pressed()).toEqual(['Note'])
    act(() => (seen.marks as Marks).distill?.())
    expect(pressed()).toEqual(['Distill'])
  })
})

describe('a note that isn’t there', () => {
  it('says so, with a way to the list, and opens no other note in its place', async () => {
    window.localStorage.setItem('binders-last-note:all', 'n1')
    await mount(<Notes id="gone" />)
    expect(screen.getByText('That note isn’t here any more')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to your notes' }).getAttribute('href')).toBe('#/notes')
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('says so on a phone too, where the list is the way out', async () => {
    asPhone()
    await mount(<Notes id="gone" />)
    expect(screen.getByText('That note isn’t here any more')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to your notes' })).toBeTruthy()
  })

  it('waits for the hub before saying it', async () => {
    render(<StoreProvider><Ready /><Notes id="gone" /></StoreProvider>)
    expect(screen.getByRole('status').textContent).toBe('Opening the note…')
    expect(screen.queryByText('That note isn’t here any more')).toBeNull()
    await screen.findByText('That note isn’t here any more')
  })

  it('says so when the note open is deleted by someone else', async () => {
    await mount(<Notes id="n1" />)
    expect(screen.getByTestId('editor')).toBeTruthy()
    await hear({ type: 'entries', entries: [entry(2, { type: 'note.delete', id: 'n1' })] })
    expect(screen.getByText('That note isn’t here any more')).toBeTruthy()
  })

  it('says nothing about a note you delete yourself', async () => {
    standInHub(() => world({ notes: [note('n1', '# One\n\nwords'), note('n2', '# Two\n\nwords')] }))
    await mount(<><Grab /><Notes id="n1" /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete this note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete this note for good? Press again' }))
    expect(actions.current().notes.map((n) => n.id)).toEqual(['n2'])
    expect(screen.queryByText('That note isn’t here any more')).toBeNull()
  })
})

describe('deleting a note from its screen', () => {
  it('asks first, in the button, and says what goes', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete this note' }))
    expect(screen.getByRole('button', { name: 'Delete this note for good? Press again' })).toBeTruthy()
    expect(actions.current().notes.map((n) => n.id)).toEqual(['n1'])
  })
})

describe('a chat’s Start over', () => {
  const chat = { id: 'chat-n1-a1', noteId: 'n1', agentId: 'a1', messages: [{ at: 'then', by: 'you', text: 'tighten it' }, { at: 'then', by: 'a1', text: 'done' }] }

  it('asks first, then clears it', async () => {
    standInHub(() => world({ chats: [chat] }))
    await mount(<><Grab /><Notes id="n1" /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByRole('button', { name: 'Clear this chat? Press again' })).toBeTruthy()
    expect(screen.getByText('tighten it')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear this chat? Press again' }))
    expect(screen.queryByText('tighten it')).toBeNull()
    expect((actions.current().chats ?? []).find((c) => c.id === chat.id)?.messages ?? []).toEqual([])
  })

  it('goes back to what it was when pressed elsewhere', async () => {
    standInHub(() => world({ chats: [chat] }))
    await mount(<Notes id="n1" />)
    const button = screen.getByRole('button', { name: 'Start over' })
    fireEvent.click(button)
    fireEvent.blur(screen.getByRole('button', { name: 'Clear this chat? Press again' }))
    expect(screen.getByRole('button', { name: 'Start over' })).toBeTruthy()
    expect(screen.getByText('tighten it')).toBeTruthy()
  })
})

describe('a note nobody wrote in', () => {
  const blank = () => hubState({ notes: [note('n1', '# '), note('n2', '# Two\n\nwords')], proposals: [] })
  function Screen({ id = 'n1' }: { id?: string }) {
    const [on, setOn] = useState(true)
    return <><button onClick={() => setOn(false)}>Leave</button>{on && <Notes id={id} />}</>
  }

  it('is thrown away when the person leaves the Notes screen', async () => {
    standInHub(blank)
    await mount(<><Grab /><Screen /></>)
    expect(actions.current().notes.map((n) => n.id)).toContain('n1')
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await settle(20)
    expect(actions.current().notes.map((n) => n.id)).toEqual(['n2'])
  })

  it('stays while the screen does, though development draws it twice', async () => {
    standInHub(blank)
    await mount(<StrictMode><Grab /><Notes id="n1" /></StrictMode>)
    await settle(20)
    expect(actions.current().notes.map((n) => n.id)).toContain('n1')
  })

  it('isn’t thrown away once it has words', async () => {
    standInHub(() => hubState({ notes: [note('n2', '# Two\n\nwords')], proposals: [] }))
    await mount(<><Grab /><Screen id="n2" /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await settle(20)
    expect(actions.current().notes.map((n) => n.id)).toEqual(['n2'])
  })
})

describe('what a note says about saving', () => {
  const withBinder = (binder: object, n: object) => standInHub(() => world({ binders: [{ id: 'b1', name: 'Binder', ...binder }], notes: [{ ...note('n1', '# One\n\nwords'), ...n }], proposals: [] }))
  const saved = () => document.querySelector<HTMLButtonElement>('.note-saved-button')!

  it('says "Saved" with the commit, branch and file a hover away', async () => {
    withBinder({ repo: 'owner/notes', notesBranch: 'binders-notes' }, { commit: 'abc1234' })
    await mount(<Notes id="n1" />)
    expect(saved().textContent?.trim()).toBe('Saved')
    expect(saved().title).toContain('Commit abc1234')
    expect(saved().title).toContain('owner/notes')
    expect(saved().title).toContain('binders-notes')
    expect(saved().title).toContain('.md')
  })

  it('shows them under the line on a press, and again hides them', async () => {
    withBinder({ repo: 'owner/notes' }, { commit: 'abc1234' })
    await mount(<Notes id="n1" />)
    expect(saved().getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.note-path')).toBeNull()
    fireEvent.click(saved())
    expect(saved().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.note-path')?.textContent).toMatch(/Commit abc1234\..*owner\/notes.*File: .*\.md/)
    fireEvent.click(saved())
    expect(document.querySelector('.note-path')).toBeNull()
  })

  it('says it isn’t on GitHub yet while the hub hasn’t committed it', async () => {
    withBinder({ repo: 'owner/notes' }, {})
    await mount(<Notes id="n1" />)
    expect(saved().textContent?.trim()).toBe('Saved, not on GitHub yet')
    expect(document.body.textContent).not.toMatch(/not saved/)
  })

  it('says only "Saved" for a binder with no repo to send it to', async () => {
    withBinder({}, {})
    await mount(<Notes id="n1" />)
    expect(saved().textContent?.trim()).toBe('Saved')
    expect(saved().title).toContain('no repo')
  })
})
