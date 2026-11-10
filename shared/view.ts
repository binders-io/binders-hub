import { z } from 'zod'

// What the Brain can show beside its words: a view, made of parts from this one list. A model writes it as JSON, the hub
// checks it against this list before a browser ever sees it, and the web app draws each part with a component of its own
// (json-render's flat form: a root and a map of elements, each a part with its props and children). Nothing outside the
// list is drawn, a part's props are only what its shape allows, and a view has no script, no markup and nothing a press
// can set off beyond asking the Brain another question. What a part says comes from a model, so it is words to read,
// never something to act on. A Thing is the exception: the hub fills it in from its own state, and it is shown live.

const words = (most: number) => z.string().max(most)
const tone = z.enum(['plain', 'good', 'warn', 'bad'])

/** The most a view holds: its elements, how deep they nest, and its size as JSON. */
export const viewMost = { elements: 60, depth: 6, bytes: 16_000 }

/** Each part: whether it holds other parts, the shape of its props, and what a model is told of it. */
export const viewParts = {
  Stack: { holds: true, props: z.object({}), says: '{} : its children one under another. Use it as the root.' },
  Row: { holds: true, props: z.object({}), says: '{} : its children side by side, such as a few Stats.' },
  Section: { holds: true, props: z.object({ title: words(80) }), says: '{"title"} : a titled group of children.' },
  Text: { holds: false, props: z.object({ text: words(1200) }), says: '{"text"} : a short paragraph. Plain words, **bold** and `code`.' },
  Callout: { holds: false, props: z.object({ tone, title: words(80).nullish(), text: words(600) }), says: '{"tone": "plain|good|warn|bad", "title"?, "text"} : one thing to notice.' },
  Stat: { holds: false, props: z.object({ label: words(40), value: words(24), detail: words(80).nullish(), tone: tone.nullish() }), says: '{"label", "value", "detail"?, "tone"?} : one number that matters.' },
  Facts: { holds: false, props: z.object({ rows: z.array(z.object({ name: words(60), value: words(240) })).min(1).max(20) }), says: '{"rows": [{"name", "value"}]} : names with their values.' },
  List: { holds: false, props: z.object({ items: z.array(words(240)).min(1).max(30), numbered: z.boolean().nullish() }), says: '{"items": ["…"], "numbered"?: true}' },
  Steps: { holds: false, props: z.object({ items: z.array(z.object({ title: words(100), detail: words(240).nullish(), state: z.enum(['done', 'now', 'next']).nullish() })).min(1).max(20) }), says: '{"items": [{"title", "detail"?, "state"?: "done|now|next"}]} : a sequence, a plan or a timeline.' },
  Table: { holds: false, props: z.object({ columns: z.array(words(40)).min(1).max(8), rows: z.array(z.array(words(240)).max(8)).min(1).max(40) }), says: '{"columns": ["…"], "rows": [["…"]]}' },
  Chart: {
    holds: false,
    props: z.object({ kind: z.enum(['bar', 'line', 'donut']), title: words(80).nullish(), labels: z.array(words(30)).min(1).max(24), series: z.array(z.object({ name: words(40), values: z.array(z.number()).min(1).max(24) })).min(1).max(4), unit: words(12).nullish() }),
    says: '{"kind": "bar|line|donut", "title"?, "labels": ["…"], "series": [{"name", "values": [numbers]}], "unit"?} : numbers to compare. One value for each label.',
  },
  Diagram: { holds: false, props: z.object({ title: words(80).nullish(), code: words(4000) }), says: '{"title"?, "code"} : a drawing of how things connect or flow. code is Mermaid: flowchart, sequenceDiagram, stateDiagram-v2, gantt or mindmap.' },
  Thing: {
    holds: false,
    props: z.object({ kind: z.enum(['card', 'set', 'env', 'agent']), binder: words(160), id: words(160), title: words(240), detail: words(300).nullish() }),
    says: '{"ref"} or {"agent"} : a card, change set or environment from “What’s going on now” by its mark there, such as {"ref": "c3"}, or an agent by its name, such as {"agent": "Sonnet"}. Shown live. Use it instead of retyping what the board says.',
  },
  Suggest: { holds: false, props: z.object({ questions: z.array(words(140)).min(1).max(4) }), says: '{"questions": ["…"]} : up to four short things they might ask next, in their own words.' },
} as const

export type ViewPart = keyof typeof viewParts
export type ViewProps<P extends ViewPart> = z.infer<(typeof viewParts)[P]['props']>

export interface ViewElement {
  type: ViewPart
  props: Record<string, unknown>
  children: string[]
}

/** A view as it's kept and drawn: json-render's flat spec, with only what this list allows. */
export interface View {
  root: string
  elements: Record<string, ViewElement>
}

const isPart = (type: unknown): type is ViewPart => typeof type === 'string' && Object.hasOwn(viewParts, type)

/**
 * A view read from anything: what a model wrote, or what came over the wire. Each element is kept only as a part from
 * the list with props of its shape; one that isn't is left out with everything under it, and so is one already above
 * itself. Undefined when nothing is left to show.
 */
export function readView(raw: unknown): View | undefined {
  const given = raw as { root?: unknown; elements?: unknown } | null | undefined
  if (!given || typeof given.root !== 'string' || !given.elements || typeof given.elements !== 'object' || Array.isArray(given.elements)) return undefined
  const from = given.elements as Record<string, unknown>
  const elements: Record<string, ViewElement> = {}
  let count = 0

  const take = (key: string, depth: number, above: Set<string>): boolean => {
    if (depth > viewMost.depth || above.has(key) || Object.hasOwn(elements, key) || count >= viewMost.elements) return false
    const element = Object.hasOwn(from, key) ? (from[key] as { type?: unknown; props?: unknown; children?: unknown } | null) : undefined
    if (!element || typeof element !== 'object' || !isPart(element.type)) return false
    const part = viewParts[element.type]
    const props = part.props.safeParse(element.props ?? {})
    if (!props.success) return false
    count++
    const kept: ViewElement = { type: element.type, props: props.data as Record<string, unknown>, children: [] }
    elements[key] = kept
    if (part.holds && Array.isArray(element.children)) {
      const under = new Set(above).add(key)
      for (const child of element.children) if (typeof child === 'string' && take(child, depth + 1, under)) kept.children.push(child)
    }
    // A group with nothing in it says nothing.
    if (part.holds && !kept.children.length) {
      delete elements[key]
      count--
      return false
    }
    return true
  }

  if (!take(given.root, 1, new Set())) return undefined
  const view: View = { root: given.root, elements }
  return JSON.stringify(view).length <= viewMost.bytes ? view : undefined
}

/** The binders a view's Things are in: a view is shown only to someone who is in every one. */
export const viewBinders = (view: View) => [...new Set(Object.values(view.elements).flatMap((e) => (e.type === 'Thing' ? [String(e.props.binder)] : [])))]
