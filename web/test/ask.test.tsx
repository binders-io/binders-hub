// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, standInHub, standInRoute } from './harness'
import { Ask } from '../src/screens/Ask'

// Ask: what it says when the hub has no model to answer with.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const source = { n: 1, binder: 'b1', binderName: 'Binder', kind: 'note', id: 'n1', title: 'The plan', text: 'The plan is to ship.', url: '#/notes/n1' }

describe('Ask without a model', () => {
  it('shows the passages that match, and points an admin at Settings → Brain as a link', async () => {
    standInHub(() => hubState())
    standInRoute('POST', '/api/brain/ask', () => ({ sources: [source], searchedBy: 'words' }))
    await mount(<Ask asked={{ question: 'What is the plan?', at: 1 }} />)
    const note = await screen.findByText(/The hub has no model to answer with yet/)
    expect(note.textContent).toContain('An admin can set one up in Settings → Brain.')
    expect(screen.getByRole('link', { name: 'Settings → Brain' }).getAttribute('href')).toBe('#/settings/brain')
  })
})
