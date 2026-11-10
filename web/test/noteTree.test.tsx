// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, note, settle, standInHub, standInRoute } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteTree, savedWords } from '../src/components/NoteTree'
import { Toast } from '../src/components/Toast'
import type { NotesSaved } from '../src/data/store'
import { UIContext } from '../src/ui'

// What a note or a folder can have done to it, without a right-click or a drag: a phone has neither.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const tree = () => hubState({
  binders: [{ id: 'b1', name: 'Binder' }],
  folders: [{ id: 'f1', name: 'Plans', binderId: 'b1' }, { id: 'f2', name: 'Old', binderId: 'b1', parentId: 'f1' }],
  notes: [note('n1', 'words')],
  cards: [],
})
const opened = () => mount(<UIContext.Provider value={ui}><NoteTree currentId="n1" /><ContextMenuHost /></UIContext.Provider>)
const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

let posted: ReturnType<typeof standInHub>['posted']

beforeEach(() => {
  ;({ posted } = standInHub(tree))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the notes tree without a right-click', () => {
  it('keeps a folder’s own actions in reach, however many places it could move to', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Old' }))
    await screen.findByRole('menu')
    expect(items()).toEqual(expect.arrayContaining(['New note', 'Rename', 'Move to', 'Delete']))
    expect(items()).not.toContain('Binder')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' }))
    await screen.findByRole('menuitem', { name: 'Back' })
    expect(items()).not.toContain('Delete')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Back' }))
    await screen.findByRole('menuitem', { name: 'Delete' })
  })

  it('stays open while its own list scrolls, and closes when the page does', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    const menu = await screen.findByRole('menu')
    fireEvent.scroll(menu)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.scroll(document.body)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('has no control inside a link', async () => {
    await opened()
    expect(document.querySelectorAll('a button, a a')).toHaveLength(0)
  })

  it('opens a note’s menu from a button named for it', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    await screen.findByRole('menu')
    expect(items()).toContain('Delete')
  })

  it('opens a folder’s menu from a button named for it', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Plans' }))
    await screen.findByRole('menu')
    expect(items()).toContain('Rename')
  })

  it('opens a binder’s menu from a button named for it', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Binder' }))
    await screen.findByRole('menu')
    expect(items()).toContain('New folder')
  })

  it('opens the binder’s General settings from its menu, by the section’s address', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Binder' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Binder settings' }))
    expect(window.location.hash).toBe('#/settings/general')
  })

  it('doesn’t follow the link when a note’s button is pressed', async () => {
    await opened()
    const before = window.location.hash
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    await screen.findByRole('menu')
    expect(window.location.hash).toBe(before)
  })
})

describe('moving without dragging', () => {
  it('moves a note to a folder from its menu', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Binder / Plans / Old' }))
    await settle()
    expect(posted.flatMap((p) => p.changes)[0].change).toMatchObject({ type: 'note.move', id: 'n1', binderId: 'b1', folderId: 'f2' })
  })

  it('doesn’t offer the place a note already is', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    await screen.findByRole('menuitem', { name: 'Back' })
    expect(items()).not.toContain('Binder')
    expect(items()).toContain('Binder / Plans')
  })

  it('doesn’t offer to put a folder inside itself or what’s in it', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Plans' }))
    await screen.findByRole('menu')
    expect(items().filter((item) => item?.startsWith('Binder / Plans'))).toEqual([])
  })

  it('moves a folder up out of the one it’s in', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Old' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Binder' }))
    await settle()
    expect(posted.flatMap((p) => p.changes)[0].change).toMatchObject({ type: 'folder.put', folder: { id: 'f2', binderId: 'b1' } })
  })
})

describe('deleting a folder from the tree', () => {
  it('asks with the shared press-again button, and deletes on the second press', async () => {
    await opened()
    const bin = screen.getByRole('button', { name: 'Delete Old' })
    expect(bin.classList.contains('confirm-button')).toBe(true)
    fireEvent.click(bin)
    await settle(0)
    expect(posted.flatMap((p) => p.changes).filter((c) => c.change.type === 'folder.delete')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete? Press again' }))
    await settle()
    expect(posted.flatMap((p) => p.changes).map((c) => c.change)).toContainEqual({ type: 'folder.delete', id: 'f2' })
  })

  it('goes back to what it was when it isn’t pressed again', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Old' }))
    fireEvent.blur(screen.getByRole('button', { name: 'Delete? Press again' }))
    expect(screen.getByRole('button', { name: 'Delete Old' })).toBeTruthy()
  })
})

describe('what saving says', () => {
  const saved = (over: Partial<NotesSaved> = {}): NotesSaved => ({ committed: 3, binders: [{ id: 'b1', name: 'Binder', repo: 'owner/repo', push: { to: 'owner/repo', branch: 'binders-notes' } }], ...over })

  it('leads with "saved" and "on GitHub", and keeps the repo and branch for the detail', () => {
    expect(savedWords(saved())).toEqual({ ok: true, text: '3 notes saved to GitHub', detail: 'Pushed to owner/repo (binders-notes).' })
    expect(savedWords(saved({ committed: 1 })).text).toBe('1 note saved to GitHub')
    expect(savedWords(saved({ committed: 0 })).text).toBe('Every note was already saved to GitHub')
  })

  it('says when they’re saved but not on GitHub, and why', () => {
    expect(savedWords(saved({ binders: [{ id: 'b1', name: 'Binder' }] }))).toMatchObject({ ok: true, text: '3 notes saved, but not on GitHub yet. Set a repo for these notes in Settings → GitHub.' })
    expect(savedWords(saved({ binders: [{ id: 'b1', name: 'Binder', repo: 'owner/repo', push: { to: 'owner/repo', error: 'No access.' } }] }))).toMatchObject({ ok: false, text: '3 notes saved, but not on GitHub: pushing to owner/repo failed: No access.' })
  })

  it('says it as a toast, with where to one press away', async () => {
    standInRoute('POST', '/api/notes/save', () => saved())
    render(<Toast />)
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Save all notes' }))
    // Each folder’s bin has a quiet region of its own for its question, so what’s said is what the regions say together.
    const said = () => screen.getAllByRole('status').map((region) => region.textContent).join('')
    await waitFor(() => expect(said()).toBe('3 notes saved to GitHub'))
    fireEvent.click(screen.getByRole('button', { name: 'Where to' }))
    await waitFor(() => expect(said()).toBe('Pushed to owner/repo (binders-notes).'))
  })

  it('says it as a failure when GitHub didn’t take them', async () => {
    standInRoute('POST', '/api/notes/save', () => saved({ binders: [{ id: 'b1', name: 'Binder', repo: 'owner/repo', push: { to: 'owner/repo', error: 'No access.' } }] }))
    render(<Toast />)
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Save all notes' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not on GitHub'))
  })

  it('says a link that couldn’t be copied as a failure', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('no')) } })
    render(<Toast />)
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Couldn’t copy the link.'))
  })
})
