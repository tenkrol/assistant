/**
 * Telegram Mini App: a small HTTP surface that serves the panel page and a JSON
 * API over the very same stores the bot uses.
 *
 * Two things matter here:
 *
 *   - trust. `initData` is the only source of the caller's identity, so its
 *     signature is checked on the server before any store is touched, the
 *     comparison is constant-time, and the whitelist is applied to the verified
 *     `user.id` — never to anything the request body or the page claims;
 *   - honesty. The panel shows and changes the same state as the bot, so every
 *     write goes through the existing stores (`add`/`cancel`/`remove`/`addFact`)
 *     and is flushed to disk before the response is sent. This module owns no
 *     state of its own.
 *
 * No dependencies beyond `node:http`, `node:crypto`, `node:fs` and the project's
 * own store modules.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { REPEAT_VALUES, describeRepeat } from './repeats.mjs'
import { EVENT_REPEATS } from './events.mjs'
import { MAX_FACT_LENGTH } from './profiles.mjs'

const JSON_TYPE = 'application/json; charset=utf-8'
const DEFAULT_MAX_BODY = 32_768
const DEFAULT_MAX_AGE_SEC = 86_400
const REMINDER_MAX_TEXT = 500
const EVENT_MAX_TITLE = 500
const DEFAULT_EVENT_DAYS = 14
const MAX_EVENT_DAYS = 365

/** Content types the static handler is willing to name. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

/** `public/` next to this module; used when the caller does not pass one. */
const defaultPublicDir = path.join(
  typeof import.meta.dirname === 'string' ? import.meta.dirname : process.cwd(),
  '..',
  'public',
)

/**
 * Машиночитаемые коды ошибок. Панель переводит код по своему словарю;
 * поле `error` остаётся человекочитаемой фразой для совместимости.
 */
const ERROR_CODES = {
  badRequest: 'bad_request',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'not_found',
  tooLarge: 'too_large',
  methodNotAllowed: 'method_not_allowed',
  unavailable: 'unavailable',
  internal: 'internal',
}

/** JSON response with the two headers that keep a Mini App from caching state. */
function sendJson(response, status, payload, headers = {}) {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

/** Ошибка в JSON: понятная фраза и стабильный код для клиента. */
function sendError(response, status, code, error, headers = {}) {
  sendJson(response, status, { error, code }, headers)
}

/** Hex HMAC-SHA256 of `message` under `key`, as a `Buffer`. */
const hmac256 = (key, message) => crypto.createHmac('sha256', key).update(message, 'utf8').digest()

/**
 * Constant-time comparison of a hex digest against the expected one.
 *
 * A wrong length is a mismatch by itself, and `timingSafeEqual` needs equal
 * lengths, so length is checked first — that leaks only the (fixed, public)
 * digest length.
 */
function safeEqualHex(expected, provided) {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/i.test(provided)) return false
  const left = expected
  const right = Buffer.from(provided, 'hex')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/**
 * Validate the `initData` string Telegram hands to a Mini App.
 *
 * The algorithm is the one from "Validating data received via the Mini App":
 * every field except `hash` is sorted by key and joined as `key=value` with
 * `\n`; the HMAC key is `HMAC_SHA256("WebAppData", bot_token)`; the digest is
 * compared in constant time. `auth_date` is additionally required to be fresh.
 *
 * Telegram's newer `signature` field is not user data and clients differ in
 * whether it is covered by `hash`, so both readings are accepted: the digest is
 * checked over all fields, and — only when `signature` is present — over all
 * fields except `signature`. Either way the checked value is an HMAC under the
 * bot token, so this widens compatibility and not the trust boundary.
 *
 * Never throws: every failure comes back as `{ ok: false, reason }`.
 *
 * @param {unknown} initData - raw `Telegram.WebApp.initData` string.
 * @param {object} [options] - validation options.
 * @param {string} options.botToken - bot token; the HMAC secret is derived from it.
 * @param {number} [options.maxAgeSec] - freshness window in seconds, `0` disables it.
 * @param {number} [options.now] - clock in epoch milliseconds, injected by tests.
 * @returns {{ok: true, user: {id: number, first_name?: string, username?: string}, authDate: number}
 *   | {ok: false, reason: string}} the verified caller or the reason it was refused.
 */
export function validateInitData(initData, { botToken, maxAgeSec = DEFAULT_MAX_AGE_SEC, now = Date.now() } = {}) {
  try {
    if (typeof initData !== 'string' || initData.trim() === '') return { ok: false, reason: 'empty' }
    if (typeof botToken !== 'string' || botToken === '') return { ok: false, reason: 'no_bot_token' }

    // `URLSearchParams` decodes each value exactly once, which is what Telegram
    // sends. Decoding again would corrupt values that legitimately contain `%`.
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return { ok: false, reason: 'missing_hash' }

    const fields = []
    for (const [key, value] of params) {
      if (key === 'hash') continue
      fields.push([key, value])
    }
    const buildString = (dropSignature) =>
      fields
        .filter(([key]) => !(dropSignature && key === 'signature'))
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n')

    const secretKey = hmac256('WebAppData', botToken)
    const hasSignature = fields.some(([key]) => key === 'signature')
    const candidates = hasSignature ? [buildString(false), buildString(true)] : [buildString(false)]
    const accepted = candidates.some((dataCheckString) => safeEqualHex(hmac256(secretKey, dataCheckString), hash))
    if (!accepted) return { ok: false, reason: 'bad_signature' }

    const authDate = Number(params.get('auth_date'))
    if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'bad_auth_date' }
    if (maxAgeSec > 0 && Math.floor(now / 1000) - authDate > maxAgeSec) return { ok: false, reason: 'expired' }

    let user
    try {
      user = JSON.parse(params.get('user') ?? '')
    } catch {
      return { ok: false, reason: 'bad_user' }
    }
    if (user == null || typeof user !== 'object' || Array.isArray(user)) return { ok: false, reason: 'bad_user' }
    const id = Number(user.id)
    if (!Number.isFinite(id)) return { ok: false, reason: 'bad_user' }

    return {
      ok: true,
      user: {
        id,
        ...(typeof user.first_name === 'string' ? { first_name: user.first_name } : {}),
        ...(typeof user.username === 'string' ? { username: user.username } : {}),
      },
      authDate,
    }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** The whitelist as a set of strings; an empty/missing list denies everybody. */
function normalizeAllowedUserIds(value) {
  const set = new Set()
  if (value == null) return set
  const list = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : String(value).split(/[\s,]+/)
  for (const item of list) {
    const id = String(item ?? '').trim()
    if (id !== '') set.add(id)
  }
  return set
}

/**
 * A store may be passed directly or wrapped (`{ store, scheduler }`), which is
 * how the bot keeps its reminder store together with its scheduler.
 */
function pickStore(value) {
  if (value == null) return undefined
  if (value.store != null && typeof value.store === 'object') return value.store
  return value
}

/** Body reader with a hard byte cap; a short read is a `400`, an over-long one a `413`. */
function readJsonBody(request, limit) {
  return new Promise((resolve) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      // Drain instead of destroying: the client must still be able to read the 413.
      request.resume()
      resolve({ ok: false, status: 413, code: ERROR_CODES.tooLarge, error: 'Тело запроса слишком большое' })
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      resolve(result)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        request.resume()
        finish({ ok: false, status: 413, code: ERROR_CODES.tooLarge, error: 'Тело запроса слишком большое' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return finish({ ok: true, value: {} })
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        return finish({ ok: false, status: 400, code: ERROR_CODES.badRequest, error: 'Некорректный JSON в теле запроса' })
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return finish({ ok: false, status: 400, code: ERROR_CODES.badRequest, error: 'Ожидается JSON-объект' })
      }
      finish({ ok: true, value })
    }
    const onError = () => finish({ ok: false, status: 400, code: ERROR_CODES.badRequest, error: 'Не удалось прочитать тело запроса' })
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

/** `decodeURIComponent` that reports malformed input as `undefined`. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const asCount = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * Create the Mini App HTTP server.
 *
 * @param {object} [options] - server options.
 * @param {number} [options.port] - TCP port, `0` picks a free one.
 * @param {string} [options.host] - bind address.
 * @param {string} options.botToken - bot token used to verify `initData`.
 * @param {Array<number|string>|Set<number|string>} [options.allowedUserIds] -
 *   Telegram user ids allowed in. Empty or missing means "nobody": the panel is
 *   closed by default rather than open by accident.
 * @param {(userId: number) => number|string} [options.chatIdOf] - chat id for a
 *   user; the default is the user id, which is right for private chats.
 * @param {object} [options.stores] - `{ reminders, events, profiles, usage, repeats }`;
 *   a missing store makes its endpoints answer `503`.
 * @param {string} [options.publicDir] - directory with `app.html`.
 * @param {object} [options.logger] - logger with `info`/`warn`/`error`.
 * @param {number} [options.maxBodyBytes] - request body cap, default 32 KiB.
 * @param {number} [options.maxAgeSec] - `initData` freshness window.
 * @returns {{server: import('node:http').Server, start: () => Promise<number>,
 *   stop: () => Promise<void>, url: string}} the running (or startable) server.
 */
export function createMiniApp({
  port = 8787,
  host = '127.0.0.1',
  botToken,
  allowedUserIds,
  chatIdOf = (id) => id,
  stores = {},
  publicDir,
  logger,
  maxBodyBytes = DEFAULT_MAX_BODY,
  maxAgeSec = DEFAULT_MAX_AGE_SEC,
} = {}) {
  const allowed = normalizeAllowedUserIds(allowedUserIds)
  const publicRoot = path.resolve(publicDir ?? defaultPublicDir)
  const repeatValues = Array.isArray(stores?.repeats)
    ? stores.repeats
    : stores?.repeats?.REPEAT_VALUES ?? REPEAT_VALUES
  const repeatSet = new Set(repeatValues)
  const eventRepeatSet = new Set(EVENT_REPEATS)
  const bodyLimit = Number.isFinite(Number(maxBodyBytes)) && Number(maxBodyBytes) > 0
    ? Math.floor(Number(maxBodyBytes))
    : DEFAULT_MAX_BODY

  if (allowed.size === 0) logger?.warn?.('miniapp: allow-list is empty, every user will get 403')

  const missingStore = (response, what) =>
    sendError(response, 503, ERROR_CODES.unavailable, `Хранилище недоступно: ${what}`)
  const badRequest = (response, error) => sendError(response, 400, ERROR_CODES.badRequest, error)
  const notFound = (response) => sendError(response, 404, ERROR_CODES.notFound, 'Не найдено')
  /** Отказ пространства: viewer и архив не меняют данные. */
  const readOnly = (response) => sendError(response, 403, ERROR_CODES.forbidden, 'Только просмотр: в этом проекте нельзя менять данные')
  const isAccessDenied = (error) => /access denied/.test(String(error?.message ?? ''))

  const mapReminder = (reminder) => ({
    id: String(reminder.id),
    text: String(reminder.text ?? ''),
    dueAt: String(reminder.dueAt ?? ''),
    repeat: reminder.repeat ?? 'none',
    repeatText: describeRepeat(reminder.repeat ?? 'none') ?? String(reminder.repeat ?? 'none'),
  })

  const mapEvent = (event) => ({
    id: String(event.id),
    title: String(event.title ?? ''),
    // `nextAt` is the upcoming occurrence; for a yearly event whose original date
    // is in the past it is the only date worth showing in a calendar.
    at: String(event.nextAt ?? event.at ?? ''),
    repeat: event.repeat ?? 'none',
    place: event.place ?? null,
  })

  /** Parse a required future instant from request data. */
  function futureDate(input) {
    if (input === undefined || input === null || input === '') return { ok: false, error: 'Укажите дату и время' }
    if (typeof input !== 'string' && typeof input !== 'number') return { ok: false, error: 'Некорректная дата' }
    const date = new Date(input)
    if (Number.isNaN(date.getTime())) return { ok: false, error: 'Некорректная дата' }
    if (date.getTime() <= Date.now()) return { ok: false, error: 'Дата должна быть в будущем' }
    return { ok: true, date }
  }

  /** `?days=` for the calendar window. */
  function parseDays(raw) {
    if (raw === null || raw === undefined || raw === '') return { ok: true, value: DEFAULT_EVENT_DAYS }
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > MAX_EVENT_DAYS) {
      return { ok: false, error: `Параметр days должен быть целым числом от 1 до ${MAX_EVENT_DAYS}` }
    }
    return { ok: true, value }
  }

  async function getState(request, response, { userId, auth }) {
    const profiles = pickStore(stores.profiles)
    const usage = pickStore(stores.usage)
    if (!profiles || typeof profiles.city !== 'function') return missingStore(response, 'память пользователя')
    if (!usage || typeof usage.total !== 'function') return missingStore(response, 'расход токенов')

    // `displayName` already prefers a remembered name over the Telegram one.
    const remembered = typeof profiles.displayName === 'function' ? profiles.displayName(userId) : undefined
    const name = remembered
      || auth.user.first_name
      || auth.user.username
      || `Пользователь ${userId}`
    const day = usage.total()
    const prompt = asCount(day?.prompt)
    const completion = asCount(day?.completion)
    sendJson(response, 200, {
      user: {
        name: String(name),
        city: profiles.city(userId) ?? null,
        persona: (typeof profiles.persona === 'function' ? profiles.persona(userId) : undefined) ?? null,
        mood: (typeof profiles.mood === 'function' ? profiles.mood(userId) : undefined) ?? null,
      },
      usageToday: {
        prompt,
        completion,
        total: prompt + completion,
        requests: asCount(day?.requests),
      },
    })
  }

  async function listReminders(request, response, { userId, chatId }) {
    const store = pickStore(stores.reminders)
    if (!store || typeof store.list !== 'function') return missingStore(response, 'напоминания')
    sendJson(response, 200, store.list(chatId, userId).map(mapReminder))
  }

  async function createReminder(request, response, { userId, chatId }) {
    const store = pickStore(stores.reminders)
    if (!store || typeof store.add !== 'function') return missingStore(response, 'напоминания')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)

    const text = typeof body.value.text === 'string' ? body.value.text.trim() : ''
    if (text.length === 0) return badRequest(response, 'Текст напоминания не может быть пустым')
    if (text.length > REMINDER_MAX_TEXT) return badRequest(response, `Текст напоминания длиннее ${REMINDER_MAX_TEXT} символов`)

    const due = futureDate(body.value.dueAt)
    if (!due.ok) return badRequest(response, due.error)

    const repeat = body.value.repeat === undefined || body.value.repeat === null ? 'none' : body.value.repeat
    if (typeof repeat !== 'string' || !repeatSet.has(repeat)) return badRequest(response, 'Недопустимый повтор')

    let reminder
    try {
      reminder = store.add({ chatId, userId, text, dueAt: due.date.toISOString(), repeat })
    } catch (error) {
      logger?.warn?.('miniapp reminder rejected', { error, userId })
      if (isAccessDenied(error)) return readOnly(response)
      const message = String(error?.message ?? '').includes('too many')
        ? 'Слишком много напоминаний'
        : 'Не удалось создать напоминание'
      return badRequest(response, message)
    }
    await store.flush()
    sendJson(response, 200, mapReminder(reminder))
  }

  async function deleteReminder(request, response, { userId, chatId, params }) {
    const store = pickStore(stores.reminders)
    if (!store || typeof store.cancel !== 'function') return missingStore(response, 'напоминания')
    const id = safeDecode(params[0])
    if (id === undefined) return notFound(response)
    const known = store.list(undefined, userId).find((item) => item.id === String(id))
    if (known && store.access && !store.access.canWrite(userId, known)) return readOnly(response)
    const removed = store.cancel(chatId, id, userId)
    if (!removed) return notFound(response)
    await store.flush()
    sendJson(response, 200, { ok: true, id: String(removed.id) })
  }

  async function listEvents(request, response, { userId, chatId, url }) {
    const store = pickStore(stores.events)
    if (!store || typeof store.upcoming !== 'function') return missingStore(response, 'календарь')
    const days = parseDays(url.searchParams.get('days'))
    if (!days.ok) return badRequest(response, days.error)
    sendJson(response, 200, store.upcoming(chatId, { days: days.value, userId }).map(mapEvent))
  }

  async function createEvent(request, response, { userId, chatId }) {
    const store = pickStore(stores.events)
    if (!store || typeof store.add !== 'function') return missingStore(response, 'календарь')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)

    const title = typeof body.value.title === 'string' ? body.value.title.trim() : ''
    if (title.length === 0) return badRequest(response, 'Название события не может быть пустым')
    if (title.length > EVENT_MAX_TITLE) return badRequest(response, `Название события длиннее ${EVENT_MAX_TITLE} символов`)

    const at = futureDate(body.value.at)
    if (!at.ok) return badRequest(response, at.error)

    const repeat = body.value.repeat === undefined || body.value.repeat === null ? 'none' : body.value.repeat
    if (typeof repeat !== 'string' || !eventRepeatSet.has(repeat)) return badRequest(response, 'Недопустимый повтор события')

    const place = typeof body.value.place === 'string' && body.value.place.trim() !== '' ? body.value.place.trim() : undefined
    let event
    try {
      event = store.add({ chatId, userId, title, at: at.date.toISOString(), repeat, place })
    } catch (error) {
      logger?.warn?.('miniapp event rejected', { error, userId })
      if (isAccessDenied(error)) return readOnly(response)
      throw error
    }
    if (!event) return badRequest(response, 'Не удалось создать событие')
    await store.flush()
    sendJson(response, 200, mapEvent(event))
  }

  async function deleteEvent(request, response, { userId, chatId, params }) {
    const store = pickStore(stores.events)
    if (!store || typeof store.remove !== 'function') return missingStore(response, 'календарь')
    const id = safeDecode(params[0])
    if (id === undefined) return notFound(response)
    const known = store.list(undefined, userId).find((item) => item.id === String(id))
    if (known && store.access && !store.access.canWrite(userId, known)) return readOnly(response)
    const removed = store.remove(chatId, id, userId)
    if (!removed) return notFound(response)
    await store.flush()
    sendJson(response, 200, { ok: true, id: String(removed.id) })
  }

  async function getMemory(request, response, { userId }) {
    const profiles = pickStore(stores.profiles)
    if (!profiles || typeof profiles.facts !== 'function') return missingStore(response, 'память')
    const facts = profiles.facts(userId).map((fact) => ({ id: String(fact.id), text: String(fact.text ?? '') }))
    sendJson(response, 200, {
      facts,
      city: (typeof profiles.city === 'function' ? profiles.city(userId) : undefined) ?? null,
    })
  }

  async function createFact(request, response, { userId }) {
    const profiles = pickStore(stores.profiles)
    if (!profiles || typeof profiles.addFact !== 'function') return missingStore(response, 'память')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)

    const text = typeof body.value.text === 'string' ? body.value.text.trim() : ''
    if (text.length === 0) return badRequest(response, 'Текст факта не может быть пустым')
    if (text.length > MAX_FACT_LENGTH) return badRequest(response, `Факт длиннее ${MAX_FACT_LENGTH} символов`)

    let result
    try {
      result = profiles.addFact(userId, text)
    } catch (error) {
      logger?.warn?.('miniapp fact rejected', { error, userId })
      return badRequest(response, 'Не удалось сохранить факт')
    }
    await profiles.flush()
    sendJson(response, 200, {
      id: String(result.fact.id),
      text: String(result.fact.text ?? ''),
      duplicate: Boolean(result.duplicate),
    })
  }

  async function deleteFact(request, response, { userId, params }) {
    const profiles = pickStore(stores.profiles)
    if (!profiles || typeof profiles.removeFact !== 'function') return missingStore(response, 'память')
    const id = safeDecode(params[0])
    if (id === undefined) return notFound(response)
    const removed = profiles.removeFact(userId, id)
    if (!removed) return notFound(response)
    await profiles.flush()
    sendJson(response, 200, { ok: true, id: String(removed.id) })
  }

  const routes = [
    { method: 'GET', pattern: /^\/api\/state$/, handler: getState },
    { method: 'GET', pattern: /^\/api\/reminders$/, handler: listReminders },
    { method: 'POST', pattern: /^\/api\/reminders$/, handler: createReminder },
    { method: 'DELETE', pattern: /^\/api\/reminders\/([^/]+)$/, handler: deleteReminder },
    { method: 'GET', pattern: /^\/api\/events$/, handler: listEvents },
    { method: 'POST', pattern: /^\/api\/events$/, handler: createEvent },
    { method: 'DELETE', pattern: /^\/api\/events\/([^/]+)$/, handler: deleteEvent },
    { method: 'GET', pattern: /^\/api\/memory$/, handler: getMemory },
    { method: 'POST', pattern: /^\/api\/memory$/, handler: createFact },
    { method: 'DELETE', pattern: /^\/api\/memory\/([^/]+)$/, handler: deleteFact },
  ]

  async function handleApi(request, response, url) {
    const method = (request.method ?? 'GET').toUpperCase()
    const pathname = url.pathname
    let match
    const allowedMethods = new Set()
    for (const route of routes) {
      const found = route.pattern.exec(pathname)
      if (!found) continue
      allowedMethods.add(route.method)
      if (route.method === method) match = { route, params: found.slice(1) }
    }
    // Routing is answered before authentication so a wrong method or an unknown
    // path is reported honestly; no store is read either way.
    if (!match) {
      // A rejected request may still carry a body; drain it so the socket stays
      // reusable and the client can read the answer.
      request.resume()
      if (allowedMethods.size > 0) {
        return sendError(response, 405, ERROR_CODES.methodNotAllowed, 'Метод не поддерживается', { allow: [...allowedMethods].join(', ') })
      }
      return notFound(response)
    }

    const header = request.headers['x-telegram-init-data']
    const initData = Array.isArray(header) ? header[0] : header
    const auth = validateInitData(initData, { botToken, maxAgeSec })
    if (!auth.ok) {
      request.resume()
      const error = auth.reason === 'expired'
        ? 'Данные Telegram устарели, откройте приложение заново'
        : 'Откройте через Telegram'
      return sendJson(response, 401, { error, code: ERROR_CODES.unauthorized, reason: auth.reason })
    }
    const userId = auth.user.id
    if (!allowed.has(String(userId))) {
      request.resume()
      return sendError(response, 403, ERROR_CODES.forbidden, 'Нет доступа')
    }

    const chatId = Number(chatIdOf(userId))
    return match.route.handler(request, response, { userId, chatId, params: match.params, url, auth })
  }

  async function serveStatic(request, response, url) {
    const method = (request.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return sendError(response, 405, ERROR_CODES.methodNotAllowed, 'Метод не поддерживается', { allow: 'GET' })
    }
    const decoded = safeDecode(url.pathname)
    if (decoded === undefined) return notFound(response)
    const relative = decoded === '/' || decoded === '' ? 'app.html' : decoded.replace(/^\/+/, '')
    const segments = relative.split('/').filter((segment) => segment !== '')
    // Dot-files (`.env`, `.git`) are never served even if one lands in public/,
    // and `..` cannot walk out of the directory.
    if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
      return notFound(response)
    }
    const target = path.resolve(publicRoot, ...segments)
    if (target !== publicRoot && !target.startsWith(publicRoot + path.sep)) return notFound(response)

    let data
    try {
      data = await fs.promises.readFile(target)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') return notFound(response)
      throw error
    }
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    response.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'no-cache',
    })
    if (method === 'HEAD') response.end()
    else response.end(data)
  }

  async function handle(request, response) {
    const header = request.headers.host ?? 'localhost'
    let url
    try {
      url = new URL(request.url ?? '/', `http://${header}`)
    } catch {
      return sendError(response, 400, ERROR_CODES.badRequest, 'Некорректный запрос')
    }
    if (url.pathname === '/healthz') {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        return sendError(response, 405, ERROR_CODES.methodNotAllowed, 'Метод не поддерживается', { allow: 'GET' })
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return response.end(method === 'HEAD' ? undefined : 'ok')
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, response, url)
    return serveStatic(request, response, url)
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      // The stack stays in the log; the client gets a sentence and a status.
      logger?.error?.('miniapp request failed', { error, method: request.method, url: request.url })
      if (!response.headersSent) sendError(response, 500, ERROR_CODES.internal, 'Внутренняя ошибка сервера')
      else {
        try {
          response.end()
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })
  })

  async function start() {
    if (server.listening) return server.address().port
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
    return server.address().port
  }

  async function stop() {
    if (!server.listening) return
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  return {
    server,
    start,
    stop,
    get url() {
      const address = server.address()
      const actualPort = address && typeof address === 'object' ? address.port : port
      return `http://${host}:${actualPort}`
    },
  }
}
