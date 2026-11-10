import { useEffect, useState } from 'react'
import { AppWindow, Check, Copy, LogOut, SquareTerminal } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { useUI } from '../ui'
import { PersonAvatar, ago } from '../components/bits'
import { attempt, toast } from '../components/Toast'
import { YourGitHub } from '../components/YourGitHub'
import { BinderTag } from '../components/BinderTag'
import { NotifySwitch } from '../components/NotifySwitch'
import { SettingsLink } from '../components/SettingsLink'

/**
 * You, wherever you are on the hub: who you're signed in as, your GitHub connections, and the apps signed in as you.
 * Yours, not a binder's, so it has a page of its own, opened from your picture at the top, and isn't in any binder's
 * Settings.
 */
export function Account() {
  const store = useStore()
  const me = store.state.me
  return (
    <div className="account-page">
      <div className="settings-pane">
        <header>
          <h2>Your account</h2>
          <p>Who you’re signed in as, here and in apps. It’s yours, the same in every binder you’re in.</p>
        </header>
        <div className="settings-card me-row">
          {me && <PersonAvatar id={me.user.login} size={44} />}
          <div>
            <b>{me?.user.name}</b>
            <span className="faint">{me?.github.signIn ? `@${me.user.login} on GitHub` : `${me?.user.login}, signed in by name on this machine`}</span>
            {me?.hubAdmin && <span className="admin-tag">Hub admin</span>}
          </div>
          <button className="button" onClick={() => void store.signOut()}><LogOut size={14} /> Sign out</button>
        </div>
        <section className="app-tokens">
          <h3>Notifications</h3>
          <NotifySwitch id="notify-account" explain />
          <p className="faint">When an agent asks you something, or work is ready to approve, and this page isn’t in front, this browser tells you. It’s remembered here only.</p>
        </section>
        <CaptureHome />
        <YourGitHub />
        <Apps />
        <McpConnections />
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
    <section className="app-tokens">
      <h3 id="capture-home-title">Where what your phone and Mac capture goes</h3>
      <label className="field capture-home">
        <span className="field-label">Binder</span>
        <select id="capture-home" aria-labelledby="capture-home-title" value={now.home} onChange={(event) => choose(event.target.value)}>
          {now.binders.map((b) => <option key={b.id} value={b.id}>{b.personal ? 'Your own Binder' : b.name}</option>)}
        </select>
      </label>
      <p className="faint">Conversations, meetings and dictations arrive there as notes, and what they offer to do goes on its board. Your own Binder is yours alone.</p>
    </section>
  )
}

/** binder: the one it's registered to, whose GitHub App it signed in through; none when it signed in without one. */
interface AppToken { id: string; app: string; at: string; binder?: { id: string; name: string; personal: boolean }; binders?: { id: string; name: string }[]; kind?: 'app' | 'mcp'; expiresAt?: string; clientId?: string }

/** The tokens of each kind: an app signed in through the browser, or an MCP client signed in through OAuth. */
function useTokens() {
  const [tokens, setTokens] = useState<AppToken[]>()
  const refresh = () => void call<{ tokens: AppToken[] }>('GET', '/api/tokens').then((r) => setTokens(r.tokens)).catch(() => {})
  useEffect(refresh, [])
  const revoke = (id: string) => void attempt(() => call('DELETE', `/api/tokens/${id}`)).then(refresh)
  return { tokens, revoke, refresh }
}

/**
 * Apps signed in as you (Binders for Mac), each with a token of its own: stopping one signs that app out. Each names
 * the binder it's registered to: it opens every binder you're in, but acts on GitHub through that binder's app.
 */
function Apps() {
  const { tokens, revoke } = useTokens()
  if (!tokens) return null
  const apps = tokens.filter((t) => t.kind !== 'mcp')
  return (
    <section className="app-tokens">
      <h3>Apps signed in as you</h3>
      {apps.length ? (
        <ul className="status-list">
          {apps.map((t) => (
            <li key={t.id} className="ok">
              <span className="status-icon"><AppWindow size={12} /></span>
              <div>
                <span className="row-title"><b>{t.app}</b>{t.binder && <BinderTag name={t.binder.name} />}</span>
                <span>Signed in {ago(t.at)} ago{t.binder ? `, through ${t.binder.personal ? 'your personal binder' : `${t.binder.name}’s GitHub App`}` : ', not through any one binder’s GitHub App'}.</span>
              </div>
              <button className="button" onClick={() => revoke(t.id)}>Sign out</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint">None. Binders for Mac signs in to this hub from its Settings, through this browser.</p>
      )}
    </section>
  )
}

/**
 * MCP clients connected as you (a terminal, an editor), each signed in through OAuth in the browser: no token to copy,
 * and an agent's token being replaced doesn't touch them. Stopping one makes the client sign in again next time.
 */
function McpConnections() {
  const { tokens, revoke, refresh } = useTokens()
  const { connectClaudeCode } = useUI()
  const [made, setMade] = useState<string>()
  const me = useStore().state.me
  if (!tokens || !me) return null
  const here = me.spaces.find((s) => s.id === me.space)
  const mcp = tokens.filter((t) => t.kind === 'mcp')
  // A client that can't sign in with OAuth gets a token of its own, shown once, as a person's: not an agent's pad.
  const create = () => void attempt(() => call<{ token: string }>('POST', '/api/tokens', { app: 'A terminal' })).then((r) => {
    if (!r) return
    setMade(r.token)
    refresh()
  })
  return (
    <section className="app-tokens">
      <h3>MCP connections</h3>
      {mcp.length ? (
        <ul className="status-list">
          {mcp.map((t) => (
            <li key={t.id} className="ok">
              <span className="status-icon"><SquareTerminal size={12} /></span>
              <div>
                <span className="row-title"><b>{t.app}</b>{(t.binders ?? (t.binder ? [t.binder] : [])).map((b) => <BinderTag key={b.id} name={b.name} />)}</span>
                <span>Connected {ago(t.at)} ago{t.binders ? `, to ${t.binders.length} binders` : t.binder ? `, to ${t.binder.name}` : ''}{t.expiresAt ? '. Its token renews itself until you stop it here' : ''}.</span>
              </div>
              <button className="button" onClick={() => revoke(t.id)}>Disconnect</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint">None. Add to Claude Code, below, has the command for Claude Code, and <SettingsLink section="status" /> the address for another MCP client. Either opens a browser to sign in.</p>
      )}
      {connectClaudeCode && (
        <div className="mcp-create">
          <button className="button" onClick={connectClaudeCode}><SquareTerminal size={14} /> Add to Claude Code</button>
          <span className="faint">The command that connects a terminal running Claude Code. It signs in through the browser.</span>
        </div>
      )}
      <div className="mcp-create">
        <button className="button" onClick={create} disabled={!here}>Create a token</button>
        <span className="faint">For a client that can’t sign in with OAuth: put it in the MCP config as a Bearer token. {here ? `It’s for ${here.name} only, and lasts` : 'It lasts'} until you stop it here.</span>
      </div>
      {made && <TokenShown token={made} />}
    </section>
  )
}

/** A token made here, shown once: copied into an MCP config that can't sign in through the browser. */
function TokenShown({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(token).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="copy-row">
      <span className="field-label">Its token, shown once</span>
      <div className="token-value mono">
        <span>{token}</span>
        <button className="icon-button" onClick={() => void copy()} aria-label="Copy the token">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      <span className="field-hint">In the MCP config, as Authorization: Bearer … . The connection shows above, and stopping it stops this token.</span>
    </div>
  )
}
