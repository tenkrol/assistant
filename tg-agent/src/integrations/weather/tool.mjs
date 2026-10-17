/**
 * Deterministic weather tool.
 *
 * Search results for weather are cached pages of arbitrary age: they produced
 * forecasts for the wrong day, which is worse than no answer. This tool asks a
 * weather API directly and returns values stamped with the local observation
 * time, so the model cannot confuse days.
 *
 * Primary source is Open-Meteo (no key, WMO codes); wttr.in is the fallback when
 * geocoding or the forecast call fails.
 */
import { connectionError, deadlineSignal } from '../connection.mjs'

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const WTTR_URL = 'https://wttr.in'

/** WMO weather codes as short Russian descriptions. */
const WMO = new Map([
  [0, 'ясно'],
  [1, 'преимущественно ясно'],
  [2, 'переменная облачность'],
  [3, 'пасмурно'],
  [45, 'туман'],
  [48, 'изморозь'],
  [51, 'слабая морось'],
  [53, 'морось'],
  [55, 'сильная морось'],
  [56, 'ледяная морось'],
  [57, 'сильная ледяная морось'],
  [61, 'слабый дождь'],
  [63, 'дождь'],
  [65, 'сильный дождь'],
  [66, 'ледяной дождь'],
  [67, 'сильный ледяной дождь'],
  [71, 'слабый снег'],
  [73, 'снег'],
  [75, 'сильный снег'],
  [77, 'снежная крупа'],
  [80, 'слабые ливни'],
  [81, 'ливни'],
  [82, 'сильные ливни'],
  [85, 'снежные ливни'],
  [86, 'сильные снежные ливни'],
  [95, 'гроза'],
  [96, 'гроза с градом'],
  [99, 'сильная гроза с градом'],
])

/** OpenAI-compatible tool definition handed to the chat model. */
export const WEATHER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'weather',
    description:
      'Текущая погода и прогноз на сегодня и завтра для города. Используй этот инструмент для любых вопросов о погоде — вместо web_search, потому что поиск отдаёт устаревшие страницы.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'Название города, например «Москва» или «Санкт-Петербург».' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}

/**
 * Build the weather tool.
 *
 * @param {object} options - tool options.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 */
export function createWeatherTool({ fetchImpl = globalThis.fetch, timeoutMs = 15000, logger } = {}) {
  const getJson = async (url, signal) => {
    const response = await fetchImpl(url, {
      signal: deadlineSignal(timeoutMs, signal),
      headers: { accept: 'application/json', 'user-agent': 'tg-agent/0.1' },
    })
    if (!response.ok) throw connectionError(`HTTP ${response.status}`, { provider: 'weather', status: response.status })
    return response.json()
  }

  /** Open-Meteo: geocode a city name, then read current conditions and two days. */
  const fromOpenMeteo = async (city, signal) => {
    const geocoded = await getJson(`${GEOCODING_URL}?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`, signal)
    const place = geocoded?.results?.[0]
    if (!place) return null
    const forecast = await getJson(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code'
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
      + '&timezone=auto&forecast_days=2',
      signal,
    )
    const current = forecast?.current
    const daily = forecast?.daily
    if (!current || !daily?.time?.length) throw new Error('empty forecast')
    logger?.debug('weather via open-meteo', { city, time: current.time })

    const lines = [
      `Погода: ${place.name}${place.country ? `, ${place.country}` : ''}`,
      `Местное время: ${current.time.replace('T', ' ')} (${forecast.timezone})`,
      `Сейчас: ${round(current.temperature_2m)} °C (ощущается ${round(current.apparent_temperature)} °C), ${describe(current.weather_code)}, `
      + `влажность ${round(current.relative_humidity_2m)}%, ветер ${round(current.wind_speed_10m)} км/ч`,
    ]
    for (let index = 0; index < daily.time.length; index++) {
      const label = index === 0 ? 'Сегодня' : 'Завтра'
      lines.push(
        `${label} (${daily.time[index]}): от ${round(daily.temperature_2m_min?.[index])} до ${round(daily.temperature_2m_max?.[index])} °C, `
        + `${describe(daily.weather_code?.[index])}${daily.precipitation_probability_max?.[index] != null ? `, осадки до ${round(daily.precipitation_probability_max[index])}%` : ''}`,
      )
    }
    lines.push('Источник: Open-Meteo')
    return lines.join('\n')
  }

  /** wttr.in fallback: a different provider, so a single outage is survivable. */
  const fromWttr = async (city, signal) => {
    const data = await getJson(`${WTTR_URL}/${encodeURIComponent(city)}?format=j1`, signal)
    const current = data?.current_condition?.[0]
    const today = data?.weather?.[0]
    if (!current) return null
    const area = data?.nearest_area?.[0]
    const name = area?.areaName?.[0]?.value ?? city
    const country = area?.country?.[0]?.value
    logger?.debug('weather via wttr.in', { city, observation: current.observation_time })
    const lines = [
      `Погода: ${name}${country ? `, ${country}` : ''}`,
      `Наблюдение: ${today?.date ?? 'сегодня'}, ${current.observation_time} местного времени`,
      `Сейчас: ${current.temp_C} °C (ощущается ${current.FeelsLikeC} °C), ${current.weatherDesc?.[0]?.value ?? 'без описания'}, `
      + `влажность ${current.humidity}%, ветер ${current.windspeedKmph} км/ч`,
    ]
    if (today) lines.push(`Сегодня (${today.date}): от ${today.mintempC} до ${today.maxtempC} °C`)
    const tomorrow = data?.weather?.[1]
    if (tomorrow) lines.push(`Завтра (${tomorrow.date}): от ${tomorrow.mintempC} до ${tomorrow.maxtempC} °C`)
    lines.push('Источник: wttr.in')
    return lines.join('\n')
  }

  return {
    definition: WEATHER_TOOL_DEFINITION,
    /**
     * Run one lookup; failures are returned as text for the model, never thrown.
     *
     * @param {object} args - `city` is required.
     * @param {AbortSignal} [signal] - cancels both attempts.
     * @returns {Promise<string>} a compact report or an error description.
     */
    async execute({ city } = {}, signal) {
      const name = String(city ?? '').trim()
      if (name === '') return 'Ошибка инструмента weather: укажите город.'
      if (name.length > 100) return 'Ошибка инструмента weather: слишком длинное название города.'
      const failures = []
      for (const [source, lookup] of [['open-meteo', fromOpenMeteo], ['wttr.in', fromWttr]]) {
        try {
          const report = await lookup(name, signal)
          if (report) return report
          failures.push(`${source}: город не найден`)
        } catch (error) {
          if (signal?.aborted) throw error
          logger?.warn('weather source failed', { source, city: name, error })
          failures.push(`${source}: ${error?.message ?? error}`)
        }
      }
      return `Ошибка инструмента weather (${failures.join('; ')}). Сообщи пользователю, что не удалось получить погоду, и не выдумывай данные.`
    },
  }
}

const describe = (code) => WMO.get(Number(code)) ?? `код ${code}`
const round = (value) => (value == null ? '—' : Math.round(Number(value) * 10) / 10)
