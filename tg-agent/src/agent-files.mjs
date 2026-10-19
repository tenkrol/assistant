/**
 * Файлы, которые агент прислал в чат: отдельная «папка агента» на сайте.
 *
 * Telegram-доставка остаётся как была, но байты дополнительно сохраняются здесь,
 * чтобы файл можно было открыть позже с телефона или ноутбука и удалить.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createJsonStore } from './storage/json-store.mjs'

const MAX_FILES_PER_CHAT = 100
const MAX_FILE_BYTES = 25 * 1024 * 1024

function safeName(value) {
  const name = String(value ?? '').replace(/[\r\n"\\/]/g, '_').trim()
  return name === '' ? 'agent-file' : name.slice(0, 160)
}

export class AgentFileStore {
  constructor({ file, directory, logger } = {}) {
    if (!file) throw new Error('Не задан файл агентских файлов')
    this.logger = logger
    this.directory = directory || path.join(path.dirname(file), 'agent-files')
    this.storage = createJsonStore({ file, version: 1, defaults: { files: [] }, logger })
  }

  get file() {
    return this.storage.file
  }

  get files() {
    const list = this.storage.state?.files
    return Array.isArray(list) ? list : []
  }

  async load() {
    await this.storage.load()
    if (!Array.isArray(this.storage.state.files)) this.storage.state.files = []
    await fs.promises.mkdir(this.directory, { recursive: true })
    return this
  }

  list(chatId) {
    return this.files
      .filter((item) => String(item.chatId) === String(chatId))
      .sort((left, right) => String(right.at).localeCompare(String(left.at)))
  }

  async add({ chatId, name, bytes, mime, caption, eventTitle } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Пустой файл агента')
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Файл агента больше 25 МБ')
    if (this.list(chatId).length >= MAX_FILES_PER_CHAT) throw new Error('Слишком много файлов агента')
    const id = crypto.randomUUID()
    const fileName = safeName(name)
    const storageName = id + '-' + fileName
    await fs.promises.mkdir(this.directory, { recursive: true })
    await fs.promises.writeFile(path.join(this.directory, storageName), bytes)
    const item = {
      id,
      chatId: String(chatId),
      name: fileName,
      mime: String(mime || 'application/octet-stream'),
      size: bytes.length,
      storageName,
      at: new Date().toISOString(),
      ...(caption ? { caption: String(caption).slice(0, 500) } : {}),
      ...(eventTitle ? { eventTitle: String(eventTitle).slice(0, 200) } : {}),
    }
    this.files.push(item)
    await this.storage.flush()
    return item
  }

  getPath(item) {
    return path.join(this.directory, item.storageName)
  }

  async remove({ chatId, id } = {}) {
    const index = this.files.findIndex((item) => String(item.chatId) === String(chatId) && String(item.id) === String(id))
    if (index === -1) return false
    const [removed] = this.files.splice(index, 1)
    await fs.promises.rm(this.getPath(removed), { force: true }).catch(() => {})
    await this.storage.flush()
    return true
  }
}
