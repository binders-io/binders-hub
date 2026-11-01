import { startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { pickPictures } from './pictures'
import { insertBlock, mermaidTemplate, setLinePrefix, tableTemplate } from './commands'

// Typing "/" at the start of a line, or after a space, offers what a note can hold, as Binders for Mac's slash menu
// does: headings, lists, a checklist, a quote, code, a table, a diagram… Typing on narrows it.

interface Item {
  id: string
  label: string
  keywords: string
  hint?: string
  run: (view: EditorView, from: number, to: number) => void
}

/** Takes the "/word" away, then does the item's work where it was. */
const atLine = (prefix: string) => (view: EditorView, from: number, to: number) => {
  view.dispatch({ changes: { from, to }, selection: { anchor: from } })
  setLinePrefix(view, prefix)
}
const block = (text: string, caret?: number, select = 0) => (view: EditorView, from: number, to: number) => {
  insertBlock(view, text, caret, from, to, select)
}
const words = (text: () => string) => (view: EditorView, from: number, to: number) => {
  const insert = text()
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
}

const items: Item[] = [
  { id: 'h1', label: 'Heading 1', keywords: 'title h1 #', hint: '⌥⌘1', run: atLine('# ') },
  { id: 'h2', label: 'Heading 2', keywords: 'subtitle h2 ##', hint: '⌥⌘2', run: atLine('## ') },
  { id: 'h3', label: 'Heading 3', keywords: 'h3 ###', hint: '⌥⌘3', run: atLine('### ') },
  { id: 'task', label: 'Checklist', keywords: 'todo to-do task checkbox', hint: '⇧⌘L', run: atLine('- [ ] ') },
  { id: 'bullet', label: 'Bulleted list', keywords: 'bullets unordered ul', hint: '⇧⌘8', run: atLine('- ') },
  { id: 'numbered', label: 'Numbered list', keywords: 'ordered ol numbers', hint: '⇧⌘7', run: atLine('1. ') },
  { id: 'quote', label: 'Quote', keywords: 'blockquote citation', hint: '⇧⌘.', run: atLine('> ') },
  { id: 'callout', label: 'Callout', keywords: 'note tip warning admonition', run: block('> [!note] Title\n> ', 16) },
  { id: 'code', label: 'Code block', keywords: 'snippet pre fence', hint: '⌥⌘C', run: block('```\n\n```', 4) },
  { id: 'table', label: 'Table', keywords: 'grid columns rows', run: block(tableTemplate, 2, 6) },
  { id: 'mermaid', label: 'Diagram', keywords: 'mermaid flowchart chart sequence graph', run: block(mermaidTemplate, 11) },
  { id: 'divider', label: 'Divider', keywords: 'rule line separator hr ---', run: block('---\n') },
  { id: 'image', label: 'Picture', keywords: 'image photo screenshot upload', run: (view, from, to) => pickPictures(view, from, to) },
  {
    id: 'link', label: 'Link to a note', keywords: 'wiki [[ reference page', run: (view, from, to) => {
      view.dispatch({ changes: { from, to, insert: '[[]]' }, selection: { anchor: from + 2 } })
      startCompletion(view)
    },
  },
  { id: 'date', label: 'Today’s date', keywords: 'day now today', run: words(() => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })) },
  { id: 'time', label: 'The time', keywords: 'now hour', run: words(() => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })) },
]

export function slashCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/(?:^|\s)\/[\w-]*$/)
  if (!before) return null
  const slashAt = before.from + before.text.indexOf('/')
  const line = context.state.doc.lineAt(slashAt)
  // Not inside code.
  if (/^\s*(```|    )/.test(line.text)) return null
  const typed = context.state.sliceDoc(slashAt + 1, context.pos).toLowerCase()
  // Names that start with what's typed first, then names that have it, then other words it answers to.
  const rank = (item: Item) => {
    const label = item.label.toLowerCase()
    return label.startsWith(typed) ? 0 : label.split(/\s+/).some((w) => w.startsWith(typed)) ? 1 : label.includes(typed) ? 2 : 3
  }
  const options: Completion[] = items
    .filter((item) => !typed || `${item.label} ${item.keywords}`.toLowerCase().includes(typed))
    .sort((a, b) => rank(a) - rank(b))
    .map((item, index) => ({
      label: item.label,
      detail: item.hint,
      type: `slash-${item.id}`,
      boost: -index,
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => item.run(view, from - 1, to),
    }))
  if (!options.length) return null
  return { from: slashAt + 1, options, filter: false }
}
