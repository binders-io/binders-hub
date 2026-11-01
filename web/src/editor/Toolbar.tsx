import type { RefObject } from 'react'
import { startCompletion } from '@codemirror/autocomplete'
import { Bold, Code, Eye, EyeOff, Heading1, Heading2, Italic, Link, List, ListChecks, ListOrdered, Minus, Network, Quote, SquareCode, Strikethrough, Table, Link2 } from 'lucide-react'
import { insertBlock, insertLink, mermaidTemplate, setLinePrefix, tableTemplate, toggleWrap } from './commands'
import type { EditorHandle } from './MarkdownEditor'
import type { EditorView } from '@codemirror/view'

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

/** The formatting toolbar over the editor, and Show Markdown at its end. */
export function Toolbar({ editor, raw, onRaw }: { editor: RefObject<EditorHandle | null>; raw: boolean; onRaw: (raw: boolean) => void }) {
  return (
    <div className="md-toolbar" role="toolbar" aria-label="Formatting">
      {groups.map((group, index) => (
        <div key={index} className="md-tool-group">
          {group.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.label}
                className="md-tool"
                title={tool.keys ? `${tool.label}  ${tool.keys}` : tool.label}
                aria-label={tool.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const view = editor.current?.view()
                  if (view) tool.run(view)
                }}
              >
                <Icon size={15} />
              </button>
            )
          })}
        </div>
      ))}
      <button className={`md-tool md-raw${raw ? ' on' : ''}`} onClick={() => onRaw(!raw)} aria-pressed={raw} title={raw ? 'Hide the Markdown' : 'Show the Markdown on every line'}>
        {raw ? <EyeOff size={15} /> : <Eye size={15} />}
        <span>Markdown</span>
      </button>
    </div>
  )
}
