// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, settle, standInHub } from './harness'
import App from '../src/App'
import { BinderSwitcher } from '../src/components/BinderSwitcher'
import { phoneQuery } from '../src/components/bits'
import { SettingsLink } from '../src/components/SettingsLink'
import { href, parse } from '../src/route'
import { Settings } from '../src/screens/Settings'

// Every section of Settings has an address of its own, which the Back button, a link and a reload all keep to.

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

function hub(you: object = {}) {
  standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server' }] }), { ...me, hubAdmin: true, log: 'redis', spaces: [], ...you })
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/options') return json({ options: { mergeMethod: 'merge', allowedUsers: [], allowedOrgs: [], admins: [], agentCommits: 'agent' }, locked: {}, implied: { admins: [], allowedUsers: [], allowedOrgs: [] } })
    if (url === '/api/spaces') return json({ spaces: [], mayCreate: false })
    if (url === '/api/github/lists') return json({ installations: [] })
    return stand(url, init)
  }))
}

/** The name of the section that's open: the app has headings of its own beside it. */
const open = () => document.querySelector('.settings-pane h2')?.textContent ?? undefined

const onPhone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === phoneQuery, media: query, addEventListener() {}, removeEventListener() {} }))

beforeEach(() => { window.location.hash = '' })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('the route', () => {
  it('has the section after settings, as notes and change sets have an id', () => {
    expect(parse('#/settings/people')).toEqual({ screen: 'settings', id: 'people' })
    expect(parse('#/settings')).toEqual({ screen: 'settings', id: '' })
    expect(href({ screen: 'settings', id: 'people' })).toBe('#/settings/people')
    // Everything that goes to Settings without naming a section still does.
    expect(href({ screen: 'settings' })).toBe('#/settings')
    expect(href(parse('#/settings'))).toBe('#/settings')
  })
})

describe('Settings sections', () => {
  it('opens the section the address names, marks it as the current one, and remembers it', async () => {
    hub()
    window.location.hash = '#/settings/flow'
    await mount(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    expect(open()).toBe('How work flows')
    expect(within(nav).getByRole('link', { name: 'How work flows' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getAllByRole('link').filter((a) => a.getAttribute('aria-current')).length).toBe(1)
    expect(window.localStorage.getItem('binders-settings-part')).toBe('flow')
  })

  it('opens the one last open for a bare address, and writes it in, so Back moves between sections', async () => {
    hub()
    await mount(<App />)
    // A section remembered from before the groups: General.
    window.localStorage.setItem('binders-settings-part', 'binder')
    window.location.hash = '#/settings'
    await waitFor(() => expect(open()).toBe('General'))
    await waitFor(() => expect(window.location.hash).toBe('#/settings/general'))
  })

  it('goes from one section to another, and Back comes back', async () => {
    hub()
    window.location.hash = '#/settings/general'
    await mount(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    window.location.hash = within(nav).getByRole('link', { name: 'Status' }).getAttribute('href')!
    await waitFor(() => expect(open()).toBe('Status'))
    window.history.back()
    await waitFor(() => expect(open()).toBe('General'))
  })

  it('falls back to the last one open for a section it doesn’t have', async () => {
    hub()
    window.localStorage.setItem('binders-settings-part', 'jira')
    window.location.hash = '#/settings/nonsense'
    await mount(<Settings />)
    expect(open()).toBe('Jira')
  })

  it('shows a phone the list of sections first, and a section with a way back to the list', async () => {
    hub()
    onPhone()
    window.location.hash = '#/settings'
    await mount(<Settings />)
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    expect(within(nav).getAllByRole('link').length).toBe(10)
    expect(open()).toBeUndefined()
    expect(within(nav).getAllByRole('link').some((a) => a.getAttribute('aria-current'))).toBe(false)
    window.location.hash = '#/settings/people'
    await waitFor(() => expect(open()).toBe('People'))
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
    // What comes up is read from its top.
    expect(document.activeElement).toBe(document.querySelector('.settings-pane h2'))
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('#/settings')
    window.location.hash = '#/settings'
    await waitFor(() => expect(open()).toBeUndefined())
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy()
  })
})

describe('links to Settings', () => {
  it('names a section by its new name, and links to it', () => {
    render(<SettingsLink section="status" />)
    expect(screen.getByRole('link', { name: 'Settings → Status' }).getAttribute('href')).toBe('#/settings/status')
    cleanup()
    render(<SettingsLink section="github">the repo</SettingsLink>)
    expect(screen.getByRole('link', { name: 'the repo' }).getAttribute('href')).toBe('#/settings/github')
  })

  it('has the banner for a hub that didn’t update point at Status', async () => {
    hub({ updateFailed: { commit: 'abcdef1234', subject: 'Break it', log: 'x' }, version: { commit: '1234567' } })
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(50)
    const banner = document.querySelector('.update-failed') as HTMLElement
    expect(within(banner).getByRole('link', { name: 'Settings → Status' }).getAttribute('href')).toBe('#/settings/status')
  })

  it('has the switcher’s members, repo and settings go to People, even from another section', async () => {
    hub({ spaces: [{ id: 'acme', name: 'Acme', role: 'owner' }], space: 'acme' })
    window.location.hash = '#/settings/flow'
    await mount(<BinderSwitcher binder="b1" onPick={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }))
    fireEvent.click(screen.getByRole('button', { name: /Members, repo and settings/ }))
    expect(window.location.hash).toBe('#/settings/people')
  })
})
