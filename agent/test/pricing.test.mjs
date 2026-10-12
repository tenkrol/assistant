import assert from 'node:assert/strict'
import { test } from 'node:test'
import { costOf, costOfDay, formatUsd, isPeak, parsePeakWindows } from '../src/pricing.mjs'

// Peak windows are 01:00–04:00 and 06:00–10:00 UTC on weekdays, per the provider.
const wednesdayPeak = new Date('2026-10-07T02:00:00Z')
const wednesdayOffPeak = new Date('2026-10-07T12:00:00Z')
const saturdayPeakHours = new Date('2026-10-10T02:00:00Z')

test('peak windows parse from configuration', () => {
  assert.deepEqual(parsePeakWindows('01:00-04:00,06:00-10:00'), [[1, 4], [6, 10]])
  assert.deepEqual(parsePeakWindows('мусор,01:00-05:00'), [[1, 5]])
  assert.deepEqual(parsePeakWindows(''), [[1, 4], [6, 10]], 'a broken value falls back to the defaults')
})

test('peak is weekday-only and window-bound', () => {
  assert.equal(isPeak(wednesdayPeak), true)
  assert.equal(isPeak(wednesdayOffPeak), false)
  assert.equal(isPeak(saturdayPeakHours), false, 'weekends are off-peak all day')
  assert.equal(isPeak(new Date('2026-10-07T00:30:00Z')), false, 'before the window')
  assert.equal(isPeak(new Date('2026-10-07T04:00:00Z')), false, 'the window end is exclusive')
})

test('a DSH usage record is priced by the three counters', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }
  const offPeak = costOf(usage, { date: wednesdayOffPeak })
  assert.equal(offPeak.peak, false)
  // 0.15 + 0.60 + 0.003 = 0.753
  assert.ok(Math.abs(offPeak.usd - 0.753) < 1e-9, `got ${offPeak.usd}`)

  const peak = costOf(usage, { date: wednesdayPeak })
  assert.equal(peak.peak, true)
  assert.ok(Math.abs(peak.usd - 1.506) < 1e-9, `got ${peak.usd}`)
})

test('cache writes are billed as uncached input', () => {
  const cost = costOf({ inputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, { date: wednesdayOffPeak })
  assert.ok(Math.abs(cost.usd - 0.15) < 1e-9)
})

test('normalised counters work the same way', () => {
  const cost = costOf({ uncachedInput: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }, { date: wednesdayOffPeak })
  assert.ok(Math.abs(cost.usd - 0.753) < 1e-9)
})

test('a day of aggregated usage is priced too', () => {
  const day = { prompt: 35_449, completion: 1_122, cached: 28_544, requests: 2 }
  const cost = costOfDay(day, { date: wednesdayOffPeak })
  // (35449-28544) uncached + 28544 cached + 1122 output, off-peak
  const expected = (6_905 * 0.15 + 28_544 * 0.003 + 1_122 * 0.6) / 1_000_000
  assert.ok(Math.abs(cost.usd - expected) < 1e-12)
  assert.ok(cost.usd > 0 && cost.usd < 0.01)
})

test('zero usage costs nothing and prices can be overridden', () => {
  assert.equal(costOf({}, { date: wednesdayOffPeak }).usd, 0)
  const custom = costOf({ outputTokens: 1_000_000 }, {
    date: wednesdayOffPeak,
    prices: { inputPeak: 1, inputOffPeak: 1, cachedPeak: 1, cachedOffPeak: 1, outputPeak: 9, outputOffPeak: 9 },
  })
  assert.equal(custom.usd, 9)
})

test('money is formatted for a person', () => {
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(0.0042), '$0.0042')
  assert.equal(formatUsd(0.123), '$0.123')
  assert.equal(formatUsd(1.5), '$1.50')
})
