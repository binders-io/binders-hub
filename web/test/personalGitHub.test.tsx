// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalGitHub } from '../src/components/PersonalGitHub'

// Your own GitHub, connected for your personal binder: disconnecting it asks first.

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const connected = { suggested: 'you/binders-notes', oauth: true, oauthApp: { set: true, clientId: 'abc123' }, callback: 'https://hub.test/auth/github/callback', connected: true }
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
})
