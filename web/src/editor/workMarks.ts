import { RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

// The work that came from a note, shown where it came from: a card's number at the end of its words' line, tinted, and
// what Distill proposed underlined with a Proposed chip. Someone else in the note shows as their name at their line.

export interface WorkMark {
  quote: string
  kind: 'card' | 'proposed'
  label: string
  tone?: string
  /** The card's column, said beside its number so it reads at a glance. */
  stage?: string
  itemId?: string
}

export interface Presence {
  quote: string
  name: string
  hue: number
}

export interface Marks {
  work: WorkMark[]
  presence?: Presence
  open: (itemId: string) => void
  /** A right-click on a card's chip: its menu. */
  menu?: (itemId: string, event: MouseEvent) => void
}

export const setMarks = StateEffect.define<Marks>()

class ChipWidget extends WidgetType {
  mark: WorkMark
  open: (itemId: string) => void
  menu?: (itemId: string, event: MouseEvent) => void
  constructor(mark: WorkMark, open: (itemId: string) => void, menu?: (itemId: string, event: MouseEvent) => void) {
    super()
    this.mark = mark
    this.open = open
    this.menu = menu
  }
  eq(other: ChipWidget) {
    return other.mark.label === this.mark.label && other.mark.tone === this.mark.tone && other.mark.kind === this.mark.kind && other.mark.stage === this.mark.stage
  }
  toDOM() {
    const chip = document.createElement(this.mark.itemId ? 'button' : 'span')
    chip.className = `work-chip ${this.mark.kind === 'proposed' ? 'proposed-chip' : this.mark.tone ?? ''}`
    if (this.mark.kind === 'card') chip.appendChild(document.createElement('i'))
    const label = document.createElement('b')
    label.textContent = this.mark.label
    chip.appendChild(label)
    if (this.mark.stage) {
      const stage = document.createElement('span')
      stage.textContent = this.mark.stage
      chip.appendChild(stage)
    }
    if (this.mark.itemId) {
      chip.title = 'Open the card · right-click for more'
      chip.addEventListener('mousedown', (event) => {
        if ((event as MouseEvent).button !== 0) return
        event.preventDefault()
        this.open(this.mark.itemId!)
      })
      chip.addEventListener('contextmenu', (event) => {
        if (!this.menu) return
        this.menu(this.mark.itemId!, event as MouseEvent)
      })
    }
    return chip
  }
  ignoreEvent() {
    return true
  }
}

class PresenceWidget extends WidgetType {
  presence: Presence
  constructor(presence: Presence) {
    super()
    this.presence = presence
  }
  eq(other: PresenceWidget) {
    return other.presence.name === this.presence.name
  }
  toDOM() {
    const caret = document.createElement('span')
    caret.className = 'cm-presence'
    caret.style.setProperty('--hue', String(this.presence.hue))
    const name = document.createElement('i')
    name.textContent = this.presence.name
    caret.appendChild(name)
    return caret
  }
}

function build(state: EditorState, marks: Marks | undefined): DecorationSet {
  if (!marks || (!marks.work.length && !marks.presence)) return Decoration.none
  const text = state.doc.toString()
  const found: { at: number; line: number; deco: Decoration; lineDeco?: Decoration }[] = []
  for (const mark of marks.work) {
    const index = text.indexOf(mark.quote)
    if (index < 0) continue
    const line = state.doc.lineAt(index)
    found.push({ at: line.to, line: line.from, deco: Decoration.widget({ widget: new ChipWidget(mark, marks.open, marks.menu), side: 1 }), lineDeco: Decoration.line({ class: mark.kind === 'proposed' ? 'cm-proposed' : 'cm-linked' }) })
  }
  if (marks.presence) {
    const index = text.indexOf(marks.presence.quote)
    if (index >= 0) {
      const line = state.doc.lineAt(index)
      found.push({ at: line.to, line: line.from, deco: Decoration.widget({ widget: new PresenceWidget(marks.presence), side: 2 }) })
    }
  }
  found.sort((a, b) => a.line - b.line || a.at - b.at)
  const builder = new RangeSetBuilder<Decoration>()
  const lined = new Set<number>()
  // Line decorations first at each line start, then the widgets at its end.
  const byLine = new Map<number, typeof found>()
  for (const f of found) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f])
  for (const [line, list] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const lineDeco = list.find((f) => f.lineDeco)?.lineDeco
    if (lineDeco && !lined.has(line)) {
      builder.add(line, line, lineDeco)
      lined.add(line)
    }
    for (const f of list) builder.add(f.at, f.at, f.deco)
  }
  return builder.finish()
}

export const workMarks = StateField.define<{ marks?: Marks; decorations: DecorationSet }>({
  create: () => ({ decorations: Decoration.none }),
  update(value, transaction) {
    let marks = value.marks
    for (const effect of transaction.effects) if (effect.is(setMarks)) marks = effect.value
    if (marks !== value.marks || transaction.docChanged) return { marks, decorations: build(transaction.state, marks) }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})
