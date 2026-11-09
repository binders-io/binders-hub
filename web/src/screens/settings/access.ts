import { useEffect, useRef, useState } from 'react'
import { call } from '../../data/api'
import type { SpaceView } from '../../data/model'
import { space } from '../../data/space'
import { useStore } from '../../data/store'
import { attempt } from '../../components/Toast'

// What the sections of this binder's group have in common: the binder as the hub lists it, who may change it, and when a
// change was just kept. The parts of them that are on screen are in shared.tsx.

export interface SpacesView {
  spaces: SpaceView[]
  mayCreate: boolean
}

/** The binder you're in, as the hub lists it, and what comes of changing it. */
export function useSpaces() {
  const { state } = useStore()
  const [view, setView] = useState<SpacesView>()
  const refresh = () => void call<SpacesView>('GET', '/api/spaces').then((found) => { if (Array.isArray(found?.spaces)) setView(found) }).catch(() => {})
  useEffect(refresh, [])
  const here = view?.spaces.find((s) => s.id === (state.me?.space ?? space))
  /** Does something to the binders, and keeps the list it answers with. */
  const change = async <T extends Partial<SpacesView>>(work: () => Promise<T>) => {
    const done = await attempt(work)
    if (done && Array.isArray(done.spaces)) setView(done as SpacesView)
    return done
  }
  return { view, here, change, refresh }
}

/**
 * Whether you may change this binder's settings: its owners and admins, the hub's admins, and anyone when it has no
 * members at all. Until the hub has said which, a plain member's controls wait.
 */
export function useBinderAccess() {
  const spaces = useSpaces()
  const me = useStore().state.me
  const managers = spaces.here?.managers ?? []
  const may = !!me?.hubAdmin || me?.role === 'owner' || me?.role === 'admin' || (!!spaces.here && managers.length === 0)
  return { ...spaces, managers, may }
}

/** Which control was just saved, for a moment. `saved(key)` says one was; `shown(key)` says whether to show it. */
export function useSaved() {
  const [key, setKey] = useState<string>()
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const saved = (next: string) => {
    window.clearTimeout(timer.current)
    setKey(next)
    timer.current = window.setTimeout(() => setKey(undefined), 1500)
  }
  return { saved, shown: (own: string) => key === own }
}

/** The agents of a person that this binder's hub has not revoked: what stops when they leave. */
export function agentsOf<T extends { owner: string; revoked?: boolean }>(agents: T[], login: string) {
  return agents.filter((a) => !a.revoked && a.owner.toLowerCase() === login.toLowerCase())
}
