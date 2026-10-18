/**
 * PLB-023: P2-1 продуктового ревью 18.10.
 *
 * Проактивность проверяется на настоящих ProactiveStore/ProactiveService:
 * два получателя, пустой обзор первого, личный mute, общий объект и миграция
 * старого общего состояния. Telegram, сети и production не нужны.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ProactiveService,
  ProactiveStore,
  dayKeyInZone,
  principalKey,
} from '../src/proactive.mjs'
import { zonedTimeToUtc } from '../src/domain/reminders.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'
const localDay = dayKeyInZone(new Date(), ZONE)
/** Рабочий момент «сегодня 10:00»; все сроки считаются от него. */
const NOW = zonedTimeToUtc(`${localDay}T10:00`, ZONE)
const DAY_MS = 86_400_000

const A = { channel: 'telegram', userId: 1, chatId: 1 }
const B = { channel: 'telegram', userId: 2, chatId: 2 }
const A_KEY = principalKey('telegram', 1)
const B_KEY = principalKey('telegram', 2)

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-plb023-'))
  return {
    dir,
    file: path.join(dir, 'proactive.json'),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

/** Хранилище с обзором в 00:05 или в конце дня, если нужны инициативы. */
async function makeStore(file, overrides = {}) {
  const store = new ProactiveStore({
    file,
    logger: silent,
    timeZone: ZONE,
    quiet: null,
    reviewAt: '00:05',
    dayLimit: 3,
    owner: A,
    ...overrides,
  })
  await store.load()
  return store
}

/** Сервис с подставными источниками и записью доставок. */
function makeService(store, {
  reminders = [],
  events = [],
  tasks = [],
  access,
  targets = [A, B],
  enabled = true,
  now = NOW,
} = {}) {
  const deliveries = []
  const service = new ProactiveService({
    store,
    sources: {
      reminders: { list: () => reminders },
      events: { list: () => events },
      tasks: async () => tasks,
    },
    targets,
    access,
    logger: silent,
    enabled,
    intervalMs: 0,
    now: () => now,
    deliver: async (chatId, text, keyboard) => deliveries.push({ chatId, text, keyboard }),
  })
  return { service, deliveries }
}

/** Напоминание на сегодня для конкретного человека. */
const reminder = (id, userId, text) => ({
  id,
  userId,
  chatId: userId,
  text,
  dueAt: zonedTimeToUtc(`${localDay}T18:00`, ZONE).toISOString(),
  repeat: 'none',
})

/** Поручение в форме моста агента. */
const task = (id, status, userId, title) => ({
  taskId: id,
  status,
  userId,
  title: title ?? `Задача ${id}`,
  updatedAt: NOW.toISOString(),
})

/** Доступ «только своё»: чужие личные записи не видны. */
const ownOnly = { canRead: (userId, record) => String(record?.userId) === String(userId) }

test('проверка 1: два пользователя с личными напоминаниями получают каждый свой обзор', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, {
      reminders: [reminder('r1', 1, 'Звонок A'), reminder('r2', 2, 'Звонок B')],
      access: ownOnly,
    })
    await service.tick({ now: NOW, force: true })

    assert.equal(deliveries.length, 2, 'обзор получили оба')
    const toA = deliveries.find((delivery) => delivery.chatId === 1)
    const toB = deliveries.find((delivery) => delivery.chatId === 2)
    assert.ok(toA && toB, 'каждому на его chatId')
    assert.match(toA.text, /Звонок A/)
    assert.doesNotMatch(toA.text, /Звонок B/, 'обзор A не показывает чужое')
    assert.match(toB.text, /Звонок B/)
    assert.doesNotMatch(toB.text, /Звонок A/, 'обзор B не показывает чужое')
    // Watermark обзора у каждого свой, но оба уже отмечены.
    assert.equal(store.watermarkFor(A_KEY).reviewDay, localDay)
    assert.equal(store.watermarkFor(B_KEY).reviewDay, localDay)
    assert.equal(store.sentToday(NOW, A_KEY).reviews, 1)
    assert.equal(store.sentToday(NOW, B_KEY).reviews, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('проверка 2: пустой обзор A не подавляет обзор B', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    const { service, deliveries } = makeService(store, {
      reminders: [reminder('r2', 2, 'Звонок B')],
      access: ownOnly,
    })
    const decisions = await service.tick({ now: NOW, force: true })

    assert.equal(deliveries.length, 1, 'ушёл только непустой обзор B')
    assert.equal(deliveries[0].chatId, 2)
    assert.match(deliveries[0].text, /Звонок B/)
    assert.ok(
      decisions.some((decision) => decision.principal === A_KEY && /обзор пуст/.test(decision.reason)),
      'решение A записано отдельно',
    )
    assert.ok(
      decisions.some((decision) => decision.principal === B_KEY && decision.kind === 'sent'),
      'решение B записано отдельно',
    )
    assert.ok(
      store.journal.some((entry) => entry.principal === A_KEY && /обзор пуст/.test(entry.reason)),
      'пропуск A в журнале',
    )
    assert.ok(
      store.journal.some((entry) => entry.principal === B_KEY && entry.kind === 'sent'),
      'отправка B в журнале',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('проверка 3: mute task у A не отключает task у B', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file, { reviewAt: '23:59' })
    await store.mute('task', A_KEY)
    assert.equal(store.settingsFor(A_KEY).categories.task, false)
    assert.equal(store.settingsFor(A_KEY).mute.task, true)
    assert.equal(store.settingsFor(B_KEY).categories.task, true, 'у B категория осталась')
    assert.equal(store.settingsFor(B_KEY).mute.task, undefined, 'у B нет mute')

    const { service, deliveries } = makeService(store, {
      tasks: [task('a', 'completed', 1, 'Задача A'), task('b', 'completed', 2, 'Задача B')],
      access: ownOnly,
    })
    const decisions = await service.tick({ now: NOW, force: true })

    assert.equal(deliveries.length, 1, 'A не получил, B получил')
    assert.equal(deliveries[0].chatId, 2)
    assert.match(deliveries[0].text, /Задача B/)
    assert.ok(
      decisions.some((decision) => decision.principal === A_KEY && decision.kind === 'muted' && decision.type === 'task'),
      'у A решение muted',
    )
    assert.equal(store.sentToday(NOW, A_KEY).count, 0)
    assert.equal(store.sentToday(NOW, B_KEY).count, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('проверка 4: общий перенос встречи — по одному уведомлению каждому, повтор не дублирует', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file, { reviewAt: '23:59' })
    const oldAt = new Date(NOW.getTime() + 30 * 60_000)
    const newAt = new Date(NOW.getTime() + 90 * 60_000)
    const seed = {
      key: 'event:1',
      type: 'event',
      title: 'Созвон',
      plannedAt: oldAt.toISOString(),
      expiresAt: new Date(newAt.getTime() + 2 * 60 * 60_000).toISOString(),
      priority: 70,
      reason: 'перенос времени',
      source: 'календарь',
      change: 'moved',
      userId: 1,
      chatId: 1,
    }
    // Оба уже знают о встрече по старому времени; объект один, доставки разные.
    assert.equal((await store.claim(seed, { now: NOW, principal: A_KEY })).ok, true)
    await store.setState('event:1', 'planned', { now: NOW, principal: A_KEY })
    assert.equal((await store.claim(seed, { now: NOW, principal: B_KEY })).ok, true)
    await store.setState('event:1', 'planned', { now: NOW, principal: B_KEY })
    const shared = store.state.users[A_KEY].items['event:1']
    assert.deepEqual(Object.keys(shared.deliveries).sort(), [A_KEY, B_KEY].sort(), 'один объект, две доставки')

    const { service, deliveries } = makeService(store, {
      events: [{ id: '1', title: 'Созвон', nextAt: newAt.toISOString(), userId: 1, chatId: 1 }],
    })
    await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 2, 'по одному уведомлению каждому')
    assert.equal(deliveries.filter((delivery) => delivery.chatId === 1).length, 1)
    assert.equal(deliveries.filter((delivery) => delivery.chatId === 2).length, 1)
    assert.ok(deliveries.every((delivery) => /Встреча перенесена/.test(delivery.text)))
    const delivered = store.state.users[A_KEY].items['event:1'].deliveries
    assert.equal(delivered[A_KEY].state, 'sent')
    assert.equal(delivered[B_KEY].state, 'sent')

    await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(deliveries.length, 2, 'повторная обработка не дублирует ни одному')
    // «Почему это пришло» у каждого человека своё, хотя объект общий.
    assert.match(service.explainLast(1), /Встреча перенесена/)
    assert.match(service.explainLast(2), /Встреча перенесена/)
    // Кнопка B меняет только доставку B, объект и доставка A не трогаются.
    const action = await service.handleAction({ action: 'done', key: 'event:1', userId: 2, now: NOW })
    assert.equal(action.toast, 'Отмечено выполненным')
    const afterAction = store.state.users[A_KEY].items['event:1'].deliveries
    assert.equal(afterAction[A_KEY].state, 'sent')
    assert.equal(afterAction[B_KEY].state, 'done')
  } finally {
    await ctx.cleanup()
  }
})

test('проверка 5: миграция общих значений владельцу, копия одна, повтор ничего не меняет', async () => {
  const ctx = await sandbox()
  try {
    const oldItem = {
      key: 'task:old',
      type: 'task',
      title: 'Старое поручение',
      plannedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
      state: 'planned',
      attempts: 0,
      priority: 90,
      reason: 'поручение завершено',
      source: 'поручение old',
      userId: 1,
      chatId: 1,
    }
    const oldJournal = [{ at: NOW.toISOString(), kind: 'sent', key: 'task:old', reason: 'старое решение', userId: 1 }]
    await fs.writeFile(ctx.file, JSON.stringify({
      version: 1,
      settings: { tz: ZONE, reviewAt: '08:00', quiet: null, dayLimit: 2 },
      sentToday: { date: localDay, count: 2, reviews: 0 },
      watermark: { at: NOW.toISOString(), reviewDay: localDay },
      items: [oldItem],
      journal: oldJournal,
    }))

    const store = await makeStore(ctx.file, { reviewAt: '23:59' })
    const owner = store.state.users[A_KEY]
    assert.ok(owner, 'владелец получил состояние')
    assert.equal(owner.settings.reviewAt, '08:00', 'настройки владельца сохранены')
    assert.equal(owner.settings.dayLimit, 2)
    assert.equal(owner.sentToday.count, 2, 'счётчик владельца сохранён')
    assert.equal(owner.watermark.reviewDay, localDay, 'watermark владельца сохранён')
    assert.equal(owner.items['task:old'].deliveries[A_KEY].state, 'planned', 'объект стал доставкой владельца')

    // Новый получатель стартует с defaults из конфигурации, а не с чужих значений.
    const bSettings = store.settingsFor(B_KEY)
    assert.equal(bSettings.reviewAt, '23:59')
    assert.equal(bSettings.dayLimit, 3)
    assert.equal(bSettings.enabled, true)

    const copies = (await fs.readdir(ctx.dir)).filter((name) => name.includes('.bak-'))
    assert.equal(copies.length, 1, 'копия до миграции ровно одна')
    const backup = JSON.parse(await fs.readFile(path.join(ctx.dir, copies[0]), 'utf8'))
    assert.equal(backup.version, 1, 'в копии старое содержимое')
    assert.ok(backup.settings, 'копия сделана до переписывания схемы')

    const afterFirst = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(afterFirst.version, 2)
    assert.ok(afterFirst.users[A_KEY])

    // Повторный запуск: ни новой копии, ни изменений в файле.
    await makeStore(ctx.file)
    const afterSecond = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.deepEqual(afterSecond, afterFirst, 'повторный запуск ничего не меняет')
    const copiesAgain = (await fs.readdir(ctx.dir)).filter((name) => name.includes('.bak-'))
    assert.equal(copiesAgain.length, 1, 'копия не дублируется')
  } finally {
    await ctx.cleanup()
  }
})

test('проверка 6: личное отключение не выключает другого, общий флаг остаётся выше', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(ctx.file)
    await store.setEnabled(false, A_KEY)
    assert.equal(store.settingsFor(A_KEY).enabled, false)
    assert.equal(store.settingsFor(B_KEY).enabled, true)

    const { service, deliveries } = makeService(store, {
      reminders: [reminder('r1', 1, 'Звонок A'), reminder('r2', 2, 'Звонок B')],
      access: ownOnly,
    })
    const decisions = await service.tick({ now: NOW, force: true })
    assert.equal(deliveries.length, 1, 'A выключил себя, B получил обзор')
    assert.equal(deliveries[0].chatId, 2)
    assert.ok(
      decisions.some((decision) => decision.principal === A_KEY && /выключена в настройках/.test(decision.reason)),
      'у A записана причина пропуска',
    )
    assert.equal(store.watermarkFor(A_KEY).reviewDay, null, 'день A не помечен: включение вернёт обзор')

    // Включили обратно в тот же день — обзор A ещё возможен.
    await store.setEnabled(true, A_KEY)
    await service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(deliveries.length, 2, 'после личного включения A снова получает')
    const toA = deliveries.filter((delivery) => delivery.chatId === 1)
    assert.equal(toA.length, 1)
    assert.match(toA[0].text, /Звонок A/)

    // Общий флаг ниже личных настроек: при enabled=false сервис только журналирует.
    const dryStore = await makeStore(path.join(ctx.dir, 'dry.json'))
    const dry = makeService(dryStore, {
      reminders: [reminder('r3', 1, 'Звонок A2'), reminder('r4', 2, 'Звонок B2')],
      access: ownOnly,
      enabled: false,
    })
    await dry.service.tick({ now: NOW, force: true })
    assert.equal(dry.deliveries.length, 0, 'общий флаг не даёт доставлять никому')
    assert.ok(dryStore.journal.some((entry) => entry.kind === 'dry-run' && entry.principal === A_KEY))
    assert.ok(dryStore.journal.some((entry) => entry.kind === 'dry-run' && entry.principal === B_KEY))
  } finally {
    await ctx.cleanup()
  }
})
