// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entry, hear, hubState, mount, settle, standInHub } from './harness'
import type { ChangeSet, PullRequest } from '../src/data/model'
import { UIContext } from '../src/ui'
import { ChangeSets } from '../src/screens/ChangeSets'

// Deleting a change set: what it does is said first, and nothing's sent unless the button is pressed twice.

const pull: PullRequest = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'https://github.com/acme/web/pull/7', state: 'open', checks: [], files: [] }
const set: ChangeSet = { id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'merging', prIds: [pull.id], noteIds: [] }
const state = () => hubState({ pulls: [pull], changeSets: [set], environments: [{ id: 'staging', name: 'Staging', url: '', version: '1', changeSetIds: [set.id], state: 'healthy', deployedAt: 'then', needsApproval: false }] })
const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const deletes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)

beforeEach(() => {
  standInHub(state)
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

describe('Deleting a change set', () => {
  it('says what it does, and sends nothing on the first press', async () => {
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    await settle(0)
    expect(screen.getByRole('button', { name: 'Delete change set #3? Press again' })).toBeTruthy()
    const said = document.querySelector('.set-foot')!.textContent!
    expect(said).toContain('Its merging stops.')
    expect(said).toContain('Its open pull request stays open on GitHub')
    expect(said).toContain('It also leaves Staging in Delivery.')
    expect(deletes()).toEqual([])
  })

  it('goes back to its own words when it isn’t pressed again', async () => {
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    await act(async () => { vi.advanceTimersByTime(4100) })
    expect(screen.getByRole('button', { name: 'Delete change set' })).toBeTruthy()
    expect(deletes()).toEqual([])
  })

  it('deletes it on the second press', async () => {
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set #3? Press again' }))
    await settle(0)
    expect(deletes()).toEqual(['/api/sets/set-3'])
  })

  it('doesn’t say the change set it just deleted isn’t here any more', async () => {
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set #3? Press again' }))
    await settle(0)
    // The hub says it’s gone, while the address still names it.
    await hear({ type: 'entries', entries: [entry(2, { type: 'set.delete', id: set.id })] })
    expect(screen.getByRole('heading', { name: 'No change sets yet' })).toBeTruthy()
    expect(screen.queryByText('That change set isn’t here any more')).toBeNull()
  })

  it('doesn’t ask the browser', async () => {
    const asked = vi.fn(() => true)
    vi.stubGlobal('confirm', asked)
    await mount(<UIContext.Provider value={ui}><ChangeSets id={set.id} /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete change set #3? Press again' }))
    expect(asked).not.toHaveBeenCalled()
  })
})
