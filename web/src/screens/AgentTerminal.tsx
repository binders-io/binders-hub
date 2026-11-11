import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Keyboard, Plus, SquareTerminal, X } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { call } from '../data/api'
import { space } from '../data/space'
import { useStore } from '../data/store'
import { AgentAvatar, ago } from '../components/bits'
import { href } from '../route'
import { EmptyState } from '../kit'
import type { FromViewer, TerminalInfo, ToViewer } from '../../../shared/terminal.ts'

// A terminal's colours, the same in either theme: the tools draw for a dark terminal.
const theme = {
  background: '#0e0f14', foreground: '#e4e4ea', cursor: '#b7adff', cursorAccent: '#0e0f14', selectionBackground: '#4b3fb066',
  black: '#1b1c24', red: '#ff6b7a', green: '#5fd38d', yellow: '#f2c55c', blue: '#7aa2ff', magenta: '#b48cff', cyan: '#5cd3e0', white: '#d8d8e0',
  brightBlack: '#5c5e6e', brightRed: '#ff8a96', brightGreen: '#7fe0a6', brightYellow: '#f7d57e', brightBlue: '#9bbaff', brightMagenta: '#c9a8ff', brightCyan: '#82e2ec', brightWhite: '#ffffff',
}

/** A phone, or a window as narrow as one: the terminal takes the screen, with the keys a phone's keyboard lacks. */
const narrow = () => window.matchMedia('(max-width: 700px)').matches
const touch = () => window.matchMedia('(pointer: coarse), (max-width: 700px)').matches

// The text's size, the same in every tab and kept for next time: smaller on a phone, for the columns tools need.
const fontKey = 'binders-terminal-font'
const fontEvent = 'binders-terminal-font'
const fontSizes = [9, 10, 11, 11.5, 12, 13, 14, 15, 16]
function savedFont() {
  try {
    const saved = Number(window.localStorage.getItem(fontKey))
    if (fontSizes.includes(saved)) return saved
  } catch { /* only a convenience */ }
  return narrow() ? 11 : 13
}

/**
 * Where a phone's keyboard covers the page: iOS leaves the page its full height and slides the keyboard over it, so the
 * terminal is lifted by as much, and the app's top bar goes while it's up. Android's browsers shrink the page instead
 * (the viewport's interactive-widget), so nothing's covered there.
 */
function useKeyboardRoom() {
  useEffect(() => {
    const view = window.visualViewport
    if (!view) return
    const root = document.documentElement
    const fit = () => {
      const covered = Math.max(0, Math.round(window.innerHeight - view.height - view.offsetTop))
      const open = covered > 80
      root.style.setProperty('--keyboard', `${open ? covered : 0}px`)
      document.body.classList.toggle('keyboard-open', open)
      // iOS scrolls the page to the caret; the terminal is above the keyboard already.
      if (open && window.scrollY) window.scrollTo(0, 0)
    }
    fit()
    view.addEventListener('resize', fit)
    view.addEventListener('scroll', fit)
    return () => {
      view.removeEventListener('resize', fit)
      view.removeEventListener('scroll', fit)
      root.style.removeProperty('--keyboard')
      document.body.classList.remove('keyboard-open')
    }
  }, [])
}

/** A tab: one of the agent's terminals, open now or starting. */
interface Tab {
  key: string
  sid?: string
  info?: TerminalInfo
  ended?: string
}

/**
 * An agent's tool in terminals, as on its own machine: Claude Code (or whichever it runs) started by its runner in a
 * worktree of its own, with its access, model and Binders' MCP tools. One tab per terminal open on its machine, each
 * kept live while another is shown. Only its owner opens them. Leaving the page leaves them running; opened again,
 * each shows as it was.
 */
export function AgentTerminal({ id, sid }: { id: string; sid?: string }) {
  const { state } = useStore()
  const agent = state.agents.find((a) => a.id === id)
  const [tabs, setTabs] = useState<Tab[]>()
  const [active, setActive] = useState<string>()
  const controls = useRef(new Map<string, { end: () => void; rename: (name: string) => void }>())
  const [renaming, setRenaming] = useState<string>()
  const made = useRef(0)
  useKeyboardRoom()

  // The terminals open on its machine now, a tab each; none, a new one.
  useEffect(() => {
    void call<{ sessions: TerminalInfo[] }>('GET', `/api/agents/${id}/terminals`).catch(() => ({ sessions: [] as TerminalInfo[] })).then((r) => {
      const open: Tab[] = r.sessions.map((s) => ({ key: s.sid, sid: s.sid, info: s }))
      if (sid && !open.some((t) => t.sid === sid)) open.push({ key: sid, sid })
      if (!open.length) open.push({ key: `new-${++made.current}` })
      setTabs(open)
      setActive(sid ?? open[0].key)
    })
  }, [id, sid])

  const show = useCallback((tab?: Tab) => {
    if (!tab) return
    setActive(tab.key)
    // In the address, so a reload opens this one again.
    window.history.replaceState(null, '', href({ screen: 'terminal', id, sid: tab.sid }))
  }, [id])
  const add = () => {
    const tab = { key: `new-${++made.current}` }
    setTabs((now) => [...(now ?? []), tab])
    show(tab)
  }
  const update = useCallback((key: string, change: Partial<Tab>) => {
    setTabs((now) => now?.map((t) => (t.key === key ? { ...t, ...change } : t)))
    if (change.sid && key === active) window.history.replaceState(null, '', href({ screen: 'terminal', id, sid: change.sid }))
  }, [active, id])
  const close = (tab: Tab) => {
    // Closing a running one ends its tool.
    if (!tab.ended) controls.current.get(tab.key)?.end()
    const rest = (tabs ?? []).filter((t) => t.key !== tab.key)
    setTabs(rest)
    if (active === tab.key) show(rest[rest.length - 1])
    if (!rest.length) window.history.replaceState(null, '', href({ screen: 'terminal', id }))
  }

  // Tabs of the same tool numbered, in the order they're shown.
  const label = (tab: Tab) => {
    if (!tab.info) return tab.ended ? 'Ended' : 'Starting…'
    if (tab.info.name) return tab.info.name
    const same = (tabs ?? []).filter((t) => t.info?.tool === tab.info!.tool)
    return same.length > 1 ? `${tab.info.tool} ${same.indexOf(tab) + 1}` : tab.info.tool
  }
  const current = tabs?.find((t) => t.key === active)

  return (
    <div className="agent-terminal">
      {/* One slim bar: back to Agents, whose terminals these are, a tab each, and where the shown one works. */}
      <div className="term-bar">
        <a className="term-back" href={href({ screen: 'agents' })} aria-label="Back to Agents" title="Back to Agents"><ArrowLeft size={16} /></a>
        <span className="term-who">
          <AgentAvatar agent={agent} size={22} />
          <h2>{agent?.name ?? 'Agent'}</h2>
        </span>
        <div className="term-tabs" role="tablist" aria-label="Its terminals">
          {tabs?.map((tab) => (
            <div key={tab.key} className={`term-tab${tab.key === active ? ' on' : ''}${tab.ended ? ' ended' : ''}`}>
              {renaming === tab.key ? (
                <form className="term-tab-rename" onSubmit={(e) => {
                  e.preventDefault()
                  const value = new FormData(e.currentTarget).get('name')
                  const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
                  controls.current.get(tab.key)?.rename(name)
                  // Shown at once; the hub's word follows.
                  if (tab.info) update(tab.key, { info: { ...tab.info, name: name || undefined } })
                  setRenaming(undefined)
                }}>
                  <SquareTerminal size={13} aria-hidden="true" />
                  <input id={`term-name-${tab.key}`} name="name" autoFocus defaultValue={tab.info?.name ?? ''} placeholder={tab.info?.tool} maxLength={40} aria-label="The terminal’s name"
                    onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === 'Escape' && setRenaming(undefined)} />
                </form>
              ) : (
                <button type="button" role="tab" aria-selected={tab.key === active} onClick={() => show(tab)} onDoubleClick={() => tab.sid && !tab.ended && setRenaming(tab.key)}
                  // A long press on a phone, a right-click with a mouse: there's no double-click on a touchscreen.
                  onContextMenu={(e) => { if (tab.sid && !tab.ended) { e.preventDefault(); setRenaming(tab.key) } }}
                  title={tab.info ? `${tab.info.dir}, opened ${ago(tab.info.startedAt)}. Double-click or long-press to rename.` : undefined}>
                  <SquareTerminal size={13} aria-hidden="true" /> {label(tab)}
                </button>
              )}
              <button type="button" className="term-tab-close" onClick={() => close(tab)} aria-label={`Close ${label(tab)}`} title={tab.sid && !tab.ended ? 'Close: ends its tool (a worktree with changes is kept)' : 'Close'}>
                <X size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="term-tab-add" onClick={add} aria-label="New terminal" title="New terminal"><Plus size={14} /></button>
        </div>
        {current?.info && <span className="term-where" title={current.info.dir}><span className="mono">{current.info.dir}</span> · opened {ago(current.info.startedAt)}</span>}
      </div>
      <div className="term-views">
        {tabs?.map((tab) => (
          <TerminalView key={tab.key} agentId={id} sid={tab.sid} active={tab.key === active}
            onReady={(info) => update(tab.key, { sid: info.sid, info, ended: undefined })}
            onEnded={(why) => update(tab.key, { ended: why })}
            onNew={add}
            onChanged={(info) => update(tab.key, { info })}
            register={(control) => (control ? controls.current.set(tab.key, control) : controls.current.delete(tab.key))} />
        ))}
        {tabs && !tabs.length && (
          <div className="term-empty">
            <EmptyState icon={<SquareTerminal size={20} />} title="No terminals open" line={`Open one to use ${agent?.name ?? 'its tool'} on its machine, as you would there.`}
              action={<button type="button" className="button primary" onClick={add}><Plus size={14} aria-hidden="true" />New terminal</button>} />
          </div>
        )}
      </div>
    </div>
  )
}

/** One terminal: its screen, and its link to the hub. Kept alive while hidden, so switching back is instant. */
function TerminalView({ agentId, sid, active, onReady, onEnded, onChanged, onNew, register }: {
  agentId: string
  sid?: string
  active: boolean
  onReady: (info: TerminalInfo) => void
  onEnded: (why: string) => void
  onChanged: (info: TerminalInfo) => void
  onNew: () => void
  register: (control?: { end: () => void; rename: (name: string) => void }) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const fitRef = useRef<() => void>(undefined)
  const termRef = useRef<XTerm>(undefined)
  const sendRef = useRef<(message: FromViewer) => void>(undefined)
  // Ctrl from the keys bar: held for the next key typed.
  const ctrl = useRef(false)
  const [ctrlOn, setCtrlOn] = useState(false)
  const [keys] = useState(touch)
  const [note, setNote] = useState<{ text: string; tone: 'info' | 'error' }>()
  const [ended, setEnded] = useState<string>()
  // The latest callbacks, for the socket's handlers set up once.
  const calls = useRef({ onReady, onEnded, onChanged })
  calls.current = { onReady, onEnded, onChanged }

  useEffect(() => {
    if (!box.current) return
    const term = new XTerm({ theme, fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace', fontSize: savedFont(), lineHeight: 1.15, cursorBlink: true, scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(box.current)
    termRef.current = term
    // A phone's keyboard, as a terminal wants it: no capitals, corrections or suggestions put in for you.
    const area = box.current.querySelector('textarea')
    for (const [name, value] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['autocomplete', 'off'], ['spellcheck', 'false'], ['enterkeyhint', 'enter']]) area?.setAttribute(name, value)
    let socket: WebSocket | undefined
    let current = sid
    let closed = false
    let retry = 1000
    let timer: number | undefined
    const send = (message: FromViewer) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message))
    sendRef.current = send
    const refit = () => {
      // Hidden, it has no size to fit to.
      if (!box.current?.offsetWidth) return
      fit.fit()
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    }
    fitRef.current = () => {
      refit()
      term.focus()
    }
    refit()
    register({ end: () => send({ type: 'end' }), rename: (name) => send({ type: 'rename', name }) })

    const connect = () => {
      const url = new URL(`/api/terminal?agent=${encodeURIComponent(agentId)}${current ? `&sid=${current}` : ''}&cols=${term.cols}&rows=${term.rows}${space ? `&space=${space}` : ''}`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      socket = ws
      let finished = false
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ToViewer
        switch (message.type) {
          case 'replay':
            term.reset()
            term.write(message.data)
            retry = 1000
            break
          case 'output':
            term.write(message.data)
            break
          case 'ready':
            current = message.session.sid
            setNote(undefined)
            calls.current.onReady(message.session)
            break
          case 'session':
            calls.current.onChanged(message.session)
            break
          case 'status':
            setNote({ text: message.text, tone: 'info' })
            break
          case 'error':
            finished = true
            setNote({ text: message.text, tone: 'error' })
            calls.current.onEnded(message.text)
            break
          case 'exit': {
            finished = true
            const why = message.why ?? (message.code ? `It ended (exit ${message.code}).` : 'It ended.')
            setEnded(why)
            setNote(undefined)
            calls.current.onEnded(why)
            term.write('\r\n\x1b[2m[ended]\x1b[0m\r\n')
            break
          }
        }
      }
      ws.onclose = () => {
        if (closed || finished) return
        // The hub restarting, or the network: open the same terminal again.
        setNote({ text: 'Reconnecting…', tone: 'info' })
        timer = window.setTimeout(connect, retry)
        retry = Math.min(15_000, retry * 2)
      }
    }
    connect()

    const typed = term.onData((data) => {
      // Ctrl held from the keys bar: the key typed next is sent as Ctrl and it (Ctrl-C, Ctrl-R…).
      if (ctrl.current && data.length === 1 && /[a-z@[\\\]^_ ]/i.test(data)) {
        ctrl.current = false
        setCtrlOn(false)
        send({ type: 'input', data: String.fromCharCode(data === ' ' ? 0 : data.toUpperCase().charCodeAt(0) & 0x1f) })
        return
      }
      send({ type: 'input', data })
    })
    // The text's size changed in another tab, or from the keys bar here.
    const resized = () => {
      term.options.fontSize = savedFont()
      refit()
    }
    window.addEventListener(fontEvent, resized)
    let sized: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(sized)
      sized = window.setTimeout(refit, 60)
    })
    observer.observe(box.current)
    return () => {
      closed = true
      register(undefined)
      window.clearTimeout(timer)
      window.clearTimeout(sized)
      observer.disconnect()
      window.removeEventListener(fontEvent, resized)
      typed.dispose()
      socket?.close()
      term.dispose()
    }
    // Once per tab: a tab's terminal keeps its own link for as long as the tab is there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shown again: fitted to the window as it is now, and typed into.
  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.())
  }, [active])

  return (
    <div className="term-view" hidden={!active}>
      <div className="term-box" ref={box} onClick={() => box.current?.querySelector('textarea')?.focus()} />
      {keys && <TermKeys term={termRef} send={(data) => sendRef.current?.({ type: 'input', data })} ctrl={ctrlOn} onCtrl={(on) => { ctrl.current = on; setCtrlOn(on) }} box={box} />}
      {(note || ended) && (
        <p className={`term-note ${ended ? 'ended' : note!.tone}`}>
          <SquareTerminal size={14} aria-hidden="true" /> <span>{ended ?? note!.text}</span>
          {ended && <button type="button" className="button small" onClick={onNew}>Open a new one</button>}
        </p>
      )}
    </div>
  )
}

/**
 * The keys a phone's keyboard doesn't have, for the tools that need them: Esc to stop Claude Code, Tab and Shift-Tab,
 * the arrows to move through a menu, Ctrl for the next key, Ctrl-C. Pressing one leaves the keyboard as it was.
 */
function TermKeys({ term, send, ctrl, onCtrl, box }: {
  term: RefObject<XTerm | undefined>
  send: (data: string) => void
  ctrl: boolean
  onCtrl: (on: boolean) => void
  box: RefObject<HTMLDivElement | null>
}) {
  // The arrows as the tool asked for them: a full-screen tool turns on "application" cursor keys.
  const arrow = (key: 'A' | 'B' | 'C' | 'D') => `\x1b${term.current?.modes.applicationCursorKeysMode ? 'O' : '['}${key}`
  const typing = () => document.activeElement === box.current?.querySelector('textarea')
  const font = (step: number) => {
    const now = fontSizes.indexOf(savedFont())
    const next = fontSizes[Math.max(0, Math.min(fontSizes.length - 1, (now < 0 ? 5 : now) + step))]
    try { window.localStorage.setItem(fontKey, String(next)) } catch { /* only a convenience */ }
    window.dispatchEvent(new Event(fontEvent))
  }
  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '')
    if (text) term.current?.paste(text)
  }
  const keys: { label: ReactNode; name: string; act: () => void; on?: boolean }[] = [
    { label: 'Esc', name: 'Escape', act: () => send('\x1b') },
    { label: 'Tab', name: 'Tab', act: () => send('\t') },
    { label: '⇧Tab', name: 'Shift-Tab', act: () => send('\x1b[Z') },
    { label: <ArrowUp size={15} />, name: 'Up', act: () => send(arrow('A')) },
    { label: <ArrowDown size={15} />, name: 'Down', act: () => send(arrow('B')) },
    { label: <ArrowLeft size={15} />, name: 'Left', act: () => send(arrow('D')) },
    { label: <ArrowRight size={15} />, name: 'Right', act: () => send(arrow('C')) },
    { label: 'Ctrl', name: 'Ctrl, for the next key', act: () => onCtrl(!ctrl), on: ctrl },
    { label: '^C', name: 'Ctrl-C', act: () => send('\x03') },
    { label: <ClipboardPaste size={15} />, name: 'Paste', act: () => void paste() },
    { label: 'A−', name: 'Smaller text', act: () => font(-1) },
    { label: 'A+', name: 'Larger text', act: () => font(1) },
    { label: <Keyboard size={15} />, name: 'Show or hide the keyboard', act: () => {
      const area = box.current?.querySelector('textarea')
      if (typing()) area?.blur()
      else area?.focus()
    } },
  ]
  return (
    <div className="term-keys" role="toolbar" aria-label="Keys">
      {keys.map((key) => (
        <button key={key.name} type="button" className={key.on ? 'on' : undefined} aria-label={key.name} title={key.name}
          aria-pressed={key.on === undefined ? undefined : key.on}
          // Pressing a key doesn't take the focus from the terminal, so the keyboard stays up.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const was = typing()
            key.act()
            if (was && key.name !== 'Show or hide the keyboard') box.current?.querySelector('textarea')?.focus()
          }}>
          {key.label}
        </button>
      ))}
    </div>
  )
}
