/**
 * PLB-022: регрессии P1 из продуктового ревью 18.10.
 *
 * Проверяются три воспроизведения: чужая задача в уведомлениях, память в обход
 * прав области и замена личного факта записью из проекта. Тесты работают на
 * настоящих ProactiveService/ProactiveStore, ProfileStore, ScopeStore и access,
 * без Telegram, сети и production.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ProactiveService,
  ProactiveStore,
  TASK_ACCESS_DENIED_REASON,
  TASK_OWNER_UNKNOWN_REASON,
  collectCandidates,
  dayKeyInZone,
} from '../src/proactive.mjs'
import { zonedTimeToUtc } from '../src/domain/reminders.mjs'
import { ProfileStore } from '../src/profiles.mjs'
import { createMemory, MEMORY_WRITE_FORBIDDEN_TEXT } from '../src/memory.mjs'
import { rulesOfProfiles } from '../src/domain/profiles.mjs'
import { ScopeStore } from '../src/scopes.mjs'
import { createAccess } from '../src/core/access.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'
const NOW = zonedTimeToUtc(`${dayKeyInZone(new Date(), ZONE)}T10:00`, ZONE)

/** Временный каталог для proactive.json и users.json. */
async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-plb022-'))
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

/** Хранилище проактивности; обзор по умолчанию уже прошёл. */
async function makeProactiveStore(file, overrides = {}) {
  const store = new ProactiveStore({
    file,
    logger: silent,
    timeZone: ZONE,
    quiet: null,
    reviewAt: '23:59',
    dayLimit: 3,
    ...overrides,
  })
  await store.load()
  return store
}

/** Поручение в форме моста агента. */
const task = (id, status, { at = NOW, title, ...extra } = {}) => ({
  taskId: id,
  status,
  title: title ?? `Задача ${id}`,
  updatedAt: at.toISOString(),
  ...extra,
})

/** Сервис с подставными источниками и записью доставок. */
function makeService(store, {
  access,
  tasks = [],
  reminders = [],
  events = [],
  targets = [{ userId: 7, chatId: 7 }],
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

/** Пространства и правила доступа в памяти: файл здесь не нужен. */
function makeAccess() {
  const scopes = new ScopeStore({ logger: silent })
  return { scopes, access: createAccess({ store: scopes, logger: silent }) }
}

/** Профиль с памятью и доменными правилами поверх того же хранилища. */
async function makeMemory(dir) {
  const { scopes, access } = makeAccess()
  const store = new ProfileStore({ file: path.join(dir, 'users.json'), logger: silent, access })
  await store.load()
  return {
    scopes,
    access,
    store,
    memory: createMemory({ store, access, logger: silent }),
    rules: rulesOfProfiles({ store, access, logger: silent }),
  }
}

test('P1-1: чужая задача не попадает ни в кандидатов, ни в обзор, ни в доставку', async () => {
  const ctx = await sandbox()
  try {
    const { access } = makeAccess()
    const foreign = task('1', 'waiting', { userId: 2, title: 'Личное поручение B' })

    // Кандидаты строятся до любых решений и уже не содержат чужую задачу.
    const candidates = collectCandidates({
      now: NOW,
      tasks: [foreign],
      userId: 1,
      chatId: 1,
      settings: { tz: ZONE },
      access,
    })
    assert.deepEqual(candidates, [])

    // Обзор наступил (00:05 уже прошло): раньше чужая задача попала бы в него.
    const store = await makeProactiveStore(path.join(ctx.dir, 'proactive.json'), { reviewAt: '00:05' })
    const { service, deliveries } = makeService(store, {
      access,
      tasks: [foreign],
      targets: [{ userId: 1, chatId: 1 }],
    })
    const decisions = await service.tick({ now: NOW, force: true })

    assert.equal(deliveries.length, 0, 'карточка чужой задачи не доставлена')
    assert.doesNotMatch(JSON.stringify(deliveries), /Личное поручение B/)
    assert.doesNotMatch(JSON.stringify(store.journal), /Личное поручение B/, 'журнал не раскрывает текст чужой задачи')
    const filtered = decisions.find((decision) => decision.kind === 'filtered' && decision.key === 'task:1')
    assert.ok(filtered, 'отказ по задаче есть в решениях тика')
    assert.equal(filtered.reason, TASK_ACCESS_DENIED_REASON)
    assert.ok(
      store.journal.some((entry) => entry.kind === 'filtered' && entry.key === 'task:1' && entry.reason === TASK_ACCESS_DENIED_REASON),
      'отказ с причиной записан в журнал решений',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('P1-1: два получателя, отзыв доступа и задача без владельца', async () => {
  const ctx = await sandbox()
  try {
    const { scopes, access } = makeAccess()

    // Без проверенной идентичности получателя задача не становится общей.
    assert.deepEqual(collectCandidates({
      now: NOW,
      tasks: [task('anon', 'completed', { userId: 1 })],
      chatId: 1,
      settings: { tz: ZONE },
      access,
    }), [])

    // Два человека с личными задачами: каждая уходит только своему получателю.
    const personalStore = await makeProactiveStore(path.join(ctx.dir, 'personal.json'))
    const personal = makeService(personalStore, {
      access,
      tasks: [
        task('a', 'completed', { userId: 1, title: 'Задача A' }),
        task('b', 'completed', { userId: 2, title: 'Задача B' }),
        task('c', 'completed', { title: 'Задача без владельца' }),
      ],
      targets: [{ userId: 1, chatId: 1 }, { userId: 2, chatId: 2 }],
    })
    await personal.service.tick({ now: NOW, force: true })

    const toFirst = personal.deliveries.filter((delivery) => delivery.chatId === 1)
    const toSecond = personal.deliveries.filter((delivery) => delivery.chatId === 2)
    assert.equal(toFirst.length, 1)
    assert.equal(toSecond.length, 1)
    assert.match(toFirst[0].text, /Задача A/)
    assert.doesNotMatch(toFirst[0].text, /Задача B/, 'чужая личная задача не ушла первому')
    assert.match(toSecond[0].text, /Задача B/)
    assert.doesNotMatch(toSecond[0].text, /Задача A/, 'чужая личная задача не ушла второму')
    assert.doesNotMatch(JSON.stringify(personal.deliveries), /Задача без владельца/)
    assert.ok(
      personalStore.journal.some((entry) => entry.kind === 'filtered' && entry.key === 'task:c' && entry.reason === TASK_OWNER_UNKNOWN_REASON),
      'задача без userId не считается общедоступной и отмечается в журнале',
    )

    // Общая задача проекта: участник получает её, после отзыва — нет.
    const project = scopes.create({ title: 'Общий проект', ownerId: 1 })
    scopes.invite(project.id, 2, 'editor')
    const sharedTasks = [
      task('shared-1', 'completed', { userId: 1, scope_id: project.id, title: 'Общая задача 1' }),
      task('shared-no-owner', 'completed', { scope_id: project.id, title: 'Общая без владельца' }),
    ]
    const sharedStore = await makeProactiveStore(path.join(ctx.dir, 'shared.json'))
    const shared = makeService(sharedStore, {
      access,
      tasks: sharedTasks,
      targets: [{ userId: 2, chatId: 2 }],
    })
    await shared.service.tick({ now: NOW, force: true })
    assert.equal(shared.deliveries.length, 1, 'участник получает доступную общую задачу')
    assert.match(shared.deliveries[0].text, /Общая задача 1/)
    assert.doesNotMatch(JSON.stringify(shared.deliveries), /Общая без владельца/)

    // Отзываем доступ и добавляем новую задачу: старая уже отправлена, новая
    // не должна дойти, а журнал должен назвать причину.
    scopes.removeMember(project.id, 2)
    sharedTasks.push(task('shared-2', 'completed', { userId: 1, scope_id: project.id, title: 'Общая задача 2' }))
    await shared.service.tick({ now: new Date(NOW.getTime() + 60_000), force: true })
    assert.equal(shared.deliveries.length, 1, 'после отзыва доступа задача не доставляется')
    assert.doesNotMatch(JSON.stringify(shared.deliveries), /Общая задача 2/)
    assert.ok(
      sharedStore.journal.some((entry) => entry.kind === 'filtered' && entry.key === 'task:shared-2' && entry.reason === TASK_ACCESS_DENIED_REASON),
      'отзыв доступа отражён в журнале',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('P1-1: доступ перепроверяется непосредственно перед отправкой', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeProactiveStore(path.join(ctx.dir, 'recheck.json'))
    let allowed = true
    const access = { canRead: () => allowed }
    const target = { userId: 1, chatId: 1 }
    const { service, deliveries } = makeService(store, {
      access,
      tasks: [task('late', 'completed', { userId: 1, title: 'Поздняя задача' })],
      targets: [target],
    })
    const gathered = await service.gather(NOW)
    const candidates = service.candidatesFor(target, gathered, NOW)
    assert.equal(candidates.length, 1, 'кандидат собран, пока доступ есть')

    // Доступ отозван после сборки, но до отправки.
    allowed = false
    const decisions = await service.planInitiatives(target, candidates, NOW)
    assert.equal(deliveries.length, 0, 'отправки после отзыва доступа нет')
    assert.ok(decisions.some((decision) => decision.kind === 'filtered' && decision.reason === TASK_ACCESS_DENIED_REASON))
    assert.equal(store.itemOf('task:late'), undefined, 'бюджет и состояние доставки не тронуты')
  } finally {
    await ctx.cleanup()
  }
})

test('P1-2: viewer не пишет, отозванный участник не читает, архив запрещает запись', async () => {
  const ctx = await sandbox()
  try {
    const { scopes, store, memory, rules } = await makeMemory(ctx.dir)
    const project = scopes.create({ title: 'Ремонт', ownerId: '42' })
    scopes.invite(project.id, '99', 'viewer')

    // Viewer пытается запомнить факт напрямую и через инструмент remember.
    const direct = memory.remember('99', 'viewer не должен это записать', { scopeId: project.id })
    assert.equal(direct.ok, false)
    assert.equal(direct.reason, 'forbidden')
    assert.equal(store.memoryRecords('99').length, 0, 'отказ не создал запись')

    scopes.setActive('99', 5, project.id)
    const viaTool = await rules.remember({ text: 'и это тоже' }, { userId: '99', chatId: 5 })
    assert.equal(viaTool, MEMORY_WRITE_FORBIDDEN_TEXT)
    assert.equal(store.memoryRecords('99').length, 0, 'данные проекта не изменились')

    // Редактор пишет факт проекта, затем доступ отзывают.
    scopes.setRole(project.id, '99', 'editor')
    const projectFact = memory.remember('99', 'факт проекта до отзыва', { scopeId: project.id }).record
    memory.remember('99', 'личный факт 99')
    scopes.removeMember(project.id, '99')

    const listed = memory.list('99')
    assert.ok(listed.records.some((record) => record.value === 'личный факт 99'), 'личные факты видны')
    assert.ok(!listed.records.some((record) => record.value === 'факт проекта до отзыва'), 'фактов проекта в list нет')
    assert.deepEqual(memory.list('99', { scopeId: project.id }).records, [])

    assert.deepEqual(memory.select('99', { scopeId: project.id }), [])
    assert.deepEqual(memory.select('99').map((record) => record.value), ['личный факт 99'], 'личное остаётся видимым')
    assert.deepEqual(memory.export('99').map((record) => record.value), ['личный факт 99'])
    assert.equal(memory.history('99', projectFact.id).ok, false, 'история проектной записи закрыта')
    assert.doesNotMatch(rules.memoryCommand('99', '').text, /факт проекта до отзыва/)

    // Архивный проект читается, но не пишется.
    const archivedFact = memory.remember('42', 'архивный факт', { scopeId: project.id }).record
    scopes.archive(project.id)
    const archived = memory.remember('42', 'после архива', { scopeId: project.id })
    assert.equal(archived.ok, false)
    assert.equal(archived.reason, 'forbidden')
    assert.ok(memory.list('42', { scopeId: project.id }).records.some((record) => record.value === 'архивный факт'))
    assert.equal(memory.history('42', archivedFact.id).ok, true, 'владелец читает историю архивного проекта')
    assert.ok(!store.memoryRecords('42').some((record) => record.value === 'после архива'))
  } finally {
    await ctx.cleanup()
  }
})

test('P1-3: запись проекта не заменяет личный факт и не переносится correct', async () => {
  const ctx = await sandbox()
  try {
    const { scopes, store, memory } = await makeMemory(ctx.dir)
    const project = scopes.create({ title: 'Казань', ownerId: '42' })

    const personal = memory.remember('42', 'живу в Москве').record
    const projectFact = memory.remember('42', 'живу в Казани', { scopeId: project.id }).record

    // Оба факта активны в своих областях, у личного нет отметки замены.
    const personalStored = store.memoryRecords('42').find((record) => record.id === personal.id)
    assert.equal(personalStored.replacedAt, undefined, 'личный факт не помечен заменённым')
    assert.equal(personalStored.supersedesId, null)
    assert.equal(store.memoryRecords('42').find((record) => record.id === projectFact.id).replacedAt, undefined)

    const addressOf = (records) => records.find((record) => record.kind === 'address')?.value
    assert.equal(addressOf(memory.select('42')), 'живу в Москве')
    assert.equal(addressOf(memory.select('42', { scopeId: project.id })), 'живу в Казани')

    // Одинаковый текст в разных областях — две записи, а не дубль.
    const coffeePersonal = memory.remember('42', 'люблю утренний кофе').record
    const coffeeProject = memory.remember('42', 'люблю утренний кофе', { scopeId: project.id })
    assert.equal(coffeeProject.duplicate, false)
    assert.notEqual(coffeePersonal.id, coffeeProject.record.id)
    assert.equal(store.memoryRecords('42').filter((record) => record.value === 'люблю утренний кофе').length, 2)

    // Исправление внутри проекта заменяет только проектную запись.
    const corrected = memory.correct('42', projectFact.id, 'живу в Уфе')
    assert.equal(corrected.ok, true)
    assert.equal(corrected.previous.id, projectFact.id)
    assert.equal(store.memoryRecords('42').find((record) => record.id === projectFact.id).replacedAt !== undefined, true)
    assert.equal(store.memoryRecords('42').find((record) => record.id === personal.id).replacedAt, undefined)
    assert.equal(addressOf(memory.select('42')), 'живу в Москве')
    assert.equal(addressOf(memory.select('42', { scopeId: project.id })), 'живу в Уфе')

    // Перенос через correct запрещён: область записи не меняется.
    const secondProject = scopes.create({ title: 'Уфа', ownerId: '42' })
    const transfer = memory.correct('42', personal.id, 'живу в Твери', { scopeId: secondProject.id })
    assert.equal(transfer.ok, false)
    assert.equal(transfer.reason, 'scope-mismatch')
    assert.equal(addressOf(memory.select('42')), 'живу в Москве')
    assert.deepEqual(memory.select('42', { scopeId: secondProject.id }), [])

    // Отмена исправления возвращает только проектную запись.
    const undone = memory.undo('42', corrected.record.id)
    assert.equal(undone.ok, true)
    assert.equal(addressOf(memory.select('42', { scopeId: project.id })), 'живу в Казани')
    assert.equal(addressOf(memory.select('42')), 'живу в Москве')
  } finally {
    await ctx.cleanup()
  }
})
