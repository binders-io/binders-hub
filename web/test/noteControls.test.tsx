// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, note, standInHub } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteControls, useMayChange } from '../src/components/NoteControls'
import { useHub } from '../src/data/store'

// A locked note's buttons: who sees what, and what's sent to the hub.

const locked = { ...note('n1', '# Standards\n\nUse tabs.'), locked: { by: 'sam', at: 'then' } }
const proposal = { id: 'np-1', noteId: 'n1', binderId: 'b1', by: 'a1', at: 'then', why: 'The formatter uses spaces.', base: locked.text, text: '# Standards\n\nUse spaces.', state: 'open' as const, comments: [] }

function Controls() {
  const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
  const mayChange = useMayChange(current ?? { id: 'n1' })
  if (!current) return null
  return <><NoteControls note={current} mayChange={mayChange} /><output data-testid="may">{String(mayChange)}</output><ContextMenuHost /></>
}

function hubWith(mayChange: boolean, over: object = {}) {
  standInHub(() => hubState({ notes: [locked], noteProposals: [proposal], ...over }))
  const sent: { url: string; body?: unknown }[] = []
  const hub = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/access')) return new Response(JSON.stringify({ mayChange }), { headers: { 'content-type': 'application/json' } })
    if (init?.method === 'POST' && !url.startsWith('/api/changes')) sent.push({ url, body: JSON.parse(String(init.body)) })
    return hub(url, init)
  }))
  return sent
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a note’s controls on a phone', () => {
  function OnPhone({ more }: { more: () => void }) {
    const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
    const mayChange = useMayChange(current ?? { id: 'n1' })
    if (!current) return null
    return <><NoteControls note={current} mayChange={mayChange} more={[{ label: 'Schedule it', onSelect: more }, { label: 'Delete this note', danger: true, confirm: 'Delete for good?', onSelect: more }]} /><ContextMenuHost /></>
  }

  it('are one button, whose menu has them and what the screen adds, each doing what its button does', async () => {
    const sent = hubWith(true)
    const more = vi.fn()
    await mount(<OnPhone more={more} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'More for this note' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Binder guide' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Review 1 suggested change', 'Unlock', 'Make it the binder’s guide', 'Copy link', 'Schedule it', 'Delete this note'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule it' }))
    expect(more).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete this note' }))
    expect(more).toHaveBeenCalledOnce()
    screen.getByRole('menuitem', { name: 'Delete for good?' })
    fireEvent.keyDown(window, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unlock' }))
    await waitFor(() => expect(sent).toEqual([{ url: '/api/notes/n1/lock', body: { locked: false } }]))

    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Review 1 suggested change' }))
    screen.getByText('The formatter uses spaces.')
  })

  it('have Copy link, as the notes list’s rows do, which puts the note’s address on the clipboard and says so', async () => {
    hubWith(true)
    const written = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText: written } })
    const said: string[] = []
    window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string }>).detail.message))
    await mount(<OnPhone more={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'More for this note' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(written).toHaveBeenCalledWith(new URL('#/notes/n1', window.location.href).toString())
    await waitFor(() => expect(said).toContain('Link copied.'))
  })

  it('say when the link couldn’t be copied', async () => {
    hubWith(true)
    Object.assign(navigator, { clipboard: { writeText: async () => { throw new Error('no') } } })
    const said: { message: string; bad?: boolean }[] = []
    window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string; bad?: boolean }>).detail))
    await mount(<OnPhone more={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'More for this note' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(said).toEqual([{ message: 'Couldn’t copy the link.', bad: true }]))
  })

  it('don’t offer to unlock what you may not', async () => {
    hubWith(false)
    await mount(<OnPhone more={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'More for this note' }))
    expect(screen.getByRole('menuitem', { name: 'Unlock' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('a note’s controls over it on a wide window', () => {
  it('are its versions as a button, and the rest in its menu with what the screen adds', async () => {
    hubWith(true)
    const more = vi.fn()
    function Bar() {
      const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
      const mayChange = useMayChange(current ?? { id: 'n1' })
      if (!current) return null
      return <><NoteControls note={current} mayChange={mayChange} bar more={[{ label: 'Schedule it', onSelect: more }]}><button type="button">Full screen</button></NoteControls><ContextMenuHost /></>
    }
    await mount(<Bar />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'More for this note' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Versions and suggested changes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy()
    expect(screen.getByText('Locked')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Unlock', 'Make it the binder’s guide', 'Copy link', 'Schedule it']))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule it' }))
    expect(more).toHaveBeenCalledOnce()
  })
})

describe('a locked note’s controls', () => {
  it('lets who may change it accept what’s suggested', async () => {
    const sent = hubWith(true)
    await mount(<Controls />)
    await waitFor(() => expect(screen.getByTestId('may').textContent).toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Versions and suggested changes' }))
    screen.getByText('The formatter uses spaces.')
    screen.getByText('Use spaces.')
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(sent).toEqual([{ url: '/api/note-proposals/np-1/decide', body: { accept: true } }]))
  })

  it('lets anyone else talk it over and suggest, but not decide or unlock', async () => {
    const sent = hubWith(false)
    await mount(<Controls />)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/notes/n1/access', expect.anything()))
    expect(screen.getByTestId('may').textContent).toBe('false')
    // Locked says so over the note; its menu offers to unlock it, and won't.
    expect(screen.getByText('Locked')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    expect((await screen.findByRole('menuitem', { name: 'Unlock' })).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Versions and suggested changes' }))
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()

    fireEvent.change(document.getElementById('proposal-comment-np-1')!, { target: { value: 'Agreed.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(sent).toEqual([{ url: '/api/note-proposals/np-1/comments', body: { text: 'Agreed.' } }]))

    fireEvent.click(screen.getByRole('button', { name: 'Suggest a change' }))
    fireEvent.change(document.getElementById('proposal-text')!, { target: { value: '# Standards\n\nUse both.' } })
    fireEvent.change(document.getElementById('proposal-why')!, { target: { value: 'Both.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    await waitFor(() => expect(sent[1]).toEqual({ url: '/api/notes/n1/proposals', body: { text: '# Standards\n\nUse both.', why: 'Both.' } }))
  })

  it('won’t accept a suggested change the note has moved on from', async () => {
    hubWith(true, { notes: [{ ...locked, text: 'Moved on.' }] })
    await mount(<Controls />)
    await waitFor(() => expect(screen.getByTestId('may').textContent).toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Versions and suggested changes' }))
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true)
    screen.getByText(/changed since this was suggested/)
  })

  it('makes a note the binder’s guide', async () => {
    const { posted } = standInHub(() => hubState({ notes: [note('n1', '# Guide')] }))
    await mount(<Controls />)
    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make it the binder’s guide' }))
    await waitFor(() => expect(posted.flatMap((p) => p.changes).some(({ change }) => change.type === 'binder.put' && change.binder.guideNoteId === 'n1')).toBe(true))
  })
})
