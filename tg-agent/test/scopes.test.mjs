/**
 * Пространства и доступ (BP-03).
 *
 * Проверяем то, что обещает дельта: чужое не видно ни в списке, ни по id;
 * участник общего проекта видит общее; viewer только читает; миграция старых
 * записей идемпотентна и оставляет копию файлов до изменения.
 *
 * Все хранилища работают на временных файлах: проверяется настоящая запись и
 * чтение, а не заглушки.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { ScopeStore } from '../src/scopes.mjs'
import { createAccess, migrateScopes } from '../src/core/access.mjs'
import { ReminderStore } from '../src/reminders.mjs'
import { EventStore } from '../src/events.mjs'
import { PollStore } from '../src/polls.mjs'
import { ProfileStore } from '../src/profiles.mjs'
import { HistoryStore } from '../src/history.mjs'
import { createProjectCommands } from '../src/core/projects.mjs'
import { rulesOfReminders } from '../src/domain/reminders.mjs'
import { rulesOfEvents } from '../src/domain/events.mjs'
import { rulesOfPolls } from '../src/domain/polls.mjs'
import { createMiniApp } from '../src/miniapp.mjs'
import { loadConfig } from '../src/config.mjs'
import { createInstance } from '../src/index.mjs'
import { testEnv } from './helpers.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const FUTURE = '2027-01-01T09:00:00.000Z'
const BOT_TOKEN = '123456:TEST-bot-token-abcdefghijklmnopqrstuvwxyz'

/** Окружение: пространства, доступ и временный каталог. */
async function makeAccess() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-scopes-'))
  const scopes = { store: new ScopeStore({ file: path.join(dir, 'scopes.json'), logger: silentLogger }) }
  await scopes.store.load()
  const access = createAccess({ store: scopes.store, logger: silentLogger })
  return {
    dir,
    scopes,
    access,
    cleanup: async () => {
      await scopes.store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/** Хранилища с доступом на одном временном каталоге. */
async function makeStores() {
  const ctx = await makeAccess()
  const reminders = new ReminderStore({ file: path.join(ctx.dir, 'reminders.json'), logger: silentLogger, access: ctx.access })
  const events = new EventStore({ file: path.join(ctx.dir, 'events.json'), logger: silentLogger, access: ctx.access })
  const polls = new PollStore({ file: path.join(ctx.dir, 'polls.json'), logger: silentLogger, access: ctx.access })
  await Promise.all([reminders.load(), events.load(), polls.load()])
  return { ...ctx, reminders, events, polls }
}

test('личное пространство создаётся один раз и хранит владельца и роль', async () => {
  const ctx = await makeAccess()
  try {
    const first = ctx.access.scopeOf(42)
    const again = ctx.access.scopeOf('42')
    assert.equal(first.id, 'personal-42')
    assert.equal(again.id, first.id)
    assert.equal(first.kind, 'personal')
    assert.equal(first.ownerId, 42)
    assert.equal(first.status, 'active')
    assert.equal(first.version, 1)
    assert.deepEqual(first.members, [{ userId: 42, platform: 'telegram', principal: 'telegram:42', role: 'owner' }])
    assert.ok(Number.isFinite(Date.parse(first.createdAt)))
    assert.equal(ctx.scopes.store.list().length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('общий проект: владелец, роли, участники и активность по паре пользователь+чат', async () => {
  const ctx = await makeAccess()
  try {
    const scope = ctx.scopes.store.create({ title: ' Ремонт ', ownerId: 1 })
    assert.equal(scope.id, 'project-1')
    assert.equal(scope.title, 'Ремонт')
    assert.equal(scope.kind, 'shared')
    assert.equal(ctx.access.canManageScope(1, scope), true)
    assert.equal(ctx.access.canManageScope(2, scope), false)

    assert.deepEqual(ctx.scopes.store.addMember(scope.id, 2), { userId: 2, platform: 'telegram', principal: 'telegram:2', role: 'editor' })
    assert.deepEqual(ctx.scopes.store.addMember(scope.id, 3, 'viewer'), { userId: 3, platform: 'telegram', principal: 'telegram:3', role: 'viewer' })
    assert.equal(ctx.access.roleOf(2, scope), 'editor')
    assert.equal(ctx.access.roleOf(3, scope), 'viewer')

    ctx.scopes.store.setActive(1, 555, scope.id)
    ctx.scopes.store.setActive(1, 777, scope.id)
    ctx.scopes.store.setActive(2, 555, scope.id)
    assert.equal(ctx.scopes.store.activeScopeId(1, 555), scope.id)
    assert.equal(ctx.scopes.store.activeScopeId(1, 777), scope.id)
    assert.equal(ctx.scopes.store.activeScopeId(2, 555), scope.id)
    assert.equal(ctx.scopes.store.activeScopeId(2, 777), undefined, 'чужой чат не меняет область')

    // Архив сохраняет чтение, но запрещает запись и управление.
    ctx.scopes.store.archive(scope.id)
    assert.equal(ctx.access.canReadScope(1, scope.id), true)
    assert.equal(ctx.access.canWriteScope(1, scope.id), false)
    assert.equal(ctx.access.canManageScope(1, scope), false)
    assert.equal(ctx.scopes.store.activeScopeId(1, 555), undefined)

    // Перезапуск: пространства и активные проекты читаются с диска.
    await ctx.scopes.store.flush()
    const reopened = new ScopeStore({ file: path.join(ctx.dir, 'scopes.json'), logger: silentLogger })
    await reopened.load()
    assert.equal(reopened.get(scope.id)?.status, 'archived')
    assert.equal(reopened.get(scope.id)?.members.length, 3)
  } finally {
    await ctx.cleanup()
  }
})

test('матрица ролей: viewer читает, но не пишет; чужой не читает личное', async () => {
  const ctx = await makeAccess()
  try {
    const scope = ctx.scopes.store.create({ title: 'Дача', ownerId: 1 })
    ctx.scopes.store.addMember(scope.id, 2, 'editor')
    ctx.scopes.store.addMember(scope.id, 3, 'viewer')
    const record = { id: '1', scope_id: scope.id, userId: 1 }

    assert.equal(ctx.access.canRead(1, record), true)
    assert.equal(ctx.access.canWrite(1, record), true, 'owner пишет')
    assert.equal(ctx.access.canRead(2, record), true)
    assert.equal(ctx.access.canWrite(2, record), true, 'editor пишет')
    assert.equal(ctx.access.canRead(3, record), true)
    assert.equal(ctx.access.canWrite(3, record), false, 'viewer только читает')
    assert.equal(ctx.access.canRead(4, record), false, 'чужой не читает')
    assert.equal(ctx.access.canWrite(4, record), false)

    const personal = ctx.access.scopeOf(1)
    const mine = { id: '2', scope_id: personal.id, userId: 1 }
    assert.equal(ctx.access.canRead(1, mine), true)
    assert.equal(ctx.access.canRead(2, mine), false, 'личное не видно второму человеку')
    assert.equal(ctx.access.canWrite(2, mine), false)

    // Архивная запись читается, но не меняется никем из участников.
    ctx.scopes.store.archive(scope.id)
    assert.equal(ctx.access.canRead(2, record), true)
    assert.equal(ctx.access.canWrite(2, record), false)
  } finally {
    await ctx.cleanup()
  }
})

test('напоминания, события и опросы: чужое не видно ни в списке, ни по id', async () => {
  const ctx = await makeStores()
  try {
    const a = ctx.reminders.add({ chatId: 1, userId: 1, text: 'моё', dueAt: FUTURE })
    const b = ctx.reminders.add({ chatId: 2, userId: 2, text: 'чужое', dueAt: FUTURE })
    assert.deepEqual(ctx.reminders.list(1, 1).map((item) => item.text), ['моё'])
    assert.deepEqual(ctx.reminders.list(2, 1), [], 'чужой чат не виден')
    assert.equal(ctx.reminders.cancel(1, b.id, 1), undefined, 'чужое по id не отменяется')
    assert.equal(ctx.reminders.reminders.length, 2)

    const ownEvent = ctx.events.add({ chatId: 1, userId: 1, title: 'врач', at: FUTURE })
    ctx.events.add({ chatId: 2, userId: 2, title: 'кино', at: FUTURE })
    assert.deepEqual(ctx.events.list(1, 1).map((item) => item.title), ['врач'])
    assert.deepEqual(ctx.events.list(2, 1), [])
    assert.equal(ctx.events.remove(1, ownEvent.id, 2), undefined, 'чужое событие по id не удаляется')
    assert.equal(ctx.events.events.length, 2)

    const ownPoll = ctx.polls.add({ chatId: 1, userId: 1, question: 'Куда?', options: ['лес', 'река'] })
    ctx.polls.add({ chatId: 2, userId: 2, question: 'Чужой?', options: ['да', 'нет'] })
    assert.deepEqual(ctx.polls.list(1, 1).map((item) => item.id), [ownPoll.id])
    assert.deepEqual(ctx.polls.list(2, 1), [])
    assert.equal(ctx.polls.get(ownPoll.id, 2), undefined, 'чужой опрос по id не читается')
    assert.equal(ctx.polls.vote(ownPoll.id, 2, 0), undefined, 'и не голосуется')
    assert.deepEqual(ownPoll.options.map((option) => option.votes), [[], []])

    assert.equal(a.scope_id, 'personal-1')
    assert.equal(b.scope_id, 'personal-2')
  } finally {
    await ctx.cleanup()
  }
})

test('участник видит общий проект; viewer получает отказ на запись', async () => {
  const ctx = await makeStores()
  try {
    const scope = ctx.scopes.store.create({ title: 'Семья', ownerId: 1 })
    ctx.scopes.store.addMember(scope.id, 2, 'editor')
    ctx.scopes.store.addMember(scope.id, 3, 'viewer')
    ctx.scopes.store.setActive(1, 555, scope.id)
    ctx.scopes.store.setActive(2, 777, scope.id)
    ctx.scopes.store.setActive(3, 888, scope.id)

    const shared = ctx.reminders.add({ chatId: 555, userId: 1, text: 'купить краску', dueAt: FUTURE })
    assert.equal(shared.scope_id, scope.id)
    assert.deepEqual(ctx.reminders.list(777, 2).map((item) => item.text), ['купить краску'], 'участник видит общее из другого чата')
    assert.deepEqual(ctx.reminders.list(888, 3).map((item) => item.text), ['купить краску'], 'viewer видит')

    // Editor меняет данные проекта.
    const edited = ctx.reminders.add({ chatId: 777, userId: 2, text: 'и валик', dueAt: FUTURE })
    assert.equal(edited.scope_id, scope.id)
    assert.equal(ctx.reminders.cancel(555, shared.id, 2)?.id, shared.id)

    // Viewer не меняет ничего: ни текст, ни кнопку.
    assert.throws(
      () => ctx.reminders.add({ chatId: 888, userId: 3, text: 'нельзя', dueAt: FUTURE }),
      /access denied/,
    )
    const still = ctx.reminders.add({ chatId: 555, userId: 1, text: 'вернуть', dueAt: FUTURE })
    assert.equal(ctx.reminders.cancel(555, still.id, 3), undefined)
    assert.equal(ctx.reminders.list(555, 1).some((item) => item.text === 'вернуть'), true)

    // Список проектов не показывает чужое личное пространство.
    assert.deepEqual(ctx.access.sharedScopes(3).map((item) => item.id), [scope.id])
    assert.equal(ctx.access.sharedScopes(4).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('домены отвечают текстом: viewer не создаёт напоминание, событие и опрос', async () => {
  const ctx = await makeStores()
  try {
    const scope = ctx.scopes.store.create({ title: 'Дача', ownerId: 1 })
    ctx.scopes.store.addMember(scope.id, 3, 'viewer')
    ctx.scopes.store.setActive(3, 888, scope.id)

    const reminders = rulesOfReminders({ store: ctx.reminders, access: ctx.access, timeZone: 'Europe/Moscow' })
    const deniedReminder = await reminders.create(
      { text: 'полить', in_minutes: 10 },
      { chatId: 888, userId: 3 },
    )
    assert.match(deniedReminder.text, /Только просмотр/)
    assert.equal(ctx.reminders.reminders.length, 0)

    const events = rulesOfEvents({ store: ctx.events, access: ctx.access, timeZone: 'Europe/Moscow' })
    const deniedEvent = await events.executeDetailed(
      { action: 'add', title: 'встреча', at: FUTURE },
      { chatId: 888, userId: 3 },
    )
    assert.match(deniedEvent.text, /viewer|Только просмотр/)
    assert.equal(ctx.events.events.length, 0)

    const polls = rulesOfPolls({ store: ctx.polls, access: ctx.access })
    const deniedPoll = await polls.create(
      { question: 'Куда?', options: ['лес', 'река'] },
      { chatId: 888, userId: 3 },
    )
    assert.match(deniedPoll.text, /просмотр/i)
    assert.equal(ctx.polls.polls.length, 0)

    // Кнопка отмены — тот же запрет, запись остаётся.
    ctx.scopes.store.setActive(1, 555, scope.id)
    const ownerReminder = ctx.reminders.add({ chatId: 555, userId: 1, text: 'важное', dueAt: FUTURE })
    const deniedButton = await reminders.cancelByButton({ chatId: 555, userId: 3, id: ownerReminder.id })
    assert.equal(deniedButton.denied, true)
    assert.match(deniedButton.outcome, /Только просмотр/)
    assert.equal(ctx.reminders.reminders.length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('viewer не голосует в опросе общего проекта (callback)', async () => {
  const ctx = await makeStores()
  try {
    const scope = ctx.scopes.store.create({ title: 'Поездка', ownerId: 1 })
    ctx.scopes.store.addMember(scope.id, 3, 'viewer')
    ctx.scopes.store.setActive(1, 555, scope.id)
    ctx.scopes.store.setActive(3, 888, scope.id)

    const poll = ctx.polls.add({ chatId: 555, userId: 1, question: 'Куда?', options: ['лес', 'река'] })
    const rules = rulesOfPolls({ store: ctx.polls, access: ctx.access })
    const outcome = await rules.vote(poll.id, 3, 0)
    assert.equal(outcome.denied, true)
    assert.match(outcome.toast, /Только просмотр/)
    assert.deepEqual(poll.options.map((option) => option.votes), [[], []], 'данные не изменились')

    // Чужой человек тоже не голосует и даже не получает подтверждения опроса.
    const stranger = await rules.vote(poll.id, 4, 0)
    assert.equal(stranger.denied, true)
    assert.match(stranger.toast, /не найден/)
  } finally {
    await ctx.cleanup()
  }
})

/** Ответ хранилища «до миграции» в реальном формате (version 1). */
async function seedLegacyFiles(dir) {
  await fs.writeFile(path.join(dir, 'reminders.json'), JSON.stringify({
    version: 1,
    nextId: 2,
    reminders: [{
      id: '1', chatId: 555, userId: 777, text: 'хлеб', dueAt: FUTURE, repeat: 'none', createdAt: '2026-10-01T00:00:00.000Z',
    }],
  }))
  await fs.writeFile(path.join(dir, 'events.json'), JSON.stringify({
    version: 1,
    nextId: 2,
    events: [{
      id: '1', chatId: 555, userId: 777, title: 'врач', at: FUTURE, repeat: 'none', createdAt: '2026-10-01T00:00:00.000Z',
    }],
  }))
  await fs.writeFile(path.join(dir, 'polls.json'), JSON.stringify({
    version: 1,
    nextId: 2,
    polls: [{
      id: '1', chatId: 555, userId: 777, question: 'Куда?', options: [{ text: 'лес', votes: [] }, { text: 'река', votes: [] }], createdAt: '2026-10-01T00:00:00.000Z',
    }],
  }))
  await fs.writeFile(path.join(dir, 'users.json'), JSON.stringify({
    version: 1,
    users: { 777: { city: 'Москва', facts: [], nextFactId: 1, updatedAt: '2026-10-01T00:00:00.000Z' } },
  }))
  await fs.writeFile(path.join(dir, 'history.json'), JSON.stringify({
    version: 1,
    chats: { 777: { messages: [{ role: 'user', content: 'привет' }] } },
  }))
}

test('миграция: копия до записи, личное пространство владельца и идемпотентность', async () => {
  const ctx = await makeAccess()
  try {
    await seedLegacyFiles(ctx.dir)
    const reminders = new ReminderStore({ file: path.join(ctx.dir, 'reminders.json'), logger: silentLogger, access: ctx.access })
    const events = new EventStore({ file: path.join(ctx.dir, 'events.json'), logger: silentLogger, access: ctx.access })
    const polls = new PollStore({ file: path.join(ctx.dir, 'polls.json'), logger: silentLogger, access: ctx.access })
    const profiles = new ProfileStore({ file: path.join(ctx.dir, 'users.json'), logger: silentLogger, access: ctx.access })
    const history = new HistoryStore({ file: path.join(ctx.dir, 'history.json'), limit: 5, logger: silentLogger, access: ctx.access })
    await Promise.all([reminders.load(), events.load(), polls.load(), profiles.load(), history.load()])

    const before = {
      reminders: await fs.readFile(reminders.file, 'utf8'),
      history: await fs.readFile(history.file, 'utf8'),
    }
    const targets = [
      { name: 'history', file: history.file, entries: () => [...history.chats.entries()].map(([chatId, record]) => ({ record, ownerId: chatId })), flush: () => history.flush() },
      { name: 'reminders', file: reminders.file, entries: () => reminders.reminders.map((record) => ({ record, ownerId: record.userId ?? record.chatId })), flush: () => reminders.flush() },
      { name: 'events', file: events.file, entries: () => events.events.map((record) => ({ record, ownerId: record.userId ?? record.chatId })), flush: () => events.flush() },
      { name: 'polls', file: polls.file, entries: () => polls.polls.map((record) => ({ record, ownerId: record.userId ?? record.chatId })), flush: () => polls.flush() },
      { name: 'profiles', file: profiles.file, entries: () => [...profiles.users.entries()].map(([userId, record]) => ({ record, ownerId: userId })), flush: () => profiles.flush() },
    ]

    const first = await migrateScopes({
      access: ctx.access,
      targets,
      backupDir: path.join(ctx.dir, 'backups'),
      logger: silentLogger,
      now: () => new Date('2026-10-18T12:00:00Z'),
    })
    assert.equal(first.migrated, 5)
    assert.ok(first.backupDir)
    const backups = await fs.readdir(first.backupDir)
    assert.deepEqual(backups.sort(), ['events.json', 'history.json', 'polls.json', 'reminders.json', 'users.json'])
    assert.equal(await fs.readFile(path.join(first.backupDir, 'reminders.json'), 'utf8'), before.reminders, 'копия сделана до изменения')
    assert.equal(await fs.readFile(path.join(first.backupDir, 'history.json'), 'utf8'), before.history)

    const afterReminders = JSON.parse(await fs.readFile(reminders.file, 'utf8'))
    const afterHistory = JSON.parse(await fs.readFile(history.file, 'utf8'))
    const afterUsers = JSON.parse(await fs.readFile(profiles.file, 'utf8'))
    assert.equal(afterReminders.reminders[0].scope_id, 'personal-777')
    assert.equal(afterReminders.version, 1, 'версия схемы не меняется')
    assert.equal(afterHistory.chats['777'].scope_id, 'personal-777')
    assert.equal(afterUsers.users['777'].scope_id, 'personal-777')
    assert.equal(ctx.access.canRead(777, reminders.reminders[0]), true)
    assert.equal(ctx.access.canRead(778, reminders.reminders[0]), false)

    // Повторный запуск ничего не меняет и не создаёт вторую копию.
    const snapshot = await fs.readFile(reminders.file, 'utf8')
    const backupDirsBefore = (await fs.readdir(path.join(ctx.dir, 'backups'))).sort()
    const second = await migrateScopes({
      access: ctx.access,
      targets,
      backupDir: path.join(ctx.dir, 'backups'),
      logger: silentLogger,
      now: () => new Date('2026-10-18T12:05:00Z'),
    })
    assert.equal(second.migrated, 0)
    assert.equal(second.backupDir, undefined)
    assert.equal(await fs.readFile(reminders.file, 'utf8'), snapshot, 'файл не переписан')
    assert.deepEqual((await fs.readdir(path.join(ctx.dir, 'backups'))).sort(), backupDirsBefore)
  } finally {
    await ctx.cleanup()
  }
})

test('команды /project: создать, пригласить, выбрать, отозвать, архивировать', async () => {
  const ctx = await makeStores()
  try {
    const sent = []
    const bot = {
      access: ctx.access,
      scopes: ctx.scopes,
      logger: silentLogger,
      send: async (chatId, text) => { sent.push(text) },
    }
    const projects = createProjectCommands(bot)
    const message = (userId, chatId = 555) => ({ from: { id: userId }, chat: { id: chatId } })

    await projects.run({ args: 'new Ремонт' }, message(1))
    assert.match(sent.at(-1), /Проект «Ремонт» создан: `project-1`/)
    assert.equal(ctx.scopes.store.activeScopeId(1, 555), 'project-1')

    await projects.run({ args: 'list' }, message(1))
    assert.match(sent.at(-1), /project-1/)
    assert.match(sent.at(-1), /активен/)

    // Приглашение создаётся pending: до принятия участника и доступа нет.
    await projects.run({ args: 'invite 2 editor' }, message(1))
    assert.match(sent.at(-1), /приглашён/)
    const codeFor2 = /Код: `([A-Z0-9]+)`/.exec(sent.at(-1))[1]
    assert.equal(ctx.scopes.store.member('project-1', 2), undefined, 'pending не участник')
    assert.equal(ctx.access.canReadScope(2, 'project-1'), false, 'pending не даёт доступа')
    await projects.run({ args: `accept ${codeFor2}` }, message(2, 777))
    assert.match(sent.at(-1), /Приглашение принято/)
    assert.equal(ctx.access.roleOf(2, ctx.scopes.store.get('project-1')), 'editor')

    await projects.run({ args: 'invite 3 viewer' }, message(1))
    assert.match(sent.at(-1), /ролью viewer/)
    const codeFor3 = /Код: `([A-Z0-9]+)`/.exec(sent.at(-1))[1]
    await projects.run({ args: `accept ${codeFor3}` }, message(3, 888))
    assert.match(sent.at(-1), /Приглашение принято/)

    // Участник видит проект и общую запись, которой поделились в другом чате.
    ctx.scopes.store.setActive(1, 555, 'project-1')
    ctx.scopes.store.setActive(2, 777, 'project-1')
    ctx.reminders.add({ chatId: 555, userId: 1, text: 'общее', dueAt: FUTURE })
    assert.deepEqual(ctx.reminders.list(777, 2).map((item) => item.text), ['общее'])

    await projects.run({ args: 'list' }, message(2, 777))
    assert.doesNotMatch(sent.at(-1), /personal-1/, 'чужое личное не показывается')

    await projects.run({ args: 'revoke 2' }, message(1))
    assert.match(sent.at(-1), /отозван/)
    assert.deepEqual(ctx.access.sharedScopes(2), [])

    await projects.run({ args: 'archive project-1' }, message(1))
    assert.match(sent.at(-1), /в архиве/)
    assert.equal(ctx.access.canReadScope(1, 'project-1'), true)
    assert.equal(ctx.access.canWriteScope(1, 'project-1'), false)
    assert.equal(ctx.scopes.store.activeScopeId(1, 555), undefined)
  } finally {
    await ctx.cleanup()
  }
})

/** Подписать initData так, как это делает Telegram. */
function signInitData(user, { botToken = BOT_TOKEN } = {}) {
  const params = new URLSearchParams()
  params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc')
  params.set('user', JSON.stringify(user))
  params.set('auth_date', String(Math.floor(Date.now() / 1000)))
  const dataCheckString = [...params.entries()].map(([key, value]) => `${key}=${value}`).sort().join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'))
  return params.toString()
}

test('Mini App: viewer получает 403 и не меняет данные общего проекта', async (t) => {
  const ctx = await makeStores()
  const scope = ctx.scopes.store.create({ title: 'Дача', ownerId: 1 })
  ctx.scopes.store.addMember(scope.id, 3, 'viewer')
  ctx.scopes.store.setActive(1, 1, scope.id)
  ctx.scopes.store.setActive(3, 3, scope.id)
  const ownerReminder = ctx.reminders.add({ chatId: 1, userId: 1, text: 'полить', dueAt: FUTURE })

  const app = createMiniApp({
    port: 0,
    host: '127.0.0.1',
    botToken: BOT_TOKEN,
    allowedUserIds: [1, 3],
    chatIdOf: (id) => id,
    stores: { reminders: ctx.reminders, events: ctx.events, profiles: new ProfileStore({ file: path.join(ctx.dir, 'profiles.json'), logger: silentLogger }) },
    logger: silentLogger,
  })
  const port = await app.start()
  const base = `http://127.0.0.1:${port}`
  t.after(async () => {
    await app.stop()
    await ctx.cleanup()
  })

  const initData = signInitData({ id: 3, first_name: 'Гость' })
  const created = await fetch(`${base}/api/reminders`, {
    method: 'POST',
    headers: { 'X-Telegram-Init-Data': initData, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'нельзя', dueAt: new Date(Date.now() + 3_600_000).toISOString() }),
  })
  assert.equal(created.status, 403)
  assert.equal((await created.json()).code, 'forbidden')
  assert.equal(ctx.reminders.reminders.length, 1, 'viewer ничего не создал')

  const removed = await fetch(`${base}/api/reminders/${ownerReminder.id}`, {
    method: 'DELETE',
    headers: { 'X-Telegram-Init-Data': initData },
  })
  assert.equal(removed.status, 403)
  assert.equal(ctx.reminders.reminders.length, 1, 'viewer ничего не удалил')
})

test('история и профили получают scope_id и читаются только владельцем', async () => {
  const ctx = await makeAccess()
  try {
    const history = new HistoryStore({ file: path.join(ctx.dir, 'history.json'), limit: 5, logger: silentLogger, access: ctx.access })
    const profiles = new ProfileStore({ file: path.join(ctx.dir, 'users.json'), logger: silentLogger, access: ctx.access })
    await Promise.all([history.load(), profiles.load()])

    await history.append('777', { role: 'user', content: 'привет' }, { userId: 777 })
    const record = history.chats.get('777')
    assert.equal(record.scope_id, 'personal-777')
    assert.deepEqual(history.messages('777', 777).map((item) => item.content), ['привет'])
    assert.deepEqual(history.messages('777', 778), [], 'чужой диалог не читается даже по id')

    profiles.addFact(777, 'его зовут Андрей')
    assert.equal(profiles.get(777).scope_id, 'personal-777')
    await profiles.flush()
    const saved = JSON.parse(await fs.readFile(profiles.file, 'utf8'))
    assert.equal(saved.users['777'].scope_id, 'personal-777')
  } finally {
    await ctx.cleanup()
  }
})


/** Платформа-заглушка для проверки настоящей сборки бота без сети. */
function fakePlatform() {
  return {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 1, username: 'stub' },
    async start() {},
    async stop() {},
    async getUpdates({ signal } = {}) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      return { updates: [], cursor: undefined }
    },
    async sendText() { return { messageId: 1 } },
    async editText() {},
    async answerCallback() {},
    async sendTyping() {},
  }
}

test('запуск бота мигрирует существующие файлы и не повторяет миграцию', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-scope-startup-'))
  try {
    await fs.writeFile(path.join(dir, 'history.json'), JSON.stringify({
      version: 1,
      chats: { 777: { messages: [{ role: 'user', content: 'старое' }] } },
    }))
    await fs.writeFile(path.join(dir, 'reminders.json'), JSON.stringify({
      version: 1,
      nextId: 2,
      reminders: [{ id: '1', chatId: 777, userId: 777, text: 'старое', dueAt: FUTURE, repeat: 'none', createdAt: '2026-10-01T00:00:00.000Z' }],
    }))
    const config = loadConfig(testEnv({
      telegramApiBase: 'http://127.0.0.1:1',
      modelBaseUrl: 'http://127.0.0.1:1',
      dataDir: dir,
      overrides: { STREAM: 'false', DIGEST: 'false', REMINDERS: 'true', MEMORY: 'true' },
    }))
    const instance = { label: 'main', platform: 'telegram', token: config.telegram.token, namespace: 'telegram' }
    const shared = { model: { name: 'stub' } }

    const first = await createInstance({ config, logger: silentLogger, instance, shared, platformFactory: async () => fakePlatform() })
    await first.bot.stop()
    const backups = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('scope-migration-'))
    assert.equal(backups.length, 1)
    assert.deepEqual((await fs.readdir(path.join(dir, 'backups', backups[0]))).sort(), ['history.json', 'reminders.json'])
    const history = JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8'))
    const reminders = JSON.parse(await fs.readFile(path.join(dir, 'reminders.json'), 'utf8'))
    assert.equal(history.chats['777'].scope_id, 'personal-777')
    assert.equal(reminders.reminders[0].scope_id, 'personal-777')
    const scopes = JSON.parse(await fs.readFile(path.join(dir, 'scopes.json'), 'utf8'))
    assert.equal(scopes.scopes['personal-777'].kind, 'personal')

    // Второй запуск: записи уже размечены, новой копии и перезаписи нет.
    const snapshot = await fs.readFile(path.join(dir, 'history.json'), 'utf8')
    const second = await createInstance({ config, logger: silentLogger, instance, shared, platformFactory: async () => fakePlatform() })
    await second.bot.stop()
    assert.equal(snapshot, await fs.readFile(path.join(dir, 'history.json'), 'utf8'))
    const after = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('scope-migration-'))
    assert.equal(after.length, 1, 'повторная миграция не создаёт копию')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
