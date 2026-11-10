// What a reader may still send. A reader sees everything in a Binder and changes nothing in it, so the hub's hook refuses
// every request that isn't a read (GET or HEAD) from a reader, except the addresses here: asking the brain, which only
// reads and answers, and what is theirs and not the Binder's (their account and tokens, their own Binder's setup,
// signing out, leaving). A route added later is refused for a reader until someone puts it here, on purpose.

/** Addresses a reader may use though they aren't reads: [method, path as a pattern]. */
export const readerMay: [method: string, path: RegExp][] = [
  // Asking: the brain answers from the Binder's notes and cards and changes nothing. A note's ask is the same, about one note.
  ['POST', /^\/api\/brain\/ask$/],
  ['POST', /^\/api\/notes\/[^/]+\/ask$/],
  ['POST', /^\/api\/brain\/search$/],
  // Words read out loud, with no Binder in them.
  ['POST', /^\/api\/brain\/speak$/],
  // Their own conversation with Ask.
  ['DELETE', /^\/api\/brain\/conversation$/],
  // Their own tokens, and their own GitHub for their personal Binder.
  ['POST', /^\/api\/tokens$/],
  ['DELETE', /^\/api\/tokens\/[^/]+$/],
  ['DELETE', /^\/api\/me\/personal-github$/],
  // Their personal Binder's setup, which is theirs alone, and where their own captures go.
  ['PUT', /^\/api\/personal\/oauth$/],
  ['DELETE', /^\/api\/personal\/oauth$/],
  ['PUT', /^\/api\/personal\/captures$/],
  ['POST', /^\/api\/personal\/repo$/],
  // A new Binder of their own, which changes none they're a reader of.
  ['POST', /^\/api\/spaces$/],
  // Naming a Binder's owner is the hub's, not the Binder their browser is in: the route says who may.
  ['PUT', /^\/api\/hub\/binders\/[^/]+\/owners\/[^/]+$/],
  // Starting a new Binder from a copy is the hub's too: the route says that only its admins may.
  ['POST', /^\/api\/hub\/binders\/from-copy$/],
]

/**
 * Addresses that take no side on the request's Binder, as they don't know yet which Binder they're for: each finds it
 * (where a capture goes, whose Binder an answer proposed something in) and refuses a reader there, in the same words.
 */
export const readerDecides: [method: string, path: RegExp][] = [
  ['POST', /^\/api\/captures$/],
  ['POST', /^\/api\/app\/audio$/],
  ['POST', /^\/api\/brain\/do$/],
]

/** Whether a reader may send this request: a read, or one of the addresses above. Leaving is theirs: taking themselves out. */
export function readerMaySend(method: string, url: string, login: string) {
  if (method === 'GET' || method === 'HEAD') return true
  const path = url.split('?')[0]
  if ([...readerMay, ...readerDecides].some(([m, pattern]) => m === method && pattern.test(path))) return true
  const leaving = method === 'DELETE' ? /^\/api\/spaces\/[^/]+\/members\/([^/]+)$/.exec(path)?.[1] : undefined
  if (leaving === undefined) return false
  try {
    return decodeURIComponent(leaving).replace(/^@/, '').toLowerCase() === login.toLowerCase()
  } catch {
    return false
  }
}
