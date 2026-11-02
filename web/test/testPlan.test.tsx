// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, hubState, mount, settle, standInHub } from './harness'
import { DebriefView } from '../src/components/Debrief'
import type { Debrief } from '../../shared/changeSet.ts'

// A debrief's functional test plan, on a card: each test as someone runs it, and how it went.

const debrief: Debrief = {
  state: 'done', askedBy: 'you', askedAt: 'then', agentId: 'a1', writtenAt: '2026-11-01T10:00:00.000Z', source: 'pull',
  does: 'Adds a health check.', changes: [{ area: 'Server', what: 'A route.' }], against: [{ point: 'GET /health answers 200', mark: 'met', where: 'src/a.ts' }], lookAt: [], tryIt: 'npm start',
  testPlan: [
    { id: 't1', title: 'Health answers 200', point: 'GET /health answers 200', steps: ['npm start', 'curl -i /health'], expect: 'HTTP 200.', risk: 'high' },
    { id: 't2', title: 'Ready fails without Redis', setup: 'Stop Redis.', steps: ['curl -i /ready'], expect: 'HTTP 503.', result: { outcome: 'passed', by: 'you', at: '2026-11-01T11:00:00.000Z' } },
  ],
}
const withPlan = () => hubState({ cards: [card('c1', 'review', { debrief })] })
let posted: ReturnType<typeof standInHub>['posted']

beforeEach(() => {
  posted = standInHub(withPlan).posted
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sent = () => posted.flatMap((p) => p.changes.map((c) => c.change))

describe('a functional test plan', () => {
  it('shows each test: what it proves, its steps, what to expect, and how it went', async () => {
    await mount(<DebriefView card={withPlan().cards[0]} />)
    expect(screen.getByText('Tests 1 of 2 passed')).toBeTruthy()
    const first = screen.getByText('Health answers 200').closest('li')!
    expect(within(first).getByText('Proves: GET /health answers 200')).toBeTruthy()
    expect(within(first).getByText('curl -i /health')).toBeTruthy()
    expect(within(first).getByText('high risk')).toBeTruthy()
    const second = screen.getByText('Ready fails without Redis').closest('li')!
    expect(within(second).getByText(/Passed for/)).toBeTruthy()
    expect(within(second).getByRole('button', { name: /Pass/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('records a pass, a failure with what went wrong, and clears one marked again', async () => {
    await mount(<DebriefView card={withPlan().cards[0]} />)
    const first = screen.getByText('Health answers 200').closest('li')!
    fireEvent.click(within(first).getByRole('button', { name: /Pass/ }))
    await settle()
    expect(sent().at(-1)).toMatchObject({ type: 'test.result', id: 'c1', test: 't1', result: { outcome: 'passed', by: 'you' } })

    fireEvent.click(within(screen.getByText('Ready fails without Redis').closest('li')!).getByRole('button', { name: /Pass/ }))
    await settle()
    expect(sent().at(-1)).toMatchObject({ type: 'test.result', test: 't2', result: null })

    fireEvent.click(within(screen.getByText('Ready fails without Redis').closest('li')!).getByRole('button', { name: /Fail/ }))
    fireEvent.change(screen.getByLabelText('What went wrong in Ready fails without Redis'), { target: { value: 'Answers 200 anyway.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fail it' }))
    await settle()
    expect(sent().at(-1)).toMatchObject({ type: 'test.result', test: 't2', result: { outcome: 'failed', note: 'Answers 200 anyway.', by: 'you' } })
  })

  it('copies the whole plan as Markdown', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await mount(<DebriefView card={withPlan().cards[0]} />)
    fireEvent.click(screen.getByRole('button', { name: /Copy as Markdown/ }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^## Functional test plan: c1\n\n### t1\. Health answers 200 \(high risk\)/))
  })
})
