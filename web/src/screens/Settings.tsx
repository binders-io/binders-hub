import { useEffect, useRef, type ReactNode } from 'react'
import { Bot, Brain, ChevronLeft, ChevronRight, History as HistoryIcon, KeyRound, Plug, Server, SlidersHorizontal, Users, Workflow } from 'lucide-react'
import { space } from '../data/space'
import { useStore } from '../data/store'
import { useRoute } from '../route'
import { BrainPanel } from '../components/BrainPanel'
import { Github } from '../components/Github'
import { HubOptionsPanel } from '../components/HubOptionsPanel'
import { People } from '../components/SpacePanel'
import { usePhone } from '../components/bits'
import { Flow } from './settings/Flow'
import { General } from './settings/General'
import { GitHub } from './settings/GitHub'
import { HistoryPart } from './settings/History'
import { HubStatus } from './settings/HubStatus'
import { JiraPart } from './settings/Jira'
import { groups, isSection, rememberSection, rememberedSection, sectionHref, sections, type GroupId, type SectionId } from './settings/sections'

const icons: Record<SectionId, (props: { size?: number }) => ReactNode> = {
  general: SlidersHorizontal, people: Users, github: Github, flow: Workflow, jira: Plug, history: HistoryIcon, access: KeyRound, brain: Brain, agents: Bot, status: Server,
}

/**
 * Settings, in two groups: this binder's (its name and people, its GitHub, how work flows, Jira, its history) and the whole hub's (who
 * gets in, the brain, agents, status), which are the same for every binder on it. Each section has an address of its own,
 * `#/settings/<section>`; with none, it's the one this browser last had open, and on a phone the list of them. What's yours
 * rather than the binder's (who you're signed in as, your GitHub, your apps) is on your account page.
 */
export function Settings() {
  const { state } = useStore()
  const [route] = useRoute()
  const phone = usePhone()
  const heading = useRef<HTMLHeadingElement>(null)
  const here = route.screen === 'settings'
  const wanted = here && isSection(route.id) ? route.id : undefined
  // On a phone with no section named, the list of them; elsewhere, the one last open.
  const current = wanted ?? (phone ? undefined : rememberedSection())
  useEffect(() => {
    if (wanted) rememberSection(wanted)
    // So Back moves between sections, rather than leaving a bare #/settings that stands for any of them.
    else if (here && current) window.history.replaceState(window.history.state, '', sectionHref(current))
  }, [here, wanted, current])
  // A phone shows one thing at a time, so what comes up is read from its top.
  useEffect(() => { if (phone && wanted) heading.current?.focus({ preventScroll: true }) }, [phone, wanted])

  const github = state.me?.github
  const warn: Partial<Record<SectionId, boolean>> = {
    github: !github?.signIn || !github?.server || state.binders.some((b) => !b.repo),
    status: state.me?.log !== 'redis' || !!state.me?.updateFailed,
  }
  const binderName = state.me?.spaces?.find((s) => s.id === (state.me?.space ?? space))?.name ?? state.binders[0]?.name
  const eyebrow: Record<GroupId, string> = { binder: binderName ? `This binder · ${binderName}` : 'This binder', hub: 'This hub · the same for every binder here' }
  const section = sections.find((s) => s.id === current)

  return (
    <div className={`settings-layout${phone ? ' phone' : ''}${current ? '' : ' index'}`}>
      {!(phone && current) && (
        <nav className="settings-nav" aria-label="Settings">
          {groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`}>
              <p className="settings-group-title" id={`settings-group-${group.id}`}>{group.title}</p>
              {(group.id === 'hub' || binderName) && <p className="settings-group-sub">{group.id === 'binder' ? binderName : 'The same for every binder here'}</p>}
              {sections.filter((s) => s.group === group.id).map((s) => {
                const Icon = icons[s.id]
                return (
                  <a key={s.id} href={sectionHref(s.id)} className={s.id === current ? 'on' : ''} aria-current={s.id === current ? 'page' : undefined}>
                    <Icon size={15} /> {s.label}
                    {warn[s.id] && <><i className="settings-warn" aria-hidden="true" /><span className="sr-only"> Needs a look</span></>}
                    {phone && <ChevronRight size={15} className="settings-chevron" aria-hidden="true" />}
                  </a>
                )
              })}
            </div>
          ))}
        </nav>
      )}
      {section && (
        <div className="settings-pane" key={section.id}>
          {phone && <a className="settings-back" href="#/settings"><ChevronLeft size={15} aria-hidden="true" /> Settings</a>}
          <header>
            <p className="settings-eyebrow">{eyebrow[section.group]}</p>
            <h2 ref={heading} tabIndex={-1}>{section.label}</h2>
            <p>{section.detail}</p>
          </header>
          {section.id === 'general' && <General />}
          {section.id === 'people' && <People />}
          {section.id === 'github' && <GitHub />}
          {section.id === 'flow' && <Flow />}
          {section.id === 'jira' && <JiraPart />}
          {section.id === 'history' && <HistoryPart />}
          {section.id === 'access' && <HubOptionsPanel part="access" />}
          {section.id === 'brain' && <BrainPanel />}
          {section.id === 'agents' && <HubOptionsPanel part="agents" />}
          {section.id === 'status' && <HubStatus />}
        </div>
      )}
    </div>
  )
}
