/** Проекты мобильного сайта: отдельные контексты чата и инструкции. */
import crypto from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const MAX_PROJECTS = 20
const MAX_NAME = 80
const MAX_INSTRUCTIONS = 2000

export class ProjectError extends Error {
  constructor(message, code = 'bad_request') {
    super(message)
    this.code = code
  }
}

export class ProjectStore {
  constructor({ file, logger } = {}) {
    this.logger = logger
    this.storage = createJsonStore({ file, version: 1, defaults: { items: [] }, logger })
  }

  get items() {
    return Array.isArray(this.storage.state?.items) ? this.storage.state.items : []
  }

  async load() {
    await this.storage.load()
    if (!Array.isArray(this.storage.state.items)) this.storage.state.items = []
    return this
  }

  list(userId) {
    return this.items.filter((item) => Number(item.userId) === Number(userId)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  find(userId, id) {
    return this.items.find((item) => Number(item.userId) === Number(userId) && String(item.id) === String(id))
  }

  async add({ userId, name, instructions = '' } = {}) {
    if (this.list(userId).length >= MAX_PROJECTS) throw new ProjectError('Слишком много проектов', 'conflict')
    const title = String(name || '').trim()
    if (title === '' || title.length > MAX_NAME) throw new ProjectError('Некорректное название проекта')
    const note = String(instructions || '').trim()
    if (note.length > MAX_INSTRUCTIONS) throw new ProjectError('Инструкции слишком длинные')
    const item = { id: crypto.randomUUID(), userId: Number(userId), name: title, instructions: note, createdAt: new Date().toISOString() }
    this.items.push(item)
    await this.storage.flush()
    return item
  }

  async update({ userId, id, name, instructions } = {}) {
    const item = this.find(userId, id)
    if (!item) throw new ProjectError('Проект не найден', 'not_found')
    if (typeof name === 'string') {
      const title = name.trim()
      if (title === '' || title.length > MAX_NAME) throw new ProjectError('Некорректное название проекта')
      item.name = title
    }
    if (typeof instructions === 'string') {
      if (instructions.length > MAX_INSTRUCTIONS) throw new ProjectError('Инструкции слишком длинные')
      item.instructions = instructions.trim()
    }
    await this.storage.flush()
    return item
  }

  async remove({ userId, id } = {}) {
    const index = this.items.findIndex((item) => Number(item.userId) === Number(userId) && String(item.id) === String(id))
    if (index === -1) throw new ProjectError('Проект не найден', 'not_found')
    const [removed] = this.items.splice(index, 1)
    await this.storage.flush()
    return removed
  }
}
