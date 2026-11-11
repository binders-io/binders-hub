// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'
import { ContextMenuHost } from '../src/components/ContextMenu'

// Connecting to Jira is a guided dialog that fills the mapping in from what Jira has, for a person to check and save;
// once connected, a summary to change it from.

const story = {
  name: 'Story',
  level: 0,
  statuses: [{ name: 'Backlog', category: 'new' }, { name: 'Building', category: 'indeterminate' }, { name: 'QA', category: 'indeterminate' }, { name: 'Shipped', category: 'done' }],
  suggested: { statuses: { ready: 'Backlog', working: 'Building', review: 'QA', live: 'Shipped' }, inbound: {}, unmatched: ['blocked'] },
}
const task = { name: 'Task', level: 0, statuses: [{ name: 'Open', category: 'new' }], suggested: { statuses: { ready: 'Open' }, inbound: {}, unmatched: [] } }
const epic = { name: 'Epic', level: 1, statuses: [], suggested: { statuses: {}, inbound: {}, unmatched: [] } }
const discovered = {
  who: 'Binders Saver',
  projects: [{ key: 'BIND', name: 'Binders' }],
  project: { key: 'BIND', name: 'Binders', sprintBoards: [{ id: 9, name: 'Team board' }], sprintBoard: 9, pointFields: [{ id: 'customfield_10016', name: 'Story Points', kind: 'number' }, { id: 'customfield_10600', name: 'T-shirt', kind: 'option' }], types: [epic, story, task], suggested: { noteIssueType: 'Epic', issueType: 'Story' } },
}

function jiraAnswering(saved: object) {
  standInHub()
  window.localStorage.setItem('binders-settings-part', 'jira')
  const sent: { url: string; method?: string; body?: Record<string, unknown> }[] = []
  const hub = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/api/jira')) return hub(url, init)
    sent.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = url === '/api/jira/discover' ? discovered : init?.method === 'PUT' ? { on: true } : saved
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
  return sent
}
const value = (id: string) => (document.getElementById(id) as HTMLSelectElement).value
const fresh = { on: false, mayManage: true, stages: ['ready', 'working', 'blocked', 'review', 'live'] }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }))
const back = () => fireEvent.click(screen.getByRole('button', { name: 'Back' }))

describe('connecting a binder to Jira', () => {
  it('is a guided dialog: where, who, then the project and how it maps, filled in from Jira, and saves what it shows', async () => {
    const sent = jiraAnswering(fresh)
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: /Connect to Jira/ }))
    expect(await screen.findByRole('heading', { name: 'Where is your Jira?' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('https://yourcompany.atlassian.net'), { target: { value: 'https://acme.atlassian.net' } })
    next()
    expect(await screen.findByRole('heading', { name: 'Who signs in?' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('its email'), { target: { value: 'saver@acme.test' } })
    fireEvent.change(screen.getByPlaceholderText('The token'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByText('Connected as Binders Saver.')
    expect(screen.getByRole('heading', { name: 'Which project?' })).toBeTruthy()
    await waitFor(() => expect(value('jira-project')).toBe('BIND'))
    expect(value('jira-note-type')).toBe('Epic')
    expect(value('jira-card-type')).toBe('Story')
    next()
    expect(await screen.findByRole('heading', { name: 'How it maps' })).toBeTruthy()
    expect(value('jira-stage-working')).toBe('Building')
    expect(value('jira-stage-blocked')).toBe('')
    expect(value('jira-sprint-board')).toBe('9')
    screen.getByText(/Nothing in this workflow looks like blocked/)

    // Another card type fills the stages in from its own workflow.
    back()
    fireEvent.change(document.getElementById('jira-card-type')!, { target: { value: 'Task' } })
    next()
    expect(value('jira-stage-ready')).toBe('Open')
    back()
    fireEvent.change(document.getElementById('jira-card-type')!, { target: { value: 'Story' } })
    next()
    fireEvent.change(document.getElementById('jira-points-field')!, { target: { value: 'customfield_10600' } })
    expect(value('jira-points-M')).toBe('M')
    fireEvent.change(document.getElementById('jira-points-M')!, { target: { value: 'Medium' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true))
    expect(sent.find((s) => s.method === 'PUT')!.body).toMatchObject({ project: 'BIND', issueType: 'Story', noteIssueType: 'Epic', statuses: story.suggested.statuses, sprintBoard: 9, pointsField: 'customfield_10600', pointsKind: 'option', points: { S: 'S', M: 'Medium', L: 'L' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('once connected, sums it up, and leaves a saved mapping as it is until a person asks Jira to fill it in again', async () => {
    jiraAnswering({ ...fresh, on: true, baseUrl: 'https://acme.atlassian.net', email: 'saver@acme.test', tokenSet: true, hint: '…ok', project: 'BIND', issueType: 'Story', statuses: { ready: 'Retired status' } })
    await mount(<Settings />)
    const connection = await screen.findByRole('button', { name: /^BIND on acme\.atlassian\.net/ })
    expect(connection.textContent).toContain('Signed in as saver@acme.test')
    expect(connection.textContent).toContain('Connected')
    fireEvent.click(screen.getByRole('button', { name: /^How it maps/ }))
    await screen.findByText('Connected as Binders Saver.')
    expect(value('jira-note-type')).toBe('')
    next()
    expect(value('jira-stage-ready')).toBe('Retired status')
    fireEvent.click(screen.getByRole('button', { name: 'Fill in from Jira again' }))
    expect(value('jira-stage-ready')).toBe('Backlog')
    back()
    expect(value('jira-note-type')).toBe('Epic')
  })

  it('disconnects from the connection’s menu, after asking', async () => {
    const sent = jiraAnswering({ ...fresh, on: true, baseUrl: 'https://acme.atlassian.net', email: 'saver@acme.test', tokenSet: true, project: 'BIND', issueType: 'Story', statuses: {} })
    await mount(<><Settings /><ContextMenuHost /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'More for Jira' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }))
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect? Press again' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE' && s.url === '/api/jira')).toBe(true))
  })
})
