import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTimeContext } from '../src/time-context.mjs'

/** One fixed instant: 00:45 in Moscow, 06:45 in Tokyo. */
const instant = new Date('2026-10-06T00:45:00+03:00')

test('formatTimeContext states the local date, time and zone', () => {
  const output = formatTimeContext({ now: instant, timeZone: 'Europe/Moscow' })

  assert.ok(output.startsWith('Сейчас: '), output)
  assert.match(output, /6 октября 2026/)
  assert.match(output, /00:45/)
  assert.match(output, /\(Europe\/Moscow\)/)
  // The model is told what "сегодня" means, so cached data cannot be mislabelled.
  assert.match(output, /сегодня/)
})

test('formatTimeContext shows the same instant in another zone', () => {
  const moscow = formatTimeContext({ now: instant, timeZone: 'Europe/Moscow' })
  const tokyo = formatTimeContext({ now: instant, timeZone: 'Asia/Tokyo' })

  assert.match(tokyo, /6 октября 2026/)
  assert.match(tokyo, /06:45/)
  assert.match(tokyo, /\(Asia\/Tokyo\)/)
  assert.ok(!tokyo.includes('00:45'), 'Tokyo is six hours ahead of Moscow')
  assert.notEqual(tokyo, moscow)
})

test('formatTimeContext falls back to the system zone for an empty zone', () => {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const output = formatTimeContext({ now: instant })

  assert.ok(systemZone.length > 0)
  assert.ok(output.includes(`(${systemZone})`), output)
  assert.ok(output.startsWith('Сейчас: '), output)
})

test('formatTimeContext throws on an invalid zone instead of returning a wrong string', () => {
  assert.throws(() => formatTimeContext({ now: instant, timeZone: 'Not/AZone' }), RangeError)
})
