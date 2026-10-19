/**
 * Домен напоминаний без платформы и сети.
 *
 * Здесь только чистые правила и маленькое хранилище в памяти: тест не поднимает
 * ни Telegram, ни VK, ни HTTP-сервер, поэтому идёт за миллисекунды.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_MINUTES,
  MIN_MINUTES,
  formatReminderTime,
  quietHoursEnd,
  rulesOfReminders,
  zonedTimeToUtc,
} from '../src/domain/reminders.mjs'

const ZONE = 'Europe/Moscow'
const DAY = 86_400_000

/** День `ГГГГ-ММ-ДД` через `days` дней по Москве. */
const dayIn = (days) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(Date.now() + days * DAY))

/** Хранилище напоминаний в памяти: та же форма записи, что у настоящего стора. */
function makeReminderStore() {
  const reminders = []
  let nextId = 1
  let flushes = 0
  const key = (value) => String(value)
  return {
    reminders,
    get flushes() {
      return flushes
    },
    list(chatId, userId) {
      return reminders.filter((reminder) => {
        if (chatId !== undefined && reminder.chatId !== chatId) return false
        if (userId !== undefined && reminder.userId !== undefined && reminder.userId !== userId) return false
        return true
      })
    },
    add({ chatId, userId, text, dueAt, repeat = 'none' }) {
      const reminder = {
        id: String(nextId++),
        chatId,
        ...(userId === undefined ? {} : { userId }),
        text,
        dueAt: new Date(dueAt).toISOString(),
        repeat,
        createdAt: new Date().toISOString(),
      }
      reminders.push(reminder)
      return reminder
    },
    cancel(chatId, id, userId) {
      const index = reminders.findIndex((reminder) => {
        if (reminder.chatId !== chatId || reminder.id !== key(id)) return false
        if (userId === undefined) return true
        return reminder.userId === undefined || reminder.userId === userId
      })
      if (index === -1) return undefined
      return reminders.splice(index, 1)[0]
    },
    async flush() {
      flushes++
    },
  }
}

test('время в поясе пользователя: 09:00 по Москве — это 06:00 UTC', () => {
  const day = dayIn(3)
  const due = zonedTimeToUtc(`${day}T09:00`, ZONE)
  assert.equal(due.toISOString().slice(11, 16), '06:00')
})

test('создание напоминания сохраняет момент пояса и показывает местное время', async () => {
  const store = makeReminderStore()
  const rules = rulesOfReminders({ store, timeZone: ZONE })
  const day = dayIn(3)
  const result = await rules.create({ text: 'зарядка', at: `${day}T09:00`, repeat: 'daily' }, { chatId: 1, userId: 1 })

  assert.equal(store.reminders.length, 1)
  assert.equal(store.reminders[0].dueAt.slice(11, 16), '06:00')
  assert.match(result.text, /09:00/, 'в подтверждении местное время')
  assert.match(result.text, /каждый день/)
  assert.equal(result.reminder.id, '1')
  assert.equal(store.flushes, 1, 'подтверждённое напоминание сразу записано')
})

test('прошедшее время не принимается и объясняется словами', async () => {
  const store = makeReminderStore()
  const rules = rulesOfReminders({ store, timeZone: ZONE })
  const result = await rules.create({ text: 'поздно', at: new Date(Date.now() - DAY).toISOString() }, { chatId: 1 })

  assert.match(result.text, /уже прошло/)
  assert.match(result.text, /Уточни у пользователя/)
  assert.equal(store.reminders.length, 0, 'в хранилище ничего не попало')
  assert.equal(store.flushes, 0)
})

test('инструмент объясняет недопустимый повтор и неоднозначное время', async () => {
  const store = makeReminderStore()
  const rules = rulesOfReminders({ store, timeZone: ZONE })
  const badRepeat = await rules.create({ text: 'x', in_minutes: 5, repeat: 'hourly' }, { chatId: 1 })
  assert.match(badRepeat.text, /недопустимый повтор/)
  const noTime = await rules.create({ text: 'x' }, { chatId: 1 })
  assert.match(noTime.text, /укажи ровно одно/)
  const both = await rules.create({ text: 'x', in_minutes: 5, at: new Date().toISOString() }, { chatId: 1 })
  assert.match(both.text, /укажи ровно одно/)
  assert.equal(store.reminders.length, 0)
})

test('задержка ограничена теми же пределами, что раньше', async () => {
  const store = makeReminderStore()
  const rules = rulesOfReminders({ store, timeZone: ZONE })
  const result = await rules.create({ text: 'x', in_minutes: MAX_MINUTES + 1 }, { chatId: 1 })
  assert.match(result.text, new RegExp(`от ${MIN_MINUTES} до ${MAX_MINUTES}`))
  assert.equal(store.reminders.length, 0)
})

test('список показывает ближайшие напоминания и кнопки отмены', () => {
  const store = makeReminderStore()
  store.add({ chatId: 1, userId: 1, text: 'позже', dueAt: new Date(Date.now() + 2 * 60 * 60_000), repeat: 'none' })
  store.add({ chatId: 1, userId: 1, text: 'раньше', dueAt: new Date(Date.now() + 60 * 60_000), repeat: 'daily' })
  store.add({ chatId: 1, userId: 2, text: 'чужое', dueAt: new Date(Date.now() + 30 * 60_000), repeat: 'none' })
  const rules = rulesOfReminders({ store, timeZone: ZONE })

  const result = rules.list({ chatId: 1, userId: 1 })
  const first = result.text.indexOf('раньше')
  const second = result.text.indexOf('позже')
  assert.ok(first !== -1 && second !== -1)
  assert.ok(first < second, 'ближайшее напоминание идёт первым')
  assert.ok(!result.text.includes('чужое'), 'чужое личное напоминание не показывается')
  assert.match(result.text, /каждый день/)
  assert.equal(result.keyboard.rows.length, 2)
  assert.match(result.keyboard.rows[0][0].data, /^cancel:\d+$/)
})

test('тихий час переносит на конец окна, а днём ничего не двигает', () => {
  const quiet = { start: 23 * 60, end: 8 * 60 }
  const night = zonedTimeToUtc(`${dayIn(1)}T03:00`, ZONE)
  const end = quietHoursEnd(night, { quiet, timeZone: ZONE })
  assert.ok(end, 'внутри окна конец найден')
  assert.ok(formatReminderTime(end, { timeZone: ZONE }).includes('08:00'))

  const noon = zonedTimeToUtc(`${dayIn(1)}T12:00`, ZONE)
  assert.equal(quietHoursEnd(noon, { quiet, timeZone: ZONE }), undefined)
})

test('откладывание сохраняет повтор и заменяет старое напоминание', async () => {
  const store = makeReminderStore()
  const old = store.add({ chatId: 1, userId: 1, text: 'зарядка', dueAt: new Date(Date.now() - 60_000), repeat: 'daily' })
  const rules = rulesOfReminders({ store, timeZone: ZONE })
  const result = await rules.snooze({ chatId: 1, userId: 1, id: old.id, minutes: 10 })

  assert.equal(result.toast, 'Отложено на 10 мин')
  assert.match(result.outcome, /каждый день/)
  const list = store.list(1, 1)
  assert.equal(list.length, 1)
  assert.notEqual(list[0].id, old.id)
  assert.equal(list[0].repeat, 'daily')
  assert.ok(Date.parse(list[0].dueAt) - Date.now() > 9 * 60_000)
})

test('отмена кнопкой и командой дают прежние тексты', async () => {
  const store = makeReminderStore()
  const reminder = store.add({ chatId: 1, userId: 1, text: 'чайник', dueAt: new Date(Date.now() + 60_000) })
  const rules = rulesOfReminders({ store, timeZone: ZONE })

  const byButton = await rules.cancelByButton({ chatId: 1, userId: 1, id: reminder.id })
  assert.equal(byButton.toast, `Напоминание №${reminder.id} отменено`)
  assert.match(byButton.outcome, /Отменено: «чайник»/)

  const missing = await rules.cancel({ chatId: 1, userId: 1, id: '99' })
  assert.equal(missing.text, 'Напоминания №99 нет. Список — /reminders.')
  const bad = await rules.cancel({ chatId: 1, userId: 1, id: 'не число' })
  assert.match(bad.text, /Укажите номер/)
})

test('текст доставки называет владельца и помечает пропущенное', () => {
  const rules = rulesOfReminders({ store: makeReminderStore(), timeZone: ZONE })
  assert.equal(rules.deliveryText({ chatId: -1, userId: 7, text: 'чайник' }, { owner: 'Вячеслав' }), '⏰ Напоминание для Вячеслав: чайник')
  // Пометка догона называет исходный срок, а не момент доставки.
  const dueAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  assert.match(
    rules.deliveryText(
      { chatId: 1, text: 'чайник', dueAt },
      { lateNotice: true, timeZone: ZONE },
    ),
    /^⏰ пропущено, было на \d{2}\.\d{2} \d{2}:\d{2} — Напоминание: чайник$/,
  )
})
