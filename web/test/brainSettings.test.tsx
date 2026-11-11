// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrainPanel } from '../src/components/BrainPanel'
import { HubOptionsPanel } from '../src/components/HubOptionsPanel'
import { me, mount, standInHub } from './harness'

// Settings → Brain, Agents and Who gets in: sections of rows, each saying how it stands, pressed (by an admin) to change it
// in a dialog; switches for what's on or off; everyone else sees the same rows as they are.

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const machines = [
  { id: 'm1', name: 'Studio Mac', online: true, platform: 'macOS 26', version: '0.15.0', seenAt: 'now', servers: [{ url: 'http://127.0.0.1:11434/v1', kind: 'ollama', models: ['qwen3:32b', 'nomic-embed-text'] }] },
  { id: 'm2', name: 'Office laptop', online: false, seenAt: 'then', servers: [] },
]
const candidates = { chat: [{ machine: 'm1', machineName: 'Studio Mac', url: 'http://127.0.0.1:11434/v1', model: 'qwen3:32b', kind: 'ollama', state: 'running' }] }

/** Settings → Brain with a stand-in hub: what it was sent, by method and address. */
function brainHub(admin = true, brain: object = { provider: 'machine', summarize: true, inUse: 'gpt-oss on DGX Spark', autoJobs: ['chat'] }) {
  const sent: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET') sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/brain' && method === 'GET') return json({ brain, admin, index: { sources: 3, passages: 12, withVectors: 0 } })
    if (url === '/api/brain' && method === 'PATCH') return json({ brain: { ...brain, ...(init?.body ? JSON.parse(String(init.body)) : {}) } })
    if (url === '/api/brain/machines') return json({ machines, candidates, latest: '0.15.0' })
    return json({})
  }))
  render(<BrainPanel />)
  return sent
}

describe('Settings → Brain', () => {
  it('lists your machines as a table, each saying what it serves and whether it’s linked, and opens one to remove it', async () => {
    const sent = brainHub()
    const table = await screen.findByRole('table', { name: 'Your machines' })
    await within(table).findByRole('button', { name: 'Open Studio Mac' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^Studio Mac2 modelsLinked/), expect.stringMatching(/^Office laptopNo models the hub can use yetAway/)])
    fireEvent.click(within(table).getByRole('button', { name: 'Open Studio Mac' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Studio Mac' })) as HTMLElement
    expect(dialog.textContent).toContain('Ollama on :11434 · 2 models')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(sent).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove it? Press again' }))
    await waitFor(() => expect(sent).toEqual([{ method: 'DELETE', url: '/api/brain/machines/m1', body: undefined }]))
  })

  it('has a row a job, saying what it uses and who chose it, that opens its choices; Use makes one the job’s', async () => {
    const sent = brainHub()
    const row = await screen.findByRole('button', { name: 'The hub’s model: gpt-oss on DGX Spark. Change it' })
    expect(row.textContent).toContain('Chosen for you')
    expect(screen.getByRole('button', { name: /^Finding by meaning: nothing yet/ }).textContent).toContain('None: passages are found by their words')
    fireEvent.click(row)
    const dialog = (await screen.findByRole('dialog', { name: 'The hub’s model' })) as HTMLElement
    expect(within(dialog).getByText('On your machines')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(sent).toEqual([{ method: 'PATCH', url: '/api/brain', body: { provider: 'machine', machine: 'm1', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:32b' } }]))
    // A server by its address is there too, behind its own line.
    expect(within(dialog).getByText('Use Claude, or a server by its address')).toBeTruthy()
  })

  it('turns what it does on and off with switches on rows, each saved as it’s pressed', async () => {
    const sent = brainHub()
    const summing = (await screen.findByRole('switch', { name: 'Sum up conversations and meetings' })) as HTMLInputElement
    expect(summing.checked).toBe(true)
    fireEvent.click(summing)
    await waitFor(() => expect(sent).toEqual([{ method: 'PATCH', url: '/api/brain', body: { summarize: false } }]))
    fireEvent.click(screen.getByRole('switch', { name: 'Local AI only' }))
    await waitFor(() => expect(sent.at(-1)).toEqual({ method: 'PATCH', url: '/api/brain', body: { localOnly: true } }))
  })

  it('shows anyone but an admin the same rows, saying what’s in use, with nothing to press or switch', async () => {
    brainHub(false)
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('gpt-oss on DGX Spark')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Change it/ })).toBeNull()
    expect(screen.getAllByRole('switch').every((s) => (s as HTMLInputElement).disabled)).toBe(true)
  })

  it('has no disclosure inside a disclosure', async () => {
    brainHub()
    await screen.findByRole('table', { name: 'Your machines' })
    expect(document.querySelector('details details')).toBeNull()
  })

  it('says it couldn’t load, with Try again', async () => {
    let tries = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/brain' && ++tries === 1) throw new TypeError('Failed to fetch')
      if (url === '/api/brain') return json({ brain: { provider: 'off', summarize: false }, admin: false })
      return json({})
    }))
    render(<BrainPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
  })

  it('finds nothing for axe to object to, loaded', async () => {
    brainHub()
    await screen.findByRole('button', { name: 'Open Studio Mac' })
    const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
  })
})

describe('Settings → Who gets in', () => {
  const options = { mergeMethod: 'merge', allowedUsers: ['ana', 'sam', 'lee'], allowedOrgs: [], admins: ['ana'], agentCommits: 'agent' }
  const optionsHub = async (hubAdmin: boolean) => {
    standInHub(undefined, { ...me, hubAdmin })
    const hub = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/options') return json({ options, locked: {}, implied: { admins: ['maker'], allowedUsers: [], allowedOrgs: [] } })
      return hub(url, init)
    }))
    await mount(<HubOptionsPanel part="access" />)
  }

  it('says who may sign in and who runs the hub as rows, each opening a dialog to change them', async () => {
    await optionsHub(true)
    expect(await screen.findByRole('heading', { name: 'Who may sign in' })).toBeTruthy()
    const people = screen.getByRole('button', { name: 'People who may sign in. Change them' })
    expect(people.textContent).toContain('@ana, @sam and 1 more')
    expect(screen.getByRole('button', { name: 'The hub’s admins. Change them' }).textContent).toContain('@ana, and @maker through GitHub')
    fireEvent.click(people)
    const dialog = (await screen.findByRole('dialog', { name: 'People who may sign in' })) as HTMLElement
    expect(within(dialog).getByText('@ana')).toBeTruthy()
  })

  it('shows them to anyone else as they are, with who can change them', async () => {
    await optionsHub(false)
    expect(await screen.findByText('Only the hub’s admins can change these.')).toBeTruthy()
    expect(screen.getByText('People').closest('.rows-item')!.textContent).toContain('@ana, @sam and 1 more')
    expect(screen.queryByRole('button', { name: /Change them/ })).toBeNull()
  })
})
