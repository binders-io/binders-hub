// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'

// Settings is two groups of sections, this binder's and the hub's, with what most people never change tucked away. The
// hub's are an admin's to change, and everyone sees them greyed, with who can.

const options = { mergeMethod: 'merge', allowedUsers: [], allowedOrgs: [], admins: [], agentCommits: 'agent' }

/** A binder's GitHub App on acme and big, for what it reaches. */
const app = { name: 'Acme app', slug: 'acme-app', owner: 'acme', ownerType: 'Organization', htmlUrl: '', installations: ['acme', 'big'], installUrl: '', madeLocally: false, settingsUrl: '' }

function hub(part: string, hubAdmin: boolean, lists: unknown = { installations: [] }, github: object = {}) {
  standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server', repos: ['acme/api', 'acme/web'] }] }), { ...me, github, hubAdmin, log: 'redis', spaces: [] })
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
  it('has two named groups, twelve sections for a hub admin, each a link to its own address', async () => {
    hub('general', true)
    await mount(<Settings />)
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    const binder = within(nav).getByRole('group', { name: 'This binder' })
    const hubs = within(nav).getByRole('group', { name: 'This hub' })
    // GitHub isn't set up in this hub, which a link says to a screen reader as well as with its dot.
    expect(within(binder).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual(['General', 'People', 'GitHub Needs a look', 'How work flows', 'Listeners', 'Jira', 'History'])
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

  it('has the hub’s status as rows, and the addresses agents and clients use, each to copy', async () => {
    hub('status', true)
    await mount(<Settings />)
    const doing = (await screen.findByRole('heading', { name: 'How it’s doing' })).closest('section')!
    expect(within(doing).getByText('Live connection')).toBeTruthy()
    expect(within(doing).getByText('Kept')).toBeTruthy()
    const addresses = screen.getByRole('heading', { name: 'Addresses' }).closest('section')!
    expect(within(addresses).getByText('The runner')).toBeTruthy()
    expect(within(addresses).getByText(`${window.location.origin}/runner/binders-runner.mjs`)).toBeTruthy()
    // How each is used is there for whoever opens it.
    expect(within(addresses).getByText('Which to use').closest('details')!.open).toBe(false)
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
    fireEvent.click(within(addresses).getByRole('button', { name: 'Copy the runner’s address' }))
    expect(await within(addresses).findByRole('button', { name: 'Copied the runner’s address' })).toBeTruthy()
    expect(writes).toEqual([`${window.location.origin}/runner/binders-runner.mjs`])
  })

  it('puts merging and who agents commit as under Agents, in the hub’s group, each a row saying how it is', async () => {
    hub('agents', true)
    await mount(<Settings />)
    const merging = await screen.findByRole('button', { name: 'Merging change sets: Merge commits. Change it' })
    expect(merging.textContent).toBe('Merging change setsMerge commits')
    expect(screen.getByRole('button', { name: 'Agents’ commits and pull requests: Each agent chooses. Change it' })).toBeTruthy()
    expect(document.querySelector('details')).toBeNull()
    // Pressing a row opens its choices, each a radio with a line on what it means.
    fireEvent.click(merging)
    const dialog = await screen.findByRole('dialog', { name: 'Merging change sets' })
    expect(within(dialog).getByRole('radio', { name: /^Merge commits/ }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: /^Squash/ }).hasAttribute('disabled')).toBe(false)
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
    fireEvent.click(await screen.findByRole('button', { name: /^Merging change sets/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /^Squash/ }))
    await screen.findByText('Saved')
    expect(calls).toEqual([{ method: 'PATCH', body: '{"mergeMethod":"squash"}' }])
  })

  it('shows merging greyed, with who can change it, to someone who isn’t an admin', async () => {
    hub('agents', false)
    await mount(<Settings />)
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
    // The rows say how each is, and aren't buttons: nothing opens to change them.
    expect(screen.getByText('Merging change sets').closest('.rows-item')!.textContent).toContain('Merge commits')
    expect(screen.getByText('Agents’ commits and pull requests').closest('.rows-item')!.textContent).toContain('Each agent chooses')
    expect(screen.queryByRole('button', { name: /Merging change sets|Agents’ commits/ })).toBeNull()
  })

  it('has the repos its agents work in as a table under GitHub, each saying what it’s for, and says what none chosen means', async () => {
    hub('github', true)
    await mount(<Settings />)
    const repos = (await screen.findByRole('heading', { name: 'Repos' })).closest('section')!
    expect(within(repos).getByText('Agents work only in the 2 chosen here.')).toBeTruthy()
    const rows = within(repos).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['acme/api', 'acme/web'])
    expect(rows.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual(['Agents', 'Agents'])
    // Opened, a repo says what it's for.
    fireEvent.click(within(repos).getByRole('button', { name: 'Open acme/api' }))
    const dialog = within(screen.getByRole('dialog', { name: 'acme/api' }))
    expect((dialog.getByRole('checkbox', { name: 'Chosen for its agents' }) as HTMLInputElement).checked).toBe(true)
    expect((dialog.getByRole('checkbox', { name: 'Its cards and notes go here' }) as HTMLInputElement).checked).toBe(false)
    // The binder's name, repo and switches aren't a section of their own any more.
    cleanup()
    hub('general', true)
    await mount(<Settings />)
    expect(screen.queryByRole('heading', { name: 'Repos' })).toBeNull()
  })

  it('says agents work in any repo the app reaches while none are chosen', async () => {
    standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server', repo: 'acme/notes' }] }), { ...me, hubAdmin: true, log: 'redis', spaces: [] })
    window.localStorage.setItem('binders-settings-part', 'github')
    await mount(<Settings />)
    expect(await screen.findByText('None are chosen for agents, so they work in any repo the app reaches.')).toBeTruthy()
    const row = screen.getAllByRole('row')[1]
    expect(within(row).getAllByRole('cell')[1].textContent).toBe('Cards, notes, agents')
  })

  it('says what the app reaches on each account, and what its custom properties need', async () => {
    hub('github', true, {
      installations: [
        { account: 'acme', kind: 'Organization', indexed: 4812, total: 4812, complete: true, reading: false, failed: false, properties: 'denied' },
        { account: 'big', kind: 'Organization', indexed: 1200, total: 52000, complete: false, reading: true, failed: false },
      ],
      permissionsUrl: 'https://github.com/organizations/acme/settings/apps/binders/permissions',
    }, { mode: 'app', app, admin: true, token: true, server: true })
    await mount(<Settings />)
    // In a word on its row, while a list is still being read; the rest in its dialog.
    const reach = await screen.findByRole('button', { name: /Reaches 56,812 repos/ })
    expect(reach.textContent).toContain('Reading')
    fireEvent.click(reach)
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
