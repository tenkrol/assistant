import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { toProviderUsage } from '../src/bot.mjs'
import { dayKey, UsageStore } from '../src/usage.mjs'
import { cleanup, tempDir } from './helpers.mjs'

test('DSH usage is mapped onto the provider shape the store understands', () => {
  const mapped = toProviderUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 })
  assert.deepEqual(mapped, { prompt_tokens: 135, completion_tokens: 20, cached_tokens: 30 })
})

test('recording sums tokens per day and flags the budget', async () => {
  const dir = await tempDir()
  try {
    const store = new UsageStore({ file: path.join(dir, 'usage.json'), dailyLimit: 1000 })
    const usage = toProviderUsage({ inputTokens: 400, outputTokens: 100 })
    assert.equal(store.record({ usage, userId: '42', chatId: 42 }), false)
    assert.equal(store.tokens(), 500)
    assert.equal(store.record({ usage, userId: '42', chatId: 42 }), true)
    assert.equal(store.tokens(), 1000)
    assert.equal(store.limitReached(), true)
    assert.deepEqual(store.byUser().map((entry) => entry.userId), ['42'])
  } finally {
    await cleanup(dir)
  }
})

test('a zero budget never reports exhaustion', () => {
  const store = new UsageStore({ file: '/nonexistent/usage.json', dailyLimit: 0 })
  store.record({ usage: { prompt_tokens: 10_000_000 }, chatId: 1 })
  assert.equal(store.limitReached(), false)
})

test('counters survive a restart', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'usage.json')
    const first = new UsageStore({ file })
    first.record({ usage: { prompt_tokens: 10, completion_tokens: 5 }, userId: '42', chatId: 42 })
    await first.flush()

    const second = await new UsageStore({ file }).load()
    assert.equal(second.tokens(), 15)
    assert.equal(second.total().requests, 1)
  } finally {
    await cleanup(dir)
  }
})

test('the day key follows the configured time zone', () => {
  const moment = new Date('2026-10-08T22:30:00Z')
  assert.equal(dayKey(moment, 'Europe/Moscow'), '2026-10-09')
  assert.equal(dayKey(moment, 'UTC'), '2026-10-08')
})
