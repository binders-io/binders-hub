// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calledOn, card, entry, hear, hubState, mount, standInHub, standInRoute } from './harness'
import { Work } from '../src/screens/Work'
import { withHistory } from '../src/data/sync'
import { UIContext } from '../src/ui'
import type { Activity } from '../src/data/model'

// A card’s page asks for its whole history when it opens, because the state a browser loads has only the recent lines of
// it and the number it left out.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const page = () => mount(<UIContext.Provider value={ui}><Work id="c1" /></UIContext.Provider>)
const said = (n: number, at = `2026-11-0${n}T10:00:00.000Z`): Activity => ({ at, by: 'you', kind: 'comment', text: `comment ${n}` })
const asked = () => calledOn().filter((c) => c === 'GET /api/cards/c1/activity').length
/** The comments in the conversation, in the order shown. */
const comments = () => Array.from(document.querySelectorAll('.conversation li p')).map((p) => p.textContent)

/** A card with its two newest lines and five left out, as the hub sends it. */
const trimmed = () => hubState({ cards: [card('c1', 'review', { activity: [said(4), said(5)], activityMore: 3 })] })
const whole = [1, 2, 3, 4, 5].map((n) => said(n))

beforeEach(() => {
  window.location.hash = ''
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('putting a card’s history together', () => {
  it('is the whole of it, with what came live after in order, and what’s in both once', () => {
    expect(withHistory([said(4), said(5)], whole)).toEqual(whole)
    expect(withHistory([said(4), said(5), said(6)], whole).map((a) => a.text)).toEqual(['comment 1', 'comment 2', 'comment 3', 'comment 4', 'comment 5', 'comment 6'])
    // The whole was read before the newest line came, and the tab holds it.
    expect(withHistory([said(4), said(5), said(6)], whole.slice(0, 4)).map((a) => a.text)).toEqual(['comment 1', 'comment 2', 'comment 3', 'comment 4', 'comment 5', 'comment 6'])
    expect(withHistory([], whole)).toBe(whole)
  })

  it('keeps the same words said twice at the same moment as often as they were said', () => {
    const twice = [said(1), said(1)]
    expect(withHistory([said(1)], twice)).toEqual(twice)
    expect(withHistory([said(1), said(1), said(1)], twice)).toHaveLength(3)
  })
})

describe('a card’s page', () => {
  it('shows what the state has while the rest comes, then all of it', async () => {
    standInHub(trimmed)
    let give = (_: unknown) => {}
    standInRoute('GET', '/api/cards/c1/activity', () => new Promise((done) => { give = done }))
    await page()
    expect(comments()).toEqual(['comment 4', 'comment 5'])
    await waitFor(() => expect(asked()).toBe(1))
    give({ activity: whole })
    await waitFor(() => expect(comments()).toEqual(['comment 1', 'comment 2', 'comment 3', 'comment 4', 'comment 5']))
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('adds lines that arrive live after, in order and without doubles, whether they came before the history or after', async () => {
    standInHub(trimmed)
    let give = (_: unknown) => {}
    standInRoute('GET', '/api/cards/c1/activity', () => new Promise((done) => { give = done }))
    await page()
    await waitFor(() => expect(asked()).toBe(1))
    // One arrives while the history is on its way, and the history has it.
    await hear({ type: 'entries', entries: [entry(2, { type: 'card.activity', id: 'c1', activity: said(6) })] })
    expect(comments()).toEqual(['comment 4', 'comment 5', 'comment 6'])
    give({ activity: [...whole, said(6)] })
    await waitFor(() => expect(comments()).toHaveLength(6))
    expect(comments()).toEqual(['comment 1', 'comment 2', 'comment 3', 'comment 4', 'comment 5', 'comment 6'])
    // Another after it.
    await hear({ type: 'entries', entries: [entry(3, { type: 'card.activity', id: 'c1', activity: said(7) })] })
    expect(comments()).toEqual(['comment 1', 'comment 2', 'comment 3', 'comment 4', 'comment 5', 'comment 6', 'comment 7'])
  })

  it('says it didn’t load, keeps what it has, and tries again when asked', async () => {
    standInHub(trimmed)
    let works = false
    standInRoute('GET', '/api/cards/c1/activity', () => (works ? { activity: whole } : new Response(JSON.stringify({ error: 'No' }), { status: 500 })))
    await page()
    const again = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByText(/older part of what it did didn’t load/)).toBeTruthy()
    expect(comments()).toEqual(['comment 4', 'comment 5'])
    works = true
    fireEvent.click(again)
    await waitFor(() => expect(comments()).toHaveLength(5))
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(asked()).toBe(2)
  })

  it('asks for nothing when the state left nothing out, as one from before this, or a short card’s, doesn’t', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'review', { activity: [said(4), said(5)] })] }))
    await page()
    expect(comments()).toEqual(['comment 4', 'comment 5'])
    expect(asked()).toBe(0)
  })
})
