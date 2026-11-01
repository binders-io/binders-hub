// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, isChunkError } from '../src/components/ErrorBoundary'

const chunkGone = new TypeError('Failed to fetch dynamically imported module: http://hub.test/assets/Notes-abc.js')

function Throws({ error }: { error: Error }): never {
  throw error
}

const online = (value: boolean) => vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value)

beforeEach(() => {
  window.sessionStorage.clear()
  // React and the boundary both report what they catch; it's expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(cleanup)

describe('telling a chunk that couldn’t load from a bug', () => {
  it('knows each browser’s words for it', () => {
    expect(isChunkError(chunkGone)).toBe(true)
    expect(isChunkError(new TypeError('error loading dynamically imported module: x'))).toBe(true)
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkError(new TypeError('card.activity is undefined'))).toBe(false)
  })

  it('knows Vite’s words for a screen whose stylesheet is gone, as a chunk with its own CSS has', () => {
    expect(isChunkError(new Error('Unable to preload CSS for /assets/AgentTerminal-abc.css'))).toBe(true)
  })
})

describe('a screen that can’t be shown', () => {
  it('reloads by itself once when its chunk is gone, as after the hub updated', () => {
    online(true)
    const reload = vi.fn()
    render(<ErrorBoundary reload={reload}><Throws error={chunkGone} /></ErrorBoundary>)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('stops reloading if that didn’t help, and offers it instead', () => {
    online(true)
    const reload = vi.fn()
    render(<ErrorBoundary reload={reload}><Throws error={chunkGone} /></ErrorBoundary>)
    cleanup()
    reload.mockClear()
    render(<ErrorBoundary reload={reload}><Throws error={chunkGone} /></ErrorBoundary>)
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/didn’t load/)
    act(() => screen.getByRole('button', { name: 'Reload' }).click())
    expect(reload).toHaveBeenCalledOnce()
  })

  it('doesn’t reload offline, where that would lose the page, and comes back by itself', () => {
    online(false)
    const reload = vi.fn()
    render(<ErrorBoundary reload={reload}><Throws error={chunkGone} /></ErrorBoundary>)
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/offline/)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(reload).toHaveBeenCalledOnce()
  })

  it('shows what went wrong in a screen, without reloading', () => {
    online(true)
    const reload = vi.fn()
    render(<ErrorBoundary reload={reload}><Throws error={new TypeError('card.activity is undefined')} /></ErrorBoundary>)
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/card\.activity is undefined/)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('tries again when you go somewhere else', () => {
    online(true)
    const { rerender } = render(<ErrorBoundary resetOn="a"><Throws error={new Error('broken')} /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toBeTruthy()
    rerender(<ErrorBoundary resetOn="b"><p>Fine</p></ErrorBoundary>)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Fine')).toBeTruthy()
  })

  it('leaves a screen that works alone', () => {
    render(<ErrorBoundary><p>Fine</p></ErrorBoundary>)
    expect(screen.getByText('Fine')).toBeTruthy()
  })
})
