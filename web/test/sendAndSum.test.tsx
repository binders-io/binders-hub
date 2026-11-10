// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubState, mount, note, settle, standInHub, standInRoute } from './harness'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteControls, noteInBinder, useMayChange } from '../src/components/NoteControls'
import { NoteTree } from '../src/components/NoteTree'
import { Toast } from '../src/components/Toast'
import { useHub } from '../src/data/store'
import { UIContext } from '../src/ui'
import { Account } from '../src/screens/Account'

// A note's ⋯ menu: Send to… another of your Binders, and Sum it up. The notes list's order for captures. The account's
// setting for where captures go.

const talk = 'so the van needs new tyres before the trip and sam said he would book the garage for tuesday morning and we agreed to split the cost between the two teams'
const long = `# Van\n\n${talk}\n`
const targets = [{ id: 'team', name: 'Team', personal: false }, { id: 'side', name: 'Side', personal: false }]
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function OnPhone() {
  const current = useHub((state) => state.notes.find((n) => n.id === 'n1'))
  const mayChange = useMayChange(current ?? { id: 'n1' })
  if (!current) return null
  return <><NoteControls note={current} mayChange={mayChange} more={[]} /><ContextMenuHost /><Toast /></>
}
const menu = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'More for this note' }))
  await screen.findByRole('menu')
}
const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent)
const withNote = (text: string, binders = targets) => {
  standInHub(() => hubState({ notes: [note('n1', text)] }))
  standInRoute('GET', '/api/notes/send-to', () => ({ binders }))
}

describe('Send to… in a note’s menu', () => {
  it('lists your other Binders, copies the note to the one you pick, and says where it went, with Open', async () => {
    withNote(long)
    const sent = standInRoute('POST', '/api/notes/n1/send', () => ({ id: 'copy1', binder: 'team', binderName: 'Team', again: false }))
    await mount(<OnPhone />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'More for this note' })).toBeTruthy())
    await settle(30)
    await menu()
    expect(items()).toContain('Send to…')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to…' }))
    await waitFor(() => expect(items()).toEqual(['Back', 'Team', 'Side']))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Team' }))
    await waitFor(() => expect(sent).toEqual([{ binder: 'team' }]))
    await waitFor(() => expect(screen.getAllByText('Sent to Team.').length).toBeGreaterThan(0))
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(noteInBinder('team', 'copy1')).toBe('/team/#/notes/copy1')
  })

  it('says so when it’s a second copy, and says why when the hub refuses', async () => {
    withNote(long)
    const answers: Response[] = [reply({ id: 'copy2', binder: 'side', binderName: 'Side', again: true }), reply({ error: 'You’re not in that Binder.' }, 422)]
    standInRoute('POST', '/api/notes/n1/send', () => answers.shift())
    await mount(<OnPhone />)
    await settle(30)
    await menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Side' }))
    await waitFor(() => expect(screen.getAllByText('Sent to Side again. It has two copies of this note now.').length).toBeGreaterThan(0))

    await menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Team' }))
    await waitFor(() => expect(within(screen.getByRole('alert')).getByText('You’re not in that Binder.')).toBeTruthy())
  })

  it('isn’t there when you have no other Binder', async () => {
    withNote(long, [])
    await mount(<OnPhone />)
    await settle(30)
    await menu()
    expect(items()).not.toContain('Send to…')
  })
})

describe('Sum it up in a note’s menu', () => {
  it('is offered for a note with enough words and no summary, says so while it works, and says when it’s done', async () => {
    withNote(long)
    let finish: (body: unknown) => void = () => {}
    const asked = standInRoute('POST', '/api/notes/n1/sum-up', () => new Promise((done) => { finish = done }))
    await mount(<OnPhone />)
    await settle(30)
    await menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sum it up' }))
    await waitFor(() => expect(asked).toHaveLength(1))
    await menu()
    const working = screen.getByRole('menuitem', { name: 'Summing it up…' }) as HTMLButtonElement
    expect(working.disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    finish({ ok: true })
    await waitFor(() => expect(screen.getAllByText('Summed up. The summary is in the note.').length).toBeGreaterThan(0))
    await menu()
    expect(items()).toContain('Sum it up')
  })

  it('says why not, in the hub’s words, when it has no model', async () => {
    withNote(long)
    standInRoute('POST', '/api/notes/n1/sum-up', () => reply({ error: 'The hub has no model to sum it up with yet. An admin can set one up in Settings → Brain.' }, 422))
    await mount(<OnPhone />)
    await settle(30)
    await menu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sum it up' }))
    await waitFor(() => expect(within(screen.getByRole('alert')).getByText('The hub has no model to sum it up with yet. An admin can set one up in Settings → Brain.')).toBeTruthy())
  })

  it('is left out for a note too short to sum up, and for one that has a summary', async () => {
    withNote('# Van\n\nFew words.\n')
    await mount(<OnPhone />)
    await settle(30)
    await menu()
    expect(items()).not.toContain('Sum it up')
    cleanup()
    vi.unstubAllGlobals()
    withNote(`# Van\n\n${talk}\n\n## Summary\n\nThey talked.\n`)
    await mount(<OnPhone />)
    await settle(30)
    await menu()
    expect(items()).not.toContain('Sum it up')
  })
})

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const tree = (state: Parameters<typeof hubState>[0]) => {
  standInHub(() => hubState({ binders: [{ id: 'b1', name: 'Binder' }], cards: [], ...state }))
  standInRoute('GET', '/api/notes/send-to', () => ({ binders: targets }))
  return mount(<UIContext.Provider value={ui}><NoteTree currentId="none" /><ContextMenuHost /></UIContext.Provider>)
}

describe('the notes list', () => {
  it('has Send to… and Sum it up in a row’s menu', async () => {
    await tree({ notes: [note('n1', long)] })
    await settle(30)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for n1' }))
    await screen.findByRole('menu')
    expect(items()).toEqual(expect.arrayContaining(['Send to…', 'Sum it up', 'Delete']))
  })

  it('shows a folder of captures newest first, by when they were recorded, and every other folder by title', async () => {
    const heard = (title: string, when: string) => `# ${title}\n\n_Conversation · ${when} UTC · 3 min_\n\n## Transcript\n\nwords\n`
    await tree({
      folders: [{ id: 'caps', name: 'Captures', binderId: 'b1' }, { id: 'plans', name: 'Plans', binderId: 'b1' }],
      notes: [
        { ...note('a', 'Alpha'), title: 'Alpha', folderId: 'caps', captured: 'conversation' as const, text: heard('Alpha', '2026-11-07 14:03') },
        { ...note('b', 'Beta'), title: 'Beta', folderId: 'caps', captured: 'meeting' as const, text: heard('Beta', '2026-11-09 08:00') },
        { ...note('c', 'Gamma'), title: 'Gamma', folderId: 'caps', captured: 'conversation' as const, text: heard('Gamma', '2026-11-08 20:15') },
        // A note written by hand in it goes by when it was last changed.
        { ...note('w', 'Written'), title: 'Written', folderId: 'caps', editedAt: '2026-11-09T09:30:00.000Z', text: '# Written\n' },
        { ...note('z', 'Zed'), title: 'Zed', folderId: 'plans', editedAt: '2026-11-09T09:30:00.000Z' },
        { ...note('y', 'Abe'), title: 'Abe', folderId: 'plans', editedAt: '2026-11-01T09:30:00.000Z' },
      ],
    })
    const order = (folder: string) => {
      const group = screen.getByRole('button', { name: `Close ${folder}` }).closest('[role="group"]') as HTMLElement
      return [...group.querySelectorAll('.note-row b')].map((b) => b.textContent)
    }
    expect(order('Captures')).toEqual(['Written', 'Beta', 'Gamma', 'Alpha'])
    expect(order('Plans')).toEqual(['Abe', 'Zed'])
  })
})

describe('where captures go, on your account', () => {
  it('shows your own Binder and your teams’, keeps the one you pick, and says so', async () => {
    standInHub(() => hubState(), { user: { login: 'you', name: 'You' }, github: {}, spaces: [], space: '' })
    standInRoute('GET', '/api/tokens', () => ({ tokens: [] }))
    const binders = [{ id: '~you', name: 'Personal', personal: true }, { id: 'team', name: 'Team', personal: false }, { id: 'side', name: 'Side', personal: false }]
    standInRoute('GET', '/api/personal/captures', () => ({ home: '~you', binders }))
    const put = standInRoute('PUT', '/api/personal/captures', (body) => ({ home: (body as { binder: string }).binder, binders }))
    await mount(<><Account /><Toast /></>)
    const select = (await screen.findByRole('combobox', { name: 'Where what your phone and Mac capture goes' })) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Your own Binder', 'Team', 'Side'])
    expect(select.value).toBe('~you')
    fireEvent.change(select, { target: { value: 'team' } })
    await waitFor(() => expect(put).toEqual([{ binder: 'team' }]))
    await waitFor(() => expect(screen.getAllByText('Your captures go to Team now.').length).toBeGreaterThan(0))
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Where what your phone and Mac capture goes' }) as HTMLSelectElement).value).toBe('team'))
  })
})
