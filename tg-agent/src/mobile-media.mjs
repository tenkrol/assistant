/**
 * Медиа веб-чата: фото и видео с телефона.
 *
 * Файл пишется в каталог рядом с индексом, а в JSON хранятся только метаданные.
 * Байты не попадают в историю и не раздувают её; отдача — через `/api/media/:id`
 * с проверкой сессии и поддержкой Range для видео.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createJsonStore } from './storage/json-store.mjs'

export const MOBILE_MEDIA_MAX_BYTES = 20 * 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export class MobileMediaError extends Error {
  constructor(message, code = 'bad_request') {
    super(message)
    this.name = 'MobileMediaError'
    this.code = code
  }
}

/** photo | video | document по MIME. */
export function mediaKind(mime) {
  const value = String(mime ?? '').toLowerCase()
  if (value.startsWith('image/')) return 'photo'
  if (value.startsWith('video/')) return 'video'
  if (value.startsWith('audio/')) return 'voice'
  return 'document'
}

export class MobileMediaStore {
  constructor({ file, dir, logger } = {}) {
    if (!file || !dir) throw new MobileMediaError('Не задан путь медиа')
    this.dir = dir
    this.logger = logger
    this.storage = createJsonStore({ file, version: 1, defaults: { items: {} }, logger })
  }

  async load() {
    await this.storage.load()
    if (!this.storage.state.items || typeof this.storage.state.items !== 'object') this.storage.state.items = {}
    await fs.mkdir(this.dir, { recursive: true })
    await this.cleanup()
    return this
  }

  /** Удалить старые файлы; ошибки не должны мешать запуску. */
  async cleanup(now = Date.now()) {
    const items = this.storage.state.items
    let changed = false
    for (const [id, item] of Object.entries(items)) {
      const at = Date.parse(item?.createdAt ?? '')
      if (Number.isFinite(at) && now - at > MAX_AGE_MS) {
        delete items[id]
        changed = true
        await fs.rm(path.join(this.dir, id), { force: true }).catch(() => {})
      }
    }
    if (changed) await this.storage.flush().catch(() => {})
  }

  /** Сохранить файл; возвращает метаданные без байтов. */
  async add({ userId, bytes, name, mime } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new MobileMediaError('Пустой файл')
    if (bytes.length > MOBILE_MEDIA_MAX_BYTES) throw new MobileMediaError('Файл больше 20 МБ')
    const id = crypto.randomUUID()
    const kind = mediaKind(mime)
    if (kind === 'document') throw new MobileMediaError('Можно прикреплять только фото, видео и голосовые')
    const cleanName = String(name || (kind === 'photo' ? 'photo.jpg' : 'video.mp4')).slice(0, 120)
    const item = {
      id,
      userId: Number(userId),
      name: cleanName,
      mime: String(mime || (kind === 'photo' ? 'image/jpeg' : 'video/mp4')).slice(0, 100),
      size: bytes.length,
      kind,
      createdAt: new Date().toISOString(),
    }
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(path.join(this.dir, id), bytes, { mode: 0o600 })
    this.storage.state.items[id] = item
    await this.storage.flush()
    return item
  }

  get(id) {
    return this.storage.state.items[String(id)] ?? null
  }

  async read(id, { userId } = {}) {
    const item = this.get(id)
    if (!item) return null
    if (userId === undefined || userId === null || String(item.userId) !== String(userId)) return null
    const bytes = await fs.readFile(path.join(this.dir, String(id))).catch(() => null)
    if (!bytes) return null
    return { item, bytes }
  }

  /** Метаданные для истории: без байтов, с URL. */
  publicItem(item) {
    if (!item) return null
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      mime: item.mime,
      size: item.size,
      url: `/api/media/${item.id}`,
    }
  }
}
