import { useEffect, useState } from 'react'
import { Check, Minus, X } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { Github } from './Github'
import { connectHref } from '../data/space'
import { isPersonal } from './PersonalRepo'
import { BinderTag } from './BinderTag'

interface Project { id: string; name: string; repo?: string; access?: 'push' | 'read' | 'none' | 'unknown'; issues: boolean; notes: boolean; notesBranch: string }
interface Link { login: string; connected: boolean; expiresAt?: string; renewsUntil?: string; projects: Project[] }

/** Connecting from here comes back here, to your account page, rather than to the binder's Settings. */
const connectHere = `${connectHref}&back=account`

const accessLabel: Record<NonNullable<Project['access']>, string> = { push: 'You can push', read: 'Read only', none: 'No access', unknown: 'GitHub didn’t say' }

/**
 * Your GitHub, as two separate connections, each for one thing. This binder's GitHub App: for work in its repos, done as
 * you (approving, merging, an agent pushing as you); it reaches only where this binder's app is installed, and only its
 * organization's members can connect, as the app is private. Your own GitHub, through the hub's OAuth App: for your
 * personal binder's notes repo in your own account, and nothing else. Signing in to the hub is neither: it only says
 * who you are. Each row names the binder it's registered to, as your account page is the same from every binder.
 */
export function YourGitHub() {
  const store = useStore()
  const { state } = store
  const [link, setLink] = useState<Link>()
  const [own, setOwn] = useState(state.me?.ownGitHub)
  useEffect(() => { void call<Link>('GET', '/api/github/me').then(setLink).catch(() => {}) }, [state.binders])
  useEffect(() => { setOwn(state.me?.ownGitHub) }, [state.me?.ownGitHub])
  const until = (at?: string) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : undefined)
  const hasApp = !!state.me?.github.app
  const login = state.me?.user.login ?? ''
  // The binder you're in now, whose GitHub App these connections go through: each is registered to it alone.
  const binder = state.me?.spaces.find((s) => s.id === state.me?.space)?.name ?? 'This binder'
  return (
    <section className="app-tokens your-github">
      <h3>Your GitHub</h3>
      <p className="faint">Signing in only tells the hub who you are. Each of these is a separate permission, for one thing.</p>
      {hasApp && link && (
        <div className="settings-card me-row">
          <Github size={20} />
          <div>
            <span className="row-title"><b>For work in this binder’s repos{link.connected ? ` · connected as @${link.login}` : ''}</b><BinderTag name={binder} /></span>
            <span className="faint">
              {!link.connected ? 'Through this binder’s GitHub App, so approving, merging and agents pushing as you happen on GitHub as you. Only its organization’s members can connect.'
                : link.renewsUntil ? `Through this binder’s GitHub App, renewed by the hub as it runs out, until ${until(link.renewsUntil)}.`
                : link.expiresAt ? `Through this binder’s GitHub App, good until ${new Date(link.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}; connect again after.`
                : 'Through this binder’s GitHub App.'}
            </span>
          </div>
          {!link.connected
            ? <a className="button primary" href={connectHere}><Github size={14} /> Connect</a>
            : <a className="button" href={connectHere} title="Sign in to GitHub as the other account first (an Enterprise Managed User's, say): GitHub connects whichever account you're signed in as there.">Use another GitHub account</a>}
        </div>
      )}
      {isPersonal && own?.possible && (
        <div className="settings-card me-row">
          <Github size={20} />
          <div>
            <span className="row-title"><b>For your personal binder{own.connected ? ' · connected' : ''}</b><BinderTag name={binder} /></span>
            <span className="faint">{own.connected ? `Your own GitHub, through the hub’s OAuth App: it keeps your personal binder’s notes in ${login}/binders-notes, in your account, and is used for nothing else.` : 'Your own GitHub, through the hub’s OAuth App, so your personal binder’s notes are kept in a private repo in your own account. Used for nothing else.'}</span>
          </div>
          {own.connected
            ? <button className="button" onClick={() => void call('DELETE', '/api/me/personal-github').then(() => setOwn({ ...own, connected: false }))}>Disconnect</button>
            : <a className="button" href="/auth/github?personal=1&back=account">Connect</a>}
        </div>
      )}
      {hasApp && link && link.projects.length > 0 && (
        <ul className="status-list">
          {link.projects.map((p) => (
            <li key={p.id} className={p.access === 'push' ? 'ok' : ''}>
              <span className="status-icon">{p.access === 'push' ? <Check size={13} strokeWidth={3} /> : p.repo ? <X size={13} strokeWidth={3} /> : <Minus size={13} strokeWidth={3} />}</span>
              <div>
                <span className="row-title"><b>{p.name}</b>{p.name !== binder && <BinderTag name={binder} />}</span>
                <span>{p.repo ? <><span className="mono">{p.repo}</span> · {accessLabel[p.access ?? 'unknown']}{p.issues ? ' · cards as issues' : ''}{p.notes ? <> · notes on <span className="mono">{p.notesBranch}</span></> : ''}</> : 'No repo linked.'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
