/**
 * PLB-008: словари мини-приложения, выбор языка и коды ошибок API.
 *
 * Проверки не запускают браузер: словари читаются с диска, чистые функции
 * локализации импортируются напрямую, а коды ошибок проверяются на настоящем
 * HTTP-сервере. Существующий `miniapp.test.mjs` не меняется — эти тесты
 * дополняют его и стерегут русскую версию от случайной правки.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { createMiniApp } from '../src/miniapp.mjs'
import { ReminderStore } from '../src/reminders.mjs'
import { EventStore } from '../src/events.mjs'
import { ProfileStore } from '../src/profiles.mjs'
import { UsageStore } from '../src/usage.mjs'
import { REPEAT_VALUES, describeRepeat } from '../src/repeats.mjs'
import { languageFromInitData, localeTag, resolveLanguage, translate } from '../public/i18n.mjs'

const USER_ID = 777
const BOT_TOKEN = '123456:TEST-bot-token-abcdefghijklmnopqrstuvwxyz'
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public')
const APP_HTML = path.join(PUBLIC_DIR, 'app.html')

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const nowSec = () => Math.floor(Date.now() / 1000)
const futureIso = (offsetMs = 3_600_000) => new Date(Date.now() + offsetMs).toISOString()

const dictionaries = {
  ru: JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'locales', 'ru.json'), 'utf8')),
  en: JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'locales', 'en.json'), 'utf8')),
}

/** Подпись `initData` тем же алгоритмом, что и в `miniapp.test.mjs`. */
function signInitData(user, { authDate = nowSec(), extra = {} } = {}) {
  const params = new URLSearchParams()
  params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc')
  params.set('user', JSON.stringify(user))
  params.set('auth_date', String(authDate))
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value))
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

const validInitData = (user = { id: USER_ID, first_name: 'Андрей', username: 'andry' }) => signInitData(user)

/** Один HTTP-запрос: JSON на входе, разобранный JSON на выходе. */
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

/** Настоящий сервер и настоящие хранилища во временном каталоге. */
async function createHarness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-miniapp-i18n-'))
  const reminders = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger })
  const events = new EventStore({ file: path.join(dir, 'events.json'), logger: silentLogger })
  const profiles = new ProfileStore({ file: path.join(dir, 'profiles.json'), logger: silentLogger })
  const usage = new UsageStore({ file: path.join(dir, 'usage.json'), logger: silentLogger, saveDelayMs: 1 })
  await Promise.all([reminders.load(), events.load(), profiles.load(), usage.load()])

  const app = createMiniApp({
    port: 0,
    host: '127.0.0.1',
    botToken: BOT_TOKEN,
    allowedUserIds: options.allowedUserIds ?? [USER_ID],
    stores: { reminders, events, profiles, usage, ...(options.stores ?? {}) },
    publicDir: PUBLIC_DIR,
    logger: options.logger ?? silentLogger,
  })
  const actualPort = await app.start()
  const base = `http://127.0.0.1:${actualPort}`

  t.after(async () => {
    await app.stop()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { app, base, dir, reminders, events, profiles, usage }
}

/** Подпись повтора так, как её строит клиент: шаблоны и точные ключи. */
function repeatText(dictionary, code) {
  const weekly = /^weekly:([1-7])$/.exec(code)
  if (weekly) return translate(dictionary, `repeat.weekly.${weekly[1]}`)
  const monthly = /^monthly:(\d{1,2})$/.exec(code)
  if (monthly) return translate(dictionary, 'repeat.monthly', { day: Number(monthly[1]) })
  const every = /^every:(\d{1,4})$/.exec(code)
  if (every) return translate(dictionary, 'repeat.every', { minutes: Number(every[1]) })
  return translate(dictionary, `repeat.${code}`)
}

// ---------------------------------------------------------------------------
// Словари и разметка
// ---------------------------------------------------------------------------

test('locales: ru.json и en.json содержат одинаковый набор ключей', () => {
  const ruKeys = Object.keys(dictionaries.ru)
  const enKeys = Object.keys(dictionaries.en)

  const onlyRu = ruKeys.filter((key) => !(key in dictionaries.en))
  const onlyEn = enKeys.filter((key) => !(key in dictionaries.ru))
  assert.deepEqual(onlyRu, [], `ключи есть в ru.json, но нет в en.json: ${onlyRu.join(', ')}`)
  assert.deepEqual(onlyEn, [], `ключи есть в en.json, но нет в ru.json: ${onlyEn.join(', ')}`)
  assert.deepEqual([...enKeys].sort(), [...ruKeys].sort())

  for (const [code, dictionary] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${code}.${key} должен быть строкой`)
      assert.notEqual(value.trim(), '', `${code}.${key} не должен быть пустым`)
    }
  }
})

test('locales: в en.json не осталось кириллицы', () => {
  const leaked = Object.entries(dictionaries.en)
    .filter(([, value]) => /[\u0400-\u04FF]/.test(value))
    .map(([key]) => key)
  assert.deepEqual(leaked, [], `в английском словаре русские строки: ${leaked.join(', ')}`)
})

test('app.html: в разметке вне <script> нет кириллицы', async () => {
  const html = await fs.readFile(APP_HTML, 'utf8')
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const cyrillic = markup.match(/[\u0400-\u04FF]/g) ?? []
  assert.deepEqual(cyrillic, [], `в разметке осталась кириллица: ${cyrillic.join('')}`)
})

test('app.html: все ключи data-i18n есть в обоих словарях', async () => {
  const html = await fs.readFile(APP_HTML, 'utf8')
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g)]
    .map((match) => match[1])
  assert.ok(keys.length >= 20, 'в разметке слишком мало ключей перевода')

  for (const key of new Set(keys)) {
    assert.ok(key in dictionaries.ru, `ru.json: нет ключа ${key}`)
    assert.ok(key in dictionaries.en, `en.json: нет ключа ${key}`)
  }
})

test('app.html: в разметке нет видимого текста, только ключи', async () => {
  const html = await fs.readFile(APP_HTML, 'utf8')
  const withoutCode = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const text = withoutCode.replace(/<[^>]+>/g, '').trim()
  assert.equal(text, '', `в разметке остался видимый текст: ${text.slice(0, 120)}`)
})

// ---------------------------------------------------------------------------
// Выбор языка
// ---------------------------------------------------------------------------

test('resolveLanguage: сохранённый выбор, затем язык Telegram, иначе русский', () => {
  assert.equal(resolveLanguage({ stored: 'en', telegram: 'ru' }), 'en')
  assert.equal(resolveLanguage({ stored: 'ru', telegram: 'en' }), 'ru')
  assert.equal(resolveLanguage({ stored: 'de', telegram: 'en' }), 'en')
  assert.equal(resolveLanguage({ stored: null, telegram: 'de' }), 'ru')
  assert.equal(resolveLanguage({ telegram: 'en-US' }), 'en')
  assert.equal(resolveLanguage({ telegram: 'ru-RU' }), 'ru')
  assert.equal(resolveLanguage({ stored: 'EN' }), 'en')
  assert.equal(resolveLanguage({}), 'ru')
  assert.equal(resolveLanguage(), 'ru')
})

test('languageFromInitData: берёт language_code из JSON-поля user', () => {
  const initData = new URLSearchParams({
    user: JSON.stringify({ id: USER_ID, language_code: 'en' }),
    auth_date: '1',
  }).toString()
  assert.equal(languageFromInitData(initData), 'en')

  const unknown = new URLSearchParams({ user: JSON.stringify({ id: USER_ID, language_code: 'de' }) }).toString()
  assert.equal(languageFromInitData(unknown), undefined)

  assert.equal(languageFromInitData(''), undefined)
  assert.equal(languageFromInitData(null), undefined)
  assert.equal(languageFromInitData('user=%7Bbad'), undefined)
})

test('translate: подставляет значения и возвращает ключ для пропуска', () => {
  assert.equal(translate(dictionaries.en, 'app.title'), 'Home Assistant')
  assert.equal(
    translate(dictionaries.en, 'memory.city', { city: 'Kazan' }),
    'City: Kazan. Change it with a bot command.',
  )
  assert.equal(translate(dictionaries.ru, 'missing.key'), 'missing.key')
  assert.equal(translate(undefined, 'missing.key'), 'missing.key')
  assert.equal(localeTag('en'), 'en-US')
  assert.equal(localeTag('de'), 'ru-RU')
})

test('русские подписи повторов совпадают с describeRepeat для всех значений', () => {
  for (const code of REPEAT_VALUES) {
    const label = repeatText(dictionaries.ru, code)
    assert.equal(label, describeRepeat(code), `подпись повтора ${code}`)
    assert.notEqual(repeatText(dictionaries.en, code), `repeat.${code}`, `английская подпись ${code}`)
  }
})

// ---------------------------------------------------------------------------
// Коды ошибок API
// ---------------------------------------------------------------------------

test('API: 401 и 403 несут коды unauthorized и forbidden', async (t) => {
  const ctx = await createHarness(t)

  const unauthorized = await call(ctx.base, '/api/state')
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.json.code, 'unauthorized')
  assert.equal(typeof unauthorized.json.error, 'string')

  const forbidden = await call(ctx.base, '/api/reminders', {
    initData: validInitData({ id: 424242, first_name: 'Чужой' }),
  })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.json.code, 'forbidden')
  assert.equal(forbidden.json.error, 'Нет доступа')
})

test('API: 404 и 405 несут коды not_found и method_not_allowed', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const notFound = await call(ctx.base, '/api/reminders/999', { method: 'DELETE', initData })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.code, 'not_found')
  assert.equal(notFound.json.error, 'Не найдено')

  const wrongMethod = await call(ctx.base, '/api/reminders', { method: 'PUT', initData })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.code, 'method_not_allowed')
  assert.equal(wrongMethod.json.error, 'Метод не поддерживается')
  assert.match(wrongMethod.response.headers.get('allow') ?? '', /GET/)
})

test('API: 400 и 413 несут коды bad_request и too_large, тексты прежние', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const empty = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData,
    body: { text: '   ', dueAt: futureIso(), repeat: 'none' },
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.code, 'bad_request')
  assert.equal(empty.json.error, 'Текст напоминания не может быть пустым')

  const malformed = await call(ctx.base, '/api/reminders', { method: 'POST', initData, body: '{not json' })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.json.code, 'bad_request')
  assert.equal(malformed.json.error, 'Некорректный JSON в теле запроса')

  const oversized = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData,
    body: JSON.stringify({ text: 'x'.repeat(40_000), dueAt: futureIso(), repeat: 'none' }),
  })
  assert.equal(oversized.status, 413)
  assert.equal(oversized.json.code, 'too_large')
  assert.equal(oversized.json.error, 'Тело запроса слишком большое')
})

test('API: 503 и 500 несут коды unavailable и internal', async (t) => {
  const missing = await createHarness(t, { stores: { reminders: null, events: null, profiles: null, usage: null } })
  const unavailable = await call(missing.base, '/api/reminders', { initData: validInitData() })
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.json.code, 'unavailable')
  assert.match(unavailable.json.error, /недоступно/)

  const logged = []
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(message, fields) { logged.push({ message, fields }) },
  }
  const failing = await createHarness(t, {
    logger,
    stores: { reminders: { list() { throw new Error('boom-internal-detail') } } },
  })
  const internal = await call(failing.base, '/api/reminders', { initData: validInitData() })
  assert.equal(internal.status, 500)
  assert.equal(internal.json.code, 'internal')
  assert.equal(internal.json.error, 'Внутренняя ошибка сервера')
  assert.equal(internal.text.includes('boom-internal-detail'), false)
  assert.equal(logged.length, 1)
})

test('static: словари и модуль локализации отдаются браузеру', async (t) => {
  const ctx = await createHarness(t)

  const english = await call(ctx.base, '/locales/en.json')
  assert.equal(english.status, 200)
  assert.match(english.contentType, /^application\/json/)
  assert.equal(english.json['app.title'], 'Home Assistant')

  const module = await call(ctx.base, '/i18n.mjs')
  assert.equal(module.status, 200)
  assert.match(module.contentType, /^text\/javascript/)
  assert.ok(module.text.includes('resolveLanguage'))
})
