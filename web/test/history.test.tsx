// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteTree } from '../src/components/NoteTree'
import { Toast } from '../src/components/Toast'
import type { HistoryLine, TrashItem } from '../src/data/model'
import { Work } from '../src/screens/Work'
import { UIContext } from '../src/ui'
import { calledOn, card, hubState, me, mount, note, standInHub } from './harness'

// Deleting a note or a card says so, with Undo, and Settings → History says who did what and what can be put back.

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const toasted = () => document.querySelector('.toast')?.textContent
/** What the page says as an alert: the toast has a region for it that's there, empty, all the time. */
const alerted = () => screen.getAllByRole('alert').map((a) => a.textContent).filter(Boolean)
const line = (n: number, by = 'ana', text = `Line ${n}.`): HistoryLine => ({ at: `2026-11-09T10:${String(59 - n).padStart(2, '0')}:00.000Z`, by, text })
const item = (id: string, over: Partial<TrashItem> = {}): TrashItem => ({ kind: 'note', id, title: `Note ${id}`, binderId: 'b1', by: 'ana', at: '2026-11-09T09:00:00.000Z', ...over })

beforeEach(() => { window.location.hash = '' })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('deleting a card', () => {
  const page = () => mount(<UIContext.Provider value={ui}><Work id="c1" /><Toast /></UIContext.Provider>)

  it('says "Deleted." with Undo, after asking first as it did before', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    await page()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(toasted()).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Delete it? Press again' }))
    await waitFor(() => expect(toasted()).toBe('Deleted.Undo'))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('puts it back with Undo, the deletion having reached the hub first', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    const restore = vi.fn()
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/trash/card/c1/restore') {
        restore(init?.method)
        return json({ kind: 'card', id: 'c1', title: 'c1' })
      }
      return stand(url, init)
    }))
    await page()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete it? Press again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(toasted()).toBe('Put back.'))
    expect(restore).toHaveBeenCalledWith('POST')
    const calls = calledOn()
    expect(calls.indexOf('POST /api/changes')).toBeGreaterThan(-1)
    expect(calls.indexOf('POST /api/changes')).toBeLessThan(calls.indexOf('POST /api/trash/card/c1/restore'))
  })

  it('says why when it can’t be put back', async () => {
    standInHub(() => hubState({ cards: [card('c1')] }))
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/trash/card/c1/restore' ? json({ error: 'That isn’t in the trash any more.' }, 422) : stand(url, init))))
    await page()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete it? Press again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(alerted()).toEqual(['That isn’t in the trash any more.']))
  })
})

describe('deleting a note or a folder', () => {
  const tree = () => hubState({ binders: [{ id: 'b1', name: 'Binder' }], folders: [{ id: 'f1', name: 'Plans', binderId: 'b1' }], notes: [note('n1', 'words')], cards: [] })
  const opened = () => mount(<UIContext.Provider value={ui}><NoteTree currentId="n1" /><ContextMenuHost /><Toast /></UIContext.Provider>)

  it('says "Deleted." with Undo for a note, which puts it back', async () => {
    standInHub(tree)
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/trash/note/n1/restore' ? json({ kind: 'note', id: 'n1', title: 'n1' }) : stand(url, init))))
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(toasted()).toBeUndefined()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete the note? Press again' }))
    await waitFor(() => expect(toasted()).toBe('Deleted.Undo'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(toasted()).toBe('Put back.'))
    expect(calledOn()).toContain('POST /api/trash/note/n1/restore')
  })

  it('says nothing of the kind for a folder, which isn’t kept', async () => {
    standInHub(tree)
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Plans' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete it? What’s in it moves up' }))
    await waitFor(() => expect(calledOn()).toContain('POST /api/changes'))
    expect(toasted()).toBeUndefined()
  })
})

describe('Settings → History', () => {
  /** The hub with a history and a trash to ask for: the addresses asked, and what's posted to put something back. */
  function withHistory(pages: (query: URLSearchParams) => { lines: HistoryLine[]; more: boolean; people?: string[] }, trash: () => TrashItem[], back: (url: string) => Response = () => json({})) {
    standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server' }] }), { ...me, spaces: [] })
    const stand = globalThis.fetch
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/history')) {
        asked.push(url)
        return json({ people: ['ana', 'cy', 'hub', 'Builder'], ...pages(new URL(url, 'http://hub.test').searchParams) })
      }
      if (url === '/api/trash') {
        asked.push(url)
        return json({ items: trash() })
      }
      if (url.startsWith('/api/trash/') && init?.method === 'POST') {
        asked.push(`POST ${url}`)
        return back(url)
      }
      return stand(url, init)
    }))
    return asked
  }
  const open = () => {
    window.location.hash = '#/settings/history'
    return mount(<App />)
  }
  const rows = (list: HTMLElement) => within(list).getAllByRole('listitem').map((li) => li.textContent)

  it('is in this binder’s group, and lists what happened newest first, with who, when and what', async () => {
    withHistory(() => ({ lines: [line(1, 'hub', 'Deleted the card “Plan it”.'), line(2, 'cy', 'Added @dee to this Binder as a member.'), line(3, 'Builder', 'Deleted the note “Old”.')], more: false }), () => [])
    await open()
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(within(nav).getByRole('group', { name: 'This binder' })).getByRole('link', { name: 'History' }).getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('.settings-pane h2')?.textContent).toBe('History')
    await waitFor(() => expect(document.querySelectorAll('.history-list')[0]?.querySelectorAll('li').length).toBe(3))
    const first = document.querySelectorAll('.history-list')[0] as HTMLElement
    expect(rows(first)).toEqual([
      expect.stringContaining('The hubDeleted the card “Plan it”.'),
      expect.stringContaining('cyAdded @dee to this Binder as a member.'),
      expect.stringContaining('BuilderDeleted the note “Old”.'),
    ])
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(line(1).at)
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull()
  })

  it('puts each line under its day, the newest first, with its time beside who did it', async () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30).toISOString()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 16, 5).toISOString()
    const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 9, 11, 0).toISOString()
    withHistory(() => ({ lines: [{ at: today, by: 'ana', text: 'This morning.' }, { at: yesterday, by: 'cy', text: 'Yesterday’s.' }, { at: before, by: 'hub', text: 'Last week’s.' }], more: false }), () => [])
    await open()
    await screen.findByText('This morning.')
    const days = [...document.querySelectorAll('.timeline-day')] as HTMLElement[]
    expect(days.map((d) => d.querySelector('h4')!.textContent)).toEqual(['Today', 'Yesterday', new Date(before).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(before).getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })])
    expect(within(days[1]).getByText('Yesterday’s.')).toBeTruthy()
    expect(days[0].querySelector('time')!.textContent).toBe(new Date(today).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
  })

  it('shows only one person’s when asked, and everyone’s again', async () => {
    const asked = withHistory((query) => ({ lines: query.get('who') === 'cy' ? [line(2, 'cy', 'Only cy’s.')] : [line(1, 'ana', 'Ana’s.'), line(2, 'cy', 'Only cy’s.')], more: false }), () => [])
    await open()
    await screen.findByText('Ana’s.')
    const who = screen.getByRole('combobox', { name: 'Show' }) as HTMLSelectElement
    expect([...who.options].map((o) => o.textContent)).toEqual(['Everyone', 'ana', 'cy', 'The hub', 'Builder'])
    fireEvent.change(who, { target: { value: 'cy' } })
    await waitFor(() => expect(screen.queryByText('Ana’s.')).toBeNull())
    expect(screen.getByText('Only cy’s.')).toBeTruthy()
    expect(asked).toContain('/api/history?who=cy')
    // Choosing one doesn’t shorten the list of people to choose from.
    expect([...who.options].length).toBe(5)
    fireEvent.change(who, { target: { value: '' } })
    await screen.findByText('Ana’s.')
  })

  it('loads older ones from the time of the last it has, and the button goes when there are no more', async () => {
    const newest = Array.from({ length: 50 }, (_, n) => line(n))
    const older = [line(50, 'ana', 'The oldest.')]
    const asked = withHistory((query) => (query.get('before') ? { lines: older, more: false } : { lines: newest, more: true }), () => [])
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }))
    await screen.findByText('The oldest.')
    expect(asked).toContain(`/api/history?before=${encodeURIComponent(newest.at(-1)!.at)}`)
    expect(screen.getByText('Line 0.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull()
  })

  it('has nothing for axe to object to, with lines and a trash to read', async () => {
    withHistory(() => ({ lines: [line(1), line(2, 'hub')], more: true }), () => [item('n1')])
    await open()
    await screen.findByText('Note n1')
    await screen.findByText('Line 1.')
    const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
  })

  it('says when there’s nothing, and when it couldn’t be loaded, with a way to try again', async () => {
    let answer: () => Response | { lines: HistoryLine[]; more: boolean } = () => ({ lines: [], more: false })
    standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server' }] }), { ...me, spaces: [] })
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/history')) {
        const said = answer()
        return said instanceof Response ? said : json({ ...said, people: [] })
      }
      if (url === '/api/trash') return json({ items: [] })
      return stand(url, init)
    }))
    await open()
    await screen.findByText('Nothing has happened here yet that’s worth noting.')
    await screen.findByText('Nothing has been deleted in the last 30 days.')
    cleanup()
    answer = () => json({ error: 'No.' }, 500)
    await open()
    await waitFor(() => expect(alerted().join('')).toContain('Couldn’t load the history.'))
    answer = () => ({ lines: [line(1)], more: false })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Line 1.')
  })

  it('lists what was deleted, with who and when, and puts it back, then reads both lists again', async () => {
    let trash = [item('n1'), item('c1', { kind: 'card', title: 'Plan it', by: 'Builder' })]
    let history = [line(1)]
    const asked = withHistory(() => ({ lines: history, more: false }), () => trash, (url) => {
      trash = trash.filter((t) => !url.includes(`/${t.kind}/${t.id}/`))
      history = [line(0, 'ana', 'Put back the note “Note n1”.'), ...history]
      return json({ kind: 'note', id: 'n1', title: 'Note n1' })
    })
    await open()
    const list = (await screen.findByText('Note n1')).closest('ul') as HTMLElement
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Note n1Note, deleted by ana .*Put back$/),
      expect.stringMatching(/^Plan itCard, deleted by Builder .*Put back$/),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Put back Note n1' }))
    await waitFor(() => expect(screen.queryByText('Note n1')).toBeNull())
    expect(asked).toContain('POST /api/trash/note/n1/restore')
    expect(screen.getByText('Plan it')).toBeTruthy()
    await screen.findByText('Put back the note “Note n1”.')
    await waitFor(() => expect(toasted()).toBe('Put back.'))
    expect(calledOn().filter((c) => c === 'GET /api/trash').length).toBeGreaterThan(1)
  })

  it('says why something can’t be put back, and leaves it listed', async () => {
    withHistory(() => ({ lines: [], more: false }), () => [item('n1')], () => json({ error: 'The binder it was in is gone, so it can’t be put back.' }, 422))
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Put back Note n1' }))
    await waitFor(() => expect(alerted()).toContain('The binder it was in is gone, so it can’t be put back.'))
    expect(screen.getByText('Note n1')).toBeTruthy()
  })

  it('names the binder of what was deleted only where there are several', async () => {
    standInHub(() => ({ ...hubState(), binders: [{ id: 'b1', name: 'Server' }, { id: 'b2', name: 'Docs' }] }), { ...me, spaces: [] })
    const stand = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/history')) return json({ lines: [], more: false, people: [] })
      if (url === '/api/trash') return json({ items: [item('n1', { binderId: 'b2' })] })
      return stand(url, init)
    }))
    await open()
    await screen.findByText('Note n1')
    expect(document.querySelector('.trash-list .rows-meta')?.textContent).toMatch(/^Note in Docs, deleted by ana/)
  })
})
