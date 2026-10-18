/**
 * Per-user profiles: the durable facts a chat partner has shared, plus their
 * default city for weather.
 *
 * Design notes:
 *   - one JSON file written atomically, like the reminder store, so a restart
 *     never loses something the user was told was remembered;
 *   - facts are numbered per user and never renumbered, because `/forget 2` must
 *     keep pointing at the same fact after other facts are deleted;
 *   - the store is bounded (users and facts per user), so a hostile or merely
 *     chatty partner cannot grow the file without limit.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createJsonStore } from './storage/json-store.mjs'
import {
  DEFAULT_MAX_FACTS,
  DEFAULT_MAX_USERS,
  MAX_CITY_LENGTH,
  MAX_FACT_LENGTH,
  cleanCity,
  displayNameOf,
  factLimitError,
} from './domain/profiles.mjs'
import {
  MemorySecretError,
  REPLACEABLE_KINDS,
  cleanMemoryValue,
  compactTombstone,
  createMemoryRecord,
  detectSecretKind,
  inferMemoryKind,
  isActiveRecord,
  isTombstoned,
  migrateProfileMemory,
  needsRecordMigration,
  selectUsableRecords,
} from './memory.mjs'

const VERSION = 1

/** Один профиль. */
const emptyProfile = () => ({ city: undefined, persona: undefined, mood: undefined, facts: [], nextFactId: 1, updatedAt: new Date().toISOString() })

/**
 * Запись факта. Новый формат хранит `value`, старый — `text`; читаем оба, чтобы
 * файл пережил обновление и откат.
 */
const isFact = (value) => value != null && typeof value.id === 'string'
  && ((typeof value.text === 'string' && value.text.trim() !== '')
    || (typeof value.value === 'string' && value.value.trim() !== ''))

/** Предел компактных tombstone в одном файле профилей. */
const MAX_TOMBSTONES = 2000

/**
 * Миграция схемы профилей: файл без `version` считаем версией 0.
 * Форма данных не менялась, поэтому пользователи остаются как есть.
 */
function migrateProfiles(data) {
  return {
    ...data,
    users: data?.users != null && typeof data.users === 'object' ? data.users : {},
    // Tombstones появились в PLB-019; старый файл просто не имеет списка.
    tombstones: Array.isArray(data?.tombstones) ? data.tombstones : [],
  }
}

export class ProfileStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxUsers] - how many profiles to keep.
   * @param {number} [options.maxFacts] - facts allowed per user.
   * @param {object} [options.access] - единая проверка доступа (`src/core/access.mjs`).
   * @param {() => Date} [options.now] - часы, подменяются в тестах.
   */
  constructor({ file, logger, maxUsers = DEFAULT_MAX_USERS, maxFacts = DEFAULT_MAX_FACTS, access, now = () => new Date() }) {
    this.file = file
    this.logger = logger
    this.maxUsers = maxUsers
    this.maxFacts = maxFacts
    // Профиль человека — его личное пространство; access нужен для `scope_id`.
    this.access = access
    this.now = now
    /** @type {Map<string, {city?: string, facts: Array<object>, nextFactId: number, updatedAt: string}>} */
    this.users = new Map()
    /** Компактные tombstone: id, scopeId, deletedAt — без текста удалённой записи. */
    this.tombstoneList = []
    /** Последние записи, попавшие в контекст модели: `${userId}:${chatId}` → {ids, at}. */
    this.used = new Map()
    // Очередь записей: перекрывающиеся flush не должны перетирать снимки.
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { users: {}, tombstones: [] },
      migrate: migrateProfiles,
      logger,
    })
  }

  /** Number of known users. */
  get size() {
    return this.users.size
  }

  /** Прочитать файл через общий слой; битый файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      if (state.users == null || typeof state.users !== 'object') throw new Error('unexpected file format')
      this.tombstoneList = Array.isArray(state.tombstones) ? state.tombstones.map((stone) => compactTombstone(stone)).filter(Boolean) : []
      let migrationPending = false
      for (const [userId, profile] of Object.entries(state.users)) {
        const facts = Array.isArray(profile?.facts) ? profile.facts.filter(isFact) : []
        if (facts.some(needsRecordMigration)) migrationPending = true
        const highest = facts.reduce((max, fact) => Math.max(max, Number(fact.id) || 0), 0)
        this.users.set(String(userId), {
          city: typeof profile?.city === 'string' && profile.city.trim() !== '' ? profile.city.trim() : undefined,
          mode: typeof profile?.mode === 'string' && profile.mode.trim() !== '' ? profile.mode.trim() : undefined,
          persona: typeof profile?.persona === 'string' && profile.persona.trim() !== '' ? profile.persona.trim() : undefined,
          mood: typeof profile?.mood === 'string' && profile.mood.trim() !== '' ? profile.mood.trim() : undefined,
          firstName: typeof profile?.firstName === 'string' && profile.firstName.trim() !== '' ? profile.firstName.trim() : undefined,
          username: typeof profile?.username === 'string' && profile.username.trim() !== '' ? profile.username.trim() : undefined,
          facts,
          nextFactId: Math.max(Number(profile?.nextFactId) || 0, highest + 1),
          updatedAt: typeof profile?.updatedAt === 'string' ? profile.updatedAt : new Date().toISOString(),
          ...(typeof profile?.scope_id === 'string' ? { scope_id: profile.scope_id } : {}),
        })
      }
      if (migrationPending) await this.migrateMemoryRecords()
      this.logger?.info('profiles loaded', { users: this.users.size })
    } catch (error) {
      // Старое поведение: чужая версия схемы и ошибки чтения только логируются.
      this.logger?.warn('profile file ignored', { file: this.file, error })
    }
    return this
  }

  /**
   * Мигрировать старые факты в формат PLB-019.
   *
   * Копия файла делается до первой мутации. Если мигрировать нечего, повторный
   * запуск не создаёт вторую копию и ничего не переписывает — идемпотентность.
   */
  async migrateMemoryRecords() {
    // Ничего не мигрируем — не делаем и копию: повторный запуск не плодит бэкапы.
    const pending = [...this.users.values()].some((profile) => (profile.facts ?? []).some(needsRecordMigration))
    if (!pending) return { migrated: 0, backupDir: undefined }
    const backupDir = await this.backupBeforeMemoryMigration()
    let migrated = 0
    const at = this.now()
    for (const [userId, profile] of this.users) {
      const scopeId = profile.scope_id
        ?? (this.access ? this.access.scopeOf(userId).id : `personal-${userId}`)
      migrated += migrateProfileMemory(profile, { subjectId: userId, scopeId, now: at })
    }
    // Новые личные пространства обязаны сохраниться вместе с записями, но их
    // ошибка не должна отменять уже сделанную миграцию.
    try {
      await this.access?.flush?.()
    } catch (error) {
      this.logger?.warn?.('scope flush after memory migration failed', { error })
    }
    // Мигрированный формат обязан оказаться на диске, иначе следующий запуск
    // снова увидит старые записи и сделает вторую копию.
    if (migrated > 0) await this.flush()
    this.logger?.info?.('memory records migrated', { migrated, backupDir })
    return { migrated, backupDir }
  }

  /** Копия файла профилей в `backups/memory-migration-<дата>-<случайное>/`. */
  async backupBeforeMemoryMigration() {
    if (!this.file) return undefined
    const base = path.join(path.dirname(this.file), 'backups')
    try {
      await fs.mkdir(base, { recursive: true })
      const stamp = this.now().toISOString().replace(/[:.]/g, '-')
      const directory = await fs.mkdtemp(path.join(base, `memory-migration-${stamp}-`))
      const copy = path.join(directory, path.basename(this.file))
      await fs.copyFile(this.file, copy)
      this.logger?.info?.('memory migration backup made', { copy })
      return directory
    } catch (error) {
      // Отсутствующий файл — не ошибка: профиль мог прийти из defaults.
      if (error?.code !== 'ENOENT') this.logger?.warn?.('memory migration backup failed', { error })
      return undefined
    }
  }

  /** The profile of one user, created on demand. */
  get(userId) {
    const key = String(userId)
    let profile = this.users.get(key)
    if (!profile) {
      profile = emptyProfile()
      if (this.access) profile.scope_id = this.access.scopeOf(key).id
      this.users.set(key, profile)
    } else if (this.access && profile.scope_id === undefined) {
      // Старая запись до миграции: пространство владельца подставляется здесь же.
      profile.scope_id = this.access.scopeOf(key).id
    }
    return profile
  }

  /** Existing profile without creating one. */
  peek(userId) {
    return this.users.get(String(userId))
  }

  /** Default city of one user, if any. */
  city(userId) {
    return this.users.get(String(userId))?.city
  }

  /**
   * Remember the default city.
   *
   * @returns {{city: string, changed: boolean}} the stored city.
   */
  setCity(userId, city) {
    const clean = cleanCity(city)
    if (clean === '') throw new Error('city is required')
    if (clean.length > MAX_CITY_LENGTH) throw new Error('city name is too long')
    const profile = this.get(userId)
    const changed = profile.city !== clean
    profile.city = clean
    profile.updatedAt = new Date().toISOString()
    this.enforceBounds()
    return { city: clean, changed }
  }

  /** Answer mode of one user (set with `/mode`), if any. */
  mode(userId) {
    return this.users.get(String(userId))?.mode
  }

  /** The chosen character of one user (set with `/character`), if any. */
  persona(userId) {
    return this.users.get(String(userId))?.persona
  }

  /**
   * Set or clear the character.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} [value] - character name; empty returns to the default.
   * @returns {string|undefined} the stored character.
   */
  setPersona(userId, value) {
    const clean = String(value ?? '').trim()
    const profile = this.get(userId)
    profile.persona = clean === '' ? undefined : clean
    profile.updatedAt = new Date().toISOString()
    return profile.persona
  }

  /** The pinned mood of one user; undefined means the daily rotation decides. */
  mood(userId) {
    return this.users.get(String(userId))?.mood
  }

  /**
   * Pin or clear the mood.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} [value] - mood name; empty returns to the rotation.
   * @returns {string|undefined} the stored mood.
   */
  setMood(userId, value) {
    const clean = String(value ?? '').trim()
    const profile = this.get(userId)
    profile.mood = clean === '' ? undefined : clean
    profile.updatedAt = new Date().toISOString()
    return profile.mood
  }

  /**
   * Set or clear the answer mode.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} [value] - mode name; empty clears it.
   * @returns {string|undefined} the stored mode.
   */
  setMode(userId, value) {
    const clean = String(value ?? '').trim()
    const profile = this.get(userId)
    profile.mode = clean === '' ? undefined : clean
    profile.updatedAt = new Date().toISOString()
    return profile.mode
  }

  /** Forget the default city; returns whether there was one. */
  clearCity(userId) {
    const profile = this.users.get(String(userId))
    if (!profile?.city) return false
    profile.city = undefined
    profile.updatedAt = new Date().toISOString()
    return true
  }

  /**
   * Действующие факты одного пользователя в порядке добавления.
   *
   * Заменённые исправлением записи остаются в истории и здесь не показываются:
   * иначе старый адрес попал бы в контекст модели рядом с новым.
   */
  facts(userId) {
    return (this.users.get(String(userId))?.facts ?? [])
      .filter(isActiveRecord)
      .map((fact) => ({ ...fact }))
  }

  /** Все записи, включая заменённые: история исправлений и повторная индексация. */
  memoryRecords(userId) {
    return (this.users.get(String(userId))?.facts ?? []).map((fact) => ({ ...fact }))
  }

  /**
   * Добавить запись памяти.
   *
   * Точный повтор не создаётся. Для заменяемых видов (имя, адрес, работа,
   * возраст, предпочтение, здоровье) новый факт заменяет старый: старая запись
   * помечается заменённой и остаётся в истории, но не в контексте модели.
   *
   * @param {string|number} userId - владелец профиля.
   * @param {string} text - короткий факт («его зовут Андрей»).
   * @param {object} [options] - `scopeId`, `kind`, `sourceRef`,
   *   `confirmationStatus`, `expiresAt`, `validFrom`, `supersedesId`.
   * @returns {{fact: object, duplicate: boolean, superseded?: object}} запись.
   */
  addFact(userId, text, options = {}) {
    const clean = cleanMemoryValue(text)
    if (clean === '') throw new Error('fact text is required')
    if (clean.length > MAX_FACT_LENGTH) throw new Error(`fact is too long (max ${MAX_FACT_LENGTH} characters)`)
    // Секрет не становится записью и не попадает в журнал: проверка идёт до
    // создания профиля, поэтому отклонённый текст не оставляет следов.
    if (detectSecretKind(clean)) throw new MemorySecretError()
    const profile = this.get(userId)
    // Область и субъект записи фиксируются до поиска дубля: личный факт и факт
    // проекта с тем же текстом — разные записи, а не одна.
    const scopeId = options.scopeId ?? profile.scope_id ?? `personal-${userId}`
    const scopeOf = (fact) => String(fact?.scopeId ?? fact?.scope_id ?? profile.scope_id ?? `personal-${userId}`)
    const inSameArea = (fact) => scopeOf(fact) === String(scopeId)
      && String(fact?.subjectId ?? userId) === String(userId)
    const active = profile.facts.filter(isActiveRecord)
    const existing = active.find((fact) => inSameArea(fact)
      && String(fact.value ?? fact.text).toLowerCase() === clean.toLowerCase())
    if (existing) return { fact: { ...existing }, duplicate: true }
    const now = this.now()
    const kind = options.kind ?? inferMemoryKind(clean)
    let superseded
    let supersedesId
    if (options.supersedesId !== undefined && options.supersedesId !== null && options.supersedesId !== '') {
      // Явная замена разрешена только внутри той же области и субъекта: иначе
      // одна область помечала бы заменённой запись другой.
      const target = profile.facts.find((fact) => String(fact.id) === String(options.supersedesId))
      if (target && inSameArea(target)) {
        superseded = target
        supersedesId = target.id
      }
    } else if (REPLACEABLE_KINDS.includes(kind)) {
      superseded = active.find((fact) => inSameArea(fact)
        && (fact.kind ?? inferMemoryKind(fact.value ?? fact.text)) === kind)
    }
    // Замена освобождает слот: иначе исправление последнего факта упиралось бы
    // в предел и не сохранялось.
    const activeAfter = active.length - (superseded && isActiveRecord(superseded) ? 1 : 0)
    if (activeAfter >= this.maxFacts) throw new Error(factLimitError(this.maxFacts))
    const fact = createMemoryRecord({
      id: String(profile.nextFactId++),
      subjectId: userId,
      scopeId,
      value: clean,
      kind,
      sourceRef: options.sourceRef ?? 'user',
      confirmationStatus: options.confirmationStatus ?? 'confirmed',
      validFrom: options.validFrom,
      expiresAt: options.expiresAt,
      supersedesId,
      now,
    })
    if (superseded && isActiveRecord(superseded)) {
      superseded.replacedAt = fact.createdAt
      superseded.replacedBy = fact.id
      fact.supersedesId = superseded.id
    }
    profile.facts.push(fact)
    profile.updatedAt = fact.createdAt
    this.enforceBounds()
    return { fact: { ...fact }, duplicate: false, ...(superseded ? { superseded: { ...superseded } } : {}) }
  }

  /** Изменить запись по id (служебные отметки истории исправлений). */
  updateFact(userId, id, patch = {}) {
    const profile = this.users.get(String(userId))
    const record = profile?.facts.find((fact) => String(fact.id) === String(id))
    if (!record) return undefined
    Object.assign(record, patch)
    profile.updatedAt = this.now().toISOString()
    return { ...record }
  }

  /**
   * Отменить исправление: вернуть заменённую запись, а замену оставить в истории.
   *
   * Данные доступны, пока исходная запись не удалена. После `/forget` отмена
   * невозможна — поэтому и tombstone, и физическое удаление.
   */
  undoCorrection(userId, id) {
    const profile = this.users.get(String(userId))
    const record = profile?.facts.find((fact) => String(fact.id) === String(id) && isActiveRecord(fact))
    if (!record || !record.supersedesId) return { ok: false, reason: 'not-found' }
    const previous = profile.facts.find((fact) => String(fact.id) === String(record.supersedesId))
    if (!previous || isTombstoned(this.tombstoneList, previous.id, previous.scopeId)) {
      return { ok: false, reason: 'deleted' }
    }
    const at = this.now().toISOString()
    record.replacedAt = at
    record.replacedBy = previous.id
    record.revertedAt = at
    delete previous.replacedAt
    delete previous.replacedBy
    profile.updatedAt = at
    return { ok: true, record: { ...record }, restored: { ...previous } }
  }

  /** Удалить запись по номеру и оставить tombstone без текста. */
  removeFact(userId, id) {
    const profile = this.users.get(String(userId))
    if (!profile) return undefined
    const index = profile.facts.findIndex((fact) => fact.id === String(id))
    if (index === -1) return undefined
    const [removed] = profile.facts.splice(index, 1)
    // Tombstone фиксирует только идентичность удалённого, не его текст.
    this.addTombstone(removed.id, removed.scopeId ?? profile.scope_id ?? `personal-${userId}`)
    profile.updatedAt = this.now().toISOString()
    return { ...removed }
  }

  /** Удалить все записи (включая историю исправлений); вернуть число действующих. */
  clearFacts(userId) {
    const profile = this.users.get(String(userId))
    if (!profile || profile.facts.length === 0) return 0
    const count = profile.facts.filter(isActiveRecord).length
    const scopeId = profile.scope_id ?? `personal-${userId}`
    for (const fact of profile.facts) this.addTombstone(fact.id, fact.scopeId ?? scopeId)
    profile.facts = []
    profile.updatedAt = this.now().toISOString()
    return count
  }

  /** Добавить компактный tombstone; текст записи сюда не передаётся. */
  addTombstone(id, scopeId, deletedAt = this.now().toISOString()) {
    const stone = compactTombstone({ id, scopeId, deletedAt })
    if (!stone) return undefined
    const exists = this.tombstoneList.some((item) => item.id === stone.id
      && (scopeId === undefined || item.scopeId === stone.scopeId))
    if (!exists) this.tombstoneList.push(stone)
    if (this.tombstoneList.length > MAX_TOMBSTONES) this.tombstoneList.splice(0, this.tombstoneList.length - MAX_TOMBSTONES)
    return { ...stone }
  }

  /** Копия списка tombstone: только id, область и дата. */
  tombstones() {
    return this.tombstoneList.map((stone) => ({ ...stone }))
  }

  /** Запрещён ли id в этой области после удаления. */
  isTombstoned(id, scopeId) {
    return isTombstoned(this.tombstoneList, id, scopeId)
  }

  /**
   * Граница индексации: старый снимок индекса не возвращает удалённую запись,
   * а заменённая запись не подменяет действующую.
   */
  reindex(records = [], { userId, scopeId } = {}) {
    if (!Array.isArray(records)) return []
    const profile = userId === undefined ? undefined : this.users.get(String(userId))
    return records.filter((record) => {
      if (!record || record.id === undefined) return false
      if (isTombstoned(this.tombstoneList, record.id, record.scopeId ?? scopeId)) return false
      if (!profile) return true
      const current = profile.facts.find((fact) => String(fact.id) === String(record.id))
      return !current || isActiveRecord(current)
    }).map((record) => ({ ...record }))
  }

  /** Запомнить, какие записи попали в последний контекст модели. */
  markUsed(userId, ids = [], { chatId } = {}) {
    if (ids.length === 0) return
    this.used.set(`${String(userId)}:${chatId === undefined ? '*' : String(chatId)}`, {
      ids: ids.map(String),
      at: this.now().toISOString(),
    })
  }

  /** Последние использованные записи для `/memory why`. */
  lastUsed(userId, { chatId } = {}) {
    return this.used.get(`${String(userId)}:${chatId === undefined ? '*' : String(chatId)}`)
      ?? this.used.get(`${String(userId)}:*`)
  }

  /**
   * What the model should know about this user, or `undefined` when nothing is.
   *
   * Facts are numbered exactly as `/memory` lists them, so the model can refer to
   * a number the user sees, and `/forget N` always means the same thing.
   *
   * В контекст попадает только действующая область: активный проект чата или
   * личная память. Истёкшие записи и заменённые исправлением не передаются.
   */
  summary(userId, options = {}) {
    const profile = this.users.get(String(userId))
    if (!profile) return undefined
    let scopeId = options.scopeId
    if (scopeId === undefined && this.access && options.chatId !== undefined) {
      scopeId = this.access.activeScope?.(userId, options.chatId)?.id
    }
    if (scopeId === undefined) {
      scopeId = profile.scope_id ?? (this.access ? this.access.scopeOf(userId).id : `personal-${userId}`)
    }
    if (this.access?.canReadScope && !this.access.canReadScope(userId, scopeId)) {
      // Личное пространство могло ещё не попасть в файл пространств, но его id
      // предсказуем: свои личные факты человек видит и после рестарта.
      if (String(scopeId) !== `personal-${userId}`) return undefined
    }
    const scope = this.access?.scopes?.get?.(scopeId)
    // Город — личная настройка; в общем проекте он не нужен и не должен утекать.
    const personal = scope === undefined || scope.kind === 'personal'
    const records = selectUsableRecords(profile.facts, { scopeId, now: this.now() })
    const parts = []
    if (personal && profile.city) parts.push(`город по умолчанию — ${profile.city}`)
    for (const fact of records) parts.push(`№${fact.id}: ${fact.value ?? fact.text}`)
    if (parts.length === 0) return undefined
    if (records.length > 0) this.markUsed(userId, records.map((fact) => fact.id), { chatId: options.chatId })
    return `Что известно об этом пользователе (помни это и не переспрашивай): ${parts.join('; ')}.`
  }

  /**
   * Remember the public Telegram name of a user.
   *
   * This is what lets the bot tell participants apart in a group without asking
   * anybody anything: the name is public in the chat anyway.
   *
   * @returns {boolean} whether anything changed.
   */
  touch(userId, { firstName, username } = {}) {
    const name = String(firstName ?? '').trim()
    const handle = String(username ?? '').trim().replace(/^@/, '')
    if (name === '' && handle === '') return false
    const profile = this.get(userId)
    let changed = false
    if (name !== '' && profile.firstName !== name) {
      profile.firstName = name
      changed = true
    }
    if (handle !== '' && profile.username !== handle) {
      profile.username = handle
      changed = true
    }
    if (changed) profile.updatedAt = new Date().toISOString()
    return changed
  }

  /**
   * How to address this user: a remembered name beats the Telegram name.
   *
   * @returns {string|undefined} the name, when one is known.
   */
  displayName(userId) {
    // Правило «запомненное имя важнее имени из мессенджера» живёт в домене.
    return displayNameOf(this.users.get(String(userId)))
  }

  /** Drop the oldest profiles once the store is over its limit. */
  enforceBounds() {
    if (this.users.size <= this.maxUsers) return 0
    const ordered = [...this.users.entries()].sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)))
    let dropped = 0
    for (const [key] of ordered) {
      if (this.users.size <= this.maxUsers) break
      this.users.delete(key)
      dropped++
    }
    if (dropped > 0) this.logger?.warn('profiles dropped to stay within the limit', { dropped, maxUsers: this.maxUsers })
    return dropped
  }

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    // Записи выполняются по очереди, чтобы поздний снимок не затёрся ранним.
    this.writing = this.writing.then(async () => {
      try {
        const users = Object.fromEntries(
          [...this.users.entries()].map(([key, profile]) => [key, {
            ...(profile.city ? { city: profile.city } : {}),
            ...(profile.mode ? { mode: profile.mode } : {}),
            ...(profile.persona ? { persona: profile.persona } : {}),
            ...(profile.mood ? { mood: profile.mood } : {}),
            ...(profile.firstName ? { firstName: profile.firstName } : {}),
            ...(profile.username ? { username: profile.username } : {}),
            nextFactId: profile.nextFactId,
            facts: profile.facts,
            updatedAt: profile.updatedAt,
            ...(profile.scope_id === undefined ? {} : { scope_id: profile.scope_id }),
          }]),
        )
        this.storage.state.users = users
        // Tombstone без текста — часть того же файла, поэтому рестарт не
        // возвращает удалённые записи.
        this.storage.state.tombstones = this.tombstoneList
        await this.storage.flush()
      } catch (error) {
        this.logger?.error('profile save failed', { error })
      }
    })
    return this.writing
  }
}

export { MAX_FACT_LENGTH }
