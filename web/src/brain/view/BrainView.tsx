import { Component, useEffect, useRef, type ReactNode } from 'react'
import { JSONUIProvider, Renderer } from '@json-render/react'
import { readView } from '../../../../shared/view.ts'
import { registry } from './registry'
import './view.css'

// What the Brain shows beside its words: a view (shared/view.ts), drawn part by part. The hub has already checked it, and
// it's checked again here, since it may have come from anywhere. If anything in it can't be drawn, the words around it
// stand on their own: a view is never worth breaking the page for.

class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('A view couldn’t be drawn:', error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export function BrainView({ view, onAsk }: { view: unknown; onAsk?: (question: string) => void }) {
  // The provider keeps the handlers it was first given, so the handler reads the latest onAsk from here.
  const asker = useRef(onAsk)
  useEffect(() => {
    asker.current = onAsk
  })
  const read = readView(view)
  if (!read) return null
  return (
    <div className="brain-view">
      <Quiet>
        <JSONUIProvider registry={registry} handlers={{ ask: (params) => (typeof params.question === 'string' && params.question ? asker.current?.(params.question) : undefined) }}>
          <Renderer spec={read} registry={registry} fallback={() => null} />
        </JSONUIProvider>
      </Quiet>
    </div>
  )
}

export default BrainView
