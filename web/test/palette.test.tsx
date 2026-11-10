// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, mount, standInHub } from './harness'
import { Palette } from '../src/components/Palette'
import { UIContext } from '../src/ui'
import type { ChangeSet, PullRequest } from '../src/data/model'

// ⌘K finds every change set, and pull requests by number, title or repo, and takes you to what each is about.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

const pull = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Pull ${number}`, branch: `b${number}`, url: '', state: 'open', checks: [], files: [], ...over })
const set = (id: string, number: number, over: Partial<ChangeSet> = {}): ChangeSet => ({ id, binderId: 'b1', number, title: `Set ${number}`, summary: '', state: 'review', prIds: [], noteIds: [], ...over })

const open = async (world: Parameters<typeof hubState>[0]) => {
  const openItem = vi.fn()
  standInHub(() => hubState(world))
  await mount(<UIContext.Provider value={{ openItem, openPalette: () => {}, binder: 'all', setBinder: () => {} }}><Palette onClose={() => {}} /></UIContext.Provider>)
  return openItem
}
const type = (text: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value: text } })
const group = (name: string) => within(screen.getByRole('group', { name }))
const rows = (name: string) => group(name).getAllByRole('option').map((o) => o.textContent)

describe('change sets in ⌘K', () => {
  const sets = [set('s1', 3, { state: 'review' }), set('s2', 4, { state: 'merging' }), set('s3', 5, { state: 'shipped' }), set('s4', 6, { state: 'assembling' })]

  it('lists every change set, whatever its state, not only the one in review', async () => {
    await open({ changeSets: sets })
    type('change set')
    expect(rows('Change sets')).toEqual(['Change set #6: Set 6Binder', 'Change set #5: Set 5Binder', 'Change set #4: Set 4Binder', 'Change set #3: Set 3Binder'])
  })

  it('finds one by its number and opens it', async () => {
    await open({ changeSets: sets })
    type('#5')
    fireEvent.click(group('Change sets').getByRole('option', { name: /Change set #5/ }))
    expect(window.location.hash).toBe('#/changes/s3')
  })

  it('doesn’t list them before anything is typed', async () => {
    await open({ changeSets: sets, pulls: [pull(1)] })
    expect(screen.queryByRole('group', { name: 'Change sets' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Pull requests' })).toBeNull()
  })
})

describe('pull requests in ⌘K', () => {
  const world = {
    pulls: [pull(482, { title: 'Fix the header' }), pull(48, { title: 'Older work', repo: 'acme/api' }), pull(9, { title: 'No home' })],
    cards: [card('c1', 'review', { prId: 'acme/web#482' })],
    changeSets: [set('s1', 3, { prIds: ['acme/web#48'] })],
  }

  it('finds one by "#482" or by "482", with its title and repo', async () => {
    await open(world)
    type('#482')
    expect(rows('Pull requests')).toEqual(['#482 Fix the headeracme/web'])
    type('482')
    expect(rows('Pull requests')).toEqual(['#482 Fix the headeracme/web'])
  })

  it('finds one by its title or its repo', async () => {
    await open(world)
    type('older')
    expect(rows('Pull requests')).toEqual(['#48 Older workacme/api'])
    type('acme/api')
    expect(rows('Pull requests')).toEqual(['#48 Older workacme/api'])
  })

  it('opens its card when it has one', async () => {
    const openItem = await open(world)
    type('482')
    fireEvent.click(group('Pull requests').getByRole('option', { name: /#482/ }))
    expect(openItem).toHaveBeenCalledWith('c1')
    expect(window.location.hash).toBe('')
  })

  it('opens its change set when it has no card', async () => {
    const openItem = await open(world)
    type('older')
    fireEvent.click(group('Pull requests').getByRole('option', { name: /#48 / }))
    expect(window.location.hash).toBe('#/changes/s1')
    expect(openItem).not.toHaveBeenCalled()
  })

  it('leaves out one with neither, as there’s nowhere here to take you', async () => {
    await open(world)
    type('No home')
    expect(screen.queryByRole('option', { name: /#9 / })).toBeNull()
  })
})
