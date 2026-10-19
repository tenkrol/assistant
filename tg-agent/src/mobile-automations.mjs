/**
 * Автоматизации мобильного сайта: регулярный запуск промпта агенту.
 *
 * Расписание хранится в московском времени (UTC+3): у владельца нет перехода
 * на летнее время, а сервер может жить в UTC.
 */
import crypto from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const MAX_ITEMS_PER_USER = 30
const MAX_TITLE = 120
const MAX_PROMPT = 4000

export class AutomationError extends Error {
  constructor(message, code = 'bad_request') {
    super(message)
    this.code = code
  }
}

function partsInMsk(date) {
  const shifted = new Date(date.getTime() + MSK_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

function mskDate(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month, day, hour - 3, minute, 0, 0))
}

export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

export function nextRunAt({ time, weekdays = [], now = new Date() }) {
  const clock = parseClock(time)
  if (!clock) return undefined
  const current = partsInMsk(now)
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(Date.UTC(current.year, current.month, current.day + offset))
    if (weekdays.length > 0) {
      const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay()
      if (!weekdays.includes(weekday)) continue
    }
    const candidate = mskDate(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), clock.hour, clock.minute)
    if (candidate.getTime() > now.getTime()) return candidate.toISOString()
  }
  return undefined
}

export class AutomationStore {
  constructor({ file, logger } = {}) {
    if (!file) throw new AutomationError('Не задан файл автоматизаций')
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
    return this.items.filter((item) => Number(item.userId) === Number(userId)).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))
  }

  async add({ userId, title, prompt, time, weekdays = [] }) {
    if (this.list(userId).length >= MAX_ITEMS_PER_USER) throw new AutomationError('Слишком много автоматизаций', 'conflict')
    const name = String(title || '').trim()
    const text = String(prompt || '').trim()
    if (name === '' || name.length > MAX_TITLE) throw new AutomationError('Некорректное название')
    if (text === '' || text.length > MAX_PROMPT) throw new AutomationError('Некорректный промпт')
    if (!parseClock(time)) throw new AutomationError('Укажите время ЧЧ:ММ')
    const days = (Array.isArray(weekdays) ? weekdays : []).map(Number).filter((day) => day >= 1 && day <= 7)
    const item = {
      id: crypto.randomUUID(),
      userId: Number(userId),
      title: name,
      prompt: text,
      time: String(time),
      weekdays: [...new Set(days)],
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: nextRunAt({ time, weekdays: days }),
      history: [],
    }
    this.items.push(item)
    await this.storage.flush()
    return item
  }

  async update({ userId, id, enabled } = {}) {
    const item = this.find(userId, id)
    if (!item) throw new AutomationError('Автоматизация не найдена', 'not_found')
    if (typeof enabled === 'boolean') item.enabled = enabled
    if (item.enabled) item.nextRunAt = nextRunAt({ time: item.time, weekdays: item.weekdays })
    await this.storage.flush()
    return item
  }

  async remove({ userId, id } = {}) {
    const index = this.items.findIndex((item) => Number(item.userId) === Number(userId) && String(item.id) === String(id))
    if (index === -1) throw new AutomationError('Автоматизация не найдена', 'not_found')
    const [removed] = this.items.splice(index, 1)
    await this.storage.flush()
    return removed
  }

  async markRun(item, { ok, error } = {}) {
    const at = new Date().toISOString()
    item.lastRunAt = at
    item.lastStatus = ok ? 'ok' : 'failed'
    item.nextRunAt = nextRunAt({ time: item.time, weekdays: item.weekdays, now: new Date(Date.now() + 60_000) })
    item.history = [{ at, ok: Boolean(ok), ...(error ? { error: String(error).slice(0, 300) } : {}) }, ...(Array.isArray(item.history) ? item.history : [])].slice(0, 10)
    await this.storage.flush()
  }

  due(now = new Date()) {
    return this.items.filter((item) => item.enabled && item.nextRunAt && new Date(item.nextRunAt).getTime() <= now.getTime())
  }

  find(userId, id) {
    return this.items.find((item) => Number(item.userId) === Number(userId) && String(item.id) === String(id))
  }
}
