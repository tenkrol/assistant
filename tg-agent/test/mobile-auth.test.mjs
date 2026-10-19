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
import { totpCode } from '../src/totp.mjs'

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
    pushStore: options.pushStore,
    pushPublicKey: options.pushPublicKey ?? '',
    pushTest: options.pushTest,
    avatarProvider: options.avatarProvider,
    mediaStore: options.mediaStore,
    documents: options.documents,
    inbox: options.inbox,
    agentFiles: options.agentFiles,
    mobileAuthLog: options.mobileAuthLog,
    mobileAutomations: options.mobileAutomations,
    gmail: options.gmail,
    mobileQuiz: options.mobileQuiz,
    mobileProjects: options.mobileProjects,
    quizGenerator: options.quizGenerator,
    automationRunner: options.automationRunner,
    systemStatus: options.systemStatus,
    proactiveSettings: options.proactiveSettings,
    updateProactive: options.updateProactive,
    chatResponder: options.chatResponder,
    agentResponder: options.agentResponder,
    agentStatus: options.agentStatus,
    agentCancel: options.agentCancel,
    agentTask: options.agentTask,
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
    groupChatId: options.groupChatId,
    groupTitle: options.groupTitle ?? 'Общий чат',
    groupChatType: options.groupChatType ?? 'group',
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

test('чат с сайта: сообщение проходит через responder и возвращает ответ', async (t) => {
  const seen = []
  const { base } = await createHarness(t, {
    accounts: true,
    chatResponder: async (input) => {
      seen.push(input)
      return {
        sends: [{ text: 'ответ ассистента' }],
        files: [{ fileName: 'file.txt', caption: 'файл', bytes: Buffer.from('hi') }],
      }
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: cookies,
  })

  const noCsrf = await request(base, '/api/chat/message', {
    method: 'POST',
    cookieJar: cookies,
    body: { text: 'привет' },
  })
  assert.equal(noCsrf.status, 403)

  const reply = await request(base, '/api/chat/message', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { text: 'привет' },
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.messages[0].text, 'ответ ассистента')
  assert.equal(reply.json.files[0].fileName, 'file.txt')
  assert.equal(Buffer.from(reply.json.files[0].data, 'base64').toString(), 'hi')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].userId, USER_ID)
  assert.equal(seen[0].chatId, USER_ID)
  assert.equal(seen[0].text, 'привет')

  const empty = await request(base, '/api/chat/message', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { text: '   ' },
  })
  assert.equal(empty.status, 400)
})

test('агент: статус, задание по шаблону и CSRF', async (t) => {
  const seen = []
  const { base } = await createHarness(t, {
    accounts: true,
    agentResponder: async (input) => {
      seen.push(input)
      return { ok: true, text: 'Задача 42 передана агенту' }
    },
    agentStatus: async () => ({
      enabled: true,
      agents: [{ id: 'agent-1', status: 'ready' }],
      events: [{ taskId: '42', agent: 'agent-1', type: 'task', status: 'done' }],
    }),
  })
  const cookies = jar()
  await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: cookies,
  })

  const status = await request(base, '/api/agent/status', { cookieJar: cookies })
  assert.equal(status.status, 200)
  assert.equal(status.json.enabled, true)
  assert.equal(status.json.events[0].taskId, '42')

  const noCsrf = await request(base, '/api/agent/task', {
    method: 'POST',
    cookieJar: cookies,
    body: { task: 'Сделай отчёт' },
  })
  assert.equal(noCsrf.status, 403)

  const sent = await request(base, '/api/agent/task', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { task: 'Сделай отчёт' },
  })
  assert.equal(sent.status, 200)
  assert.match(sent.json.text, /передана/)
  assert.equal(seen[0].task, 'Сделай отчёт')
  assert.equal(seen[0].userId, USER_ID)

  const empty = await request(base, '/api/agent/task', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { task: '' },
  })
  assert.equal(empty.status, 400)
})

test('общий чат: список, история и отправка с chatId группы', async (t) => {
  const seen = []
  const GROUP_ID = -1001234567890
  const { base } = await createHarness(t, {
    accounts: true,
    groupChatId: GROUP_ID,
    groupTitle: 'TenKrol и Машулечка',
    chatResponder: async (input) => {
      seen.push(input)
      return { sends: [{ text: 'ответ в группу' }], files: [] }
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: cookies,
  })

  const chats = await request(base, '/api/chats', { cookieJar: cookies })
  assert.equal(chats.status, 200)
  assert.equal(chats.json.chats.length, 2)
  assert.equal(chats.json.chats[1].id, String(GROUP_ID))
  assert.equal(chats.json.chats[1].title, 'TenKrol и Машулечка')

  const history = await request(base, `/api/chat/history?chatId=${GROUP_ID}`, { cookieJar: cookies })
  assert.equal(history.status, 200)
  assert.equal(history.json.chat.chatId, GROUP_ID)

  const sent = await request(base, '/api/chat/message', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: {
      text: 'привет из веба',
      chatId: String(GROUP_ID),
      replyTo: { text: 'прошлое сообщение', role: 'assistant', author: 'Ассистент' },
    },
  })
  assert.equal(sent.status, 200)
  assert.equal(sent.json.messages[0].text, 'ответ в группу')
  assert.equal(seen[0].chatId, GROUP_ID)
  assert.equal(seen[0].chatType, 'group')
  assert.equal(seen[0].chatTitle, 'TenKrol и Машулечка')
  assert.equal(seen[0].replyTo.text, 'прошлое сообщение')
  assert.equal(seen[0].replyTo.author, 'Ассистент')

  const foreign = await request(base, '/api/chat/history?chatId=-100999', { cookieJar: cookies })
  assert.equal(foreign.status, 403)
})

test('push: конфиг, подписка и отписка', async (t) => {
  const { MobilePushStore } = await import('../src/mobile-push.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-push-api-'))
  const pushStore = new MobilePushStore({ file: path.join(dir, 'push.json'), logger: silentLogger })
  await pushStore.load()
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

  const { base } = await createHarness(t, {
    accounts: true,
    pushStore,
    pushPublicKey: 'BPublicKeyTest',
    pushTest: async ({ userId }) => ({ sent: 1, failed: 0, subscribed: 1, userId }),
  })
  const cookies = jar()
  await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'tenkrol', password: PASSWORD },
    cookieJar: cookies,
  })
  const config = await request(base, '/api/push/config', { cookieJar: cookies })
  assert.equal(config.status, 200)
  assert.equal(config.json.enabled, true)
  assert.equal(config.json.publicKey, 'BPublicKeyTest')

  const subscription = {
    endpoint: 'https://push.example.test/abc',
    keys: { p256dh: '0123456789abcdef', auth: '0123456789abcdef' },
  }
  const sub = await request(base, '/api/push/subscribe', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: subscription,
  })
  assert.equal(sub.status, 200)
  assert.equal(pushStore.listForUsers([USER_ID]).length, 1)

  const unsub = await request(base, '/api/push/unsubscribe', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { endpoint: subscription.endpoint },
  })
  assert.equal(unsub.status, 200)
  assert.equal(pushStore.listForUsers([USER_ID]).length, 0)

  const tested = await request(base, '/api/push/test', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: {},
  })
  assert.equal(tested.status, 200)
  assert.equal(tested.json.sent, 1)
  assert.equal(tested.json.userId, USER_ID)
})

test('система: состояние сервера и бэкапы', async (t) => {
  const { base } = await createHarness(t, {
    systemStatus: async () => ({
      generatedAt: '2026-10-19T10:00:00.000Z',
      server: 'Диск: 40%\nСервисы: ok',
      backups: [{ name: 'state.tar.gz', size: 1024, at: '2026-10-19T03:00:00.000Z' }],
    }),
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const system = await request(base, '/api/system', { cookieJar: cookies })
  assert.equal(system.status, 200)
  assert.match(system.json.server, /Диск/)
  assert.equal(system.json.backups[0].name, 'state.tar.gz')
})

test('файлы: список документов и скачивание оригинала', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-files-api-'))
  const original = path.join(dir, 'a.txt')
  await fs.writeFile(original, 'hello')
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  const { base } = await createHarness(t, {
    documents: {
      list: () => [{ id: 'd1', fileName: 'a.txt', mime: 'text/plain', size: 5, processingStatus: 'ready', createdAt: new Date().toISOString() }],
      createDownloadLink: async () => ({ token: 't1' }),
      resolveDownloadLink: async () => ({ filePath: original, fileName: 'a.txt', version: { mime: 'text/plain' } }),
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const list = await request(base, '/api/files', { cookieJar: cookies })
  assert.equal(list.status, 200)
  assert.equal(list.json.files[0].name, 'a.txt')
  const download = await fetch(`${base}/api/files/d1/download`, { headers: { cookie: cookies.cookie } })
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'hello')
  assert.match(download.headers.get('content-disposition'), /a\.txt/)
})

test('проактивность: чтение и сохранение настроек', async (t) => {
  let current = { enabled: true, reviewAt: '09:00', quiet: { start: 23 * 60, end: 8 * 60 }, dayLimit: 3, globalEnabled: true }
  const patches = []
  const { base } = await createHarness(t, {
    proactiveSettings: async () => current,
    updateProactive: async (patch) => { patches.push(patch); current = { ...current, ...patch }; return current },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const before = await request(base, '/api/proactive', { cookieJar: cookies })
  assert.equal(before.status, 200)
  assert.equal(before.json.reviewAt, '09:00')
  assert.equal(before.json.globalEnabled, true)

  const after = await request(base, '/api/proactive', {
    method: 'PATCH',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { enabled: false, reviewAt: '10:30', dayLimit: 5, quietStart: '22:00', quietEnd: '07:00' },
  })
  assert.equal(after.status, 200)
  assert.equal(patches[0].enabled, false)
  assert.equal(patches[0].reviewAt, '10:30')
  assert.equal(patches[0].dayLimit, 5)
  assert.deepEqual(patches[0].quiet, { start: 1320, end: 420 })

  const invalid = await request(base, '/api/proactive', {
    method: 'PATCH',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { reviewAt: '25:00' },
  })
  assert.equal(invalid.status, 400)
})

test('агент: детали задачи', async (t) => {
  const { base } = await createHarness(t, {
    agentTask: async (taskId) => ({ task: { task: 'проверь сервер ' + taskId }, status: 'done' }),
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const details = await request(base, '/api/agent/task/task-1', { cookieJar: cookies })
  assert.equal(details.status, 200)
  assert.match(JSON.stringify(details.json.task), /проверь сервер/)
})

test('агент: отмена задачи', async (t) => {
  const cancelled = []
  const { base } = await createHarness(t, {
    agentCancel: async ({ taskId }) => { cancelled.push(taskId); return { ok: true } },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const done = await request(base, '/api/agent/cancel', {
    method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' },
    body: { taskId: 'task-1' },
  })
  assert.equal(done.status, 200)
  assert.deepEqual(cancelled, ['task-1'])
  const empty = await request(base, '/api/agent/cancel', {
    method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: {},
  })
  assert.equal(empty.status, 400)
})

test('проекты: очистка чата', async (t) => {
  let cleared = null
  const { base, history } = await createHarness(t, {
    mobileProjects: {
      list: () => [{ id: 'p1', name: 'Работа', instructions: '' }],
      find: (userId, id) => id === 'p1' ? { id: 'p1', name: 'Работа', instructions: '' } : undefined,
    },
  })
  history.reset = async (chatId) => { cleared = chatId }
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const response = await request(base, '/api/projects/p1/chat', { method: 'DELETE', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' } })
  assert.equal(response.status, 200)
  assert.equal(cleared, 'project:p1')
})

test('проекты: список и отдельный контекст', async (t) => {
  const seen = []
  const { base } = await createHarness(t, {
    mobileProjects: {
      list: () => [{ id: 'p1', name: 'Работа', instructions: 'коротко' }],
      find: (userId, id) => id === 'p1' ? { id: 'p1', name: 'Работа', instructions: 'коротко' } : undefined,
      add: async () => ({ id: 'p2', name: 'Дом', instructions: '' }),
      update: async () => ({ id: 'p1', name: 'Работа', instructions: 'коротко' }),
      remove: async () => true,
    },
    chatResponder: async (input) => { seen.push(input); return { sends: [{ text: 'ответ' }], files: [] } },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const list = await request(base, '/api/projects', { cookieJar: cookies })
  assert.equal(list.json.projects.length, 1)
  const sent = await request(base, '/api/chat/message', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { chatId: 'project:p1', text: 'привет' } })
  assert.equal(sent.status, 200)
  assert.equal(seen[0].webOnly, true)
  assert.equal(seen[0].projectInstructions, 'коротко')
})

test('опрос дня: вопросы и ответ в память', async (t) => {
  const questions = [{ id: 'q1', text: 'Что ты любишь?' }]
  const answers = {}
  const { base } = await createHarness(t, {
    mobileQuiz: {
      ensure: async () => ({ date: '2026-10-19', questions, answers }),
      get: () => ({ date: '2026-10-19', questions, answers }),
      answer: async ({ questionId, text }) => { answers[questionId] = text; return { question: questions[0], answer: text } },
    },
    quizGenerator: async () => ['Что ты любишь?'],
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const quiz = await request(base, '/api/quiz', { cookieJar: cookies })
  assert.equal(quiz.status, 200)
  assert.equal(quiz.json.questions.length, 1)
  const answered = await request(base, '/api/quiz/answer', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { questionId: 'q1', text: 'кофе' } })
  assert.equal(answered.status, 200)
  const memory = await request(base, '/api/memory', { cookieJar: cookies })
  assert.match(JSON.stringify(memory.json.facts), /кофе/)
})

test('Gmail: статус без настройки', async (t) => {
  const { base } = await createHarness(t, {
    gmail: { client: { configured: false, redirectUri: 'https://tenkrol.ru/api/gmail/callback' }, tokens: { get: () => undefined, remove: async () => {} } },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const status = await request(base, '/api/gmail/status', { cookieJar: cookies })
  assert.equal(status.status, 200)
  assert.equal(status.json.configured, false)
  assert.equal(status.json.connected, false)
})

test('автоматизации: создать, переключить и запустить', async (t) => {
  const items = []
  const runs = []
  const { base } = await createHarness(t, {
    mobileAutomations: {
      list: (userId) => items.filter((item) => item.userId === userId),
      add: async ({ userId, title, prompt, time, weekdays }) => { const item = { id: 'a1', userId, title, prompt, time, weekdays, enabled: true, nextRunAt: new Date().toISOString(), history: [] }; items.push(item); return item },
      update: async ({ itemId, enabled }) => { const item = items.find((entry) => entry.id === itemId); item.enabled = enabled; return item },
      remove: async () => true,
      find: (userId, id) => items.find((item) => item.id === id && item.userId === userId),
      markRun: async (item, result) => { item.lastStatus = result.ok ? 'ok' : 'failed' },
      due: () => [],
    },
    automationRunner: async ({ text }) => { runs.push(text); return { sends: [] } },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const created = await request(base, '/api/automations', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { title: 'Утро', prompt: 'Дайджест', time: '09:00' } })
  assert.equal(created.status, 200)
  const listed = await request(base, '/api/automations', { cookieJar: cookies })
  assert.equal(listed.json.items.length, 1)
  const run = await request(base, '/api/automations/a1/run', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' } })
  assert.equal(run.status, 200)
  assert.deepEqual(runs, ['Дайджест'])
})

test('журнал входов показывает записи аккаунта', async (t) => {
  const { base } = await createHarness(t, {
    mobileAuthLog: { list: ({ login }) => [{ at: new Date().toISOString(), login, ok: true, via: 'password', ip: '127.0.0.1', userAgent: 'test' }], add: async () => {} },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const log = await request(base, '/api/security/log', { cookieJar: cookies })
  assert.equal(log.status, 200)
  assert.equal(log.json.entries[0].ok, true)
})

test('2FA: включение и вход по коду', async (t) => {
  const { base } = await createHarness(t, { accounts: true })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { username: 'tenkrol', password: PASSWORD }, cookieJar: cookies })
  const setup = await request(base, '/api/2fa/setup', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { currentPassword: PASSWORD } })
  assert.equal(setup.status, 200)
  assert.ok(setup.json.secret)
  const code = totpCode(setup.json.secret)
  const enabled = await request(base, '/api/2fa/enable', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { currentPassword: PASSWORD, code } })
  assert.equal(enabled.status, 200)
  await request(base, '/api/auth/logout', { method: 'POST', cookieJar: cookies })
  const noCode = await request(base, '/api/auth/login', { method: 'POST', body: { username: 'tenkrol', password: PASSWORD }, cookieJar: cookies })
  assert.equal(noCode.status, 401)
  assert.equal(noCode.json.code, 'totp_required')
  const withCode = await request(base, '/api/auth/login', { method: 'POST', body: { username: 'tenkrol', password: PASSWORD, code: totpCode(setup.json.secret) }, cookieJar: cookies })
  assert.equal(withCode.status, 200)
})

test('выйти на всех устройствах отзывает сессию', async (t) => {
  const { base } = await createHarness(t, { accounts: true })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { username: 'tenkrol', password: PASSWORD }, cookieJar: cookies })
  const wrong = await request(base, '/api/session/revoke-all', {
    method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { currentPassword: 'неверный' },
  })
  assert.equal(wrong.status, 403)
  const done = await request(base, '/api/session/revoke-all', {
    method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { currentPassword: PASSWORD },
  })
  assert.equal(done.status, 200)
  assert.match(done.response.headers.get('set-cookie'), /tg_mobile_session=;/)
  const old = await request(base, '/api/state', { cookieJar: cookies })
  assert.equal(old.status, 401)
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

test('медиа: загрузка фото, отдача и отправка с вложением', async (t) => {
  const { MobileMediaStore } = await import('../src/mobile-media.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-api-'))
  const mediaStore = new MobileMediaStore({ file: path.join(dir, 'media.json'), dir: path.join(dir, 'files'), logger: silentLogger })
  await mediaStore.load()
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  const seen = []
  const { base, history } = await createHarness(t, {
    mediaStore,
    chatResponder: async (input) => {
      seen.push(input)
      return { sends: [{ text: 'фото принято' }], files: [] }
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })

  const upload = await fetch(`${base}/api/chat/upload`, {
    method: 'POST',
    headers: {
      cookie: cookies.cookie,
      'X-Mobile-Client': '1',
      'X-File-Name': encodeURIComponent('photo.png'),
      'Content-Type': 'image/png',
    },
    body: Buffer.from([137, 80, 78, 71]),
  })
  assert.equal(upload.status, 201)
  const uploaded = await upload.json()
  assert.equal(uploaded.kind, 'photo')
  assert.equal(uploaded.url, `/api/media/${uploaded.id}`)

  const media = await fetch(`${base}${uploaded.url}`, { headers: { cookie: cookies.cookie } })
  assert.equal(media.status, 200)
  assert.equal(media.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await media.arrayBuffer()).toString('hex'), '89504e47')

  const sent = await request(base, '/api/chat/message', {
    method: 'POST',
    cookieJar: cookies,
    headers: { 'X-Mobile-Client': '1' },
    body: { text: 'смотри', attachments: [{ id: uploaded.id }] },
  })
  assert.equal(sent.status, 200)
  assert.equal(sent.json.messages[0].text, 'фото принято')
  assert.equal(Buffer.from(seen[0].attachments[0].bytes).toString('hex'), '89504e47')

  await history.append(USER_ID, {
    role: 'user',
    content: 'смотри',
    attachments: [uploaded],
  }, { userId: USER_ID })
  await history.flush()
  const chat = await request(base, '/api/chat/history', { cookieJar: cookies })
  assert.equal(chat.json.messages.at(-1).attachments[0].id, uploaded.id)
})

test('инбокс: добавить, отметить, удалить', async (t) => {
  const items = []
  const { base } = await createHarness(t, {
    inbox: {
      list: (userId) => items.filter((item) => item.userId === userId),
      add: async ({ userId, text }) => { const item = { id: 'i1', userId, text, done: false, createdAt: new Date().toISOString() }; items.push(item); return item },
      toggle: async ({ itemId, done }) => { const item = items.find((entry) => entry.id === itemId); item.done = done; return item },
      remove: async ({ itemId }) => { const index = items.findIndex((entry) => entry.id === itemId); return items.splice(index, 1)[0] },
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const created = await request(base, '/api/inbox', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { text: 'позвонить' } })
  assert.equal(created.status, 200)
  assert.equal(created.json.item.text, 'позвонить')
  const listed = await request(base, '/api/inbox', { cookieJar: cookies })
  assert.equal(listed.json.items.length, 1)
  const toggled = await request(base, '/api/inbox', { method: 'PATCH', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { itemId: 'i1', done: true } })
  assert.equal(toggled.json.item.done, true)
  const removed = await request(base, '/api/inbox?id=i1', { method: 'DELETE', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' } })
  assert.equal(removed.status, 200)
})

test('файлы агента: список, скачивание и удаление', async (t) => {
  const original = path.join(t.context?.dir ?? process.cwd(), 'agent-file.txt')
  const { base } = await createHarness(t, {
    agentFiles: {
      list: (chatId) => [{ id: 'af1', chatId, name: 'отчёт.txt', mime: 'text/plain', size: 5, storageName: 'af1.txt', at: new Date().toISOString() }].filter(() => String(chatId) === String(USER_ID)),
      getPath: () => original,
      remove: async () => true,
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const listed = await request(base, '/api/files/agent', { cookieJar: cookies })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.files[0].name, 'отчёт.txt')
  const removed = await request(base, '/api/files/agent/af1', { method: 'DELETE', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' } })
  assert.equal(removed.status, 200)
})

test('память: экспорт в JSON', async (t) => {
  const { base } = await createHarness(t)
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  await request(base, '/api/memory', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { text: 'экспортируемый факт' } })
  const response = await fetch(`${base}/api/memory/export`, { headers: { cookie: cookies.cookie } })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.match(JSON.stringify(data.facts), /экспортируемый факт/)
})

test('память: изменить факт', async (t) => {
  const { base } = await createHarness(t)
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const created = await request(base, '/api/memory', { method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { text: 'любит чай' } })
  assert.equal(created.status, 200)
  const updated = await request(base, '/api/memory/' + created.json.id, { method: 'PATCH', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { text: 'любит кофе' } })
  assert.equal(updated.status, 200)
  const confirmed = await request(base, '/api/memory/' + created.json.id, { method: 'PATCH', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { confirmationStatus: 'confirmed' } })
  assert.equal(confirmed.status, 200)
  const memory = await request(base, '/api/memory', { cookieJar: cookies })
  assert.match(JSON.stringify(memory.json.facts), /любит кофе/)
})

test('файлы: поиск по содержимому', async (t) => {
  const { base } = await createHarness(t, {
    documents: {
      list: () => [],
      search: async ({ query }) => ({
        query,
        semantic: false,
        results: [{ citation: { documentId: 'd1', documentName: 'договор.pdf', snippet: 'оплата в течение 5 дней', page: 2, versionNumber: 1 } }],
      }),
    },
  })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const found = await request(base, '/api/files/search?q=оплата', { cookieJar: cookies })
  assert.equal(found.status, 200)
  assert.equal(found.json.results[0].name, 'договор.pdf')
  assert.match(found.json.results[0].snippet, /оплата/)
})

test('аватар: отдаётся только своим, история ссылается на него', async (t) => {
  const { base, profiles, history } = await createHarness(t, {
    avatarProvider: async (userId) => (Number(userId) === USER_ID ? { bytes: Buffer.from([1, 2, 3]), mime: 'image/png' } : null),
  })
  await profiles.touch(USER_ID, { firstName: 'Владелец' })
  await history.append(USER_ID, { role: 'user', content: 'привет', author: 'Владелец' }, { userId: USER_ID })
  await history.flush()
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })

  const photo = await request(base, `/api/avatar/${USER_ID}`, { cookieJar: cookies })
  assert.equal(photo.status, 200)
  assert.equal(photo.response.headers.get('content-type'), 'image/png')
  assert.equal(photo.text, Buffer.from([1, 2, 3]).toString())

  const foreign = await request(base, `/api/avatar/${MASHA_ID}`, { cookieJar: cookies })
  assert.equal(foreign.status, 403)

  const chat = await request(base, '/api/chat/history', { cookieJar: cookies })
  assert.equal(chat.status, 200)
  assert.equal(chat.json.messages[0].avatar, `/api/avatar/${USER_ID}`)
})

test('редактировать и удалить своё сообщение', async (t) => {
  const calls = []
  const { base, history } = await createHarness(t, {
    editChatMessage: async (input) => calls.push(['edit', input]),
    deleteChatMessage: async (input) => calls.push(['delete', input]),
  })
  await history.append(USER_ID, { role: 'user', content: 'старый текст' }, { userId: USER_ID })
  await history.flush()
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const chat = await request(base, '/api/chat/history', { cookieJar: cookies })
  const id = chat.json.messages[0].id
  const edited = await request(base, '/api/chat/message/' + id, {
    method: 'PATCH', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' }, body: { text: 'новый текст' },
  })
  assert.equal(edited.status, 200)
  assert.equal(edited.json.message.text, 'новый текст')
  const removed = await request(base, '/api/chat/message/' + id, { method: 'DELETE', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' } })
  assert.equal(removed.status, 200)
  const after = await request(base, '/api/chat/history', { cookieJar: cookies })
  assert.equal(after.json.messages.length, 0)
})

test('реакция на сообщение сохраняется', async (t) => {
  const { base, history } = await createHarness(t)
  await history.append(USER_ID, { role: 'user', content: 'поставь лайк' }, { userId: USER_ID })
  await history.flush()
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const chat = await request(base, '/api/chat/history', { cookieJar: cookies })
  const id = chat.json.messages[0].id
  assert.ok(id)
  const reacted = await request(base, '/api/chat/react', {
    method: 'POST', cookieJar: cookies, headers: { 'X-Mobile-Client': '1' },
    body: { messageId: id, reaction: '👍' },
  })
  assert.equal(reacted.status, 200)
  assert.equal(reacted.json.reaction, '👍')
  const after = await request(base, '/api/chat/history', { cookieJar: cookies })
  assert.equal(after.json.messages[0].reaction, '👍')
})

test('поиск по истории чата', async (t) => {
  const { base, history } = await createHarness(t)
  await history.append(USER_ID, { role: 'user', content: 'купить молоко' }, { userId: USER_ID })
  await history.append(USER_ID, { role: 'assistant', content: 'молоко уже есть' })
  await history.flush()
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const found = await request(base, '/api/chat/search?q=молоко', { cookieJar: cookies })
  assert.equal(found.status, 200)
  assert.equal(found.json.results.length, 2)
  assert.match(found.json.results[0].text, /молоко/)
  const short = await request(base, '/api/chat/search?q=м', { cookieJar: cookies })
  assert.equal(short.status, 400)
})

test('история сохраняет цитату ответа', async (t) => {
  const { base, history } = await createHarness(t)
  await history.append(USER_ID, {
    role: 'user',
    content: 'это ответ',
    replyTo: { text: 'на что отвечаю', author: 'Ассистент' },
  }, { userId: USER_ID })
  await history.flush()
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const chat = await request(base, '/api/chat/history', { cookieJar: cookies })
  assert.equal(chat.status, 200)
  assert.equal(chat.json.messages[0].replyTo.text, 'на что отвечаю')
  assert.equal(chat.json.messages[0].replyTo.author, 'Ассистент')
})

test('календарь: ссылка-подписка без cookie', async (t) => {
  const { base } = await createHarness(t)
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const link = await request(base, '/api/calendar/link', { cookieJar: cookies })
  assert.equal(link.status, 200)
  assert.match(link.json.url, /\/api\/calendar\.ics\?token=/)
  const pathOnly = new URL(link.json.url).pathname + new URL(link.json.url).search
  const feed = await fetch(base + pathOnly)
  assert.equal(feed.status, 200)
  assert.match(await feed.text(), /BEGIN:VCALENDAR/)
  const forged = await fetch(base + '/api/calendar.ics?token=wrong')
  assert.equal(forged.status, 403)
})

test('экспорт календаря в .ics', async (t) => {
  const { base, reminders, events } = await createHarness(t)
  reminders.add({ chatId: USER_ID, userId: USER_ID, text: 'позвонить', dueAt: new Date(Date.now() + 3600_000).toISOString(), repeat: 'none' })
  events.add({ chatId: USER_ID, userId: USER_ID, title: 'встреча', at: new Date(Date.now() + 7200_000).toISOString(), repeat: 'none' })
  const cookies = jar()
  await request(base, '/api/auth/login', { method: 'POST', body: { password: PASSWORD }, cookieJar: cookies })
  const response = await fetch(`${base}/api/calendar.ics`, { headers: { cookie: cookies.cookie } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/calendar/)
  const text = await response.text()
  assert.match(text, /BEGIN:VCALENDAR/)
  assert.match(text, /SUMMARY:Напоминание: позвонить/)
  assert.match(text, /SUMMARY:Событие: встреча/)
})

test('статистика: сегодня и семь дней с нулями', async (t) => {
  const { base, usage } = await createHarness(t)
  usage.record({ usage: { prompt_tokens: 10, completion_tokens: 5 }, userId: USER_ID, chatId: USER_ID, timeZone: 'Europe/Moscow' })
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
