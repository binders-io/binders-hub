import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'
import { z } from 'zod'
import { viewParts, type ViewPart } from '../../../../shared/view.ts'

// What json-render is told a view can be made of: the parts in shared/view.ts, each with the shape of its props and the
// words a model is given for it, and the one thing a press can do, which is to ask the Brain another question. The list
// itself lives in shared/ so the hub and this page can never disagree about it.

type Parts = { [K in ViewPart]: { props: (typeof viewParts)[K]['props']; slots: string[]; description: string } }

const components = Object.fromEntries(
  (Object.keys(viewParts) as ViewPart[]).map((name) => [name, { props: viewParts[name].props, slots: viewParts[name].holds ? ['default'] : [], description: viewParts[name].says }]),
) as Parts

export const catalog = defineCatalog(schema, {
  components,
  actions: {
    ask: { params: z.object({ question: z.string() }), description: 'Asks the Brain a follow-up question, as if it had been typed in the box.' },
  },
})
