import { signInHref } from '../data/space'
import { useEffect, useState, type FormEvent } from 'react'
import { Github } from '../components/Github'
import { Logo } from '../components/Logo'
import { useStore } from '../data/store'
import { attempt } from '../components/Toast'

/** Signing in: with GitHub, or, on a hub run on this machine with no GitHub app, with a name. */
export function SignIn() {
  const store = useStore()
  const [options, setOptions] = useState<{ github: boolean; dev: boolean }>()
  const [name, setName] = useState('')

  useEffect(() => {
    fetch('/auth/options').then((r) => r.json()).then(setOptions).catch(() => setOptions({ github: false, dev: false }))
  }, [])

  const byName = async (event: FormEvent) => {
    event.preventDefault()
    await attempt(() => store.signInByName(name))
  }

  return (
    <div className="sign-in">
      <div className="sign-in-card">
        <Logo size={56} />
        <h1>Binders</h1>
        <p>Notes become work, agents do it, and you ship it.</p>
        {options?.github && (
          <a className="button primary big" href={signInHref}><Github size={17} /> Sign in with GitHub</a>
        )}
        {options?.dev && (
          <form className="sign-in-dev" onSubmit={byName}>
            <label htmlFor="dev-name" className="faint">{options.github ? 'Or, on this machine, by name' : 'This hub runs on this machine without a GitHub app. Sign in with a name:'}</label>
            <div>
              <input id="dev-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="your-name" />
              <button className="button" disabled={!name.trim()}>Sign in</button>
            </div>
          </form>
        )}
        {options && !options.github && !options.dev && <p className="faint">This hub has no way to sign in yet: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on it.</p>}
        {!options && <p className="faint">Reaching the hub…</p>}
      </div>
    </div>
  )
}
