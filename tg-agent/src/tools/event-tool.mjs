/**
 * Инструмент `event`: модель записывает встречи в локальный календарь.
 *
 * Время всегда разрешается в поясе пользователя, а напоминание о событии —
 * обычное напоминание в общем хранилище, поэтому доставка, тихие часы и кнопки
 * работают без особых случаев. Правила и тексты — в домене событий.
 */
import { DEFAULT_REMIND_BEFORE, LIST_DAYS, rulesOfEvents } from '../domain/events.mjs'
import { createTool } from './contract.mjs'

/** Описание инструмента для модели. */
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
 * Собрать инструмент календаря.
 *
 * @param {object} options - `{ store, reminders, timeZone, logger }`.
 * @returns {{definition: object, execute: Function, executeDetailed: Function}} инструмент.
 */
export function createEventTool({ store, reminders, timeZone = '', logger } = {}) {
  const rules = rulesOfEvents({ store, reminders, timeZone, logger })

  return createTool({
    definition: EVENT_TOOL_DEFINITION,
    executeDetailed: (args = {}, context = {}) => rules.executeDetailed(args, context),
  })
}

export { LIST_DAYS }
