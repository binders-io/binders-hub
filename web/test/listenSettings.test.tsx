// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, me, mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'
import type { ListenerView } from '../src/data/listen'

// Settings → Listeners: each listener a row with what it is and which choice it's in, opening its dialog; who may change
// them; Add a listener, guided; and the secret of an address to post to, which is shown once.

const base = { binderId: 'b1', folder: 'Inbox', createdAt: 'then', createdBy: 'you' }
const post: ListenerView = { ...base, id: 'l1', name: 'Support form', kind: 'post', mode: 'watch', from: 'anyone', address: 'https://hub.test/webhooks/in/main/l1' }
const feed: ListenerView = { ...base, id: 'l2', name: 'Release notes', kind: 'feed', mode: 'on', folder: 'News', url: 'https://example.com/feed.xml', everyMinutes: 30 }
const github: ListenerView = { ...base, id: 'l3', name: 'Repo issues', kind: 'github', mode: 'off' }

/** The hub with `listeners`, answering what Settings → Listeners asks. `sent` has each change it was sent. */
function listenHub(listeners: ListenerView[], mayManage = true, binders = [{ id: 'b1', name: 'Server' }]) {
  standInHub(() => ({ ...hubState(), binders }), { ...me, role: mayManage ? 'owner' : 'member' })
  window.localStorage.setItem('binders-settings-part', 'listeners')
  const held = listeners.map((l) => ({ ...l }))
  const sent: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const stand = globalThis.fetch
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0]
    if (!path.startsWith('/api/listen')) return stand(url, init)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    sent.push({ method, path, body })
    if (method === 'GET') return json({ listeners: held, mayManage })
    if (method === 'POST' && path === '/api/listen') {
      const made = { ...base, id: 'l9', name: String(body?.name), kind: body?.kind as ListenerView['kind'], mode: 'watch' as const, folder: String(body?.folder), ...(body?.kind === 'post' ? { from: 'anyone' as const, address: 'https://hub.test/webhooks/in/main/l9' } : {}) }
      held.push(made)
      return json({ listener: made, ...(body?.kind === 'post' ? { secret: 'bnl_first_secret' } : {}) })
    }
    if (method === 'POST' && path.endsWith('/secret')) return json({ secret: 'bnl_second_secret' })
    const at = held.find((l) => path.endsWith(`/${l.id}`))
    if (method === 'PUT' && at) { Object.assign(at, body); return json({ listener: at }) }
    if (method === 'DELETE' && at) { held.splice(held.indexOf(at), 1); return new Response(null) }
    return json({})
  }))
  return sent
}
/** A listener's row, in the list. */
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) })
/** A listener's dialog, opened from its row. */
const open = (name: string) => {
  fireEvent.click(row(name))
  return within(screen.getByRole('dialog', { name }))
}
const done = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }))
/** Add a listener: the guided dialog, at the kind asked for. */
const adding = async (kind: RegExp) => {
  fireEvent.click(await screen.findByRole('button', { name: /Add a listener/ }))
  fireEvent.click(await screen.findByRole('button', { name: kind }))
  return within(screen.getByRole('dialog', { name: 'Add a listener' }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('Settings → Listeners', () => {
  it('lists each listener as a row with what it is, where its notes go, and the choice it is in', async () => {
    listenHub([post, feed, github])
    await mount(<Settings />)
    await screen.findByText('Support form')
    expect(row('Support form').textContent).toContain('An address to post to')
    expect(row('Support form').textContent).toContain('Notes go to Inbox')
    expect(row('Support form').textContent).toContain('Watch')
    expect(row('Release notes').textContent).toContain('A feed the hub reads')
    expect(row('Release notes').textContent).toContain('On')
    expect(row('Repo issues').textContent).toContain('GitHub issues')
    expect(row('Repo issues').textContent).toContain('Off')
    // A new one starts in Watch, and the opening says so.
    expect(screen.getByText(/starts in Watch/)).toBeTruthy()
    // Opened, each has its choice, and one line under it says what it means, with the folder in it for On.
    const checked = (dialog: ReturnType<typeof open>) => dialog.getAllByRole('radio', { checked: true }).map((r) => r.textContent)
    let dialog = open('Support form')
    expect(checked(dialog)).toContain('Watch')
    expect(dialog.getByText('The hub says what it would file in Came in, and files nothing.')).toBeTruthy()
    done()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = open('Release notes')
    expect(checked(dialog)).toContain('On')
    expect(dialog.getByText('Each thing it hears becomes a note in News.')).toBeTruthy()
    done()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = open('Repo issues')
    expect(checked(dialog)).toContain('Off')
    expect(dialog.getByText('It hears nothing.')).toBeTruthy()
    expect(dialog.getByText(/Someone in the Binder is heard, and anyone else is from outside/)).toBeTruthy()
  })

  it('sends the new choice when the mode is changed, and shows it', async () => {
    const sent = listenHub([post])
    await mount(<Settings />)
    await screen.findByText('Support form')
    const dialog = open('Support form')
    fireEvent.click(dialog.getByRole('radio', { name: 'On' }))
    await waitFor(() => expect(sent.find((s) => s.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/listen/l1', body: { mode: 'on' } }))
    await waitFor(() => expect(dialog.getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true'))
    expect(dialog.getByText('Each thing it hears becomes a note in Inbox.')).toBeTruthy()
    expect(dialog.getByRole('radio', { name: 'Watch' }).getAttribute('aria-checked')).toBe('false')
    expect(row('Support form').textContent).toContain('On')
  })

  it('sends who has an address to post to when it is changed', async () => {
    const sent = listenHub([post])
    await mount(<Settings />)
    await screen.findByText('Support form')
    const dialog = open('Support form')
    expect((dialog.getByLabelText('Anyone') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(dialog.getByLabelText('Only people in this Binder'))
    await waitFor(() => expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ from: 'binder' }))
    await waitFor(() => expect((dialog.getByLabelText('Only people in this Binder') as HTMLInputElement).checked).toBe(true))
  })

  it('shows a person who may not manage the listeners no way to change them', async () => {
    listenHub([post, feed], false)
    await mount(<Settings />)
    await screen.findByText('Support form')
    expect(screen.getByText(/Only this binder’s owners and admins/)).toBeTruthy()
    expect(screen.queryByText('Add a listener')).toBeNull()
    // What is there is still readable: its choice, its folder and its address.
    const dialog = open('Support form')
    expect(dialog.queryByRole('radio')).toBeNull()
    expect(dialog.queryByRole('textbox')).toBeNull()
    expect(dialog.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(dialog.queryByRole('button', { name: /^New secret/ })).toBeNull()
    expect(dialog.getByText('Watch')).toBeTruthy()
    expect(dialog.getByText('https://hub.test/webhooks/in/main/l1')).toBeTruthy()
  })

  it('adds an address to post to, guided, and shows its secret once, with a command to paste, and not again once dismissed', async () => {
    const sent = listenHub([])
    await mount(<Settings />)
    await screen.findByText(/No listeners yet/)
    const add = await adding(/An address to post to/)
    expect(add.getByText(/It starts in Watch/)).toBeTruthy()
    fireEvent.change(add.getByLabelText('Name'), { target: { value: 'Alerts' } })
    fireEvent.click(add.getByRole('button', { name: 'Create' }))
    const block = await screen.findByRole('region', { name: 'The secret for Alerts' })
    expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ kind: 'post', name: 'Alerts', binderId: 'b1', folder: 'Inbox' })
    expect(within(block).getAllByText('bnl_first_secret').length).toBeGreaterThan(0)
    expect(within(block).getByText(/It won’t be shown again/)).toBeTruthy()
    expect(block.textContent).toContain('curl -X POST "https://hub.test/webhooks/in/main/l9" -H "Authorization: Bearer bnl_first_secret" -H "Content-Type: application/json" -d \'{"title":"Hello","text":"Sent from my script"}\'')
    expect(block.textContent).toContain('?key=bnl_first_secret')
    expect(within(block).getByRole('button', { name: 'Copy the secret' })).toBeTruthy()
    // The listener is in the list, in Watch.
    expect(row('Alerts').textContent).toContain('Watch')
    fireEvent.click(screen.getByRole('button', { name: 'I’ve copied it' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: /secret/ })).toBeNull())
    expect(document.body.textContent).not.toContain('bnl_first_secret')
    // Nowhere else: not in the browser's storage or the address.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('bnl_first_secret')
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('bnl_first_secret')
    expect(window.location.href).not.toContain('bnl_first_secret')
  })

  it('keeps a new secret on the page, unmissable, if its dialog is closed before it is dismissed', async () => {
    listenHub([])
    await mount(<Settings />)
    await screen.findByText(/No listeners yet/)
    const add = await adding(/An address to post to/)
    fireEvent.change(add.getByLabelText('Name'), { target: { value: 'Alerts' } })
    fireEvent.click(add.getByRole('button', { name: 'Create' }))
    await screen.findByRole('region', { name: 'The secret for Alerts' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const block = screen.getByRole('region', { name: 'The secret for Alerts' })
    expect(block.textContent).toContain('bnl_first_secret')
    fireEvent.click(screen.getByRole('button', { name: 'I’ve copied it' }))
    expect(screen.queryByRole('region', { name: /secret/ })).toBeNull()
  })

  it('makes a new secret after asking, and shows that one once', async () => {
    const sent = listenHub([post])
    await mount(<Settings />)
    await screen.findByText('Support form')
    const dialog = open('Support form')
    fireEvent.click(dialog.getByRole('button', { name: 'New secret for Support form' }))
    expect(sent.some((s) => s.path.endsWith('/secret'))).toBe(false)
    fireEvent.click(dialog.getByRole('button', { name: /The old one stops/ }))
    const block = await screen.findByRole('region', { name: 'The secret for Support form' })
    expect(block.textContent).toContain('Bearer bnl_second_secret')
    expect(block.textContent).toContain('https://hub.test/webhooks/in/main/l1')
  })

  it('asks for a feed’s address, and sends it with the feed', async () => {
    const sent = listenHub([])
    await mount(<Settings />)
    await screen.findByText(/No listeners yet/)
    const add = await adding(/A feed the hub reads/)
    fireEvent.change(add.getByLabelText('Name'), { target: { value: 'News' } })
    expect((add.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(add.getByLabelText('Feed address'), { target: { value: 'https://example.com/rss' } })
    fireEvent.click(add.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ kind: 'feed', name: 'News', binderId: 'b1', folder: 'Inbox', url: 'https://example.com/rss' }))
    // A feed has no secret to show: its dialog is done.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('region', { name: /secret/ })).toBeNull()
  })

  it('asks which binder its notes go in only when there is more than one', async () => {
    listenHub([], true, [{ id: 'b1', name: 'Server' }, { id: 'b2', name: 'Docs' }])
    await mount(<Settings />)
    await screen.findByText(/No listeners yet/)
    expect((await adding(/An address to post to/)).getByLabelText('The binder its notes go in')).toBeTruthy()
    cleanup()
    listenHub([])
    await mount(<Settings />)
    await screen.findByText(/No listeners yet/)
    expect((await adding(/An address to post to/)).queryByLabelText('The binder its notes go in')).toBeNull()
  })

  it('shows why a feed can’t be read as a warning, and its address and how often it is read', async () => {
    listenHub([{ ...feed, failing: 'example.com didn’t answer.' }])
    await mount(<Settings />)
    await screen.findByText('Release notes')
    expect(row('Release notes').textContent).toContain('Can’t read it')
    const dialog = open('Release notes')
    const warning = dialog.getByText('example.com didn’t answer.')
    expect(warning.closest('[role="status"]')?.className).toContain('setup-warning')
    expect((dialog.getByLabelText('Feed address') as HTMLInputElement).value).toBe('https://example.com/feed.xml')
    expect((dialog.getByLabelText('Read it every (minutes)') as HTMLInputElement).value).toBe('30')
  })

  it('sends how often a feed is read when it is changed', async () => {
    const sent = listenHub([feed])
    await mount(<Settings />)
    await screen.findByText('Release notes')
    const box = open('Release notes').getByLabelText('Read it every (minutes)')
    fireEvent.change(box, { target: { value: '60' } })
    fireEvent.blur(box)
    await waitFor(() => expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ everyMinutes: 60 }))
  })

  it('removes a listener after asking', async () => {
    const sent = listenHub([post, feed])
    await mount(<Settings />)
    await screen.findByText('Support form')
    const dialog = open('Support form')
    fireEvent.click(dialog.getByRole('button', { name: 'Remove Support form' }))
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false)
    fireEvent.click(dialog.getByRole('button', { name: 'Remove it? Press again' }))
    await waitFor(() => expect(sent.find((s) => s.method === 'DELETE')?.path).toBe('/api/listen/l1'))
    await waitFor(() => expect(screen.queryByText('Support form')).toBeNull())
    expect(screen.getByText('Release notes')).toBeTruthy()
  })

  it('says there are none when there are none', async () => {
    listenHub([])
    await mount(<Settings />)
    expect(await screen.findByText(/No listeners yet/)).toBeTruthy()
  })

  it('finds nothing for axe to object to, with every kind of listener, and a secret showing', async () => {
    listenHub([post, { ...feed, failing: 'example.com didn’t answer.' }, github])
    await mount(<Settings />)
    await screen.findByText('Support form')
    const quiet = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }
    const list = await axe.run(document.body, quiet)
    expect(list.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
    const dialog = open('Support form')
    fireEvent.click(dialog.getByRole('button', { name: 'New secret for Support form' }))
    fireEvent.click(dialog.getByRole('button', { name: /The old one stops/ }))
    await screen.findByRole('region', { name: 'The secret for Support form' })
    const { violations } = await axe.run(screen.getByRole('dialog'), { rules: { ...quiet.rules } })
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
  })
})
