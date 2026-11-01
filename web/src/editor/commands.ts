import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'

// Formatting, as the toolbar, the slash menu and the keys do it: wrap what's selected, or set what a line is.

/** Wraps each selection in `mark` (**, *, `, ~~), or takes it off when it's already there. */
export function toggleWrap(view: EditorView, mark: string) {
  const { state } = view
  view.dispatch(state.changeByRange((range) => {
    const before = state.sliceDoc(range.from - mark.length, range.from)
    const after = state.sliceDoc(range.to, range.to + mark.length)
    if (before === mark && after === mark) {
      return {
        changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
        range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
      }
    }
    return {
      changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
    }
  }))
  view.focus()
  return true
}

const linePrefix = /^(\s*)(#{1,6}\s+|>\s?(\[![a-z]+\]\s?)?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/

/** Makes each selected line a heading, a list item, a quote…, or plain again when it already is that. */
export function setLinePrefix(view: EditorView, prefix: string) {
  const { state } = view
  const changes: ChangeSpec[] = []
  const seen = new Set<number>()
  let number = 1
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos)
      pos = line.to + 1
      if (seen.has(line.number)) continue
      seen.add(line.number)
      const match = linePrefix.exec(line.text)!
      const current = match[2] ?? ''
      const wanted = prefix === '1. ' ? `${number++}. ` : prefix
      const same = current.trim() === wanted.trim() || (prefix === '1. ' && /^\d+[.)]\s+$/.test(current))
      changes.push({ from: line.from + match[1].length, to: line.from + match[1].length + current.length, insert: same ? '' : wanted })
    }
  }
  // The caret moves on past a marker put in where it stood.
  const set = state.changes(changes)
  view.dispatch({ changes: set, selection: state.selection.map(set, 1), scrollIntoView: true })
  view.focus()
  return true
}

/** Puts `text` on a line of its own where the caret is, with the caret at `caret` within it, selecting `select` characters. */
export function insertBlock(view: EditorView, text: string, caret = text.length, from = view.state.selection.main.from, to = view.state.selection.main.to, select = 0) {
  const { state } = view
  const line = state.doc.lineAt(from)
  const before = state.sliceDoc(line.from, from).trim() ? '\n\n' : ''
  const after = state.sliceDoc(to, line.to).trim() ? '\n' : ''
  const insert = before + text + after
  const at = from + before.length + caret
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: at, head: at + select }, scrollIntoView: true })
  view.focus()
  return true
}

export function insertLink(view: EditorView) {
  const range = view.state.selection.main
  const words = view.state.sliceDoc(range.from, range.to)
  const insert = `[${words || 'words'}](https://)`
  const urlAt = range.from + insert.length - 9
  view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: words ? { anchor: urlAt + 1, head: urlAt + 8 } : { anchor: range.from + 1, head: range.from + 6 } })
  view.focus()
  return true
}

export const tableTemplate = '| Column | Column | Column |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'
export const mermaidTemplate = '```mermaid\nflowchart LR\n  A[Start] --> B[Next]\n```'

export const formattingKeys: KeyBinding[] = [
  { key: 'Mod-b', run: (view) => toggleWrap(view, '**') },
  { key: 'Mod-i', run: (view) => toggleWrap(view, '*') },
  { key: 'Mod-e', run: (view) => toggleWrap(view, '`') },
  { key: 'Mod-Shift-x', run: (view) => toggleWrap(view, '~~') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Alt-1', run: (view) => setLinePrefix(view, '# ') },
  { key: 'Mod-Alt-2', run: (view) => setLinePrefix(view, '## ') },
  { key: 'Mod-Alt-3', run: (view) => setLinePrefix(view, '### ') },
  { key: 'Mod-Shift-l', run: (view) => setLinePrefix(view, '- [ ] ') },
  { key: 'Mod-Shift-8', run: (view) => setLinePrefix(view, '- ') },
  { key: 'Mod-Shift-7', run: (view) => setLinePrefix(view, '1. ') },
  { key: 'Mod-Shift-.', run: (view) => setLinePrefix(view, '> ') },
  { key: 'Mod-Alt-c', run: (view) => insertBlock(view, '```\n\n```', 4) },
]
