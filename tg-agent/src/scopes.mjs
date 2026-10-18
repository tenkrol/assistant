/**
 * Пространства данных (scope): личное у каждого человека и общие проекты.
 *
 * Зачем: раньше изоляция была только по `chatId`/`userId`, поэтому у семьи не
 * было способа вести общее дело. Теперь у каждой записи есть `scope_id`, а здесь
 * живут сами пространства, их участники и роли.
 *
 * Решения:
 *  - личное пространство создаётся при первом обращении и имеет предсказуемый
 *    id `personal-<userId>`, поэтому его не нужно искать перебором;
 *  - общий проект создаётся только явно и получает id `project-<номер>`;
 *  - роли MVP: `owner` (управляет и пишет), `editor` (пишет), `viewer` (читает);
 *  - `status: 'archived'` оставляет историю доступной, но запрещает изменения;
 *  - активный проект хранится отдельно для пары «пользователь + чат», чтобы
 *    команда `/project use` не меняла область у другого человека.
 *
 * Файл пишется через общий слой состояния: атомарно, под замком и с версией.
 */
import { createJsonStore } from './storage/json-store.mjs'

const VERSION = 1
/** Роли, которые понимает MVP. */
export const SCOPE_ROLES = ['owner', 'editor', 'viewer']
/** Статусы пространства. */
export const SCOPE_STATUSES = ['active', 'archived']

/** Роль допустима? */
export const isScopeRole = (role) => SCOPE_ROLES.includes(role)

/** Пространство в хранимой форме. */
const isScope = (value) =>
  value != null
  && typeof value.id === 'string'
  && value.id !== ''
  && (value.kind === 'personal' || value.kind === 'shared')
  && typeof value.title === 'string'
  && value.ownerId !== undefined
  && Array.isArray(value.members)
  && value.members.every((member) => member != null && member.userId !== undefined && isScopeRole(member.role))
  && (value.status === undefined || SCOPE_STATUSES.includes(value.status))
  && (value.version === undefined || Number.isFinite(Number(value.version)))
  && (value.createdAt === undefined || typeof value.createdAt === 'string')

/** Привести запись к полной форме, не потеряв данные. */
function normalizeScope(value) {
  return {
    id: String(value.id),
    kind: value.kind,
    title: String(value.title).trim() || (value.kind === 'personal' ? 'Личное' : 'Проект'),
    ownerId: value.ownerId,
    members: value.members.map((member) => ({ userId: member.userId, role: member.role })),
    status: value.status ?? 'active',
    version: Number(value.version) || 1,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }
}

/** Миграция файла пространств: старые/битые записи не должны ронять загрузку. */
function migrateScopes(data) {
  return {
    ...data,
    scopes: data?.scopes != null && typeof data.scopes === 'object' ? data.scopes : {},
    active: data?.active != null && typeof data.active === 'object' ? data.active : {},
    nextProjectId: Number(data?.nextProjectId) || 1,
  }
}

/** Наибольший номер общего проекта в наборе записей. */
function highestProjectNumber(scopes) {
  let highest = 0
  for (const scope of scopes) {
    const match = /^project-(\d+)$/.exec(String(scope.id))
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/** Совместимая фабрика: `createScopeStore({ file, logger })`. */
export const createScopeStore = (options = {}) => new ScopeStore(options)

export class ScopeStore {
  /**
   * @param {object} options - `file`, `logger`, `now`.
   * @param {string} options.file - JSON-файл пространств.
   * @param {object} [options.logger] - логгер с info/warn/error.
   * @param {() => Date} [options.now] - часы (подменяются в тестах).
   */
  constructor({ file, logger, now = () => new Date() } = {}) {
    this.file = file
    this.logger = logger
    this.now = now
    /** @type {Map<string, object>} */
    this.scopes = new Map()
    /** Чат → пользователь → id активного проекта. */
    this.active = new Map()
    this.nextProjectId = 1
    // Очередь записей: поздний снимок не должен затирать ранний.
    this.writing = Promise.resolve()
    // Без файла хранилище живёт только в памяти: это удобно для проверок и
    // модульных обёрток, но бот всегда передаёт путь.
    this.storage = file
      ? createJsonStore({
        file,
        version: VERSION,
        defaults: { scopes: {}, active: {}, nextProjectId: 1 },
        migrate: migrateScopes,
        logger,
      })
      : undefined
  }

  /** Прочитать файл через общий слой; битый или чужой файл не роняет бота. */
  async load() {
    if (!this.storage) return this
    try {
      const state = await this.storage.load()
      this.scopes.clear()
      const raw = state.scopes != null && typeof state.scopes === 'object' ? state.scopes : {}
      for (const [id, value] of Object.entries(raw)) {
        if (!isScope(value)) continue
        this.scopes.set(String(value.id ?? id), normalizeScope({ ...value, id: String(value.id ?? id) }))
      }
      this.active.clear()
      const active = state.active != null && typeof state.active === 'object' ? state.active : {}
      for (const [chatId, byUser] of Object.entries(active)) {
        if (byUser == null || typeof byUser !== 'object') continue
        const normalized = {}
        for (const [userId, scopeId] of Object.entries(byUser)) {
          if (typeof scopeId === 'string' && scopeId !== '') normalized[userId] = scopeId
        }
        if (Object.keys(normalized).length > 0) this.active.set(chatId, normalized)
      }
      this.nextProjectId = Math.max(
        Number(state.nextProjectId) || 1,
        highestProjectNumber(this.scopes.values()) + 1,
      )
      this.logger?.info?.('scopes loaded', { scopes: this.scopes.size, activeChats: this.active.size })
    } catch (error) {
      // Как у остальных хранилищ: чужая версия схемы только логируется.
      this.logger?.warn?.('scope file ignored', { file: this.file, error: error?.message ?? error })
    }
    return this
  }

  /** Одно пространство по id. */
  get(id) {
    return id === undefined || id === null ? undefined : this.scopes.get(String(id))
  }

  /** Все пространства (копии, чтобы вызывающий не менял хранилище). */
  list() {
    return [...this.scopes.values()].map((scope) => ({ ...scope, members: scope.members.map((member) => ({ ...member })) }))
  }

  /**
   * Личное пространство человека; создаётся при первом обращении.
   *
   * @param {string|number} userId - владелец.
   * @returns {object} пространство.
   */
  personal(userId) {
    if (userId === undefined || userId === null) throw new Error('scope: не задан пользователь')
    const key = String(userId)
    const existing = [...this.scopes.values()].find(
      (scope) => scope.kind === 'personal' && String(scope.ownerId) === key,
    )
    if (existing) return existing
    const scope = {
      id: `personal-${key}`,
      kind: 'personal',
      title: 'Личное',
      ownerId: userId,
      members: [{ userId, role: 'owner' }],
      status: 'active',
      version: 1,
      createdAt: this.now().toISOString(),
    }
    this.scopes.set(scope.id, scope)
    return scope
  }

  /**
   * Создать общий проект. Личные пространства так не создаются.
   *
   * @param {object} input - `title`, `ownerId`.
   * @returns {object} созданное пространство.
   */
  create({ title, ownerId } = {}) {
    const clean = String(title ?? '').trim().slice(0, 120)
    if (ownerId === undefined || ownerId === null) throw new Error('scope: не задан владелец')
    if (clean === '') throw new Error('scope: нужно название проекта')
    const id = `project-${this.nextProjectId++}`
    const scope = {
      id,
      kind: 'shared',
      title: clean,
      ownerId,
      members: [{ userId: ownerId, role: 'owner' }],
      status: 'active',
      version: 1,
      createdAt: this.now().toISOString(),
    }
    this.scopes.set(id, scope)
    return scope
  }

  /** Участник пространства или `undefined`. */
  member(scopeId, userId) {
    const scope = this.get(scopeId)
    if (!scope || userId === undefined || userId === null) return undefined
    return scope.members.find((item) => String(item.userId) === String(userId))
  }

  /**
   * Добавить участника или сменить его роль.
   *
   * @param {string} scopeId - проект.
   * @param {string|number} userId - приглашённый.
   * @param {string} [role] - `editor` (по умолчанию) или `viewer`.
   * @returns {object|undefined} участник либо undefined для неизвестного проекта.
   */
  invite(scopeId, userId, role = 'editor') {
    const scope = this.get(scopeId)
    if (!scope) return undefined
    if (userId === undefined || userId === null) throw new Error('scope: не задан участник')
    if (!isScopeRole(role) || role === 'owner') throw new Error('scope: недопустимая роль')
    const known = scope.members.find((item) => String(item.userId) === String(userId))
    if (known) return known
    const member = { userId, role }
    scope.members.push(member)
    return member
  }

  /** Сменить роль участника (владельца не трогаем). */
  setRole(scopeId, userId, role) {
    const member = this.member(scopeId, userId)
    if (!member) return undefined
    if (!isScopeRole(role) || role === 'owner' || member.role === 'owner') return undefined
    member.role = role
    return member
  }

  /** Убрать участника; владельца убрать нельзя. */
  removeMember(scopeId, userId) {
    const scope = this.get(scopeId)
    if (!scope) return undefined
    const index = scope.members.findIndex((item) => String(item.userId) === String(userId))
    if (index === -1) return undefined
    if (scope.members[index].role === 'owner' || String(scope.ownerId) === String(userId)) return undefined
    const [removed] = scope.members.splice(index, 1)
    return removed
  }

  /** Перевести проект в архив; история остаётся доступной. */
  archive(scopeId) {
    const scope = this.get(scopeId)
    if (!scope) return undefined
    scope.status = 'archived'
    // Архивный проект не должен оставаться активным ни у кого.
    for (const byUser of this.active.values()) {
      for (const [userId, activeId] of Object.entries(byUser)) {
        if (activeId === scope.id) delete byUser[userId]
      }
    }
    return scope
  }

  /** id активного проекта пользователя в этом чате. */
  activeScopeId(userId, chatId) {
    const scopeId = this.active.get(String(chatId))?.[String(userId)]
    const scope = this.get(scopeId)
    // Архивный проект не бывает активной областью записи.
    return scope && scope.status === 'active' ? scope.id : undefined
  }

  /** Запомнить активный проект пары «пользователь + чат»; пустое значение сбрасывает. */
  setActive(userId, chatId, scopeId) {
    if (userId === undefined || userId === null || chatId === undefined || chatId === null) return undefined
    const chatKey = String(chatId)
    const userKey = String(userId)
    const byUser = this.active.get(chatKey) ?? {}
    if (scopeId === undefined || scopeId === null || scopeId === '') {
      delete byUser[userKey]
    } else {
      byUser[userKey] = String(scopeId)
    }
    if (Object.keys(byUser).length === 0) this.active.delete(chatKey)
    else this.active.set(chatKey, byUser)
    return byUser[userKey]
  }

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    if (!this.storage) return this.writing
    this.writing = this.writing.then(async () => {
      try {
        const scopes = {}
        for (const [id, scope] of this.scopes) scopes[id] = scope
        const active = {}
        for (const [chatId, byUser] of this.active) active[chatId] = byUser
        this.storage.state.scopes = scopes
        this.storage.state.active = active
        this.storage.state.nextProjectId = this.nextProjectId
        await this.storage.flush()
      } catch (error) {
        this.logger?.error?.('scope save failed', { error })
      }
    })
    return this.writing
  }
}
