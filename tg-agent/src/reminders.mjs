/**
 * Reminders: durable list plus a poll-based scheduler.
 *
 * Design notes:
 *   - the store is a plain JSON file written atomically, so a restart (or a
 *     SIGKILL) never loses a reminder that was already confirmed to the user;
 *   - the scheduler polls instead of keeping one timer per reminder: a single
 *     interval has no timer leaks and behaves predictably after a long sleep or
 *     a clock jump;
 *   - a repeat is advanced in whole days from the previous due instant, which
 *     keeps the local time stable in zones without DST (the common case for a
 *     personal bot).
 */
import { createJsonStore } from './storage/json-store.mjs'
import { REPEAT_VALUES, isRepeat, repeatAfterDelivery } from './domain/repeats.mjs'
import { zonedTimeToUtc } from './domain/reminders.mjs'

const VERSION = 1
/** Допустимые повторы живут в одном месте — `src/domain/repeats.mjs`. */
const REPEATS = REPEAT_VALUES

/**
 * Окно догона: просроченное моложе 12 часов доставляется с пометкой, старше —
 * снимается. Иначе простой бота на сутки вылился бы в лавину старых сообщений.
 */
export const LATE_DELIVERY_WINDOW_MS = 12 * 60 * 60 * 1000

/** Reminder in its stored shape. */
const isReminder = (value) =>
  value != null
  && typeof value.id === 'string'
  && typeof value.chatId === 'number'
  && typeof value.text === 'string'
  && typeof value.dueAt === 'string'
  && Number.isFinite(Date.parse(value.dueAt))
  && isRepeat(value.repeat ?? 'none')
  && (value.userId === undefined || typeof value.userId === 'number')

/**
 * Миграция схемы напоминаний: файл без `version` считаем версией 0.
 * Форма данных в версиях 0 и 1 совпадает, поэтому достаточно отбросить мусор.
 */
function migrateReminders(data) {
  return {
    ...data,
    reminders: Array.isArray(data?.reminders) ? data.reminders.filter(isReminder) : [],
  }
}

export class ReminderStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxPerChat] - reminders allowed per chat.
   * @param {number} [options.maxPerUser] - reminders allowed per user.
   * @param {object} [options.access] - единая проверка доступа (`src/core/access.mjs`).
   */
  constructor({ file, logger, maxPerChat = 50, maxPerUser = 50, access }) {
    this.file = file
    this.logger = logger
    this.maxPerChat = maxPerChat
    this.maxPerUser = maxPerUser
    // Единственная точка проверки доступа. Без неё поведение прежнее: хранилище
    // остаётся пригодным для тестов и одиночных сценариев.
    this.access = access
    /** @type {Array<{id: string, chatId: number, userId?: number, text: string, dueAt: string, repeat: string, createdAt: string}>} */
    this.reminders = []
    this.nextId = 1
    // Очередь записей: слой общий, и перекрывающиеся flush не должны
    // перетирать более свежий снимок состояния.
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { nextId: 1, reminders: [] },
      migrate: migrateReminders,
      logger,
    })
  }

  /** Прочитать файл через общий слой; битый или чужой файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      this.reminders = Array.isArray(state.reminders) ? state.reminders.filter(isReminder) : []
      const highest = this.reminders.reduce((max, reminder) => Math.max(max, Number(reminder.id) || 0), 0)
      this.nextId = Math.max(Number(state.nextId) || 0, highest + 1)
      this.logger?.info('reminders loaded', { count: this.reminders.length })
    } catch (error) {
      // Старое поведение: чужая версия схемы и ошибки чтения только логируются.
      this.logger?.warn('reminder file ignored', { file: this.file, error })
    }
    return this
  }

  /**
   * All reminders, optionally only those of one chat and/or one user.
   *
   * A reminder without `userId` belongs to the chat as a whole (older records);
   * it stays visible to every user of that chat.
   *
   * @param {number} [chatId] - restrict to one chat.
   * @param {number} [userId] - restrict to one user.
   */
  list(chatId, userId) {
    return this.reminders.filter((reminder) => {
      // Запись общего проекта видна участнику из любого чата; личная остаётся
      // привязанной к своему чату.
      if (chatId !== undefined && reminder.chatId !== chatId) {
        if (!this.access || userId === undefined || !this.access.isSharedFor(userId, reminder)) return false
      }
      if (this.access && userId !== undefined) return this.access.canRead(userId, reminder)
      if (userId !== undefined && reminder.userId !== undefined && reminder.userId !== userId) return false
      return true
    })
  }

  /** Reminders that are due at or before `at`. */
  due(at = Date.now()) {
    return this.reminders.filter((reminder) => Date.parse(reminder.dueAt) <= at)
  }

  /**
   * Add one reminder.
   *
   * @param {object} input - `chatId`, `userId`, `text`, `dueAt` (Date or ISO string), `repeat`.
   * @param {string} [input.scopeId] - явное пространство; иначе активный проект или личное.
   * @param {boolean} [input.system] - системная запись (перенос тихого часа), без проверки роли.
   * @returns {object} the stored reminder.
   */
  add({ chatId, userId, text, dueAt, repeat = 'none', scopeId, system = false }) {
    const clean = String(text ?? '').trim()
    if (clean === '') throw new Error('reminder text is required')
    if (clean.length > 500) throw new Error('reminder text is too long')
    if (!isRepeat(repeat)) throw new Error(`repeat must be one of ${REPEATS.slice(0, 6).join(', ')}, …`)
    // A repeat that is not `none` must be known to the advance logic as well.
    const due = dueAt instanceof Date ? dueAt : new Date(dueAt)
    if (Number.isNaN(due.getTime())) throw new Error('reminder time is invalid')
    // The per-user cap is checked first and counts every chat, so it stays
    // reachable and a user cannot spread the same load across chats.
    if (userId !== undefined && this.reminders.filter((item) => String(item.userId) === String(userId)).length >= this.maxPerUser) {
      throw new Error(`too many reminders for this user (${this.maxPerUser})`)
    }
    if (this.list(chatId).length >= this.maxPerChat) throw new Error(`too many reminders in this chat (${this.maxPerChat})`)
    // Область записи выбирает access: активный проект пары «пользователь + чат»
    // или личное пространство. Модель не может подменить пользователя.
    const targetScope = userId === undefined || !this.access
      ? scopeId
      : this.access.scopeIdFor(userId, chatId, scopeId)
    if (targetScope !== undefined && this.access && userId !== undefined && !system && !this.access.canWriteScope(userId, targetScope)) {
      throw new Error('access denied: в этом проекте только просмотр')
    }
    const reminder = {
      id: String(this.nextId++),
      chatId,
      ...(userId === undefined ? {} : { userId }),
      ...(targetScope === undefined ? {} : { scope_id: targetScope }),
      text: clean,
      dueAt: due.toISOString(),
      repeat,
      createdAt: new Date().toISOString(),
    }
    this.reminders.push(reminder)
    return reminder
  }

  /**
   * Remove one reminder of a chat by id; returns it when it existed.
   *
   * With `userId` only that user's reminders (and chat-owned ones) can be
   * removed, so nobody in a group cancels somebody else's reminder.
   */
  cancel(chatId, id, userId) {
    const reminder = this.reminders.find((item) => item.id === String(id))
    if (!reminder) return undefined
    if (this.access && userId !== undefined) {
      // Участник общего проекта может убрать запись из другого чата, но только
      // если у него есть право записи. Viewer не меняет данные никак.
      if (!this.access.canWrite(userId, reminder)) return undefined
    } else {
      if (reminder.chatId !== chatId) return undefined
      if (userId !== undefined && reminder.userId !== undefined && reminder.userId !== userId) return undefined
    }
    this.reminders = this.reminders.filter((item) => item !== reminder)
    return reminder
  }

  /** Drop one reminder by id (used after a one-off fires). */
  remove(id) {
    const index = this.reminders.findIndex((reminder) => reminder.id === String(id))
    if (index !== -1) this.reminders.splice(index, 1)
  }

  /**
   * Move a repeating reminder to its next occurrence after `now`.
   *
   * @param {string} id - reminder id.
   * @param {number} [now] - reference instant.
   * @returns {object | undefined} the updated reminder.
   */
  advance(id, now = Date.now()) {
    const reminder = this.reminders.find((item) => item.id === String(id))
    if (!reminder || reminder.repeat === 'none') return reminder
    // Все расписания (daily, weekdays, weekly:2, monthly:1, every:30 …) разбирает
    // src/domain/repeats.mjs, чтобы планировщик и инструмент не разошлись в «дальше».
    const next = repeatAfterDelivery(reminder, { now: new Date(now) })
    if (next?.dueAt) reminder.dueAt = next.dueAt.toISOString()
    return reminder
  }

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    // Записи выполняются по очереди: так снимок, снятый позже, не затрётся
    // состоянием более раннего вызова.
    this.writing = this.writing.then(async () => {
      try {
        // Синхронизируем доменное состояние с состоянием слоя перед записью.
        this.storage.state.nextId = this.nextId
        this.storage.state.reminders = this.reminders
        await this.storage.flush()
      } catch (error) {
        this.logger?.error('reminder save failed', { error })
      }
    })
    return this.writing
  }
}

export class ReminderScheduler {
  /**
   * @param {object} options - scheduler options.
   * @param {ReminderStore} options.store - reminder storage.
   * @param {(reminder: object) => Promise<void>} options.deliver - sends one reminder.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.intervalMs] - poll period.
   * @param {() => number} [options.now] - clock, injected by tests.
   * @param {boolean} [options.lateNotice] - mark reminders that were overdue at startup.
   * @param {number} [options.lateWindowMs] - окно догона: старше него просроченное
   *   снимается и считается, а не доставляется.
   * @param {(info: {now: number}) => Promise<*>} [options.onTick] - дополнительная
   *   работа на том же таймере (проактивность). Второй `setInterval` не создаётся.
   */
  constructor({ store, deliver, logger, intervalMs = 20_000, now = () => Date.now(), lateNotice = true, lateWindowMs = LATE_DELIVERY_WINDOW_MS, onTick }) {
    this.store = store
    this.deliver = deliver
    this.logger = logger
    this.intervalMs = intervalMs
    this.now = now
    this.lateNotice = lateNotice
    this.lateWindowMs = lateWindowMs
    // Сколько просроченных снято без доставки: значение для журнала и тестов.
    this.droppedCount = 0
    this.onTick = onTick
    this.timer = undefined
    this.firing = false
  }

  /** Start polling and deliver anything already overdue. */
  start() {
    if (this.timer) return this
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    void this.tick()
    return this
  }

  /** Stop polling and persist the store. */
  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.store.flush()
  }

  /**
   * Deliver every due reminder.
   *
   * Overlapping ticks are skipped: a slow `deliver` (a Telegram call) must not
   * fire the same reminder twice.
   *
   * @returns {Promise<number>} how many reminders were delivered.
   */
  async tick() {
    if (this.firing) return 0
    this.firing = true
    let delivered = 0
    try {
      const now = this.now()
      for (const reminder of this.store.due(now)) {
        const late = now - Date.parse(reminder.dueAt)
        try {
          await this.deliver(reminder, { lateMs: late, lateNotice: this.lateNotice && late > this.intervalMs * 2 })
          delivered++
          this.logger?.info('reminder delivered', { id: reminder.id, chatId: reminder.chatId, lateMs: late, repeat: reminder.repeat })
        } catch (error) {
          this.logger?.error('reminder delivery failed', { id: reminder.id, chatId: reminder.chatId, error })
          // Keep it: the next tick retries, so a temporary Telegram outage does
          // not swallow the reminder.
          continue
        }
        if (reminder.repeat === 'none') this.store.remove(reminder.id)
        else this.store.advance(reminder.id, now)
      }
      if (delivered > 0) await this.store.flush()
      // Проактивность живёт на этом же таймере: отдельного интервала нет.
      if (this.onTick) {
        try {
          await this.onTick({ now })
        } catch (error) {
          this.logger?.error('scheduler extra tick failed', { error })
        }
      }
    } finally {
      this.firing = false
    }
    return delivered
  }
}

// Перевод местного времени в момент времени живёт в домене напоминаний.
// Реэкспорт сохраняет прежний публичный API `src/reminders.mjs`.
export { zonedTimeToUtc } from './domain/reminders.mjs'
