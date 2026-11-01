import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { activeLines } from './livePreview'
import { linkHost, showMarkdown } from './options'

// [[Links]] between notes, as Obsidian writes them: [[Title]], [[Title|shown as]], [[Title#Heading]]. They show as the
// words, a link to a note that isn't there yet shows faint, and following one that isn't there makes the note.

const pattern = /\[\[([^\]|\n]+?)(\|([^\]\n]*))?\]\]/g

function build(view: EditorView): DecorationSet {
  const { state } = view
  const host = state.facet(linkHost)
  const raw = state.facet(showMarkdown)
  const active = activeLines(state, view.hasFocus)
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to)
    for (const match of text.matchAll(pattern)) {
      const start = from + match.index
      const end = start + match[0].length
      const inside = syntaxTree(state).resolveInner(start, 1)
      if (/Code/.test(inside.name) || /Code/.test(inside.parent?.name ?? '')) continue
      const target = match[1].trim()
      const note = target.split(/[#^]/)[0].trim()
      const known = !host || host.exists(note)
      const editing = raw || active.has(state.doc.lineAt(start).number)
      const label = match[3] !== undefined ? match[3] : match[1]
      const labelFrom = match[3] !== undefined ? end - 2 - match[3].length : start + 2
      const labelTo = end - 2
      const mark = Decoration.mark({ class: `cm-wikilink${known ? '' : ' missing'}`, attributes: { 'data-target': note, title: known ? `Open “${note}”` : `Make a note called “${note}”` } })
      if (editing) {
        builder.add(start, end, mark)
      } else {
        builder.add(start, labelFrom, Decoration.replace({}))
        if (label) builder.add(labelFrom, labelTo, mark)
        builder.add(labelTo, end, Decoration.replace({}))
      }
    }
  }
  return builder.finish()
}

export const wikiLinks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || update.startState.facet(linkHost) !== update.state.facet(linkHost) || update.startState.facet(showMarkdown) !== update.state.facet(showMarkdown)) {
        this.decorations = build(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const link = (event.target as HTMLElement).closest('.cm-wikilink') as HTMLElement | null
        if (!link?.dataset.target) return false
        // On a line being edited a click puts the caret, unless ⌘ is down.
        const line = view.state.doc.lineAt(view.posAtDOM(link)).number
        if (activeLines(view.state, view.hasFocus).has(line) && !(event.metaKey || event.ctrlKey)) return false
        event.preventDefault()
        view.state.facet(linkHost)?.open(link.dataset.target)
        return true
      },
    },
  },
)

/** After "[[": the notes whose titles match what's typed, and a new note of that name when none does. */
export function linkCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\[\[[^\]\n]*$/)
  if (!before) return null
  const host = context.state.facet(linkHost)
  if (!host) return null
  const typed = before.text.slice(2)
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean)
  const after = context.state.sliceDoc(context.pos, context.pos + 2)
  const close = after === ']]' ? '' : ']]'
  const typedLower = typed.trim().toLowerCase()
  const titles = host.titles()
    .filter((t) => words.every((w) => t.toLowerCase().includes(w)))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(typedLower)) - Number(!b.toLowerCase().startsWith(typedLower)) || a.localeCompare(b))
  const options = titles.slice(0, 30).map((title) => ({ label: title, type: 'note', apply: `${title}${close}` }))
  if (typed.trim() && !titles.some((t) => t.toLowerCase() === typed.trim().toLowerCase())) {
    options.push({ label: typed.trim(), type: 'new', apply: `${typed.trim()}${close}`, detail: 'new note' } as (typeof options)[number])
  }
  // Our own order: existing notes first, a new one last.
  return { from: before.from + 2, options, filter: false }
}
