/**
 * PLB-020: полезная проактивность (BP-04).
 *
 * Тесты идут без Telegram и сети: домен получает часы, источники и доставку
 * параметрами. Поэтому тихие часы, DST, бюджет, дубли и два экземпляра
 * планировщика проверяются за миллисекунды, а не ожиданием таймера.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ProactiveService,
  ProactiveStore,
  buildReviewMessage,
  collectCandidates,
  dayKeyInZone,
  isQuietNow,
  localParts,
  localTimeToInstant,
  mergeCandidates,
  notificationText,
  proactiveKeyboard,
  reviewInstant,
} from '../src/proactive.mjs'
import { zonedTimeToUtc } from '../src/domain/reminders.mjs'
import { ReminderScheduler, ReminderStore } from '../src/reminders.mjs'
import { loadConfig } from '../src/config.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'
const DAY_MS = 86_400_000
const localDay = dayKeyInZone(new Date(), ZONE)
/** Рабочий момент «сегодня 10:00» по Москве: все относительные времена считаются от него. */
const NOW = zonedTimeToUtc(`${localDay}T10:00`, ZONE)

/** Временный каталог и файл состояния. */
async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-proactive-'))
  return {
    dir,
    file: path.join(dir, 'proactive.json'),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

/** Хранилище с настройками из теста. */
async function makeStore(file, overrides = {}) {
  const store = new ProactiveStore({
    file,
    logger: silent,
    timeZone: ZONE,
    quiet: { start: 23 * 60, end: 8 * 60 },
    reviewAt: '23:59',
    dayLimit: 3,
    owner: { userId: 7 },
    ...overrides,
  })
  await store.load()
  return store
}

/** Поручение в форме, которую отдаёт мост агента. */
const task = (id, status, { at = NOW, title, ...extra } = {}) => ({
  taskId: id,
  status,
  title: title ?? `Задача ${id}`,
  updatedAt: at.toISOString(),
  ...extra,
})

/** Сервис с подставными источниками и записью доставок. */
function makeService(store, {
  reminders = [],
  events = [],
  tasks = [],
  eventsError,
  tasksError,
  enabled = true,
  targets = [{ userId: 7, chatId: 7 }],
  deliver,
  now = NOW,
} = {}) {
  const deliveries = []
  const service = new ProactiveService({
    store,
    sources: {
      reminders: { list: () => reminders },
      ...(eventsError
        ? { events: { list: () => { throw eventsError } } }
        : { events: { list: () => events } }),
      tasks: async () => {
        if (tasksError) throw tasksError
        return typeof tasks === 'function' ? tasks() : tasks
      },
    },
    targets,
    deliver: deliver ?? (async (chatId, text, keyboard) => { deliveries.push({ chatId, text, keyboard }) }),
    logger: silent,
    enabled,
    intervalMs: 0,
    now: () => now,
  })
  return { service, deliveries }
}

/** Смещение UTC в миллисекундах для пояса в конкретный момент. */
function offsetMs(value, zone) {
  const parts = localParts(value, zone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  return asUtc - Math.floor(value.getTime() / 60_000) * 60_000
}

/** Ближайший переход летнего времени: сканируем часы вперёд от текущего момента. */
function nextDstTransition(zone, from = new Date(), direction = 'any') {
  let previous = offsetMs(from, zone)
  for (let index = 1; index <= 800 * 24; index++) {
    const sample = new Date(from.getTime() + index * 3_600_000)
    const current = offsetMs(sample, zone)
    if (current !== previous) {
      const forward = current > previous
      if (direction === 'any' || (direction === 'forward' && forward) || (direction === 'backward' && !forward)) {
        // Часовая сетка не знает минуту перехода: уточняем её делением пополам,
        // иначе «за 30 минут до» могло попасть уже после перехода.
        let low = sample.getTime() - 3_600_000
        let high = sample.getTime()
        while (high - low > 60_000) {
          const middle = Math.floor((low + high) / 2 / 60_000) * 60_000
          if (offsetMs(new Date(middle), zone) === previous) low = middle
          else high = middle
        }
        return { at: new Date(high), before: previous, after: current }
      }
    }
    previous = current
  }
  throw new Error(`no DST transition found for ${zone}`)
}

test('настройки проактивности по умолчанию: флаг выключен, обзор в 09:00, предел 3', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
    MODEL_API_KEY: 'sk-test',
    ALLOWED_USER_IDS: '7',
  })
  assert.equal(config.proactive.enabled, false, 'dry-run по умолчанию')
  assert.equal(config.proactive.reviewAt, '09:00')
  assert.equal(config.proactive.dayLimit, 3)
  assert.equal(config.proactive.checkIntervalMs, 60_000)
})

test('dry-run пишет решения в журнал и ничего не отправляет', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, { tasks: [task('1', 'completed')], enabled: false })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 0, 'в dry-run доставки нет')
    assert.equal(store.sentToday(NOW).count, 0, 'бюджет не расходуется')
    const dry = store.journal.find((entry) => entry.kind === 'dry-run')
    assert.ok(dry, 'решение записано в журнал')
    assert.equal(dry.dryRun, true)
    assert.equal(dry.key, 'task:1')
    assert.match(dry.text, /Почему: поручение завершено/)
    assert.match(dry.text, /Источник: поручение 1/)
    // Повторный тик не дублирует одно и то же решение в журнале.
    await service.tick({ now: NOW, force: true })
    assert.equal(store.journal.filter((entry) => entry.key === 'task:1').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('тихие часы: ночью не отправляется, утром — если ещё актуально', async () => {
  const ctx = await sandbox()
  try {
    const night = zonedTimeToUtc(`${localDay}T02:00`, ZONE)
    const morning = zonedTimeToUtc(`${localDay}T08:05`, ZONE)
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, { tasks: [task('1', 'completed', { at: night })] })
    const first = await service.tick({ now: night, force: true })
    assert.equal(deliveries.length, 0, 'в 02:00 не будим')
    assert.ok(first.some((decision) => decision.kind === 'deferred' && decision.reason === 'тихие часы'))
    await service.tick({ now: morning, force: true })
    assert.equal(deliveries.length, 1, 'после тихих часов уведомление доставлено')
    assert.match(deliveries[0].text, /Поручение выполнено/)
  } finally {
    await ctx.cleanup()
  }
})

test('переход летнего времени: местное время по IANA, обзор один раз за местные сутки', async () => {
  const ctx = await sandbox()
  try {
    // Пояс с переходом, а не фиксированным смещением.
    const zone = 'America/New_York'
    const transition = nextDstTransition(zone)
    const before = new Date(transition.at.getTime() - 30 * 60_000)
    const after = new Date(transition.at.getTime() + 30 * 60_000)
    const day = dayKeyInZone(before, zone)
    assert.equal(dayKeyInZone(after, zone), day, 'переход внутри одних местных суток')
    assert.notEqual(offsetMs(before, zone), offsetMs(after, zone), 'смещение пересчитано через Intl')
    // При откате назад местное время повторяется; Intl должен показать это,
    // а не фиксированное смещение.
    if (transition.after < transition.before) {
      assert.equal(localParts(before, zone).hour, localParts(after, zone).hour)
    }

    const eventAt = zonedTimeToUtc(`${day}T12:00`, zone)
    const store = await makeStore(ctx.file, { timeZone: zone, reviewAt: '00:05', quiet: null })
    const { service, deliveries } = makeService(store, {
      targets: [{ userId: 7, chatId: 7 }],
      events: [{ id: 'e1', title: 'Созвон', nextAt: eventAt.toISOString(), chatId: 7, userId: 7 }],
    })
    await service.tick({ now: before, force: true })
    assert.equal(deliveries.length, 1, 'обзор в день перехода отправлен')
    await service.tick({ now: after, force: true })
    assert.equal(deliveries.length, 1, 'второй раз за те же местные сутки обзора нет')
    assert.equal(store.watermark.reviewDay, day)
  } finally {
    await ctx.cleanup()
  }
})

test('два экземпляра планировщика дают одно логическое уведомление', async () => {
  const ctx = await sandbox()
  try {
    const storeA = await makeStore(ctx.file)
    const storeB = await makeStore(ctx.file)
    const deliveries = []
    const deliver = async (chatId, text, keyboard) => { deliveries.push({ chatId, text, keyboard }) }
    const sources = { tasks: [task('1', 'completed')] }
    const { service: first } = makeService(storeA, { ...sources, deliver })
    const { service: second } = makeService(storeB, { ...sources, deliver })
    await Promise.all([
      first.tick({ now: NOW, force: true }),
      second.tick({ now: NOW, force: true }),
    ])
    assert.equal(deliveries.length, 1, 'ключ события и транзакция не дают дубля')
    const fresh = await makeStore(ctx.file)
    assert.equal(fresh.itemOf('task:1').state, 'sent')
    assert.equal(fresh.sentToday(NOW).count, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('рестарт: просроченное по TTL не отправляется и старый обзор не повторяется', async () => {
  const ctx = await sandbox()
  try {
    const old = new Date(NOW.getTime() - 2 * DAY_MS)
    await fs.writeFile(ctx.file, JSON.stringify({
      version: 1,
      watermark: { at: old.toISOString(), reviewDay: dayKeyInZone(old, ZONE) },
      sentToday: { date: dayKeyInZone(old, ZONE), count: 3, reviews: 1 },
      items: [{
        key: 'task:9',
        type: 'task',
        title: 'Поручение выполнено: старое',
        plannedAt: old.toISOString(),
        expiresAt: old.toISOString(),
        state: 'planned',
        priority: 90,
        reason: 'поручение завершено',
        source: 'поручение 9',
        userId: 7,
        chatId: 7,
        attempts: 0,
      }],
      settings: { tz: ZONE, reviewAt: '23:59', quiet: { start: 23 * 60, end: 8 * 60 }, categories: { reminder: true, event: true, task: true, review: true }, dayLimit: 3 },
      journal: [],
    }))
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, {})
    const decisions = await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 0, 'пачки просроченного после простоя нет')
    assert.equal(store.itemOf('task:9').state, 'expired')
    assert.ok(decisions.some((decision) => decision.kind === 'expired'))
  } finally {
    await ctx.cleanup()
  }
})

test('после простоя приходит не больше одного актуального обзора', async () => {
  const ctx = await sandbox()
  try {
    const old = new Date(NOW.getTime() - 2 * DAY_MS)
    const eventAt = zonedTimeToUtc(`${localDay}T12:00`, ZONE)
    const store = await makeStore(ctx.file, { reviewAt: '00:05' })
    await store.skipReview(dayKeyInZone(old, ZONE), 'старый обзор', { now: old })
    const { service, deliveries } = makeService(store, {
      events: [{ id: 'e1', title: 'Созвон', nextAt: eventAt.toISOString(), chatId: 7, userId: 7 }],
    })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1, 'один актуальный обзор')
    await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(deliveries.length, 1, 'второй обзор за день не отправляется')
  } finally {
    await ctx.cleanup()
  }
})

test('отключённая категория не доставляется', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    await store.mute('task')
    const { service, deliveries } = makeService(store, { tasks: [task('1', 'completed')] })
    const decisions = await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 0)
    assert.ok(decisions.some((decision) => decision.kind === 'muted' && decision.type === 'task'))
  } finally {
    await ctx.cleanup()
  }
})

test('недоступный источник помечается, а не выдаётся за «встреч нет»', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file, { reviewAt: '00:05' })
    const { service, deliveries } = makeService(store, {
      eventsError: new Error('calendar down'),
      tasksError: new Error('agent down'),
    })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1, 'проблема источника значима для обзора')
    assert.match(deliveries[0].text, /недоступен/)
    assert.doesNotMatch(deliveries[0].text, /встреч нет|сегодня ничего/i)
    assert.match(deliveries[0].text, /Почему: обзор по расписанию/)
  } finally {
    await ctx.cleanup()
  }
})

test('одинаковые события объединяются по ключу', async () => {
  const merged = mergeCandidates([
    { key: 'task:1', type: 'task', title: 'A', plannedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(), priority: 60, reason: 'первая причина', source: '1', reviewOnly: false },
    { key: 'task:1', type: 'task', title: 'B', plannedAt: new Date(NOW.getTime() + 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(), priority: 90, reason: 'вторая причина', source: '1', reviewOnly: false },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].key, 'task:1')
  assert.equal(merged[0].priority, 90)
  assert.deepEqual(merged[0].reasons, ['первая причина', 'вторая причина'])

  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const duplicate = task('1', 'completed')
    const { service, deliveries } = makeService(store, { tasks: [duplicate, { ...duplicate }] })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1, 'одно логическое уведомление на ключ')
    assert.equal(store.items.filter((item) => item.key === 'task:1').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('пустой обзор не отправляется, пропуск фиксируется в журнале', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file, { reviewAt: '00:05' })
    const { service, deliveries } = makeService(store, {})
    const decisions = await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 0)
    assert.ok(decisions.some((decision) => decision.kind === 'skipped' && /обзор пуст/.test(decision.reason)))
    assert.equal(store.watermark.reviewDay, localDay)
    assert.ok(store.journal.some((entry) => entry.kind === 'skipped' && /обзор пуст/.test(entry.reason)))
    const second = await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(second.length, 0, 'второй раз в тот же день обзор не считается')
  } finally {
    await ctx.cleanup()
  }
})

test('дневной предел: три инициативных, четвёртое ждёт и уходит на следующий день', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const tasks = [task('1', 'completed'), task('2', 'completed'), task('3', 'completed'), task('4', 'completed')]
    const { service, deliveries } = makeService(store, { tasks })
    const decisions = await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 3)
    assert.ok(decisions.some((decision) => decision.kind === 'deferred' && /дневной предел/.test(decision.reason)))
    await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(deliveries.length, 3, 'в тот же день больше не отправляем')
    const tomorrow = new Date(NOW.getTime() + DAY_MS)
    await service.tick({ now: tomorrow, force: true })
    assert.equal(deliveries.length, 4, 'на следующий день бюджет снова доступен')
  } finally {
    await ctx.cleanup()
  }
})

test('неизменившийся статус — не новость, завершение и ошибка — новость', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, { tasks: [task('1', 'running')] })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 0, 'heartbeat не уведомляет')
    deliveries.length = 0
    const changed = makeService(store, { tasks: [task('1', 'completed')] })
    await changed.service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(changed.deliveries.length, 1)
    const failed = makeService(store, { tasks: [task('2', 'error')] })
    await failed.service.tick({ now: new Date(NOW.getTime() + 120_000), force: true })
    assert.equal(failed.deliveries.length, 1)
    assert.match(failed.deliveries[0].text, /Ошибка поручения/)
  } finally {
    await ctx.cleanup()
  }
})

test('отложенное перепроверяется: завершённая задача не напоминается', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, { tasks: [task('1', 'blocked')] })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1)
    const action = await service.handleAction({ action: 'snooze', key: 'task:1', userId: 7, now: NOW })
    assert.match(action.outcome, /Отложено/)
    assert.equal(store.itemOf('task:1').state, 'snoozed')
    const later = new Date(NOW.getTime() + 31 * 60_000)
    const { service: next, deliveries: after } = makeService(store, {
      tasks: [task('1', 'completed', { at: later })],
    })
    const decisions = await next.tick({ now: later, force: true })
    assert.equal(after.length, 0, 'завершённую задачу не напоминаем')
    assert.equal(store.itemOf('task:1').state, 'cancelled')
    assert.ok(decisions.some((decision) => decision.kind === 'cancelled' && /актуальности/.test(decision.reason)))
  } finally {
    await ctx.cleanup()
  }
})

test('кнопки открыть/выполнено/отложить/отключить и объяснение по запросу', async () => {
  const keyboard = proactiveKeyboard('task:1')
  const labels = keyboard.rows.flat().map((button) => button.text)
  assert.ok(labels.some((label) => /Открыть/.test(label)))
  assert.ok(labels.some((label) => /Выполнено/.test(label)))
  assert.ok(labels.some((label) => /Отложить/.test(label)))
  assert.ok(labels.some((label) => /Отключить этот тип/.test(label)))
  assert.ok(keyboard.rows.flat().every((button) => button.data.startsWith('pro:')))

  const text = notificationText({
    title: 'Поручение выполнено: отчёт',
    reason: 'поручение завершено',
    source: 'поручение 3',
  })
  assert.match(text, /Почему: поручение завершено/)
  assert.match(text, /Источник: поручение 3/)

  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, { tasks: [task('1', 'completed')] })
    await service.tick({ now: NOW, force: true })
    assert.match(deliveries[0].text, /Почему: поручение завершено/)
    assert.match(deliveries[0].text, /Источник: поручение 1/)
    const explanation = service.explainLast(7)
    assert.match(explanation, /поручение завершено/)
    assert.match(explanation, /поручение 1/)
    const action = await service.handleAction({ action: 'open', key: 'task:1', userId: 7, now: NOW })
    assert.match(action.outcome, /Почему:/)
    assert.equal(service.explainLast(8), 'Инициативных уведомлений пока не было — объяснять нечего.')
  } finally {
    await ctx.cleanup()
  }
})

test('обзор показывает не больше согласованного числа важных пунктов', () => {
  const events = Array.from({ length: 8 }, (_, index) => ({
    id: `e${index}`,
    title: `Встреча ${index}`,
    nextAt: zonedTimeToUtc(`${localDay}T${String(11 + index).padStart(2, '0')}:00`, ZONE).toISOString(),
    chatId: 7,
    userId: 7,
  }))
  const built = buildReviewMessage({
    now: NOW,
    settings: { tz: ZONE, reviewAt: '09:00', reviewMax: 3, categories: { reminder: true, event: true, task: true, review: true } },
    events,
  })
  assert.equal(built.empty, false)
  assert.equal(built.count, 3)
  assert.equal((built.text.match(/^— /gm) ?? []).length, 3)
})

test('напоминание в обзор попадает, но отдельным уведомлением не дублируется', async () => {
  const ctx = await sandbox()
  try {
    const due = zonedTimeToUtc(`${localDay}T18:00`, ZONE)
    const reminder = { id: '5', chatId: 7, userId: 7, text: 'Позвонить', dueAt: due.toISOString(), repeat: 'none' }
    const store = await makeStore(ctx.file, { reviewAt: '00:05' })
    const { service, deliveries } = makeService(store, { reminders: [reminder] })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1, 'одно сообщение — обзор')
    assert.match(deliveries[0].text, /Сроки/)
    assert.match(deliveries[0].text, /Позвонить/)
    assert.equal(store.itemOf('reminder:5'), undefined, 'отдельного события по напоминанию нет')
  } finally {
    await ctx.cleanup()
  }
})

test('миграция proactive.json: копия до изменения и идемпотентность', async () => {
  const ctx = await sandbox()
  try {
    await fs.writeFile(ctx.file, JSON.stringify({ version: 0, items: [] }))
    const store = await makeStore(ctx.file)
    const afterFirst = (await fs.readdir(ctx.dir)).filter((name) => name.includes('.bak-'))
    assert.equal(afterFirst.length, 1, 'копия старой схемы сделана')
    assert.equal(store.settings.tz, ZONE)
    const saved = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(saved.version, 2)
    assert.equal(saved.users['telegram:7'].settings.tz, ZONE)

    const again = await makeStore(ctx.file)
    const afterSecond = (await fs.readdir(ctx.dir)).filter((name) => name.includes('.bak-'))
    assert.equal(afterSecond.length, 1, 'повторный запуск копию не делает')
    assert.equal(again.settings.tz, ZONE)
  } finally {
    await ctx.cleanup()
  }
})

test('проактивность использует существующий таймер напоминаний, а не второй', async () => {
  const ctx = await sandbox()
  try {
    const store = new ReminderStore({ file: path.join(ctx.dir, 'reminders.json'), logger: silent })
    await store.load()
    let ticks = 0
    const scheduler = new ReminderScheduler({
      store,
      deliver: async () => {},
      logger: silent,
      intervalMs: 20_000,
      onTick: async () => { ticks++ },
    })
    await scheduler.tick()
    assert.equal(ticks, 1, 'дополнительная работа идёт внутри того же тика')
    scheduler.start()
    assert.ok(scheduler.timer, 'таймер один')
    await scheduler.stop()
  } finally {
    await ctx.cleanup()
  }
})

test('кандидат помнит источник и причину, а TTL отбрасывает старое', () => {
  const candidates = collectCandidates({
    now: NOW,
    reminders: [{ id: '1', chatId: 7, userId: 7, text: 'Старое', dueAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString() }],
    settings: { tz: ZONE },
  })
  assert.equal(candidates.length, 0, 'напоминание вне TTL в обзор не попадает')
  const quiet = isQuietNow(zonedTimeToUtc(`${localDay}T02:00`, ZONE), { tz: ZONE, quiet: { start: 23 * 60, end: 8 * 60 } })
  assert.equal(quiet, true)
  assert.equal(reviewInstant(NOW, { tz: ZONE, reviewAt: '09:00' }).getTime() < NOW.getTime(), true)
})

test('обзор не раскрывает записи чужого пространства', async () => {
  const ctx = await sandbox()
  try {
    const eventAt = zonedTimeToUtc(`${localDay}T12:00`, ZONE)
    const due = zonedTimeToUtc(`${localDay}T18:00`, ZONE)
    const access = {
      canRead: (userId, record) => String(record?.userId) === String(userId),
    }
    const store = await makeStore(ctx.file, { reviewAt: '00:05' })
    const { service, deliveries } = makeService(store, {
      events: [
        { id: 'mine', title: 'Моя встреча', nextAt: eventAt.toISOString(), chatId: 7, userId: 7 },
        { id: 'other', title: 'Чужая встреча', nextAt: eventAt.toISOString(), chatId: 8, userId: 8 },
      ],
      reminders: [
        { id: '1', chatId: 7, userId: 7, text: 'Мой срок', dueAt: due.toISOString(), repeat: 'none' },
        { id: '2', chatId: 8, userId: 8, text: 'Чужой срок', dueAt: due.toISOString(), repeat: 'none' },
      ],
    })
    // Подменяем проверку доступа после сборки: сервис держит ссылку на объект.
    service.access = access
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1)
    assert.match(deliveries[0].text, /Моя встреча/)
    assert.match(deliveries[0].text, /Мой срок/)
    assert.doesNotMatch(deliveries[0].text, /Чужая|Чужой/)
  } finally {
    await ctx.cleanup()
  }
})

test('недоступный календарь не отменяет уже известное событие', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const planned = new Date(NOW.getTime() + 60 * 60_000)
    const claim = await store.claim({
      key: 'event:1',
      type: 'event',
      title: 'Встреча',
      plannedAt: planned.toISOString(),
      expiresAt: new Date(planned.getTime() + 2 * 60 * 60_000).toISOString(),
      priority: 70,
      reason: 'перенос времени',
      source: 'календарь',
      change: 'moved',
      userId: 7,
      chatId: 7,
    }, { now: NOW })
    assert.equal(claim.ok, true)
    await store.snooze('event:1', { now: NOW, minutes: 30 })

    const { service } = makeService(store, { eventsError: new Error('calendar down') })
    await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(store.itemOf('event:1').state, 'snoozed', 'недоступность не равна отмене')
  } finally {
    await ctx.cleanup()
  }
})


test('весенний пропуск: несуществующее местное время не уводит обзор в прошлое', () => {
  const zone = 'America/New_York'
  const transition = nextDstTransition(zone, new Date(), 'forward')
  const day = dayKeyInZone(transition.at, zone)
  // 03:30 существует и должно остаться 03:30, а не сдвинуться на час.
  const afterGap = localTimeToInstant(`${day}T03:30`, zone)
  assert.deepEqual(localParts(afterGap, zone), { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)), hour: 3, minute: 30 })
  // 02:30 в этот день не существует: берём первый момент после пропуска.
  const missing = localTimeToInstant(`${day}T02:30`, zone)
  assert.equal(localParts(missing, zone).hour, 3)
  assert.equal(localTimeToInstant(`${day}T03:30`, zone).getTime(), afterGap.getTime())
})

test('обзор приходит с кнопками; отложенный обзор отправляется после срока', async () => {
  const ctx = await sandbox()
  try {
    const eventAt = zonedTimeToUtc(`${localDay}T12:00`, ZONE)
    const store = await makeStore(ctx.file, { reviewAt: '00:05', quiet: null })
    const { service, deliveries } = makeService(store, {
      events: [{ id: 'e1', title: 'Созвон', nextAt: eventAt.toISOString(), chatId: 7, userId: 7 }],
    })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1)
    assert.ok(deliveries[0].keyboard, 'у обзора есть кнопки')
    const labels = deliveries[0].keyboard.rows.flat().map((button) => button.text)
    assert.ok(labels.some((label) => /Отложить/.test(label)))
    const key = `review:${localDay}`
    const action = await service.handleAction({ action: 'snooze', key, userId: 7, now: NOW })
    assert.match(action.outcome, /Отложено/)
    assert.equal(store.watermark.reviewDay, null, 'перенос разрешает повторную отправку')
    await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(deliveries.length, 1, 'до срока повторного обзора нет')
    await service.tick({ now: new Date(NOW.getTime() + 31 * 60_000), force: true })
    assert.equal(deliveries.length, 2, 'после срока обзор отправлен снова')
  } finally {
    await ctx.cleanup()
  }
})

test('отложенная встреча возвращается в срок, а не выдаётся за перенос', async () => {
  const ctx = await sandbox()
  try {
    const when = new Date(NOW.getTime() + 60 * 60_000)
    const store = await makeStore(ctx.file)
    const claim = await store.claim({
      key: 'event:1',
      type: 'event',
      title: 'Созвон',
      plannedAt: when.toISOString(),
      expiresAt: new Date(when.getTime() + 2 * 60 * 60_000).toISOString(),
      priority: 70,
      reason: 'перенос времени с 09:00 на 11:00',
      source: 'календарь',
      change: 'moved',
      userId: 7,
      chatId: 7,
    }, { now: NOW })
    assert.equal(claim.ok, true)
    await store.snooze('event:1', { now: NOW, minutes: 30 })
    const { service, deliveries } = makeService(store, {
      events: [{ id: '1', title: 'Созвон', nextAt: when.toISOString(), chatId: 7, userId: 7 }],
    })
    await service.tick({ now: new Date(NOW.getTime() + 31 * 60_000), force: true })
    assert.equal(deliveries.length, 1)
    assert.match(deliveries[0].text, /Созвон/)
    assert.doesNotMatch(deliveries[0].text, /перенесена/)
    assert.equal(store.itemOf('event:1').state, 'sent')
  } finally {
    await ctx.cleanup()
  }
})
