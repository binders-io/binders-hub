// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalGitHub } from '../src/components/PersonalGitHub'
import { Toast } from '../src/components/Toast'

// Your own GitHub, connected for your personal binder: disconnecting it, or taking its OAuth App away, asks first, and
// says so when the hub refuses.

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const connected = { suggested: 'you/binders-notes', oauth: true, oauthApp: { set: true, clientId: 'abc123' }, callback: 'https://hub.test/auth/github/callback', connected: true }
const refused = (error: string) => new Response(JSON.stringify({ error }), { status: 500, headers: { 'content-type': 'application/json' } })
const deletes = (fetched: ReturnType<typeof vi.fn>) => fetched.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('disconnecting your GitHub', () => {
  it('asks with the shared press-again button, and sends nothing on the first press', async () => {
    const fetched = vi.fn(async (url: string) => (url === '/api/personal' ? json(connected) : json({})))
    vi.stubGlobal('fetch', fetched)
    render(<PersonalGitHub />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(screen.getByRole('button', { name: 'Disconnect it? Press again' })).toBeTruthy()
    expect(deletes(fetched)).toEqual([])
  })

  it('disconnects on the second press', async () => {
    const fetched = vi.fn(async (url: string) => (url === '/api/personal' ? json(connected) : json({})))
    vi.stubGlobal('fetch', fetched)
    render(<PersonalGitHub />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect it? Press again' }))
    await waitFor(() => expect(deletes(fetched)).toEqual(['/api/me/personal-github']))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull())
  })

  it('shows it when the hub refuses to disconnect, and stays connected', async () => {
    const fetched = vi.fn(async (url: string, init?: RequestInit) => (url === '/api/personal' ? json(connected) : init?.method === 'DELETE' ? refused('GitHub wouldn’t let go.') : json({})))
    vi.stubGlobal('fetch', fetched)
    render(<><PersonalGitHub /><Toast /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect it? Press again' }))
    expect((await screen.findAllByText('GitHub wouldn’t let go.')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })
})

describe('taking your OAuth App away', () => {
  const asked = 'Take away your OAuth App and your GitHub connection? Press again'

  it('asks what goes first, and sends nothing on the first press', async () => {
    const fetched = vi.fn(async (url: string) => (url === '/api/personal' ? json(connected) : json({})))
    vi.stubGlobal('fetch', fetched)
    render(<PersonalGitHub />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take it away' }))
    expect(screen.getByRole('button', { name: asked })).toBeTruthy()
    expect(deletes(fetched)).toEqual([])
  })

  it('takes it away on the second press', async () => {
    const after = { ...connected, oauthApp: { set: false }, connected: false }
    const fetched = vi.fn(async (url: string, init?: RequestInit) => (url === '/api/personal' ? json(connected) : init?.method === 'DELETE' ? json(after) : json({})))
    vi.stubGlobal('fetch', fetched)
    render(<PersonalGitHub />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take it away' }))
    fireEvent.click(screen.getByRole('button', { name: asked }))
    await waitFor(() => expect(deletes(fetched)).toEqual(['/api/personal/oauth']))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take it away' })).toBeNull())
  })

  it('shows it when the hub refuses, and keeps the App', async () => {
    const fetched = vi.fn(async (url: string, init?: RequestInit) => (url === '/api/personal' ? json(connected) : init?.method === 'DELETE' ? refused('The hub is busy.') : json({})))
    vi.stubGlobal('fetch', fetched)
    render(<><PersonalGitHub /><Toast /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Take it away' }))
    fireEvent.click(screen.getByRole('button', { name: asked }))
    expect((await screen.findAllByText('The hub is busy.')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Take it away' })).toBeTruthy()
  })
})
