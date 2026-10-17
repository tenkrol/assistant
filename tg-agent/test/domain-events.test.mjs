/**
 * Домен событий без платформы и сети.
 *
 * Календарь и напоминания — маленькие хранилища в памяти. Проверяются годовое
 * вхождение, время в поясе пользователя и напоминание за N минут до события.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calendarText,
  dayKeyInZone,
  nextYearlyOccurrence,
  rulesOfEvents,
} from '../src/domain/events.mjs'

const ZONE = 'Europe/Moscow'
const DAY = 86_400_000

/** `ГГГГ-ММ-ДД` через `days` дней по Москве. */
const dayIn = (days) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(Date.now() + days * DAY))

/** Хранилище событий в памяти с той же формой записи, что у настоящего стора. */
function makeEventStore() {
  const events = []
  let nextId = 1
  let flushes = 0
  const nextAt = (event, now = new Date()) => (event.repeat === 'yearly' ? nextYearlyOccurrence(event.at, now) : event.at)
  const self = {
    events,
    get flushes() {
      return flushes
    },
    add({ chatId, userId, title, at, repeat = 'none', place, remindBefore }) {
      const event = {
        id: String(nextId++),
        chatId,
        userId,
        title: String(title).trim(),
        at: new Date(at).toISOString(),
        repeat,
        ...(place ? { place } : {}),
        ...(remindBefore === undefined ? {} : { remindBefore }),
        createdAt: new Date().toISOString(),
      }
      events.push(event)
      return event
    },
    list(chatId) {
      return events
        .filter((event) => chatId === undefined || event.chatId === chatId)
        .map((event) => ({ ...event, nextAt: nextAt(event) }))
        .sort((left, right) => Date.parse(left.nextAt) - Date.parse(right.nextAt))
    },
    upcoming(chatId, { from = new Date(), days = 1 } = {}) {
      const keys = new Set()
      for (let offset = 0; offset < days; offset++) keys.add(dayKeyInZone(new Date(from.getTime() + offset * DAY), ZONE))
      return self.list(chatId)
        .filter((event) => keys.has(dayKeyInZone(new Date(event.nextAt), ZONE)))
        .map((event) => ({ ...event, dayKey: dayKeyInZone(new Date(event.nextAt), ZONE) }))
    },
    remove(chatId, id) {
      const index = events.findIndex((event) => event.chatId === chatId && event.id === String(id))
      if (index === -1) return undefined
      return events.splice(index, 1)[0]
    },
    async flush() {
      flushes++
    },
  }
  return self
}

/** Хранилище напоминаний, куда событие пишет своё напоминание. */
function makeReminderStore() {
  const reminders = []
  let flushes = 0
  return {
    reminders,
    get flushes() {
      return flushes
    },
    add({ chatId, userId, text, dueAt, repeat = 'none' }) {
      const reminder = { id: String(reminders.length + 1), chatId, userId, text, dueAt: new Date(dueAt).toISOString(), repeat }
      reminders.push(reminder)
      return reminder
    },
    async flush() {
      flushes++
    },
  }
}

test('годовое событие возвращается в следующем году с тем же числом', () => {
  const past = new Date(Date.now() - 30 * DAY)
  const next = nextYearlyOccurrence(past.toISOString(), new Date())
  assert.ok(Date.parse(next) > Date.now())
  assert.equal(new Date(next).getUTCDate(), past.getUTCDate())
  assert.equal(new Date(next).getUTCMonth(), past.getUTCMonth())
  assert.equal(new Date(next).getUTCFullYear(), past.getUTCFullYear() + 1)

  const future = new Date(Date.now() + 7 * DAY)
  assert.equal(nextYearlyOccurrence(future.toISOString(), new Date()), future.toISOString(), 'будущее не двигается')
})

test('мероприятие записывается в поясе пользователя и ставит напоминание за 60 минут', async () => {
  const store = makeEventStore()
  const reminders = makeReminderStore()
  const rules = rulesOfEvents({ store, reminders, timeZone: ZONE })
  const result = await rules.executeDetailed(
    { action: 'add', title: 'Приём у врача', date: dayIn(5), time: '09:15', remind_before: 60 },
    { chatId: 1, userId: 1 },
  )

  assert.match(result.text, /09:15/)
  assert.match(result.text, /Напомню за 60 мин/)
  assert.equal(result.event.at.slice(11, 16), '06:15', '09:15 по Москве — 06:15 UTC')
  assert.equal(store.events.length, 1)
  assert.equal(store.flushes, 1)
  assert.equal(reminders.reminders.length, 1)
  assert.equal(reminders.reminders[0].text, 'через 60 мин: Приём у врача')
  assert.equal(Date.parse(reminders.reminders[0].dueAt), Date.parse(result.event.at) - 3_600_000)
})

test('remind_before = 0 не создаёт напоминание и честно об этом говорит', async () => {
  const store = makeEventStore()
  const reminders = makeReminderStore()
  const rules = rulesOfEvents({ store, reminders, timeZone: ZONE })
  const result = await rules.executeDetailed(
    { action: 'add', title: 'Созвон', date: dayIn(2), time: '16:00', remind_before: 0 },
    { chatId: 1, userId: 1 },
  )
  assert.match(result.text, /Напоминать не буду/)
  assert.equal(reminders.reminders.length, 0)
})

test('без даты инструмент объясняет, что нужно', async () => {
  const store = makeEventStore()
  const rules = rulesOfEvents({ store, timeZone: ZONE })
  const result = await rules.executeDetailed({ action: 'add', title: 'Ничего' }, { chatId: 1, userId: 1 })
  assert.match(result.text, /не понял дату/)
  assert.equal(store.events.length, 0)
})

test('список событий и календарь помечают годовой повтор', async () => {
  const store = makeEventStore()
  const rules = rulesOfEvents({ store, timeZone: ZONE })
  await rules.executeDetailed(
    { action: 'add', title: 'День рождения мамы', date: dayIn(2), time: '10:00', repeat: 'yearly' },
    { chatId: 1, userId: 1 },
  )

  const list = await rules.executeDetailed({ action: 'list' }, { chatId: 1 })
  assert.match(list.text, /День рождения мамы/)
  assert.match(list.text, /каждый год/)

  const calendar = rules.calendar(1)
  assert.match(calendar.text, /День рождения мамы/)
  assert.match(calendar.text, /каждый год/)
})

test('пустой календарь отвечает прежними фразами', async () => {
  const store = makeEventStore()
  const rules = rulesOfEvents({ store, timeZone: ZONE })
  const list = await rules.executeDetailed({ action: 'list' }, { chatId: 1 })
  assert.equal(list.text, 'В ближайшие 7 дней событий нет.')
  assert.match(rules.calendar(1).text, /В ближайшие две недели событий нет/)
  assert.match(calendarText([], { timeZone: ZONE }), /Добавить: «запиши стоматолога/)
})

test('событие удаляется по номеру и подтверждает удаление', async () => {
  const store = makeEventStore()
  const rules = rulesOfEvents({ store, timeZone: ZONE })
  await rules.executeDetailed({ action: 'add', title: 'Созвон', date: dayIn(2), time: '16:00' }, { chatId: 1, userId: 1 })
  const removed = await rules.executeDetailed({ action: 'remove', id: '1' }, { chatId: 1 })
  assert.match(removed.text, /Удалил событие «Созвон»/)
  assert.equal(store.events.length, 0)
})
