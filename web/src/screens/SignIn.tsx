import { signInHref } from '../data/space'
import { useEffect, useState, type FormEvent } from 'react'
import { RotateCw } from 'lucide-react'
import { Github } from '../components/Github'
import { Logo } from '../components/Logo'
import { useStore } from '../data/store'
import { attempt } from '../components/Toast'

/** Signing in: with GitHub, or, on a hub run on this machine with no GitHub app, with a name. */
export function SignIn() {
  const store = useStore()
  if (store.state.unreachable) return <Unreachable />
  return <Options />
}

/** The hub gave no answer, which isn't the same as being signed out: nothing to sign in to until it does. */
function Unreachable() {
  const store = useStore()
  const [trying, setTrying] = useState(false)
  const again = async () => {
    setTrying(true)
    await store.reconnect()
    setTrying(false)
  }
  return (
    <div className="sign-in">
      <div className="sign-in-card">
        <Logo size={56} />
        <h1>Binders</h1>
        <p role="alert">Couldn’t reach the hub.</p>
        <button type="button" className="button primary big" disabled={trying} onClick={() => void again()}><RotateCw size={15} className={trying ? 'spin' : undefined} /> {trying ? 'Trying…' : 'Try again'}</button>
      </div>
    </div>
  )
}

function Options() {
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
