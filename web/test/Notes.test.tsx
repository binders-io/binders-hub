// @vitest-environment jsdom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entry, hear, hubState, mount, note, settle, standInHub } from './harness'
import { useActions } from '../src/data/store'
import type { Marks } from '../src/editor/workMarks'
import type { LinkHost } from '../src/editor/options'
import { Notes } from '../src/screens/Notes'

// What typing must not touch. New marks send the editor a second transaction on every keystroke, and the list and the
// chat have no business drawing for a change to one note's words.

const seen = vi.hoisted(() => ({ marks: [] as unknown[], links: [] as unknown[], tree: 0, chat: 0, text: '' }))
vi.mock('../src/editor/MarkdownEditor', () => ({
  MarkdownEditor: (props: { marks: Marks; links: LinkHost; text: string }) => {
    seen.marks.push(props.marks)
    seen.links.push(props.links)
    seen.text = props.text
    return null
  },
}))
vi.mock('../src/editor/Toolbar', () => ({ Toolbar: () => null }))
vi.mock('../src/components/NoteTree', () => ({ NoteTree: () => { seen.tree++; return null } }))
vi.mock('../src/components/NoteChat', () => ({ NoteChat: () => { seen.chat++; return null } }))

let actions: ReturnType<typeof useActions>
function Grab() {
  actions = useActions()
  return null
}

// Under its heading: changing the heading changes its title, which the list does show.
const typing = () => act(async () => {
  actions.editNote('n1', '# n1\n\na')
  actions.editNote('n1', '# n1\n\nab')
  actions.editNote('n1', '# n1\n\nabc')
})

beforeEach(() => {
  Object.assign(seen, { marks: [], links: [], tree: 0, chat: 0, text: '' })
  const state = () => hubState({
    notes: [note('n1', '# n1'), { ...note('n2', 'See [[n1]] for more'), work: [{ itemId: 'c1', quote: 'See' }] }],
    proposals: [{ id: 'p', binderId: 'b1', noteId: 'n1', title: 'Do it', quote: 'One', brief: '', doneWhen: '', size: 'S', by: 'a1', state: 'new' }],
  })
  standInHub(state)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('typing in a note', () => {
  it('reaches the editor with the note’s words', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    await typing()
    expect(seen.text).toBe('# n1\n\nabc')
  })

  it('leaves the marks and links as they were, so the editor isn’t sent them again', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    await settle(50)
    const [marks, links] = [seen.marks.at(-1), seen.links.at(-1)]
    await typing()
    await settle(300)
    expect(seen.marks.at(-1)).toBe(marks)
    expect(seen.links.at(-1)).toBe(links)
  })

  it('doesn’t draw the notes list or the chat', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    await settle(50)
    const { tree, chat } = seen
    await typing()
    await settle(300)
    expect(seen.tree).toBe(tree)
    expect(seen.chat).toBe(chat)
  })

  it('changes the marks when a proposal does, so the editor shows it', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    await settle(50)
    const marks = seen.marks.at(-1) as Marks
    expect(marks.work.map((m) => m.label)).toEqual(['Proposed'])
    await hear({ type: 'entries', entries: [entry(2, { type: 'proposal.update', id: 'p', fields: { state: 'dismissed' } })] })
    expect((seen.marks.at(-1) as Marks).work).toEqual([])
  })

  it('draws the list when the heading changes, as that’s the note’s title', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    await settle(50)
    const { tree } = seen
    await act(async () => actions.editNote('n1', '# Renamed'))
    expect(seen.tree).toBeGreaterThan(tree)
  })

  it('finds [[links]] in other notes, and updates as they’re written', async () => {
    await mount(<><Grab /><Notes id="n1" /></>)
    expect(document.querySelector('.backlink')?.textContent).toContain('See n1 for more')
    await hear({ type: 'entries', entries: [entry(2, { type: 'note.edit', id: 'n2', text: 'Nothing now', title: 'n2', by: 'sam', at: 'now' })] })
    expect(document.querySelector('.backlink')).toBeNull()
  })
})
