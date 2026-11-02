// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Offers, type Offer } from '../src/components/GitHubSetup'

// Another binder's GitHub App offered by installation: the hub's own first, one button for each installation this
// person can reach.

afterEach(cleanup)

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
