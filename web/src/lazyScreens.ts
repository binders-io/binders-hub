import { lazy, type ComponentType } from 'react'
import { loadDocs } from './data/liveNote'

// Each screen on its own, with what only it needs: the editor with Notes, the terminal with AgentTerminal. Opening the
// app takes the shell, and the rest follows.

const loaders: (() => Promise<unknown>)[] = []

function screen<K extends string, P extends object>(load: () => Promise<Record<K, ComponentType<P>>>, name: K) {
  loaders.push(load)
  return lazy(() => load().then((module) => ({ default: module[name] })))
}

export const Home = screen(() => import('./screens/Home'), 'Home')
export const Flow = screen(() => import('./screens/Flow'), 'Flow')
export const Notes = screen(() => import('./screens/Notes'), 'Notes')
export const ChangeSets = screen(() => import('./screens/ChangeSets'), 'ChangeSets')
export const Delivery = screen(() => import('./screens/Delivery'), 'Delivery')
export const Work = screen(() => import('./screens/Work'), 'Work')
export const Agents = screen(() => import('./screens/Agents'), 'Agents')
export const AgentTerminal = screen(() => import('./screens/AgentTerminal'), 'AgentTerminal')
export const Settings = screen(() => import('./screens/Settings'), 'Settings')
export const Account = screen(() => import('./screens/Account'), 'Account')
export const Ask = screen(() => import('./screens/Ask'), 'Ask')

/**
 * Fetches every screen once the page is quiet. There's no service worker, so an open tab works offline only with what
 * it has already loaded: without this, going offline would leave the screens not yet opened out of reach, and notes
 * unable to merge. On a connection that asks to save data, a screen comes when it's opened.
 */
export function prefetchScreens() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (connection?.saveData) return () => {}
  let stopped = false
  const run = async () => {
    for (const load of [...loaders, loadDocs]) {
      if (stopped) return
      // One that fails is tried again when it's opened, and says so then.
      await load().catch(() => undefined)
    }
  }
  const idle = window.requestIdleCallback ?? ((work: () => void) => window.setTimeout(work, 1500))
  idle(() => void run())
  return () => { stopped = true }
}
