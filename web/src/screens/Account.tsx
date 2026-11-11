import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { AppWindow, KeyRound, Link2, LogOut, Plug, SquareTerminal, TriangleAlert } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { Dialog, EmptyState, Guided, PageHeader, Row, Rows, Section, Skeleton } from '../kit'
import { PersonAvatar, ago } from '../components/bits'
import { attempt, toast } from '../components/Toast'
import { YourGitHub } from '../components/YourGitHub'
import { BinderTag } from '../components/BinderTag'
import { NotifySwitch } from '../components/NotifySwitch'
import { SettingsLink } from '../components/SettingsLink'
import { claudeCodeCommand, claudeCodeName } from '../components/ClaudeCode'
import { CopyButton } from './settings/shared'

/**
 * You, wherever you are on the hub: who you're signed in as, your notifications, where your captures go, your GitHub
 * connections, and the apps and clients signed in as you. Yours, not a binder's, so it has a page of its own, opened
 * from your picture at the top, and isn't in any binder's Settings.
 */
export function Account() {
  const store = useStore()
  const me = store.state.me
  const tokens = useTokens()
  return (
    <div className="page account-page">
      <div className="page-column">
        <PageHeader title="Your account" lead="Who you’re signed in as, here and in apps. The same in every binder you’re in." />
        {me ? (
          <div className="account-me">
            <PersonAvatar id={me.user.login} size={48} />
            <div className="account-me-text">
              <span className="account-me-name">{me.user.name || me.user.login}{me.hubAdmin && <span className="tag account-admin">Hub admin</span>}</span>
              <span className="account-me-line">{me.github.signIn ? `@${me.user.login} on GitHub` : `${me.user.login}, signed in by name on this machine`}</span>
            </div>
            <button type="button" className="button" onClick={() => void store.signOut()}><LogOut size={14} aria-hidden="true" />Sign out</button>
          </div>
        ) : (
          <div className="account-me" aria-busy="true"><Skeleton round width={48} height={48} /><div className="account-me-text"><Skeleton width="40%" height={14} /><Skeleton width="60%" height={12} /></div></div>
        )}
        <Section title="Notifications">
          <div><NotifySwitch id="notify-account" explain line="When an agent asks you something, or work is ready to approve, and this page isn’t in front. Remembered in this browser only." /></div>
        </Section>
        <CaptureHome />
        <YourGitHub />
        <Apps tokens={tokens} />
        <McpConnections tokens={tokens} />
      </div>
    </div>
  )
}

/**
 * Where what your phone and Mac capture goes: your own Binder, or a team's you're in. Kept on the hub, so it holds on
 * every device. If it names a Binder you've left, captures go to your own again, and this says so.
 */
function CaptureHome() {
  const [now, setNow] = useState<{ home: string; binders: { id: string; name: string; personal: boolean }[] }>()
  useEffect(() => {
    void call<typeof now>('GET', '/api/personal/captures').then(setNow, () => {})
  }, [])
  if (!now?.binders?.length) return null
  const choose = (binder: string) => void attempt(() => call<NonNullable<typeof now>>('PUT', '/api/personal/captures', { binder })).then((saved) => {
    if (!saved) return
    setNow(saved)
    const where = saved.binders.find((b) => b.id === saved.home)
    toast(`Your captures go to ${where?.personal ? 'your own Binder' : where?.name} now.`)
  })
  return (
    <Section title="Captures">
      <div className="field">
        <label className="field-label" htmlFor="capture-home">Where what your phone and Mac capture goes</label>
        <select id="capture-home" className="select" value={now.home} onChange={(event) => choose(event.target.value)}>
          {now.binders.map((b) => <option key={b.id} value={b.id}>{b.personal ? 'Your own Binder' : b.name}</option>)}
        </select>
        <span className="field-hint">Conversations, meetings and dictations arrive there as notes, and what they offer to do goes on its board. Your own Binder is yours alone.</span>
      </div>
    </Section>
  )
}

/** binder: the one it's registered to, whose GitHub App it signed in through; none when it signed in without one. */
interface AppToken { id: string; app: string; at: string; binder?: { id: string; name: string; personal: boolean }; binders?: { id: string; name: string }[]; kind?: 'app' | 'mcp'; expiresAt?: string; clientId?: string }

type Tokens = ReturnType<typeof useTokens>

/** The tokens of each kind, asked once for the page: an app signed in through the browser, or an MCP client signed in through OAuth. */
function useTokens() {
  const [tokens, setTokens] = useState<AppToken[]>()
  const refresh = () => void call<{ tokens: AppToken[] }>('GET', '/api/tokens').then((r) => setTokens(r.tokens)).catch(() => {})
  useEffect(refresh, [])
  const revoke = (id: string) => void attempt(() => call('DELETE', `/api/tokens/${id}`)).then(refresh)
  return { tokens, revoke, refresh }
}

/**
 * Apps signed in as you (Binders for Mac), each with a token of its own: signing one out stops that app. Each names
 * the binder it's registered to: it opens every binder you're in, but acts on GitHub through that binder's app.
 */
function Apps({ tokens: { tokens, revoke } }: { tokens: Tokens }) {
  if (!tokens) return null
  const apps = tokens.filter((t) => t.kind !== 'mcp')
  return (
    <Section title="Apps signed in as you" lead="Each has a token of its own: signing one out stops it there.">
      {apps.length ? (
        <Rows label="Apps signed in as you">
          {apps.map((t) => (
            <Row key={t.id} icon={<AppWindow size={16} />} title={<span className="row-title">{t.app}{t.binder && <BinderTag name={t.binder.name} />}</span>}
              meta={`Signed in ${ago(t.at)} ago${t.binder ? `, through ${t.binder.personal ? 'your personal binder' : `${t.binder.name}’s GitHub App`}` : ', not through any one binder’s GitHub App'}.`}
              trailing={<button type="button" className="button small" aria-label={`Sign out ${t.app}`} onClick={() => revoke(t.id)}>Sign out</button>} />
          ))}
        </Rows>
      ) : (
        <EmptyState compact icon={<AppWindow size={18} />} title="No apps signed in" line="Binders for Mac signs in to this hub from its Settings, through this browser." />
      )}
    </Section>
  )
}

/**
 * MCP clients connected as you (a terminal, an editor), each signed in through OAuth in the browser: no token to copy,
 * and an agent's token being replaced doesn't touch them. Disconnecting one makes the client sign in again next time.
 * Connecting one is one button, and a guided dialog: Claude Code, another client, or a token for one that can't sign in.
 */
function McpConnections({ tokens: { tokens, revoke, refresh } }: { tokens: Tokens }) {
  const [connecting, setConnecting] = useState(false)
  const [made, setMade] = useState<string>()
  const me = useStore().state.me
  if (!tokens || !me) return null
  const here = me.spaces.find((s) => s.id === me.space)
  const mcp = tokens.filter((t) => t.kind === 'mcp')
  const thisBinder = me.space ? new URL(`/${me.space}/mcp`, window.location.origin).toString() : undefined
  // A client that can't sign in with OAuth gets a token of its own, shown once, as a person's: not an agent's pad.
  const create = () => void attempt(() => call<{ token: string }>('POST', '/api/tokens', { app: 'A terminal' })).then((r) => {
    if (!r) return
    setConnecting(false)
    setMade(r.token)
    refresh()
  })
  // The hub's address for MCP, as the Claude Code dialog finds it when the hub hasn't said.
  const mcpUrl = me.mcpUrl ?? new URL('/mcp', window.location.origin).toString()
  const command = claudeCodeCommand(mcpUrl)
  return (
    <>
    <Section title="MCP connections" lead="Terminals and editors connected as you." action={<button type="button" className="button small" onClick={() => setConnecting(true)}><Plug size={14} aria-hidden="true" />Connect a client</button>}>
      {mcp.length ? (
        <Rows label="MCP connections">
          {mcp.map((t) => (
            <Row key={t.id} icon={<SquareTerminal size={16} />} title={<span className="row-title">{t.app}{(t.binders ?? (t.binder ? [t.binder] : [])).map((b) => <BinderTag key={b.id} name={b.name} />)}</span>}
              meta={`Connected ${ago(t.at)} ago${t.binders ? `, to ${t.binders.length} binders` : t.binder ? `, to ${t.binder.name}` : ''}${t.expiresAt ? '. Its token renews itself until you stop it here' : ''}.`}
              trailing={<button type="button" className="button small" aria-label={`Disconnect ${t.app}`} onClick={() => revoke(t.id)}>Disconnect</button>} />
          ))}
        </Rows>
      ) : (
        <EmptyState compact icon={<SquareTerminal size={18} />} title="No clients connected"
          line={<>Connect a client and it signs in through the browser. <SettingsLink section="status" /> has the address for another MCP client.</>} />
      )}
    </Section>
      <AnimatePresence>
        {connecting && (
          <Guided key="connect" title="Connect a client" question="Which client?" onClose={() => setConnecting(false)}
            options={[
              { id: 'claude', icon: <SquareTerminal size={18} />, name: 'Claude Code', line: 'One command to paste. It signs in through the browser.', recommended: true },
              { id: 'other', icon: <Link2 size={18} />, name: 'Another MCP client', line: 'Give it the hub’s address. It signs in through the browser.' },
              { id: 'token', icon: <KeyRound size={18} />, name: 'A client that can’t sign in', line: 'A token of your own, for its MCP config.', disabled: !here },
            ]}
            steps={(id) => id === 'claude'
              ? [{
                title: 'Paste this in a terminal',
                content: (
                  <div className="connect-step">
                    <pre className="mono connect-command">{command}</pre>
                    <p>Then in Claude Code, type <code>/mcp</code>, pick {claudeCodeName} and sign in. A browser opens on the hub: tick the binders it may work in and allow it. It works in every folder, as you.</p>
                  </div>
                ),
                footer: (nav) => <><CopyButton value={command} label="the command" small={false} /><button type="button" className="button primary" onClick={nav.close}>Done</button></>,
              }]
              : id === 'other'
                ? [{
                  title: 'Give it this address',
                  lead: 'It signs in through the browser, where you pick the binders it may work in.',
                  content: (
                    <div className="connect-step">
                      <div className="value-box"><span className="mono">{mcpUrl}</span><CopyButton value={mcpUrl} label="the address" /></div>
                      {thisBinder && here && <p>For {here.name} alone: <span className="mono">{thisBinder}</span></p>}
                    </div>
                  ),
                  footer: (nav) => <button type="button" className="button primary" onClick={nav.close}>Done</button>,
                }]
                : [{
                  title: 'Create a token',
                  lead: 'For a client that can’t sign in with OAuth: put it in its MCP config as a Bearer token.',
                  content: <p className="connect-step-line">{here ? `It’s for ${here.name} only, and lasts` : 'It lasts'} until you disconnect it here. It’s shown once.</p>,
                  footer: (nav) => <><button type="button" className="button" onClick={nav.close}>Cancel</button><button type="button" className="button primary" onClick={create}>Create a token</button></>,
                }]} />
        )}
        {made && <TokenShown key="token" token={made} onClose={() => setMade(undefined)} />}
      </AnimatePresence>
    </>
  )
}

/** A token made here, shown once and only closed from its button: copied into an MCP config that can't sign in through the browser. */
function TokenShown({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <Dialog title="Your token" onClose={onClose} closeOnlyFromButton size="medium"
      footer={<><CopyButton value={token} label="the token" small={false} /><button type="button" className="button primary" onClick={onClose}>I’ve copied it</button></>}>
      <div className="token-shown">
        <p className="setup-warning" role="note"><TriangleAlert size={15} aria-hidden="true" /><span>Shown once. Copy it now: it can’t be shown again.</span></p>
        <pre className="mono token-shown-value">{token}</pre>
        <p className="token-shown-line">In the MCP config, as <span className="mono">Authorization: Bearer …</span>. It shows under MCP connections, and disconnecting it there stops this token.</p>
      </div>
    </Dialog>
  )
}
