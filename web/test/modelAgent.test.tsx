// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../src/data/model'
import { Agents } from '../src/screens/Agents'
import { Home } from '../src/screens/Home'
import { AgentsNow } from '../src/brain/rail/AgentsNow'
import { UIContext, type UI } from '../src/ui'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { agent, hubState, me, mount, standInHub, standInRoute } from './harness'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
  window.localStorage.clear()
})

const owner = { ...me, role: 'owner' }
const member = { ...me, role: 'member' }

const takesAll = { cards: true, chats: true, debriefs: true, challenges: true }
const azure: Agent = {
  ...agent, id: 'm1', name: 'Azure assistant', provider: 'other', runsOn: 'This hub',
  endpoint: { kind: 'openai', baseUrl: 'https://your-resource.openai.azure.com/openai/v1', model: 'gpt-deploy', takes: takesAll, ready: { ok: true, at: 'now' } },
}
const broken: Agent = { ...azure, id: 'm2', name: 'Broken one', endpoint: { ...azure.endpoint!, ready: { ok: false, why: 'The key was refused: it is wrong or has run out.', at: 'now' } } }

/** Add an agent's first step, its choice of what kind. */
async function choosing() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add an agent' })[0])
  return (await screen.findByRole('dialog', { name: 'Add an agent' })) as HTMLElement
}

/** The page and the step of Add an agent that adds a model, as the Binder's owner. */
async function opened(you: unknown = owner, agents: Agent[] = []) {
  standInHub(() => hubState({ agents }), you)
  await mount(<Agents />)
  const dialog = await choosing()
  fireEvent.click(within(dialog).getByRole('button', { name: /A model, with no machine/ }))
  await within(dialog).findByRole('heading', { name: 'Which model?' })
  return dialog
}

/** The rare actions of an agent's card, in its menu. */
async function menuOf(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `More for ${name}` }))
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
}

const pick = (dialog: HTMLElement, name: RegExp) => fireEvent.click(within(dialog).getByRole('radio', { name }))
const type = (dialog: HTMLElement, label: RegExp, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })

describe('adding a model with no machine', () => {
  it('is offered to a Binder’s owner, and a member is told who can add one', async () => {
    standInHub(undefined, owner)
    await mount(<Agents />)
    const offered = within(await choosing()).getByRole('button', { name: /A model, with no machine/ }) as HTMLButtonElement
    expect(offered.disabled).toBe(false)
    expect(offered.textContent).toContain('It can’t read or change code.')
    cleanup()
    standInHub(undefined, member)
    await mount(<Agents />)
    const refused = within(await choosing()).getByRole('button', { name: /A model, with no machine/ }) as HTMLButtonElement
    expect(refused.disabled).toBe(true)
    expect(refused.textContent).toMatch(/Only this binder’s owners and admins can add one/)
  })

  it('shows each kind’s own fields and no others', async () => {
    const dialog = await opened()
    const has = (label: RegExp) => !!within(dialog).queryByLabelText(label)
    // The hub's own model has nothing to fill in but a name and what it takes.
    expect(within(dialog).getByRole('radio', { name: /The hub’s own model/ }).getAttribute('aria-checked')).toBe('true')
    expect([has(/^Address/), has(/^Model or deployment/), has(/^Key/)]).toEqual([false, false, false])
    expect(has(/^Name/)).toBe(true)
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4)

    pick(dialog, /OpenAI’s chat API/)
    expect([has(/^Address/), has(/^Model or deployment/), has(/^Key/)]).toEqual([true, true, true])
    expect(within(dialog).queryByLabelText(/\(optional\)/)).toBeNull()
    expect((within(dialog).getByLabelText(/^Address/) as HTMLInputElement).placeholder).toBe('https://your-resource.openai.azure.com/openai/v1')

    pick(dialog, /Claude, by Anthropic/)
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).placeholder).toBe('claude-opus-5-5')
    expect(has(/^Key/)).toBe(true)
    const optional = within(dialog).getByLabelText(/^Address \(optional\)/) as HTMLInputElement
    expect(optional.placeholder).toBe('https://your-resource.services.ai.azure.com/anthropic')

    pick(dialog, /The hub’s own model/)
    expect([has(/^Address/), has(/^Model or deployment/), has(/^Key/)]).toEqual([false, false, false])
  })

  it('keeps the key hidden as typed and out of the browser’s help', async () => {
    const dialog = await opened()
    pick(dialog, /OpenAI’s chat API/)
    const key = within(dialog).getByLabelText(/^Key/) as HTMLInputElement
    expect(key.type).toBe('password')
    expect(key.getAttribute('autocomplete')).toBe('off')
  })

  it('shows the hub’s yes from Try it, and sends nothing but the model’s fields', async () => {
    const dialog = await opened()
    const tried = standInRoute('POST', '/api/agents/endpoint/test', () => ({ ok: true }))
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Address/, 'https://r.openai.azure.com/openai/v1')
    type(dialog, /^Model or deployment/, 'gpt-deploy')
    type(dialog, /^Key/, 'typed-key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    expect(await within(dialog).findByText('It answers and calls tools.')).toBeTruthy()
    expect(tried).toEqual([{ kind: 'openai', baseUrl: 'https://r.openai.azure.com/openai/v1', model: 'gpt-deploy', key: 'typed-key' }])
  })

  it('shows the hub’s reason from Try it when the model doesn’t work', async () => {
    const dialog = await opened()
    standInRoute('POST', '/api/agents/endpoint/test', () => ({ ok: false, why: 'It answered, but never called a tool.' }))
    pick(dialog, /Claude, by Anthropic/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('It answered, but never called a tool.')
    expect(within(dialog).queryByText('It answers and calls tools.')).toBeNull()
  })

  it('disables the buttons while it is working', async () => {
    const dialog = await opened()
    let finish: (body: unknown) => void = () => {}
    standInRoute('POST', '/api/agents/endpoint/test', () => new Promise((done) => { finish = done }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(true))
    expect((within(dialog).getByRole('button', { name: 'Add it' }) as HTMLButtonElement).disabled).toBe(true)
    finish({ ok: true })
    await within(dialog).findByText('It answers and calls tools.')
    expect((within(dialog).getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('posts what was filled in for a server that speaks OpenAI’s API, then clears the key', async () => {
    const dialog = await opened()
    const added = standInRoute('POST', '/api/agents/endpoint', () => ({ agent: azure }))
    type(dialog, /^Name/, 'Azure assistant')
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Address/, 'https://your-resource.openai.azure.com/openai/v1')
    type(dialog, /^Model or deployment/, 'gpt-deploy')
    type(dialog, /^Key/, 'typed-key')
    fireEvent.click(within(dialog).getByLabelText('Debriefs'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add it' }))
    expect(await within(dialog).findByText(/Azure assistant is added/)).toBeTruthy()
    expect(added).toEqual([{ name: 'Azure assistant', kind: 'openai', baseUrl: 'https://your-resource.openai.azure.com/openai/v1', model: 'gpt-deploy', key: 'typed-key', takes: { ...takesAll, debriefs: false } }])
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('')
    // The key was in the body of the call alone: not in an address, the browser's storage or the page's words.
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('typed-key'))).toBe(true)
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('typed-key')
    expect(document.body.textContent).not.toContain('typed-key')
  })

  it('posts a Claude agent with its model and key, and an address only when one was typed', async () => {
    const dialog = await opened()
    const added = standInRoute('POST', '/api/agents/endpoint', () => ({ agent: { ...azure, name: 'Claude', endpoint: { ...azure.endpoint!, kind: 'anthropic', baseUrl: undefined, model: 'claude-opus-5-5' } } }))
    type(dialog, /^Name/, 'Claude')
    pick(dialog, /Claude, by Anthropic/)
    type(dialog, /^Model or deployment/, 'claude-opus-5-5')
    type(dialog, /^Key/, 'typed-key-1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add it' }))
    await within(dialog).findByText(/Claude is added/)
    expect(added).toEqual([{ name: 'Claude', kind: 'anthropic', model: 'claude-opus-5-5', key: 'typed-key-1', takes: takesAll }])
  })

  it('posts the hub’s own model with no address, model or key', async () => {
    const dialog = await opened()
    const added = standInRoute('POST', '/api/agents/endpoint', () => ({ agent: { ...azure, name: 'The hub', endpoint: { kind: 'brain', takes: takesAll, ready: { ok: true, at: 'now' } } } }))
    type(dialog, /^Name/, 'The hub')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add it' }))
    await within(dialog).findByText(/The hub is added/)
    expect(added).toEqual([{ name: 'The hub', kind: 'brain', takes: takesAll }])
  })

  it('says plainly when the agent was made but isn’t ready, and why', async () => {
    const dialog = await opened()
    standInRoute('POST', '/api/agents/endpoint', () => ({ agent: broken }))
    type(dialog, /^Name/, 'Broken one')
    pick(dialog, /OpenAI’s chat API/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add it' }))
    expect((await within(dialog).findByText(/Broken one is added, but it isn’t ready: The key was refused/))).toBeTruthy()
  })

  it('shows a refusal in place, and keeps what was typed', async () => {
    const dialog = await opened()
    standInRoute('POST', '/api/agents/endpoint', () => new Response(JSON.stringify({ error: 'Only this Binder’s owners and admins add an agent that is a model.' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    type(dialog, /^Name/, 'Azure assistant')
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Key/, 'typed-key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add it' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Only this Binder’s owners and admins add an agent that is a model.')
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('typed-key')
    expect((within(dialog).getByRole('button', { name: 'Add it' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('an agent that is a model', () => {
  const boardWith = async (agents: Agent[], you: unknown = owner) => {
    standInHub(() => hubState({ agents }), you)
    await mount(<><Agents /><ContextMenuHost /></>)
  }

  it('reads ready, and “Runs on this hub” with its model and the host of its address', async () => {
    await boardWith([azure])
    const pieces = [...document.querySelectorAll('.agent-meta > .agent-piece')].map((p) => p.textContent)
    expect(pieces).toEqual(['Ready'])
    const where = [...document.querySelectorAll('.agent-where > span')].map((p) => p.textContent)
    expect(where).toEqual(['Runs on this hub', 'gpt-deploy at your-resource.openai.azure.com'])
    expect(document.querySelector('.agent-facts')!.textContent).toContain('Takes cards, chats, debriefs and challenges')
  })

  it('reads the model’s name at Anthropic when it has no address, and the hub’s own model plainly', async () => {
    const claude: Agent = { ...azure, id: 'm3', name: 'Claude', endpoint: { kind: 'anthropic', model: 'claude-opus-5-5', takes: takesAll } }
    const brain: Agent = { ...azure, id: 'm4', name: 'The hub', endpoint: { kind: 'brain', takes: takesAll } }
    await boardWith([claude, brain])
    const text = document.body.textContent ?? ''
    expect(text).toContain('claude-opus-5-5 at Anthropic')
    expect(text).toContain('The hub’s own model')
  })

  it('shows why one that isn’t ready isn’t, with a way for an owner to put it right', async () => {
    await boardWith([broken])
    expect(screen.getByText('The key was refused: it is wrong or has run out.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put it right' }))
    expect(await screen.findByRole('dialog', { name: 'Edit Broken one' })).toBeTruthy()
  })

  it('shows the reason to a member without the way to change it', async () => {
    await boardWith([broken], member)
    expect(screen.getByText('The key was refused: it is wrong or has run out.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Put it right' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('has no runner controls', async () => {
    await boardWith([azure])
    expect(screen.queryByText(/runner/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Start the runner|Update it now|Restart/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Terminal/ })).toBeNull()
    expect(screen.queryByText('Details')).toBeNull()
    // It can still be changed and revoked, and its menu has nothing else.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(await menuOf('Azure assistant')).toEqual(['Revoke'])
  })

  it('saves its edit with the PATCH address, and sends no key when the box is empty', async () => {
    await boardWith([azure])
    const saved = standInRoute('PATCH', '/api/agents/m1/endpoint', () => ({ agent: azure }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Edit Azure assistant' })) as HTMLElement
    expect(within(dialog).getByText(/Empty keeps the key that’s there/)).toBeTruthy()
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).value).toBe('gpt-deploy')
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('')
    type(dialog, /^Model or deployment/, 'gpt-deploy-2')
    fireEvent.click(within(dialog).getByLabelText('Challenges'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Azure assistant' })).toBeNull())
    expect(saved).toEqual([{ takes: { ...takesAll, challenges: false }, model: 'gpt-deploy-2', baseUrl: 'https://your-resource.openai.azure.com/openai/v1' }])
    expect('key' in (saved[0] as object)).toBe(false)
  })

  it('sends a new key when one is typed, then says so when it still isn’t ready', async () => {
    await boardWith([azure])
    const saved = standInRoute('PATCH', '/api/agents/m1/endpoint', () => ({ agent: broken }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Edit Azure assistant' })) as HTMLElement
    type(dialog, /^Key/, 'new-key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText(/still isn’t ready: The key was refused/)).toBeTruthy()
    expect((saved[0] as { key: string }).key).toBe('new-key')
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('')
  })

  it('shows a refusal of the edit in place', async () => {
    await boardWith([azure])
    standInRoute('PATCH', '/api/agents/m1/endpoint', () => new Response(JSON.stringify({ error: 'The address must end in /v1.' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Edit Azure assistant' })) as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('The address must end in /v1.')
  })

  it('has no address, model or key to edit for the hub’s own model', async () => {
    await boardWith([{ ...azure, name: 'The hub', endpoint: { kind: 'brain', takes: takesAll } }])
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Edit The hub' })) as HTMLElement
    expect(within(dialog).queryByLabelText(/^Key/)).toBeNull()
    expect(within(dialog).queryByLabelText(/^Model or deployment/)).toBeNull()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4)
  })
})

describe('an agent that is a model, elsewhere', () => {
  const ui: UI = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }

  it('reads on a Home tile as running on the hub, with no runner to start', async () => {
    standInHub(() => hubState({ agents: [azure, broken] }), owner)
    await mount(<UIContext.Provider value={ui}><Home /></UIContext.Provider>)
    // Neither holds a card, so each is a row under the agents at work, which opens the Agents page.
    const tile = screen.getByRole('link', { name: /^Azure assistant/ })
    expect(tile.textContent).toContain('Runs on this hub · gpt-deploy at your-resource.openai.azure.com')
    expect(tile.textContent).toContain('Ready')
    const sick = screen.getByRole('link', { name: /^Broken one/ })
    expect(sick.textContent).toContain('The key was refused: it is wrong or has run out.')
    expect(document.body.textContent).not.toMatch(/runner/i)
  })

  it('reads in the Brain’s agents rail as ready or needing attention, not online or offline', async () => {
    standInHub(() => hubState({ agents: [azure, broken] }), owner)
    await mount(<UIContext.Provider value={ui}><AgentsNow /></UIContext.Provider>)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Ready')
    expect(text).toContain('Needs attention')
    expect(text).not.toMatch(/Online|Offline/)
  })
})

describe('An address on a machine’s own network, in a form for a model the hub reaches', () => {
  it('is told apart from one out on the internet', async () => {
    const { looksLocal } = await import('../src/components/modelAgent')
    for (const address of ['http://127.0.0.1:8000', 'http://localhost:1234/v1', 'https://10.0.0.5/v1', 'http://192.168.1.20:11434', 'http://172.20.0.3:8000/v1', 'http://spark.local:8000']) expect(looksLocal(address), address).toBe(true)
    for (const address of ['https://your-resource.openai.azure.com/openai/v1', 'https://api.openai.com/v1', 'https://172.64.0.1/v1', '']) expect(looksLocal(address), address).toBe(false)
  })

  it('takes the range mesh VPNs use, 100.64.0.0 to 100.127.255.255, as the hub does', async () => {
    const { looksLocal } = await import('../src/components/modelAgent')
    for (const address of ['http://100.64.0.2:8899/v1', 'http://100.100.10.1:11434', 'https://100.127.255.255/v1']) expect(looksLocal(address), address).toBe(true)
    for (const address of ['http://100.63.255.255:8000', 'http://100.128.0.1:8000', 'https://100.1.2.3/v1']) expect(looksLocal(address), address).toBe(false)
  })

  it('takes a one-word host name as local, such as a container’s, and the names only a network has', async () => {
    const { looksLocal } = await import('../src/components/modelAgent')
    for (const address of ['http://ollama:11434/v1', 'http://spark/v1', 'http://gpu-box:8000', 'http://nas.lan:8080', 'http://models.internal/v1', 'http://box.home.arpa', 'http://[fd00::5]:8000', 'http://[::1]:8000']) expect(looksLocal(address), address).toBe(true)
    for (const address of ['https://models.example.com/v1', 'http://[2001:db8::1]:8000', 'not an address at all']) expect(looksLocal(address), address).toBe(false)
  })

  it('says so beside the address in the form', async () => {
    const dialog = await opened()
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Address/, 'http://100.64.0.2:8899/v1')
    expect(within(dialog).getByLabelText(/^Address/).closest('.field')!.textContent).toContain('That’s the hub’s own machine or network')
    type(dialog, /^Address/, 'https://r.openai.azure.com/openai/v1')
    expect(within(dialog).getByLabelText(/^Address/).closest('.field')!.textContent).not.toContain('hub’s own machine')
  })
})

describe('what the hub found wrong, in a model’s form', () => {
  it('is said beside the box it’s about, and the box is marked', async () => {
    const dialog = await opened()
    standInRoute('POST', '/api/agents/endpoint', () => new Response(JSON.stringify({ error: 'The address must end in /v1.' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    type(dialog, /^Name/, 'Azure assistant')
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Address/, 'https://r.openai.azure.com/openai')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add it' }))
    const alert = await within(dialog).findByRole('alert')
    const box = within(dialog).getByLabelText(/^Address/)
    expect(alert.textContent).toBe('The address must end in /v1.')
    expect(alert.closest('.field')).toBe(box.closest('.field'))
    expect(box.getAttribute('aria-invalid')).toBe('true')
    // Typing again clears it.
    type(dialog, /^Address/, 'https://r.openai.azure.com/openai/v1')
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('shows what Try it found as a status, said with words and not colour alone', async () => {
    const dialog = await opened()
    standInRoute('POST', '/api/agents/endpoint/test', () => ({ ok: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    const said = (await within(dialog).findByText('It answers and calls tools.')).closest('p')!
    expect(said.querySelector('.status-pill.ok')!.textContent).toBe('Works')
  })
})

