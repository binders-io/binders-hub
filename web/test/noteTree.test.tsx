// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, note, settle, standInHub } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteTree } from '../src/components/NoteTree'
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
