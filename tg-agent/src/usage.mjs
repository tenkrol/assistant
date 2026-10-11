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
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1
const DEFAULT_RETENTION_DAYS = 60
const SAVE_DELAY_MS = 2000

/** Calendar day of `date` in `timeZone`, as `YYYY-MM-DD`. */
export function dayKey(date = new Date(), timeZone = '') {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

const emptyDay = () => ({ prompt: 0, completion: 0, cached: 0, requests: 0, users: {} })

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
    this.writing = Promise.resolve()
  }

  /** Read the file when it exists; a corrupt file is reported and replaced. */
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed?.version !== VERSION || parsed.days == null || typeof parsed.days !== 'object') {
        throw new Error('unexpected file format')
      }
      for (const [key, value] of Object.entries(parsed.days)) {
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
      if (error.code !== 'ENOENT') this.logger?.warn('usage file ignored', { file: this.file, error })
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

  /** Persist atomically and wait for the write. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // Serialize writers: two flushes must not race on the same temporary file.
    this.writing = this.writing.then(async () => {
      try {
        this.prune()
        const payload = `${JSON.stringify({ version: VERSION, days: Object.fromEntries(this.days) }, null, 2)}\n`
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        const temporary = `${this.file}.tmp`
        await fs.writeFile(temporary, payload, 'utf8')
        await fs.rename(temporary, this.file)
      } catch (error) {
        this.logger?.error('usage save failed', { error })
      }
    })
    return this.writing
  }
}
