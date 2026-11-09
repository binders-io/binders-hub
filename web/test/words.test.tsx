// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agent, card, hubState, mount, note, settle, standInHub } from './harness'
import { BlastView, SetChallenge } from '../src/components/Challenge'
import { NoteTree } from '../src/components/NoteTree'
import { ScheduleDialog } from '../src/components/Schedules'
import { SideAgents } from '../src/components/SideAgents'
import { Agents } from '../src/screens/Agents'
import { ChangeSets } from '../src/screens/ChangeSets'
import { Home } from '../src/screens/Home'
import { Notes } from '../src/screens/Notes'
import { UIContext } from '../src/ui'
import type { ChangeSet, PullRequest } from '../src/data/model'

// One word for each thing: what's inside a binder is a part, a suggested change is a note's, an agent whose runner
// isn't up is Not running, what a person has to do is Waiting on you, and so on. The old words must not come back.

vi.mock('../src/editor/MarkdownEditor', () => ({ MarkdownEditor: () => <div data-testid="editor" /> }))
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => null }))

const ui = { openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} }
const pull: PullRequest = { id: 'acme/web#7', repo: 'acme/web', number: 7, title: 'A page', branch: 'b', url: 'https://github.com/acme/web/pull/7', state: 'open', checks: [], files: [] }
const set = (over: Partial<ChangeSet> = {}): ChangeSet => ({ id: 'set-3', binderId: 'b1', number: 3, title: 'Pages', summary: '', state: 'review', prIds: [pull.id], noteIds: [], ...over })

beforeEach(() => {
  Element.prototype.scrollTo = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('part', () => {
  it('is what a new binder’s name box calls what’s inside a binder, not project', async () => {
    standInHub(() => hubState({ binders: [], notes: [], cards: [] }))
    await mount(<UIContext.Provider value={ui}><NoteTree currentId="" /></UIContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Start its notes' }))
    expect((screen.getByPlaceholderText(/^New .*’s name$/) as HTMLInputElement).placeholder).toBe('New part’s name')
  })

  it('is what a change set’s Challenge says has no agent yet', async () => {
    standInHub(() => hubState({ agents: [], pulls: [pull], changeSets: [set()], cards: [card('c1', 'review', { prId: pull.id })] }))
    await mount(<UIContext.Provider value={ui}><SetChallenge set={set()} /></UIContext.Provider>)
    expect(screen.getByText(/No agent works in this part yet/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/project/i)
  })
})

describe('suggested changes', () => {
  it('is what the notes list’s badge calls a change someone proposed to a locked note', async () => {
    const locked = { ...note('n1', '# Standards'), locked: { by: 'sam', at: 'then' } }
    standInHub(() => hubState({ notes: [locked], noteProposals: [{ id: 'np-1', noteId: 'n1', binderId: 'b1', by: 'a1', at: 'then', why: 'Spaces.', base: locked.text, text: '# Standards\n\nUse spaces.', state: 'open', comments: [] }] }))
    await mount(<UIContext.Provider value={ui}><NoteTree currentId="n1" /></UIContext.Provider>)
    expect(document.querySelector('i.waiting')?.getAttribute('title')).toBe('Suggested changes to review')
  })
})

describe('Not running', () => {
  const never = { ...agent, id: 'a9', name: 'Fresh' }

  it('is what an agent that has never run says, on the Agents page, in the sidebar and on Home', async () => {
    standInHub(() => hubState({ agents: [never] }))
    await mount(<UIContext.Provider value={ui}><Agents /><SideAgents agents={[never]} /><Home /></UIContext.Provider>)
    // The card, the sidebar's row and Home's tile.
    expect(screen.getAllByText('Not running').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('Its runner isn’t running.').length).toBeGreaterThanOrEqual(2)
    expect(document.body.textContent).not.toMatch(/Not connected|Not started|No runner is listening|isn’t listening/)
  })

  it('is said in a sentence on Home when an agent is heard from but its runner isn’t up', async () => {
    standInHub(() => hubState({ agents: [{ ...agent, lastSeen: new Date().toISOString() }] }))
    await mount(<UIContext.Provider value={ui}><Home /></UIContext.Provider>)
    // Heard from a moment ago, so online, but not listening for work.
    expect(screen.getByText(/Online, but its runner isn’t running\./)).toBeTruthy()
    expect(screen.queryByText('Not running')).toBeNull()
    expect(document.body.textContent).not.toContain('not listening')
  })

  it('is what a Distill waiting for an agent says to tell it', async () => {
    standInHub(() => hubState({ notes: [note('n1', '# One\n\nwords')], agents: [agent], cards: [card('d1', 'ready', { title: 'Distill “One” into work items', noteId: 'n1' })] }))
    window.localStorage.setItem('binders-note-side', 'distill')
    await mount(<UIContext.Provider value={ui}><Notes id="n1" /></UIContext.Provider>)
    expect(await screen.findByText(/Its runner isn’t running\. In Claude Code/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/isn’t listening/)
  })
})

describe('a change set', () => {
  beforeEach(() => {
    standInHub(() => hubState({ pulls: [pull], changeSets: [set()] }))
  })
  const open = () => mount(<UIContext.Provider value={ui}><ChangeSets id="set-3" /></UIContext.Provider>)

  it('says Waiting on you when it’s the person’s to approve', async () => {
    await open()
    await settle(50)
    expect(screen.getAllByText('Waiting on you').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('Waiting for you')
  })

  it('has inner tabs that say what they hold: Pull requests, Debrief and Challenge', async () => {
    await open()
    expect(within(screen.getByRole('tablist', { name: 'This change set' })).getAllByRole('tab').map((t) => t.firstChild?.textContent ?? t.textContent)).toEqual(['Pull requests', 'Debrief', 'Challenge'])
    expect(screen.queryByRole('tab', { name: /^Review/ })).toBeNull()
    expect(screen.queryByRole('tab', { name: /^Changes/ })).toBeNull()
  })
})

describe('a schedule', () => {
  it('that isn’t one of the offered ones is Custom times', async () => {
    standInHub(() => hubState({ notes: [note('n1', '# One')] }))
    await mount(<ScheduleDialog noteId="n1" onClose={() => {}} />)
    expect(within(screen.getByLabelText('Runs')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Every hour', 'Every day', 'Weekdays', 'Every week', 'Custom times'])
    expect(document.body.textContent).not.toContain('Custom (cron)')
  })
})

describe('what a Challenge says a change reaches', () => {
  it('is What else this touches', () => {
    render(<BlastView blast={{ at: 'then', symbols: [], outside: 0, stillUsed: 0, untested: 0 }} />)
    expect(screen.getByText('What else this touches')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/blast/i)
  })
})
