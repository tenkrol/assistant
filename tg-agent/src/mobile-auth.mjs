/**
 * Парольная авторизация мобильного сайта: хеш пароля, подписанная сессия и cookie.
 *
 * Здесь нет сети и состояния: только чистые функции, поэтому и сервер мини-приложения,
 * и инструмент выдачи пароля, и тесты используют один и тот же код. Пароль хранится
 * только как scrypt-хеш; сессия — stateless HMAC-токен в HttpOnly-cookie.
 *
 * Формат хеша: `scrypt$N$r$p$<salt-base64url>$<key-base64url>`.
 * Формат сессии: `<payload-base64url>.<hmac-base64url>`; payload — `{v,uid,iat,exp}`.
 */
import crypto from 'node:crypto'

export const SESSION_COOKIE = 'tg_mobile_session'
export const SESSION_VERSION = 1
export const MIN_SESSION_SECRET_LENGTH = 32

const HASH_PREFIX = 'scrypt'
const HASH_DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 }
const MAX_HASH_KEYLEN = 128
const MAX_SCRYPT_N = 1 << 20
const MAX_PASSWORD_LENGTH = 1024
const MAX_TOKEN_LENGTH = 2048

const b64url = (buffer) => buffer.toString('base64url')

/** Понятная ошибка конфигурации: её видит владелец в логе, а не посетитель. */
export class MobileAuthConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MobileAuthConfigError'
  }
}

/** Проверить, что строка похожа на корректный scrypt-хеш. */
export function isPasswordHash(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('$')
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false
  const [, ns, rs, ps, saltB64, keyB64] = parts
  const N = Number(ns)
  const r = Number(rs)
  const p = Number(ps)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (N < 1024 || N > MAX_SCRYPT_N || r < 1 || r > 32 || p < 1 || p > 16) return false
  try {
    return Buffer.from(saltB64, 'base64url').length >= 8
      && Buffer.from(keyB64, 'base64url').length >= 16
  } catch {
    return false
  }
}

/**
 * Закодировать пароль в scrypt-хеш.
 *
 * @param {string} password - пароль в открытом виде.
 * @param {object} [options] - параметры scrypt (для тестов можно уменьшить N).
 * @returns {string} хеш для `MOBILE_PASSWORD_HASH`.
 */
export function hashPassword(password, options = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new MobileAuthConfigError('Пароль не может быть пустым')
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new MobileAuthConfigError(`Пароль длиннее ${MAX_PASSWORD_LENGTH} символов`)
  }
  const N = Number(options.N ?? HASH_DEFAULTS.N)
  const r = Number(options.r ?? HASH_DEFAULTS.r)
  const p = Number(options.p ?? HASH_DEFAULTS.p)
  const keylen = Number(options.keylen ?? HASH_DEFAULTS.keylen)
  if (!Number.isInteger(N) || N < 1024 || N > MAX_SCRYPT_N) throw new MobileAuthConfigError('Некорректный параметр scrypt N')
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new MobileAuthConfigError('Некорректный параметр scrypt r')
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new MobileAuthConfigError('Некорректный параметр scrypt p')
  if (!Number.isInteger(keylen) || keylen < 16 || keylen > MAX_HASH_KEYLEN) throw new MobileAuthConfigError('Некорректная длина ключа scrypt')
  const salt = crypto.randomBytes(Number(options.saltBytes ?? HASH_DEFAULTS.saltBytes))
  const key = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: 128 * 1024 * 1024 })
  return [HASH_PREFIX, N, r, p, b64url(salt), b64url(key)].join('$')
}

/**
 * Сверить пароль с хешем за постоянное время.
 *
 * @param {string} password - введённый пароль.
 * @param {string} encoded - значение `MOBILE_PASSWORD_HASH`.
 * @returns {boolean} совпадает ли пароль.
 */
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false
  if (!isPasswordHash(encoded)) return false
  const [, ns, rs, ps, saltB64, keyB64] = encoded.split('$')
  let salt
  let expected
  try {
    salt = Buffer.from(saltB64, 'base64url')
    expected = Buffer.from(keyB64, 'base64url')
  } catch {
    return false
  }
  let derived
  try {
    derived = crypto.scryptSync(password, salt, expected.length, {
      N: Number(ns),
      r: Number(rs),
      p: Number(ps),
      maxmem: 128 * 1024 * 1024,
    })
  } catch {
    return false
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
}

/** Случайный секрет подписи сессий; в env попадает только он. */
export function createSessionSecret() {
  return b64url(crypto.randomBytes(32))
}

/** Проверить, что секрет достаточно длинный, чтобы им нельзя было пренебречь. */
export function isSessionSecret(value) {
  return typeof value === 'string' && value.length >= MIN_SESSION_SECRET_LENGTH
}

/**
 * Подписать сессию.
 *
 * @param {object} input - `userId`, `ttlSec`, необязательный `now`.
 * @param {string} secret - `MOBILE_SESSION_SECRET`.
 * @returns {string} токен для cookie.
 */
export function signSession({ userId, ttlSec, now = Date.now() }, secret) {
  if (!isSessionSecret(secret)) throw new MobileAuthConfigError('Секрет сессии короче 32 символов')
  const iat = Math.floor(now / 1000)
  const exp = iat + Number(ttlSec)
  if (!Number.isFinite(exp) || exp <= iat) throw new MobileAuthConfigError('Некорректный срок сессии')
  const payload = b64url(Buffer.from(JSON.stringify({
    v: SESSION_VERSION,
    uid: String(userId),
    iat,
    exp,
  })))
  const signature = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${signature}`
}

/**
 * Проверить подпись и срок сессии.
 *
 * @param {string} token - значение cookie.
 * @param {string} secret - `MOBILE_SESSION_SECRET`.
 * @param {object} [options] - `now`, `userId` (если задан, uid обязан совпасть).
 * @returns {{ok: true, userId: string, iat: number, exp: number}|{ok: false, reason: string}}
 */
export function verifySession(token, secret, { now = Date.now(), userId } = {}) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'invalid' }
  }
  if (!isSessionSecret(secret)) return { ok: false, reason: 'no_secret' }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' }
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  let provided
  try {
    provided = Buffer.from(signature, 'base64url')
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest()
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' }
  }
  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (data?.v !== SESSION_VERSION || typeof data.uid !== 'string' || !Number.isInteger(data.iat) || !Number.isInteger(data.exp)) {
    return { ok: false, reason: 'invalid' }
  }
  if (userId !== undefined && String(userId) !== data.uid) return { ok: false, reason: 'wrong_user' }
  if (data.exp <= Math.floor(now / 1000)) return { ok: false, reason: 'expired' }
  return { ok: true, userId: data.uid, iat: data.iat, exp: data.exp }
}

/** Разобрать `Cookie` без сторонних библиотек; ошибки формата не ломают запрос. */
export function parseCookies(header) {
  const result = {}
  if (typeof header !== 'string' || header.trim() === '') return result
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name || result[name] !== undefined) continue
    try {
      result[name] = decodeURIComponent(value)
    } catch {
      result[name] = value
    }
  }
  return result
}

/** Заголовок Set-Cookie для входа. */
export function sessionCookie(token, { maxAgeSec, secure = true } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(Number(maxAgeSec)))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Заголовок Set-Cookie для выхода. */
export function clearSessionCookie({ secure = true } = {}) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
