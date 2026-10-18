/**
 * Web Push для мобильного сайта: VAPID-подпись, подписки и пустые push-сообщения.
 *
 * Содержимое уведомления намеренно не шифруется: push без payload не требует
 * RFC 8291 (ECDH + AES-GCM) и всё равно будит service worker. Текст уведомления
 * общий, а подробности человек видит, открыв приложение. Это меньше кода и меньше
 * шансов ошибиться в криптографии; при необходимости payload можно добавить позже.
 *
 * VAPID:
 *   publicKey  — base64url несжатой точки P-256 (65 байт, начинается с 0x04);
 *   privateKey — base64url скаляра d (32 байта).
 */
import crypto from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const DEFAULT_TTL_SEC = 60
const MAX_SUBSCRIPTIONS_PER_USER = 10
const MAX_ENDPOINT_LENGTH = 2048
const VAPID_TTL_SEC = 12 * 60 * 60

const b64url = (buffer) => Buffer.from(buffer).toString('base64url')

export class MobilePushError extends Error {
  constructor(message, code = 'bad_request') {
    super(message)
    this.name = 'MobilePushError'
    this.code = code
  }
}

/** Сгенерировать пару ключей VAPID (для первого запуска и инструмента выдачи). */
export function createVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  if (!pub.x || !pub.y || !priv.d) throw new Error('не удалось выпустить VAPID-ключи')
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
  ])
  return {
    publicKey: raw.toString('base64url'),
    privateKey: priv.d,
  }
}

/** Проверить и собрать VAPID-конфиг из env; `undefined`, если ключей нет. */
export function createVapidConfig({ publicKey, privateKey, subject } = {}) {
  if (!publicKey || !privateKey) return undefined
  let raw
  try {
    raw = Buffer.from(publicKey, 'base64url')
  } catch {
    return undefined
  }
  if (raw.length !== 65 || raw[0] !== 4) return undefined
  if (typeof privateKey !== 'string' || privateKey.length < 20) return undefined
  return {
    publicKey,
    privateKey,
    subject: String(subject || 'https://tenkrol.ru'),
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(raw.subarray(1, 33)),
      y: b64url(raw.subarray(33, 65)),
      d: privateKey,
    },
  }
}

/** JWT для Authorization: vapid t=..., k=... */
export function createVapidJwt({ audience, subject, jwk, now = Date.now() } = {}) {
  if (typeof audience !== 'string' || !/^https?:\/\//.test(audience)) {
    throw new MobilePushError('Некорректный audience VAPID')
  }
  if (!jwk || typeof jwk.d !== 'string') throw new MobilePushError('Нет VAPID-ключа')
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + VAPID_TTL_SEC,
    sub: String(subject || 'https://tenkrol.ru'),
  })))
  const input = `${header}.${payload}`
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' })
  const signature = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64url(signature)}`
}

const validSubscription = (value) => {
  if (!value || typeof value !== 'object') return false
  if (typeof value.endpoint !== 'string' || value.endpoint.length > MAX_ENDPOINT_LENGTH) return false
  if (!/^https:\/\//.test(value.endpoint)) return false
  const keys = value.keys
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false
  if (keys.p256dh.length < 16 || keys.auth.length < 8) return false
  return true
}

/**
 * Отправить пустое push-сообщение в подписку.
 *
 * @returns {Promise<{ok: boolean, expired: boolean, status?: number, error?: string}>}
 */
export async function sendPush(subscription, { vapid, fetchImpl = globalThis.fetch, ttlSec = DEFAULT_TTL_SEC, urgency = 'high', now = Date.now() } = {}) {
  if (!validSubscription(subscription)) return { ok: false, expired: false, error: 'некорректная подписка' }
  if (!vapid?.jwk) return { ok: false, expired: false, error: 'VAPID не настроен' }
  let origin
  try {
    origin = new URL(subscription.endpoint).origin
  } catch {
    return { ok: false, expired: false, error: 'некорректный endpoint' }
  }
  let jwt
  try {
    jwt = createVapidJwt({ audience: origin, subject: vapid.subject, jwk: vapid.jwk, now })
  } catch (error) {
    return { ok: false, expired: false, error: error?.message ?? String(error) }
  }
  let response
  try {
    response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        ttl: String(Math.max(1, Math.floor(ttlSec))),
        urgency,
        'content-length': '0',
      },
    })
  } catch (error) {
    return { ok: false, expired: false, error: error?.message ?? String(error) }
  }
  const status = response?.status ?? 0
  if (status >= 200 && status < 300) return { ok: true, expired: false, status }
  const expired = status === 404 || status === 410
  return { ok: false, expired, status, error: `push endpoint ответил ${status}` }
}

/** Хранилище подписок одного бота: один файл, без секретов (endpoint и ключи браузера). */
export class MobilePushStore {
  constructor({ file, logger } = {}) {
    if (!file) throw new MobilePushError('Не задан файл подписок')
    this.logger = logger
    this.storage = createJsonStore({
      file,
      version: 1,
      defaults: { subscriptions: [] },
      logger,
    })
  }

  get file() {
    return this.storage.file
  }

  get subscriptions() {
    const list = this.storage.state?.subscriptions
    return Array.isArray(list) ? list : []
  }

  async load() {
    await this.storage.load()
    if (!Array.isArray(this.storage.state.subscriptions)) this.storage.state.subscriptions = []
    return this
  }

  listForUsers(userIds) {
    const wanted = new Set((userIds ?? []).map(String))
    return this.subscriptions.filter((item) => wanted.has(String(item.userId)))
  }

  /** Добавить или обновить подписку; один endpoint — одна запись. */
  async add({ userId, subscription } = {}) {
    const id = Number(userId)
    if (!Number.isInteger(id) || id <= 0) throw new MobilePushError('Некорректный пользователь')
    if (!validSubscription(subscription)) throw new MobilePushError('Некорректная подписка')
    const now = new Date().toISOString()
    const existing = this.subscriptions.find((item) => item.endpoint === subscription.endpoint)
    if (existing) {
      existing.userId = id
      existing.keys = { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
      existing.updatedAt = now
    } else {
      const count = this.subscriptions.filter((item) => Number(item.userId) === id).length
      if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
        throw new MobilePushError('Слишком много устройств для уведомлений', 'conflict')
      }
      this.subscriptions.push({
        userId: id,
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        createdAt: now,
        updatedAt: now,
      })
    }
    await this.storage.flush()
    return true
  }

  async remove(endpoint) {
    if (typeof endpoint !== 'string' || endpoint === '') return false
    const before = this.subscriptions.length
    this.storage.state.subscriptions = this.subscriptions.filter((item) => item.endpoint !== endpoint)
    if (this.storage.state.subscriptions.length === before) return false
    await this.storage.flush()
    return true
  }

  async removeSubscription(subscription) {
    if (!subscription || typeof subscription.endpoint !== 'string') return false
    return this.remove(subscription.endpoint)
  }
}
