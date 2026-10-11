import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSmartHomeTool,
  DEFAULT_ALLOWED_DOMAINS,
  FORBIDDEN_DOMAINS,
  HOME_TOOL_DEFINITION,
  SUPPORTED_DOMAINS,
} from '../src/smart-home.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const BASE = 'http://ha.test:8123'
const TOKEN = 'test-token'

/** `/api/states` entry as Home Assistant returns it. */
function entity(entityId, state, attributes = {}) {
  return { entity_id: entityId, state, attributes, last_changed: '2026-10-07T00:00:00+00:00' }
}

/** The fixture home: supported domains plus one domain the tool must ignore. */
function homeEntities() {
  return [
    entity('light.kitchen', 'on', { friendly_name: 'Кухня', brightness: 153, color_temp_kelvin: 2700 }),
    entity('light.bedroom', 'off', { friendly_name: 'Спальня' }),
    entity('switch.kettle', 'on', { friendly_name: 'Чайник' }),
    entity('climate.home', 'heat', { friendly_name: 'Климат', current_temperature: 21.5, temperature: 23 }),
    entity('sensor.temperature', '21.5', { friendly_name: 'Температура', unit_of_measurement: '°C' }),
    entity('sensor.leak', 'unavailable', { friendly_name: 'Датчик протечки' }),
    entity('scene.evening', 'unknown', { friendly_name: 'Вечер' }),
    entity('automation.noise', 'on', { friendly_name: 'Автоматизация' }),
  ]
}

/** JSON response double with the fields the tool reads. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

/** Body sent as-is, for the "unparseable JSON" case. */
function rawResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => body,
  }
}

/**
 * A fetch double that routes by URL and records every call.
 *
 * No sockets: the exact URL, method, headers and parsed body are all available
 * for assertions, and `/api/states` can be forced to a status or a bad body.
 */
function stubFetch({ entities = homeEntities(), serviceStates = [], statesStatus = 200, serviceStatus = 200, statesBody } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    const href = String(url)
    calls.push({
      url: href,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    if (href.includes('/api/services/')) {
      if (serviceStatus !== 200) return jsonResponse({ message: 'nope' }, serviceStatus)
      return jsonResponse(serviceStates)
    }
    if (href.endsWith('/api/states')) {
      if (statesStatus !== 200) return jsonResponse({}, statesStatus)
      if (statesBody !== undefined) return rawResponse(statesBody)
      return jsonResponse(entities)
    }
    throw new Error(`unexpected URL ${href}`)
  }
  impl.calls = calls
  return impl
}

const makeTool = (options = {}) => createSmartHomeTool({ baseUrl: BASE, token: TOKEN, logger: silentLogger, ...options })

test('home list groups supported entities by type and sorts names', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  const output = await tool.execute({ action: 'list' })

  assert.match(output, /^Устройства \(7\):/)
  assert.match(output, /Свет: Кухня \(on\), Спальня \(off\)/)
  assert.match(output, /Выключатели: Чайник \(on\)/)
  assert.match(output, /Климат: Климат \(heat\)/)
  assert.match(output, /Датчики: Датчик протечки \(unavailable\), Температура \(21\.5\)/)
  assert.match(output, /Сцены: Вечер \(unknown\)/)
  // Domains outside the supported set never reach the model.
  assert.doesNotMatch(output, /automation/)
  // Groups follow the fixed domain order.
  assert.ok(output.indexOf('Свет:') < output.indexOf('Выключатели:'))
  assert.ok(output.indexOf('Выключатели:') < output.indexOf('Климат:'))
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, `${BASE}/api/states`)
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${TOKEN}`)
})

test('home list is cached for 30 seconds', async () => {
  let clock = 1_000
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl, now: () => clock })

  await tool.execute({ action: 'list' })
  assert.equal(fetchImpl.calls.length, 1)
  await tool.execute({ action: 'list' })
  assert.equal(fetchImpl.calls.length, 1, 'the second list must come from the cache')

  clock += 30_001
  await tool.execute({ action: 'list' })
  assert.equal(fetchImpl.calls.length, 2, 'after the TTL the list is refetched')
})

test('home list truncates to 30 entities', async () => {
  const many = Array.from({ length: 40 }, (_, index) => entity(`light.lamp_${index}`, 'off', { friendly_name: `Лампа ${index}` }))
  const tool = makeTool({ fetchImpl: stubFetch({ entities: many }) })

  const output = await tool.execute({ action: 'list' })

  assert.match(output, /^Устройства \(30 из 40\):/)
  assert.equal(output.split('\n').length, 2)
})

test('home state describes a light with brightness and colour temperature', async () => {
  const tool = makeTool({ fetchImpl: stubFetch() })

  assert.equal(await tool.execute({ action: 'state', query: 'Кухня' }), 'Кухня: включено, яркость 60%, цвет тёплый')
})

test('home state describes climate and sensor attributes', async () => {
  const tool = makeTool({ fetchImpl: stubFetch() })

  assert.equal(await tool.execute({ action: 'state', query: 'Климат' }), 'Климат: нагрев, сейчас 21.5 °C, цель 23 °C')
  assert.equal(await tool.execute({ action: 'state', query: 'sensor.temperature' }), 'Температура: 21.5 °C')
})

test('home state reports an unavailable entity', async () => {
  const tool = makeTool({ fetchImpl: stubFetch() })

  assert.equal(await tool.execute({ action: 'state', query: 'Датчик протечки' }), 'Датчик протечки: недоступно')
})

test('home resolves a device by entity id, exact name and substring, ignoring case', async () => {
  const tool = makeTool({ fetchImpl: stubFetch() })

  assert.equal(await tool.execute({ action: 'state', query: 'light.bedroom' }), 'Спальня: выключено')
  assert.equal(await tool.execute({ action: 'state', query: 'СПАЛЬНЯ' }), 'Спальня: выключено')
  assert.equal(await tool.execute({ action: 'state', query: 'кух' }), 'Кухня: включено, яркость 60%, цвет тёплый')
})

test('home asks to clarify when several devices match', async () => {
  const entities = [entity('light.hall', 'on', { friendly_name: 'Свет' }), entity('light.office', 'off', { friendly_name: 'Свет' })]
  const fetchImpl = stubFetch({ entities, serviceStates: [entity('light.hall', 'on', { friendly_name: 'Свет' })] })
  const tool = makeTool({ fetchImpl })

  const output = await tool.execute({ action: 'control', query: 'Свет', domain: 'light', service: 'turn_on' })

  assert.match(output, /найдено несколько устройств/)
  assert.match(output, /light\.hall/)
  assert.match(output, /light\.office/)
  assert.match(output, /Уточните entity_id/)
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST').length, 0, 'an ambiguous name must not control anything')
})

test('home reports an unknown device instead of guessing', async () => {
  const tool = makeTool({ fetchImpl: stubFetch() })

  const output = await tool.execute({ action: 'state', query: 'Гараж' })

  assert.match(output, /Ошибка инструмента home/)
  assert.match(output, /«Гараж» не найдено/)
})

test('home control posts the service call with auth, entity id and service data', async () => {
  const fetchImpl = stubFetch({ serviceStates: [entity('light.kitchen', 'on', { friendly_name: 'Кухня', brightness: 153 })] })
  const tool = makeTool({ fetchImpl })

  const output = await tool.execute({
    action: 'control',
    query: 'Кухня',
    domain: 'light',
    service: 'turn_on',
    serviceData: { brightness_pct: 60 },
  })

  assert.equal(output, 'Готово: Кухня — включено.')
  const post = fetchImpl.calls.find((call) => call.method === 'POST')
  assert.equal(post.url, `${BASE}/api/services/light/turn_on`)
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(post.headers['content-type'], 'application/json')
  assert.equal(post.headers.accept, 'application/json')
  assert.deepEqual(post.body, { brightness_pct: 60, entity_id: 'light.kitchen' })
  // The entity list request carries the same credential header.
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${TOKEN}`)
})

test('home control cannot redirect the call through serviceData.entity_id', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  await tool.execute({
    action: 'control',
    query: 'Кухня',
    domain: 'light',
    service: 'turn_on',
    serviceData: { entity_id: 'light.bedroom' },
  })

  const post = fetchImpl.calls.find((call) => call.method === 'POST')
  assert.deepEqual(post.body, { entity_id: 'light.kitchen' })
})

test('home control falls back to the service name when Home Assistant reports no state', async () => {
  const fetchImpl = stubFetch({ serviceStates: [] })
  const tool = makeTool({ fetchImpl })

  const output = await tool.execute({ action: 'control', query: 'Спальня', domain: 'light', service: 'turn_off' })

  assert.equal(output, 'Готово: Спальня — выключено.')
})

test('home refuses forbidden domains without touching the API', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  for (const domain of ['shell_command', 'python_script', 'hassio', 'homeassistant']) {
    const output = await tool.execute({ action: 'control', query: 'Кухня', domain, service: 'turn_on' })
    assert.match(output, /Ошибка инструмента home/)
    assert.match(output, /запрещён/)
  }
  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'homeassistant', service: 'restart' }), /запрещён/)
  assert.equal(fetchImpl.calls.length, 0, 'a denied domain must be rejected before any request')
})

test('FORBIDDEN_DOMAINS covers command execution and restart', () => {
  for (const domain of ['shell_command', 'python_script', 'hassio', 'homeassistant']) {
    assert.ok(FORBIDDEN_DOMAINS.includes(domain), `${domain} must be forbidden`)
  }
})

test('home refuses a domain outside allowedDomains without touching the API', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  // `sensor` is readable but deliberately absent from the default write list.
  const output = await tool.execute({ action: 'control', query: 'Температура', domain: 'sensor', service: 'turn_on' })

  assert.match(output, /домен «sensor» не разрешён/)
  assert.match(output, new RegExp(DEFAULT_ALLOWED_DOMAINS.join(', ')))
  assert.equal(fetchImpl.calls.length, 0)
})

test('home honours a custom allowedDomains list', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl, allowedDomains: ['light'] })

  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'climate', service: 'turn_on' }), /не разрешён/)
  assert.equal(fetchImpl.calls.length, 0)
  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'light', service: 'turn_on' }), /Готово: Кухня/)
})

test('home refuses a malformed service path without touching the API', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'light', service: '../../states' }), /некорректный сервис/)
  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'light', service: '' }), /укажите service/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('home control requires an object serviceData', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'light', service: 'turn_on', serviceData: [1, 2] }), /serviceData должен быть объектом/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('home control asks for a device when query is missing', async () => {
  const tool = makeTool({ fetchImpl: stubFetch() })

  assert.match(await tool.execute({ action: 'control', domain: 'light', service: 'turn_on' }), /укажите устройство/)
})

test('home allowedEntities restricts control and the visible list', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl, allowedEntities: ['light.kitchen'] })

  const refused = await tool.execute({ action: 'control', query: 'Спальня', domain: 'light', service: 'turn_on' })
  assert.match(refused, /allowedEntities/)
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST').length, 0, 'a denied entity must not receive a service call')

  const list = await tool.execute({ action: 'list' })
  assert.match(list, /^Устройства \(1\):/)
  assert.doesNotMatch(list, /Спальня/)

  assert.match(await tool.execute({ action: 'control', query: 'Кухня', domain: 'light', service: 'turn_off' }), /Готово: Кухня/)
})

test('home scene turns a scene on', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  const output = await tool.execute({ action: 'scene', query: 'Вечер' })

  assert.equal(output, 'Готово: сцена «Вечер» включена.')
  const post = fetchImpl.calls.find((call) => call.method === 'POST')
  assert.equal(post.url, `${BASE}/api/services/scene/turn_on`)
  assert.deepEqual(post.body, { entity_id: 'scene.evening' })
})

test('home reports an unknown action without touching the API', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })

  assert.match(await tool.execute({ action: 'reboot' }), /неизвестное действие «reboot»/)
  assert.match(await tool.execute({}), /неизвестное действие/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('home reports a missing token or baseUrl without touching the API', async () => {
  const fetchImpl = stubFetch()
  assert.match(await createSmartHomeTool({ baseUrl: BASE, token: '   ', fetchImpl }).execute({ action: 'list' }), /не задан токен/)
  assert.match(await createSmartHomeTool({ baseUrl: '', token: TOKEN, fetchImpl }).execute({ action: 'list' }), /не задан адрес/)
  assert.match(await createSmartHomeTool({ baseUrl: 'ftp://ha', token: TOKEN, fetchImpl }).execute({ action: 'list' }), /должен быть http/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('home normalizes a baseUrl without a scheme', async () => {
  const fetchImpl = stubFetch()
  const tool = createSmartHomeTool({ baseUrl: 'ha.test:8123/', token: TOKEN, fetchImpl, logger: silentLogger })

  await tool.execute({ action: 'list' })

  assert.equal(fetchImpl.calls[0].url, 'http://ha.test:8123/api/states')
})

test('home reports HTTP errors as text', async () => {
  assert.match(await makeTool({ fetchImpl: stubFetch({ statesStatus: 401 }) }).execute({ action: 'list' }), /HTTP 401/)
  assert.match(await makeTool({ fetchImpl: stubFetch({ statesStatus: 404 }) }).execute({ action: 'list' }), /HTTP 404/)
  assert.match(await makeTool({ fetchImpl: stubFetch({ serviceStatus: 401 }) }).execute({ action: 'control', query: 'Кухня', domain: 'light', service: 'turn_on' }), /HTTP 401/)
})

test('home reports a transport failure instead of throwing', async () => {
  const tool = makeTool({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })

  const output = await tool.execute({ action: 'list' })

  assert.match(output, /Ошибка инструмента home/)
  assert.match(output, /не удалось связаться/)
})

test('home reports a timeout signalled by fetch', async () => {
  const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const tool = makeTool({ fetchImpl: async () => { throw timeoutError } })

  const output = await tool.execute({ action: 'list' })

  assert.match(output, /время ожидания/)
})

test('home aborts a hanging request after timeoutMs', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    // Node 22: the timer behind AbortSignal.timeout() is unref'd, so the event
    // loop can empty before the abort fires and the test gets cancelled. This
    // ref'd guard keeps the loop alive; the abort listener still rejects first.
    const guard = setTimeout(() => reject(new Error('stub never settled')), 5000)
    init.signal.addEventListener('abort', () => {
      clearTimeout(guard)
      reject(init.signal.reason)
    }, { once: true })
  })
  const tool = makeTool({ fetchImpl, timeoutMs: 20 })

  const output = await tool.execute({ action: 'list' })

  assert.match(output, /Ошибка инструмента home/)
  assert.match(output, /время ожидания/)
})

test('home reports an unparseable JSON body', async () => {
  const tool = makeTool({ fetchImpl: stubFetch({ statesBody: '<html>gateway error</html>' }) })

  const output = await tool.execute({ action: 'list' })

  assert.match(output, /Ошибка инструмента home/)
  assert.match(output, /некорректный JSON/)
})

test('home never throws, whatever the arguments or the transport', async () => {
  const tool = makeTool({ fetchImpl: async () => { throw new Error('boom') } })

  await assert.doesNotReject(() => tool.execute({ action: 'state', query: {} }))
  await assert.doesNotReject(() => tool.execute({ action: 'control', query: 'Кухня', domain: 'light', service: 'turn_on' }))
})

test('home accepts both a plain signal and a { signal } context', async () => {
  const fetchImpl = stubFetch()
  const tool = makeTool({ fetchImpl })
  const controller = new AbortController()

  assert.match(await tool.execute({ action: 'list' }, controller.signal), /Устройства/)
  assert.match(await tool.execute({ action: 'state', query: 'Кухня' }, { signal: controller.signal }), /Кухня: включено/)
})

test('home reports a caller cancellation as text', async () => {
  const controller = new AbortController()
  const fetchImpl = async () => {
    controller.abort()
    throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  }
  const tool = makeTool({ fetchImpl })

  const output = await tool.execute({ action: 'list' }, controller.signal)

  assert.match(output, /Ошибка инструмента home/)
  assert.match(output, /запрос отменён/)
})

test('HOME_TOOL_DEFINITION describes the home function in Russian', () => {
  assert.equal(HOME_TOOL_DEFINITION.type, 'function')
  assert.equal(HOME_TOOL_DEFINITION.function.name, 'home')
  assert.equal(HOME_TOOL_DEFINITION.function.parameters.type, 'object')
  assert.deepEqual(HOME_TOOL_DEFINITION.function.parameters.required, ['action'])
  assert.deepEqual(HOME_TOOL_DEFINITION.function.parameters.properties.action.enum, ['list', 'state', 'control', 'scene'])
  assert.equal(HOME_TOOL_DEFINITION.function.parameters.properties.serviceData.type, 'object')
  assert.equal(HOME_TOOL_DEFINITION.function.parameters.additionalProperties, false)
  assert.match(HOME_TOOL_DEFINITION.function.description, /устройств/)
  assert.match(HOME_TOOL_DEFINITION.function.description, /включи свет на кухне/)
  assert.match(HOME_TOOL_DEFINITION.function.description, /какая температура дома/)
  assert.match(HOME_TOOL_DEFINITION.function.description, /выключи всё в спальне/)
})

test('SUPPORTED_DOMAINS and DEFAULT_ALLOWED_DOMAINS keep reads wider than writes', () => {
  for (const domain of ['light', 'switch', 'climate', 'cover', 'media_player', 'sensor', 'binary_sensor', 'scene']) {
    assert.ok(SUPPORTED_DOMAINS.includes(domain), `${domain} must be readable`)
  }
  assert.ok(SUPPORTED_DOMAINS.includes('sensor'))
  assert.ok(!DEFAULT_ALLOWED_DOMAINS.includes('sensor'))
  assert.ok(!DEFAULT_ALLOWED_DOMAINS.includes('binary_sensor'))
})
