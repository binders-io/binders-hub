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

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-binders': '1', accept: 'application/json', ...spaceHeaders, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
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
