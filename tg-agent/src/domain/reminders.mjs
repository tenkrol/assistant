/**
 * Домен напоминаний: время по часовому поясу пользователя, инварианты, повторы
 * и ближайшие напоминания.
 *
 * Здесь нет Telegram, VK, сети и `bot.mjs`: на входе хранилище и обычные данные,
 * на выходе результат и готовый текст сообщения. Форматы хранения не меняются —
 * домен читает и пишет те же самые записи, что и раньше.
 */
import { REPEAT_VALUES, describeRepeat, isRepeat } from './repeats.mjs'

/** Нижняя и верхняя границы задержки `in_minutes` — те же, что были в инструменте. */
export const MIN_MINUTES = 0.05
export const MAX_MINUTES = 100_000
/** Сколько напоминаний показываем кнопками отмены в списке. */
export const LIST_BUTTONS = 8

/** Часовой пояс пользователя; пустая настройка означает системный. */
export function resolveZone(timeZone = '') {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Перевести местное время в момент времени.
 *
 * Строка с явным смещением или `Z` уже называет момент и берётся как есть.
 * Наивная строка («2026-10-06T09:00», её обычно и присылает модель) читается
 * в `timeZone`: смещение достаётся из `Intl` и применяется один раз.
 *
 * @param {string} localIso - ISO-время, со смещением или без.
 * @param {string} timeZone - пояс для наивного ввода, пусто — системный.
 * @returns {Date} соответствующий момент времени.
 */
export function zonedTimeToUtc(localIso, timeZone = '') {
  const value = String(localIso ?? '').trim()
  if (/(?:[+-]\d{2}:?\d{2}|Z)$/i.test(value)) {
    const explicit = new Date(value)
    if (Number.isNaN(explicit.getTime())) throw new Error(`cannot parse time: ${localIso}`)
    return explicit
  }
  const zone = resolveZone(timeZone)
  const naive = new Date(`${value}Z`)
  if (Number.isNaN(naive.getTime())) throw new Error(`cannot parse time: ${localIso}`)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(naive).map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  const offsetMs = asUtc - Math.floor(naive.getTime() / 1000) * 1000
  return new Date(naive.getTime() - offsetMs)
}

/**
 * Местные дата и время одного момента.
 *
 * @param {Date|string|number} value - момент времени.
 * @param {object} [options] - `timeZone`, `locale`.
 * @returns {string} человекочитаемая строка, как в подтверждениях напоминаний.
 */
export function formatReminderTime(value, { timeZone = '', locale = 'ru-RU' } = {}) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: resolveZone(timeZone),
  }).format(value instanceof Date ? value : new Date(value))
}

/** Подпись повтора в списке `/reminders` — дословно прежняя. */
export function reminderListRepeat(repeat) {
  if (repeat === 'none' || repeat === undefined) return ''
  return repeat === 'daily' ? ', каждый день' : ', каждую неделю'
}

/** Пометка повтора при откладывании — дословно прежняя. */
export function snoozeRepeatNote(repeat) {
  if (repeat === 'none' || repeat === undefined) return ''
  return repeat === 'daily' ? ' (дальше — каждый день)' : ' (дальше — каждую неделю)'
}

/**
 * Когда заканчивается тихий час, если `now` внутри него.
 *
 * Чистая функция: конфигурация приходит параметром, поэтому её легко проверить
 * без бота и без подмены системных часов.
 *
 * @param {Date} now - проверяемый момент.
 * @param {object} options - `quiet` (`{start, end}` в минутах от полуночи) и `timeZone`.
 * @returns {Date|undefined} конец окна или `undefined`, когда сейчас не тихо.
 */
export function quietHoursEnd(now, { quiet, timeZone = '' } = {}) {
  if (!quiet) return undefined
  const zone = timeZone
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((part) => [part.type, part.value]))
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const crossesMidnight = quiet.start > quiet.end
  const inside = crossesMidnight
    ? (minutes >= quiet.start || minutes < quiet.end)
    : (minutes >= quiet.start && minutes < quiet.end)
  if (!inside) return undefined
  const endHour = String(Math.floor(quiet.end / 60)).padStart(2, '0')
  const endMinute = String(quiet.end % 60).padStart(2, '0')
  let day = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
  // Вечернее окно заканчивается завтра; утреннее — сегодня.
  if (crossesMidnight && minutes >= quiet.start) {
    const next = new Date(Date.UTC(day.year, day.month - 1, day.day) + 24 * 60 * 60 * 1000)
    day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
  }
  const stamp = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}T${endHour}:${endMinute}:00`
  return zonedTimeToUtc(stamp, zone)
}

/** Момент сейчас как `Date`: правило не зависит от того, что вернул инжектированный клок. */
function asDate(value) {
  return value instanceof Date ? value : new Date(value)
}

/** Напоминания чата/пользователя, ближайшее первым. */
export function nearestReminders(store, { chatId, userId } = {}) {
  return [...(store?.list(chatId, userId) ?? [])].sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
}

/** Текст подтверждения создания напоминания. */
export function reminderConfirmation({ reminder, due, repeat = 'none', timeZone = '', locale = 'ru-RU' }) {
  const zone = resolveZone(timeZone)
  const human = formatReminderTime(due, { timeZone, locale })
  const repeatText = describeRepeat(repeat) ?? 'без повтора'
  return `Напоминание №${reminder.id} создано: ${human} (${zone}), ${repeatText}. Текст: «${reminder.text}».`
}

/**
 * Пометка догона: «⏰ пропущено, было на DD.MM HH:MM — ».
 *
 * Время берётся из сохранённого `dueAt`, а не из момента доставки: человек
 * должен видеть, когда напоминание должно было сработать.
 *
 * @param {string|Date|number} dueAt - исходный срок.
 * @param {object} [options] - `timeZone`: пояс получателя.
 * @returns {string} префикс с исходным сроком.
 */
export function lateReminderPrefix(dueAt, { timeZone = '' } = {}) {
  const due = new Date(dueAt)
  // Битая запись не должна ронять доставку: лучше честная пометка без времени.
  if (Number.isNaN(due.getTime())) return '⏰ пропущено — '
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ru-RU', {
    timeZone: resolveZone(timeZone),
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(due).map((part) => [part.type, part.value]))
  const hour = String(Number(parts.hour) % 24).padStart(2, '0')
  return `⏰ пропущено, было на ${parts.day}.${parts.month} ${hour}:${parts.minute} — `
}

/** Текст доставленного напоминания. */
export function reminderDeliveryText(reminder, { lateNotice = false, owner, timeZone = '' } = {}) {
  const text = String(reminder?.text ?? '')
  if (lateNotice) {
    return `${lateReminderPrefix(reminder?.dueAt, { timeZone })}${owner ? `Напоминание для ${owner}: ` : 'Напоминание: '}${text}`
  }
  const prefix = '⏰ Напоминание'
  return `${prefix}${owner ? ` для ${owner}` : ''}: ${text}`
}

/**
 * Правила домена напоминаний.
 *
 * @param {object} options - `store`, `timeZone`, `locale`, `now`, `quiet`, `logger`.
 * @returns {object} правила: создание, список, отмена, откладывание, доставка.
 */
export function rulesOfReminders({ store, timeZone = '', locale = 'ru-RU', now = () => new Date(), quiet, logger, access } = {}) {
  const referenceNow = () => asDate(now())
  // Доступ приходит извне, но если хранилище уже собрано с ним — берём оттуда.
  const guard = access ?? store?.access
  const readOnlyText = 'Только просмотр: в этом проекте у вас роль viewer, изменения недоступны. Попросите владельца выдать роль editor.'

  /** Можно ли менять запись; без access ограничение прежнее — по userId/chatId. */
  const writable = (userId, record) => !guard || userId === undefined || guard.canWrite(userId, record)

  return {
    store,
    zone: () => resolveZone(timeZone),
    formatTime: (value) => formatReminderTime(value, { timeZone, locale }),
    nearest: (chatId, userId) => nearestReminders(store, { chatId, userId }),

    /**
     * Правила инструмента `remind`: разобрать время, проверить инварианты и
     * создать напоминание. Ничего не пишет, если время уже прошло.
     */
    async create(args = {}, context = {}) {
      const { text, in_minutes: inMinutes, at, repeat = 'none' } = args
      const { chatId, userId } = context
      if (!Number.isFinite(chatId)) return { text: 'Ошибка инструмента remind: не удалось определить чат.' }
      const hasDelay = inMinutes !== undefined && inMinutes !== null
      const hasMoment = typeof at === 'string' && at.trim() !== ''
      // Форма аргументов проверяется раньше времени: недопустимый повтор должен
      // быть назван, даже если вызывающий забыл время.
      if (!isRepeat(repeat)) return { text: 'Ошибка инструмента remind: недопустимый повтор. Можно: none, daily, weekdays, weekly, weekly:1..7, monthly:1..31, every:N (N кратно 5).' }
      if (hasDelay === hasMoment) {
        return { text: 'Ошибка инструмента remind: укажи ровно одно — in_minutes (через сколько минут) или at (дата и время). Если пользователь не назвал время, спроси его.' }
      }

      const reference = referenceNow()
      let due
      try {
        if (hasDelay) {
          const minutes = Number(inMinutes)
          if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
            return { text: `Ошибка инструмента remind: in_minutes должно быть числом от ${MIN_MINUTES} до ${MAX_MINUTES}.` }
          }
          due = new Date(reference.getTime() + Math.round(minutes * 60_000))
        } else {
          // Явное смещение уважаем, наивное местное время читаем в поясе.
          due = zonedTimeToUtc(at.trim(), resolveZone(timeZone))
        }
        if (Number.isNaN(due.getTime())) throw new Error('unparseable time')
      } catch {
        return { text: 'Ошибка инструмента remind: не удалось разобрать время. Передай in_minutes или at в формате ISO 8601, например 2026-10-06T09:00:00+03:00.' }
      }
      if (due.getTime() < reference.getTime() - 60_000) {
        const past = formatReminderTime(due, { timeZone, locale })
        return { text: `Ошибка инструмента remind: время ${past} уже прошло. Уточни у пользователя дату и время.` }
      }

      if (guard && userId !== undefined) {
        const scopeId = guard.scopeIdFor(userId, chatId)
        if (!guard.canWriteScope(userId, scopeId)) return { text: readOnlyText }
      }
      let reminder
      try {
        reminder = store.add({ chatId, userId, text, dueAt: due, repeat })
      } catch (error) {
        if (/access denied/.test(String(error?.message))) return { text: readOnlyText }
        return { text: `Ошибка инструмента remind: ${error.message}` }
      }
      // Подтверждённое напоминание обязано пережить перезапуск.
      await store.flush()
      return {
        text: reminderConfirmation({ reminder, due, repeat, timeZone, locale }),
        reminder,
      }
    },

    /** Список `/reminders` с кнопками отмены. */
    list({ chatId, userId } = {}) {
      const list = nearestReminders(store, { chatId, userId })
      if (list.length === 0) {
        return { text: 'Напоминаний нет. Скажите, например: «напомни завтра в 9 позвонить маме».' }
      }
      const lines = list.map((reminder) => (
        `№${reminder.id} — ${formatReminderTime(reminder.dueAt, { timeZone, locale })}${reminderListRepeat(reminder.repeat)}: ${reminder.text}`
      ))
      return {
        text: ['**Напоминания:**', ...lines, '', 'Отменить: `/cancel <номер>` или кнопкой ниже'].join('\n'),
        keyboard: {
          rows: list.slice(0, LIST_BUTTONS).map((reminder) => [{ text: `✖️ Отменить №${reminder.id}`, data: `cancel:${reminder.id}` }]),
        },
      }
    },

    /** Команда `/cancel <номер>`. */
    async cancel({ chatId, userId, id } = {}) {
      const value = String(id ?? '').trim()
      if (!/^\d+$/.test(value)) {
        return { text: 'Укажите номер: `/cancel 3`. Список — `/reminders`.' }
      }
      const known = userId === undefined ? undefined : store?.list?.(undefined, userId)?.find((item) => item.id === value)
      if (known && !writable(userId, known)) return { text: readOnlyText }
      const removed = store?.cancel(chatId, value, userId)
      await store?.flush()
      return {
        text: removed ? `Напоминание №${value} отменено.` : `Напоминания №${value} нет. Список — /reminders.`,
        removed,
      }
    },

    /** Отмена кнопкой под сообщением: короткое всплывающее и новый текст сообщения. */
    async cancelByButton({ chatId, userId, id } = {}) {
      const known = userId === undefined ? undefined : store?.list?.(undefined, userId)?.find((item) => item.id === String(id))
      if (known && !writable(userId, known)) {
        return { toast: 'Только просмотр', outcome: readOnlyText, denied: true }
      }
      const removed = store?.cancel(chatId, id, userId)
      await store?.flush()
      return {
        toast: removed ? `Напоминание №${id} отменено` : `Напоминания №${id} уже нет`,
        outcome: removed ? `✖️ Отменено: «${removed.text}»` : '✖️ Напоминание уже отменено',
        removed,
      }
    },

    /** Откладывание кнопкой: старый повтор сохраняется, старое напоминание удаляется. */
    async snooze({ chatId, userId, id, minutes: rawMinutes } = {}) {
      // Без хранилища кнопка не работает: ядро покажет общую ошибку действия.
      if (!store) throw new Error('напоминания недоступны')
      const minutes = Number(rawMinutes)
      const existing = store.list(chatId, userId).find((reminder) => reminder.id === String(id))
      if (!existing) {
        return {
          toast: 'Напоминание уже неактивно',
          outcome: '✖️ Это напоминание уже сработало или отменено',
        }
      }
      if (!writable(userId, existing)) {
        return { toast: 'Только просмотр', outcome: readOnlyText, denied: true }
      }
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
        return { toast: 'Неверная задержка' }
      }
      const moved = store.add({
        chatId,
        userId: existing.userId,
        text: existing.text,
        dueAt: new Date(referenceNow().getTime() + minutes * 60_000),
        repeat: existing.repeat ?? 'none',
        ...(existing.scope_id === undefined ? {} : { scopeId: existing.scope_id }),
      })
      store.cancel(chatId, existing.id, userId)
      await store.flush()
      const when = formatReminderTime(moved.dueAt, { timeZone, locale })
      return {
        toast: `Отложено на ${minutes} мин`,
        outcome: `⏰ Отложено до ${when}${snoozeRepeatNote(moved.repeat)}`,
        reminder: moved,
      }
    },

    /** Перенести сработавшее напоминание на конец тихого часа. */
    async postponeForQuietHours(reminder, until) {
      if (!store) throw new Error('напоминания недоступны')
      const moved = store.add({
        chatId: reminder.chatId,
        userId: reminder.userId,
        text: reminder.text,
        dueAt: until,
        repeat: reminder.repeat ?? 'none',
        ...(reminder.scope_id === undefined ? {} : { scopeId: reminder.scope_id }),
        // Перенос из-за тихого часа — системное действие, а не правка человеком.
        system: true,
      })
      store.cancel(reminder.chatId, reminder.id, reminder.userId)
      await store.flush()
      return moved
    },

    /** Конец тихого часа; ошибка расчёта не должна ломать доставку. */
    quietHoursEnd(instant) {
      try {
        return quietHoursEnd(instant, { quiet, timeZone })
      } catch (error) {
        logger?.warn?.('quiet hours calculation failed', { error })
        return undefined
      }
    },

    /** Текст доставленного напоминания. */
    deliveryText: reminderDeliveryText,

    /** Подписи повторов (для команд и списков). */
    repeatValues: REPEAT_VALUES,
    describeRepeat,
    isRepeat,
  }
}
