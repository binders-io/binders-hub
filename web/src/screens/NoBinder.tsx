import { useEffect } from 'react'
import { ChevronRight, LogOut } from 'lucide-react'
import type { Me } from '../data/model'
import { space, spaceHref } from '../data/space'
import { SignInFrame } from './SignIn'

/**
 * Signed in, but this isn't a Binder you're in: the ones you are, or who to ask. Drawn before the app is, so it takes
 * the look this browser was last given (black on white or white on black) itself.
 */
export function NoBinder({ me }: { me: Me }) {
  useEffect(() => {
    try {
      const theme = window.localStorage.getItem('binders-hub-theme')
      if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
    } catch {
      // The system's look, then.
    }
  }, [])
  const signOut = async () => {
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-binders': '1' } }).catch(() => undefined)
    window.location.replace('/')
  }
  const none = !me.spaces.length
  // With nowhere to go, signing out is the one thing to do, so it's the button; otherwise it's at the foot.
  const signedInAs = <>Signed in as <b>{me.user.login}</b>{!none && <> · <button type="button" className="text-button" onClick={() => void signOut()}><LogOut size={13} aria-hidden="true" />Sign out</button></>}</>
  return (
    <SignInFrame title={space ? `Not in /${space}` : 'No binder yet'} foot={signedInAs}
      line={!none
        ? (space ? 'You’re not a member of that binder, or there’s none at that address. Yours:' : 'Pick one of yours:')
        : 'No binder on this hub has you as a member yet. Ask its owner to add you.'}>
      {none && <button type="button" className="button big" onClick={() => void signOut()}><LogOut size={16} aria-hidden="true" />Sign out</button>}
      {!none && (
        <ul className="sign-in-binders" aria-label="Your binders">
          {me.spaces.map((s) => (
            <li key={s.id}>
              <a href={spaceHref(s.id, '')}>
                <span className="sign-in-binder-mark" aria-hidden="true">{s.name.charAt(0).toUpperCase()}</span>
                <span className="sign-in-binder-text"><b>{s.name}</b><span className="mono">/{s.id}</span></span>
                <ChevronRight size={16} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </SignInFrame>
  )
}
