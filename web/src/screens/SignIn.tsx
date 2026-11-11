import { signInHref } from '../data/space'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, RotateCw, WifiOff } from 'lucide-react'
import { Github } from '../components/Github'
import { Logo } from '../components/Logo'
import { Skeleton } from '../kit'
import { useStore } from '../data/store'
import { attempt } from '../components/Toast'

/** Signing in: with GitHub, or, on a hub run on this machine with no GitHub app, with a name. */
export function SignIn() {
  const store = useStore()
  if (store.state.unreachable) return <Unreachable />
  return <Options />
}

/**
 * The page every way in is drawn on: the mark, the name, one line, and what to do, in the middle of the screen, with
 * which hub this is at its foot.
 */
export function SignInFrame({ title, line, children, foot }: { title: ReactNode; line?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="sign-in">
      <main className="sign-in-card">
        <Logo size={56} />
        <div className="sign-in-words">
          <h1>{title}</h1>
          {line && <p className="sign-in-line">{line}</p>}
        </div>
        <div className="sign-in-actions">{children}</div>
      </main>
      <footer className="sign-in-foot">{foot ?? window.location.host}</footer>
    </div>
  )
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
    <SignInFrame title="Binders" line={<span className="sign-in-problem" role="alert"><WifiOff size={15} aria-hidden="true" />Couldn’t reach the hub.</span>}>
      <button type="button" className="button primary big" disabled={trying} onClick={() => void again()}><RotateCw size={16} className={trying ? 'spin' : undefined} aria-hidden="true" /> {trying ? 'Trying…' : 'Try again'}</button>
    </SignInFrame>
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
    <SignInFrame title="Binders" line="Notes become work, agents do it, and you ship it.">
      {!options && (
        <div className="sign-in-waiting" aria-busy="true">
          <Skeleton height={44} />
          <span className="sr-only" role="status">Reaching the hub…</span>
        </div>
      )}
      {options?.github && (
        <a className="button primary big" href={signInHref}><Github size={18} /> Sign in with GitHub</a>
      )}
      {options?.dev && (
        <form className="sign-in-dev" onSubmit={byName}>
          {options.github
            ? <div className="sign-in-or" aria-hidden="true"><span>or, on this machine</span></div>
            : <p className="sign-in-note">This hub has no GitHub app, so sign in with a name.</p>}
          <label htmlFor="dev-name" className="sr-only">{options.github ? 'Or, on this machine, by name' : 'Your name'}</label>
          <div className="sign-in-name">
            <input id="dev-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="your-name" autoComplete="username" autoCapitalize="none" spellCheck={false} />
            <button className={`button${options.github ? '' : ' primary'}`} disabled={!name.trim()}>Sign in<ArrowRight size={15} aria-hidden="true" /></button>
          </div>
        </form>
      )}
      {options && !options.github && !options.dev && <p className="sign-in-note">This hub has no way to sign in yet: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on it.</p>}
    </SignInFrame>
  )
}
