// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
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

  it('names the binder a token it makes is for', async () => {
    withTokens()
    await mount(<Account />)
    expect(await screen.findByText(/It’s for Acme only, and lasts/)).toBeTruthy()
  })

  it('leaves the section out, without a word to fail on, until it’s known who you are', async () => {
    withTokens(null)
    await mount(<Account />)
    await settle(50)
    expect(screen.queryByRole('heading', { name: 'MCP connections' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Your account' })).toBeTruthy()
  })
})
