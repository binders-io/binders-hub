import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import { Github } from './Github'
import { call } from '../data/api'
import { space } from '../data/space'
import { sectionHref } from '../screens/settings/sections'

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
  if (status.repo) {
    return (
      <p className="personal-synced"><Lock size={13} aria-hidden="true" /> Your personal binder. Its notes sync to <a href={`https://github.com/${status.repo}`} target="_blank" rel="noreferrer">{status.repo}</a>.</p>
    )
  }
  // One line of what's left, and the one button that does it.
  const setUp = !status.oauth
  const line = setUp ? `In a private ${status.suggested}, in your own account, for you alone.`
    : making ? `Making ${status.suggested}, private, in your GitHub account…`
      : error ?? (!status.connected ? 'Connect your GitHub account: the hub makes the repo and pushes your notes to it.'
        : 'Sign in with GitHub once more, so the hub can make the repo as you.')
  return (
    <section className="personal-repo" aria-label="Your notes on GitHub">
      <span className="personal-repo-icon" aria-hidden="true"><Github size={18} /></span>
      <div className="personal-repo-text">
        <b>{setUp ? 'Keep your notes in your own GitHub' : `Sync your notes to ${status.suggested}`}</b>
        <p className={error && !setUp ? 'bad' : undefined}>{making && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{line}</p>
      </div>
      {setUp && <a className="button small primary" href={sectionHref('github')}>Set it up</a>}
      {!making && !setUp && !status.connected && !error && <a className="button small primary" href="/auth/github?personal=1">Connect my GitHub</a>}
      {!making && error && <button type="button" className="button small" onClick={() => window.location.reload()}>Try again</button>}
    </section>
  )
}
