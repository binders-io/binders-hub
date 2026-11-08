// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullDiffs } from '../src/components/Diffs'
import { HubConnection } from '../src/data/sync'
import { FakeSocket } from './harness'
import type { PullRequest } from '../src/data/model'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const pull = (id: number, files: PullRequest['files'], head = 'h1'): PullRequest => ({ id: `acme/web#${id}`, repo: 'acme/web', number: id, title: 'A page', branch: 'b', url: '', state: 'open', checks: [], files, head })
const listed = [{ path: 'src/a.ts', added: 1, removed: 0, lines: [] }]
const full = [{ path: 'src/a.ts', added: 1, removed: 0, lines: [{ kind: '+' as const, text: 'a new line', n: 1 }] }]
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('a pull request’s diff', () => {
  it('shows each file’s name while its lines load, then the lines', async () => {
    let give = (_: Response) => {}
    const fetched = vi.fn(() => new Promise<Response>((done) => { give = done }))
    vi.stubGlobal('fetch', fetched)
    render(<PullDiffs pull={pull(1, listed)} />)
    expect(screen.getByRole('status').textContent).toMatch(/Loading/)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(fetched.mock.calls[0]).toContainEqual('/api/pulls/acme%2Fweb/1/files')
    give(answer({ files: full }))
    expect(await screen.findByText('a new line')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says when they didn’t load, and tries again when asked', async () => {
    const fetched = vi.fn(async () => answer({ error: 'No' }, 500))
    vi.stubGlobal('fetch', fetched)
    render(<PullDiffs pull={pull(2, listed)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(fetched).toHaveBeenCalledTimes(2)
    fetched.mockImplementation(async () => answer({ files: full }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('a new line')).toBeTruthy()
  })

  it('asks again once the pull request has moved on, and not before', async () => {
    const fetched = vi.fn(async () => answer({ files: full }))
    vi.stubGlobal('fetch', fetched)
    const first = render(<PullDiffs pull={pull(3, listed)} />)
    await screen.findByText('a new line')
    first.unmount()
    const second = render(<PullDiffs pull={pull(3, listed)} />)
    expect(screen.getByText('a new line')).toBeTruthy()
    expect(fetched).toHaveBeenCalledTimes(1)
    second.rerender(<PullDiffs pull={pull(3, listed, 'h2')} />)
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledTimes(2))
  })

  it('needs no asking when the state came with its lines', () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    render(<PullDiffs pull={pull(4, full)} />)
    expect(screen.getByText('a new line')).toBeTruthy()
    expect(fetched).not.toHaveBeenCalled()
  })
})

describe('the connection', () => {
  it('asks for the light state, and only what it missed once it’s been following', async () => {
    FakeSocket.open = []
    vi.stubGlobal('WebSocket', FakeSocket)
    const fetched = vi.fn(async (_url: string) => answer({ version: 8, presence: {} }))
    vi.stubGlobal('fetch', fetched)
    const snapshots: number[] = []
    const connection = new HubConnection({ snapshot: (version) => snapshots.push(version), entries: () => {}, status: () => {}, version: () => 7, presence: () => {} })
    await connection.start()
    expect(fetched.mock.calls[0][0]).toBe('/api/state?light=1&have=7')
    expect(FakeSocket.open.at(-1)!.url.toString()).toContain('since=7&light=1')
    expect(snapshots).toEqual([])
    await connection.start()
    expect(fetched.mock.calls[1][0]).toBe('/api/state?light=1&have=7&replay=1')
    connection.stop()
  })
})
