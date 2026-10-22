/**
 * Инструмент `remind`.
 *
 * Модель не считает хранимый момент сама: она передаёт задержку в минутах или
 * ISO-время, а домен напоминаний разрешает его в поясе пользователя, проверяет
 * инварианты и пишет напоминание. Здесь остаётся только описание инструмента и
 * тонкая обвязка над `rulesOfReminders`.
 */
import { REPEAT_VALUES } from '../domain/repeats.mjs'
import { TONE_VALUES, rulesOfReminders } from '../domain/reminders.mjs'
import { createTool } from './contract.mjs'

/** Допустимые повторы: см. src/domain/repeats.mjs. */
const REPEATS = REPEAT_VALUES

/** Описание инструмента в формате OpenAI. */
export const REMIND_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'remind',
    description:
      'Создать напоминание в этом чате. Вызывай, когда пользователь просит напомнить что-либо («напомни через 20 минут», «напомни завтра в 9»). '
      + 'Текущее время бери из системного сообщения. Укажи ровно одно из двух: in_minutes (через сколько минут) или at (момент в ISO 8601). '
      + 'Повтор «каждые N» — это repeat=every:N, где N — минуты (не меньше 15, кратно 5): «каждые 2 часа» → every:120, «каждые 30 минут» → every:30. '
      + 'Если просят «ласково» — tone=gentle, «строго» — tone=strict, без уточнения — tone=neutral.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Что напомнить — коротко и дословно, без даты.' },
        in_minutes: { type: 'number', description: 'Через сколько минут напомнить, например 20.' },
        at: { type: 'string', description: 'Момент напоминания в ISO 8601, например 2026-10-06T09:00:00+03:00 или 2026-10-07T09:00.' },
        repeat: {
          type: 'string',
          enum: REPEATS,
          description: 'Повтор: none (по умолчанию), daily, weekdays (по будням), weekly, weekly:1..7 (1=понедельник), monthly:1..31, every:N (каждые N минут; N от 15 до 1440, кратно 5; часы переводи в минуты: 2 часа = every:120).',
        },
        tone: {
          type: 'string',
          enum: TONE_VALUES,
          description: 'Тон текста доставки: gentle — «ласково», neutral — обычный (по умолчанию), strict — «строго». Время, повтор и кнопки не меняет.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

/**
 * Собрать инструмент напоминаний.
 *
 * @param {object} options - параметры инструмента.
 * @param {import('../reminders.mjs').ReminderStore} options.store - хранилище напоминаний.
 * @param {string} [options.timeZone] - пояс для наивного времени и подтверждения.
 * @param {string} [options.locale] - локаль подтверждения.
 * @param {() => Date} [options.now] - часы, подменяются тестами.
 */
export function createReminderTool({ store, timeZone = '', locale = 'ru-RU', now = () => new Date() }) {
  const rules = rulesOfReminders({ store, timeZone, locale, now })

  // Ядру нужен id напоминания, чтобы поставить под подтверждением кнопки
  // «Отложить» и «Отменить»; модель видит только текст.
  return createTool({
    definition: REMIND_TOOL_DEFINITION,
    executeDetailed: (args, context) => rules.create(args, context),
  })
}
