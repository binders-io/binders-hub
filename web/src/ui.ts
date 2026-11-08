import { createContext, useContext } from 'react'

// What the app around a screen offers it. Apart from App.tsx, so a screen loaded on its own doesn't reach back for it.

export interface UI {
  openItem: (id: string) => void
  openPalette: () => void
  /** Opens the dialog that splits a card for a swarm of agents. */
  splitCard?: (id: string) => void
  /** Opens the dialog with the command that adds the hub to Claude Code. */
  connectClaudeCode?: () => void
  /** The binder the app shows, or 'all'. */
  binder: string
  setBinder: (id: string) => void
}

export const UIContext = createContext<UI>({ openItem: () => {}, openPalette: () => {}, binder: 'all', setBinder: () => {} })

export const useUI = () => useContext(UIContext)
