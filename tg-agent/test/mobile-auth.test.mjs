/**
 * Парольная авторизация мобильного сайта: хеш, сессия, cookie и HTTP-поток.
 *
 * Тесты реальные: сервер слушает порт 0, хранилища лежат во временном каталоге,
 * cookie проходят через `fetch` как в браузере. Пароль в тестах — «правильный-пароль»,
 * хеш считается с маленьким scrypt N, чтобы прогон оставался быстрым.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SESSION_COOKIE,
  createSessionSecret,
  hashPassword,
  parseCookies,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
  verifyUsername,
} from '../src/mobile-auth.mjs'
import { createMiniApp } from '../src/miniapp.mjs'
import { ReminderStore } from '../src/reminders.mjs'
import { EventStore } from '../src/events.mjs'
import { ProfileStore } from '../src/profiles.mjs'
import { UsageStore } from '../src/usage.mjs'
import { HistoryStore } from '../src/history.mjs'
import { MobileUserStore } from '../src/mobile-users.mjs'

const USER_ID = 777
const MASHA_ID = 888
const BOT_TOKEN = '123456:TEST-bot-token-abcdefghijklmnopqrstuvwxyz'
const SECRET = 'test-session-secret-0123456789abcdef'
const PASSWORD = 'правильный-пароль'
const HASH = hashPassword(PASSWORD, { N: 1024 })
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

// ---------------------------------------------------------------------------
// Чистые функции
// ---------------------------------------------------------------------------

test('hashPassword/verifyPassword: верный и неверный пароль', () => {
  assert.equal(verifyPassword(PASSWORD, HASH), true)
  assert.equal(verifyPassword('неверный', HASH), false)
  assert.equal(verifyPassword('', HASH), false)
  assert.match(HASH, /^scrypt\$1024\$8\$1\$/)
})

test('verifyPassword отклоняет мусор и чужой формат', () => {
  for (const value of [undefined, null, '', 'plain', 'bcrypt$1$2$3$4$5', HASH.replace('$1024$', '$999999$')]) {
    assert.equal(verifyPassword(PASSWORD, value), false)
  }
})

test('verifyUsername: логин сравнивается, пустой конфиг пропускает', () => {
  assert.equal(verifyUsername('tenkrol', 'tenkrol'), true)
  assert.equal(verifyUsername('TenKrol', 'tenkrol'), false)
  assert.equal(verifyUsername('', 'tenkrol'), false)
  assert.equal(verifyUsername('tenkrol', ''), true)
  assert.equal(verifyUsername(undefined, 'tenkrol'), false)
})

test('session secret: короткий секрет не принимается', () => {
  assert.equal(verifySession(signSession({ userId: USER_ID, ttlSec: 60 }, SECRET), 'short').ok, false)
  assert.ok(createSessionSecret().length >= 32)
})

test('session token: подпись, срок и пользователь проверяются', () => {
  const now = Date.now()
  const token = signSession({ userId: USER_ID, ttlSec: 60, now }, SECRET)
  const good = verifySession(token, SECRET, { now, userId: USER_ID })
  assert.equal(good.ok, true)
  assert.equal(good.userId, String(USER_ID))
  assert.equal(verifySession(token, SECRET, { now: now + 61_000 }).ok, false)
  assert.equal(verifySession(token, SECRET, { now, userId: 888 }).ok, false)
  assert.equal(verifySession(token.slice(0, -1) + 'x', SECRET, { now }).ok, false)
  assert.equal(verifySession(token + '.x', SECRET, { now }).ok, false)
})

test('parseCookies: несколько cookie и битое кодирование', () => {
  assert.deepEqual(parseCookies('a=1; b=two; a=ignored'), { a: '1', b: 'two' })
  assert.deepEqual(parseCookies('x=%D0%9F; y=%E0%A4%A'), { x: 'П', y: '%E0%A4%A' })
})

test('sessionCookie: HttpOnly, SameSite, Secure и Max-Age', () => {
  const secure = sessionCookie('token', { maxAgeSec: 60, secure: true })
  assert.match(secure, new RegExp(SESSION_COOKIE + '=token'))
  assert.match(secure, /HttpOnly/)
  assert.match(secure, /SameSite=Strict/)
  assert.match(secure, /Secure/)
  assert.match(secure, /Max-Age=60/)
  assert.doesNotMatch(sessionCookie('token', { maxAgeSec: 60, secure: false }), /Secure/)
})

// ---------------------------------------------------------------------------
// HTTP-поток
// ---------------------------------------------------------------------------

/** Cookie-jar как у браузера: храним только значение сессионной cookie. */
function jar() {
  let value = ''
  return {
    get cookie() {
      return value
    },
    absorb(response) {
      const list = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean)
      const session = list.find((header) => header.startsWith(SESSION_COOKIE + '='))
      if (!session) return
      const pair = session.split(';')[0]
      value = pair === SESSION_COOKIE + '=' ? '' : pair
    },
  }
}

async function request(base, target, { method = 'GET', body, cookieJar, headers = {} } = {}) {
  const merged = { ...headers }
  if (cookieJar?.cookie) merged.cookie = cookieJar.cookie
  let payload
  if (body !== undefined) {
    merged['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(`${base}${target}`, { method, headers: merged, body: payload, redirect: 'manual' })
  cookieJar?.absorb(response)
  const text = await response.text()
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { response, status: response.status, text, json }
}

async function createHarness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mobile-auth-'))
  const reminders = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger })
  const events = new EventStore({ file: path.join(dir, 'events.json'), logger: silentLogger })
  const profiles = new ProfileStore({ file: path.join(dir, 'profiles.json'), logger: silentLogger })
  const usage = new UsageStore({ file: path.join(dir, 'usage.json'), logger: silentLogger, saveDelayMs: 1 })
  const history = new HistoryStore({ file: path.join(dir, 'history.json'), logger: silentLogger })
  await Promise.all([reminders.load(), events.load(), profiles.load(), usage.load(), history.load()])

  let mobileUsers
  if (options.accounts) {
    mobileUsers = new MobileUserStore({
      file: path.join(dir, 'mobile-accounts.json'),
      logger: silentLogger,
      seedUsers: [{
        login: options.ownerLogin ?? 'tenkrol',
        passwordHash: options.mobilePasswordHash ?? HASH,
        name: options.mobileUserName ?? 'Владелец',
        userId: options.mobileUserId ?? USER_ID,
        role: 'owner',
      }],
    })
    await mobileUsers.load()
  }

  const publicDir = path.join(dir, 'public')
  await fs.mkdir(path.join(publicDir, 'mobile'), { recursive: true })
  await fs.writeFile(path.join(publicDir, 'app.html'), '<!doctype html><title>old</title>')
  await fs.writeFile(path.join(publicDir, 'mobile', 'index.html'), '<!doctype html><title>mobile</title><p>сайт</p>')

  const app = createMiniApp({
    port: 0,
    host: '127.0.0.1',
    botToken: BOT_TOKEN,
    allowedUserIds: options.allowedUserIds ?? [USER_ID],
    stores: { reminders, events, profiles, usage },
    history,
    mobileUsers,
    publicDir,
    logger: silentLogger,
    mobilePasswordHash: options.mobilePasswordHash ?? HASH,
    mobileSessionSecret: options.mobileSessionSecret ?? SECRET,
    mobileUserId: options.mobileUserId ?? USER_ID,
    mobileUserName: options.mobileUserName ?? 'Владелец',
    mobileUsername: options.mobileUsername ?? '',
    cookieSecure: options.cookieSecure ?? false,
    sessionTtlSec: options.sessionTtlSec ?? 3600,
    loginRateLimit: options.loginRateLimit ?? {},
    defaultModel: 'deepseek-flash',
    modelOptions: ['deepseek-flash', 'deepseek-v4-pro'],
    telegramUrl: 'https://t.me/test_bot',
    now: options.now,
    timeZone: 'Europe/Moscow',
  })
  const port = await app.start()
  const base = `http://127.0.0.1:${port}`

  t.after(async () => {
    await app.stop()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { app, base, dir, publicDir, reminders, events, profiles, usage, history }
}

test('вход: неверный пароль, затем верный и cookie-сессия', async (t) => {
  const { base } = await createHarness(t)
  const cookies = jar()

  const anonymous = await request(base, '/api/auth/session', { cookieJar: cookies })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json.code, 'unauthorized')

  const wrong = await request(base, '/api/auth/login', { method: 'POST', body: { password: 'неверный' }, cookieJar: cookies })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json.error, 'Неверный логин или пароль')
  assert.equal(cookies.cookie, '')

  const login = await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  assert.equal(login.status, 200)
  assert.equal(login.json.ok, true)
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(login.response.headers.get('set-cookie'), /SameSite=Strict/)
  assert.match(cookies.cookie, new RegExp('^' + SESSION_COOKIE + '='))

  const session = await request(base, '/api/auth/session', { cookieJar: cookies })
  assert.equal(session.status, 200)
  assert.equal(session.json.user.via, 'password')
  assert.equal(session.json.telegramUrl, 'https://t.me/test_bot')
})

test('вход: cookie Secure включается настройкой, logout стирает сессию', async (t) => {
  const { base } = await createHarness(t, { cookieSecure: true })
  const cookies = jar()
  const login = await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  assert.match(login.response.headers.get('set-cookie'), /Secure/)
  assert.equal((await request(base, '/api/auth/session', { cookieJar: cookies })).status, 200)
  const out = await request(base, '/api/auth/logout', { method: 'POST', cookieJar: cookies })
  assert.equal(out.status, 200)
  assert.match(out.response.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal(cookies.cookie, '')
  assert.equal((await request(base, '/api/auth/session', { cookieJar: cookies })).status, 401)
})

test('без пароля и секрета вход выключен, данные закрыты', async (t) => {
  const { base } = await createHarness(t, { mobilePasswordHash: '', mobileSessionSecret: '' })
  const login = await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD } })
  assert.equal(login.status, 503)
  assert.equal((await request(base, '/api/reminders')).status, 401)
  assert.equal((await request(base, '/api/auth/session')).status, 401)
})

test('cookie-сессия: GET открывает данные, POST без заголовка клиента запрещён', async (t) => {
  const { base, reminders } = await createHarness(t)
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })

  const list = await request(base, '/api/reminders', { cookieJar: cookies })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json, [])

  const blocked = await request(base, '/api/reminders', {
    method: 'POST',
    cookieJar: cookies,
    body: { text: 'Проверка', dueAt: new Date(Date.now() + 3_600_000).toISOString(), repeat: 'none' },
  })
  assert.equal(blocked.status, 403)

  const created = await request(base, '/api/reminders', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { text: 'Проверка', dueAt: new Date(Date.now() + 3_600_000).toISOString(), repeat: 'none' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.text, 'Проверка')
  assert.equal(reminders.list(USER_ID, USER_ID).length, 1)
})

test('cookie-сессия: чужой Origin отклоняется', async (t) => {
  const { base } = await createHarness(t)
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const blocked = await request(base, '/api/memory', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1', Origin: 'https://evil.example' },
    body: { text: 'секрет' },
  })
  assert.equal(blocked.status, 403)
})

test('лимит попыток: после серии ошибок 429 и Retry-After', async (t) => {
  let current = Date.now()
  const { base } = await createHarness(t, {
    loginRateLimit: { maxFailures: 2, windowMs: 60_000, blockMs: 60_000 },
    now: () => current,
  })
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await request(base, '/api/auth/login', { method: 'POST', body: { password: 'неверный' } })).status, 401)
  }
  const blocked = await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD } })
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.response.headers.get('retry-after')) >= 1)

  current += 61_000
  const ok = await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD } })
  assert.equal(ok.status, 200)
})

test('вход: логин проверяется вместе с паролем', async (t) => {
  const { base } = await createHarness(t, { mobileUsername: 'tenkrol' })
  const cookies = jar()

  const noUsername = await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  assert.equal(noUsername.status, 401)
  assert.equal(cookies.cookie, '')

  const wrongUsername = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'другой', password: PASSWORD },
    cookieJar: cookies,
  })
  assert.equal(wrongUsername.status, 401)
  assert.equal(cookies.cookie, '')

  const ok = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: cookies,
  })
  assert.equal(ok.status, 200)
  assert.equal((await request(base, '/api/auth/session', { cookieJar: cookies })).status, 200)
})

test('аккаунты: владелец добавляет Машу, у неё свои данные и свой вход', async (t) => {
  const { base } = await createHarness(t, {
    accounts: true,
    allowedUserIds: [USER_ID, MASHA_ID],
  })
  const owner = jar()
  const loginOwner = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: owner,
  })
  assert.equal(loginOwner.status, 200)
  assert.equal(loginOwner.json.user.role, 'owner')

  const before = await request(base, '/api/accounts', { cookieJar: owner })
  assert.equal(before.status, 200)
  assert.equal(before.json.accounts.length, 1)
  assert.equal(before.json.canManage, true)

  const added = await request(base, '/api/accounts', {
    method: 'POST',
    cookieJar: owner,
    headers: { 'X-Mobile-Client': '1' },
    body: { login: 'masha', password: 'masha-pass', name: 'Маша' },
  })
  assert.equal(added.status, 200)
  assert.equal(added.json.accounts.length, 2)
  assert.equal(added.json.user.userId, MASHA_ID)
  assert.equal(added.json.user.role, 'member')

  const masha = jar()
  const loginMasha = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'masha', password: 'masha-pass' },
    cookieJar: masha,
  })
  assert.equal(loginMasha.status, 200)
  assert.equal(loginMasha.json.user.role, 'member')
  assert.equal((await request(base, '/api/accounts', { cookieJar: masha })).json.canManage, false)

  // Маша пишет свой факт; владелец его не видит.
  const addFact = await request(base, '/api/memory', {
    method: 'POST',
    cookieJar: masha,
    headers: { 'X-Mobile-Client': '1' },
    body: { text: 'факт Маши' },
  })
  assert.equal(addFact.status, 200)
  const ownerMemory = await request(base, '/api/memory', { cookieJar: owner })
  const mashaMemory = await request(base, '/api/memory', { cookieJar: masha })
  assert.equal(ownerMemory.json.facts.some((fact) => fact.text === 'факт Маши'), false)
  assert.equal(mashaMemory.json.facts.some((fact) => fact.text === 'факт Маши'), true)

  const forbidden = await request(base, '/api/accounts', {
    method: 'POST',
    cookieJar: masha,
    headers: { 'X-Mobile-Client': '1' },
    body: { login: 'third', password: 'third-pass', name: 'Третий' },
  })
  assert.equal(forbidden.status, 403)
})

test('аккаунт: смена своего логина и пароля закрывает старые сессии', async (t) => {
  const { base } = await createHarness(t, { accounts: true })
  const old = jar()
  await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: old,
  })
  const staleCookie = old.cookie
  assert.equal((await request(base, '/api/auth/session', { cookieJar: old })).status, 200)

  const changed = await request(base, '/api/account', {
    method: 'PATCH',
    cookieJar: old,
    headers: { 'X-Mobile-Client': '1' },
    body: { currentPassword: PASSWORD, login: 'andryukovy', password: '123' },
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.user.login, 'andryukovy')
  assert.equal(changed.json.sessionUpdated, true)

  // Старая cookie недействительна, новая — из Set-Cookie — работает.
  assert.equal((await request(base, '/api/auth/session', { headers: { cookie: staleCookie } })).status, 401)
  assert.equal((await request(base, '/api/auth/session', { cookieJar: old })).status, 200)
  const oldPassword = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'andryukovy', password: PASSWORD },
  })
  assert.equal(oldPassword.status, 401)
  const newLogin = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'andryukovy', password: '123' },
  })
  assert.equal(newLogin.status, 200)
})

test('аккаунт: неверный текущий пароль не меняет учётные данные', async (t) => {
  const { base } = await createHarness(t, { accounts: true })
  const cookies = jar()
  await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: cookies,
  })
  const denied = await request(base, '/api/account', {
    method: 'PATCH',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { currentPassword: 'wrong', password: 'new-pass' },
  })
  assert.equal(denied.status, 403)
  assert.equal((await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
  })).status, 200)
})

test('настройки: чтение, смена и проверка значений', async (t) => {
  const { base } = await createHarness(t)
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })

  const initial = await request(base, '/api/settings', { cookieJar: cookies })
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.json.options.personas.includes('дружелюбный'), true)
  assert.deepEqual(initial.json.options.moods.includes('бодрый'), true)
  assert.equal(initial.json.defaults.model, 'deepseek-flash')

  const updated = await request(base, '/api/settings', {
    method: 'PATCH',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { city: 'Москва', persona: 'дружелюбный', mood: 'бодрый', mode: 'кратко', voice: true, model: 'deepseek-v4-pro' },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.city, 'Москва')
  assert.equal(updated.json.persona, 'дружелюбный')
  assert.equal(updated.json.mood, 'бодрый')
  assert.equal(updated.json.mode, 'кратко')
  assert.equal(updated.json.voice, true)
  assert.equal(updated.json.model, 'deepseek-v4-pro')

  const invalid = await request(base, '/api/settings', {
    method: 'PATCH',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { persona: 'инопланетный' },
  })
  assert.equal(invalid.status, 400)
})

test('статистика: сегодня и семь дней с нулями', async (t) => {
  const { base, usage } = await createHarness(t)
  usage.record({ usage: { prompt_tokens: 10, completion_tokens: 5 }, userId: USER_ID, chatId: USER_ID })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const stats = await request(base, '/api/stats?days=7', { cookieJar: cookies })
  assert.equal(stats.status, 200)
  assert.equal(stats.json.today.total, 15)
  assert.equal(stats.json.today.requests, 1)
  assert.equal(stats.json.days.length, 7)
  assert.equal(stats.json.days.at(-1).total, 15)
  assert.equal(stats.json.days[0].total, 0)
})

test('история чата: последние сообщения и CTA в Telegram', async (t) => {
  const { base, history } = await createHarness(t)
  await history.append(USER_ID, { role: 'user', content: 'Привет' }, { userId: USER_ID })
  await history.append(USER_ID, { role: 'assistant', content: 'Здравствуйте' })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const chat = await request(base, '/api/chat/history', { cookieJar: cookies })
  assert.equal(chat.status, 200)
  assert.deepEqual(chat.json.messages.map((message) => message.text), ['Привет', 'Здравствуйте'])
  assert.equal(chat.json.telegramUrl, 'https://t.me/test_bot')
})

test('статика /mobile/ с CSP и редирект /mobile', async (t) => {
  const { base } = await createHarness(t)
  const page = await request(base, '/mobile/')
  assert.equal(page.status, 200)
  assert.match(page.text, /mobile/)
  assert.match(page.response.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal(page.response.headers.get('x-frame-options'), 'DENY')

  const redirect = await request(base, '/mobile')
  assert.equal(redirect.status, 302)
  assert.equal(redirect.response.headers.get('location'), '/mobile/')
})

test('Telegram initData по-прежнему открывает API без cookie', async (t) => {
  const { base } = await createHarness(t)
  // Подпись не проверяем здесь: это делает старый тест miniapp.test.mjs.
  // Важно, что без initData и без cookie данные закрыты.
  assert.equal((await request(base, '/api/state')).status, 401)
})
