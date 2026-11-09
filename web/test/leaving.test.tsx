// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, mount, settle, standInHub } from './harness'
import App from '../src/App'
import { phoneQuery } from '../src/components/bits'
import { toast } from '../src/components/Toast'

// Escape on a card’s page leaves the card, but only when nothing else is open to take it.

const asPhone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))
let back: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  standInHub(() => hubState({ cards: [card('c1', 'ready', { title: 'Fix the login' })] }))
  // A card opened from another screen of the app, so Back goes back in history.
  window.history.replaceState({ appDepth: 2 }, '', '#/work/c1')
  back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const opened = async () => {
  await mount(<App />)
  await settle(100)
  await screen.findByRole('heading', { level: 1, name: 'Fix the login' })
}
const escape = (on: Element = document.body) => fireEvent.keyDown(on, { key: 'Escape' })

describe('Escape on a card', () => {
  it('leaves it when nothing else is open', async () => {
    await opened()
    escape()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('goes to the board, not out of the app, when a link from elsewhere opened the card', async () => {
    window.history.replaceState({ appDepth: 0 }, '', '#/work/c1')
    await opened()
    escape()
    expect(back).not.toHaveBeenCalled()
    await waitFor(() => expect(window.location.hash).toBe('#/flow'))
  })

  it('only closes the “Give it to” picker when that’s open, and the next press leaves', async () => {
    await opened()
    const opener = screen.getByRole('button', { name: /Any agent/ })
    fireEvent.click(opener)
    expect(screen.getByRole('listbox', { name: 'Give it to' })).toBeTruthy()
    escape()
    expect(screen.queryByRole('listbox', { name: 'Give it to' })).toBeNull()
    expect(back).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
    escape()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('only closes the picker when the press comes from inside it', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: /Any agent/ }))
    escape(screen.getByRole('option', { name: /Agent/ }))
    expect(screen.queryByRole('listbox', { name: 'Give it to' })).toBeNull()
    expect(back).not.toHaveBeenCalled()
  })

  it('is taken first by a field being edited', async () => {
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Fix the login' }))
    const box = screen.getByRole('textbox', { name: 'Title' })
    fireEvent.change(box, { target: { value: 'Something else' } })
    escape(box)
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fix the login')
    expect(back).not.toHaveBeenCalled()
  })

  it('is taken first by a toast with focus in it, which it closes', async () => {
    await opened()
    act(() => toast('Dismissed.', { action: { label: 'Undo', run: () => {} } }))
    const undo = await screen.findByRole('button', { name: 'Undo' })
    undo.focus()
    escape(undo)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull())
    expect(back).not.toHaveBeenCalled()
  })

  it('is taken first by the search palette', async () => {
    await opened()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await screen.findByRole('dialog')
    // Focus is on the page behind, so only the palette being open stops it.
    escape()
    expect(back).not.toHaveBeenCalled()
  })

  it('is taken first by the phone’s menu', async () => {
    asPhone()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy()
    escape()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(back).not.toHaveBeenCalled()
  })
})
