/**
 * Reminders: durable store, poll-based scheduler and the `remind` tool.
 *
 * Time is injected everywhere it can be (`now`, fixed `dueAt` literals), so the
 * only real waiting happens in the live-interval test, which has to observe a
 * genuine `setInterval`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ReminderScheduler, ReminderStore, zonedTimeToUtc } from '../src/reminders.mjs'
import { createReminderTool } from '../src/reminder-tool.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const DAY_MS = 86_400_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** A moment far enough ahead that store-only tests never depend on the real clock. */
const FUTURE = '2026-10-07T09:00:00.000Z'

/** Poll a predicate; fails the test instead of hanging forever. */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5, what = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    assert.ok(Date.now() - started <= timeoutMs, `timed out waiting for ${what}`)
    await sleep(stepMs)
  }
}

/**
 * A store backed by a fresh temporary file.
 *
 * @param {object} [options] - store options.
 * @param {number} [options.maxPerChat] - reminders allowed per chat.
 */
async function makeStore({ maxPerChat = 50 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-reminders-'))
  const file = path.join(dir, 'reminders.json')
  const store = new ReminderStore({ file, logger: silentLogger, maxPerChat })
  await store.load()
  return {
    dir,
    file,
    store,
    /** Flush before removing so no in-flight write can land during `rm`. */
    cleanup: async () => {
      await store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/** The `remind` tool over a fresh store with an injected clock. */
async function makeTool({ timeZone = 'Europe/Moscow', now, locale } = {}) {
  const ctx = await makeStore()
  const tool = createReminderTool({ store: ctx.store, timeZone, locale, now })
  return { ...ctx, tool }
}

test('add stores a Date and an ISO string with the documented fields', async () => {
  const ctx = await makeStore()
  try {
    const fromDate = ctx.store.add({ chatId: 7, text: '  чай  ', dueAt: new Date('2026-10-07T06:00:00.000Z') })
    assert.equal(fromDate.id, '1')
    assert.equal(fromDate.chatId, 7)
    assert.equal(fromDate.text, 'чай')
    assert.equal(fromDate.dueAt, '2026-10-07T06:00:00.000Z')
    assert.equal(fromDate.repeat, 'none')
    assert.ok(Number.isFinite(Date.parse(fromDate.createdAt)), `createdAt ${fromDate.createdAt}`)

    const fromIso = ctx.store.add({ chatId: 7, text: 'кофе', dueAt: '2026-10-07T09:00:00+03:00', repeat: 'daily' })
    assert.equal(fromIso.id, '2')
    assert.equal(fromIso.dueAt, '2026-10-07T06:00:00.000Z')
    assert.equal(fromIso.repeat, 'daily')
    assert.deepEqual(ctx.store.list(7).map((reminder) => reminder.text), ['чай', 'кофе'])
  } finally {
    await ctx.cleanup()
  }
})

test('add trims the text and refuses an empty one', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.add({ chatId: 1, text: '\n  позвонить  \t', dueAt: FUTURE }).text, 'позвонить')
    assert.throws(() => ctx.store.add({ chatId: 1, text: '', dueAt: FUTURE }), /text is required/)
    assert.throws(() => ctx.store.add({ chatId: 1, text: '   \n ', dueAt: FUTURE }), /text is required/)
    assert.equal(ctx.store.list(1).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('add refuses text longer than 500 characters', async () => {
  const ctx = await makeStore()
  try {
    assert.throws(() => ctx.store.add({ chatId: 1, text: 'a'.repeat(501), dueAt: FUTURE }), /too long/)
    // Exactly 500 characters is still accepted.
    assert.equal(ctx.store.add({ chatId: 1, text: 'a'.repeat(500), dueAt: FUTURE }).text.length, 500)
  } finally {
    await ctx.cleanup()
  }
})

test('add refuses an unknown repeat', async () => {
  const ctx = await makeStore()
  try {
    assert.throws(() => ctx.store.add({ chatId: 1, text: 'x', dueAt: FUTURE, repeat: 'hourly' }), /repeat must be one of/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('add refuses an unparseable date', async () => {
  const ctx = await makeStore()
  try {
    assert.throws(() => ctx.store.add({ chatId: 1, text: 'x', dueAt: 'не дата' }), /time is invalid/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('add enforces maxPerChat per chat, not globally', async () => {
  const ctx = await makeStore({ maxPerChat: 2 })
  try {
    ctx.store.add({ chatId: 1, text: 'первое', dueAt: FUTURE })
    ctx.store.add({ chatId: 1, text: 'второе', dueAt: FUTURE })
    assert.throws(() => ctx.store.add({ chatId: 1, text: 'третье', dueAt: FUTURE }), /too many reminders/)
    assert.equal(ctx.store.list(1).length, 2)
    // Another chat has its own budget.
    assert.equal(ctx.store.add({ chatId: 2, text: 'чужое', dueAt: FUTURE }).chatId, 2)
    assert.equal(ctx.store.list(2).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('list filters by chat and returns everything without an argument', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.add({ chatId: 1, text: 'a', dueAt: FUTURE })
    ctx.store.add({ chatId: 2, text: 'b', dueAt: FUTURE })
    ctx.store.add({ chatId: 1, text: 'c', dueAt: FUTURE })
    assert.deepEqual(ctx.store.list(1).map((reminder) => reminder.text), ['a', 'c'])
    assert.deepEqual(ctx.store.list(2).map((reminder) => reminder.text), ['b'])
    assert.deepEqual(ctx.store.list().map((reminder) => reminder.text), ['a', 'b', 'c'])
    assert.deepEqual(ctx.store.list(99), [])
  } finally {
    await ctx.cleanup()
  }
})

test('due returns only the reminders whose time has come', async () => {
  const ctx = await makeStore()
  try {
    const at = Date.parse('2026-10-06T09:00:00Z')
    ctx.store.add({ chatId: 1, text: 'прошлое', dueAt: '2026-10-06T08:00:00Z' })
    ctx.store.add({ chatId: 1, text: 'ровно', dueAt: '2026-10-06T09:00:00Z' })
    ctx.store.add({ chatId: 1, text: 'будущее', dueAt: '2026-10-06T10:00:00Z' })
    assert.deepEqual(ctx.store.due(at).map((reminder) => reminder.text), ['прошлое', 'ровно'])
    assert.deepEqual(ctx.store.due(Date.parse('2026-10-06T07:00:00Z')), [])
  } finally {
    await ctx.cleanup()
  }
})

test('cancel removes only the chat own reminder and reports a miss with undefined', async () => {
  const ctx = await makeStore()
  try {
    const mine = ctx.store.add({ chatId: 1, text: 'моё', dueAt: FUTURE })
    const foreign = ctx.store.add({ chatId: 2, text: 'чужое', dueAt: FUTURE })

    assert.equal(ctx.store.cancel(1, foreign.id), undefined, 'another chat must not lose its reminder')
    assert.equal(ctx.store.list().length, 2)

    const removed = ctx.store.cancel(1, mine.id)
    assert.equal(removed?.text, 'моё')
    assert.deepEqual(ctx.store.list(1), [])
    assert.deepEqual(ctx.store.list(2).map((reminder) => reminder.text), ['чужое'])

    assert.equal(ctx.store.cancel(1, '999'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('advance leaves a one-off reminder untouched', async () => {
  const ctx = await makeStore()
  try {
    const reminder = ctx.store.add({ chatId: 1, text: 'разово', dueAt: '2026-10-06T08:00:00Z' })
    const returned = ctx.store.advance(reminder.id, Date.parse('2026-10-06T09:00:00Z'))
    assert.equal(returned, reminder)
    assert.equal(reminder.dueAt, '2026-10-06T08:00:00.000Z')
  } finally {
    await ctx.cleanup()
  }
})

test('advance moves a daily reminder by exactly one day', async () => {
  const ctx = await makeStore()
  try {
    const reminder = ctx.store.add({ chatId: 1, text: 'зарядка', dueAt: '2026-10-06T09:00:00Z', repeat: 'daily' })
    ctx.store.advance(reminder.id, Date.parse('2026-10-06T09:00:00Z'))
    assert.equal(reminder.dueAt, '2026-10-07T09:00:00.000Z')
  } finally {
    await ctx.cleanup()
  }
})

test('advance moves a weekly reminder by exactly one week', async () => {
  const ctx = await makeStore()
  try {
    const reminder = ctx.store.add({ chatId: 1, text: 'отчёт', dueAt: '2026-10-06T09:00:00Z', repeat: 'weekly' })
    ctx.store.advance(reminder.id, Date.parse('2026-10-06T09:00:00Z'))
    assert.equal(reminder.dueAt, '2026-10-13T09:00:00.000Z')
  } finally {
    await ctx.cleanup()
  }
})

test('advance jumps a long-overdue reminder into the future, again and again', async () => {
  const ctx = await makeStore()
  try {
    const reminder = ctx.store.add({ chatId: 1, text: 'давно', dueAt: '2020-01-01T00:00:00Z', repeat: 'daily' })
    const now = Date.parse('2026-10-06T00:00:00Z')
    ctx.store.advance(reminder.id, now)
    const first = Date.parse(reminder.dueAt)
    assert.ok(first > now, `first ${reminder.dueAt} must be in the future`)
    ctx.store.advance(reminder.id, now)
    const second = Date.parse(reminder.dueAt)
    assert.ok(second > now, `second ${reminder.dueAt} must be in the future`)
    assert.equal(second, first + DAY_MS)
  } finally {
    await ctx.cleanup()
  }
})

test('flush + load round-trips reminders and keeps nextId going', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.add({ chatId: 1, text: 'раз', dueAt: '2026-10-07T06:00:00Z', repeat: 'daily' })
    ctx.store.add({ chatId: 2, text: 'два', dueAt: '2026-10-08T06:00:00Z' })
    await ctx.store.flush()

    const reopened = new ReminderStore({ file: ctx.file, logger: silentLogger })
    await reopened.load()
    assert.deepEqual(reopened.list(), ctx.store.list())
    assert.equal(reopened.nextId, 3)

    const next = reopened.add({ chatId: 1, text: 'три', dueAt: '2026-10-09T06:00:00Z' })
    assert.equal(next.id, '3', 'a new reminder must not reuse an old id')
    assert.equal(reopened.nextId, 4)
  } finally {
    await ctx.cleanup()
  }
})

test('a corrupt file is ignored and replaced by the next flush', async () => {
  const ctx = await makeStore()
  try {
    await fs.writeFile(ctx.file, '{ это не json', 'utf8')
    const store = new ReminderStore({ file: ctx.file, logger: silentLogger })
    await store.load()
    assert.deepEqual(store.list(), [])
    assert.equal(store.nextId, 1)

    store.add({ chatId: 1, text: 'после сбоя', dueAt: '2026-10-07T06:00:00Z' })
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.reminders.length, 1)
    assert.equal(parsed.reminders[0].text, 'после сбоя')
  } finally {
    await ctx.cleanup()
  }
})

test('tick delivers due reminders, counts them and drops the one-off ones', async () => {
  const ctx = await makeStore()
  try {
    const delivered = []
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      now: () => Date.parse('2026-10-06T09:00:00Z'),
      deliver: async (reminder, info) => { delivered.push({ reminder, info }) },
    })
    ctx.store.add({ chatId: 1, text: 'первое', dueAt: '2026-10-06T08:00:00Z' })
    ctx.store.add({ chatId: 1, text: 'второе', dueAt: '2026-10-06T09:00:00Z' })

    assert.equal(await scheduler.tick(), 2)
    assert.deepEqual(delivered.map((entry) => entry.reminder.text), ['первое', 'второе'])
    assert.deepEqual(ctx.store.list(), [])
    assert.equal(await scheduler.tick(), 0)
  } finally {
    await ctx.cleanup()
  }
})

test('a repeating reminder is delivered and moved to the future, staying in the store', async () => {
  const ctx = await makeStore()
  try {
    const delivered = []
    const now = Date.parse('2026-10-06T09:00:00Z')
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      now: () => now,
      deliver: async (reminder) => { delivered.push(reminder.text) },
    })
    const reminder = ctx.store.add({ chatId: 1, text: 'зарядка', dueAt: '2026-10-06T08:00:00Z', repeat: 'daily' })

    assert.equal(await scheduler.tick(), 1)
    assert.deepEqual(delivered, ['зарядка'])
    const remaining = ctx.store.list()
    assert.equal(remaining.length, 1, 'a repeating reminder is not removed')
    assert.equal(remaining[0].id, reminder.id)
    assert.equal(remaining[0].dueAt, '2026-10-07T08:00:00.000Z')
    assert.ok(Date.parse(remaining[0].dueAt) > now)
    assert.equal(await scheduler.tick(), 0, 'the rescheduled reminder is not due yet')
  } finally {
    await ctx.cleanup()
  }
})

test('tick does not deliver a reminder that is not due yet', async () => {
  const ctx = await makeStore()
  try {
    const delivered = []
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      now: () => Date.parse('2026-10-06T09:00:00Z'),
      deliver: async (reminder) => { delivered.push(reminder.text) },
    })
    ctx.store.add({ chatId: 1, text: 'позже', dueAt: '2026-10-06T10:00:00Z' })

    assert.equal(await scheduler.tick(), 0)
    assert.deepEqual(delivered, [])
    assert.equal(ctx.store.list().length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('a failing delivery keeps the reminder and is retried by the next tick', async () => {
  const ctx = await makeStore()
  try {
    let calls = 0
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      now: () => Date.parse('2026-10-06T09:00:00Z'),
      deliver: async () => { calls++; throw new Error('telegram недоступен') },
    })
    ctx.store.add({ chatId: 1, text: 'важное', dueAt: '2026-10-06T08:00:00Z' })

    // tick() must swallow the failure and report zero delivered.
    assert.equal(await scheduler.tick(), 0)
    assert.equal(calls, 1)
    assert.equal(ctx.store.list().length, 1, 'the reminder must survive a failed delivery')

    assert.equal(await scheduler.tick(), 0)
    assert.equal(calls, 2, 'the next tick must retry')
    assert.equal(ctx.store.list().length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('lateMs and lateNotice describe how overdue a reminder was', async () => {
  const ctx = await makeStore()
  try {
    const now = Date.parse('2026-10-06T09:00:00Z')
    const seen = new Map()
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      intervalMs: 1000,
      now: () => now,
      deliver: async (reminder, info) => { seen.set(reminder.text, info) },
    })
    ctx.store.add({ chatId: 1, text: 'просроченное', dueAt: new Date(now - 5000).toISOString() })
    ctx.store.add({ chatId: 1, text: 'свежее', dueAt: new Date(now - 200).toISOString() })

    assert.equal(await scheduler.tick(), 2)
    assert.equal(seen.get('просроченное').lateMs, 5000)
    assert.ok(seen.get('просроченное').lateMs > 0)
    assert.equal(seen.get('просроченное').lateNotice, true)

    assert.equal(seen.get('свежее').lateMs, 200)
    assert.ok(seen.get('свежее').lateMs < 1000, 'a fresh reminder has a small lateMs')
    assert.equal(seen.get('свежее').lateNotice, false)
  } finally {
    await ctx.cleanup()
  }
})

test('overlapping ticks deliver one reminder exactly once', async () => {
  const ctx = await makeStore()
  try {
    let calls = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      now: () => Date.parse('2026-10-06T09:00:00Z'),
      deliver: async () => { calls++; await gate },
    })
    ctx.store.add({ chatId: 1, text: 'одно', dueAt: '2026-10-06T08:00:00Z' })

    const first = scheduler.tick()
    // The second call runs while the first one is paused inside `deliver`.
    const second = scheduler.tick()
    release()
    const counts = await Promise.all([first, second])

    assert.equal(calls, 1, 'deliver must be called once')
    assert.deepEqual([...counts].sort((a, b) => a - b), [0, 1])
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('start arms the interval, stop clears it and flushes', async () => {
  const ctx = await makeStore()
  try {
    let now = Date.parse('2026-10-06T09:00:00Z')
    const delivered = []
    const scheduler = new ReminderScheduler({
      store: ctx.store,
      logger: silentLogger,
      intervalMs: 10,
      now: () => now,
      deliver: async (reminder) => { delivered.push(reminder.text) },
    })
    ctx.store.add({ chatId: 1, text: 'пора', dueAt: '2026-10-06T08:59:00Z' })
    ctx.store.add({ chatId: 1, text: 'потом', dueAt: '2026-10-07T09:00:00Z' })

    scheduler.start()
    assert.ok(scheduler.timer, 'start must arm the interval')
    const armed = scheduler.timer
    scheduler.start()
    assert.equal(scheduler.timer, armed, 'a second start must reuse the same interval')
    await waitFor(() => delivered.length === 1, { what: 'the first delivery' })
    assert.deepEqual(delivered, ['пора'])

    await scheduler.stop()
    assert.equal(scheduler.timer, undefined, 'stop must clear the interval')
    // stop() flushes: the not-yet-due reminder is already on disk.
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.deepEqual(parsed.reminders.map((reminder) => reminder.text), ['потом'])

    // After stop nothing fires again even though a reminder has become due.
    now = Date.parse('2026-10-08T09:00:00Z')
    ctx.store.add({ chatId: 1, text: 'после stop', dueAt: '2026-10-07T09:00:00Z' })
    await sleep(80)
    assert.deepEqual(delivered, ['пора'], 'a stopped scheduler must not deliver')
  } finally {
    await ctx.cleanup()
  }
})

test('zonedTimeToUtc converts a Moscow wall-clock time to UTC', () => {
  assert.equal(zonedTimeToUtc('2026-10-07T09:00', 'Europe/Moscow').toISOString(), '2026-10-07T06:00:00.000Z')
})

test('zonedTimeToUtc converts a Tokyo wall-clock time to UTC', () => {
  assert.equal(zonedTimeToUtc('2026-01-15T12:30', 'Asia/Tokyo').toISOString(), '2026-01-15T03:30:00.000Z')
})

// An explicit offset or `Z` names an instant, so it must be honoured as written
// and must not depend on the zone passed alongside it.
test('zonedTimeToUtc honours an explicit offset regardless of the zone', () => {
  const literal = '2026-10-06T09:00:00+03:00'
  assert.equal(zonedTimeToUtc(literal, 'UTC').toISOString(), '2026-10-06T06:00:00.000Z')
  assert.equal(zonedTimeToUtc(literal, 'Europe/Moscow').toISOString(), '2026-10-06T06:00:00.000Z')
  assert.equal(zonedTimeToUtc(literal, 'Asia/Tokyo').toISOString(), '2026-10-06T06:00:00.000Z')
  assert.equal(zonedTimeToUtc('2026-10-06T06:00:00Z', 'Asia/Tokyo').toISOString(), '2026-10-06T06:00:00.000Z')
  assert.equal(zonedTimeToUtc('2026-10-06T06:00:00+0000', 'Asia/Tokyo').toISOString(), '2026-10-06T06:00:00.000Z')
})

test('zonedTimeToUtc refuses garbage', () => {
  assert.throws(() => zonedTimeToUtc('не время', 'Europe/Moscow'), /cannot parse time/)
})

test('in_minutes schedules about now + the given minutes', async () => {
  const reference = new Date('2026-10-06T09:00:00.000Z')
  const ctx = await makeTool({ now: () => reference })
  try {
    await ctx.tool.execute({ text: 'чай', in_minutes: 20 }, { chatId: 42 })
    const [reminder] = ctx.store.list(42)
    assert.ok(reminder, 'a reminder must be created')
    const delta = Date.parse(reminder.dueAt) - reference.getTime()
    assert.ok(Math.abs(delta - 20 * 60_000) <= 1000, `delta ${delta} ms`)
  } finally {
    await ctx.cleanup()
  }
})

test('a naive `at` is resolved in the configured zone', async () => {
  const ctx = await makeTool({ timeZone: 'Europe/Moscow', now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    await ctx.tool.execute({ text: 'встреча', at: '2026-10-07T09:00' }, { chatId: 42 })
    assert.equal(ctx.store.list(42)[0].dueAt, '2026-10-07T06:00:00.000Z')
  } finally {
    await ctx.cleanup()
  }
})

test('`at` with an explicit offset is taken as is, whatever the zone', async () => {
  const ctx = await makeTool({ timeZone: 'Asia/Tokyo', now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    await ctx.tool.execute({ text: 'созвон', at: '2026-10-06T09:00:00+03:00' }, { chatId: 42 })
    assert.equal(ctx.store.list(42)[0].dueAt, '2026-10-06T06:00:00.000Z')
  } finally {
    await ctx.cleanup()
  }
})

test('in_minutes together with at is refused and creates nothing', async () => {
  const ctx = await makeTool({ now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    const output = await ctx.tool.execute({ text: 'x', in_minutes: 5, at: '2026-10-07T09:00' }, { chatId: 42 })
    assert.match(output, /ровно одно/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('without in_minutes and at the tool asks for a time and creates nothing', async () => {
  const ctx = await makeTool({ now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    const output = await ctx.tool.execute({ text: 'x' }, { chatId: 42 })
    assert.match(output, /ровно одно/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('in_minutes outside the supported range is refused', async () => {
  const ctx = await makeTool({ now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    for (const minutes of [0.01, 200_000]) {
      const output = await ctx.tool.execute({ text: 'x', in_minutes: minutes }, { chatId: 42 })
      assert.match(output, /in_minutes должно быть числом от 0\.05 до 100000/, `minutes ${minutes}: ${output}`)
    }
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('a time in the past is refused with «прошло» and creates nothing', async () => {
  const ctx = await makeTool({ now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    const output = await ctx.tool.execute({ text: 'x', at: '2020-01-01T00:00' }, { chatId: 42 })
    assert.match(output, /прошло/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('an unsupported repeat is refused and creates nothing', async () => {
  const ctx = await makeTool({ now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    const output = await ctx.tool.execute({ text: 'x', in_minutes: 10, repeat: 'hourly' }, { chatId: 42 })
    assert.match(output, /недопустимый повтор/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('the confirmation carries the number, the local time and the text', async () => {
  const ctx = await makeTool({ timeZone: 'Europe/Moscow', now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    const output = await ctx.tool.execute({ text: 'позвонить маме', at: '2026-10-07T09:00' }, { chatId: 42 })
    assert.match(output, /№1/)
    assert.match(output, /09:00/)
    assert.match(output, /Europe\/Moscow/)
    assert.match(output, /«позвонить маме»/)
  } finally {
    await ctx.cleanup()
  }
})

test('without a chatId the tool reports it instead of creating a reminder', async () => {
  const ctx = await makeTool({ now: () => new Date('2026-10-06T00:00:00Z') })
  try {
    assert.match(await ctx.tool.execute({ text: 'x', in_minutes: 10 }, {}), /не удалось определить чат/)
    assert.match(await ctx.tool.execute({ text: 'x', in_minutes: 10 }), /не удалось определить чат/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})
