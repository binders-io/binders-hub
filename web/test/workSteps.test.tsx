// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, mount, standInHub } from './harness'
import { Work } from '../src/screens/Work'
import { UIContext } from '../src/ui'
import type { Environment, PullRequest } from '../src/data/model'

// The steps along the top of a card's page: after "Merged", one for each environment of its pull request's repo.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: '', state: 'merged', checks: [], files: [], cardId: 'c1', agentId: 'a1', ...over })
const env = (name: string, order: number, over: Partial<Environment> = {}): Environment => ({ id: `acme/web#${name}`, repo: 'acme/web', name, url: '', version: '', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order, ...over })

const page = (environments: Environment[], over: Partial<PullRequest> = {}) => {
  standInHub(() => hubState({ cards: [card('c1', 'live', { agentId: 'a1', prId: 'acme/web#7' })], pulls: [pull(over)], environments }))
  return mount(<UIContext.Provider value={ui}><Work id="c1" /></UIContext.Provider>)
}

/** Each step as the page shows it: its name, what it says, and whether it's done. */
const steps = () => within(screen.getByRole('list', { name: 'Where it is' })).getAllByRole('listitem').map((li) => ({ title: li.querySelector('b')!.textContent, detail: li.querySelector('em')!.textContent, state: li.className }))
const afterMerged = () => steps().slice(steps().findIndex((s) => s.title === 'Merged') + 1)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the steps on a card’s page', () => {
  it('has one step per environment of its repo after Merged, in order', async () => {
    await page([env('production', 1), env('staging', 0), env('qa', 2)])
    expect(afterMerged().map((s) => s.title)).toEqual(['staging', 'production', 'qa'])
  })

  it('is done once its pull request is on the environment, saying what’s on it', async () => {
    await page([env('staging', 0, { version: 'v1.2', pullIds: ['acme/web#7'] }), env('production', 1, { version: 'v1.0', pullIds: [] })])
    const [staging, production] = afterMerged()
    expect(staging).toEqual({ title: 'staging', detail: 'v1.2', state: 'done' })
    // It’s the one that comes next, after the one before it.
    expect(production).toEqual({ title: 'production', detail: 'After staging', state: 'now' })
  })

  it('says the first waits for the merge, and doesn’t count a card as done just for being closed', async () => {
    await page([env('staging', 0, { version: 'v1.2', pullIds: ['acme/web#8'] })])
    expect(afterMerged()).toEqual([{ title: 'staging', detail: 'After merging', state: 'now' }])
  })

  it('has no environment steps for a repo with none, and none for another repo’s', async () => {
    await page([env('staging', 0, { repo: 'acme/api', id: 'acme/api#staging' })])
    expect(afterMerged()).toEqual([])
    expect(steps().map((s) => s.title)).not.toContain('staging')
    expect(steps().map((s) => s.title)).not.toContain('Staging')
    expect(steps().map((s) => s.title)).not.toContain('Production')
  })

  it('has none for a card with no pull request', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'working', { agentId: 'a1' })], environments: [env('staging', 0)] }))
    await mount(<UIContext.Provider value={ui}><Work id="c1" /></UIContext.Provider>)
    expect(steps().map((s) => s.title)).not.toContain('staging')
  })
})
