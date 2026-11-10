// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmButton } from '../src/components/ConfirmButton'
import { ScheduleList } from '../src/components/Schedules'
import { Agents } from '../src/screens/Agents'
import { agent, card, calledOn, hubState, mount, standInHub } from './harness'

// The one way of asking before something that can't be taken back: the first press asks, the second does it, and
// otherwise it goes back.

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

const button = (onConfirm = vi.fn(), props: Partial<Parameters<typeof ConfirmButton>[0]> = {}) => {
  render(<ConfirmButton question="Revoke it? Press again" onConfirm={onConfirm} {...props}>Revoke</ConfirmButton>)
  return onConfirm
}

describe('a button that asks first', () => {
  it('turns its words into the question on the first press, and does nothing yet', () => {
    const done = button()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.getByRole('button', { name: 'Revoke it? Press again' })).toBeTruthy()
    expect(done).not.toHaveBeenCalled()
  })

  it('does it on the second press, and goes back to its own words', () => {
    const done = button()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke it? Press again' }))
    expect(done).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })

  it('goes back after four seconds, and then needs asking again', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const done = button()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    act(() => { vi.advanceTimersByTime(3900) })
    expect(screen.getByRole('button', { name: 'Revoke it? Press again' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(done).not.toHaveBeenCalled()
  })

  it('goes back when focus leaves it, and on Escape, for a keyboard', () => {
    const done = button()
    const revoke = screen.getByRole('button', { name: 'Revoke' })
    revoke.focus()
    fireEvent.click(revoke)
    fireEvent.keyDown(revoke, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
    fireEvent.click(revoke)
    fireEvent.blur(revoke)
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
    expect(done).not.toHaveBeenCalled()
  })

  it('says the question to a screen reader when it appears, in a region that was already there', () => {
    button(vi.fn(), { detail: 'Its cards stay.' })
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(region.textContent).toBe('Revoke it? Press again Its cards stay.')
    expect(document.querySelector('.confirm-detail')?.textContent).toBe('Its cards stay.')
  })

  it('keeps the name of an icon-only button, and shows the question in its place', () => {
    button(vi.fn(), { label: 'Revoke Sam' })
    expect(screen.getByRole('button', { name: 'Revoke Sam' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Sam' }))
    expect(screen.getByRole('button', { name: 'Revoke it? Press again' }).textContent).toBe('Revoke it? Press again')
  })

  it('acts on the first press when there is nothing to lose', () => {
    const done = button(vi.fn(), { ask: false })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('doesn’t ask while it can’t be pressed', () => {
    button(vi.fn(), { disabled: true })
    expect((screen.getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a schedule’s bin', () => {
  const schedule = { id: 's1', noteId: 'n1', binderId: 'b1', cron: '0 9 * * 1', tz: 'UTC', enabled: true, createdAt: '2026-01-01T00:00:00Z', createdBy: 'you' } as never
  const deletes = () => calledOn().filter((c) => c.startsWith('DELETE'))

  it('deletes the schedule only on the second press', async () => {
    standInHub()
    await mount(<ScheduleList schedules={[schedule]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete the schedule' }))
    expect(deletes()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete it? Press again' }))
    await act(async () => {})
    expect(deletes()).toEqual(['DELETE /api/schedules/s1'])
  })
})

describe('what an agent’s card asks before', () => {
  const working = () => hubState({ cards: [card('c1', 'working', { agentId: 'a1' }), card('c2', 'working', { agentId: 'a1' })] })
  const posts = () => calledOn().filter((c) => c.startsWith('POST /api/agents') || c.startsWith('DELETE /api/agents'))

  it('revokes only on the second press', async () => {
    standInHub(working)
    await mount(<Agents />)
    fireEvent.click(screen.getByRole('button', { name: `Revoke ${agent.name}` }))
    expect(posts()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Revoke it? Press again' }))
    await act(async () => {})
    expect(posts()).toEqual(['DELETE /api/agents/a1'])
  })

  it('says a new token cuts off the running runner, and makes it only on the second press', async () => {
    standInHub(working)
    await mount(<Agents />)
    fireEvent.click(screen.getByRole('button', { name: `New token for ${agent.name}` }))
    expect(posts()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cut off its runner? Press again' }))
    await act(async () => {})
    expect(posts()).toEqual(['POST /api/agents/a1/token'])
  })

  it('asks for a restart that stops what it holds, in place of the browser’s box, and only then restarts', async () => {
    const asked = vi.fn(() => true)
    vi.stubGlobal('confirm', asked)
    standInHub(() => ({ ...working(), agents: [{ ...agent, lastSeen: new Date().toISOString(), runnerSeen: { version: '99.0.0', parallel: 3, at: new Date().toISOString() } }] }))
    await mount(<Agents />)
    fireEvent.click(screen.getByRole('button', { name: `Restart ${agent.name}’s runner` }))
    expect(posts()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Restart and stop 2 cards? Press again' }))
    await act(async () => {})
    expect(posts()).toEqual(['POST /api/agents/a1/restart'])
    expect(asked).not.toHaveBeenCalled()
  })
})
