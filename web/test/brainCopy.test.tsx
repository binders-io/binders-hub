// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrainPanel } from '../src/components/BrainPanel'

// Copying the line that links a machine, which a browser may not allow.

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** What the toasts said, and whether each was bad news. */
function toasts() {
  const said: { message: string; bad?: boolean }[] = []
  window.addEventListener('binders-refused', (event) => said.push((event as CustomEvent<{ message: string; bad?: boolean }>).detail))
  return said
}

async function openTheLine(copied: () => Promise<void>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/brain') return json({ brain: {}, admin: true })
    if (url === '/api/brain/machines') return json({ machines: [] })
    if (url === '/api/brain/machines/command') return json({ install: 'curl https://hub.test/install | sh', expiresAt: '2026-11-10T10:00:00.000Z' })
    return json({})
  }))
  Object.assign(navigator, { clipboard: { writeText: copied } })
  render(<BrainPanel />)
  fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add a machine' })
  fireEvent.click(within(dialog).getByRole('button', { name: /Lending the hub its models/ }))
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy the line' }))
}

describe('copying the line that links a machine', () => {
  it('says so as good news when it copied', async () => {
    const said = toasts()
    await openTheLine(async () => {})
    await waitFor(() => expect(said).toEqual([expect.objectContaining({ message: 'Copied. Paste it in a terminal on each machine.' })]))
    expect(said[0].bad).toBeUndefined()
  })

  it('says it as news that went wrong when the browser wouldn’t', async () => {
    const said = toasts()
    await openTheLine(async () => { throw new Error('denied') })
    await waitFor(() => expect(said).toEqual([expect.objectContaining({ message: 'Couldn’t copy it: select it and copy it yourself.', bad: true })]))
  })
})
