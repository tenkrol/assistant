/**
 * PLB-028: панель — тон напоминания, интервалы «каждые N» и вечерний чек-ин.
 *
 * Здесь проверяются три вещи, которых раньше не было:
 *  - селект тона уходит в API вместе с текстом и временем (тело собирает та же
 *    функция `public/panel.mjs`, которую вызывает страница);
 *  - интервал меньше 15 минут панель не отправляет, а сервер его отклоняет;
 *  - вечерний чек-ин сохраняется через существующий `PATCH /api/proactive`
 *    в `settings.eveningCheckIn` и переживает перезапись файла.
 *
 * Браузер не запускается: страница читается как текст, а API вызывается на
 * настоящем сервере с настоящими хранилищами во временном каталоге.
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
import { ProactiveStore } from '../src/proactive.mjs'
import { REPEAT_VALUES } from '../src/repeats.mjs'
import { translate } from '../public/i18n.mjs'
import {
  DEFAULT_EVENING_CHECK_IN,
  TONE_CHOICES,
  eveningSettingsPayload,
  normalizeEvening,
  reminderPayload,
} from '../public/panel.mjs'

const USER_ID = 777
const BOT_TOKEN = '123456:TEST-bot-token-abcdefghijklmnopqrstuvwxyz'
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public')
const APP_HTML = path.join(PUBLIC_DIR, 'app.html')
const PRINCIPAL = { channel: 'telegram', userId: USER_ID }

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const nowSec = () => Math.floor(Date.now() / 1000)
const futureIso = (offsetMs = 3_600_000) => new Date(Date.now() + offsetMs).toISOString()

const dictionaries = {
  ru: JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'locales', 'ru.json'), 'utf8')),
  en: JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'locales', 'en.json'), 'utf8')),
}
const ru = (key, vars) => translate(dictionaries.ru, key, vars)

/** Подпись `initData` тем же алгоритмом, что и в остальных тестах панели. */
function signInitData(user, { authDate = nowSec() } = {}) {
  const params = new URLSearchParams()
  params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc')
  params.set('user', JSON.stringify(user))
  params.set('auth_date', String(authDate))
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'))
  return params.toString()
}

const validInitData = (user = { id: USER_ID, first_name: 'Андрей' }) => signInitData(user)

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

/** Сервер с настоящими хранилищами и настоящим ProactiveStore. */
async function createHarness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-panel-028-'))
  const reminders = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger })
  const events = new EventStore({ file: path.join(dir, 'events.json'), logger: silentLogger })
  const profiles = new ProfileStore({ file: path.join(dir, 'profiles.json'), logger: silentLogger })
  const usage = new UsageStore({ file: path.join(dir, 'usage.json'), logger: silentLogger, saveDelayMs: 1 })
  const proactive = new ProactiveStore({ file: path.join(dir, 'proactive.json'), logger: silentLogger })
  await Promise.all([reminders.load(), events.load(), profiles.load(), usage.load(), proactive.load()])

  const app = createMiniApp({
    port: 0,
    host: '127.0.0.1',
    botToken: BOT_TOKEN,
    allowedUserIds: [USER_ID],
    stores: { reminders, events, profiles, usage },
    publicDir: PUBLIC_DIR,
    logger: silentLogger,
    proactiveSettings: async ({ userId }) => ({
      ...proactive.settingsFor({ channel: 'telegram', userId }),
      globalEnabled: true,
    }),
    updateProactive: async (patch, { userId }) => proactive.updateSettings(patch, { channel: 'telegram', userId }),
  })
  const actualPort = await app.start()
  const base = `http://127.0.0.1:${actualPort}`

  t.after(async () => {
    await app.stop()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { app, base, dir, reminders, proactive }
}

// ---------------------------------------------------------------------------
// Разметка и тело запроса
// ---------------------------------------------------------------------------

test('app.html: селект тона в форме напоминания и чек-ин со временем 21:00', async () => {
  const html = await fs.readFile(APP_HTML, 'utf8')

  assert.match(html, /<select id="reminder-tone"><\/select>/, 'нет селекта тона напоминания')
  assert.match(html, /<select id="evening-tone"><\/select>/, 'нет селекта тона чек-ина')
  assert.match(html, /<form[^>]+id="evening-form"/, 'нет формы вечернего чек-ина')
  assert.match(html, /id="evening-at"[^>]*value="21:00"/, 'время чек-ина по умолчанию не 21:00')
  assert.match(html, /byId\('reminder-tone'\)\.value/, 'форма не читает выбранный тон')
  assert.match(html, /eveningSettingsPayload/, 'чек-ин не собирает тело через общий помощник')
  assert.match(html, /'PATCH', '\/api\/proactive'/, 'чек-ин не сохраняется через /api/proactive')

  // В вариантах повтора только разрешённые интервалы, и все они не меньше 15 минут.
  const intervals = [...html.matchAll(/\['(every:\d+)',/g)].map((match) => match[1])
  assert.deepEqual(intervals, ['every:15', 'every:30', 'every:60', 'every:120'])
  for (const code of intervals) {
    assert.ok(REPEAT_VALUES.includes(code), `сервер не знает повтор ${code}`)
    assert.ok(Number(code.split(':')[1]) >= 15, `панель предлагает слишком частый ${code}`)
  }
})

test('панель: тон по умолчанию нейтральный и уходит вместе с текстом и временем', () => {
  assert.deepEqual(TONE_CHOICES.map((entry) => entry[0]), ['gentle', 'neutral', 'strict'])

  const strict = reminderPayload({ text: '  Позвонить маме ', repeat: 'every:60', tone: 'strict' }, ru)
  assert.equal(strict.text, 'Позвонить маме')
  assert.equal(strict.repeat, 'every:60')
  assert.equal(strict.tone, 'strict')

  assert.equal(reminderPayload({ text: 'без тона', repeat: 'none' }, ru).tone, 'neutral')
  assert.equal(reminderPayload({ text: 'чужой тон', repeat: 'none', tone: 'loud' }, ru).tone, 'neutral')
  assert.throws(
    () => reminderPayload({ text: '   ', repeat: 'none' }, ru),
    { message: 'Введите текст напоминания' },
  )
})

test('панель: интервал меньше 15 минут не отправляется, разрешённые проходят', () => {
  for (const minutes of [1, 5, 10, 14]) {
    assert.throws(
      () => reminderPayload({ text: 'вода', repeat: `every:${minutes}` }, ru),
      { message: 'Минимальный интервал — 15 минут' },
      `every:${minutes} не должен отправляться`,
    )
  }
  for (const minutes of [15, 30, 60, 120, 1440]) {
    assert.doesNotThrow(
      () => reminderPayload({ text: 'вода', repeat: `every:${minutes}` }, ru),
      `every:${minutes} должен отправляться`,
    )
  }
})

test('панель: чек-ин собирает включение, время и тон', () => {
  assert.deepEqual(
    eveningSettingsPayload({ enabled: true, at: '21:00', tone: 'gentle' }, ru),
    { eveningCheckIn: { enabled: true, at: '21:00', tone: 'gentle' } },
  )
  assert.deepEqual(
    eveningSettingsPayload({ enabled: false, at: ' 07:30 ', tone: 'чужой' }, ru),
    { eveningCheckIn: { enabled: false, at: '07:30', tone: 'neutral' } },
  )
  assert.throws(
    () => eveningSettingsPayload({ enabled: true, at: '25:00' }, ru),
    { message: 'Время в формате ЧЧ:ММ' },
  )
  assert.deepEqual(normalizeEvening(undefined), DEFAULT_EVENING_CHECK_IN)
  assert.deepEqual(
    normalizeEvening({ enabled: true, at: 'не время', tone: 'strict' }),
    { enabled: true, at: '21:00', tone: 'strict' },
  )
})

// ---------------------------------------------------------------------------
// API: напоминание
// ---------------------------------------------------------------------------

test('API: тон напоминания сохраняется, возвращается и читается с диска', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const body = reminderPayload({ text: 'Выпить таблетки', repeat: 'every:60', tone: 'gentle' }, ru)
  body.dueAt = futureIso()
  const created = await call(ctx.base, '/api/reminders', { method: 'POST', initData, body })
  assert.equal(created.status, 200)
  assert.equal(created.json.tone, 'gentle')
  assert.equal(created.json.repeat, 'every:60')

  const listed = await call(ctx.base, '/api/reminders', { initData })
  assert.equal(listed.json[0].tone, 'gentle')

  const replayed = new ReminderStore({ file: path.join(ctx.dir, 'reminders.json'), logger: silentLogger })
  await replayed.load()
  assert.equal(replayed.list(USER_ID, USER_ID)[0].tone, 'gentle')

  const defaulted = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData,
    body: { text: 'Без тона', dueAt: futureIso(), repeat: 'none' },
  })
  assert.equal(defaulted.json.tone, 'neutral', 'без поля tone напоминание нейтральное')

  const invalid = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData,
    body: { text: 'Странный тон', dueAt: futureIso(), repeat: 'none', tone: 'loud' },
  })
  assert.equal(invalid.status, 400)
  assert.match(invalid.json.error, /тон/)
})

test('API: повтор every:5 отклоняется, интервалы от 15 минут принимаются', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const refused = await call(ctx.base, '/api/reminders', {
    method: 'POST',
    initData,
    body: { text: 'Слишком часто', dueAt: futureIso(), repeat: 'every:5' },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.json.error, /минимальный интервал/i)
  assert.deepEqual((await call(ctx.base, '/api/reminders', { initData })).json, [])

  for (const minutes of [15, 30, 60, 120]) {
    const body = reminderPayload({ text: `Вода ${minutes}`, repeat: `every:${minutes}`, tone: 'neutral' }, ru)
    body.dueAt = futureIso()
    const created = await call(ctx.base, '/api/reminders', { method: 'POST', initData, body })
    assert.equal(created.status, 200, `every:${minutes}`)
    assert.equal(created.json.repeat, `every:${minutes}`)
  }
})

// ---------------------------------------------------------------------------
// API: вечерний чек-ин
// ---------------------------------------------------------------------------

test('API: вечерний чек-ин сохраняется в settings.eveningCheckIn и переживает перезапись', async (t) => {
  const ctx = await createHarness(t)
  const initData = validInitData()

  const saved = await call(ctx.base, '/api/proactive', {
    method: 'PATCH',
    initData,
    body: eveningSettingsPayload({ enabled: true, at: '21:00', tone: 'gentle' }, ru),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json.eveningCheckIn, { enabled: true, at: '21:00', tone: 'gentle' })

  const read = await call(ctx.base, '/api/proactive', { initData })
  assert.equal(read.status, 200)
  assert.deepEqual(read.json.eveningCheckIn, { enabled: true, at: '21:00', tone: 'gentle' })

  // Частичное сохранение не сбрасывает остальные поля.
  const changed = await call(ctx.base, '/api/proactive', {
    method: 'PATCH',
    initData,
    body: { eveningCheckIn: { at: '22:15' } },
  })
  assert.deepEqual(changed.json.eveningCheckIn, { enabled: true, at: '22:15', tone: 'gentle' })

  const disabled = await call(ctx.base, '/api/proactive', {
    method: 'PATCH',
    initData,
    body: { eveningCheckIn: { enabled: false } },
  })
  assert.deepEqual(disabled.json.eveningCheckIn, { enabled: false, at: '22:15', tone: 'gentle' })

  const replayed = new ProactiveStore({ file: path.join(ctx.dir, 'proactive.json'), logger: silentLogger })
  await replayed.load()
  assert.deepEqual(replayed.settingsFor(PRINCIPAL).eveningCheckIn, {
    enabled: false,
    at: '22:15',
    tone: 'gentle',
  })

  for (const bad of [
    { eveningCheckIn: { at: '25:00' } },
    { eveningCheckIn: { tone: 'loud' } },
    { eveningCheckIn: 'yes' },
  ]) {
    const refused = await call(ctx.base, '/api/proactive', { method: 'PATCH', initData, body: bad })
    assert.equal(refused.status, 400, JSON.stringify(bad))
  }
  const after = await call(ctx.base, '/api/proactive', { initData })
  assert.deepEqual(after.json.eveningCheckIn, { enabled: false, at: '22:15', tone: 'gentle' })
})

// ---------------------------------------------------------------------------
// Словари и статика
// ---------------------------------------------------------------------------

test('locales: ключи тона и чек-ина есть в обоих словарях и наборы совпадают', () => {
  const required = [
    'reminders.tone.label',
    'tone.gentle',
    'tone.neutral',
    'tone.strict',
    'evening.heading',
    'evening.enabled.label',
    'evening.at.label',
    'evening.tone.label',
    'evening.hint',
    'evening.submit',
    'evening.saved',
    'form.evening.time',
    'form.repeat.min',
  ]
  for (const key of required) {
    assert.equal(typeof dictionaries.ru[key], 'string', `ru.json: нет ключа ${key}`)
    assert.equal(typeof dictionaries.en[key], 'string', `en.json: нет ключа ${key}`)
  }
  assert.deepEqual(Object.keys(dictionaries.ru).sort(), Object.keys(dictionaries.en).sort())
  assert.equal(dictionaries.ru['tone.gentle'], 'ласково')
  assert.equal(dictionaries.ru['tone.neutral'], 'нейтрально')
  assert.equal(dictionaries.ru['tone.strict'], 'строго')
})

test('static: сервер отдаёт браузеру новый модуль panel.mjs', async (t) => {
  const ctx = await createHarness(t)
  const module = await call(ctx.base, '/panel.mjs')
  assert.equal(module.status, 200)
  assert.match(module.contentType, /^text\/javascript/)
  assert.ok(module.text.includes('reminderPayload'))
  assert.ok(module.text.includes('eveningSettingsPayload'))
})
