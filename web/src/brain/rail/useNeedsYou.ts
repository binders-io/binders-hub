import { forAttention } from '../../../../shared/waiting.ts'
import { useWaiting } from '../../data/notify'
import { useUI } from '../../ui'

/** What waits on this person or on anyone in the binder, in the binder they're looking at: the rows Home lists, less those on others. */
export function useNeedsYou() {
  const { binder } = useUI()
  return forAttention(useWaiting(binder))
}
