import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useStore } from '../data/store'
import { href } from '../route'
import { Dialog } from './Dialog'

/**
 * What the hub is called in Claude Code. `binders` is taken: Binders for Mac gives its own server that name, and puts
 * it back whenever it connects. `binders_hub` is the one a runner adds for each of an agent's runs.
 */
export const claudeCodeName = 'binders-hub'

/** The command that adds the hub to Claude Code, in every folder, as you: Claude Code signs in through the browser. */
export const claudeCodeCommand = (url: string) => `claude mcp add --transport http --scope user ${claudeCodeName} ${url}`

/** The hub in Claude Code: the one command to paste, and how Claude Code then signs in as you. */
export function ClaudeCodeDialog({ onClose }: { onClose: () => void }) {
  const me = useStore().state.me
  const command = claudeCodeCommand(me?.mcpUrl ?? new URL('/mcp', window.location.origin).toString())
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(command).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <Dialog title="Add the hub to Claude Code" onClose={onClose}>
      <div className="claude-code">
        <p>Paste this in a terminal:</p>
        <pre className="mono">{command}</pre>
        <button type="button" className="button primary" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy the command'}
        </button>
        <p>Then in Claude Code, type <code>/mcp</code>, pick {claudeCodeName} and sign in. A browser opens on the hub: tick the binders it may work in and allow it. There’s no token to copy.</p>
        <p className="faint">It works in every folder, as you. The connection shows in <a href={href({ screen: 'account' })} onClick={onClose}>Your account</a>, where you can disconnect it.</p>
      </div>
    </Dialog>
  )
}
