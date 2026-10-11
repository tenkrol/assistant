/**
 * The `remind` tool.
 *
 * The model never computes a stored timestamp itself: it passes either a delay
 * in minutes or an ISO time, and this module resolves it against the configured
 * zone, validates it and writes the reminder. The confirmation text it returns
 * carries the resolved local time, so the model can show the user exactly when
 * the reminder will fire.
 */
import { zonedTimeToUtc } from './reminders.mjs'
import { REPEAT_VALUES, describeRepeat, isRepeat } from './repeats.mjs'

/** Allowed repeat values: see src/repeats.mjs. */
const REPEATS = REPEAT_VALUES
const MIN_MINUTES = 0.05
const MAX_MINUTES = 100_000

/** OpenAI-compatible tool definition. */
export const REMIND_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'remind',
    description:
      'Создать напоминание в этом чате. Вызывай, когда пользователь просит напомнить что-либо («напомни через 20 минут», «напомни завтра в 9»). '
      + 'Текущее время бери из системного сообщения. Укажи ровно одно из двух: in_minutes (через сколько минут) или at (момент в ISO 8601).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Что напомнить — коротко и дословно, без даты.' },
        in_minutes: { type: 'number', description: 'Через сколько минут напомнить, например 20.' },
        at: { type: 'string', description: 'Момент напоминания в ISO 8601, например 2026-10-06T09:00:00+03:00 или 2026-10-07T09:00.' },
        repeat: {
          type: 'string',
          enum: REPEATS,
          description: 'Повтор: none (по умолчанию), daily, weekdays (по будням), weekly, weekly:1..7 (1=понедельник), monthly:1..31, every:N (каждые N минут, N кратно 5).',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

/**
 * Build the reminder tool.
 *
 * @param {object} options - tool options.
 * @param {import('./reminders.mjs').ReminderStore} options.store - reminder storage.
 * @param {string} [options.timeZone] - zone for naive times and for the confirmation.
 * @param {string} [options.locale] - locale for the confirmation text.
 * @param {() => Date} [options.now] - clock, injected by tests.
 */
export function createReminderTool({ store, timeZone = '', locale = 'ru-RU', now = () => new Date() }) {
  const zone = () => timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  return {
    definition: REMIND_TOOL_DEFINITION,
    /**
     * Create one reminder for a chat.
     *
     * @param {object} args - tool arguments.
     * @param {number} chatId - chat the reminder belongs to; injected by the bot.
     * @returns {Promise<string>} confirmation or an error the model must report.
     */
    async execute(args, context) {
      const { text } = await this.executeDetailed(args, context)
      return text
    },

    /**
     * Same as `execute`, but also returns the stored reminder.
     *
     * The bot needs the id to put «Отложить»/«Отменить» buttons under the
     * confirmation, and the model must only ever see the text.
     *
     * @param {object} args - tool arguments.
     * @param {{chatId: number, userId?: number}} context - chat and owner.
     * @returns {Promise<{text: string, reminder?: object}>} result plus the reminder when one was created.
     */
    async executeDetailed({ text, in_minutes: inMinutes, at, repeat = 'none' } = {}, { chatId, userId } = {}) {
      if (!Number.isFinite(chatId)) return { text: 'Ошибка инструмента remind: не удалось определить чат.' }
      const hasDelay = inMinutes !== undefined && inMinutes !== null
      const hasMoment = typeof at === 'string' && at.trim() !== ''
      // Argument shape is validated before anything else, so an invalid repeat is
      // reported even when the caller forgot the time argument.
      if (!isRepeat(repeat)) return { text: 'Ошибка инструмента remind: недопустимый повтор. Можно: none, daily, weekdays, weekly, weekly:1..7, monthly:1..31, every:N (N кратно 5).' }
      if (hasDelay === hasMoment) {
        return { text: 'Ошибка инструмента remind: укажи ровно одно — in_minutes (через сколько минут) или at (дата и время). Если пользователь не назвал время, спроси его.' }
      }

      const reference = now()
      let due
      try {
        if (hasDelay) {
          const minutes = Number(inMinutes)
          if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
            return { text: `Ошибка инструмента remind: in_minutes должно быть числом от ${MIN_MINUTES} до ${MAX_MINUTES}.` }
          }
          due = new Date(reference.getTime() + Math.round(minutes * 60_000))
        } else {
          // Handles both forms: an explicit offset is honoured, a naive local
          // time is read in the configured zone.
          due = zonedTimeToUtc(at.trim(), zone())
        }
        if (Number.isNaN(due.getTime())) throw new Error('unparseable time')
      } catch {
        return { text: 'Ошибка инструмента remind: не удалось разобрать время. Передай in_minutes или at в формате ISO 8601, например 2026-10-06T09:00:00+03:00.' }
      }
      if (due.getTime() < reference.getTime() - 60_000) {
        const past = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: zone() }).format(due)
        return { text: `Ошибка инструмента remind: время ${past} уже прошло. Уточни у пользователя дату и время.` }
      }

      let reminder
      try {
        reminder = store.add({ chatId, userId, text, dueAt: due, repeat })
      } catch (error) {
        return { text: `Ошибка инструмента remind: ${error.message}` }
      }
      // Persist immediately: without this the reminder lived in memory only and
      // any restart before it was due erased it.
      await store.flush()
      const human = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: zone() }).format(due)
      const repeatText = describeRepeat(repeat) ?? 'без повтора'
      return { text: `Напоминание №${reminder.id} создано: ${human} (${zone()}), ${repeatText}. Текст: «${reminder.text}».`, reminder }
    },
  }
}
