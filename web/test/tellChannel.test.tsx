// @vitest-environment jsdom
import axe from 'axe-core'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, standInHub } from './harness'
import { Flow } from '../src/screens/settings/Flow'
import { Toast } from '../src/components/Toast'

// Settings → How work flows → Tell a channel: one row that says where it posts, opening a dialog with one box for the
// address, a test, and stopping. The hub never sends the address back, so all the page knows is whether one is set, where
// it goes and how the last post went.

interface Status { set: boolean; host?: string; last?: { at: string; ok: boolean; answered: string }; retryAt?: string; mayManage?: boolean }
interface Sent { method: string; url: string; body?: Record<string, unknown> }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const address = 'https://hooks.slack.com/services/T0SECRET/B0SECRET/xyz'

/** The hub with a channel as `status` says, which changes as the page changes it. `answers` overrides what it says to a call. */
function hub(status: Status, answers: Record<string, () => Response> = {}) {
  standInHub()
  const now = { ...status }
  const sent: Sent[] = []
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/api/tell')) return stand(url, init)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ method, url, body })
    const own = answers[`${method} ${url}`]
    if (own) return own()
    if (method === 'PUT') {
      now.set = true
      now.host = new URL(body.url).host
      now.last = undefined
      return json(now)
    }
    if (method === 'DELETE') {
      now.set = false
      now.host = undefined
      now.last = undefined
      return json({ ok: true })
    }
    if (method === 'POST') return json({ ok: true, answered: 'It answered 200: ok.' })
    return json(now)
  }))
  return { sent, now }
}

const box = () => screen.getByLabelText(/Channel address/) as HTMLInputElement
/** Tell a channel's dialog, opened from its row. */
const openTell = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /No channel yet|Telling/ }))
  return within(screen.getByRole('dialog', { name: 'Tell a channel' }))
}
const refusals = () => {
  const said: string[] = []
  window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string }>).detail.message))
  return said
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Tell a channel, for an owner or an admin', () => {
  it('says what the address is, with the box’s name above it', async () => {
    hub({ set: false, mayManage: true })
    await mount(<Flow />)
    expect(await screen.findByRole('heading', { name: 'Tell a channel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /No channel yet/ }).textContent).toContain('Off')
    const dialog = await openTell()
    expect(dialog.getByText(/An incoming webhook from Slack, or any address that takes a JSON post/)).toBeTruthy()
    const input = box()
    // The name is in the label that holds the box, written before it.
    const label = input.closest('label')!
    expect(label.classList.contains('field')).toBe(true)
    expect(label.firstElementChild!.textContent).toBe('Channel address')
    expect(input.getAttribute('aria-describedby')).toBe('tell-hint')
    expect(document.getElementById('tell-hint')!.textContent).toMatch(/https:\/\//)
  })

  it('leaves Save off until there is something to save, and offers a test and stopping only once there’s a channel', async () => {
    hub({ set: false, mayManage: true })
    await mount(<Flow />)
    await openTell()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop telling it' })).toBeNull()
  })

  it('saves the address, clears the box, says it’s kept, and shows only where it goes', async () => {
    const { sent } = hub({ set: false, mayManage: true })
    await mount(<Flow />)
    await openTell()
    fireEvent.change(box(), { target: { value: address } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ url: address })
    expect(box().value).toBe('')
    expect(box().placeholder).toBe('Paste a new address to change it')
    expect(screen.getByText('hooks.slack.com')).toBeTruthy()
    expect(document.body.textContent).not.toContain('T0SECRET')
    expect((screen.getByRole('button', { name: 'Send a test' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('saves from the keyboard, with Enter in the box', async () => {
    const { sent } = hub({ set: false, mayManage: true })
    await mount(<Flow />)
    await openTell()
    fireEvent.change(box(), { target: { value: address } })
    fireEvent.submit(box().closest('form')!)
    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true))
  })

  it('says why in words when the hub won’t take the address, and keeps what was typed', async () => {
    const said = refusals()
    hub({ set: false, mayManage: true }, { 'PUT /api/tell': () => json({ error: 'The address has to start with https://, so what’s sent can’t be read on the way.' }, 422) })
    await mount(<><Flow /><Toast /></>)
    await openTell()
    fireEvent.change(box(), { target: { value: 'http://hooks.example.com/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(said.join(' ')).toMatch(/has to start with https:\/\//))
    expect(box().value).toBe('http://hooks.example.com/x')
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('sends a test and says what came of it, where a screen reader will hear it', async () => {
    const { sent } = hub({ set: true, host: 'hooks.slack.com', mayManage: true })
    await mount(<Flow />)
    await openTell()
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }))
    await screen.findByText(/The test arrived\. It answered 200: ok\./)
    expect(sent.some((s) => s.method === 'POST' && s.url === '/api/tell/test')).toBe(true)
    expect(screen.getByText(/The test arrived/).closest('[role="status"]')).toBeTruthy()
  })

  it('says when the test didn’t arrive, with what the address answered', async () => {
    hub({ set: true, host: 'hooks.slack.com', mayManage: true }, { 'POST /api/tell/test': () => json({ ok: false, answered: 'It answered 404: no_service.' }) })
    await mount(<Flow />)
    await openTell()
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }))
    const line = await screen.findByText(/The test didn’t arrive\. It answered 404: no_service\./)
    expect(line.classList.contains('problem')).toBe(true)
  })

  it('shows how the last post went, and when a failed one is tried again', async () => {
    const ago = new Date(Date.now() - 5 * 60_000).toISOString()
    hub({ set: true, host: 'hooks.slack.com', mayManage: true, last: { at: ago, ok: false, answered: 'It answered 500.' }, retryAt: new Date(Date.now() + 5 * 60_000).toISOString() })
    await mount(<Flow />)
    // The row says it in a word, and the line.
    expect((await screen.findByRole('button', { name: /Telling hooks\.slack\.com/ })).textContent).toContain('Failing')
    const line = (await openTell()).getByText(/The last post didn’t work 5m ago\. It answered 500\./)
    expect(line.classList.contains('problem')).toBe(true)
    expect(line.textContent).toMatch(/It tries again at .*; what’s waiting is posted then\./)
  })

  it('shows a post that worked as fine, not as a problem', async () => {
    hub({ set: true, host: 'hooks.slack.com', mayManage: true, last: { at: new Date(Date.now() - 2 * 3600_000).toISOString(), ok: true, answered: 'It answered 200: ok.' } })
    await mount(<Flow />)
    const line = (await openTell()).getByText(/The last post worked 2h ago\. It answered 200: ok\./)
    expect(line.classList.contains('problem')).toBe(false)
  })

  it('stops telling only after a second press, and then shows no address set', async () => {
    const { sent } = hub({ set: true, host: 'hooks.slack.com', mayManage: true })
    await mount(<Flow />)
    await openTell()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop telling it' }))
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Stop telling it? Press again' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(screen.queryByText('hooks.slack.com')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull()
    expect(screen.getByRole('button', { name: /No channel yet/ })).toBeTruthy()
  })

  it('has nothing for axe to object to', async () => {
    hub({ set: true, host: 'hooks.slack.com', mayManage: true, last: { at: new Date().toISOString(), ok: true, answered: 'It answered 200: ok.' } })
    await mount(<Flow />)
    await screen.findByRole('heading', { name: 'Tell a channel' })
    const quiet = { rules: { 'color-contrast': { enabled: false } } }
    const row = await axe.run(document.getElementById('tell-title')!.closest('section')!, quiet)
    expect(row.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
    await openTell()
    const { violations } = await axe.run(screen.getByRole('dialog'), quiet)
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
  })
})

describe('Tell a channel, for a member', () => {
  it('shows whether a channel is set, and no box, no buttons and never the address', async () => {
    hub({ set: true, host: 'hooks.slack.com', mayManage: false })
    await mount(<Flow />)
    expect(await screen.findByText('This binder tells a channel when something starts waiting.')).toBeTruthy()
    // A row with nothing to open.
    expect(screen.queryByRole('button', { name: /tells a channel/ })).toBeNull()
    expect(screen.queryByLabelText(/Channel address/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop telling it' })).toBeNull()
    expect(screen.queryByText('hooks.slack.com')).toBeNull()
  })

  it('says so when none is set', async () => {
    hub({ set: false, mayManage: false })
    await mount(<Flow />)
    expect(await screen.findByText('This binder doesn’t tell a channel.')).toBeTruthy()
  })
})

describe('Tell a channel, when the hub can’t say', () => {
  it('shows nothing', async () => {
    hub({ set: false }, { 'GET /api/tell': () => json({ error: 'No.' }, 500) })
    await mount(<Flow />)
    await screen.findByText('Schedules')
    expect(screen.queryByRole('heading', { name: 'Tell a channel' })).toBeNull()
  })
})
