/**
 * PLB-027: защита истории от невалидного chatId, устойчивый поллинг и
 * команда `/proactive`.
 *
 * Сеть не нужна: поллинг получает подставной fetch, а проактивность —
 * временный файл состояния. Поэтому паузы, уведомления и настройки видны
 * сразу, без ожидания реальных секунд.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Assistant } from '../src/bot.mjs'
import { createCommandRouter } from '../src/core/commands.mjs'
import { HistoryStore } from '../src/history.mjs'
import { TelegramClient } from '../src/telegram.mjs'
import { loadConfig } from '../src/config.mjs'
import { ProactiveService, ProactiveStore, dayKeyInZone } from '../src/proactive.mjs'
import { testEnv, waitFor } from './helpers.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'

/** Временный каталог, который тест обязан убрать за собой. */
async function sandbox(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  }
}

test('PLB-027: невалидный chatId не попадает в историю и не создаёт ключ NaN', async () => {
  const box = await sandbox('tg-history-027-')
  const warnings = []
  const logger = { ...silentLogger, warn: (message) => warnings.push(message) }
  const file = path.join(box.dir, 'history.json')
  const store = new HistoryStore({ file, limit: 6, logger, saveDelayMs: 1 })
  await store.load()
  try {
    for (const chatId of [Number.NaN, undefined, 'abc']) {
      await store.append(chatId, { role: 'user', content: `мусор: ${String(chatId)}` })
    }
    assert.equal(store.size, 0, 'невалидные ключи не создают чат в памяти')
    assert.deepEqual(store.messages('NaN'), [])
    assert.deepEqual(store.messages('undefined'), [])
    assert.deepEqual(store.messages('abc'), [])
    assert.equal(store.voice(Number.NaN), false, 'чтение озвучки тоже не создаёт ключ')
    assert.equal(store.size, 0)
    assert.deepEqual(warnings, [
      'history write skipped: invalid chatId',
      'history write skipped: invalid chatId',
      'history write skipped: invalid chatId',
    ])

    await store.append(42, { role: 'user', content: 'настоящий чат' })
    assert.equal(store.size, 1, 'числовой chatId пишется как раньше')
    assert.deepEqual(store.messages(42).map((message) => message.content), ['настоящий чат'])

    await store.flush()
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(Object.keys(saved.chats), ['42'])
    assert.equal(saved.chats['42'].messages[0].content, 'настоящий чат')
  } finally {
    await store.flush()
    await box.cleanup()
  }
})

/** Бот с подставным fetch: первые `failuresBeforeSuccess` вызовов падают, дальше успех. */
async function pollingHarness({ failuresBeforeSuccess = 3 } = {}) {
  const box = await sandbox('tg-poll-027-')
  const pauses = []
  const sends = []
  let calls = 0
  const fetchImpl = async () => { throw new TypeError('fetch failed') }
  const client = new TelegramClient({
    token: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
    apiBase: 'http://127.0.0.1:9',
    fetchImpl,
    maxAttempts: 1,
    sleep: async () => {},
    logger: silentLogger,
  })
  const platform = {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 42, username: 'test_bot' },
    async start() { return this.identity },
    async stop() {},
    async getUpdates({ cursor } = {}) {
      calls += 1
      if (calls <= failuresBeforeSuccess) return client.getUpdates({ offset: cursor, timeoutSec: 1 })
      // Уступаем событийный цикл: иначе успешные повторы не дадут таймерам
      // теста выполниться и `waitFor` не увидит результат.
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { updates: [], cursor }
    },
    async sendText({ chatId, markdown }) {
      sends.push({ chatId, markdown })
      return { messageId: sends.length }
    },
    async sendTyping() {},
  }
  const config = loadConfig(testEnv({
    telegramApiBase: 'http://127.0.0.1:9',
    modelBaseUrl: 'http://127.0.0.1:9/v1',
    dataDir: box.dir,
  }))
  const history = new HistoryStore({ file: path.join(box.dir, 'history.json'), limit: 6, logger: silentLogger, saveDelayMs: 1 })
  await history.load()
  const bot = new Assistant({
    config,
    platform,
    model: { name: 'test-model' },
    history,
    logger: silentLogger,
    sleep: async (ms) => { pauses.push(ms) },
  })
  return {
    box,
    bot,
    pauses,
    sends,
    calls: () => calls,
    cleanup: async () => {
      await bot.stop()
      await box.cleanup()
    },
  }
}

test('PLB-027: серия обрывов даёт растущие паузы, один алерт и одно восстановление', async () => {
  // Пять ошибок подряд проверяют всю лестницу пауз, включая 15 и 30 секунд.
  const harness = await pollingHarness({ failuresBeforeSuccess: 5 })
  try {
    await harness.bot.start()
    await waitFor(
      () => harness.sends.length >= 2 && harness.calls() >= 8,
      { what: 'алерт об обрыве и сообщение о восстановлении', timeout: 5000 },
    )

    assert.deepEqual(harness.pauses.slice(0, 5), [1000, 2000, 5000, 15000, 30000], 'паузы 1→2→5→15→30 секунд')
    const alerts = harness.sends.filter((send) => /Нет связи/.test(send.markdown))
    const recovered = harness.sends.filter((send) => /Связь восстановлена/.test(send.markdown))
    assert.equal(alerts.length, 1, 'один алерт на серию, без спама')
    assert.equal(recovered.length, 1, 'одно сообщение о восстановлении')
    assert.equal(harness.sends.length, 2, 'после восстановления повторы молчат')
    for (const send of harness.sends) {
      assert.equal(send.chatId, 777, 'уведомление идёт в чат владельца из разрешённых')
    }
    assert.match(alerts[0].markdown, /3 ошибки getUpdates подряд/)
    assert.match(recovered[0].markdown, /снова отвечает/)
  } finally {
    await harness.cleanup()
  }
})

test('PLB-027: короткий сбой не беспокоит владельца и не шлёт «восстановлено»', async () => {
  const harness = await pollingHarness({ failuresBeforeSuccess: 1 })
  try {
    await harness.bot.start()
    await waitFor(
      () => harness.calls() >= 3 && harness.pauses.length >= 1,
      { what: 'первый успешный опрос после одной ошибки', timeout: 5000 },
    )
    assert.deepEqual(harness.pauses.slice(0, 1), [1000])
    assert.equal(harness.sends.length, 0, 'одиночная ошибка не повод для сообщений')
  } finally {
    await harness.cleanup()
  }
})

/** Хранилище и сервис проактивности на временном файле. */
async function proactiveHarness() {
  const box = await sandbox('tg-proactive-027-')
  const store = new ProactiveStore({
    file: path.join(box.dir, 'proactive.json'),
    logger: silentLogger,
    timeZone: ZONE,
    quiet: { start: 23 * 60, end: 8 * 60 },
    reviewAt: '09:00',
    owner: { channel: 'telegram', userId: 1 },
  })
  await store.load()
  const service = new ProactiveService({
    store,
    channel: 'telegram',
    enabled: true,
    now: () => new Date(),
    deliver: async () => {},
    logger: silentLogger,
  })
  const replies = []
  const bot = {
    proactive: service,
    platform: { name: 'telegram' },
    config: {},
    async send(chatId, text) { replies.push({ chatId, text }) },
  }
  const router = createCommandRouter(bot)
  const message = (userId) => ({ chat: { id: 1000 + userId, type: 'private' }, from: { id: userId } })
  return {
    box,
    store,
    service,
    replies,
    run: (args, userId = 1) => router.runCommand({ name: 'proactive', args }, message(userId)),
    cleanup: async () => {
      await store.flush()
      await box.cleanup()
    },
  }
}

test('PLB-027: /proactive показывает статус и не меняет настройки', async () => {
  const harness = await proactiveHarness()
  try {
    // Счётчики и отметку обзора кладём напрямую в состояние получателя:
    // команда должна их только прочитать.
    harness.service.settingsFor({ userId: 1 })
    const user = harness.store.state.users['telegram:1']
    const day = dayKeyInZone(new Date(), ZONE)
    user.sentToday = { date: day, count: 2, reviews: 1 }
    user.watermark.reviewDay = day
    const before = JSON.stringify(harness.store.state)

    await harness.run('')

    const reply = harness.replies.at(-1).text
    assert.match(reply, /Проактивность/)
    assert.match(reply, /Включена: \*\*да\*\*/)
    assert.match(reply, /Время обзора: \*\*09:00\*\*/)
    assert.match(reply, /Тихие часы: \*\*23:00–08:00\*\*/)
    assert.match(reply, /Отправлено сегодня: \*\*2\*\* \(обзоров: 1\)/)
    assert.match(reply, new RegExp(`reviewDay\\): \\*\\*${day}\\*\\*`))
    assert.equal(JSON.stringify(harness.store.state), before, 'статус ничего не записал')
  } finally {
    await harness.cleanup()
  }
})

test('PLB-027: выключение одного получателя не меняет второго', async () => {
  const harness = await proactiveHarness()
  try {
    await harness.service.setEnabled(true, { userId: 1 })
    await harness.service.setEnabled(true, { userId: 2 })

    await harness.run('выкл', 1)

    assert.equal(harness.service.settingsFor({ userId: 1 }).enabled, false)
    assert.equal(harness.service.settingsFor({ userId: 2 }).enabled, true, 'второй получатель не тронут')
    assert.match(harness.replies.at(-1).text, /выключена/)
  } finally {
    await harness.cleanup()
  }
})

test('PLB-027: /proactive обзор меняет время только своего получателя', async () => {
  const harness = await proactiveHarness()
  try {
    await harness.run('обзор 08:30', 1)

    assert.equal(harness.service.settingsFor({ userId: 1 }).reviewAt, '08:30')
    assert.equal(harness.service.settingsFor({ userId: 2 }).reviewAt, '09:00', 'у второго время прежнее')
    assert.match(harness.replies.at(-1).text, /\*\*08:30\*\*/)
  } finally {
    await harness.cleanup()
  }
})

test('PLB-027: /proactive тихие сохраняет окно и отвергает мусор', async () => {
  const harness = await proactiveHarness()
  try {
    await harness.run('тихие 22:15-07:05', 1)
    assert.deepEqual(harness.service.settingsFor({ userId: 1 }).quiet, { start: 22 * 60 + 15, end: 7 * 60 + 5 })
    assert.match(harness.replies.at(-1).text, /22:15–07:05/)

    await harness.run('тихие 25:00-07:00', 1)
    assert.deepEqual(harness.service.settingsFor({ userId: 1 }).quiet, { start: 22 * 60 + 15, end: 7 * 60 + 5 })
    assert.match(harness.replies.at(-1).text, /Не понял окно/)
  } finally {
    await harness.cleanup()
  }
})
