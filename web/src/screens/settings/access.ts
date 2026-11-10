import { useEffect, useRef, useState } from 'react'
import { call } from '../../data/api'
import type { SpaceView } from '../../data/model'
import { space } from '../../data/space'
import { useHub, useStore } from '../../data/store'
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
 * Whether you may change this binder's settings: its owners and admins. The hub says you're its admin when you're one of
 * the hub's admins and it has no owner, so that's no special case here. `noOwner` is whether the hub's list of the binder
 * shows no owner; until the list has come, it's false, so a line about it doesn't flash.
 */
export function useBinderAccess() {
  const spaces = useSpaces()
  const me = useStore().state.me
  const managers = spaces.here?.managers ?? []
  const may = me?.role === 'owner' || me?.role === 'admin'
  const noOwner = !!spaces.here && !managers.some((m) => m.role === 'owner')
  return { ...spaces, managers, may, noOwner }
}

/**
 * Whether you may change the Binder you're in: not when you're a reader, who sees all of it and changes none of it. Every
 * control that changes something asks this. Until the hub has said who you are, you may, so nobody's controls flicker
 * away and back; a reader who presses one anyway is refused by the hub, in words that show as a toast.
 */
export function useMayChangeBinder() {
  return useHub((state) => state.me?.role !== 'reader')
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

/** The binder's name as its copy's file says it: "my-team-2026-11-09.binder-copy.json.gz" is "My team". */
export function nameFromCopy(file: string) {
  const dated = /^(.+?)-\d{4}-\d{2}-\d{2}\.binder-copy/.exec(file)
  const base = (dated?.[1] ?? file.split('.')[0]).replace(/-+/g, ' ').trim()
  return base.charAt(0).toUpperCase() + base.slice(1)
}
