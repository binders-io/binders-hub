import { useEffect, useState } from 'react'
import { AppWindow, LogOut } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { PersonAvatar, ago } from '../components/bits'
import { attempt } from '../components/Toast'
import { YourGitHub } from '../components/YourGitHub'
import { BinderTag } from '../components/BinderTag'

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
        <YourGitHub />
        <Apps />
      </div>
    </div>
  )
}

/** binder: the one it's registered to, whose GitHub App it signed in through; none when it signed in without one. */
interface AppToken { id: string; app: string; at: string; binder?: { id: string; name: string; personal: boolean } }

/**
 * Apps signed in as you (Binders for Mac), each with a token of its own: stopping one signs that app out. Each names
 * the binder it's registered to: it opens every binder you're in, but acts on GitHub through that binder's app.
 */
function Apps() {
  const [tokens, setTokens] = useState<AppToken[]>()
  const refresh = () => void call<{ tokens: AppToken[] }>('GET', '/api/tokens').then((r) => setTokens(r.tokens)).catch(() => {})
  useEffect(refresh, [])
  const revoke = (id: string) => void attempt(() => call('DELETE', `/api/tokens/${id}`)).then(refresh)
  if (!tokens) return null
  return (
    <section className="app-tokens">
      <h3>Apps signed in as you</h3>
      {tokens.length ? (
        <ul className="status-list">
          {tokens.map((t) => (
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
