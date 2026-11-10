import { firstRules } from '../hub/src/brain/first.ts'
import type { BrainModel, Passage } from '../hub/src/brain/models.ts'

// The demo hub's Brain: no model at all, only a few answers written here, put together from the board the hub hands it.
// It is there so the Brain's page can be looked at with nothing set up: what it says of the work is what the invented
// hub holds, and it shows each kind of view. Asked anything else, it says what it can be asked. For an agent's question it
// drafts an answer when a note has a sentence about it, and says it's the person's to decide when none does.

const boardTitle = 'What’s going on now'
const block = (view: unknown) => `\`\`\`view\n${JSON.stringify(view)}\n\`\`\``

/** The lines under one heading of the board, up to the next. */
const under = (board: string, heading: string) => (board.split(`\n${heading}:\n`)[1]?.split(/\n(?=[A-Z][^\n]*:\n)/)[0] ?? '').split('\n').filter((line) => line.startsWith('- ') && !/^- (nothing|none|and \d+ more)/.test(line))

/** The marks on some lines, and the titles beside them. */
const marked = (lines: string[]) => lines.flatMap((line) => {
  const found = /\[([a-z]\d+(?:-\d+)?)\] (?:Change set #\d+, )?“([^”]+)”/.exec(line)
  return found ? [{ mark: found[1], title: found[2] }] : []
})

type Elements = Record<string, { type: string; props: Record<string, unknown>; children?: string[] }>

/** A view with these parts one under another. */
function stack(parts: Elements, order: string[]) {
  return { root: 'all', elements: { all: { type: 'Stack', props: {}, children: order }, ...parts } }
}

/** A titled group of Things, one for each mark; nothing when there are none. */
function things(elements: Elements, key: string, title: string, refs: Record<string, unknown>[]) {
  if (!refs.length) return []
  const children = refs.map((props, i) => {
    elements[`${key}${i}`] = { type: 'Thing', props }
    return `${key}${i}`
  })
  elements[key] = { type: 'Section', props: { title }, children }
  return [key]
}

function reply(question: string, board: string, passages: Passage[]): { words: string; view?: unknown; cites?: number[] } {
  const asked = question.toLowerCase()
  const agents = under(board, 'Agents').map((line) => /^- (.+?) \(/.exec(line)?.[1]).filter((name): name is string => !!name)
  const waiting = marked(under(board, 'Waiting on you'))
  const working = marked(under(board, 'Being worked on'))
  const ready = marked(under(board, 'Ready for an agent'))
  const review = under(board, 'Finished, in review').map((line) => /“([^”]+)”/.exec(line)?.[1]).filter((title): title is string => !!title)
  const sets = marked(under(board, 'Change sets (releases)'))
  const next = (questions: string[]) => ({ type: 'Suggest', props: { questions } })

  const stopping = /^(?:please )?stop\b(.*)/.exec(asked)
  if (stopping) {
    const wanted = stopping[1].replace(/\b(the|work|on|card|it)\b/g, ' ').trim().split(/\s+/).filter(Boolean)
    const card = working.find((c) => wanted.length && wanted.every((word) => c.title.toLowerCase().includes(word))) ?? (wanted.length ? undefined : working[0])
    return card ? { words: `DO stop ${card.mark}` } : { words: 'I couldn’t tell which card you meant. Say a few words of its title.' }
  }

  if (/need|waiting on me|wait/.test(asked)) {
    if (!waiting.length) return { words: 'Nothing is waiting on you.', view: stack({ none: { type: 'Callout', props: { tone: 'good', title: 'All clear', text: 'No agent is asking you anything, and nothing is held for you.' } }, next: next(['What are my agents working on?', 'What’s in review?']) }, ['none', 'next']) }
    const elements: Elements = { next: next(['What are my agents working on?']) }
    return { words: `${waiting.length === 1 ? 'One thing is' : `${waiting.length} things are`} waiting on you.`, view: stack(elements, [...things(elements, 'w', 'Waiting on you', waiting.map((c) => ({ ref: c.mark }))), 'next']) }
  }

  if (/agent|working on|who/.test(asked)) {
    const elements: Elements = { next: next(['What needs me?', 'Draw how the open work fits together']) }
    const order = [...things(elements, 'a', 'Agents', agents.map((name) => ({ agent: name }))), ...things(elements, 'c', 'Being worked on', working.map((c) => ({ ref: c.mark }))), 'next']
    return { words: agents.length ? `${agents.length === 1 ? 'One agent is' : `${agents.length} agents are`} set up, with ${working.length || 'nothing'} being worked on.` : 'No agents are set up yet.', view: stack(elements, order) }
  }

  if (/review|release|change set/.test(asked)) {
    const elements: Elements = { next: next(['What needs me?', 'How many cards are in each stage?']) }
    const order = things(elements, 's', 'Change sets', sets.map((s) => ({ ref: s.mark })))
    if (review.length) {
      elements.list = { type: 'List', props: { items: review } }
      elements.done = { type: 'Section', props: { title: 'Finished, in review' }, children: ['list'] }
      order.push('done')
    }
    return { words: review.length || sets.length ? `${review.length} finished and in review, ${sets.length} change set${sets.length === 1 ? '' : 's'} open.` : 'Nothing is in review, and no change set is open.', view: stack(elements, [...order, 'next']) }
  }

  if (/draw|diagram|fit|flow/.test(asked)) {
    const name = (title: string) => title.replace(/["\[\]{}()<>|#;`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    const lines = ['flowchart LR', '  notes([Notes]) --> ready', '  subgraph ready [Ready]', ...(ready.length ? ready.slice(0, 4).map((c, i) => `    r${i}["${name(c.title)}"]`) : ['    r0["Nothing waiting"]']), '  end', '  subgraph working [Being worked on]', ...(working.length ? working.slice(0, 5).map((c, i) => `    w${i}["${name(c.title)}"]`) : ['    w0["Nothing"]']), '  end', '  ready --> working', '  working --> review([In review])', ...(sets.length ? sets.slice(0, 3).map((s, i) => `  review --> s${i}{{"${name(s.title)}"}}`) : ['  review --> sets{{Change sets}}']), '  review --> you((You approve))']
    return { words: 'This is how the open work moves, from notes to what you approve.', view: stack({ drawing: { type: 'Diagram', props: { title: 'The open work', code: lines.join('\n') } }, next: next(['What needs me?', 'What’s in review?']) }, ['drawing', 'next']) }
  }

  if (/how many|count|chart|stage|number/.test(asked)) {
    const labels = ['Waiting on you', 'Being worked on', 'Ready', 'In review', 'Change sets']
    const values = [waiting.length, working.length, ready.length, review.length, sets.length]
    const stat = (label: string, value: number, tone?: string) => ({ type: 'Stat', props: { label, value: String(value), ...(tone ? { tone } : {}) } })
    return {
      words: 'Here is how the open work is spread.',
      view: stack({
        stats: { type: 'Row', props: {}, children: ['s0', 's1', 's2'] },
        s0: stat('Waiting on you', waiting.length, waiting.length ? 'warn' : 'good'), s1: stat('Being worked on', working.length), s2: stat('In review', review.length),
        chart: { type: 'Chart', props: { kind: 'bar', title: 'Open work', labels, series: [{ name: 'Cards', values }] } },
        table: { type: 'Table', props: { columns: ['Where', 'How many'], rows: labels.map((label, i) => [label, String(values[i])]) } },
      }, ['stats', 'chart', 'table']),
    }
  }

  const found = passages.find((p) => p.title !== boardTitle)
  if (found) return { words: `From “${found.title}”: ${found.text.replace(/\s+/g, ' ').trim().slice(0, 280)}`, cites: [passages.indexOf(found)], view: stack({ next: next(['What needs me?', 'What are my agents working on?']) }, ['next']) }
  return { words: 'This is a demo hub, so its Brain knows only a few questions.', view: stack({ next: next(['What needs me?', 'What are my agents working on?', 'What’s in review?', 'Draw how the open work fits together']) }, ['next']) }
}

/**
 * A draft of an answer to an agent's question, as the Brain's first look asks for one: the sentence among the notes that
 * shares the most words with the question, when one shares enough to be about it, and otherwise that it's the person's.
 */
function draft(question: string, passages: Passage[]): { text: string; sources: number[] } {
  const wordsIn = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const asked = wordsIn(question.slice(question.indexOf(':') + 1))
  let best = { n: -1, shared: 0, sentence: '' }
  passages.forEach((passage, n) => {
    // The first document is the card that asks: an answer has to come from somewhere else.
    if (n === 0) return
    for (const sentence of passage.text.split(/(?<=[.!?])\s+|\n+/)) {
      const shared = [...wordsIn(sentence)].filter((word) => asked.has(word)).length
      if (shared > best.shared) best = { n, shared, sentence: sentence.replace(/^[#*>\s-]+/, '').trim() }
    }
  })
  return best.shared >= 3 ? { text: `FACT\n${best.sentence}`, sources: [best.n] } : { text: 'YOURS\nNothing in the notes says, so it is yours to decide.', sources: [] }
}

/** The demo's stand-in for a model: the same few answers every time, from the board it's given. */
export const demoBrain: BrainModel = {
  label: 'Demo Brain',
  summarize: async (capture) => ({ title: capture.title ?? 'Captured', summary: capture.text.replace(/\s+/g, ' ').trim().slice(0, 240), points: [], decisions: [], followUps: [] }),
  answer: async (question, passages, more) => {
    if (more === firstRules) {
      const made = draft(question, passages)
      return { text: made.text, parts: [{ text: made.text, sources: made.sources }] }
    }
    const said = reply(question, passages.find((p) => p.title === boardTitle)?.text ?? '', passages)
    return { text: said.words, parts: [{ text: said.words, sources: said.cites ?? [] }], ...(said.view ? { view: block(said.view) } : {}) }
  },
  talk: async (turns, passages) => reply(turns[turns.length - 1]?.text ?? '', passages.find((p) => p.title === boardTitle)?.text ?? '', passages).words,
  sortMoment: async (said) => ({ kind: 'note', title: said.slice(0, 80) }),
}
