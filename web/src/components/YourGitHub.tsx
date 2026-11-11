import { useEffect, useState } from 'react'
import { Check, Minus, X } from 'lucide-react'
import { call } from '../data/api'
import { useStore } from '../data/store'
import { Github } from './Github'
import { connectHref } from '../data/space'
import { isPersonal } from './PersonalRepo'
import { BinderTag } from './BinderTag'
import { Row, Rows, Section, Skeleton, Status } from '../kit'

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
  const icon = (access?: Project['access'], repo?: string) => (access === 'push' ? <Check size={16} strokeWidth={2.5} /> : repo ? <X size={16} strokeWidth={2.5} /> : <Minus size={16} strokeWidth={2.5} />)
  return (
    <Section title="Your GitHub" lead="Signing in only tells the hub who you are. Each of these is a separate permission, for one thing." className="your-github">
      {(hasApp && link) || (isPersonal && own?.possible) ? (
        <Rows label="Your GitHub connections">
          {hasApp && link && (
            <Row icon={<Github size={16} />}
              title={<span className="row-title">For work in this binder’s repos<BinderTag name={binder} /></span>}
              meta={!link.connected ? 'Through this binder’s GitHub App, so approving, merging and agents pushing as you happen on GitHub as you. Only its organization’s members can connect.'
                : link.renewsUntil ? `As @${link.login}, renewed by the hub as it runs out, until ${until(link.renewsUntil)}.`
                : link.expiresAt ? `As @${link.login}, good until ${new Date(link.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}; connect again after.`
                : `As @${link.login}, through this binder’s GitHub App.`}
              status={link.connected ? <Status tone="ok">Connected</Status> : undefined}
              trailing={!link.connected
                ? <a className="button small primary" href={connectHere}><Github size={14} />Connect</a>
                : <a className="button small" href={connectHere} title="Sign in to GitHub as the other account first (an Enterprise Managed User’s, say): GitHub connects whichever account you’re signed in as there.">Use another account</a>} />
          )}
          {isPersonal && own?.possible && (
            <Row icon={<Github size={16} />}
              title={<span className="row-title">For your personal binder<BinderTag name={binder} /></span>}
              meta={own.connected ? `Your own GitHub, through the hub’s OAuth App: it keeps your notes in ${login}/binders-notes, and is used for nothing else.` : 'Your own GitHub, through the hub’s OAuth App, so your notes are kept in a private repo in your own account. Used for nothing else.'}
              status={own.connected ? <Status tone="ok">Connected</Status> : undefined}
              trailing={own.connected
                ? <button type="button" className="button small" onClick={() => void call('DELETE', '/api/me/personal-github').then(() => setOwn({ ...own, connected: false }))}>Disconnect</button>
                : <a className="button small" href="/auth/github?personal=1&back=account">Connect</a>} />
          )}
        </Rows>
      ) : null}
      {hasApp && link && link.projects.length > 0 && (
        <Rows label="What you may do in each repo">
          {link.projects.map((p) => (
            <Row key={p.id} icon={icon(p.access, p.repo)}
              title={<span className="row-title">{p.name}{p.name !== binder && <BinderTag name={binder} />}</span>}
              meta={p.repo ? `${p.repo} · ${accessLabel[p.access ?? 'unknown']}${p.issues ? ' · cards as issues' : ''}${p.notes ? ` · notes on ${p.notesBranch}` : ''}` : 'No repo linked.'} />
          ))}
        </Rows>
      )}
      {hasApp && !link && <div aria-busy="true"><Skeleton lines={2} /></div>}
      {!hasApp && !(isPersonal && own?.possible) && <p className="faint">This binder has no GitHub App to connect to yet.</p>}
    </Section>
  )
}
