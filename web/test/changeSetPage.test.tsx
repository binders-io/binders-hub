// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, standInHub } from './harness'
import { ChangeSets } from '../src/screens/ChangeSets'
import { UIContext } from '../src/ui'
import type { ChangeSet, PullRequest } from '../src/data/model'

// A change set's page: what its tabs say of the debrief and the review, and a link to one that's gone.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const pull: PullRequest = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'https://github.com/acme/web/pull/7', state: 'open', checks: [], files: [] }
const set = (over: Partial<ChangeSet> = {}): ChangeSet => ({ id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'review', prIds: [pull.id], noteIds: [], ...over })
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString()
const open = (sets: ChangeSet[], id = 'set-3') => {
  standInHub(() => hubState({ pulls: [pull], changeSets: sets }))
  return mount(<UIContext.Provider value={ui}><ChangeSets id={id} /></UIContext.Provider>)
}
const tab = (name: string) => within(screen.getByRole('tab', { name: new RegExp(`^${name}`) }))

describe('the debrief and Challenge tabs', () => {
  const debrief = (state: 'asked' | 'writing', askedAt: string) => ({ state, askedBy: 'you', askedAt, agentId: 'a1' }) as ChangeSet['debrief']
  const challenge = (state: 'asked' | 'reviewing', askedAt: string) => ({ state, askedBy: 'you', askedAt, agentId: 'a1', picked: 'hub', authors: [] }) as ChangeSet['challenge']

  it('say it’s being written or reviewed while the agent has had it a short while', async () => {
    await open([set({ debrief: debrief('writing', hoursAgo(0.1)), challenge: challenge('reviewing', hoursAgo(0.1)) })])
    expect(tab('Debrief').getByText('writing…')).toBeTruthy()
    expect(tab('Challenge').getByText('reviewing…')).toBeTruthy()
  })

  it('say it went quiet, as the card’s page does, once nothing has come of it for over half an hour', async () => {
    await open([set({ debrief: debrief('writing', hoursAgo(2)), challenge: challenge('reviewing', hoursAgo(2)) })])
    expect(tab('Debrief').getByText('went quiet')).toBeTruthy()
    expect(tab('Challenge').getByText('went quiet')).toBeTruthy()
    expect(screen.queryByText('writing…')).toBeNull()
    expect(screen.queryByText('reviewing…')).toBeNull()
  })

  it('say it never started when it was asked and no agent took it in that time', async () => {
    await open([set({ debrief: debrief('asked', hoursAgo(2)), challenge: challenge('asked', hoursAgo(2)) })])
    expect(tab('Debrief').getByText('not started')).toBeTruthy()
    expect(tab('Challenge').getByText('not started')).toBeTruthy()
  })
})

describe('a link to a change set that’s gone', () => {
  it('says so, with the way to the list, instead of opening the first one', async () => {
    await open([set()], 'set-99')
    expect(screen.getByRole('heading', { name: 'That change set isn’t here any more' })).toBeTruthy()
    expect(screen.queryByText('Change set #3 · Pages')).toBeNull()
    expect(screen.getByRole('link', { name: 'Go to the change sets' }).getAttribute('href')).toBe('#/changes')
  })

  it('still opens the first when there’s no address, and the set when it’s there', async () => {
    await open([set()], '')
    expect(screen.getByRole('heading', { name: /Change set #3/ })).toBeTruthy()
    cleanup()
    await open([set()])
    expect(screen.getByRole('heading', { name: /Change set #3/ })).toBeTruthy()
  })
})

describe('on a phone', () => {
  const phone = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 900px)', media: query, addEventListener() {}, removeEventListener() {} }))

  it('lists the sets first, each a link to its own page, and opens none of them', async () => {
    standInHub(() => hubState({ pulls: [pull], changeSets: [set(), set({ id: 'set-2', number: 2, title: 'Older', state: 'shipped' })] }))
    phone()
    await mount(<UIContext.Provider value={ui}><ChangeSets id="" /></UIContext.Provider>)
    const nav = screen.getByRole('navigation', { name: 'Change sets' })
    expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['#3 PagesWaiting on you · 1 pull request', '#/changes/set-3'],
      ['#2 OlderShipped · 1 pull request', '#/changes/set-2'],
    ])
    expect(screen.queryByRole('heading', { name: /Change set #3/ })).toBeNull()
  })

  it('has a set on its own, with the way back to the list', async () => {
    standInHub(() => hubState({ pulls: [pull], changeSets: [set()] }))
    phone()
    await mount(<UIContext.Provider value={ui}><ChangeSets id="set-3" /></UIContext.Provider>)
    expect(screen.getByRole('heading', { name: /Change set #3/ })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Change sets' })).toBeNull()
    expect(screen.getByRole('link', { name: 'All change sets' }).getAttribute('href')).toBe('#/changes')
  })
})

describe('the tabs', () => {
  it('move with the arrow keys, as a tab list’s do', async () => {
    await open([set()])
    const changes = screen.getByRole('tab', { name: /^Pull requests/ })
    changes.focus()
    fireEvent.keyDown(changes, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: /^Debrief/ }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Debrief/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: /^Challenge/ }).getAttribute('aria-selected')).toBe('true')
  })
})
