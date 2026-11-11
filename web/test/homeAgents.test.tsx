// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, me, mount, standInHub } from './harness'
import { Home } from '../src/screens/Home'
import { UIContext } from '../src/ui'
import type { Activity } from '../src/data/model'

// Home's agents: one at work is a calm panel with its card and its last few steps, not its whole session; one holding
// nothing is a row that opens the Agents page. Over them, a greeting with the day, and the counts, each a line long.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {}, askQuestion: () => {} }
const step = (tool: string, text: string, result?: string): Activity => ({ at: 'then', by: 'a1', kind: 'step', tool, text, result })
const steps = [step('Read', 'one.ts'), step('Read', 'two.ts'), step('Edit', 'three.ts', '+3 −1'), step('Bash', 'npm test', '18 passed'), { at: 'then', by: 'a1', kind: 'said', text: 'Running the tests again.' } as Activity]
const world = () => hubState({
  agents: [{ ...agent, lastSeen: new Date().toISOString() }, { ...agent, id: 'a2', name: 'Idle one' }],
  cards: [card('c1', 'working', { title: 'Build the page', agentId: 'a1', doing: 'Testing it', activity: steps })],
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Home’s agents', () => {
  it('shows one at work as a panel: who, its card, and its last four steps', async () => {
    standInHub(world, me)
    await mount(<UIContext.Provider value={ui}><Home /></UIContext.Provider>)
    const panel = screen.getByRole('heading', { name: 'Agent' }).closest('article')!
    expect(within(panel).getByText('Working')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /Build the page/ }).textContent).toContain('Testing it')
    const last = within(panel).getByRole('list', { name: 'Last steps on Build the page' })
    expect(within(last).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Read two.ts', 'Edit three.ts · +3 −1', 'Bash npm test · 18 passed', 'Running the tests again.'])
    expect(panel.querySelector('.terminal')).toBeNull()
  })

  it('shows one holding nothing as a row that opens the Agents page', async () => {
    standInHub(world, me)
    await mount(<UIContext.Provider value={ui}><Home /></UIContext.Provider>)
    expect(screen.queryByRole('heading', { name: 'Idle one' })).toBeNull()
    const row = screen.getByRole('link', { name: /^Idle one/ })
    expect(row.getAttribute('href')).toBe('#/agents')
    expect(row.textContent).toContain('Its runner isn’t running.')
    expect(row.textContent).toContain('Not running')
  })

  it('greets you by your first name, with the day under it', async () => {
    standInHub(world, { ...me, user: { ...me.user, name: 'ada lovelace' } })
    await mount(<UIContext.Provider value={ui}><Home /></UIContext.Provider>)
    expect(screen.getByRole('heading', { level: 2, name: /^Good (morning|afternoon|evening), Ada$/ })).toBeTruthy()
    expect(screen.getByText(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))).toBeTruthy()
  })

  it('keeps each count’s line to one line, whole on hover', async () => {
    standInHub(world, me)
    await mount(<UIContext.Provider value={ui}><Home /></UIContext.Provider>)
    const tile = screen.getByRole('button', { name: /Working now/ })
    const line = tile.querySelector('.stat-detail')!
    expect(line.getAttribute('title')).toBe(line.textContent)
  })
})
