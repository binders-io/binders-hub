// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, settle, standInHub } from './harness'
import type { ChangeSet, PullRequest } from '../src/data/model'
import { UIContext } from '../src/ui'
import { ChangeSets } from '../src/screens/ChangeSets'

// Deleting a change set: what it does is said first, and nothing's sent unless the person says yes.

const pull: PullRequest = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'https://github.com/acme/web/pull/7', state: 'open', checks: [], files: [] }
const set: ChangeSet = { id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'merging', prIds: [pull.id], noteIds: [] }
const state = () => hubState({ pulls: [pull], changeSets: [set], environments: [{ id: 'staging', name: 'Staging', url: '', version: '1', changeSetIds: [set.id], state: 'healthy', deployedAt: 'then', needsApproval: false }] })
const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const deletes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)

beforeEach(() => {
  standInHub(state)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Deleting a change set', () => {
  it('says what it does, and sends nothing when the person says no', async () => {
    const asked = vi.fn(() => false)
    vi.stubGlobal('confirm', asked)
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    await settle(0)
    const said = String((asked.mock.calls as unknown as string[][])[0][0])
    expect(said).toContain('Delete change set #3?')
    expect(said).toContain('Its merging stops.')
    expect(said).toContain('Its open pull request stays open on GitHub')
    expect(said).toContain('It also leaves Staging in Delivery.')
    expect(deletes()).toEqual([])
  })

  it('deletes it when the person says yes', async () => {
    vi.stubGlobal('confirm', () => true)
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    await settle(0)
    expect(deletes()).toEqual(['/api/sets/set-3'])
  })
})
