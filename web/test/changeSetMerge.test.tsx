// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calledOn, hubState, mount, standInHub, standInRoute } from './harness'
import { Toast } from '../src/components/Toast'
import { ChangeSets } from '../src/screens/ChangeSets'
import { UIContext } from '../src/ui'
import type { ChangeSet, PullRequest } from '../src/data/model'

// Approving a change set merges everything in it and can't be taken back: it asks first, and can't be sent twice.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${number}`, repo: 'acme/web', number, title: `Page ${number}`, branch: `b${number}`, url: `https://github.com/acme/web/pull/${number}`, state: 'open', checks: [], files: [], ...over })
const setOf = (pulls: PullRequest[]): ChangeSet => ({ id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'review', prIds: pulls.map((p) => p.id), noteIds: [] })
const approvals = () => calledOn().filter((c) => c === 'POST /api/sets/set-3/approve')
const open = (pulls: PullRequest[]) => {
  standInHub(() => hubState({ pulls, changeSets: [setOf(pulls)] }))
  return mount(<UIContext.Provider value={ui}><ChangeSets id="set-3" /><Toast /></UIContext.Provider>)
}

describe('Approve and merge', () => {
  it('asks what will happen first, and sends nothing on the first press', async () => {
    await open([1, 2, 3].map((n) => pr(n)))
    fireEvent.click(screen.getByRole('button', { name: 'Approve 3 and merge' }))
    expect(screen.getByRole('button', { name: 'Merge 3 pull requests? Press again' })).toBeTruthy()
    expect(approvals()).toEqual([])
  })

  it('says “pull request” for one', async () => {
    await open([pr(1)])
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1 and merge' }))
    expect(screen.getByRole('button', { name: 'Merge 1 pull request? Press again' })).toBeTruthy()
  })

  it('counts only what is left to merge when some are in', async () => {
    await open([pr(1, { state: 'merged' }), pr(2), pr(3)])
    fireEvent.click(screen.getByRole('button', { name: 'Approve the other 2 and merge' }))
    expect(screen.getByRole('button', { name: 'Merge 2 pull requests? Press again' })).toBeTruthy()
  })

  it('approves on the second press, and can’t be pressed again while the request is out', async () => {
    standInHub(() => hubState({ pulls: [pr(1), pr(2)], changeSets: [setOf([pr(1), pr(2)])] }))
    let answer!: () => void
    const answered = new Promise<void>((done) => { answer = done })
    const sent = standInRoute('POST', '/api/sets/set-3/approve', async () => { await answered; return {} })
    await mount(<UIContext.Provider value={ui}><ChangeSets id="set-3" /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Approve 2 and merge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 pull requests? Press again' }))
    const merging = await screen.findByRole('button', { name: 'Merging…' })
    expect((merging as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(merging)
    expect(approvals()).toEqual(['POST /api/sets/set-3/approve'])
    expect(sent).toHaveLength(1)
    await act(async () => { answer() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve 2 and merge' })).toBeTruthy())
  })

  it('can be pressed again once the hub has said no', async () => {
    standInHub(() => hubState({ pulls: [pr(1)], changeSets: [setOf([pr(1)])] }))
    standInRoute('POST', '/api/sets/set-3/approve', () => new Response(JSON.stringify({ error: 'A check failed.' }), { status: 409 }))
    await mount(<UIContext.Provider value={ui}><ChangeSets id="set-3" /><Toast /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1 and merge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 1 pull request? Press again' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A check failed.'))
    expect((screen.getByRole('button', { name: 'Approve 1 and merge' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('is off while a check has failed, as before', async () => {
    await open([pr(1, { checks: [{ name: 'tests', state: 'failed' }] })])
    expect((screen.getByRole('button', { name: 'Approve 1 and merge' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
