// Settings' sections, in the two groups the sidebar shows them in. Light on purpose: a link to a section from anywhere
// in the app (`SettingsLink`) reads its name from here without pulling in the screen.

export type SectionId = 'general' | 'people' | 'github' | 'flow' | 'listeners' | 'jira' | 'history' | 'access' | 'hubbinders' | 'brain' | 'agents' | 'status'
export type GroupId = 'binder' | 'hub'

export interface Section {
  id: SectionId
  label: string
  group: GroupId
  /** The one line under the section's name. */
  detail: string
  /** The rest of what it's for, behind "How this works" under that line, for whoever wants it. */
  more?: string
  /** Only for the hub's admins: others don't see it listed, and its address takes them to General. */
  hubAdmin?: true
}

export const sections: Section[] = [
  { id: 'general', group: 'binder', label: 'General', detail: 'Its name and address, a copy of it, and leaving it.' },
  { id: 'people', group: 'binder', label: 'People', detail: 'Who’s in it, and what each of them may do.' },
  { id: 'github', group: 'binder', label: 'GitHub', detail: 'Its own GitHub App, and the repos its cards, notes and agents use. No other binder uses its app or sees its repos.' },
  { id: 'flow', group: 'binder', label: 'How work flows', detail: 'What goes to GitHub as work happens, and what runs by itself.' },
  { id: 'listeners', group: 'binder', label: 'Listeners', detail: 'What comes into this binder from outside it: an address another tool posts to, a feed the hub reads, or issues opened on GitHub.' },
  { id: 'jira', group: 'binder', label: 'Jira', detail: 'Mirrors this binder’s cards into one Jira Cloud project.', more: 'A card becomes an issue, and its stage the issue’s status. What people do there comes back: a status they change moves the card, and a comment lands on it. The hub keeps the words; Jira’s copy is written, never read back.' },
  { id: 'history', group: 'binder', label: 'History', detail: 'What happened here, and what was deleted in the last 30 days.' },
  { id: 'access', group: 'hub', label: 'Who gets in', detail: 'Who may sign in to this hub, and who runs it.' },
  { id: 'hubbinders', group: 'hub', hubAdmin: true, label: 'Binders', detail: 'Every binder on this hub, and who owns it.' },
  { id: 'brain', group: 'hub', label: 'Brain', detail: 'The models the hub sums up, answers and talks with.' },
  { id: 'agents', group: 'hub', label: 'Agents', detail: 'How change sets merge, and who agents commit as.' },
  { id: 'status', group: 'hub', label: 'Status', detail: 'How the hub is doing, and the addresses clients use to reach it.' },
]

export const groups: { id: GroupId; title: string }[] = [
  { id: 'binder', title: 'This binder' },
  { id: 'hub', title: 'This hub' },
]

/** What a group's sections are the same for: the binder you're in, or every binder on the hub. */
export const hubGroupLine = 'The same for every binder here'

export const isSection = (id: string | undefined): id is SectionId => sections.some((s) => s.id === id)

export const sectionHref = (id: SectionId) => `#/settings/${id}`

const storageKey = 'binders-settings-part'

/** Where a section went, for a browser that remembers one from before there were these. */
const movedTo: Record<string, SectionId> = { binder: 'general', binders: 'general', hub: 'access', briefs: 'github', sync: 'status' }

/** The section this browser last had open, else General. */
export function rememberedSection(): SectionId {
  try {
    const stored = window.localStorage.getItem(storageKey) ?? ''
    const id = movedTo[stored] ?? stored
    return isSection(id) ? id : 'general'
  } catch {
    return 'general'
  }
}

export function rememberSection(id: SectionId) {
  try { window.localStorage.setItem(storageKey, id) } catch { /* only a convenience */ }
}
