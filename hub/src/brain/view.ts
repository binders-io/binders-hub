import { asksOf, type Card } from '../../../shared/work.ts'
import { readView, viewParts, type View, type ViewPart, type ViewProps } from '../../../shared/view.ts'
import { agentOnline, stageNames, type Asked, type Board, type Proposal, type WorkPlace } from './board.ts'

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
  'When you name cards, change sets or environments from “What’s going on now”, show each as a Thing rather than describing it in words: several under a Section with a short title.',
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
export function thingFor(mark: string, board: Board): Record<string, unknown> | undefined {
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
export function viewFrom(raw: string, board?: Board, places: WorkPlace[] = [], offer?: (asked: Asked) => Proposal | undefined): View | undefined {
  const given = jsonIn(raw) as { root?: unknown; elements?: Record<string, { type?: unknown; props?: Record<string, unknown> } | null> } | undefined
  if (!given?.elements || typeof given.elements !== 'object') return undefined
  const elements: Record<string, unknown> = {}
  for (const [key, element] of Object.entries(given.elements)) {
    if (element?.type === 'Offer') {
      // A model says which thing it offers to do, by its marks: the hub makes the offer, or leaves the part out. Where
      // nothing may be offered (a question, a reader, a place with no button to press), every one is left out.
      const asked = board && offer ? askedBy(element.props ?? {}) : undefined
      const made = asked && board ? offer?.(asked) : undefined
      if (made && board) elements[key] = { type: 'Offer', props: offerProps(made, board) }
      continue
    }
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

const verbs = ['stop', 'tell', 'allow', 'deny', 'approve', 'promote'] as const

/** What a model's Offer part asks for, read as its line would be: the thing to do, the marks, and the words to say. */
function askedBy(props: Record<string, unknown>): Asked | undefined {
  const verb = verbs.find((v) => v === props.do)
  const marks = (Array.isArray(props.refs) ? props.refs : [props.ref]).flatMap((ref) => (typeof ref === 'string' ? [ref.toLowerCase().replace(/[^a-z0-9-]/g, '')] : [])).filter(Boolean).slice(0, 40)
  if (!verb || !marks.length) return undefined
  return { verb, mark: marks[0], rest: verb === 'tell' ? (typeof props.words === 'string' ? props.words.slice(0, 2000) : '') : marks.slice(1).join(' ') }
}

/** The most things an offer shows beside its button; the rest are counted. */
const aboutMost = 8

/** An offer as it's drawn: the hub's words for it, its button, and the things it would act on, as they stand now. */
export function offerProps(proposal: Proposal, board: Board): ViewProps<'Offer'> {
  const about = proposal.about.flatMap((mark) => thingFor(mark, board) ?? []) as NonNullable<ViewProps<'Offer'>['about']>
  return { id: proposal.id, what: clip(proposal.what, 600), button: clip(proposal.button, 60), ...(proposal.heavy ? { heavy: true } : {}), ...(about.length ? { about: about.slice(0, aboutMost) } : {}), ...(about.length > aboutMost ? { more: about.length - aboutMost } : {}) }
}

/**
 * A view with the hub's offers in it, each a button with the things it's about: above whatever a model drew, or as the
 * whole view when it drew nothing. An offer the view already has (a model put it there itself) isn't added twice.
 */
export function withOffers(view: View | undefined, proposals: Proposal[], board: Board): View | undefined {
  const there = new Set(view ? Object.values(view.elements).flatMap((element) => (element.type === 'Offer' ? [String(element.props.id)] : [])) : [])
  const added = proposals.filter((proposal) => !there.has(proposal.id))
  if (!added.length) return view
  const elements: Record<string, unknown> = { ...(view?.elements ?? {}) }
  const keys = added.map((proposal, n) => {
    const key = `hub-offer-${n + 1}`
    elements[key] = { type: 'Offer', props: offerProps(proposal, board) }
    return key
  })
  const root = view?.elements[view.root]
  // A model's Stack takes them at its top; anything else goes under them, in a Stack of the hub's.
  if (view && root?.type === 'Stack') elements[view.root] = { ...root, children: [...keys, ...root.children] }
  else elements['hub-root'] = { type: 'Stack', props: {}, children: [...keys, ...(view ? [view.root] : [])] }
  return readView({ root: view && root?.type === 'Stack' ? view.root : 'hub-root', elements }) ?? view
}
