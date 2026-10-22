/**
 * Repeat schedules for reminders: the vocabulary behind `repeat`.
 *
 * A reminder stores `repeat` as a plain string (the original triple was
 * `none | daily | weekly`), so widening the vocabulary does not change the
 * shape of a stored record and older files stay readable. This module owns two
 * things only: what a `repeat` value may be, and when it should fire next.
 *
 * Deliberate simplification, documented rather than accidental: all comparisons
 * happen in absolute time through `Date`, and the calendar fields used to place
 * a repeat (day of week, day of month) are read with the `getUTC*` / `Date.UTC`
 * family. No IANA zone is consulted at any point, and the time of day of the
 * next occurrence is copied verbatim from `dueAt` as stored. For a zone with a
 * whole-hour offset this is exact; near midnight local a weekday or month
 * boundary can belong to the neighbouring local day, and a zone that observes
 * DST can see the local clock drift by an hour across a transition. That is the
 * same trade-off the original day-based `advance()` made, kept on purpose so a
 * new schedule cannot silently reinterpret an already stored reminder.
 */

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

const WEEKLY_FIRST = 1
const WEEKLY_LAST = 7
const MONTHLY_FIRST = 1
const MONTHLY_LAST = 31
const EVERY_FIRST_MINUTES = 5
const EVERY_LAST_MINUTES = 1440
const EVERY_STEP_MINUTES = 5
/**
 * Минимальный интервал для нового напоминания.
 *
 * Публичный словарь по-прежнему знает `every:5`: старые записи должны
 * переноситься, а мини-приложение — показывать прежние варианты. Но создать
 * новый повтор чаще 15 минут нельзя — это и объясняет `repeatIssue`.
 */
const EVERY_CREATE_MIN_MINUTES = 15

/**
 * Границы интервального повтора — для текстов об ошибке в инструменте.
 *
 * `minMinutes` — порог создания (15 минут), `acceptedFromMinutes` — нижняя
 * граница словаря, куда входят уже сохранённые записи начиная с 5 минут.
 */
export const EVERY_LIMITS = Object.freeze({
  minMinutes: EVERY_CREATE_MIN_MINUTES,
  acceptedFromMinutes: EVERY_FIRST_MINUTES,
  maxMinutes: EVERY_LAST_MINUTES,
  stepMinutes: EVERY_STEP_MINUTES,
})

/** Inclusive integer range, used only to build the value list below. */
function range(from, to, step = 1) {
  const values = []
  for (let value = from; value <= to; value += step) values.push(value)
  return values
}

/**
 * Every accepted `repeat` value.
 *
 * - `none` — fires once, no repeat;
 * - `daily` — every day at the same time of day;
 * - `weekly` — every 7 days from the previous firing;
 * - `weekdays` — Monday through Friday;
 * - `weekly:1` … `weekly:7` — one weekday, 1 = Monday … 7 = Sunday;
 * - `monthly:1` … `monthly:31` — that day of the month (clamped to the last
 *   day of a shorter month);
 * - `every:5` … `every:1440` — каждые N минут, N кратно 5.
 */
export const REPEAT_VALUES = [
  'none',
  'daily',
  'weekly',
  'weekdays',
  ...range(WEEKLY_FIRST, WEEKLY_LAST).map((day) => `weekly:${day}`),
  ...range(MONTHLY_FIRST, MONTHLY_LAST).map((day) => `monthly:${day}`),
  ...range(EVERY_FIRST_MINUTES, EVERY_LAST_MINUTES, EVERY_STEP_MINUTES).map((minutes) => `every:${minutes}`),
]

const REPEAT_SET = new Set(REPEAT_VALUES)

/** Pattern for one weekday; the value is guaranteed valid by `isRepeat`. */
const WEEKLY_RE = /^weekly:([1-7])$/
/** Pattern for one day of the month. */
const MONTHLY_RE = /^monthly:(\d{1,2})$/
/** Pattern for a minute interval. */
const EVERY_RE = /^every:(\d{1,4})$/

/** Accusative weekday phrases, indexed like `Date#getUTCDay` (0 = Sunday). */
const WEEKDAY_LABELS = [
  'каждое воскресенье',
  'каждый понедельник',
  'каждый вторник',
  'каждую среду',
  'каждый четверг',
  'каждую пятницу',
  'каждую субботу',
]

/**
 * Is `value` a supported repeat?
 *
 * @param {unknown} value - candidate value from a stored reminder or a tool call.
 * @returns {boolean} `true` when `nextDue` and `describeRepeat` understand it.
 */
export const isRepeat = (value) => typeof value === 'string' && REPEAT_SET.has(value)

/**
 * Почему интервал `every:N` не принят — человеческими словами.
 *
 * Возвращает `undefined` для любого корректного значения и для мусора, который
 * не похож на `every:N`: там инструмент скажет общий текст. Отдельная причина
 * нужна именно интервалам, чтобы «каждые 10 минут» не превращались молча в
 * «каждые 15», а человек увидел, что именно поправить.
 *
 * @param {unknown} value - запрошенный повтор.
 * @returns {string | undefined} причина отказа или `undefined`.
 */
export function repeatIssue(value) {
  const match = /^every:(-?\d+)$/.exec(String(value ?? ''))
  if (match) {
    const minutes = Number(match[1])
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) return undefined
    if (minutes < EVERY_CREATE_MIN_MINUTES) {
      return `минимальный интервал — ${EVERY_CREATE_MIN_MINUTES} минут`
    }
    if (minutes > EVERY_LAST_MINUTES) {
      return `максимальный интервал — ${EVERY_LAST_MINUTES} минут (24 часа)`
    }
    if (minutes % EVERY_STEP_MINUTES !== 0) {
      return `интервал должен быть кратен ${EVERY_STEP_MINUTES} минутам`
    }
    return undefined
  }
  return undefined
}

/**
 * Russian label for a repeat.
 *
 * @param {unknown} value - repeat value.
 * @returns {string | undefined} a human phrase, or `undefined` for an unknown
 *   value. Unknown values are reported rather than silently rendered as "no
 *   repeat", so a bad record is visible to the caller; callers that want a
 *   fallback should use `isRepeat` and pick their own default.
 */
export function describeRepeat(value) {
  if (!isRepeat(value)) return undefined
  if (value === 'none') return 'без повтора'
  if (value === 'daily') return 'каждый день'
  if (value === 'weekly') return 'каждую неделю'
  if (value === 'weekdays') return 'по будням'
  const weekly = WEEKLY_RE.exec(value)
  if (weekly) return WEEKDAY_LABELS[Number(weekly[1]) % 7]
  const monthly = MONTHLY_RE.exec(value)
  if (monthly) return `${Number(monthly[1])}-го числа каждого месяца`
  const every = EVERY_RE.exec(value)
  if (every) return `каждые ${Number(every[1])} минут`
  return undefined
}

/**
 * Normalise a `Date` / ISO string / epoch number to a valid `Date`.
 *
 * @param {unknown} value - instant to normalise.
 * @returns {Date | undefined} a valid date, or `undefined` when unparseable.
 */
function toInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }
  return undefined
}

/** Is this instant a Saturday or a Sunday on the UTC calendar? */
const isWeekend = (ms) => {
  const day = new Date(ms).getUTCDay()
  return day === 0 || day === 6
}

/**
 * First instant of the series `anchor + k * step` (k >= 1) strictly after `now`.
 *
 * One step is always taken first, which mirrors the original `advance()`: a
 * repeat moves the reminder forward from the instant it fired and never returns
 * that instant itself. The closed form jumps straight to the last period, so an
 * outage of months costs the same as a delay of one period and can never yield a
 * burst of catch-up firings — exactly one future instant comes back.
 *
 * @param {number} anchorMs - previous firing (or the stored due instant).
 * @param {number} stepMs - period, strictly positive.
 * @param {number} nowMs - reference instant.
 * @returns {number} epoch milliseconds of the next firing.
 */
function firstStepAfter(anchorMs, stepMs, nowMs) {
  let next = anchorMs + stepMs
  if (next <= nowMs) next += (Math.floor((nowMs - next) / stepMs) + 1) * stepMs
  return next
}

/** Number of days in a UTC month (month is 0-based). */
const daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/**
 * Nearest `dayOfMonth`-th at the stored time of day, strictly after `reference`.
 *
 * A month shorter than `dayOfMonth` contributes its last day instead (the 31st
 * becomes the 28th/29th of February, the 30th of April, and so on).
 */
function nextMonthly(due, reference, dayOfMonth) {
  const time = [due.getUTCHours(), due.getUTCMinutes(), due.getUTCSeconds(), due.getUTCMilliseconds()]
  let year = reference.getUTCFullYear()
  let month = reference.getUTCMonth()
  for (let attempt = 0; attempt < 2; attempt++) {
    const day = Math.min(dayOfMonth, daysInMonth(year, month))
    const candidate = Date.UTC(year, month, day, ...time)
    if (candidate > reference.getTime()) return candidate
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }
  return undefined
}

/**
 * Nearest `isoDay` (1 = Monday … 7 = Sunday) at the stored time of day, strictly
 * after `reference`.
 *
 * Unlike plain `weekly`, this re-reads the calendar from `now`: the day is the
 * next one that matches, and only the time of day comes from `dueAt`. If today
 * is already that weekday and its time of day has not passed, today is the
 * answer; otherwise it is today plus seven days.
 */
function nextWeeklyDay(due, reference, isoDay) {
  const time = [due.getUTCHours(), due.getUTCMinutes(), due.getUTCSeconds(), due.getUTCMilliseconds()]
  const target = isoDay % 7
  const midnight = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), ...time)
  const delta = (target - reference.getUTCDay() + 7) % 7
  let candidate = midnight + delta * DAY_MS
  if (candidate <= reference.getTime()) candidate += 7 * DAY_MS
  return candidate
}

/**
 * When a reminder with this repeat should fire next, strictly after `now`.
 *
 * Expected use is the delivery path: `dueAt` is the instant that just fired, so
 * `dueAt <= now`. The contract is only "strictly later than `now`"; for an
 * undelivered reminder (`dueAt > now`) the calendar-based schedules (`weekly:N`,
 * `monthly:D`) may return an instant before `dueAt`, while the fixed-step ones
 * (`daily`, `weekly`, `every:N`) always move one full period past `dueAt`.
 *
 * @param {Date | string | number} dueAt - previous firing / stored due instant.
 * @param {unknown} repeat - one of `REPEAT_VALUES`.
 * @param {object} [options] - options.
 * @param {Date | string | number} [options.now] - reference instant, defaults to now.
 * @returns {Date | undefined} the next firing, or `undefined` for `none`, for an
 *   unknown repeat or for an unparseable `dueAt` — never throws.
 */
export function nextDue(dueAt, repeat, { now = new Date() } = {}) {
  if (!isRepeat(repeat) || repeat === 'none') return undefined
  const due = toInstant(dueAt)
  const reference = toInstant(now)
  if (!due || !reference) return undefined

  const dueMs = due.getTime()
  const nowMs = reference.getTime()

  // `daily`: whole 24h steps from the previous instant, which keeps the stored
  // local time stable in zones without DST (the common case for a personal bot).
  if (repeat === 'daily') return new Date(firstStepAfter(dueMs, DAY_MS, nowMs))

  // `weekly`: a fixed 7*24h step, deliberately *not* "re-read the same weekday
  // from the calendar". Re-reading would shift the reminder by an hour across a
  // DST switch; a plain multiple of 24h cannot. This is what the original
  // day-based advance() did.
  if (repeat === 'weekly') return new Date(firstStepAfter(dueMs, 7 * DAY_MS, nowMs))

  // `weekdays`: walk whole days forward from the previous instant, skipping
  // Saturday and Sunday. Friday therefore lands on Monday, and so do Saturday
  // and Sunday.
  if (repeat === 'weekdays') {
    let next = firstStepAfter(dueMs, DAY_MS, nowMs)
    while (isWeekend(next)) next += DAY_MS
    return new Date(next)
  }

  const weekly = WEEKLY_RE.exec(repeat)
  if (weekly) return new Date(nextWeeklyDay(due, reference, Number(weekly[1])))

  const monthly = MONTHLY_RE.exec(repeat)
  if (monthly) return new Date(nextMonthly(due, reference, Number(monthly[1])))

  // `every:N` lives on a fixed grid anchored at the first firing
  // (dueAt + k*N minutes). After a long outage a single instant is returned:
  // the first grid point strictly after `now`. Missed points are neither
  // replayed (no burst of notifications) nor collapsed into "now" — the grid
  // the user asked for is preserved. For a delivered reminder (dueAt <= now)
  // the result is therefore always later than `now` and never further away than
  // one interval; `firstStepAfter` reaches it in constant time, so a sleep of
  // several months costs the same as a delay of one period.
  const every = EVERY_RE.exec(repeat)
  if (every) return new Date(firstStepAfter(dueMs, Number(every[1]) * MINUTE_MS, nowMs))

  return undefined
}

/**
 * New schedule for a reminder that has just been delivered.
 *
 * Опорный момент берётся из `anchorAt`: это исходный срок серии, а не текущий
 * `dueAt`. Поэтому повторный вызов с теми же входными данными возвращает тот же
 * момент — сдвиг идемпотентен, а тик и рестарт не перескакивают через интервал.
 * Старые записи без `anchorAt` продолжают считаться от своего `dueAt`.
 *
 * @param {{dueAt?: unknown, anchorAt?: unknown, repeat?: unknown}} reminder - stored reminder.
 * @param {object} [options] - options.
 * @param {Date | string | number} [options.now] - reference instant, defaults to now.
 * @returns {{dueAt: Date, repeat: string} | undefined} the fields to store back
 *   (`dueAt` is a `Date`; call `.toISOString()` for the stored string shape), or
 *   `undefined` when the reminder must not repeat.
 */
export function repeatAfterDelivery(reminder, { now = new Date() } = {}) {
  const repeat = reminder?.repeat ?? 'none'
  if (!isRepeat(repeat) || repeat === 'none') return undefined
  const anchor = reminder?.anchorAt ?? reminder?.dueAt
  const dueAt = nextDue(anchor, repeat, { now })
  if (!dueAt) return undefined
  return { dueAt, repeat }
}
