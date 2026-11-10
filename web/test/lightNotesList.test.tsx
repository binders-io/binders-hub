// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guideMost } from '../../shared/guide.ts'
import { lightNote } from '../../shared/notes.ts'
import { hubState, mount, note, settle, standInHub } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteControls, useMayChange } from '../src/components/NoteControls'
import { NoteTree } from '../src/components/NoteTree'
import { RepoBriefs } from '../src/components/RepoBriefs'
import { useActions, useHub } from '../src/data/store'
import { UIContext } from '../src/ui'

// What a screen does with a note whose text isn't here: the notes list finds it by how it starts and by what the hub
// says is in it, and a note's controls read its text only when it's here.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const light = (id: string, title: string, text: string, over: object = {}) => lightNote({ ...note(id, text), title, ...over })
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Has the stand-in hub answer the search, as `answer` says for the words (a body, or a promise of one). Gives the words asked. */
function standInSearch(answer: (words: string) => unknown) {
  const hub = globalThis.fetch
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('/api/notes/search')) return hub(url, init)
    const words = new URL(String(url), 'http://hub.test').searchParams.get('q') ?? ''
    asked.push(words)
    return reply(await answer(words))
  }))
  return asked
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('filtering the notes list when most notes have no text here', () => {
  const rows = () => [...document.querySelectorAll('.tree-results .tree-row')].map((row) => row.querySelector('.tree-label b')?.textContent)
  const typeIn = (words: string) => fireEvent.change(screen.getByPlaceholderText('Filter notes'), { target: { value: words } })

  beforeEach(() => {
    standInHub(() => hubState({
      notes: [
        light('a', 'Alpha', '# Alpha\n\nzebra crossing, near the start'),
        light('b', 'Beta', `# Beta\n\n${'filler '.repeat(200)}the deepword is far down`),
        light('c', 'Gamma', '# Gamma\n\nnothing'),
        note('d', 'whole note with a hiddenword in it'),
      ],
    }))
  })
  const opened = () => mount(<UIContext.Provider value={ui}><NoteTree currentId="a" /></UIContext.Provider>)

  it('finds a note by its title, its place and how it starts, at once, with no hub', async () => {
    const asked = standInSearch(() => ({ ids: [] }))
    await opened()
    typeIn('zebra')
    expect(rows()).toEqual(['Alpha'])
    typeIn('binder gamma')
    expect(rows()).toEqual(['Gamma'])
    expect(asked).toEqual([])
  })

  it('finds a note that has its text by all of it, as before', async () => {
    standInSearch(() => ({ ids: [] }))
    await opened()
    typeIn('hiddenword')
    expect(rows()).toEqual(['d'])
  })

  it('adds the notes the hub finds the words in, when typing has paused', async () => {
    const asked = standInSearch(() => ({ ids: ['b'] }))
    await opened()
    typeIn('deepword')
    expect(rows()).toEqual([])
    expect(screen.getByText('No note matches “deepword”.')).toBeTruthy()
    await waitFor(() => expect(rows()).toEqual(['Beta']), { timeout: 2000 })
    expect(asked).toEqual(['deepword'])
  })

  it('asks the hub once typing has paused, and not for a single character', async () => {
    const asked = standInSearch(() => ({ ids: [] }))
    await opened()
    typeIn('d')
    await settle(400)
    expect(asked).toEqual([])
    typeIn('de')
    typeIn('dee')
    typeIn('deep')
    await settle(400)
    expect(asked).toEqual(['deep'])
  })

  it('doesn’t show the answer to words that are no longer typed', async () => {
    const late = new Promise<unknown>((done) => setTimeout(() => done({ ids: ['c'] }), 700))
    const asked = standInSearch((words) => (words === 'deep' ? late : { ids: ['b'] }))
    await opened()
    typeIn('deep')
    await settle(300)
    expect(asked).toEqual(['deep'])
    typeIn('deepword')
    await settle(1000)
    expect(asked).toEqual(['deep', 'deepword'])
    expect(rows()).toEqual(['Beta'])
  })

  it('is what’s here when the hub can’t be reached', async () => {
    standInSearch(() => { throw new TypeError('Failed to fetch') })
    await opened()
    typeIn('zebra')
    await settle(400)
    expect(rows()).toEqual(['Alpha'])
    typeIn('deepword')
    await settle(400)
    expect(rows()).toEqual([])
  })
})

describe('the order of a folder of captures when their text isn’t here', () => {
  it('is by when they were recorded, read from how each starts', async () => {
    const heard = (title: string, when: string) => `# ${title}\n\n_Conversation · ${when} UTC · 3 min_\n\n## Transcript\n\n${'words '.repeat(300)}\n`
    standInHub(() => hubState({
      folders: [{ id: 'caps', name: 'Captures', binderId: 'b1' }],
      notes: [
        light('a', 'Alpha', heard('Alpha', '2026-11-07 14:03'), { folderId: 'caps', captured: 'conversation' }),
        light('b', 'Beta', heard('Beta', '2026-11-09 08:00'), { folderId: 'caps', captured: 'meeting' }),
        light('c', 'Gamma', heard('Gamma', '2026-11-08 20:15'), { folderId: 'caps', captured: 'conversation' }),
      ],
    }))
    await mount(<UIContext.Provider value={ui}><NoteTree currentId="a" /></UIContext.Provider>)
    const group = screen.getByRole('button', { name: 'Close Captures' }).closest('[role="group"]') as HTMLElement
    expect([...group.querySelectorAll('.note-row b')].map((b) => b.textContent)).toEqual(['Beta', 'Gamma', 'Alpha'])
  })
})

describe('a note’s controls when its text isn’t here', () => {
  const talk = 'so the van needs new tyres before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams'
  let actions: ReturnType<typeof useActions>
  function OnPhone() {
    actions = useActions()
    const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
    const mayChange = useMayChange(current ?? { id: 'n1' })
    if (!current) return null
    return <><NoteControls note={current} mayChange={mayChange} more={[]} /><ContextMenuHost /></>
  }
  const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent)
  const menu = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'More for this note' }))
    await screen.findByRole('menu')
  }

  it('offers Sum it up only once the text is here, to be read', async () => {
    standInHub(() => hubState({ notes: [light('n1', 'Van', `# Van\n\n${talk}\n`)] }))
    await mount(<OnPhone />)
    await menu()
    expect(items()).not.toContain('Sum it up')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await act(async () => { actions.holdNote('n1', `# Van\n\n${talk}\n`, 'then') })
    await menu()
    expect(items()).toContain('Sum it up')
  })

  it('says a guide is long from the note’s length, which is known without its text', async () => {
    standInHub(() => hubState({
      binders: [{ id: 'b1', name: 'Binder', guideNoteId: 'n1' }],
      notes: [light('n1', 'Guide', `# Guide\n\n${'x'.repeat(guideMost)}`)],
    }))
    function Plain() {
      const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
      return current ? <NoteControls note={current} mayChange /> : null
    }
    await mount(<Plain />)
    expect(screen.getByText('Long for a guide')).toBeTruthy()
  })

  it('doesn’t say a short guide is long', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', guideNoteId: 'n1' }], notes: [light('n1', 'Guide', '# Guide\n\nShort.')] }))
    function Plain() {
      const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
      return current ? <NoteControls note={current} mayChange /> : null
    }
    await mount(<Plain />)
    expect(screen.queryByText('Long for a guide')).toBeNull()
  })

  describe('in what’s suggested for a locked note', () => {
    const locked = light('n1', 'Standards', '# Standards\n\nUse tabs.', { locked: { by: 'sam', at: 'then' } })
    const proposal = { id: 'np-1', noteId: 'n1', binderId: 'b1', by: 'a1', at: 'then', why: 'The formatter uses spaces.', base: '# Standards\n\nUse tabs.', text: '# Standards\n\nUse spaces.', state: 'open' as const, comments: [] }

    function Locked() {
      const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
      const mayChange = useMayChange(current ?? { id: 'n1' })
      return current ? <NoteControls note={current} mayChange={mayChange} /> : null
    }

    it('keeps Accept off until the text is here to compare with, then lets it on when nothing changed', async () => {
      standInHub(() => hubState({ notes: [locked], noteProposals: [proposal] }))
      let answer: (body: unknown) => void = () => {}
      const hub = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/access')) return reply({ mayChange: true })
        if (String(url).endsWith('/text')) return reply(await new Promise((done) => { answer = done }))
        return hub(url, init)
      }))
      await mount(<Locked />)
      await settle(50)
      fireEvent.click(await screen.findByRole('button', { name: 'Versions and suggested changes' }))
      const accept = await screen.findByRole('button', { name: 'Accept' })
      expect((accept as HTMLButtonElement).disabled).toBe(true)
      await act(async () => answer({ text: '# Standards\n\nUse tabs.', editedAt: 'then' }))
      await waitFor(() => expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false))
    })

    it('says the note has changed once its text is here and isn’t what was suggested on', async () => {
      standInHub(() => hubState({ notes: [locked], noteProposals: [{ ...proposal, base: '# Standards\n\nUse tabs, always.' }] }))
      const hub = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/access')) return reply({ mayChange: true })
        if (String(url).endsWith('/text')) return reply({ text: '# Standards\n\nUse tabs.', editedAt: 'then' })
        return hub(url, init)
      }))
      await mount(<Locked />)
      await settle(50)
      fireEvent.click(await screen.findByRole('button', { name: 'Versions and suggested changes' }))
      await screen.findByText(/The note has changed since this was suggested/)
      expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('has Suggest a change start from the note’s text once it’s here, never from an empty one', async () => {
      standInHub(() => hubState({ notes: [locked] }))
      let answer: (body: unknown) => void = () => {}
      const hub = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/access')) return reply({ mayChange: false })
        if (String(url).endsWith('/text')) return reply(await new Promise((done) => { answer = done }))
        return hub(url, init)
      }))
      await mount(<Locked />)
      await settle(50)
      fireEvent.click(await screen.findByRole('button', { name: 'Versions and suggested changes' }))
      const suggest = await screen.findByRole('button', { name: 'Suggest a change' })
      expect((suggest as HTMLButtonElement).disabled).toBe(true)
      await act(async () => answer({ text: '# Standards\n\nUse tabs.', editedAt: 'then' }))
      await waitFor(() => expect((screen.getByRole('button', { name: 'Suggest a change' }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByRole('button', { name: 'Suggest a change' }))
      expect((await screen.findByLabelText('How it should read') as HTMLTextAreaElement).value).toBe('# Standards\n\nUse tabs.')
    })
  })
})

describe('a repo’s brief kept in a note whose text isn’t here', () => {
  it('is still a brief, written and there to read', async () => {
    const brief = { id: 'acme/api', repo: 'acme/api', noteId: 'n1', writtenAt: new Date().toISOString(), writtenBy: 'a1' }
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/api' }], notes: [light('n1', 'acme/api', '# acme/api\n\nThe API is in Go. It has three services.')], briefs: [brief] }))
    await mount(<RepoBriefs />)
    await screen.findByText(/^Written (just now|on |\d+[smh] ago)/)
    expect(screen.queryByText(/No brief yet/)).toBeNull()
    expect(screen.getByRole('link', { name: /Read it in/ })).toBeTruthy()
  })
})

