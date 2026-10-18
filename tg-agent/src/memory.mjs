/**
 * Управляемая память (BP-02).
 *
 * Здесь живут правила записи памяти: что считается действующей записью, как
 * выбираются записи для контекста модели, как исправление заменяет старую
 * запись и как удаление оставляет компактный tombstone без текста.
 *
 * Модуль доменный: ни сети, ни Telegram, ни файлов. Хранилище приходит снаружи
 * (`ProfileStore`), а проверка доступа — из `src/core/access.mjs`. Это позволяет
 * одним и тем же правилам работать в командах, инструменте `remember`, мини-
 * приложении и при повторной индексации истории.
 *
 * Формат записи:
 *   { id, subjectId, scopeId, kind, value, sourceRef, confirmationStatus,
 *     validFrom, expiresAt, supersedesId, version }
 *
 * Для старых файлов рядом с `value` остаётся `text`: до PLB-019 это единственное
 * поле текста, и его читают старые команды, выгрузка и дайджест.
 */

/** Версия формата одной записи памяти. Версия файла профиля остаётся 1. */
export const MEMORY_RECORD_VERSION = 1

/** Сколько записей показываем на одной странице `/memory`. */
export const MEMORY_PAGE_SIZE = 10

/** Статусы подтверждения записи. */
export const MEMORY_STATUSES = ['confirmed', 'assumption', 'imported']

/**
 * Статусы, которые можно отдавать модели.
 *
 * `imported` — старый факт из версии до PLB-019: источник неизвестен, но текст
 * когда-то сохранил сам пользователь. Мы не выдаём его за подтверждённый (это
 * видно в `/memory why`), но и не теряем память при обновлении.
 */
export const RETRIEVAL_STATUSES = ['confirmed', 'assumption', 'imported']

/** Виды записей, у которых новый факт заменяет старый, а не копится рядом. */
export const REPLACEABLE_KINDS = ['name', 'address', 'job', 'age', 'preference', 'health']

/** Поля обязательного формата записи — по ним же идёт миграция. */
export const MEMORY_RECORD_FIELDS = [
  'id', 'subjectId', 'scopeId', 'kind', 'value', 'sourceRef',
  'confirmationStatus', 'validFrom', 'expiresAt', 'supersedesId', 'version',
]

/** Ошибка «в тексте похоже на секрет»; сообщение не повторяет значение. */
export class MemorySecretError extends Error {
  constructor() {
    super('secret-like text is not stored in memory')
    this.name = 'MemorySecretError'
    this.kind = 'secret'
  }
}

/** Объяснение для человека: что произошло и почему секрет не сохранён. */
export const SECRET_MEMORY_TEXT = 'Не сохранил: в тексте похоже на секрет — токен, пароль или ключ. Память не хранит секреты; сохраните их в менеджере паролей.'

/** Приводит текст записи к одному пробелу между словами. */
export function cleanMemoryValue(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Вид записи по тексту. Это не семантика, а узкая эвристика: она нужна только
 * затем, чтобы «переехал» заменял адрес, а не добавлял второй адрес рядом.
 *
 * @param {string} value - текст записи.
 * @returns {string} вид: name, address, job, age, preference, health или fact.
 */
export function inferMemoryKind(value) {
  const text = String(value ?? '').toLowerCase()
  if (/(?:его|её|ее|меня)\s+зовут|мо[её]\s+имя|\bимя\b/.test(text)) return 'name'
  if (/жив[уеё]т|живу|переехал|переехала|адрес|прожива|город/.test(text)) return 'address'
  if (/работает|работаю|профессия|должность/.test(text)) return 'job'
  if (/\b(?:лет|года|год)\b|возраст/.test(text)) return 'age'
  if (/любит|предпочита|нравится|не\s+любит|увлекается/.test(text)) return 'preference'
  if (/аллерг|вегетариан|болеет|диагноз|лекарств/.test(text)) return 'health'
  return 'fact'
}

/**
 * Похоже ли значение на секрет.
 *
 * Проверка намеренно узкая: лучше не сохранить безобидную строку, чем записать
 * пароль. Возвращается вид секрета, а не значение, — его можно писать в лог.
 *
 * @param {string} value - проверяемый текст.
 * @returns {string|null} вид секрета или null.
 */
export function detectSecretKind(value) {
  const text = String(value ?? '')
  const rules = [
    // Ключи известных сервисов и заголовки авторизации.
    ['token', /\bsk-[A-Za-z0-9_-]{12,}\b/],
    ['token', /\b(?:gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{12,}\b/],
    ['token', /\bAKIA[0-9A-Z]{16}\b/],
    ['token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i],
    ['key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    // Пароль, токен или ключ, названные словом и выданные значением.
    ['password', /(?:парол[ья]|password|passwd|pwd)\s*(?:[:=—–-]|\s)\s*\S{4,}/i],
    ['token', /(?:токен|token|api[-_ ]?key|секрет|secret|ключ)\s*(?:[:=—–-]|\s)\s*[A-Za-z0-9_./+-]{12,}/i],
  ]
  for (const [kind, pattern] of rules) {
    if (pattern.test(text)) return kind
  }
  // Длинная случайная строка без пробелов: типичный токен или ключ. Нужны и
  // буквы, и цифры — иначе обычное длинное слово или повтор буквы считались бы
  // секретом.
  const compact = text.trim()
  if (compact.length >= 32 && !/\s/.test(compact) && /[A-Za-z]/.test(compact) && /\d/.test(compact)) return 'token'
  return null
}

/** Бросает {@link MemorySecretError}, когда текст похож на секрет. */
export function assertNoSecret(value) {
  if (detectSecretKind(value)) throw new MemorySecretError()
}

/**
 * Компактный tombstone: id, область и дата удаления. Текста здесь нет и быть
 * не должно — иначе удалённое значение оставалось бы в файле.
 */
export function compactTombstone({ id, scopeId, deletedAt } = {}) {
  if (id === undefined || id === null || String(id) === '') return undefined
  if (scopeId === undefined || scopeId === null || String(scopeId) === '') return undefined
  return {
    id: String(id),
    scopeId: String(scopeId),
    deletedAt: typeof deletedAt === 'string' && deletedAt !== '' ? deletedAt : new Date().toISOString(),
  }
}

/** Есть ли tombstone для записи в этой области. */
export function isTombstoned(tombstones = [], id, scopeId) {
  if (id === undefined || id === null) return false
  const key = String(id)
  return tombstones.some((stone) => stone && String(stone.id) === key
    && (scopeId === undefined || scopeId === null || stone.scopeId === undefined || String(stone.scopeId) === String(scopeId)))
}

/** Активна ли запись: не заменена и не удалена. */
export function isActiveRecord(record) {
  return Boolean(record) && record.replacedAt === undefined && record.deletedAt === undefined
}

/** Истёк ли срок записи на момент `now`. */
export function isExpiredRecord(record, now = new Date()) {
  if (!record?.expiresAt) return false
  const at = Date.parse(record.expiresAt)
  return Number.isFinite(at) && at <= now.getTime()
}

/** Начался ли срок действия записи. */
export function hasStartedRecord(record, now = new Date()) {
  if (!record?.validFrom) return true
  const at = Date.parse(record.validFrom)
  return !Number.isFinite(at) || at <= now.getTime()
}

/**
 * Можно ли отдавать запись модели: активная, разрешённого статуса, начавшаяся и
 * не истёкшая.
 */
export function isUsableRecord(record, now = new Date()) {
  if (!isActiveRecord(record)) return false
  if (!RETRIEVAL_STATUSES.includes(record.confirmationStatus ?? 'imported')) return false
  if (!hasStartedRecord(record, now)) return false
  return !isExpiredRecord(record, now)
}

/**
 * Выбрать записи одной области для контекста модели.
 *
 * Конфликты не сливаются: записи с заменяемыми видами дедуплицируются по
 * `supersedesId`/дате, поэтому в промпт попадает только действующая. Записи без
 * `scopeId` (старый формат) считаются принадлежащими выбранной области, пока
 * миграция не проставила поле.
 *
 * @param {Array<object>} records - все записи профиля, включая заменённые.
 * @param {object} [options] - `scopeId`, `now`.
 * @returns {Array<object>} действующие записи в порядке добавления.
 */
export function selectUsableRecords(records = [], { scopeId, now = new Date() } = {}) {
  const selected = []
  for (const record of records) {
    if (!record) continue
    if (scopeId !== undefined && scopeId !== null && record.scopeId !== undefined && String(record.scopeId) !== String(scopeId)) continue
    if (!isUsableRecord(record, now)) continue
    selected.push(record)
  }
  // Один действующий адрес, имя и т.п.: если старый формат оставил два активных
  // факта одного вида, побеждает более поздний, а не оба сразу.
  const byKind = new Map()
  const result = []
  for (const record of selected) {
    if (!REPLACEABLE_KINDS.includes(record.kind ?? inferMemoryKind(record.value ?? record.text))) {
      result.push(record)
      continue
    }
    const previous = byKind.get(record.kind)
    if (previous) {
      const prevAt = Date.parse(previous.validFrom ?? previous.createdAt ?? '') || 0
      const nextAt = Date.parse(record.validFrom ?? record.createdAt ?? '') || 0
      if (nextAt >= prevAt) {
        byKind.set(record.kind, record)
        const index = result.indexOf(previous)
        if (index !== -1) result.splice(index, 1, record)
      }
      continue
    }
    byKind.set(record.kind, record)
    result.push(record)
  }
  return result
}

/**
 * Отфильтровать кандидатов повторной индексации по tombstone.
 *
 * Индекс может быть старым и содержать уже удалённую запись; tombstone не даёт
 * ей вернуться в контекст после рестарта.
 */
export function filterTombstoned(records = [], tombstones = [], { scopeId } = {}) {
  return records.filter((record) => record && !isTombstoned(tombstones, record.id, record.scopeId ?? scopeId))
}

/**
 * Собрать запись памяти в каноническом формате.
 *
 * @param {object} options - поля записи и часы.
 * @returns {object} запись с legacy-полями `text` и `scope_id`.
 */
export function createMemoryRecord({
  id,
  subjectId,
  scopeId,
  value,
  kind,
  sourceRef = 'user',
  confirmationStatus = 'confirmed',
  validFrom,
  expiresAt = null,
  supersedesId = null,
  createdAt,
  now = new Date(),
}) {
  const stamp = (validFrom ?? createdAt ?? now).toISOString?.() ?? String(validFrom ?? createdAt ?? now)
  const text = cleanMemoryValue(value)
  const scope = String(scopeId)
  return {
    id: String(id),
    subjectId: String(subjectId),
    scopeId: scope,
    kind: kind ?? inferMemoryKind(text),
    value: text,
    sourceRef: typeof sourceRef === 'string' && sourceRef !== '' ? sourceRef : 'user',
    confirmationStatus: MEMORY_STATUSES.includes(confirmationStatus) ? confirmationStatus : 'confirmed',
    validFrom: stamp,
    expiresAt: typeof expiresAt === 'string' && expiresAt !== '' ? expiresAt : null,
    supersedesId: supersedesId === undefined || supersedesId === null || supersedesId === '' ? null : String(supersedesId),
    version: MEMORY_RECORD_VERSION,
    // Совместимость со старыми читателями: текст и `scope_id` из PLB-018.
    text,
    scope_id: scope,
    createdAt: createdAt === undefined ? stamp : String(createdAt),
  }
}

/**
 * Нужна ли записи миграция в новый формат.
 *
 * @param {object} record - запись из файла профиля.
 * @returns {boolean} true, если не хватает хотя бы одного нового поля.
 */
export function needsRecordMigration(record) {
  if (!record) return false
  return MEMORY_RECORD_FIELDS.some((field) => record[field] === undefined)
    || typeof record.value !== 'string'
    || typeof record.text !== 'string'
}

/**
 * Мигрировать одну старую запись на месте.
 *
 * Старый факт получает `confirmationStatus: imported` и `sourceRef: unknown`:
 * мы не знаем, откуда он взялся, и не выдаём его за подтверждённый.
 *
 * @returns {boolean} изменилась ли запись.
 */
export function migrateMemoryRecord(record, { subjectId, scopeId, now = new Date() } = {}) {
  if (!needsRecordMigration(record)) return false
  const value = cleanMemoryValue(record.value ?? record.text)
  const stamp = record.createdAt ?? record.validFrom ?? now.toISOString()
  record.subjectId = record.subjectId ?? String(subjectId)
  record.scopeId = record.scopeId ?? record.scope_id ?? scopeId ?? `personal-${subjectId}`
  record.kind = record.kind ?? inferMemoryKind(value)
  record.value = value
  record.sourceRef = record.sourceRef ?? 'unknown'
  record.confirmationStatus = record.confirmationStatus ?? 'imported'
  record.validFrom = record.validFrom ?? stamp
  record.expiresAt = record.expiresAt ?? null
  record.supersedesId = record.supersedesId ?? null
  record.version = MEMORY_RECORD_VERSION
  // Старые читатели по-прежнему видят `text` и `scope_id`.
  record.text = record.text ?? value
  record.scope_id = record.scope_id ?? record.scopeId
  record.createdAt = record.createdAt ?? stamp
  return true
}

/** Мигрировать все факты одного профиля; возвращает число изменённых записей. */
export function migrateProfileMemory(profile, options = {}) {
  if (!profile || !Array.isArray(profile.facts)) return 0
  let migrated = 0
  for (const record of profile.facts) {
    if (migrateMemoryRecord(record, options)) migrated++
  }
  return migrated
}

/** Человеческое описание источника записи для `/memory why` и истории. */
export function describeSource(record) {
  const status = record?.confirmationStatus ?? 'imported'
  if (status === 'assumption') return 'это предположение, подтверждения нет'
  if (status === 'imported') return 'источник неизвестен (запись импортирована из старой версии)'
  const ref = String(record?.sourceRef ?? '')
  if (ref.startsWith('telegram:message:')) return 'сообщение пользователя в этом чате'
  if (ref.startsWith('telegram:chat:')) return 'сообщение пользователя в этом чате'
  if (ref === 'agent' || ref.startsWith('agent:')) return 'предложение агента, без подтверждения пользователя'
  if (ref === 'user' || ref === 'unknown') return 'сообщение пользователя'
  return `источник: ${ref}`
}

/** Оценка владения областью для истории исправлений. */
function isMemoryScopeOwner(access, userId, record) {
  if (!access) return String(record?.subjectId) === String(userId)
  const scoped = { ...record, scope_id: record.scopeId, userId: record.subjectId }
  const scope = access.scopeOfRecord?.(scoped)
  if (!scope) return String(record?.subjectId) === String(userId)
  if (scope.kind === 'personal') return String(scope.ownerId) === String(userId)
  return String(scope.ownerId) === String(userId) && access.canManageScope?.(userId, scope) !== false
}

/**
 * Собрать операции памяти поверх хранилища профилей.
 *
 * @param {object} options - `store`, `access`, `logger`, `now`.
 * @returns {object} list/remember/correct/forget/undo/history/export/select.
 */
export function createMemory({ store, access, logger, now = () => new Date() } = {}) {
  if (!store) throw new Error('memory: нужно хранилище профилей')

  const clock = () => (typeof now === 'function' ? now() : new Date())

  /** Все записи профиля, включая заменённые: только для истории и проверок. */
  function allRecords(userId) {
    if (typeof store.memoryRecords === 'function') return store.memoryRecords(userId)
    return store.facts?.(userId) ?? []
  }

  /** Действующие записи, как их видит пользователь. */
  function activeRecords(userId, { scopeId } = {}) {
    return allRecords(userId).filter((record) => isActiveRecord(record)
      && (scopeId === undefined || record.scopeId === undefined || String(record.scopeId) === String(scopeId)))
  }

  /** Можно ли менять запись в её области. */
  function canWrite(userId, record) {
    if (!access) return String(record.subjectId ?? userId) === String(userId)
    const scoped = { ...record, scope_id: record.scopeId, userId: record.subjectId ?? userId }
    if (typeof access.canWrite === 'function') return access.canWrite(userId, scoped)
    return access.canWriteScope?.(userId, record.scopeId) !== false
  }

  /** Область новой записи: явная, активный проект чата или личная. */
  function scopeFor(userId, { scopeId, chatId } = {}) {
    if (scopeId !== undefined && scopeId !== null && scopeId !== '') return String(scopeId)
    if (access && chatId !== undefined && typeof access.scopeIdFor === 'function') {
      return String(access.scopeIdFor(userId, chatId))
    }
    // `peek` не создаёт профиль: отклонённый текст (пустой, секрет) не должен
    // оставлять после себя пустую запись пользователя.
    const profile = typeof store.peek === 'function' ? store.peek(userId) : undefined
    return String(profile?.scope_id ?? `personal-${userId}`)
  }

  return {
    /**
     * Список действующих записей с пагинацией.
     *
     * @returns {{records: Array<object>, page: number, pages: number, total: number, scopeId?: string}}
     */
    list(userId, { scopeId, page = 1, pageSize = MEMORY_PAGE_SIZE, includeReplaced = false } = {}) {
      const records = (includeReplaced ? allRecords(userId) : activeRecords(userId, { scopeId }))
        .filter((record) => scopeId === undefined || record.scopeId === undefined || String(record.scopeId) === String(scopeId))
      const total = records.length
      const pages = Math.max(1, Math.ceil(total / pageSize))
      const current = Math.min(Math.max(1, Number(page) || 1), pages)
      const start = (current - 1) * pageSize
      return { records: records.slice(start, start + pageSize).map((record) => ({ ...record })), page: current, pages, total, ...(scopeId === undefined ? {} : { scopeId: String(scopeId) }) }
    },

    /**
     * Запомнить запись. Явная просьба сохраняется подтверждённой; предложение
     * модели обязано передать `confirmationStatus: 'assumption'`.
     *
     * @returns {{ok: boolean, record?: object, duplicate?: boolean, superseded?: object, text?: string}}
     */
    remember(userId, value, options = {}) {
      if (detectSecretKind(value)) return { ok: false, secret: true, text: SECRET_MEMORY_TEXT }
      const scopeId = scopeFor(userId, options)
      const result = store.addFact(userId, value, {
        ...options,
        scopeId,
        sourceRef: options.sourceRef ?? (options.chatId !== undefined ? `telegram:chat:${options.chatId}` : 'user'),
        confirmationStatus: options.confirmationStatus ?? 'confirmed',
        expiresAt: options.expiresAt ?? null,
      })
      // `record` — единое имя результата для correct/forget/remember.
      return { ok: true, ...result, record: result.fact }
    },

    /**
     * Исправить запись: старая помечается заменённой, новая становится активной.
     *
     * @returns {{ok: boolean, record?: object, previous?: object, text?: string, reason?: string}}
     */
    correct(userId, id, value, options = {}) {
      if (detectSecretKind(value)) return { ok: false, secret: true, text: SECRET_MEMORY_TEXT }
      const record = activeRecords(userId).find((item) => String(item.id) === String(id))
      if (!record) return { ok: false, reason: 'not-found' }
      if (!canWrite(userId, record)) return { ok: false, reason: 'forbidden' }
      const result = store.addFact(userId, value, {
        ...options,
        scopeId: options.scopeId ?? record.scopeId,
        kind: options.kind ?? record.kind,
        supersedesId: record.id,
        sourceRef: options.sourceRef ?? (options.chatId !== undefined ? `telegram:chat:${options.chatId}` : 'user'),
        confirmationStatus: options.confirmationStatus ?? 'confirmed',
        expiresAt: options.expiresAt ?? record.expiresAt ?? null,
      })
      return { ok: true, record: result.fact, previous: { ...record }, superseded: result.superseded }
    },

    /** Удалить запись и оставить tombstone без текста. */
    forget(userId, id, options = {}) {
      const record = activeRecords(userId).find((item) => String(item.id) === String(id))
      if (!record) return { ok: false, reason: 'not-found' }
      if (!canWrite(userId, record)) return { ok: false, reason: 'forbidden' }
      const removed = store.removeFact(userId, record.id)
      return removed ? { ok: true, record: removed } : { ok: false, reason: 'not-found' }
    },

    /** Отменить исправление, пока исходная запись не удалена. */
    undo(userId, id) {
      const record = allRecords(userId).find((item) => String(item.id) === String(id) && isActiveRecord(item))
      if (!record) return { ok: false, reason: 'not-found' }
      if (!canWrite(userId, record)) return { ok: false, reason: 'forbidden' }
      if (!record.supersedesId) return { ok: false, reason: 'not-a-correction' }
      const previous = allRecords(userId).find((item) => String(item.id) === String(record.supersedesId))
      if (!previous || store.isTombstoned?.(previous.id, previous.scopeId)) return { ok: false, reason: 'deleted' }
      if (typeof store.undoCorrection !== 'function') return { ok: false, reason: 'unsupported' }
      return store.undoCorrection(userId, record.id)
    },

    /** История записи: цепочка замен. Доступна только владельцу области. */
    history(userId, id, { requesterId = userId } = {}) {
      const target = allRecords(userId).find((record) => String(record.id) === String(id))
      if (!target) return { ok: false, reason: 'not-found' }
      if (!isMemoryScopeOwner(access, requesterId, target)) return { ok: false, reason: 'forbidden' }
      const chain = []
      // Поднимаемся от записи к тому, что она заменила.
      let cursor = target
      const seen = new Set()
      while (cursor && !seen.has(String(cursor.id))) {
        seen.add(String(cursor.id))
        chain.unshift({ ...cursor })
        cursor = cursor.supersedesId ? allRecords(userId).find((record) => String(record.id) === String(cursor.supersedesId)) : undefined
      }
      // И опускаемся к тому, что заменило её.
      let next = allRecords(userId).find((record) => String(record.supersedesId) === String(target.id))
      while (next && !seen.has(String(next.id))) {
        seen.add(String(next.id))
        chain.push({ ...next })
        next = allRecords(userId).find((record) => String(record.supersedesId) === String(next.id))
      }
      return { ok: true, history: chain, record: { ...target } }
    },

    /** Выгрузка действующих записей в чистом виде — без tombstone и служебных полей. */
    export(userId, { scopeId } = {}) {
      return activeRecords(userId, { scopeId }).map((record) => ({
        id: String(record.id),
        subjectId: String(record.subjectId ?? userId),
        scopeId: record.scopeId,
        kind: record.kind ?? inferMemoryKind(record.value ?? record.text),
        value: record.value ?? record.text,
        sourceRef: record.sourceRef ?? 'unknown',
        confirmationStatus: record.confirmationStatus ?? 'imported',
        validFrom: record.validFrom ?? record.createdAt,
        expiresAt: record.expiresAt ?? null,
        supersedesId: record.supersedesId ?? null,
        version: record.version ?? MEMORY_RECORD_VERSION,
      }))
    },

    /** Записи для контекста модели: только разрешённая область и действующие. */
    select(userId, { scopeId, chatId, at = clock() } = {}) {
      const scope = scopeFor(userId, { scopeId, chatId })
      return selectUsableRecords(allRecords(userId), { scopeId: scope, now: at })
        .map((record) => ({ ...record }))
    },

    /** Проверка перед повторной индексацией истории. */
    filterIndexed(records = [], { scopeId } = {}) {
      const tombstones = store.tombstones?.() ?? []
      return filterTombstoned(records, tombstones, { scopeId })
    },

    /** Итоговая проверка владения областью — для команд и тестов. */
    owns(userId, record) {
      return isMemoryScopeOwner(access, userId, record)
    },

    store,
  }
}
