// @vitest-environment jsdom
import axe from 'axe-core'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, calledOn, entry, hear, hubState, me, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import { Environments } from '../src/components/Environments'
import { ContextMenuHost } from '../src/components/ContextMenu'
import type { Environment, PullRequest } from '../src/data/model'

// Settings → How work flows, Environments: each repo's environments as a table, a row opening a dialog to change one, its
// place and its removal in a menu; what an owner or an admin sets, and what a member sees.

const env = (over: Partial<Environment> = {}): Environment => ({ id: 'acme/web#staging', repo: 'acme/web', name: 'staging', url: '', version: '', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0, ...over })
const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ id: 'acme/blog#2', repo: 'acme/blog', number: 2, title: 'A post', branch: 'b', url: '', state: 'merged', checks: [], files: [], ...over })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const owner = { ...me, role: 'owner' }
const member = { ...me, role: 'member' }

const staging = env({ url: 'https://stage.example', version: 'v1.1' })
const production = env({ id: 'acme/web#production', name: 'production', order: 1 })

/** The binder works in acme/web, its agent in acme/api, and a pull request is in acme/blog. */
function settings(environments: Environment[], you: object = owner) {
  standInHub(() => hubState({
    binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web', repos: ['acme/web'] }],
    agents: [{ ...agent, repos: ['acme/api'] }],
    pulls: [pull()],
    environments,
  }), you)
  return mount(<><Environments /><Toast /><ContextMenuHost /></>)
}

/** An environment's dialog, opened from its row in the table. */
const open = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }))
  return within(screen.getByRole('dialog', { name }))
}
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }))
/** The dialog's menu: its place and its removal. */
const menu = () => fireEvent.click(screen.getByRole('button', { name: /Move or remove/ }))
const toasted = (words: string) => waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe(words))
const type = (box: HTMLElement, value: string) => {
  fireEvent.change(box, { target: { value } })
  fireEvent.blur(box)
}
const adding = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  return within(screen.getByRole('dialog', { name: 'Add an environment' }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('what it says', () => {
  it('says how environments get here, and that none have yet', async () => {
    await settings([])
    expect(screen.getByRole('heading', { name: 'Environments' })).toBeTruthy()
    expect(screen.getByText(/When GitHub reports a deployment from one of this binder’s repos, the hub shows it in Delivery\./)).toBeTruthy()
    expect(screen.getByText('No environments yet')).toBeTruthy()
  })

  it('lists each repo’s environments in order, in a table under the repo’s name as a link to it', async () => {
    await settings([production, staging])
    expect(screen.getByRole('link', { name: /acme\/web/ }).getAttribute('href')).toBe('https://github.com/acme/web')
    expect([...document.querySelectorAll('.data-table-open')].map((b) => b.textContent)).toEqual(['staging', 'production'])
    const rows = [...document.querySelectorAll('tbody tr')] as HTMLElement[]
    expect(within(rows[0]).getByText('v1.1')).toBeTruthy()
    expect(within(rows[0]).getByText('stage.example')).toBeTruthy()
    expect(within(rows[1]).getByText('Nothing yet')).toBeTruthy()
  })

  it('opens one in a dialog, each field’s name above a full-width box', async () => {
    await settings([staging])
    const dialog = open('staging')
    const name = dialog.getByLabelText('Name')
    expect(name.closest('.field')!.firstElementChild!.textContent).toBe('Name')
    expect((dialog.getByLabelText('Where it’s served') as HTMLInputElement).value).toBe('https://stage.example')
  })
})

describe('adding one', () => {
  it('offers only the repos the binder works in: its own, its agents’ and its pull requests’', async () => {
    await settings([])
    const options = within(adding().getByLabelText('Repo')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['acme/web', 'acme/api', 'acme/blog'])
  })

  it('says to add a repo first when the binder has none, and has nothing to add', async () => {
    standInHub(() => hubState(), owner)
    await mount(<Environments />)
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('#/settings/github')
  })

  it('sends the repo, name and address, says so, and closes', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web' }] }), owner)
    const sent = standInRoute('POST', '/api/environments', () => env({ name: 'qa' }))
    await mount(<><Environments /><Toast /></>)
    const add = adding()
    fireEvent.change(add.getByLabelText('Name, as GitHub calls it'), { target: { value: ' qa ' } })
    fireEvent.change(add.getByLabelText('Where it’s served (optional)'), { target: { value: 'https://qa.example' } })
    fireEvent.click(add.getByRole('button', { name: 'Add environment' }))
    await waitFor(() => expect(sent).toEqual([{ repo: 'acme/web', name: 'qa', url: 'https://qa.example' }]))
    await toasted('Added qa to acme/web.')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add an environment' })).toBeNull())
  })

  it('has nothing to send until it has a name, and sends no address when there isn’t one', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web' }] }), owner)
    const sent = standInRoute('POST', '/api/environments', () => env())
    await mount(<Environments />)
    const add = adding()
    const button = add.getByRole('button', { name: 'Add environment' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(add.getByLabelText('Name, as GitHub calls it'), { target: { value: 'staging' } })
    fireEvent.click(button)
    await waitFor(() => expect(sent).toEqual([{ repo: 'acme/web', name: 'staging' }]))
  })

  it('shows the hub’s refusal as it is, and keeps the dialog and what was typed', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web' }] }), owner)
    standInRoute('POST', '/api/environments', () => json({ error: 'acme/web has an environment called staging already.' }, 400))
    await mount(<><Environments /><Toast /></>)
    const add = adding()
    fireEvent.change(add.getByLabelText('Name, as GitHub calls it'), { target: { value: 'staging' } })
    fireEvent.click(add.getByRole('button', { name: 'Add environment' }))
    await toasted('acme/web has an environment called staging already.')
    expect((add.getByLabelText('Name, as GitHub calls it') as HTMLInputElement).value).toBe('staging')
  })
})

describe('changing one', () => {
  it('renames it when the box is left, with its id encoded in the path, and says Saved', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => env({ id: 'acme/web#stage', name: 'stage' }))
    type(open('staging').getByLabelText('Name'), 'stage')
    await waitFor(() => expect(sent).toEqual([{ name: 'stage' }]))
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('doesn’t send an empty name, and puts the old one back', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', /^\/api\/environments\//, () => env())
    const box = open('staging').getByLabelText('Name') as HTMLInputElement
    type(box, '  ')
    await waitFor(() => expect(box.value).toBe('staging'))
    expect(sent).toEqual([])
  })

  it('sets where it’s served, and clears it with an empty box', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => staging)
    type(open('staging').getByLabelText('Where it’s served'), 'https://new.example')
    await waitFor(() => expect(sent).toEqual([{ url: 'https://new.example' }]))
  })

  it('goes back to what it was, and shows the hub’s words, when the hub refuses', async () => {
    await settings([staging])
    standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => json({ error: 'Where it’s served is an address starting with http:// or https://.' }, 400))
    const box = open('staging').getByLabelText('Where it’s served') as HTMLInputElement
    type(box, 'nowhere')
    await toasted('Where it’s served is an address starting with http:// or https://.')
    await waitFor(() => expect(box.value).toBe('https://stage.example'))
  })

  it('keeps the dialog, and the person’s place in it, when a rename gives it a new id', async () => {
    await settings([staging, production])
    standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => env({ id: 'acme/web#stage', name: 'stage' }))
    type(open('staging').getByLabelText('Name'), 'stage')
    const before = screen.getByRole('dialog')
    await screen.findByText('Saved')
    // The hub's word comes back as the same environment under a new id.
    await hear({ type: 'entries', entries: [entry(2, { type: 'env.delete', id: 'acme/web#staging' }), entry(3, { type: 'env.put', environment: { ...staging, id: 'acme/web#stage', name: 'stage' } })] })
    expect(screen.getByRole('dialog', { name: 'stage' })).toBe(before)
    expect(within(before).getByText('Saved')).toBeTruthy()
  })
})

describe('putting them in order', () => {
  it('moves one down and up from its dialog’s menu, by asking the hub for its new place', async () => {
    await settings([staging, production])
    const down = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => staging)
    const up = standInRoute('PUT', '/api/environments/acme%2Fweb%23production', () => production)
    open('staging')
    menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move staging down' }))
    await waitFor(() => expect(down).toEqual([{ order: 1 }]))
    close()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    open('production')
    menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move production up' }))
    await waitFor(() => expect(up).toEqual([{ order: 0 }]))
  })

  it('has no place to go past the first and the last', async () => {
    await settings([staging, production])
    open('staging')
    menu()
    expect(screen.getByRole('menuitem', { name: 'Move staging up' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Move staging down' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('removing one', () => {
  it('asks first, then deletes it; and says it comes back if GitHub deploys there again', async () => {
    await settings([staging])
    expect(screen.getByText(/One taken off comes back by itself if GitHub deploys there again\./)).toBeTruthy()
    const sent = standInRoute('DELETE', '/api/environments/acme%2Fweb%23staging', () => ({ ok: true }))
    open('staging')
    menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove staging' }))
    expect(sent).toEqual([])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove staging? Press again' }))
    await waitFor(() => expect(sent.length).toBe(1))
    expect(calledOn()).toContain('DELETE /api/environments/acme%2Fweb%23staging')
  })
})

describe('Deploy from the hub', () => {
  const deploying = env({ deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, needsApproval: true })

  it('is part of an environment’s dialog, with its two boxes', async () => {
    await settings([staging])
    const dialog = open('staging')
    expect(dialog.getByRole('group', { name: 'Deploy from the hub' })).toBeTruthy()
    expect(dialog.getByLabelText('Workflow file')).toBeTruthy()
    expect(dialog.getByLabelText('Branch or tag to run it on')).toBeTruthy()
  })

  it('says how the hub deploys to one that has a workflow, in the table and its dialog', async () => {
    await settings([deploying])
    expect(within(document.querySelector('tbody tr') as HTMLElement).getByText('deploy.yml')).toBeTruthy()
    expect(open('staging').getByText(/The hub deploys to it with deploy\.yml on main when someone presses Promote on Delivery\./)).toBeTruthy()
  })

  it('waits for the workflow and the branch both before it asks the hub', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => deploying)
    const dialog = open('staging')
    type(dialog.getByLabelText('Workflow file'), 'deploy.yml')
    await new Promise((done) => setTimeout(done, 50))
    expect(sent).toEqual([])
    type(dialog.getByLabelText('Branch or tag to run it on'), 'main')
    await waitFor(() => expect(sent).toEqual([{ deploy: { workflow: 'deploy.yml', ref: 'main' } }]))
  })

  it('stops the hub deploying when both are emptied', async () => {
    await settings([deploying])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => staging)
    const dialog = open('staging')
    type(dialog.getByLabelText('Workflow file'), '')
    await new Promise((done) => setTimeout(done, 50))
    expect(sent).toEqual([])
    type(dialog.getByLabelText('Branch or tag to run it on'), '')
    await waitFor(() => expect(sent).toEqual([{ deploy: null }]))
  })

  it('says a person presses Promote, with no switch to say otherwise, as nothing deploys by itself', async () => {
    await settings([deploying])
    expect(open('staging').getByText(/when someone presses Promote on Delivery/)).toBeTruthy()
    expect(screen.queryByLabelText('Wait for someone to press Promote')).toBeNull()
  })
})

describe('Look on GitHub now', () => {
  it('asks the hub to look at every repo, and says it’s working', async () => {
    await settings([staging])
    let finish: (body: unknown) => void = () => {}
    const sent = standInRoute('POST', '/api/environments/look', () => new Promise((done) => { finish = done }))
    fireEvent.click(screen.getByRole('button', { name: 'Look on GitHub now' }))
    expect((await screen.findByRole('button', { name: 'Looking on GitHub…' })).hasAttribute('disabled')).toBe(true)
    expect(sent).toEqual([{}])
    finish({ looked: ['acme/web'], failed: [] })
    await toasted('Looked at acme/web.')
  })
})

describe('for a member', () => {
  it('shows the environments and how the hub deploys to them, greyed in their dialog, and nothing to press', async () => {
    await settings([env({ version: 'v1', deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, needsApproval: true })], member)
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Look on GitHub now' })).toBeNull()
    const dialog = open('staging')
    expect(dialog.getByText(/The hub deploys to it with deploy\.yml on main/)).toBeTruthy()
    for (const control of [dialog.getByLabelText('Name'), dialog.getByLabelText('Workflow file')]) expect(control.closest('fieldset')!.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /Move or remove/ })).toBeNull()
  })

  it('doesn’t repeat who can change them: the page above already says', async () => {
    await settings([staging], member)
    expect(screen.queryByText(/Only this binder’s owners and admins/)).toBeNull()
  })
})

describe('for assistive technology', () => {
  it('finds nothing for axe to object to, in the table or with an environment’s dialog open', async () => {
    await settings([env({ version: 'v1', deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, needsApproval: true }), production])
    const quiet = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }
    expect((await axe.run(document.body, quiet)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
    open('staging')
    const { violations } = await axe.run(document.body, quiet)
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
  })
})
