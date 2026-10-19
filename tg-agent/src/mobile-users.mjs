/**
 * Аккаунты мобильного сайта: несколько человек на одном сайте, у каждого — свой
 * Telegram user id и, значит, свои напоминания, память и история.
 *
 * В файле лежат только scrypt-хеши паролей. Версия учётных данных (`version`) растёт
 * при смене логина или пароля и попадает в подписанную сессию: старые cookie
 * перестают работать сразу после смены.
 *
 * Начальный владелец заводится из `.env` (`MOBILE_USERNAME`, `MOBILE_PASSWORD_HASH`,
 * `MOBILE_USER_ID`), если файла аккаунтов ещё нет. Дальше источник правды — этот файл.
 */
import { hashPassword, isPasswordHash, verifyPassword } from './mobile-auth.mjs'
import { createJsonStore } from './storage/json-store.mjs'

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/
export const MAX_LOGIN_LENGTH = 32
export const MAX_NAME_LENGTH = 80
export const MOBILE_USERS_VERSION = 1

export class MobileUsersError extends Error {
  constructor(message, code = 'bad_request') {
    super(message)
    this.name = 'MobileUsersError'
    this.code = code
  }
}

export const normalizeLogin = (value) => String(value ?? '').trim().toLowerCase()

/** Проверить логин до записи; возвращает нормализованное значение. */
export function validateLogin(value) {
  const login = normalizeLogin(value)
  if (!LOGIN_RE.test(login)) {
    throw new MobileUsersError('Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание')
  }
  return login
}

/** Имя для интерфейса; пустое заменяется логином. */
export function validateName(value, fallback = '') {
  const name = String(value ?? '').trim()
  if (name.length > MAX_NAME_LENGTH) throw new MobileUsersError(`Имя длиннее ${MAX_NAME_LENGTH} символов`)
  return name === '' ? fallback : name
}

/** Проверить пароль; слабые разрешены (владелец решил), но пустой — нет. */
export function validatePassword(value) {
  if (typeof value !== 'string' || value === '') throw new MobileUsersError('Введите пароль')
  if (value.length > 1024) throw new MobileUsersError('Пароль слишком длинный')
  return value
}

const publicUser = (user) => ({
  login: String(user.login),
  name: String(user.name ?? user.login),
  userId: Number(user.userId),
  role: user.role === 'owner' ? 'owner' : 'member',
  version: Number(user.version) || 1,
})

export class MobileUserStore {
  /**
   * @param {object} options - `file`, `logger`, `seedUsers`.
   * `seedUsers` — массив `{login,passwordHash,name,userId,role}` для первого запуска.
   */
  constructor({ file, logger, seedUsers = [] } = {}) {
    if (!file) throw new MobileUsersError('Не задан файл аккаунтов')
    this.logger = logger
    this.seedUsers = seedUsers
    this.storage = createJsonStore({
      file,
      version: MOBILE_USERS_VERSION,
      defaults: { users: [] },
      logger,
    })
  }

  get file() {
    return this.storage.file
  }

  get users() {
    const users = this.storage.state?.users
    return Array.isArray(users) ? users : []
  }

  /** Прочитать файл и завести владельца, если аккаунтов ещё нет. */
  async load() {
    await this.storage.load()
    if (!Array.isArray(this.storage.state.users)) this.storage.state.users = []
    if (this.storage.state.users.length > 0) return this

    const seeded = []
    for (const candidate of this.seedUsers) {
      try {
        const login = validateLogin(candidate.login)
        if (!isPasswordHash(candidate.passwordHash)) continue
        const userId = Number(candidate.userId)
        if (!Number.isInteger(userId) || userId <= 0) continue
        if (seeded.some((user) => user.login === login || user.userId === userId)) continue
        seeded.push({
          login,
          name: validateName(candidate.name, login),
          userId,
          role: candidate.role === 'owner' ? 'owner' : 'member',
          passwordHash: candidate.passwordHash,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      } catch (error) {
        this.logger?.warn?.('mobile account seed skipped', { error: error?.message ?? error })
      }
    }
    if (seeded.length === 0) return this
    this.storage.state.users = seeded
    await this.storage.flush()
    this.logger?.info?.('mobile accounts seeded', { count: seeded.length })
    return this
  }

  list() {
    return this.users.map(publicUser)
  }

  findByLogin(value) {
    const login = normalizeLogin(value)
    return this.users.find((user) => user.login === login)
  }

  findByUserId(value) {
    const id = Number(value)
    return this.users.find((user) => Number(user.userId) === id)
  }

  owner() {
    return this.users.find((user) => user.role === 'owner')
  }

  /** Проверить логин и пароль; возвращает запись или `null`. */
  authenticate(login, password) {
    const user = this.findByLogin(login)
    if (!user) return null
    return verifyPassword(password, user.passwordHash) ? user : null
  }

  /** Первый свободный Telegram id из allow-list — для «добавить Машу». */
  freeUserId(allowedIds) {
    const used = new Set(this.users.map((user) => String(user.userId)))
    for (const id of allowedIds ?? []) {
      if (!used.has(String(id))) return Number(id)
    }
    return undefined
  }

  /** Добавить аккаунт. Пароль хешируется здесь; наружу хеш не отдаётся. */
  async add({ login, password, name, userId, role = 'member' } = {}) {
    const cleanLogin = validateLogin(login)
    const cleanPassword = validatePassword(password)
    const cleanName = validateName(name, cleanLogin)
    const id = Number(userId)
    if (!Number.isInteger(id) || id <= 0) throw new MobileUsersError('Некорректный Telegram id')
    if (this.users.some((user) => user.login === cleanLogin)) throw new MobileUsersError('Такой логин уже занят', 'conflict')
    if (this.users.some((user) => Number(user.userId) === id)) throw new MobileUsersError('Этот Telegram id уже привязан', 'conflict')

    const now = new Date().toISOString()
    const user = {
      login: cleanLogin,
      name: cleanName,
      userId: id,
      role: role === 'owner' ? 'owner' : 'member',
      passwordHash: hashPassword(cleanPassword),
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.storage.state.users.push(user)
    await this.storage.flush()
    return publicUser(user)
  }

  /** Отозвать все сессии: версия учётных данных растёт без смены пароля. */
  async revokeSessions(login) {
    const user = this.findByLogin(login)
    if (!user) throw new MobileUsersError('Аккаунт не найден', 'not_found')
    user.version = (Number(user.version) || 1) + 1
    user.updatedAt = new Date().toISOString()
    await this.storage.flush()
    return { user: publicUser(user) }
  }

  /**
   * Изменить текущий аккаунт: логин, пароль, имя.
   *
   * @returns {{user: object, credentialChanged: boolean}} публичная запись.
   */
  async update(login, changes = {}) {
    const user = this.findByLogin(login)
    if (!user) throw new MobileUsersError('Аккаунт не найден', 'not_found')
    let credentialChanged = false

    if (Object.prototype.hasOwnProperty.call(changes, 'login')) {
      const nextLogin = validateLogin(changes.login)
      if (nextLogin !== user.login) {
        if (this.users.some((item) => item.login === nextLogin)) throw new MobileUsersError('Такой логин уже занят', 'conflict')
        user.login = nextLogin
        credentialChanged = true
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'password')) {
      user.passwordHash = hashPassword(validatePassword(changes.password))
      credentialChanged = true
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'name')) {
      user.name = validateName(changes.name, user.login)
    }
    if (credentialChanged) user.version = (Number(user.version) || 1) + 1
    user.updatedAt = new Date().toISOString()
    await this.storage.flush()
    return { user: publicUser(user), credentialChanged }
  }
}
