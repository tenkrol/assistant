/**
 * Smart-home control through Home Assistant's REST API.
 *
 * Why Home Assistant and not "Yandex Smart Home" directly: Yandex has no public
 * API that lets a third party *control* the devices Alice sees. What Yandex
 * publishes is the smart-home device model that a skill or a device maker feeds
 * into its cloud (https://yandex.ru/dev/dialogs/smart-home/doc/ru/concepts/general-concept),
 * and that is a one-way integration, not a control endpoint for a bot. The only
 * supported path from a self-hosted hub is the "Yandex Smart Home" integration for
 * Home Assistant (https://github.com/dext0r/yandex_smart_home): Home Assistant
 * owns the devices, the integration publishes them to Alice, and Alice's commands
 * are executed by Home Assistant. So this bot controls Home Assistant, and it is
 * Home Assistant that makes the devices visible to Alice in the first place.
 *
 * Home Assistant exposes a documented, stable REST API with a long-lived access
 * token (https://developers.home-assistant.io/docs/api/rest/). The fields this
 * module uses:
 *   - `GET /api/states` — an array of state objects, each with `entity_id`,
 *     `state`, `last_changed` and `attributes`; `attributes.friendly_name` is the
 *     human name shown to the user.
 *   - `GET /api/states/<entity_id>` — one state object, 404 when unknown (not used
 *     here: reads go through the 30-second entity cache).
 *   - `POST /api/services/<domain>/<service>` — runs a service. The body is the
 *     service data plus `entity_id`; the reply is the list of states that changed
 *     while the service ran, which is what the confirmation text reports.
 * All calls carry `Authorization: Bearer <token>` and `content-type: application/json`.
 *
 * The tool is deliberately narrow. Reads are grouped over a fixed set of display
 * domains (light, switch, climate, cover, media_player, sensor, binary_sensor,
 * scene); writes are checked against `allowedDomains` (default: light, switch,
 * scene, climate, cover, media_player), against an optional `allowedEntities`
 * list, and against an explicit denylist of domains that can run host commands or
 * reconfigure Home Assistant. A model must never be able to reach shell_command,
 * python_script, hassio or homeassistant.restart through this tool.
 *
 * Nothing here throws: every failure comes back as text that starts with
 * "Ошибка инструмента home: ...", exactly as in src/weather.mjs.
 */
import { connectionError, deadlineSignal, isTimeoutError } from '../connection.mjs'

/** Domains the tool is willing to read and show to the model. */
export const SUPPORTED_DOMAINS = ['light', 'switch', 'climate', 'cover', 'media_player', 'sensor', 'binary_sensor', 'scene']

/** Domains a service call is allowed to target unless the caller overrides them. */
export const DEFAULT_ALLOWED_DOMAINS = ['light', 'switch', 'scene', 'climate', 'cover', 'media_player']

/**
 * Domains that are never allowed to receive a service call.
 *
 * `shell_command` and `python_script` execute arbitrary code on the Home
 * Assistant host, `command_line`/`rest_command` run host commands or outbound
 * requests, `hassio` drives the supervisor and `homeassistant` owns
 * restart/stop/reload. A denied domain is rejected before any network request.
 */
export const FORBIDDEN_DOMAINS = ['shell_command', 'python_script', 'pyscript', 'command_line', 'rest_command', 'hassio', 'homeassistant']

/** Human group titles for `list`, in display order. */
const DOMAIN_LABELS = {
  light: 'Свет',
  switch: 'Выключатели',
  climate: 'Климат',
  cover: 'Шторы',
  media_player: 'Медиаплееры',
  sensor: 'Датчики',
  binary_sensor: 'Бинарные датчики',
  scene: 'Сцены',
}

/** At most this many entities in one `list` answer. */
const LIST_LIMIT = 30

/** The entity list is reused for this long, so a question costs no API call. */
const CACHE_TTL_MS = 30_000

/** Short labels for `state` and for control confirmations. */
const STATE_LABELS = {
  on: 'включено',
  off: 'выключено',
  open: 'открыто',
  closed: 'закрыто',
  opening: 'открывается',
  closing: 'закрывается',
  playing: 'играет',
  paused: 'пауза',
  idle: 'простой',
  standby: 'ожидание',
  buffering: 'буферизация',
  heat: 'нагрев',
  cool: 'охлаждение',
  auto: 'авто',
  dry: 'осушение',
  fan_only: 'вентиляция',
  heat_cool: 'нагрев/охлаждение',
  unavailable: 'недоступно',
  unknown: 'состояние неизвестно',
}

/** Last-resort confirmation when Home Assistant reports no changed state. */
const SERVICE_RESULTS = {
  turn_on: 'включено',
  turn_off: 'выключено',
  toggle: 'переключено',
  open_cover: 'открыто',
  close_cover: 'закрыто',
  set_temperature: 'температура задана',
  set_hvac_mode: 'режим задан',
  volume_set: 'громкость задана',
  media_play: 'воспроизведение',
  media_pause: 'пауза',
}

const SLUG = /^[a-z0-9_]{1,64}$/

/** OpenAI-compatible tool definition handed to the chat model. */
export const HOME_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'home',
    description:
      'Управление умным домом через Home Assistant (его же видит Алиса через интеграцию Yandex Smart Home): список устройств, '
      + 'состояние, включение и выключение, сцены. Вызывай для любых просьб про устройства дома: «включи свет на кухне», '
      + '«какая температура дома», «выключи всё в спальне», «запусти сцену Вечер». Сначала action="list" или "state", чтобы узнать '
      + 'точные названия устройств, затем action="control" с domain и service. Не выдумывай устройства и их состояния — '
      + 'если инструмент вернул ошибку, сообщи её пользователю.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'state', 'control', 'scene'],
          description: 'list — список устройств; state — состояние одного устройства; control — команда устройству; scene — запустить сцену.',
        },
        query: {
          type: 'string',
          description: 'Название устройства, как его называет пользователь («Кухня», «свет в спальне»), либо точный entity_id (light.kitchen). Регистр не важен.',
        },
        domain: {
          type: 'string',
          description: 'Домен устройства для control, например light, switch, climate, cover, media_player, scene.',
        },
        service: {
          type: 'string',
          description: 'Сервис для control, например turn_on, turn_off, toggle, set_temperature, open_cover, close_cover.',
        },
        serviceData: {
          type: 'object',
          description: 'Дополнительные параметры сервиса, например {"brightness_pct": 60} для света или {"temperature": 23} для климата.',
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
}

/**
 * Build the smart-home tool.
 *
 * @param {object} [options] - tool options.
 * @param {string} [options.baseUrl] - Home Assistant root, e.g. `http://homeassistant.local:8123`; a missing scheme becomes `http://`.
 * @param {string} [options.token] - Home Assistant long-lived access token.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation; tests inject a stub.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 * @param {string[]} [options.allowedDomains] - domains a service call may target.
 * @param {string[]} [options.allowedEntities] - entity ids the tool may control; an empty list means "all".
 * @param {() => number} [options.now] - clock in milliseconds, injected by tests for the cache.
 * @returns {{definition: object, execute: (args: object, context?: object|AbortSignal) => Promise<string>}}
 */
export function createSmartHomeTool({
  baseUrl = '',
  token = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  logger,
  allowedDomains = DEFAULT_ALLOWED_DOMAINS,
  allowedEntities = [],
  now = () => Date.now(),
} = {}) {
  const writeDomains = new Set(
    (Array.isArray(allowedDomains) ? allowedDomains : DEFAULT_ALLOWED_DOMAINS).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  )
  const writeEntities = new Set(
    (Array.isArray(allowedEntities) ? allowedEntities : []).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  )
  /** @type {{at: number, entities: Array<object>|null}} */
  const cache = { at: 0, entities: null }

  /** Resolve `baseUrl` on every call so a misconfiguration is reported, not thrown. */
  const resolveBase = () => {
    const raw = String(baseUrl ?? '').trim()
    if (raw === '') return { error: 'не задан адрес Home Assistant (baseUrl).' }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    try {
      const url = new URL(withScheme)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { error: `адрес Home Assistant должен быть http(s), получено «${raw}».` }
      }
      return { base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
    } catch {
      return { error: `некорректный адрес Home Assistant: «${raw}».` }
    }
  }

  /** One REST call; HTTP and transport failures become Russian error text. */
  const request = async (base, path, { method = 'GET', body, signal } = {}) => {
    const combined = deadlineSignal(timeoutMs, signal)
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        signal: combined,
        headers: {
          authorization: `Bearer ${String(token).trim()}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      if (signal?.aborted) throw connectionError('запрос отменён.', { provider: 'home' })
      if (isTimeoutError(error) || combined.aborted) throw connectionError(`превышено время ожидания ответа Home Assistant (${timeoutMs} мс).`, { provider: 'home', temporary: true })
      throw connectionError(`не удалось связаться с Home Assistant (${error?.message ?? error}).`, { provider: 'home', cause: error })
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw connectionError(`Home Assistant отклонил токен (HTTP ${response.status}). Проверьте HA_TOKEN.`, { provider: 'home', status: response.status })
      if (response.status === 404) throw connectionError('Home Assistant не нашёл запрошенный ресурс (HTTP 404).', { provider: 'home', status: response.status })
      throw connectionError(`Home Assistant ответил HTTP ${response.status}.`, { provider: 'home', status: response.status })
    }
    return response
  }

  /** Read the body as JSON; an unparseable body is an error, never an exception. */
  const readJson = async (response, what) => {
    const raw = await response.text()
    try {
      return raw.trim() === '' ? [] : JSON.parse(raw)
    } catch {
      throw connectionError(`не удалось разобрать ответ Home Assistant (${what}): некорректный JSON.`, { provider: 'home' })
    }
  }

  /**
   * Load the entity list through the 30-second cache.
   *
   * Entities outside `SUPPORTED_DOMAINS` (automations, persons, scripts, ...) are
   * dropped at load time, so a model can never resolve or address them at all.
   */
  const loadEntities = async (base, signal) => {
    if (cache.entities && now() - cache.at < CACHE_TTL_MS) return cache.entities
    const response = await request(base, '/api/states', { signal })
    const raw = await readJson(response, '/api/states')
    if (!Array.isArray(raw)) throw connectionError('Home Assistant вернул неожиданный формат списка устройств.', { provider: 'home' })
    const entities = raw.map(normalizeEntity).filter((entity) => entity && SUPPORTED_DOMAINS.includes(entity.domain))
    cache.entities = entities
    cache.at = now()
    logger?.debug('home entities loaded', { count: entities.length })
    return entities
  }

  /** Entities visible to `list`, honouring `allowedEntities` when it is set. */
  const visibleEntities = (entities) =>
    (writeEntities.size === 0 ? entities : entities.filter((entity) => writeEntities.has(entity.entityId.toLowerCase())))

  const entityAllowed = (entity) => writeEntities.size === 0 || writeEntities.has(entity.entityId.toLowerCase())

  /** Fuzzy resolution: entity_id, then exact name, then substring. */
  const resolve = (entities, query) => {
    const needle = String(query ?? '').trim().toLowerCase()
    if (needle === '') return { missing: '' }
    for (const tier of [
      (entity) => entity.entityId.toLowerCase() === needle,
      (entity) => entity.name.toLowerCase() === needle,
      (entity) => entity.name.toLowerCase().includes(needle) || entity.entityId.toLowerCase().includes(needle),
    ]) {
      const hits = entities.filter(tier)
      if (hits.length === 1) return { entity: hits[0] }
      if (hits.length > 1) return { candidates: hits }
    }
    return { missing: String(query).trim() }
  }

  const candidatesText = (list) => list.slice(0, 6).map((entity) => `${entity.name} (${entity.entityId})`).join(', ')

  /** `list`: up to 30 entities grouped by domain, sorted by name inside a group. */
  const listAction = async (base, signal) => {
    const entities = await loadEntities(base, signal)
    const shown = visibleEntities(entities)
    if (shown.length === 0) return 'Устройства не найдены: Home Assistant не вернул ни одной поддерживаемой сущности.'
    const lines = []
    let used = 0
    for (const domain of SUPPORTED_DOMAINS) {
      if (used >= LIST_LIMIT) break
      const group = shown.filter((entity) => entity.domain === domain).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      if (group.length === 0) continue
      const take = group.slice(0, LIST_LIMIT - used)
      lines.push(`${DOMAIN_LABELS[domain]}: ${take.map((entity) => `${entity.name} (${entity.state})`).join(', ')}`)
      used += take.length
    }
    const total = shown.length
    return [`Устройства (${used}${used < total ? ` из ${total}` : ''}):`, ...lines].join('\n')
  }

  /** `state`: one entity, described for a person. */
  const stateAction = async (base, query, signal) => {
    const entities = await loadEntities(base, signal)
    const resolved = resolve(entities, query)
    if (resolved.missing !== undefined) {
      return resolved.missing === ''
        ? 'Ошибка инструмента home: укажите устройство в query — название или entity_id.'
        : `Ошибка инструмента home: устройство «${resolved.missing}» не найдено. Сначала вызови action="list".`
    }
    if (resolved.candidates) {
      return `Ошибка инструмента home: по запросу «${String(query).trim()}» найдено несколько устройств: ${candidatesText(resolved.candidates)}. Уточните entity_id.`
    }
    return describeState(resolved.entity)
  }

  /** Validate a write target before any network request. */
  const checkDomain = (domain) => {
    const value = String(domain ?? '').trim().toLowerCase()
    if (!SLUG.test(value)) return { error: `некорректный домен устройства${value === '' ? ' (укажите domain)' : `: «${value}»`}.` }
    if (FORBIDDEN_DOMAINS.includes(value)) {
      return { error: `домен «${value}» запрещён: он выполняет команды или перенастраивает Home Assistant.` }
    }
    if (!writeDomains.has(value)) {
      return { error: `домен «${value}» не разрешён. Разрешены: ${[...writeDomains].join(', ')}.` }
    }
    return { domain: value }
  }

  const checkService = (service) => {
    const value = String(service ?? '').trim().toLowerCase()
    if (!SLUG.test(value)) return { error: `некорректный сервис${value === '' ? ' (укажите service)' : `: «${value}»`}.` }
    return { service: value }
  }

  /** Resolve a query and refuse entities outside `allowedEntities`. */
  const resolveForWrite = async (base, query, signal) => {
    const entities = await loadEntities(base, signal)
    const resolved = resolve(entities, query)
    const label = String(query ?? '').trim()
    if (resolved.missing !== undefined) {
      return { error: resolved.missing === ''
        ? 'укажите устройство в query — название или entity_id.'
        : `устройство «${resolved.missing}» не найдено. Сначала вызови action="list".` }
    }
    if (resolved.candidates) {
      return { error: `по запросу «${label}» найдено несколько устройств: ${candidatesText(resolved.candidates)}. Уточните entity_id.` }
    }
    if (!entityAllowed(resolved.entity)) {
      return { error: `управление устройством «${resolved.entity.name}» (${resolved.entity.entityId}) не разрешено: его нет в allowedEntities.` }
    }
    return { entity: resolved.entity }
  }

  /** POST one service call and return the changed states it reports. */
  const callService = async (base, domain, service, body, signal) => {
    const response = await request(base, `/api/services/${domain}/${service}`, { method: 'POST', body, signal })
    const raw = await response.text()
    if (raw.trim() === '') return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // A service may answer with a non-JSON body; the command still succeeded.
      return []
    }
  }

  /** `control`: run `domain.service` on the resolved entity. */
  const controlAction = async (base, { query, domain, service, serviceData }, signal) => {
    const checkedDomain = checkDomain(domain)
    if (checkedDomain.error) return `Ошибка инструмента home: ${checkedDomain.error}`
    const checkedService = checkService(service)
    if (checkedService.error) return `Ошибка инструмента home: ${checkedService.error}`
    const data = serviceData == null ? {} : serviceData
    if (typeof data !== 'object' || Array.isArray(data)) return 'Ошибка инструмента home: serviceData должен быть объектом.'
    const target = await resolveForWrite(base, query, signal)
    if (target.error) return `Ошибка инструмента home: ${target.error}`
    const changed = await callService(base, checkedDomain.domain, checkedService.service, { ...data, entity_id: target.entity.entityId }, signal)
    // The list is stale after a write: refresh it on the next read.
    cache.entities = null
    const updated = changed.map(normalizeEntity).find((entity) => entity?.entityId === target.entity.entityId)
    const result = shortLabel(updated) ?? SERVICE_RESULTS[checkedService.service] ?? 'команда выполнена'
    logger?.debug('home service called', { domain: checkedDomain.domain, service: checkedService.service, entity: target.entity.entityId })
    return `Готово: ${target.entity.name} — ${result}.`
  }

  /** `scene`: turn on one scene entity. */
  const sceneAction = async (base, query, signal) => {
    const checkedDomain = checkDomain('scene')
    if (checkedDomain.error) return `Ошибка инструмента home: ${checkedDomain.error}`
    const target = await resolveForWrite(base, query, signal)
    if (target.error) return `Ошибка инструмента home: ${target.error}`
    await callService(base, 'scene', 'turn_on', { entity_id: target.entity.entityId }, signal)
    cache.entities = null
    logger?.debug('home scene called', { entity: target.entity.entityId })
    return `Готово: сцена «${target.entity.name}» включена.`
  }

  return {
    definition: HOME_TOOL_DEFINITION,
    /**
     * Run one action; failures are returned as text for the model, never thrown.
     *
     * @param {object} args - `action` is required; the rest depends on it.
     * @param {object|AbortSignal} [context] - the bot passes either `{ signal }` or the signal itself.
     * @returns {Promise<string>} a human report or an error description.
     */
    async execute(args = {}, context) {
      const signal = signalOf(context)
      const { action, query, domain, service, serviceData } = args ?? {}
      try {
        if (String(token ?? '').trim() === '') return 'Ошибка инструмента home: не задан токен Home Assistant (HA_TOKEN).'
        const resolvedBase = resolveBase()
        if (resolvedBase.error) return `Ошибка инструмента home: ${resolvedBase.error}`
        const base = resolvedBase.base
        switch (String(action ?? '').trim().toLowerCase()) {
          case 'list':
            return await listAction(base, signal)
          case 'state':
            return await stateAction(base, query, signal)
          case 'control':
            return await controlAction(base, { query, domain, service, serviceData }, signal)
          case 'scene':
            return await sceneAction(base, query, signal)
          default:
            return `Ошибка инструмента home: неизвестное действие «${action ?? ''}». Доступны: list, state, control, scene.`
        }
      } catch (error) {
        logger?.warn('home tool failed', { action, error })
        return `Ошибка инструмента home: ${error?.message ?? error}`
      }
    },
  }
}

/** Accept both bot conventions: `execute(args, signal)` and `execute(args, { signal })`. */
function signalOf(context) {
  if (!context) return undefined
  if (typeof context === 'object' && 'signal' in context) return context.signal ?? undefined
  return context
}

/** Normalize one `/api/states` entry; `null` for anything without an entity_id. */
function normalizeEntity(entry) {
  const entityId = typeof entry?.entity_id === 'string' ? entry.entity_id.trim() : ''
  if (entityId === '') return null
  const attributes = entry?.attributes && typeof entry.attributes === 'object' ? entry.attributes : {}
  const friendly = typeof attributes.friendly_name === 'string' ? attributes.friendly_name.trim() : ''
  const dot = entityId.indexOf('.')
  return {
    entityId,
    domain: dot === -1 ? '' : entityId.slice(0, dot).toLowerCase(),
    name: friendly === '' ? entityId : friendly,
    state: typeof entry.state === 'string' ? entry.state : String(entry.state ?? 'unknown'),
    attributes,
  }
}

/** Human one-liner for `state`, or the state itself for unusual domains. */
function describeState(entity) {
  const { name, state, attributes, domain } = entity
  if (state === 'unavailable') return `${name}: недоступно`
  if (domain === 'scene') return `${name}: сцена`
  if (state === 'unknown') return `${name}: состояние неизвестно`
  if (domain === 'light') {
    const parts = [state === 'on' ? 'включено' : state === 'off' ? 'выключено' : state]
    if (state === 'on') {
      const pct = brightnessPct(attributes)
      if (pct !== null) parts.push(`яркость ${pct}%`)
      const color = describeColor(attributes)
      if (color) parts.push(color)
    }
    return `${name}: ${parts.join(', ')}`
  }
  if (domain === 'switch') return `${name}: ${STATE_LABELS[state] ?? state}`
  if (domain === 'climate') {
    const parts = [STATE_LABELS[state] ?? state]
    if (Number.isFinite(Number(attributes.current_temperature))) parts.push(`сейчас ${num(attributes.current_temperature)} °C`)
    if (Number.isFinite(Number(attributes.temperature))) parts.push(`цель ${num(attributes.temperature)} °C`)
    return `${name}: ${parts.join(', ')}`
  }
  if (domain === 'cover') {
    const parts = [STATE_LABELS[state] ?? state]
    if (Number.isFinite(Number(attributes.current_position))) parts.push(`позиция ${Math.round(Number(attributes.current_position))}%`)
    return `${name}: ${parts.join(', ')}`
  }
  if (domain === 'media_player') {
    const parts = [STATE_LABELS[state] ?? state]
    if (typeof attributes.media_title === 'string' && attributes.media_title !== '') parts.push(`«${attributes.media_title}»`)
    if (Number.isFinite(Number(attributes.volume_level))) parts.push(`громкость ${Math.round(Number(attributes.volume_level) * 100)}%`)
    return `${name}: ${parts.join(', ')}`
  }
  if (domain === 'binary_sensor') return `${name}: ${state === 'on' ? 'да' : state === 'off' ? 'нет' : state}`
  const unit = typeof attributes.unit_of_measurement === 'string' ? ` ${attributes.unit_of_measurement}` : ''
  return `${name}: ${state}${unit}`
}

/** Short confirmation label for a state object. */
function shortLabel(entity) {
  if (!entity) return null
  if (entity.domain === 'scene') return 'сцена включена'
  return STATE_LABELS[entity.state] ?? entity.state
}

/** `brightness` is 0-255; `brightness_pct` is already a percentage when present. */
function brightnessPct(attributes) {
  if (Number.isFinite(Number(attributes?.brightness_pct))) return Math.round(Number(attributes.brightness_pct))
  if (!Number.isFinite(Number(attributes?.brightness))) return null
  return Math.max(0, Math.min(100, Math.round((Number(attributes.brightness) / 255) * 100)))
}

/** Warm/neutral/cold from Kelvin (or legacy mireds); plain RGB otherwise. */
function describeColor(attributes) {
  let kelvin = Number(attributes?.color_temp_kelvin)
  if (!Number.isFinite(kelvin) || kelvin <= 0) {
    const mireds = Number(attributes?.color_temp)
    kelvin = Number.isFinite(mireds) && mireds > 0 ? Math.round(1_000_000 / mireds) : NaN
  }
  if (Number.isFinite(kelvin) && kelvin > 0) {
    if (kelvin < 3500) return 'цвет тёплый'
    if (kelvin <= 5500) return 'цвет нейтральный'
    return 'цвет холодный'
  }
  const rgb = attributes?.rgb_color
  if (Array.isArray(rgb) && rgb.length >= 3) return `цвет RGB(${rgb.slice(0, 3).map((value) => Math.round(Number(value))).join(', ')})`
  const hs = attributes?.hs_color
  if (Array.isArray(hs) && hs.length >= 1 && Number.isFinite(Number(hs[0]))) return `оттенок ${Math.round(Number(hs[0]))}°`
  return ''
}

/** Round to one decimal, without trailing `.0`. */
function num(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 10) / 10)
}
