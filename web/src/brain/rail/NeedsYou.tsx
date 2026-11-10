import { heard } from '../../data/sync'
import { useHub } from '../../data/store'
import { useNeedsYou } from './useNeedsYou'
import { WaitingItems } from '../../components/Waiting'
import { RailSection } from './RailSection'

/** The rail's first part: what needs you, oldest first within yours, and each row opens the thing it's about. */
export function NeedsYou() {
  const rows = useNeedsYou()
  // Until the hub has answered once, an empty list means nothing has arrived yet.
  const loaded = useHub((state) => heard(state.sync))
  return (
    <RailSection id="needs" title="Needs you" count={rows.length} alert>
      {rows.length ? <WaitingItems rows={rows} compact /> : <p className="faint brain-rail-none">{loaded ? 'Nothing needs you.' : 'Loading…'}</p>}
    </RailSection>
  )
}
