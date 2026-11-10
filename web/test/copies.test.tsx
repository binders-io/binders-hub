// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'
import { nameFromCopy } from '../src/screens/settings/access'

// A binder's copies: the card to download one, the switch for a daily copy in its repo, the hub's own seven days, and a
// new binder started from a file. The hub's routes are stood in for.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Role = 'owner' | 'admin' | 'member' | 'reader'
interface Copies { latest?: { at: string; bytes: number; version: number }; days: number; inRepo?: { on: boolean; repo?: string; branch: string; at?: string; failed?: string } }
interface Listed { id: string; name: string; createdAt: string; people: number; owners: string[]; admins: string[]; yours: boolean }

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
const listed = (id: string, name: string): Listed => ({ id, name, createdAt: 'then', people: 1, owners: ['ana'], admins: [], yours: true })

/** Acme, which you have `role` in; its one part has `part` over it. `copies` is what the hub says of its copies. */
function hub({ role = 'owner', hubAdmin = false, section, part = { repo: 'acme/api', repos: ['acme/api'] } as object, copies = { days: 7 } as Copies, list = [] as Listed[], fromCopy }: { role?: Role; hubAdmin?: boolean; section: string; part?: object; copies?: Copies; list?: Listed[]; fromCopy?: (init: RequestInit) => Response }) {
  const spaces = [{ id: 'acme', name: 'Acme', role, createdAt: 'then', managers: [{ login: 'ana', role: 'owner' }], members: undefined }]
  const { posted } = standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server', ...part }] }), { ...me, role, hubAdmin, space: 'acme', spaces: spaces.map((s) => ({ id: s.id, name: s.name, role })), log: 'redis' })
  window.localStorage.setItem('binders-settings-part', section)
  const uploads: { url: string; init: RequestInit }[] = []
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/spaces') return json({ spaces, mayCreate: false })
    if (url === '/api/copies') return json(copies)
    if (url === '/api/issues') return json({ binders: {} })
    if (url === '/api/hub/binders') return json({ binders: list })
    if (url.startsWith('/api/hub/binders/from-copy')) {
      uploads.push({ url, init: init! })
      return fromCopy ? fromCopy(init!) : json({ binders: [...list, listed('copy', 'Copy')], created: { id: 'copy', name: 'Copy' } })
    }
    if (url === '/api/github/lists') return json({ installations: [] })
    return stand(url, init)
  }))
  return { posted, uploads }
}

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

const cardText = 'Everything in this binder as one file: its notes, its board, its change sets and its history. Not its connections to GitHub or Jira, no tokens, and not the pictures and files in notes, which are kept with the notes.'

describe('the card to download a copy', () => {
  it.each<[Role, boolean]>([['owner', true], ['admin', true], ['member', false], ['reader', false]])('is shown to a %s: %s', async (role, shown) => {
    hub({ role, section: 'general' })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    await waitFor(() => expect(!!screen.queryByRole('heading', { name: 'Download a copy' })).toBe(shown))
    expect(!!screen.queryByText(cardText)).toBe(shown)
  })

  it('says what is in a copy and what is not, and has a plain link to this binder’s copy that saves as a file', async () => {
    hub({ section: 'general' })
    await mount(<Settings />)
    const card = (await screen.findByRole('heading', { name: 'Download a copy' })).closest('section')!
    expect(within(card).getByText(cardText)).toBeTruthy()
    const link = within(card).getByRole('link', { name: 'Download a copy' })
    expect(link.getAttribute('href')).toBe('/api/spaces/acme/copy')
    expect(link.hasAttribute('download')).toBe(true)
  })
})

describe('the daily copy in the repo, in How work flows', () => {
  const switchName = 'Keep a daily copy of the whole binder in acme/api'

  it('is off until turned on, with its lines, and turning it on saves at once', async () => {
    const { posted } = hub({ section: 'flow', copies: { days: 7, inRepo: { on: false, repo: 'acme/api', branch: 'binders-copies' } } })
    await mount(<Settings />)
    const copies = await screen.findByRole('checkbox', { name: switchName })
    expect((copies as HTMLInputElement).checked).toBe(false)
    expect(copies.hasAttribute('disabled')).toBe(false)
    const row = copies.closest('.issues-row')!
    expect(row.textContent).toContain('On branch binders-copies. Seven days are kept. Anyone who can read acme/api can read them.')
    expect(within(row as HTMLElement).queryByText(/Last copy/)).toBeNull()
    fireEvent.click(copies)
    await screen.findByText('Saved')
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"copies":true'))
  })

  it('shows on when the binder says so, and turning it off saves', async () => {
    const { posted } = hub({ section: 'flow', part: { repo: 'acme/api', repos: ['acme/api'], copies: true } })
    await mount(<Settings />)
    const copies = await screen.findByRole('checkbox', { name: switchName })
    expect((copies as HTMLInputElement).checked).toBe(true)
    fireEvent.click(copies)
    await waitFor(() => expect(JSON.stringify(posted)).toContain('"copies":false'))
  })

  it('is greyed with its reason when the binder has no repo yet', async () => {
    hub({ section: 'flow', part: {} })
    await mount(<Settings />)
    const copies = await screen.findByRole('checkbox', { name: /Keep a daily copy of the whole binder/ })
    expect(copies.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('This binder has no repo yet.')).toBeTruthy()
    expect(screen.queryByText(/Anyone who can read/)).toBeNull()
  })

  it('says when the last copy was made, once it is on', async () => {
    hub({ section: 'flow', part: { repo: 'acme/api', repos: ['acme/api'], copies: true }, copies: { days: 7, inRepo: { on: true, repo: 'acme/api', branch: 'binders-copies', at: hoursAgo(3) } } })
    await mount(<Settings />)
    expect(await screen.findByText('Last copy 3h ago.')).toBeTruthy()
  })

  it('says nothing of a last copy while it is off', async () => {
    hub({ section: 'flow', copies: { days: 7, inRepo: { on: false, branch: 'binders-copies', at: hoursAgo(3) } } })
    await mount(<Settings />)
    await screen.findByRole('checkbox', { name: switchName })
    expect(screen.queryByText(/Last copy/)).toBeNull()
  })

  it('shows the hub’s words when the push failed, as a problem', async () => {
    hub({ section: 'flow', part: { repo: 'acme/api', repos: ['acme/api'], copies: true }, copies: { days: 7, inRepo: { on: true, repo: 'acme/api', branch: 'binders-copies', failed: 'GitHub refused the push: no access to acme/api.' } } })
    await mount(<Settings />)
    const line = await screen.findByText('GitHub refused the push: no access to acme/api.')
    expect(line.className).toContain('problem')
    expect(screen.queryByText(/Last copy/)).toBeNull()
  })

  it('says the hub keeps seven days on its own disk, with when the last one was', async () => {
    hub({ section: 'flow', copies: { days: 7, latest: { at: hoursAgo(5), bytes: 1200, version: 40 } } })
    await mount(<Settings />)
    expect(await screen.findByText('The hub also keeps seven days of copies on its own disk. Last one 5h ago.')).toBeTruthy()
  })

  it('says it without a last one when there is none yet, and to a member of the binder too, whatever the switch says', async () => {
    hub({ section: 'flow', role: 'member', part: {} })
    await mount(<Settings />)
    expect(await screen.findByText('The hub also keeps seven days of copies on its own disk.')).toBeTruthy()
  })
})

describe('New binder from a copy', () => {
  const fileNamed = (name: string) => new File(['gz'], name, { type: 'application/gzip' })
  const opened = async (over: Parameters<typeof hub>[0] extends infer T ? Partial<T> : never = {}) => {
    const set = hub({ hubAdmin: true, section: 'hubbinders', list: [listed('acme', 'Acme')], ...over } as Parameters<typeof hub>[0])
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'New binder from a copy' }))
    return { ...set, dialog: await screen.findByRole('dialog', { name: 'New binder from a copy' }) }
  }

  it('is for the hub’s admins, above the list', async () => {
    hub({ hubAdmin: true, section: 'hubbinders', list: [listed('acme', 'Acme')] })
    await mount(<Settings />)
    const button = await screen.findByRole('button', { name: 'New binder from a copy' })
    const list = screen.getByRole('list', { name: 'Binders on this hub' })
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    cleanup()
    hub({ hubAdmin: false, section: 'general' })
    await mount(<Settings />)
    await screen.findByLabelText('Name')
    expect(screen.queryByRole('button', { name: 'New binder from a copy' })).toBeNull()
  })

  it('is there when the hub has no binders', async () => {
    hub({ hubAdmin: true, section: 'hubbinders', list: [] })
    await mount(<Settings />)
    expect(await screen.findByRole('button', { name: 'New binder from a copy' })).toBeTruthy()
    expect(screen.getByText('No binders on this hub yet.')).toBeTruthy()
  })

  it('takes the name from the file’s name, in words with a capital, and lets it be changed', async () => {
    const { dialog } = await opened()
    const file = within(dialog).getByLabelText('The copy') as HTMLInputElement
    expect(file.getAttribute('accept')).toContain('.gz')
    expect(file.closest('.field')!.firstElementChild!.textContent).toBe('The copy')
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement
    expect(name.value).toBe('')
    expect(within(dialog).getByRole('button', { name: 'Make the binder' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(file, { target: { files: [fileNamed('my-team-2026-11-09.binder-copy.json.gz')] } })
    expect(name.value).toBe('My team')
    fireEvent.change(name, { target: { value: 'My team again' } })
    expect(name.value).toBe('My team again')
    expect(within(dialog).getByRole('button', { name: 'Make the binder' }).hasAttribute('disabled')).toBe(false)
  })

  it('works the name out of a file’s name', () => {
    expect(nameFromCopy('acme-2026-11-09.binder-copy.json.gz')).toBe('Acme')
    expect(nameFromCopy('~ana-2026-01-02.binder-copy.json.gz')).toBe('~ana')
    expect(nameFromCopy('a-b-c-2026-01-02.binder-copy.json.gz')).toBe('A b c')
    expect(nameFromCopy('backup.gz')).toBe('Backup')
  })

  it('sends the file as the body, as gzip, with the name in the address and the headers the other calls send', async () => {
    const { uploads, dialog } = await opened()
    const file = fileNamed('my-team-2026-11-09.binder-copy.json.gz')
    fireEvent.change(within(dialog).getByLabelText('The copy'), { target: { files: [file] } })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Team & co' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make the binder' }))
    await waitFor(() => expect(uploads.length).toBe(1))
    expect(uploads[0].url).toBe('/api/hub/binders/from-copy?name=Team%20%26%20co')
    expect(uploads[0].init.method).toBe('POST')
    expect(uploads[0].init.body).toBe(file)
    expect(uploads[0].init.headers).toMatchObject({ 'x-binders': '1', 'content-type': 'application/gzip' })
  })

  it('says it is making the binder, and cannot be pressed again, while the file goes up', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((done) => { release = done })
    const set = hub({ hubAdmin: true, section: 'hubbinders', list: [listed('acme', 'Acme')] })
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/hub/binders/from-copy')) {
        set.uploads.push({ url, init: init! })
        await held
        return json({ binders: [], created: { id: 'copy', name: 'Copy' } })
      }
      return stand(url, init)
    }))
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'New binder from a copy' }))
    const dialog = await screen.findByRole('dialog', { name: 'New binder from a copy' })
    fireEvent.change(within(dialog).getByLabelText('The copy'), { target: { files: [fileNamed('copy-2026-11-09.binder-copy.json.gz')] } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make the binder' }))
    const busy = await within(dialog).findByRole('button', { name: 'Making it…' })
    expect(busy.hasAttribute('disabled')).toBe(true)
    fireEvent.click(busy)
    release()
    await within(dialog).findByText('It doesn’t write to GitHub until that’s turned on in its Settings.')
    expect(set.uploads.length).toBe(1)
  })

  it('says it is made, that it does not write to GitHub yet, and links to it, and shows it in the list', async () => {
    const said = toasts()
    const { dialog } = await opened()
    fireEvent.change(within(dialog).getByLabelText('The copy'), { target: { files: [fileNamed('copy-2026-11-09.binder-copy.json.gz')] } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make the binder' }))
    await waitFor(() => expect(said).toContain('Made Copy from the copy.'))
    expect(await within(dialog).findByText('It doesn’t write to GitHub until that’s turned on in its Settings.')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Open Copy' }).getAttribute('href')).toBe('/copy/#/home')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const rows = within(screen.getByRole('list', { name: 'Binders on this hub' })).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Acme', 'Copy'])
  })

  it('shows the hub’s own words when it refuses, and keeps the dialog and what was chosen for another try', async () => {
    const said = toasts()
    const { dialog } = await opened({ fromCopy: () => json({ error: 'That is not a copy of a binder.' }, 400) })
    fireEvent.change(within(dialog).getByLabelText('The copy'), { target: { files: [fileNamed('notes-2026-11-09.binder-copy.json.gz')] } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make the binder' }))
    await waitFor(() => expect(said).toContain('That is not a copy of a binder.'))
    expect(screen.getByRole('dialog', { name: 'New binder from a copy' })).toBeTruthy()
    expect(within(dialog).getByLabelText('Name')).toHaveProperty('value', 'Notes')
    expect(within(dialog).getByRole('button', { name: 'Make the binder' }).hasAttribute('disabled')).toBe(false)
    expect(within(dialog).queryByText(/doesn’t write to GitHub/)).toBeNull()
    expect(said.some((m) => m.startsWith('Made'))).toBe(false)
  })
})
