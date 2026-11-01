import DOMPurify from 'dompurify'

// A diagram as nodes to put in the page, with anything that could run taken out. A diagram's source is in a note, which
// anyone in the Binder or any of its agents can write, and what Mermaid makes of it goes straight into the page. Mermaid
// sanitizes it too, with securityLevel strict (blocks.ts); this holds if that's ever changed or got past.
//
// Loaded with Mermaid, which brings DOMPurify anyway. The settings are Mermaid's own: without them DOMPurify takes out
// foreignObject, which is where a flowchart's labels are, so diagrams would draw with no words in them.

export const safeSvg = (svg: string) => DOMPurify.sanitize(svg, {
  ADD_TAGS: ['foreignobject'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  RETURN_DOM_FRAGMENT: true,
})
