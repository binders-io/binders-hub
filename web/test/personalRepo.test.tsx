// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalRepo } from '../src/components/PersonalRepo'

// A personal binder's notes repo: the step left, and where to take it.

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('keeping your notes in your own GitHub', () => {
  it('links straight to Settings → GitHub, by its address, to set it up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ app: false, installed: false, signedIn: true, suggested: 'you/binders-notes', oauth: false, connected: false })))
    render(<PersonalRepo />)
    const link = await screen.findByRole('link', { name: 'Set it up' })
    expect(link.getAttribute('href')).toBe('#/settings/github')
  })
})
