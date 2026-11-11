import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Boxes, Brain, ChevronLeft, ChevronRight, History as HistoryIcon, Inbox, KeyRound, Plug, Server, SlidersHorizontal, Users, Workflow } from 'lucide-react'
import { space } from '../data/space'
import { useStore } from '../data/store'
import { useRoute } from '../route'
import { More, PageHeader } from '../kit'
import { BrainPanel } from '../components/BrainPanel'
import { Github } from '../components/Github'
import { HubOptionsPanel } from '../components/HubOptionsPanel'
import { People } from '../components/SpacePanel'
import { usePhone } from '../components/bits'
import { Flow } from './settings/Flow'
import { General } from './settings/General'
import { GitHub } from './settings/GitHub'
import { HistoryPart } from './settings/History'
import { HubBinders } from './settings/HubBinders'
import { HubStatus } from './settings/HubStatus'
import { JiraPart } from './settings/Jira'
import { Listeners } from './settings/Listeners'
import { ActionPlaceProvider, NoOwnerLine } from './settings/shared'
import { groups, hubGroupLine, isSection, rememberSection, rememberedSection, sectionHref, sections, type GroupId, type SectionId } from './settings/sections'

const icons: Record<SectionId, (props: { size?: number }) => ReactNode> = {
  general: SlidersHorizontal, people: Users, github: Github, flow: Workflow, listeners: Inbox, jira: Plug, history: HistoryIcon, access: KeyRound, hubbinders: Boxes, brain: Brain, agents: Bot, status: Server,
}

const titleId = 'settings-title'

/**
 * Settings, in two groups: this binder's (its name and people, its GitHub, how work flows, Jira, its history) and the whole hub's (who
 * gets in, the brain, agents, status), which are the same for every binder on it. Each section has an address of its own,
 * `#/settings/<section>`; with none, it's the one this browser last had open, and on a phone the list of them. Every
 * section starts the same way, with where you are, its name and one line, and its one main action, if it has one, at
 * the right of its name. What's yours rather than the binder's (who you're signed in as, your GitHub, your apps) is on
 * your account page.
 */
export function Settings() {
  const { state } = useStore()
  const [route] = useRoute()
  const phone = usePhone()
  // Where a section's main action goes, once the header is drawn.
  const [place, setPlace] = useState<HTMLElement | null>(null)
  const here = route.screen === 'settings'
  // Sections only the hub's admins have are General to anyone else, once the hub has said who you are.
  const hubAdmin = !!state.me?.hubAdmin
  const barred = (id: string | undefined) => !!state.me && !hubAdmin && !!sections.find((s) => s.id === id)?.hubAdmin
  const named = here && isSection(route.id) ? route.id : undefined
  const wanted = barred(named) ? undefined : named
  const remembered = rememberedSection()
  // On a phone with no section named, the list of them; elsewhere, the one last open.
  const current = barred(named) ? 'general' : wanted ?? (phone ? undefined : barred(remembered) ? 'general' : remembered)
  useEffect(() => {
    if (wanted) rememberSection(wanted)
    // So Back moves between sections, rather than leaving a bare #/settings that stands for any of them.
    else if (here && current) window.history.replaceState(window.history.state, '', sectionHref(current))
  }, [here, wanted, current])
  // A phone shows one thing at a time, so what comes up is read from its top.
  useEffect(() => {
    if (!phone || !wanted) return
    const heading = document.getElementById(titleId)
    if (!heading) return
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }, [phone, wanted])

  const github = state.me?.github
  const warn: Partial<Record<SectionId, boolean>> = {
    github: !github?.signIn || !github?.server || state.binders.some((b) => !b.repo),
    status: state.me?.log !== 'redis' || !!state.me?.updateFailed,
  }
  const binderName = state.me?.spaces?.find((s) => s.id === (state.me?.space ?? space))?.name ?? state.binders[0]?.name
  const where: Record<GroupId, string> = { binder: binderName ? `This binder · ${binderName}` : 'This binder', hub: `This hub · ${hubGroupLine.toLowerCase()}` }
  const section = sections.find((s) => s.id === current)

  return (
    <div className={`settings-layout${phone ? ' phone' : ''}${current ? '' : ' index'}`}>
      {!(phone && current) && (
        <nav className="settings-nav" aria-label="Settings">
          {groups.map((group) => (
            <div key={group.id} className="settings-group" role="group" aria-labelledby={`settings-group-${group.id}`}>
              <div className="settings-group-head">
                <p className="settings-group-title" id={`settings-group-${group.id}`}>{group.title}</p>
                {(group.id === 'hub' || binderName) && <p className="settings-group-sub">{group.id === 'binder' ? binderName : hubGroupLine}</p>}
              </div>
              <div className="settings-group-links">
                {sections.filter((s) => s.group === group.id && (!s.hubAdmin || hubAdmin)).map((s) => {
                  const Icon = icons[s.id]
                  return (
                    <a key={s.id} href={sectionHref(s.id)} className={s.id === current ? 'on' : ''} aria-current={s.id === current ? 'page' : undefined}>
                      <span className="settings-nav-icon" aria-hidden="true"><Icon size={phone ? 16 : 15} /></span>
                      <span className="settings-nav-label">{s.label}</span>
                      {warn[s.id] && <><i className="settings-warn" aria-hidden="true" /><span className="sr-only"> Needs a look</span></>}
                      {phone && <ChevronRight size={16} className="settings-chevron" aria-hidden="true" />}
                    </a>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      )}
      {section && (
        <div className="settings-pane page" key={section.id}>
          <div className="page-column">
            <div className="settings-head">
              {phone && <a className="settings-back" href="#/settings"><ChevronLeft size={18} aria-hidden="true" />Settings</a>}
              <PageHeader id={titleId} eyebrow={where[section.group]} title={section.label} lead={section.detail}
                action={<span ref={setPlace} className="settings-action-place" />} />
              {section.more && <More><p>{section.more}</p></More>}
            </div>
            {section.group === 'binder' && <NoOwnerLine />}
            <ActionPlaceProvider value={{ framed: true, place }}>
              {section.id === 'general' && <General />}
              {section.id === 'people' && <People />}
              {section.id === 'github' && <GitHub />}
              {section.id === 'flow' && <Flow />}
              {section.id === 'listeners' && <Listeners />}
              {section.id === 'jira' && <JiraPart />}
              {section.id === 'history' && <HistoryPart />}
              {section.id === 'access' && <HubOptionsPanel part="access" />}
              {section.id === 'hubbinders' && <HubBinders />}
              {section.id === 'brain' && <BrainPanel />}
              {section.id === 'agents' && <HubOptionsPanel part="agents" />}
              {section.id === 'status' && <HubStatus />}
            </ActionPlaceProvider>
          </div>
        </div>
      )}
    </div>
  )
}
