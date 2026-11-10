import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useStore } from '../../data/store'
import { claudeCodeCommand } from '../../components/ClaudeCode'
import { Status } from './shared'

/** How the hub is doing: its log, its connection, its address and version, and a failed update. Then the addresses other clients use. */
export function HubStatus() {
  const { state } = useStore()
  const me = state.me
  return (
    <>
      <ul className="status-list">
        <Status ok={me?.log === 'redis'} label="Change log" detail={me?.log === 'redis' ? 'On Redis: everything is kept across restarts.' : 'In memory: set REDIS_URL, or everything is gone when the hub stops.'} />
        <Status ok={state.sync.connection === 'live'} label="Live connection" detail={state.sync.connection === 'live' ? `Up to date, at change ${state.sync.version}.` : 'Reconnecting. Your changes wait in this browser meanwhile.'} />
        {me && <Status ok label="Address" detail={me.publicUrl} />}
        <Status ok={!me?.updateFailed} label="Version" detail={me?.version
          ? <>Commit {me.version.repo ? <a className="mono" href={`${me.version.repo}/commit/${me.version.commit}`} target="_blank" rel="noreferrer">{me.version.commit.slice(0, 7)}</a> : <span className="mono">{me.version.commit.slice(0, 7)}</span>}{me.version.subject ? `: ${me.version.subject}` : ''}</>
          : 'Not built by the server’s updater, so it doesn’t know its commit.'} />
        {me?.updateFailed && (
          <Status ok={false} label="Didn’t update" detail={<>
            <span className="mono">{me.updateFailed.commit.slice(0, 7)}</span>{me.updateFailed.subject ? ` (${me.updateFailed.subject})` : ''} failed its tests{me.updateFailed.at ? ` on ${new Date(me.updateFailed.at).toLocaleString()}` : ''}, so the hub stayed on the version above. A newer commit that passes goes in by itself.
            {me.updateFailed.log && <details className="update-log"><summary>How the tests ended</summary><pre className="mono">{me.updateFailed.log}</pre></details>}
          </>} />
        )}
      </ul>
      <details className="settings-more">
        <summary>Addresses for agents and MCP clients</summary>
        <Addresses />
      </details>
    </>
  )
}

/** Where agents and other MCP clients connect. Add to Claude Code and an agent's card give most people what they need. */
function Addresses() {
  const me = useStore().state.me
  if (!me) return null
  const runner = `${window.location.origin}/runner/binders-runner.mjs`
  // The binder's own address, for a person's terminal: OAuth signs them in as themselves, and an agent's token being
  // replaced doesn't touch it.
  const mine = me.space ? new URL(`/${me.space}/mcp`, window.location.origin).toString() : me.mcpUrl
  return (
    <div className="copy-rows">
      <CopyRow label="MCP for you, in the binders you pick" value={me.mcpUrl} hint={`Add to Claude Code, on the Agents page, has the command for Claude Code: ${claudeCodeCommand(me.mcpUrl)}. It opens a browser to sign in with GitHub and pick the binders it works in: no token to copy, and an agent’s token being replaced doesn’t touch it. Agents use this address too, with their own token.`} />
      <CopyRow label="MCP for you, in this binder alone" value={mine} hint="The same, for this binder only." />
      <CopyRow label="The runner" value={runner} hint="Keeps an agent taking cards. Start the runner on an agent’s card shows the whole command." />
    </div>
  )
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="copy-row">
      <span className="field-label">{label}</span>
      <div className="token-value mono">
        <span>{value}</span>
        <button className="icon-button" onClick={() => void copy()} aria-label={`Copy the ${label.toLowerCase()}`}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}
