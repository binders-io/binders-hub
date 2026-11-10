// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRunner } from '../../shared/work.ts'
import type { Agent } from '../src/data/model'
import { isModelAgent } from '../src/components/modelAgent'
import { Agents } from '../src/screens/Agents'
import { agent, hubState, me, mount, standInHub, standInRoute } from './harness'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
  window.localStorage.clear()
})

const owner = { ...me, role: 'owner' }
const member = { ...me, role: 'member' }
const takes = { cards: true, chats: true, debriefs: true, challenges: true }

// Binders' own agent: on a machine, with a runner, and with a model the hub holds for it, or none yet.
const onMachine: Agent = { ...agent, id: 'w1', name: 'Binders on studio-mac', provider: 'other', runsOn: 'studio-mac', runner: { ...defaultRunner, tool: 'binders', access: 'full' } }
const withModel: Agent = { ...onMachine, endpoint: { kind: 'openai', baseUrl: 'https://your-resource.openai.azure.com/openai/v1', model: 'gpt-deploy', takes, ready: { ok: true, at: 'now' } } }
const unready: Agent = { ...withModel, endpoint: { ...withModel.endpoint!, ready: { ok: false, why: 'The key was refused: it is wrong or has run out.', at: 'now' } } }

const boardWith = async (agents: Agent[], you: unknown = owner) => {
  standInHub(() => hubState({ agents }), you)
  await mount(<Agents />)
}
const reply = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })
const pick = (dialog: HTMLElement, name: RegExp) => fireEvent.click(within(dialog).getByRole('radio', { name }))
const type = (dialog: HTMLElement, label: RegExp, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })

describe('an agent on a machine that has a model', () => {
  it('is not one of the agents with no machine, so it keeps every runner control', async () => {
    expect(isModelAgent(withModel)).toBe(false)
    expect(isModelAgent({ ...withModel, runner: undefined })).toBe(true)
    await boardWith([withModel])
    expect(screen.getByRole('button', { name: 'Start the runner' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart Binders on studio-mac’s runner' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New token for Binders on studio-mac' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke Binders on studio-mac' })).toBeTruthy()
    // Still named by its tool and machine, and not as one the hub runs.
    expect(document.body.textContent).not.toContain('Runs on this hub')
    expect(document.querySelector('.agent-meta')!.textContent).toContain('Binders')
  })

  it('has its own mark on its avatar, not an initial', async () => {
    await boardWith([withModel])
    expect(document.querySelector('.avatar.agent .avatar-mark svg')).toBeTruthy()
  })
})

describe('the Model row', () => {
  it('says what its model is, and an owner can change it', async () => {
    await boardWith([withModel])
    const row = screen.getByText('Model').nextElementSibling as HTMLElement
    expect(row.textContent).toContain('gpt-deploy at your-resource.openai.azure.com')
    expect(within(row).getByRole('button', { name: 'Change' })).toBeTruthy()
    expect(document.querySelector('.agent-warning.model-agent-warning')).toBeNull()
  })

  it('shows why one that isn’t ready isn’t, with a way for an owner to put it right', async () => {
    await boardWith([unready])
    expect(screen.getByText('The key was refused: it is wrong or has run out.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put it right' }))
    // It opens the model's own dialog, not the runner's settings.
    expect(await screen.findByRole('dialog', { name: 'Binders on studio-mac’s model' })).toBeTruthy()
  })

  it('says it has none yet, and an owner can give it one', async () => {
    await boardWith([onMachine])
    expect(screen.getByText(/No model yet\. It can’t work until it has one\./)).toBeTruthy()
    expect(screen.getByText('Model').nextElementSibling!.textContent).toBe('None yet')
    fireEvent.click(screen.getByRole('button', { name: 'Give it a model' }))
    expect(await screen.findByRole('dialog', { name: 'Give Binders on studio-mac a model' })).toBeTruthy()
  })

  it('tells a member who can give it a model, and offers them no button for it', async () => {
    await boardWith([onMachine], member)
    expect(screen.getByText(/Ask one of this Binder’s owners or admins to give it a model\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Give it a model' })).toBeNull()
    cleanup()
    await boardWith([unready, { ...withModel, id: 'w2', name: 'Other' }], member)
    expect(screen.getByText('The key was refused: it is wrong or has run out.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Put it right' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
  })

  it('is not shown for a machine agent of another tool', async () => {
    await boardWith([{ ...agent, runner: defaultRunner }])
    expect(screen.queryByText(/No model yet/)).toBeNull()
    expect(screen.queryByText('Model')).toBeNull()
  })
})

describe('setting up an agent with the Binders tool', () => {
  it('says the machine needs no key, and has no model box of its own', async () => {
    await boardWith([])
    fireEvent.click(screen.getByRole('button', { name: 'Set one up by hand' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Set up an agent' })) as HTMLElement
    expect(within(dialog).queryByLabelText(/^Model/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Binders/ }))
    expect(within(dialog).getByText('Binders’ own agent works in the repo on this machine, and the hub takes each step of its model, so the machine needs no key. Give it a model from its card once it’s set up.')).toBeTruthy()
    expect(within(dialog).queryByLabelText(/^Model/)).toBeNull()
    expect(within(dialog).getByLabelText(/^Time limit/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: /Claude Code/ }))
    expect(within(dialog).queryByText(/the machine needs no key/)).toBeNull()
    expect(within(dialog).getByLabelText(/^Model/)).toBeTruthy()
  })

  it('shows the same hint and no model box when editing one', async () => {
    await boardWith([withModel])
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Edit Binders on studio-mac' })) as HTMLElement
    expect(within(dialog).getByText(/the machine needs no key/)).toBeTruthy()
    expect(within(dialog).queryByLabelText(/^Model/)).toBeNull()
  })
})

describe('the dialog for a machine agent’s model', () => {
  const open = async (agents: Agent[], button: string) => {
    await boardWith(agents)
    fireEvent.click(screen.getByRole('button', { name: button }))
    return (await screen.findByRole('dialog')) as HTMLElement
  }

  it('offers the three kinds and each one’s own fields, and no “What it takes” boxes', async () => {
    const dialog = await open([onMachine], 'Give it a model')
    const has = (label: RegExp) => !!within(dialog).queryByLabelText(label)
    expect(within(dialog).getAllByRole('radio')).toHaveLength(3)
    expect(within(dialog).queryByText('What it takes')).toBeNull()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
    expect([has(/^Address/), has(/^Model or deployment/), has(/^Key/)]).toEqual([false, false, false])
    pick(dialog, /OpenAI’s chat API/)
    expect([has(/^Address/), has(/^Model or deployment/), has(/^Key/)]).toEqual([true, true, true])
    expect(within(dialog).queryByLabelText(/\(optional\)/)).toBeNull()
    pick(dialog, /Claude, by Anthropic/)
    expect(has(/^Address \(optional\)/)).toBe(true)
    expect(has(/^Key/)).toBe(true)
    const key = within(dialog).getByLabelText(/^Key/) as HTMLInputElement
    expect(key.type).toBe('password')
    expect(key.getAttribute('autocomplete')).toBe('off')
    // It has no model yet, so there is no key to keep.
    expect(within(dialog).queryByText(/Empty keeps the key/)).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Take its model away' })).toBeNull()
  })

  it('tries what was typed with the test route, and shows the hub’s yes and its reason', async () => {
    const dialog = await open([onMachine], 'Give it a model')
    let answer: { ok: boolean; why?: string } = { ok: true }
    const tried = standInRoute('POST', '/api/agents/endpoint/test', () => answer)
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Address/, 'https://r.openai.azure.com/openai/v1')
    type(dialog, /^Model or deployment/, 'gpt-deploy')
    type(dialog, /^Key/, 'typed-key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    expect(await within(dialog).findByText('It answers and calls tools.')).toBeTruthy()
    expect(tried).toEqual([{ kind: 'openai', baseUrl: 'https://r.openai.azure.com/openai/v1', model: 'gpt-deploy', key: 'typed-key', agent: 'w1' }])
    answer = { ok: false, why: 'It answered, but never called a tool.' }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('It answered, but never called a tool.')
  })

  it('saves a first model with the PATCH address and its kind, then closes and keeps the key out of sight', async () => {
    const dialog = await open([onMachine], 'Give it a model')
    const saved = standInRoute('PATCH', '/api/agents/w1/endpoint', () => ({ agent: withModel }))
    pick(dialog, /Claude, by Anthropic/)
    type(dialog, /^Model or deployment/, 'claude-opus-5-5')
    type(dialog, /^Key/, 'typed-key-1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(saved).toEqual([{ kind: 'anthropic', model: 'claude-opus-5-5', key: 'typed-key-1' }])
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('typed-key-1'))).toBe(true)
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('typed-key-1')
    expect(document.body.textContent).not.toContain('typed-key-1')
  })

  it('sends the hub’s own model with a kind and nothing else', async () => {
    const dialog = await open([onMachine], 'Give it a model')
    const saved = standInRoute('PATCH', '/api/agents/w1/endpoint', () => ({ agent: withModel }))
    pick(dialog, /The hub’s own model/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved).toEqual([{ kind: 'brain' }])
  })

  it('says a new address needs its key again, and tries with the kept key by naming the agent', async () => {
    const dialog = await open([withModel], 'Change')
    const tried = standInRoute('POST', '/api/agents/endpoint/test', () => ({ ok: true }))
    // The same server, another path: the key the hub keeps still goes with it.
    type(dialog, /^Address/, 'https://your-resource.openai.azure.com/openai/v1/')
    expect(within(dialog).getByText('Empty keeps the key that’s there. Type one to replace it.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    await waitFor(() => expect(tried).toHaveLength(1))
    expect(tried[0]).toEqual({ kind: 'openai', baseUrl: 'https://your-resource.openai.azure.com/openai/v1/', model: 'gpt-deploy', agent: 'w1' })
    // Another server: the hub won't send the kept key there, and the form says so.
    type(dialog, /^Address/, 'https://another.openai.azure.com/openai/v1')
    expect(within(dialog).getByText(/A new address needs its key typed again/)).toBeTruthy()
    expect(within(dialog).queryByText(/Empty keeps the key/)).toBeNull()
  })

  it('starts from what it has, and says empty keeps the key, sending none when the box is empty', async () => {
    const dialog = await open([withModel], 'Change')
    expect(within(dialog).getByRole('radio', { name: /OpenAI’s chat API/ }).getAttribute('aria-checked')).toBe('true')
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).value).toBe('gpt-deploy')
    expect((within(dialog).getByLabelText(/^Address/) as HTMLInputElement).value).toBe('https://your-resource.openai.azure.com/openai/v1')
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('')
    expect(within(dialog).getByText('Empty keeps the key that’s there. Type one to replace it.')).toBeTruthy()
    const saved = standInRoute('PATCH', '/api/agents/w1/endpoint', () => ({ agent: withModel }))
    type(dialog, /^Model or deployment/, 'gpt-deploy-2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toEqual({ kind: 'openai', model: 'gpt-deploy-2', baseUrl: 'https://your-resource.openai.azure.com/openai/v1' })
    expect('key' in (saved[0] as object)).toBe(false)
  })

  it('says another kind needs its own key, and starts that kind empty', async () => {
    const dialog = await open([withModel], 'Change')
    pick(dialog, /Claude, by Anthropic/)
    expect(within(dialog).getByText('A new kind of model needs its own key.')).toBeTruthy()
    expect(within(dialog).queryByText(/Empty keeps the key/)).toBeNull()
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).value).toBe('')
    expect((within(dialog).getByLabelText(/^Address/) as HTMLInputElement).value).toBe('')
    const saved = standInRoute('PATCH', '/api/agents/w1/endpoint', () => ({ agent: withModel }))
    type(dialog, /^Model or deployment/, 'claude-opus-5-5')
    type(dialog, /^Key/, 'typed-key-2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved).toEqual([{ kind: 'anthropic', model: 'claude-opus-5-5', key: 'typed-key-2' }])
  })

  it('brings back what it had when the first kind is picked again', async () => {
    const dialog = await open([withModel], 'Change')
    pick(dialog, /Claude, by Anthropic/)
    pick(dialog, /OpenAI’s chat API/)
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).value).toBe('gpt-deploy')
    expect(within(dialog).getByText('Empty keeps the key that’s there. Type one to replace it.')).toBeTruthy()
  })

  it('stays open and says why when the saved model still isn’t ready, and clears the key', async () => {
    const dialog = await open([withModel], 'Change')
    standInRoute('PATCH', '/api/agents/w1/endpoint', () => ({ agent: unready }))
    type(dialog, /^Key/, 'new-key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText(/still isn’t ready: The key was refused/)).toBeTruthy()
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('')
  })

  it('shows a refusal in place, and keeps what was typed', async () => {
    const dialog = await open([onMachine], 'Give it a model')
    standInRoute('PATCH', '/api/agents/w1/endpoint', () => reply(403, 'Only this Binder’s owners and admins change an agent’s model.'))
    pick(dialog, /OpenAI’s chat API/)
    type(dialog, /^Key/, 'typed-key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Only this Binder’s owners and admins change an agent’s model.')
    expect((within(dialog).getByLabelText(/^Key/) as HTMLInputElement).value).toBe('typed-key')
  })

  it('disables the buttons while Try it is working', async () => {
    const dialog = await open([onMachine], 'Give it a model')
    let finish: (body: unknown) => void = () => {}
    standInRoute('POST', '/api/agents/endpoint/test', () => new Promise((done) => { finish = done }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }))
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true))
    expect((within(dialog).getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(true)
    finish({ ok: true })
    await within(dialog).findByText('It answers and calls tools.')
  })

  it('takes its model away only after a second press, with the DELETE address', async () => {
    const dialog = await open([withModel], 'Change')
    const gone = standInRoute('DELETE', '/api/agents/w1/endpoint', () => ({ agent: onMachine }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take its model away' }))
    expect(gone).toHaveLength(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take it away? Press again' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(gone).toHaveLength(1)
  })

  it('shows the hub’s words when taking the model away is refused', async () => {
    const dialog = await open([withModel], 'Change')
    standInRoute('DELETE', '/api/agents/w1/endpoint', () => reply(403, 'Only this Binder’s owners and admins can take a model away.'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take its model away' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take it away? Press again' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Only this Binder’s owners and admins can take a model away.')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
