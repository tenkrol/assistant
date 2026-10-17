/**
 * Домен событий: календарь, годовой повтор и напоминание за N минут до начала.
 *
 * Событие хранится локально и намеренно просто: название, момент начала и
 * необязательный годовой повтор. Напоминание о событии — обычное напоминание,
 * поэтому доставка, тихие часы и кнопки работают без особых случаев.
 *
 * Telegram, VK, сеть и `bot.mjs` домену не нужны: на входе хранилища и данные,
 * на выходе результат и текст сообщения.
 */
import { zonedTimeToUtc } from './reminders.mjs'

/** Повторы, которые понимает событие. */
export const EVENT_REPEATS = ['none', 'yearly']

/** За сколько минут напоминать по умолчанию. */
export const DEFAULT_REMIND_BEFORE = 30

/** Сколько дней показывает инструмент `event` в режиме списка. */
export const LIST_DAYS = 7

/** Местный календарный день момента, `ГГГГ-ММ-ДД`. */
export function dayKeyInZone(date, timeZone = '') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** Местное время момента, `ЧЧ:ММ`. */
export function timeInZone(date, timeZone = '') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit' }).format(date)
}

/** Местная дата, `9 октября`. */
export function dateInZone(date, timeZone = '') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone || undefined, day: 'numeric', month: 'long' }).format(date)
}

/** Ближайшее годовое вхождение момента, строго после `now`. */
export function nextYearlyOccurrence(iso, now) {
  const start = new Date(iso)
  const next = new Date(start)
  while (next.getTime() <= now.getTime()) {
    // 29 февраля сдвигаем на 28-е в невисокосный год: 1 марта было бы сюрпризом.
    const year = next.getUTCFullYear() + 1
    const day = next.getUTCDate() === 29 && next.getUTCMonth() === 1 ? 28 : next.getUTCDate()
    next.setUTCFullYear(year, next.getUTCMonth(), day)
  }
  return next.toISOString()
}

/** Когда показать событие: годовое — ближайшее вхождение, обычное — как записано. */
export function eventOccurrence(event, now = new Date()) {
  return event.repeat === 'yearly' ? nextYearlyOccurrence(event.at, now) : event.at
}

/** Текст списка событий для инструмента `event`. */
export function eventListText(events, { timeZone = '' } = {}) {
  if (events.length === 0) return 'В ближайшие 7 дней событий нет.'
  const lines = events.map((event, index) => {
    const when = `${dateInZone(new Date(event.nextAt), timeZone)} в ${timeInZone(new Date(event.nextAt), timeZone)}`
    const repeat = event.repeat === 'yearly' ? ' (каждый год)' : ''
    const place = event.place ? `, ${event.place}` : ''
    return `${index + 1}. ${when} — ${event.title}${place}${repeat}`
  })
  return `Ближайшие события:\n${lines.join('\n')}`
}

/**
 * Текст `/calendar` на две недели.
 *
 * @param {Array<object>} events - события с `nextAt`.
 * @param {object} options - `timeZone`.
 * @returns {string} готовое сообщение.
 */
export function calendarText(events, { timeZone = '' } = {}) {
  if (events.length === 0) {
    return 'В ближайшие две недели событий нет.\n\nДобавить: «запиши стоматолога 15 октября в 11:30».'
  }
  const lines = events.map((event, index) => {
    const day = new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone || undefined, day: 'numeric', month: 'long', weekday: 'short' }).format(new Date(event.nextAt))
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit' }).format(new Date(event.nextAt))
    const repeat = event.repeat === 'yearly' ? ' (каждый год)' : ''
    const place = event.place ? `, ${event.place}` : ''
    return `${index + 1}. ${day}, ${time} — ${event.title}${place}${repeat}`
  })
  return ['**Ближайшие события**', ...lines, '', 'Удалить: «удали событие 2» или напишите мне об этом.'].join('\n')
}

/** Текст удаления события. */
export function eventRemovedText(target, { timeZone = '' } = {}) {
  return `Удалил событие «${target.title}» (${dateInZone(new Date(target.at), timeZone)}).`
}

/** Текст подтверждения записи события. */
export function eventAddedText({ instant, title, repeat, reminderNote = '', reminderHint = '', timeZone = '' } = {}) {
  const when = `${dateInZone(instant, timeZone)} в ${timeInZone(instant, timeZone)}`
  const repeatNote = repeat === 'yearly' ? ', каждый год' : ''
  return `Записал: ${when} — «${title}»${repeatNote}.${reminderNote}${reminderHint}`
}

/** Минуты до напоминания, приведённые к допустимому диапазону. */
export function clampRemindBefore(value) {
  const minutes = Number(value)
  return Number.isFinite(minutes) ? Math.min(1440, Math.max(0, Math.round(minutes))) : DEFAULT_REMIND_BEFORE
}

/**
 * Правила домена событий.
 *
 * @param {object} options - `store`, `reminders` (стор или обёртка), `timeZone`,
 *   `locale`, `logger`, `now`.
 * @returns {object} правила: календарь и инструмент `event`.
 */
export function rulesOfEvents({ store, reminders, timeZone = '', locale = 'ru-RU', logger, now = () => Date.now() } = {}) {
  // Инструмент получает обёртку `{ store, tool }`, бот — тоже; принимаем и сам стор.
  const reminderStore = reminders?.store ?? reminders
  const referenceNow = () => Number(now())
  const zone = () => timeZone

  return {
    store,
    timeZone: zone(),

    /** `/calendar`: ближайшие две недели. */
    calendar(chatId, { days = 14 } = {}) {
      return { text: calendarText(store.upcoming(chatId, { days }), { timeZone }) }
    },

    /** Правила инструмента `event`: добавить, показать, удалить. */
    async executeDetailed(args = {}, context = {}) {
      const { chatId, userId } = context
      if (!store) return { text: 'Ошибка инструмента event: календарь недоступен.' }
      const action = String(args.action ?? 'add').trim().toLowerCase()

      if (action === 'list') {
        const events = store.upcoming(chatId, { days: LIST_DAYS })
        return { text: eventListText(events, { timeZone }) }
      }

      if (action === 'remove') {
        const target = store.remove(chatId, args.id ?? args.title)
        if (!target) return { text: 'Ошибка инструмента event: не нашёл такое событие. Покажите список — action list.' }
        await store.flush()
        return { text: eventRemovedText(target, { timeZone }) }
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

      // Напоминание — отдельное обычное напоминание: так остаётся один путь доставки.
      let reminderNote = ''
      const minutes = clampRemindBefore(remindBefore)
      if (reminderStore && minutes > 0) {
        const remindAt = new Date(instant.getTime() - minutes * 60_000)
        if (remindAt.getTime() > referenceNow()) {
          const created = reminderStore.add({
            chatId,
            userId,
            text: `через ${minutes} мин: ${title}`,
            dueAt: remindAt,
            repeat: 'none',
          })
          if (created) {
            await reminderStore.flush()
            reminderNote = ` Напомню за ${minutes} мин.`
          }
        }
      }
      const reminderHint = reminderStore && minutes === 0 ? ' Напоминать не буду.' : ''
      return {
        text: eventAddedText({ instant, title, repeat, reminderNote, reminderHint, timeZone }),
        event,
      }
    },
  }
}
