import { CircleCheck } from 'lucide-react'
import { useFirst } from '../../data/first'
import { heard } from '../../data/sync'
import { useHub } from '../../data/store'
import { useNeedsYou } from './useNeedsYou'
import { WaitingItems } from '../../components/Waiting'
import { EmptyState, Skeleton } from '../../kit'
import { RailSection } from './RailSection'

/** The rail's first part: what needs you, oldest first within yours, and each row opens the thing it's about. */
export function NeedsYou() {
  const rows = useNeedsYou()
  const first = useFirst(rows)
  // Until the hub has answered once, an empty list means nothing has arrived yet.
  const loaded = useHub((state) => heard(state.sync))
  return (
    <RailSection id="needs" title="Needs you" count={rows.length} alert>
      {rows.length ? <WaitingItems rows={rows} compact first={first} />
        : loaded ? <EmptyState compact icon={<CircleCheck size={18} />} title="Nothing needs you." />
        : <div className="brain-rail-loading" role="status" aria-label="Loading"><Skeleton lines={2} /></div>}
    </RailSection>
  )
}
