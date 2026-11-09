// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, mount, standInHub, standInRoute } from './harness'
import { ChallengeView, SetChallenge } from '../src/components/Challenge'
import { DebriefView } from '../src/components/Debrief'
import type { Challenge, Debrief } from '../../shared/changeSet.ts'
import type { Card, ChangeSet } from '../src/data/model'

// A debrief or Challenge asked of an agent that never started on it, or that started and went quiet, can be asked
// again once the hub would take it: after half an hour.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const debrief = (askedMinutesAgo: number, over: Partial<Debrief> = {}): Debrief => ({ state: 'asked', askedBy: 'you', askedAt: minutesAgo(askedMinutesAgo), agentId: 'a1', ...over })
const challenge = (askedMinutesAgo: number, over: Partial<Challenge> = {}): Challenge => ({ state: 'asked', askedBy: 'you', askedAt: minutesAgo(askedMinutesAgo), agentId: 'a1', picked: 'hub', authors: [], ...over })
const hub = (c: Card) => hubState({ cards: [c], agents: [agent, { ...agent, id: 'a2', name: 'Other' }] })
const set = (over: Partial<ChangeSet> = {}): ChangeSet => ({ id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'review', prIds: ['acme/web#7'], noteIds: [], ...over })
const pr = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'u', state: 'open' as const, checks: [], files: [], cardId: 'c1', agentId: 'a1' }

describe('a debrief nobody picked up', () => {
  it('still waits when it was asked recently, with its button off and no way to ask again', async () => {
    const c = card('c1', 'review', { debrief: debrief(10) })
    standInHub(() => hub(c))
    await mount(<DebriefView card={c} />)
    expect(screen.getByText(/will write it as soon as its runner is listening/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
    expect((screen.getByRole('button', { name: /Debriefing/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says when it was asked, and offers to ask again, after half an hour', async () => {
    const c = card('c1', 'review', { debrief: debrief(45) })
    standInHub(() => hub(c))
    await mount(<DebriefView card={c} />)
    expect(screen.getByText(/Agent hasn’t started on it since it was asked 45m ago\./)).toBeTruthy()
    expect(screen.queryByText(/will write it as soon as/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Debrief' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('asks again from there', async () => {
    const c = card('c1', 'review', { debrief: debrief(45) })
    standInHub(() => hub(c))
    const asked = standInRoute('POST', '/api/cards/c1/debrief')
    await mount(<DebriefView card={c} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('asks for the change set’s debrief when the card is in one', async () => {
    const c = card('c1', 'review', { prId: pr.id, debrief: debrief(45) })
    const s = set({ debrief: debrief(45) })
    standInHub(() => ({ ...hub(c), pulls: [pr], changeSets: [s] }))
    const asked = standInRoute('POST', '/api/sets/set-3/debrief')
    await mount(<DebriefView card={c} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('doesn’t call one the agent started on recently stale', async () => {
    const c = card('c1', 'review', { debrief: debrief(10, { state: 'writing' }) })
    standInHub(() => hub(c))
    await mount(<DebriefView card={c} />)
    expect(screen.getByText(/is writing it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
  })

  it('offers to ask again after half an hour of writing with nothing to show, in words that say it started and went quiet', async () => {
    const c = card('c1', 'review', { debrief: debrief(90, { state: 'writing' }) })
    standInHub(() => hub(c))
    const asked = standInRoute('POST', '/api/cards/c1/debrief')
    await mount(<DebriefView card={c} />)
    expect(screen.queryByText(/is writing it/)).toBeNull()
    expect(screen.getByText(/Agent started on it, then went quiet\. It was asked 1h ago\./)).toBeTruthy()
    expect(screen.queryByText(/hasn’t started on it/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Debrief' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })
})

describe('a Challenge nobody picked up', () => {
  it('still waits when it was asked recently', async () => {
    const c = card('c1', 'review', { prId: pr.id, challenge: challenge(10) })
    standInHub(() => ({ ...hub(c), pulls: [pr] }))
    await mount(<ChallengeView card={c} />)
    expect(screen.getByText(/will review it as soon as its runner is listening/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
    expect((screen.getByRole('button', { name: /Challenging/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says when it was asked, and asks again, after half an hour', async () => {
    const c = card('c1', 'review', { prId: pr.id, challenge: challenge(31) })
    standInHub(() => ({ ...hub(c), pulls: [pr] }))
    const asked = standInRoute('POST', '/api/cards/c1/challenge')
    await mount(<ChallengeView card={c} />)
    expect(screen.getByText(/Agent hasn’t started on it since it was asked 31m ago\./)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Challenge' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('still reviewing, not stale, when it started on it recently', async () => {
    const c = card('c1', 'review', { prId: pr.id, challenge: challenge(10, { state: 'reviewing' }) })
    standInHub(() => ({ ...hub(c), pulls: [pr] }))
    await mount(<ChallengeView card={c} />)
    expect(screen.getByText(/is reviewing it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
  })

  it('offers to ask again after half an hour of reviewing with nothing to show, in words that say it started and went quiet', async () => {
    const c = card('c1', 'review', { prId: pr.id, challenge: challenge(40, { state: 'reviewing' }) })
    standInHub(() => ({ ...hub(c), pulls: [pr] }))
    const asked = standInRoute('POST', '/api/cards/c1/challenge')
    await mount(<ChallengeView card={c} />)
    expect(screen.queryByText(/is reviewing it/)).toBeNull()
    expect(screen.getByText(/Agent started on it, then went quiet\. It was asked 40m ago\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('says the same on the change set’s page', async () => {
    const c = card('c1', 'review', { prId: pr.id })
    const s = set({ challenge: challenge(50, { state: 'reviewing' }) })
    standInHub(() => ({ ...hub(c), pulls: [pr], changeSets: [s] }))
    const asked = standInRoute('POST', '/api/sets/set-3/challenge')
    await mount(<SetChallenge set={s} />)
    expect(screen.getByText(/Agent started on it, then went quiet\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('says the date once it has been days', async () => {
    const c = card('c1', 'review', { prId: pr.id, challenge: challenge(3 * 24 * 60) })
    standInHub(() => ({ ...hub(c), pulls: [pr] }))
    await mount(<ChallengeView card={c} />)
    expect(screen.getByText(/since it was asked on /)).toBeTruthy()
  })

  it('is asked again for the whole change set from its page', async () => {
    const c = card('c1', 'review', { prId: pr.id })
    const s = set({ challenge: challenge(40) })
    standInHub(() => ({ ...hub(c), pulls: [pr], changeSets: [s] }))
    const asked = standInRoute('POST', '/api/sets/set-3/challenge')
    await mount(<SetChallenge set={s} />)
    expect(screen.getByText(/Agent hasn’t started on it since it was asked 40m ago\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(asked).toHaveLength(1))
  })

  it('is still waiting on the change set’s page when asked recently', async () => {
    const c = card('c1', 'review', { prId: pr.id })
    const s = set({ challenge: challenge(5) })
    standInHub(() => ({ ...hub(c), pulls: [pr], changeSets: [s] }))
    await mount(<SetChallenge set={s} />)
    expect(screen.getByText(/will review it as soon as its runner is listening/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
  })
})
