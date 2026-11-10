// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor, type EditorHandle } from '../src/editor/MarkdownEditor'
import type { Marks } from '../src/editor/workMarks'

// The marks in a note's text lead somewhere: a card's opens the card, and the Proposed one opens Distill.

const links = { titles: () => [], exists: () => false, open: () => {} }

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})
afterEach(cleanup)

function editorWith(marks: Marks) {
  const ref = createRef<EditorHandle>()
  render(<MarkdownEditor ref={ref} text={'# Plan\n\nShip it\n\nAsk legal'} onChange={() => {}} links={links} marks={marks} raw={false} noteId="n1" />)
  return ref.current!.view()!.contentDOM
}

const proposed = { quote: 'Ask legal', kind: 'proposed' as const, label: 'Proposed' }
const cardMark = { quote: 'Ship it', kind: 'card' as const, label: '#4', tone: 'blue', stage: 'Working', itemId: 'c1' }

describe('the Proposed mark', () => {
  it('is a button a keyboard reaches, named for where it goes', () => {
    const chip = editorWith({ work: [proposed], open: () => {}, distill: () => {} }).querySelector<HTMLElement>('.proposed-chip')!
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('type')).toBe('button')
    expect(chip.getAttribute('tabindex')).toBeNull()
    expect(chip.getAttribute('aria-label')).toBe('Proposed: show it in Distill')
    expect(chip.title).toMatch(/Distill/)
  })

  it('opens Distill when pressed, however it’s pressed', () => {
    const distill = vi.fn()
    const chip = editorWith({ work: [proposed], open: () => {}, distill }).querySelector<HTMLElement>('.proposed-chip')!
    // A press with the keyboard (Enter or Space on a button) arrives as a click.
    fireEvent.click(chip)
    expect(distill).toHaveBeenCalledTimes(1)
  })

  it('doesn’t take the caret when pressed with a mouse', () => {
    const chip = editorWith({ work: [proposed], open: () => {}, distill: () => {} }).querySelector<HTMLElement>('.proposed-chip')!
    expect(fireEvent.mouseDown(chip, { button: 0 })).toBe(false)
  })

  it('is plain text when nothing is offered to go to', () => {
    const chip = editorWith({ work: [proposed], open: () => {} }).querySelector<HTMLElement>('.proposed-chip')!
    expect(chip.tagName).toBe('SPAN')
  })
})

describe('a card’s mark', () => {
  it('opens the card on a click, so Enter on it does too', () => {
    const open = vi.fn()
    const chip = editorWith({ work: [cardMark], open }).querySelector<HTMLElement>('.work-chip')!
    expect(chip.tagName).toBe('BUTTON')
    fireEvent.click(chip)
    expect(open).toHaveBeenCalledWith('c1')
  })
})
