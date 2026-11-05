import { useState } from 'react'
import { Check, Copy, KeyRound, LoaderCircle } from 'lucide-react'
import { attempt } from './Toast'
import type { Agent } from '../data/model'
import { isListening, useStore } from '../data/store'

/**
 * Starting an agent with the Binders runner: one command to paste in Terminal, which gets the runner (the hub serves
 * it) and starts it with the agent's token in its folder, then the hub's presence, live, as it connects. Without the
 * token at hand, one click makes a new one (the old one stops working) and puts it in the command.
 */
export function RunnerSteps({ agent, token: given }: { agent: Agent; token?: string }) {
  const store = useStore()
  const { state } = store
  const [copied, setCopied] = useState(false)
  const [token, setToken] = useState(given)
  const [making, setMaking] = useState(false)
  // In the background (installed with the `binders` command, kept running at login and after a crash), or in this terminal.
  const [how, setHow] = useState<'background' | 'terminal'>('background')
  const [windows, setWindows] = useState(() => /Windows/.test(navigator.userAgent))
  const live = state.agents.find((a) => a.id === agent.id) ?? agent
  const listening = isListening(live)
  const where = live.runner?.workspace
  const command = runnerCommand({ windows, how, origin: window.location.origin, token: token ?? '<its token>', where })
  const copy = async () => {
    await navigator.clipboard.writeText(command).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  const fresh = async () => {
    setMaking(true)
    const made = await attempt(() => store.newToken(agent.id))
    setMaking(false)
    if (made) setToken(made)
  }

  return (
    <ol className="runner-steps">
      <li>
        <h3>Paste this in {windows ? 'PowerShell' : 'Terminal'} <span className="faint">needs Node 20 or newer</span></h3>
        <div className="segmented runner-how" role="radiogroup" aria-label="What it runs on">
          <button type="button" role="radio" aria-checked={!windows} className={!windows ? 'on' : ''} onClick={() => setWindows(false)}>macOS or Linux</button>
          <button type="button" role="radio" aria-checked={windows} className={windows ? 'on' : ''} onClick={() => setWindows(true)}>Windows</button>
        </div>
        <div className="segmented runner-how" role="radiogroup" aria-label="How it runs">
          <button type="button" role="radio" aria-checked={how === 'background'} className={how === 'background' ? 'on' : ''} onClick={() => setHow('background')}>In the background</button>
          <button type="button" role="radio" aria-checked={how === 'terminal'} className={how === 'terminal' ? 'on' : ''} onClick={() => setHow('terminal')}>In this terminal</button>
        </div>
        {token ? (
          <Command text={command} copied={copied} onCopy={() => void copy()} />
        ) : (
          <div className="runner-token">
            <p className="faint">The command carries the agent’s token, shown once. {listening ? 'Making a new one stops the runner using the old one: restart it with this.' : 'Make one for it:'}</p>
            <button type="button" className="button primary" disabled={making} onClick={() => void fresh()}><KeyRound size={14} /> {making ? 'Making it…' : 'Make the command'}</button>
          </div>
        )}
        <p className="faint">
          {where ? <>It works in <span className="mono">{where}</span>, as set for this agent. </> : 'Change ~/path/to/your/code to the folder with the code, or set it once in this agent’s settings. '}
          {how === 'background'
            ? <>It installs the <span className="mono">binders</span> command and keeps the agent running in the background: at login, and again after a crash. Then <span className="mono">binders list</span> shows your agents, and <span className="mono">binders logs</span>, <span className="mono">restart</span>, <span className="mono">stop</span> and <span className="mono">remove</span> do what they say. It takes each card as it comes, and updates itself.</>
            : 'Leave it running: it takes each card as it comes, and updates itself. Restarting? Stop the old one first with Ctrl-C.'}
        </p>
      </li>
      <li className={listening ? 'done' : ''}>
        <h3>{listening ? <><Check size={14} strokeWidth={3} /> Listening for work</> : <><LoaderCircle size={14} className="spin" /> Waiting for the runner to connect…</>}</h3>
        <p className="faint">{listening ? `On ${live.runsOn ?? 'its machine'}. Cards meant for ${live.name}, or open to any agent that can, go to it now.` : 'This turns green as soon as it connects.'}</p>
      </li>
    </ol>
  )
}

/** The command to paste, for where it's going to run. */
export function runnerCommand({ windows, how, origin, token, where }: { windows: boolean; how: 'background' | 'terminal'; origin: string; token: string; where?: string }) {
  const folder = where ? (where.includes(' ') ? `'${where}'` : where) : windows ? '$HOME/path/to/your/code' : '~/path/to/your/code'
  if (windows) {
    const file = '$HOME/.binders/binders-runner.mjs'
    return how === 'background'
      ? `& ([scriptblock]::Create((irm ${origin}/install.ps1))) add --token ${token} --workspace ${folder}`
      : [
          ...(where ? [`cd ${folder}`] : []),
          `New-Item -ItemType Directory -Force $HOME/.binders | Out-Null`,
          `irm ${origin}/runner/binders-runner.mjs -OutFile ${file}`,
          `$env:BINDERS_TOKEN='${token}'`,
          `node ${file} --hub ${origin}${where ? '' : ` --workspace ${folder}`}`,
        ].join('; ')
  }
  const file = '~/.binders/binders-runner.mjs'
  return how === 'background'
    ? `curl -fsSL ${origin}/install | sh -s -- add --token ${token} --workspace ${folder}`
    : [
        ...(where ? [`cd ${folder}`] : []),
        `mkdir -p ~/.binders`,
        `curl -fsSL ${origin}/runner/binders-runner.mjs -o ${file}`,
        `BINDERS_TOKEN=${token} node ${file} --hub ${origin}${where ? '' : ' --workspace ~/path/to/your/code'}`,
      ].join(' && ')
}

function Command({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="command">
      <pre className="mono">{text}</pre>
      <button type="button" className="icon-button" onClick={onCopy} aria-label="Copy">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
  )
}
