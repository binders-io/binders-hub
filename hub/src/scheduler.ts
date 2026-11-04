import { nextRun } from '../../shared/schedule.ts'
import type { Actions } from './actions.ts'
import type { Hub } from './hub.ts'
import { log } from './logger.ts'

// The timer behind what runs without being asked: every half minute, each schedule that's on and due fires once. Due is
// the first time its cron gives after its last run (or its making), so runs missed while the hub was down come to one
// run, not one for each time missed. Then the notes a folder's rule says to Distill, and a note's own change sets that
// have everything in. Each step's failure stays its own.

export class Scheduler {
  private timer?: NodeJS.Timeout
  private ticking = false

  private hub: Hub
  private actions: Actions
  private options: { everyMs?: number; now?: () => Date }

  constructor(hub: Hub, actions: Actions, options: { everyMs?: number; now?: () => Date } = {}) {
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
      await this.actions.sendFinishedSets().catch((err: Error) => log.warn({ err }, 'Sending a note’s change set for review failed'))
    } finally {
      this.ticking = false
    }
  }
}
