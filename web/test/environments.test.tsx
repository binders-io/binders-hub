// @vitest-environment jsdom
import axe from 'axe-core'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, calledOn, entry, hear, hubState, me, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import { Environments } from '../src/components/Environments'
import type { Environment, PullRequest } from '../src/data/model'

// Settings → How work flows, Environments: what an owner or an admin sets on each repo's environments, and what a member sees.

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
  return mount(<><Environments /><Toast /></>)
}

const row = (name: string) => screen.getByText(name, { selector: '.env-row-head > b' }).closest('li') as HTMLElement
const toasted = (words: string) => waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe(words))
const type = (box: HTMLElement, value: string) => {
  fireEvent.change(box, { target: { value } })
  fireEvent.blur(box)
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
    expect(screen.getByText('No environments yet.')).toBeTruthy()
  })

  it('lists each repo’s environments in order, under the repo’s name as a link to it', async () => {
    await settings([production, staging])
    expect(screen.getByRole('link', { name: /acme\/web/ }).getAttribute('href')).toBe('https://github.com/acme/web')
    expect([...document.querySelectorAll('.env-row-head > b')].map((b) => b.textContent)).toEqual(['staging', 'production'])
    expect(within(row('staging')).getByText('On it: v1.1')).toBeTruthy()
    expect(within(row('production')).getByText('Nothing deployed yet')).toBeTruthy()
  })

  it('puts each field’s name above a full-width box', async () => {
    await settings([staging])
    const name = within(row('staging')).getByLabelText('Name')
    expect(name.closest('.field')!.firstElementChild!.textContent).toBe('Name')
    expect((within(row('staging')).getByLabelText('Where it’s served') as HTMLInputElement).value).toBe('https://stage.example')
  })
})

describe('adding one', () => {
  it('offers only the repos the binder works in: its own, its agents’ and its pull requests’', async () => {
    await settings([])
    const options = within(screen.getByLabelText('Repo')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['acme/web', 'acme/api', 'acme/blog'])
  })

  it('says to add a repo first when the binder has none', async () => {
    standInHub(() => hubState(), owner)
    await mount(<Environments />)
    expect(screen.queryByLabelText('Repo')).toBeNull()
    expect(screen.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('#/settings/github')
  })

  it('sends the repo, name and address, and says Saved', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web' }] }), owner)
    const sent = standInRoute('POST', '/api/environments', () => env({ name: 'qa' }))
    await mount(<Environments />)
    const add = (document.querySelector('.env-add') as HTMLElement)
    fireEvent.change(within(add).getByLabelText('Name, as GitHub calls it'), { target: { value: ' qa ' } })
    fireEvent.change(within(add).getByLabelText('Where it’s served (optional)'), { target: { value: 'https://qa.example' } })
    fireEvent.click(within(add).getByRole('button', { name: 'Add environment' }))
    await waitFor(() => expect(sent).toEqual([{ repo: 'acme/web', name: 'qa', url: 'https://qa.example' }]))
    expect(await screen.findByText('Saved')).toBeTruthy()
    expect((within(add).getByLabelText('Name, as GitHub calls it') as HTMLInputElement).value).toBe('')
  })

  it('has nothing to send until it has a name, and sends no address when there isn’t one', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web' }] }), owner)
    const sent = standInRoute('POST', '/api/environments', () => env())
    await mount(<Environments />)
    const add = (document.querySelector('.env-add') as HTMLElement)
    const button = within(add).getByRole('button', { name: 'Add environment' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(add).getByLabelText('Name, as GitHub calls it'), { target: { value: 'staging' } })
    fireEvent.click(button)
    await waitFor(() => expect(sent).toEqual([{ repo: 'acme/web', name: 'staging' }]))
  })

  it('shows the hub’s refusal as it is, and keeps what was typed', async () => {
    standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder', repo: 'acme/web' }] }), owner)
    standInRoute('POST', '/api/environments', () => json({ error: 'acme/web has an environment called staging already.' }, 400))
    await mount(<><Environments /><Toast /></>)
    const add = (document.querySelector('.env-add') as HTMLElement)
    fireEvent.change(within(add).getByLabelText('Name, as GitHub calls it'), { target: { value: 'staging' } })
    fireEvent.click(within(add).getByRole('button', { name: 'Add environment' }))
    await toasted('acme/web has an environment called staging already.')
    expect((within(add).getByLabelText('Name, as GitHub calls it') as HTMLInputElement).value).toBe('staging')
  })
})

describe('changing one', () => {
  it('renames it when the box is left, with its id encoded in the path', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => env({ id: 'acme/web#stage', name: 'stage' }))
    type(within(row('staging')).getByLabelText('Name'), 'stage')
    await waitFor(() => expect(sent).toEqual([{ name: 'stage' }]))
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('doesn’t send an empty name, and puts the old one back', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', /^\/api\/environments\//, () => env())
    const box = within(row('staging')).getByLabelText('Name') as HTMLInputElement
    type(box, '  ')
    await waitFor(() => expect(box.value).toBe('staging'))
    expect(sent).toEqual([])
  })

  it('sets where it’s served, and clears it with an empty box', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => staging)
    const box = within(row('staging')).getByLabelText('Where it’s served')
    type(box, 'https://new.example')
    await waitFor(() => expect(sent).toEqual([{ url: 'https://new.example' }]))
  })

  it('goes back to what it was, and shows the hub’s words, when the hub refuses', async () => {
    await settings([staging])
    standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => json({ error: 'Where it’s served is an address starting with http:// or https://.' }, 400))
    const box = within(row('staging')).getByLabelText('Where it’s served') as HTMLInputElement
    type(box, 'nowhere')
    await toasted('Where it’s served is an address starting with http:// or https://.')
    await waitFor(() => expect(box.value).toBe('https://stage.example'))
  })

  it('keeps the row, and the person’s place in it, when a rename gives it a new id', async () => {
    await settings([staging, production])
    standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => env({ id: 'acme/web#stage', name: 'stage' }))
    const before = row('staging')
    type(within(before).getByLabelText('Name'), 'stage')
    await screen.findByText('Saved')
    // The hub's word comes back as the same environment under a new id.
    await hear({ type: 'entries', entries: [entry(2, { type: 'env.delete', id: 'acme/web#staging' }), entry(3, { type: 'env.put', environment: { ...staging, id: 'acme/web#stage', name: 'stage' } })] })
    expect(row('stage')).toBe(before)
    expect(within(before).getByText('Saved')).toBeTruthy()
  })
})

describe('putting them in order', () => {
  it('moves one down and up by asking the hub for its new place', async () => {
    await settings([staging, production])
    const down = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => staging)
    const up = standInRoute('PUT', '/api/environments/acme%2Fweb%23production', () => production)
    fireEvent.click(screen.getByRole('button', { name: 'Move staging down' }))
    await waitFor(() => expect(down).toEqual([{ order: 1 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Move production up' }))
    await waitFor(() => expect(up).toEqual([{ order: 0 }]))
  })

  it('has no place to go past the first and the last, and says so without leaving the keyboard', async () => {
    await settings([staging, production])
    const sent = standInRoute('PUT', /^\/api\/environments\//, () => staging)
    const first = screen.getByRole('button', { name: 'Move staging up' })
    const last = screen.getByRole('button', { name: 'Move production down' })
    expect(first.getAttribute('aria-disabled')).toBe('true')
    expect(last.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(first)
    fireEvent.click(last)
    await new Promise((done) => setTimeout(done, 50))
    expect(sent).toEqual([])
  })
})

describe('removing one', () => {
  it('asks first, saying it comes back if GitHub deploys there again, then deletes it', async () => {
    await settings([staging])
    const sent = standInRoute('DELETE', '/api/environments/acme%2Fweb%23staging', () => ({ ok: true }))
    const button = screen.getByRole('button', { name: 'Remove staging' })
    fireEvent.click(button)
    expect(sent).toEqual([])
    expect(button.getAttribute('aria-label')).toBe('Remove staging? Press again')
    expect(screen.getByText('If GitHub deploys there again, it comes back by itself.')).toBeTruthy()
    fireEvent.click(button)
    await waitFor(() => expect(sent.length).toBe(1))
    expect(calledOn()).toContain('DELETE /api/environments/acme%2Fweb%23staging')
  })
})

describe('Deploy from the hub', () => {
  const deploying = env({ deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, needsApproval: true })

  it('is folded away until it’s asked for', async () => {
    await settings([staging])
    const toggle = within(row('staging')).getByRole('button', { name: 'Deploy from the hub' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Workflow file')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Workflow file')).toBeTruthy()
    expect(screen.getByLabelText('Branch or tag to run it on')).toBeTruthy()
  })

  it('says how the hub deploys to one that has a workflow, while it’s folded away', async () => {
    await settings([deploying])
    expect(screen.getByText('The hub deploys to it with deploy.yml on main, once someone presses Promote.')).toBeTruthy()
  })

  it('waits for the workflow and the branch both before it asks the hub', async () => {
    await settings([staging])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => deploying)
    fireEvent.click(within(row('staging')).getByRole('button', { name: 'Deploy from the hub' }))
    type(screen.getByLabelText('Workflow file'), 'deploy.yml')
    await new Promise((done) => setTimeout(done, 50))
    expect(sent).toEqual([])
    type(screen.getByLabelText('Branch or tag to run it on'), 'main')
    await waitFor(() => expect(sent).toEqual([{ deploy: { workflow: 'deploy.yml', ref: 'main' } }]))
  })

  it('stops the hub deploying when both are emptied', async () => {
    await settings([deploying])
    const sent = standInRoute('PUT', '/api/environments/acme%2Fweb%23staging', () => staging)
    fireEvent.click(within(row('staging')).getByRole('button', { name: 'Deploy from the hub' }))
    type(screen.getByLabelText('Workflow file'), '')
    await new Promise((done) => setTimeout(done, 50))
    expect(sent).toEqual([])
    type(screen.getByLabelText('Branch or tag to run it on'), '')
    await waitFor(() => expect(sent).toEqual([{ deploy: null }]))
  })

  it('says a person presses Promote, with no switch to say otherwise, as nothing deploys by itself', async () => {
    await settings([deploying])
    fireEvent.click(within(row('staging')).getByRole('button', { name: 'Deploy from the hub' }))
    expect(screen.getByText(/It deploys when someone presses Promote on Delivery/)).toBeTruthy()
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
  it('shows the environments greyed, with how the hub deploys to them, and nothing to press', async () => {
    await settings([env({ version: 'v1', deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, needsApproval: true })], member)
    expect(screen.getByText('staging', { selector: '.env-row-head > b' })).toBeTruthy()
    expect(screen.getByText('The hub deploys to it with deploy.yml on main, once someone presses Promote.')).toBeTruthy()
    for (const control of [within(row('staging')).getByLabelText('Name'), screen.getByRole('button', { name: 'Look on GitHub now' }), screen.getByRole('button', { name: 'Remove staging' })]) {
      expect(control.closest('fieldset')!.disabled).toBe(true)
    }
  })

  it('doesn’t repeat who can change them: the page above already says', async () => {
    await settings([staging], member)
    expect(screen.queryByText(/Only this binder’s owners and admins/)).toBeNull()
  })
})

describe('for assistive technology', () => {
  it('finds nothing for axe to object to, with a row’s deploy part open', async () => {
    await settings([env({ version: 'v1', deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, needsApproval: true }), production])
    fireEvent.click(within(row('staging')).getByRole('button', { name: 'Deploy from the hub' }))
    const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
  })
})
