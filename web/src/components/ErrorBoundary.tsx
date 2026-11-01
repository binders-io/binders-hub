import { Component, type ErrorInfo, type ReactNode } from 'react'

// When a screen can't be shown. The likeliest reason is the hub updating: files are named by their contents, so a tab
// left open asks for a screen that isn't there any more, and loading the page again puts that right. Offline there's
// nothing to load it from, and reloading would lose the page, so it waits. Anything else is a bug: it says so here, and
// the rest of the app keeps working. Waiting changes are in the browser (sync.ts), so none of this loses what's written.

const reloadedAt = 'binders-reloaded-at'
/** A reload this recent didn't help: don't loop. */
const reloadWindowMs = 30_000

const message = (error: unknown) => String((error as Error | undefined)?.message ?? error)

/** Chrome's, Firefox's and Safari's words for an import() that failed, and Vite's for a stylesheet one needed. */
export const isChunkError = (error: unknown) => /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message(error))

function reloadedLately() {
  try {
    return Date.now() - Number(window.sessionStorage.getItem(reloadedAt) ?? 0) < reloadWindowMs
  } catch {
    return true // Nowhere to remember it, so never by itself.
  }
}

function noteReload() {
  try {
    window.sessionStorage.setItem(reloadedAt, String(Date.now()))
  } catch {
    // reloadedLately says true without storage.
  }
}

interface Props {
  children: ReactNode
  /** Changing this tries the children again: the route, so going elsewhere gets out of a broken screen. */
  resetOn?: string
  /** With no app around it: the whole window. */
  whole?: boolean
  reload?: () => void
}

export class ErrorBoundary extends Component<Props, { error?: unknown }> {
  state: { error?: unknown } = {}
  private leave?: () => void

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  private reload = () => (this.props.reload ?? (() => window.location.reload()))()

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('A screen couldn’t be shown:', error, info.componentStack)
    if (!isChunkError(error)) return
    if (!window.navigator.onLine) {
      const back = () => this.reload()
      window.addEventListener('online', back, { once: true })
      this.leave = () => window.removeEventListener('online', back)
    } else if (!reloadedLately()) {
      noteReload()
      this.reload()
    }
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetOn !== this.props.resetOn && this.state.error !== undefined) {
      this.leave?.()
      this.setState({ error: undefined })
    }
  }

  componentWillUnmount() {
    this.leave?.()
  }

  render() {
    const { error } = this.state
    if (error === undefined) return this.props.children
    const chunk = isChunkError(error)
    const offline = chunk && !window.navigator.onLine
    return (
      <div className={`empty-screen screen-failed${this.props.whole ? ' whole' : ''}`} role="alert">
        <h2>{offline ? 'This screen needs the hub' : chunk ? 'This screen didn’t load' : 'Something went wrong here'}</h2>
        <p>{offline
          ? 'You’re offline, and it hadn’t loaded yet. It opens by itself when you’re back. What you’ve written is kept in this browser.'
          : chunk
            ? 'The hub may have just updated, or the connection dropped. What you’ve written is kept in this browser.'
            : 'This screen hit an error. What you’ve written is kept in this browser.'}</p>
        {!chunk && <p className="mono screen-failed-why">{message(error)}</p>}
        {!offline && <button type="button" className="button primary big" onClick={this.reload}>Reload</button>}
      </div>
    )
  }
}
