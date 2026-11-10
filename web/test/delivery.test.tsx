// @vitest-environment jsdom
import axe from 'axe-core'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calledOn, hubState, me, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import { Delivery } from '../src/screens/Delivery'
import type { ChangeSet, Environment, PullRequest } from '../src/data/model'

// The Delivery screen: for each repo, its environments in order, what's on each and what isn't there yet.

const env = (over: Partial<Environment> = {}): Environment => ({ id: 'acme/web#staging', repo: 'acme/web', name: 'staging', url: '', version: '', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0, ...over })
const pull = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Change ${number}`, branch: 'b', url: '', state: 'merged', checks: [], files: [], ...over })
const set: ChangeSet = { id: 's1', binderId: 'b1', number: 4, title: 'The login fix', summary: '', state: 'shipped', prIds: ['acme/web#1'], noteIds: [] }

const owner = { ...me, role: 'owner' }
const member = { ...me, role: 'member' }

const delivery = (environments: Environment[], extra: object = {}, you: object = owner) => {
  standInHub(() => hubState({ environments, ...extra }), you)
  return mount(<><Delivery /><Toast /></>)
}

/** What the toast on screen says, once it has. */
const toasted = (words: string) => waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe(words))

/** The block of one environment, by its name. */
const block = (name: string) => screen.getByRole('heading', { name, level: 3 }).closest('section') as HTMLElement

const twoRepos = [
  env({ id: 'acme/web#production', name: 'production', order: 1, version: 'v1.0', pullIds: ['acme/web#1'], deployedAt: new Date(Date.now() - 5 * 60_000).toISOString(), url: 'https://acme.example', changeSetIds: ['s1'] }),
  env({ id: 'acme/web#staging', name: 'staging', order: 0, version: 'v1.1', state: 'deploying', pullIds: ['acme/web#1', 'acme/web#2', 'acme/web#3'], logUrl: 'https://github.com/acme/web/actions/runs/9' }),
  env({ id: 'acme/api#live', repo: 'acme/api', name: 'live', version: '', state: 'failed' }),
]
const pulls = [pull(1), pull(2), pull(3), pull(4), pull(5, { state: 'open' }), pull(6, { repo: 'acme/api', id: 'acme/api#6' })]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('with nothing deployed yet', () => {
  it('says so, and that GitHub’s word will show here by itself', async () => {
    await delivery([])
    expect(screen.getByText('Nothing has been deployed from this binder’s repos yet. When GitHub reports a deployment from one of them, it shows here by itself.')).toBeTruthy()
  })

  it('offers an owner Look on GitHub now, and not a member', async () => {
    await delivery([])
    expect(screen.getByRole('button', { name: 'Look on GitHub now' })).toBeTruthy()
    cleanup()
    await delivery([], {}, member)
    expect(screen.queryByRole('button', { name: 'Look on GitHub now' })).toBeNull()
  })

  it('says it’s working while the hub looks, and then which repos it looked at', async () => {
    standInHub(() => hubState(), owner)
    let finish: (body: unknown) => void = () => {}
    const asked = standInRoute('POST', '/api/environments/look', () => new Promise((done) => { finish = done }))
    await mount(<><Delivery /><Toast /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Look on GitHub now' }))
    const working = await screen.findByRole('button', { name: 'Looking on GitHub…' })
    expect(working.hasAttribute('disabled')).toBe(true)
    expect(working.getAttribute('aria-busy')).toBe('true')
    expect(asked).toEqual([{}])
    await act(async () => finish({ looked: ['acme/web', 'acme/api'], failed: [] }))
    await toasted('Looked at acme/web, acme/api.')
    expect(screen.getByRole('button', { name: 'Look on GitHub now' }).hasAttribute('disabled')).toBe(false)
  })

  it('says which repo it couldn’t look at, and why', async () => {
    standInHub(() => hubState(), owner)
    standInRoute('POST', '/api/environments/look', () => ({ looked: ['acme/web'], failed: [{ repo: 'acme/api', why: 'GitHub isn’t connected for acme/api.' }] }))
    await mount(<><Delivery /><Toast /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Look on GitHub now' }))
    await toasted('Looked at acme/web. Couldn’t look at acme/api: GitHub isn’t connected for acme/api.')
  })

  it('shows a refusal in the hub’s own words', async () => {
    standInHub(() => hubState(), owner)
    standInRoute('POST', '/api/environments/look', () => new Response(JSON.stringify({ error: 'Only this Binder’s owners and admins can change its environments.' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    await mount(<><Delivery /><Toast /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Look on GitHub now' }))
    await toasted('Only this Binder’s owners and admins can change its environments.')
  })
})

describe('a block for each repo', () => {
  it('names each repo as a link to it on GitHub, and says how environments get here', async () => {
    await delivery(twoRepos, { pulls })
    expect(screen.getByRole('link', { name: 'acme/web' }).getAttribute('href')).toBe('https://github.com/acme/web')
    expect(screen.getByRole('link', { name: 'acme/api' }).getAttribute('href')).toBe('https://github.com/acme/api')
    expect(screen.getByText('When GitHub reports a deployment from one of this binder’s repos, the hub shows it in Delivery.')).toBeTruthy()
    expect(screen.queryByText(/Nothing has been deployed from this binder/)).toBeNull()
  })

  it('has a repo’s environments in the order they’re deployed to', async () => {
    await delivery(twoRepos, { pulls })
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(names).toEqual(['staging', 'production', 'live'])
  })

  it('says each one’s state in words', async () => {
    await delivery([...twoRepos, env({ id: 'acme/web#qa', name: 'qa', order: 2, state: 'waiting' }), env({ id: 'acme/web#dev', name: 'dev', order: 3 })], { pulls })
    expect(within(block('staging')).getByText('Deploying')).toBeTruthy()
    expect(within(block('production')).getByText('Healthy')).toBeTruthy()
    expect(within(block('live')).getByText('Failed')).toBeTruthy()
    expect(within(block('qa')).getByText('Waiting on GitHub')).toBeTruthy()
  })

  it('shows what’s on it, where it’s served and when, with a link to the run', async () => {
    await delivery(twoRepos, { pulls })
    expect(within(block('production')).getByText('v1.0')).toBeTruthy()
    expect(within(block('production')).getByRole('link', { name: /acme\.example/ }).getAttribute('href')).toBe('https://acme.example')
    expect(within(block('production')).getByText('5m ago')).toBeTruthy()
    expect(within(block('staging')).getByRole('link', { name: /See the run on GitHub/ }).getAttribute('href')).toBe('https://github.com/acme/web/actions/runs/9')
  })

  it('says so when nothing has been deployed to one', async () => {
    await delivery(twoRepos, { pulls })
    expect(within(block('live')).getByText('Nothing deployed yet')).toBeTruthy()
  })

  it('doesn’t link an address that isn’t http or https', async () => {
    await delivery([env({ version: 'v1', url: 'javascript:alert(1)' })])
    expect(block('staging').querySelector('a.env-url')).toBeNull()
  })

  it('lists the change sets on it by number and title', async () => {
    await delivery(twoRepos, { pulls, changeSets: [set] })
    const link = within(block('production')).getByRole('link', { name: /CS-4 The login fix/ })
    expect(link.getAttribute('href')).toContain('changes')
  })

  it('counts the repo’s merged pull requests that aren’t on the first environment yet', async () => {
    await delivery(twoRepos, { pulls })
    // Four merged in acme/web, three on staging; the open one and the other repo’s don’t count.
    expect(within(block('staging')).getByText('1 merged pull request isn’t here yet')).toBeTruthy()
    expect(within(block('live')).getByText('1 merged pull request isn’t here yet')).toBeTruthy()
  })

  it('counts those on the one before and not yet on a later one', async () => {
    await delivery(twoRepos, { pulls })
    // Staging has 1, 2 and 3; production only 1.
    expect(within(block('production')).getByText('2 merged pull requests on staging aren’t here yet')).toBeTruthy()
  })

  it('says it’s up to date when nothing is behind, and when the one before has nothing on it', async () => {
    await delivery([
      env({ version: 'v1', pullIds: ['acme/web#1'] }),
      env({ id: 'acme/web#production', name: 'production', order: 1, version: 'v1', pullIds: ['acme/web#1'] }),
      env({ id: 'acme/web#extra', name: 'extra', order: 2 }),
    ], { pulls: [pull(1)] })
    expect(within(block('staging')).getByText('Everything merged is here')).toBeTruthy()
    expect(within(block('production')).getByText('Up to date with staging')).toBeTruthy()
    cleanup()
    await delivery([env(), env({ id: 'acme/web#production', name: 'production', order: 1 })], { pulls: [pull(1)] })
    expect(within(block('production')).getByText('Nothing is on staging yet')).toBeTruthy()
  })
})

describe('Promote', () => {
  const deployable = (over: Partial<Environment> = {}) => [
    env({ version: 'v1.1', pullIds: ['acme/web#1'] }),
    env({ id: 'acme/web#production', name: 'production', order: 1, version: 'v1.0', needsApproval: true, deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' }, ...over }),
  ]

  it('is between two environments when the later one has a deploy workflow and differs', async () => {
    await delivery(deployable(), { pulls })
    expect(screen.getByRole('button', { name: 'Promote v1.1 to production' })).toBeTruthy()
  })

  it('isn’t there when the later one has no deploy workflow', async () => {
    await delivery(deployable({ deploy: undefined }), { pulls })
    expect(screen.queryByRole('button', { name: /Promote/ })).toBeNull()
  })

  it('isn’t there when the later one already has what the one before has', async () => {
    await delivery(deployable({ version: 'v1.1' }), { pulls })
    expect(screen.queryByRole('button', { name: /Promote/ })).toBeNull()
  })

  it('isn’t there while the later one is deploying, or when nothing is on the one before', async () => {
    await delivery(deployable({ state: 'deploying' }), { pulls })
    expect(screen.queryByRole('button', { name: /Promote/ })).toBeNull()
    cleanup()
    await delivery([env({ version: '' }), ...deployable().slice(1)], { pulls })
    expect(screen.queryByRole('button', { name: /Promote/ })).toBeNull()
  })

  it('asks first, then promotes with the id encoded in the path', async () => {
    standInHub(() => hubState({ environments: deployable(), pulls }), owner)
    const sent = standInRoute('POST', '/api/environments/acme%2Fweb%23production/promote', () => ({ ok: true }))
    await mount(<><Delivery /><Toast /></>)
    const button = screen.getByRole('button', { name: 'Promote v1.1 to production' })
    fireEvent.click(button)
    expect(sent).toEqual([])
    expect(button.textContent).toBe('Promote v1.1 to production? Press again')
    fireEvent.click(button)
    await waitFor(() => expect(sent.length).toBe(1))
    expect(calledOn()).toContain('POST /api/environments/acme%2Fweb%23production/promote')
    await toasted('Asked GitHub to deploy v1.1 to production.')
  })

  it('shows the hub’s refusal as it is', async () => {
    standInHub(() => hubState({ environments: deployable(), pulls }), owner)
    standInRoute('POST', '/api/environments/acme%2Fweb%23production/promote', () => new Response(JSON.stringify({ error: 'production is already deploying.' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    await mount(<><Delivery /><Toast /></>)
    const button = screen.getByRole('button', { name: 'Promote v1.1 to production' })
    fireEvent.click(button)
    fireEvent.click(button)
    await toasted('production is already deploying.')
  })

  it('is for anyone in the binder, not only its owners', async () => {
    await delivery(deployable(), { pulls }, member)
    expect(screen.getByRole('button', { name: 'Promote v1.1 to production' })).toBeTruthy()
  })
})

describe('for assistive technology', () => {
  it('finds nothing for axe to object to, with environments in every state and a Promote', async () => {
    await delivery([...twoRepos, env({ id: 'acme/web#qa', name: 'qa', order: 2, state: 'waiting', logUrl: 'https://github.com/acme/web/actions/runs/3' }), env({ id: 'acme/web#dev', name: 'dev', order: 3, version: 'v2', deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' } })], { pulls, changeSets: [set] })
    const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
  })
})
