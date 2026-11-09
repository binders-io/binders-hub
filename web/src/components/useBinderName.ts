import { useHub } from '../data/store'
import { space } from '../data/space'

/** The name of the binder you're in, as the switcher shows it. */
export function useBinderName() {
  const me = useHub((hub) => hub.me)
  return me?.spaces?.find((s) => s.id === (me.space ?? space))?.name ?? 'Binders'
}
