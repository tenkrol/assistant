/**
 * Управляемая память PLB-019 (BP-02).
 *
 * Проверяются сценарии дельты: исправление меняет контекст, удалённое не
 * возвращается после рестарта и повторной индексации, области не смешиваются,
 * истёкшее предпочтение не используется, источник ответа объясним, миграция
 * старых фактов идемпотентна и оставляет копию файла.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProfileStore } from '../src/profiles.mjs'
import {
  MEMORY_RECORD_VERSION,
  MemorySecretError,
  SECRET_MEMORY_TEXT,
  createMemory,
  describeSource,
  filterTombstoned,
  isExpiredRecord,
} from '../src/memory.mjs'
import { rulesOfProfiles, memoryWhyText } from '../src/domain/profiles.mjs'
import { ScopeStore } from '../src/scopes.mjs'
import { createAccess } from '../src/core/access.mjs'
import { HistoryStore } from '../src/history.mjs'
import { loadConfig } from '../src/config.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** Хранилище с доступом к пространствам и временным файлом. */
async function makeMemory({ withAccess = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memory-'))
  const file = path.join(dir, 'users.json')
  const scopes = new ScopeStore({ logger: silent })
  const access = withAccess ? createAccess({ store: scopes, logger: silent }) : undefined
  const store = new ProfileStore({ file, logger: silent, access })
  await store.load()
  return {
    dir,
    file,
    scopes,
    access,
    store,
    memory: createMemory({ store, access, logger: silent }),
    rules: rulesOfProfiles({ store, access, logger: silent }),
    /** Прочитать файл после flush. */
    async read() {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    },
    async cleanup() {
      await store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

test('remember создаёт запись полного формата и сразу отдаёт её модели', async () => {
  const ctx = await makeMemory()
  try {
    const { fact } = ctx.memory.remember('42', 'его зовут Андрей', { chatId: 5 })
    for (const field of ['id', 'subjectId', 'scopeId', 'kind', 'value', 'sourceRef', 'confirmationStatus', 'validFrom', 'expiresAt', 'supersedesId', 'version']) {
      assert.ok(field in fact, `в записи нет поля ${field}`)
    }
    assert.equal(fact.subjectId, '42')
    assert.equal(fact.scopeId, 'personal-42')
    assert.equal(fact.sourceRef, 'telegram:chat:5')
    assert.equal(fact.confirmationStatus, 'confirmed')
    assert.equal(fact.version, MEMORY_RECORD_VERSION)
    assert.equal(fact.value, 'его зовут Андрей')
    // Совместимость со старыми читателями: текст и scope_id на месте.
    assert.equal(fact.text, 'его зовут Андрей')
    assert.equal(fact.scope_id, 'personal-42')

    const summary = ctx.store.summary('42', { chatId: 5 })
    assert.match(summary, /№1: его зовут Андрей/)
    // Контекст запомнил, какие записи в него попали: это основа `/memory why`.
    assert.deepEqual(ctx.store.lastUsed('42', { chatId: 5 }).ids, ['1'])
  } finally {
    await ctx.cleanup()
  }
})

test('секреты не сохраняются и не оставляют профиля', async () => {
  const ctx = await makeMemory()
  try {
    assert.equal(ctx.memory.remember('42', 'токен: sk-abcdefghijklmnop').secret, true)
    assert.equal(ctx.memory.remember('42', 'пароль: hunter2').secret, true)
    assert.throws(() => ctx.store.addFact('42', 'api key: sk-abcdefghijklmnop'), (error) => {
      assert.ok(error instanceof MemorySecretError)
      return true
    })
    assert.equal(ctx.store.facts('42').length, 0, 'секрет не создаёт запись')
    assert.equal(ctx.store.size, 0, 'отказ не создаёт и профиль')

    const text = await ctx.rules.remember({ text: 'мой пароль: hunter2' }, { userId: '42' })
    assert.equal(text, SECRET_MEMORY_TEXT)
    assert.equal(ctx.store.facts('42').length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('исправление заменяет факт в контексте и оставляет историю', async () => {
  const ctx = await makeMemory()
  try {
    ctx.memory.remember('42', 'живу в Химках')
    const corrected = ctx.memory.correct('42', '1', 'живу в Мытищах')
    assert.equal(corrected.ok, true)
    assert.equal(corrected.record.supersedesId, '1')
    assert.equal(corrected.previous.id, '1')

    const summary = ctx.store.summary('42')
    assert.match(summary, /Мытищах/)
    assert.doesNotMatch(summary, /Химках/, 'старый адрес не попадает в контекст')
    assert.deepEqual(ctx.store.facts('42').map((fact) => fact.value), ['живу в Мытищах'])

    // История доступна, но в контекст модели не идёт.
    const history = ctx.memory.history('42', '2')
    assert.deepEqual(history.history.map((record) => record.id), ['1', '2'])
    assert.equal(ctx.memory.export('42').length, 1)
    assert.equal(ctx.memory.export('42')[0].value, 'живу в Мытищах')
  } finally {
    await ctx.cleanup()
  }
})

test('исправление можно отменить, пока исходная запись не удалена', async () => {
  const ctx = await makeMemory()
  try {
    ctx.memory.remember('42', 'живу в Химках')
    ctx.memory.correct('42', '1', 'живу в Мытищах')
    const undone = ctx.memory.undo('42', '2')
    assert.equal(undone.ok, true)
    assert.equal(undone.restored.id, '1')
    assert.match(ctx.store.summary('42'), /Химках/)
    assert.doesNotMatch(ctx.store.summary('42'), /Мытищах/)

    // После удаления исходной записи отмена невозможна: данных уже нет.
    ctx.memory.forget('42', '1')
    assert.equal(ctx.memory.undo('42', '2').reason !== undefined, true)
  } finally {
    await ctx.cleanup()
  }
})

test('удалённое не возвращается после рестарта и повторной индексации', async () => {
  const ctx = await makeMemory()
  try {
    const { fact } = ctx.memory.remember('42', 'живу в Химках')
    assert.equal(ctx.memory.forget('42', fact.id).ok, true)
    assert.equal(ctx.store.summary('42'), undefined)

    const tombstones = ctx.store.tombstones()
    assert.equal(tombstones.length, 1)
    assert.deepEqual(Object.keys(tombstones[0]).sort(), ['deletedAt', 'id', 'scopeId'])
    assert.doesNotMatch(JSON.stringify(tombstones), /Химк/, 'tombstone не хранит текст')
    await ctx.store.flush()

    // Рестарт читает файл заново.
    const reopened = new ProfileStore({ file: ctx.file, logger: silent })
    await reopened.load()
    assert.equal(reopened.facts('42').length, 0)
    assert.equal(reopened.lastUsed('42'), undefined)
    // Повторная индексация старого снимка не воскрешает запись.
    const oldIndex = [{ id: fact.id, value: 'живу в Химках', scopeId: fact.scopeId }]
    assert.deepEqual(reopened.reindex(oldIndex), [])
    assert.deepEqual(filterTombstoned(oldIndex, reopened.tombstones()), [])
    // Другая область с тем же номером не блокируется.
    assert.equal(reopened.reindex([{ id: fact.id, scopeId: 'project-9' }]).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('память проекта не попадает в контекст другой области', async () => {
  const ctx = await makeMemory()
  try {
    const projectA = ctx.scopes.create({ title: 'Ремонт', ownerId: '42' })
    const projectB = ctx.scopes.create({ title: 'Дача', ownerId: '42' })
    ctx.memory.remember('42', 'стены красим в белый', { scopeId: projectA.id })
    ctx.memory.remember('42', 'личный факт', { scopeId: 'personal-42' })

    const onlyA = ctx.store.summary('42', { scopeId: projectA.id })
    assert.match(onlyA, /стены красим в белый/)
    assert.doesNotMatch(onlyA, /личный факт/)

    const onlyB = ctx.store.summary('42', { scopeId: projectB.id })
    assert.equal(onlyB, undefined, 'в проекте B нет чужих фактов')

    const personal = ctx.store.summary('42')
    assert.match(personal, /личный факт/)
    assert.doesNotMatch(personal, /стены красим/, 'факт проекта не раскрыт в личном контексте')

    // Участник другого проекта не видит память первого. Роль editor, потому
    // что viewer с PLB-022 писать не может — это проверяется отдельно.
    ctx.scopes.invite(projectB.id, '99', 'editor')
    ctx.memory.remember('99', 'моё дело в проекте B', { scopeId: projectB.id })
    assert.match(ctx.store.summary('99', { scopeId: projectB.id }), /моё дело/)
    assert.equal(ctx.store.summary('99', { scopeId: projectA.id }), undefined)

    // Активный проект чата — область и для инструмента remember, и для контекста.
    ctx.scopes.setActive('42', 5, projectA.id)
    const saved = await ctx.rules.remember({ text: 'плитка выбрана' }, { userId: '42', chatId: 5 })
    assert.match(saved, /Запомнил/)
    assert.equal(ctx.store.facts('42').find((fact) => /плитка/.test(fact.value)).scopeId, projectA.id)
    assert.match(ctx.store.summary('42', { chatId: 5 }), /плитка/)
  } finally {
    await ctx.cleanup()
  }
})

test('истёкшее предпочтение не используется как действующее', async () => {
  const ctx = await makeMemory()
  try {
    const past = new Date(Date.now() - 60_000).toISOString()
    ctx.memory.remember('42', 'любит утренний кофе', { expiresAt: past })
    assert.equal(ctx.store.summary('42'), undefined)
    assert.equal(ctx.memory.select('42').length, 0)
    assert.equal(isExpiredRecord(ctx.store.facts('42')[0]), true)
    // В списке запись видна и честно помечена истёкшей.
    assert.match(ctx.rules.memoryCommand('42').text, /срок истёк/)
  } finally {
    await ctx.cleanup()
  }
})

test('why объясняет источник и честно называет предположение', async () => {
  const ctx = await makeMemory()
  try {
    ctx.memory.remember('42', 'его зовут Андрей', { chatId: 5 })
    ctx.store.summary('42', { chatId: 5 })
    const used = ctx.store.lastUsed('42', { chatId: 5 })
    const records = ctx.store.memoryRecords('42').filter((record) => used.ids.includes(record.id))
    const text = memoryWhyText(records, { at: used.at })
    assert.match(text, /Почему я так решил/)
    assert.match(text, /№1/)
    assert.match(text, /сообщение пользователя/)
    assert.match(text, /20\d\d-\d\d-\d\d/, 'дата записи видна')

    // Предположение не выдаётся за подтверждённый факт.
    const assumption = ctx.memory.remember('42', 'любит утро', { confirmationStatus: 'assumption', sourceRef: 'agent' })
    assert.equal(assumption.record.confirmationStatus, 'assumption')
    assert.match(describeSource(assumption.record), /предположение/)
    assert.match(memoryWhyText([assumption.record]), /подтверждения нет/)
  } finally {
    await ctx.cleanup()
  }
})

test('миграция старых фактов: imported/unknown, копия до изменения, идемпотентность', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memory-migrate-'))
  const file = path.join(dir, 'users.json')
  const before = {
    version: 1,
    users: {
      42: {
        city: 'Москва',
        facts: [
          { id: '1', text: 'его зовут Андрей', createdAt: '2025-01-02T03:04:05.000Z' },
          { id: '2', text: 'живёт в Химках', createdAt: '2025-02-03T04:05:06.000Z' },
        ],
        nextFactId: 3,
        updatedAt: '2025-02-03T04:05:06.000Z',
        scope_id: 'personal-42',
      },
    },
  }
  try {
    await fs.writeFile(file, JSON.stringify(before, null, 2))
    const store = new ProfileStore({ file, logger: silent, now: () => new Date('2026-10-18T12:00:00.000Z') })
    await store.load()
    const after = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const fact of after.users['42'].facts) {
      assert.equal(fact.confirmationStatus, 'imported')
      assert.equal(fact.sourceRef, 'unknown')
      assert.equal(fact.subjectId, '42')
      assert.equal(fact.scopeId, 'personal-42')
      assert.equal(fact.version, MEMORY_RECORD_VERSION)
      assert.equal(fact.value, fact.text)
      assert.ok(Number.isFinite(Date.parse(fact.validFrom)))
    }
    // Копия файла сделана до миграции и совпадает с исходником.
    const backups = await fs.readdir(path.join(dir, 'backups'))
    assert.equal(backups.length, 1)
    const copy = JSON.parse(await fs.readFile(path.join(dir, 'backups', backups[0], 'users.json'), 'utf8'))
    assert.deepEqual(copy, before)

    // Второй запуск ничего не мигрирует и не делает вторую копию.
    const again = new ProfileStore({ file, logger: silent, now: () => new Date('2026-10-18T12:05:00.000Z') })
    await again.load()
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), after)
    assert.equal((await fs.readdir(path.join(dir, 'backups'))).length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('команды: пагинация, фильтр проекта, исправление, why и удаление', async () => {
  const ctx = await makeMemory()
  try {
    const project = ctx.scopes.create({ title: 'Дача', ownerId: '42' })
    for (let index = 1; index <= 11; index += 1) ctx.store.addFact('42', `факт номер ${index}`)
    ctx.store.addFact('42', 'на даче есть скважина', { scopeId: project.id })
    ctx.store.setCity('42', 'Казань')

    const first = ctx.rules.memoryCommand('42').text
    assert.match(first, /Страница 1 из 2/)
    assert.match(first, /Казань/)
    assert.match(first, /№10:/)
    assert.doesNotMatch(first, /№11:/)

    const second = await ctx.rules.memoryCommand('42', '2')
    assert.match(second.text, /№11:/)
    assert.match(second.text, /Страница 2 из 2/)

    const projectOnly = await ctx.rules.memoryCommand('42', 'проект Дача')
    assert.match(projectOnly.text, /скважина/)
    assert.match(projectOnly.text, /проект «Дача»/)
    assert.doesNotMatch(projectOnly.text, /факт номер 1/)

    // Исправление: следующий контекст уже с новым адресом.
    const corrected = await ctx.rules.memoryCommand('42', 'correct 1 живу в Мытищах', { chatId: 5 })
    assert.match(corrected.text, /Исправил/)
    assert.match(ctx.store.summary('42'), /Мытищах/)
    assert.doesNotMatch(ctx.store.summary('42'), /№1: /)

    // why показывает источник записи, попавшей в контекст.
    ctx.store.summary('42', { chatId: 5 })
    const why = await ctx.rules.memoryCommand('42', 'why', { chatId: 5 })
    assert.match(why.text, /Почему я так решил/)
    assert.match(why.text, /№12|№1/)

    // Область удаления уточняется, а сам факт удаляется по номеру.
    const clarify = await ctx.rules.forgetCommand('42', 'это')
    assert.match(clarify.text, /запись памяти/)
    assert.match(clarify.text, /исходное сообщение/)
    const removed = await ctx.rules.forgetCommand('42', '11')
    assert.match(removed.text, /Забыл №11/)
    assert.equal(ctx.store.isTombstoned('11', 'personal-42'), true)
  } finally {
    await ctx.cleanup()
  }
})

test('личная память не раскрывается в общем чате', async () => {
  const ctx = await makeMemory()
  try {
    ctx.store.addFact('42', 'его зовут Андрей')
    const answer = await ctx.rules.memoryCommand('42', '', { isGroup: true })
    assert.doesNotMatch(answer.text, /Андрей/)
    assert.match(answer.text, /личном чате/)
  } finally {
    await ctx.cleanup()
  }
})

test('исходное сообщение удаляется отдельной операцией /forget ... сообщение', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memory-history-'))
  try {
    const history = new HistoryStore({ file: path.join(dir, 'history.json'), limit: 10, logger: silent, saveDelayMs: 1000 })
    await history.load()
    await history.append('5', { role: 'user', content: 'переехал в Мытищи' })
    await history.append('5', { role: 'assistant', content: 'Запомнил.' })
    const removed = await history.forgetContaining('5', 'живу в Мытищах')
    assert.equal(removed, 1)
    assert.deepEqual(history.messages('5'), [], 'окно не начинается с ответа без вопроса')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('автоматическое извлечение по умолчанию выключено и включается настройкой', () => {
  const minimal = {
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
    MODEL_API_KEY: 'sk-test',
    ALLOWED_USER_IDS: '1',
  }
  assert.equal(loadConfig(minimal).profiles.autoExtract, false)
  assert.equal(loadConfig({ ...minimal, MEMORY_AUTO_EXTRACT: 'true' }).profiles.autoExtract, true)
})
