import { BriefService } from './actions/briefs.ts'

export { mergeableOf, type GitHubAccess } from './actions/base.ts'

/**
 * What people and agents do that's more than one change. It's one object to the routes, MCP and webhooks, and a file for
 * each part of the work, each building on the one before: base, cards, rules, environments, change sets, debriefs,
 * Challenges, repo briefs.
 */
export class Actions extends BriefService {}
