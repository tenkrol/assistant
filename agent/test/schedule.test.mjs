import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  CronError,
  ScheduleStore,
  describeCron,
  localParts,
  nextRunAt,
  parseCron,
  parseScheduleAdd,
} from '../src/schedule.mjs'
import { cleanup, createTestLogger, tempDir } from './helpers.mjs'

const MOSCOW = 'Europe/Moscow'

test('a five-field expression is parsed into value sets', () => {
  const parsed = parseCron('0 9 * * 1-5')
  assert.deepEqual([...parsed.minute.values], [0])
  assert.deepEqual([...parsed.hour.values], [9])
  assert.equal(parsed.minute.restricted, true)
  assert.equal(parsed.dom.restricted, false)
  assert.deepEqual([...parsed.dow.values], [1, 2, 3, 4, 5])
  assert.equal(parsed.source, '0 9 * * 1-5')
})

test('lists, ranges, steps and names are understood', () => {
  assert.deepEqual([...parseCron('1,3,5 * * * *').minute.values], [1, 3, 5])
  assert.deepEqual([...parseCron('*/15 * * * *').minute.values], [0, 15, 30, 45])
  assert.deepEqual([...parseCron('0 6-9/2 * * *').hour.values], [6, 8])
  assert.deepEqual([...parseCron('0 0 1 jan *').month.values], [1])
  assert.deepEqual([...parseCron('0 0 * * mon-fri').dow.values], [1, 2, 3, 4, 5])
  assert.deepEqual([...parseCron('0 0 * * 7').dow.values], [0], 'Sunday is both 0 and 7')
})

test('a malformed expression names the field it does not understand', () => {
  assert.throws(() => parseCron('0 9 * *'), (error) => {
    assert.ok(error instanceof CronError)
    assert.match(error.message, /5 полей/)
    return true
  })
  assert.throws(() => parseCron('0 99 * * *'), /часы/)
  assert.throws(() => parseCron('0 9 * * пн'), /день недели/)
  assert.throws(() => parseCron('*/0 * * * *'), /шаг/)
})

test('wall-clock parts are computed in the requested zone', () => {
  const instant = new Date('2026-10-08T21:30:00Z')
  const moscow = localParts(instant, MOSCOW)
  assert.equal(moscow.hour, 0, 'Moscow is UTC+3')
  assert.equal(moscow.day, 9)
  const utc = localParts(instant, 'UTC')
  assert.equal(utc.hour, 21)
  assert.equal(utc.day, 8)
})

test('the next run is found in the owner time zone', () => {
  // 2026-10-08 is a Thursday; 09:00 Moscow = 06:00 UTC.
  const from = new Date('2026-10-08T05:00:00Z')
  const next = nextRunAt(parseCron('0 9 * * *'), from, { timeZone: MOSCOW })
  assert.equal(next.toISOString(), '2026-10-08T06:00:00.000Z')
})

test('a weekday schedule skips the weekend', () => {
  // Friday 09:00 Moscow has passed → the next run is Monday.
  const friday = new Date('2026-10-09T07:00:00Z')
  const next = nextRunAt(parseCron('0 9 * * 1-5'), friday, { timeZone: MOSCOW })
  assert.equal(next.toISOString(), '2026-10-12T06:00:00.000Z', 'Monday 09:00 Moscow')
})

test('a step schedule fires within the hour', () => {
  const from = new Date('2026-10-08T12:07:00Z')
  const next = nextRunAt(parseCron('*/15 * * * *'), from, { timeZone: 'UTC' })
  assert.equal(next.toISOString(), '2026-10-08T12:15:00.000Z')
})

test('the next run is strictly after the given moment', () => {
  const exact = new Date('2026-10-08T12:15:00Z')
  const next = nextRunAt(parseCron('*/15 * * * *'), exact, { timeZone: 'UTC' })
  assert.equal(next.toISOString(), '2026-10-08T12:30:00.000Z')
})

test('day-of-month and day-of-week are OR-ed, like Vixie cron', () => {
  // The 1st of the month OR any Monday. From 6 October the 1st has passed and
  // the next match is Monday the 12th — which only happens under the OR rule.
  const from = new Date('2026-10-06T00:00:00Z')
  const next = nextRunAt(parseCron('0 3 1 * 1'), from, { timeZone: 'UTC' })
  assert.equal(next.toISOString(), '2026-10-12T03:00:00.000Z')
})

test('a schedule with no occurrence in the horizon is reported as such', () => {
  // 30 February never happens.
  const next = nextRunAt(parseCron('0 0 30 2 *'), new Date('2026-01-01T00:00:00Z'), { timeZone: 'UTC', horizonDays: 40 })
  assert.equal(next, undefined)
})

test('common patterns get a human description', () => {
  assert.equal(describeCron('0 9 * * *'), 'каждый день в 09:00')
  assert.equal(describeCron('30 18 * * 1-5'), 'по будням в 18:30')
  assert.equal(describeCron('0 8 * * 1,3'), 'по понедельникам, средам в 08:00')
  assert.equal(describeCron('*/15 * * * *'), 'каждые 15 мин')
  assert.equal(describeCron('0 */6 * * *'), 'каждые 6 ч в :00')
  assert.equal(describeCron('0 9 1 * *'), '1-го числа каждого месяца в 09:00')
  assert.match(describeCron('7 3 13 6 2'), /по cron/)
})

test('add arguments split into cron and task, quoted or bare', () => {
  assert.deepEqual(parseScheduleAdd('"0 9 * * 1-5" собери сводку'), { cronText: '0 9 * * 1-5', task: 'собери сводку' })
  assert.deepEqual(parseScheduleAdd('0 9 * * 1-5 собери сводку и пришли файл'), { cronText: '0 9 * * 1-5', task: 'собери сводку и пришли файл' })
  assert.deepEqual(parseScheduleAdd('«*/30 * * * *» проверь почту'), { cronText: '*/30 * * * *', task: 'проверь почту' })
  assert.deepEqual(parseScheduleAdd(''), { cronText: '', task: '' })
})

test('a stored schedule survives a restart with its next run', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'schedules.json')
    const store = await new ScheduleStore({ file, timeZone: MOSCOW, logger: createTestLogger() }).load()
    const record = await store.add({ chatId: 42, userId: 42, cron: '0 9 * * 1-5', task: 'собери сводку' })
    assert.match(record.id, /^s[0-9a-z]+$/)
    assert.ok(record.nextRunAt > Date.now() - 1000)

    const reloaded = await new ScheduleStore({ file, timeZone: MOSCOW, logger: createTestLogger() }).load()
    const same = reloaded.get(record.id)
    assert.equal(same.task, 'собери сводку')
    assert.equal(same.cron, '0 9 * * 1-5')
    assert.equal(same.enabled, true)
    assert.equal(same.nextRunAt, record.nextRunAt)
  } finally {
    await cleanup(dir)
  }
})

test('a malformed cron never reaches the store', async () => {
  const dir = await tempDir()
  try {
    const store = new ScheduleStore({ file: path.join(dir, 'schedules.json'), timeZone: 'UTC', logger: createTestLogger() })
    await assert.rejects(() => store.add({ chatId: 1, cron: 'не cron', task: 'x' }), CronError)
    assert.equal(store.all().length, 0)
  } finally {
    await cleanup(dir)
  }
})

test('update, disable and remove work as expected', async () => {
  const dir = await tempDir()
  try {
    const store = new ScheduleStore({ file: path.join(dir, 'schedules.json'), timeZone: 'UTC', logger: createTestLogger() })
    const record = await store.add({ chatId: 1, cron: '0 9 * * *', task: 'задача' })
    await store.update(record.id, { enabled: false })
    assert.equal(store.get(record.id).enabled, false)
    assert.equal(await store.remove(record.id), true)
    assert.equal(await store.remove(record.id), false)
    assert.equal(store.all().length, 0)
  } finally {
    await cleanup(dir)
  }
})

test('refresh recomputes the next run and counts what was missed', async () => {
  const dir = await tempDir()
  try {
    const store = new ScheduleStore({ file: path.join(dir, 'schedules.json'), timeZone: 'UTC', logger: createTestLogger() })
    const record = await store.add({ chatId: 1, cron: '0 9 * * *', task: 'задача' })
    // Pretend the service was down for a week.
    await store.update(record.id, { nextRunAt: Date.now() - 7 * 86_400_000 })

    const missed = await store.refresh(new Date())
    assert.equal(missed, 1, 'one schedule was overdue')
    assert.ok(store.get(record.id).nextRunAt > Date.now())
    assert.equal(store.get(record.id).missed, 1)
  } finally {
    await cleanup(dir)
  }
})

test('refresh tolerates a run that only just became due', async () => {
  const dir = await tempDir()
  try {
    const store = new ScheduleStore({ file: path.join(dir, 'schedules.json'), timeZone: 'UTC', logger: createTestLogger() })
    const record = await store.add({ chatId: 1, cron: '0 9 * * *', task: 'задача' })
    await store.update(record.id, { nextRunAt: Date.now() - 40_000 })

    const missed = await store.refresh(new Date(), { graceMs: 120_000 })
    assert.equal(missed, 0, '40 seconds late is the next tick, not a lost run')
    assert.equal(store.get(record.id).missed, 0)
    assert.ok(store.get(record.id).nextRunAt > Date.now())
  } finally {
    await cleanup(dir)
  }
})

test('a disabled schedule is left alone by refresh', async () => {
  const dir = await tempDir()
  try {
    const store = new ScheduleStore({ file: path.join(dir, 'schedules.json'), timeZone: 'UTC', logger: createTestLogger() })
    const record = await store.add({ chatId: 1, cron: '0 9 * * *', task: 'задача' })
    await store.update(record.id, { enabled: false, nextRunAt: Date.now() - 86_400_000 })
    assert.equal(await store.refresh(new Date()), 0)
  } finally {
    await cleanup(dir)
  }
})

test('shedules are listed oldest first for a stable view', async () => {
  const dir = await tempDir()
  try {
    const store = new ScheduleStore({ file: path.join(dir, 'schedules.json'), timeZone: 'UTC', logger: createTestLogger() })
    const first = await store.add({ chatId: 1, cron: '0 9 * * *', task: 'первая' })
    await new Promise((resolve) => setTimeout(resolve, 3))
    const second = await store.add({ chatId: 1, cron: '0 10 * * *', task: 'вторая' })
    assert.deepEqual(store.all().map((record) => record.id), [first.id, second.id])

    const raw = JSON.parse(await fs.readFile(path.join(dir, 'schedules.json'), 'utf8'))
    assert.equal(raw.schedules.length, 2)
    assert.equal(raw.timeZone, 'UTC')
  } finally {
    await cleanup(dir)
  }
})
