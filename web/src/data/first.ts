import { useEffect, useRef, useState } from 'react'
import type { Waiting } from '../../../shared/waiting.ts'
import { call } from './api'

// What the Brain makes of the cards that wait on a person, as the web app talks to the hub about it: a draft under a
// card, and which cards wait for the same thing. The hub drafts and only drafts; nothing goes to an agent until a person
// presses a button, and what is sent goes as that person. The hub's live socket says `first` when a draft is ready;
// sync.ts turns that into a window event, and the list of waiting rows listens for it and asks again.

/** What a draft rests on: a note or a card, with its title to show. */
export interface DraftSource {
  kind: 'note' | 'card'
  id: string
  title: string
}

/** answer: worked out from the Binder's notes. again: another try will probably pass. yours: it is the person's to decide. */
export type DraftKind = 'answer' | 'again' | 'yours'

export interface Draft {
  /** The id of the card it is for. */
  card: string
  for: string
  kind: DraftKind
  words: string
  sources: DraftSource[]
  at: string
  model?: string
}

/** Cards that wait for the same thing: one question asked by several, or three or more cards from one note. */
export interface Gathered {
  key: string
  why: 'question' | 'note'
  /** The question, or the note's title. */
  title: string
  cards: string[]
}

export interface FirstView {
  drafts: Draft[]
  groups: Gathered[]
}

/** The window event sync.ts sends when the hub says a draft is ready. */
export const firstEvent = 'binders-first'

const none: FirstView = { drafts: [], groups: [] }
const kinds: DraftKind[] = ['answer', 'again', 'yours']

/** The hub's drafts and groups. Anything that isn't shaped as one is left out, so a page never draws half a draft. */
export async function loadFirst(): Promise<FirstView> {
  const found = await call<{ drafts?: unknown; gathered?: unknown } | undefined>('GET', '/api/brain/first')
  const drafts = (Array.isArray(found?.drafts) ? found.drafts : [])
    .filter((d): d is Draft => !!d && typeof d.card === 'string' && typeof d.words === 'string' && kinds.includes(d.kind))
    .map((d) => ({ ...d, sources: Array.isArray(d.sources) ? d.sources.filter((s) => s && typeof s.id === 'string' && (s.kind === 'note' || s.kind === 'card')) : [] }))
  const groups = (Array.isArray(found?.gathered) ? found.gathered : [])
    .filter((g): g is Gathered => !!g && typeof g.key === 'string' && (g.why === 'question' || g.why === 'note') && Array.isArray(g.cards))
  return { drafts, groups }
}

/** Sends `words` to each card as the signed-in person's answer. */
export const sendFirst = (cards: string[], words: string) => call<{ sent: number }>('POST', '/api/brain/first/send', { cards, words })

/** Stops each card, which moves it to Proposed. */
export const stopFirst = (cards: string[]) => call<{ stopped: number }>('POST', '/api/brain/first/stop', { cards })

/**
 * The drafts and groups for the rows shown. It asks when it mounts, when the hub says a draft is ready, and when the set
 * of waiting cards changes (the hub starts a draft on the first ask for a card). With no card waiting there's nothing to
 * ask. An answer that comes after a newer ask, or an ask that fails, leaves what was there.
 */
export function useFirst(rows: Waiting[]): FirstView {
  const [view, setView] = useState<FirstView>(none)
  const cards = rows.filter((r) => r.about.type === 'card').map((r) => r.about.id)
  const key = [...new Set(cards)].sort().join('\n')
  const latest = useRef(0)
  const ask = useRef(() => {})
  useEffect(() => {
    ask.current = () => {
      if (!key) {
        latest.current += 1
        setView((was) => (was.drafts.length || was.groups.length ? none : was))
        return
      }
      const turn = ++latest.current
      loadFirst().then((found) => { if (turn === latest.current) setView(found) }).catch(() => {})
    }
    ask.current()
  }, [key])
  useEffect(() => {
    const again = () => ask.current()
    window.addEventListener(firstEvent, again)
    return () => {
      window.removeEventListener(firstEvent, again)
      latest.current += 1
    }
  }, [])
  return view
}
