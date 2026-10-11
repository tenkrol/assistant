/**
 * Character and mood.
 *
 * Both are per-user settings: a character survives a restart, a pinned mood wins
 * over the rotation, and the rotation itself is stable within a day.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MOODS, PERSONAS, autoMood, characterHint, moodOf, personaOf } from '../src/personas.mjs'

const NOON = new Date('2026-10-08T12:00:00+03:00')
const ZONE = 'Europe/Moscow'

test('an unknown or missing character falls back to the neutral one', () => {
  assert.equal(personaOf(undefined).title, 'обычный')
  assert.equal(personaOf({ persona: 'нет такого' }).title, 'обычный')
  assert.equal(personaOf({ persona: 'с юмором' }).hint, PERSONAS['с юмором'].hint)
})

test('the mood rotates per user and day, and is stable inside one day', () => {
  const morning = new Date('2026-10-08T09:00:00+03:00')
  const evening = new Date('2026-10-08T20:00:00+03:00')
  const first = moodOf({}, { userId: 1, now: morning, timeZone: ZONE })
  assert.equal(moodOf({}, { userId: 1, now: evening, timeZone: ZONE }), first, 'в течение дня не меняется')
  assert.ok(MOODS[first], 'настроение из списка')
  // Different people in one chat do not share a mood.
  const other = moodOf({}, { userId: 2, now: morning, timeZone: ZONE })
  const third = moodOf({}, { userId: 3, now: morning, timeZone: ZONE })
  assert.ok([other, third].some((mood) => mood !== first), 'у разных людей настроения расходятся')
})

test('a late hour brings the tired mood, a pinned mood wins over everything', () => {
  const night = new Date('2026-10-08T02:00:00+03:00')
  assert.equal(moodOf({}, { userId: 1, now: night, timeZone: ZONE }), 'уставший')
  assert.equal(moodOf({ mood: 'серьёзный' }, { userId: 1, now: night, timeZone: ZONE }), 'серьёзный')
  assert.equal(moodOf({ mood: 'выдумка' }, { userId: 1, now: night, timeZone: ZONE }), 'уставший', 'неизвестное настроение игнорируется')
})

test('the rotation never picks the night mood', () => {
  const moods = new Set()
  for (let day = 1; day <= 28; day++) {
    moods.add(autoMood(1, new Date(`2026-09-${String(day).padStart(2, '0')}T12:00:00+03:00`), ZONE))
  }
  assert.equal(moods.has('уставший'), false)
  assert.ok(moods.size >= 4, `настроения чередуются: ${[...moods].join(', ')}`)
})

test('the hint describes the character and forbids mood affecting facts', () => {
  const hint = characterHint({ profile: { persona: 'заботливый' }, userId: 1, now: NOON, timeZone: ZONE })
  assert.match(hint, /Твой характер: заботливый/)
  assert.match(hint, /факты, цифры и время всегда точные/)
})
