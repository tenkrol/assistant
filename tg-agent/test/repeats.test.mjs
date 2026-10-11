/**
 * Repeat schedules: value validation, Russian labels and the next-firing rule.
 *
 * Every instant is an explicit UTC literal and the assertions use `getUTC*`,
 * so the suite does not depend on the machine's time zone. The implementation
 * deliberately works in absolute time (see `src/repeats.mjs`), and these tests
 * pin that simplification down instead of hiding it: a `weekly` step is exactly
 * 7*24h even across the March 2026 date on which EU zones switch to DST.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPEAT_VALUES,
  describeRepeat,
  isRepeat,
  nextDue,
  repeatAfterDelivery,
} from '../src/repeats.mjs'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** Shorthand: ISO string -> Date. */
const at = (iso) => new Date(iso)
/** Shorthand: `nextDue` result as an ISO string (fails loudly when undefined). */
const nextIso = (dueAt, repeat, now) => nextDue(at(dueAt), repeat, { now: at(now) }).toISOString()

// 2026-10-06 is a Tuesday; 2026-10-09 Friday; 2026-10-10 Saturday;
// 2026-10-11 Sunday; 2026-10-12 Monday; 2026-10-13 Tuesday.

test('REPEAT_VALUES lists every documented form exactly once', () => {
  assert.equal(REPEAT_VALUES.length, 4 + 7 + 31 + 288)
  assert.equal(new Set(REPEAT_VALUES).size, REPEAT_VALUES.length)
  for (const value of ['none', 'daily', 'weekly', 'weekdays']) assert.ok(REPEAT_VALUES.includes(value), value)
  for (let day = 1; day <= 7; day++) assert.ok(REPEAT_VALUES.includes(`weekly:${day}`), `weekly:${day}`)
  for (let day = 1; day <= 31; day++) assert.ok(REPEAT_VALUES.includes(`monthly:${day}`), `monthly:${day}`)
  for (let minutes = 5; minutes <= 1440; minutes += 5) assert.ok(REPEAT_VALUES.includes(`every:${minutes}`), `every:${minutes}`)
  assert.ok(!REPEAT_VALUES.includes('every:0'))
  assert.ok(!REPEAT_VALUES.includes('every:1445'))
  assert.ok(REPEAT_VALUES.every(isRepeat))
})

test('isRepeat accepts the listed values and rejects the rest', () => {
  for (const value of REPEAT_VALUES) assert.equal(isRepeat(value), true, value)
  const rejected = [
    'weekly:0', 'weekly:8', 'monthly:0', 'monthly:32',
    'every:3', 'every:2000', 'every:7', 'every:1445', 'every:0',
    'weekly:01', 'monthly:003', 'every:030', 'every:-30',
    'Daily', 'WEEKLY:1', 'WEEKDAYS', 'garbage', '', ' ', 'none ',
    null, undefined, 0, 1, {}, [], true,
  ]
  for (const value of rejected) assert.equal(isRepeat(value), false, JSON.stringify(value) ?? String(value))
})

test('describeRepeat names each schedule in Russian', () => {
  const cases = {
    none: 'без повтора',
    daily: 'каждый день',
    weekly: 'каждую неделю',
    weekdays: 'по будням',
    'weekly:1': 'каждый понедельник',
    'weekly:2': 'каждый вторник',
    'weekly:3': 'каждую среду',
    'weekly:4': 'каждый четверг',
    'weekly:5': 'каждую пятницу',
    'weekly:6': 'каждую субботу',
    'weekly:7': 'каждое воскресенье',
    'monthly:1': '1-го числа каждого месяца',
    'monthly:2': '2-го числа каждого месяца',
    'monthly:21': '21-го числа каждого месяца',
    'monthly:31': '31-го числа каждого месяца',
    'every:5': 'каждые 5 минут',
    'every:30': 'каждые 30 минут',
    'every:1440': 'каждые 1440 минут',
  }
  for (const [value, label] of Object.entries(cases)) assert.equal(describeRepeat(value), label, value)
  for (const value of ['garbage', 'weekly:0', 'every:3', '', null, undefined, 42]) {
    assert.equal(describeRepeat(value), undefined, String(value))
  }
})

test('nextDue returns undefined for none and for every invalid repeat, without throwing', () => {
  const dueAt = at('2026-10-06T09:00:00.000Z')
  const now = at('2026-10-06T10:00:00.000Z')
  assert.equal(nextDue(dueAt, 'none', { now }), undefined)
  const invalid = ['garbage', 'weekly:0', 'weekly:8', 'monthly:0', 'monthly:32', 'every:3', 'every:2000', 'every:7', '', null, undefined, 42, {}]
  for (const repeat of invalid) {
    assert.doesNotThrow(() => nextDue(dueAt, repeat, { now }))
    assert.equal(nextDue(dueAt, repeat, { now }), undefined, String(repeat))
  }
})

test('nextDue returns undefined for a missing or unparseable dueAt', () => {
  const now = at('2026-10-06T10:00:00.000Z')
  for (const dueAt of ['nonsense', '', null, undefined, new Date('nope'), Number.NaN, {}]) {
    assert.equal(nextDue(dueAt, 'daily', { now }), undefined, String(dueAt))
  }
})

test('daily catches up in whole days and keeps the time of day', () => {
  // Three days plus a couple of hours behind: the next firing is tomorrow,
  // because today's 06:07:08.123 has already passed.
  const next = nextDue(at('2026-10-06T06:07:08.123Z'), 'daily', { now: at('2026-10-09T10:00:00.000Z') })
  assert.equal(next.toISOString(), '2026-10-10T06:07:08.123Z')
  assert.equal(next.getUTCHours(), 6)
  assert.equal(next.getUTCMinutes(), 7)
  assert.equal(next.getUTCSeconds(), 8)
  assert.equal(next.getUTCMilliseconds(), 123)
  assert.ok(next.getTime() > at('2026-10-09T10:00:00.000Z').getTime())
})

test('daily steps exactly one day when only the time of day has passed', () => {
  assert.equal(nextIso('2026-10-09T09:00:00.000Z', 'daily', '2026-10-09T10:00:00.000Z'), '2026-10-10T09:00:00.000Z')
})

test('weekdays skips the weekend: Friday, Saturday and Sunday land on Monday', () => {
  assert.equal(nextIso('2026-10-09T06:00:00.000Z', 'weekdays', '2026-10-09T07:00:00.000Z'), '2026-10-12T06:00:00.000Z')
  assert.equal(nextIso('2026-10-10T06:00:00.000Z', 'weekdays', '2026-10-10T07:00:00.000Z'), '2026-10-12T06:00:00.000Z')
  assert.equal(nextIso('2026-10-11T06:00:00.000Z', 'weekdays', '2026-10-11T07:00:00.000Z'), '2026-10-12T06:00:00.000Z')
  // Thursday -> Friday is untouched: mid-week days are not skipped.
  assert.equal(nextIso('2026-10-08T06:00:00.000Z', 'weekdays', '2026-10-08T07:00:00.000Z'), '2026-10-09T06:00:00.000Z')
})

test('weekdays keeps the stored time of day', () => {
  const next = nextDue(at('2026-10-09T21:15:30.500Z'), 'weekdays', { now: at('2026-10-09T22:00:00.000Z') })
  assert.equal(next.toISOString(), '2026-10-12T21:15:30.500Z')
  assert.equal(next.getUTCHours(), 21)
  assert.equal(next.getUTCMinutes(), 15)
  assert.equal(next.getUTCSeconds(), 30)
})

test('weekly is exactly seven 24h days from the previous instant', () => {
  const due = at('2026-10-06T06:00:00.000Z')
  const now = at('2026-10-06T07:00:00.000Z')
  const next = nextDue(due, 'weekly', { now })
  assert.equal(next.toISOString(), '2026-10-13T06:00:00.000Z')
  assert.equal(next.getTime() - due.getTime(), 7 * DAY_MS)
})

test('weekly skips missed weeks but stays on the original grid', () => {
  const due = at('2026-08-04T06:00:00.000Z')
  const now = at('2026-10-06T07:00:00.000Z')
  const next = nextDue(due, 'weekly', { now })
  assert.ok(next.getTime() > now.getTime())
  assert.equal((next.getTime() - due.getTime()) % (7 * DAY_MS), 0)
  assert.ok(next.getTime() - now.getTime() <= 7 * DAY_MS)
  assert.equal(next.getUTCHours(), 6)
})

test('weekly and daily stay on absolute 24h steps across the March 2026 DST date', () => {
  // Moscow has no DST switch, so the test asserts what the implementation
  // promises by construction: no wall-clock correction is ever applied.
  const weeklyDue = at('2026-03-25T06:00:00.000Z')
  const weekly = nextDue(weeklyDue, 'weekly', { now: at('2026-03-25T07:00:00.000Z') })
  assert.equal(weekly.toISOString(), '2026-04-01T06:00:00.000Z')
  assert.equal(weekly.getTime() - weeklyDue.getTime(), 7 * DAY_MS)
  assert.equal(weekly.getUTCHours(), 6)
  assert.equal(weekly.getUTCMinutes(), 0)

  const dailyDue = at('2026-03-28T21:00:00.000Z')
  const daily = nextDue(dailyDue, 'daily', { now: at('2026-03-28T22:00:00.000Z') })
  assert.equal(daily.toISOString(), '2026-03-29T21:00:00.000Z')
  assert.equal(daily.getTime() - dailyDue.getTime(), DAY_MS)
  assert.equal(daily.getUTCHours(), 21)
})

test('weekly:2 fires today when the requested time has not passed yet', () => {
  // Tuesday 2026-10-06, 08:00 — the 09:00 firing is still ahead.
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:2', '2026-10-06T08:00:00.000Z'), '2026-10-06T09:00:00.000Z')
})

test('weekly:2 fires next week when today is the day but the time has passed', () => {
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:2', '2026-10-06T10:00:00.000Z'), '2026-10-13T09:00:00.000Z')
  // Exactly on the firing instant is not "strictly later", so it moves a week.
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:2', '2026-10-06T09:00:00.000Z'), '2026-10-13T09:00:00.000Z')
})

test('weekly:N picks the nearest requested weekday in the stored time of day', () => {
  const now = '2026-10-06T10:00:00.000Z' // Tuesday
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:1', now), '2026-10-12T09:00:00.000Z') // Monday
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:2', now), '2026-10-13T09:00:00.000Z') // Tuesday
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:3', now), '2026-10-07T09:00:00.000Z') // Wednesday
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'weekly:7', now), '2026-10-11T09:00:00.000Z') // Sunday
  const next = nextDue(at('2026-10-06T21:15:30.500Z'), 'weekly:4', { now: at(now) })
  assert.equal(next.toISOString(), '2026-10-08T21:15:30.500Z') // Thursday, clock preserved
})

test('monthly:31 clamps to the last day of a shorter month', () => {
  assert.equal(nextIso('2026-01-31T06:00:00.000Z', 'monthly:31', '2026-02-01T00:00:00.000Z'), '2026-02-28T06:00:00.000Z')
  assert.equal(nextIso('2028-01-31T06:00:00.000Z', 'monthly:31', '2028-02-01T00:00:00.000Z'), '2028-02-29T06:00:00.000Z')
  assert.equal(nextIso('2026-03-31T06:00:00.000Z', 'monthly:31', '2026-04-01T00:00:00.000Z'), '2026-04-30T06:00:00.000Z')
  assert.equal(nextIso('2026-01-30T06:00:00.000Z', 'monthly:30', '2026-02-01T00:00:00.000Z'), '2026-02-28T06:00:00.000Z')
})

test('monthly:D fires on the requested day and keeps the stored time of day', () => {
  // Today is the 15th and 06:00 is still ahead.
  assert.equal(nextIso('2026-09-15T06:00:00.000Z', 'monthly:15', '2026-10-15T05:00:00.000Z'), '2026-10-15T06:00:00.000Z')
  // Today is the 1st but 06:00 has passed.
  assert.equal(nextIso('2026-10-01T06:00:00.000Z', 'monthly:1', '2026-10-01T07:00:00.000Z'), '2026-11-01T06:00:00.000Z')
  const next = nextDue(at('2026-01-31T23:59:59.999Z'), 'monthly:31', { now: at('2026-02-01T00:00:00.000Z') })
  assert.equal(next.toISOString(), '2026-02-28T23:59:59.999Z')
  assert.equal(next.getUTCHours(), 23)
  assert.equal(next.getUTCMilliseconds(), 999)
})

test('every:30 returns one future instant on the original grid', () => {
  const due = at('2026-10-06T09:00:00.000Z')
  const now = at('2026-10-06T12:47:00.000Z')
  const next = nextDue(due, 'every:30', { now })
  assert.equal(next.toISOString(), '2026-10-06T13:00:00.000Z')
  assert.equal((next.getTime() - due.getTime()) % (30 * MINUTE_MS), 0)
  // No burst and no drift: a single instant, at most one interval ahead.
  assert.ok(next.getTime() > now.getTime())
  assert.ok(next.getTime() - now.getTime() <= 30 * MINUTE_MS)
})

test('every:30 is strictly later even when now sits exactly on a grid point', () => {
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'every:30', '2026-10-06T12:30:00.000Z'), '2026-10-06T13:00:00.000Z')
  assert.equal(nextIso('2026-10-06T09:00:00.000Z', 'every:5', '2026-10-06T09:03:00.000Z'), '2026-10-06T09:05:00.000Z')
})

test('every:N does not replay a backlog after a very long outage', () => {
  const due = at('2026-01-01T09:00:00.000Z')
  const now = at('2026-10-06T12:47:00.000Z')
  const fine = nextDue(due, 'every:30', { now })
  assert.equal(fine.toISOString(), '2026-10-06T13:00:00.000Z')
  assert.ok(fine.getTime() - now.getTime() <= 30 * MINUTE_MS)

  const coarse = nextDue(due, 'every:1440', { now })
  assert.equal(coarse.toISOString(), '2026-10-07T09:00:00.000Z')
  assert.equal((coarse.getTime() - due.getTime()) % (1440 * MINUTE_MS), 0)
  assert.ok(coarse.getTime() - now.getTime() <= 1440 * MINUTE_MS)
})

test('nextDue is always strictly later than now for every calendar schedule', () => {
  const repeats = ['daily', 'weekly', 'weekdays', 'weekly:1', 'weekly:2', 'weekly:7', 'monthly:1', 'monthly:15', 'monthly:31', 'every:5', 'every:30', 'every:1440']
  const nows = ['2026-10-06T06:00:00.000Z', '2026-10-06T23:59:59.999Z', '2026-10-11T12:00:00.000Z', '2026-12-31T23:30:00.000Z']
  for (const repeat of repeats) {
    for (const now of nows) {
      const next = nextDue(at('2026-10-06T23:59:59.999Z'), repeat, { now: at(now) })
      assert.ok(next instanceof Date, `${repeat} @ ${now}`)
      assert.ok(next.getTime() > at(now).getTime(), `${repeat} @ ${now} -> ${next.toISOString()}`)
    }
  }
})

test('repeatAfterDelivery moves the date forward and keeps the repeat type', () => {
  const now = at('2026-10-06T10:00:00.000Z')
  const cases = {
    daily: '2026-10-07T09:00:00.000Z',
    weekly: '2026-10-13T09:00:00.000Z',
    weekdays: '2026-10-07T09:00:00.000Z',
    'weekly:2': '2026-10-13T09:00:00.000Z',
    'monthly:15': '2026-10-15T09:00:00.000Z',
    'every:30': '2026-10-06T10:30:00.000Z',
  }
  for (const [repeat, expectedIso] of Object.entries(cases)) {
    const result = repeatAfterDelivery({ dueAt: '2026-10-06T09:00:00.000Z', repeat }, { now })
    assert.equal(result.repeat, repeat)
    assert.ok(result.dueAt instanceof Date)
    assert.equal(result.dueAt.toISOString(), expectedIso, repeat)
    assert.ok(result.dueAt.getTime() > now.getTime(), repeat)
  }
})

test('repeatAfterDelivery returns undefined when nothing should repeat', () => {
  const now = at('2026-10-06T10:00:00.000Z')
  assert.equal(repeatAfterDelivery({ dueAt: '2026-10-06T09:00:00.000Z', repeat: 'none' }, { now }), undefined)
  assert.equal(repeatAfterDelivery({ dueAt: '2026-10-06T09:00:00.000Z' }, { now }), undefined)
  assert.equal(repeatAfterDelivery({ dueAt: '2026-10-06T09:00:00.000Z', repeat: 'garbage' }, { now }), undefined)
  assert.equal(repeatAfterDelivery({ dueAt: 'nonsense', repeat: 'daily' }, { now }), undefined)
  assert.equal(repeatAfterDelivery(undefined, { now }), undefined)
})

test('repeatAfterDelivery result can be stored in the reminder shape', () => {
  const result = repeatAfterDelivery({ dueAt: '2026-10-06T09:00:00.000Z', repeat: 'weekdays' }, { now: at('2026-10-09T10:00:00.000Z') })
  assert.equal(result.dueAt.toISOString(), '2026-10-12T09:00:00.000Z')
  const stored = { id: '1', chatId: 7, text: 'x', dueAt: result.dueAt.toISOString(), repeat: result.repeat }
  assert.equal(typeof stored.dueAt, 'string')
  assert.ok(Number.isFinite(Date.parse(stored.dueAt)))
  assert.equal(nextIso(stored.dueAt, stored.repeat, '2026-10-12T10:00:00.000Z'), '2026-10-13T09:00:00.000Z')
})
