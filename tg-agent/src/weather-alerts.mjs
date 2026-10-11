/**
 * Weather warnings for the morning digest: rain, frost, heat, wind.
 *
 * A separate module on purpose — the weather *tool* answers questions and its text
 * is part of the conversation, while alerts are thresholds the digest checks in
 * passing. Both read the same free Open-Meteo API, and a failure here must never
 * break the digest: the caller gets an empty list instead of an exception.
 */

/** Defaults: what is worth warning an ordinary person about. */
export const ALERT_DEFAULTS = {
  rainPercent: 60,
  tempMin: -15,
  tempMax: 30,
  windKmh: 40,
}

/** Human wording for the codes the API returns. */
function describe(code) {
  if (code == null) return ''
  if (code === 0) return 'ясно'
  if (code <= 3) return 'облачно'
  if (code <= 48) return 'туман'
  if (code <= 67) return 'дождь'
  if (code <= 77) return 'снег'
  if (code <= 82) return 'ливни'
  return 'гроза'
}

/**
 * Warnings for the next two days.
 *
 * @param {object} options - `{ city, fetchImpl, timeoutMs, thresholds, logger, now }`.
 * @returns {Promise<Array<string>>} short warnings, empty when nothing is unusual.
 */
export async function forecastAlerts({
  city,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  thresholds = {},
  timeZone = 'Europe/Moscow',
  logger,
} = {}) {
  const limits = { ...ALERT_DEFAULTS, ...thresholds }
  const place = String(city ?? '').trim()
  if (place === '') return []
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=&longitude=&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max`
  try {
    // Resolve the city first: the API needs coordinates.
    const geo = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=ru&format=json`, { signal: AbortSignal.timeout(timeoutMs) })
    const geoBody = await geo.json()
    const found = geoBody?.results?.[0]
    if (!found) return []
    const forecastUrl = url.replace('latitude=&longitude=', `latitude=${found.latitude}&longitude=${found.longitude}`)
      + `&timezone=${encodeURIComponent(timeZone)}&forecast_days=2`
    const response = await fetchImpl(forecastUrl, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.json()
    const daily = body?.daily
    if (!daily?.time?.length) return []
    const alerts = []
    for (let index = 0; index < daily.time.length; index++) {
      const when = index === 0 ? 'сегодня' : 'завтра'
      const min = Number(daily.temperature_2m_min?.[index])
      const max = Number(daily.temperature_2m_max?.[index])
      const rain = Number(daily.precipitation_probability_max?.[index])
      const wind = Number(daily.wind_speed_10m_max?.[index])
      const sky = describe(daily.weather_code?.[index])
      if (Number.isFinite(rain) && rain >= limits.rainPercent) {
        alerts.push(`${when} ${sky || 'осадки'} — вероятность ${Math.round(rain)}%, возьмите зонт`)
      } else if (sky === 'гроза' || sky === 'ливни') {
        alerts.push(`${when} ожидаются ${sky}`)
      }
      if (Number.isFinite(min) && min <= limits.tempMin) alerts.push(`${when} до ${Math.round(min)} °C — оденьтесь теплее`)
      if (Number.isFinite(max) && max >= limits.tempMax) alerts.push(`${when} до +${Math.round(max)} °C — берегите голову от солнца и пейте воду`)
      if (Number.isFinite(wind) && wind >= limits.windKmh) alerts.push(`${when} ветер до ${Math.round(wind)} км/ч`)
    }
    // Two days of the same warning is noise: keep the first mention of each kind.
    const seen = new Set()
    return alerts.filter((line) => {
      const kind = line.replace(/^(сегодня|завтра)\s/, '')
      if (seen.has(kind)) return false
      seen.add(kind)
      return true
    })
  } catch (error) {
    logger?.warn?.('weather alerts failed', { error: error?.message ?? error })
    return []
  }
}
