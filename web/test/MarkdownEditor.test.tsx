// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { changesTo, noteDoc } from '../../shared/noteDoc.ts'
import { LiveNote } from '../src/data/liveNote'
import { MarkdownEditor, type EditorHandle } from '../src/editor/MarkdownEditor'

// The editor as the note screen uses it. It's in charge of its own text once a note's document is here, so what it must
// get right is which edits it tells the note about.

const links = { titles: () => [], exists: () => false, open: () => {} }
const marks = { work: [], open: () => {} }

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
  // What CodeMirror measures with, which jsdom has no layout for.
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})
afterEach(cleanup)

function open(text: string, onChange: (text: string, changes?: string[]) => void, live?: LiveNote) {
  const ref = createRef<EditorHandle>()
  render(<MarkdownEditor ref={ref} text={text} onChange={onChange} live={live} links={links} marks={marks} raw={false} noteId="n1" />)
  return ref.current!.view()!
}

const opened = async (text: string) => {
  const live = new LiveNote('n1', { fetchDoc: async () => undefined, waiting: () => ({ created: text, changes: [], whole: false }) })
  await live.open()
  return live
}

describe('a note’s lists', () => {
  it('hangs each item’s wrapped lines under its words, a step in for each level, whatever the note has for spaces', () => {
    const view = open('- top\n    - inner\n        - deepest\n\n1. one\n10. ten\n\n- [ ] a task\n\nwords', () => {})
    const lines = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-list-line')]
    expect(lines.map((line) => line.textContent?.trim())).toEqual(['top', 'inner', 'deepest', '1. one', '10. ten', 'a task'])
    const style = (at: number, name: string) => lines[at].style.getPropertyValue(name)
    expect([0, 1, 2].map((at) => style(at, '--depth'))).toEqual(['0', '1', '2'])
    expect(style(1, '--hang')).toBe('22px')
    expect(style(3, '--hang')).toBe('24px')
    expect(style(4, '--hang')).toBe('33px')
    expect(style(5, '--hang')).toBe('25px')
    expect(view.contentDOM.querySelectorAll('.cm-list-indent').length).toBe(2)
    expect(view.contentDOM.querySelectorAll('.cm-line:not(.cm-list-line)').length).toBe(4)
  })

  it('shows the mark on the line being written, keeping its place', () => {
    const view = open('- first\n- second', () => {})
    view.focus()
    view.dispatch({ selection: { anchor: 3 } })
    const lines = view.contentDOM.querySelectorAll('.cm-list-line')
    if (view.hasFocus) expect(lines[0].querySelector('.cm-list-mark')?.textContent).toBe('- ')
    expect(lines[1].querySelector('.cm-bullet')).toBeTruthy()
  })
})

describe('the editor', () => {
  it('says when someone starts and stops writing in it, and when it goes', () => {
    const focused = vi.fn()
    const ref = createRef<EditorHandle>()
    const page = render(<MarkdownEditor ref={ref} text="# Hi\n\nWords" onChange={() => {}} links={links} marks={marks} raw={false} noteId="n1" onFocusChange={focused} />)
    expect(focused).not.toHaveBeenCalled()
    page.unmount()
    expect(focused).toHaveBeenCalledWith(false)
  })

  it('sends the whole text until the note’s document is here', () => {
    const onChange = vi.fn()
    const view = open('# Hi', onChange)
    view.dispatch({ changes: { from: 4, insert: '!' } })
    expect(onChange).toHaveBeenCalledWith('# Hi!')
  })

  it('makes what you type into changes to the document once it is', async () => {
    const onChange = vi.fn()
    const live = await opened('# Hi')
    const view = open('# Hi', onChange, live)
    view.dispatch({ changes: { from: 4, insert: '!' } })
    expect(onChange).toHaveBeenCalledOnce()
    const [text, changes] = onChange.mock.calls[0] as [string, string[]]
    expect(text).toBe('# Hi!')
    expect(changes).toHaveLength(1)
    expect(live.text).toBe('# Hi!')
  })

  it('shows a teammate’s edit where it was made, without sending it back', async () => {
    const onChange = vi.fn()
    const live = await opened('one two')
    const view = open('one two', onChange, live)
    view.dispatch({ selection: { anchor: 7 } })
    live.hear(changesTo(noteDoc('n1', 'one two'), 'zero one two'))
    expect(view.state.doc.toString()).toBe('zero one two')
    expect(view.state.selection.main.head).toBe(12)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes a teammate’s text before the document is here, keeping your place', () => {
    const onChange = vi.fn()
    const ref = createRef<EditorHandle>()
    const { rerender } = render(<MarkdownEditor ref={ref} text="one two" onChange={onChange} links={links} marks={marks} raw={false} />)
    const view = ref.current!.view()!
    view.dispatch({ selection: { anchor: 7 } })
    rerender(<MarkdownEditor ref={ref} text="one two three" onChange={onChange} links={links} marks={marks} raw={false} />)
    expect(view.state.doc.toString()).toBe('one two three')
    expect(view.state.selection.main.head).toBe(7)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('doesn’t send the same words twice when text arrives that it already has', () => {
    const onChange = vi.fn()
    const ref = createRef<EditorHandle>()
    const { rerender } = render(<MarkdownEditor ref={ref} text="same" onChange={onChange} links={links} marks={marks} raw={false} />)
    const before = ref.current!.view()!.state.doc
    rerender(<MarkdownEditor ref={ref} text="same" onChange={onChange} links={links} marks={marks} raw={false} />)
    expect(ref.current!.view()!.state.doc).toBe(before)
  })

  it('stops listening for the theme when it goes', () => {
    const removing = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<MarkdownEditor text="" onChange={() => {}} links={links} marks={marks} raw={false} />)
    unmount()
    expect(removing).toHaveBeenCalledWith('binders-theme', expect.any(Function))
  })
})
