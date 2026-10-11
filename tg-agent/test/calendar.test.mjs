/**
 * Church and folk holidays plus the daily health tip.
 *
 * The movable dates are computed, so the tests pin them to the official Orthodox
 * Easter dates of recent years: if the algorithm drifts, these fail.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { HEALTH_TIP_COUNT, churchHolidays, folkHolidays, healthTip, orthodoxEaster } from '../src/calendar.mjs'

const ZONE = 'Europe/Moscow'
const at = (iso) => new Date(`${iso}T10:00:00+03:00`)

test('Orthodox Easter matches the official dates', () => {
  const expected = { 2024: '05-05', 2025: '04-20', 2026: '04-12', 2027: '05-02', 2028: '04-16' }
  for (const [year, date] of Object.entries(expected)) {
    const easter = orthodoxEaster(Number(year))
    const actual = `${String(easter.month).padStart(2, '0')}-${String(easter.day).padStart(2, '0')}`
    assert.equal(actual, date, `Пасха ${year}`)
  }
})

test('fixed church feasts are recognised', () => {
  assert.deepEqual(churchHolidays(at('2026-01-07'), ZONE), ['Рождество Христово'])
  assert.deepEqual(churchHolidays(at('2026-01-19'), ZONE), ['Крещение Господне'])
  assert.deepEqual(churchHolidays(at('2026-10-14'), ZONE), ['Покров Пресвятой Богородицы'])
  assert.deepEqual(churchHolidays(at('2026-03-15'), ZONE), [], 'обычный день')
})

test('movable feasts hang off Easter', () => {
  assert.deepEqual(churchHolidays(at('2026-04-12'), ZONE), ['Пасха (Светлое Христово Воскресение)'])
  assert.deepEqual(churchHolidays(at('2026-04-05'), ZONE), ['Вход Господень в Иерусалим (Вербное воскресенье)'], 'Easter − 7')
  assert.deepEqual(churchHolidays(at('2026-05-21'), ZONE), ['Вознесение Господне'], 'Easter + 39')
  assert.deepEqual(churchHolidays(at('2026-05-31'), ZONE), ['День Святой Троицы (Пятидесятница)'], 'Easter + 49')
  assert.deepEqual(churchHolidays(at('2026-02-22'), ZONE), ['Прощёное воскресенье'], 'Easter − 49')
})

test('folk and professional days include computed ones', () => {
  assert.deepEqual(folkHolidays(at('2026-02-14'), ZONE), ['День всех влюблённых'])
  assert.deepEqual(folkHolidays(at('2026-09-13'), ZONE), ['День программиста'], '256-й день года')
  assert.deepEqual(folkHolidays(at('2026-11-29'), ZONE), ['День матери'], 'последнее воскресенье ноября')
  assert.deepEqual(folkHolidays(at('2026-10-18'), ZONE), ['День отца'], 'третье воскресенье октября')
  assert.deepEqual(folkHolidays(at('2026-06-01'), ZONE), [])
})

test('the health tip is stable for a day, personal, and always filled in', () => {
  const morning = at('2026-10-08')
  const evening = new Date('2026-10-08T22:00:00+03:00')
  const first = healthTip(morning, 1, ZONE)
  assert.deepEqual(healthTip(evening, 1, ZONE), first, 'в течение дня не меняется')
  assert.ok(first.tip.length > 10 && first.why.length > 10, 'совет и объяснение заполнены')
  // Everyone gets a tip, and the rotation covers the whole list over time.
  const seen = new Set()
  for (let day = 1; day <= 40; day++) {
    const moment = new Date(Date.UTC(2026, 0, day, 6, 0, 0))
    const tip = healthTip(moment, 1, ZONE)
    assert.ok(tip.tip, 'совет есть всегда')
    seen.add(tip.tip)
  }
  assert.ok(seen.size >= 20, `советы чередуются: ${seen.size} из ${HEALTH_TIP_COUNT}`)
})
