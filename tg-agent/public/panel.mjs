/**
 * Чистые помощники формы мини-приложения.
 *
 * Здесь нет DOM, `fetch` и Telegram: только приведение значений формы к телу
 * запроса. Благодаря этому те же функции, которые вызывает страница, можно
 * проверить в Node без браузера — в том числе тон и минимальный интервал.
 */

/** Тоны напоминания и вечернего вопроса. */
export const TONE_VALUES = Object.freeze(['gentle', 'neutral', 'strict'])

/** Пары «значение — ключ словаря» для селектов тона. */
export const TONE_CHOICES = Object.freeze([
  ['gentle', 'tone.gentle'],
  ['neutral', 'tone.neutral'],
  ['strict', 'tone.strict'],
])

/** Минимальный интервал `every:N`, который панель разрешает отправить. */
export const EVERY_MIN_MINUTES = 15

/** Значения вечернего чек-ина, пока человек ничего не сохранял. */
export const DEFAULT_EVENING_CHECK_IN = Object.freeze({
  enabled: false,
  at: '21:00',
  tone: 'neutral',
})

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const EVERY = /^every:(\d{1,4})$/

/** Неизвестный тон читается как нейтральный — так же, как на сервере. */
export function normalizeTone(value) {
  return TONE_VALUES.includes(value) ? value : 'neutral'
}

/** Похоже ли значение на время `ЧЧ:ММ`. */
export function isClock(value) {
  return typeof value === 'string' && CLOCK.test(value)
}

/** Полная и безопасная настройка вечернего вопроса для формы. */
export function normalizeEvening(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    enabled: source.enabled === true,
    at: isClock(source.at) ? source.at : DEFAULT_EVENING_CHECK_IN.at,
    tone: normalizeTone(source.tone),
  }
}

/**
 * Тело POST /api/reminders из значений формы.
 *
 * Тон по умолчанию нейтральный; интервал меньше 15 минут не отправляется,
 * потому что сервер всё равно откажет. `dueAt` добавляет вызывающий код после
 * проверки даты, чтобы порядок ошибок остался прежним.
 *
 * @param {{text?: unknown, dueAt?: unknown, repeat?: unknown, tone?: unknown}} fields - поля формы.
 * @param {(key: string, vars?: object) => string} [t] - переводчик сообщений.
 * @returns {{text: string, dueAt: unknown, repeat: string, tone: string}} тело запроса.
 */
export function reminderPayload(fields = {}, t = (key) => key) {
  const text = typeof fields.text === 'string' ? fields.text.trim() : ''
  if (text === '') throw new Error(t('form.reminder.empty'))

  const repeat = typeof fields.repeat === 'string' && fields.repeat !== '' ? fields.repeat : 'none'
  const every = EVERY.exec(repeat)
  if (every && Number(every[1]) < EVERY_MIN_MINUTES) {
    throw new Error(t('form.repeat.min', { minutes: EVERY_MIN_MINUTES }))
  }

  return {
    text,
    dueAt: fields.dueAt,
    repeat,
    tone: normalizeTone(fields.tone),
  }
}

/**
 * Тело PATCH /api/proactive для вечернего чек-ина.
 *
 * Сервер хранит настройку в `settings.eveningCheckIn`; имена полей совпадают
 * с ним, поэтому отдельного механизма сохранения не появляется.
 *
 * @param {{enabled?: unknown, at?: unknown, tone?: unknown}} fields - поля формы.
 * @param {(key: string, vars?: object) => string} [t] - переводчик сообщений.
 * @returns {{eveningCheckIn: {enabled: boolean, at: string, tone: string}}} тело запроса.
 */
export function eveningSettingsPayload(fields = {}, t = (key) => key) {
  const at = typeof fields.at === 'string' ? fields.at.trim() : ''
  if (!isClock(at)) throw new Error(t('form.evening.time'))
  return {
    eveningCheckIn: {
      enabled: fields.enabled === true,
      at,
      tone: normalizeTone(fields.tone),
    },
  }
}
