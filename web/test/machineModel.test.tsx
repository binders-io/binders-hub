// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRunner } from '../../shared/work.ts'
import type { Agent } from '../src/data/model'
import { isModelAgent, machineModelWords, modelOnMachine } from '../src/components/modelAgent'
import { Agents } from '../src/screens/Agents'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { agent, hubState, me, mount, settle, standInHub, standInRoute } from './harness'

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
  await mount(<><Agents /><ContextMenuHost /></>)
}
/** The rare actions of an agent's card, in its menu, by their words. */
const menuOf = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `More for ${name}` }))
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
}
const choose = (item: string) => fireEvent.click(screen.getByRole('menuitem', { name: item }))
/** Add an agent, set up by hand. */
const byHand = async () => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add an agent' })[0])
  const dialog = (await screen.findByRole('dialog', { name: 'Add an agent' })) as HTMLElement
  fireEvent.click(within(dialog).getByRole('button', { name: /Set one up by hand/ }))
  await within(dialog).findByRole('form', { name: 'Set up an agent' })
  return dialog
}
/** What its card says it runs on and with: its machine, its tool, its model. */
const where = () => [...document.querySelectorAll('.agent-where > span')].map((p) => p.textContent)
const reply = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })
const pick = (dialog: HTMLElement, name: RegExp) => fireEvent.click(within(dialog).getByRole('radio', { name }))
const type = (dialog: HTMLElement, label: RegExp, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })

describe('an agent on a machine that has a model', () => {
  it('is not one of the agents with no machine, so it keeps every runner control', async () => {
    expect(isModelAgent(withModel)).toBe(false)
    expect(isModelAgent({ ...withModel, runner: undefined })).toBe(true)
    await boardWith([withModel])
    expect(screen.getByRole('button', { name: 'Start the runner' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    // Its runner isn't connected, so there's nothing to restart from here: the card says to start it instead.
    expect(await menuOf('Binders on studio-mac')).toEqual(['New token', 'Change its model', 'Revoke'])
    // Still named by its tool and machine, and not as one the hub runs.
    expect(document.body.textContent).not.toContain('Runs on this hub')
    expect(where().slice(0, 2)).toEqual(['studio-mac', 'Binders'])
  })

  it('has its own mark on its avatar, not an initial', async () => {
    await boardWith([withModel])
    expect(document.querySelector('.avatar.agent .avatar-mark svg')).toBeTruthy()
  })
})

describe('its model, on its card', () => {
  it('says what its model is, and an owner can change it from its menu', async () => {
    await boardWith([withModel])
    expect(where()).toContain('gpt-deploy at your-resource.openai.azure.com')
    expect(document.querySelector('.agent-warning.model-agent-warning')).toBeNull()
    await menuOf('Binders on studio-mac')
    choose('Change its model')
    expect(await screen.findByRole('dialog', { name: 'Binders on studio-mac’s model' })).toBeTruthy()
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
    expect(where()).toEqual(['studio-mac', 'Binders'])
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
    expect(await menuOf('Binders on studio-mac')).not.toContain('Change its model')
  })

  it('is not asked for of a machine agent of another tool', async () => {
    await boardWith([{ ...agent, runner: defaultRunner }])
    expect(screen.queryByText(/No model yet/)).toBeNull()
    expect(await menuOf('Agent')).not.toContain('Change its model')
  })
})

describe('setting up an agent with the Binders tool', () => {
  it('says where its model can be, and has no model box of its own', async () => {
    await boardWith([])
    const dialog = await byHand()
    expect(within(dialog).queryByLabelText(/^Model/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Binders/ }))
    expect(within(dialog).getByText('Binders’ own agent works in the repo on this machine. Nothing else is installed there. Its model is on the hub, or on the machine itself: choose below.')).toBeTruthy()
    expect(within(dialog).queryByLabelText(/^Model/)).toBeNull()
    expect(within(dialog).getByLabelText(/^Time limit/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: /Claude Code/ }))
    expect(within(dialog).queryByText(/Its model is on the hub, or on the machine itself/)).toBeNull()
    expect(within(dialog).getByLabelText(/^Model/)).toBeTruthy()
  })

  it('shows the same hint and no model box when editing one', async () => {
    await boardWith([withModel])
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = (await screen.findByRole('dialog', { name: 'Edit Binders on studio-mac' })) as HTMLElement
    expect(within(dialog).getByText(/Its model is on the hub, or on the machine itself/)).toBeTruthy()
    expect(within(dialog).queryByLabelText(/^Model/)).toBeNull()
  })
})

describe('the dialog for a machine agent’s model', () => {
  // Give it a model is a button on a card with none; Change is its menu's, for one that has one.
  const open = async (agents: Agent[], button: string) => {
    await boardWith(agents)
    if (button === 'Change') {
      await menuOf(agents[0].name)
      choose('Change its model')
    } else fireEvent.click(screen.getByRole('button', { name: button }))
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

// Binders' own agent with its model on its own machine: a server or proxy the runner calls itself, set in its runner settings.
const local: Agent = { ...onMachine, runner: { ...onMachine.runner!, model: 'local-model', modelUrl: 'http://127.0.0.1:8000' } }

describe('Binders’ own agent with its model on its machine', () => {
  const edit = async (agents: Agent[], you: unknown = owner) => {
    await boardWith(agents, you)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    return (await screen.findByRole('dialog', { name: /^Edit / })) as HTMLElement
  }

  it('words it as the model and the host of its address, on its machine', () => {
    expect(machineModelWords({ model: 'local-model', modelUrl: 'http://127.0.0.1:8000' })).toBe('local-model at 127.0.0.1:8000, on its machine')
    expect(modelOnMachine(local)).toBe(true)
    expect(modelOnMachine(withModel)).toBe(false)
    expect(modelOnMachine({ ...agent, runner: { ...defaultRunner, modelUrl: 'http://x' } })).toBe(false)
  })

  it('opens the form on “On the hub” for an agent with no address, with nothing else to fill in', async () => {
    const dialog = await edit([withModel])
    const group = within(dialog).getByRole('radiogroup', { name: 'Its model' })
    expect(within(group).getByRole('radio', { name: /On the hub/ }).getAttribute('aria-checked')).toBe('true')
    expect(within(group).getByText('The hub reaches the model and keeps its key. Give it one from its card.')).toBeTruthy()
    expect(within(dialog).queryByLabelText(/^Address on the machine/)).toBeNull()
    expect(within(dialog).queryByLabelText(/^Model or deployment/)).toBeNull()
  })

  it('opens the form on “On this machine” for an agent that has an address, with its fields filled in', async () => {
    const dialog = await edit([local])
    const group = within(dialog).getByRole('radiogroup', { name: 'Its model' })
    expect(within(group).getByRole('radio', { name: /On this machine/ }).getAttribute('aria-checked')).toBe('true')
    const address = within(dialog).getByLabelText(/^Address on the machine/) as HTMLInputElement
    expect(address.value).toBe('http://127.0.0.1:8000')
    expect(address.placeholder).toBe('http://127.0.0.1:8000')
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).value).toBe('local-model')
    expect(within(dialog).getByText('If the server wants a key, put it in BINDERS_MODEL_KEY in the runner’s environment on that machine. It never leaves the machine.')).toBeTruthy()
    // It never asks for a key.
    expect(within(dialog).queryByLabelText(/^Key/)).toBeNull()
  })

  it('shows the choice and its fields only for the Binders tool, and sends no address with another tool', async () => {
    const dialog = await edit([local])
    const saved = standInRoute('PATCH', '/api/agents/w1', () => ({}))
    fireEvent.click(within(dialog).getByRole('radio', { name: /Claude Code/ }))
    expect(within(dialog).queryByRole('radiogroup', { name: 'Its model' })).toBeNull()
    expect(within(dialog).queryByLabelText(/^Address on the machine/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    const runner = (saved[0] as { runner: Record<string, unknown> }).runner
    expect(runner.tool).toBe('claude')
    expect('modelUrl' in runner && runner.modelUrl !== undefined).toBe(false)
    expect(runner.model).toBeUndefined()
  })

  it('saves the address and the model with the runner settings when “On this machine” is picked', async () => {
    const dialog = await edit([withModel])
    const saved = standInRoute('PATCH', '/api/agents/w1', () => ({}))
    pick(dialog, /On this machine/)
    type(dialog, /^Address on the machine/, 'http://127.0.0.1:8000')
    type(dialog, /^Model or deployment/, 'local-model')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(saved).toHaveLength(1)
    const runner = (saved[0] as { runner: { tool: string; modelUrl?: string; model?: string } }).runner
    expect(runner).toMatchObject({ tool: 'binders', modelUrl: 'http://127.0.0.1:8000', model: 'local-model' })
  })

  it('needs the model’s name once “On this machine” is picked', async () => {
    const dialog = await edit([withModel])
    const saved = standInRoute('PATCH', '/api/agents/w1', () => ({}))
    pick(dialog, /On this machine/)
    type(dialog, /^Address on the machine/, 'http://127.0.0.1:8000')
    expect((within(dialog).getByLabelText(/^Model or deployment/) as HTMLInputElement).required).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await settle(50)
    expect(saved).toHaveLength(0)
  })

  it('sends neither address nor model when “On the hub” is picked again', async () => {
    const dialog = await edit([local])
    const saved = standInRoute('PATCH', '/api/agents/w1', () => ({}))
    pick(dialog, /On the hub/)
    expect(within(dialog).queryByLabelText(/^Address on the machine/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    const runner = (saved[0] as { runner: Record<string, unknown> }).runner
    expect(runner.tool).toBe('binders')
    expect(runner.modelUrl).toBeUndefined()
    expect(runner.model).toBeUndefined()
  })

  it('shows the hub’s refusal in the form and keeps what was typed', async () => {
    const dialog = await edit([withModel])
    standInRoute('PATCH', '/api/agents/w1', () => reply(400, 'A model address can’t have a name or a password in it.'))
    pick(dialog, /On this machine/)
    type(dialog, /^Address on the machine/, 'http://me:pw@127.0.0.1:8000')
    type(dialog, /^Model or deployment/, 'local-model')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('A model address can’t have a name or a password in it.')
    expect((within(dialog).getByLabelText(/^Address on the machine/) as HTMLInputElement).value).toBe('http://me:pw@127.0.0.1:8000')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('sets one up with its model on the machine, sending the address and model in its runner', async () => {
    await boardWith([])
    const made = standInRoute('POST', '/api/agents', () => ({ agent: local, token: 'tok' }))
    const dialog = await byHand()
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Binders/ }))
    expect(within(dialog).getByRole('radio', { name: /On the hub/ }).getAttribute('aria-checked')).toBe('true')
    pick(dialog, /On this machine/)
    type(dialog, /^Address on the machine/, ' http://127.0.0.1:8000 ')
    type(dialog, /^Model or deployment/, 'local-model')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(made).toHaveLength(1))
    expect((made[0] as { runner: object }).runner).toMatchObject({ tool: 'binders', modelUrl: 'http://127.0.0.1:8000', model: 'local-model' })
  })

  it('reads its model on its machine in the card, with no Change and neither amber line', async () => {
    // Whatever model the card holds for it, and however that model is doing, is not the one used.
    await boardWith([{ ...local, endpoint: { ...unready.endpoint! } }])
    expect(document.querySelector('.agent-model')!.textContent).toBe('local-model at 127.0.0.1:8000, on its machine')
    expect(document.querySelector('.agent-warning')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Put it right' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Give it a model' })).toBeNull()
    expect(screen.queryByText(/No model yet/)).toBeNull()
    // The runner controls are still there, and nothing to change its model with.
    expect(await menuOf('Binders on studio-mac')).toEqual(['New token', 'Revoke'])
  })

  it('shows no “No model yet” line for one with an address and no model on the card, to a member too', async () => {
    await boardWith([local], member)
    expect(screen.queryByText(/No model yet/)).toBeNull()
    expect(screen.queryByText(/Ask one of this Binder’s owners/)).toBeNull()
    expect(document.querySelector('.agent-model')!.textContent).toContain('on its machine')
  })

  it('still reads as before for one without an address', async () => {
    await boardWith([onMachine])
    expect(screen.getByText(/No model yet\. It can’t work until it has one\./)).toBeTruthy()
  })
})
