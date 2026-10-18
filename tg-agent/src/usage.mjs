/**
 * Token accounting per calendar day, plus the optional daily budget.
 *
 * Design notes:
 *   - the day is the user's day (the configured time zone), not UTC: "за сегодня"
 *     has to mean what the person reading the number thinks it means;
 *   - counters are aggregated, never per message: a month of history stays tiny;
 *   - old days are pruned, so the file cannot grow without bound;
 *   - writes are debounced and atomic, because every answered message records
 *     usage and the state file does not deserve a write per token.
 */
import { createJsonStore } from './storage/json-store.mjs'

const VERSION = 1
const DEFAULT_RETENTION_DAYS = 60
const SAVE_DELAY_MS = 2000

/** Calendar day of `date` in `timeZone`, as `YYYY-MM-DD`. */
export function dayKey(date = new Date(), timeZone = '') {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

const emptyDay = () => ({ prompt: 0, completion: 0, cached: 0, requests: 0, users: {} })

/**
 * Миграция схемы расходов: файл без `version` считаем версией 0.
 * Форма данных та же — дни остаются как есть.
 */
function migrateUsage(data) {
  return {
    ...data,
    days: data?.days != null && typeof data.days === 'object' ? data.days : {},
  }
}

export class UsageStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.retentionDays] - how many days to keep.
   * @param {number} [options.dailyLimit] - token budget per day, 0 disables it.
   * @param {number} [options.saveDelayMs] - debounce for writes.
   */
  constructor({ file, logger, retentionDays = DEFAULT_RETENTION_DAYS, dailyLimit = 0, saveDelayMs = SAVE_DELAY_MS }) {
    this.file = file
    this.logger = logger
    this.retentionDays = retentionDays
    this.dailyLimit = dailyLimit
    this.saveDelayMs = saveDelayMs
    /** @type {Map<string, {prompt: number, completion: number, cached: number, requests: number, users: Record<string, {prompt: number, completion: number, requests: number}>}>} */
    this.days = new Map()
    this.timer = undefined
    // Очередь записей: перекрывающиеся flush не должны перетирать снимки.
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { days: {} },
      migrate: migrateUsage,
      logger,
    })
  }

  /** Прочитать файл через общий слой; битый файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      if (state.days == null || typeof state.days !== 'object') throw new Error('unexpected file format')
      for (const [key, value] of Object.entries(state.days)) {
        this.days.set(key, {
          prompt: Number(value?.prompt) || 0,
          completion: Number(value?.completion) || 0,
          cached: Number(value?.cached) || 0,
          requests: Number(value?.requests) || 0,
          users: value?.users && typeof value.users === 'object' ? value.users : {},
        })
      }
      this.prune()
      this.logger?.info('usage loaded', { days: this.days.size })
    } catch (error) {
      // Старое поведение: чужая версия схемы и ошибки чтения только логируются.
      this.logger?.warn('usage file ignored', { file: this.file, error })
    }
    return this
  }

  /** Counters of one day (never `undefined`). */
  total(date = new Date(), timeZone = '') {
    const day = this.days.get(dayKey(date, timeZone))
    // A copy: callers read counters, they must not be able to mutate the store.
    return day ? { ...day, users: { ...day.users } } : emptyDay()
  }

  /** Total tokens (prompt + completion) of one day. */
  tokens(date = new Date(), timeZone = '') {
    const day = this.total(date, timeZone)
    return day.prompt + day.completion
  }

  /**
   * Counters for the last `days` calendar days, oldest first.
   *
   * Missing days are returned as zeros: the chart must have the same number of
   * bars whether or not the bot was used that day.
   *
   * @param {number} [days] - how many days to return, at least 1.
   * @param {Date} [date] - the last day (today by default).
   * @param {string} [timeZone] - zone used by `dayKey`.
   * @returns {Array<{date: string, prompt: number, completion: number, total: number, requests: number}>}
   */
  recent(days = 7, date = new Date(), timeZone = '') {
    const count = Math.max(1, Math.floor(Number(days) || 7))
    const result = []
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const current = new Date(date)
      current.setDate(current.getDate() - offset)
      const key = dayKey(current, timeZone)
      const day = this.days.get(key)
      const prompt = Number(day?.prompt) || 0
      const completion = Number(day?.completion) || 0
      result.push({
        date: key,
        prompt,
        completion,
        total: prompt + completion,
        requests: Number(day?.requests) || 0,
      })
    }
    return result
  }

  /**
   * Add one model call to the day's counters.
   *
   * @param {object} input - `usage` is the provider payload; the rest is context.
   * @returns {boolean} whether the daily limit is exhausted after this call.
   */
  record({ usage, userId, chatId, date = new Date(), timeZone = '' } = {}) {
    const key = dayKey(date, timeZone)
    let day = this.days.get(key)
    if (!day) {
      day = emptyDay()
      this.days.set(key, day)
    }
    const prompt = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0
    const completion = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0
    const cached = Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0) || 0
    day.prompt += prompt
    day.completion += completion
    day.cached += cached
    day.requests += 1
    const owner = userId === undefined || userId === null ? String(chatId ?? 'unknown') : String(userId)
    const perUser = day.users[owner] ?? { prompt: 0, completion: 0, requests: 0 }
    perUser.prompt += prompt
    perUser.completion += completion
    perUser.requests += 1
    day.users[owner] = perUser
    this.scheduleSave()
    return this.limitReached(date, timeZone)
  }

  /** Whether the day's budget is used up; `limit` 0 means "no budget". */
  limitReached(date = new Date(), timeZone = '') {
    if (!this.dailyLimit) return false
    return this.tokens(date, timeZone) >= this.dailyLimit
  }

  /** Who spent what today, biggest first. */
  byUser(date = new Date(), timeZone = '') {
    const day = this.total(date, timeZone)
    return Object.entries(day.users)
      .map(([userId, value]) => ({ userId, ...value, total: value.prompt + value.completion }))
      .sort((a, b) => b.total - a.total)
  }

  /** Keep only the newest `retentionDays` days. */
  prune() {
    const keys = [...this.days.keys()].sort()
    for (const key of keys.slice(0, Math.max(0, keys.length - this.retentionDays))) this.days.delete(key)
  }

  scheduleSave() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.saveDelayMs)
    this.timer.unref?.()
  }

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // Записи выполняются по очереди, чтобы поздний снимок не затёрся ранним.
    this.writing = this.writing.then(async () => {
      try {
        this.prune()
        this.storage.state.days = Object.fromEntries(this.days)
        await this.storage.flush()
      } catch (error) {
        this.logger?.error('usage save failed', { error })
      }
    })
    return this.writing
  }
}
