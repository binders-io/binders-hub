import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cronPreset, describeCron, nextRun, parseCron, presetCron } from '../../shared/schedule.ts'
import { Actions } from '../src/actions.ts'
import { Hub } from '../src/hub.ts'
import { MemoryLog } from '../src/log.ts'
import { Scheduler } from '../src/scheduler.ts'
import { seed } from './helpers.ts'

describe('when a schedule runs next', () => {
  it('follows cron in its time zone, across a change of the clocks', () => {
    // Friday 30 October 2026, 10:00 in New York; the clocks go back on Sunday 1 November.
    const after = new Date('2026-10-30T14:00:00Z')
    assert.equal(nextRun('0 9 * * 1-5', 'America/New_York', after)?.toISOString(), '2026-11-02T14:00:00.000Z', 'Monday 09:00 EST')
    assert.equal(nextRun('*/15 * * * *', 'UTC', new Date('2026-10-30T10:07:00Z'))?.toISOString(), '2026-10-30T10:15:00.000Z')
    assert.equal(nextRun('30 18 * * 5', 'Europe/Lisbon', after)?.toISOString(), '2026-10-30T18:30:00.000Z', 'Friday 18:30 in Lisbon, on UTC in winter')
    assert.equal(nextRun('0 0 1 1 *', 'UTC', after)?.toISOString(), '2027-01-01T00:00:00.000Z')
  })

  it('reads presets as cron and back, and refuses what isn’t cron', () => {
    assert.equal(presetCron({ kind: 'weekdays', time: '09:30' }), '30 9 * * 1-5')
    assert.deepEqual(cronPreset('30 9 * * 1-5'), { kind: 'weekdays', time: '09:30' })
    assert.equal(describeCron(presetCron({ kind: 'weekly', day: 1, time: '08:00' })), 'Every Monday at 08:00')
    assert.equal(describeCron('0 */6 * * *'), 'Cron 0 */6 * * *')
    assert.throws(() => parseCron('0 9 * *'), /five fields/)
    assert.throws(() => parseCron('61 * * * *'), /from 0 to 59/)
  })
})

describe('scheduled runs', () => {
  it('puts the note on the board as a card when due, skips while the last run is going, and runs now when asked', async () => {
    const hub = new Hub(new MemoryLog())
    await hub.start(seed())
    let clock = new Date('2026-10-30T10:00:00Z')
    const actions = new Actions(hub, undefined as never)
    ;(actions as unknown as { now: () => string }).now = () => clock.toISOString()
    const scheduler = new Scheduler(hub, actions, { now: () => clock })
    await hub.record({ kind: 'user', login: 'ana' }, { type: 'note.edit', id: 'n1', text: '# Dependency check\n\nUpdate what is out of date.', title: 'Dependency check', by: 'ana', at: clock.toISOString() })

    const schedule = await actions.addSchedule('ana', { noteId: 'n1', cron: '0 11 * * *', tz: 'UTC' })
    await scheduler.tick()
    assert.equal(hub.state.cards.length, 0, 'not due yet')

    clock = new Date('2026-10-30T11:00:30Z')
    await scheduler.tick()
    const card = hub.state.cards.find((c) => c.scheduleId === schedule.id)!
    assert.equal(card.title, 'Dependency check · Oct 30')
    assert.equal(card.stage, 'ready')
    assert.match(card.brief, /every day at 11:00, UTC/)
    assert.match(card.brief, /Update what is out of date\./, 'the note is the instructions')
    assert.equal(hub.state.schedules?.[0].lastCardId, card.id)

    // Missed days while the last run is still going: one skip, then nothing piles up.
    clock = new Date('2026-11-02T11:00:30Z')
    await scheduler.tick()
    assert.equal(hub.state.cards.length, 1)
    assert.match(hub.state.schedules?.[0].lastSkipped ?? '', /isn’t done yet/)

    await hub.record({ kind: 'hub' }, { type: 'card.update', id: card.id, fields: { stage: 'live' } })
    clock = new Date('2026-11-03T11:00:30Z')
    await scheduler.tick()
    assert.equal(hub.state.cards.length, 2, 'the next day it runs again')

    const now = await actions.runSchedule(schedule.id, 'ana')
    assert.ok(now, 'run now goes even with a run going')
    await actions.updateSchedule('ana', schedule.id, { enabled: false })
    clock = new Date('2026-11-04T11:00:30Z')
    await scheduler.tick()
    assert.equal(hub.state.cards.length, 3, 'off, it doesn’t run')
    await assert.rejects(actions.addSchedule('ana', { noteId: 'n1', cron: 'every day', tz: 'UTC' }), /five fields/)
    await assert.rejects(actions.addSchedule('ana', { noteId: 'n1', cron: '0 9 * * *', tz: 'Mars/Olympus' }), /isn’t a time zone/)
  })
})
