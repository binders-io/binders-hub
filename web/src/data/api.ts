import { spaceHeaders } from './space'

// The hub's HTTP API, as the web app calls it: with the session cookie, the header that says it's the web app, and the
// Binder it's for.

export class HubError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** What a person reads when the hub can't be reached, in place of the browser's own "Failed to fetch" or "Load failed". */
export const unreachable = 'Couldn’t reach the hub. Try again in a moment.'

/** Whether an error is the browser saying a request never got an answer: each browser words it its own way. */
export const isNetworkFailure = (error: unknown) => error instanceof TypeError && /failed to fetch|load failed|network ?error|network request failed/i.test(error.message)

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-binders': '1', accept: 'application/json', ...spaceHeaders, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    // Status 0: no answer at all, which is not the hub saying no.
    if (isNetworkFailure(error)) throw new HubError(0, unreachable)
    throw error
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!response.ok) throw new HubError(response.status, (parsed as { error?: string })?.error ?? `The hub answered ${response.status}.`)
  return parsed as T
}
