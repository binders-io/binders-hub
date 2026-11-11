// @vitest-environment jsdom
import axe from 'axe-core'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, hubState, me, mount, settle, standInHub, standInRepos } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NewSpace } from '../src/components/SpacePanel'
import { Settings } from '../src/screens/Settings'
import { sections } from '../src/screens/settings/sections'

// The sections of this binder's group: what each shows, who may change it, and how a change says it was kept.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Role = 'owner' | 'admin' | 'member'
interface Sent { method?: string; url: string; body?: Record<string, unknown> }

const you = { login: 'you', role: 'owner' as Role }
const sam = { login: 'sam', role: 'admin' as Role }
const bob = { login: 'bob', role: 'member' as Role }

const space = (over: object = {}) => ({ id: 'acme', name: 'Acme', role: 'owner', createdAt: 'then', managers: [{ login: 'you', role: 'owner' }, { login: 'sam', role: 'admin' }], members: [you, sam, bob], ...over })

/**
 * The hub with one binder, Acme, and `role` in it. `answers` is what the hub says to a change to the binders, by method.
 * Gives every request to the binders and what was posted to the board.
 */
function hub({ role = 'owner', hubAdmin = false, section, spaceOver = {}, state = {}, answers = {} as Record<string, (url: string) => unknown> }: { role?: Role; hubAdmin?: boolean; section: string; spaceOver?: object; state?: object; answers?: Record<string, (url: string) => unknown> }) {
  const mine = space({ role, ...spaceOver })
  const spaces = [mine, { id: 'other', name: 'Other', role: 'member', createdAt: 'then', managers: [] }]
  const { posted } = standInHub(() => ({
    ...hubState({ binders: [{ id: 'b1', name: 'Server', repo: 'acme/api', repos: ['acme/api'] }], agents: [{ ...agent, id: 'a1', name: 'Ada', owner: 'you' }, { ...agent, id: 'a2', name: 'Bot', owner: 'sam' }] }),
    ...state,
  }), { ...me, role, hubAdmin, space: mine.id, spaces: spaces.map((s) => ({ id: s.id, name: s.name, role: s.role })), log: 'redis' })
  window.localStorage.setItem('binders-settings-part', section)
  const sent: Sent[] = []
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/spaces') return json({ spaces, mayCreate: true })
    if (url.startsWith('/api/spaces/')) {
      sent.push({ method: init?.method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const answer = answers[init?.method ?? 'GET']
      return json(answer ? answer(url) : { spaces, mayCreate: true })
    }
    if (url === '/api/issues') return json({ binders: { b1: { on: true, kept: 3, waiting: 0 } } })
    if (url === '/api/github/lists') return json({ installations: [] })
    return stand(url, init)
  }))
  return { sent, posted }
}

/** What the hub's refusals and notices said, as a toast would show them. */
function toasts() {
  const said: string[] = []
  window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string }>).detail.message))
  return said
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('General', () => {
  it('renames the binder from a name above a full-width box, and says it was saved', async () => {
    const { sent } = hub({ section: 'general' })
    await mount(<Settings />)
    const name = await screen.findByLabelText('Name')
    expect(name.closest('.field')!.firstElementChild!.textContent).toContain('Name')
    fireEvent.change(name, { target: { value: 'Acme 2' } })
    fireEvent.blur(name)
    await screen.findByText('Saved')
    expect(sent).toEqual([{ method: 'PATCH', url: '/api/spaces/acme', body: { name: 'Acme 2' } }])
  })

  it('has someone who isn’t an owner or admin see it greyed, with who can change it', async () => {
    hub({ section: 'general', role: 'member', spaceOver: { members: undefined } })
    await mount(<Settings />)
    expect(await screen.findByText('Only this binder’s owners and admins, @you and @sam, can change these.')).toBeTruthy()
    expect(screen.getByLabelText('Name').closest('fieldset')!.disabled).toBe(true)
  })

  it('leaves the binder after asking, saying how many of their agents stop', async () => {
    const { sent } = hub({ section: 'general', role: 'admin', spaceOver: { managers: [{ login: 'you', role: 'admin' }, { login: 'sam', role: 'owner' }] }, answers: { DELETE: () => ({ spaces: [space({ id: 'other', name: 'Other' })], mayCreate: true, revoked: [{ id: 'a1', name: 'Ada' }] }) } })
    await mount(<Settings />)
    expect(await screen.findByText(/1 agent of yours stops working in it: Ada\./)).toBeTruthy()
    const leave = screen.getByRole('button', { name: 'Leave' })
    fireEvent.click(leave)
    expect(sent).toEqual([])
    expect(leave.textContent).toBe('Leave it? Press again')
    fireEvent.click(leave)
    expect(await screen.findByText('You left Acme.')).toBeTruthy()
    expect(screen.getByText('1 agent of yours was revoked with you: Ada.')).toBeTruthy()
    expect(sent).toEqual([{ method: 'DELETE', url: '/api/spaces/acme/members/you', body: undefined }])
    expect(screen.getByRole('link', { name: 'Open Other' }).getAttribute('href')).toBe('/other/#/home')
  })

  it('doesn’t offer leaving to its last owner, and says what to do first', async () => {
    hub({ section: 'general', spaceOver: { managers: [{ login: 'you', role: 'owner' }] } })
    await mount(<Settings />)
    expect(await screen.findByText(/You’re its only owner/)).toBeTruthy()
    expect(within(document.querySelector('.settings-pane') as HTMLElement).getByRole('link', { name: 'People' }).getAttribute('href')).toBe('#/settings/people')
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull()
  })

  it('takes the binder off the hub from a dialog, once its name is typed, saying nothing is destroyed', async () => {
    const { sent } = hub({ section: 'general', answers: { DELETE: () => ({ spaces: [], mayCreate: true, removed: { id: 'acme', name: 'Acme' } }) } })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take it off…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Take Acme off the hub?' })
    expect(within(dialog).getByText(/Nothing is destroyed\. Its notes stay in its GitHub repo and its data on the hub’s disk/)).toBeTruthy()
    const button = within(dialog).getByRole('button', { name: 'Take it off the hub' })
    const typed = within(dialog).getByLabelText('Type its name to confirm')
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(typed, { target: { value: 'acme' } })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(typed, { target: { value: 'Acme' } })
    fireEvent.click(button)
    expect(await screen.findByText('Acme is off the hub.')).toBeTruthy()
    expect(screen.getByText(/Its notes are still in its GitHub repo/)).toBeTruthy()
    expect(sent).toEqual([{ method: 'DELETE', url: '/api/spaces/acme', body: { name: 'Acme' } }])
    expect(screen.getByRole('link', { name: 'Go to the hub' }).getAttribute('href')).toBe('/')
  })

  it('shows the hub’s own words when it refuses', async () => {
    const said = toasts()
    hub({ section: 'general', answers: { DELETE: () => { throw new Error('unused') } } })
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'DELETE' ? json({ error: 'The hub’s first Binder can’t be removed: its files are the hub’s own.' }, 400) : stand(url, init))))
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take it off…' }))
    fireEvent.change(await screen.findByLabelText('Type its name to confirm'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Take it off the hub' }))
    await waitFor(() => expect(said).toContain('The hub’s first Binder can’t be removed: its files are the hub’s own.'))
    // The dialog stays, for another try.
    expect(screen.getByRole('dialog', { name: 'Take Acme off the hub?' })).toBeTruthy()
  })

  it('offers taking it off the hub only to its owners and the hub’s admins, and never for a personal binder', async () => {
    const heading = (name: string) => screen.queryByText(name)
    hub({ section: 'general', role: 'admin' })
    await mount(<Settings />)
    await screen.findByText('Leave this binder')
    expect(heading('Take this binder off the hub')).toBeNull()
    cleanup()
    // A hub admin has no place in a binder that has an owner, so it's an admin's offer no more than theirs.
    hub({ section: 'general', role: 'admin', hubAdmin: true })
    await mount(<Settings />)
    await screen.findByText('Leave this binder')
    expect(heading('Take this binder off the hub')).toBeNull()
    cleanup()
    // Looking after one with no owner, the hub gives them the role admin, and they may.
    hub({ section: 'general', role: 'admin', hubAdmin: true, spaceOver: { managers: [{ login: 'sam', role: 'admin' }] } })
    await mount(<Settings />)
    expect(await screen.findByText('Take this binder off the hub')).toBeTruthy()
    cleanup()
    hub({ section: 'general', role: 'admin', spaceOver: { managers: [{ login: 'sam', role: 'admin' }] } })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    expect(heading('Take this binder off the hub')).toBeNull()
    cleanup()
    hub({ section: 'general', spaceOver: { id: '~you' } })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    expect(heading('Take this binder off the hub')).toBeNull()
    expect(heading('Leave this binder')).toBeNull()
  })

  it('doesn’t offer taking the hub’s first binder off, and says it’s the hub’s own and stays', async () => {
    hub({ section: 'general', spaceOver: { first: true } })
    await mount(<Settings />)
    expect(await screen.findByText('Take this binder off the hub')).toBeTruthy()
    expect(screen.getByText('This is the hub’s own binder, so it stays.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Take it off…' })).toBeNull()
    expect(screen.queryByLabelText('Type its name to confirm')).toBeNull()
  })

  it('has each part as a row, under the binder’s own name, that opens its name and delete', async () => {
    const { posted } = hub({ section: 'general', state: { binders: [{ id: 'b1', name: 'First part' }, { id: 'b2', name: 'Second part' }] } })
    await mount(<Settings />)
    const parts = (await screen.findByRole('heading', { name: 'Its parts' })).closest('section')!
    expect(screen.getByLabelText('Name')).toBeTruthy()
    // The sample hub's notes and cards are on the first part, so only the second is empty enough to delete.
    fireEvent.click(within(parts).getByRole('button', { name: 'Change its part Second part' }))
    let dialog = await screen.findByRole('dialog', { name: 'Second part' })
    expect(within(dialog).getByRole('button', { name: 'Delete this part' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(parts).getByRole('button', { name: 'Change its part First part' }))
    dialog = await screen.findByRole('dialog', { name: 'First part' })
    expect(within(dialog).getByRole('button', { name: 'Delete this part' }).hasAttribute('disabled')).toBe(true)
    const name = within(dialog).getByLabelText('Name')
    expect(name.closest('.field')!.firstElementChild!.textContent).toBe('Name')
    fireEvent.change(name, { target: { value: 'Front end' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"name":"Front end"'))
  })

  it('starts a binder’s notes and board from a name above a full-width box, when it has none', async () => {
    const { posted } = hub({ section: 'general', state: { binders: [] } })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start them' }))
    await screen.findByRole('dialog', { name: 'Start its notes and board' })
    const name = await screen.findByLabelText('Name', { selector: '#new-binder-name' })
    expect(name.closest('.field')!.firstElementChild!.textContent).toBe('Name')
    fireEvent.change(name, { target: { value: 'Notebook' } })
    fireEvent.click(screen.getByRole('button', { name: /Start it/ }))
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"name":"Notebook"'))
  })

  it('has no list of other binders or form for a new one: the switcher has both', async () => {
    hub({ section: 'general', hubAdmin: true })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    expect(screen.queryByText('Your other binders')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'New binder' })).toBeNull()
    expect(screen.queryByText('Other')).toBeNull()
  })
})

describe('People', () => {
  it('shows everyone who runs the binder, and says who can change it to a member', async () => {
    hub({ section: 'people', role: 'member', spaceOver: { members: undefined } })
    await mount(<Settings />)
    const runs = (await screen.findByRole('heading', { name: 'Who runs it' })).closest('section')!
    expect(within(runs).getByText('Owner')).toBeTruthy()
    expect(within(runs).getByText('Admin')).toBeTruthy()
    expect(screen.getByText('Only this binder’s owners and admins, @you and @sam, can change these.')).toBeTruthy()
    expect(screen.queryByLabelText('sam’s role')).toBeNull()
  })

  it('warns, as more than grey text, that a binder with no members is open to everyone who can sign in', async () => {
    hub({ section: 'people', spaceOver: { managers: [], members: [] } })
    await mount(<Settings />)
    const warning = await screen.findByText(/Nobody is in this binder yet, so anyone who can sign in to this hub can open it/)
    expect(warning.closest('[role="status"]')!.className).toContain('setup-warning')
    expect(warning.textContent).toContain('Add its first member, as owner')
    cleanup()
    hub({ section: 'people', role: 'member', spaceOver: { managers: [], members: undefined } })
    await mount(<Settings />)
    expect(await screen.findByText(/One of the hub’s admins adds its first owner/)).toBeTruthy()
  })

  /** A person's ⋯, and what's in it. */
  const menuOf = async (login: string) => {
    fireEvent.click(await screen.findByRole('button', { name: `More for ${login}` }))
    return screen.findAllByRole('menuitem')
  }

  it('asks before removing someone, from their row’s menu, and says how many of their agents are revoked with them', async () => {
    const said = toasts()
    const { sent } = hub({ section: 'people', answers: { DELETE: () => ({ spaces: [space()], mayCreate: true, revoked: [{ id: 'a2', name: 'Bot' }] }) } })
    await mount(<><Settings /><ContextMenuHost /></>)
    const items = await menuOf('sam')
    expect(items.map((i) => i.textContent)).toEqual(['Remove from this binder'])
    fireEvent.click(items[0])
    const dialog = await screen.findByRole('dialog', { name: 'Remove sam?' })
    expect(sent).toEqual([])
    expect(within(dialog).getByText('1 agent of theirs stops with them: Bot.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove sam' }))
    await waitFor(() => expect(said).toContain('Removed @sam. Their 1 agent was revoked with them: Bot.'))
    expect(sent).toEqual([{ method: 'DELETE', url: '/api/spaces/acme/members/sam', body: undefined }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says when the person has no agents to stop, and Cancel removes no one', async () => {
    const { sent } = hub({ section: 'people' })
    await mount(<><Settings /><ContextMenuHost /></>)
    fireEvent.click((await menuOf('bob'))[0])
    const dialog = await screen.findByRole('dialog', { name: 'Remove bob?' })
    expect(within(dialog).getByText('None of their agents work here.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent).toEqual([])
  })

  it('sends you to General to leave, from your own row’s menu', async () => {
    hub({ section: 'people' })
    await mount(<><Settings /><ContextMenuHost /></>)
    const items = await menuOf('you')
    expect(items.map((i) => i.textContent)).toEqual(['Leave this binder…'])
    fireEvent.click(items[0])
    expect(window.location.hash).toBe('#/settings/general')
  })

  it('changes a role at once, and says it was saved', async () => {
    const { sent } = hub({ section: 'people' })
    await mount(<Settings />)
    fireEvent.change(await screen.findByLabelText('bob’s role'), { target: { value: 'admin' } })
    await screen.findByText('Saved')
    expect(sent).toEqual([{ method: 'PUT', url: '/api/spaces/acme/members/bob', body: { role: 'admin' } }])
  })

  it('adds people from one button in the header, and a dialog with the role they get', async () => {
    const said = toasts()
    const { sent } = hub({ section: 'people' })
    await mount(<Settings />)
    const add = await screen.findByRole('button', { name: 'Add people' })
    expect(add.closest('.page-header')).toBeTruthy()
    fireEvent.click(add)
    const dialog = await screen.findByRole('dialog', { name: 'Add people' })
    const box = within(dialog).getByRole('textbox', { name: 'GitHub logins' })
    expect(within(dialog).getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(box, { target: { value: '@carol' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.change(box, { target: { value: 'dee' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(within(dialog).getByText('@carol')).toBeTruthy()
    // Member, unless another is picked; each says what it may do.
    expect((within(dialog).getByRole('radio', { name: /^Member/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Admin/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 people' }))
    await waitFor(() => expect(said).toContain('Added 2 people as admins.'))
    expect(sent).toEqual([
      { method: 'PUT', url: '/api/spaces/acme/members/carol', body: { role: 'admin' } },
      { method: 'PUT', url: '/api/spaces/acme/members/dee', body: { role: 'admin' } },
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps who wasn’t added in the dialog when the hub refuses one, in its own words', async () => {
    const said = toasts()
    hub({ section: 'people' })
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'PUT' && url.endsWith('/dee') ? json({ error: 'Only owners make owners.' }, 403) : stand(url, init))))
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add people' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add people' })
    const box = within(dialog).getByRole('textbox', { name: 'GitHub logins' })
    for (const login of ['carol', 'dee']) {
      fireEvent.change(box, { target: { value: login } })
      fireEvent.keyDown(box, { key: 'Enter' })
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 people' }))
    await waitFor(() => expect(said).toContain('Only owners make owners.'))
    expect(said).toContain('Added @carol as a member.')
    expect(screen.getByRole('dialog', { name: 'Add people' })).toBeTruthy()
    expect(within(dialog).queryByText('@carol')).toBeNull()
    expect(within(dialog).getByText('@dee')).toBeTruthy()
  })

  it('has no Add people for someone who may not add anyone', async () => {
    hub({ section: 'people', role: 'member', spaceOver: { members: undefined } })
    await mount(<Settings />)
    await screen.findByRole('heading', { name: 'Who runs it' })
    expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull()
  })
})

describe('GitHub', () => {
  it('has a member read its repos, with what each is for greyed and out of reach, and who can change them', async () => {
    hub({ section: 'github', role: 'member', spaceOver: { members: undefined } })
    await mount(<Settings />)
    expect(await screen.findByText('Only this binder’s owners and admins, @you and @sam, can change these.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add repos/ })).toBeNull()
    // The repo it has, for its cards and among its agents': in its dialog, both switches greyed, and nothing to take it off.
    fireEvent.click(screen.getByRole('button', { name: 'Open acme/api' }))
    const dialog = within(screen.getByRole('dialog', { name: 'acme/api' }))
    for (const name of ['Its cards and notes go here', 'Chosen for its agents']) {
      const box = dialog.getByRole('checkbox', { name }) as HTMLInputElement
      expect(box.checked).toBe(true)
      expect(box.closest('fieldset')!.disabled).toBe(true)
    }
    expect(dialog.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('lets its owner take a repo off, after asking, from its dialog', async () => {
    const { posted } = hub({ section: 'github', state: { binders: [{ id: 'b1', name: 'Server', repo: 'acme/api', repos: ['acme/api', 'acme/web'] }] } })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open acme/web' }))
    const dialog = within(screen.getByRole('dialog', { name: 'acme/web' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }))
    expect(JSON.stringify(posted)).not.toContain('"repos":["acme/api"]')
    fireEvent.click(dialog.getByRole('button', { name: 'Take it off? Press again' }))
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"repos":["acme/api"]'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('takes every repo off the agents’ list at once, after asking, so they work in any repo again', async () => {
    const { posted } = hub({ section: 'github', state: { binders: [{ id: 'b1', name: 'Server', repo: 'acme/api', repos: ['acme/api', 'acme/web'] }] } })
    await mount(<><Settings /><ContextMenuHost /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'More for the repos' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Take every repo off the agents’ list' }))
    expect(JSON.stringify(posted)).not.toContain('"repos"')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Take them all off? Press again' }))
    await waitFor(() => expect(posted.length).toBeGreaterThan(0))
    const binder = posted.flatMap((p) => p.changes).map((c) => c.change).find((c) => c.type === 'binder.put') as { binder: { repo?: string; repos?: string[] } }
    expect(binder.binder.repos).toBeUndefined()
    expect(binder.binder.repo).toBe('acme/api')
  })

  it('adds repos by name from Add repos, to the ones its agents work in', async () => {
    const { posted } = hub({ section: 'github' })
    standInRepos(() => ({ repos: [{ fullName: 'acme/web', private: true, linkable: true }, { fullName: 'acme/docs', private: false, linkable: true }], total: 2, more: 0, topics: [], properties: [], failed: false }))
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add repos/ }))
    fireEvent.click(await screen.findByRole('button', { name: /By name/ }))
    const box = await screen.findByRole('combobox', { name: 'Repos for its agents' })
    act(() => box.focus())
    fireEvent.mouseDown(await screen.findByRole('option', { name: /acme\/web/ }))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /acme\/docs/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 repos' }))
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"repos":["acme/api","acme/web","acme/docs"]'))
  })

  it('adds every repo with a topic together, checked with GitHub first, and says which it left out', async () => {
    const said = toasts()
    const { posted } = hub({ section: 'github' })
    const repos = [{ fullName: 'acme/api', private: true, linkable: true, topics: ['billing'] }, { fullName: 'acme/pay', private: true, linkable: true, topics: ['billing'] }, { fullName: 'acme/old', private: true, linkable: true, topics: ['billing'] }]
    const asked = standInRepos(() => ({ repos, total: 3, more: 0, topics: [{ name: 'billing', count: 3 }], properties: [], failed: false }), { 'acme/old': 'you can only read it' })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add repos/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Every repo with a topic/ }))
    fireEvent.change(await screen.findByLabelText('Topic'), { target: { value: 'billing' } })
    expect(await screen.findByText('2 repos with the topic billing aren’t chosen yet; 1 is already.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add all 2' }))
    await waitFor(() => expect(asked.checked).toEqual([['acme/pay', 'acme/old']]))
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"repos":["acme/api","acme/pay"]'))
    await waitFor(() => expect(said.join(' ')).toContain('Left out acme/old: you can only read it.'))
  })

  it('lets its owner pick the repo its cards go to, from Add repos, and says it was saved', async () => {
    const { posted } = hub({ section: 'github', state: { binders: [{ id: 'b1', name: 'Server' }] } })
    const asked = standInRepos(() => ({ repos: [{ fullName: 'acme/web', private: false, linkable: true }], total: 1, more: 0, topics: [], properties: [], failed: false }))
    await mount(<Settings />)
    // No repos yet: one button to add them, in the empty table.
    expect(await screen.findByText('No repos yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add repos/ }))
    fireEvent.click(await screen.findByRole('button', { name: /The repo its cards and notes go to/ }))
    const box = await screen.findByRole('combobox', { name: 'GitHub repo' })
    act(() => box.focus())
    fireEvent.mouseDown(await screen.findByRole('option', { name: /acme\/web/ }))
    await screen.findByText('Saved')
    expect(asked.length).toBeGreaterThan(0)
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"repo":"acme/web"'))
  })
})

describe('Jira', () => {
  it('says to a member that the binder is mirrored, and who can change it, by name', async () => {
    hub({ section: 'jira', role: 'member', spaceOver: { members: undefined } })
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/jira' ? json({ on: true, mayManage: false }) : stand(url, init))))
    await mount(<Settings />)
    expect(await screen.findByText('This binder’s cards are mirrored into Jira.')).toBeTruthy()
    expect(screen.getByText('Only this binder’s owners and admins, @you and @sam, can change these.')).toBeTruthy()
  })
})

describe('How work flows', () => {
  it('has a switch save at once, and say so beside itself', async () => {
    const { posted } = hub({ section: 'flow' })
    await mount(<Settings />)
    const issues = await screen.findByRole('checkbox', { name: /Keep its cards as issues in acme\/api/ })
    expect(await screen.findByText(/3 cards on GitHub/)).toBeTruthy()
    fireEvent.click(issues)
    await screen.findByText('Saved')
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"issues":false'))
  })

  it('has a member see the switches greyed, with who can change them', async () => {
    hub({ section: 'flow', role: 'member', spaceOver: { members: undefined } })
    await mount(<Settings />)
    expect(await screen.findByText('Only this binder’s owners and admins, @you and @sam, can change these.')).toBeTruthy()
    for (const name of [/Push its notes/, /Keep its cards as issues/, /Keep a daily copy/, /Post a Challenge’s findings/]) expect(screen.getByRole('checkbox', { name }).hasAttribute('disabled')).toBe(true)
  })

  it('has a member of a binder with no owner see the switches greyed, as anyone else', async () => {
    hub({ section: 'flow', role: 'member', spaceOver: { managers: [], members: undefined } })
    await mount(<Settings />)
    const reviews = await screen.findByRole('checkbox', { name: /Post a Challenge’s findings/ })
    expect(reviews.hasAttribute('disabled')).toBe(true)
  })

  it('opens a switch’s row to the rest: the branch notes go on, and syncing the issues', async () => {
    const { posted } = hub({ section: 'flow' })
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: /^Push its notes/ }))
    const notes = within(screen.getByRole('dialog', { name: 'Its notes on GitHub' }))
    const branch = notes.getByLabelText(/Branch/) as HTMLInputElement
    expect(branch.value).toBe('binders-notes')
    fireEvent.change(branch, { target: { value: 'notes' } })
    fireEvent.blur(branch)
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"notesBranch":"notes"'))
    fireEvent.click(notes.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /^Keep its cards as issues/ }))
    const issues = within(screen.getByRole('dialog', { name: 'Its cards as issues' }))
    expect(issues.getByText('3 cards on GitHub.')).toBeTruthy()
    expect(issues.getByRole('link', { name: /Issues on GitHub/ }).getAttribute('href')).toBe('https://github.com/acme/api/issues?q=label%3Abinders')
    expect(issues.getByRole('button', { name: 'Sync now' })).toBeTruthy()
  })

  it('points a binder with no repo to where one is picked', async () => {
    hub({ section: 'flow', state: { binders: [{ id: 'b1', name: 'Server' }] } })
    await mount(<Settings />)
    expect(await screen.findByRole('link', { name: 'pick one in GitHub' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'pick one in GitHub' }).getAttribute('href')).toBe('#/settings/github')
    expect(screen.queryByRole('checkbox', { name: /Push its notes/ })).toBeNull()
  })

  it('lists the schedules, as the Agents page does, and says when there are none', async () => {
    hub({ section: 'flow', state: { schedules: [{ id: 's1', noteId: 'n1', binderId: 'b1', cron: '0 9 * * 1-5', tz: 'UTC', enabled: true, createdAt: new Date().toISOString(), createdBy: 'you' }] } })
    await mount(<><Settings /><ContextMenuHost /></>)
    const schedules = (await screen.findByRole('heading', { name: 'Schedules' })).closest('section')!
    fireEvent.click(within(schedules).getByRole('button', { name: /^More for/ }))
    expect(screen.getByRole('menuitem', { name: 'Run now' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Turn off' })).toBeTruthy()
    cleanup()
    hub({ section: 'flow' })
    await mount(<Settings />)
    expect(await screen.findByText('No schedules yet')).toBeTruthy()
  })

  it('lists each folder that has a rule, with what it does, and opens it as the folder’s menu does', async () => {
    hub({
      section: 'flow',
      state: {
        folders: [{ id: 'f1', binderId: 'b1', name: 'Docs' }, { id: 'f2', binderId: 'b1', name: 'Inbox', parentId: 'f1' }],
        folderRules: [{ id: 'r1', binderId: 'b1', folderId: 'f2', enabled: true, distill: true, agentId: 'a1', quietMinutes: 10, accept: { maxCards: 5, sizes: ['S', 'M'], agents: ['a1'] }, changeSet: 'shared', since: 'then', createdAt: 'then', createdBy: 'you' }],
      },
    })
    await mount(<Settings />)
    const rules = (await screen.findByRole('heading', { name: 'Folder rules' })).closest('section')!
    expect(within(rules).getByText('Docs / Inbox')).toBeTruthy()
    expect(within(rules).getByText('Distills a note once it’s had no edit for 10 minutes, by Ada; accepts up to 5 cards (S, M) without asking; adds each note’s work to the open change set.')).toBeTruthy()
    fireEvent.click(within(rules).getByRole('button', { name: /^Docs \/ Inbox/ }))
    expect(await screen.findByRole('dialog', { name: 'Rules for “Inbox”' })).toBeTruthy()
  })

  it('has a member see the rules but not open them', async () => {
    hub({
      section: 'flow', role: 'member', spaceOver: { members: undefined },
      state: {
        folders: [{ id: 'f1', binderId: 'b1', name: 'Docs' }],
        folderRules: [{ id: 'r1', binderId: 'b1', folderId: 'f1', enabled: true, distill: false, quietMinutes: 10, changeSet: 'own', since: 'then', createdAt: 'then', createdBy: 'you' }],
      },
    })
    await mount(<Settings />)
    expect(await screen.findByText('Doesn’t distill; gives each note its own change set.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Docs/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Only this binder’s owners and admins open a rule.')).toBeTruthy()
  })

  it('has the binder’s environments in it, with how they get there', async () => {
    hub({ section: 'flow' })
    await mount(<Settings />)
    expect(await screen.findByRole('heading', { name: 'Environments' })).toBeTruthy()
    expect(screen.getByText(/When GitHub reports a deployment from one of this binder’s repos, the hub shows it in Delivery\./)).toBeTruthy()
  })
})

describe('a new binder', () => {
  it('has the hub’s admin name its owner with the people picker, one person at a time', async () => {
    standInHub(() => hubState(), { ...me, hubAdmin: true })
    const sent: Sent[] = []
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/spaces') {
        sent.push({ method: init?.method, url, body: JSON.parse(String(init?.body)) })
        return json({})
      }
      if (url.startsWith('/api/github/people')) return json({ people: [{ login: 'carol', why: 'in acme' }] })
      return stand(url, init)
    }))
    await mount(<NewSpace me="you" forOthers />)
    // The one it starts with, as a chip, and the box to pick another beside it.
    expect(screen.getByText('@you')).toBeTruthy()
    const owner = screen.getByLabelText('Its owner')
    act(() => owner.focus())
    fireEvent.change(owner, { target: { value: 'car' } })
    await settle(250)
    fireEvent.mouseDown(await screen.findByRole('button', { name: /carol/ }))
    expect(screen.getByText('@carol')).toBeTruthy()
    expect(screen.queryByText('@you')).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team Two' } })
    fireEvent.click(screen.getByRole('button', { name: /Make the binder/ }))
    await waitFor(() => expect(sent).toEqual([{ method: 'POST', url: '/api/spaces', body: { id: 'team-two', name: 'Team Two', owner: 'carol' } }]))
  })

  it('doesn’t ask anyone else for an owner', async () => {
    standInHub()
    await mount(<NewSpace me="you" forOthers={false} />)
    expect(screen.queryByLabelText('Its owner')).toBeNull()
  })
})

describe('every section', () => {
  // As a11y.test.tsx does: jsdom lays nothing out, so contrast is checked elsewhere. A section on its own has no page
  // around it to be a landmark of, which a11y.test.tsx has.
  it.each(sections.map((s) => [s.id]))('finds nothing for axe to object to in %s', async (id) => {
    hub({
      section: id, hubAdmin: true,
      state: {
        folders: [{ id: 'f1', binderId: 'b1', name: 'Docs' }],
        folderRules: [{ id: 'r1', binderId: 'b1', folderId: 'f1', enabled: true, distill: false, quietMinutes: 10, changeSet: 'own', since: 'then', createdAt: 'then', createdBy: 'you' }],
      },
    })
    await mount(<Settings />)
    await settle(200)
    expect(document.querySelector('.settings-pane h2')!.textContent).toBe(sections.find((s) => s.id === id)!.label)
    const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
  })
})
