// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubSetup, Offers, type Offer } from '../src/components/GitHubSetup'
import { hubState, me, mount, standInHub, standInRoute } from './harness'

// A binder's GitHub: another binder's GitHub App offered by installation (the hub's own first, one button for each
// installation this person can reach), the guided setup, and once it's set up, the rows that sum it up.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const offers: Offer[] = [
  { binder: { id: 'main', name: 'Main' }, hub: true, app: { name: 'Binders for acme', slug: 'binders-for-acme', owner: 'sam', htmlUrl: '', installations: [{ account: 'acme', type: 'Organization' }, { account: 'sam', type: 'User' }] } },
  { binder: { id: 'mobile', name: 'Mobile' }, app: { name: 'Mobile bot', slug: 'mobile-bot', owner: 'acme', htmlUrl: '', installations: [{ account: 'acme-labs', type: 'Organization' }] } },
]

describe('offering the hub’s GitHub App', () => {
  it('names the hub’s app, lists the installations, and uses the one picked', () => {
    const reuse = vi.fn()
    render(<Offers offers={offers} busy={false} reuse={reuse} />)
    expect(screen.getByText('Use the hub’s GitHub App')).toBeTruthy()
    expect(screen.getByText('Use Mobile bot')).toBeTruthy()
    const [hub] = screen.getAllByRole('list')
    const rows = within(hub).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('@acme an organization you’re in'), expect.stringContaining('@sam your own account')])
    fireEvent.click(screen.getByRole('button', { name: /Use it for @sam/ }))
    expect(reuse).toHaveBeenCalledWith(offers[0], 'sam')
    fireEvent.click(screen.getByRole('button', { name: /Use it for @acme-labs/ }))
    expect(reuse).toHaveBeenLastCalledWith(offers[1], 'acme-labs')
  })

  it('holds the buttons while one is being used', () => {
    render(<Offers offers={offers} busy reuse={() => {}} />)
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a binder whose app is set up', () => {
  const github = { mode: 'app', app: { name: 'Acme app', slug: 'acme-app', owner: 'sam', ownerType: 'Organization', htmlUrl: '', installations: ['acme'], installUrl: '', madeLocally: true, settingsUrl: '' }, signIn: true, server: true, webhooks: true, token: true, admin: true, local: false }

  it('sums it up in rows, the app opening to what it lacks and forgetting it, which asks first', async () => {
    standInHub(() => hubState(), { ...me, github, spaces: [], publicUrl: '', mcpUrl: '', webhookUrl: '' })
    standInRoute('GET', '/api/github/health', () => ({ health: { app: { name: 'Acme app', slug: 'acme-app', owner: 'sam', ownerType: 'Organization', url: '', settingsUrl: 'https://github.test/settings' }, missing: [{ permission: 'custom_properties', level: 'read', for: 'filtering repos' }], installations: [{ account: 'acme', selection: 'selected', repos: 3 }] } }))
    const forgot = standInRoute('DELETE', '/api/github/app')
    await mount(<GitHubSetup />)
    const app = await screen.findByRole('button', { name: /^Acme app/ })
    await waitFor(() => expect(app.textContent).toContain('1 to fix'))
    expect(screen.getByText('Your GitHub').closest('li')!.textContent).toContain('Connected')
    fireEvent.click(app)
    const dialog = within(screen.getByRole('dialog', { name: 'Acme app' }))
    expect(dialog.getByText(/Custom properties \(read\)/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Forget this app' }))
    expect(forgot).toEqual([])
    expect(dialog.getByRole('button', { name: 'Forget this app? Press again' })).toBeTruthy()
  })
})

describe('a binder with no app yet', () => {
  const github = { mode: 'none', signIn: true, server: false, webhooks: false, token: false, admin: true, local: false }

  it('sets it up in a guided dialog: the hub’s app first, by its installations, or one of its own', async () => {
    standInHub(() => hubState(), { ...me, github, spaces: [{ id: 'acme', name: 'Acme', role: 'owner' }], space: 'acme', publicUrl: '', mcpUrl: '', webhookUrl: '' })
    standInRoute('GET', '/api/github/reusable', () => ({ apps: offers }))
    await mount(<GitHubSetup />)
    expect(screen.getByText('Not connected to GitHub yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Set up GitHub/ }))
    const hub = await screen.findByRole('button', { name: /Use the hub’s GitHub App/ })
    expect(hub.textContent).toContain('Recommended')
    expect(screen.getByRole('button', { name: /Make one of its own/ })).toBeTruthy()
    fireEvent.click(hub)
    expect(await screen.findByRole('heading', { name: 'Where is it installed?' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Use it for @acme/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', { name: /Make one of its own/ }))
    expect((screen.getByLabelText(/The app’s name on GitHub/) as HTMLInputElement).value).toBe('Binders for Acme')
    expect((screen.getByRole('button', { name: /Create on GitHub/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says to anyone else that its owners and admins set it up', async () => {
    standInHub(() => hubState(), { ...me, github: { ...github, admin: false }, spaces: [], publicUrl: '', mcpUrl: '', webhookUrl: '' })
    await mount(<GitHubSetup />)
    expect(screen.getByText('This binder’s owners and admins set it up.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Set up GitHub/ })).toBeNull()
  })
})
