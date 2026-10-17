/**
 * Events: meetings, appointments, birthdays — the part of a calendar the bot owns.
 *
 * Kept locally and deliberately simple: an event has a title, a start instant and
 * optionally a yearly repeat (a birthday is a calendar event that comes back by
 * itself). Reading someone else's Google or Yandex calendar needs OAuth and a public
 * HTTPS endpoint, so that is left for a later step — the storage below does not care
 * where the event came from.
 *
 * An event may bring its own reminder: the tool writes a normal reminder a few
 * minutes before the start, so delivery, quiet hours and buttons all keep working as
 * they do for any other reminder.
 */
import { createJsonStore } from './storage/json-store.mjs'

/** File format version. */
const VERSION = 1

/** Repeats an event may have. */
export const EVENT_REPEATS = ['none', 'yearly']

/** Default minutes before the start when a reminder is asked for. */
export const DEFAULT_REMIND_BEFORE = 30

/** How many events one user may keep: the file must not grow forever. */
const MAX_EVENTS = 300

/** The shape stored on disk. */
const isEvent = (value) =>
  value != null
  && typeof value.id === 'string'
  && typeof value.chatId === 'number'
  && typeof value.title === 'string'
  && typeof value.at === 'string'
  && !Number.isNaN(Date.parse(value.at))
  && EVENT_REPEATS.includes(value.repeat ?? 'none')

/**
 * Миграция схемы событий: файл без `version` считаем версией 0.
 * Форма данных не менялась — отбрасываем только записи неверной формы.
 */
function migrateEvents(data) {
  return {
    ...data,
    events: Array.isArray(data?.events) ? data.events.filter(isEvent) : [],
  }
}

/** The local calendar day of an instant, as `YYYY-MM-DD`. */
export function dayKeyInZone(date, timeZone = '') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** Local time of an instant as `HH:MM`. */
export function timeInZone(date, timeZone = '') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit' }).format(date)
}

/** Local date as `9 октября`. */
export function dateInZone(date, timeZone = '') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone || undefined, day: 'numeric', month: 'long' }).format(date)
}

/** The next yearly occurrence of an instant, strictly after `now`. */
function nextYearly(iso, now) {
  const start = new Date(iso)
  const next = new Date(start)
  while (next.getTime() <= now.getTime()) {
    // 29 февраля сдвигаем на 28-е в невисокосный год: 1 марта было бы сюрпризом.
    const year = next.getUTCFullYear() + 1
    const day = next.getUTCDate() === 29 && next.getUTCMonth() === 1 ? 28 : next.getUTCDate()
    next.setUTCFullYear(year, next.getUTCMonth(), day)
  }
  return next.toISOString()
}

/**
 * Events for one chat, stored as a JSON file like every other state.
 */
export class EventStore {
  /**
   * @param {object} options - `{ file, logger, timeZone }`.
   */
  constructor({ file, logger, timeZone = '' } = {}) {
    this.file = file
    this.logger = logger
    this.timeZone = timeZone
    this.events = []
    this.nextId = 1
    // Очередь записей: перекрывающиеся flush не должны перетирать снимки.
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { nextId: 1, events: [] },
      migrate: migrateEvents,
      logger,
    })
  }

  /** Прочитать файл через общий слой; битый файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      this.events = Array.isArray(state.events) ? state.events.filter(isEvent) : []
      this.nextId = Number.isInteger(state.nextId) && state.nextId > 0 ? state.nextId : this.events.length + 1
      this.logger?.info('events loaded', { count: this.events.length })
    } catch (error) {
      this.logger?.warn('events load failed', { error: error?.message ?? error })
      this.events = []
      this.nextId = 1
    }
    return this
  }

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    // Записи выполняются по очереди, чтобы поздний снимок не затёрся ранним.
    this.writing = this.writing.then(async () => {
      try {
        // Синхронизируем доменное состояние с состоянием слоя перед записью.
        this.storage.state.nextId = this.nextId
        this.storage.state.events = this.events
        await this.storage.flush()
      } catch (error) {
        this.logger?.warn('events flush failed', { error: error?.message ?? error })
      }
    })
    return this.writing
  }

  /**
   * Add an event.
   *
   * @param {object} request - `{ chatId, userId, title, at, repeat, place, remindBefore }`.
   * @returns {object|undefined} the stored event.
   */
  add({ chatId, userId, title, at, repeat = 'none', place, remindBefore }) {
    const cleanTitle = String(title ?? '').trim().slice(0, 200)
    const when = new Date(at)
    if (chatId === undefined || cleanTitle === '' || Number.isNaN(when.getTime())) return undefined
    if (!EVENT_REPEATS.includes(repeat)) return undefined
    const event = {
      id: String(this.nextId++),
      chatId: Number(chatId),
      userId: userId === undefined ? undefined : Number(userId),
      title: cleanTitle,
      at: when.toISOString(),
      repeat,
      ...(place ? { place: String(place).trim().slice(0, 120) } : {}),
      ...(Number.isFinite(Number(remindBefore)) ? { remindBefore: Math.max(0, Math.min(1440, Math.round(Number(remindBefore)))) } : {}),
      createdAt: new Date().toISOString(),
    }
    this.events.push(event)
    this.enforceBounds()
    return event
  }

  /** Events of one chat, with their next occurrence, sorted by time. */
  list(chatId) {
    const now = new Date()
    return this.events
      .filter((event) => chatId === undefined || event.chatId === Number(chatId))
      .map((event) => ({ ...event, nextAt: event.repeat === 'yearly' ? nextYearly(event.at, now) : event.at }))
      .sort((left, right) => Date.parse(left.nextAt) - Date.parse(right.nextAt))
  }

  /**
   * Events that fall inside a window.
   *
   * @param {number|string} chatId - chat to look at.
   * @param {object} options - `{ from, days }`.
   * @returns {Array<object>} events with `dayKey` and `time`.
   */
  upcoming(chatId, { from = new Date(), days = 1 } = {}) {
    const zone = this.timeZone
    const keys = new Set()
    for (let offset = 0; offset < days; offset++) {
      keys.add(dayKeyInZone(new Date(from.getTime() + offset * 86_400_000), zone))
    }
    return this.list(chatId)
      .filter((event) => keys.has(dayKeyInZone(new Date(event.nextAt), zone)))
      .map((event) => ({ ...event, dayKey: dayKeyInZone(new Date(event.nextAt), zone), time: timeInZone(new Date(event.nextAt), zone) }))
  }

  /** Remove an event by id, or by its number in the chat's list. */
  remove(chatId, idOrNumber) {
    const wanted = String(idOrNumber ?? '').trim()
    const own = this.events.filter((event) => event.chatId === Number(chatId))
    const byNumber = own[Number(wanted) - 1]
    const target = this.events.find((event) => event.id === wanted && event.chatId === Number(chatId)) ?? byNumber
    if (!target) return undefined
    this.events = this.events.filter((event) => event !== target)
    return target
  }

  /** Drop the oldest events once the cap is reached. */
  enforceBounds() {
    if (this.events.length <= MAX_EVENTS) return
    const now = Date.now()
    this.events.sort((left, right) => {
      const leftPast = left.repeat === 'none' && Date.parse(left.at) < now
      const rightPast = right.repeat === 'none' && Date.parse(right.at) < now
      if (leftPast !== rightPast) return leftPast ? -1 : 1
      return Date.parse(left.createdAt ?? left.at) - Date.parse(right.createdAt ?? right.at)
    })
    this.events = this.events.slice(this.events.length - MAX_EVENTS)
  }
}
