// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, standInHub } from './harness'
import { Settings } from '../src/screens/Settings'

// Bringing a team's work in from Jira: what it shows before anything moves, and what it asks for.

const features = [{ key: 'BIND-900', title: 'Checkout', status: 'In Progress', stories: 4, stages: { ready: 1, working: 1, live: 1 }, leftOut: 1, here: 0, noted: false }]

function hub() {
  standInHub()
  window.localStorage.setItem('binders-settings-part', 'jira')
  const sent: { url: string; body?: unknown }[] = []
  const real = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url === '/api/jira/features') return json({ features })
    if (url === '/api/jira/import') {
      sent.push({ url, body: JSON.parse(String(init?.body)) })
      return json({ features: 1, stories: 3, already: 0, leftOut: ['BIND-904'] })
    }
    if (url === '/api/jira') return json({ on: true, mayManage: true, baseUrl: 'https://x.atlassian.net', email: 'a@x.test', tokenSet: true, project: 'BIND', stages: ['ready'], statuses: {} })
    if (url === '/api/jira/discover') return json({ who: 'Saver', projects: [] })
    return real(url, init)
  }))
  return sent
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('bringing in existing work', () => {
  it('shows how each feature’s stories stand, and keeps agents off them unless asked', async () => {
    const sent = hub()
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what’s in Jira' }))
    await screen.findByText(/4 stories: 1 not started, 1 in progress, 1 done, 1 left out/)
    screen.getByText(/no agent starts them until someone moves them to Ready/)
    expect((screen.getByRole('button', { name: /Bring in/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(document.getElementById('jira-feature-BIND-900')!)
    fireEvent.click(screen.getByRole('button', { name: 'Bring in 1 feature' }))
    await waitFor(() => expect(sent).toEqual([{ url: '/api/jira/import', body: { binderId: 'b1', keys: ['BIND-900'], agentsMayTake: false } }]))
  })

  it('says what letting agents take them means', async () => {
    const sent = hub()
    await mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'See what’s in Jira' }))
    fireEvent.click(await screen.findByLabelText(/Let agents take what hasn’t started/))
    screen.getByText(/any agent working in this binder can take them straight away/)
    fireEvent.click(document.getElementById('jira-feature-BIND-900')!)
    fireEvent.click(screen.getByRole('button', { name: 'Bring in 1 feature' }))
    await waitFor(() => expect((sent[0].body as { agentsMayTake: boolean }).agentsMayTake).toBe(true))
  })
})
