import { nextRun } from '../../shared/schedule.ts'
import type { Actions } from './actions.ts'
import type { CopyKeeper } from './copies.ts'
import type { FeedReader } from './listen/reader.ts'
import { emptyTrash } from './history.ts'
import type { Hub } from './hub.ts'
import { log } from './logger.ts'

// The timer behind what runs without being asked: every half minute, each schedule that's on and due fires once. Due is
// the first time its cron gives after its last run (or its making), so runs missed while the hub was down come to one
// run, not one for each time missed. Then the notes a folder's rule says to Distill, and a note's own change sets that
// have everything in, the cards whose agent has gone quiet, the diffs nobody needs kept any more, the Binder's daily copy when one is due,
// and the repos whose deployments are due a look on GitHub. Each step's failure stays its own.

/** How long an agent can go unheard before the card it works on goes back on the board. */
export const quietMs = 20 * 60_000

/** How long a pull request's diff stays in the state after it's merged or closed: after that GitHub has it. */
export const diffKeptMs = 14 * 86_400_000

/** How many pull requests, and how many cards, a pass tidies, so it never writes a huge change. */
export const tidyBatch = 20

export class Scheduler {
  private timer?: NodeJS.Timeout
  private ticking = false
  /** The Binder's daily copies: asked each tick whether one is due, and not waited for. */
  copies?: CopyKeeper
  /** The feeds its listeners read: asked each tick which are due, and not waited for. */
  feeds?: FeedReader

  private hub: Hub
  private actions: Actions
  private options: { everyMs?: number; now?: () => Date; quietMs?: number; diffKeptMs?: number; tidyBatch?: number; trashKeptMs?: number }

  constructor(hub: Hub, actions: Actions, options: { everyMs?: number; now?: () => Date; quietMs?: number; diffKeptMs?: number; tidyBatch?: number; trashKeptMs?: number } = {}) {
    this.hub = hub
    this.actions = actions
    this.options = options
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.options.everyMs ?? 30_000)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  /** Fires what's due; one pass at a time. */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.options.now?.() ?? new Date()
      for (const schedule of this.hub.state.schedules ?? []) {
        if (!schedule.enabled) continue
        let due: Date | undefined
        try {
          due = nextRun(schedule.cron, schedule.tz, new Date(schedule.lastRun ?? schedule.createdAt))
        } catch (error) {
          // It was checked when it was set, so this is a time zone or rule the hub no longer takes: said on the schedule.
          const why = `It can’t work out when to run: ${(error as Error).message}`
          if (schedule.failing !== why) await this.hub.record({ kind: 'hub' }, { type: 'schedule.update', id: schedule.id, fields: { failing: why } }).catch(() => undefined)
          continue
        }
        if (!due || due > now) continue
        await this.actions.runSchedule(schedule.id, undefined, due.toISOString()).catch((err: Error) => log.warn({ err, schedule: schedule.id }, 'A schedule couldn’t run'))
      }
      await this.actions.distillDue(now).catch((err: Error) => log.warn({ err }, 'Distilling a folder’s notes failed'))
      await this.releaseQuiet(now).catch((err: Error) => log.warn({ err }, 'Putting back the cards of agents gone quiet failed'))
      await this.tidyDiffs(now).catch((err: Error) => log.warn({ err }, 'Letting go of old diffs failed'))
      await emptyTrash(this.hub, now.getTime(), this.options.trashKeptMs, this.options.tidyBatch).catch((err: Error) => log.warn({ err }, 'Emptying the old trash failed'))
      await this.actions.sendFinishedSets().catch((err: Error) => log.warn({ err }, 'Sending a note’s change set for review failed'))
      // A daily copy takes its own time, and fails on its own: it's started here and left to finish.
      if (this.copies) void this.copies.tick(now)
      if (this.feeds) void this.feeds.look().catch((err: Error) => log.warn({ err }, 'Reading the listeners’ feeds failed'))
      // Looking at GitHub for deployments paces itself, a repo at a time with a pause between, so it isn't waited for here.
      if (this.actions.deliveryLooks) void this.actions.lookDue(now.getTime()).catch((err: Error) => log.warn({ err }, 'Looking for deployments failed'))
    } finally {
      this.ticking = false
    }
  }

  /** The lines of diffs that are held on GitHub or by a pull request are let go of, a few at a time. */
  private async tidyDiffs(now: Date) {
    const batch = this.options.tidyBatch ?? tidyBatch
    await this.actions.dropOldDiffs(now.getTime(), this.options.diffKeptMs ?? diffKeptMs, batch)
    await this.actions.clearDoneWorktrees(batch)
  }

  /**
   * A card being worked on whose agent the hub hasn't heard from in a while goes back on the board: its runner is gone,
   * or its machine asleep. Blocked cards wait on a person, not an agent, so they stay. The hub's own start counts as the
   * last time it heard (it keeps no memory of before), so a restart doesn't put back every card at once.
   */
  private async releaseQuiet(now: Date) {
    const limit = this.options.quietMs ?? quietMs
    for (const card of this.hub.state.cards) {
      if (card.stage !== 'working' || !card.agentId) continue
      if (now.getTime() - this.hub.lastHeard(card.agentId, now.getTime()) < limit) continue
      const name = this.hub.state.agents.find((a) => a.id === card.agentId)?.name ?? 'An agent'
      const minutes = Math.round(limit / 60_000)
      await this.actions.releaseUnheard(card.agentId, card.id, `${name} hasn’t been heard from for ${minutes} minutes, so this went back on the board.`)
        .catch((err: Error) => log.warn({ err, card: card.id }, 'A card’s quiet agent couldn’t be put back'))
    }
  }
}
