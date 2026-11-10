// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import { BinderSwitcher, waitingEveryMs } from '../src/components/BinderSwitcher'

// The switcher shows what waits for you, or for anyone, in your other binders: a number beside each, and a dot on its
// own button. It asks when the page opens, when the list opens and every two minutes while the page is visible.

const spaces = [{ id: 'acme', name: 'Acme', role: 'owner' }, { id: 'beta', name: 'Beta', role: 'member' }, { id: 'gamma', name: 'Gamma', role: 'member' }]

/** The hub with three binders, Acme the one you're in. `waiting` is what it answers, and may be changed between asks. */
function hub(waiting: { current: unknown }) {
  standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder' }] }), { ...me, space: 'acme', spaces })
  const asked = { count: 0 }
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/me/waiting') return stand(url, init)
    asked.count++
    if (waiting.current instanceof Error) throw waiting.current
    if (typeof waiting.current === 'number') return new Response(JSON.stringify({ error: 'No.' }), { status: waiting.current })
    return new Response(JSON.stringify(waiting.current), { headers: { 'content-type': 'application/json' } })
  }))
  return asked
}
const answer = (counts: Record<string, number>) => ({ binders: spaces.map((s) => ({ id: s.id, name: s.name, count: counts[s.id] ?? 0 })) })
const opener = () => screen.getByRole('button', { expanded: false })
const list = () => screen.getByRole('listbox', { name: 'Binders' })

/** Catches the page's two-minute timer, so a test can say when it fires, and passes every other timer through. */
function twoMinuteTimer() {
  const real = window.setInterval.bind(window)
  const caught: { tick?: () => void; every?: number; cleared: boolean } = { cleared: false }
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, every?: number) => {
    if (every === waitingEveryMs) {
      caught.tick = handler
      caught.every = every
      return 999_999
    }
    return real(handler, every)
  }) as typeof window.setInterval)
  const clear = window.clearInterval.bind(window)
  vi.spyOn(window, 'clearInterval').mockImplementation(((id?: number) => {
    if (id === 999_999) caught.cleared = true
    else clear(id)
  }) as typeof window.clearInterval)
  return caught
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('what waits in your other binders', () => {
  it('puts a dot on the button, with words for a screen reader, when another binder has something', async () => {
    hub({ current: answer({ beta: 2, gamma: 1 }) })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(within(opener()).getByText('3 things are waiting in your other binders')).toBeTruthy())
    expect(opener().querySelector('.binder-dot')).toBeTruthy()
    // The words are read out and not seen.
    expect(within(opener()).getByText('3 things are waiting in your other binders').classList.contains('sr-only')).toBe(true)
  })

  it('says “1 thing is” for one', async () => {
    hub({ current: answer({ beta: 1 }) })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(within(opener()).getByText('1 thing is waiting in your other binders')).toBeTruthy())
  })

  it('shows each other binder’s number beside its name, and none where nothing waits', async () => {
    hub({ current: answer({ beta: 2 }) })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(opener().querySelector('.binder-dot')).toBeTruthy())
    fireEvent.click(opener())
    const menu = list()
    const beta = within(menu).getByRole('link', { name: /Beta/ })
    // The number is seen, and "2 waiting" is read out in its place.
    expect(beta.querySelector('.binder-waiting [aria-hidden="true"]')!.textContent).toBe('2')
    expect(within(beta).getByText('2 waiting').classList.contains('sr-only')).toBe(true)
    expect(within(menu).getByRole('link', { name: /Gamma/ }).querySelector('.binder-waiting')).toBeNull()
  })

  it('shows no dot and no number for what waits in the binder you’re in, or when nothing waits elsewhere', async () => {
    hub({ current: answer({ acme: 5 }) })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/me/waiting')).toBe(true))
    await act(async () => {})
    expect(opener().querySelector('.binder-dot')).toBeNull()
    fireEvent.click(opener())
    expect(list().querySelector('.binder-waiting')).toBeNull()
    // Your own binder is the one in the list with a tick, not a link.
    expect(within(list()).getByRole('button', { name: /Acme/ }).querySelector('.binder-waiting')).toBeNull()
  })

  it('asks when the page opens, and again each time the list opens', async () => {
    const waiting = { current: answer({}) }
    const asked = hub(waiting)
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(asked.count).toBe(1))
    waiting.current = answer({ gamma: 4 })
    fireEvent.click(opener())
    await waitFor(() => expect(asked.count).toBe(2))
    expect(await within(list()).findByText('4 waiting')).toBeTruthy()
    // Closing doesn't ask.
    fireEvent.keyDown(window, { key: 'Escape' })
    await act(async () => {})
    expect(asked.count).toBe(2)
  })

  it('asks every two minutes while the page is visible, and not while it’s hidden', async () => {
    const waiting = { current: answer({}) }
    const timer = twoMinuteTimer()
    const asked = hub(waiting)
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(asked.count).toBe(1))
    expect(timer.every).toBe(120_000)

    waiting.current = answer({ beta: 3 })
    await act(async () => { timer.tick!() })
    await waitFor(() => expect(asked.count).toBe(2))
    await waitFor(() => expect(within(opener()).getByText('3 things are waiting in your other binders')).toBeTruthy())

    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { timer.tick!() })
    expect(asked.count).toBe(2)
    hidden.mockReturnValue('visible')
    await act(async () => { timer.tick!() })
    await waitFor(() => expect(asked.count).toBe(3))
  })

  it('stops asking when the switcher goes away', async () => {
    const timer = twoMinuteTimer()
    hub({ current: answer({}) })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    cleanup()
    expect(timer.cleared).toBe(true)
  })

  it('shows nothing when the hub can’t say, and nothing more than it had before when a later ask fails', async () => {
    const waiting: { current: unknown } = { current: 500 }
    const asked = hub(waiting)
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(asked.count).toBe(1))
    await act(async () => {})
    expect(opener().querySelector('.binder-dot')).toBeNull()
    fireEvent.click(opener())
    expect(list().querySelector('.binder-waiting')).toBeNull()

    waiting.current = answer({ beta: 2 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(opener())
    await waitFor(() => expect(list().querySelector('.binder-waiting')).toBeTruthy())

    waiting.current = new TypeError('Failed to fetch')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(opener())
    await waitFor(() => expect(asked.count).toBe(4))
    expect(screen.queryByText(/failed|couldn’t|error/i)).toBeNull()
  })

  it('shows nothing for an answer that isn’t a list', async () => {
    const asked = hub({ current: { binders: 'many' } })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(asked.count).toBe(1))
    await act(async () => {})
    expect(opener().querySelector('.binder-dot')).toBeNull()
  })

  it('names each other binder’s number in its link, which a keyboard reaches and a screen reader reads', async () => {
    hub({ current: answer({ beta: 2 }) })
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    await waitFor(() => expect(opener().querySelector('.binder-dot')).toBeTruthy())
    fireEvent.click(opener())
    const link = within(list()).getByRole('link', { name: /Beta.*2 ?waiting/ })
    expect(link.getAttribute('href')).toBe('/beta/#/home')
  })
})
