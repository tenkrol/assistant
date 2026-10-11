/**
 * Usage: per-day token accounting (`UsageStore`) and the calendar-day helper.
 *
 * Every test runs against a fresh temporary file, so persistence is exercised
 * for real (flush writes, load reads) without touching the running bot's data.
 * Days are always named explicitly, so nothing here depends on the real clock.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { UsageStore, dayKey } from '../src/usage.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * A store backed by a fresh temporary file.
 *
 * @param {object} [options] - store options.
 * @param {number} [options.retentionDays] - days kept by `prune`.
 * @param {number} [options.dailyLimit] - token budget per day, 0 disables it.
 * @param {number} [options.saveDelayMs] - debounce for writes.
 */
async function makeStore({ retentionDays, dailyLimit, saveDelayMs = 5 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-usage-'))
  const file = path.join(dir, 'usage.json')
  const store = new UsageStore({ file, logger: silentLogger, retentionDays, dailyLimit, saveDelayMs })
  await store.load()
  return {
    dir,
    file,
    store,
    /** Flush before removing so no pending write can land during `rm`. */
    cleanup: async () => {
      await store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/** Noon UTC of a `YYYY-MM-DD` day: far from any zone edge. */
const at = (day) => new Date(`${day}T12:00:00Z`)

test('dayKey maps an instant to the calendar day of the requested zone', () => {
  const moment = new Date('2026-10-05T22:30:00Z')
  assert.equal(dayKey(moment, 'UTC'), '2026-10-05')
  assert.equal(dayKey(moment, 'Europe/Moscow'), '2026-10-06', '22:30Z is already 01:30 in Moscow')
  assert.equal(dayKey(moment, 'Asia/Tokyo'), '2026-10-06', '22:30Z is already 07:30 in Tokyo')
  // An empty zone falls back to the system one.
  assert.equal(dayKey(moment, ''), dayKey(moment, Intl.DateTimeFormat().resolvedOptions().timeZone))
})

test('record sums prompt, completion and cached tokens plus requests', async () => {
  const ctx = await makeStore()
  try {
    const date = at('2026-10-06')
    ctx.store.record({
      usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 30 },
      userId: 1,
      date,
      timeZone: 'UTC',
    })
    ctx.store.record({
      usage: { prompt_tokens: 200, completion_tokens: 10, prompt_cache_hit_tokens: 5 },
      userId: 1,
      date,
      timeZone: 'UTC',
    })

    assert.deepEqual(ctx.store.total(date, 'UTC'), {
      prompt: 300,
      completion: 50,
      cached: 35,
      requests: 2,
      users: { 1: { prompt: 300, completion: 50, requests: 2 } },
    })
    assert.equal(ctx.store.tokens(date, 'UTC'), 350, 'tokens() is prompt + completion, without the cached part')
  } finally {
    await ctx.cleanup()
  }
})

test('record understands Anthropic field names and nested cached tokens', async () => {
  const ctx = await makeStore()
  try {
    const date = at('2026-10-06')
    ctx.store.record({ usage: { input_tokens: 70, output_tokens: 20 }, date, timeZone: 'UTC' })
    ctx.store.record({
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 12 } },
      date,
      timeZone: 'UTC',
    })

    const day = ctx.store.total(date, 'UTC')
    assert.equal(day.prompt, 120)
    assert.equal(day.completion, 25)
    assert.equal(day.cached, 12)
    assert.equal(day.requests, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('record without a usage payload still counts the request', async () => {
  const ctx = await makeStore()
  try {
    const date = at('2026-10-06')
    const reached = ctx.store.record({ chatId: 7, date, timeZone: 'UTC' })
    assert.equal(reached, false)
    assert.deepEqual(ctx.store.total(date, 'UTC'), {
      prompt: 0,
      completion: 0,
      cached: 0,
      requests: 1,
      users: { 7: { prompt: 0, completion: 0, requests: 1 } },
    })

    // An explicit `usage: undefined` takes the same path and must not throw.
    ctx.store.record({ chatId: 7, usage: undefined, date, timeZone: 'UTC' })
    assert.equal(ctx.store.total(date, 'UTC').requests, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('byUser sums per user, sorts by total and falls back to the chat id', async () => {
  const ctx = await makeStore()
  try {
    const date = at('2026-10-06')
    ctx.store.record({ usage: { prompt_tokens: 10, completion_tokens: 5 }, userId: 1, date, timeZone: 'UTC' })
    ctx.store.record({ usage: { prompt_tokens: 100, completion_tokens: 0 }, userId: 2, date, timeZone: 'UTC' })
    ctx.store.record({ usage: { prompt_tokens: 7, completion_tokens: 1 }, userId: 1, date, timeZone: 'UTC' })
    // No user id: the chat id becomes the key.
    ctx.store.record({ usage: { prompt_tokens: 4, completion_tokens: 4 }, chatId: 777, date, timeZone: 'UTC' })
    ctx.store.record({ usage: { prompt_tokens: 1, completion_tokens: 1 }, userId: null, chatId: '8', date, timeZone: 'UTC' })
    // A falsy but present user id is kept as-is.
    ctx.store.record({ usage: { prompt_tokens: 2, completion_tokens: 3 }, userId: 0, date, timeZone: 'UTC' })
    // Neither id nor chat: the documented "unknown" bucket.
    ctx.store.record({ usage: {}, date, timeZone: 'UTC' })

    assert.deepEqual(ctx.store.byUser(date, 'UTC'), [
      { userId: '2', prompt: 100, completion: 0, requests: 1, total: 100 },
      { userId: '1', prompt: 17, completion: 6, requests: 2, total: 23 },
      { userId: '777', prompt: 4, completion: 4, requests: 1, total: 8 },
      { userId: '0', prompt: 2, completion: 3, requests: 1, total: 5 },
      { userId: '8', prompt: 1, completion: 1, requests: 1, total: 2 },
      { userId: 'unknown', prompt: 0, completion: 0, requests: 1, total: 0 },
    ])
  } finally {
    await ctx.cleanup()
  }
})

test('different days do not mix and an untouched day totals zeros', async () => {
  const ctx = await makeStore()
  try {
    const first = at('2026-10-05')
    const second = at('2026-10-06')
    const untouched = at('2026-10-07')
    ctx.store.record({ usage: { prompt_tokens: 5 }, date: first, timeZone: 'UTC' })
    ctx.store.record({ usage: { prompt_tokens: 9 }, date: second, timeZone: 'UTC' })

    assert.equal(ctx.store.total(first, 'UTC').prompt, 5)
    assert.equal(ctx.store.total(second, 'UTC').prompt, 9)
    assert.deepEqual(ctx.store.total(untouched, 'UTC'), {
      prompt: 0,
      completion: 0,
      cached: 0,
      requests: 0,
      users: {},
    })
    assert.equal(ctx.store.days.size, 2, 'reading an unknown day must not create it')
  } finally {
    await ctx.cleanup()
  }
})

test('limitReached flips exactly at the budget and record reports it', async () => {
  const ctx = await makeStore({ dailyLimit: 1000 })
  try {
    const date = at('2026-10-06')
    assert.equal(ctx.store.limitReached(date, 'UTC'), false)
    // Cached tokens are not part of the budget (tokens() ignores them).
    assert.equal(
      ctx.store.record({ usage: { prompt_tokens: 900, prompt_cache_hit_tokens: 5000 }, date, timeZone: 'UTC' }),
      false,
    )
    assert.equal(
      ctx.store.record({ usage: { prompt_tokens: 99 }, date, timeZone: 'UTC' }),
      false,
      '999 tokens are still under the limit',
    )
    assert.equal(
      ctx.store.record({ usage: { prompt_tokens: 1 }, date, timeZone: 'UTC' }),
      true,
      'the limit is reached at exactly 1000 tokens',
    )
    assert.equal(ctx.store.limitReached(date, 'UTC'), true)

    ctx.store.record({ usage: { completion_tokens: 1 }, date, timeZone: 'UTC' })
    assert.equal(ctx.store.limitReached(date, 'UTC'), true, 'it stays reached above the limit')
  } finally {
    await ctx.cleanup()
  }
})

test('dailyLimit 0 disables the budget', async () => {
  const ctx = await makeStore({ dailyLimit: 0 })
  try {
    const date = at('2026-10-06')
    assert.equal(ctx.store.limitReached(date, 'UTC'), false)
    assert.equal(ctx.store.record({ usage: { prompt_tokens: 1_000_000 }, date, timeZone: 'UTC' }), false)
    assert.equal(ctx.store.limitReached(date, 'UTC'), false)
  } finally {
    await ctx.cleanup()
  }
})

test('flush + load round-trips the counters and the per-user split', async () => {
  const ctx = await makeStore()
  try {
    const date = at('2026-10-06')
    ctx.store.record({
      usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 7 },
      userId: 1,
      date,
      timeZone: 'UTC',
    })
    ctx.store.record({ usage: { input_tokens: 20, output_tokens: 2 }, userId: 2, date, timeZone: 'UTC' })
    await ctx.store.flush()

    const reopened = new UsageStore({ file: ctx.file, logger: silentLogger })
    await reopened.load()
    assert.deepEqual(reopened.total(date, 'UTC'), ctx.store.total(date, 'UTC'))
    assert.deepEqual(reopened.byUser(date, 'UTC'), ctx.store.byUser(date, 'UTC'))
  } finally {
    await ctx.cleanup()
  }
})

test('a corrupt file is ignored and replaced by a valid flush', async () => {
  const ctx = await makeStore()
  try {
    await fs.writeFile(ctx.file, '{ это не json', 'utf8')
    const store = new UsageStore({ file: ctx.file, logger: silentLogger })
    await store.load()
    assert.equal(store.days.size, 0, 'a corrupt file must not throw and must leave the store empty')

    store.record({ usage: { prompt_tokens: 3 }, date: at('2026-10-06'), timeZone: 'UTC' })
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.days['2026-10-06'].prompt, 3)
  } finally {
    await ctx.cleanup()
  }
})

test('a file from another version is ignored, not trusted', async () => {
  const ctx = await makeStore()
  try {
    await fs.writeFile(ctx.file, JSON.stringify({ version: 99, days: { '2026-10-06': { prompt: 500 } } }), 'utf8')
    const store = new UsageStore({ file: ctx.file, logger: silentLogger })
    await store.load()
    assert.equal(store.days.size, 0)
    assert.equal(store.total(at('2026-10-06'), 'UTC').prompt, 0)

    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.deepEqual(parsed.days, {})
  } finally {
    await ctx.cleanup()
  }
})

test('retention keeps only the newest days across a flush and a reload', async () => {
  const ctx = await makeStore({ retentionDays: 2 })
  try {
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      ctx.store.record({ usage: { prompt_tokens: 1 }, date: at(day), timeZone: 'UTC' })
    }
    await ctx.store.flush()
    assert.deepEqual([...ctx.store.days.keys()].sort(), ['2026-10-03', '2026-10-04'])

    const reopened = new UsageStore({ file: ctx.file, logger: silentLogger, retentionDays: 2 })
    await reopened.load()
    assert.deepEqual([...reopened.days.keys()].sort(), ['2026-10-03', '2026-10-04'])

    await reopened.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.deepEqual(Object.keys(parsed.days).sort(), ['2026-10-03', '2026-10-04'])
  } finally {
    await ctx.cleanup()
  }
})

test('two overlapping flushes leave a complete, valid file', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.record({
      usage: { prompt_tokens: 42, completion_tokens: 8 },
      userId: 1,
      date: at('2026-10-06'),
      timeZone: 'UTC',
    })
    // Neither call waits for the other: the store must serialize them itself.
    const first = ctx.store.flush()
    const second = ctx.store.flush()
    await Promise.all([first, second])

    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.deepEqual(parsed.days['2026-10-06'], {
      prompt: 42,
      completion: 8,
      cached: 0,
      requests: 1,
      users: { 1: { prompt: 42, completion: 8, requests: 1 } },
    })
    await assert.rejects(fs.access(`${ctx.file}.tmp`), { code: 'ENOENT' }, 'no temporary file may be left behind')
  } finally {
    await ctx.cleanup()
  }
})
