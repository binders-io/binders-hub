// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calledOn, hubState, standInHub, standInRoute } from './harness'
import { BlastView } from '../src/components/Challenge'
import type { BlastRadius } from '../../shared/changeSet.ts'

// A Challenge's blast radius in a browser’s state has its counts and not its symbols: the list asks for them when it's opened.

const symbols = [{ name: 'parse', file: 'src/a.ts', change: 'removed' as const, uses: [{ file: 'src/b.ts', line: 12, text: 'parse(x)' }], tests: [] }]
const left = (over: Partial<BlastRadius> = {}): BlastRadius => ({ at: 't1', repo: 'acme/web', symbols: [], symbolCount: 21, outside: 4, stillUsed: 1, untested: 0, ...over })
const asked = (path: string) => calledOn().filter((c) => c === `GET ${path}`).length

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('what else a change touches, when its symbols were left out', () => {
  it('counts the symbols from symbolCount, and asks for nothing until the list is opened', () => {
    standInHub(() => hubState())
    standInRoute('GET', '/api/cards/c1/blast', () => ({ blast: { ...left(), symbols } }))
    render(<BlastView blast={left()} of={{ kind: 'card', id: 'c1' }} />)
    expect(screen.getByText('21 changed symbols')).toBeTruthy()
    expect(asked('/api/cards/c1/blast')).toBe(0)
  })

  it('asks the card for them when opened, says it is loading, and shows them', async () => {
    standInHub(() => hubState())
    let give: (answer: unknown) => void = () => {}
    standInRoute('GET', '/api/cards/c1/blast', () => new Promise((done) => { give = done }))
    render(<BlastView blast={left()} of={{ kind: 'card', id: 'c1' }} />)
    fireEvent.click(screen.getByRole('button', { name: /What else this touches/ }))
    expect(screen.getByText('Loading…')).toBeTruthy()
    await waitFor(() => expect(asked('/api/cards/c1/blast')).toBe(1))
    give({ blast: { ...left(), symbols } })
    expect(await screen.findByText('parse')).toBeTruthy()
    expect(screen.getByText('src/b.ts:12')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('21 changed symbols')).toBeTruthy()
  })

  it('asks the change set’s own address for a change set’s', async () => {
    standInHub(() => hubState())
    standInRoute('GET', '/api/sets/s%201/blast', () => ({ blast: { ...left(), symbols } }))
    render(<BlastView blast={left()} of={{ kind: 'set', id: 's 1' }} />)
    fireEvent.click(screen.getByRole('button', { name: /What else this touches/ }))
    expect(await screen.findByText('parse')).toBeTruthy()
    expect(asked('/api/sets/s%201/blast')).toBe(1)
  })

  it('says they could not be loaded, with Try again, which asks again', async () => {
    standInHub(() => hubState())
    let works = false
    standInRoute('GET', '/api/cards/c1/blast', () => (works ? { blast: { ...left(), symbols } } : new Response(JSON.stringify({ error: 'No' }), { status: 500 })))
    render(<BlastView blast={left()} of={{ kind: 'card', id: 'c1' }} />)
    fireEvent.click(screen.getByRole('button', { name: /What else this touches/ }))
    const again = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByText(/couldn’t be loaded/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    works = true
    fireEvent.click(again)
    expect(await screen.findByText('parse')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(asked('/api/cards/c1/blast')).toBe(2)
  })

  it('asks again when a new blast arrives, and shows a whole one without asking', async () => {
    standInHub(() => hubState())
    standInRoute('GET', '/api/cards/c1/blast', () => ({ blast: { ...left(), symbols } }))
    const { rerender } = render(<BlastView blast={left()} of={{ kind: 'card', id: 'c1' }} />)
    fireEvent.click(screen.getByRole('button', { name: /What else this touches/ }))
    await screen.findByText('parse')
    rerender(<BlastView blast={left({ at: 't2' })} of={{ kind: 'card', id: 'c1' }} />)
    await waitFor(() => expect(asked('/api/cards/c1/blast')).toBe(2))
    cleanup()
    render(<BlastView blast={{ ...left(), symbols, symbolCount: undefined }} of={{ kind: 'card', id: 'c2' }} />)
    fireEvent.click(screen.getByRole('button', { name: /What else this touches/ }))
    expect(screen.getByText('parse')).toBeTruthy()
    expect(screen.getByText('1 changed symbol')).toBeTruthy()
    expect(asked('/api/cards/c2/blast')).toBe(0)
  })
})
