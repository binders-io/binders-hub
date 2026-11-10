import { useEffect, useState, useTransition } from 'react'

export type Route =
  | { screen: 'home' }
  | { screen: 'flow' }
  | { screen: 'notes'; id: string }
  | { screen: 'changes'; id: string }
  | { screen: 'delivery' }
  | { screen: 'work'; id: string }
  | { screen: 'agents' }
  /** An agent's tool in a terminal: one of its terminals open now, or a new one. */
  | { screen: 'terminal'; id: string; sid?: string }
  /** A section of Settings, each with an address of its own; none is the one this browser last had open. */
  | { screen: 'settings'; id?: string }
  /** A question answered from the binders' notes and cards. */
  | { screen: 'ask' }
  /** You: who you're signed in as, your GitHub and your apps, the same in every binder. */
  | { screen: 'account' }

export function parse(hash: string): Route {
  const [screen, id, sid] = hash.replace(/^#\/?/, '').split('/')
  if (screen === 'terminal' && id) return { screen, id, sid: sid || undefined }
  if (screen === 'notes') return { screen, id: id ?? '' }
  if (screen === 'changes') return { screen, id: id ?? '' }
  if (screen === 'settings') return { screen, id: id ?? '' }
  if (screen === 'agents' || screen === 'account' || screen === 'ask') return { screen }
  if (screen === 'delivery') return { screen }
  if (screen === 'work' && id) return { screen, id }
  if (screen === 'flow') return { screen }
  return { screen: 'home' }
}

export function href(route: Route) {
  return '#/' + route.screen + ('id' in route && route.id ? `/${route.id}` : '') + ('sid' in route && route.sid ? `/${route.sid}` : '')
}

export function go(route: Route) {
  window.location.hash = href(route)
}

/** The route, and whether the next screen is still on its way: until it's here, the one you're on stays. */
export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash))
  const [moving, startMoving] = useTransition()
  useEffect(() => {
    const changed = () => startMoving(() => setRoute(parse(window.location.hash)))
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  return [route, moving] as const
}
