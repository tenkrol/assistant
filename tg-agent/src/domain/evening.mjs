/**
 * Вечерний чек-ин: настройка и её естественные формулировки.
 *
 * Здесь нет таймера и нет Telegram. Модуль отвечает на три вопроса:
 *  - как выглядит настройка `{enabled, at, tone}` после чтения файла;
 *  - какую фразу человека считать просьбой включить/выключить вопрос;
 *  - какой текст вопроса соответствует тону.
 *
 * Сам вопрос приходит через существующий планировщик напоминаний, поэтому
 * второго таймера нигде не появляется.
 */
import { TONE_LABELS, TONE_VALUES, isTone, normalizeTone } from './reminders.mjs'

/** Значения по умолчанию: вопрос выключен, пока человек его не попросил. */
export const DEFAULT_EVENING_CHECK_IN = Object.freeze({
  enabled: false,
  at: '21:00',
  tone: 'neutral',
})

/** Допустимые тона вечернего вопроса — те же, что у напоминаний. */
export const EVENING_TONES = TONE_VALUES

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Похоже ли значение на время `ЧЧ:ММ` (для настройки, а не для текста). */
export const isClock = (value) => typeof value === 'string' && CLOCK.test(value.trim())

/**
 * Привести настройку к полной и безопасной форме.
 *
 * Неверное время не превращается в «сейчас»: берётся прежнее значение по
 * умолчанию (21:00), а вызывающий код, который разбирал фразу человека, уже
 * успел сказать об ошибке. Неизвестный тон читается как нейтральный.
 *
 * @param {unknown} value - сохранённая или присланная настройка.
 * @returns {{enabled: boolean, at: string, tone: string}} полная настройка.
 */
export function normalizeEveningCheckIn(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    enabled: source.enabled === true,
    at: isClock(source.at) ? source.at.trim() : DEFAULT_EVENING_CHECK_IN.at,
    tone: normalizeTone(source.tone),
  }
}

/** Подпись тона для подтверждения человеку. */
export const eveningToneLabel = (tone) => TONE_LABELS[normalizeTone(tone)]

/**
 * Текст вечернего вопроса.
 *
 * Все тона спрашивают одно и то же — «как прошёл день», — но с разной
 * интонацией. Это единственное, что меняет тон: время и факт отправки от него
 * не зависят.
 *
 * @param {string} [tone] - `gentle`, `neutral` или `strict`.
 * @returns {string} готовый текст сообщения.
 */
export function eveningCheckInText(tone = 'neutral') {
  if (normalizeTone(tone) === 'gentle') return '🌙 Как прошёл день? Если хочется — расскажи, я рядом.'
  if (normalizeTone(tone) === 'strict') return '🌙 Как прошёл день? Ответь, пожалуйста.'
  return '🌙 Как прошёл день?'
}

/** Время в тексте: `ЧЧ:ММ` из любого места фразы. */
function extractClock(text) {
  const match = /(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/.exec(text)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** Тон в тексте: «ласково», «строго», «нейтрально». */
function extractTone(text) {
  if (/(ласков|мягк|по-доброму|нежн)/iu.test(text)) return 'gentle'
  if (/(строг|жёстк|жестк)/iu.test(text)) return 'strict'
  if (/(нейтральн|обычн|как обычно)/iu.test(text)) return 'neutral'
  return undefined
}

/** Просьба выключить вопрос: «не спрашивай вечером», «выключи чек-ин». */
const DISABLE = /(?:не\s+(?:спрашивай|спрашивать|спроси)|(?:выключи|выключить|отключи|отключить|убери|убрать)[^.!?]{0,40}(?:вечер|чек-?ин))/iu

/** Просьба включить вопрос: «спрашивай вечером», «включи вечерний чек-ин». */
const ENABLE = /(?:(?:спрашивай|спроси|спрашивать)[^.!?]{0,60}(?:вечером|вечерний|вечерн)|(?:включи|включить|настрой|хочу|сделай)[^.!?]{0,60}(?:вечерн|вечером|чек-?ин)|вечерн(?:ий|его|ему)?\s*(?:чек-?ин|вопрос))/iu

/** Вопрос о настройке — это не команда: «как включить вечерний чек-ин?». */
const QUESTION = /^\s*(?:как|что|где|когда|почему|зачем|можно|нужно|а\s+как)\b/iu

/**
 * Разобрать естественную фразу про вечерний вопрос.
 *
 * Возвращает `undefined`, если фраза к вечернему вопросу не относится. Иначе —
 * `{ patch }` для настройки либо `{ error }` с понятным объяснением.
 *
 * @param {string} text - сообщение человека.
 * @returns {{patch?: object, error?: string} | undefined} разобранная просьба.
 */
export function parseEveningCheckInRequest(text) {
  const value = String(text ?? '').trim()
  if (value === '') return undefined
  if (DISABLE.test(value)) return { patch: { enabled: false } }
  if (!ENABLE.test(value)) return undefined
  if (QUESTION.test(value) && /[?]\s*$/.test(value)) return undefined
  const clock = extractClock(value)
  if (clock === null) {
    return { error: 'Не понял время вечернего вопроса. Пример: «спрашивай вечером, как прошёл день в 21:00».' }
  }
  const tone = extractTone(value)
  return {
    patch: {
      enabled: true,
      ...(clock === undefined ? {} : { at: clock }),
      ...(tone === undefined ? {} : { tone }),
    },
  }
}

/**
 * Разобрать аргументы команды `/proactive вечер …`.
 *
 * @param {string} text - хвост команды после слова «вечер».
 * @returns {{patch?: object, error?: string}} настройка или объяснение.
 */
export function parseEveningCheckInCommand(text) {
  const value = String(text ?? '').trim()
  if (value === '' || /^(?:вкл|включить|on|да)$/iu.test(value)) {
    return { patch: { enabled: true } }
  }
  if (/^(?:выкл|выключить|off|нет)(?:\s|$)/iu.test(value)) return { patch: { enabled: false } }
  const clock = extractClock(value)
  if (clock === null) return { error: 'Не понял время. Пример: `/proactive вечер 21:00 ласково`.' }
  const tone = extractTone(value)
  if (clock === undefined && tone === undefined) {
    return { error: 'Не понял. Примеры: `/proactive вечер вкл`, `/proactive вечер 21:00 ласково`, `/proactive вечер выкл`.' }
  }
  return {
    patch: {
      enabled: true,
      ...(clock === undefined ? {} : { at: clock }),
      ...(tone === undefined ? {} : { tone }),
    },
  }
}

/**
 * Ответ человеку после изменения настройки.
 *
 * @param {object} status - результат `statusFor` (или `{settings:{eveningCheckIn}}`).
 * @returns {string} подтверждение.
 */
export function eveningCheckInConfirmation(status = {}) {
  const evening = normalizeEveningCheckIn(status.eveningCheckIn ?? status.settings?.eveningCheckIn)
  if (!evening.enabled) {
    return 'Вечерний вопрос выключен. Вернуть: «спрашивай вечером, как прошёл день в 21:00».'
  }
  return `Вечерний вопрос включён: каждый день в ${evening.at}, тон — ${eveningToneLabel(evening.tone)}. Спрошу: «Как прошёл день?». Выключить: «не спрашивай вечером».`
}
