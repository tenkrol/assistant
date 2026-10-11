import assert from 'node:assert/strict'
import test from 'node:test'
import { createWeatherTool, WEATHER_TOOL_DEFINITION } from '../src/weather.mjs'
import { createWebTools } from '../src/web-tools.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Response shape `getJson` consumes: `ok`, `status` and an async `json()`. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }
}

/**
 * A fetch double that routes by URL and records every call.
 *
 * Routing by URL keeps both providers in one function: no ports, no sockets,
 * and the exact URL the tool built is available for assertions.
 */
function routedFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const href = String(url)
    const index = calls.length
    calls.push({ url: href, init })
    return handler(href, index)
  }
  impl.calls = calls
  return impl
}

/** Open-Meteo geocoding answer for a place that exists. */
function geocodingBody(overrides = {}) {
  return {
    results: [
      {
        name: 'Москва',
        latitude: 55.7558,
        longitude: 37.6173,
        country: 'Россия',
        timezone: 'Europe/Moscow',
        ...overrides,
      },
    ],
  }
}

/** Open-Meteo forecast answer with current conditions plus two days. */
function forecastBody() {
  return {
    timezone: 'Europe/Moscow',
    current: {
      time: '2026-10-06T00:45',
      temperature_2m: 3.4,
      apparent_temperature: 0.2,
      relative_humidity_2m: 81,
      wind_speed_10m: 12.5,
      weather_code: 3,
    },
    daily: {
      time: ['2026-10-06', '2026-10-07'],
      temperature_2m_max: [7.1, 8.6],
      temperature_2m_min: [1.2, 2.4],
      precipitation_probability_max: [20, 65],
      weather_code: [3, 61],
    },
  }
}

test('weather reports Open-Meteo current conditions and a two-day forecast', async () => {
  const fetchImpl = routedFetch((url) => {
    if (url.includes('/v1/search')) return jsonResponse(geocodingBody())
    if (url.includes('/v1/forecast')) return jsonResponse(forecastBody())
    throw new Error(`unexpected URL ${url}`)
  })
  const tool = createWeatherTool({ fetchImpl, logger: silentLogger })

  const output = await tool.execute({ city: 'Москва' })

  // Place, local observation time and current values.
  assert.match(output, /Погода: Москва, Россия/)
  assert.match(output, /Местное время: 2026-10-06 00:45 \(Europe\/Moscow\)/)
  assert.match(output, /Сейчас: 3\.4 °C \(ощущается 0\.2 °C\), пасмурно, влажность 81%, ветер 12\.5 км\/ч/)
  // WMO code 3 is "пасмурно", code 61 is "слабый дождь"; both days carry a date.
  assert.match(output, /Сегодня \(2026-10-06\): от 1\.2 до 7\.1 °C, пасмурно, осадки до 20%/)
  assert.match(output, /Завтра \(2026-10-07\): от 2\.4 до 8\.6 °C, слабый дождь, осадки до 65%/)
  assert.match(output, /Источник: Open-Meteo/)
  assert.equal(fetchImpl.calls.length, 2)
})

test('weather geocodes by name and asks the forecast for the place and auto timezone', async () => {
  const fetchImpl = routedFetch((url) =>
    (url.includes('/v1/search') ? jsonResponse(geocodingBody()) : jsonResponse(forecastBody())))
  const tool = createWeatherTool({ fetchImpl, logger: silentLogger })

  await tool.execute({ city: 'Санкт-Петербург' })

  const [geocoding, forecast] = fetchImpl.calls.map((call) => call.url)
  assert.match(geocoding, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/)
  assert.match(geocoding, /name=%D0%A1%D0%B0%D0%BD%D0%BA%D1%82/)
  assert.match(geocoding, /count=1/)
  assert.match(geocoding, /language=ru/)
  assert.match(forecast, /latitude=55\.7558/)
  assert.match(forecast, /longitude=37\.6173/)
  assert.match(forecast, /timezone=auto/)
  assert.match(forecast, /forecast_days=2/)
  assert.match(forecast, /current=temperature_2m/)
  assert.match(forecast, /daily=temperature_2m_max/)
})

test('weather falls back to wttr.in when geocoding finds no city', async () => {
  const wttrBody = {
    current_condition: [
      {
        observation_time: '10:30 PM',
        temp_C: '4',
        FeelsLikeC: '1',
        weatherDesc: [{ value: 'Пасмурно' }],
        humidity: '80',
        windspeedKmph: '11',
      },
    ],
    weather: [
      { date: '2026-10-06', mintempC: '2', maxtempC: '7' },
      { date: '2026-10-07', mintempC: '3', maxtempC: '9' },
    ],
    nearest_area: [{ areaName: [{ value: 'Москва' }], country: [{ value: 'Россия' }] }],
  }
  const fetchImpl = routedFetch((url) => {
    if (url.includes('/v1/search')) return jsonResponse({ results: [] })
    if (url.includes('wttr.in')) return jsonResponse(wttrBody)
    throw new Error(`unexpected URL ${url}`)
  })
  const tool = createWeatherTool({ fetchImpl, logger: silentLogger })

  const output = await tool.execute({ city: 'Москва' })

  assert.match(output, /Погода: Москва, Россия/)
  assert.match(output, /Наблюдение: 2026-10-06, 10:30 PM местного времени/)
  assert.match(output, /Сейчас: 4 °C \(ощущается 1 °C\), Пасмурно, влажность 80%, ветер 11 км\/ч/)
  assert.match(output, /Сегодня \(2026-10-06\): от 2 до 7 °C/)
  assert.match(output, /Завтра \(2026-10-07\): от 3 до 9 °C/)
  assert.match(output, /Источник: wttr\.in/)
  // The fallback request goes to the documented wttr.in JSON endpoint.
  assert.match(fetchImpl.calls[1].url, /^https:\/\/wttr\.in\/.+format=j1/)
})

test('weather reports a failure instead of throwing when every source fails', async () => {
  const fetchImpl = routedFetch((url) => {
    if (url.includes('/v1/search')) return jsonResponse({ results: [] })
    if (url.includes('wttr.in')) return jsonResponse({ error: 'boom' }, 500)
    throw new Error(`unexpected URL ${url}`)
  })
  const tool = createWeatherTool({ fetchImpl, logger: silentLogger })

  const output = await tool.execute({ city: 'Атлантида' })

  assert.match(output, /Ошибка инструмента weather/)
  assert.match(output, /город не найден/)
  assert.match(output, /не выдумывай данные/)
})

test('weather rejects an empty or over-long city without touching the network', async () => {
  const fetchImpl = routedFetch(() => {
    throw new Error('fetch must not be called for invalid input')
  })
  const tool = createWeatherTool({ fetchImpl, logger: silentLogger })

  assert.match(await tool.execute({}), /Ошибка инструмента weather: укажите город/)
  assert.match(await tool.execute({ city: '   ' }), /Ошибка инструмента weather: укажите город/)
  assert.match(await tool.execute({ city: 'x'.repeat(101) }), /Ошибка инструмента weather: слишком длинное название города/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('WEATHER_TOOL_DEFINITION describes a weather function with a required city', () => {
  assert.equal(WEATHER_TOOL_DEFINITION.type, 'function')
  assert.equal(WEATHER_TOOL_DEFINITION.function.name, 'weather')
  assert.equal(WEATHER_TOOL_DEFINITION.function.parameters.type, 'object')
  assert.deepEqual(WEATHER_TOOL_DEFINITION.function.parameters.required, ['city'])
  assert.equal(WEATHER_TOOL_DEFINITION.function.parameters.properties.city.type, 'string')
  assert.equal(WEATHER_TOOL_DEFINITION.function.parameters.additionalProperties, false)
  assert.match(WEATHER_TOOL_DEFINITION.function.description, /погод/i)
})

test('createWebTools registers the weather tool and routes calls to it', async () => {
  const weatherTool = createWeatherTool({
    fetchImpl: routedFetch(() => {
      throw new Error('the integration test must not call the network')
    }),
    logger: silentLogger,
  })
  const tools = createWebTools({ apiKey: 'x', extraTools: [weatherTool], logger: silentLogger })

  assert.deepEqual(tools.definitions.map((definition) => definition.function.name), ['web_search', 'web_fetch', 'weather'])
  assert.equal(tools.definitions[2], WEATHER_TOOL_DEFINITION)

  // A distinct fake proves `execute` dispatches to the extra tool itself.
  const seen = []
  const fake = {
    definition: { type: 'function', function: { name: 'weather', parameters: { type: 'object' } } },
    execute: async (args) => {
      seen.push(args)
      return `погода для ${args.city}`
    },
  }
  const fakedTools = createWebTools({ apiKey: 'x', extraTools: [fake], logger: silentLogger })
  assert.deepEqual(fakedTools.definitions.map((definition) => definition.function.name), ['web_search', 'web_fetch', 'weather'])
  assert.equal(await fakedTools.execute('weather', { city: 'Пермь' }), 'погода для Пермь')
  assert.deepEqual(seen, [{ city: 'Пермь' }])
})
