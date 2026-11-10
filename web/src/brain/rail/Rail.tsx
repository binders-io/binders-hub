import type { ComponentType } from 'react'
import { AgentsNow } from './AgentsNow'
import { NeedsYou } from './NeedsYou'

// The Brain's right rail, "Now": a stack of sections, each in its own file in this folder and each one entry in this
// list. A later section, such as "Came in" for what arrives from outside, is one more entry here and one more file.
const sections: { id: string; Section: ComponentType }[] = [
  { id: 'needs', Section: NeedsYou },
  { id: 'agents', Section: AgentsNow },
]

export function Rail() {
  return (
    <div className="brain-rail-sections">
      {sections.map(({ id, Section }) => <Section key={id} />)}
    </div>
  )
}
