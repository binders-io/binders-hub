// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, HubError, isNetworkFailure, unreachable } from '../src/data/api'
import { Toast, attempt, failure, toast } from '../src/components/Toast'

// A toast says what happened, can carry a button, and tells good news from bad.

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

describe('a toast', () => {
  it('reads an ordinary one politely and a failure as an alert, each in its own region', async () => {
    render(<Toast />)
    toast('Link copied.')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Link copied.'))
    expect(screen.getByRole('alert').textContent).toBe('')
    failure('The hub refused that.')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The hub refused that.'))
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('looks different when it is a failure', async () => {
    render(<Toast />)
    toast('Link copied.')
    expect((await screen.findAllByText('Link copied.')).some((el) => el.closest('.toast'))).toBe(true)
    expect(document.querySelector('.toast.bad')).toBeNull()
    failure('That failed.')
    await waitFor(() => expect(document.querySelector('.toast.bad')).toBeTruthy())
  })

  it('carries a button that does what it says and closes the toast', async () => {
    const undo = vi.fn()
    render(<Toast />)
    toast('Card deleted.', { action: { label: 'Undo', run: undo } })
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelector('.toast')).toBeNull())
  })

  it('closes first and then runs its button, so a toast the button shows stays', async () => {
    render(<Toast />)
    toast('Notes saved.', { action: { label: 'Where to', run: () => toast('Pushed to owner/repo.') } })
    fireEvent.click(await screen.findByRole('button', { name: 'Where to' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Pushed to owner/repo.'))
    expect(screen.queryByRole('button', { name: 'Where to' })).toBeNull()
  })

  it('can carry a button and be bad news at once', async () => {
    render(<Toast />)
    failure('Couldn’t save.', { action: { label: 'Try again', run: () => {} } })
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(document.querySelector('.toast.bad')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t save.')
  })

  it('says its words once to a screen reader, with a button too', async () => {
    render(<Toast />)
    toast('Card deleted.', { action: { label: 'Undo', run: () => {} } })
    await screen.findByRole('button', { name: 'Undo' })
    const spoken = screen.getAllByText('Card deleted.').filter((el) => !el.closest('[aria-hidden="true"]'))
    expect(spoken).toHaveLength(1)
  })

  it('stays longer with a button, and while it has focus', async () => {
    render(<Toast />)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => { toast('Card deleted.', { action: { label: 'Undo', run: () => {} } }) })
    await act(async () => { vi.advanceTimersByTime(7000) })
    expect(screen.getByRole('status').textContent).toBe('Card deleted.')
    const undo = screen.getByRole('button', { name: 'Undo' })
    undo.focus()
    fireEvent.focus(undo)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('status').textContent).toBe('Card deleted.')
    fireEvent.blur(undo)
    await act(async () => { vi.advanceTimersByTime(10_100) })
    // Its words are out of the regions once it's closing; the box itself fades first.
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('goes after a few seconds when it has no button', async () => {
    render(<Toast />)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => { toast('Link copied.') })
    await act(async () => { vi.advanceTimersByTime(5900) })
    expect(screen.getByRole('status').textContent).toBe('Link copied.')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

describe('when the hub can’t be reached', () => {
  const offline = (message: string) => vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(message) }))

  it('knows the way each browser says it', () => {
    for (const words of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'Network request failed']) expect(isNetworkFailure(new TypeError(words))).toBe(true)
    expect(isNetworkFailure(new TypeError('x is not a function'))).toBe(false)
    expect(isNetworkFailure(new Error('Failed to fetch'))).toBe(false)
  })

  it('gives a call a plain error, not the browser’s', async () => {
    offline('Failed to fetch')
    await expect(call('POST', '/api/x')).rejects.toThrow(unreachable)
    await expect(call('POST', '/api/x')).rejects.toBeInstanceOf(HubError)
  })

  it('shows it in a toast as an alert, from attempt', async () => {
    offline('Load failed')
    render(<Toast />)
    expect(await attempt(() => call('POST', '/api/x'))).toBeUndefined()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Couldn’t reach the hub. Try again in a moment.'))
  })

  it('turns a bare network error from some other fetch into the same words', async () => {
    render(<Toast />)
    await attempt(async () => { throw new TypeError('Failed to fetch') })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Couldn’t reach the hub. Try again in a moment.'))
  })

  it('still shows what the hub said when it answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not yours.' }), { status: 403 })))
    render(<Toast />)
    await attempt(() => call('POST', '/api/x'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not yours.'))
  })

  it('leaves other errors as they were', async () => {
    render(<Toast />)
    await attempt(async () => { throw new Error('Something specific.') })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Something specific.'))
  })
})
