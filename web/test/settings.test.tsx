// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'

// Settings is two groups of sections, this binder's and the hub's, with what most people never change tucked away. The
// hub's are an admin's to change, and everyone sees them greyed, with who can.

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
  window.location.hash = ''
})

describe('Settings', () => {
  it('has two named groups, eleven sections for a hub admin, each a link to its own address', async () => {
    hub('general', true)
    await mount(<Settings />)
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    const binder = within(nav).getByRole('group', { name: 'This binder' })
    const hubs = within(nav).getByRole('group', { name: 'This hub' })
    // GitHub isn't set up in this hub, which a link says to a screen reader as well as with its dot.
    expect(within(binder).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual(['General', 'People', 'GitHub Needs a look', 'How work flows', 'Jira', 'History'])
    expect(within(hubs).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual(['Who gets in', 'Binders', 'Brain', 'Agents', 'Status'])
    expect(within(nav).getByRole('link', { name: 'How work flows' }).getAttribute('href')).toBe('#/settings/flow')
    expect(within(hubs).getByRole('link', { name: 'Status' }).getAttribute('href')).toBe('#/settings/status')
    expect(within(nav).getByText('Server')).toBeTruthy()
    expect(within(nav).getByText('The same for every binder here')).toBeTruthy()
  })

  it.each([['sync', 'Status'], ['access', 'Who gets in'], ['hub', 'Who gets in'], ['agents', 'Agents'], ['briefs', 'GitHub'], ['binders', 'General'], ['binder', 'General'], ['nonsense', 'General']])('takes a browser that remembers %s to %s', async (old, now) => {
    hub(old, true)
    await mount(<Settings />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(now)
  })

  it('shows an admin who may sign in, and has no switch for what only the hub’s own environment sets', async () => {
    hub('access', true)
    await mount(<Settings />)
    expect(await screen.findByRole('heading', { name: 'Who may sign in' })).toBeTruthy()
    for (const name of ['Following GitHub', 'Committing notes', 'Signing in by name']) expect(screen.queryByRole('heading', { name, hidden: true })).toBeNull()
  })

  it('has the hub’s status with agents’ addresses tucked away', async () => {
    hub('status', true)
    await mount(<Settings />)
    const addresses = (await screen.findByText('Addresses for agents and MCP clients')).closest('details')!
    expect(addresses.open).toBe(false)
    expect(within(addresses).getByText('The runner')).toBeTruthy()
    expect(screen.getByText('Live connection')).toBeTruthy()
  })

  it('puts merging and who agents commit as under Agents, in the hub’s group and not folded away', async () => {
    hub('agents', true)
    await mount(<Settings />)
    expect(await screen.findByRole('heading', { name: 'Merging change sets' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Agents’ commits and pull requests' })).toBeTruthy()
    expect(document.querySelector('details')).toBeNull()
    expect(screen.getByRole('radio', { name: 'Squash' }).hasAttribute('disabled')).toBe(false)
    // Nor is it under GitHub, which is this binder's alone.
    cleanup()
    hub('github', true)
    await mount(<Settings />)
    expect(screen.queryByText('Merging change sets')).toBeNull()
  })

  it('saves a change to merging at once and says so beside it, as every control in Settings does', async () => {
    hub('agents', true)
    const calls: { method?: string; body?: string }[] = []
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/options' && init?.method === 'PATCH') {
        calls.push({ method: init.method, body: String(init.body) })
        return new Response(JSON.stringify({ options: { ...options, mergeMethod: 'squash' }, locked: {}, implied: { admins: [], allowedUsers: [], allowedOrgs: [] } }), { headers: { 'content-type': 'application/json' } })
      }
      return stand(url, init)
    }))
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Squash' }))
    await screen.findByText('Saved')
    expect(calls).toEqual([{ method: 'PATCH', body: '{"mergeMethod":"squash"}' }])
  })

  it('shows merging greyed, with who can change it, to someone who isn’t an admin', async () => {
    hub('agents', false)
    await mount(<Settings />)
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Squash' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('radio', { name: 'Always its owner' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps the repo a binder’s cards go to first under GitHub, and the repos its agents work in below', async () => {
    hub('github', true)
    await mount(<Settings />)
    const heading = await screen.findByRole('heading', { name: 'Where its cards and notes go' })
    expect(screen.getByRole('heading', { name: 'Repos its agents work in' })).toBeTruthy()
    expect(heading.compareDocumentPosition(screen.getByRole('heading', { name: 'Repos its agents work in' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/Its agents work in 2 repos, chosen below/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove acme/api' })).toBeTruthy()
    // The binder's name, repo and switches aren't a section of their own any more.
    cleanup()
    hub('general', true)
    await mount(<Settings />)
    expect(screen.queryByText(/Its agents work in/)).toBeNull()
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
    hub('access', false)
    await mount(<Settings />)
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
  })
})
