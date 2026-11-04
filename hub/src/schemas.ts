import { z } from 'zod'
import { testTextMost } from '../../shared/changeSet.ts'

// What a person's client may send, checked before it goes in the log: once a change is in, every hub and every browser
// applies it, so one that can't be applied or shown is everybody's problem. These hold what the reducers and screens
// rely on and no more. Fields they don't know pass, so a newer client or the Mac isn't refused: the web app drops a
// change the hub refuses and undoes it on screen, which would lose an edit made offline. And null passes where a field
// can be cleared, as that's how a cleared field travels (`forWire`).

const text = z.string()
const optional = text.nullish()
const number = z.number().nullish()

const binder = z.looseObject({ id: text, name: text })
const folder = z.looseObject({ id: text, binderId: text, name: text, parentId: optional })
const workLink = z.looseObject({ itemId: text, quote: text })
const note = z.looseObject({ id: text, title: text, binderId: text, folderId: optional, editedAt: text, editors: z.array(text), text, work: z.array(workLink).nullish() })
const activity = z.looseObject({ at: text, by: text, kind: text, text })
const plan = z.array(z.looseObject({ text, done: z.boolean() })).nullish()
const card = z.looseObject({ id: text, binderId: text, title: text, brief: text, doneWhen: text, size: text, stage: text, createdAt: text, createdBy: text, updatedAt: text, waitsFor: z.array(text), activity: z.array(activity), plan })

/** A card's fields as a change sets them: what every card has can't be cleared, and its id and activity aren't fields. */
const cardFields = z.looseObject({
  id: z.never().optional(),
  activity: z.never().optional(),
  binderId: text.optional(),
  title: text.optional(),
  brief: text.optional(),
  doneWhen: text.optional(),
  size: text.optional(),
  stage: text.optional(),
  updatedAt: text.optional(),
  waitsFor: z.array(text).optional(),
  noteId: optional,
  quote: optional,
  agentId: optional,
  meantFor: optional,
  prId: optional,
  doing: optional,
  needsYou: optional,
  progress: number,
  plan,
})

const byId = <T extends string>(type: T) => z.looseObject({ type: z.literal(type), id: text })

const fromPeople = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('binder.put'), binder }),
  byId('binder.delete'),
  z.looseObject({ type: z.literal('folder.put'), folder }),
  byId('folder.delete'),
  z.looseObject({ type: z.literal('note.put'), note }),
  z.looseObject({ type: z.literal('note.edit'), id: text, text, title: text, by: text, at: text, changes: z.array(text).nullish() }),
  z.looseObject({ type: z.literal('note.link'), id: text, link: workLink }),
  z.looseObject({ type: z.literal('note.move'), id: text, binderId: text, folderId: optional }),
  byId('note.delete'),
  z.looseObject({ type: z.literal('card.put'), card }),
  z.looseObject({ type: z.literal('card.update'), id: text, fields: cardFields, activity: activity.nullish() }),
  z.looseObject({ type: z.literal('card.activity'), id: text, activity }),
  byId('card.delete'),
  z.looseObject({ type: z.literal('proposal.update'), id: text, fields: z.looseObject({ state: z.enum(['new', 'accepted', 'dismissed']).optional(), cardId: optional, meantFor: optional }) }),
  byId('chat.clear'),
  z.looseObject({ type: z.literal('test.result'), id: text, test: text, result: z.looseObject({ outcome: z.enum(['passed', 'failed']), note: z.string().max(testTextMost).nullish(), by: text, at: text }).nullable() }),
])

const inWords = (error: z.ZodError) => {
  const issue = error.issues[0]
  return issue.path.length ? `${issue.path.join('.')} isn’t right` : issue.message
}

/** What's wrong with a change from a person, in a few words, or undefined when it can go in the log. */
export function whatsWrong(change: unknown) {
  const parsed = fromPeople.safeParse(change)
  return parsed.success ? undefined : inWords(parsed.error)
}

// What each route of the API takes. As above: what a route relies on, with other fields let through, and for the same
// reason, as the Mac and older tabs call these too.

const maybe = text.nullish().transform((value) => value ?? undefined)
const texts = z.array(text).optional()
const flag = z.boolean().optional()

export const bodies = {
  newSpace: z.looseObject({ id: maybe, name: maybe, owner: maybe }),
  named: z.looseObject({ name: maybe }),
  member: z.looseObject({ role: z.enum(['owner', 'admin', 'member']).optional() }),
  newCard: z.looseObject({ binderId: text, title: text, brief: maybe, doneWhen: maybe, size: z.enum(['S', 'M', 'L']).optional(), meantFor: maybe, waitsFor: texts, noteId: maybe, quote: maybe }),
  ask: z.looseObject({ agentId: maybe, effort: maybe }),
  finding: z.looseObject({ action: maybe }),
  comment: z.looseObject({ text: maybe }),
  permission: z.looseObject({ request: z.string().max(64), allow: z.boolean() }),
  chat: z.looseObject({ agentId: maybe, text: maybe }),
  newSchedule: z.looseObject({ noteId: maybe, agentId: maybe, cron: maybe, tz: maybe, enabled: flag }),
  changeSchedule: z.looseObject({ agentId: optional, cron: maybe, tz: maybe, enabled: flag }),
  order: z.looseObject({ prIds: z.array(text) }),
  newAgent: z.looseObject({ name: text, provider: maybe, repos: texts, binders: texts, skills: texts, runsOn: maybe, runner: z.looseObject({}).optional() }),
  changeAgent: z.looseObject({ name: maybe, provider: maybe, repos: texts, binders: texts, skills: texts, runsOn: maybe, runner: z.looseObject({}).optional() }),
  options: z.looseObject({}),
  newRepo: z.looseObject({ owner: maybe, name: maybe, private: flag, description: maybe }),
  oauth: z.looseObject({ clientId: maybe, clientSecret: maybe }),
  newApp: z.looseObject({ org: maybe, name: maybe }),
  reuse: z.looseObject({ from: maybe, accounts: z.array(text.max(100)).max(20).optional() }),
  briefAsk: z.looseObject({ agentId: maybe, refresh: flag }),
  lesson: z.looseObject({ text: maybe }),
}

/** A request's body as its route takes it, or what's wrong with it. */
export function readBody<T>(schema: z.ZodType<T>, body: unknown): { body: T; wrong?: undefined } | { body?: undefined; wrong: string } {
  const parsed = schema.safeParse(body ?? {})
  return parsed.success ? { body: parsed.data } : { wrong: inWords(parsed.error) }
}

// What GitHub sends, signed and so from GitHub, but in a shape that's GitHub's to change: what the handlers rely on, so a
// change there is one quiet line in the log and not a failed delivery it retries.

const repository = z.looseObject({ full_name: text })
const webhooks: Record<string, z.ZodType> = {
  issues: z.looseObject({ action: text, repository, issue: z.looseObject({ number: z.number(), title: text }) }),
  pull_request: z.looseObject({ action: text, repository, pull_request: z.looseObject({ number: z.number(), title: text, head: z.looseObject({ ref: text }) }) }),
  check_run: z.looseObject({ repository, check_run: z.looseObject({ pull_requests: z.array(z.looseObject({ number: z.number() })) }) }),
  workflow_run: z.looseObject({ repository, workflow_run: z.looseObject({ id: z.number(), name: text }) }),
  deployment_status: z.looseObject({ deployment_status: z.looseObject({ state: text }), deployment: z.looseObject({ environment: text }) }),
}

/** What's wrong with a delivery of an event the hub acts on, or undefined. */
export function whatsWrongWithWebhook(event: string, payload: unknown) {
  const parsed = webhooks[event]?.safeParse(payload)
  return !parsed || parsed.success ? undefined : inWords(parsed.error)
}
