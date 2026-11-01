import type { Entry } from '../../../shared/state.ts'
import { challengeReview, pullOf, type Challenge, type ChallengeReview } from '../../../shared/changeSet.ts'
import { GitHubError } from '../github.ts'
import type { Hub } from '../hub.ts'
import type { RepoAccess } from './issues.ts'
import { log } from '../logger.ts'

// A Challenge's findings as a review on the card's pull request, for binders that turn it on: one review that only
// comments, with each finding on its file and line where the diff has it and the rest in the review's body. It's
// posted once, as the findings come in; the review's address goes back on the Challenge, or why it couldn't be posted.

export class ReviewsSaver {
  private hub: Hub
  private github: RepoAccess
  private queue: Promise<void> = Promise.resolve()
  private publicUrl?: string

  constructor(hub: Hub, github: RepoAccess, options: { publicUrl?: string } = {}) {
    this.hub = hub
    this.github = github
    this.publicUrl = options.publicUrl
  }

  start() {
    this.hub.on('entries', (entries) => this.follow(entries))
  }

  private follow(entries: Entry[]) {
    for (const { change } of entries) {
      if (change.type !== 'card.update' || !change.fields.challenge) continue
      const challenge = change.fields.challenge as Challenge
      // New findings, not yet posted: what this saver records itself has its review on it.
      if (challenge.state !== 'done' || !challenge.findings?.length || challenge.review) continue
      const id = change.id
      this.queue = this.queue.then(() => this.post(id, challenge.reviewedAt)).catch((err) => log.error({ err }, 'Posting a Challenge to GitHub failed'))
    }
  }

  private async post(cardId: string, reviewedAt?: string) {
    const card = this.hub.state.cards.find((c) => c.id === cardId)
    const challenge = card?.challenge
    if (!card || !challenge || challenge.reviewedAt !== reviewedAt || challenge.review) return
    if (this.hub.state.binders.find((b) => b.id === card.binderId)?.reviewComments !== true) return
    // Work with only a worktree's diff has nowhere on GitHub to comment.
    const pull = pullOf(this.hub.state, card)
    if (!pull) return
    const at = new Date().toISOString()
    const agent = this.hub.state.agents.find((a) => a.id === challenge.agentId)?.name ?? 'An agent'
    const by = { agent, link: this.publicUrl ? `${this.publicUrl}/#/work/${card.id}` : undefined }
    const github = await this.github.forRepo(pull.repo)
    let review: ChallengeReview
    if (!github) review = { repo: pull.repo, number: pull.number, at, failed: `The hub can’t reach ${pull.repo}: install the GitHub App on it.` }
    else {
      const marked = (body: string) => `${body}\n\n<!-- binders ${JSON.stringify({ challenge: card.id })} -->`
      const full = challengeReview(challenge, pull.files, by)
      try {
        let posted: { id: number; html_url: string }
        let onLines = full.comments.length
        try {
          posted = await github.review(pull.repo, pull.number, { body: marked(full.body), comments: full.comments })
        } catch (error) {
          // New commits since the diff was read can move a line out of it, and GitHub then takes none of the comments:
          // every finding goes in the body instead.
          if (!(error instanceof GitHubError && error.status === 422 && onLines)) throw error
          posted = await github.review(pull.repo, pull.number, { body: marked(challengeReview(challenge, [], by).body), comments: [] })
          onLines = 0
        }
        review = { repo: pull.repo, number: pull.number, id: posted.id, url: posted.html_url, at, onLines }
      } catch (error) {
        review = { repo: pull.repo, number: pull.number, at, failed: `GitHub said: ${(error as Error).message}` }
      }
    }
    // Read again: it may have been challenged again while GitHub answered. Only the review is this saver's.
    const now = this.hub.state.cards.find((c) => c.id === cardId)?.challenge
    if (!now || now.reviewedAt !== reviewedAt) return
    await this.hub.record({ kind: 'hub' }, { type: 'card.update', id: cardId, fields: { challenge: { ...now, review } } })
  }

  async stop() {
    await this.queue
  }
}
