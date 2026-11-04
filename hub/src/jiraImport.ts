import type { Card, Stage } from '../../shared/work.ts'
import { titleOf, type Folder, type Note } from '../../shared/notes.ts'
import type { Change } from '../../shared/state.ts'
import { Refused, type Hub } from './hub.ts'
import { markdownOf, stageOfImported, type JiraConnection, type JiraStory } from './jira.ts'
import type { JiraSaver } from './savers/jira.ts'

// A team's work already in Jira, brought onto the board: a feature becomes a note and its stories cards under it, each
// where it stands. It's the same link as one the hub made, except that what the team wrote stays theirs: the hub doesn't
// write over an imported issue's description, and doesn't make it GitHub issues it never needed. Not started means
// Proposed here, whatever Jira calls it: agents take anything in Ready at once, and nobody has said this work is theirs.

const folderName = 'From Jira'
/** The most a single import brings in: more than this is a project, not a feature, and a person should choose. */
const storiesMost = 500

export const noteIdFor = (issueId: string) => `note-jira-${issueId}`
export const cardIdFor = (issueId: string) => `card-jira-${issueId}`

/** A size from an issue's points, the nearest there is: what's in Jira isn't written over until the size changes. */
function sizeOf(jira: JiraConnection, value: unknown): Card['size'] {
  const { pointsField, pointsKind, points } = jira.settings
  if (!pointsField || !points || value === null || value === undefined) return 'M'
  const sizes = ['S', 'M', 'L'] as const
  if (pointsKind === 'number') {
    const worth = Number(value)
    if (!Number.isFinite(worth)) return 'M'
    return sizes.reduce((best, size) => (Math.abs(Number(points[size]) - worth) < Math.abs(Number(points[best]) - worth) ? size : best), 'M' as Card['size'])
  }
  const said = String((value as { value?: unknown })?.value ?? value)
  return sizes.find((size) => String(points[size]) === said) ?? 'M'
}

/** The project's features and what's under each, for a person to choose from. Nothing changes. */
export async function listFeatures(hub: Hub, jira: JiraConnection) {
  const features = await jira.features()
  const stories = await jira.storiesUnder(features.map((f) => f.key))
  return features.map((feature) => {
    const under = stories.filter((s) => s.parent === feature.key)
    const stages: Partial<Record<Stage, number>> = {}
    let leftOut = 0
    for (const story of under) {
      const stage = stageOfImported(story.status, story.category, jira.settings)
      if (stage) stages[stage] = (stages[stage] ?? 0) + 1
      else leftOut++
    }
    return { key: feature.key, title: feature.summary, status: feature.status, stories: under.length, stages, leftOut, here: under.filter((s) => hub.state.cards.some((c) => c.id === cardIdFor(s.id))).length, noted: hub.state.notes.some((n) => n.id === noteIdFor(feature.id)) }
  })
}

export async function importFeatures(hub: Hub, jira: JiraConnection, saver: JiraSaver, options: { binderId: string; keys: string[]; by: string; agentsMayTake?: boolean }) {
  const { binderId, by, agentsMayTake } = options
  if (!jira.on()) throw new Refused('Connect Jira first.')
  if (!hub.state.binders.some((b) => b.id === binderId)) throw new Refused(`No binder ${binderId}.`)
  const prefix = `${jira.settings.project}-`
  const keys = [...new Set(options.keys)]
  if (!keys.length) throw new Refused('Choose a feature to bring in.')
  // Only this project's: the connection is for it, and a key is only a word until Jira says otherwise.
  if (keys.some((key) => !key.startsWith(prefix) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key))) throw new Refused(`Only ${jira.settings.project}’s features can be brought in here.`)
  const features = await Promise.all(keys.map((key) => jira.feature(key)))
  const stories = await jira.storiesUnder(keys, true)
  if (stories.length > storiesMost) throw new Refused(`That’s ${stories.length} stories, and one import takes up to ${storiesMost}. Choose fewer features.`)

  const at = new Date().toISOString()
  const changes: Change[] = []
  let folder: Folder | undefined = hub.state.folders.find((f) => f.binderId === binderId && !f.parentId && f.name === folderName)
  if (!folder) {
    folder = { id: `folder-jira-${binderId}`.slice(0, 60), binderId, name: folderName }
    if (!hub.state.folders.some((f) => f.id === folder!.id)) changes.push({ type: 'folder.put', folder })
  }
  const counted = { features: 0, stories: 0, already: 0, leftOut: [] as string[] }
  const adopted: (() => void)[] = []

  for (const feature of features) {
    const noteId = noteIdFor(feature.id)
    const under = stories.filter((s) => s.parent === feature.key)
    const taking: { story: JiraStory; stage: Stage }[] = []
    for (const story of under) {
      if (saver.cardOfIssue(story.id) || hub.state.cards.some((c) => c.id === cardIdFor(story.id))) {
        counted.already++
        continue
      }
      const stage = stageOfImported(story.status, story.category, jira.settings)
      if (!stage) {
        counted.leftOut.push(story.key)
        continue
      }
      taking.push({ story, stage: stage === 'ready' && !agentsMayTake ? 'proposed' : stage })
    }

    if (!hub.state.notes.some((n) => n.id === noteId)) {
      const lines = taking.map(({ story }) => `- ${story.key}: ${story.summary}`)
      const text = [`# ${feature.summary}`, markdownOf(feature.description), lines.length ? `## Stories\n\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n').slice(0, 200_000) + '\n'
      const note: Note = { id: noteId, title: titleOf(text), binderId, folderId: folder.id, editedAt: at, editedBy: by, editors: [by], text }
      changes.push({ type: 'note.put', note })
      adopted.push(() => saver.adoptEpic(noteId, { id: feature.id, key: feature.key }))
      counted.features++
    }

    for (const { story, stage } of taking) {
      const id = cardIdFor(story.id)
      const who = story.assignee ? `, with ${story.assignee}` : ''
      const size = sizeOf(jira, story.points)
      const card: Card = {
        id, binderId, title: story.summary, brief: markdownOf(story.description).slice(0, 20_000), doneWhen: '', size, stage,
        createdAt: at, createdBy: by, updatedAt: at, noteId, waitsFor: [],
        jira: { key: story.key, url: jira.browse(story.key), imported: true },
        ...(stage === 'working' ? { doing: `In progress in Jira${who}` } : stage === 'live' ? { progress: 1 } : {}),
        activity: [{ at, by: 'Jira', kind: 'said', text: `Brought in from Jira: ${story.key}, ${story.status ?? 'no status'}${who}.` }],
      }
      adopted.push(() => saver.adopt(card, { id: story.id, key: story.key, status: story.status, parent: feature.key }))
      changes.push({ type: 'card.put', card })
      const quote = `${story.key}: ${story.summary}`
      changes.push({ type: 'note.link', id: noteId, link: { itemId: id, quote } })
      counted.stories++
    }
  }

  // Known as linked before the board hears of them, so nothing takes them for cards to make issues of.
  for (const adopt of adopted) adopt()
  if (changes.length) await hub.recordAll({ kind: 'user', login: by }, changes)
  return counted
}
