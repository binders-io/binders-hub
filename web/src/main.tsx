import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './app.css'
import App from './App.tsx'
import { StoreProvider } from './data/store.tsx'
import { space, spaceHref } from './data/space'
import type { Me } from './data/model'
import { NoBinder } from './screens/NoBinder.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

/**
 * Which Binder to show. On the hub's bare address: the person's first, by going to its address; what this browser
 * kept from before a hub held several Binders goes with it. A Binder they're not in: the ones they are.
 */
async function start() {
  const response = await fetch('/api/me', { headers: { accept: 'application/json', ...(space ? { 'x-binders-space': space } : {}) } }).catch(() => undefined)
  const me = response?.ok ? ((await response.json()) as Me) : undefined
  if (me && !space && me.space) {
    adopt(me.space)
    window.location.replace(spaceHref(me.space))
    return
  }
  const root = createRoot(document.getElementById('root')!)
  if (me && (!me.space || (space && me.space !== space))) {
    root.render(<StrictMode><NoBinder me={me} /></StrictMode>)
    return
  }
  root.render(
    <StrictMode>
      <ErrorBoundary whole>
        <StoreProvider>
          <App />
        </StoreProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

/** This browser's cache and waiting changes from before Binders had addresses, now the first Binder's. */
function adopt(id: string) {
  try {
    const storage = window.localStorage
    const cache = storage.getItem('binders-hub-cache-v3')
    if (cache && !storage.getItem(`binders-hub-cache-v3:${id}`)) storage.setItem(`binders-hub-cache-v3:${id}`, cache)
    storage.removeItem('binders-hub-cache-v3')
    for (const key of Object.keys(storage)) {
      const client = /^binders-hub-outbox-v3:([0-9a-f]{24})$/.exec(key)?.[1]
      if (!client) continue
      storage.setItem(`binders-hub-outbox-v3:${id}:${client}`, storage.getItem(key)!)
      storage.removeItem(key)
    }
  } catch {
    // Blocked storage: nothing kept to carry over.
  }
}

void start()
