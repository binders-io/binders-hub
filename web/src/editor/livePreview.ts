import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { showMarkdown } from './options'

// Live preview, as Obsidian and Binders for Mac do it: the note stays Markdown, and it shows rendered. Headings without
// their #, bold without its **, links as their words, bullets as dots, checkboxes you click. The markup comes back,
// faintly, on the lines you're editing, and everywhere with Show Markdown.

/** The lines the selection touches while you're in the note: their markup shows. Just opening a note shows none. */
export function activeLines(state: EditorState, focused = true) {
  const lines = new Set<number>()
  if (!focused) return lines
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) lines.add(n)
  }
  return lines
}

const hidden = Decoration.replace({})

/** The space after a list's mark goes with it: words start at the same place on every line of the item. */
class BulletWidget extends WidgetType {
  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-bullet'
    dot.setAttribute('aria-hidden', 'true')
    return dot
  }
  eq() {
    return true
  }
}

class CheckboxWidget extends WidgetType {
  checked: boolean
  at: number
  constructor(checked: boolean, at: number) {
    super()
    this.checked = checked
    this.at = at
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.at === this.at
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Done' : 'Not done')
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      // "[ ]" ↔ "[x]": the character between the brackets.
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent() {
    return false
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const rule = document.createElement('span')
    rule.className = 'cm-rule'
    return rule
  }
  eq() {
    return true
  }
}

class ImageWidget extends WidgetType {
  src: string
  alt: string
  constructor(src: string, alt: string) {
    super()
    this.src = src
    this.alt = alt
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM() {
    const img = document.createElement('img')
    img.className = 'cm-image'
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    return img
  }
}

class CalloutWidget extends WidgetType {
  kind: string
  constructor(kind: string) {
    super()
    this.kind = kind
  }
  eq(other: CalloutWidget) {
    return other.kind === this.kind
  }
  toDOM() {
    const label = document.createElement('span')
    label.className = `cm-callout-label ${this.kind}`
    label.textContent = this.kind.charAt(0).toUpperCase() + this.kind.slice(1)
    return label
  }
}

const lineClass = (name: string) => Decoration.line({ class: name })

/** How far words start from a list item's mark, in pixels: bullets, boxes, and numbers by how many digits they have. */
const hangOf = (marker: string, task: boolean) => (task ? 25 : /^[-*+]$/.test(marker) ? 22 : 24 + Math.max(0, marker.length - 2) * 9)

/** How many lists a list item is inside, beyond its own. */
function depthOf(mark: { parent: { name: string; parent: unknown } | null }) {
  let depth = -1
  for (let at = mark.parent as { name: string; parent: unknown } | null; at; at = at.parent as typeof at) {
    if (at.name === 'BulletList' || at.name === 'OrderedList') depth++
  }
  return Math.max(0, depth)
}
const markClass = (name: string, attributes?: Record<string, string>) => Decoration.mark({ class: name, attributes })

function build(view: EditorView): DecorationSet {
  const { state } = view
  const raw = state.facet(showMarkdown)
  const active = activeLines(state, view.hasFocus)
  const isActive = (pos: number) => raw || active.has(state.doc.lineAt(pos).number)
  const found: Range<Decoration>[] = []
  const seenLines = new Set<string>()
  const addLine = (pos: number, name: string) => {
    const line = state.doc.lineAt(pos)
    const key = `${line.from}:${name}`
    if (seenLines.has(key)) return
    seenLines.add(key)
    found.push(lineClass(name).range(line.from))
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name)
        if (heading) {
          addLine(node.from, `cm-h cm-h${heading[1]}`)
          return
        }
        switch (name) {
          case 'HeaderMark': {
            if (isActive(node.from)) return
            const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            found.push(hidden.range(node.from, after))
            return
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'CodeMark': {
            const parent = node.node.parent?.name
            if (parent === 'FencedCode') return
            if (!isActive(node.from)) found.push(hidden.range(node.from, node.to))
            return
          }
          case 'InlineCode':
            found.push(markClass('cm-inline-code').range(node.from, node.to))
            return
          case 'Link': {
            const url = node.node.getChild('URL')
            const marks = node.node.getChildren('LinkMark')
            const href = url ? state.doc.sliceString(url.from, url.to) : ''
            if (marks.length >= 2) found.push(markClass('cm-link', { 'data-href': href }).range(marks[0].to, marks[1].from))
            if (!isActive(node.from) && marks.length >= 2) {
              found.push(hidden.range(node.from, marks[0].to))
              found.push(hidden.range(marks[1].from, node.to))
            }
            return false
          }
          case 'Image': {
            if (isActive(node.from)) return false
            const url = node.node.getChild('URL')
            const text = state.doc.sliceString(node.from, node.to)
            const alt = /^!\[([^\]]*)\]/.exec(text)?.[1] ?? ''
            if (url) found.push(Decoration.replace({ widget: new ImageWidget(state.doc.sliceString(url.from, url.to), alt) }).range(node.from, node.to))
            return false
          }
          case 'URL':
            if (node.node.parent?.name !== 'Link') found.push(markClass('cm-link', { 'data-href': state.doc.sliceString(node.from, node.to) }).range(node.from, node.to))
            return
          case 'Blockquote': {
            for (let pos = node.from; pos <= node.to; ) {
              const line = state.doc.lineAt(pos)
              addLine(line.from, 'cm-quote')
              pos = line.to + 1
            }
            // > [!note] Title: an Obsidian callout.
            const first = state.doc.lineAt(node.from)
            const callout = /^>\s*\[!(\w+)\]\s?/.exec(first.text)
            if (callout) {
              addLine(first.from, `cm-callout-title cm-callout-${callout[1].toLowerCase()}`)
              if (!isActive(first.from)) {
                found.push(Decoration.replace({ widget: new CalloutWidget(callout[1].toLowerCase()) }).range(first.from, first.from + callout[0].length))
              }
            }
            return
          }
          case 'QuoteMark': {
            if (isActive(node.from)) return
            const line = state.doc.lineAt(node.from)
            // A callout's first line was handled with its label.
            if (/^>\s*\[!\w+\]/.test(line.text) && line.from === node.from) return
            const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            found.push(hidden.range(node.from, after))
            return
          }
          case 'ListMark': {
            const item = node.node.parent
            const task = item?.getChild('Task')
            const box = task?.getChild('TaskMarker')
            const text = state.doc.sliceString(node.from, node.to)
            const line = state.doc.lineAt(node.from)
            // Wrapped lines hang under the words, each level a step in, whatever the note has for spaces.
            const key = `${line.from}:list`
            if (!seenLines.has(key)) {
              seenLines.add(key)
              found.push(Decoration.line({ class: 'cm-list-line', attributes: { style: `--depth:${depthOf(node.node)};--hang:${hangOf(text, !!task)}px` } }).range(line.from))
              if (node.from > line.from && !state.doc.sliceString(line.from, node.from).trim()) found.push(markClass('cm-list-indent').range(line.from, node.from))
            }
            const spaced = (to: number) => (state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)
            if (isActive(node.from)) {
              found.push(markClass('cm-list-mark').range(node.from, spaced(box ? box.to : node.to)))
              return
            }
            if (task) {
              // A task's bullet goes; its box stands for it.
              found.push(hidden.range(node.from, spaced(node.to)))
            } else if (/^[-*+]$/.test(text)) {
              found.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, spaced(node.to)))
            } else {
              found.push(markClass('cm-list-mark cm-list-number').range(node.from, spaced(node.to)))
            }
            return
          }
          case 'TaskMarker': {
            const checked = /x/i.test(state.doc.sliceString(node.from, node.to))
            if (checked) found.push(markClass('cm-task-done').range(node.to, state.doc.lineAt(node.to).to))
            if (isActive(node.from)) return
            const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            found.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, after))
            return
          }
          case 'HorizontalRule':
            if (!isActive(node.from)) found.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
            return
          case 'FencedCode': {
            const firstLine = state.doc.lineAt(node.from).number
            const lastLine = state.doc.lineAt(node.to).number
            for (let n = firstLine; n <= lastLine; n++) {
              const line = state.doc.line(n)
              addLine(line.from, `cm-codeblock${n === firstLine ? ' cm-codeblock-first' : ''}${n === lastLine ? ' cm-codeblock-last' : ''}`)
            }
            return
          }
        }
      },
    })
  }

  // #tags, outside code.
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to)
    for (const match of text.matchAll(/(^|[\s(])#([A-Za-z][\w/-]*)/g)) {
      const start = from + match.index + match[1].length
      const end = start + match[2].length + 1
      const inside = syntaxTree(state).resolveInner(start, 1)
      if (/Code|URL|Header/.test(inside.name) || /Code/.test(inside.parent?.name ?? '')) continue
      if (state.doc.lineAt(start).text.startsWith('#') && start === state.doc.lineAt(start).from) continue
      found.push(markClass('cm-tag').range(start, end))
    }
  }

  found.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  const builder = new RangeSetBuilder<Decoration>()
  let lastTo = -1
  for (const range of found) {
    // Replacements can't overlap; the first one wins.
    if (range.value.spec.widget !== undefined || range.value === hidden) {
      if (range.from < lastTo) continue
      lastTo = range.to
    }
    builder.add(range.from, range.to, range.value)
  }
  return builder.finish()
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || update.startState.facet(showMarkdown) !== update.state.facet(showMarkdown) || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      // A link's words open it in a new tab, except on a line being edited, where a click puts the caret.
      mousedown(event, view) {
        const target = event.target as HTMLElement
        const link = target.closest('.cm-link') as HTMLElement | null
        const href = link?.dataset.href
        if (!href || !(event.metaKey || event.ctrlKey || !activeLines(view.state, view.hasFocus).has(view.state.doc.lineAt(view.posAtDOM(link!)).number))) return false
        event.preventDefault()
        window.open(href, '_blank', 'noopener')
        return true
      },
    },
  },
)
