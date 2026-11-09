// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'

// Settings is a few sections, with what most people never change tucked away, and only an admin's to see.

const options = { mergeMethod: 'merge', allowedUsers: [], allowedOrgs: [], admins: [], agentCommits: 'agent' }

function hub(part: string, hubAdmin: boolean, lists: unknown = { installations: [] }) {
  standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server', repos: ['acme/api', 'acme/web'] }] }), { ...me, hubAdmin, log: 'redis', spaces: [] })
  window.localStorage.setItem('binders-settings-part', part)
  const stand = globalThis.fetch
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/options') return json({ options, locked: {}, implied: { admins: [], allowedUsers: [], allowedOrgs: [] } })
    if (url === '/api/spaces') return json({ spaces: [], mayCreate: false })
    if (url === '/api/github/lists') return json(lists)
    return stand(url, init)
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings', () => {
  it('has five sections', async () => {
    hub('binder', true)
    await mount(<Settings />)
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    expect(within(nav).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Binder', 'GitHub', 'Brain', 'Jira', 'This hub'])
  })

  it.each([['sync', 'This hub'], ['access', 'This hub'], ['agents', 'This hub'], ['briefs', 'GitHub'], ['binders', 'Binder']])('takes a browser that remembers %s to %s', async (old, now) => {
    hub(old, true)
    await mount(<Settings />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(now)
  })

  it('shows an admin who may sign in, with agents’ addresses tucked away, and has no switch for what only the hub’s own environment sets', async () => {
    hub('hub', true)
    await mount(<Settings />)
    expect(await screen.findByRole('heading', { name: 'Who may sign in' })).toBeTruthy()
    const addresses = (await screen.findByText('Addresses for agents and MCP clients')).closest('details')!
    expect(addresses.open).toBe(false)
    expect(within(addresses).getByText('The runner')).toBeTruthy()
    for (const name of ['Following GitHub', 'Committing notes', 'Signing in by name']) expect(screen.queryByRole('heading', { name, hidden: true })).toBeNull()
  })

  it('tucks merging away under GitHub, and only for an admin', async () => {
    hub('github', true)
    await mount(<Settings />)
    const merging = (await screen.findByText('Merging, and who agents commit as')).closest('details')!
    expect(merging.open).toBe(false)
    expect(within(merging).getByRole('heading', { name: 'Merging change sets', hidden: true })).toBeTruthy()
    cleanup()
    hub('github', false)
    await mount(<Settings />)
    expect(screen.queryByText('Merging, and who agents commit as')).toBeNull()
  })

  it('keeps the repos a binder’s agents work in under GitHub, a tap away from the binder', async () => {
    hub('binder', true)
    await mount(<Settings />)
    expect(screen.getByText(/Its agents work in 2 repos/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: /Repos its agents work in/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose them in GitHub' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('GitHub')
    expect(screen.getByRole('heading', { name: 'Repos its agents work in' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove acme/api' })).toBeTruthy()
  })

  it('says what the app reaches on each account, and what its custom properties need', async () => {
    hub('github', true, {
      installations: [
        { account: 'acme', kind: 'Organization', indexed: 4812, total: 4812, complete: true, reading: false, failed: false, properties: 'denied' },
        { account: 'big', kind: 'Organization', indexed: 1200, total: 52000, complete: false, reading: true, failed: false },
      ],
      permissionsUrl: 'https://github.com/organizations/acme/settings/apps/binders/permissions',
    })
    await mount(<Settings />)
    const lists = await screen.findByText(/4,812 repos the app reaches/)
    expect(lists.closest('li')!.textContent).toContain('Custom properties (read)')
    expect(within(lists.closest('li')!).getByRole('link', { name: /its permissions on GitHub/ }).getAttribute('href')).toContain('/permissions')
    expect(screen.getByText(/Reading its repos from GitHub: 1,200 of 52,000 so far/)).toBeTruthy()
  })

  it('says who can change it to someone who can’t', async () => {
    hub('hub', false)
    await mount(<Settings />)
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
  })
})
