import { Database, Globe, GitCommitHorizontal, Play, Radio, SquareTerminal, TriangleAlert } from 'lucide-react'
import { useStore } from '../../data/store'
import { Rows, Section, Status } from '../../kit'
import { claudeCodeCommand } from '../../components/ClaudeCode'
import { CopyButton, InfoRow } from './shared'

/**
 * How the hub is doing, a row each: its log, its connection, its version, and an update that failed, with its tests'
 * end to read. Then the addresses other clients use, each with a button to copy it.
 */
export function HubStatus() {
  const { state } = useStore()
  const me = state.me
  const live = state.sync.connection === 'live'
  const redis = me?.log === 'redis'
  return (
    <>
      <Section title="How it’s doing">
        <Rows label="How it’s doing">
          <InfoRow icon={<Database size={16} />} title="Change log" status={<Status tone={redis ? 'ok' : 'bad'}>{redis ? 'Kept' : 'In memory'}</Status>}
            line={redis ? 'On Redis: everything is kept across restarts.' : 'In memory: set REDIS_URL, or everything is gone when the hub stops.'} />
          <InfoRow icon={<Radio size={16} />} title="Live connection" status={<Status tone={live ? 'ok' : 'waiting'}>{live ? 'Live' : 'Reconnecting'}</Status>}
            line={live ? `Up to date, at change ${state.sync.version}.` : 'Reconnecting. Your changes wait in this browser meanwhile.'} />
          <InfoRow icon={<GitCommitHorizontal size={16} />} title="Version" status={<Status tone={me?.updateFailed ? 'bad' : 'ok'}>{me?.updateFailed ? 'Didn’t update' : 'Running'}</Status>}
            line={me?.version
              ? <>Commit {me.version.repo ? <a className="mono" href={`${me.version.repo}/commit/${me.version.commit}`} target="_blank" rel="noreferrer">{me.version.commit.slice(0, 7)}</a> : <span className="mono">{me.version.commit.slice(0, 7)}</span>}{me.version.subject ? `: ${me.version.subject}` : ''}</>
              : 'Not built by the server’s updater, so it doesn’t know its commit.'}
            trailing={me?.version ? <CopyButton value={me.version.commit} label="the commit" /> : undefined} />
          {me?.updateFailed && (
            <InfoRow icon={<TriangleAlert size={16} />} tone="danger" title="Didn’t update"
              line={<><span className="mono">{me.updateFailed.commit.slice(0, 7)}</span>{me.updateFailed.subject ? ` (${me.updateFailed.subject})` : ''} failed its tests{me.updateFailed.at ? ` on ${new Date(me.updateFailed.at).toLocaleString()}` : ''}, so the hub stayed on the version above. A newer commit that passes goes in by itself.</>}>
              {me.updateFailed.log && <details className="update-log"><summary>How the tests ended</summary><pre className="mono">{me.updateFailed.log}</pre></details>}
            </InfoRow>
          )}
        </Rows>
      </Section>
      <Addresses />
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
  const rows = [
    { icon: <Globe size={16} />, label: 'This hub', value: me.publicUrl, copy: 'the hub’s address' },
    { icon: <SquareTerminal size={16} />, label: 'MCP for you, in the binders you pick', value: me.mcpUrl, copy: 'the MCP address for the binders you pick' },
    { icon: <SquareTerminal size={16} />, label: 'MCP for you, in this binder alone', value: mine, copy: 'the MCP address for this binder' },
    { icon: <Play size={16} />, label: 'The runner', value: runner, copy: 'the runner’s address' },
  ]
  return (
    <Section title="Addresses" lead="Where agents and MCP clients reach this hub." moreLabel="Which to use"
      more={(
        <>
          <p>Add to Claude Code, on the Agents page, has the command for Claude Code: <span className="mono">{claudeCodeCommand(me.mcpUrl)}</span>. It opens a browser to sign in with GitHub and pick the binders it works in: no token to copy, and an agent’s token being replaced doesn’t touch it. Agents use the first MCP address too, with their own token.</p>
          <p>The second is the same, for this binder only. The runner keeps an agent taking cards; Start the runner, on an agent’s card, shows the whole command.</p>
        </>
      )}>
      <Rows label="Addresses">
        {rows.map((r) => <InfoRow key={r.label} icon={r.icon} title={r.label} line={<span className="mono value-line">{r.value}</span>} trailing={<CopyButton value={r.value} label={r.copy} />} />)}
      </Rows>
    </Section>
  )
}
