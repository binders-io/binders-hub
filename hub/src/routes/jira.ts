import { Refusal } from '../auth.ts'
import { Refused } from '../hub.ts'
import { discoverJira, jiraAddress, stages, usualPoints, validProject, type JiraSettings, type StageStatuses } from '../jira.ts'
import type { Stage } from '../../../shared/work.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Context } from './context.ts'

// A binder's Jira: where its cards are mirrored, and the token that does it. The hub's store keeps the token sealed;
// this says how it stands, takes a new one, tries the one it has against Jira, and forgets it. Only the binder's owners
// and admins see its details or change it, as its GitHub.

export async function jiraRoutes(app: FastifyInstance, context: Context) {
  const { spaces, sp, login, isAdmin, options, act } = context

  const mayManage = (request: FastifyRequest) => spaces.mayManage(sp(request).id, login(request), isAdmin(login(request)))
  const owner = (request: FastifyRequest, doing: string) => {
    if (!mayManage(request)) throw new Refusal(`Only this binder’s owners and admins ${doing} its Jira.`)
  }

  app.get('/api/jira', act(async (request) => {
    const binder = sp(request)
    const jira = binder.jira
    const on = jira?.on() ?? false
    if (!jira || !mayManage(request)) return { on, stages, mayManage: mayManage(request) }
    return {
      ...jira.publicSettings(),
      on,
      stages,
      mayManage: true,
      webhook: on ? { url: `${options.publicUrl.replace(/\/$/, '')}/webhooks/jira/${binder.id}?secret=${await jira.secret()}` } : undefined,
    }
  }))

  app.put('/api/jira', act(async (request) => {
    owner(request, 'change')
    const binder = sp(request)
    const jira = binder.jira
    if (!jira) throw new Refused('Jira isn’t available on this binder.')
    const body = (request.body ?? {}) as Partial<JiraSettings> & { statuses?: Record<string, unknown> }
    const baseUrl = jiraAddress(typeof body.baseUrl === 'string' ? body.baseUrl : undefined)
    if (!baseUrl) throw new Refused('A Jira Cloud address looks like https://yourcompany.atlassian.net.')
    if (!validProject(body.project)) throw new Refused('A project key is letters and numbers, like BIND.')
    const was = jira.settings
    const token = typeof body.token === 'string' ? body.token : undefined
    // The saved token goes only to the address it was given for: a new address means giving it again.
    if (was.baseUrl && was.baseUrl !== baseUrl && !token?.trim()) throw new Refused('A new Jira address needs its token entered again.')
    const statuses: StageStatuses = {}
    for (const stage of stages) {
      const name = body.statuses?.[stage]
      if (typeof name === 'string' && name) statuses[stage] = name
    }
    const inbound: Record<string, Stage> = {}
    for (const [name, stage] of Object.entries((body.inbound ?? {}) as Record<string, unknown>).slice(0, 200)) {
      if (name.length <= 200 && stages.includes(stage as Stage)) inbound[name] = stage as Stage
    }
    const pointsField = typeof body.pointsField === 'string' && /^customfield_\d+$/.test(body.pointsField) ? body.pointsField : undefined
    const worth = (size: 'S' | 'M' | 'L') => {
      const value = Number(body.points?.[size])
      return Number.isFinite(value) && value >= 0 && value <= 1000 ? value : usualPoints[size]
    }
    const moved = (was.baseUrl && was.baseUrl !== baseUrl) || (was.project && was.project !== body.project!.trim().toUpperCase())
    const saved = await jira.configure({ baseUrl, email: String(body.email ?? ''), token, project: body.project, issueType: String(body.issueType ?? ''), noteIssueType: typeof body.noteIssueType === 'string' ? body.noteIssueType.slice(0, 100) : undefined, statuses, inbound, pointsField, points: { S: worth('S'), M: worth('M'), L: worth('L') } })
    // Issue ids mean nothing at another address, and could be someone else's issue there.
    if (moved) await binder.jiraIssues?.forget()
    await binder.jiraIssues?.load().catch(() => undefined)
    return { ...saved, on: jira.on() }
  }))

  app.delete('/api/jira', act(async (request) => {
    owner(request, 'disconnect')
    const binder = sp(request)
    await binder.jiraIssues?.forget()
    await binder.jira?.disconnect()
    return { ok: true }
  }))

  // What Jira has, to fill in the mapping: nothing is kept. As on saving, a saved token goes only to the address it was given for.
  app.post('/api/jira/discover', act(async (request) => {
    owner(request, 'read')
    const jira = sp(request).jira
    if (!jira) throw new Refused('Jira isn’t available on this binder.')
    const body = (request.body ?? {}) as { baseUrl?: unknown; email?: unknown; token?: unknown; project?: unknown }
    const was = jira.settings
    const given = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl : undefined
    const baseUrl = given ? jiraAddress(given) : was.baseUrl
    if (given && !baseUrl) throw new Refused('A Jira Cloud address looks like https://yourcompany.atlassian.net.')
    const typed = typeof body.token === 'string' ? body.token.trim() : ''
    const token = typed || (baseUrl === was.baseUrl ? was.token : undefined)
    const email = (typeof body.email === 'string' && body.email.trim()) || was.email
    if (!baseUrl || !email || !token) throw new Refused('Connecting needs Jira’s address, the service account’s email and its API token.')
    return discoverJira({ baseUrl, email, token }, typeof body.project === 'string' ? body.project : undefined)
  }))

  app.post('/api/jira/test', act(async (request) => {
    owner(request, 'try')
    const jira = sp(request).jira
    if (!jira?.on()) return { ok: false, error: 'Jira isn’t set up on this binder yet.' }
    const who = await jira.myself()
    return { ok: true, who: who.displayName ?? who.emailAddress }
  }))
}
