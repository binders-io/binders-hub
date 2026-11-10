import type { Change } from './state.ts'

/** What a new hub starts with: one project with a note on what to do first. Environments are made when GitHub reports a deployment, or a person sets one up. */
export function startingSeed(owner: string, now = new Date()): Change[] {
  const at = now.toISOString()
  const welcome = `# Welcome to Binders

Write here, then **Distill** this note into work items for your agents.

- Set up an agent in **Agents**, and start it with the runner it shows.
- Link this binder to a GitHub repo in Settings → GitHub, and its cards become issues there.
`
  return [
    { type: 'binder.put', binder: { id: 'first', name: 'First project', createdBy: owner } },
    { type: 'note.put', note: { id: 'welcome', title: 'Welcome to Binders', binderId: 'first', editedAt: at, editors: [owner], text: welcome } },
  ]
}
