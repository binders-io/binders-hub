// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRunner } from '../../shared/work.ts'
import { Agents } from '../src/screens/Agents'
import { BrainPanel } from '../src/components/BrainPanel'
import { until } from '../src/components/AddMachine'
import App from '../src/App'
import { agent, entry, hear, hubState, me, mount, settle, standInHub, standInRoute } from './harness'

afterEach(() => {
  version = 1
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
  window.localStorage.clear()
})

const secret = 'bnj_thesecretofthisline'
const line = (expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()) => ({
  token: secret,
  expiresAt,
  command: { unix: `curl -fsSL https://hub.test/install | sh -s -- join ${secret}`, windows: `& ([scriptblock]::Create((irm https://hub.test/install.ps1))) join ${secret}` },
})

/** What the toasts said, so a test can tell that the line wasn't in one. */
function toasts() {
  const said: string[] = []
  window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string }>).detail.message))
  return said
}

/** The page with its stand-in hub, the dialog open once the line has come. */
async function opened(you: unknown = me, agents = [agent]) {
  standInHub(() => hubState({ agents }), you)
  const asked = standInRoute('POST', '/api/agents/join-line', () => line())
  await mount(<Agents />)
  fireEvent.click(screen.getByRole('button', { name: 'Add a machine' }))
  const dialog = (await screen.findByRole('dialog', { name: 'Add a machine' })) as HTMLElement
  await within(dialog).findByText(/Run this in the folder/)
  return { dialog, asked }
}

// Each is a later entry, as the hub numbers them: one that isn't newer than what the tab has is dropped.
let version = 1
const joins = (id: string, over: object = {}) => hear({ type: 'entries', entries: [entry(++version, { type: 'agent.put', agent: { ...agent, id, name: 'Claude Code on studio-mac', runsOn: 'studio-mac', runner: { ...defaultRunner, workspace: '/Users/ana/code/app' }, ...over } })] })

describe('the Agents page’s buttons', () => {
  it('leads with Add a machine, and keeps Set up an agent beside it, quieter, as Set one up by hand', async () => {
    standInHub()
    await mount(<Agents />)
    const main = screen.getByRole('button', { name: 'Add a machine' })
    const byHand = screen.getByRole('button', { name: 'Set one up by hand' })
    expect(main.className).toContain('primary')
    expect(byHand.className).not.toContain('primary')
    expect(byHand.parentElement).toBe(main.parentElement)
    expect(screen.queryByRole('button', { name: 'Set up an agent' })).toBeNull()
    fireEvent.click(byHand)
    expect(await screen.findByRole('dialog', { name: 'Set up an agent' })).toBeTruthy()
  })

  it('leads, with no agents yet, with Add a machine and one sentence on what it does', async () => {
    standInHub(() => hubState({ agents: [] }))
    await mount(<Agents />)
    const empty = document.querySelector('.empty-screen') as HTMLElement
    expect(within(empty).getByText('No agents yet')).toBeTruthy()
    expect(empty.querySelectorAll('p').length).toBe(1)
    expect(empty.querySelector('p')!.textContent).toMatch(/^Add a machine: one line, run in the folder with the code/)
    const add = within(empty).getByRole('button', { name: 'Add a machine' })
    fireEvent.click(add)
    expect(await screen.findByRole('dialog', { name: 'Add a machine' })).toBeTruthy()
  })

  it('has Home’s empty state send people to Add a machine, on the Agents page', async () => {
    standInHub(() => hubState({ agents: [], cards: [] }))
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(200)
    // The sidebar says the same, with no agents: both lead to the Agents page.
    const links = await screen.findAllByRole('link', { name: 'Add a machine' })
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['#/agents', '#/agents'])
    const link = links.find((l) => l.closest('.home-empty'))!
    expect(link.closest('.home-empty')!.textContent).toMatch(/^No agents yet\. Add a machine: one line/)
  })
})

describe('the line', () => {
  it('is asked of the hub once, as the dialog opens, and shown with the two sentences', async () => {
    const { dialog, asked } = await opened()
    expect(asked).toEqual([undefined])
    expect(within(dialog).getByText('Run this in the folder with the code, on each machine. It works for a day.')).toBeTruthy()
    expect(within(dialog).getByText(/^Anyone with this line can add a machine as you until tomorrow at /)).toBeTruthy()
    expect(dialog.querySelector('.command pre')!.textContent).toBe(line().command.unix)
  })

  it('copies the line from a button with a name, and says so politely', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const { dialog } = await opened()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy the line' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(line().command.unix))
    await waitFor(() => expect(within(dialog).getAllByRole('status').map((s) => s.textContent).join(' ')).toContain('Copied.'))
  })

  it('says so in a toast when the browser won’t copy, without the line in it', async () => {
    Object.assign(navigator, { clipboard: { writeText: async () => { throw new Error('denied') } } })
    const said = toasts()
    const { dialog } = await opened()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy the line' }))
    await waitFor(() => expect(said).toEqual(['Couldn’t copy it: select it and copy it yourself.']))
  })

  it('switches between macOS or Linux and Windows', async () => {
    const { dialog } = await opened()
    const group = within(dialog).getByRole('radiogroup', { name: 'What it runs on' })
    expect(within(group).getByRole('radio', { name: 'macOS or Linux' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('radio', { name: 'Windows' }))
    expect(dialog.querySelector('.command pre')!.textContent).toBe(line().command.windows)
    expect(within(group).getByRole('radio', { name: 'Windows' }).getAttribute('aria-checked')).toBe('true')
  })

  it('starts on Windows when the browser is on Windows', async () => {
    const was = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true })
    try {
      const { dialog } = await opened()
      expect(dialog.querySelector('.command pre')!.textContent).toBe(line().command.windows)
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: was, configurable: true })
    }
  })

  it('keeps the secret out of the address, the browser’s storage and the toasts', async () => {
    const said = toasts()
    const { dialog } = await opened()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy the line' }))
    await settle(50)
    expect(window.location.href).not.toContain(secret)
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(secret)
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(secret)
    expect(said.join(' ')).not.toContain(secret)
    expect([...document.querySelectorAll('a')].some((a) => a.getAttribute('href')?.includes(secret))).toBe(false)
  })

  it('says when it runs out in words, from the hub’s own time', () => {
    const now = new Date(2026, 10, 9, 10, 0)
    const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const tomorrow = new Date(2026, 10, 10, 14, 30)
    expect(until(tomorrow.toISOString(), now)).toBe(`tomorrow at ${time(tomorrow)}`)
    const later = new Date(2026, 10, 9, 23, 0)
    expect(until(later.toISOString(), now)).toBe(`today at ${time(later)}`)
    const week = new Date(2026, 10, 13, 9, 5)
    expect(until(week.toISOString(), now)).toBe(`${week.toLocaleDateString([], { weekday: 'long' })} at ${time(week)}`)
    expect(until('nonsense', now)).toBe('')
  })

  it('says why in the hub’s own words when it can’t add machines, and asks again when told to', async () => {
    standInHub()
    let answers = 0
    standInRoute('POST', '/api/agents/join-line', () => (++answers === 1 ? new Response(JSON.stringify({ error: 'This hub can’t add machines: its address isn’t public.' }), { status: 422, headers: { 'content-type': 'application/json' } }) : line()))
    await mount(<Agents />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a machine' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Add a machine' })) as HTMLElement
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This hub can’t add machines: its address isn’t public.')
    expect(within(dialog).queryByRole('button', { name: 'Copy the line' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(await within(dialog).findByRole('button', { name: 'Copy the line' })).toBeTruthy()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(answers).toBe(2)
  })

  it('says a hub that can’t be reached in plain words', async () => {
    standInHub()
    standInRoute('POST', '/api/agents/join-line', () => { throw new TypeError('Failed to fetch') })
    await mount(<Agents />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a machine' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t reach the hub. Try again in a moment.')
  })
})

describe('machines that joined', () => {
  it('starts empty, waiting for one, with none of the agents there already', async () => {
    const { dialog } = await opened()
    const joined = within(dialog).getByRole('region', { name: 'Machines that joined' })
    expect(within(joined).getByText('Waiting for one to run it…')).toBeTruthy()
    expect(within(joined).queryByRole('list')).toBeNull()
    expect(within(joined).queryByText('Agent')).toBeNull()
  })

  it('shows an agent of yours that appears, with where it works, and when it’s listening', async () => {
    const { dialog } = await opened()
    await joins('a2')
    const joined = within(dialog).getByRole('region', { name: 'Machines that joined' })
    const row = within(joined).getByRole('listitem')
    expect(within(row).getByText('Claude Code on studio-mac')).toBeTruthy()
    expect(row.textContent).toContain('Works in /Users/ana/code/app')
    expect(row.textContent).toContain('Not listening yet')
    expect(within(joined).queryByText('Waiting for one to run it…')).toBeNull()
    await hear({ type: 'presence', presence: { a2: { at: new Date().toISOString(), listening: true } } })
    expect(row.textContent).toContain('Listening')
    expect(row.textContent).not.toContain('Not listening yet')
  })

  it('names the machine when the hub gave no folder', async () => {
    const { dialog } = await opened()
    await joins('a2', { runner: defaultRunner })
    expect(within(dialog).getByRole('listitem').textContent).toContain('On studio-mac')
  })

  it('leaves out another person’s agent, a revoked one and one that was already there', async () => {
    const { dialog } = await opened()
    await joins('a3', { owner: 'someone-else', name: 'Theirs' })
    await joins('a4', { revoked: true, name: 'Revoked' })
    await hear({ type: 'entries', entries: [entry(++version, { type: 'agent.put', agent: { ...agent, name: 'Agent, renamed' } })] })
    expect(within(dialog).queryByRole('listitem')).toBeNull()
    expect(within(dialog).getByText('Waiting for one to run it…')).toBeTruthy()
  })

  it('says it to a screen reader, politely, as it joins and as it starts listening', async () => {
    const { dialog } = await opened()
    const live = dialog.querySelector('p.sr-only[role="status"]') as HTMLElement
    expect(live.textContent).toBe('')
    await joins('a2')
    expect(live.textContent).toBe('Claude Code on studio-mac joined, and isn’t listening yet.')
    await hear({ type: 'presence', presence: { a2: { at: new Date().toISOString(), listening: true } } })
    expect(live.textContent).toBe('Claude Code on studio-mac joined and is listening for work.')
    await joins('a5', { name: 'Codex on pi' })
    expect(live.textContent).toMatch(/^2 machines joined\. Codex on pi joined/)
    // role=status is a polite live region.
    expect(live.getAttribute('aria-live')).toBeNull()
  })

  it('doesn’t list machines when the dialog is opened again, until one joins', async () => {
    const { dialog } = await opened()
    await joins('a2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a machine' })).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a machine' })[0])
    const again = (await screen.findByRole('dialog', { name: 'Add a machine' })) as HTMLElement
    expect(within(again).queryByRole('listitem')).toBeNull()
  })
})

describe('closing it', () => {
  it('stays open for a tap outside or Escape, and closes from Done or Close', async () => {
    const { dialog } = await opened()
    fireEvent.click(document.querySelector('.scrim') as HTMLElement)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Add a machine' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a machine' })).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a machine' })[0])
    const again = (await screen.findByRole('dialog', { name: 'Add a machine' })) as HTMLElement
    fireEvent.click(within(again).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a machine' })).toBeNull())
  })

  it('has every control a button, so Tab reaches it, and Done last', async () => {
    const { dialog } = await opened()
    const controls = [...dialog.querySelectorAll('button')]
    expect(controls.every((b) => b.tabIndex >= 0 && !b.disabled)).toBe(true)
    expect(controls.at(-1)!.textContent).toBe('Done')
    for (const icon of dialog.querySelectorAll('button.icon-button')) expect(icon.getAttribute('aria-label')).toBeTruthy()
  })
})

describe('for a hub admin', () => {
  it('says that each machine’s models are lent to the hub’s brain too', async () => {
    const { dialog } = await opened({ ...me, hubAdmin: true })
    expect(within(dialog).getByText('You’re a hub admin, so each machine’s models are lent to the hub’s brain too.')).toBeTruthy()
  })

  it('says nothing of models to anyone else', async () => {
    const { dialog } = await opened()
    expect(dialog.textContent).not.toMatch(/model|brain/i)
  })
})

describe('Settings → Brain → Your machines', () => {
  it('keeps its own line, and says a machine with code is better added from the Agents page, as a link', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/brain') return json({ brain: {}, admin: true })
      if (url === '/api/brain/machines') return json({ machines: [] })
      return json({})
    }))
    render(<BrainPanel />)
    expect(await screen.findByRole('button', { name: 'Add your machines' })).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Agents page' })
    expect(link.getAttribute('href')).toBe('#/agents')
    expect(link.parentElement!.textContent).toMatch(/^A machine with code on it is better added from the Agents page/)
  })
})

describe('the page’s rules', () => {
  it('has a quiet button in the header, smaller than the main one', () => {
    const css = readFileSync(resolve(__dirname, '../src/app.css'), 'utf8')
    expect(css).toMatch(/\.head-actions \.button\.quiet \{[^}]*height: 28px/)
  })
})
