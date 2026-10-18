/**
 * Единая точка проверки доступа к данным по пространствам (`scope_id`).
 *
 * Все хранилища спрашивают разрешение только здесь: домены и инструменты не
 * решают сами, можно ли читать или писать запись. Так пропущенная проверка не
 * появляется при добавлении новой точки чтения.
 *
 * Идентичность приходит из проверенного контекста транспорта (`message.from.id`,
 * `context.userId`), а не из аргументов модели. Аргументы модели могут назвать
 * только объект или проект, но не подменить пользователя.
 *
 * Здесь же живёт миграция существующих записей в личное пространство: она делает
 * копию файлов до изменения и идемпотентна — второй запуск ничего не меняет.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ScopeStore, parsePrincipal } from '../scopes.mjs'

/** Личный владелец записи: автор, а для старых записей без автора — чат. */
export function scopeOwnerOf(record) {
  if (!record) return undefined
  if (record.userId !== undefined && record.userId !== null) return record.userId
  if (record.chatId !== undefined && record.chatId !== null) return record.chatId
  if (record.ownerId !== undefined && record.ownerId !== null) return record.ownerId
  return undefined
}

/**
 * Собрать правила доступа поверх хранилища пространств.
 *
 * @param {object} options - `store` (или `scopes.store`), `platform`, `logger`.
 * @param {object} options.store - хранилище `ScopeStore`.
 * @param {string} [options.platform] - канал проверенного контекста (адаптер).
 * @returns {object} проверки доступа и работа с активным проектом.
 */
export function createAccess({ store, scopes, platform, logger } = {}) {
  const scopeStore = store ?? scopes?.store ?? scopes
  if (!scopeStore || typeof scopeStore.personal !== 'function') {
    throw new Error('access: нужно хранилище пространств')
  }
  // Платформа приходит от адаптера (проверенный транспорт), а не из аргументов
  // модели: только вместе с id она образует principal человека.
  const channel = String(platform ?? scopeStore.platform ?? 'telegram').toLowerCase()

  /** Principal проверенного пользователя: `<платформа>:<id>`. */
  function principalOf(userId) {
    return parsePrincipal(userId, channel)?.principal
  }

  /** Участник пространства по id или principal; pending в members не попадает. */
  function memberOf(scope, userId) {
    const target = parsePrincipal(userId, channel)
    if (!scope || !target) return undefined
    return scope.members?.find((member) => {
      if (member.principal) return member.principal === target.principal
      // Запись до миграции: платформы нет, значит канал тот же.
      return String(member.userId) === String(target.userId)
        && (member.platform ?? channel) === target.platform
    })
  }

  /** Владелец пространства с учётом платформы. */
  function isOwner(scope, userId) {
    const target = parsePrincipal(userId, channel)
    if (!scope || !target) return false
    if (String(scope.ownerId) !== String(target.userId)) return false
    return scope.ownerPlatform === undefined || scope.ownerPlatform === target.platform
  }

  /** Личное пространство человека; создаётся при первом обращении. */
  function scopeOf(userId) {
    return scopeStore.personal(userId)
  }

  /** Пространство записи: сначала `scope_id`, иначе личное пространство владельца. */
  function scopeOfRecord(record) {
    if (!record) return undefined
    if (record.scope_id !== undefined && record.scope_id !== null && record.scope_id !== '') {
      const found = scopeStore.get(record.scope_id)
      if (found) return found
      // Предсказуемый id личного пространства позволяет восстановить его, даже
      // если файл пространств ещё не успел сохраниться после первого обращения.
      const match = /^personal-(.+)$/.exec(String(record.scope_id))
      const owner = scopeOwnerOf(record)
      if (match && owner !== undefined && String(owner) === match[1]) return scopeStore.personal(owner)
      return undefined
    }
    const owner = scopeOwnerOf(record)
    return owner === undefined ? undefined : scopeStore.personal(owner)
  }

  /** Роль пользователя в пространстве: owner, editor, viewer или undefined. */
  function roleOf(userId, scope) {
    return memberOf(scope, userId)?.role
  }

  /** Можно ли прочитать запись. */
  function canRead(userId, record) {
    if (userId === undefined || userId === null) return false
    const scope = scopeOfRecord(record)
    if (!scope) return false
    if (scope.kind === 'personal') return isOwner(scope, userId)
    return Boolean(memberOf(scope, userId))
  }

  /** Можно ли изменить запись; архив и роль viewer запрещают запись. */
  function canWrite(userId, record) {
    if (!canRead(userId, record)) return false
    const scope = scopeOfRecord(record)
    if (!scope || scope.status === 'archived') return false
    const role = roleOf(userId, scope)
    return role === 'owner' || role === 'editor'
  }

  /** Виден ли пользователю общий проект (нужно для списков и записей из других чатов). */
  function isSharedFor(userId, record) {
    const scope = scopeOfRecord(record)
    return scope?.kind === 'shared' && canRead(userId, record)
  }

  /** Можно ли прочитать пространство целиком. */
  function canReadScope(userId, scopeId) {
    const scope = scopeStore.get(scopeId)
    if (!scope || userId === undefined || userId === null) return false
    if (scope.kind === 'personal') return isOwner(scope, userId)
    return Boolean(memberOf(scope, userId))
  }

  /** Можно ли писать в пространство (архив и viewer запрещают). */
  function canWriteScope(userId, scopeId) {
    const scope = scopeStore.get(scopeId)
    if (!scope || !canReadScope(userId, scopeId) || scope.status === 'archived') return false
    const role = roleOf(userId, scope)
    return role === 'owner' || role === 'editor'
  }

  /** Общие пространства, где пользователь состоит; архивные тоже видны для чтения. */
  function sharedScopes(userId) {
    return scopeStore.list().filter(
      (scope) => scope.kind === 'shared' && memberOf(scope, userId) !== undefined,
    )
  }

  /** Управлять пространством может только владелец и только пока оно не в архиве. */
  function canManageScope(userId, scope) {
    if (!scope || scope.status === 'archived') return false
    if (!isOwner(scope, userId)) return false
    return memberOf(scope, userId)?.role === 'owner'
  }

  /** Активное пространство пользователя в этом чате. */
  function activeScope(userId, chatId) {
    const scopeId = scopeStore.activeScopeId(userId, chatId)
    if (!scopeId || !canReadScope(userId, scopeId)) return undefined
    return scopeStore.get(scopeId)
  }

  /**
   * Пространство для новой записи: явно заданное, активный проект или личное.
   *
   * @param {string|number} userId - автор записи из проверенного контекста.
   * @param {string|number} chatId - чат/тема.
   * @param {string} [requested] - явно выбранный проект.
   * @returns {string} id пространства.
   */
  function scopeIdFor(userId, chatId, requested) {
    if (requested !== undefined && requested !== null && requested !== '') return String(requested)
    const active = activeScope(userId, chatId)
    if (active) return active.id
    return scopeOf(userId).id
  }

  return {
    store: scopeStore,
    scopeOf,
    scopeOfRecord,
    platform: channel,
    principalOf,
    roleOf,
    canRead,
    canWrite,
    isSharedFor,
    canReadScope,
    canWriteScope,
    sharedScopes,
    canManageScope,
    activeScope,
    scopeIdFor,
    /** Сохранить изменения пространств (после создания личного или проекта). */
    flush: () => scopeStore.flush(),
    /** Хранилище пространств — для команд `/project` и диагностики. */
    scopes: scopeStore,
    logger,
  }
}

/**
 * Доступ по умолчанию для модульных обёрток.
 *
 * Production всегда передаёт объект `access` в хранилища; обёртки ниже нужны для
 * совместимого импорта `scopeOf`/`canRead` без фабрики. Один процесс — одно
 * хранилище пространств, поэтому состояние модуля не пересекается между ботами.
 */
let defaultAccess
export function configureAccess(options = {}) {
  defaultAccess = createAccess(options)
  return defaultAccess
}

/**
 * Текущий доступ. Явно собранный через `configureAccess` приоритетнее; иначе
 * для модульных обёрток создаётся пространство в памяти.
 */
export function currentAccess() {
  if (!defaultAccess) defaultAccess = createAccess({ store: new ScopeStore() })
  return defaultAccess
}

/** Модульные обёртки тех же проверок. */
export const scopeOf = (userId) => currentAccess().scopeOf(userId)
export const canRead = (userId, record) => currentAccess().canRead(userId, record)
export const canWrite = (userId, record) => currentAccess().canWrite(userId, record)
export const sharedScopes = (userId) => currentAccess().sharedScopes(userId)
export const canManageScope = (userId, scope) => currentAccess().canManageScope(userId, scope)

/**
 * Проставить `scope_id` записям, у которых его нет.
 *
 * Не пишет на диск: вызывающий сам решает, когда сохранять. Возвращает число
 * изменённых записей; повторный вызов на тех же данных вернёт 0.
 *
 * @param {object} access - результат {@link createAccess}.
 * @param {Array<{record: object, ownerId?: string|number}>} entries - записи и их владельцы.
 * @returns {number} сколько записей получило пространство.
 */
export function migrateScopeEntries(access, entries = []) {
  let migrated = 0
  for (const entry of entries) {
    const record = entry?.record
    const scopeId = record?.scope_id
    if (!record || (scopeId !== undefined && scopeId !== null && scopeId !== '')) continue
    const owner = entry.ownerId ?? scopeOwnerOf(record)
    if (owner === undefined || owner === null || owner === '') continue
    record.scope_id = access.scopeOf(owner).id
    migrated++
  }
  return migrated
}

/** Имя каталога миграции с отметкой времени без символов, недопустимых в пути. */
const migrationStamp = (now) => now.toISOString().replace(/[:.]/g, '-')

/**
 * Мигрировать существующие записи в личные пространства с копией файлов.
 *
 * Копия делается до первой мутации: каталог `backups/scope-migration-<дата>/`.
 * Если мигрировать нечего, копия не создаётся и файлы не переписываются — это и
 * есть идемпотентность.
 *
 * @param {object} options - параметры миграции.
 * @param {object} options.access - правила доступа.
 * @param {Array<object>} options.targets - `{ name, file, entries(), flush() }`.
 * @param {string} [options.backupDir] - куда класть копии; по умолчанию `backups/` рядом.
 * @param {object} [options.logger] - логгер.
 * @param {() => Date} [options.now] - часы для имени копии.
 * @returns {Promise<{migrated: number, backupDir?: string, files: string[]}>} отчёт.
 */
export async function migrateScopes({ access, targets = [], backupDir, logger, now = () => new Date() } = {}) {
  if (!access) throw new Error('migrateScopes: нужен access')

  /** Есть ли в цели записи без `scope_id`. */
  const pending = []
  for (const target of targets) {
    const entries = typeof target.entries === 'function' ? target.entries() : []
    if (entries.some((entry) => {
      const scopeId = entry?.record?.scope_id
      return Boolean(entry?.record) && (scopeId === undefined || scopeId === null || scopeId === '')
    })) {
      pending.push({ target, entries })
    }
  }
  if (pending.length === 0) return { migrated: 0, files: [] }

  const base = backupDir
    ?? (pending.find((item) => item.target.file)?.target.file
      ? path.join(path.dirname(pending.find((item) => item.target.file).target.file), 'backups')
      : path.join(process.cwd(), 'backups'))
  await fs.mkdir(base, { recursive: true })
  // `mkdtemp` не даёт двум миграциям, начатым в одну миллисекунду, перетереть
  // копии друг друга.
  const directory = await fs.mkdtemp(path.join(base, `scope-migration-${migrationStamp(now())}-`))

  const files = []
  for (const { target } of pending) {
    if (!target.file) continue
    const copy = path.join(directory, path.basename(target.file))
    try {
      await fs.copyFile(target.file, copy)
      files.push(copy)
    } catch (error) {
      // Отсутствующий файл — не ошибка: записи могли прийти из defaults.
      if (error?.code !== 'ENOENT') throw error
    }
  }

  let migrated = 0
  for (const { target, entries } of pending) {
    migrated += migrateScopeEntries(access, entries)
    await target.flush?.()
  }
  // Новые личные пространства обязаны сохраниться вместе с записями.
  await access.flush?.()

  logger?.info?.('scope migration complete', { migrated, backupDir: directory, files: files.length })
  return { migrated, backupDir: directory, files }
}
