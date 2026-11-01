import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import { Github } from './Github'
import { call } from '../data/api'
import { signInHref, space } from '../data/space'

// A personal binder's repo: <login>/binders-notes, private, in their own GitHub account, where its notes sync. With the
// hub's OAuth App, they connect their GitHub account once (it asks for access to their repos), and the hub makes the
// repo by itself and pushes to it; without one, the hub's GitHub App has to be on their account instead. Until then,
// this says the one step left.

type Status = { repo?: string; app: boolean; installed: boolean; installUrl?: string; signedIn: boolean; suggested: string; oauth: boolean; connected: boolean }

export const isPersonal = space.startsWith('~')

export function PersonalRepo() {
  const [status, setStatus] = useState<Status>()
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string>()
  const tried = useRef(false)

  useEffect(() => {
    let live = true
    const load = async () => {
      const now = await call<Status>('GET', '/api/personal').catch(() => undefined)
      if (!live || !now) return
      setStatus(now)
      // Everything's there but the repo: make it now, once.
      const ready = now.oauth ? now.connected : now.app && now.installed && now.signedIn
      if (!now.repo && ready && !tried.current) {
        tried.current = true
        setMaking(true)
        try {
          if (live) setStatus(await call<Status>('POST', '/api/personal/repo'))
        } catch (e) {
          if (live) setError((e as Error).message)
        } finally {
          if (live) setMaking(false)
        }
      }
    }
    void load()
    return () => { live = false }
  }, [])

  if (!status) return null
  if (!status.oauth && !status.repo) {
    return (
      <section className="personal-repo">
        <Github size={20} />
        <div>
          <b>Keep your notes in your own GitHub</b>
          <p>Your personal binder is yours alone. Set up your own OAuth App and connect your GitHub, and its notes are kept in a private {status.suggested} in your account.</p>
        </div>
        <a className="button primary" href="#/settings" onClick={() => { try { window.localStorage.setItem('binders-settings-part', 'github') } catch { /* only a convenience */ } }}>Set it up</a>
      </section>
    )
  }
  if (status.repo) {
    return (
      <p className="personal-synced"><Lock size={13} /> Your personal Binder. Its notes sync to <a href={`https://github.com/${status.repo}`} target="_blank" rel="noreferrer">{status.repo}</a>.</p>
    )
  }
  return (
    <section className="personal-repo">
      <Github size={20} />
      <div>
        <b>Sync your notes to {status.suggested}</b>
        {making ? (
          <p><LoaderCircle size={13} className="spin" /> Making {status.suggested}, private, in your GitHub account…</p>
        ) : error ? (
          <p className="bad">{error}</p>
        ) : status.oauth && !status.connected ? (
          <p>Your personal binder is yours alone. To keep its notes in a private repo in your own GitHub account, connect your GitHub account: GitHub asks to let this hub reach your repos, so it can make {status.suggested} and push your notes to it. You come back here and the repo is made.</p>
        ) : !status.oauth && !status.installed ? (
          <p>Your personal binder is yours alone. To keep its notes in a private repo in your GitHub account, install the hub’s GitHub App on your account. You come back here and the repo is made.</p>
        ) : (
          <p>Sign in with GitHub once more, so the hub can make the repo as you.</p>
        )}
      </div>
      {!making && status.oauth && !status.connected && <a className="button primary" href="/auth/github?personal=1">Connect my GitHub account</a>}
      {!making && !status.oauth && !status.installed && status.installUrl && <a className="button primary" href={status.installUrl}>Install on my account</a>}
      {!making && !status.oauth && status.installed && !status.signedIn && <a className="button primary" href={signInHref}>Sign in with GitHub</a>}
      {!making && error && <button type="button" className="button" onClick={() => window.location.reload()}>Try again</button>}
    </section>
  )
}
