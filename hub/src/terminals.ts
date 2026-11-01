import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { terminalName, termSize, type FromRunner, type FromViewer, type TerminalInfo, type ToRunner, type ToViewer } from '../../shared/terminal.ts'

/** A binder's agent, as terminals know it: "space/agent". */
export type AgentKey = string

/**
 * The agents' terminals: each runner's live link, and who has which of its terminals open. What a terminal writes goes
 * to everyone who has it open; what they type goes to it. The hub keeps nothing of it: the runner has the terminals and
 * what they wrote, so they outlast the hub restarting.
 */
export class Terminals extends EventEmitter<{ change: [AgentKey] }> {
  private runners = new Map<AgentKey, WebSocket>()
  private open = new Map<AgentKey, TerminalInfo[]>()
  /** Each terminal's agent: a runner can only speak for its own. */
  private agentOf = new Map<string, AgentKey>()
  private viewers = new Map<string, Map<string, WebSocket>>()
  /** Names given here, kept too: a runner from before names were kept on it doesn't, and shows them anyway. */
  private names = new Map<string, string>()
  private named = (s: TerminalInfo): TerminalInfo => (this.names.has(s.sid) ? { ...s, name: this.names.get(s.sid) || undefined } : s)

  /** Whether the agent's runner is linked, and its terminals open now. */
  list(key: AgentKey) {
    return { online: this.runners.has(key), sessions: (this.open.get(key) ?? []).map(this.named) }
  }

  /** A runner's live link: it says who it is first (its agent's token), then speaks for that agent's terminals alone. */
  runner(socket: WebSocket, who: (token: string) => Promise<AgentKey | undefined>) {
    let key: AgentKey | undefined
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000)
    const hello = setTimeout(() => !key && socket.close(4001, 'Say who you are first.'), 10_000)
    socket.on('message', async (raw) => {
      let message: FromRunner
      try {
        message = JSON.parse(String(raw)) as FromRunner
      } catch {
        return
      }
      if (!key) {
        if (message.type !== 'hello') return
        key = await who(String(message.token ?? ''))
        clearTimeout(hello)
        if (!key) return socket.close(4003, 'This hub doesn’t know that token.')
        // A runner linking again (or a second one for the same agent) takes over.
        const before = this.runners.get(key)
        this.runners.set(key, socket)
        if (before && before !== socket) before.close(4000, 'Another runner for this agent linked.')
        for (const [sid, agent] of this.agentOf) if (agent === key) this.toViewers(sid, { type: 'status', text: 'The runner is back.' })
        this.emit('change', key)
        return
      }
      switch (message.type) {
        case 'sessions': {
          const sessions = (message.sessions ?? []).filter((s) => typeof s?.sid === 'string').map(this.named)
          this.open.set(key, sessions)
          for (const s of sessions) if ((this.agentOf.get(s.sid) ?? key) === key) this.agentOf.set(s.sid, key)
          // Each open one as it is now, to whoever has it open (renamed in another tab, say).
          for (const s of sessions) if (this.agentOf.get(s.sid) === key) this.toViewers(s.sid, { type: 'session', session: s })
          this.emit('change', key)
          break
        }
        case 'output':
          if (this.agentOf.get(message.sid) === key) this.toViewers(message.sid, { type: 'output', data: String(message.data) })
          break
        case 'replay': {
          if (this.agentOf.get(message.sid) !== key) break
          const viewer = this.viewers.get(message.sid)?.get(message.viewer)
          const found = this.open.get(key)?.find((s) => s.sid === message.sid)
          const session = found && this.named(found)
          if (viewer) {
            send(viewer, { type: 'replay', data: String(message.data) })
            if (session) send(viewer, { type: 'ready', session })
          }
          break
        }
        case 'exit':
          if (this.agentOf.get(message.sid) !== key) break
          this.toViewers(message.sid, { type: 'exit', code: message.code ?? null, why: message.why })
          for (const viewer of this.viewers.get(message.sid)?.values() ?? []) viewer.close(1000)
          this.viewers.delete(message.sid)
          this.agentOf.delete(message.sid)
          this.names.delete(message.sid)
          break
      }
    })
    socket.on('close', () => {
      clearInterval(ping)
      clearTimeout(hello)
      if (!key || this.runners.get(key) !== socket) return
      this.runners.delete(key)
      this.emit('change', key)
      for (const [sid, agent] of this.agentOf) if (agent === key) this.toViewers(sid, { type: 'status', text: 'The runner went away. Its terminal keeps going there, and shows here again once it’s back.' })
    })
  }

  /**
   * Someone with a terminal open in the web app (the hub has checked it's the agent's owner): a terminal of theirs
   * opened again, or a new one.
   */
  viewer(socket: WebSocket, key: AgentKey, by: string, want: { sid?: string; cols?: unknown; rows?: unknown }) {
    const runner = this.runners.get(key)
    if (!runner) {
      send(socket, { type: 'error', text: 'The agent’s runner isn’t linked: start it (runner 0.7.2 or newer), then open the terminal again.' })
      return socket.close(1000)
    }
    const size = termSize(want.cols, want.rows)
    const viewer = randomBytes(6).toString('hex')
    const known = want.sid ? (this.open.get(key) ?? []).find((s) => s.sid === want.sid) : undefined
    if (want.sid && !known) {
      send(socket, { type: 'exit', code: null, why: 'That terminal has ended.' })
      return socket.close(1000)
    }
    const sid = known?.sid ?? `t${randomBytes(6).toString('hex')}`
    this.agentOf.set(sid, key)
    const watching = this.viewers.get(sid) ?? new Map<string, WebSocket>()
    watching.set(viewer, socket)
    this.viewers.set(sid, watching)
    const toRunner = (message: ToRunner) => {
      const now = this.runners.get(key)
      if (now?.readyState === now?.OPEN) now!.send(JSON.stringify(message))
    }
    if (known) {
      toRunner({ type: 'attach', sid, viewer })
      toRunner({ type: 'resize', sid, ...size })
    } else {
      send(socket, { type: 'status', text: 'Starting it on the agent’s machine…' })
      toRunner({ type: 'open', sid, by, ...size, viewer })
    }
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000)
    socket.on('message', (raw) => {
      let message: FromViewer
      try {
        message = JSON.parse(String(raw)) as FromViewer
      } catch {
        return
      }
      if (message.type === 'input' && typeof message.data === 'string') toRunner({ type: 'input', sid, data: message.data.slice(0, 100_000) })
      else if (message.type === 'resize') toRunner({ type: 'resize', sid, ...termSize(message.cols, message.rows) })
      else if (message.type === 'end') toRunner({ type: 'close', sid })
      else if (message.type === 'rename') {
        const name = terminalName(message.name)
        this.names.set(sid, name)
        toRunner({ type: 'rename', sid, name })
        // Everyone with it open, and the sidebar, at once; a runner that keeps names says so again shortly.
        const session = this.open.get(key)?.find((s) => s.sid === sid)
        if (session) this.toViewers(sid, { type: 'session', session: this.named(session) })
        this.emit('change', key)
      }
    })
    socket.on('close', () => {
      clearInterval(ping)
      this.viewers.get(sid)?.delete(viewer)
    })
  }

  private toViewers(sid: string, message: ToViewer) {
    for (const viewer of this.viewers.get(sid)?.values() ?? []) send(viewer, message)
  }
}

const send = (socket: WebSocket, message: ToViewer) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}
