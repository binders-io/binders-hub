// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import App from '../src/App'
import { Settings } from '../src/screens/Settings'

// A binder's settings are its owners' and admins'; the hub's admins run the hub, and look after a binder only while it
// has no owner. What Settings says of that, and the hub's own list of binders where an owner is named.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Role = 'owner' | 'admin' | 'member' | 'reader'
interface Listed { id: string; name: string; createdAt: string; first?: true; people: number; owners: string[]; admins: string[]; yours: boolean }

const listed = (over: Partial<Listed> & { id: string; name: string }): Listed => ({ createdAt: 'then', people: 2, owners: ['ana'], admins: [], yours: false, ...over })
const owned = [{ login: 'ana', role: 'owner' }, { login: 'sam', role: 'admin' }]
const unowned = [{ login: 'sam', role: 'admin' }]

/**
 * The hub with Acme, which you have `role` in, and `managers` run. `list` is what the hub's list of binders says, and
 * `put` what it answers to naming an owner. Gives what was sent to the hub's binders.
 */
function hub({ role = 'owner', hubAdmin = false, managers = owned, section = 'general', list = [] as Listed[], put }: { role?: Role; hubAdmin?: boolean; managers?: { login: string; role: string }[]; section?: string; list?: Listed[]; put?: (url: string) => Response }) {
  const spaces = [{ id: 'acme', name: 'Acme', role, createdAt: 'then', managers, members: role === 'owner' || role === 'admin' ? [{ login: 'sam', role: 'admin' }] : undefined }]
  standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server' }] }), { ...me, role, hubAdmin, space: 'acme', spaces: spaces.map((s) => ({ id: s.id, name: s.name, role })), log: 'redis' })
  window.localStorage.setItem('binders-settings-part', section)
  const sent: { method?: string; url: string }[] = []
  let current = list
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/spaces') return json({ spaces, mayCreate: false })
    if (url === '/api/hub/binders') return json({ binders: current })
    if (url.startsWith('/api/hub/binders/')) {
      sent.push({ method: init?.method, url })
      if (put) return put(url)
      current = current.map((b) => (url.includes(`/${b.id}/`) ? { ...b, owners: [decodeURIComponent(url.split('/').at(-1)!)] } : b))
      return json({ binders: current })
    }
    if (url === '/api/options') return json({ options: { mergeMethod: 'merge', allowedUsers: [], allowedOrgs: [], admins: [], agentCommits: 'agent' }, locked: {}, implied: { admins: [], allowedUsers: [], allowedOrgs: [] } })
    if (url === '/api/github/lists') return json({ installations: [] })
    return stand(url, init)
  }))
  return sent
}

function toasts() {
  const said: string[] = []
  window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string }>).detail.message))
  return said
}

const open = () => document.querySelector('.settings-pane h2')?.textContent ?? undefined
const noOwnerLine = 'This binder has no owner yet. One of the hub’s admins can name one.'
const lookingAfterText = 'This binder has no owner yet, so the hub’s admins look after it. Name an owner in People.'
/** The line has a link in it, so its words are in more than one element. */
const lookingAfter = (_: string, element: Element | null) => element?.tagName === 'P' && element.textContent === lookingAfterText

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('who may change a binder', () => {
  it.each<[Role, boolean, boolean]>([
    ['owner', false, true],
    ['admin', false, true],
    ['member', false, false],
    ['reader', false, false],
    // A hub admin has the place they have in the binder, like anyone: the hub says admin only when it has no owner.
    ['member', true, false],
    ['reader', true, false],
    ['owner', true, true],
  ])('says %s (hub admin %s) may change it: %s', async (role, hubAdmin, may) => {
    hub({ role, hubAdmin })
    await mount(<Settings />)
    const name = await screen.findByLabelText('Name')
    await waitFor(() => expect(name.closest('fieldset')!.disabled).toBe(!may))
  })
})

describe('a binder with no owner', () => {
  it('tells someone who may not change it, once, that one of the hub’s admins can name an owner', async () => {
    hub({ role: 'member', managers: [], section: 'general' })
    await mount(<Settings />)
    expect(await screen.findByText(noOwnerLine)).toBeTruthy()
    expect(screen.getAllByText(noOwnerLine).length).toBe(1)
    expect(screen.queryByText(lookingAfter)).toBeNull()
  })

  it('says it at the top of each of the binder’s sections, and not in the hub’s', async () => {
    hub({ role: 'member', managers: [], section: 'flow' })
    await mount(<Settings />)
    expect(await screen.findByText(noOwnerLine)).toBeTruthy()
    expect(screen.getAllByText(noOwnerLine).length).toBe(1)
    cleanup()
    hub({ role: 'member', managers: [], section: 'status' })
    await mount(<Settings />)
    await screen.findByText('Live connection')
    expect(screen.queryByText(noOwnerLine)).toBeNull()
  })

  it('tells a hub admin looking after it that the hub’s admins do, and where to name an owner', async () => {
    hub({ role: 'admin', hubAdmin: true, managers: unowned })
    await mount(<Settings />)
    const line = await screen.findByText(lookingAfter)
    expect(within(line).getByRole('link', { name: 'People' }).getAttribute('href')).toBe('#/settings/people')
    expect(screen.queryByText(noOwnerLine)).toBeNull()
  })

  it('says nothing of it when it has an owner', async () => {
    hub({ role: 'member', managers: owned })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    expect(screen.queryByText(noOwnerLine)).toBeNull()
    expect(screen.queryByText(lookingAfter)).toBeNull()
  })

  it('tells an admin of it who isn’t one of the hub’s the same as anyone: they can’t name an owner either', async () => {
    hub({ role: 'admin', managers: unowned })
    await mount(<Settings />)
    expect(await screen.findByText(noOwnerLine)).toBeTruthy()
    expect(screen.queryByText(lookingAfter)).toBeNull()
  })
})

describe('the hub’s Binders section', () => {
  const nav = () => screen.getByRole('navigation', { name: 'Settings' })

  it('is listed under This hub for a hub admin, with its name and what it’s for', async () => {
    hub({ hubAdmin: true, section: 'hubbinders', list: [listed({ id: 'acme', name: 'Acme', yours: true })] })
    await mount(<Settings />)
    const hubs = within(nav()).getByRole('group', { name: 'This hub' })
    expect(within(hubs).getByRole('link', { name: 'Binders' }).getAttribute('href')).toBe('#/settings/hubbinders')
    await waitFor(() => expect(open()).toBe('Binders'))
    expect(screen.getByText('Every binder on this hub and who owns it. Name an owner for one that has none.')).toBeTruthy()
  })

  it('is not listed for anyone else', async () => {
    hub({ hubAdmin: false })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    expect(within(nav()).queryByRole('link', { name: 'Binders' })).toBeNull()
    expect(within(nav()).getAllByRole('link').length).toBe(11)
  })

  it('sends anyone else to General when its address is opened, and so does a browser that remembered it', async () => {
    hub({ hubAdmin: false })
    window.location.hash = '#/settings/hubbinders'
    await mount(<App />)
    await screen.findByRole('navigation', { name: 'Settings' })
    await waitFor(() => expect(open()).toBe('General'))
    await waitFor(() => expect(window.location.hash).toBe('#/settings/general'))
    expect(screen.queryByText('No owner')).toBeNull()
    cleanup()
    hub({ hubAdmin: false, section: 'hubbinders' })
    window.location.hash = '#/settings'
    await mount(<Settings />)
    await waitFor(() => expect(open()).toBe('General'))
  })

  it('opens for a hub admin at its address and stays', async () => {
    hub({ hubAdmin: true, list: [listed({ id: 'acme', name: 'Acme', yours: true })] })
    window.location.hash = '#/settings/hubbinders'
    await mount(<App />)
    await waitFor(() => expect(open()).toBe('Binders'))
    expect(window.location.hash).toBe('#/settings/hubbinders')
  })

  it('lists each binder with its address, owners and people, those with no owner first and marked', async () => {
    hub({
      hubAdmin: true, section: 'hubbinders',
      list: [
        listed({ id: 'acme', name: 'Acme', owners: ['ana', 'bo'], people: 5, yours: true }),
        listed({ id: 'lonely', name: 'Lonely', owners: [], admins: [], people: 0 }),
        listed({ id: 'orphan', name: 'Orphan', owners: [], admins: ['sam'], people: 3, yours: true }),
      ],
    })
    await mount(<Settings />)
    const list = await screen.findByRole('list', { name: 'Binders on this hub' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Lonely', 'Orphan', 'Acme'])
    expect(within(rows[0]).getByText('No owner')).toBeTruthy()
    expect(within(rows[1]).getByText('No owner')).toBeTruthy()
    expect(within(rows[2]).queryByText('No owner')).toBeNull()
    expect(within(rows[2]).getByText(`${window.location.origin}/acme`)).toBeTruthy()
    expect(within(rows[2]).getByText(/Owned by @ana and @bo · 5 people/)).toBeTruthy()
    expect(within(rows[1]).getByText(/Admins @sam · 3 people/)).toBeTruthy()
    expect(within(rows[0]).getByText(/Nobody runs it · 0 people/)).toBeTruthy()
    // A binder you're in links to it; one you're not in is only listed.
    expect(within(rows[2]).getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('/acme/#/home')
    expect(within(rows[0]).queryByRole('link', { name: 'Lonely' })).toBeNull()
  })

  it('says so when the hub has no binders', async () => {
    hub({ hubAdmin: true, section: 'hubbinders', list: [] })
    await mount(<Settings />)
    expect(await screen.findByText('No binders on this hub yet.')).toBeTruthy()
  })

  it('says, before naming the first owner of a binder nobody is in, that it stops being open to everyone', async () => {
    const warning = 'Nobody is in this binder yet, so everyone who can sign in can open it. Once it has an owner, only the people added to it can.'
    hub({ hubAdmin: true, section: 'hubbinders', list: [listed({ id: 'lonely', name: 'Lonely', owners: [], people: 0 }), listed({ id: 'gone', name: 'Gone', owners: [], people: 3 })] })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Name an owner for Lonely' }))
    expect(within(await screen.findByRole('dialog', { name: 'Name an owner' })).getByText(warning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // One whose owners have gone has people in it: naming an owner closes it to nobody.
    fireEvent.click(await screen.findByRole('button', { name: 'Name an owner for Gone' }))
    expect(within(await screen.findByRole('dialog', { name: 'Name an owner' })).queryByText(warning)).toBeNull()
  })

  it('names an owner from a dialog with one labelled field, then says so and shows the list as it is now', async () => {
    const said = toasts()
    const sent = hub({ hubAdmin: true, section: 'hubbinders', list: [listed({ id: 'lonely', name: 'Lonely', owners: [], people: 0 }), listed({ id: 'acme', name: 'Acme', yours: true })] })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Name an owner for Lonely' }))
    const dialog = await screen.findByRole('dialog', { name: 'Name an owner' })
    expect(within(dialog).getByText('Lonely')).toBeTruthy()
    const login = within(dialog).getByLabelText('GitHub login')
    // The name is above a full-width box, as everywhere in Settings.
    expect(login.closest('.field')!.firstElementChild!.textContent).toBe('GitHub login')
    const button = within(dialog).getByRole('button', { name: 'Make an owner' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(login, { target: { value: '@carol' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make @carol an owner' }))
    await waitFor(() => expect(said).toContain('Made @carol an owner of Lonely.'))
    expect(sent).toEqual([{ method: 'PUT', url: '/api/hub/binders/lonely/owners/carol' }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const row = screen.getByRole('list', { name: 'Binders on this hub' })
    expect(within(row).queryByText('No owner')).toBeNull()
    expect(within(row).getByText(/Owned by @carol/)).toBeTruthy()
  })

  it('shows the hub’s own words when it refuses, and keeps the dialog for another try', async () => {
    const said = toasts()
    hub({ hubAdmin: true, section: 'hubbinders', list: [listed({ id: 'lonely', name: 'Lonely', owners: [] })], put: () => json({ error: 'A personal Binder is only its person’s.' }, 400) })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Name an owner for Lonely' }))
    fireEvent.change(await screen.findByLabelText('GitHub login'), { target: { value: 'carol' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make @carol an owner' }))
    await waitFor(() => expect(said).toContain('A personal Binder is only its person’s.'))
    expect(screen.getByRole('dialog', { name: 'Name an owner' })).toBeTruthy()
    expect(screen.getByLabelText('GitHub login')).toHaveProperty('value', 'carol')
    expect(said.some((m) => m.startsWith('Made'))).toBe(false)
  })

  it('can name an owner for a binder that already has one', async () => {
    const sent = hub({ hubAdmin: true, section: 'hubbinders', list: [listed({ id: 'acme', name: 'Acme', yours: true })] })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Name an owner for Acme' }))
    fireEvent.change(await screen.findByLabelText('GitHub login'), { target: { value: 'dee' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make @dee an owner' }))
    await waitFor(() => expect(sent).toEqual([{ method: 'PUT', url: '/api/hub/binders/acme/owners/dee' }]))
  })
})
