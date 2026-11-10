import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Refused } from '../hub.ts'
import { waitsOnPerson } from '../brain/first.ts'
import type { Context } from './context.ts'

// What the Brain makes of the cards waiting on a person, for the page to show under each: a draft of the answer, that
// another try may pass, or that it's the person's to decide; and which cards wait for the same thing. Sending is the
// person's own act: the words go to the agent as theirs, to one card or to several at once, and so does stopping.

/** The most cards one answer or one stop goes to. */
const mostAtOnce = 30

export async function firstRoutes(app: FastifyInstance, context: Context) {
  const { sp, login, act } = context

  /** The cards named, each still waiting on a person here: one that isn't any more is left out, not guessed at. */
  const waiting = (request: FastifyRequest) => {
    const given = (request.body as { cards?: unknown } | undefined)?.cards
    if (!Array.isArray(given) || !given.length || given.length > mostAtOnce || !given.every((id) => typeof id === 'string')) throw new Refused(`Say which cards, at most ${mostAtOnce}.`)
    const state = sp(request).hub.state
    return [...new Set(given as string[])].flatMap((id) => {
      const card = state.cards.find((c) => c.id === id)
      return card && waitsOnPerson(card) ? [card] : []
    })
  }

  app.get('/api/brain/first', act(async (request) => (await sp(request).first?.look()) ?? { drafts: [], gathered: [] }))

  // The person's answer, to each card named: what the Brain drafted and they checked, or their own words.
  app.post('/api/brain/first/send', act(async (request) => {
    const words = (request.body as { words?: unknown } | undefined)?.words
    if (typeof words !== 'string' || !words.trim()) throw new Refused('Say what to send.')
    const cards = waiting(request)
    if (!cards.length) throw new Refused('None of those is waiting any more.')
    const space = sp(request)
    for (const card of cards) await space.actions.comment(login(request), card.id, words.trim().slice(0, 2000))
    return { sent: cards.length }
  }))

  // Stopping each card named, as the board's Stop does: it goes to Proposed, where nothing picks it up.
  app.post('/api/brain/first/stop', act(async (request) => {
    const cards = waiting(request)
    if (!cards.length) throw new Refused('None of those is waiting any more.')
    const space = sp(request)
    let stopped = 0
    for (const card of cards) {
      // One that can't be stopped where it stands is left, and the rest still are.
      await space.actions.stopCard(login(request), card.id).then(() => { stopped++ }, () => undefined)
    }
    return { stopped }
  }))
}
