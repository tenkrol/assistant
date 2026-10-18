/**
 * Web Push: VAPID, отправка пустого push и хранение подписок.
 * Реальный push на устройство здесь не проверяется — криптография и HTTP-контракт
 * проверяются на подставном fetch, как и остальные внешние вызовы проекта.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  MobilePushError,
  MobilePushStore,
  createVapidConfig,
  createVapidJwt,
  createVapidKeys,
  sendPush,
} from '../src/mobile-push.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/abc123',
  keys: {
    p256dh: 'BM3xq0a2m3yH4uJ5kL6nO7pQ8rS9tU0vW1xY2zA3bC4dE5fG6hI7jK8lM9nO0pQ1rS2tU3vW4xY5zA6bC7dE8f',
    auth: '0123456789abcdef',
  },
}

test('VAPID: ключи, JWT и подпись P-256', () => {
  const keys = createVapidKeys()
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65)
  const vapid = createVapidConfig({ ...keys, subject: 'https://tenkrol.ru' })
  assert.ok(vapid)
  assert.equal(vapid.jwk.kty, 'EC')
  const jwt = createVapidJwt({ audience: 'https://push.example.test', jwk: vapid.jwk, now: 1_700_000_000_000 })
  const [header, payload, signature] = jwt.split('.')
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256')
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))
  assert.equal(claims.aud, 'https://push.example.test')
  assert.equal(claims.sub, 'https://tenkrol.ru')
  const publicKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: vapid.jwk.x, y: vapid.jwk.y },
    format: 'jwk',
  })
  assert.equal(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, Buffer.from(signature, 'base64url')), true)
  assert.equal(createVapidConfig({ publicKey: 'bad', privateKey: 'bad' }), undefined)
})

test('sendPush отправляет пустой POST с VAPID-заголовками', async () => {
  const vapid = createVapidConfig({ ...createVapidKeys(), subject: 'https://tenkrol.ru' })
  const calls = []
  const result = await sendPush(SUBSCRIPTION, {
    vapid,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { status: 201 }
    },
  })
  assert.deepEqual(result, { ok: true, expired: false, status: 201 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, SUBSCRIPTION.endpoint)
  assert.equal(calls[0].options.method, 'POST')
  assert.match(calls[0].options.headers.authorization, /^vapid t=.+, k=.+$/)
  assert.equal(calls[0].options.headers.ttl, '60')
  assert.equal(calls[0].options.headers['content-length'], '0')
  assert.equal(calls[0].options.body, undefined)
})

test('sendPush: 410 значит подписку пора удалить', async () => {
  const vapid = createVapidConfig({ ...createVapidKeys() })
  const result = await sendPush(SUBSCRIPTION, {
    vapid,
    fetchImpl: async () => ({ status: 410 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.expired, true)
})

test('MobilePushStore: добавление, обновление, лимит и удаление', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mobile-push-'))
  const file = path.join(dir, 'mobile-push.json')
  const store = new MobilePushStore({ file, logger: silentLogger })
  await store.load()
  try {
    await store.add({ userId: 777, subscription: SUBSCRIPTION })
    assert.equal(store.subscriptions.length, 1)
    assert.equal(store.listForUsers([777]).length, 1)
    assert.equal(store.listForUsers([888]).length, 0)
    await store.add({ userId: 777, subscription: { ...SUBSCRIPTION, endpoint: 'https://push.example.test/second' } })
    assert.equal(store.subscriptions.length, 2)
    await store.remove(SUBSCRIPTION.endpoint)
    assert.equal(store.subscriptions.length, 1)

    const other = new MobilePushStore({ file, logger: silentLogger })
    await other.load()
    assert.equal(other.subscriptions.length, 1)
    await assert.rejects(() => other.add({ userId: 777, subscription: { endpoint: 'http://insecure', keys: {} } }), MobilePushError)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
