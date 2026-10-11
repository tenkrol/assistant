/**
 * Digest weather warnings: rain, frost, heat, wind.
 *
 * The thresholds are the whole feature, so they are tested directly; the API is
 * faked, and a failing request must never break the digest.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_DEFAULTS, forecastAlerts } from '../src/weather-alerts.mjs'

/** A fake Open-Meteo: geocoding plus one daily row. */
function fakeApi({ min, max, rain, wind, code }) {
  return async (url) => {
    if (String(url).includes('geocoding')) {
      return { json: async () => ({ results: [{ latitude: 55.75, longitude: 37.61 }] }) }
    }
    return {
      json: async () => ({
        daily: {
          time: ['2026-10-09', '2026-10-10'],
          temperature_2m_min: [min, min],
          temperature_2m_max: [max, max],
          precipitation_probability_max: [rain, rain],
          weather_code: [code, code],
          wind_speed_10m_max: [wind, wind],
        },
      }),
    }
  }
}

test('rain, frost, heat and wind each produce a warning', async () => {
  const alerts = await forecastAlerts({ city: 'Москва', fetchImpl: fakeApi({ min: -18, max: 32, rain: 90, wind: 45, code: 61 }) })
  const text = alerts.join('\n')
  assert.match(text, /дождь/)
  assert.match(text, /-18 °C/)
  assert.match(text, /\+32 °C/)
  assert.match(text, /ветер/)
  assert.equal(alerts.length, 4, text)
})

test('an ordinary day produces nothing', async () => {
  const alerts = await forecastAlerts({ city: 'Москва', fetchImpl: fakeApi({ min: 8, max: 16, rain: 10, wind: 6, code: 2 }) })
  assert.deepEqual(alerts, [])
})

test('thresholds are configurable', async () => {
  const quiet = await forecastAlerts({ city: 'Москва', fetchImpl: fakeApi({ min: 5, max: 20, rain: 65, wind: 5, code: 61 }), thresholds: { rainPercent: 80 } })
  assert.deepEqual(quiet, [], 'при пороге 80% дождь с 65% не тревога')
  const strict = await forecastAlerts({ city: 'Москва', fetchImpl: fakeApi({ min: 5, max: 20, rain: 65, wind: 5, code: 61 }), thresholds: { tempMax: 15 } })
  assert.match(strict.join(' '), /\+20 °C/, 'свой порог жары работает')
  assert.equal(ALERT_DEFAULTS.rainPercent, 60, 'умолчания не изменились')
})

test('no city, an unknown city or a broken API return no warnings', async () => {
  assert.deepEqual(await forecastAlerts({ city: '' }), [])
  assert.deepEqual(await forecastAlerts({ city: 'Атлантида', fetchImpl: async () => ({ json: async () => ({}) }) }), [])
  const broken = await forecastAlerts({ city: 'Москва', fetchImpl: async () => { throw new Error('сеть легла') }, logger: { warn() {} } })
  assert.deepEqual(broken, [], 'ошибка сети не должна ломать дайджест')
})

test('the same warning is not repeated for both days', async () => {
  const alerts = await forecastAlerts({ city: 'Москва', fetchImpl: fakeApi({ min: -20, max: 10, rain: 5, wind: 5, code: 71 }) })
  assert.equal(alerts.length, 1, alerts.join('\n'))
  assert.match(alerts[0], /сегодня/)
})
