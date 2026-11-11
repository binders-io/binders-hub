import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { startCompletion } from '@codemirror/autocomplete'
import { Bold, Code, Eye, EyeOff, Heading1, Heading2, Italic, Link, List, ListChecks, ListOrdered, Minus, Network, Quote, SquareCode, Strikethrough, Table, Link2 } from 'lucide-react'
import { insertBlock, insertLink, mermaidTemplate, setLinePrefix, tableTemplate, toggleWrap } from './commands'
import type { EditorHandle } from './MarkdownEditor'
import type { EditorView } from '@codemirror/view'
import { MenuButton, type MenuItem } from '../kit'

interface Tool {
  label: string
  keys?: string
  icon: typeof Bold
  run: (view: EditorView) => void
}

const groups: Tool[][] = [
  [
    { label: 'Heading 1', keys: '⌥⌘1', icon: Heading1, run: (v) => setLinePrefix(v, '# ') },
    { label: 'Heading 2', keys: '⌥⌘2', icon: Heading2, run: (v) => setLinePrefix(v, '## ') },
  ],
  [
    { label: 'Bold', keys: '⌘B', icon: Bold, run: (v) => toggleWrap(v, '**') },
    { label: 'Italic', keys: '⌘I', icon: Italic, run: (v) => toggleWrap(v, '*') },
    { label: 'Strikethrough', keys: '⇧⌘X', icon: Strikethrough, run: (v) => toggleWrap(v, '~~') },
    { label: 'Code', keys: '⌘E', icon: Code, run: (v) => toggleWrap(v, '`') },
    { label: 'Link', keys: '⌘K', icon: Link, run: insertLink },
  ],
  [
    { label: 'Bulleted list', keys: '⇧⌘8', icon: List, run: (v) => setLinePrefix(v, '- ') },
    { label: 'Numbered list', keys: '⇧⌘7', icon: ListOrdered, run: (v) => setLinePrefix(v, '1. ') },
    { label: 'Checklist', keys: '⇧⌘L', icon: ListChecks, run: (v) => setLinePrefix(v, '- [ ] ') },
    { label: 'Quote', keys: '⇧⌘.', icon: Quote, run: (v) => setLinePrefix(v, '> ') },
  ],
  [
    { label: 'Code block', keys: '⌥⌘C', icon: SquareCode, run: (v) => insertBlock(v, '```\n\n```', 4) },
    { label: 'Table', icon: Table, run: (v) => insertBlock(v, tableTemplate, 2, undefined, undefined, 6) },
    { label: 'Diagram', icon: Network, run: (v) => insertBlock(v, mermaidTemplate, 11) },
    { label: 'Divider', icon: Minus, run: (v) => insertBlock(v, '---\n') },
    {
      label: 'Link to a note', keys: '[[', icon: Link2, run: (v) => {
        const at = v.state.selection.main.from
        v.dispatch({ changes: { from: at, insert: '[[]]' }, selection: { anchor: at + 2 } })
        v.focus()
        startCompletion(v)
      },
    },
  ],
]

/** How wide a tool is, and what a group adds for the line between it and the next: as 06-notes.css draws them. */
const toolWidth = 30
const groupGap = 13
const moreWidth = 32

/** How many of the groups fit in a width, the rest going to the ⋯; all of them when nothing has been measured. */
function groupsThatFit(width: number, fixed: number) {
  if (width <= 0) return groups.length
  const widths = groups.map((group) => group.length * toolWidth + groupGap)
  if (widths.reduce((sum, w) => sum + w, fixed) <= width) return groups.length
  let used = fixed + moreWidth
  let fit = 0
  for (const w of widths) {
    if (used + w > width) break
    used += w
    fit++
  }
  return fit
}

/**
 * The formatting toolbar over the editor, and Show Markdown at its end: one row of grouped buttons, and what doesn't fit
 * in a ⋯ at its end, so it's never more than one row. On a phone it's under the words while they're being written, over
 * the keyboard, with a way to put the keyboard away, and it scrolls sideways instead.
 */
export function Toolbar({ editor, raw, onRaw, onDone }: { editor: RefObject<EditorHandle | null>; raw: boolean; onRaw: (raw: boolean) => void; onDone?: () => void }) {
  const bar = useRef<HTMLDivElement>(null)
  const markdown = useRef<HTMLButtonElement>(null)
  const [fit, setFit] = useState(groups.length)
  useLayoutEffect(() => {
    const row = bar.current
    if (!row || onDone || typeof ResizeObserver === 'undefined') return
    const measure = () => setFit(groupsThatFit(row.clientWidth, (markdown.current?.offsetWidth ?? 0) + 8))
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(row)
    return () => watch.disconnect()
  }, [onDone])
  const run = (tool: Tool) => {
    const view = editor.current?.view()
    if (view) tool.run(view)
  }
  const shown = onDone ? groups : groups.slice(0, fit)
  const rest = onDone ? [] : groups.slice(fit)
  const overflow = (): MenuItem[] => rest.flatMap((group, index) => [
    ...(index ? [{ separator: true as const }] : []),
    ...group.map((tool) => {
      const Icon = tool.icon
      return { label: tool.label, icon: <Icon size={14} />, onSelect: () => run(tool) }
    }),
  ])
  return (
    <div ref={bar} className={`md-toolbar${onDone ? ' docked' : ''}`} role="toolbar" aria-label="Formatting">
      {shown.map((group, index) => (
        <div key={index} className="md-tool-group">
          {group.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.label}
                type="button"
                className="md-tool"
                title={tool.keys ? `${tool.label}  ${tool.keys}` : tool.label}
                aria-label={tool.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(tool)}
              >
                <Icon size={16} />
              </button>
            )
          })}
        </div>
      ))}
      {rest.length > 0 && <MenuButton className="md-tool md-more" label="More formatting" items={overflow} />}
      <button ref={markdown} type="button" className={`md-tool md-raw${raw ? ' on' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onRaw(!raw)} aria-pressed={raw} title={raw ? 'Hide the Markdown' : 'Show the Markdown on every line'}>
        {raw ? <EyeOff size={16} /> : <Eye size={16} />}
        <span>Markdown</span>
      </button>
      {onDone && <button type="button" className="md-tool md-done" onClick={onDone}>Done</button>}
    </div>
  )
}
