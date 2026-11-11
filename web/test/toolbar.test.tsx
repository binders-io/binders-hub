// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ContextMenuHost } from '../src/components/ContextMenu'
import type { EditorHandle } from '../src/editor/MarkdownEditor'
import { Toolbar } from '../src/editor/Toolbar'

// The formatting bar is one row: what doesn't fit in its width goes into a ⋯ at its end, and works from there.

/** The bar in a window this wide, with an editor holding `text`. */
function bar(width: number, text = 'one') {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('md-toolbar') ? width : 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const view = new EditorView({ state: EditorState.create({ doc: text }), parent: document.body.appendChild(document.createElement('div')) })
  const editor = createRef<EditorHandle>() as { current: EditorHandle | null }
  editor.current = { view: () => view } as unknown as EditorHandle
  render(<><Toolbar editor={editor} raw={false} onRaw={() => {}} /><ContextMenuHost /></>)
  return view
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the formatting bar', () => {
  it('shows every tool when they fit, and no ⋯', () => {
    bar(2000)
    expect(screen.getByRole('button', { name: 'Bulleted list' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Diagram' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More formatting' })).toBeNull()
  })

  it('puts the groups that don’t fit in a ⋯, in one row, and they work from there', async () => {
    const view = bar(320)
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(within(toolbar).getByRole('button', { name: 'Bold' })).toBeTruthy()
    expect(within(toolbar).queryByRole('button', { name: 'Bulleted list' })).toBeNull()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More formatting' }))
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    expect(items).toEqual(expect.arrayContaining(['Bulleted list', 'Checklist', 'Table', 'Link to a note']))
    expect(items).not.toContain('Bold')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bulleted list' }))
    expect(view.state.doc.toString()).toBe('- one')
    view.destroy()
  })

  it('keeps Show Markdown at its end, whatever the width', () => {
    bar(200)
    expect(screen.getByRole('button', { name: /Markdown/ })).toBeTruthy()
  })
})
