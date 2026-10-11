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
import fs from 'node:fs/promises'
import path from 'node:path'
import { REPEAT_VALUES, isRepeat, repeatAfterDelivery } from './repeats.mjs'

const VERSION = 1
/** Allowed repeat values live in one place: `src/repeats.mjs`. */
const REPEATS = REPEAT_VALUES

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

export class ReminderStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxPerChat] - reminders allowed per chat.
   * @param {number} [options.maxPerUser] - reminders allowed per user.
   */
  constructor({ file, logger, maxPerChat = 50, maxPerUser = 50 }) {
    this.file = file
    this.logger = logger
    this.maxPerChat = maxPerChat
    this.maxPerUser = maxPerUser
    /** @type {Array<{id: string, chatId: number, userId?: number, text: string, dueAt: string, repeat: string, createdAt: string}>} */
    this.reminders = []
    this.nextId = 1
    this.writing = Promise.resolve()
  }

  /** Read the file when it exists; a corrupt file is reported and replaced. */
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed?.version !== VERSION || !Array.isArray(parsed.reminders)) throw new Error('unexpected file format')
      this.reminders = parsed.reminders.filter(isReminder)
      const highest = this.reminders.reduce((max, reminder) => Math.max(max, Number(reminder.id) || 0), 0)
      this.nextId = Math.max(Number(parsed.nextId) || 0, highest + 1)
      this.logger?.info('reminders loaded', { count: this.reminders.length })
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn('reminder file ignored', { file: this.file, error })
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
      if (chatId !== undefined && reminder.chatId !== chatId) return false
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
   * @returns {object} the stored reminder.
   */
  add({ chatId, userId, text, dueAt, repeat = 'none' }) {
    const clean = String(text ?? '').trim()
    if (clean === '') throw new Error('reminder text is required')
    if (clean.length > 500) throw new Error('reminder text is too long')
    if (!isRepeat(repeat)) throw new Error(`repeat must be one of ${REPEATS.slice(0, 6).join(', ')}, …`)
    // A repeat that is not `none` must be known to the advance logic as well.
    const due = dueAt instanceof Date ? dueAt : new Date(dueAt)
    if (Number.isNaN(due.getTime())) throw new Error('reminder time is invalid')
    // The per-user cap is checked first and counts every chat, so it stays
    // reachable and a user cannot spread the same load across chats.
    if (userId !== undefined && this.list(undefined, userId).length >= this.maxPerUser) {
      throw new Error(`too many reminders for this user (${this.maxPerUser})`)
    }
    if (this.list(chatId).length >= this.maxPerChat) throw new Error(`too many reminders in this chat (${this.maxPerChat})`)
    const reminder = {
      id: String(this.nextId++),
      chatId,
      ...(userId === undefined ? {} : { userId }),
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
    const index = this.reminders.findIndex((reminder) => {
      if (reminder.chatId !== chatId || reminder.id !== String(id)) return false
      if (userId === undefined) return true
      return reminder.userId === undefined || reminder.userId === userId
    })
    if (index === -1) return undefined
    const [removed] = this.reminders.splice(index, 1)
    return removed
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
    // Every pattern (daily, weekdays, weekly:2, monthly:1, every:30 …) is handled by
    // src/repeats.mjs, so the scheduler and the tool never disagree about «дальше».
    const next = repeatAfterDelivery(reminder, { now: new Date(now) })
    if (next?.dueAt) reminder.dueAt = next.dueAt.toISOString()
    return reminder
  }

  /** Persist atomically and wait for the write. */
  async flush() {
    try {
      const payload = `${JSON.stringify({ version: VERSION, nextId: this.nextId, reminders: this.reminders }, null, 2)}\n`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, payload, 'utf8')
      await fs.rename(temporary, this.file)
    } catch (error) {
      this.logger?.error('reminder save failed', { error })
    }
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
   */
  constructor({ store, deliver, logger, intervalMs = 20_000, now = () => Date.now(), lateNotice = true }) {
    this.store = store
    this.deliver = deliver
    this.logger = logger
    this.intervalMs = intervalMs
    this.now = now
    this.lateNotice = lateNotice
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
    } finally {
      this.firing = false
    }
    return delivered
  }
}

/**
 * Turn an ISO string into the instant it denotes.
 *
 * A string with an explicit offset or `Z` already names an instant, so it is
 * honoured as written. A naive wall-clock string ("2026-10-06T09:00", which is
 * what a model usually produces) is interpreted in `timeZone`: the offset is
 * derived from `Intl` at that instant and applied once, which is exact outside
 * DST edges.
 *
 * @param {string} localIso - ISO time, with or without a zone.
 * @param {string} timeZone - IANA zone for naive input, empty means the system zone.
 * @returns {Date} the corresponding instant.
 */
export function zonedTimeToUtc(localIso, timeZone = '') {
  const value = String(localIso ?? '').trim()
  if (/(?:[+-]\d{2}:?\d{2}|Z)$/i.test(value)) {
    const explicit = new Date(value)
    if (Number.isNaN(explicit.getTime())) throw new Error(`cannot parse time: ${localIso}`)
    return explicit
  }
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const naive = new Date(`${value}Z`)
  if (Number.isNaN(naive.getTime())) throw new Error(`cannot parse time: ${localIso}`)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(naive).map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  const offsetMs = asUtc - Math.floor(naive.getTime() / 1000) * 1000
  return new Date(naive.getTime() - offsetMs)
}
