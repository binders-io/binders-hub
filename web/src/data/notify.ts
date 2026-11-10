import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { forAttention, waitingOn, type Waiting } from '../../../shared/waiting.ts'
import { openOnDistill } from '../components/notesLayout'
import { go, type Route } from '../route'
import { useHub, type State } from './store'

// What waits on you, reaching a tab that isn't in front: its count in the title and on the installed app's icon, and a
// browser notification for each thing that starts waiting while the page is hidden. The browser's own permission is
// asked for once, when the switch is pressed, and the choice is remembered in this browser.

/** Where a row leads. */
export function routeOf(row: Waiting): Route {
  switch (row.about.type) {
    case 'card': return { screen: 'work', id: row.about.id }
    case 'changeSet': return { screen: 'changes', id: row.about.id }
    case 'note': return { screen: 'notes', id: row.about.id }
    default: return { screen: 'delivery' }
  }
}

/** Opens what a row is about, from wherever it was pressed: cards proposed from a note open the note on its proposed cards. */
export function openRow(row: Waiting) {
  if (row.kind === 'proposals') openOnDistill(row.about.id)
  go(routeOf(row))
}

/** Two lists of rows alike in everything a screen draws, for a selection that makes a new list each time. */
export const sameRows = (a: readonly Waiting[], b: readonly Waiting[]) => a.length === b.length && a.every((x, i) => {
  const y = b[i]
  return x.id === y.id && x.for === y.for && x.title === y.title && x.detail === y.detail && x.since === y.since && x.count === y.count
})

/** What waits on you, from the state, for every binder you're in or for one. Nothing waits on a reader: every row is someone else's. */
export const waitingFor = (state: State, binder?: string) => waitingOn(state, state.me?.user.login, { binder, reads: state.me?.role === 'reader' })

/** What waits on you, for every binder you're in, or for one: your rows, then anyone's, then others'. */
export function useWaiting(binder?: string) {
  const select = useCallback((state: State) => waitingFor(state, binder), [binder])
  return useHub(select, sameRows)
}

type Permission = NotificationPermission | 'unsupported'

/** What the notifier needs of the browser, so a test can stand in for it. */
export interface NotifyEnv {
  permission: () => Permission
  /** Asks the person's browser. Only ever from the switch. */
  ask: () => Promise<Permission>
  /** The page isn't the one in front. */
  hidden: () => boolean
  show: (note: { title: string; body: string; tag: string }, onClick: () => void) => void
  badge: (count: number) => void
  remembered: () => boolean
  remember: (on: boolean) => void
}

const rememberedKey = 'binders-hub-notify'

export function browserEnv(): NotifyEnv {
  const supported = () => typeof Notification !== 'undefined'
  return {
    permission: () => (supported() ? Notification.permission : 'unsupported'),
    ask: async () => {
      if (!supported()) return 'unsupported'
      try { return await Notification.requestPermission() } catch { return Notification.permission }
    },
    hidden: () => document.visibilityState === 'hidden',
    show: (note, onClick) => {
      try {
        const shown = new Notification(note.title, { body: note.body, tag: note.tag })
        shown.onclick = () => {
          window.focus()
          shown.close()
          onClick()
        }
      } catch { /* a browser that only allows them from a service worker: the title's count still says */ }
    },
    badge: (count) => {
      const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
      try { void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {}) } catch { /* no badge here */ }
    },
    remembered: () => {
      try { return window.localStorage.getItem(rememberedKey) === 'on' } catch { return false }
    },
    remember: (on) => {
      try { window.localStorage.setItem(rememberedKey, on ? 'on' : 'off') } catch { /* only for this tab then */ }
    },
  }
}

/** unsupported: this browser has no notifications; denied: it was refused, and only the browser's settings can undo that. */
export type NotifyStatus = 'unsupported' | 'denied' | 'off' | 'on'

export class Notifier {
  /** The rows there were at the last look; the first look is what was there when the page loaded. */
  private seen?: Set<string>
  private open: (row: Waiting) => void = () => {}
  private listeners = new Set<() => void>()

  private env: NotifyEnv

  constructor(env: NotifyEnv) {
    this.env = env
  }

  status(): NotifyStatus {
    const permission = this.env.permission()
    if (permission === 'unsupported') return 'unsupported'
    if (permission === 'denied') return 'denied'
    return this.env.remembered() && permission === 'granted' ? 'on' : 'off'
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }

  /** The switch, pressed on: asks the browser if it hasn't been asked, and is on only if it says yes. */
  async turnOn() {
    let permission = this.env.permission()
    if (permission === 'default') permission = await this.env.ask()
    this.env.remember(permission === 'granted')
    this.changed()
  }

  turnOff() {
    this.env.remember(false)
    this.changed()
  }

  /** The page it was looking at is gone: the next look is a first one again. */
  forget() {
    this.seen = undefined
  }

  /**
   * Every look at what waits on you, once the hub has answered. The first look only notes what's there. After that the
   * count goes to the app's icon, and each row for you or anyone that wasn't there before, and came while the page was
   * out of sight, raises a notification.
   */
  update(rows: Waiting[], ready: boolean, open: (row: Waiting) => void) {
    if (!ready) return
    this.open = open
    const attention = forAttention(rows)
    this.env.badge(attention.length)
    const before = this.seen
    this.seen = new Set(attention.map((r) => r.id))
    if (!before || this.status() !== 'on' || !this.env.hidden()) return
    for (const row of attention) {
      if (!before.has(row.id)) this.env.show({ title: row.title, body: row.detail, tag: row.id }, () => this.open(row))
    }
  }
}

const notifier = new Notifier(browserEnv())

/** The switch's state, and its two moves. Shared by every switch on screen, as the browser has one permission. */
export function useNotifySwitch() {
  const status = useSyncExternalStore(notifier.subscribe, () => notifier.status())
  return { status, turnOn: () => notifier.turnOn(), turnOff: () => notifier.turnOff() }
}

/** Keeps the notifier looking at what waits on you, from the app. `open` goes to a row's page. */
export function useNotifications(rows: Waiting[], open: (row: Waiting) => void) {
  // Not until the hub has answered, and we know who you are: before that the list is empty or only anyone's, and
  // everything that fills in would look new.
  const ready = useHub((state) => state.sync.version > 0 && state.sync.connection === 'live' && !!state.me)
  useEffect(() => notifier.update(rows, ready, open), [rows, ready, open])
  useEffect(() => () => notifier.forget(), [])
}
