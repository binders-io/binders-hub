import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { AlertTriangle, Bot, FileText, LayoutDashboard, GitPullRequestArrow, Menu, Monitor, Moon, Rocket, Search, Settings as SettingsIcon, Sun, Workflow, X } from 'lucide-react'
import { isOnline, sameValues, useActions, useClock, useHub, type State } from './data/store'
import { Kbd, PersonAvatar, usePhone } from './components/bits'
import { Github } from './components/Github'
import { BinderSwitcher } from './components/BinderSwitcher'
import { poppedOut } from './components/notesLayout'
import { Palette } from './components/Palette'
import { Toast } from './components/Toast'
import { SideAgents } from './components/SideAgents'
import { Account, AgentTerminal, Agents, ChangeSets, Delivery, Flow, Home, Notes, prefetchScreens, Settings, Work } from './lazyScreens'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UIContext, type UI } from './ui'
import { SignIn } from './screens/SignIn'
import { go, href, useRoute, type Route } from './route'
import { ContextMenuHost } from './components/ContextMenu'
import { useModal } from './components/useModal'
import { SwarmDialog } from './components/SwarmDialog'

/** The binder you're in, remembered in this browser; one that's gone falls back to the first. */
function useBinder(ids: string[]) {
  const [chosen, setChosen] = useState<string>(() => {
    try { return window.localStorage.getItem('binders-current') ?? '' } catch { return '' }
  })
  const binder = chosen === 'all' || ids.includes(chosen) ? chosen : (ids[0] ?? 'all')
  const setBinder = useCallback((id: string) => {
    setChosen(id)
    try { window.localStorage.setItem('binders-current', id) } catch { /* only a convenience */ }
  }, [])
  return [binder, setBinder] as const
}

const nav: { route: Route; label: string; icon: typeof Workflow; key: string }[] = [
  { route: { screen: 'home' }, label: 'Home', icon: LayoutDashboard, key: '1' },
  { route: { screen: 'flow' }, label: 'Work', icon: Workflow, key: '2' },
  { route: { screen: 'notes', id: '' }, label: 'Notes', icon: FileText, key: '3' },
  { route: { screen: 'changes', id: '' }, label: 'Change sets', icon: GitPullRequestArrow, key: '4' },
  { route: { screen: 'delivery' }, label: 'Delivery', icon: Rocket, key: '5' },
  { route: { screen: 'agents' }, label: 'Agents', icon: Bot, key: '6' },
  { route: { screen: 'settings' }, label: 'Settings', icon: SettingsIcon, key: '7' },
]

/** A phone's tab bar: the screens used most, by a short name. The rest are in the menu. */
const tabs: { screen: Route['screen']; label: string }[] = [{ screen: 'home', label: 'Home' }, { screen: 'flow', label: 'Work' }, { screen: 'notes', label: 'Notes' }, { screen: 'changes', label: 'Changes' }, { screen: 'agents', label: 'Agents' }]

const titles: Record<Route['screen'], string> = { home: 'Home', flow: 'Work', notes: 'Notes', changes: 'Change sets', delivery: 'Delivery', work: 'Card', agents: 'Agents', terminal: 'Terminal', settings: 'Settings', account: 'Your account' }

type Theme = 'system' | 'light' | 'dark'

/** White on black or black on white: the system's choice unless you pick one, remembered in this browser. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (window.localStorage.getItem('binders-hub-theme') as Theme) || 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    // Diagrams are drawn in the theme's colours; they redraw on this.
    window.dispatchEvent(new Event('binders-theme'))
    try {
      window.localStorage.setItem('binders-hub-theme', theme)
    } catch {
      // Remembered for this tab only.
    }
  }, [theme])
  return [theme, setTheme] as const
}

/** The tab's title: the screen, or the card or note that's open. */
function usePageTitle(route: Route, signedOut: boolean) {
  const open = useHub((state) => (route.screen === 'work' ? state.cards.find((c) => c.id === route.id)?.title : route.screen === 'notes' ? state.notes.find((n) => n.id === route.id)?.title : undefined))
  const name = signedOut ? '' : open || titles[route.screen]
  useEffect(() => { document.title = name ? `${name} · Binders Hub` : 'Binders Hub' }, [name])
}

/**
 * Going to another screen moves focus to its heading, for a keyboard or a screen reader: what was focused has gone or is
 * behind them, and the heading says where they are. Not when the screen has put focus in a field of its own.
 */
function useFocusOnScreenChange(screen: Route['screen']) {
  const heading = useRef<HTMLHeadingElement & HTMLParagraphElement>(null)
  const last = useRef(screen)
  useEffect(() => {
    if (last.current === screen) return
    last.current = screen
    const now = document.activeElement
    if (now instanceof HTMLElement && now.closest('.screen') && (now.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(now.tagName))) return
    heading.current?.focus({ preventScroll: true })
  }, [screen])
  return heading
}

/** The counts beside the screens' names. */
function countsIn(state: State, binder: string): Partial<Record<Route['screen'], number>> {
  const here = (binderId: string) => binder === 'all' || binderId === binder
  return {
    flow: state.cards.filter((c) => c.stage === 'working' && here(c.binderId)).length || undefined,
    notes: state.proposals.filter((p) => p.state === 'new' && here(p.binderId)).length || undefined,
    changes: state.changeSets.filter((c) => c.state === 'review' && here(c.binderId)).length || undefined,
    delivery: state.environments.filter((e) => e.state === 'waiting' && e.needsApproval).length || undefined,
    agents: state.agents.filter((a) => !a.revoked && isOnline(a)).length || undefined,
  }
}

export default function App() {
  const [route, moving] = useRoute()
  const store = useActions()
  const binders = useHub((state) => state.binders)
  const signedOut = useHub((state) => state.signedOut)
  const allAgents = useHub((state) => state.agents)
  const connection = useHub((state) => state.sync.connection)
  const waiting = useHub((state) => state.sync.pending.length)
  const me = useHub((state) => state.me)
  const [palette, setPalette] = useState(false)
  // On a phone the sidebar is a menu, opened from the top bar and closed by going anywhere.
  const [menu, setMenu] = useState(false)
  const [theme, setTheme] = useTheme()
  // Whoever is signed in, large in the top bar: as big as the bar comfortably holds, a little less on a phone's shorter bar.
  const phone = usePhone()
  const menuOpen = menu && phone
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebar = useModal<HTMLElement>(() => setMenu(false), { active: menuOpen, returnTo: menuButton })
  const heading = useFocusOnScreenChange(route.screen)
  const content = useRef<HTMLDivElement>(null)
  usePageTitle(route, signedOut)
  const [binder, setBinder] = useBinder(useMemo(() => binders.map((b) => b.id), [binders]))
  const [splitting, setSplitting] = useState<string>()
  // An agent going quiet changes the count with nothing else changing.
  useClock()
  const counts = useHub((state) => countsIn(state, binder), sameValues)
  const agents = useMemo(() => allAgents.filter((a) => !a.revoked), [allAgents])

  // A card opens full screen, with its whole way from the note to production.
  const ui = useMemo<UI>(() => ({ openItem: (id: string) => go({ screen: 'work', id }), openPalette: () => setPalette(true), binder, setBinder, splitCard: (id: string) => setSplitting(id) }), [binder, setBinder])

  // A new note in the binder you're looking at, opened.
  const newNote = useCallback(() => {
    const target = binder !== 'all' ? binder : binders[0]?.id
    go({ screen: 'notes', id: target ? store.addNote(target) : '' })
  }, [binder, binders, store])

  const onKey = useCallback((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      setPalette((open) => !open)
      return
    }
    // New note: ⌘N where the browser lets a page have it (the hub installed as an app), ⌥⌘N anywhere. By the key's
    // place, as ⌥N types a character of its own.
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === 'KeyN') {
      event.preventDefault()
      newNote()
      return
    }
    const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return
    // And N on its own, when you're not typing.
    if (event.code === 'KeyN' && !palette) {
      event.preventDefault()
      newNote()
      return
    }
    const target = nav.find((n) => n.key === event.key)
    if (target && !palette) go(target.route)
    if (event.key === 'Escape' && route.screen === 'work') window.history.back()
  }, [palette, route.screen, newNote])

  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  useEffect(() => (signedOut ? undefined : prefetchScreens()), [signedOut])

  if (signedOut) {
    return (
      <>
        <SignIn />
        <Toast />
      </>
    )
  }

  const routeKey = href(route)
  // A card's own title is its page's heading.
  const Title = route.screen === 'work' ? 'p' : 'h1'
  // This binder has a GitHub App, but you haven't connected to it: the hub works in its repos, you can't act there as yourself.
  const unlinked = !!me?.github.app && !me.github.token

  // A popped-out note or chat: that alone, live like any other tab.
  if (poppedOut() !== 'none' && route.screen === 'notes') {
    return (
      <UIContext.Provider value={ui}>
        <div className="app popout">
          <main className="main"><div className="screen"><ErrorBoundary resetOn={routeKey}><Suspense fallback={<ScreenLoading />}><Notes id={route.id} /></Suspense></ErrorBoundary></div></main>
          <Toast />
          <ContextMenuHost />
        </div>
      </UIContext.Provider>
    )
  }

  return (
    <UIContext.Provider value={ui}>
      <div className={`app${menuOpen ? ' menu-open' : ''}${route.screen === 'terminal' ? ' terminal-open' : ''}`}>
        {/* A button, as a link to #main would be a route. */}
        <button type="button" className="skip-link" onClick={() => content.current?.focus()}>Skip to the content</button>
        {menuOpen && <button type="button" className="menu-scrim" aria-label="Close the menu" onClick={() => setMenu(false)} />}
        <aside ref={sidebar} className="sidebar" aria-label="Sidebar" {...(menuOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Menu', tabIndex: -1 } : {})} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setMenu(false) }}>
          <BinderSwitcher binder={binder} onPick={setBinder} />
          <button className="search-button" onClick={() => setPalette(true)}>
            <Search size={14} /> <span>Search or run</span> <Kbd>⌘K</Kbd>
          </button>
          <nav className="nav" aria-label="Screens">
            {nav.map((n) => {
              const Icon = n.icon
              const on = n.route.screen === route.screen || (n.route.screen === 'agents' && route.screen === 'terminal')
              return (
                <a key={n.label} href={href(n.route)} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
                  <Icon size={16} strokeWidth={2.2} />
                  <span>{n.label}</span>
                  {counts[n.route.screen] ? <em className={`count count-${n.route.screen}`}>{counts[n.route.screen]}</em> : <Kbd>{n.key}</Kbd>}
                </a>
              )
            })}
          </nav>

          <SideAgents agents={agents} />

          <footer className="side-foot">
            <span className={`sync ${connection}`} title={connection === 'live' ? 'Connected to the hub: changes save as you make them' : waiting ? `${waiting} changes wait in this browser for the hub` : 'The hub isn’t reachable'}>
              <i /> {connection === 'live' ? 'Hub' : connection === 'connecting' ? 'Connecting' : waiting ? `Offline · ${waiting} waiting` : 'Offline'}
            </span>
            <div className="theme-switch" role="group" aria-label="Appearance">
              {([['system', Monitor, 'Match the system'], ['light', Sun, 'Black on white'], ['dark', Moon, 'White on black']] as const).map(([value, Icon, label]) => (
                <button key={value} aria-pressed={theme === value} onClick={() => setTheme(value)} title={label} aria-label={label}>
                  <Icon size={13} />
                </button>
              ))}
            </div>
          </footer>
        </aside>

        <main className="main" inert={menuOpen}>
          <header className="topbar">
            <button type="button" ref={menuButton} className="icon-button menu-button" onClick={() => setMenu(true)} aria-label="Menu" aria-expanded={menuOpen}><Menu size={19} /></button>
            <Title key={Title} className="topbar-title" ref={heading} tabIndex={-1}>{titles[route.screen]}</Title>
            <span className={`live-pill ${connection === 'signed-out' ? 'offline' : connection}`}><i /> {connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}</span>
            <button type="button" className="icon-button topbar-search" onClick={() => setPalette(true)} aria-label="Search or run"><Search size={18} /></button>
            <div className="presence">
              {unlinked && <a className="gh-pill" href={href({ screen: 'account' })} aria-label="GitHub not connected" title="This binder’s GitHub App is set up, but you haven’t connected to it: you can’t link repos to agents, approve or merge as yourself until you do."><Github size={13} /> <span>GitHub not connected</span></a>}
              {me && <a className={`me${route.screen === 'account' ? ' on' : ''}${unlinked ? ' unlinked' : ''}`} href={href({ screen: 'account' })} aria-current={route.screen === 'account' ? 'page' : undefined} title={`Your account: signed in as ${me.user.login}${unlinked ? ', not connected to this binder’s GitHub' : me.github.token ? ', connected to this binder’s GitHub' : ''}`} aria-label="Your account"><PersonAvatar id={me.user.login} size={phone ? 34 : 38} /></a>}
            </div>
          </header>
          <UpdateFailed />
          <div ref={content} tabIndex={-1} className={`screen${moving ? ' moving' : ''}`}>
            <ErrorBoundary resetOn={routeKey}>
              <Suspense fallback={<ScreenLoading />}>
                {route.screen === 'home' && <Home />}
                {route.screen === 'flow' && <Flow />}
                {route.screen === 'notes' && <Notes id={route.id} />}
                {route.screen === 'changes' && <ChangeSets id={route.id} />}
                {route.screen === 'delivery' && <Delivery />}
                {route.screen === 'work' && <Work id={route.id} />}
                {route.screen === 'agents' && <Agents />}
                {route.screen === 'terminal' && <AgentTerminal key={route.id} id={route.id} sid={route.sid} />}
                {route.screen === 'settings' && <Settings />}
                {route.screen === 'account' && <Account />}
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>

        <nav className="tabbar" aria-label="Main screens" inert={menuOpen}>
          {tabs.map((t) => {
            const item = nav.find((n) => n.route.screen === t.screen)!
            const Icon = item.icon
            const on = route.screen === t.screen || (t.screen === 'flow' && route.screen === 'work')
            return (
              <a key={t.screen} href={href(item.route)} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
                <Icon size={20} strokeWidth={on ? 2.4 : 2} />
                <span>{t.label}</span>
                {counts[t.screen] ? <em className={`count count-${t.screen}`}>{counts[t.screen]}</em> : null}
              </a>
            )
          })}
        </nav>

        <AnimatePresence>{palette && <Palette key="palette" onClose={() => setPalette(false)} />}</AnimatePresence>
        {splitting && <SwarmDialog key={splitting} cardId={splitting} onClose={() => setSplitting(undefined)} />}
        <Toast />
        <ContextMenuHost />
      </div>
    </UIContext.Provider>
  )
}

/** A screen on its way the first time, once it's taken long enough to be worth saying: most arrive before this shows. */
function ScreenLoading() {
  return <p className="screen-loading" role="status">Loading…</p>
}

/** For the hub's admins: a newer commit didn't go in because its tests failed. Hidden for that commit once dismissed. */
function UpdateFailed() {
  const me = useHub((state) => state.me)
  const failed = me?.updateFailed
  const key = 'binders-hub-update-seen'
  const [seen, setSeen] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? ''
    } catch {
      return ''
    }
  })
  if (!failed || seen === failed.commit) return null
  const dismiss = () => {
    setSeen(failed.commit)
    try { window.localStorage.setItem(key, failed.commit) } catch { /* only a convenience */ }
  }
  return (
    <div className="update-failed" role="status">
      <AlertTriangle size={15} />
      <span>The hub didn’t update: <span className="mono">{failed.commit.slice(0, 7)}</span>{failed.subject ? ` (${failed.subject})` : ''} failed its tests, so it’s still on {me?.version ? <span className="mono">{me.version.commit.slice(0, 7)}</span> : 'the last good version'}. <a href={href({ screen: 'settings' })}>Settings → This hub</a> shows why.</span>
      <button type="button" className="icon-button" onClick={dismiss} aria-label="Dismiss"><X size={14} /></button>
    </div>
  )
}
