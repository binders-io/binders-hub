import { useEffect, useRef, useState } from 'react'

// A Mermaid drawing in a view. It's drawn by the same code that draws diagrams in notes (editor/blocks.ts: the same
// settings, the same strict security level, the same cleaning of what comes out), and Mermaid is loaded only when a view
// has one. Until it's drawn the box keeps some height, so what's below doesn't jump. A source Mermaid can't read is shown
// as written, under its title.

/** Changes when the page's theme does, so a drawing is made again in the new colours. */
function useTheme() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const watch = new MutationObserver(() => setVersion((v) => v + 1))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watch.disconnect()
  }, [])
  return version
}

function Drawn({ title, code }: { title?: string | null; code: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'drawing' | 'drawn' | 'failed'>('drawing')
  const theme = useTheme()
  useEffect(() => {
    let live = true
    import('../../editor/blocks')
      .then(({ draw }) => draw(code))
      .then((drawing) => {
        if (!live) return
        box.current?.replaceChildren(drawing.cloneNode(true))
        setState('drawn')
      })
      .catch(() => {
        if (live) setState('failed')
      })
    return () => {
      live = false
    }
  }, [code, theme])

  if (state === 'failed') {
    return (
      <figure className="view-diagram failed">
        {title ? <figcaption>{title}</figcaption> : null}
        <p className="view-diagram-why">This drawing couldn’t be drawn.</p>
        <pre>{code}</pre>
      </figure>
    )
  }
  return (
    <figure className="view-diagram">
      {title ? <figcaption>{title}</figcaption> : null}
      <div className="view-diagram-body">
        <div ref={box} className={`view-diagram-box${state === 'drawn' ? ' drawn' : ''}`} role="region" tabIndex={0} aria-label={title ? `Diagram: ${title}` : 'Diagram'} aria-busy={state === 'drawing'} />
        {state === 'drawing' ? <p className="view-diagram-wait" aria-live="polite">Drawing…</p> : null}
      </div>
    </figure>
  )
}

/** A new source starts from scratch: nothing of the last drawing is kept for it. */
export const Diagram = ({ title, code }: { title?: string | null; code: string }) => <Drawn key={code} title={title} code={code} />
