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
  return read<T>(response)
}

/** The hub's answer as JSON, or its `error` in words when it refused. */
async function read<T>(response: Response): Promise<T> {
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

/** Sends a file as the whole body of a POST, as the type it is, and reads the hub's JSON answer as `call` does. */
export async function upload<T = unknown>(path: string, file: Blob, type: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-binders': '1', accept: 'application/json', ...spaceHeaders, 'content-type': type },
      body: file,
    })
  } catch (error) {
    if (isNetworkFailure(error)) throw new HubError(0, unreachable)
    throw error
  }
  return read<T>(response)
}
