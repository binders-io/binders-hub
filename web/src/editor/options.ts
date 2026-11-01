import { Facet } from '@codemirror/state'

/** Show Markdown: the markup stays visible on every line, not only the ones being edited. */
export const showMarkdown = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/** What the editor needs from the app around it: the notes [[links]] can reach, and what to do when one is followed. */
export interface LinkHost {
  titles: () => string[]
  exists: (title: string) => boolean
  open: (title: string) => void
}

export const linkHost = Facet.define<LinkHost, LinkHost | undefined>({ combine: (values) => values[values.length - 1] })
