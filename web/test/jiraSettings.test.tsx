// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'

// Connecting to Jira fills the mapping in from what Jira has, for a person to check and save.

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
  project: { key: 'BIND', name: 'Binders', types: [epic, story, task], suggested: { noteIssueType: 'Epic', issueType: 'Story' } },
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

describe('connecting a binder to Jira', () => {
  it('fills in the project, the types and the stages from Jira, and saves what it shows', async () => {
    const sent = jiraAnswering(fresh)
    await mount(<Settings />)
    fireEvent.change(await screen.findByPlaceholderText('https://yourcompany.atlassian.net'), { target: { value: 'https://acme.atlassian.net' } })
    fireEvent.change(screen.getByPlaceholderText('its email'), { target: { value: 'saver@acme.test' } })
    fireEvent.change(screen.getByPlaceholderText('The token'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Jira' }))
    await screen.findByText('Connected as Binders Saver.')
    await waitFor(() => expect(value('jira-project')).toBe('BIND'))
    expect(value('jira-note-type')).toBe('Epic')
    expect(value('jira-card-type')).toBe('Story')
    expect(value('jira-stage-working')).toBe('Building')
    expect(value('jira-stage-blocked')).toBe('')
    screen.getByText(/Nothing in this workflow looks like blocked/)

    fireEvent.change(document.getElementById('jira-card-type')!, { target: { value: 'Task' } })
    expect(value('jira-stage-ready')).toBe('Open')
    fireEvent.change(document.getElementById('jira-card-type')!, { target: { value: 'Story' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true))
    expect(sent.find((s) => s.method === 'PUT')!.body).toMatchObject({ project: 'BIND', issueType: 'Story', noteIssueType: 'Epic', statuses: story.suggested.statuses })
  })

  it('leaves a saved mapping as it is on opening, until a person asks Jira to fill it in again', async () => {
    jiraAnswering({ ...fresh, on: true, baseUrl: 'https://acme.atlassian.net', email: 'saver@acme.test', tokenSet: true, hint: '…ok', project: 'BIND', issueType: 'Story', statuses: { ready: 'Retired status' } })
    await mount(<Settings />)
    await screen.findByText('Connected as Binders Saver.')
    expect(value('jira-note-type')).toBe('')
    expect(value('jira-stage-ready')).toBe('Retired status')
    fireEvent.click(screen.getByRole('button', { name: 'Fill in from Jira again' }))
    expect(value('jira-note-type')).toBe('Epic')
    expect(value('jira-stage-ready')).toBe('Backlog')
  })
})
