import { useHub } from '../data/store'
import { useBinderAccess } from '../screens/settings/access'

/** The names as a sentence says them: @ana, @bo and @cy. */
const listed = (logins: string[]) => {
  const names = logins.map((l) => `@${l}`)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

function Who() {
  const { managers } = useBinderAccess()
  return managers.length ? <span> Ask {listed(managers.map((m) => m.login))}.</span> : null
}

/**
 * The one line at the top of every screen for someone who can read this binder and not change it: it says so once, so
 * what a reader can't do needn't be shown as disabled, and who can let them. Nothing for anyone else.
 */
export function ReaderLine() {
  const reader = useHub((state) => state.me?.role === 'reader')
  if (!reader) return null
  return (
    <p className="reader-line" role="status">
      You can read this binder. Its owners can let you change it.
      <Who />
    </p>
  )
}
