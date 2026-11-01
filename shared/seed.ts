import type { Change } from './state.ts'

/** What a new hub starts with: one project with a note on what to do first, and the two environments. */
export function startingSeed(owner: string, now = new Date()): Change[] {
  const at = now.toISOString()
  const welcome = `# Welcome to Binders

Write here, then **Distill** this note into work items for your agents.

- Set up an agent in **Agents**, and start it with the runner it shows.
- Link this project to a GitHub repo in Settings → Projects, and its cards become issues there.
`
  return [
    { type: 'binder.put', binder: { id: 'first', name: 'First project', createdBy: owner } },
    { type: 'note.put', note: { id: 'welcome', title: 'Welcome to Binders', binderId: 'first', editedAt: at, editors: [owner], text: welcome } },
    { type: 'env.put', environment: { id: 'staging', name: 'Staging', url: '', version: '—', changeSetIds: [], state: 'healthy', deployedAt: '—', needsApproval: false } },
    { type: 'env.put', environment: { id: 'production', name: 'Production', url: '', version: '—', changeSetIds: [], state: 'healthy', deployedAt: '—', needsApproval: true } },
  ]
}
