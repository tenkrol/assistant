/**
 * Recurring tasks: a small cron, evaluated in the configured time zone.
 *
 * DSH's headless bundle mounts no scheduler, so the agent keeps its own: five
 * fields (minute hour day-of-month month day-of-week), the usual star, list,
 * range and step forms, and — like Vixie cron — an OR between day-of-month and
 * day-of-week when both are restricted.
 *
 * Everything is computed in the agent's time zone, not in UTC: "по понедельникам
 * в 9:00" has to mean 9:00 where the owner lives. The search walks minutes inside
 * a matching day and jumps straight to the next midnight otherwise, so an annual
 * schedule is still found in milliseconds.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomInt } from 'node:crypto'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAY_NAMES = ['воскресеньям', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам']

const FIELDS = [
  { name: 'минуты', min: 0, max: 59 },
  { name: 'часы', min: 0, max: 23 },
  { name: 'день месяца', min: 1, max: 31 },
  { name: 'месяц', min: 1, max: 12, names: MONTHS, nameOffset: 1 },
  { name: 'день недели', min: 0, max: 7, names: WEEKDAYS, normalize: (value) => (value === 7 ? 0 : value) },
]

/** Error raised for a malformed expression, with the field that is wrong. */
export class CronError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CronError'
  }
}

/** Turn one field into a set of values plus whether it was restricted. */
function parseField(raw, field) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') throw new CronError(`поле «${field.name}» пустое`)

  const values = new Set()
  let restricted = false

  for (const chunk of text.split(',')) {
    const part = chunk.trim()
    if (part === '') throw new CronError(`поле «${field.name}» содержит пустой элемент`)
    const [rangeText, stepText] = part.split('/')
    let step = 1
    if (stepText !== undefined) {
      step = Number(stepText)
      if (!Number.isInteger(step) || step < 1) throw new CronError(`поле «${field.name}»: шаг «${stepText}» должен быть целым числом ≥ 1`)
    }

    let from
    let to
    if (rangeText === '*' || rangeText === '') {
      from = field.min
      to = field.max
    } else if (rangeText.includes('-')) {
      restricted = true
      const [startText, endText] = rangeText.split('-')
      from = convert(startText, field)
      to = convert(endText, field)
    } else {
      restricted = true
      from = convert(rangeText, field)
      to = stepText === undefined ? from : field.max
    }

    if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
      throw new CronError(`поле «${field.name}»: не понимаю «${chunk}»`)
    }
    if (from < field.min || to > field.max || from > to) {
      throw new CronError(`поле «${field.name}»: значение вне диапазона ${field.min}–${field.max}`)
    }
    for (let value = from; value <= to; value += step) values.add(normalise(value, field))
  }

  if (values.size === 0) throw new CronError(`поле «${field.name}» не содержит значений`)
  return { values, restricted }
}

/** A single value: a number, or a three-letter name. */
function convert(text, field) {
  const trimmed = String(text).trim()
  if (trimmed === '') return undefined
  const numeric = Number(trimmed)
  if (Number.isInteger(numeric)) return numeric
  const index = field.names?.indexOf(trimmed.slice(0, 3))
  if (index === undefined || index === -1) return undefined
  return index + (field.nameOffset ?? 0)
}

const normalise = (value, field) => (field.normalize ? field.normalize(value) : value)

/**
 * Parse a five-field cron expression.
 *
 * @param {string} expression - for example `0 9 * * 1-5`.
 * @returns {object} the parsed schedule.
 * @throws {CronError} when the expression is malformed.
 */
export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/).filter((part) => part !== '')
  if (parts.length !== 5) {
    throw new CronError(`нужно 5 полей (минуты часы день-месяца месяц день-недели), получено ${parts.length}`)
  }
  const [minute, hour, dom, month, dow] = parts.map((raw, index) => parseField(raw, FIELDS[index]))
  return { minute, hour, dom, month, dow, source: parts.join(' ') }
}

/** The formatter per time zone; building one is the expensive part. */
const formatters = new Map()
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * The wall-clock fields of one instant in a time zone.
 *
 * @param {Date} date - the instant.
 * @param {string} timeZone - IANA zone.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, dow: number}} local parts.
 */
export function localParts(date, timeZone) {
  const parts = {}
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const weekday = WEEKDAYS.indexOf(String(parts.weekday ?? '').toLowerCase().slice(0, 3))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dow: weekday === -1 ? 0 : weekday,
  }
}

/** Whether the calendar day matches (Vixie OR rule for dom/dow). */
function dayMatches(parsed, local) {
  if (!parsed.month.values.has(local.month)) return false
  const domOk = parsed.dom.values.has(local.day)
  const dowOk = parsed.dow.values.has(local.dow)
  if (parsed.dom.restricted && parsed.dow.restricted) return domOk || dowOk
  if (parsed.dom.restricted) return domOk
  if (parsed.dow.restricted) return dowOk
  return true
}

/**
 * When the schedule fires next.
 *
 * @param {object} parsed - from {@link parseCron}.
 * @param {Date} [from] - the instant to search from (exclusive).
 * @param {object} [options] - `timeZone`, `horizonDays`.
 * @returns {Date|undefined} the next occurrence, or undefined when there is none in the horizon.
 */
export function nextRunAt(parsed, from = new Date(), { timeZone = 'UTC', horizonDays = 400 } = {}) {
  // The next whole minute: a schedule that fires "now" has already fired.
  let cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  const limit = from.getTime() + horizonDays * 86_400_000

  while (cursor.getTime() <= limit) {
    const local = localParts(cursor, timeZone)
    if (!dayMatches(parsed, local)) {
      // Jump to just after the next local midnight instead of walking the day.
      const minutesLeft = Math.max(1, 1440 - (local.hour * 60 + local.minute))
      cursor = new Date(cursor.getTime() + minutesLeft * 60_000)
      continue
    }
    if (parsed.minute.values.has(local.minute) && parsed.hour.values.has(local.hour)) return cursor
    cursor = new Date(cursor.getTime() + 60_000)
  }
  return undefined
}

/**
 * A short human phrase for the common patterns, so `/schedule` reads well.
 *
 * @param {string} expression - the cron expression.
 * @returns {string} Russian description, or the raw expression when unusual.
 */
export function describeCron(expression) {
  const source = String(expression ?? '').trim()
  const parts = source.split(/\s+/)
  if (parts.length !== 5) return source
  const [minute, hour, dom, month, dow] = parts
  const pad = (value) => String(value).padStart(2, '0')
  const timeText = (hourValue, minuteValue) => `${pad(hourValue)}:${pad(minuteValue)}`

  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `каждые ${minute.slice(2)} мин`
  }
  if (/^\d+$/.test(minute) && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return `каждые ${hour.slice(2)} ч в :${pad(minute)}`
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const at = timeText(hour, minute)
    if (dom === '*' && month === '*' && dow === '*') return `каждый день в ${at}`
    if (dom === '*' && month === '*' && dow !== '*') {
      const days = expandDays(dow)
      if (days) return `${days} в ${at}`
    }
    if (month === '*' && dow === '*' && /^\d+$/.test(dom)) return `${dom}-го числа каждого месяца в ${at}`
  }
  return `по cron «${source}»`
}

/** Turn a day-of-week field into «по понедельникам, средам» when it is simple. */
function expandDays(field) {
  const days = []
  for (const chunk of field.split(',')) {
    if (chunk.includes('-')) {
      const [start, end] = chunk.split('-').map(Number)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return undefined
      for (let day = start; day <= end; day += 1) days.push(day % 7)
      continue
    }
    const value = Number(chunk)
    if (!Number.isInteger(value)) return undefined
    days.push(value % 7)
  }
  const unique = [...new Set(days)].sort((a, b) => a - b)
  if (unique.length === 0) return undefined
  if (unique.join(',') === '1,2,3,4,5') return 'по будням'
  if (unique.length === 7) return 'каждый день'
  if (unique.length > 4) return undefined
  return `по ${unique.map((day) => WEEKDAY_NAMES[day]).join(', ')}`
}

/**
 * Split `add` arguments into the cron expression and the task text.
 *
 * The cron may be quoted (`"0 9 * * 1-5" сводка`), which is what the help text
 * suggests, or written bare (`0 9 * * 1-5 сводка`) — five fields, then the task.
 *
 * @param {string} input - everything after `/schedule add`.
 * @returns {{cronText: string, task: string}} the two parts.
 */
export function parseScheduleAdd(input) {
  const text = String(input ?? '').trim()
  if (text === '') return { cronText: '', task: '' }

  const quoted = text.match(/^["«'`]([^"»'`]+)["»'`]\s*([\s\S]*)$/)
  if (quoted) return { cronText: quoted[1].trim(), task: quoted[2].trim() }

  const parts = text.split(/\s+/)
  return { cronText: parts.slice(0, 5).join(' '), task: parts.slice(5).join(' ').trim() }
}

/**
 * The schedules: one small JSON file, rewritten atomically on every change.
 *
 * A schedule survives a restart, and a restart never fires missed runs in a
 * burst: on load the next occurrence is recomputed from now and the skipped
 * count is reported to the owner instead.
 */
export class ScheduleStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file.
   * @param {string} [options.timeZone] - zone the cron is evaluated in.
   * @param {object} [options.logger] - logger.
   */
  constructor({ file, timeZone = 'UTC', logger } = {}) {
    this.file = file
    this.timeZone = timeZone
    this.logger = logger
    /** @type {Map<string, object>} id → schedule. */
    this.schedules = new Map()
    this.counter = 0
  }

  /** Read the file; a corrupt one is reported and replaced on the next write. */
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      for (const record of parsed?.schedules ?? []) {
        if (typeof record?.id === 'string') this.schedules.set(record.id, record)
      }
      this.logger?.info('schedules loaded', { count: this.schedules.size })
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn('schedule file ignored', { file: this.file, error })
    }
    return this
  }

  /** A short id, unique across restarts. */
  nextId() {
    if (this.counter === 0) this.counter = randomInt(1, 46_656)
    this.counter += 1
    return `s${this.counter.toString(36)}`
  }

  all() {
    return [...this.schedules.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  get(id) {
    return this.schedules.get(String(id))
  }

  /**
   * Add one schedule.
   *
   * @param {object} input - `chatId`, `userId`, `cron`, `task`, optional `title`.
   * @returns {Promise<object>} the stored record.
   */
  async add({ chatId, userId, cron, task, title }) {
    const parsed = parseCron(cron)
    const now = new Date()
    const record = {
      id: this.nextId(),
      chatId: String(chatId),
      userId: userId === undefined ? undefined : String(userId),
      cron: parsed.source,
      task: String(task ?? '').trim(),
      title: title ?? String(task ?? '').trim().slice(0, 60),
      enabled: true,
      createdAt: now.getTime(),
      nextRunAt: nextRunAt(parsed, now, { timeZone: this.timeZone })?.getTime(),
      runs: 0,
      missed: 0,
    }
    this.schedules.set(record.id, record)
    await this.save()
    return record
  }

  /** Merge a patch into one schedule. */
  async update(id, patch) {
    const record = this.get(id)
    if (!record) return undefined
    Object.assign(record, patch)
    await this.save()
    return record
  }

  /** Forget one schedule. */
  async remove(id) {
    const existed = this.schedules.delete(String(id))
    if (existed) await this.save()
    return existed
  }

  /**
   * Recompute the next occurrence of every enabled schedule from `now`.
   *
   * `graceMs` keeps a restart from counting a run that only just became due as
   * "missed": a schedule that was due 40 seconds ago is simply the next tick's
   * business, not a lost day.
   *
   * @param {Date} [from] - the moment to recompute from.
   * @param {object} [options] - `graceMs`.
   * @returns {Promise<number>} how many schedules really missed a run.
   */
  async refresh(from = new Date(), { graceMs = 0 } = {}) {
    let missed = 0
    for (const record of this.schedules.values()) {
      if (!record.enabled) continue
      const parsed = parseCron(record.cron)
      const due = record.nextRunAt === undefined ? undefined : new Date(record.nextRunAt)
      const overdue = due !== undefined && from.getTime() - due.getTime() > graceMs
      if (overdue) missed += 1
      const next = nextRunAt(parsed, from, { timeZone: this.timeZone })
      record.nextRunAt = next?.getTime()
      record.missed = (record.missed ?? 0) + (overdue ? 1 : 0)
    }
    await this.save()
    return missed
  }

  /** Write the file atomically. */
  async save() {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const payload = `${JSON.stringify({ version: 1, timeZone: this.timeZone, schedules: this.all() }, null, 2)}\n`
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, payload, 'utf8')
      await fs.rename(temporary, this.file)
    } catch (error) {
      this.logger?.error('schedule save failed', { error })
    }
  }
}
