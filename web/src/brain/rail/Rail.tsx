import type { ComponentType } from 'react'
import { AgentsNow } from './AgentsNow'
import { CameIn } from './CameIn'
import { NeedsYou } from './NeedsYou'

// The Brain's right rail, "Now": a stack of sections, each in its own file in this folder and each one entry in this
// list. "Came in" is what arrived from outside through the Binder's listeners; a later section is one more entry here and one more file.
const sections: { id: string; Section: ComponentType }[] = [
  { id: 'needs', Section: NeedsYou },
  { id: 'agents', Section: AgentsNow },
  { id: 'came', Section: CameIn },
]

export function Rail() {
  return (
    <div className="brain-rail-sections">
      {sections.map(({ id, Section }) => <Section key={id} />)}
    </div>
  )
}
