/**
 * Инбокс мобильного сайта: короткие заметки и задачи, не привязанные к чату.
 *
 * Хранится отдельным JSON рядом с остальным состоянием. Каждый пользователь
 * видит только свои записи; owner и второй аккаунт не пересекаются.
 */
import crypto from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const MAX_ITEMS_PER_USER = 100
const MAX_TEXT = 500

export class MobileInboxError extends Error {
  constructor(message, code = 'bad_request') {
    super(message)
    this.name = 'MobileInboxError'
    this.code = code
  }
}

export class MobileInboxStore {
  constructor({ file, logger } = {}) {
    if (!file) throw new MobileInboxError('Не задан файл инбокса')
    this.logger = logger
    this.storage = createJsonStore({
      file,
      version: 1,
      defaults: { items: [] },
      logger,
    })
  }

  get file() {
    return this.storage.file
  }

  get items() {
    const list = this.storage.state?.items
    return Array.isArray(list) ? list : []
  }

  async load() {
    await this.storage.load()
    if (!Array.isArray(this.storage.state.items)) this.storage.state.items = []
    return this
  }

  list(userId) {
    const id = Number(userId)
    return this.items
      .filter((item) => Number(item.userId) === id)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  }

  async add({ userId, text } = {}) {
    const id = Number(userId)
    if (!Number.isInteger(id) || id <= 0) throw new MobileInboxError('Некорректный пользователь')
    const value = String(text ?? '').trim()
    if (value.length === 0) throw new MobileInboxError('Заметка не может быть пустой')
    if (value.length > MAX_TEXT) throw new MobileInboxError(`Заметка длиннее ${MAX_TEXT} символов`)
    if (this.list(id).length >= MAX_ITEMS_PER_USER) throw new MobileInboxError('Слишком много заметок', 'conflict')
    const item = {
      id: crypto.randomUUID(),
      userId: id,
      text: value,
      done: false,
      createdAt: new Date().toISOString(),
    }
    this.items.push(item)
    await this.storage.flush()
    return item
  }

  async toggle({ userId, itemId, done } = {}) {
    const item = this.find(userId, itemId)
    if (!item) throw new MobileInboxError('Заметка не найдена', 'not_found')
    item.done = Boolean(done)
    item.updatedAt = new Date().toISOString()
    await this.storage.flush()
    return item
  }

  async remove({ userId, itemId } = {}) {
    const id = Number(userId)
    const index = this.items.findIndex((item) => Number(item.userId) === id && String(item.id) === String(itemId))
    if (index === -1) throw new MobileInboxError('Заметка не найдена', 'not_found')
    const [removed] = this.items.splice(index, 1)
    await this.storage.flush()
    return removed
  }

  find(userId, itemId) {
    return this.items.find((item) => Number(item.userId) === Number(userId) && String(item.id) === String(itemId))
  }
}
