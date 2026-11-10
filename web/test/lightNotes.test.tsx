// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lightNote } from '../../shared/notes.ts'
import { FakeSocket, calledOn, entry, hear, hubState, me, mount, note, settle, standInHub, standInRoute } from './harness'
import { StoreProvider, useActions, useHub, useNoteText } from '../src/data/store'
import { keys } from '../src/data/sync'
import { Notes } from '../src/screens/Notes'

// A browser holds most notes without their text: the hub's light state sends how each starts, how long it is and what it
// links to. The text is asked for when the note is opened, and until it's here nothing may treat the empty text as the
// note's own: not the editor, which would send what's typed as the whole note, and not leaving the note, which throws
// away an empty one.

const seen = vi.hoisted(() => ({ texts: [] as string[], mounted: 0, unmounted: 0, live: 0 }))
vi.mock('../src/editor/MarkdownEditor', async () => {
  const { useEffect } = await import('react')
  return {
    MarkdownEditor: (props: { text: string }) => {
      seen.texts.push(props.text)
      useEffect(() => {
        seen.mounted++
        return () => void seen.unmounted++
      }, [])
      return <div data-testid="editor">{props.text}</div>
    },
  }
})
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => null }))
vi.mock('../src/components/NoteTree', () => ({ NoteTree: () => null }))
vi.mock('../src/components/NoteChat', () => ({ NoteChat: () => null }))

const light = (id: string, text = 'words', editedAt = 'then') => lightNote({ ...note(id, text), editedAt })
const lightHub = (...notes: ReturnType<typeof light>[]) => () => hubState({ notes })
const asNote = (id: string, text: string, editedAt = 'then') => ({ text, editedAt, id })

/** Has the stand-in hub answer a note's text: what `answer` says (a body, a Response, or a promise of either), by the note and how many times it's asked. */
function standInText(answer: (id: string, time: number) => unknown) {
  const hub = globalThis.fetch
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const found = /^\/api\/notes\/([^/?]+)\/text$/.exec(String(url))
    if (!found) return hub(url, init)
    const id = decodeURIComponent(found[1])
    asked.push(id)
    const sent = await answer(id, asked.filter((a) => a === id).length)
    return sent instanceof Response ? sent : new Response(JSON.stringify(sent), { headers: { 'content-type': 'application/json' } })
  }))
  return asked
}
const refused = (status: number) => new Response(JSON.stringify({ error: 'No such note' }), { status, headers: { 'content-type': 'application/json' } })
const sentNotes = (posted: ReturnType<typeof standInHub>['posted']) => posted.flatMap((p) => p.changes).map((c) => c.change).filter((c) => c.type.startsWith('note.'))

let actions: ReturnType<typeof useActions>
function Grab() {
  actions = useActions()
  return null
}
function Probe({ id }: { id: string }) {
  const { text, failed, again } = useNoteText(id)
  const left = useHub((state) => state.notes.find((n) => n.id === id)?.left)
  return <><p data-testid="text">{text === undefined ? 'none' : `text:${text}`}</p><p data-testid="failed">{String(failed)}</p><p data-testid="left">{String(!!left)}</p><button onClick={again}>again</button></>
}
const probed = () => screen.getByTestId('text').textContent

let posted: ReturnType<typeof standInHub>['posted']
beforeEach(() => {
  Object.assign(seen, { texts: [], mounted: 0, unmounted: 0 })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('asking for a note’s text', () => {
  beforeEach(() => {
    ;({ posted } = standInHub(lightHub(light('n1', 'words'), light('n2', 'other'), { ...note('whole', 'all here') })))
  })

  it('asks the hub, and holds what it says: the note is whole from then on', async () => {
    const asked = standInText((id) => asNote(id, 'words'))
    await mount(<><Grab /><Probe id="n1" /></>)
    await waitFor(() => expect(probed()).toBe('text:words'))
    expect(asked).toEqual(['n1'])
    expect(screen.getByTestId('left').textContent).toBe('false')
    expect(actions.current().notes.find((n) => n.id === 'n1')).toMatchObject({ text: 'words' })
    // Held here, never sent.
    await settle(400)
    expect(posted).toEqual([])
  })

  it('is no text at all until it’s here, never an empty one', async () => {
    let answer: (body: unknown) => void = () => {}
    standInText(() => new Promise((done) => { answer = done }))
    await mount(<Probe id="n1" />)
    expect(probed()).toBe('none')
    await settle(100)
    expect(probed()).toBe('none')
    await act(async () => answer(asNote('n1', 'words')))
    await waitFor(() => expect(probed()).toBe('text:words'))
  })

  it('asks nothing for a note that has its text', async () => {
    const asked = standInText((id) => asNote(id, 'x'))
    await mount(<Probe id="whole" />)
    await settle(100)
    expect(probed()).toBe('text:all here')
    expect(asked).toEqual([])
  })

  it('asks for a note once however many screens want it', async () => {
    const asked = standInText(async (id) => { await new Promise((done) => setTimeout(done, 50)); return asNote(id, 'words') })
    await mount(<><Probe id="n1" /><Probe id="n1" /></>)
    await waitFor(() => expect(screen.getAllByTestId('text').map((p) => p.textContent)).toEqual(['text:words', 'text:words']))
    expect(asked).toHaveLength(1)
  })

  it('asks again when the text is of another version of the note, and holds the one that matches', async () => {
    const asked = standInText((id, time) => asNote(id, time < 3 ? 'older words' : 'words', time < 3 ? 'earlier' : 'then'))
    await mount(<Probe id="n1" />)
    await waitFor(() => expect(probed()).toBe('text:words'), { timeout: 3000 })
    expect(asked).toHaveLength(3)
  })

  it('gives up after five tries, and tries again when asked to', async () => {
    const asked = standInText((id) => asNote(id, 'nope', 'never'))
    await mount(<Probe id="n1" />)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), { timeout: 4000 })
    expect(asked).toHaveLength(5)
    expect(probed()).toBe('none')
    await settle(900)
    expect(asked).toHaveLength(5)
    fireEvent.click(screen.getByText('again'))
    await waitFor(() => expect(asked.length).toBeGreaterThan(5))
    expect(screen.getByTestId('failed').textContent).toBe('false')
  })

  it('asks again by itself once the note here has caught up with the text it gave up on', async () => {
    // The hub's text is of a version of the note this tab hasn't heard of yet: its state is behind.
    const asked = standInText((id) => asNote(id, 'newer words', 'later'))
    await mount(<Probe id="n1" />)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), { timeout: 4000 })
    expect(asked).toHaveLength(5)
    // The change arrives: the note here is now the one the text is of, and nobody has to press anything.
    await hear({ type: 'entries', entries: [entry(2, { type: 'note.edit', id: 'n1', text: 'newer words', title: 'n1', by: 'sam', at: 'later' })] })
    await waitFor(() => expect(probed()).toBe('text:newer words'), { timeout: 3000 })
    expect(screen.getByTestId('failed').textContent).toBe('false')
    expect(screen.getByTestId('left').textContent).toBe('false')
  })

  it('fails at once when the hub has no such note', async () => {
    const asked = standInText(() => refused(404))
    await mount(<Probe id="n1" />)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'))
    expect(asked).toHaveLength(1)
    expect(probed()).toBe('none')
  })

  it('doesn’t take an answer that isn’t a text and when it was written for an empty note', async () => {
    const asked = standInText(() => ({}))
    await mount(<><Grab /><Probe id="n1" /></>)
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), { timeout: 4000 })
    expect(asked).toHaveLength(5)
    expect(actions.current().notes.find((n) => n.id === 'n1')).toMatchObject({ text: '', left: { size: 5 } })
  })

  it('stops when the screen goes', async () => {
    const asked = standInText((id) => asNote(id, 'nope', 'never'))
    await mount(<Probe id="n1" />)
    await waitFor(() => expect(asked).toHaveLength(1))
    cleanup()
    await settle(1000)
    expect(asked).toHaveLength(1)
  })

  it('stops asking for a note when the screen moves to another', async () => {
    const asked = standInText((id) => asNote(id, id === 'n2' ? 'other' : 'nope', id === 'n2' ? 'then' : 'never'))
    function Moves() {
      const { text } = useNoteText('n1')
      const second = useNoteText('n2').text
      return <p data-testid="both">{String(text)}|{String(second)}</p>
    }
    const { rerender } = render(<StoreProvider><Moves /></StoreProvider>)
    rerender(<StoreProvider><Probe id="n2" /></StoreProvider>)
    await settle(1000)
    expect(asked.filter((a) => a === 'n1').length).toBeLessThanOrEqual(2)
  })
})

describe('reading as a reader', () => {
  it('asks for a note’s text like anyone, as it’s a read', async () => {
    standInHub(lightHub(light('n1', 'words')), { ...me, role: 'reader' })
    const asked = standInText((id) => asNote(id, 'words'))
    await mount(<Probe id="n1" />)
    await waitFor(() => expect(probed()).toBe('text:words'))
    expect(asked).toEqual(['n1'])
  })
})

describe('guarding a note that isn’t loaded', () => {
  beforeEach(() => {
    ;({ posted } = standInHub(lightHub(light('n1', '# Plans\n\nlong words'), { ...note('whole', '# ') })))
  })

  it('sends nothing when its text is written whole, as that text is empty', async () => {
    await mount(<Grab />)
    await act(async () => actions.editNote('n1', 'x'))
    await act(async () => actions.editNote('n1', ''))
    await settle(400)
    expect(sentNotes(posted)).toEqual([])
    expect(actions.current().notes[0]).toMatchObject({ text: '', left: { size: 19 } })
  })

  it('sends the changes made to its document, which are only what was typed', async () => {
    await mount(<Grab />)
    await act(async () => actions.editNote('n1', '# Plans\n\nlong words!', ['change']))
    await settle(400)
    expect(sentNotes(posted)).toMatchObject([{ type: 'note.edit', id: 'n1', changes: ['change'] }])
    expect(actions.current().notes[0]).toMatchObject({ text: '', left: { size: 20 } })
  })

  it('is not thrown away when it’s left, as it isn’t empty', async () => {
    await mount(<Grab />)
    await act(async () => actions.discardIfEmpty('n1'))
    await settle(400)
    expect(sentNotes(posted)).toEqual([])
  })

  it('is thrown away when it’s whole and has nothing in it', async () => {
    await mount(<Grab />)
    await act(async () => actions.discardIfEmpty('whole'))
    await settle(400)
    expect(sentNotes(posted)).toMatchObject([{ type: 'note.delete', id: 'whole' }])
  })

  it('is whole from the start when this tab made it, and its text isn’t asked for', async () => {
    const asked = standInText(() => refused(404))
    await mount(<Grab />)
    let id = ''
    await act(async () => { id = actions.addNote('b1', undefined, '# Fresh\n\nwords') })
    const made = actions.current().notes.find((n) => n.id === id)!
    expect(made.left).toBeUndefined()
    expect(made.text).toBe('# Fresh\n\nwords')
    await settle(400)
    expect(sentNotes(posted)).toMatchObject([{ type: 'note.put', note: { id, text: '# Fresh\n\nwords' } }])
    function Opened() {
      useNoteText(id)
      return null
    }
    render(<StoreProvider><Opened /></StoreProvider>)
    await settle(100)
    expect(asked).toEqual([])
  })
})

describe('the editor of a note whose text is on its way', () => {
  it('is not made until the text is here, and never has an empty text', async () => {
    standInHub(lightHub(light('n1', '# Plans\n\nlong words')))
    let answer: (body: unknown) => void = () => {}
    standInText(() => new Promise((done) => { answer = done }))
    await mount(<Notes id="n1" />)
    expect(screen.queryByTestId('editor')).toBeNull()
    // Nothing shown at first, so a quick note doesn't flash.
    expect(screen.queryByText('Loading…')).toBeNull()
    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy(), { timeout: 1000 })
    expect(seen.mounted).toBe(0)
    await act(async () => answer(asNote('n1', '# Plans\n\nlong words')))
    await screen.findByTestId('editor')
    expect(screen.getByTestId('editor').textContent).toBe('# Plans\n\nlong words')
    expect(seen.texts.every((text) => text === '# Plans\n\nlong words')).toBe(true)
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('is made at once for a note that has its text', async () => {
    standInHub(() => hubState({ notes: [note('n1', '# Whole')] }))
    standInText(() => refused(404))
    await mount(<Notes id="n1" />)
    expect(screen.getByTestId('editor').textContent).toBe('# Whole')
    expect(seen.texts).not.toContain('')
  })

  it('says so when the note couldn’t be loaded, and loads it when asked to try again', async () => {
    standInHub(lightHub(light('n1', '# Plans')))
    const asked = standInText((id, time) => (time === 1 ? refused(404) : asNote(id, '# Plans')))
    await mount(<Notes id="n1" />)
    await screen.findByText(/This note couldn’t be loaded/)
    expect(screen.queryByTestId('editor')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('editor')
    expect(asked).toHaveLength(2)
    expect(seen.texts).toEqual(expect.arrayContaining(['# Plans']))
    expect(seen.texts).not.toContain('')
  })

  it('says so when the note isn’t on this device and the hub can’t be reached', async () => {
    standInHub(lightHub(light('n1', '# Plans')))
    // What was kept from last time, and a hub that doesn't answer for its state.
    window.localStorage.setItem(keys.cache, JSON.stringify({ version: 3, confirmed: hubState({ notes: [light('n1', '# Plans')] }) }))
    const asked = standInText(() => { throw new TypeError('Failed to fetch') })
    const hub = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).split('?')[0] === '/api/state') throw new TypeError('Failed to fetch')
      return hub(url, init)
    }))
    render(<StoreProvider><Notes id="n1" /></StoreProvider>)
    await screen.findByText('This note isn’t on this device yet. It loads when you’re back online.')
    // One try before the hub was known to be away, and no more while it is: the connection's own tries are the next.
    await settle(300)
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(asked).toHaveLength(1)
  })

  it('stays when a snapshot brings the note back without its text, and still shows what it had', async () => {
    let state = hubState({ notes: [light('n1', '# Plans\n\nwords')] })
    standInHub(() => state)
    let times = 0
    standInText((id) => (++times === 1 ? asNote(id, '# Plans\n\nwords') : new Promise(() => {})))
    await mount(<><Grab /><Notes id="n1" /></>)
    await screen.findByTestId('editor')
    expect(seen.mounted).toBe(1)
    // The hub's note was written elsewhere while this tab was away: its next snapshot has it light again.
    state = hubState({ notes: [light('n1', '# Plans\n\nwords, and more', 'later')] })
    standInRoute('GET', '/api/state', () => ({ version: 2, state, presence: {} }))
    await act(async () => { FakeSocket.open.at(-1)!.readyState = 3; FakeSocket.open.at(-1)!.onclose?.() })
    await waitFor(() => expect(actions.current().notes[0].left).toBeDefined(), { timeout: 3000 })
    expect(screen.getByTestId('editor').textContent).toBe('# Plans\n\nwords')
    expect(seen.mounted).toBe(1)
    expect(seen.unmounted).toBe(0)
    expect(seen.texts).not.toContain('')
    // Asked for again, by the stand-in the snapshot's route made.
    expect(calledOn().filter((c) => c.endsWith('/text'))).toHaveLength(1)
  })

  it('opens a reader’s note too', async () => {
    standInHub(lightHub(light('n1', '# Plans')), { ...me, role: 'reader' })
    standInText((id) => asNote(id, '# Plans'))
    await mount(<Notes id="n1" />)
    await screen.findByTestId('editor')
  })
})

describe('the linked mentions of a note', () => {
  const mentions = () => [...document.querySelectorAll('.backlink')].map((a) => a.textContent)

  it('are the notes whose links name it, from what stands in for their text, with the line when the hub says it', async () => {
    standInHub(() => hubState({ notes: [note('n1', '# n1'), light('n2', '# n2\n\n- See [[n1]] for more'), light('n3', '# n3\n\nNothing')] }))
    standInText((id) => asNote(id, id === 'n1' ? '# n1' : 'x'))
    const asking = standInRoute('GET', '/api/notes/n1/backlinks', () => ({ notes: [{ id: 'n2', title: 'n2', line: 'See [[n1]] for more' }] }))
    await mount(<Notes id="n1" />)
    // At once, with the title: the line comes after.
    expect(mentions()).toHaveLength(1)
    await waitFor(() => expect(mentions()[0]).toContain('See n1 for more'))
    expect(mentions()[0]).toContain('n2')
    expect(asking).toHaveLength(1)
  })

  it('are asked of the hub again when the notes that link here change', async () => {
    standInHub(() => hubState({ notes: [note('n1', '# n1'), light('n2', '# n2\n\nSee [[n1]]'), light('n3', '# n3\n\nNothing')] }))
    standInText((id) => asNote(id, '# n1'))
    const asking = standInRoute('GET', '/api/notes/n1/backlinks', () => ({ notes: [] }))
    await mount(<Notes id="n1" />)
    await waitFor(() => expect(asking).toHaveLength(1))
    await act(async () => {
      FakeSocket.open.at(-1)!.onmessage?.({ data: JSON.stringify({ type: 'entries', entries: [{ version: 2, id: 'e2', client: 'user:sam:other', at: 'now', change: { type: 'note.edit', id: 'n3', text: 'Now [[n1]]', title: 'n3', by: 'sam', at: 'later' } }] }) })
    })
    await waitFor(() => expect(asking).toHaveLength(2))
    expect(mentions()).toHaveLength(2)
  })

  it('ask the hub for nothing when every note that links here has its text', async () => {
    standInHub(() => hubState({ notes: [note('n1', '# n1'), note('n2', 'See [[n1]] for more')] }))
    standInText((id) => asNote(id, '# n1'))
    const asking = standInRoute('GET', '/api/notes/n1/backlinks', () => ({ notes: [] }))
    await mount(<Notes id="n1" />)
    await settle(100)
    expect(mentions()[0]).toContain('See n1 for more')
    expect(asking).toHaveLength(0)
  })
})
