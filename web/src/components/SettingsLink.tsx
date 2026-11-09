import type { ReactNode } from 'react'
import { sectionHref, sections, type SectionId } from '../screens/settings/sections'

/**
 * A pointer to a section of Settings, as a link to it: "Settings → GitHub" by default, or the words it's given. Where a
 * message says to go to Settings, it's this, so the section is one click away and its name stays right if it's renamed.
 */
export function SettingsLink({ section, children }: { section: SectionId; children?: ReactNode }) {
  const found = sections.find((s) => s.id === section)
  return <a href={sectionHref(section)}>{children ?? `Settings → ${found?.label ?? ''}`}</a>
}
