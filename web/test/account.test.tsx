// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, settle, standInHub, standInRoute } from './harness'
import { Account } from '../src/screens/Account'

// Your account page: what's connected as you, and where to go for the rest.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const withTokens = (you: unknown = { ...me, spaces: [{ id: 'acme', name: 'Acme', role: 'owner' }], space: 'acme' }) => {
  standInHub(() => hubState(), you)
  standInRoute('GET', '/api/tokens', () => ({ tokens: [] }))
}

describe('MCP connections', () => {
  it('points, when there are none, at the hub’s address in Settings → Status, as a link', async () => {
    withTokens()
    await mount(<Account />)
    await screen.findByRole('heading', { name: 'MCP connections' })
    const link = screen.getByRole('link', { name: 'Settings → Status' })
    expect(link.getAttribute('href')).toBe('#/settings/status')
    expect(link.closest('p')!.textContent).toContain('the address for another MCP client')
    expect(document.body.textContent).not.toContain('This hub')
  })

  /** Connect a client, and the way picked. */
  const connect = async (way: string) => {
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connect a client' })
    fireEvent.click(within(dialog).getByRole('button', { name: way }))
    return dialog
  }

  it('connects a client from one button, with Claude Code’s command, another client’s address, or a token', async () => {
    withTokens()
    await mount(<Account />)
    const dialog = await connect('Claude Code Recommended')
    expect(within(dialog).getByRole('heading', { name: 'Paste this in a terminal' })).toBeTruthy()
    expect(dialog.querySelector('pre')?.textContent).toContain('claude mcp add --transport http --scope user binders-hub')
    expect(within(dialog).getByRole('button', { name: 'Copy the command' })).toBeTruthy()
    // Back to the choice, and the address for any other client.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Another MCP client' }))
    expect(within(dialog).getByRole('heading', { name: 'Give it this address' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Copy the address' })).toBeTruthy()
  })

  it('names the binder a token it makes is for', async () => {
    withTokens()
    await mount(<Account />)
    const dialog = await connect('A client that can’t sign in')
    expect(within(dialog).getByText(/It’s for Acme only, and lasts/)).toBeTruthy()
  })

  it('shows a token it makes once, in a dialog only its own button closes', async () => {
    withTokens()
    const made = standInRoute('POST', '/api/tokens', () => ({ token: 'bnp_secret' }))
    await mount(<Account />)
    const dialog = await connect('A client that can’t sign in')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create a token' }))
    const shown = await screen.findByRole('dialog', { name: 'Your token' })
    expect(made).toEqual([{ app: 'A terminal' }])
    expect(shown.querySelector('pre')?.textContent).toBe('bnp_secret')
    expect(within(shown).getByText(/Shown once/)).toBeTruthy()
    // Escape doesn't lose it.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Your token' })).toBeTruthy()
    fireEvent.click(within(shown).getByRole('button', { name: 'I’ve copied it' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Your token' })).toBeNull())
  })

  it('leaves the section out, without a word to fail on, until it’s known who you are', async () => {
    withTokens(null)
    await mount(<Account />)
    await settle(50)
    expect(screen.queryByRole('heading', { name: 'MCP connections' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Your account' })).toBeTruthy()
  })
})
