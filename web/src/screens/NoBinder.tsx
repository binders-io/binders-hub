import { Logo } from '../components/Logo'
import type { Me } from '../data/model'
import { space, spaceHref } from '../data/space'

/** Signed in, but this isn't a Binder you're in: the ones you are, or who to ask. */
export function NoBinder({ me }: { me: Me }) {
  const signOut = async () => {
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-binders': '1' } }).catch(() => undefined)
    window.location.replace('/')
  }
  return (
    <div className="sign-in">
      <div className="sign-in-card">
        <Logo size={56} />
        <h1>{space ? `Not in /${space}` : 'No binder yet'}</h1>
        {me.spaces.length ? (
          <>
            <p>{space ? 'You’re not a member of that binder, or there’s none at that address. Yours:' : 'Pick one of yours:'}</p>
            <ul className="no-binder-list">
              {me.spaces.map((s) => (
                <li key={s.id}><a className="button big" href={spaceHref(s.id, '')}>{s.name} <span className="mono faint">/{s.id}</span></a></li>
              ))}
            </ul>
          </>
        ) : (
          <p>You’re signed in as <b>{me.user.login}</b>, but no binder on this hub has you as a member yet. Ask its owner to add you.</p>
        )}
        <button className="button" onClick={() => void signOut()}>Sign out</button>
      </div>
    </div>
  )
}
