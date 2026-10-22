/**
 * PLB-028: интервальные напоминания, вечерний чек-ин и тон напоминания.
 *
 * Время везде подставное: у хранилища, планировщика и сервиса проактивности свои
 * `now`, поэтому «каждые два часа» и «в 21:00» проверяются без ожидания и без
 * зависимости от часов машины.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ReminderScheduler, ReminderStore } from '../src/reminders.mjs'
import { TONE_VALUES, reminderDeliveryText, reminderListRepeat, rulesOfReminders, snoozeRepeatNote, zonedTimeToUtc } from '../src/domain/reminders.mjs'
import { REMIND_TOOL_DEFINITION, createReminderTool } from '../src/tools/reminder-tool.mjs'
import { createConversation } from '../src/core/conversation.mjs'
import {
  ProactiveService,
  ProactiveStore,
  EVENING_SUPPRESS_MS,
  dayKeyInZone,
  eveningCheckInInstant,
  principalKey,
} from '../src/proactive.mjs'
import {
  eveningCheckInConfirmation,
  eveningCheckInText,
  parseEveningCheckInCommand,
  parseEveningCheckInRequest,
} from '../src/domain/evening.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'
const MINUTE = 60_000
const DAY = 86_400_000

/** Временный каталог: файлы напоминаний и проактивности не пересекаются. */
async function sandbox(prefix = 'tg-plb028-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    dir,
    reminderFile: path.join(dir, 'reminders.json'),
    proactiveFile: path.join(dir, 'proactive.json'),
    cleanup: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  }
}

/** Хранилище напоминаний на временном файле. */
async function makeReminderStore(file) {
  const store = new ReminderStore({ file, logger: silent })
  await store.load()
  return store
}

/** Хранилище проактивности с отключёнными тихими часами и поздним обзором. */
async function makeProactiveStore(file, owner) {
  const store = new ProactiveStore({
    file,
    logger: silent,
    timeZone: ZONE,
    quiet: null,
    reviewAt: '00:05',
    dayLimit: 3,
    owner,
  })
  await store.load()
  return store
}

/** Сервис с подставным источником «когда человек писал» и записью доставок. */
function makeService(store, { targets, lastUserActivity, enabled = true, now }) {
  const deliveries = []
  const service = new ProactiveService({
    store,
    sources: {
      lastUserActivity,
    },
    targets,
    logger: silent,
    enabled,
    intervalMs: 0,
    now: () => now,
    deliver: async (chatId, text, keyboard) => { deliveries.push({ chatId, text, keyboard }) },
  })
  return { service, deliveries }
}

const A = { channel: 'telegram', userId: 1, chatId: 1 }
const B = { channel: 'telegram', userId: 2, chatId: 2 }
const A_KEY = principalKey('telegram', 1)
const B_KEY = principalKey('telegram', 2)

test('every:120 создаётся и переносится ровно на два часа; интервал меньше 15 минут объясняется', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeReminderStore(ctx.reminderFile)
    const reference = new Date('2026-10-06T09:00:00.000Z')
    const rules = rulesOfReminders({ store, timeZone: ZONE, now: () => reference })

    const created = await rules.create({ text: 'пить воду', in_minutes: 120, repeat: 'every:120' }, { chatId: A.chatId, userId: A.userId })
    assert.equal(created.reminder.repeat, 'every:120')
    assert.equal(store.list(A.chatId).length, 1)
    assert.equal(created.reminder.dueAt, new Date(reference.getTime() + 120 * MINUTE).toISOString())
    assert.equal(reminderListRepeat('every:120'), ', каждые 120 минут', 'в списке интервал не выглядит недельным')
    assert.equal(snoozeRepeatNote('every:120'), ' (дальше — каждые 120 минут)')
    assert.equal(reminderListRepeat('daily'), ', каждый день', 'прежняя подпись не изменилась')

    // Два часа от исходного срока, а не от момента тика.
    const first = store.advance(created.reminder.id, new Date('2026-10-06T11:00:00.000Z').getTime())
    assert.equal(first.dueAt, '2026-10-06T13:00:00.000Z')

    // То же `now` второй раз не сдвигает сетку ещё на интервал.
    const second = store.advance(created.reminder.id, new Date('2026-10-06T11:00:00.000Z').getTime())
    assert.equal(second.dueAt, '2026-10-06T13:00:00.000Z')

    // Невалидный интервал: объяснение и никакой молчаливой подмены.
    const before = store.list(A.chatId).length
    for (const [repeat, expected] of [
      ['every:10', /минимальный интервал — 15 минут/],
      ['every:17', /кратно 5/],
      ['every:2000', /максимальный интервал — 1440 минут/],
    ]) {
      const refused = await rules.create({ text: 'слишком часто', in_minutes: 30, repeat }, { chatId: A.chatId, userId: A.userId })
      assert.match(refused.text, expected, repeat)
      assert.doesNotMatch(refused.text, /недопустимый повтор/, `${repeat} должно объясняться точнее общего текста`)
    }
    assert.equal(store.list(A.chatId).length, before, 'отказанные интервалы ничего не создали')
  } finally {
    await ctx.cleanup()
  }
})

test('рестарт не дублирует интервальное напоминание: состояние на диске и тот же тик', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeReminderStore(ctx.reminderFile)
    const delivered = []
    const at = Date.parse('2026-10-06T11:00:00.000Z')
    const reminder = store.add({ chatId: A.chatId, text: 'вода', dueAt: '2026-10-06T09:00:00.000Z', repeat: 'every:120' })
    const scheduler = new ReminderScheduler({
      store,
      logger: silent,
      now: () => at,
      deliver: async (item) => { delivered.push(item.text) },
    })

    assert.equal(await scheduler.tick(), 1)
    assert.equal(reminder.dueAt, '2026-10-06T13:00:00.000Z')
    assert.equal(await scheduler.tick(), 0, 'повторный тик не доставляет перенесённое')
    await store.flush()

    // Перезапуск: новый экземпляр читает тот же файл и видит будущий срок.
    const reopened = await makeReminderStore(ctx.reminderFile)
    assert.equal(reopened.list(A.chatId)[0].dueAt, '2026-10-06T13:00:00.000Z')
    const restarted = new ReminderScheduler({
      store: reopened,
      logger: silent,
      now: () => at,
      deliver: async (item) => { delivered.push(item.text) },
    })
    assert.equal(await restarted.tick(), 0, 'после рестарта на том же моменте дубля нет')
    assert.deepEqual(delivered, ['вода'])

    // Следующее срабатывание — ровно на исходной сетке.
    const next = new ReminderScheduler({
      store: reopened,
      logger: silent,
      now: () => Date.parse('2026-10-06T13:00:00.000Z'),
      deliver: async (item) => { delivered.push(item.text) },
    })
    assert.equal(await next.tick(), 1)
    assert.equal(reopened.list(A.chatId)[0].dueAt, '2026-10-06T15:00:00.000Z')
    assert.deepEqual(delivered, ['вода', 'вода'])
  } finally {
    await ctx.cleanup()
  }
})

test('тон меняет только текст доставки, но не время, повтор и запись у двух людей', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeReminderStore(ctx.reminderFile)
    const due = '2026-10-07T06:00:00.000Z'
    const gentle = store.add({ chatId: 1, userId: 1, text: 'выпить таблетки', dueAt: due, repeat: 'daily', tone: 'gentle' })
    const strict = store.add({ chatId: 2, userId: 2, text: 'выпить таблетки', dueAt: due, repeat: 'daily', tone: 'strict' })
    const neutral = store.add({ chatId: 3, userId: 3, text: 'выпить таблетки', dueAt: due, repeat: 'daily' })

    assert.deepEqual(TONE_VALUES, ['gentle', 'neutral', 'strict'])
    assert.equal(reminderDeliveryText(neutral), '⏰ Напоминание: выпить таблетки')
    assert.match(reminderDeliveryText(gentle), /^🌿 Мягко напоминаю: выпить таблетки$/)
    assert.match(reminderDeliveryText(strict), /^⏰ Строго напоминаю: выпить таблетки$/)
    assert.notEqual(reminderDeliveryText(gentle), reminderDeliveryText(strict))

    // Тон не меняет ни срок, ни повтор: advance двигает только dueAt.
    store.advance(gentle.id, Date.parse('2026-10-07T06:00:00.000Z'))
    assert.equal(gentle.repeat, 'daily')
    assert.equal(gentle.tone, 'gentle')
    assert.equal(gentle.dueAt, '2026-10-08T06:00:00.000Z')
    // Настройки двух людей независимы: у каждого свой тон в своей записи.
    assert.equal(gentle.tone, 'gentle')
    assert.equal(strict.tone, 'strict')
    assert.equal(store.list(1, 1)[0].id, gentle.id)
    assert.equal(store.list(2, 2)[0].id, strict.id)
  } finally {
    await ctx.cleanup()
  }
})

test('инструмент remind принимает tone и отдаёт его в доставку', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeReminderStore(ctx.reminderFile)
    const tool = createReminderTool({ store, timeZone: ZONE, now: () => new Date('2026-10-06T00:00:00.000Z') })
    const schema = REMIND_TOOL_DEFINITION.function.parameters.properties
    assert.deepEqual(schema.tone.enum, TONE_VALUES)
    assert.match(REMIND_TOOL_DEFINITION.function.description, /tone=gentle/)
    assert.match(schema.repeat.description, /every:120/)

    const output = await tool.execute({ text: 'выпить таблетки', at: '2026-10-07T09:00', tone: 'gentle' }, { chatId: 1, userId: 1 })
    assert.match(output, /создано/)
    const [reminder] = store.list(1, 1)
    assert.equal(reminder.tone, 'gentle')
    assert.match(reminderDeliveryText(reminder), /^🌿 Мягко напоминаю: выпить таблетки$/)
  } finally {
    await ctx.cleanup()
  }
})

test('вечерний вопрос: один раз в день и не приходит, если человек только что писал', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeProactiveStore(ctx.proactiveFile, A)
    const settings = await store.setEveningCheckIn({ enabled: true, at: '21:00', tone: 'gentle' }, A_KEY)
    assert.deepEqual(settings.eveningCheckIn, { enabled: true, at: '21:00', tone: 'gentle' })

    const at = zonedTimeToUtc('2026-10-06T21:00', ZONE)
    const day = dayKeyInZone(at, ZONE)
    const last = at.getTime() - 5 * MINUTE
    let { service, deliveries } = makeService(store, {
      targets: [A],
      lastUserActivity: () => last,
      now: at,
    })

    const skipped = await service.tick({ now: at, force: true })
    assert.equal(deliveries.length, 0, 'при недавнем сообщении вопрос не приходит')
    assert.ok(skipped.some((decision) => decision.type === 'checkin' && /2 часа/.test(decision.reason)))
    assert.equal(store.watermarkFor(A_KEY).eveningDay, day, 'день закрыт, повторной попытки нет')
    assert.equal(await service.tick({ now: at, force: true }).then(() => deliveries.length), 0)

    // На следующий день при старом последнем сообщении вопрос приходит один раз.
    const tomorrow = new Date(at.getTime() + DAY)
    const nextDayLast = at.getTime() - EVENING_SUPPRESS_MS - MINUTE
    const restarted = makeService(store, {
      targets: [A],
      lastUserActivity: () => nextDayLast,
      now: tomorrow,
    })
    service = restarted.service
    deliveries = restarted.deliveries
    const sent = await service.tick({ now: tomorrow, force: true })
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].chatId, A.chatId)
    assert.match(deliveries[0].text, /Как прошёл день\?/)
    assert.ok(sent.some((decision) => decision.type === 'checkin' && decision.kind === 'sent'))

    await service.tick({ now: tomorrow, force: true })
    assert.equal(deliveries.length, 1, 'в тот же день второго вопроса нет')
    assert.equal(store.sentToday(tomorrow, A_KEY).count, 0, 'вечерний вопрос не тратит дневной бюджет')
  } finally {
    await ctx.cleanup()
  }
})

test('у двух людей свои вечерние настройки и свой тон', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeProactiveStore(ctx.proactiveFile, A)
    await store.setEveningCheckIn({ enabled: true, at: '21:00', tone: 'gentle' }, A_KEY)
    await store.setEveningCheckIn({ enabled: true, at: '21:00', tone: 'strict' }, B_KEY)
    assert.equal(store.settingsFor(A_KEY).eveningCheckIn.tone, 'gentle')
    assert.equal(store.settingsFor(B_KEY).eveningCheckIn.tone, 'strict')

    const at = zonedTimeToUtc('2026-10-06T21:30', ZONE)
    const { service, deliveries } = makeService(store, {
      targets: [A, B],
      lastUserActivity: () => undefined,
      now: at,
    })
    await service.tick({ now: at, force: true })

    assert.equal(deliveries.length, 2, 'каждому свой вопрос')
    const toA = deliveries.find((item) => item.chatId === A.chatId)
    const toB = deliveries.find((item) => item.chatId === B.chatId)
    assert.ok(toA && toB)
    assert.match(toA.text, /расскажи, я рядом/)
    assert.match(toB.text, /Ответь, пожалуйста/)
    assert.doesNotMatch(toA.text, /Ответь, пожалуйста/)
    assert.equal(store.settingsFor(A_KEY).eveningCheckIn.tone, 'gentle')
    assert.equal(store.settingsFor(B_KEY).eveningCheckIn.tone, 'strict')
  } finally {
    await ctx.cleanup()
  }
})

test('вечерний вопрос идёт через существующий планировщик, второго таймера нет', async () => {
  const ctx = await sandbox()
  try {
    const proactiveStore = await makeProactiveStore(ctx.proactiveFile, A)
    await proactiveStore.setEveningCheckIn({ enabled: true, at: '21:00', tone: 'neutral' }, A_KEY)
    const at = zonedTimeToUtc('2026-10-06T21:00', ZONE)
    const { service, deliveries } = makeService(proactiveStore, {
      targets: [A],
      lastUserActivity: () => undefined,
      now: at,
    })
    const reminderStore = await makeReminderStore(ctx.reminderFile)
    let extraTicks = 0
    const scheduler = new ReminderScheduler({
      store: reminderStore,
      logger: silent,
      now: () => at.getTime(),
      deliver: async () => {},
      onTick: async ({ now }) => {
        extraTicks++
        await service.tick({ now: new Date(now), force: true })
      },
    })

    await scheduler.tick()
    assert.equal(extraTicks, 1, 'сервис вызван на том же тике')
    assert.equal(deliveries.length, 1)
    assert.match(deliveries[0].text, /Как прошёл день\?/)
    assert.equal(scheduler.timer, undefined, 'второго таймера никто не завёл')
  } finally {
    await ctx.cleanup()
  }
})

test('фраза «спрашивай вечером…» доходит до настройки без вызова модели', async () => {
  const calls = []
  const sent = []
  const bot = {
    username: 'test_bot',
    logger: silent,
    lastUserAt: new Map(),
    config: {
      access: {
        allowedChatTypes: new Set(['private']),
        allowAllUsers: true,
        allowedUserIds: new Set(),
      },
    },
    isAllowed: () => true,
    send: async (chatId, text) => { sent.push({ chatId, text }) },
    proactive: {
      setEveningCheckIn: async (patch, target) => {
        calls.push({ patch, target })
        return { eveningCheckIn: { enabled: true, at: patch.at ?? '21:00', tone: patch.tone ?? 'neutral' } }
      },
    },
  }
  const conversation = createConversation(bot)
  await conversation.handleMessage({
    from: { id: 1 },
    chat: { id: 1, type: 'private' },
    text: 'спрашивай вечером, как прошёл день в 21:00',
    addressed: true,
  })

  assert.deepEqual(calls, [{ patch: { enabled: true, at: '21:00' }, target: { userId: 1 } }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Вечерний вопрос включён/)
  assert.match(sent[0].text, /21:00/)
  assert.ok(bot.lastUserAt.get('1') > 0, 'активность отмечена для подавления')
})

test('естественная фраза включает вечерний вопрос с временем и тоном; выключение понимается', () => {
  const parsed = parseEveningCheckInRequest('спрашивай вечером, как прошёл день в 21:00')
  assert.deepEqual(parsed, { patch: { enabled: true, at: '21:00' } })

  const gentle = parseEveningCheckInRequest('спрашивай вечером в 21:30 ласково')
  assert.deepEqual(gentle, { patch: { enabled: true, at: '21:30', tone: 'gentle' } })

  const strict = parseEveningCheckInRequest('включи вечерний чек-ин в 20:00 строго')
  assert.deepEqual(strict, { patch: { enabled: true, at: '20:00', tone: 'strict' } })

  assert.deepEqual(parseEveningCheckInRequest('не спрашивай вечером'), { patch: { enabled: false } })
  assert.equal(parseEveningCheckInRequest('Как включить вечерний чек-ин?'), undefined, 'вопрос — не команда')
  assert.equal(parseEveningCheckInRequest('напомни вечером в 21:00'), undefined, 'это напоминание, не чек-ин')
  assert.match(parseEveningCheckInRequest('спрашивай вечером в 25:00').error, /Не понял время/)

  assert.deepEqual(parseEveningCheckInCommand('21:00 ласково'), { patch: { enabled: true, at: '21:00', tone: 'gentle' } })
  assert.deepEqual(parseEveningCheckInCommand('выкл'), { patch: { enabled: false } })
  assert.match(parseEveningCheckInCommand('ерунда').error, /Примеры/)
})

test('текст вопроса и подтверждение используют выбранный тон', () => {
  assert.match(eveningCheckInText('gentle'), /рядом/)
  assert.equal(eveningCheckInText('neutral'), '🌙 Как прошёл день?')
  assert.match(eveningCheckInText('strict'), /Ответь, пожалуйста/)

  const enabled = eveningCheckInConfirmation({ eveningCheckIn: { enabled: true, at: '21:00', tone: 'gentle' } })
  assert.match(enabled, /21:00/)
  assert.match(enabled, /ласковый/)
  const disabled = eveningCheckInConfirmation({ eveningCheckIn: { enabled: false, at: '21:00', tone: 'neutral' } })
  assert.match(disabled, /выключен/)
})

test('eveningCheckInInstant берёт местное время получателя, а не UTC', () => {
  const at = zonedTimeToUtc('2026-10-06T12:00', ZONE)
  const instant = eveningCheckInInstant(at, { tz: ZONE, eveningCheckIn: { enabled: true, at: '21:00', tone: 'neutral' } })
  assert.equal(instant.toISOString(), zonedTimeToUtc('2026-10-06T21:00', ZONE).toISOString())
})
