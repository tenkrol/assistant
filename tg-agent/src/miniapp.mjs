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
import { PERSONA_NAMES, MOOD_NAMES } from './personas.mjs'
import { MODES } from './core/modes.mjs'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  isPasswordHash,
  isSessionSecret,
  parseCookies,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
  verifyUsername,
} from './mobile-auth.mjs'
import { generateTotpSecret, totpUri, verifyTotp } from './totp.mjs'
import { GmailError } from './mobile-gmail.mjs'

const JSON_TYPE = 'application/json; charset=utf-8'
const DEFAULT_MAX_BODY = 32_768
const DEFAULT_MAX_AGE_SEC = 86_400
const REMINDER_MAX_TEXT = 500
const EVENT_MAX_TITLE = 500
const DEFAULT_EVENT_DAYS = 14
const MAX_EVENT_DAYS = 365
/** Парольная сессия мобильного сайта: неделя по умолчанию. */
const DEFAULT_SESSION_TTL_SEC = 7 * 24 * 60 * 60
const DEFAULT_LOGIN_MAX_FAILURES = 5
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_LOGIN_BLOCK_MS = 15 * 60 * 1000
const MAX_LOGIN_TRACKED_IPS = 10_000
const CHAT_HISTORY_LIMIT = 60
const CHAT_MESSAGE_MAX = 4_000
const CHAT_INPUT_MAX = 4_000
const MOBILE_CLIENT_HEADER = 'x-mobile-client'
/** Мобильный клиент — единственная страница, для которой включается CSP. */
const MOBILE_PATH_PREFIX = '/mobile'
const MOBILE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

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

/** Бинарное тело с жёстким лимитом; для загрузки фото/видео. */
function readBinaryBody(request, limit) {
  return new Promise((resolve) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      request.resume()
      resolve({ ok: false, status: 413, error: 'Файл больше 20 МБ' })
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
        request.resume()
        finish({ ok: false, status: 413, error: 'Файл больше 20 МБ' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish({ ok: true, bytes: Buffer.concat(chunks) })
    const onError = () => finish({ ok: false, status: 400, error: 'Не удалось прочитать файл' })
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

/** Положительное целое из env/опций; иначе значение по умолчанию. */
const positiveInt = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
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
  // Парольный вход мобильного сайта. Если хеш или секрет не заданы, вход выключен:
  // сайт открывается, но данные требуют Telegram или настроенного пароля.
  mobilePasswordHash,
  mobileSessionSecret,
  mobileUserId,
  mobileUserName = 'Владелец',
  mobileUsername = '',
  botUsername = '',
  mobileUsers,
  sessionTtlSec = DEFAULT_SESSION_TTL_SEC,
  cookieSecure = true,
  loginRateLimit = {},
  history,
  defaultModel = '',
  modelOptions = [],
  telegramUrl = '',
  groupChatId = '',
  groupTitle = 'Общий чат',
  groupChatType = 'group',
  pushStore,
  pushPublicKey = '',
  pushTest,
  avatarProvider,
  mediaStore,
  inbox,
  agentFiles,
  yandexDisk,
  mobileAuthLog,
  mobileAutomations,
  automationRunner,
  gmail,
  mobileQuiz,
  mobileProjects,
  quizGenerator,
  editChatMessage,
  deleteChatMessage,
  documents,
  proactiveSettings,
  updateProactive,
  systemStatus,
  maxMediaBytes = 20 * 1024 * 1024,
  chatResponder,
  agentResponder,
  agentStatus,
  agentCancel,
  agentTask,
  timeZone = '',
  now = () => Date.now(),
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
  const sessionTtl = positiveInt(sessionTtlSec, DEFAULT_SESSION_TTL_SEC)
  const passwordUser = mobileUserId === undefined || mobileUserId === null || mobileUserId === ''
    ? undefined
    : String(mobileUserId)
  const passwordUserNumber = Number(passwordUser)
  const passwordUserValid = Number.isInteger(passwordUserNumber) && passwordUserNumber > 0
  const passwordConfigured = Boolean(passwordUserValid && isPasswordHash(mobilePasswordHash))
  const usernameExpected = typeof mobileUsername === 'string' ? mobileUsername.trim() : ''
  const accounts = mobileUsers && typeof mobileUsers.authenticate === 'function' ? mobileUsers : null
  const passwordAuthEnabled = Boolean((accounts || passwordConfigured) && isSessionSecret(mobileSessionSecret))
  const loginLimits = {
    maxFailures: positiveInt(loginRateLimit.maxFailures, DEFAULT_LOGIN_MAX_FAILURES),
    windowMs: positiveInt(loginRateLimit.windowMs, DEFAULT_LOGIN_WINDOW_MS),
    blockMs: positiveInt(loginRateLimit.blockMs, DEFAULT_LOGIN_BLOCK_MS),
  }
  const loginAttempts = new Map()
  const clock = typeof now === 'function' ? now : () => Date.now()
  const models = [...new Set([defaultModel, ...modelOptions].filter((value) => typeof value === 'string' && value.trim() !== ''))]
  const groupIdNumber = Number(groupChatId)
  const groupConfigured = Number.isInteger(groupIdNumber) && groupIdNumber !== 0
  const groupType = groupChatType === 'supergroup' ? 'supergroup' : 'group'
  const groupName = String(groupTitle || 'Общий чат')
  const displayNameFor = (userId) => (stores.profiles && typeof stores.profiles.displayName === 'function'
    ? stores.profiles.displayName(userId)
    : undefined)

  if (allowed.size === 0) logger?.warn?.('miniapp: allow-list is empty, every user will get 403')
  if (passwordConfigured && !isSessionSecret(mobileSessionSecret)) {
    logger?.warn?.('miniapp: пароль задан, но MOBILE_SESSION_SECRET отсутствует или короче 32 символов — вход по паролю выключен')
  }
  if (passwordConfigured && passwordUser && !allowed.has(String(passwordUser))) {
    logger?.warn?.('miniapp: MOBILE_USER_ID отсутствует в allow-list — вход по паролю будет отклонён', { userId: passwordUser })
  }

  const missingStore = (response, what) =>
    sendError(response, 503, ERROR_CODES.unavailable, `Хранилище недоступно: ${what}`)
  const badRequest = (response, error) => sendError(response, 400, ERROR_CODES.badRequest, error)
  const notFound = (response) => sendError(response, 404, ERROR_CODES.notFound, 'Не найдено')
  /** Отказ пространства: viewer и архив не меняют данные. */
  const readOnly = (response) => sendError(response, 403, ERROR_CODES.forbidden, 'Только просмотр: в этом проекте нельзя менять данные')
  const isAccessDenied = (error) => /access denied/.test(String(error?.message ?? ''))

  // ---------------------------------------------------------------------------
  // Парольная авторизация мобильного сайта
  // ---------------------------------------------------------------------------

  const timeNow = () => {
    const value = clock()
    return Number.isFinite(value) ? value : Date.now()
  }

  const isLoopback = (address) => address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'

  /**
   * IP для ограничения попыток входа.
   *
   * Сервер слушает localhost за nginx, поэтому `x-forwarded-for` принимается только
   * от loopback-соединения; иначе клиент подделал бы адрес и обошёл лимит.
   */
  function clientIp(request) {
    const remote = String(request.socket?.remoteAddress ?? '')
    const forwarded = request.headers['x-forwarded-for']
    const raw = isLoopback(remote) && typeof forwarded === 'string' && forwarded.trim() !== ''
      ? forwarded.split(',')[0].trim()
      : remote
    return (raw === '' ? 'unknown' : raw).slice(0, 64)
  }

  function pruneLoginAttempts(at) {
    if (loginAttempts.size < MAX_LOGIN_TRACKED_IPS) return
    for (const [key, state] of loginAttempts) {
      if (at >= state.blockedUntil && at - state.last > loginLimits.windowMs) loginAttempts.delete(key)
    }
    if (loginAttempts.size >= MAX_LOGIN_TRACKED_IPS) loginAttempts.clear()
  }

  /** Состояние попыток одного IP: окно и блокировка после серии ошибок. */
  function loginState(ip, at) {
    pruneLoginAttempts(at)
    let state = loginAttempts.get(ip)
    if (!state) {
      state = { failures: 0, first: at, last: at, blockedUntil: 0 }
      loginAttempts.set(ip, state)
      return state
    }
    if (state.blockedUntil > 0 && at >= state.blockedUntil) {
      state.failures = 0
      state.first = at
      state.blockedUntil = 0
    } else if (at - state.first > loginLimits.windowMs) {
      state.failures = 0
      state.first = at
    }
    state.last = at
    return state
  }

  function recordLoginFailure(ip, at) {
    const state = loginState(ip, at)
    state.failures += 1
    if (state.failures >= loginLimits.maxFailures) state.blockedUntil = at + loginLimits.blockMs
    return state
  }

  /** Кто пришёл: Telegram initData или подписанная парольная cookie. */
  function authenticate(request) {
    const header = request.headers['x-telegram-init-data']
    const initData = Array.isArray(header) ? header[0] : header
    if (typeof initData === 'string' && initData.trim() !== '') {
      const auth = validateInitData(initData, { botToken, maxAgeSec })
      if (!auth.ok) return { ok: false, via: 'telegram', reason: auth.reason }
      return { ok: true, via: 'telegram', userId: auth.user.id, user: auth.user, telegram: auth }
    }
    if (passwordAuthEnabled) {
      const cookies = parseCookies(request.headers.cookie)
      const token = cookies[SESSION_COOKIE]
      if (typeof token === 'string' && token !== '') {
        const session = verifySession(token, mobileSessionSecret, { now: timeNow() })
        if (!session.ok) return { ok: false, via: 'password', reason: session.reason }
        if (accounts) {
          // Сессия привязана к аккаунту и его версии: смена пароля или логина
          // сразу завершает старые cookie.
          if (typeof session.login !== 'string' || !Number.isInteger(session.version)) {
            return { ok: false, via: 'password', reason: 'stale' }
          }
          const account = accounts.findByLogin(session.login)
          if (!account
            || Number(account.version) !== session.version
            || String(account.userId) !== String(session.userId)) {
            return { ok: false, via: 'password', reason: 'stale' }
          }
          return {
            ok: true,
            via: 'password',
            userId: Number(account.userId),
            login: account.login,
            role: account.role === 'owner' ? 'owner' : 'member',
            account,
            user: { id: Number(account.userId), first_name: account.name, login: account.login, role: account.role },
          }
        }
        if (String(session.userId) !== String(passwordUserNumber)) {
          return { ok: false, via: 'password', reason: 'wrong_user' }
        }
        return {
          ok: true,
          via: 'password',
          userId: passwordUserNumber,
          login: usernameExpected || undefined,
          role: 'owner',
          user: { id: passwordUserNumber, first_name: mobileUserName },
        }
      }
    }
    return { ok: false, via: 'none', reason: 'no_auth' }
  }

  function authError(response, auth) {
    const expired = auth.reason === 'expired'
    return sendJson(response, 401, {
      error: expired ? 'Сессия истекла, войдите заново' : 'Нужен вход на сайт',
      code: ERROR_CODES.unauthorized,
      reason: auth.reason,
    })
  }

  /** POST /api/auth/login — единственное место, где принимается пароль. */
  async function login(request, response) {
    if (!passwordAuthEnabled) {
      request.resume()
      return sendError(response, 503, ERROR_CODES.unavailable, 'Вход по паролю не настроен')
    }
    const at = timeNow()
    const ip = clientIp(request)
    const state = loginState(ip, at)
    if (state.blockedUntil > at) {
      request.resume()
      const retryAfter = Math.max(1, Math.ceil((state.blockedUntil - at) / 1000))
      return sendJson(response, 429, {
        error: 'Слишком много попыток входа. Попробуйте позже.',
        code: 'too_many_requests',
        retryAfter,
      }, { 'retry-after': String(retryAfter) })
    }

    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const password = body.value?.password
    const username = typeof body.value?.username === 'string' ? body.value.username.trim() : ''
    if (typeof password !== 'string' || password === '' || password.length > 1024) {
      return sendError(response, 400, ERROR_CODES.badRequest, 'Введите логин и пароль')
    }

    const account = accounts ? accounts.authenticate(username, password) : null
    const legacyOk = !accounts && verifyUsername(username, usernameExpected) && verifyPassword(password, mobilePasswordHash)
    if (accounts ? !account : !legacyOk) {
      const failed = recordLoginFailure(ip, at)
      logger?.warn?.('mobile login failed', { attempts: failed.failures, blocked: failed.blockedUntil > at })
      const retryAfter = failed.blockedUntil > at
        ? Math.max(1, Math.ceil((failed.blockedUntil - at) / 1000))
        : undefined
      const headers = retryAfter ? { 'retry-after': String(retryAfter) } : {}
      await mobileAuthLog?.add?.({ login: username, ok: false, ip, userAgent: request.headers['user-agent'], reason: 'password' }).catch(() => {})
      return sendJson(response, 401, {
        error: 'Неверный логин или пароль',
        code: ERROR_CODES.unauthorized,
        ...(retryAfter ? { retryAfter } : {}),
      }, headers)
    }

    if (accounts) {
      const totp = accounts.totpState(account.login)
      if (totp?.enabled) {
        const code = typeof body.value?.code === 'string' ? body.value.code.replace(/\s+/g, '') : ''
        if (code === '') {
          return sendJson(response, 401, {
            error: 'Введите код из приложения-аутентификатора',
            code: 'totp_required',
          })
        }
        if (!verifyTotp(totp.secret, code)) {
          const failed = recordLoginFailure(ip, at)
          logger?.warn?.('mobile totp failed', { attempts: failed.failures })
          return sendJson(response, 401, {
            error: 'Неверный код двухфакторной защиты',
            code: 'totp_invalid',
          })
        }
      }
    }
    loginAttempts.delete(ip)
    const sessionUser = accounts
      ? {
          userId: Number(account.userId),
          login: account.login,
          name: account.name,
          role: account.role === 'owner' ? 'owner' : 'member',
          version: Number(account.version) || 1,
        }
      : {
          userId: passwordUserNumber,
          login: usernameExpected || undefined,
          name: mobileUserName,
          role: 'owner',
          version: undefined,
        }
    const token = signSession({
      userId: sessionUser.userId,
      ttlSec: sessionTtl,
      now: at,
      login: sessionUser.login,
      version: sessionUser.version,
    }, mobileSessionSecret)
    logger?.info?.('mobile login ok', { login: sessionUser.login })
    await mobileAuthLog?.add?.({ login: sessionUser.login, ok: true, ip, userAgent: request.headers['user-agent'] }).catch(() => {})
    return sendJson(response, 200, {
      ok: true,
      user: { name: sessionUser.name, via: 'password', login: sessionUser.login, role: sessionUser.role },
    }, {
      'set-cookie': sessionCookie(token, { maxAgeSec: sessionTtl, secure: cookieSecure }),
    })
  }

  /** POST /api/auth/logout — стирает cookie, даже если сессия уже истекла. */
  function logout(request, response) {
    request.resume()
    sendJson(response, 200, { ok: true }, {
      'set-cookie': clearSessionCookie({ secure: cookieSecure }),
    })
  }

  /** GET /api/auth/session — кто я и можно ли уже показывать данные. */
  function sessionInfo(request, response) {
    request.resume()
    const auth = authenticate(request)
    if (!auth.ok) return authError(response, auth)
    if (!allowed.has(String(auth.userId))) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Нет доступа')
    }
    const telegramName = stores.profiles && typeof stores.profiles.displayName === 'function'
      ? stores.profiles.displayName(auth.userId)
      : String(auth.user.first_name ?? mobileUserName)
    sendJson(response, 200, {
      authenticated: true,
      totpEnabled: Boolean(accounts && auth.login && accounts.totpState(auth.login)?.enabled),
      user: {
        name: String(auth.user.first_name ?? mobileUserName),
        telegramName: telegramName || String(auth.user.first_name ?? mobileUserName),
        via: auth.via,
        login: auth.login ?? null,
        role: auth.role ?? null,
      },
      telegramUrl,
      botUsername: String(botUsername || ''),
    })
  }

  // ---------------------------------------------------------------------------
  // Аккаунты мобильного сайта: владелец добавляет второго человека, каждый
  // входит своим логином и видит только свои данные.
  // ---------------------------------------------------------------------------

  function accountsSnapshot(auth) {
    if (!accounts) return { accounts: [], canManage: false, current: null }
    const list = accounts.list()
    const current = list.find((item) => item.login === auth.login) ?? null
    return {
      accounts: auth.role === 'owner' ? list : (current ? [current] : []),
      canManage: auth.role === 'owner',
      current,
    }
  }

  function accountError(response, error) {
    const conflict = error?.code === 'conflict'
    const status = conflict ? 409 : 400
    return sendJson(response, status, {
      error: String(error?.message ?? 'Не удалось изменить аккаунт'),
      code: conflict ? 'conflict' : ERROR_CODES.badRequest,
    })
  }

  function listAccounts(request, response, { auth }) {
    request.resume()
    if (!accounts) return missingStore(response, 'аккаунты')
    sendJson(response, 200, accountsSnapshot(auth))
  }

  /** POST /api/accounts — владелец добавляет второго человека. */
  async function createAccount(request, response, { auth }) {
    if (!accounts) return missingStore(response, 'аккаунты')
    if (auth.role !== 'owner') {
      request.resume()
      return sendError(response, 403, ERROR_CODES.forbidden, 'Добавлять пользователей может только владелец')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const values = body.value
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return badRequest(response, 'Ожидается объект с логином и паролем')
    }
    const login = String(values.login ?? '').trim().toLowerCase()
    const password = typeof values.password === 'string' ? values.password : ''
    const name = typeof values.name === 'string' ? values.name.trim() : ''
    let userId = values.userId === undefined || values.userId === null || values.userId === ''
      ? undefined
      : Number(values.userId)
    if (userId === undefined && accounts.freeUserId) {
      userId = accounts.freeUserId([...allowed])
    }
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendJson(response, 409, {
        error: 'Нет свободного Telegram id: добавьте его в ALLOWED_USER_IDS',
        code: 'conflict',
      })
    }
    if (!allowed.has(String(userId))) {
      return badRequest(response, 'Этот Telegram id не разрешён в ALLOWED_USER_IDS')
    }
    try {
      const user = await accounts.add({ login, password, name, userId, role: 'member' })
      logger?.info?.('mobile account added', { login: user.login })
      return sendJson(response, 200, { ok: true, user, ...accountsSnapshot(auth) })
    } catch (error) {
      return accountError(response, error)
    }
  }

  /** POST /api/session/revoke-all — выйти на всех устройствах. */
  async function revokeAllSessions(request, response, { auth }) {
    if (!accounts) {
      request.resume()
      return missingStore(response, 'аккаунты')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const password = typeof body.value?.currentPassword === 'string' ? body.value.currentPassword : ''
    if (!accounts.authenticate(auth.login, password)) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Неверный текущий пароль')
    }
    try {
      await accounts.revokeSessions(auth.login)
      logger?.info?.('mobile sessions revoked', { login: auth.login })
      sendJson(response, 200, { ok: true }, {
        'set-cookie': clearSessionCookie({ secure: cookieSecure }),
      })
    } catch (error) {
      accountError(response, error)
    }
  }

  const mapAutomation = (item) => ({
    id: String(item.id),
    title: String(item.title),
    prompt: String(item.prompt),
    time: String(item.time),
    weekdays: Array.isArray(item.weekdays) ? item.weekdays : [],
    enabled: Boolean(item.enabled),
    nextRunAt: item.nextRunAt ?? null,
    lastRunAt: item.lastRunAt ?? null,
    lastStatus: item.lastStatus ?? null,
    history: Array.isArray(item.history) ? item.history : [],
  })

  function listAutomations(request, response, { userId }) {
    request.resume()
    if (!mobileAutomations || typeof mobileAutomations.list !== 'function') return missingStore(response, 'автоматизации')
    sendJson(response, 200, { items: mobileAutomations.list(userId).map(mapAutomation) })
  }

  async function createAutomation(request, response, { userId }) {
    if (!mobileAutomations || typeof mobileAutomations.add !== 'function') return missingStore(response, 'автоматизации')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const item = await mobileAutomations.add({
        userId,
        title: body.value?.title,
        prompt: body.value?.prompt,
        time: body.value?.time,
        weekdays: body.value?.weekdays,
      })
      sendJson(response, 200, { item: mapAutomation(item) })
    } catch (error) {
      return badRequest(response, error?.message || 'Не удалось создать автоматизацию')
    }
  }

  async function updateAutomation(request, response, { userId, params }) {
    if (!mobileAutomations || typeof mobileAutomations.update !== 'function') return missingStore(response, 'автоматизации')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const item = await mobileAutomations.update({
        userId,
        id: params[0],
        enabled: body.value?.enabled,
        title: body.value?.title,
        prompt: body.value?.prompt,
        time: body.value?.time,
        weekdays: body.value?.weekdays,
      })
      sendJson(response, 200, { item: mapAutomation(item) })
    } catch (error) {
      if (error?.code === 'not_found') return notFound(response)
      return badRequest(response, error?.message || 'Не удалось обновить автоматизацию')
    }
  }

  async function deleteAutomation(request, response, { userId, params }) {
    request.resume()
    if (!mobileAutomations || typeof mobileAutomations.remove !== 'function') return missingStore(response, 'автоматизации')
    try {
      await mobileAutomations.remove({ userId, id: params[0] })
      sendJson(response, 200, { ok: true })
    } catch (error) {
      if (error?.code === 'not_found') return notFound(response)
      return badRequest(response, error?.message || 'Не удалось удалить автоматизацию')
    }
  }

  async function runAutomation(request, response, { userId, params }) {
    request.resume()
    if (!mobileAutomations || !automationRunner) return missingStore(response, 'автоматизации')
    const item = mobileAutomations.find(userId, params[0])
    if (!item) return notFound(response)
    try {
      await automationRunner({ userId, text: item.prompt })
      await mobileAutomations.markRun(item, { ok: true })
      sendJson(response, 200, { ok: true, item: mapAutomation(item) })
    } catch (error) {
      await mobileAutomations.markRun(item, { ok: false, error: error?.message ?? error }).catch(() => {})
      sendError(response, 502, ERROR_CODES.unavailable, 'Автоматизация не выполнилась')
    }
  }

  let automationBusy = false
  function startAutomationLoop() {
    if (!mobileAutomations || typeof automationRunner !== 'function') return
    const timer = setInterval(async () => {
      if (automationBusy) return
      automationBusy = true
      try {
        for (const item of mobileAutomations.due()) {
          try {
            await automationRunner({ userId: item.userId, text: item.prompt })
            await mobileAutomations.markRun(item, { ok: true })
            logger?.info?.('automation ran', { id: item.id, userId: item.userId })
          } catch (error) {
            await mobileAutomations.markRun(item, { ok: false, error: error?.message ?? error }).catch(() => {})
            logger?.warn?.('automation failed', { id: item.id, error: error?.message ?? error })
          }
        }
      } finally {
        automationBusy = false
      }
    }, 30_000)
    timer.unref?.()
  }

  /** GET /api/security/log — последние входы текущего аккаунта. */
  function securityLog(request, response, { auth }) {
    request.resume()
    if (!mobileAuthLog || typeof mobileAuthLog.list !== 'function') {
      return sendJson(response, 200, { entries: [] })
    }
    sendJson(response, 200, { entries: mobileAuthLog.list({ login: auth.login, limit: 20 }) })
  }

  /** Двухфакторная защита: выдать секрет (ещё не включён). */
  async function setupTotp(request, response, { auth }) {
    if (!accounts) {
      request.resume()
      return missingStore(response, 'аккаунты')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    if (!accounts.authenticate(auth.login, body.value?.currentPassword)) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Неверный текущий пароль')
    }
    const secret = generateTotpSecret()
    await accounts.setTotp(auth.login, { secret, enabled: false })
    sendJson(response, 200, { secret, uri: totpUri({ secret, login: auth.login }), enabled: false })
  }

  async function enableTotp(request, response, { auth }) {
    if (!accounts) {
      request.resume()
      return missingStore(response, 'аккаунты')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    if (!accounts.authenticate(auth.login, body.value?.currentPassword)) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Неверный текущий пароль')
    }
    const state = accounts.totpState(auth.login)
    if (!state?.secret) return badRequest(response, 'Сначала получите секрет')
    if (!verifyTotp(state.secret, body.value?.code)) return badRequest(response, 'Неверный код')
    await accounts.setTotp(auth.login, { secret: state.secret, enabled: true })
    sendJson(response, 200, { enabled: true })
  }

  async function disableTotp(request, response, { auth }) {
    if (!accounts) {
      request.resume()
      return missingStore(response, 'аккаунты')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    if (!accounts.authenticate(auth.login, body.value?.currentPassword)) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Неверный текущий пароль')
    }
    const state = accounts.totpState(auth.login)
    if (state?.enabled && !verifyTotp(state.secret, body.value?.code)) return badRequest(response, 'Неверный код')
    await accounts.setTotp(auth.login, { secret: '', enabled: false })
    sendJson(response, 200, { enabled: false })
  }

  /** PATCH /api/account — сменить свой логин, пароль или имя. */
  async function updateAccount(request, response, { auth }) {
    if (!accounts) return missingStore(response, 'аккаунты')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const values = body.value
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return badRequest(response, 'Ожидается объект с изменениями')
    }
    const currentPassword = typeof values.currentPassword === 'string' ? values.currentPassword : ''
    if (!accounts.authenticate(auth.login, currentPassword)) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Неверный текущий пароль')
    }
    const changes = {}
    if (Object.prototype.hasOwnProperty.call(values, 'login')) changes.login = values.login
    if (Object.prototype.hasOwnProperty.call(values, 'password')) changes.password = values.password
    if (Object.prototype.hasOwnProperty.call(values, 'name')) changes.name = values.name
    if (Object.keys(changes).length === 0) return badRequest(response, 'Нет изменений')

    try {
      const result = await accounts.update(auth.login, changes)
      const headers = {}
      if (result.credentialChanged) {
        // Старая cookie больше не действительна: выдаём новую сразу, чтобы
        // человека не выкинуло из только что изменённого аккаунта.
        const token = signSession({
          userId: result.user.userId,
          ttlSec: sessionTtl,
          now: timeNow(),
          login: result.user.login,
          version: result.user.version,
        }, mobileSessionSecret)
        headers['set-cookie'] = sessionCookie(token, { maxAgeSec: sessionTtl, secure: cookieSecure })
      }
      logger?.info?.('mobile account updated', { login: result.user.login })
      return sendJson(response, 200, {
        ok: true,
        user: result.user,
        sessionUpdated: result.credentialChanged,
        ...accountsSnapshot({ ...auth, login: result.user.login }),
      }, headers)
    } catch (error) {
      return accountError(response, error)
    }
  }

  // ---------------------------------------------------------------------------
  // Данные, которых не было в старой панели: история чата, настройки, статистика
  // ---------------------------------------------------------------------------

  const chatIdFor = (userId) => Number(chatIdOf(userId))

  const safeText = (value, limit = CHAT_MESSAGE_MAX) => String(value ?? '').slice(0, limit)

  /** Личный чат или настроенный общий чат; чужие id не принимаются. */
  function resolveChat(requested, auth) {
    if (requested === undefined || requested === null || requested === '' || String(requested) === String(auth.userId)) {
      return { chatId: Number(auth.userId), type: 'private', title: 'Личный чат' }
    }
    if (groupConfigured && String(requested) === String(groupIdNumber)) {
      return { chatId: groupIdNumber, type: groupType, title: groupName }
    }
    const projectMatch = /^project:([A-Za-z0-9-]+)$/.exec(String(requested))
    if (projectMatch && mobileProjects && typeof mobileProjects.find === 'function') {
      const project = mobileProjects.find(auth.userId, projectMatch[1])
      if (project) return { chatId: 'project:' + project.id, type: 'project', title: project.name, project }
    }
    return null
  }

  function listChats(request, response, { auth }) {
    request.resume()
    const decorate = (chat) => {
      const messages = history && typeof history.messages === 'function'
        ? history.messages(chat.id, chat.type === 'private' ? auth.userId : undefined)
        : []
      const last = messages.at(-1)
      return {
        ...chat,
        ...(last ? {
          lastMessage: safeText(last.content, 90),
          lastAt: typeof last.at === 'string' ? last.at : null,
        } : {}),
      }
    }
    const chats = [decorate({
      id: String(auth.userId),
      type: 'private',
      title: 'Личный чат',
      subtitle: 'только вы и ассистент',
    })]
    if (groupConfigured) {
      chats.push(decorate({
        id: String(groupIdNumber),
        type: groupType,
        title: groupName,
        subtitle: 'общий чат с Машей',
      }))
    }
    if (mobileProjects && typeof mobileProjects.list === 'function') {
      for (const project of mobileProjects.list(auth.userId)) {
        chats.push(decorate({
          id: 'project:' + project.id,
          type: 'project',
          title: project.name,
          subtitle: 'проект · отдельный контекст',
        }))
      }
    }
    sendJson(response, 200, { chats })
  }

  const chatInFlight = new Set()
  const agentInFlight = new Set()
  let agentStatusCache = { at: 0, value: null }

  /** GET /api/push/config — можно ли включить уведомления и публичный VAPID-ключ. */
  function getPushConfig(request, response) {
    request.resume()
    const enabled = Boolean(pushStore && typeof pushStore.add === 'function' && pushPublicKey)
    sendJson(response, 200, { enabled, publicKey: enabled ? pushPublicKey : '' })
  }

  /** POST /api/push/test — отправить тестовый push текущему аккаунту. */
  async function testPush(request, response, { userId }) {
    if (typeof pushTest !== 'function') {
      request.resume()
      return missingStore(response, 'уведомления')
    }
    request.resume()
    try {
      const result = await pushTest({ userId })
      sendJson(response, 200, result ?? { sent: 0, failed: 0, subscribed: 0 })
    } catch (error) {
      logger?.warn?.('push test failed', { error: error?.message ?? error, userId })
      sendError(response, 502, 'push_unavailable', 'Не удалось отправить тестовый push')
    }
  }

  /** POST /api/push/subscribe — сохранить подписку браузера. */
  async function subscribePush(request, response, { userId }) {
    if (!pushStore || typeof pushStore.add !== 'function') {
      request.resume()
      return missingStore(response, 'уведомления')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      await pushStore.add({ userId, subscription: body.value })
      return sendJson(response, 200, { ok: true })
    } catch (error) {
      const conflict = error?.code === 'conflict'
      return sendJson(response, conflict ? 409 : 400, {
        error: String(error?.message ?? 'Не удалось сохранить подписку'),
        code: conflict ? 'conflict' : ERROR_CODES.badRequest,
      })
    }
  }

  /** POST /api/push/unsubscribe — удалить подписку текущего браузера. */
  async function unsubscribePush(request, response) {
    if (!pushStore || typeof pushStore.remove !== 'function') {
      request.resume()
      return missingStore(response, 'уведомления')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const endpoint = typeof body.value?.endpoint === 'string' ? body.value.endpoint : ''
    if (endpoint === '') return badRequest(response, 'Нет endpoint подписки')
    await pushStore.remove(endpoint)
    sendJson(response, 200, { ok: true })
  }

  /** GET /api/agent/status — доступен ли мост и что происходило у агента. */
  async function getAgentStatus(request, response) {
    request.resume()
    if (typeof agentStatus !== 'function') {
      return sendJson(response, 200, { enabled: false, agents: [], events: [] })
    }
    const at = timeNow()
    if (agentStatusCache.value && at - agentStatusCache.at < 10_000) {
      return sendJson(response, 200, agentStatusCache.value)
    }
    try {
      const value = await agentStatus()
      agentStatusCache = { at, value }
      sendJson(response, 200, value)
    } catch (error) {
      logger?.warn?.('agent status failed', { error: error?.message ?? error })
      sendJson(response, 200, { enabled: false, agents: [], events: [], error: 'Агент не отвечает' })
    }
  }

  /** GET /api/agent/task/:id — детали задачи агента. */
  async function getAgentTask(request, response, { params }) {
    request.resume()
    if (typeof agentTask !== 'function') return missingStore(response, 'агент')
    try {
      const task = await agentTask(String(params[0]))
      sendJson(response, 200, { task: task ?? null })
    } catch (error) {
      logger?.warn?.('agent task details failed', { error: error?.message ?? error })
      sendError(response, 502, 'agent_unavailable', 'Не удалось получить задачу')
    }
  }

  /** POST /api/agent/cancel — отменить задачу агента по taskId. */
  async function cancelAgentTask(request, response) {
    if (typeof agentCancel !== 'function') {
      request.resume()
      return missingStore(response, 'агент')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const taskId = typeof body.value?.taskId === 'string' ? body.value.taskId.trim() : ''
    if (taskId === '') return badRequest(response, 'Нет taskId')
    try {
      const result = await agentCancel({ taskId })
      sendJson(response, 200, { ok: true, result: result ?? null })
    } catch (error) {
      logger?.warn?.('agent cancel failed', { error: error?.message ?? error, taskId })
      sendError(response, 502, 'agent_unavailable', 'Не удалось отменить задачу')
    }
  }

  /** POST /api/agent/task — задание агенту по шаблону с сайта. */
  async function submitAgentTask(request, response, { userId, chatId, auth }) {
    if (typeof agentResponder !== 'function') {
      request.resume()
      return missingStore(response, 'агент')
    }
    if (agentInFlight.has(String(userId))) {
      request.resume()
      return sendJson(response, 429, {
        error: 'Агент уже принимает задачу — дождитесь ответа',
        code: 'too_many_requests',
      })
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const task = typeof body.value?.task === 'string' ? body.value.task.trim() : ''
    if (task === '') return badRequest(response, 'Опишите задание')
    if (task.length > CHAT_INPUT_MAX) return badRequest(response, `Задание длиннее ${CHAT_INPUT_MAX} символов`)

    agentInFlight.add(String(userId))
    try {
      const result = await agentResponder({
        task,
        userId,
        chatId,
        name: displayNameFor(userId) || String(auth.user?.first_name ?? mobileUserName),
        login: auth.login ?? null,
      })
      if (!result || result.ok !== true) {
        return sendError(response, 502, 'agent_unavailable', String(result?.error ?? 'Агент не принял задание'))
      }
      agentStatusCache = { at: 0, value: null }
      sendJson(response, 200, { ok: true, text: String(result.text ?? 'Задание передано агенту') })
    } catch (error) {
      logger?.warn?.('agent task failed', { error: error?.message ?? error, userId })
      sendError(response, 502, 'agent_unavailable', String(error?.message ?? 'Агент не принял задание'))
    } finally {
      agentInFlight.delete(String(userId))
    }
  }

  /** POST /api/chat/message — сообщение с сайта через тот же конвейер бота. */
  async function sendChatMessage(request, response, { userId, chatId, auth }) {
    if (typeof chatResponder !== 'function') {
      request.resume()
      return missingStore(response, 'чат')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const target = resolveChat(body.value?.chatId, auth)
    if (!target) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой чат')
    if (chatInFlight.has(String(userId) + ':' + String(target.chatId))) {
      request.resume()
      return sendJson(response, 429, {
        error: 'Ассистент ещё отвечает на предыдущее сообщение',
        code: 'too_many_requests',
      })
    }
    const text = typeof body.value?.text === 'string' ? body.value.text.trim() : ''
    const requestedAttachments = Array.isArray(body.value?.attachments)
      ? body.value.attachments.map((item) => String(item?.id ?? item)).filter(Boolean).slice(0, 4)
      : []
    const attachments = []
    if (requestedAttachments.length > 0) {
      if (!mediaStore || typeof mediaStore.read !== 'function') return missingStore(response, 'медиа')
      for (const id of requestedAttachments) {
        const entry = await mediaStore.read(id).catch(() => null)
        if (!entry) return badRequest(response, 'Вложение не найдено или устарело')
        attachments.push({ ...mediaStore.publicItem(entry.item), bytes: entry.bytes })
      }
    }
    if (text === '' && attachments.length === 0) return badRequest(response, 'Введите сообщение')
    if (text.length > CHAT_INPUT_MAX) return badRequest(response, `Сообщение длиннее ${CHAT_INPUT_MAX} символов`)
    const rawReply = body.value?.replyTo
    const replyTo = rawReply && typeof rawReply === 'object' && typeof rawReply.text === 'string' && rawReply.text.trim() !== ''
      ? {
        text: rawReply.text.trim().slice(0, 1000),
        ...(typeof rawReply.role === 'string' ? { role: rawReply.role === 'assistant' ? 'assistant' : 'user' } : {}),
        ...(typeof rawReply.author === 'string' && rawReply.author.trim() !== '' ? { author: rawReply.author.trim().slice(0, 80) } : {}),
      }
      : undefined

    const streaming = body.value?.stream === true
    const emit = (event) => {
      if (!streaming || response.writableEnded) return
      try { response.write('data: ' + JSON.stringify(event) + '\n\n') } catch { /* клиент ушёл */ }
    }
    let heartbeat
    if (streaming) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      emit({ type: 'start' })
      heartbeat = setInterval(() => emit({ type: 'ping' }), 15_000)
      heartbeat.unref?.()
    }
    chatInFlight.add(String(userId) + ':' + String(target.chatId))
    try {
      const delivery = await chatResponder({
        userId,
        chatId: target.chatId,
        chatType: target.type === 'project' ? 'private' : target.type,
        chatTitle: target.title,
        ...(target.type === 'project' ? { webOnly: true, projectInstructions: target.project?.instructions ?? '' } : {}),
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        name: displayNameFor(userId) || String(auth.user?.first_name ?? mobileUserName),
        login: auth.login ?? null,
        ...(streaming ? { onDelta: (chunk) => emit({ type: 'delta', text: chunk }) } : {}),
      })
      const messages = (delivery?.sends ?? [])
        .filter((entry) => entry && typeof entry.text === 'string' && entry.text !== '')
        .map((entry) => ({
          role: 'assistant',
          text: entry.text,
          ...(entry.keyboard ? { keyboard: entry.keyboard } : {}),
        }))
      const files = (delivery?.files ?? []).map((file) => ({
        fileName: String(file.fileName ?? 'file'),
        caption: String(file.caption ?? ''),
        size: file.bytes?.length ?? 0,
        // Файл до 2 МиБ отдаём сразу data-URL-ом; больший предложим забрать в Telegram.
        data: file.bytes && file.bytes.length <= 2 * 1024 * 1024 ? file.bytes.toString('base64') : null,
      }))
      let lastUser = history && typeof history.messages === 'function'
        ? history.messages(String(target.chatId), target.type === 'private' ? userId : undefined).filter((entry) => entry.role === 'user').at(-1)
        : undefined
      if (lastUser && typeof history.patch === 'function') {
        const deliveredAt = new Date().toISOString()
        const readAt = !delivery?.silent && messages.length > 0 ? deliveredAt : undefined
        lastUser = await history.patch(String(target.chatId), lastUser.id, {
          deliveredAt,
          ...(readAt ? { readAt } : {}),
        }) || lastUser
      }
      const payload = {
        messages,
        files,
        silent: Boolean(delivery?.silent),
        ...(lastUser && typeof lastUser.id === 'string' ? {
          userMessage: {
            id: lastUser.id,
            text: lastUser.content,
            status: lastUser.readAt ? 'read' : lastUser.deliveredAt ? 'delivered' : 'sent',
          },
        } : {}),
      }
      if (streaming) {
        emit({ type: 'done', ...payload })
        response.end()
      } else {
        sendJson(response, 200, payload)
      }
    } catch (error) {
      logger?.warn?.('web chat failed', { error: error?.message ?? error, userId })
      if (streaming) {
        emit({ type: 'error', error: 'Не удалось получить ответ от ассистента' })
        response.end()
      } else {
        sendError(response, 500, ERROR_CODES.internal, 'Не удалось получить ответ от ассистента')
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      chatInFlight.delete(String(userId) + ':' + String(target.chatId))
    }
  }

  const avatarCache = new Map()

  /** GET /api/calendar.ics — экспорт напоминаний и событий в iCalendar. */
  function exportCalendar(request, response, { userId, chatId }) {
    request.resume()
    const reminders = pickStore(stores.reminders)
    const events = pickStore(stores.events)
    const items = []
    if (reminders && typeof reminders.list === 'function') {
      for (const reminder of reminders.list(chatId, userId)) items.push({ kind: 'Напоминание', title: reminder.text, at: reminder.dueAt, id: reminder.id })
    }
    if (events && typeof events.upcoming === 'function') {
      for (const event of events.upcoming(chatId, { days: 365, userId })) items.push({ kind: 'Событие', title: event.title, at: event.at, id: event.id, place: event.place })
    }
    const stamp = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const clean = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TenKrol//Assistant//RU', 'CALSCALE:GREGORIAN']
    items.forEach((item) => {
      lines.push('BEGIN:VEVENT')
      lines.push('UID:' + clean(item.id || item.at) + '@tenkrol.ru')
      lines.push('DTSTAMP:' + stamp(new Date()))
      lines.push('DTSTART:' + stamp(item.at))
      lines.push('SUMMARY:' + clean(item.kind + ': ' + item.title))
      if (item.place) lines.push('LOCATION:' + clean(item.place))
      lines.push('DESCRIPTION:' + clean('Экспорт из мобильного пульта TenKrol'))
      lines.push('END:VEVENT')
    })
    lines.push('END:VCALENDAR')
    const body = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')
    response.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-length': String(body.length),
      'content-disposition': 'attachment; filename="tenkrol-calendar.ics"',
      'cache-control': 'private, no-store',
    })
    response.end(body)
  }

  /** Инбокс: короткие заметки пользователя. */
  function listInbox(request, response, { userId }) {
    request.resume()
    if (!inbox || typeof inbox.list !== 'function') return missingStore(response, 'инбокс')
    sendJson(response, 200, { items: inbox.list(userId) })
  }

  async function addInboxItem(request, response, { userId }) {
    if (!inbox || typeof inbox.add !== 'function') return missingStore(response, 'инбокс')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const item = await inbox.add({ userId, text: body.value?.text })
      sendJson(response, 200, { item })
    } catch (error) {
      if (error?.code === 'conflict') return sendError(response, 409, ERROR_CODES.conflict, error.message)
      return badRequest(response, error?.message || 'Не удалось добавить заметку')
    }
  }

  async function updateInboxItem(request, response, { userId }) {
    if (!inbox || typeof inbox.toggle !== 'function') return missingStore(response, 'инбокс')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const item = await inbox.toggle({ userId, itemId: body.value?.itemId, done: body.value?.done })
      sendJson(response, 200, { item })
    } catch (error) {
      if (error?.code === 'not_found') return notFound(response)
      return badRequest(response, error?.message || 'Не удалось обновить заметку')
    }
  }

  async function deleteInboxItem(request, response, { userId, url }) {
    if (!inbox || typeof inbox.remove !== 'function') return missingStore(response, 'инбокс')
    request.resume()
    try {
      await inbox.remove({ userId, itemId: url.searchParams.get('id') })
      sendJson(response, 200, { ok: true })
    } catch (error) {
      if (error?.code === 'not_found') return notFound(response)
      return badRequest(response, error?.message || 'Не удалось удалить заметку')
    }
  }

  /** GET /api/system — состояние сервера и список бэкапов. */
  async function getSystem(request, response) {
    request.resume()
    if (typeof systemStatus !== 'function') return missingStore(response, 'состояние сервера')
    try {
      sendJson(response, 200, await systemStatus())
    } catch (error) {
      logger?.warn?.('system status failed', { error: error?.message ?? error })
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось получить состояние сервера')
    }
  }

  /** GET /api/files — документы, доступные пользователю. */
  function listFiles(request, response, { userId }) {
    request.resume()
    if (!documents || typeof documents.list !== 'function') return missingStore(response, 'файлы')
    const files = documents.list(userId)
      .slice()
      .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))
      .slice(0, 100)
      .map((document) => ({
        id: String(document.id),
        name: safeText(document.fileName, 160),
        mime: safeText(document.mime, 100),
        size: Number(document.size) || 0,
        status: String(document.processingStatus ?? 'ready'),
        createdAt: document.createdAt ?? null,
        updatedAt: document.updatedAt ?? document.createdAt ?? null,
      }))
    sendJson(response, 200, { files })
  }

  const photoCache = new Map()

  /** GET /api/photos/search — поиск фотографий через Openverse. */
  async function searchPhotos(request, response, { url }) {
    request.resume()
    const query = String(url.searchParams.get('q') ?? '').trim()
    if (query.length < 2) return badRequest(response, 'Запрос минимум из 2 символов')
    const cached = photoCache.get(query.toLowerCase())
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return sendJson(response, 200, { query, photos: cached.photos })
    try {
      const target = new URL('https://api.openverse.org/v1/images/')
      target.searchParams.set('q', query)
      target.searchParams.set('page_size', '20')
      target.searchParams.set('mature', 'false')
      const api = await fetch(target, { headers: { 'user-agent': 'TenKrol/1.0 (https://tenkrol.ru)' } })
      if (!api.ok) throw new Error('Openverse HTTP ' + api.status)
      const data = await api.json()
      const photos = (Array.isArray(data.results) ? data.results : []).map((item) => ({
        id: String(item.id ?? ''),
        title: String(item.title || 'Без названия').slice(0, 200),
        thumbnail: String(item.thumbnail || item.url || ''),
        url: String(item.url || ''),
        source: String(item.source || item.provider || ''),
        creator: String(item.creator || ''),
        license: String(item.license || '').toUpperCase(),
        page: String(item.foreign_landing_url || ''),
      })).filter((item) => /^https:\/\//.test(item.thumbnail))
      photoCache.set(query.toLowerCase(), { at: Date.now(), photos })
      while (photoCache.size > 30) photoCache.delete(photoCache.keys().next().value)
      sendJson(response, 200, { query, photos })
    } catch (error) {
      logger?.warn?.('photo search failed', { error: error?.message ?? error })
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось найти фотографии')
    }
  }

  /** GET /api/photos/generate?prompt=... — генерация изображения через внешний сервис. */
  async function generatePhoto(request, response, { url }) {
    request.resume()
    const prompt = String(url.searchParams.get('prompt') ?? '').trim().slice(0, 500)
    if (prompt.length < 3) return badRequest(response, 'Опишите изображение')
    try {
      const target = new URL('https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt))
      target.searchParams.set('width', '768')
      target.searchParams.set('height', '768')
      target.searchParams.set('nologo', 'true')
      target.searchParams.set('safe', 'true')
      const image = await fetch(target, { signal: AbortSignal.timeout(90_000), headers: { 'user-agent': 'TenKrol/1.0' } })
      if (!image.ok) throw new Error('Image service HTTP ' + image.status)
      const bytes = Buffer.from(await image.arrayBuffer())
      response.writeHead(200, {
        'content-type': image.headers.get('content-type') || 'image/jpeg',
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=300',
      })
      response.end(bytes)
    } catch (error) {
      logger?.warn?.('photo generation failed', { error: error?.message ?? error })
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось сгенерировать изображение')
    }
  }

  const youtubeSearchCache = new Map()
  const youtubeThumbCache = new Map()

  /** GET /api/youtube/thumb?id=... — превью через сервер (локально ytimg может быть закрыт). */
  async function youtubeThumb(request, response, { url }) {
    request.resume()
    const id = String(url.searchParams.get('id') ?? '')
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return notFound(response)
    const cached = youtubeThumbCache.get(id)
    if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(cached.bytes.length), 'cache-control': 'public, max-age=21600' })
      return response.end(cached.bytes)
    }
    try {
      const image = await fetch('https://i.ytimg.com/vi/' + id + '/mqdefault.jpg')
      if (!image.ok) return notFound(response)
      const bytes = Buffer.from(await image.arrayBuffer())
      youtubeThumbCache.set(id, { at: Date.now(), bytes })
      while (youtubeThumbCache.size > 100) youtubeThumbCache.delete(youtubeThumbCache.keys().next().value)
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(bytes.length), 'cache-control': 'public, max-age=21600' })
      response.end(bytes)
    } catch (error) {
      logger?.warn?.('youtube thumb failed', { error: error?.message ?? error })
      notFound(response)
    }
  }


  /** Поиск YouTube через публичную страницу результатов (без API-ключа). */
  async function searchYoutube(request, response, { url }) {
    request.resume()
    const query = String(url.searchParams.get('q') ?? '').trim()
    if (query.length < 2) return badRequest(response, 'Запрос минимум из 2 символов')
    const cached = youtubeSearchCache.get(query.toLowerCase())
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return sendJson(response, 200, { query, videos: cached.videos })
    try {
      const target = new URL('https://www.youtube.com/results')
      target.searchParams.set('search_query', query)
      target.searchParams.set('hl', 'ru')
      const page = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; TenKrol/1.0)' } })
      if (!page.ok) throw new Error('YouTube HTTP ' + page.status)
      const html = await page.text()
      const start = html.indexOf('ytInitialData = ')
      if (start === -1) throw new Error('Нет данных YouTube')
      const from = start + 'ytInitialData = '.length
      const end = html.indexOf(';</script>', from)
      const data = JSON.parse(html.slice(from, end))
      const videos = []
      const seen = new Set()
      const visit = (node) => {
        if (!node || typeof node !== 'object' || videos.length >= 12) return
        if (node.videoRenderer || node.compactVideoRenderer) {
          const item = node.videoRenderer ?? node.compactVideoRenderer
          const id = String(item.videoId ?? '')
          if (id !== '' && !seen.has(id)) {
            seen.add(id)
            const thumb = item.thumbnail?.thumbnails?.at(-1)?.url
            videos.push({
              id,
              title: String(item.title?.runs?.[0]?.text ?? item.title?.simpleText ?? 'Без названия'),
              channel: String(item.ownerText?.runs?.[0]?.text ?? item.longBylineText?.runs?.[0]?.text ?? ''),
              duration: String(item.lengthText?.simpleText ?? ''),
              views: String(item.viewCountText?.simpleText ?? item.shortViewCountText?.simpleText ?? ''),
              published: String(item.publishedTimeText?.simpleText ?? ''),
              thumbnail: '/api/youtube/thumb?id=' + encodeURIComponent(id),
            })
          }
          return
        }
        for (const value of Object.values(node)) visit(value)
      }
      visit(data)
      youtubeSearchCache.set(query.toLowerCase(), { at: Date.now(), videos })
      while (youtubeSearchCache.size > 30) youtubeSearchCache.delete(youtubeSearchCache.keys().next().value)
      sendJson(response, 200, { query, videos })
    } catch (error) {
      logger?.warn?.('youtube search failed', { error: error?.message ?? error })
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось найти видео на YouTube')
    }
  }

  /** GET /api/disk — папка агента на Яндекс.Диске. */
  async function listDiskFiles(request, response) {
    request.resume()
    if (!yandexDisk || !yandexDisk.enabled) {
      return sendJson(response, 200, { configured: false, files: [] })
    }
    try {
      const files = await yandexDisk.listAgentFiles()
      sendJson(response, 200, { configured: true, files })
    } catch (error) {
      logger?.warn?.('disk list failed', { error: error?.message ?? error })
      sendJson(response, 200, { configured: true, files: [], error: 'Не удалось получить файлы с Диска' })
    }
  }

  /** GET /api/disk/download?path=... — скачать файл из папки агента. */
  async function downloadDiskFile(request, response, { url }) {
    request.resume()
    if (!yandexDisk || !yandexDisk.enabled) return notFound(response)
    try {
      const bytes = await yandexDisk.download(url.searchParams.get('path'))
      const name = String(url.searchParams.get('path') || 'agent-file').split('/').pop()
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'private, no-store',
      })
      response.end(bytes)
    } catch (error) {
      if (error?.status === 403) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой путь')
      if (error?.status === 404) return notFound(response)
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось скачать файл с Диска')
    }
  }

  /** DELETE /api/disk?path=... — удалить файл из папки агента на Диске. */
  async function deleteDiskFile(request, response, { url }) {
    request.resume()
    if (!yandexDisk || !yandexDisk.enabled) return notFound(response)
    try {
      await yandexDisk.remove(url.searchParams.get('path'))
      sendJson(response, 200, { ok: true })
    } catch (error) {
      if (error?.status === 403) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой путь')
      if (error?.status === 404) return notFound(response)
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось удалить файл с Диска')
    }
  }

  /** GET /api/files/agent — файлы, которые прислал агент. */
  function listAgentFiles(request, response, { userId }) {
    request.resume()
    if (!agentFiles || typeof agentFiles.list !== 'function') return missingStore(response, 'файлы агента')
    const chats = [String(userId)]
    if (groupConfigured) chats.push(String(groupIdNumber))
    const files = chats
      .flatMap((chatId) => agentFiles.list(chatId))
      .sort((left, right) => String(right.at).localeCompare(String(left.at)))
      .map((item) => ({
        id: String(item.id),
        name: safeText(item.name, 160),
        mime: safeText(item.mime, 100),
        size: Number(item.size) || 0,
        at: item.at,
        ...(item.caption ? { caption: safeText(item.caption, 300) } : {}),
        ...(item.eventTitle ? { eventTitle: safeText(item.eventTitle, 200) } : {}),
      }))
    sendJson(response, 200, { files })
  }

  function agentFileAccess(auth, id) {
    if (!agentFiles || typeof agentFiles.list !== 'function') return undefined
    const chats = [String(auth.userId)]
    if (groupConfigured) chats.push(String(groupIdNumber))
    for (const chatId of chats) {
      const item = agentFiles.list(chatId).find((entry) => String(entry.id) === String(id))
      if (item) return { item, chatId }
    }
    return undefined
  }

  /** GET /api/files/agent/:id/download — скачать файл агента. */
  async function downloadAgentFile(request, response, { auth, params }) {
    request.resume()
    const found = agentFileAccess(auth, params?.[0])
    if (!found) return notFound(response)
    let bytes
    try {
      bytes = await fs.promises.readFile(agentFiles.getPath(found.item))
    } catch {
      return notFound(response)
    }
    const name = String(found.item.name || 'agent-file').replace(/[\r\n"]/g, '')
    response.writeHead(200, {
      'content-type': found.item.mime || 'application/octet-stream',
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
    })
    response.end(bytes)
  }

  /** DELETE /api/files/agent/:id — удалить файл агента. */
  async function deleteAgentFile(request, response, { auth, params }) {
    request.resume()
    const found = agentFileAccess(auth, params?.[0])
    if (!found) return notFound(response)
    await agentFiles.remove({ chatId: found.chatId, id: found.item.id })
    sendJson(response, 200, { ok: true })
  }

  /** GET /api/files/search — поиск по содержимому документов. */
  async function searchFiles(request, response, { userId, url }) {
    request.resume()
    if (!documents || typeof documents.search !== 'function') return missingStore(response, 'файлы')
    const query = String(url.searchParams.get('q') ?? '').trim()
    if (query.length < 2) return badRequest(response, 'Запрос минимум из 2 символов')
    try {
      const result = await documents.search({ userId, query, limit: 10 })
      sendJson(response, 200, {
        query,
        results: (result.results ?? []).map((item) => ({
          documentId: item.citation.documentId,
          name: safeText(item.citation.documentName, 160),
          snippet: safeText(item.citation.snippet, 600),
          ...(item.citation.page ? { page: item.citation.page } : {}),
          ...(item.citation.versionNumber ? { version: item.citation.versionNumber } : {}),
        })),
        semantic: Boolean(result.semantic),
      })
    } catch (error) {
      logger?.warn?.('files search failed', { error: error?.message ?? error })
      sendError(response, 502, ERROR_CODES.unavailable, 'Поиск по файлам недоступен')
    }
  }

  /** GET /api/files/:id/download — оригинал документа. */
  async function downloadFile(request, response, { userId, params }) {
    request.resume()
    if (!documents || typeof documents.createDownloadLink !== 'function' || typeof documents.resolveDownloadLink !== 'function') {
      return missingStore(response, 'файлы')
    }
    const link = await documents.createDownloadLink({ userId, documentId: params?.[0] })
    if (!link) return notFound(response)
    const resolved = await documents.resolveDownloadLink({ token: link.token, userId })
    if (!resolved) return notFound(response)
    let bytes
    try {
      bytes = await fs.promises.readFile(resolved.filePath)
    } catch {
      return notFound(response)
    }
    const name = String(resolved.fileName || 'document').replace(/[\r\n"]/g, '')
    response.writeHead(200, {
      'content-type': resolved.version?.mime || 'application/octet-stream',
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
    })
    response.end(bytes)
  }

  /** POST /api/chat/upload — принять фото или видео с телефона. */
  async function uploadMedia(request, response, { userId }) {
    if (!mediaStore || typeof mediaStore.add !== 'function') {
      request.resume()
      return missingStore(response, 'медиа')
    }
    const mime = String(request.headers['content-type'] ?? '').toLowerCase()
    if (!mime.startsWith('image/') && !mime.startsWith('video/') && !mime.startsWith('audio/')) {
      request.resume()
      return badRequest(response, 'Можно прикреплять только фото, видео и голосовые')
    }
    const rawName = request.headers['x-file-name']
    const name = typeof rawName === 'string' ? safeDecode(rawName) : undefined
    const body = await readBinaryBody(request, maxMediaBytes)
    if (!body.ok) return sendError(response, body.status, ERROR_CODES.tooLarge, body.error)
    try {
      const item = await mediaStore.add({ userId, bytes: body.bytes, name, mime })
      sendJson(response, 201, mediaStore.publicItem(item))
    } catch (error) {
      logger?.warn?.('media upload failed', { error: error?.message ?? error, userId })
      badRequest(response, String(error?.message ?? 'Не удалось сохранить файл'))
    }
  }

  /** GET /api/media/:id — отдать фото/видео с Range для <video>. */
  async function getMedia(request, response, { params }) {
    if (!mediaStore || typeof mediaStore.read !== 'function') {
      request.resume()
      return notFound(response)
    }
    const entry = await mediaStore.read(params?.[0]).catch(() => null)
    if (!entry) return notFound(response)
    const { item, bytes } = entry
    const range = String(request.headers.range ?? '')
    const baseHeaders = {
      'content-type': item.mime || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (match) {
      const start = Number(match[1])
      const end = match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1)
      if (!Number.isFinite(start) || start > end || start >= bytes.length) {
        response.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${bytes.length}` })
        return response.end()
      }
      response.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'content-length': String(end - start + 1),
      })
      return response.end(bytes.subarray(start, end + 1))
    }
    response.writeHead(200, { ...baseHeaders, 'content-length': String(bytes.length) })
    response.end(bytes)
  }

  /** PATCH /api/chat/message/:id — изменить текст своего сообщения. */
  async function editChatMessageHandler(request, response, { userId, auth, params }) {
    if (!history || typeof history.edit !== 'function') return missingStore(response, 'история чата')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const target = resolveChat(body.value?.chatId, auth)
    if (!target) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой чат')
    const text = String(body.value?.text ?? '').trim()
    if (text === '' || text.length > CHAT_MESSAGE_MAX) return badRequest(response, 'Некорректный текст')
    const message = history.message(target.chatId, params?.[0])
    if (!message) return notFound(response)
    if (message.role !== 'user') return sendError(response, 403, ERROR_CODES.forbidden, 'Можно менять только свои сообщения')
    const updated = await history.edit(target.chatId, params[0], text)
    if (message.telegramMessageId && typeof editChatMessage === 'function') {
      await editChatMessage({ chatId: target.chatId, messageId: message.telegramMessageId, text }).catch((error) => {
        logger?.warn?.('telegram edit failed', { error: error?.message ?? error })
      })
    }
    sendJson(response, 200, { ok: true, message: { id: updated.id, text: updated.content } })
  }

  /** DELETE /api/chat/message/:id — удалить сообщение из истории и Telegram. */
  async function deleteChatMessageHandler(request, response, { auth, params }) {
    if (!history || typeof history.remove !== 'function') return missingStore(response, 'история чата')
    request.resume()
    const target = resolveChat(new URL(request.url, 'http://localhost').searchParams.get('chatId'), auth)
    if (!target) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой чат')
    const message = history.message(target.chatId, params?.[0])
    if (!message) return notFound(response)
    if (message.role !== 'user') return sendError(response, 403, ERROR_CODES.forbidden, 'Можно удалять только свои сообщения')
    await history.remove(target.chatId, params[0])
    if (message.telegramMessageId && typeof deleteChatMessage === 'function') {
      await deleteChatMessage({ chatId: target.chatId, messageId: message.telegramMessageId }).catch((error) => {
        logger?.warn?.('telegram delete failed', { error: error?.message ?? error })
      })
    }
    sendJson(response, 200, { ok: true })
  }

  /** POST /api/chat/react — поставить/снять реакцию на сообщение. */
  async function reactMessage(request, response, { userId, auth }) {
    if (!history || typeof history.react !== 'function') return missingStore(response, 'история чата')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const target = resolveChat(body.value?.chatId, auth)
    if (!target) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой чат')
    const messageId = String(body.value?.messageId ?? '')
    const reaction = String(body.value?.reaction ?? '')
    const allowed = new Set(['👍', '❤️', '🔥', '😂', '😮', ''])
    if (messageId === '' || !allowed.has(reaction)) return badRequest(response, 'Недопустимая реакция')
    const message = await history.react(target.chatId, messageId, reaction)
    if (!message) return notFound(response)
    sendJson(response, 200, { ok: true, messageId, reaction: message.reaction ?? '' })
  }

  /** GET /api/chat/search — поиск по истории выбранного чата. */
  function searchChat(request, response, { userId, auth, url }) {
    request.resume()
    if (!history || typeof history.messages !== 'function') return missingStore(response, 'история чата')
    const target = resolveChat(url.searchParams.get('chatId'), auth)
    if (!target) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой чат')
    const query = String(url.searchParams.get('q') ?? '').trim().toLowerCase()
    if (query.length < 2) return badRequest(response, 'Запрос минимум из 2 символов')
    const results = history.messages(target.chatId, target.type === 'private' ? userId : undefined)
      .filter((message) => String(message.content ?? '').toLowerCase().includes(query))
      .slice(-50)
      .reverse()
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        text: safeText(message.content, 600),
        ...(typeof message.author === 'string' && message.author !== '' ? { author: safeText(message.author, 80) } : {}),
        ...(typeof message.at === 'string' ? { at: message.at } : {}),
      }))
    sendJson(response, 200, { query, results })
  }

  /** GET /api/avatar/:userId — фото профиля Telegram для автора сообщения. */
  async function getAvatar(request, response, { params }) {
    request.resume()
    const target = Number(params?.[0])
    if (!Number.isInteger(target) || !allowed.has(String(target))) {
      return sendError(response, 403, ERROR_CODES.forbidden, 'Нет доступа')
    }
    if (typeof avatarProvider !== 'function') return notFound(response)
    const now = timeNow()
    const cached = avatarCache.get(target)
    if (cached && now - cached.at < 60 * 60 * 1000) {
      if (!cached.avatar) return notFound(response)
      response.writeHead(200, {
        'content-type': cached.avatar.mime || 'image/jpeg',
        'content-length': String(cached.avatar.bytes.length),
        'cache-control': 'private, max-age=3600',
      })
      return response.end(cached.avatar.bytes)
    }
    let avatar
    try {
      avatar = await avatarProvider(target)
    } catch (error) {
      logger?.warn?.('avatar fetch failed', { userId: target, error: error?.message ?? error })
    }
    // Отрицательный результат не кэшируем: человек может открыть фото в
    // Telegram, и следующий запрос должен его подхватить.
    if (!avatar || !Buffer.isBuffer(avatar.bytes) || avatar.bytes.length === 0) return notFound(response)
    avatarCache.set(target, { at: now, avatar })
    if (avatarCache.size > 30) {
      const oldest = [...avatarCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) avatarCache.delete(oldest[0])
    }
    response.writeHead(200, {
      'content-type': avatar.mime || 'image/jpeg',
      'content-length': String(avatar.bytes.length),
      'cache-control': 'private, max-age=3600',
    })
    response.end(avatar.bytes)
  }

  function chatHistory(request, response, { userId, chatId, auth, url }) {
    if (!history || typeof history.messages !== 'function') {
      return missingStore(response, 'история чата')
    }
    const target = resolveChat(url.searchParams.get('chatId'), auth)
    if (!target) return sendError(response, 403, ERROR_CODES.forbidden, 'Чужой чат')
    const rawLimit = Number(url.searchParams.get('limit'))
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, CHAT_HISTORY_LIMIT)
      : CHAT_HISTORY_LIMIT
    const authorIds = new Map()
    if (stores.profiles && stores.profiles.users) {
      for (const profileId of stores.profiles.users.keys()) {
        const name = displayNameFor(profileId)
        if (name) authorIds.set(String(name), Number(profileId))
      }
    }
    const messages = history.messages(target.chatId, target.type === 'private' ? userId : undefined)
      .slice(-limit)
      .map((message) => {
        const author = typeof message.author === 'string' && message.author !== '' ? safeText(message.author, 80) : undefined
        const authorId = author ? authorIds.get(String(author)) : undefined
        return {
          role: message.role === 'assistant' ? 'assistant' : 'user',
          text: safeText(message.content),
          ...(typeof message.id === 'string' ? { id: message.id } : {}),
          ...(typeof message.reaction === 'string' && message.reaction !== '' ? { reaction: message.reaction } : {}),
          ...(typeof message.deliveredAt === 'string' ? { deliveredAt: message.deliveredAt } : {}),
          ...(typeof message.readAt === 'string' ? { readAt: message.readAt } : {}),
          ...(typeof message.at === 'string' ? { at: message.at } : {}),
          ...(author ? { author } : {}),
          ...(authorId ? { avatar: `/api/avatar/${authorId}` } : {}),
          ...(message.replyTo && typeof message.replyTo.text === 'string' && message.replyTo.text !== ''
            ? {
              replyTo: {
                text: safeText(message.replyTo.text, 600),
                ...(message.replyTo.author ? { author: safeText(message.replyTo.author, 80) } : {}),
              },
            }
            : {}),
          ...(Array.isArray(message.attachments) && message.attachments.length > 0
            ? {
              attachments: message.attachments
                .filter((item) => item && typeof item.url === 'string' && item.url.startsWith('/api/media/'))
                .map((item) => ({
                  id: String(item.id ?? ''), kind: ['photo', 'video', 'voice'].includes(item.kind) ? item.kind : 'photo',
                  name: safeText(item.name, 120), mime: safeText(item.mime, 100),
                  size: Number(item.size) || 0, url: item.url,
                })),
            }
            : {}),
        }
      })
    sendJson(response, 200, { messages, telegramUrl, chat: target })
  }

  function settingsSnapshot(userId, chatId, auth) {
    const profiles = pickStore(stores.profiles)
    const displayName = profiles && typeof profiles.displayName === 'function'
      ? profiles.displayName(userId)
      : undefined
    return {
      user: {
        name: String(displayName || auth.user?.first_name || mobileUserName),
        via: auth.via,
        login: auth.login ?? null,
        role: auth.role ?? null,
      },
      city: profiles && typeof profiles.city === 'function' ? profiles.city(userId) ?? null : null,
      persona: profiles && typeof profiles.persona === 'function' ? profiles.persona(userId) ?? null : null,
      mood: profiles && typeof profiles.mood === 'function' ? profiles.mood(userId) ?? null : null,
      mode: profiles && typeof profiles.mode === 'function' ? profiles.mode(userId) ?? null : null,
      voice: history && typeof history.voice === 'function' ? history.voice(chatId) === true : false,
      model: history && typeof history.model === 'function' ? history.model(chatId) ?? null : null,
      defaults: { model: defaultModel || null },
      options: {
        personas: [...PERSONA_NAMES],
        moods: [...MOOD_NAMES],
        modes: Object.keys(MODES),
        models,
      },
      telegramUrl,
    }
  }

  /** GET /api/proactive — личные настройки проактивности. */
  async function getProactive(request, response, { userId }) {
    request.resume()
    if (typeof proactiveSettings !== 'function') return missingStore(response, 'проактивность')
    const value = await proactiveSettings({ userId })
    sendJson(response, 200, value ?? {})
  }

  /** PATCH /api/proactive — время обзора, тихие часы, лимит и включение. */
  async function patchProactive(request, response, { userId }) {
    if (typeof updateProactive !== 'function') {
      request.resume()
      return missingStore(response, 'проактивность')
    }
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const values = body.value ?? {}
    const patch = {}
    if (Object.prototype.hasOwnProperty.call(values, 'enabled')) {
      if (typeof values.enabled !== 'boolean') return badRequest(response, 'enabled должен быть true/false')
      patch.enabled = values.enabled
    }
    if (Object.prototype.hasOwnProperty.call(values, 'reviewAt')) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(values.reviewAt ?? ''))) return badRequest(response, 'Время обзора в формате HH:MM')
      patch.reviewAt = values.reviewAt
    }
    if (Object.prototype.hasOwnProperty.call(values, 'dayLimit')) {
      const limit = Number(values.dayLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) return badRequest(response, 'Лимит от 1 до 20')
      patch.dayLimit = limit
    }
    if (Object.prototype.hasOwnProperty.call(values, 'quietStart') || Object.prototype.hasOwnProperty.call(values, 'quietEnd')) {
      const toMinutes = (value) => {
        const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''))
        return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
      }
      const start = toMinutes(values.quietStart)
      const end = toMinutes(values.quietEnd)
      if (start === undefined || end === undefined) return badRequest(response, 'Тихие часы в формате HH:MM')
      patch.quiet = { start, end }
    }
    try {
      const value = await updateProactive(patch, { userId })
      sendJson(response, 200, value ?? {})
    } catch (error) {
      badRequest(response, String(error?.message ?? 'Не удалось сохранить настройки'))
    }
  }

  function getSettings(request, response, { userId, chatId, auth }) {
    request.resume()
    sendJson(response, 200, settingsSnapshot(userId, chatId, auth))
  }

  async function updateSettings(request, response, { userId, chatId, auth }) {
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    if (body.value === null || typeof body.value !== 'object' || Array.isArray(body.value)) {
      return badRequest(response, 'Ожидается объект настроек')
    }
    const values = body.value
    const profiles = pickStore(stores.profiles)
    const has = (key) => Object.prototype.hasOwnProperty.call(values, key)
    let changed = false

    if (has('city')) {
      if (!profiles || typeof profiles.setCity !== 'function' || typeof profiles.clearCity !== 'function') {
        return missingStore(response, 'память пользователя')
      }
      if (typeof values.city !== 'string') return badRequest(response, 'Город должен быть строкой')
      try {
        if (values.city.trim() === '') profiles.clearCity(userId)
        else profiles.setCity(userId, values.city)
      } catch (error) {
        return badRequest(response, String(error?.message ?? 'Не удалось изменить город'))
      }
      changed = true
    }

    const simple = [
      ['persona', 'setPersona', new Set(PERSONA_NAMES), 'характер', 'Недопустимый характер'],
      ['mood', 'setMood', new Set(MOOD_NAMES), 'настроение', 'Недопустимое настроение'],
      ['mode', 'setMode', new Set(Object.keys(MODES)), 'режим', 'Недопустимый режим'],
    ]
    for (const [key, method, allowedValues, label, message] of simple) {
      if (!has(key)) continue
      if (!profiles || typeof profiles[method] !== 'function') {
        return missingStore(response, `профиль (${label})`)
      }
      if (typeof values[key] !== 'string') return badRequest(response, `Поле «${label}» должно быть строкой`)
      const clean = values[key].trim()
      if (clean !== '' && !allowedValues.has(clean)) return badRequest(response, message)
      profiles[method](userId, clean)
      changed = true
    }

    if (has('voice')) {
      if (!history || typeof history.setVoice !== 'function') return missingStore(response, 'история чата')
      if (typeof values.voice !== 'boolean') return badRequest(response, 'Озвучка должна быть true или false')
      await history.setVoice(chatId, values.voice)
      changed = true
    }

    if (has('model')) {
      if (!history || typeof history.setModel !== 'function') return missingStore(response, 'история чата')
      if (typeof values.model !== 'string') return badRequest(response, 'Модель должна быть строкой')
      const model = values.model.trim()
      if (model !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model)) {
        return badRequest(response, 'Недопустимое имя модели')
      }
      await history.setModel(chatId, model === '' ? undefined : model)
      changed = true
    }

    if (changed) {
      await Promise.all([
        profiles && typeof profiles.flush === 'function' ? profiles.flush() : Promise.resolve(),
        history && typeof history.flush === 'function' ? history.flush() : Promise.resolve(),
      ])
    }
    sendJson(response, 200, settingsSnapshot(userId, chatId, auth))
  }

  function getStats(request, response, { url }) {
    request.resume()
    const usage = pickStore(stores.usage)
    if (!usage || typeof usage.total !== 'function') return missingStore(response, 'расход токенов')
    const rawDays = Number(url.searchParams.get('days'))
    const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 30 ? rawDays : 7
    const todayDate = new Date(timeNow())
    const today = usage.total(todayDate, timeZone)
    const prompt = asCount(today?.prompt)
    const completion = asCount(today?.completion)
    const historyDays = typeof usage.recent === 'function'
      ? usage.recent(days, todayDate, timeZone)
      : []
    sendJson(response, 200, {
      today: {
        prompt,
        completion,
        total: prompt + completion,
        requests: asCount(today?.requests),
      },
      days: historyDays,
      limit: Number(usage.dailyLimit) || 0,
    })
  }

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

  const mapProject = (item) => ({
    id: String(item.id),
    name: String(item.name),
    instructions: String(item.instructions ?? ''),
    createdAt: item.createdAt,
  })

  function listProjects(request, response, { userId }) {
    request.resume()
    if (!mobileProjects || typeof mobileProjects.list !== 'function') return sendJson(response, 200, { projects: [] })
    sendJson(response, 200, { projects: mobileProjects.list(userId).map(mapProject) })
  }

  async function createProject(request, response, { userId }) {
    if (!mobileProjects || typeof mobileProjects.add !== 'function') return missingStore(response, 'проекты')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const item = await mobileProjects.add({ userId, name: body.value?.name, instructions: body.value?.instructions })
      sendJson(response, 200, { project: mapProject(item) })
    } catch (error) {
      return badRequest(response, error?.message || 'Не удалось создать проект')
    }
  }

  async function updateProject(request, response, { userId, params }) {
    if (!mobileProjects || typeof mobileProjects.update !== 'function') return missingStore(response, 'проекты')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const item = await mobileProjects.update({ userId, id: params[0], name: body.value?.name, instructions: body.value?.instructions })
      sendJson(response, 200, { project: mapProject(item) })
    } catch (error) {
      if (error?.code === 'not_found') return notFound(response)
      return badRequest(response, error?.message || 'Не удалось обновить проект')
    }
  }

  async function deleteProject(request, response, { userId, params }) {
    request.resume()
    if (!mobileProjects || typeof mobileProjects.remove !== 'function') return missingStore(response, 'проекты')
    try {
      await mobileProjects.remove({ userId, id: params[0] })
      sendJson(response, 200, { ok: true })
    } catch (error) {
      if (error?.code === 'not_found') return notFound(response)
      return badRequest(response, error?.message || 'Не удалось удалить проект')
    }
  }

  const mapQuiz = (day) => ({
    date: day.date,
    questions: (day.questions ?? []).map((question) => ({
      id: String(question.id),
      text: String(question.text),
      answer: day.answers?.[question.id] ?? null,
    })),
  })

  async function getQuiz(request, response, { userId }) {
    request.resume()
    if (!mobileQuiz || typeof mobileQuiz.ensure !== 'function') return missingStore(response, 'опрос')
    try {
      const day = await mobileQuiz.ensure({ userId, generate: quizGenerator })
      sendJson(response, 200, mapQuiz(day))
    } catch (error) {
      logger?.warn?.('quiz failed', { error: error?.message ?? error })
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось подготовить вопросы')
    }
  }

  async function answerQuiz(request, response, { userId }) {
    if (!mobileQuiz || typeof mobileQuiz.answer !== 'function') return missingStore(response, 'опрос')
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    try {
      const result = await mobileQuiz.answer({ userId, questionId: body.value?.questionId, text: body.value?.text })
      const profiles = pickStore(stores.profiles)
      if (profiles && typeof profiles.addFact === 'function') {
        profiles.addFact(userId, `На вопрос «${result.question.text}» ответил: ${result.answer}`, { confirmationStatus: 'confirmed' })
        await profiles.flush()
      }
      const day = mobileQuiz.get(userId)
      sendJson(response, 200, { ok: true, quiz: mapQuiz(day) })
    } catch (error) {
      return badRequest(response, error?.message || 'Не удалось сохранить ответ')
    }
  }

  /** GET /api/memory/export — выгрузка памяти в JSON. */
  function exportMemory(request, response, { userId }) {
    request.resume()
    const profiles = pickStore(stores.profiles)
    if (!profiles || typeof profiles.facts !== 'function') return missingStore(response, 'память')
    const body = Buffer.from(JSON.stringify({
      exportedAt: new Date().toISOString(),
      city: typeof profiles.city === 'function' ? profiles.city(userId) ?? null : null,
      facts: profiles.facts(userId).map((fact) => ({
        text: String(fact.text ?? ''),
        ...(fact.confirmationStatus ? { confirmationStatus: fact.confirmationStatus } : {}),
        ...(fact.createdAt ? { createdAt: fact.createdAt } : {}),
      })),
    }, null, 2), 'utf8')
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'content-disposition': 'attachment; filename="tenkrol-memory.json"',
      'cache-control': 'private, no-store',
    })
    response.end(body)
  }

  async function getMemory(request, response, { userId }) {
    const profiles = pickStore(stores.profiles)
    if (!profiles || typeof profiles.facts !== 'function') return missingStore(response, 'память')
    const facts = profiles.facts(userId).map((fact) => ({
      id: String(fact.id),
      text: String(fact.text ?? ''),
      confirmationStatus: fact.confirmationStatus === 'assumption' ? 'assumption' : 'confirmed',
    }))
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

  async function updateFact(request, response, { userId, params }) {
    const profiles = pickStore(stores.profiles)
    if (!profiles || typeof profiles.updateFact !== 'function') return missingStore(response, 'память')
    const id = safeDecode(params[0])
    if (id === undefined) return notFound(response)
    const body = await readJsonBody(request, bodyLimit)
    if (!body.ok) return sendError(response, body.status, body.code, body.error)
    const patch = {}
    if (typeof body.value?.text === 'string') {
      const text = body.value.text.trim()
      if (text === '' || text.length > MAX_FACT_LENGTH) return badRequest(response, 'Некорректный текст факта')
      patch.text = text
    }
    if (body.value?.confirmationStatus !== undefined) {
      if (!['confirmed', 'assumption'].includes(body.value.confirmationStatus)) return badRequest(response, 'Некорректный статус')
      patch.confirmationStatus = body.value.confirmationStatus
    }
    if (Object.keys(patch).length === 0) return badRequest(response, 'Нет изменений')
    const updated = profiles.updateFact(userId, id, patch)
    if (!updated) return notFound(response)
    await profiles.flush()
    sendJson(response, 200, {
      id: String(updated.id),
      text: String(updated.text ?? ''),
      confirmationStatus: updated.confirmationStatus === 'assumption' ? 'assumption' : 'confirmed',
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
    { method: 'GET', pattern: /^\/api\/memory\/export$/, handler: exportMemory },
    { method: 'GET', pattern: /^\/api\/projects$/, handler: listProjects },
    { method: 'POST', pattern: /^\/api\/projects$/, handler: createProject },
    { method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)$/, handler: updateProject },
    { method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)$/, handler: deleteProject },
    { method: 'GET', pattern: /^\/api\/quiz$/, handler: getQuiz },
    { method: 'POST', pattern: /^\/api\/quiz\/answer$/, handler: answerQuiz },
    { method: 'POST', pattern: /^\/api\/memory$/, handler: createFact },
    { method: 'PATCH', pattern: /^\/api\/memory\/([^/]+)$/, handler: updateFact },
    { method: 'DELETE', pattern: /^\/api\/memory\/([^/]+)$/, handler: deleteFact },
    { method: 'GET', pattern: /^\/api\/chats$/, handler: listChats },
    { method: 'GET', pattern: /^\/api\/avatar\/(\d+)$/, handler: getAvatar },
    { method: 'GET', pattern: /^\/api\/inbox$/, handler: listInbox },
    { method: 'POST', pattern: /^\/api\/inbox$/, handler: addInboxItem },
    { method: 'PATCH', pattern: /^\/api\/inbox$/, handler: updateInboxItem },
    { method: 'DELETE', pattern: /^\/api\/inbox$/, handler: deleteInboxItem },
    { method: 'GET', pattern: /^\/api\/calendar\.ics$/, handler: exportCalendar },
    { method: 'GET', pattern: /^\/api\/calendar\/link$/, handler: calendarLink },
    { method: 'GET', pattern: /^\/api\/system$/, handler: getSystem },
    { method: 'GET', pattern: /^\/api\/files\/search$/, handler: searchFiles },
    { method: 'GET', pattern: /^\/api\/photos\/search$/, handler: searchPhotos },
    { method: 'GET', pattern: /^\/api\/photos\/generate$/, handler: generatePhoto },
    { method: 'GET', pattern: /^\/api\/youtube\/thumb$/, handler: youtubeThumb },
    { method: 'GET', pattern: /^\/api\/youtube\/search$/, handler: searchYoutube },
    { method: 'GET', pattern: /^\/api\/disk$/, handler: listDiskFiles },
    { method: 'GET', pattern: /^\/api\/disk\/download$/, handler: downloadDiskFile },
    { method: 'DELETE', pattern: /^\/api\/disk$/, handler: deleteDiskFile },
    { method: 'GET', pattern: /^\/api\/files\/agent$/, handler: listAgentFiles },
    { method: 'GET', pattern: /^\/api\/files\/agent\/([^/]+)\/download$/, handler: downloadAgentFile },
    { method: 'DELETE', pattern: /^\/api\/files\/agent\/([^/]+)$/, handler: deleteAgentFile },
    { method: 'GET', pattern: /^\/api\/files$/, handler: listFiles },
    { method: 'GET', pattern: /^\/api\/files\/([^/]+)\/download$/, handler: downloadFile },
    { method: 'POST', pattern: /^\/api\/chat\/upload$/, handler: uploadMedia },
    { method: 'GET', pattern: /^\/api\/media\/([^/]+)$/, handler: getMedia },
    { method: 'PATCH', pattern: /^\/api\/chat\/message\/([^/]+)$/, handler: editChatMessageHandler },
    { method: 'DELETE', pattern: /^\/api\/chat\/message\/([^/]+)$/, handler: deleteChatMessageHandler },
    { method: 'POST', pattern: /^\/api\/chat\/react$/, handler: reactMessage },
    { method: 'GET', pattern: /^\/api\/chat\/search$/, handler: searchChat },
    { method: 'GET', pattern: /^\/api\/chat\/history$/, handler: chatHistory },
    { method: 'POST', pattern: /^\/api\/chat\/message$/, handler: sendChatMessage },
    { method: 'GET', pattern: /^\/api\/push\/config$/, handler: getPushConfig },
    { method: 'POST', pattern: /^\/api\/push\/subscribe$/, handler: subscribePush },
    { method: 'POST', pattern: /^\/api\/push\/unsubscribe$/, handler: unsubscribePush },
    { method: 'POST', pattern: /^\/api\/push\/test$/, handler: testPush },
    { method: 'GET', pattern: /^\/api\/agent\/status$/, handler: getAgentStatus },
    { method: 'POST', pattern: /^\/api\/agent\/task$/, handler: submitAgentTask },
    { method: 'POST', pattern: /^\/api\/agent\/cancel$/, handler: cancelAgentTask },
    { method: 'GET', pattern: /^\/api\/agent\/task\/([^/]+)$/, handler: getAgentTask },
    { method: 'GET', pattern: /^\/api\/proactive$/, handler: getProactive },
    { method: 'PATCH', pattern: /^\/api\/proactive$/, handler: patchProactive },
    { method: 'GET', pattern: /^\/api\/settings$/, handler: getSettings },
    { method: 'PATCH', pattern: /^\/api\/settings$/, handler: updateSettings },
    { method: 'GET', pattern: /^\/api\/stats$/, handler: getStats },
    { method: 'GET', pattern: /^\/api\/accounts$/, handler: listAccounts },
    { method: 'POST', pattern: /^\/api\/accounts$/, handler: createAccount },
    { method: 'PATCH', pattern: /^\/api\/account$/, handler: updateAccount },
    { method: 'GET', pattern: /^\/api\/security\/log$/, handler: securityLog },
    { method: 'GET', pattern: /^\/api\/gmail\/status$/, handler: gmailStatus },
    { method: 'GET', pattern: /^\/api\/gmail\/auth$/, handler: gmailAuth },
    { method: 'GET', pattern: /^\/api\/gmail\/messages$/, handler: gmailMessages },
    { method: 'GET', pattern: /^\/api\/gmail\/messages\/([^/]+)$/, handler: gmailMessage },
    { method: 'GET', pattern: /^\/api\/automations$/, handler: listAutomations },
    { method: 'POST', pattern: /^\/api\/automations$/, handler: createAutomation },
    { method: 'PATCH', pattern: /^\/api\/automations\/([^/]+)$/, handler: updateAutomation },
    { method: 'DELETE', pattern: /^\/api\/automations\/([^/]+)$/, handler: deleteAutomation },
    { method: 'POST', pattern: /^\/api\/automations\/([^/]+)\/run$/, handler: runAutomation },
    { method: 'POST', pattern: /^\/api\/2fa\/setup$/, handler: setupTotp },
    { method: 'POST', pattern: /^\/api\/2fa\/enable$/, handler: enableTotp },
    { method: 'POST', pattern: /^\/api\/2fa\/disable$/, handler: disableTotp },
    { method: 'POST', pattern: /^\/api\/session\/revoke-all$/, handler: revokeAllSessions },
  ]

  /** Метод для auth-путей проверяется отдельно: вход не требует уже открытой сессии. */
  const AUTH_ROUTES = {
    '/api/auth/login': { method: 'POST', run: login },
    '/api/auth/logout': { method: 'POST', run: logout },
    '/api/auth/session': { method: 'GET', run: sessionInfo },
  }

  function gmailState(userId) {
    const payload = Buffer.from(JSON.stringify({ userId: Number(userId), at: Date.now() })).toString('base64url')
    const sig = crypto.createHmac('sha256', mobileSessionSecret).update('gmail:' + payload).digest('base64url')
    return payload + '.' + sig
  }

  function readGmailState(token) {
    const [payload, sig] = String(token || '').split('.')
    if (!payload || !sig) return undefined
    const expected = crypto.createHmac('sha256', mobileSessionSecret).update('gmail:' + payload).digest('base64url')
    if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return undefined
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (Date.now() - Number(data.at) > 10 * 60 * 1000) return undefined
      return Number(data.userId)
    } catch {
      return undefined
    }
  }

  async function gmailAccess(userId) {
    const stored = gmail?.tokens?.get(userId)
    if (!stored) throw new GmailError('Gmail не подключён', 'not_connected', 401)
    const token = await gmail.client.accessToken(stored.refreshToken)
    return { token, stored }
  }

  function gmailStatus(request, response, { userId }) {
    request.resume()
    const configured = Boolean(gmail?.client?.configured)
    const stored = gmail?.tokens?.get(userId)
    sendJson(response, 200, {
      configured,
      connected: Boolean(stored),
      ...(stored?.email ? { email: stored.email } : {}),
      redirectUri: gmail?.client?.redirectUri ?? '',
    })
  }

  function gmailAuth(request, response, { userId }) {
    request.resume()
    if (!gmail?.client?.configured) return badRequest(response, 'Gmail OAuth не настроен на сервере')
    sendJson(response, 200, { url: gmail.client.authUrl(gmailState(userId)) })
  }

  async function gmailCallback(request, response, url) {
    request.resume()
    const userId = readGmailState(url.searchParams.get('state'))
    const code = url.searchParams.get('code')
    const fallback = '/mobile/?gmail=error'
    if (!userId || !code || !gmail?.client?.configured) {
      response.writeHead(302, { location: fallback })
      return response.end()
    }
    try {
      const data = await gmail.client.exchangeCode(code)
      if (!data.refresh_token) throw new GmailError('Google не выдал refresh token')
      await gmail.tokens.set(userId, { refreshToken: data.refresh_token, scope: data.scope ?? '' })
      response.writeHead(302, { location: '/mobile/?gmail=connected' })
      response.end()
    } catch (error) {
      logger?.warn?.('gmail callback failed', { error: error?.message ?? error })
      response.writeHead(302, { location: fallback })
      response.end()
    }
  }

  async function gmailMessages(request, response, { userId, url }) {
    request.resume()
    if (!gmail?.tokens) return missingStore(response, 'Gmail')
    try {
      const { token } = await gmailAccess(userId)
      const messages = await gmail.client.list(token, { q: url.searchParams.get('q') ?? '', max: 15 })
      sendJson(response, 200, { messages })
    } catch (error) {
      if (error?.code === 'reauth' || error?.code === 'not_connected') {
        await gmail.tokens.remove(userId).catch(() => {})
        return sendError(response, 401, 'gmail_reauth', 'Подключите Gmail заново')
      }
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось получить письма')
    }
  }

  async function gmailMessage(request, response, { userId, params }) {
    request.resume()
    if (!gmail?.tokens) return missingStore(response, 'Gmail')
    try {
      const { token } = await gmailAccess(userId)
      const message = await gmail.client.message(token, params[0])
      sendJson(response, 200, { message })
    } catch (error) {
      if (error?.code === 'reauth' || error?.code === 'not_connected') return sendError(response, 401, 'gmail_reauth', 'Подключите Gmail заново')
      sendError(response, 502, ERROR_CODES.unavailable, 'Не удалось открыть письмо')
    }
  }

  function calendarToken(userId) {
    return crypto.createHmac('sha256', mobileSessionSecret).update('calendar:' + String(userId)).digest('base64url').slice(0, 32)
  }

  function userIdForCalendarToken(token) {
    const users = accounts ? accounts.list().map((user) => user.userId) : [passwordUserNumber]
    for (const id of users) {
      if (!Number.isInteger(Number(id))) continue
      const expected = calendarToken(id)
      if (expected.length === String(token).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)))) {
        return Number(id)
      }
    }
    return undefined
  }

  /** Ссылка-подписка для Apple Calendar / Google Calendar. */
  function calendarLink(request, response, { userId }) {
    request.resume()
    const host = request.headers['x-forwarded-host'] || request.headers.host || 'tenkrol.ru'
    const proto = request.headers['x-forwarded-proto'] || 'https'
    sendJson(response, 200, {
      url: proto + '://' + host + '/api/calendar.ics?token=' + calendarToken(userId),
    })
  }

  async function handleApi(request, response, url) {
    const method = (request.method ?? 'GET').toUpperCase()
    const pathname = url.pathname

    if (pathname === '/api/calendar.ics' && method === 'GET' && url.searchParams.get('token')) {
      const id = userIdForCalendarToken(url.searchParams.get('token'))
      if (!id) {
        request.resume()
        return sendError(response, 403, ERROR_CODES.forbidden, 'Неверная ссылка календаря')
      }
      return exportCalendar(request, response, { userId: id, chatId: Number(chatIdOf(id)) })
    }

    if (pathname === '/api/gmail/callback' && method === 'GET') return gmailCallback(request, response, url)

    const authRoute = AUTH_ROUTES[pathname]
    if (authRoute) {
      if (method !== authRoute.method) {
        request.resume()
        return sendError(response, 405, ERROR_CODES.methodNotAllowed, 'Метод не поддерживается', { allow: authRoute.method })
      }
      return authRoute.run(request, response)
    }

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

    const auth = authenticate(request)
    if (!auth.ok) {
      request.resume()
      return authError(response, auth)
    }
    if (!allowed.has(String(auth.userId))) {
      request.resume()
      return sendError(response, 403, ERROR_CODES.forbidden, 'Нет доступа')
    }
    // Cookie-сессию браузер отправляет сам, поэтому изменяющие запросы дополнительно
    // должны нести заголовок мобильного клиента и совпадать по Origin.
    if (auth.via === 'password' && method !== 'GET' && method !== 'HEAD') {
      const clientHeader = request.headers[MOBILE_CLIENT_HEADER]
      const client = Array.isArray(clientHeader) ? clientHeader[0] : clientHeader
      if (client !== '1') {
        request.resume()
        return sendError(response, 403, ERROR_CODES.forbidden, 'Запрос должен идти с мобильного клиента')
      }
      const origin = request.headers.origin
      if (typeof origin === 'string' && origin !== '') {
        let originHost
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = ''
        }
        if (originHost !== request.headers.host) {
          request.resume()
          return sendError(response, 403, ERROR_CODES.forbidden, 'Запрос с другого сайта отклонён')
        }
      }
    }

    const chatId = chatIdFor(auth.userId)
    return match.route.handler(request, response, {
      userId: auth.userId,
      chatId,
      params: match.params,
      url,
      auth,
      via: auth.via,
    })
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
    let target = path.resolve(publicRoot, ...segments)
    if (target !== publicRoot && !target.startsWith(publicRoot + path.sep)) return notFound(response)

    // Каталог отдаёт свой index.html: `/mobile/` — это сайт, а не 404.
    try {
      const info = await fs.promises.stat(target)
      if (info.isDirectory()) target = path.join(target, 'index.html')
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return notFound(response)
      throw error
    }

    let data
    try {
      data = await fs.promises.readFile(target)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') return notFound(response)
      throw error
    }
    const mobile = decoded === MOBILE_PATH_PREFIX || decoded.startsWith(MOBILE_PATH_PREFIX + '/')
    const headers = {
      'content-type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    if (mobile) {
      headers['content-security-policy'] = MOBILE_CSP
      headers['referrer-policy'] = 'no-referrer'
      headers['x-frame-options'] = 'DENY'
      headers['permissions-policy'] = 'camera=(), microphone=(self), geolocation=()'
    }
    response.writeHead(200, headers)
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
    // Без завершающей косой относительные ссылки внутри сайта уехали бы в корень.
    if (url.pathname === MOBILE_PATH_PREFIX) {
      response.writeHead(302, { location: MOBILE_PATH_PREFIX + '/', 'cache-control': 'no-store' })
      return response.end()
    }
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

  startAutomationLoop()

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
