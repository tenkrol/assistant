/**
 * The `event` tool: the model books appointments into the local calendar.
 *
 * Two details matter here. First, the instant is always resolved in the user's zone
 * (`zonedTimeToUtc`), so "в пятницу в 15:00" cannot land three hours off. Second, when
 * a reminder is asked for, a real reminder is written to the reminder store — delivery,
 * quiet hours and the «отложить» buttons then work without any special casing.
 */
import { DEFAULT_REMIND_BEFORE, dateInZone, timeInZone } from './events.mjs'
import { zonedTimeToUtc } from './reminders.mjs'

/** How many days a listing covers. */
const LIST_DAYS = 7

/** The tool definition handed to the model. */
export const EVENT_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'event',
    description:
      'Календарь: записать встречу, приём, поездку или день рождения; показать ближайшие события; удалить событие. '
      + 'Используй, когда называют дату и время события, а не просьбу напомнить в моменте.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'add — записать, list — показать ближайшие, remove — удалить.' },
        title: { type: 'string', description: 'Название события: «Стоматолог», «День рождения мамы», «Созвон с Сергеем».' },
        date: { type: 'string', description: 'Дата события в формате ГГГГ-ММ-ДД (посчитай от текущей даты из системного сообщения).' },
        time: { type: 'string', description: 'Время в формате ЧЧ:ММ по местному времени пользователя. Если время не названо, спроси или поставь 09:00.' },
        at: { type: 'string', description: 'Полный момент ISO, если он уже известен (альтернатива date+time).' },
        repeat: { type: 'string', enum: ['none', 'yearly'], description: 'yearly — каждый год в этот день (дни рождения, годовщины).' },
        place: { type: 'string', description: 'Место, если названо.' },
        remind_before: { type: 'number', description: `За сколько минут напомнить: 0 — не напоминать, по умолчанию ${DEFAULT_REMIND_BEFORE}.` },
        id: { type: 'string', description: 'Номер или идентификатор события для удаления (из списка).' },
      },
      required: ['action'],
    },
  },
}

/**
 * Build the tool.
 *
 * @param {object} options - `{ store, reminders, timeZone, logger }`.
 * @returns {{definition: object, execute: Function, executeDetailed: Function}} the tool.
 */
export function createEventTool({ store, reminders, timeZone = '', logger } = {}) {
  const executeDetailed = async (args = {}, { chatId, userId } = {}) => {
    if (!store) return { text: 'Ошибка инструмента event: календарь недоступен.' }
    const action = String(args.action ?? 'add').trim().toLowerCase()
    if (action === 'list') {
      const events = store.upcoming(chatId, { days: LIST_DAYS })
      if (events.length === 0) return { text: 'В ближайшие 7 дней событий нет.' }
      const lines = events.map((event, index) => {
        const when = `${dateInZone(new Date(event.nextAt), timeZone)} в ${timeInZone(new Date(event.nextAt), timeZone)}`
        const repeat = event.repeat === 'yearly' ? ' (каждый год)' : ''
        const place = event.place ? `, ${event.place}` : ''
        return `${index + 1}. ${when} — ${event.title}${place}${repeat}`
      })
      return { text: `Ближайшие события:\n${lines.join('\n')}` }
    }

    if (action === 'remove') {
      const target = store.remove(chatId, args.id ?? args.title)
      if (!target) return { text: 'Ошибка инструмента event: не нашёл такое событие. Покажите список — action list.' }
      await store.flush()
      return { text: `Удалил событие «${target.title}» (${dateInZone(new Date(target.at), timeZone)}).` }
    }

    // action === 'add'
    const title = String(args.title ?? '').trim()
    if (title === '') return { text: 'Ошибка инструмента event: нужно название события.' }
    let instant
    try {
      if (args.at) {
        instant = new Date(args.at)
      } else if (args.date) {
        const time = /^\d{1,2}:\d{2}$/.test(String(args.time ?? '')) ? String(args.time) : '09:00'
        instant = zonedTimeToUtc(`${String(args.date).trim()}T${time}:00`, timeZone)
      }
    } catch (error) {
      logger?.warn?.('event time parse failed', { error: error?.message ?? error })
      instant = undefined
    }
    if (!instant || Number.isNaN(instant.getTime())) {
      return { text: 'Ошибка инструмента event: не понял дату. Нужны date (ГГГГ-ММ-ДД) и time (ЧЧ:ММ) или готовый момент в at.' }
    }
    const repeat = args.repeat === 'yearly' ? 'yearly' : 'none'
    const remindBefore = args.remind_before === undefined ? DEFAULT_REMIND_BEFORE : Number(args.remind_before)
    const event = store.add({ chatId, userId, title, at: instant.toISOString(), repeat, place: args.place, remindBefore: Number.isFinite(remindBefore) ? remindBefore : DEFAULT_REMIND_BEFORE })
    if (!event) return { text: 'Ошибка инструмента event: не удалось записать событие.' }
    await store.flush()

    const when = `${dateInZone(instant, timeZone)} в ${timeInZone(instant, timeZone)}`
    const repeatNote = repeat === 'yearly' ? ', каждый год' : ''
    // A reminder is a separate, ordinary reminder: that keeps one delivery path.
    let reminderNote = ''
    const minutes = Number.isFinite(remindBefore) ? Math.min(1440, Math.max(0, Math.round(remindBefore))) : DEFAULT_REMIND_BEFORE
    if (reminders && minutes > 0) {
      const remindAt = new Date(instant.getTime() - minutes * 60_000)
      if (remindAt.getTime() > Date.now()) {
        const created = reminders.store.add({
          chatId,
          userId,
          text: `через ${minutes} мин: ${title}`,
          dueAt: remindAt,
          repeat: 'none',
        })
        if (created) {
          await reminders.store.flush()
          reminderNote = ` Напомню за ${minutes} мин.`
        }
      }
    }
    const reminderHint = reminders && minutes === 0 ? ' Напоминать не буду.' : ''
    return { text: `Записал: ${when} — «${title}»${repeatNote}.${reminderNote}${reminderHint}`, event }
  }

  return {
    definition: EVENT_TOOL_DEFINITION,
    executeDetailed,
    execute: async (args, context) => (await executeDetailed(args, context)).text,
  }
}

export { LIST_DAYS }
