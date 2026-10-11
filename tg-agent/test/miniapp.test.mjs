/**
 * Mini App: `initData` signature validation and the HTTP panel API.
 *
 * The signature used by every test is produced here with the documented
 * algorithm and a throwaway bot token, so the tests check agreement between the
 * signer and the verifier plus the refusals that matter (a changed field, an
 * expired `auth_date`, garbage). The API tests run a real server on port 0 and
 * talk to it over `fetch`; stores are real and back onto temporary files, so a
 * write is only visible after it has actually reached disk.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { createMiniApp, validateInitData } from '../src/miniapp.mjs'
import { ReminderStore } from '../src/reminders.mjs'
import { EventStore } from '../src/events.mjs'
import { ProfileStore } from '../src/profiles.mjs'
import { UsageStore } from '../src/usage.mjs'

const USER_ID = 777
const BOT_TOKEN = '123456:TEST-bot-token-abcdefghijklmnopqrstuvwxyz'
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public')

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const nowSec = () => Math.floor(Date.now() / 1000)
const futureIso = (offsetMs = 3_600_000) => new Date(Date.now() + offsetMs).toISOString()
const pastIso = (offsetMs = 3_600_000) => new Date(Date.now() - offsetMs).toISOString()

/**
 * Build a real `initData` string: fields sorted, signed with
 * `HMAC_SHA256(HMAC_SHA256("WebAppData", token), data_check_string)`.
 */
function signInitData(user, { authDate = nowSec(), botToken = BOT_TOKEN, extra = {} } = {}) {
  const params = new URLSearchParams()
  params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc')
  params.set('user', JSON.stringify(user))
  params.set('auth_date', String(authDate))
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value))
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

const validInitData = (user = { id: USER_ID, first_name: 'Андрей', username: 'andry' }) => signInitData(user)

/** One HTTP round trip: JSON in, parsed JSON out. */
async function call(base, target, { method = 'GET', initData, body } = {}) {
  const headers = {}
  if (initData !== undefined) headers['X-Telegram-Init-Data'] = initData
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await fetch(`${base}${target}`, { method, headers, body: payload })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { response, status: response.status, text, json, contentType: response.headers.get('content-type') }
}

/** A real server plus real stores on temporary files. */
async function createHarness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-miniapp-'))
  const reminders = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger })
  const events = new EventStore({ file: path.join(dir, 'events.json'), logger: silentLogger })
  const profiles = new ProfileStore({ file: path.join(dir, 'profiles.json'), logger: silentLogger })
  const usage = new UsageStore({ file: path.join(dir, 'usage.json'), logger: silentLogger, saveDelayMs: 1 })
  await Promise.all([reminders.load(), events.load(), profiles.load(), usage.load()])

  const stores = { reminders, events, profiles, usage, ...(options.stores ?? {}) }
  const app = createMiniApp({
    port: 0,
    host: '127.0.0.1',
    botToken: options.botToken ?? BOT_TOKEN,
    allowedUserIds: options.allowedUserIds ?? [USER_ID],
    chatIdOf: options.chatIdOf,
    stores,
    publicDir: options.publicDir ?? PUBLIC_DIR,
    logger: options.logger ?? silentLogger,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  })
  const actualPort = await app.start()
  const base = `http://127.0.0.1:${actualPort}`

  t.after(async () => {
    await app.stop()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { app, base, dir, stores, reminders, events, profiles, usage }
}

// ---------------------------------------------------------------------------
// validateInitData
// ---------------------------------------------------------------------------

test('validateInitData accepts a string signed with the same token', () => {
  const now = Date.now()
  const authDate = Math.floor(now / 1000)
  const initData = signInitData({ id: USER_ID, first_name: 'Андрей', username: 'andry' }, { authDate })
  const result = validateInitData(initData, { botToken: BOT_TOKEN, now })
  assert.equal(result.ok, true)
  assert.deepEqual(result.user, { id: USER_ID, first_name: 'Андрей', username: 'andry' })
  assert.equal(result.authDate, authDate)
})

test('validateInitData rejects a changed user id', () => {
  const params = new URLSearchParams(validInitData())
  params.set('user', JSON.stringify({ id: 888, first_name: 'Андрей' }))
  const result = validateInitData(params.toString(), { botToken: BOT_TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad_signature')
})

test('validateInitData rejects a signature made with another bot token', () => {
  const initData = signInitData({ id: USER_ID }, { botToken: '999999:some-other-token' })
  const result = validateInitData(initData, { botToken: BOT_TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad_signature')
})

test('validateInitData rejects a missing hash', () => {
  const params = new URLSearchParams(validInitData())
  params.delete('hash')
  const result = validateInitData(params.toString(), { botToken: BOT_TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing_hash')
})

test('validateInitData rejects a stale auth_date', () => {
  const initData = signInitData({ id: USER_ID }, { authDate: nowSec() - 90_000 })
  const result = validateInitData(initData, { botToken: BOT_TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

test('validateInitData keeps an old auth_date when maxAgeSec is 0', () => {
  const initData = signInitData({ id: USER_ID, first_name: 'Андрей' }, { authDate: nowSec() - 90_000 })
  const result = validateInitData(initData, { botToken: BOT_TOKEN, maxAgeSec: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.user.id, USER_ID)
})

test('validateInitData rejects garbage, empty and non-string input without throwing', () => {
  assert.equal(validateInitData('', { botToken: BOT_TOKEN }).ok, false)
  assert.equal(validateInitData('   ', { botToken: BOT_TOKEN }).ok, false)
  assert.equal(validateInitData('not-a-query-string', { botToken: BOT_TOKEN }).ok, false)
  assert.equal(validateInitData('garbage=1&hash=zzzz', { botToken: BOT_TOKEN }).ok, false)
  assert.equal(validateInitData(validInitData(), { botToken: '' }).ok, false)
  for (const value of [null, undefined, 42, {}, [], true]) {
    let result
    assert.doesNotThrow(() => {
      result = validateInitData(value, { botToken: BOT_TOKEN })
    })
    assert.equal(result.ok, false)
    assert.equal(typeof result.reason, 'string')
  }
})

test('validateInitData accepts both readings of the optional signature field', () => {
  // (a) the hash covers the signature field.
  const covered = signInitData({ id: USER_ID, first_name: 'Андрей' }, { extra: { signature: 'abc123' } })
  assert.equal(validateInitData(covered, { botToken: BOT_TOKEN }).ok, true)
  // (b) the signature is appended after signing, so the hash does not cover it.
  const appended = `${validInitData()}&signature=deadbeef`
  assert.equal(validateInitData(appended, { botToken: BOT_TOKEN }).ok, true)
})

// ---------------------------------------------------------------------------
// HTTP: authentication and access
// ---------------------------------------------------------------------------

test('a valid signature opens the API', async (t) => {
  const ctx = await createHarness(t)
  ctx.usage.record({ usage: { prompt_tokens: 120, completion_tokens: 30 }, userId: USER_ID })
  await ctx.usage.flush()

  const state = await call(ctx.base, '/api/state', { initData: validInitData() })
  assert.equal(state.status, 200)
  assert.equal(state.json.usageToday.prompt, 120)
  assert.equal(state.json.usageToday.completion, 30)
  assert.equal(state.json.usageToday.total, 150)
  assert.equal(state.json.usageToday.requests, 1)
  assert.equal(state.json.user.name, 'Андрей')
  assert.equal(state.json.user.city, null)
})

test('state reports the remembered profile', async (t) => {
  const ctx = await createHarness(t)
  ctx.profiles.touch(USER_ID, { firstName: 'Андрей', username: 'andry' })
  ctx.profiles.setCity(USER_ID, 'Казань')
  ctx.profiles.setPersona(USER_ID, 'шерлок')
  ctx.profiles.setMood(USER_ID, 'бодрый')
  await ctx.profiles.flush()

  const state = await call(ctx.base, '/api/state', { initData: validInitData() })
  assert.equal(state.status, 200)
  assert.deepEqual(state.json.user, { name: 'Андрей', city: 'Казань', persona: 'шерлок', mood: 'бодрый' })
})

test('a forged initData is refused with 401', async (t) => {
  const ctx = await createHarness(t)
  const params = new URLSearchParams(validInitData())
  params.set('user', JSON.stringify({ id: USER_ID, first_name: 'Взломщик' }))
  const forged = await call(ctx.base, '/api/state', { initData: params.toString() })
  assert.equal(forged.status, 401)
  assert.equal(typeof forged.json.error, 'string')
})

test('an expired or unreadable signature is refused with 401', async (t) => {
  const ctx = await createHarness(t)
  const stale = await call(ctx.base, '/api/state', { initData: signInitData({ id: USER_ID }, { authDate: nowSec() - 90_000 }) })
  assert.equal(stale.status, 401)

  const garbage = await call(ctx.base, '/api/state', { initData: 'hash=deadbeef&user=whatever' })
  assert.equal(garbage.status, 401)

  const missing = await call(ctx.base, '/api/state')
  assert.equal(missing.status, 401)
})

test('a verified user outside the whitelist gets 403', async (t) => {
  const ctx = await createHarness(t)
  const stranger = await call(ctx.base, '/api/reminders', { initData: validInitData({ id: 424242, first_name: 'Чужой' }) })
  assert.equal(stranger.status, 403)
  assert.equal(stranger.json.error, 'Нет доступа')
})

test('an empty allow-list closes the panel to everyone', async (t) => {
  const ctx = await createHarness(t, { allowedUserIds: [] })
  const state = await call(ctx.base, '/api/state', { initData: validInitData() })
  assert.equal(state.status, 403)
})

test('/healthz answers without a signature and refuses other methods', async (t) => {
  const ctx = await createHarness(t)
  const health = await call(ctx.base, '/healthz')
  assert.equal(health.status, 200)
  assert.equal(health.text, 'ok')
  const post = await call(ctx.base, '/healthz', { method: 'POST' })
  assert.equal(post.status, 405)
})

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

test('reminders: empty, add, list, delete, empty — and the write reaches disk', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const empty = await call(ctx.base, '/api/reminders', { initData })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json, [])

  const created = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData,
    body: { text: 'Позвонить маме', dueAt: futureIso(), repeat: 'daily' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.text, 'Позвонить маме')
  assert.equal(created.json.repeat, 'daily')
  assert.equal(created.json.repeatText, 'каждый день')
  assert.ok(created.json.id)

  // The response is sent after `flush`, so an independent store on the same file sees it.
  const replayed = new ReminderStore({ file: path.join(ctx.dir, 'reminders.json'), logger: silentLogger })
  await replayed.load()
  const stored = replayed.list(USER_ID, USER_ID)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].text, 'Позвонить маме')
  assert.equal(stored[0].repeat, 'daily')

  const listed = await call(ctx.base, '/api/reminders', { initData })
  assert.equal(listed.json.length, 1)
  assert.equal(listed.json[0].id, created.json.id)

  const removed = await call(ctx.base, `/api/reminders/${created.json.id}`, { method: 'DELETE', initData })
  assert.equal(removed.status, 200)
  const after = await call(ctx.base, '/api/reminders', { initData })
  assert.deepEqual(after.json, [])

  const missing = await call(ctx.base, '/api/reminders/999', { method: 'DELETE', initData })
  assert.equal(missing.status, 404)
})

test('reminders: empty text, a past date and an unknown repeat are refused and create nothing', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()
  const cases = [
    { body: { text: '   ', dueAt: futureIso(), repeat: 'none' }, error: /пуст/ },
    { body: { text: 'ок', dueAt: pastIso(), repeat: 'none' }, error: /будущ/ },
    { body: { text: 'ок', dueAt: 'не дата', repeat: 'none' }, error: /дат/i },
    { body: { text: 'ок', dueAt: futureIso(), repeat: 'sometimes' }, error: /повтор/ },
  ]
  for (const item of cases) {
    const refused = await call(ctx.base, '/api/reminders', { method: 'POST', initData, body: item.body })
    assert.equal(refused.status, 400, JSON.stringify(item.body))
    assert.match(refused.json.error, item.error)
  }
  const listed = await call(ctx.base, '/api/reminders', { initData })
  assert.deepEqual(listed.json, [])

  const onDisk = await fs.readFile(path.join(ctx.dir, 'reminders.json'), 'utf8').catch(() => '')
  if (onDisk !== '') assert.deepEqual(JSON.parse(onDisk).reminders, [])
})

test('chatIdOf decides which chat the store is keyed by', async (t) => {
  const ctx = await createHarness(t, { chatIdOf: (id) => 1000 + id })
  const created = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData: validInitData(),
    body: { text: 'проверка', dueAt: futureIso(), repeat: 'none' },
  })
  assert.equal(created.status, 200)
  const stored = ctx.reminders.list(1000 + USER_ID)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].chatId, 1000 + USER_ID)
})

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------

test('events: add, list for 14 days, delete — a yearly repeat survives', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const created = await call(ctx.base, '/api/events', {
    method: 'POST',
    initData,
    body: { title: 'День рождения', at: futureIso(2 * 86_400_000), repeat: 'yearly' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.title, 'День рождения')
  assert.equal(created.json.repeat, 'yearly')
  assert.ok(created.json.id)

  const listed = await call(ctx.base, '/api/events?days=14', { initData })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.length, 1)
  assert.equal(listed.json[0].repeat, 'yearly')
  assert.equal(listed.json[0].title, 'День рождения')

  const removed = await call(ctx.base, `/api/events/${created.json.id}`, { method: 'DELETE', initData })
  assert.equal(removed.status, 200)
  const after = await call(ctx.base, '/api/events', { initData })
  assert.deepEqual(after.json, [])
})

test('events: a bad repeat, a past date and a bad days window are refused', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()
  const badRepeat = await call(ctx.base, '/api/events', {
    method: 'POST',
    initData,
    body: { title: 'X', at: futureIso(), repeat: 'daily' },
  })
  assert.equal(badRepeat.status, 400)

  const past = await call(ctx.base, '/api/events', {
    method: 'POST',
    initData,
    body: { title: 'X', at: pastIso(), repeat: 'none' },
  })
  assert.equal(past.status, 400)

  const badDays = await call(ctx.base, '/api/events?days=soon', { initData })
  assert.equal(badDays.status, 400)
})

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

test('memory: a fact is added, listed on disk and removed; the city is read-only', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()
  ctx.profiles.setCity(USER_ID, 'Москва')
  await ctx.profiles.flush()

  const before = await call(ctx.base, '/api/memory', { initData })
  assert.equal(before.status, 200)
  assert.deepEqual(before.json.facts, [])
  assert.equal(before.json.city, 'Москва')

  const created = await call(ctx.base, '/api/memory', { method: 'POST', initData, body: { text: 'любит крепкий кофе' } })
  assert.equal(created.status, 200)
  assert.ok(created.json.id)
  assert.equal(created.json.text, 'любит крепкий кофе')

  const replayed = new ProfileStore({ file: path.join(ctx.dir, 'profiles.json'), logger: silentLogger })
  await replayed.load()
  assert.equal(replayed.facts(USER_ID).length, 1)

  const listed = await call(ctx.base, '/api/memory', { initData })
  assert.equal(listed.json.facts.length, 1)
  assert.equal(listed.json.facts[0].text, 'любит крепкий кофе')

  const removed = await call(ctx.base, `/api/memory/${created.json.id}`, { method: 'DELETE', initData })
  assert.equal(removed.status, 200)
  const after = await call(ctx.base, '/api/memory', { initData })
  assert.deepEqual(after.json.facts, [])

  const missing = await call(ctx.base, '/api/memory/999', { method: 'DELETE', initData })
  assert.equal(missing.status, 404)
})

test('memory: an empty fact is refused', async (t) => {
  const ctx = await createHarness(t)
  const refused = await call(ctx.base, '/api/memory', { method: 'POST', initData: validInitData(), body: { text: '  ' } })
  assert.equal(refused.status, 400)
})

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test('a missing store answers 503 on its endpoints', async (t) => {
  const ctx = await createHarness(t, { stores: { reminders: null, events: null, profiles: null, usage: null } })
  const initData = validInitData()
  const calls = [
    ['GET', '/api/reminders', undefined],
    ['POST', '/api/reminders', { text: 'ок', dueAt: futureIso(), repeat: 'none' }],
    ['GET', '/api/events', undefined],
    ['GET', '/api/memory', undefined],
    ['GET', '/api/state', undefined],
  ]
  for (const [method, target, body] of calls) {
    const refused = await call(ctx.base, target, { method, initData, ...(body === undefined ? {} : { body }) })
    assert.equal(refused.status, 503, `${method} ${target}`)
    assert.match(refused.json.error, /недоступно/)
  }
})

test('an oversized body is refused with 413 and writes nothing', async (t) => {
  const ctx = await createHarness(t)
  const body = JSON.stringify({ text: 'x'.repeat(40_000), dueAt: futureIso(), repeat: 'none' })
  const refused = await call(ctx.base, '/api/reminders', { method: 'POST', initData: validInitData(), body })
  assert.equal(refused.status, 413)
  assert.deepEqual(ctx.reminders.list(USER_ID, USER_ID), [])
})

test('an unknown path is 404 and a wrong method is 405', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()
  const unknown = await call(ctx.base, '/api/nope', { initData })
  assert.equal(unknown.status, 404)

  const put = await call(ctx.base, '/api/reminders', { method: 'PUT', initData })
  assert.equal(put.status, 405)
  assert.match(put.response.headers.get('allow') ?? '', /GET/)

  // Routing is resolved before the signature, so this is a 405 as well.
  const putAnonymous = await call(ctx.base, '/api/reminders', { method: 'PUT' })
  assert.equal(putAnonymous.status, 405)
})

test('a broken store is a 500 with a logged error and no stack in the body', async (t) => {
  const logged = []
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(message, fields) { logged.push({ message, fields }) },
  }
  const ctx = await createHarness(t, {
    logger,
    stores: { reminders: { list() { throw new Error('boom-internal-detail') } } },
  })
  const failed = await call(ctx.base, '/api/reminders', { initData: validInitData() })
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error, 'Внутренняя ошибка сервера')
  assert.equal(failed.text.includes('boom-internal-detail'), false)
  assert.equal(logged.length, 1)
  assert.equal(logged[0].fields.error.message, 'boom-internal-detail')
})

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

test('static: / serves the panel as UTF-8 HTML', async (t) => {
  const ctx = await createHarness(t)
  const index = await call(ctx.base, '/')
  assert.equal(index.status, 200)
  assert.match(index.contentType, /^text\/html; charset=utf-8/)
  assert.match(index.text, /<!doctype html>/i)
  assert.match(index.text, /X-Telegram-Init-Data/)
  assert.match(index.text, /telegram-web-app\.js/)

  const page = await call(ctx.base, '/app.html')
  assert.equal(page.status, 200)
  assert.equal(page.text, index.text)
})

test('static: traversal and neighbouring secrets are not served', async (t) => {
  const ctx = await createHarness(t)
  for (const target of ['/../.env', '/.env', '/%2e%2e/.env', '/../src/miniapp.mjs', '/nope.html']) {
    const refused = await call(ctx.base, target)
    assert.equal(refused.status, 404, target)
    assert.equal(refused.text.includes('TELEGRAM_BOT_TOKEN'), false, target)
    assert.equal(refused.text.includes('MODEL_API_KEY'), false, target)
  }
})

test('the panel page never renders data as markup', async () => {
  const html = await fs.readFile(path.join(PUBLIC_DIR, 'app.html'), 'utf8')
  for (const pattern of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
    assert.equal(html.includes(pattern), false, `app.html must not contain ${pattern}`)
  }
  assert.ok(html.includes('textContent'), 'the page must render data through textContent')
  assert.ok(html.includes('X-Telegram-Init-Data'), 'the page must send the signed initData header')
})
