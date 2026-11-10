// Settings' sections, in the two groups the sidebar shows them in. Light on purpose: a link to a section from anywhere
// in the app (`SettingsLink`) reads its name from here without pulling in the screen.

export type SectionId = 'general' | 'people' | 'github' | 'flow' | 'jira' | 'history' | 'access' | 'brain' | 'agents' | 'status'
export type GroupId = 'binder' | 'hub'

export interface Section {
  id: SectionId
  label: string
  group: GroupId
  /** The line under the section's name. */
  detail: string
}

export const sections: Section[] = [
  { id: 'general', group: 'binder', label: 'General', detail: 'Its name and address. Leave it, or take it off the hub.' },
  { id: 'people', group: 'binder', label: 'People', detail: 'Who’s in it, and who runs it.' },
  { id: 'github', group: 'binder', label: 'GitHub', detail: 'This binder’s own GitHub App and the repos it’s installed on, the repo its cards and notes go to, and the repos its agents work in. No other binder uses its app or sees its repos.' },
  { id: 'flow', group: 'binder', label: 'How work flows', detail: 'What goes to GitHub as work happens, and what runs by itself.' },
  { id: 'jira', group: 'binder', label: 'Jira', detail: 'Mirrors this binder’s cards into one Jira Cloud project: a card becomes an issue, its stage the issue’s status, and what people do there comes back: a status they change moves the card, a comment lands on it. The hub keeps the words; Jira’s copy is written, never read back.' },
  { id: 'history', group: 'binder', label: 'History', detail: 'What people and agents did here that others may want to know of later, and what was deleted, which can be put back for 30 days.' },
  { id: 'access', group: 'hub', label: 'Who gets in', detail: 'Who may sign in to this hub, and who runs it.' },
  { id: 'brain', group: 'hub', label: 'Brain', detail: 'The models the hub sums up, answers and talks with, the same for every binder on this hub.' },
  { id: 'agents', group: 'hub', label: 'Agents', detail: 'How change sets merge, and who agents commit as.' },
  { id: 'status', group: 'hub', label: 'Status', detail: 'How the hub is doing, and the addresses other clients use to reach it.' },
]

export const groups: { id: GroupId; title: string }[] = [
  { id: 'binder', title: 'This binder' },
  { id: 'hub', title: 'This hub' },
]

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
