// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Toast } from '../src/components/Toast'
import { unreachable } from '../src/data/api'
import { MarkdownEditor, type EditorHandle } from '../src/editor/MarkdownEditor'
import { insertPictures } from '../src/editor/pictures'

// A picture that doesn't go up is said as a failure, in words a person can use.

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function send(fetchIt: () => Promise<Response>) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(fetchIt))
  const ref = createRef<EditorHandle>()
  render(<><Toast /><MarkdownEditor ref={ref} text="# Plan" onChange={() => {}} links={{ titles: () => [], exists: () => false, open: () => {} }} marks={{ work: [], open: () => {} }} raw={false} noteId="n1" /></>)
  const view = ref.current!.view()!
  await insertPictures(view, [new File(['x'], 'shot.png', { type: 'image/png' })], view.state.doc.length)
  return view
}

describe('a picture that doesn’t go up', () => {
  it('is an alert with what the hub said', async () => {
    const view = await send(async () => new Response(JSON.stringify({ error: 'That picture is too big.' }), { status: 413, headers: { 'content-type': 'application/json' } }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That picture is too big.'))
    expect(view.state.doc.toString()).not.toContain('Sending')
  })

  it('says the hub can’t be reached rather than the browser’s own words', async () => {
    await send(async () => { throw new TypeError('Failed to fetch') })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(unreachable))
  })
})
