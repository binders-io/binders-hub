import { asksOf, type Card } from '../../../shared/work.ts'
import { readView, viewParts, type View, type ViewPart } from '../../../shared/view.ts'
import { agentOnline, stageNames, type Board, type WorkPlace } from './board.ts'

// What the Brain shows beside its words. A model may end its answer with one block of JSON, a view made of the parts in
// shared/view.ts. The hub takes the block out of the words, turns each mark in it into the thing itself from its own
// state, and keeps only what the list of parts allows, so a browser is never sent anything a model made up the shape of.
// A view that doesn't read is left out, and the words stand on their own.

const partLines = (Object.keys(viewParts) as ViewPart[]).map((name) => `- ${name} ${viewParts[name].says}`)

/** What a model is told of views: the form, the parts, and that nothing in one may be made up. */
export const viewRules = [
  'You can also show things, when showing says it better than words: how work stands, numbers to compare, steps in order, how things connect. Most answers need no view, so leave it out unless it helps.',
  'To show something, end your answer with one block that starts with a line ```view and ends with a line ```. In it, one JSON object: {"root": "KEY", "elements": {"KEY": {"type": "PART", "props": {…}, "children": ["KEY", …]}}}. Only Stack, Row and Section have children.',
  'The parts:',
  ...partLines,
  'Every name, number and state in a view comes from the documents. Never make one up, never fill a gap, and never add sample data. A chart is only for numbers the documents give or that you counted from them.',
  'In a Thing, ref is the mark from the square brackets, and an agent goes by its name: the hub shows that thing itself, so this is the one place a mark belongs. When the view carries the detail, keep your words to a line or two, and don’t mention the view.',
  'For example, asked what an agent is doing, with document lines Sonnet and [c2] “Fix the header”:',
  '```view',
  '{"root":"all","elements":{"all":{"type":"Stack","props":{},"children":["who","what","next"]},"who":{"type":"Thing","props":{"agent":"Sonnet"}},"what":{"type":"Thing","props":{"ref":"c2"}},"next":{"type":"Suggest","props":{"questions":["What is waiting on me?"]}}}}',
  '```',
].join('\n')

const clip = (text: string, most: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > most ? `${one.slice(0, most - 1)}…` : one
}

/** A card's standing in a line: where it is, who has it, and what's being done or asked. */
function cardLine(card: Card, agentName: (id?: string) => string | undefined) {
  const asks = asksOf(card)
  return [stageNames[card.stage] ?? card.stage, agentName(card.agentId), asks ? `asks: ${clip(asks, 140)}` : card.stage === 'working' && card.doing ? clip(card.doing, 140) : undefined].filter(Boolean).join(' · ')
}

/** An agent as a Thing's props: who it is, whether it's there, and what it holds. */
function agentThing(place: WorkPlace, id: string): Record<string, unknown> | undefined {
  const state = place.hub.state
  const agent = state.agents.find((a) => a.id === id && !a.revoked)
  if (!agent) return undefined
  const holding = state.cards.filter((c) => c.agentId === id && (c.stage === 'working' || c.stage === 'blocked'))
  return { kind: 'agent', binder: place.id, id, title: clip(agent.name, 240), detail: clip(`${agentOnline(place.hub.presence(), agent) ? 'Online' : 'Offline'} · ${holding.length ? `working on ${holding.map((c) => `“${clip(c.title, 60)}”`).join(', ')}` : 'not working on anything'}`, 300) }
}

/** What a mark stands for, as a Thing's props: the thing's own name and standing, from the hub's state. */
function thingFor(mark: string, board: Board): Record<string, unknown> | undefined {
  const target = board.targets.get(mark.toLowerCase().replace(/[^a-z0-9-]/g, ''))
  if (!target) return undefined
  const { place, id } = target
  const state = place.hub.state
  const agentName = (agentId?: string) => state.agents.find((a) => a.id === agentId)?.name
  switch (target.kind) {
    case 'card': {
      const card = state.cards.find((c) => c.id === id)
      return card && { kind: 'card', binder: place.id, id, title: clip(card.title, 240), detail: cardLine(card, agentName) }
    }
    case 'set': {
      const set = state.changeSets.find((s) => s.id === id)
      const standing = set && (set.state === 'assembling' ? 'Taking pull requests' : set.state === 'review' ? 'In review' : set.state === 'merging' ? 'Approved, merging' : set.state)
      return set && { kind: 'set', binder: place.id, id, title: clip(`Change set #${set.number}${set.title ? `: ${set.title}` : ''}`, 240), detail: `${standing} · ${set.prIds.length} pull request${set.prIds.length === 1 ? '' : 's'}` }
    }
    case 'env': {
      const env = state.environments.find((e) => e.id === id)
      return env && { kind: 'env', binder: place.id, id, title: clip(`${env.repo ? `${env.repo} ` : ''}${env.name}`, 240), detail: clip(`${env.version || 'Nothing deployed yet'} · ${env.state}`, 300) }
    }
    default:
      return undefined
  }
}

/**
 * The agent a model named, in the places the person asked in: by its name as the board gives it, whatever its case. An
 * agent has no mark, as one on its line would sit before its cards' titles and be taken for theirs. Two of one name in
 * different Binders: the first, as the board lists them.
 */
function agentNamed(name: string, places: WorkPlace[]): Record<string, unknown> | undefined {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return undefined
  for (const place of places) {
    const here = (binderId: string) => !place.binders || place.binders.includes(binderId)
    const agent = place.hub.state.agents.find((a) => !a.revoked && a.name.toLowerCase() === wanted && (!a.binders.length || a.binders.some(here)))
    if (agent) return agentThing(place, agent.id)
  }
  return undefined
}

/** The first JSON object in what a model wrote for its view: some put a word or two around it. */
function jsonIn(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * A model's view block as a view to show: each Thing's mark or agent's name turned into the thing it stands for, and
 * only what the list of parts allows kept. Undefined when it doesn't read, or shows nothing. A Thing that isn't on the
 * board is left out, never guessed at. `places`: where the person asked, for an agent named.
 */
export function viewFrom(raw: string, board?: Board, places: WorkPlace[] = []): View | undefined {
  const given = jsonIn(raw) as { root?: unknown; elements?: Record<string, { type?: unknown; props?: Record<string, unknown> } | null> } | undefined
  if (!given?.elements || typeof given.elements !== 'object') return undefined
  const elements: Record<string, unknown> = {}
  for (const [key, element] of Object.entries(given.elements)) {
    if (element?.type !== 'Thing') {
      elements[key] = element
      continue
    }
    const { ref, agent } = element.props ?? {}
    const props = typeof agent === 'string' ? agentNamed(agent, places) : typeof ref === 'string' && board ? thingFor(ref, board) : undefined
    if (props) elements[key] = { type: 'Thing', props }
  }
  return readView({ root: given.root, elements })
}
