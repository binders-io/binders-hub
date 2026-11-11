// @vitest-environment jsdom
import axe from 'axe-core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import type { Me } from '../src/data/model'
import { StoreProvider } from '../src/data/store'
import { NoBinder } from '../src/screens/NoBinder'
import { me, standInHub, standInRoute } from './harness'

// The first thing anyone sees: signing in, and, signed in, the binders that are theirs when this address isn't one.
// Each is the mark, a name, one line and what to do, with which hub or who's signed in at its foot.

const violations = async () => {
  const { violations: found } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
  return found.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

/** The app for someone the hub says isn't signed in, with these ways in. */
const signedOut = (options: { github: boolean; dev: boolean }) => {
  standInHub()
  standInRoute('GET', '/api/me', () => new Response(JSON.stringify({ error: 'Sign in first.' }), { status: 401, headers: { 'content-type': 'application/json' } }))
  standInRoute('GET', '/auth/options', () => options)
  render(<StoreProvider><App /></StoreProvider>)
}

describe('signing in', () => {
  it('is the mark, the name, one line and one button, with the hub it is for at its foot', async () => {
    signedOut({ github: true, dev: false })
    const button = await screen.findByRole('link', { name: 'Sign in with GitHub' })
    expect(button.getAttribute('href')).toBe('/auth/github')
    expect(button.className).toContain('primary')
    expect(screen.getByRole('heading', { level: 1, name: 'Binders' })).toBeTruthy()
    expect(screen.getByText('Notes become work, agents do it, and you ship it.')).toBeTruthy()
    expect(screen.getByRole('contentinfo').textContent).toBe(window.location.host)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(await violations()).toEqual([])
  })

  it('offers a name too, under GitHub, on a hub run on this machine', async () => {
    signedOut({ github: true, dev: true })
    await screen.findByRole('link', { name: 'Sign in with GitHub' })
    const name = screen.getByRole('textbox', { name: 'Or, on this machine, by name' })
    const go = screen.getByRole('button', { name: 'Sign in' })
    expect(go.hasAttribute('disabled')).toBe(true)
    fireEvent.change(name, { target: { value: 'maya' } })
    expect(go.hasAttribute('disabled')).toBe(false)
    expect(await violations()).toEqual([])
  })

  it('says why there’s only a name, and makes its button the main one, with no GitHub app', async () => {
    signedOut({ github: false, dev: true })
    expect(await screen.findByText('This hub has no GitHub app, so sign in with a name.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' }).className).toContain('primary')
  })

  it('says what to set when there’s no way in at all', async () => {
    signedOut({ github: false, dev: false })
    expect(await screen.findByText(/set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on it/)).toBeTruthy()
  })
})

describe('no binder here', () => {
  const you = (spaces: Me['spaces']) => ({ ...me, publicUrl: '', mcpUrl: '', spaces }) as unknown as Me

  it('lists the binders that are yours as rows to open, with who’s signed in and Sign out at the foot', async () => {
    render(<NoBinder me={you([{ id: 'acme', name: 'Acme', role: 'owner' }, { id: '~you', name: 'Personal', role: 'owner' }])} />)
    expect(screen.getByRole('heading', { level: 1, name: 'No binder yet' })).toBeTruthy()
    expect(screen.getByText('Pick one of yours:')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Your binders' })
    const links = within(list).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/acme/', '/~you/'])
    expect(links[0].textContent).toContain('Acme')
    expect(links[0].textContent).toContain('/acme')
    const foot = screen.getByRole('contentinfo')
    expect(foot.textContent).toContain('Signed in as you')
    expect(within(foot).getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(await violations()).toEqual([])
  })

  it('says to ask an owner when none are yours, and Sign out is the button', async () => {
    const out = vi.fn(async () => new Response(null))
    vi.stubGlobal('fetch', out)
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    render(<NoBinder me={you([])} />)
    expect(screen.getByText('No binder on this hub has you as a member yet. Ask its owner to add you.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(out).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
    expect(await violations()).toEqual([])
  })

  it('takes the look this browser was last given, as the app would', () => {
    window.localStorage.setItem('binders-hub-theme', 'light')
    render(<NoBinder me={you([])} />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    window.localStorage.removeItem('binders-hub-theme')
  })
})
