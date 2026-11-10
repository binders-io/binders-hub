// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hear, hubState, me, mount, standInHub } from './harness'
import { CameIn } from '../src/brain/rail/CameIn'
import type { Outcome } from '../src/data/listen'

// The Brain's rail: Came in, what listeners heard and what the hub did with each.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const row = (id: string, over: Partial<Outcome> = {}): Outcome => ({ id, listener: 'l1', listenerName: 'Support form', at: ago(5), title: `Thing ${id}`, strength: 'heard', did: 'noted', line: `Filed ${id} in Inbox.`, note: `n-${id}`, ...over })

/** The hub with `rows` in its feed. `undone` has the rows it was asked to take back; `feeds` is how many times the feed was asked for. */
function feedHub(rows: () => Outcome[], role = 'member', undo: (id: string) => Response | Outcome = (id) => row(id, { did: 'undone', note: undefined })) {
  standInHub(() => hubState(), { ...me, role })
  const undone: string[] = []
  const state = { feeds: 0 }
  const stand = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0]
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/api/listen/feed' && (init?.method ?? 'GET') === 'GET') { state.feeds++; return json({ rows: rows() }) }
    const taken = /^\/api\/listen\/feed\/(.+)\/undo$/.exec(path)
    if (taken && init?.method === 'POST') {
      undone.push(taken[1])
      const answer = undo(taken[1])
      return answer instanceof Response ? answer : json({ row: answer })
    }
    return stand(url, init)
  }))
  return { undone, state }
}
const item = (title: string) => within(screen.getByText(title).closest('li')!)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('Came in, on the Brain’s rail', () => {
  it('shows each row with its listener, its sender, its title, the hub’s line and when', async () => {
    feedHub(() => [row('r1', { sender: 'sam@example.com', title: 'Printer is on fire', line: 'Filed in Inbox as a note.' })])
    await mount(<CameIn />)
    const heading = await screen.findByRole('heading', { name: /Came in/ })
    expect(heading.textContent).toContain('1')
    const one = item('Printer is on fire')
    expect(one.getByText('Support form')).toBeTruthy()
    expect(one.getByText('sam@example.com')).toBeTruthy()
    expect(one.getByText('Filed in Inbox as a note.')).toBeTruthy()
    expect(one.getByText('5m ago')).toBeTruthy()
    // A note it made opens from its title.
    expect(one.getByRole('link', { name: 'Printer is on fire' }).getAttribute('href')).toBe('#/notes/n-r1')
    expect(one.queryByText('From outside')).toBeNull()
  })

  it('marks a row from outside', async () => {
    feedHub(() => [row('r1', { strength: 'outside' })])
    await mount(<CameIn />)
    expect((await screen.findAllByText('From outside')).length).toBe(1)
  })

  it('takes a row back when Undo is pressed, and shows the row as taken back', async () => {
    const { undone } = feedHub(() => [row('r1', { title: 'Printer is on fire' })], 'member', (id) => row(id, { title: 'Printer is on fire', did: 'undone', line: 'Taken back by @you.', note: undefined }))
    await mount(<CameIn />)
    await screen.findByText('Printer is on fire')
    fireEvent.click(item('Printer is on fire').getByRole('button', { name: 'Undo' }))
    await screen.findByText('Taken back by @you.')
    expect(undone).toEqual(['r1'])
    const one = item('Printer is on fire')
    expect(one.queryByRole('button')).toBeNull()
    expect(one.queryByRole('link')).toBeNull()
  })

  it('shows the hub’s words when it refuses to take a row back, and the row stays as it was', async () => {
    feedHub(() => [row('r1', { title: 'Printer is on fire' })], 'member', () => new Response(JSON.stringify({ error: 'That note has been changed since, so it stays.' }), { status: 409, headers: { 'content-type': 'application/json' } }))
    await mount(<CameIn />)
    await screen.findByText('Printer is on fire')
    fireEvent.click(item('Printer is on fire').getByRole('button', { name: 'Undo' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That note has been changed since, so it stays.')
    expect(item('Printer is on fire').getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('shows no Undo to a reader, and none on a row that made no note', async () => {
    feedHub(() => [row('r1', { title: 'Made' }), row('r2', { title: 'Would', did: 'would-note', note: undefined, line: 'Would file it in Inbox.' }), row('r3', { title: 'Held', did: 'held', note: undefined }), row('r4', { title: 'Gone', did: 'undone', note: undefined })], 'member')
    await mount(<CameIn />)
    await screen.findByText('Made')
    expect(screen.getAllByRole('button', { name: 'Undo' }).length).toBe(1)
    expect(item('Would').queryByRole('button')).toBeNull()
    expect(item('Held').queryByRole('button')).toBeNull()
    expect(item('Gone').queryByRole('button')).toBeNull()
    cleanup()
    feedHub(() => [row('r1', { title: 'Made' })], 'reader')
    await mount(<CameIn />)
    await screen.findByText('Made')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('shows the newest six, and up to thirty when asked', async () => {
    feedHub(() => Array.from({ length: 40 }, (_, i) => row(`r${i}`, { title: `Thing ${i}` })))
    await mount(<CameIn />)
    await screen.findByText('Thing 0')
    expect(document.querySelectorAll('.brain-came-row').length).toBe(6)
    expect(screen.getByRole('heading', { name: /Came in/ }).textContent).toContain('40')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(document.querySelectorAll('.brain-came-row').length).toBe(30)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('asks again when the hub says something was heard', async () => {
    let rows = [row('r1', { title: 'First' })]
    const { state } = feedHub(() => rows)
    await mount(<CameIn />)
    await screen.findByText('First')
    const asked = state.feeds
    rows = [row('r2', { title: 'Second' }), ...rows]
    await hear({ type: 'heard' })
    await screen.findByText('Second')
    expect(state.feeds).toBe(asked + 1)
    expect(screen.getByText('First')).toBeTruthy()
  })

  it('says nothing has come in, and points a person who runs the Binder to where to set one up', async () => {
    feedHub(() => [], 'owner')
    await mount(<CameIn />)
    expect(await screen.findByText(/Nothing has come in\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Settings → Listeners' }).getAttribute('href')).toBe('#/settings/listeners')
    expect(screen.getByRole('heading', { name: /Came in/ }).textContent).toContain('0')
  })

  it('gives a member the same line without the link', async () => {
    feedHub(() => [], 'member')
    await mount(<CameIn />)
    await screen.findByText(/Nothing has come in\./)
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
  })
})
