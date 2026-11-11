// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, me, mount, note, settle, standInHub, standInRoute } from './harness'
import App from '../src/App'
import { Toast } from '../src/components/Toast'
import { ContextMenuHost } from '../src/components/ContextMenu'
import { NoteTree } from '../src/components/NoteTree'
import { Palette } from '../src/components/Palette'
import { People } from '../src/components/SpacePanel'
import { ReaderLine } from '../src/components/ReaderLine'
import { waitingFor } from '../src/data/notify'
import { useHub } from '../src/data/store'
import { Agents } from '../src/screens/Agents'
import { ChangeSets } from '../src/screens/ChangeSets'
import { Delivery } from '../src/screens/Delivery'
import { Flow } from '../src/screens/Flow'
import { Home } from '../src/screens/Home'
import { Notes } from '../src/screens/Notes'
import { Work } from '../src/screens/Work'
import { useMayChangeBinder } from '../src/screens/settings/access'
import { UIContext } from '../src/ui'
import type { ChangeSet, Environment, PullRequest } from '../src/data/model'

// A reader sees everything in a Binder and changes nothing in it: nothing that changes something is offered, one quiet
// line at the top says why, and nothing waits on them. A member's screens are the same as they were.

const readerWords = 'You can read this binder, and can’t change it. One of its owners can let you.'

// The editor stands in for itself: whether it was given a document it may type in is all this needs of it.
vi.mock('../src/editor/MarkdownEditor', () => ({
  MarkdownEditor: (props: { readOnly?: boolean }) => <div data-testid="editor" data-readonly={String(!!props.readOnly)} />,
}))
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => <div data-testid="toolbar" /> }))

const managers = [{ login: 'ana', role: 'owner' }, { login: 'ed', role: 'admin' }]

/** The hub with one Binder, Acme, and `role` in it; the world is what its state has. */
function hubAs(role: 'reader' | 'member' | 'owner', world: () => ReturnType<typeof hubState> = () => hubState()) {
  const you = { ...me, role, space: 'acme', spaces: [{ id: 'acme', name: 'Acme', role }] }
  const stood = standInHub(world, you)
  standInRoute('GET', '/api/spaces', () => ({ spaces: [{ id: 'acme', name: 'Acme', role, createdAt: 'then', managers, ...(role === 'owner' ? { members: [{ login: 'you', role: 'owner' }, { login: 'cy', role: 'reader' }] } : {}) }], mayCreate: true }))
  return stood
}

const ui = (over: object = {}) => ({ openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {}, splitCard: () => {}, ...over })
const withUI = (children: React.ReactNode) => <UIContext.Provider value={ui()}>{children}<Toast /><ContextMenuHost /></UIContext.Provider>
const has = (name: string | RegExp) => screen.queryByRole('button', { name }) !== null

beforeEach(() => {
  window.location.hash = ''
  Element.prototype.scrollTo = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('the line at the top', () => {
  it('says a reader can read the binder, and who can let them change it', async () => {
    hubAs('reader')
    await mount(<ReaderLine />)
    const line = await screen.findByRole('status')
    expect(line.textContent).toContain('You can read this binder. Its owners can let you change it.')
    await waitFor(() => expect(line.textContent).toContain('Ask @ana and @ed.'))
  })

  it('is on every screen of the app, for a reader, and for nobody else', async () => {
    hubAs('reader')
    window.location.hash = '#/flow'
    await mount(<App />)
    await settle(100)
    expect(screen.getAllByText(/You can read this binder\. Its owners can let you change it\./)).toHaveLength(1)
    window.location.hash = '#/delivery'
    await settle(100)
    expect(screen.getAllByText(/You can read this binder\. Its owners can let you change it\./)).toHaveLength(1)
    cleanup()
    hubAs('member')
    window.location.hash = '#/flow'
    await mount(<App />)
    await settle(100)
    expect(screen.queryByText(/You can read this binder/)).toBeNull()
  })
})

describe('the hook that says whether you may change the binder', () => {
  const Says = () => <output data-testid="may">{String(useMayChangeBinder())}</output>
  it.each([['reader', 'false'], ['member', 'true'], ['admin', 'true'], ['owner', 'true']] as const)('is %s: %s', async (role, says) => {
    standInHub(() => hubState(), { ...me, role })
    await mount(<Says />)
    expect(screen.getByTestId('may').textContent).toBe(says)
  })

  it('says yes until the hub has said who you are, so no one’s controls come and go', async () => {
    standInHub(() => hubState(), me)
    await mount(<Says />)
    expect(screen.getByTestId('may').textContent).toBe('true')
  })
})

describe('the People section', () => {
  it('offers Reader beside the other roles, with a line saying what a reader can and can’t do', async () => {
    hubAs('owner')
    await mount(withUI(<People />))
    const picker = await screen.findByRole('combobox', { name: 'cy’s role' })
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Owner', 'Admin', 'Member', 'Reader'])
    expect((picker as HTMLSelectElement).value).toBe('reader')
    // Who may do what is said once, under the list.
    expect(screen.getByText(/A reader sees everything and can ask about it, but can’t change anything or have agents/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add people' }))
    const adding = within(await screen.findByRole('dialog', { name: 'Add people' })).getByRole('group', { name: 'Their role' })
    expect(within(adding).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['owner', 'admin', 'member', 'reader'])
    expect(within(adding).getByRole('radio', { name: /Reader/ })).toBeTruthy()
  })

  it('makes someone a reader, and says which agents were revoked with the change', async () => {
    hubAs('owner')
    const sent = standInRoute('PUT', '/api/spaces/acme/members/you', () => ({ spaces: [], revoked: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Tester' }] }))
    await mount(withUI(<People />))
    fireEvent.change(await screen.findByRole('combobox', { name: 'you’s role' }), { target: { value: 'reader' } })
    await waitFor(() => expect(sent).toEqual([{ role: 'reader' }]))
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('@you can only read now, so their 2 agents were revoked: Builder, Tester.'))
  })
})

describe('the board', () => {
  const proposal = { id: 'p1', binderId: 'b1', noteId: 'n1', title: 'Add dark mode', quote: 'dark', brief: '', doneWhen: '', size: 'M' as const, by: 'a1', state: 'new' as const }
  const world = () => hubState({ cards: [card('c1', 'ready'), card('c2', 'blocked', { agentId: 'a1' })], proposals: [proposal] })

  it('has no New card, no Accept, Edit first or Dismiss, and nothing to drag, for a reader', async () => {
    hubAs('reader', world)
    await mount(withUI(<Flow />))
    expect(has(/New card/)).toBe(false)
    expect(has('Accept')).toBe(false)
    expect(has(/Edit first/)).toBe(false)
    expect(has('Dismiss')).toBe(false)
    expect(document.querySelectorAll('.card-drag[draggable="true"]')).toHaveLength(0)
    // What it shows is all there.
    expect(screen.getByRole('button', { name: 'c1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add dark mode' })).toBeTruthy()
  })

  it('has them all for a member', async () => {
    hubAs('member', world)
    await mount(withUI(<Flow />))
    expect(has(/New card/)).toBe(true)
    expect(has('Accept')).toBe(true)
    expect(has('Dismiss')).toBe(true)
    expect(document.querySelectorAll('.card-drag[draggable="true"]').length).toBe(2)
  })

  it('has a card’s menu that opens it and copies its link, and does nothing else', async () => {
    hubAs('reader', world)
    await mount(withUI(<Flow />))
    fireEvent.click(screen.getByRole('button', { name: 'Actions for c1' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open', 'Copy link'])
    cleanup()
    hubAs('member', world)
    await mount(withUI(<Flow />))
    fireEvent.click(screen.getByRole('button', { name: 'Actions for c1' }))
    const full = await screen.findByRole('menu')
    expect(within(full).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(expect.arrayContaining(['Open', 'Copy link', 'Delete']))
  })
})

describe('a card’s page', () => {
  const world = () => hubState({ cards: [card('c1', 'working', { agentId: 'a1', title: 'Fix the login', brief: 'Make it work.' })] })
  const page = () => mount(withUI(<Work id="c1" />))

  it('has no moves, Stop, Delete, edit or answer box for a reader, and still reads and copies the link', async () => {
    hubAs('reader', world)
    await page()
    for (const name of [/^Delete/, 'Stop', /Nudge/, 'Proposed', 'Ready', 'Done', 'Debrief', 'Challenge']) expect(has(name), String(name)).toBe(false)
    expect(screen.queryByText('Move it')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Fix the login', level: 1 })).toBeTruthy()
    expect(screen.getByText('Make it work.')).toBeTruthy()
    expect(has(/Copy link/)).toBe(true)
    // Who has it is told, not offered as a choice.
    expect(screen.queryByRole('button', { name: /Agent/ })).toBeNull()
    expect(screen.getAllByText('Agent').length).toBeGreaterThan(0)
  })

  it('has them all for a member', async () => {
    hubAs('member', world)
    await page()
    for (const name of [/^Delete/, 'Stop', /Nudge/]) expect(has(name), String(name)).toBe(true)
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('doesn’t offer to fix the words of a card that’s waiting, or to put it in Ready', async () => {
    hubAs('reader', () => hubState({ cards: [card('c1', 'proposed', { brief: 'Not yet.' })] }))
    await page()
    expect(has(/Put it in Ready/)).toBe(false)
    expect(screen.queryByText(/stay as they are/)).toBeNull()
    expect(screen.getByText('Not yet.')).toBeTruthy()
  })
})

describe('a note', () => {
  const world = () => hubState({ notes: [note('n1', '# One\n\nWords.'), note('n2', '# Two')] })

  it('opens read-only, with no Delete, Distill or Send to, for a reader; Chat and the versions are there', async () => {
    hubAs('reader', world)
    window.localStorage.clear()
    await mount(withUI(<Notes id="n1" />))
    await screen.findByTestId('editor')
    expect(screen.getByTestId('editor').getAttribute('data-readonly')).toBe('true')
    expect(screen.queryByTestId('toolbar')).toBeNull()
    // The note's ⋯ has what reads, and nothing that changes the Binder.
    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    const reads = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    expect(reads).toContain('Copy link')
    for (const changes of ['Delete this note', 'Schedule it', 'Give it its own change set', 'Make it the binder’s guide', 'Lock']) expect(reads).not.toContain(changes)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('tab', { name: /Distill/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /Chat/ })).toBeTruthy()
    expect(has('Versions and suggested changes')).toBe(true)
    expect(has('Save all notes')).toBe(false)
    expect(has('New note')).toBe(false)
  })

  it('opens to be typed in for a member, with all of them', async () => {
    hubAs('member', world)
    window.localStorage.clear()
    await mount(withUI(<Notes id="n1" />))
    await screen.findByTestId('editor')
    expect(screen.getByTestId('editor').getAttribute('data-readonly')).toBe('false')
    expect(screen.getByRole('tab', { name: /Distill/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More for this note' }))
    const all = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    for (const name of ['Lock', 'Make it the binder’s guide', 'Copy link', 'Schedule it', 'Give it its own change set', 'Delete this note']) expect(all).toContain(name)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(has('Save all notes')).toBe(true)
    expect(has('New note')).toBe(true)
  })

  // Going from one note to another throws away the first when nothing was ever written in it, which is a change.
  const leaving = async (role: 'reader' | 'member') => {
    const stood = hubAs(role, () => hubState({ notes: [note('n1', ''), note('n2', '# Two')] }))
    window.localStorage.clear()
    function Pair() {
      const [id, setId] = useState('n1')
      return <><button onClick={() => setId('n2')}>Next</button><Notes id={id} /></>
    }
    await mount(withUI(<Pair />))
    await screen.findByTestId('editor')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await settle(600)
    return stood.posted.flatMap((batch) => batch.changes.map((c) => c.change.type))
  }

  it('doesn’t throw away an empty note a reader only looked at when they go to another', async () => {
    expect(await leaving('member')).toContain('note.delete')
    cleanup()
    expect(await leaving('reader')).toEqual([])
  })

  it('has a list that browses and searches and makes nothing, moves nothing and deletes nothing', async () => {
    hubAs('reader', world)
    await mount(withUI(<NoteTree currentId="n1" />))
    const row = (await screen.findByText('n1')).closest('a')!
    expect(row.getAttribute('draggable')).toBe('false')
    fireEvent.contextMenu(row)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open', 'Copy link'])
    expect(has(/New note in/)).toBe(false)
    expect(has(/New folder in/)).toBe(false)
    expect(screen.getByPlaceholderText('Filter notes')).toBeTruthy()
  })
})

describe('a change set', () => {
  const pr = (n: number, over: Partial<PullRequest> = {}): PullRequest => ({ id: `acme/web#${n}`, repo: 'acme/web', number: n, title: `Page ${n}`, branch: `b${n}`, url: '', state: 'open', checks: [], files: [], ...over })
  const set: ChangeSet = { id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'review', prIds: ['acme/web#1'], noteIds: [] }
  const world = () => hubState({ pulls: [pr(1, { mergeable: 'behind' })], changeSets: [set] })

  it('has no Approve, no way to close or delete it, and no Update the branch, for a reader', async () => {
    hubAs('reader', world)
    await mount(withUI(<ChangeSets id="set-3" />))
    expect(has(/Approve/)).toBe(false)
    expect(has(/Delete change set/)).toBe(false)
    expect(has(/Update the branch/)).toBe(false)
    expect(screen.getByRole('heading', { name: /Change set #3/ })).toBeTruthy()
    expect(screen.getByText('Its base has moved on; nothing clashes.')).toBeTruthy()
  })

  it('has them for a member', async () => {
    hubAs('member', world)
    await mount(withUI(<ChangeSets id="set-3" />))
    expect(has(/Approve 1 and merge/)).toBe(true)
    expect(has(/Delete change set/)).toBe(true)
    expect(has(/Update the branch/)).toBe(true)
  })
})

describe('delivery', () => {
  const env = (over: Partial<Environment>): Environment => ({ id: 'acme/web#staging', repo: 'acme/web', name: 'staging', url: '', version: 'v1.1', changeSetIds: [], state: 'healthy', deployedAt: '', needsApproval: false, order: 0, ...over })
  const world = () => hubState({ environments: [env({ pullIds: ['acme/web#1'] }), env({ id: 'acme/web#production', name: 'production', order: 1, version: 'v1.0', needsApproval: true, deploy: { repo: 'acme/web', workflow: 'deploy.yml', ref: 'main' } })] })

  it('has no Promote for a reader, and one for a member', async () => {
    hubAs('reader', world)
    await mount(withUI(<Delivery />))
    expect(screen.getByRole('heading', { name: 'production', level: 3 })).toBeTruthy()
    expect(has(/Promote/)).toBe(false)
    expect(document.querySelector('.promote-arrow')).toBeTruthy()
    cleanup()
    hubAs('member', world)
    await mount(withUI(<Delivery />))
    expect(has(/Promote v1.1 to production/)).toBe(true)
  })
})

describe('agents', () => {
  const world = () => hubState({ agents: [{ ...agent, name: 'Builder', owner: 'ana' }] })

  it('has no Add an agent, and no Edit or menu on an agent, for a reader: only Claude Code, which acts as them', async () => {
    hubAs('reader', world)
    await mount(withUI(<Agents />))
    expect(screen.getByRole('heading', { name: 'Builder' })).toBeTruthy()
    for (const name of [/Add an agent/, 'Edit', /More for/, /Start the runner/, /Restart/]) expect(has(name), String(name)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Use from Claude Code' }))
    expect(await screen.findByRole('dialog', { name: 'Add the hub to Claude Code' })).toBeTruthy()
  })

  it('says nothing where its only content was the way to add one', async () => {
    hubAs('reader', () => hubState({ agents: [] }))
    await mount(withUI(<Agents />))
    expect(screen.getByText('No agents yet')).toBeTruthy()
    expect(has(/Add an agent/)).toBe(false)
  })

  it('has them for a member, the rare ones in each agent’s menu', async () => {
    hubAs('member', world)
    await mount(withUI(<Agents />))
    for (const name of [/Add an agent/, 'Edit', 'More for Builder']) expect(has(name), String(name)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'More for Builder' }))
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['New token', 'Revoke'])
  })
})

describe('⌘K', () => {
  it('leaves out the actions that change things for a reader, and keeps going to places and asking', async () => {
    hubAs('reader')
    await mount(withUI(<Palette onClose={() => {}} />))
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options.some((o) => o.startsWith('New note'))).toBe(false)
    expect(options.some((o) => o.startsWith('Set up an agent'))).toBe(false)
    expect(options.some((o) => o.startsWith('Board'))).toBe(true)
    expect(options.some((o) => o.startsWith('Your account'))).toBe(true)
  })

  it('has them for a member', async () => {
    hubAs('member')
    await mount(withUI(<Palette onClose={() => {}} />))
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options.some((o) => o.startsWith('New note'))).toBe(true)
    expect(options.some((o) => o.startsWith('Set up an agent'))).toBe(true)
  })
})

describe('what waits', () => {
  const busy = () => hubState({
    agents: [{ ...agent, lastSeen: new Date().toISOString() }],
    cards: [card('Which one', 'blocked', { agentId: 'a1', needsYou: 'Left or right?' })],
    changeSets: [{ id: 'cs1', binderId: 'b1', number: 4, title: 'Login work', summary: '', state: 'review', prIds: ['o/r#1'], noteIds: [] }],
  })

  it('gives a reader every row as someone else’s, so they are there to read and none is theirs', () => {
    const state = { ...busy(), me: { ...me, role: 'reader' } } as never
    const rows = waitingFor(state)
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.for === 'others')).toBe(true)
    const theirs = waitingFor({ ...(state as object), me: { ...me, role: 'member' } } as never)
    expect(theirs.map((r) => r.for).sort()).toEqual(['anyone', 'you'])
  })

  it('shows Home’s number, the sidebar’s badges and the tab’s title nothing, for a reader', async () => {
    hubAs('reader', busy)
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(100)
    const tile = screen.getByRole('button', { name: /Waiting on you/ })
    expect(within(tile).getByText('0')).toBeTruthy()
    expect(document.querySelectorAll('.side .count-flow, .side .count-changes, .tabbar .count-flow, .tabbar .count-changes')).toHaveLength(0)
    expect(document.title).not.toMatch(/^\(\d+\)/)
  })

  it('shows them to a member who has them', async () => {
    hubAs('member', busy)
    window.location.hash = '#/home'
    await mount(<App />)
    await settle(100)
    expect(within(screen.getByRole('button', { name: /Waiting on you/ })).getByText('2')).toBeTruthy()
    expect(document.title).toMatch(/^\(2\)/)
  })

  it('is read by Home, which has nothing of the reader’s to count', async () => {
    hubAs('reader', busy)
    await mount(withUI(<Home />))
    expect(within(screen.getByRole('button', { name: /Waiting on you/ })).getByText('0')).toBeTruthy()
  })
})

describe('a refusal that gets through', () => {
  const Who = () => <output data-testid="role">{useHub((s) => s.me?.role)}</output>

  it('shows the hub’s words as a toast, like any other, and undoes what was tried', async () => {
    // A member’s screen with a hub that says no, as it would to a reader pressing something that was missed.
    const you = { ...me, role: 'member' }
    standInHub(() => hubState({ cards: [card('c1')] }), you)
    standInRoute('POST', '/api/changes', () => new Response(JSON.stringify({ error: readerWords }), { status: 403, headers: { 'content-type': 'application/json' } }))
    await mount(withUI(<><Who /><Work id="c1" /></>))
    fireEvent.click(screen.getByRole('button', { name: 'Blocked' }))
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain(readerWords))
  })

  it('shows it for something sent on its own, too', async () => {
    standInHub(() => hubState({ cards: [card('c1', 'working', { agentId: 'a1' })] }), { ...me, role: 'member' })
    standInRoute('POST', '/api/cards/c1/comment', () => new Response(JSON.stringify({ error: readerWords }), { status: 403, headers: { 'content-type': 'application/json' } }))
    await mount(withUI(<Work id="c1" />))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } })
    await act(async () => { fireEvent.submit(screen.getByRole('textbox').closest('form')!) })
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain(readerWords))
  })
})
