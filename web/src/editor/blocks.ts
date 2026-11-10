import { ensureSyntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { showMarkdown } from './options'

// What shows as a whole while the caret is elsewhere: a table as a grid, a ```mermaid block as its drawing. Clicking
// one puts the caret in its Markdown, as Binders for Mac does.

/** Redraws the diagrams, after the theme changes. */
export const redraw = StateEffect.define<null>()

function cells(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: { text: string; start: number }[] = []
  const start = line.indexOf('|') === line.search(/\S/) ? line.indexOf('|') + 1 : line.search(/\S/)
  let current = ''
  let cellStart = start
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (char === '|') {
      out.push({ text: current.trim(), start: cellStart })
      current = ''
      cellStart = start + i + 1
      continue
    }
    current += char
  }
  out.push({ text: current.trim(), start: cellStart })
  return out
}

class TableWidget extends WidgetType {
  source: string
  from: number
  constructor(source: string, from: number) {
    super()
    this.source = source
    this.from = from
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    const table = document.createElement('table')
    table.className = 'cm-table'
    const lines = this.source.split('\n')
    const aligns = cells(lines[1] ?? '').map((c) => (/^:-+:$/.test(c.text) ? 'center' : /-+:$/.test(c.text) ? 'right' : 'left'))
    let offset = this.from
    lines.forEach((line, index) => {
      const lineFrom = offset
      offset += line.length + 1
      if (index === 1) return
      const row = document.createElement('tr')
      for (const [column, cell] of cells(line).entries()) {
        const el = document.createElement(index === 0 ? 'th' : 'td')
        el.textContent = cell.text || '\u00a0'
        el.style.textAlign = aligns[column] ?? 'left'
        const at = lineFrom + cell.start + (line.slice(cell.start).length - line.slice(cell.start).trimStart().length)
        el.addEventListener('mousedown', (event) => {
          event.preventDefault()
          view.dispatch({ selection: { anchor: Math.min(at + cell.text.length, view.state.doc.length) } })
          view.focus()
        })
        row.appendChild(el)
      }
      ;(index === 0 ? (table.tHead ?? table.createTHead()) : (table.tBodies[0] ?? table.createTBody())).appendChild(row)
    })
    wrap.appendChild(table)
    return wrap
  }
  ignoreEvent() {
    return false
  }
}

let mermaidReady: Promise<typeof import('mermaid').default> | undefined
let drawn = 0
/** Diagrams drawn, by theme and source. Editing one draws a new one each time, so only the latest are kept. */
const cache = new Map<string, DocumentFragment>()
const drawingsKept = 40

/** Keeps a drawing, dropping the one unused longest: a Map keeps its keys in the order they went in. */
export function keepDrawing<T>(kept: Map<string, T>, key: string, drawing: T, limit = drawingsKept) {
  kept.delete(key)
  kept.set(key, drawing)
  if (kept.size > limit) kept.delete(kept.keys().next().value!)
}

const drawingKey = (colors: { text: string; bg: string }, source: string) => `${colors.text}|${colors.bg}|${source}`

/** The page's colours now, so a diagram is drawn in black on white or white on black like the rest. */
function palette() {
  const style = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return { bg: pick('--surface', '#ffffff'), text: pick('--text', '#0a0a0a'), muted: pick('--muted', '#525252'), fill: pick('--surface-3', '#f0f0f0') }
}

export async function draw(source: string) {
  const colors = palette()
  const key = drawingKey(colors, source)
  const known = cache.get(key)
  if (known) return known
  mermaidReady ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidReady
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'Nunito Sans, -apple-system, system-ui, sans-serif',
    themeVariables: {
      background: colors.bg,
      primaryColor: colors.fill,
      primaryTextColor: colors.text,
      primaryBorderColor: colors.text,
      lineColor: colors.muted,
      secondaryColor: colors.bg,
      tertiaryColor: colors.bg,
      textColor: colors.text,
      fontSize: '14px',
    },
    // Drawn at their own size; a wide one scrolls rather than shrinking its words.
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
  })
  const id = `mermaid-${++drawn}`
  try {
    const { svg } = await mermaid.render(id, source)
    const { safeSvg } = await import('./safeSvg')
    const drawing = safeSvg(svg)
    keepDrawing(cache, key, drawing)
    return drawing
  } catch (error) {
    // A diagram it can't read leaves its working in the page, and typing one out fails on every pause.
    document.getElementById(`d${id}`)?.remove()
    throw error
  }
}

class MermaidWidget extends WidgetType {
  source: string
  from: number
  version: number
  constructor(source: string, from: number, version: number) {
    super()
    this.source = source
    this.from = from
    this.version = version
  }
  eq(other: MermaidWidget) {
    return other.source === this.source && other.version === this.version
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div')
    box.className = 'cm-mermaid'
    box.title = 'Click to edit the diagram'
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ selection: { anchor: Math.min(this.from + 11, view.state.doc.length) } })
      view.focus()
    })
    const known = cache.get(drawingKey(palette(), this.source))
    if (known) box.replaceChildren(known.cloneNode(true))
    else {
      box.classList.add('loading')
      box.textContent = 'Drawing…'
      draw(this.source).then((drawing) => {
        box.classList.remove('loading')
        box.replaceChildren(drawing.cloneNode(true))
      }).catch((error: Error) => {
        box.classList.remove('loading')
        box.classList.add('failed')
        box.textContent = `Mermaid couldn’t draw this: ${error.message.split('\n')[0]}`
      })
    }
    return box
  }
  ignoreEvent() {
    return false
  }
  get estimatedHeight() {
    return 180
  }
}

let themeVersion = 0

function build(state: EditorState): DecorationSet {
  if (state.facet(showMarkdown)) return Decoration.none
  const tree = ensureSyntaxTree(state, state.doc.length, 200)
  if (!tree) return Decoration.none
  const found: Range<Decoration>[] = []
  const touches = (from: number, to: number) => state.selection.ranges.some((r) => r.to >= from && r.from <= to)
  tree.iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        const from = state.doc.lineAt(node.from).from
        const to = state.doc.lineAt(node.to).to
        if (!touches(from, to)) found.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(from, to), from), block: true }).range(from, to))
        return false
      }
      if (node.name === 'FencedCode') {
        const info = node.node.getChild('CodeInfo')
        if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== 'mermaid') return false
        const from = state.doc.lineAt(node.from).from
        const to = state.doc.lineAt(node.to).to
        const text = state.sliceDoc(from, to)
        const closed = /\n```\s*$/.test(text)
        if (!closed || touches(from, to)) return false
        const body = text.replace(/^```mermaid[^\n]*\n/, '').replace(/\n```\s*$/, '')
        found.push(Decoration.replace({ widget: new MermaidWidget(body, from, themeVersion), block: true }).range(from, to))
        return false
      }
    },
  })
  return Decoration.set(found, true)
}

export const blocks = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.effects.some((e) => e.is(redraw))) {
      themeVersion++
      return build(transaction.state)
    }
    if (transaction.docChanged || transaction.selection || transaction.startState.facet(showMarkdown) !== transaction.state.facet(showMarkdown)) return build(transaction.state)
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})
