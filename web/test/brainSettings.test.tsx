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

  /** A hub whose own server has a gateway on it, as a proxy to a cloud: what the panel was sent, and how the brain stands. */
  function gatewayHub(brain: Record<string, unknown> = { provider: 'off', summarize: true }) {
    const address = 'http://127.0.0.1:4000/v1'
    const chat = [...Array.from({ length: 30 }, (_, i) => `gpt-4.${i}`), 'gpt-5.1', 'gpt-5-mini', 'claude-sonnet-5']
    const server = { id: 'm3', name: 'hub-server', online: true, platform: 'linux x64', version: '0.15.0', seenAt: 'now', servers: [{ url: address, kind: 'openai', models: [], lists: 34, gateway: true }] }
    const gateways = [{ machine: 'm3', machineName: 'hub-server', url: address, models: { chat, embeddings: ['text-embedding-3-large'], transcription: [], speech: [] } }]
    const sent: { url: string; body?: { model?: string } }[] = []
    let now = brain
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as { model: string } : undefined
      if (method !== 'GET') sent.push({ url, body })
      if (url === '/api/brain') return json({ brain: now, admin: true })
      if (url === '/api/brain/machines') return json({ machines: [server], candidates: {}, gateways, latest: '0.15.0' })
      if (url === '/api/brain/gateway' && body?.model === 'gpt-5-mini') return new Response(JSON.stringify({ error: 'gpt-5-mini didn’t answer through hub-server. The server answered 404: no such deployment. Nothing was changed.' }), { status: 422, headers: { 'content-type': 'application/json' } })
      if (url === '/api/brain/gateway' && body) {
        now = { ...now, provider: 'machine', machine: 'm3', baseUrl: address, model: body.model, inUse: `${body.model}, through a gateway on hub-server`, ownJobs: ['chat'] }
        return json({ brain: now })
      }
      return json({})
    }))
    render(<BrainPanel />)
    return { sent, address }
  }

  it('says a machine with only a gateway has cloud models to choose from, and what the hub does with them', async () => {
    gatewayHub()
    const table = await screen.findByRole('table', { name: 'Your machines' })
    fireEvent.click(await within(table).findByRole('button', { name: 'Open hub-server' }))
    expect(within(table).getAllByRole('row')[1].textContent).toMatch(/^hub-serverA gateway to 34 cloud models, yours to chooseLinked/)
    const dialog = (await screen.findByRole('dialog', { name: 'hub-server' })) as HTMLElement
    expect(dialog.textContent).toContain('A gateway on :4000 to 34 cloud models. The hub never picks one itself: choose one under Models.')
  })

  it('offers a gateway’s cloud models under a job, found by typing; the one pressed is tried, and what came back is said', async () => {
    const { sent, address } = gatewayHub()
    fireEvent.click(await screen.findByRole('button', { name: /^The hub’s model: nothing yet/ }))
    const dialog = (await screen.findByRole('dialog', { name: 'The hub’s model' })) as HTMLElement
    const list = await within(dialog).findByRole('list', { name: 'Cloud models through a gateway' })
    const names = () => within(list).getAllByRole('listitem').map((item) => item.querySelector('b')!.textContent)
    expect(names()).toHaveLength(8)
    expect(dialog.textContent).toContain('33 cloud models, reached through hub-server.')
    expect(dialog.textContent).toContain('25 more: type to find one.')
    fireEvent.change(within(dialog).getByLabelText('Find a cloud model'), { target: { value: 'GPT-5' } })
    // What matches, then what's typed itself, as no model there has exactly that name.
    expect(names()).toEqual(['gpt-5.1', 'gpt-5-mini', 'GPT-5'])
    fireEvent.change(within(dialog).getByLabelText('Find a cloud model'), { target: { value: 'gpt-5.1' } })
    expect(names()).toEqual(['gpt-5.1'])
    fireEvent.change(within(dialog).getByLabelText('Find a cloud model'), { target: { value: 'gpt-5' } })

    // One the gateway lists and can't reach: said, and nothing in use.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use gpt-5-mini' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('gpt-5-mini didn’t answer through hub-server. The server answered 404: no such deployment. Nothing was changed.')
    expect(within(list).queryByText('In use')).toBeNull()

    // One that answers: in use, first in the list, and what was said before is gone.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use gpt-5.1' }))
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0].textContent).toBe('gpt-5.1hub-server · gateway on :4000 · runs in a cloudIn use'))
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByText('gpt-5.1, through a gateway on hub-server')).toBeTruthy()
    expect(sent).toEqual([
      { url: '/api/brain/gateway', body: { job: 'chat', machine: 'm3', url: address, model: 'gpt-5-mini' } },
      { url: '/api/brain/gateway', body: { job: 'chat', machine: 'm3', url: address, model: 'gpt-5.1' } },
    ])
    // A name the gateway doesn't list (a deployment's, say) can be tried as it's typed.
    fireEvent.change(within(dialog).getByLabelText('Find a cloud model'), { target: { value: 'my-deployment' } })
    expect(dialog.textContent).toContain('None of them has that in its name. If the gateway takes the name anyway, try it as typed.')
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['my-deploymenthub-server · gateway on :4000 · not in its list, tried as typedUse'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use my-deployment on hub-server, as typed' }))
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0].textContent).toContain('In use'))
    expect(sent.at(-1)).toEqual({ url: '/api/brain/gateway', body: { job: 'chat', machine: 'm3', url: address, model: 'my-deployment' } })
    fireEvent.change(within(dialog).getByLabelText('Find a cloud model'), { target: { value: 'two words' } })
    expect(dialog.textContent).toContain('None of them has that in its name.')
    expect(within(dialog).queryByRole('list', { name: 'Cloud models through a gateway' })).toBeNull()
    const { violations } = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
  })

  it('offers no cloud model while Local AI only is on, and says why; nor for the jobs that can’t be tried first', async () => {
    gatewayHub({ provider: 'off', summarize: true, localOnly: true })
    fireEvent.click(await screen.findByRole('button', { name: /^Finding by meaning: nothing yet/ }))
    const dialog = (await screen.findByRole('dialog', { name: 'Finding by meaning' })) as HTMLElement
    const use = (await within(dialog).findByRole('button', { name: 'Use text-embedding-3-large' })) as HTMLButtonElement
    expect(use.disabled).toBe(true)
    expect(dialog.textContent).toContain('Local AI only is on, so a cloud model can’t be used. Turn it off to choose one.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Reading answers out: nothing yet/ }))
    const speech = (await screen.findByRole('dialog', { name: 'Reading answers out' })) as HTMLElement
    expect(within(speech).queryByText('Through a gateway')).toBeNull()
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
