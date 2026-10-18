/**
 * Полезная проактивность (BP-04, PLB-020).
 *
 * Здесь живут три вещи, которые должны быть проверяемы без Telegram и сети:
 *  1. правила домена — какие события вообще стоят уведомления, как они
 *     объединяются по ключу, сколько живут и в каком порядке идут;
 *  2. хранилище `proactive.json` через общий слой состояния: версия схемы,
 *     миграция с копией, идемпотентность и транзакции;
 *  3. сервис, который вызывает существующий планировщик напоминаний. Второго
 *     таймера нет: `ReminderScheduler` раз в свой интервал зовёт `tick()`.
 *
 * Отдельно про «существенную разницу»: обычный heartbeat и неизменившийся
 * статус новостью не являются. Кандидат появляется только при переносе,
 * новом препятствии, завершении, ошибке или ожидающем решении. Уже отправленное
 * событие не повторяется: ключ и состояние доставки лежат в файле.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createJsonStore } from './storage/json-store.mjs'
import { quietHoursEnd, resolveZone } from './domain/reminders.mjs'

/** Версия схемы `proactive.json`. */
export const PROACTIVE_VERSION = 1
/** Дневной предел инициативных уведомлений; обзор считается отдельно. */
export const DEFAULT_DAY_LIMIT = 3
/** Один обзор в день. */
export const REVIEW_LIMIT = 1
/** Сколько важных пунктов максимум показывает обзор. */
export const DEFAULT_REVIEW_MAX = 5
/** На сколько откладывается уведомление кнопкой. */
export const DEFAULT_SNOOZE_MINUTES = 30
/** Просроченное напоминание старше этого срока в обзор не попадает. */
const REMINDER_GRACE_MS = 12 * 60 * 60 * 1000
/** Уведомление о переносе встречи живёт два часа после нового времени. */
const EVENT_TTL_MS = 2 * 60 * 60 * 1000
/** Изменение задачи живёт сутки: позже это уже история, а не новость. */
const TASK_TTL_MS = 24 * 60 * 60 * 1000
/** Захват доставки другим экземпляром считается брошенным через 5 минут. */
const CLAIM_TTL_MS = 5 * 60 * 1000
/** Сколько записей журнала решений храним. */
const JOURNAL_LIMIT = 500
/** Разница во времени, ниже которой переносом не считается. */
const MOVE_EPSILON_MS = 60_000

/**
 * Приоритеты заданы кодом, а не решением модели.
 *
 * Чем больше число, тем раньше событие попадает в бюджет и в обзор.
 */
export const PRIORITY = Object.freeze({
  task_error: 100,
  task_completed: 90,
  task_blocked: 80,
  event_moved: 70,
  task_moved: 65,
  task_waiting: 60,
  event_soon: 50,
  reminder: 30,
  review: 10,
})

/** Категории, которые можно отключить кнопкой «отключить этот тип». */
export const CATEGORIES = Object.freeze(['reminder', 'event', 'task', 'review'])

const DEFAULT_CATEGORIES = Object.freeze({ reminder: true, event: true, task: true, review: true })
const TYPE_LABEL = Object.freeze({ reminder: 'напоминания', event: 'встречи', task: 'поручения', review: 'обзор' })

const STATUS_COMPLETED = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'finished'])
const STATUS_ERROR = new Set(['error', 'failed', 'failure', 'crashed', 'timeout'])
const STATUS_BLOCKED = new Set(['blocked', 'obstacle', 'stuck', 'needs_help'])
const STATUS_WAITING = new Set(['waiting', 'needs_decision', 'decision', 'question', 'approval', 'review', 'paused'])
const STATUS_MOVED = new Set(['moved', 'rescheduled', 'postponed', 'deadline_moved'])

const pad = (value) => String(value).padStart(2, '0')
const asDate = (value) => (value instanceof Date ? value : new Date(value))
const iso = (value) => asDate(value).toISOString()
const validTime = (value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value ?? ''))
const validZone = (zone) => {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Местные части времени по IANA-поясу.
 *
 * Смещение нигде не хранится: каждый раз оно вычисляется через `Intl`, поэтому
 * переход на летнее время и смена пояса не дают сдвига.
 *
 * @param {Date|string|number} value - момент времени.
 * @param {string} [timeZone] - IANA-пояс, пусто — системный.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number}} части.
 */
export function localParts(value, timeZone = '') {
  const date = asDate(value)
  const zone = resolveZone(timeZone)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Некоторые локали отдают «24» для полуночи.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  }
}

/** Локальная дата `ГГГГ-ММ-ДД` по IANA-поясу. */
export function dayKeyInZone(value, timeZone = '') {
  const { year, month, day } = localParts(value, timeZone)
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Местное время суток в минутах от полуночи. */
export function localMinutes(value, timeZone = '') {
  const { hour, minute } = localParts(value, timeZone)
  return hour * 60 + minute
}

/** Локальное `ЧЧ:ММ` — для текстов уведомлений. */
export function formatLocalTime(value, timeZone = '') {
  const { hour, minute } = localParts(value, timeZone)
  return `${pad(hour)}:${pad(minute)}`
}

/** Локальная дата словами: «18 октября, воскресенье». */
export function formatLocalDate(value, timeZone = '') {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: resolveZone(timeZone),
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  }).format(asDate(value))
}

/**
 * Перевести местное время в момент времени без ошибки на переходе DST.
 *
 * `zonedTimeToUtc` в домене напоминаний делает один проход и после перехода
 * вперёд может ошибиться на час. Здесь смещение подбирается итеративно через
 * `Intl`: для несуществующего местного времени (весенний пропуск) возвращается
 * первый момент после пропуска.
 *
 * @param {string} localIso - местное время `ГГГГ-ММ-ДДTЧЧ:ММ[:СС]`.
 * @param {string} [timeZone] - IANA-пояс, пусто — системный.
 * @returns {Date} соответствующий момент.
 */
export function localTimeToInstant(localIso, timeZone = '') {
  const value = String(localIso ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) throw new Error(`cannot parse local time: ${localIso}`)
  const [, year, month, day, hour, minute, second = '0'] = match
  const zone = resolveZone(timeZone)
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  let guess = target
  let afterGap
  for (let index = 0; index < 8; index++) {
    const parts = localParts(new Date(guess), zone)
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
    const delta = target - represented
    if (delta === 0) {
      return new Date(Math.floor(guess / 60_000) * 60_000)
    }
    // В весеннем пропуске итерация начинает ходить вокруг дыры: запоминаем
    // ближайший момент уже после неё и выбираем его.
    if (represented > target && (afterGap === undefined || guess < afterGap)) afterGap = guess
    guess += delta
  }
  return new Date(afterGap ?? guess)
}

/** Начало следующих местных суток — верхняя граница TTL обзора. */
export function endOfDayInstant(value, timeZone = '') {
  const { year, month, day } = localParts(value, timeZone)
  const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000)
  const key = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
  return localTimeToInstant(`${key}T00:00:00`, timeZone)
}

/** Момент обзора сегодня по местным часам. */
export function reviewInstant(value, settings = {}) {
  const zone = settings.tz ?? ''
  const key = dayKeyInZone(value, zone)
  const time = validTime(settings.reviewAt) ? settings.reviewAt : '09:00'
  return localTimeToInstant(`${key}T${time}`, zone)
}

/**
 * Сейчас тихие часы?
 *
 * Окно может пересекать полночь; сравнение идёт по местным минутам, а не по
 * смещению, поэтому DST не ломает границу.
 *
 * @param {Date|string|number} value - момент времени.
 * @param {object} settings - настройки проактивности (`quiet`, `tz`).
 * @returns {boolean} true, если сейчас нельзя беспокоить.
 */
export function isQuietNow(value, settings = {}) {
  const quiet = settings.quiet
  if (!quiet || quiet.start === quiet.end) return false
  const minutes = localMinutes(value, settings.tz ?? '')
  const crossesMidnight = quiet.start > quiet.end
  return crossesMidnight
    ? (minutes >= quiet.start || minutes < quiet.end)
    : (minutes >= quiet.start && minutes < quiet.end)
}

/** Привести окно тихих часов к `{start,end}` в минутах или к `null`. */
export function normalizeQuiet(value) {
  if (value === null || value === false) return null
  if (!value || typeof value !== 'object') return null
  const start = Number(value.start)
  const end = Number(value.end)
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || start > 1439 || end < 0 || end > 1439 || start === end) return null
  return { start, end }
}

/**
 * Полные настройки проактивности с безопасными значениями по умолчанию.
 *
 * @param {object} [input] - сохранённые настройки.
 * @param {object} [fallback] - значения из конфигурации: `timeZone`, `quiet`, `dayLimit`.
 * @returns {object} настройки, пригодные для расчётов.
 */
export function normalizeSettings(input = {}, { timeZone = '', quiet, dayLimit = DEFAULT_DAY_LIMIT, reviewMax = DEFAULT_REVIEW_MAX, snoozeMinutes = DEFAULT_SNOOZE_MINUTES, reviewAt = '09:00' } = {}) {
  const zone = validZone(input.tz) ? input.tz : (validZone(timeZone) ? timeZone : resolveZone(''))
  const fallbackQuiet = quiet === undefined ? { start: 23 * 60, end: 8 * 60 } : quiet
  const window = input.quiet === undefined ? normalizeQuiet(fallbackQuiet) : normalizeQuiet(input.quiet)
  const categories = { ...DEFAULT_CATEGORIES }
  for (const [key, value] of Object.entries(input.categories ?? {})) {
    if (CATEGORIES.includes(key)) categories[key] = value !== false
  }
  const channels = { text: true, ...(input.channels && typeof input.channels === 'object' ? input.channels : {}) }
  const limit = Number(input.dayLimit ?? dayLimit)
  const max = Number(input.reviewMax ?? reviewMax)
  const snooze = Number(input.snoozeMinutes ?? snoozeMinutes)
  return {
    tz: zone,
    reviewAt: validTime(input.reviewAt) ? input.reviewAt : (validTime(reviewAt) ? reviewAt : '09:00'),
    quiet: window,
    channels,
    categories,
    dayLimit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DAY_LIMIT,
    reviewMax: Number.isInteger(max) && max > 0 ? max : DEFAULT_REVIEW_MAX,
    snoozeMinutes: Number.isInteger(snooze) && snooze > 0 ? snooze : DEFAULT_SNOOZE_MINUTES,
  }
}

/** Ключ события: стабильный, поэтому дубли объединяются, а перенос виден. */
export const candidateKey = (type, id) => `${type}:${id}`

/** Один кандидат в том виде, в котором он попадает в план и в файл. */
function makeCandidate({ type, id, title, plannedAt, expiresAt, priority, reason, source, change, detail, reviewOnly = false, userId, chatId, record, extra } = {}) {
  return {
    key: candidateKey(type, id),
    type,
    title: String(title ?? '').trim() || 'Событие',
    plannedAt: iso(plannedAt),
    expiresAt: iso(expiresAt ?? plannedAt),
    priority: Number(priority) || 0,
    reason: String(reason ?? ''),
    source: String(source ?? ''),
    ...(change === undefined ? {} : { change }),
    ...(detail === undefined || detail === '' ? {} : { detail: String(detail) }),
    reviewOnly: Boolean(reviewOnly),
    ...(userId === undefined ? {} : { userId }),
    ...(chatId === undefined ? {} : { chatId }),
    ...(record?.scope_id === undefined ? {} : { scope_id: record.scope_id }),
    ...(extra ?? {}),
  }
}

/** Тип изменения поручения по его статусу; `undefined` — новости нет. */
export function taskChangeOf(task = {}) {
  const status = String(task.status ?? task.type ?? task.state ?? '').toLowerCase()
  if (STATUS_COMPLETED.has(status)) return 'completed'
  if (STATUS_ERROR.has(status)) return 'error'
  if (STATUS_BLOCKED.has(status)) return 'blocked'
  if (STATUS_MOVED.has(status)) return 'moved'
  if (STATUS_WAITING.has(status)) return 'waiting'
  return undefined
}

/** Причины отказа по задаче для журнала решений. */
export const TASK_ACCESS_DENIED_REASON = 'задача отфильтрована по доступу'
export const TASK_OWNER_UNKNOWN_REASON = 'у задачи нет проверенного владельца'

/**
 * Владелец и область задачи из проверенного источника.
 *
 * Мост агента и старые записи называют одни и те же поля по-разному. Никакой
 * идентичности из текста задачи не выводим: неизвестный владелец остаётся
 * неизвестным и не считается общедоступным.
 *
 * @param {object} task - поручение из источника.
 * @returns {{userId?: string|number, scopeId?: string}} principal.
 */
export function taskPrincipal(task = {}) {
  const userId = task?.userId ?? task?.ownerId
  const scopeId = task?.scope_id ?? task?.scopeId
  return {
    ...(userId === undefined || userId === null || userId === '' ? {} : { userId }),
    ...(scopeId === undefined || scopeId === null || scopeId === '' ? {} : { scopeId: String(scopeId) }),
  }
}

/** Запись для единой проверки доступа: владелец и область задачи. */
export function taskAccessRecord(task = {}) {
  const principal = taskPrincipal(task)
  return {
    ...(principal.userId === undefined ? {} : { userId: principal.userId }),
    ...(principal.scopeId === undefined ? {} : { scope_id: principal.scopeId }),
  }
}

/**
 * Видна ли задача этому получателю.
 *
 * Без `access` сохраняется прежнее поведение одного пользователя: проверять
 * нечем. С `access` задача без проверенного владельца не показывается никому.
 */
export function canReadTask(userId, task, access) {
  if (!access) return true
  if (userId === undefined || userId === null) return false
  const principal = taskPrincipal(task)
  if (principal.userId === undefined) return false
  if (typeof access.canRead !== 'function') return false
  return access.canRead(userId, taskAccessRecord(task))
}

/** Существенная ли разница между прежним состоянием и новым кандидатом. */
export function isSignificantChange(previous, candidate) {
  if (!previous) return true
  if (previous.change !== candidate.change) return true
  if (previous.change === 'moved' || candidate.change === 'moved') {
    return Math.abs(Date.parse(previous.plannedAt) - Date.parse(candidate.plannedAt)) > MOVE_EPSILON_MS
  }
  return false
}

/** Объяснение «почему это пришло» для одного события. */
export function candidateWhy(candidate) {
  const reason = candidate?.reason || 'значимое изменение'
  const source = candidate?.source || 'источник не указан'
  return `Почему: ${reason}. Источник: ${source}.`
}

/** Текст инициативного уведомления: причина и источник прямо в сообщении. */
export function notificationText(candidate) {
  const lines = [`🔔 ${candidate.title}`]
  if (candidate.detail) lines.push(candidate.detail)
  lines.push(candidateWhy(candidate))
  return lines.join('\n')
}

/** Кнопки уведомления: открыть, выполнено, отложить, отключить тип. */
export function proactiveKeyboard(key) {
  return {
    rows: [
      [{ text: '👁 Открыть', data: `pro:open:${key}` }],
      [{ text: '✅ Выполнено', data: `pro:done:${key}` }, { text: '⏰ Отложить', data: `pro:snooze:${key}` }],
      [{ text: '🔕 Отключить этот тип', data: `pro:mute:${key}` }],
    ],
  }
}

/**
 * Собрать кандидатов из существующих источников.
 *
 * Напоминания и события уже лежат в своих хранилищах; поручения приходят из
 * моста агента. Напоминания попадают только в обзор: явно заданное напоминание
 * доставляет прежний планировщик, и второй раз о нём не сообщаем.
 *
 * @param {object} options - `now`, `reminders`, `events`, `tasks`, `previous`,
 *   `userId`, `chatId`, `settings`, `access`, `onDenied`.
 * @returns {Array<object>} кандидаты без дублей, по убыванию приоритета.
 */
export function collectCandidates({ now = new Date(), reminders = [], events = [], tasks = [], previous = [], userId, chatId, settings = {}, access, onDenied } = {}) {
  const at = asDate(now)
  const config = normalizeSettings(settings)
  const day = dayKeyInZone(at, config.tz)
  const dayEnd = endOfDayInstant(at, config.tz)
  const previousByKey = new Map((previous ?? []).map((item) => [item.key, item]))
  const canRead = (record) => {
    if (!access || userId === undefined || !record) return true
    return access.canRead(userId, record)
  }
  const list = []

  for (const reminder of reminders ?? []) {
    if (!reminder?.id || !reminder.dueAt) continue
    const due = asDate(reminder.dueAt)
    if (Number.isNaN(due.getTime())) continue
    // Только сегодняшние сроки: далёкое напоминание ещё не повод для обзора.
    if (due.getTime() >= dayEnd.getTime()) continue
    if (due.getTime() < at.getTime() - REMINDER_GRACE_MS) continue
    if (!canRead(reminder)) continue
    list.push(makeCandidate({
      type: 'reminder',
      id: reminder.id,
      title: `Срок: ${reminder.text}`,
      plannedAt: due,
      expiresAt: new Date(Math.max(dayEnd.getTime(), due.getTime())),
      priority: PRIORITY.reminder,
      reason: 'срок напоминания',
      source: 'напоминания',
      userId: reminder.userId ?? userId,
      chatId: reminder.chatId ?? chatId,
      record: reminder,
      reviewOnly: true,
    }))
  }

  for (const event of events ?? []) {
    if (!event?.id) continue
    const when = asDate(event.nextAt ?? event.at)
    if (Number.isNaN(when.getTime())) continue
    if (!canRead(event)) continue
    const key = candidateKey('event', event.id)
    const previousItem = previousByKey.get(key)
    const pending = Boolean(previousItem && ['planned', 'snoozed', 'failed', 'claimed'].includes(previousItem.state))
    const today = dayKeyInZone(when, config.tz) === day
    const movedNow = Boolean(previousItem && Math.abs(Date.parse(previousItem.plannedAt) - when.getTime()) > MOVE_EPSILON_MS)
    const snoozedDue = Boolean(previousItem?.state === 'snoozed'
      && (!previousItem.snoozeUntil || Date.parse(previousItem.snoozeUntil) <= at.getTime()))
    if (!today && !movedNow && !pending && !snoozedDue) continue
    if (when.getTime() > dayEnd.getTime() + 86_400_000) continue
    if (!movedNow && snoozedDue) {
      // Отложенное событие вернулось в срок и всё ещё существует: повторяем
      // сохранённое уведомление, не выдавая срок snooze за перенос встречи.
      list.push({
        ...previousItem,
        key,
        type: 'event',
        reviewOnly: false,
        reasons: [previousItem.reason],
      })
      continue
    }
    if (movedNow) {
      const was = formatLocalTime(previousItem.plannedAt, config.tz)
      const nowText = formatLocalTime(when, config.tz)
      list.push(makeCandidate({
        type: 'event',
        id: event.id,
        title: `Встреча перенесена: ${event.title ?? 'без названия'}`,
        plannedAt: when,
        expiresAt: new Date(when.getTime() + EVENT_TTL_MS),
        priority: PRIORITY.event_moved,
        reason: `перенос времени с ${was} на ${nowText}`,
        source: 'календарь',
        change: 'moved',
        detail: event.place ? `Место: ${event.place}` : undefined,
        userId: event.userId ?? userId,
        chatId: event.chatId ?? chatId,
        record: event,
      }))
      continue
    }
    list.push(makeCandidate({
      type: 'event',
      id: event.id,
      title: event.title ?? 'Встреча',
      plannedAt: when,
      expiresAt: new Date(Math.max(dayEnd.getTime(), when.getTime())),
      priority: PRIORITY.event_soon,
      reason: 'встреча в календаре',
      source: 'календарь',
      detail: `${formatLocalTime(when, config.tz)}${event.place ? `, ${event.place}` : ''}`,
      userId: event.userId ?? userId,
      chatId: event.chatId ?? chatId,
      record: event,
      reviewOnly: true,
    }))
  }

  for (const task of tasks ?? []) {
    const id = task?.taskId ?? task?.id
    if (id === undefined || id === null || id === '') continue
    const key = candidateKey('task', id)
    const principal = taskPrincipal(task)
    // ACL задачи — до кандидатов и обзора. Отказ пишется в журнал решений без
    // текста задачи: причина видна, чужих данных в журнале нет.
    if (access && !canReadTask(userId, task, access)) {
      onDenied?.({
        kind: 'filtered',
        key,
        type: 'task',
        reason: principal.userId === undefined ? TASK_OWNER_UNKNOWN_REASON : TASK_ACCESS_DENIED_REASON,
        source: `поручение ${id}`,
      })
      continue
    }
    const change = taskChangeOf(task)
    // Выполняется, статус не менялся — heartbeat, а не новость.
    if (!change) continue
    const previousItem = previousByKey.get(key)
    const pending = Boolean(previousItem && ['planned', 'snoozed', 'failed', 'claimed'].includes(previousItem.state))
    // Пока событие не доставлено (ждёт бюджета, отложено), оно остаётся
    // кандидатом даже без новой разницы — иначе оно потерялось бы до TTL.
    if (!pending && !isSignificantChange(previousItem, { change, plannedAt: task.updatedAt ?? task.at ?? at })) {
      continue
    }
    const title = String(task.title ?? task.subject ?? task.name ?? `Поручение ${id}`)
    const planned = asDate(task.updatedAt ?? task.at ?? task.dueAt ?? at)
    const expires = change === 'waiting'
      ? new Date(Math.max(dayEnd.getTime(), at.getTime()))
      : new Date(planned.getTime() + TASK_TTL_MS)
    const reasons = {
      completed: 'поручение завершено',
      error: 'ошибка поручения',
      blocked: 'новое препятствие',
      moved: 'срок поручения перенесён',
      waiting: 'поручение ждёт решения',
    }
    list.push(makeCandidate({
      type: 'task',
      id,
      title: change === 'completed'
        ? `Поручение выполнено: ${title}`
        : change === 'error'
          ? `Ошибка поручения: ${title}`
          : change === 'blocked'
            ? `Препятствие: ${title}`
            : change === 'moved'
              ? `Перенос срока: ${title}`
              : `Ждёт решения: ${title}`,
      plannedAt: planned,
      expiresAt: expires,
      priority: PRIORITY[`task_${change}`] ?? PRIORITY.task_waiting,
      reason: reasons[change],
      source: `поручение ${id}`,
      change,
      detail: task.error ? String(task.error).slice(0, 200) : (task.obstacle ? String(task.obstacle).slice(0, 200) : undefined),
      // `userId` кандидата — получатель доставки, а не владелец задачи: так
      // запись в `items` принадлежит тому, кому её отправили. Владелец и
      // область остаются в `subjectUserId`/`scope_id` для повторной проверки.
      userId: userId ?? principal.userId,
      chatId: chatId ?? task.chatId,
      record: taskAccessRecord(task),
      extra: principal.userId === undefined ? undefined : { subjectUserId: principal.userId },
      reviewOnly: change === 'waiting',
    }))
  }

  return mergeCandidates(list)
}

/**
 * Объединить одинаковые события по ключу.
 *
 * Одно логическое уведомление на ключ: остаётся больший приоритет, более ранний
 * срок и общая причина без повторов.
 *
 * @param {Array<object>} candidates - кандидаты, возможно с дублями.
 * @returns {Array<object>} уникальные кандидаты по убыванию приоритета.
 */
export function mergeCandidates(candidates = []) {
  const merged = new Map()
  for (const candidate of candidates) {
    if (!candidate?.key) continue
    const existing = merged.get(candidate.key)
    if (!existing) {
      merged.set(candidate.key, { ...candidate, reasons: [candidate.reason] })
      continue
    }
    const reasons = [...new Set([...(existing.reasons ?? []), candidate.reason].filter(Boolean))]
    merged.set(candidate.key, {
      ...existing,
      title: existing.priority >= candidate.priority ? existing.title : candidate.title,
      priority: Math.max(existing.priority, candidate.priority),
      plannedAt: new Date(Math.min(Date.parse(existing.plannedAt), Date.parse(candidate.plannedAt))).toISOString(),
      expiresAt: new Date(Math.max(Date.parse(existing.expiresAt), Date.parse(candidate.expiresAt))).toISOString(),
      reviewOnly: existing.reviewOnly && candidate.reviewOnly,
      detail: existing.detail ?? candidate.detail,
      change: existing.change ?? candidate.change,
      reasons,
      reason: reasons.join('; '),
    })
  }
  return [...merged.values()].sort((left, right) => (
    right.priority - left.priority || Date.parse(left.plannedAt) - Date.parse(right.plannedAt)
  ))
}

/**
 * Текст обзора: встречи, сроки, ожидающие решения и не больше `reviewMax`
 * важных пунктов. Пустой обзор не отправляется.
 *
 * @param {object} options - `now`, `settings`, `events`, `reminders`, `tasks`,
 *   `candidates`, `unavailable`, `timeZone`.
 * @returns {{text?: string, empty: boolean, keys: string[], count: number, unavailable: string[]}} результат.
 */
export function buildReviewMessage({ now = new Date(), settings = {}, events = [], reminders = [], tasks = [], candidates = [], unavailable = [], timeZone = '' } = {}) {
  const config = normalizeSettings(settings, { timeZone })
  const at = asDate(now)
  const dayEnd = endOfDayInstant(at, config.tz)
  const points = []
  const push = (point) => {
    if (points.some((existing) => existing.key === point.key)) return
    points.push(point)
  }

  for (const event of events ?? []) {
    const when = asDate(event.nextAt ?? event.at)
    if (Number.isNaN(when.getTime())) continue
    if (when.getTime() >= dayEnd.getTime() || when.getTime() < at.getTime() - 60 * 60 * 1000) continue
    push({
      key: candidateKey('event', event.id),
      section: 'Встречи',
      text: `${formatLocalTime(when, config.tz)} — ${event.title ?? 'встреча'}${event.place ? ` (${event.place})` : ''}`,
      priority: PRIORITY.event_soon,
      plannedAt: when,
    })
  }

  for (const reminder of reminders ?? []) {
    if (!reminder?.id || !reminder.dueAt) continue
    const due = asDate(reminder.dueAt)
    if (Number.isNaN(due.getTime())) continue
    if (due.getTime() >= dayEnd.getTime() || due.getTime() < at.getTime() - REMINDER_GRACE_MS) continue
    push({
      key: candidateKey('reminder', reminder.id),
      section: 'Сроки',
      text: `${formatLocalTime(due, config.tz)} — ${reminder.text}`,
      priority: PRIORITY.reminder,
      plannedAt: due,
    })
  }

  for (const task of tasks ?? []) {
    const status = String(task?.status ?? task?.type ?? '').toLowerCase()
    if (!task || !STATUS_WAITING.has(status)) continue
    const id = task.taskId ?? task.id
    if (id === undefined) continue
    push({
      key: candidateKey('task', id),
      section: 'Ждут решения',
      text: String(task.title ?? task.subject ?? `Поручение ${id}`),
      priority: PRIORITY.task_waiting,
      plannedAt: asDate(task.updatedAt ?? task.at ?? at),
    })
  }

  for (const candidate of candidates ?? []) {
    if (candidate.reviewOnly || candidate.type === 'review') continue
    push({
      key: candidate.key,
      section: 'Важно',
      text: candidate.title,
      priority: candidate.priority,
      plannedAt: asDate(candidate.plannedAt),
    })
  }

  const sorted = points.sort((left, right) => right.priority - left.priority || left.plannedAt - right.plannedAt)
  const picked = sorted.slice(0, config.reviewMax)
  const unavailableList = [...new Set((unavailable ?? []).filter(Boolean))]
  if (picked.length === 0 && unavailableList.length === 0) {
    return { empty: true, keys: [], count: 0, unavailable: [] }
  }

  const lines = [`🗓 **Обзор на ${formatLocalDate(at, config.tz)}**`]
  const sections = ['Встречи', 'Сроки', 'Ждут решения', 'Важно']
  for (const section of sections) {
    const own = picked.filter((point) => point.section === section)
    if (own.length === 0) continue
    lines.push('', `**${section}**`)
    for (const point of own) lines.push(`— ${point.text}`)
  }
  if (unavailableList.length > 0) {
    lines.push('')
    for (const source of unavailableList) lines.push(`⚠️ ${source}: источник недоступен, данные не получены.`)
  }
  lines.push('', `_Почему: обзор по расписанию в ${config.reviewAt} (${config.tz}). Источник: календарь, напоминания, поручения._`)
  return {
    text: lines.join('\n'),
    empty: false,
    keys: picked.map((point) => point.key),
    count: picked.length,
    unavailable: unavailableList,
  }
}

/** Пустое состояние нового `proactive.json`. */
function defaultState(settings) {
  return {
    watermark: { at: null, reviewDay: null },
    sentToday: { date: null, count: 0, reviews: 0 },
    items: [],
    settings,
    journal: [],
  }
}

const ITEM_STATES = new Set(['planned', 'claimed', 'sent', 'failed', 'snoozed', 'done', 'cancelled', 'reviewed', 'muted', 'expired'])

/** Запись о доставке в допустимой форме. */
function normalizeItem(value) {
  if (value == null || typeof value !== 'object') return undefined
  if (typeof value.key !== 'string' || value.key === '') return undefined
  if (!['reminder', 'event', 'task', 'review'].includes(value.type)) return undefined
  if (Number.isNaN(Date.parse(value.plannedAt)) || Number.isNaN(Date.parse(value.expiresAt))) return undefined
  return {
    ...value,
    state: ITEM_STATES.has(value.state) ? value.state : 'planned',
    attempts: Number(value.attempts) || 0,
    priority: Number(value.priority) || 0,
  }
}

/** Привести состояние файла к полной форме, не потеряв записи. */
function normalizeState(data, settings) {
  const source = data && typeof data === 'object' ? data : {}
  const sent = source.sentToday && typeof source.sentToday === 'object' ? source.sentToday : {}
  const watermark = source.watermark && typeof source.watermark === 'object' ? source.watermark : {}
  return {
    ...source,
    watermark: {
      at: typeof watermark.at === 'string' ? watermark.at : null,
      reviewDay: typeof watermark.reviewDay === 'string' ? watermark.reviewDay : null,
    },
    sentToday: {
      date: typeof sent.date === 'string' ? sent.date : null,
      count: Number(sent.count) || 0,
      reviews: Number(sent.reviews) || 0,
    },
    items: Array.isArray(source.items) ? source.items.map(normalizeItem).filter(Boolean) : [],
    settings: normalizeSettings(source.settings ?? {}, {
      timeZone: settings?.tz ?? '',
      quiet: settings?.quiet,
      dayLimit: settings?.dayLimit,
      reviewAt: settings?.reviewAt,
      reviewMax: settings?.reviewMax,
      snoozeMinutes: settings?.snoozeMinutes,
    }),
    journal: Array.isArray(source.journal)
      ? source.journal.filter((entry) => entry && typeof entry === 'object').slice(-JOURNAL_LIMIT)
      : [],
  }
}

/** Миграция схемы `proactive.json`: версия 0 — файл без `version`. */
function migrateProactive(data, from, to, settings) {
  const next = normalizeState(data, settings)
  return { ...next, version: to }
}

/** Запись журнала в допустимой форме. */
function journalEntry(entry, now) {
  return {
    at: iso(now),
    kind: String(entry.kind ?? 'skip'),
    ...(entry.key === undefined ? {} : { key: String(entry.key) }),
    ...(entry.type === undefined ? {} : { type: String(entry.type) }),
    ...(entry.title === undefined ? {} : { title: String(entry.title) }),
    reason: String(entry.reason ?? ''),
    ...(entry.source === undefined ? {} : { source: String(entry.source) }),
    ...(entry.userId === undefined ? {} : { userId: entry.userId }),
    ...(entry.chatId === undefined ? {} : { chatId: entry.chatId }),
    ...(entry.text === undefined ? {} : { text: String(entry.text) }),
    ...(entry.dryRun ? { dryRun: true } : {}),
  }
}

/**
 * Хранилище проактивности: `proactive.json` в общем слое состояния.
 *
 * Миграция идёт с копией файла и идемпотентна: второй запуск не делает новую
 * копию и не меняет уже заполненные настройки. Для двух экземпляров планировщика
 * важна `claim`: она под замком читает актуальный файл, проверяет бюджет и
 * помечает событие захваченным, поэтому одно уведомление не уйдёт дважды.
 */
export class ProactiveStore {
  /**
   * @param {object} options - `file`, `logger`, `timeZone`, `quiet`,
   *   `reviewAt`, `dayLimit`, `reviewMax`, `snoozeMinutes`.
   */
  constructor({ file, logger, timeZone = '', quiet, reviewAt = '09:00', dayLimit = DEFAULT_DAY_LIMIT, reviewMax = DEFAULT_REVIEW_MAX, snoozeMinutes = DEFAULT_SNOOZE_MINUTES } = {}) {
    this.file = file
    this.logger = logger
    this.baseSettings = normalizeSettings({}, { timeZone, quiet, reviewAt, dayLimit, reviewMax, snoozeMinutes })
    this.storage = createJsonStore({
      file,
      version: PROACTIVE_VERSION,
      defaults: defaultState(this.baseSettings),
      migrate: (data, from, to) => migrateProactive(data, from, to, this.baseSettings),
      logger,
    })
  }

  /**
   * Дочитать файл и, если он старой схемы, оставить копию до миграции.
   *
   * Копия делается ровно один раз: после миграции в файле есть `version` и
   * `settings`, поэтому повторный запуск её не создаёт.
   */
  async preserveBeforeMigration() {
    if (!this.file) return false
    let raw
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    const found = Number(parsed?.version)
    const finite = Number.isFinite(found)
    const oldVersion = !finite || found < PROACTIVE_VERSION
    if (!oldVersion && parsed?.settings) return false
    // Старую версию копирует общий слой состояния; здесь копия нужна только
    // тогда, когда версия та же, а настроек ещё нет (иначе было бы две копии).
    if (!(finite && found < PROACTIVE_VERSION)) {
      const target = `${this.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.copyFile(this.file, target).catch(() => {})
      this.logger?.info?.('proactive: копия перед миграцией настроек', { file: this.file, copy: target })
    }
    return true
  }

  /** Прочитать файл; битый или чужой файл не роняет бота. */
  async load() {
    const migrated = await this.preserveBeforeMigration()
    try {
      await this.storage.load()
      this.applyDefaults()
      // Миграция должна попасть на диск сразу: иначе следующий запуск снова
      // увидел бы старую схему и сделал бы вторую копию.
      if (migrated) await this.storage.flush()
    } catch (error) {
      this.logger?.warn('proactive file ignored', { file: this.file, error: error?.message ?? error })
    }
    return this
  }

  /** Перечитать актуальный файл перед тиком: второй экземпляр мог уже отправить. */
  async refresh() {
    await this.storage.load()
    this.applyDefaults()
    return this
  }

  /** Дополнить состояние полями схемы, если файл той же версии их не содержит. */
  applyDefaults() {
    const normalized = normalizeState(this.storage.state, this.baseSettings)
    Object.assign(this.storage.state, normalized)
    return this
  }

  /** Сохранить состояние. */
  async flush() {
    return this.storage.flush()
  }

  /** Полное состояние: удобно для диагностики и тестов. */
  get state() {
    return this.storage.state
  }

  get settings() {
    return this.storage.state.settings
  }

  get items() {
    return this.storage.state.items ?? []
  }

  get watermark() {
    return this.storage.state.watermark ?? {}
  }

  get journal() {
    return this.storage.state.journal ?? []
  }

  /** Запись по ключу. */
  itemOf(key) {
    return this.items.find((item) => item.key === key)
  }

  /**
   * Счётчики на местную дату `now`.
   *
   * @param {Date} now - момент проверки.
   * @returns {{date: string, count: number, reviews: number}} бюджет дня.
   */
  sentToday(now = new Date()) {
    const day = dayKeyInZone(now, this.settings.tz)
    const sent = this.storage.state.sentToday ?? {}
    if (sent.date !== day) return { date: day, count: 0, reviews: 0 }
    return { date: day, count: Number(sent.count) || 0, reviews: Number(sent.reviews) || 0 }
  }

  /** Сбросить счётчики при смене местной даты и убрать старую историю. */
  rollover(state, now) {
    const day = dayKeyInZone(now, state.settings.tz)
    if (!state.sentToday || state.sentToday.date !== day) {
      state.sentToday = { date: day, count: 0, reviews: 0 }
    }
    // Завершённые записи нужны только для дедупликации и разбора недавних
    // решений: хранить их вечно в JSON-файле нельзя.
    const cutoff = now.getTime() - 14 * 86_400_000
    state.items = (state.items ?? []).filter((item) => {
      if (!['sent', 'done', 'cancelled', 'reviewed', 'muted', 'expired'].includes(item.state)) return true
      const stamp = Date.parse(item.updatedAt ?? item.sentAt ?? item.plannedAt)
      return Number.isNaN(stamp) || stamp >= cutoff
    })
    return day
  }

  /** Добавить решения в журнал, не разрастаясь бесконечно. */
  async note(entries = [], now = new Date()) {
    if (entries.length === 0) return this
    await this.storage.transaction((state) => {
      state.journal = Array.isArray(state.journal) ? state.journal : []
      for (const entry of entries) state.journal.push(journalEntry(entry, now))
      if (state.journal.length > JOURNAL_LIMIT) state.journal = state.journal.slice(-JOURNAL_LIMIT)
      state.watermark = state.watermark ?? {}
      state.watermark.at = iso(now)
    })
    return this
  }

  /**
   * Захватить событие под доставку и зарезервировать место в бюджете.
   *
   * Всё чтение и запись идут в одной транзакции: второй экземпляр увидит
   * состояние `claimed`/`sent` и не отправит то же событие ещё раз.
   *
   * @param {object} candidate - событие с ключом и данными.
   * @param {object} options - `now`, `review`.
   * @returns {Promise<object>} `{ok, reason?, item?, budget?}`.
   */
  async claim(candidate, { now = new Date(), review = false } = {}) {
    const at = asDate(now)
    return this.storage.transaction((state) => {
      const day = this.rollover(state, at)
      let item = state.items.find((entry) => entry.key === candidate.key)
      if (!item) {
        item = normalizeItem({
          ...candidate,
          state: 'planned',
          attempts: 0,
          reserved: false,
          createdAt: iso(at),
          updatedAt: iso(at),
        })
        if (!item) return { ok: false, reason: 'некорректное событие' }
        state.items.push(item)
      }
      const deny = (reason) => ({ ok: false, reason })
      if (['sent', 'done', 'cancelled', 'reviewed', 'muted', 'expired'].includes(item.state)) return deny(`состояние ${item.state}`)
      if (item.state === 'claimed' && item.claimedAt && at.getTime() - Date.parse(item.claimedAt) < CLAIM_TTL_MS) {
        return deny('уже отправляется другим экземпляром')
      }
      if (item.nextAttemptAt && at.getTime() < Date.parse(item.nextAttemptAt)) return deny('ожидает повтора')
      if (item.expiresAt && at.getTime() > Date.parse(item.expiresAt)) {
        item.state = 'expired'
        item.updatedAt = iso(at)
        return deny('истёк срок актуальности')
      }
      if (review) {
        if (state.sentToday.reviews >= REVIEW_LIMIT) return deny('обзор на сегодня уже отправлен')
        if (!item.reserved) {
          state.sentToday.reviews += 1
          item.reserved = true
        }
      } else {
        if (state.sentToday.count >= state.settings.dayLimit) return deny('дневной предел исчерпан')
        if (!item.reserved) {
          state.sentToday.count += 1
          item.reserved = true
        }
      }
      item.state = 'claimed'
      item.claimedAt = iso(at)
      item.updatedAt = iso(at)
      item.attempts = (Number(item.attempts) || 0) + 1
      return {
        ok: true,
        item: { ...item },
        day,
        budget: { ...state.sentToday },
      }
    })
  }

  /** Доставка удалась: состояние `sent`, отметка watermark. */
  async finish(key, { now = new Date(), state: finalState = 'sent', reviewDay } = {}) {
    const at = asDate(now)
    await this.storage.transaction((draft) => {
      const item = draft.items.find((entry) => entry.key === key)
      if (item) {
        item.state = finalState
        item.sentAt = iso(at)
        item.updatedAt = iso(at)
        item.reserved = false
        delete item.claimedAt
      }
      draft.watermark = draft.watermark ?? {}
      draft.watermark.at = iso(at)
      if (reviewDay) draft.watermark.reviewDay = reviewDay
    })
    return this
  }

  /** Отметить событие выполненным/отложенным/отменённым без отправки. */
  async setState(key, state, { now = new Date(), reason } = {}) {
    const at = asDate(now)
    await this.storage.transaction((draft) => {
      const item = draft.items.find((entry) => entry.key === key)
      if (!item) return
      if (item.reserved) {
        // Возврат резерва: попытка не состоялась.
        if (item.type === 'review') draft.sentToday.reviews = Math.max(0, (draft.sentToday.reviews || 0) - 1)
        else draft.sentToday.count = Math.max(0, (draft.sentToday.count || 0) - 1)
        item.reserved = false
      }
      item.state = state
      item.updatedAt = iso(at)
      if (reason) item.reason = reason
      delete item.claimedAt
    })
    return this
  }

  /** Доставка сорвалась: вернуть резерв и назначить backoff. */
  async release(key, { now = new Date(), error } = {}) {
    const at = asDate(now)
    await this.storage.transaction((draft) => {
      const item = draft.items.find((entry) => entry.key === key)
      if (!item) return
      if (item.reserved) {
        if (item.type === 'review') draft.sentToday.reviews = Math.max(0, (draft.sentToday.reviews || 0) - 1)
        else draft.sentToday.count = Math.max(0, (draft.sentToday.count || 0) - 1)
        item.reserved = false
      }
      item.state = 'failed'
      item.updatedAt = iso(at)
      item.lastError = String(error?.message ?? error ?? 'ошибка доставки').slice(0, 200)
      const backoff = Math.min(30 * 60 * 1000, 60 * 1000 * Math.max(1, Number(item.attempts) || 1))
      item.nextAttemptAt = iso(new Date(at.getTime() + backoff))
      delete item.claimedAt
    })
    return this
  }

  /** Отложить событие на `minutes`: при повторной проверке оно ещё актуально? */
  async snooze(key, { now = new Date(), minutes = DEFAULT_SNOOZE_MINUTES } = {}) {
    const at = asDate(now)
    let result
    await this.storage.transaction((draft) => {
      const item = draft.items.find((entry) => entry.key === key)
      if (!item) return
      if (item.reserved) {
        if (item.type === 'review') draft.sentToday.reviews = Math.max(0, (draft.sentToday.reviews || 0) - 1)
        else draft.sentToday.count = Math.max(0, (draft.sentToday.count || 0) - 1)
        item.reserved = false
      }
      const planned = new Date(at.getTime() + minutes * 60_000)
      item.state = 'snoozed'
      // `plannedAt` остаётся исходным сроком события: иначе перенос встречи
      // выглядел бы как «перенос с времени snooze».
      item.snoozeUntil = iso(planned)
      item.nextAttemptAt = iso(planned)
      item.updatedAt = iso(at)
      if (item.type === 'review') {
        // Отложенный обзор — это перенос того же обзора, а не второй за день.
        draft.watermark = draft.watermark ?? {}
        draft.watermark.reviewDay = null
        draft.sentToday.reviews = Math.max(0, (draft.sentToday.reviews || 0) - 1)
      }
      if (Date.parse(item.expiresAt) < planned.getTime()) item.expiresAt = iso(new Date(planned.getTime() + 60 * 60 * 1000))
      result = { ...item }
      delete item.claimedAt
    })
    return result
  }

  /** Отключить категорию уведомлений. */
  async mute(type) {
    await this.storage.transaction((draft) => {
      draft.settings.categories = { ...draft.settings.categories, [type]: false }
    })
    return this
  }

  /** Обзор пропущен: отметить день, чтобы не пытаться снова каждую минуту. */
  async skipReview(day, reason, { now = new Date() } = {}) {
    const at = asDate(now)
    await this.storage.transaction((draft) => {
      draft.watermark = draft.watermark ?? {}
      draft.watermark.reviewDay = day
      draft.watermark.at = iso(at)
    })
    return this
  }

  /** Пункты, показанные в обзоре, больше не отправляем как инициативу. */
  async markReviewed(keys = [], { now = new Date() } = {}) {
    if (keys.length === 0) return this
    const at = asDate(now)
    await this.storage.transaction((draft) => {
      for (const key of keys) {
        const item = draft.items.find((entry) => entry.key === key)
        if (!item) continue
        if (['sent', 'done', 'cancelled'].includes(item.state)) continue
        item.state = 'reviewed'
        item.updatedAt = iso(at)
      }
    })
    return this
  }

  /** Пометка watermark после тика без решений. */
  async touch(now = new Date()) {
    await this.storage.transaction((draft) => {
      draft.watermark = draft.watermark ?? {}
      draft.watermark.at = iso(now)
    })
    return this
  }
}

/**
 * Сервис проактивности.
 *
 * Второго таймера не создаёт: `tick()` зовёт существующий планировщик
 * напоминаний. Флаг `enabled=false` переводит сервис в dry-run: решения
 * считаются и попадают в журнал, но `deliver` не вызывается и бюджет не
 * расходуется.
 */
export class ProactiveService {
  /**
   * @param {object} options - параметры сервиса.
   * @param {ProactiveStore} options.store - хранилище `proactive.json`.
   * @param {object} [options.sources] - `{ reminders, events, tasks }`; у первых
   *   двух есть `list()`, `tasks` — функция, возвращающая массив поручений.
   * @param {Array<{userId: number|string, chatId: number|string}>} [options.targets] - кому доставлять.
   * @param {(chatId: number|string, text: string, keyboard?: object) => Promise<void>} options.deliver - доставка.
   * @param {object} [options.access] - единая проверка доступа (`src/core/access.mjs`).
   * @param {object} [options.logger] - логгер.
   * @param {boolean} [options.enabled] - false = dry-run.
   * @param {number} [options.intervalMs] - как часто считать план.
   * @param {() => Date} [options.now] - часы, подменяются в тестах.
   */
  constructor({ store, sources = {}, targets = [], deliver, access, logger, enabled = false, intervalMs = 60_000, now = () => new Date() } = {}) {
    this.store = store
    this.sources = sources
    this.targets = targets
    this.deliver = deliver
    this.access = access
    this.logger = logger
    this.enabled = Boolean(enabled)
    this.intervalMs = intervalMs
    this.now = now
    this.ticking = false
    this.lastTickAt = 0
    // Повтор одного и того же решения не должен засорять журнал каждый тик.
    this.reported = new Set()
  }

  /** Настройки из файла: тихие часы, лимиты, категории. */
  get settings() {
    return this.store.settings
  }

  /** Категория включена? */
  categoryEnabled(type) {
    if (!this.settings.categories) return true
    return this.settings.categories[type] !== false
  }

  /** Канал включён? Сейчас у бота один текстовый канал. */
  channelEnabled() {
    return this.settings.channels?.text !== false
  }

  /**
   * Собрать сырые данные источников; ошибка источника — это «недоступен», а не
   * «ничего нет».
   *
   * @param {Date} now - момент сбора.
   * @returns {Promise<object>} `{reminders, events, tasks, unavailable}`.
   */
  async gather(now) {
    const gathered = { reminders: [], events: [], tasks: [], unavailable: [] }
    if (this.sources.reminders?.list) {
      try {
        gathered.reminders = this.sources.reminders.list() ?? []
      } catch (error) {
        this.logger?.warn('proactive: reminders source unavailable', { error: error?.message ?? error })
        gathered.unavailable.push('напоминания')
      }
    }
    if (this.sources.events?.list) {
      try {
        gathered.events = this.sources.events.list() ?? []
      } catch (error) {
        this.logger?.warn('proactive: events source unavailable', { error: error?.message ?? error })
        gathered.unavailable.push('календарь')
      }
    }
    if (typeof this.sources.tasks === 'function') {
      try {
        gathered.tasks = await this.sources.tasks({ now }) ?? []
      } catch (error) {
        this.logger?.warn('proactive: tasks source unavailable', { error: error?.message ?? error })
        gathered.unavailable.push('поручения')
      }
    }
    return gathered
  }

  /**
   * Кандидаты одного получателя с учётом доступа.
   *
   * Отказы по задачам складываются в `denied` — тик добавит их в журнал
   * решений с причиной, не раскрывая текст чужой задачи.
   */
  candidatesFor(target, gathered, now, denied = []) {
    const previous = this.store.items.filter((item) => (
      item.userId === undefined || String(item.userId) === String(target.userId)
    ))
    return mergeCandidates(collectCandidates({
      now,
      reminders: gathered.reminders,
      events: gathered.events,
      tasks: gathered.tasks,
      previous,
      userId: target.userId,
      chatId: target.chatId,
      settings: this.settings,
      access: this.access,
      onDenied: (decision) => denied.push({
        ...decision,
        userId: target.userId,
        chatId: target.chatId,
      }),
    }))
  }

  /**
   * Отменить записи, которые больше не подтверждаются источником.
   *
   * Сюда попадают отложенные и запланированные события: если задачу закрыли, а
   * встречу отменили, напоминать о них нельзя.
   */
  async reconcile(target, candidates, now, unavailable = [], denied = []) {
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
    // Отказ по доступу — не повод отменять запись: доступ могут вернуть, а
    // «событие больше не актуально» здесь было бы неправдой.
    const deniedKeys = new Set(denied.map((decision) => decision.key).filter(Boolean))
    // Недоступный источник не подтверждает отсутствие записи: событие нельзя
    // отменять только потому, что календарь или мост не ответил.
    const missing = new Set(unavailable)
    const sourceDown = (type) => (
      (type === 'event' && missing.has('календарь'))
      || (type === 'task' && missing.has('поручения'))
      || (type === 'reminder' && missing.has('напоминания'))
    )
    const decisions = []
    for (const item of [...this.store.items]) {
      if (item.type === 'review') continue
      if (item.userId !== undefined && String(item.userId) !== String(target.userId)) continue
      if (deniedKeys.has(item.key)) continue
      if (['sent', 'done', 'cancelled', 'reviewed', 'muted', 'expired'].includes(item.state)) continue
      if (item.expiresAt && now.getTime() > Date.parse(item.expiresAt)) {
        await this.store.setState(item.key, 'expired', { now, reason: 'истёк срок актуальности' })
        decisions.push({ kind: 'expired', key: item.key, type: item.type, reason: 'истёк срок актуальности', userId: item.userId })
        continue
      }
      if (item.state === 'claimed' && item.claimedAt && now.getTime() - Date.parse(item.claimedAt) > CLAIM_TTL_MS) {
        await this.store.setState(item.key, 'planned', { now, reason: 'захват доставки истёк' })
        continue
      }
      if (sourceDown(item.type)) continue
      if (!byKey.has(item.key)) {
        await this.store.setState(item.key, 'cancelled', { now, reason: 'событие больше не актуально' })
        decisions.push({
          kind: 'cancelled',
          key: item.key,
          type: item.type,
          reason: 'событие больше не актуально',
          source: item.source,
          userId: item.userId,
        })
      }
    }
    return decisions
  }

  /** Обзор: только значимое, один раз в местные сутки и после тихих часов. */
  async planReview(target, gathered, candidates, now) {
    const settings = this.settings
    const day = dayKeyInZone(now, settings.tz)
    if (this.store.watermark.reviewDay === day) return undefined
    // Отложенный обзор ждёт назначенного времени, а не отправляется на следующем тике.
    const existingReview = this.store.itemOf(candidateKey('review', day))
    if (existingReview?.state === 'snoozed' && Date.parse(existingReview.snoozeUntil ?? existingReview.plannedAt) > now.getTime()) return undefined
    if (now.getTime() < reviewInstant(now, settings).getTime()) return undefined
    if (!this.channelEnabled()) return { kind: 'skipped', type: 'review', reason: 'канал отключён' }
    if (!this.categoryEnabled('review')) {
      const decision = { kind: 'muted', type: 'review', reason: 'категория «обзор» отключена' }
      if (this.enabled) await this.store.skipReview(day, decision.reason, { now })
      return decision
    }
    if (isQuietNow(now, settings)) {
      const end = quietHoursEnd(now, { quiet: settings.quiet, timeZone: settings.tz })
      if (!end || end.getTime() >= endOfDayInstant(now, settings.tz).getTime()) {
        const decision = { kind: 'skipped', type: 'review', reason: 'тихие часы до конца дня' }
        if (this.enabled) await this.store.skipReview(day, decision.reason, { now })
        return decision
      }
      return { kind: 'deferred', type: 'review', reason: 'тихие часы', until: end.toISOString() }
    }

    // Обзор собирается только из доступных этому человеку записей: чужие
    // пространства не должны попадать даже в перечисление.
    const visible = (record) => {
      if (!this.access || target.userId === undefined) return true
      return this.access.canRead(target.userId, record)
    }
    // Задачи проходят тот же ACL, что и доставка: обзор не перечисляет чужие
    // поручения и не считает задачу без владельца общей.
    const ownTasks = (gathered.tasks ?? []).filter((entry) => canReadTask(target.userId, entry, this.access))
    // Отложенное до более позднего срока в обзор не подмешиваем: иначе обзор
    // «съел» бы отложенное уведомление раньше времени.
    const reviewCandidates = candidates.filter((candidate) => {
      const item = this.store.itemOf(candidate.key)
      if (item?.state !== 'snoozed') return true
      return Date.parse(item.snoozeUntil ?? item.plannedAt) <= now.getTime()
    })
    const built = buildReviewMessage({
      now,
      settings,
      events: (gathered.events ?? []).filter(visible),
      reminders: (gathered.reminders ?? []).filter(visible),
      tasks: ownTasks,
      candidates: reviewCandidates,
      unavailable: gathered.unavailable,
    })
    if (built.empty) {
      const decision = { kind: 'skipped', type: 'review', reason: 'обзор пуст: значимых пунктов нет' }
      if (this.enabled) await this.store.skipReview(day, decision.reason, { now })
      return decision
    }
    if (this.store.sentToday(now).reviews >= REVIEW_LIMIT) {
      return { kind: 'skipped', type: 'review', reason: 'обзор на сегодня уже отправлен' }
    }

    const candidate = makeCandidate({
      type: 'review',
      id: day,
      title: 'Ежедневный обзор',
      plannedAt: reviewInstant(now, settings),
      expiresAt: endOfDayInstant(now, settings.tz),
      priority: PRIORITY.review,
      reason: `обзор по расписанию в ${settings.reviewAt} (${settings.tz})`,
      source: 'календарь, напоминания, поручения',
      userId: target.userId,
      chatId: target.chatId,
      reviewOnly: true,
    })

    if (!this.enabled) {
      return { kind: 'dry-run', ...candidate, text: built.text, keys: built.keys }
    }

    const claim = await this.store.claim(candidate, { now, review: true })
    if (!claim.ok) return { kind: 'skipped', type: 'review', key: candidate.key, reason: claim.reason }
    try {
      await this.deliver(target.chatId, built.text, proactiveKeyboard(candidate.key))
      await this.store.finish(candidate.key, { now, reviewDay: day })
      await this.store.markReviewed(built.keys, { now })
      this.logger?.info('proactive review sent', { chatId: target.chatId, day, points: built.count })
      return { kind: 'sent', ...candidate, text: built.text, keys: built.keys }
    } catch (error) {
      await this.store.release(candidate.key, { now, error })
      this.logger?.error('proactive review delivery failed', { chatId: target.chatId, error })
      return { kind: 'failed', type: 'review', key: candidate.key, reason: String(error?.message ?? error) }
    }
  }

  /**
   * Повторная проверка доступа непосредственно перед доставкой.
   *
   * Кандидаты уже собраны с ACL, но доступ может быть отозван между сборкой и
   * отправкой. Для задачи проверяется её владелец и область, для остальных —
   * та же запись, что фильтровалась в источниках.
   */
  canDeliver(target, candidate) {
    if (!this.access) return true
    if (target?.userId === undefined || target?.userId === null) return false
    const owner = candidate?.subjectUserId ?? candidate?.userId
    if (owner === undefined || owner === null) return false
    const record = {
      userId: owner,
      ...(candidate?.scope_id === undefined ? {} : { scope_id: candidate.scope_id }),
    }
    return typeof this.access.canRead === 'function' ? this.access.canRead(target.userId, record) : false
  }

  /** Инициативные уведомления: приоритет, бюджет, тихие часы, актуальность. */
  async planInitiatives(target, candidates, now) {
    const decisions = []
    const settings = this.settings
    for (const candidate of candidates) {
      if (candidate.reviewOnly || candidate.type === 'review') continue
      const item = this.store.itemOf(candidate.key)
      if (item && ['sent', 'done', 'cancelled', 'reviewed', 'muted', 'expired'].includes(item.state)) continue
      // Отложенное «ждёт решения» закрылось само: это не напоминание, а отмена.
      if (item && item.state === 'snoozed' && candidate.type === 'task' && candidate.change === 'completed') {
        await this.store.setState(item.key, 'cancelled', { now, reason: 'отменено по актуальности: задача завершена' })
        decisions.push({ kind: 'cancelled', key: item.key, type: item.type, reason: 'отменено по актуальности: задача завершена', source: item.source, userId: item.userId })
        continue
      }
      if (item && item.state === 'snoozed' && Date.parse(item.snoozeUntil ?? item.plannedAt) > now.getTime()) continue
      if (item && item.state === 'claimed' && item.claimedAt && now.getTime() - Date.parse(item.claimedAt) < CLAIM_TTL_MS) continue
      if (!this.channelEnabled()) {
        decisions.push({ kind: 'skipped', key: candidate.key, type: candidate.type, reason: 'канал отключён' })
        continue
      }
      if (!this.categoryEnabled(candidate.type)) {
        decisions.push({ kind: 'muted', key: candidate.key, type: candidate.type, reason: `категория «${TYPE_LABEL[candidate.type] ?? candidate.type}» отключена` })
        continue
      }
      if (now.getTime() > Date.parse(candidate.expiresAt)) {
        if (item) await this.store.setState(item.key, 'expired', { now, reason: 'истёк срок актуальности' })
        decisions.push({ kind: 'expired', key: candidate.key, type: candidate.type, reason: 'истёк срок актуальности' })
        continue
      }
      if (isQuietNow(now, settings)) {
        decisions.push({ kind: 'deferred', key: candidate.key, type: candidate.type, reason: 'тихие часы' })
        continue
      }
      if (this.store.sentToday(now).count >= settings.dayLimit) {
        decisions.push({ kind: 'deferred', key: candidate.key, type: candidate.type, reason: 'дневной предел исчерпан' })
        continue
      }
      // Последняя проверка перед отправкой: отзыв доступа между сборкой
      // кандидатов и этим моментом не должен приводить к доставке.
      if (!this.canDeliver(target, candidate)) {
        decisions.push({
          kind: 'filtered',
          key: candidate.key,
          type: candidate.type,
          reason: candidate.type === 'task' ? TASK_ACCESS_DENIED_REASON : 'нет доступа к записи',
          source: candidate.source,
          userId: target.userId,
          chatId: target.chatId,
        })
        continue
      }
      if (!this.enabled) {
        decisions.push({ kind: 'dry-run', ...candidate, text: notificationText(candidate) })
        continue
      }

      const claim = await this.store.claim(candidate, { now })
      if (!claim.ok) {
        decisions.push({ kind: 'deferred', key: candidate.key, type: candidate.type, reason: claim.reason })
        continue
      }
      try {
        const text = notificationText(candidate)
        await this.deliver(target.chatId, text, proactiveKeyboard(candidate.key))
        await this.store.finish(candidate.key, { now })
        this.logger?.info('proactive sent', { chatId: target.chatId, key: candidate.key, type: candidate.type, priority: candidate.priority })
        decisions.push({ kind: 'sent', ...candidate, text })
      } catch (error) {
        await this.store.release(candidate.key, { now, error })
        this.logger?.error('proactive delivery failed', { chatId: target.chatId, key: candidate.key, error })
        decisions.push({ kind: 'failed', key: candidate.key, type: candidate.type, reason: String(error?.message ?? error) })
      }
    }
    return decisions
  }

  /**
   * Один тик. Обычно его зовёт существующий планировщик напоминаний.
   *
   * @param {object} [options] - `now`, `force`.
   * @returns {Promise<Array<object>>} принятые решения (для журнала и тестов).
   */
  async tick({ now, force = false } = {}) {
    const at = now === undefined ? asDate(this.now()) : asDate(now)
    if (this.ticking) return []
    if (!force && this.lastTickAt && at.getTime() - this.lastTickAt < this.intervalMs) return []
    this.ticking = true
    this.lastTickAt = at.getTime()
    const decisions = []
    try {
      await this.store.refresh()
      const gathered = await this.gather(at)
      for (const target of this.targets) {
        const denied = []
        const candidates = this.candidatesFor(target, gathered, at, denied)
        decisions.push(...denied)
        decisions.push(...await this.reconcile(target, candidates, at, gathered.unavailable, denied))
        const review = await this.planReview(target, gathered, candidates, at)
        if (review) decisions.push(review)
        decisions.push(...await this.planInitiatives(target, candidates, at))
      }
      const fresh = decisions.filter((decision) => {
        const signature = [decision.kind, decision.key ?? decision.type, decision.reason ?? ''].join('|')
        if (this.reported.has(signature)) return false
        // Набор живёт в памяти процесса; ограничиваем его, чтобы долгая работа
        // не превращалась в утечку.
        if (this.reported.size > 2048) this.reported.clear()
        this.reported.add(signature)
        return true
      })
      if (fresh.length > 0) {
        await this.store.note(fresh.map((decision) => ({
          ...decision,
          ...(this.enabled ? {} : { dryRun: true }),
        })), at)
      }
      return decisions
    } catch (error) {
      this.logger?.error('proactive tick failed', { error: error?.message ?? error })
      return decisions
    } finally {
      this.ticking = false
    }
  }

  /** Текст «почему это пришло» для записи. */
  whyText(item) {
    if (!item) return 'Это уведомление уже неактуально.'
    const lines = [`${item.title ?? 'Уведомление'}`]
    lines.push(candidateWhy(item))
    if (item.sentAt ?? item.updatedAt) lines.push(`Когда: ${item.sentAt ?? item.updatedAt}.`)
    return lines.join('\n')
  }

  /**
   * Объяснение последнего уведомления по запросу пользователя.
   *
   * @param {number|string} [userId] - чей запрос; чужие события не раскрываются.
   * @returns {string} краткий ответ с причиной и источником.
   */
  explainLast(userId) {
    const own = this.store.journal.filter((entry) => (
      ['sent', 'dry-run'].includes(entry.kind)
      // Чужая запись без владельца тоже не объясняется: лучше промолчать,
      // чем показать данные другого пространства.
      && (userId === undefined || (entry.userId !== undefined && String(entry.userId) === String(userId)))
    ))
    const last = own.at(-1)
    if (!last) {
      const item = [...this.store.items].reverse().find((entry) => (
        entry.state === 'sent'
        && (userId === undefined || (entry.userId !== undefined && String(entry.userId) === String(userId)))
      ))
      if (!item) return 'Инициативных уведомлений пока не было — объяснять нечего.'
      return this.whyText(item)
    }
    return this.whyText(last)
  }

  /**
   * Нажатие кнопки уведомления.
   *
   * @param {object} request - `action` (open/done/snooze/mute), `key`, `userId`, `now`.
   * @returns {Promise<{toast: string, outcome?: string, denied?: boolean}>} ответ для кнопки.
   */
  async handleAction({ action, key, userId, now = this.now() } = {}) {
    const at = asDate(now)
    const item = this.store.itemOf(key)
    if (!item) {
      return { toast: 'Уведомление уже неактивно', outcome: 'Это уведомление больше не актуально.' }
    }
    if (userId !== undefined && item.userId !== undefined && String(item.userId) !== String(userId)) {
      return { toast: 'Нет доступа', outcome: 'Это уведомление из другой области.', denied: true }
    }
    if (action === 'open') {
      return { toast: 'Почему это пришло', outcome: this.whyText(item) }
    }
    if (action === 'done') {
      await this.store.setState(key, 'done', { now: at, reason: 'отмечено выполненным' })
      return { toast: 'Отмечено выполненным', outcome: `✅ Выполнено: ${item.title}` }
    }
    if (action === 'snooze') {
      const minutes = this.settings.snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES
      const moved = await this.store.snooze(key, { now: at, minutes })
      const until = moved ? formatLocalTime(moved.snoozeUntil ?? moved.plannedAt, this.settings.tz) : ''
      return { toast: `Отложено на ${minutes} мин`, outcome: `⏰ Отложено до ${until}. Проверю актуальность перед напоминанием.` }
    }
    if (action === 'mute') {
      await this.store.mute(item.type)
      return { toast: 'Тип отключён', outcome: `🔕 Уведомления типа «${TYPE_LABEL[item.type] ?? item.type}» отключены.` }
    }
    return { toast: 'Не понял действие' }
  }
}
