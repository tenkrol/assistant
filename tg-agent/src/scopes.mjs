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
 *  - участник — это principal `<платформа>:<id>`: одинаковый числовой id в
 *    Telegram и VK обозначает разных людей;
 *  - приглашение (PLB-024) — отдельная сущность: до принятия получателем оно
 *    `pending` и в `members` не попадает, поэтому доступа не даёт;
 *  - `status: 'archived'` оставляет историю доступной, но запрещает изменения;
 *  - активный проект хранится отдельно для пары «пользователь + чат», чтобы
 *    команда `/project use` не меняла область у другого человека.
 *
 * Файл пишется через общий слой состояния: атомарно, под замком и с версией.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomInt } from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const VERSION = 1
/** Роли, которые понимает MVP. */
export const SCOPE_ROLES = ['owner', 'editor', 'viewer']
/** Статусы пространства. */
export const SCOPE_STATUSES = ['active', 'archived']
/** Статусы приглашения. */
export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'expired', 'revoked']
/** Срок жизни приглашения по умолчанию: 7 дней. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Алфавит кода без похожих символов (0/O, 1/I): код диктуют голосом. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
/** Явный principal: `telegram:7`, `vk:12345`. */
const PRINCIPAL_RE = /^([a-z][a-z0-9-]{0,31}):(.+)$/

/** Роль допустима? */
export const isScopeRole = (role) => SCOPE_ROLES.includes(role)

/**
 * Разобрать principal из проверенного контекста.
 *
 * Голый числовой id считается id текущей платформы: старые записи и команды
 * пришли из одного канала. Явный `<платформа>:<id>` не смешивается с ним.
 *
 * @param {string|number} value - id или principal.
 * @param {string} [platform] - платформа по умолчанию.
 * @returns {{platform: string, userId: string, principal: string}|undefined}
 */
export function parsePrincipal(value, platform = 'telegram') {
  if (value === undefined || value === null) return undefined
  const raw = String(value).trim()
  if (raw === '') return undefined
  const explicit = PRINCIPAL_RE.exec(raw)
  if (explicit) {
    return { platform: explicit[1].toLowerCase(), userId: explicit[2], principal: `${explicit[1].toLowerCase()}:${explicit[2]}` }
  }
  const channel = String(platform || 'telegram').toLowerCase()
  return { platform: channel, userId: raw, principal: `${channel}:${raw}` }
}

/** Участник в полной форме: userId остаётся для старых читателей, principal — ключ. */
function normalizeMember(member, platform) {
  const target = parsePrincipal(member.principal ?? member.userId, member.platform ?? platform)
  return {
    userId: member.userId ?? target?.userId,
    platform: member.platform ?? target?.platform ?? platform,
    principal: member.principal ?? target?.principal ?? `${platform}:${member.userId}`,
    role: member.role,
  }
}

/** Пространство в хранимой форме. */
const isScope = (value) =>
  value != null
  && typeof value.id === 'string'
  && value.id !== ''
  && (value.kind === 'personal' || value.kind === 'shared')
  && typeof value.title === 'string'
  && value.ownerId !== undefined
  && Array.isArray(value.members)
  && value.members.every((member) =>
    member != null
    && (member.userId !== undefined || typeof member.principal === 'string')
    && isScopeRole(member.role))
  && (value.status === undefined || SCOPE_STATUSES.includes(value.status))
  && (value.version === undefined || Number.isFinite(Number(value.version)))
  && (value.createdAt === undefined || typeof value.createdAt === 'string')

/** Привести запись к полной форме, не потеряв данные. */
function normalizeScope(value, platform) {
  const owner = parsePrincipal(value.ownerPrincipal ?? value.ownerId, value.ownerPlatform ?? platform)
  return {
    id: String(value.id),
    kind: value.kind,
    title: String(value.title).trim() || (value.kind === 'personal' ? 'Личное' : 'Проект'),
    ownerId: value.ownerId,
    ownerPlatform: value.ownerPlatform ?? owner?.platform ?? platform,
    members: value.members.map((member) => normalizeMember(member, platform)),
    status: value.status ?? 'active',
    version: Number(value.version) || 1,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }
}

/** Строка похожа на principal: `<платформа>:<id>`. */
const isPrincipalString = (value) => PRINCIPAL_RE.test(String(value ?? ''))

/** Приглашение в хранимой форме. */
const isInvitation = (value) =>
  value != null
  && typeof value.id === 'string'
  && value.id !== ''
  && typeof value.scopeId === 'string'
  && value.scopeId !== ''
  && typeof value.inviterPrincipal === 'string'
  && isPrincipalString(value.inviterPrincipal)
  && typeof value.inviteePrincipal === 'string'
  && isPrincipalString(value.inviteePrincipal)
  && isScopeRole(value.role)
  && INVITATION_STATUSES.includes(value.status)
  && typeof value.code === 'string'
  && value.code !== ''
  && typeof value.expiresAt === 'string'
  && Number.isFinite(Date.parse(value.expiresAt))
  && typeof value.createdAt === 'string'

/** Привести приглашение к полной форме. */
function normalizeInvitation(value) {
  return {
    id: String(value.id),
    scopeId: String(value.scopeId),
    inviterPrincipal: String(value.inviterPrincipal),
    inviteePrincipal: String(value.inviteePrincipal),
    role: value.role,
    status: value.status,
    code: String(value.code),
    expiresAt: String(value.expiresAt),
    createdAt: String(value.createdAt),
  }
}

/** Миграция файла пространств: старые/битые записи не должны ронять загрузку. */
function migrateScopes(data) {
  return {
    ...data,
    scopes: data?.scopes != null && typeof data.scopes === 'object' ? data.scopes : {},
    active: data?.active != null && typeof data.active === 'object' ? data.active : {},
    nextProjectId: Number(data?.nextProjectId) || 1,
    invitations: Array.isArray(data?.invitations) ? data.invitations : [],
    nextInvitationId: Number(data?.nextInvitationId) || 1,
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

/** Наибольший номер приглашения в наборе записей. */
function highestInvitationNumber(invitations) {
  let highest = 0
  for (const invitation of invitations) {
    const match = /^invitation-(\d+)$/.exec(String(invitation.id))
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/** Метка времени, допустимая в имени каталога. */
const migrationStamp = (now) => now.toISOString().replace(/[:.]/g, '-')

/** Совместимая фабрика: `createScopeStore({ file, logger })`. */
export const createScopeStore = (options = {}) => new ScopeStore(options)

export class ScopeStore {
  /**
   * @param {object} options - `file`, `logger`, `now`, `platform`.
   * @param {string} options.file - JSON-файл пространств.
   * @param {object} [options.logger] - логгер с info/warn/error; сюда же идёт
   *   журнал отклонённых попыток принять чужое приглашение.
   * @param {() => Date} [options.now] - часы (подменяются в тестах).
   * @param {string} [options.platform] - канал по умолчанию для старых id.
   * @param {number} [options.invitationTtlMs] - срок приглашения.
   */
  constructor({ file, logger, now = () => new Date(), platform = 'telegram', invitationTtlMs = INVITATION_TTL_MS } = {}) {
    this.file = file
    this.logger = logger
    this.now = now
    this.platform = String(platform || 'telegram').toLowerCase()
    this.invitationTtlMs = Number(invitationTtlMs) > 0 ? Number(invitationTtlMs) : INVITATION_TTL_MS
    /** @type {Map<string, object>} */
    this.scopes = new Map()
    /** Чат → пользователь → id активного проекта. */
    this.active = new Map()
    /** @type {Map<string, object>} */
    this.invitations = new Map()
    this.nextProjectId = 1
    this.nextInvitationId = 1
    // Сколько участников/владельцев пришли из файла без платформы. Это же
    // число — признак того, что миграция ещё не выполнена.
    this.pendingPlatformMigration = 0
    // Очередь записей: поздний снимок не должен затирать ранний.
    this.writing = Promise.resolve()
    // Без файла хранилище живёт только в памяти: это удобно для проверок и
    // модульных обёрток, но бот всегда передаёт путь.
    this.storage = file
      ? createJsonStore({
        file,
        version: VERSION,
        defaults: { scopes: {}, active: {}, nextProjectId: 1, invitations: [], nextInvitationId: 1 },
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
      let missingPlatforms = 0
      for (const [id, value] of Object.entries(raw)) {
        if (!isScope(value)) continue
        // Считаем владельцев и участников без платформы до нормализации: после
        // неё отличить старую запись от новой уже нельзя.
        if (value.ownerPlatform === undefined && value.ownerPrincipal === undefined) missingPlatforms++
        for (const member of value.members) {
          if (member?.platform === undefined || member?.principal === undefined) missingPlatforms++
        }
        const scopeId = String(value.id ?? id)
        this.scopes.set(scopeId, normalizeScope({ ...value, id: scopeId }, this.platform))
      }
      this.pendingPlatformMigration = missingPlatforms
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
      this.invitations.clear()
      const list = Array.isArray(state.invitations) ? state.invitations : []
      for (const value of list) {
        if (!isInvitation(value)) continue
        this.invitations.set(String(value.id), normalizeInvitation(value))
      }
      this.nextProjectId = Math.max(
        Number(state.nextProjectId) || 1,
        highestProjectNumber(this.scopes.values()) + 1,
      )
      this.nextInvitationId = Math.max(
        Number(state.nextInvitationId) || 1,
        highestInvitationNumber(this.invitations.values()) + 1,
      )
      // Просроченное приглашение не должно оставаться `pending` после загрузки.
      this.expireInvitations()
      this.logger?.info?.('scopes loaded', {
        scopes: this.scopes.size,
        activeChats: this.active.size,
        invitations: this.invitations.size,
      })
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
    const owner = parsePrincipal(userId, this.platform)
    const scope = {
      id: `personal-${key}`,
      kind: 'personal',
      title: 'Личное',
      ownerId: userId,
      ownerPlatform: owner?.platform ?? this.platform,
      members: [{
        userId,
        platform: owner?.platform ?? this.platform,
        principal: owner?.principal ?? `${this.platform}:${key}`,
        role: 'owner',
      }],
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
   * @param {object} input - `title`, `ownerId`, `ownerPlatform`.
   * @returns {object} созданное пространство.
   */
  create({ title, ownerId, ownerPlatform } = {}) {
    const clean = String(title ?? '').trim().slice(0, 120)
    if (ownerId === undefined || ownerId === null) throw new Error('scope: не задан владелец')
    if (clean === '') throw new Error('scope: нужно название проекта')
    const id = `project-${this.nextProjectId++}`
    const owner = parsePrincipal(ownerId, ownerPlatform ?? this.platform)
    const scope = {
      id,
      kind: 'shared',
      title: clean,
      ownerId,
      ownerPlatform: owner?.platform ?? this.platform,
      members: [{
        userId: ownerId,
        platform: owner?.platform ?? this.platform,
        principal: owner?.principal ?? `${this.platform}:${ownerId}`,
        role: 'owner',
      }],
      status: 'active',
      version: 1,
      createdAt: this.now().toISOString(),
    }
    this.scopes.set(id, scope)
    return scope
  }

  /** Участник пространства или `undefined`; принимает id или principal. */
  member(scopeId, userId) {
    const scope = this.get(scopeId)
    const target = parsePrincipal(userId, this.platform)
    if (!scope || !target) return undefined
    return scope.members.find((item) => {
      // Новые записи сравниваются principal'ом; старые без платформы — парой
      // «id + текущий канал», чтобы файл до миграции оставался читаемым.
      if (item.principal) return item.principal === target.principal
      return String(item.userId) === String(target.userId)
        && (item.platform ?? this.platform) === target.platform
    })
  }

  /**
   * Добавить участника напрямую (принятие приглашения и служебные сценарии).
   *
   * Это единственный путь попасть в `members`: сама команда `/project invite`
   * создаёт только `pending`-приглашение.
   *
   * @param {string} scopeId - проект.
   * @param {string|number} invitee - id или principal.
   * @param {string} [role] - `editor` (по умолчанию) или `viewer`.
   * @returns {object|undefined} участник либо undefined для неизвестного проекта.
   */
  addMember(scopeId, invitee, role = 'editor', { platform } = {}) {
    const scope = this.get(scopeId)
    if (!scope) return undefined
    const target = parsePrincipal(invitee, platform ?? this.platform)
    if (!target) throw new Error('scope: не задан участник')
    if (!isScopeRole(role) || role === 'owner') throw new Error('scope: недопустимая роль')
    const known = this.member(scope.id, target.principal)
    if (known) return known
    const member = {
      userId: typeof invitee === 'number' ? invitee : target.userId,
      platform: target.platform,
      principal: target.principal,
      role,
    }
    scope.members.push(member)
    return member
  }

  /**
   * Пригласить участника: создаёт `pending`-приглашение и НЕ добавляет в
   * `members`. Доступ появится только после `/project accept`.
   *
   * @param {string} scopeId - проект.
   * @param {string|number} invitee - id (текущая платформа) или principal.
   * @param {string} [role] - `editor` (по умолчанию) или `viewer`.
   * @param {object} [options] - `inviterPrincipal`, `ttlMs`.
   * @returns {object|undefined} приглашение либо undefined для неизвестного проекта.
   */
  invite(scopeId, invitee, role = 'editor', { inviterPrincipal, ttlMs } = {}) {
    const scope = this.get(scopeId)
    if (!scope) return undefined
    const target = parsePrincipal(invitee, this.platform)
    if (!target) throw new Error('scope: не задан участник')
    if (!isScopeRole(role) || role === 'owner') throw new Error('scope: недопустимая роль')
    const inviter = parsePrincipal(
      inviterPrincipal ?? scope.ownerId,
      scope.ownerPlatform ?? this.platform,
    )
    if (inviter && inviter.principal === target.principal) throw new Error('scope: нельзя пригласить себя')
    this.expireInvitations()
    if (this.member(scope.id, target.principal)) throw new Error('scope: уже участник')
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : this.invitationTtlMs
    const expiresAt = new Date(this.now().getTime() + ttl).toISOString()
    // Повторное приглашение тому же человеку обновляет срок и роль, а не
    // плодит коды: старый код продолжает работать.
    const pending = [...this.invitations.values()].find(
      (item) => item.scopeId === scope.id && item.inviteePrincipal === target.principal && item.status === 'pending',
    )
    if (pending) {
      pending.role = role
      pending.expiresAt = expiresAt
      if (inviter) pending.inviterPrincipal = inviter.principal
      return pending
    }
    const invitation = {
      id: `invitation-${this.nextInvitationId++}`,
      scopeId: scope.id,
      inviterPrincipal: inviter?.principal ?? `${this.platform}:${scope.ownerId}`,
      inviteePrincipal: target.principal,
      role,
      status: 'pending',
      code: this.newInvitationCode(),
      expiresAt,
      createdAt: this.now().toISOString(),
    }
    this.invitations.set(invitation.id, invitation)
    return invitation
  }

  /** Новый уникальный код приглашения. */
  newInvitationCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = ''
      for (let index = 0; index < CODE_LENGTH; index++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
      }
      if (![...this.invitations.values()].some((item) => item.code === code)) return code
    }
    throw new Error('scope: не удалось создать код приглашения')
  }

  /** Приглашение по коду (регистр не важен); просроченное помечается. */
  invitationByCode(code) {
    const wanted = String(code ?? '').trim().toUpperCase()
    if (wanted === '') return undefined
    this.expireInvitations()
    return [...this.invitations.values()].find((item) => item.code.toUpperCase() === wanted)
  }

  /** Пометить просроченные приглашения; возвращает число изменённых. */
  expireInvitations() {
    const nowMs = this.now().getTime()
    let changed = 0
    for (const invitation of this.invitations.values()) {
      if (invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= nowMs) {
        invitation.status = 'expired'
        changed++
      }
    }
    return changed
  }

  /** Все приглашения (копии; для проверок и диагностики). */
  listInvitations(scopeId) {
    return [...this.invitations.values()]
      .filter((item) => scopeId === undefined || item.scopeId === String(scopeId))
      .map((item) => ({ ...item }))
  }

  /** Общая проверка перед принятием/отклонением: срок, статус, адресат. */
  invitationCheck(invitation, actor) {
    if (!invitation) return { ok: false, reason: 'unknown' }
    const principal = parsePrincipal(actor, this.platform)
    if (!principal) return { ok: false, reason: 'actor', invitation }
    if (invitation.status !== 'pending') return { ok: false, reason: invitation.status, invitation }
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) {
      invitation.status = 'expired'
      this.logger?.warn?.('invitation accept denied', {
        reason: 'expired',
        invitationId: invitation.id,
        scopeId: invitation.scopeId,
        actor: principal.principal,
      })
      return { ok: false, reason: 'expired', invitation }
    }
    // Пересланный код третьему лицу: сверяем principal с адресатом. Попытка
    // остаётся в журнале — владелец должен её видеть.
    if (invitation.inviteePrincipal !== principal.principal) {
      this.logger?.warn?.('invitation accept denied', {
        reason: 'foreign',
        invitationId: invitation.id,
        scopeId: invitation.scopeId,
        actor: principal.principal,
        invitee: invitation.inviteePrincipal,
      })
      return { ok: false, reason: 'foreign', invitation, actor: principal.principal }
    }
    return { ok: true, principal, invitation }
  }

  /**
   * Принять приглашение своим подтверждённым аккаунтом.
   *
   * @param {string} code - код из приглашения.
   * @param {string|number} actor - principal из проверенного контекста.
   * @returns {{ok: boolean, reason?: string, invitation?: object, member?: object, scope?: object}}
   */
  acceptInvitation(code, actor) {
    const invitation = this.invitationByCode(code)
    const check = this.invitationCheck(invitation, actor)
    if (!check.ok) return check
    const scope = this.get(invitation.scopeId)
    if (!scope) return { ok: false, reason: 'scope', invitation }
    const member = this.addMember(scope.id, invitation.inviteePrincipal, invitation.role)
    invitation.status = 'accepted'
    return { ok: true, invitation, member, scope }
  }

  /**
   * Отклонить приглашение. Отклонить может только сам адресат.
   *
   * @param {string} code - код из приглашения.
   * @param {string|number} actor - principal из проверенного контекста.
   * @returns {{ok: boolean, reason?: string, invitation?: object}}
   */
  declineInvitation(code, actor) {
    const invitation = this.invitationByCode(code)
    const check = this.invitationCheck(invitation, actor)
    if (!check.ok) return check
    invitation.status = 'declined'
    return { ok: true, invitation }
  }

  /**
   * Отозвать доступ владельцем: снимает `pending`-приглашение и/или участника.
   *
   * @param {string} scopeId - проект.
   * @param {string|number} invitee - id или principal.
   * @returns {{kind: string, invitation?: object, member?: object}|undefined}
   */
  revokeAccess(scopeId, invitee) {
    const scope = this.get(scopeId)
    const target = parsePrincipal(invitee, this.platform)
    if (!scope || !target) return undefined
    this.expireInvitations()
    const invitation = [...this.invitations.values()].find(
      (item) => item.scopeId === scope.id
        && item.inviteePrincipal === target.principal
        && item.status === 'pending',
    )
    if (invitation) invitation.status = 'revoked'
    // Принятое приглашение тоже отзывается: доступ снимается с участника.
    const member = this.removeMember(scope.id, target.principal)
    if (!invitation && !member) return undefined
    return { kind: invitation ? 'invitation' : 'member', invitation, member }
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
    const target = parsePrincipal(userId, this.platform)
    if (!target) return undefined
    const index = scope.members.findIndex((item) => {
      if (item.principal) return item.principal === target.principal
      return String(item.userId) === String(target.userId)
        && (item.platform ?? this.platform) === target.platform
    })
    if (index === -1) return undefined
    const found = scope.members[index]
    // Владельца убирать нельзя. Сравниваем principal, а не голый id: иначе
    // vk:7 нельзя было бы отозвать из проекта telegram:7.
    const ownerPrincipal = parsePrincipal(
      scope.ownerId,
      scope.ownerPlatform ?? this.platform,
    )?.principal
    if (found.role === 'owner' || (ownerPrincipal && found.principal === ownerPrincipal)) return undefined
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

  /** Нужна ли миграция участников: в файле ещё нет платформы. */
  needsMemberMigration() {
    return this.pendingPlatformMigration > 0
  }

  /**
   * Проставить участникам и владельцам платформу по известному каналу.
   *
   * Никого не удаляет и роли не меняет — только дополняет записи. Повторный
   * вызов возвращает 0.
   *
   * @returns {number} сколько записей дополнено.
   */
  migrateMembers() {
    const migrated = this.pendingPlatformMigration
    for (const scope of this.scopes.values()) {
      if (scope.ownerPlatform === undefined) scope.ownerPlatform = this.platform
      for (const member of scope.members) {
        if (member.platform !== undefined && member.principal !== undefined) continue
        const target = parsePrincipal(member.userId, member.platform ?? this.platform)
        member.platform = target?.platform ?? this.platform
        member.principal = target?.principal ?? `${this.platform}:${member.userId}`
      }
    }
    this.pendingPlatformMigration = 0
    return migrated
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
        this.storage.state.invitations = [...this.invitations.values()]
        this.storage.state.nextInvitationId = this.nextInvitationId
        await this.storage.flush()
      } catch (error) {
        this.logger?.error?.('scope save failed', { error })
      }
    })
    return this.writing
  }
}

/**
 * Мигрировать участников существующего `scopes.json` к principal с платформой.
 *
 * Копия файла делается до первой записи: `backups/scope-member-migration-<дата>/`.
 * Если дополнять нечего, копия не создаётся и файл не переписывается — это и
 * есть идемпотентность. Существующие участники (в том числе Маша) остаются.
 *
 * @param {object} options - параметры миграции.
 * @param {ScopeStore} options.store - хранилище пространств.
 * @param {string} [options.backupDir] - куда класть копию; по умолчанию `backups/` рядом.
 * @param {object} [options.logger] - логгер.
 * @param {() => Date} [options.now] - часы для имени копии.
 * @returns {Promise<{migrated: number, backupDir?: string, files: string[]}>} отчёт.
 */
export async function migrateScopeMembers({ store, backupDir, logger, now = () => new Date() } = {}) {
  if (!store || typeof store.needsMemberMigration !== 'function') {
    throw new Error('migrateScopeMembers: нужно хранилище пространств')
  }
  if (!store.needsMemberMigration()) return { migrated: 0, files: [] }

  const files = []
  let directory
  if (store.file) {
    const base = backupDir ?? path.join(path.dirname(store.file), 'backups')
    await fs.mkdir(base, { recursive: true })
    directory = await fs.mkdtemp(path.join(base, `scope-member-migration-${migrationStamp(now())}-`))
    const copy = path.join(directory, path.basename(store.file))
    try {
      await fs.copyFile(store.file, copy)
      files.push(copy)
    } catch (error) {
      // Отсутствующий файл — не ошибка: записи могли прийти из defaults.
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const migrated = store.migrateMembers()
  await store.flush()
  logger?.info?.('scope member migration complete', {
    migrated,
    backupDir: directory,
    files: files.length,
  })
  return { migrated, backupDir: directory, files }
}
