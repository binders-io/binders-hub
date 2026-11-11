import { useNotifySwitch } from '../data/notify'

/**
 * "Tell me when something waits on me": off until pressed, and pressing it is the one time the browser is asked. One
 * choice for this browser, so every switch on screen shows the same. Where the browser has no notifications at all,
 * it's left out of Home and said once in Account. Given a `line`, it's a row: its words with the switch at their end,
 * and the line under them, read out with it.
 */
export function NotifySwitch({ id, explain, line }: { id: string; explain?: boolean; line?: string }) {
  const { status, turnOn, turnOff } = useNotifySwitch()
  if (status === 'unsupported') return explain ? <p className="faint notify-note">This browser can’t show notifications.</p> : null
  return (
    <div className={`notify-switch${line ? ' with-line' : ''}`}>
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" checked={status === 'on'} disabled={status === 'denied'} aria-describedby={line ? `${id}-line` : undefined} onChange={(e) => { if (e.target.checked) void turnOn(); else turnOff() }} />
        <span aria-hidden="true" />
        Tell me when something waits on me
      </label>
      {line && <p className="notify-line" id={`${id}-line`}>{line}</p>}
      {status === 'denied' && <p className="faint notify-note">This browser is blocking them for this page. Allow them in its site settings, then come back.</p>}
    </div>
  )
}
