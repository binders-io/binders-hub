// The Binder this page is for: the first part of its address (/acme/). A hub holds one or more Binders, each a team's
// own board, and every call to the hub says which. On the hub's bare address there's none yet: the page asks the hub
// for the person's first and goes there.

// A team's Binder (/acme/), or a person's own (/~login/).
const pattern = /^(?:[a-z][a-z0-9-]{1,38}[a-z0-9]|~[a-z0-9][a-z0-9-]{0,38})$/

export const space: string = (() => {
  const first = window.location.pathname.split('/')[1] ?? ''
  return pattern.test(first) ? first : ''
})()

/** The header that names it, for every call to the hub. */
export const spaceHeaders: Record<string, string> = space ? { 'x-binders-space': space } : {}

/** Signing in with GitHub, or connecting it, through this Binder's GitHub App. */
export const signInHref = space ? `/auth/github?space=${space}` : '/auth/github'

/** Connecting your GitHub to the hub's GitHub App, for what's done as you on repos (signing in may go elsewhere). */
export const connectHref = `${signInHref}${signInHref.includes('?') ? '&' : '?'}connect=1`

/** A Binder's address on this hub, keeping the screen you're on. */
export const spaceHref = (id: string, hash = window.location.hash) => `/${id}/${hash}`
