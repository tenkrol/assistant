/**
 * Calendar: the store, the tool the model calls, and the digest block.
 *
 * The interesting behaviour is time: a date without a zone must land at the user's
 * local time, a yearly event must come back next year, and the reminder the tool
 * writes is an ordinary reminder the scheduler already knows how to deliver.
 *
 * Dates are always computed from "now": a hard-coded future date silently turns into
 * a past one a few days later, and then the test fails for the wrong reason.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEventTool } from '../src/event-tool.mjs'
import { EventStore, dayKeyInZone } from '../src/events.mjs'
import { ReminderStore } from '../src/reminders.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'
const DAY = 86_400_000
const HOUR = 3_600_000

/** `ГГГГ-ММ-ДД` for `days` from today, in Moscow. */
const dayIn = (days) => dayKeyInZone(new Date(Date.now() + days * DAY), ZONE)

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-events-'))
  const store = new EventStore({ file: path.join(dir, 'events.json'), logger: silent, timeZone: ZONE })
  await store.load()
  return { store, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('an event survives a restart and keeps its local time', async () => {
  const { store, dir, cleanup } = await makeStore()
  try {
    const at = new Date(Date.now() + 3 * DAY)
    at.setUTCMinutes(30, 0, 0)
    store.add({ chatId: 555, userId: 555, title: 'Стоматолог', at: at.toISOString() })
    await store.flush()

    const reopened = new EventStore({ file: path.join(dir, 'events.json'), logger: silent, timeZone: ZONE })
    await reopened.load()
    const [event] = reopened.list(555)
    assert.equal(event.title, 'Стоматолог')

    // The listing must place it on the day it actually falls on, in Moscow.
    const same = reopened.upcoming(555, { from: new Date(event.nextAt), days: 1 })
    assert.equal(same.length, 1, 'событие попадает в свой день')
    assert.equal(same[0].dayKey, dayKeyInZone(new Date(event.nextAt), ZONE))
    // И время в списке — московское, а не UTC.
    const expected = new Intl.DateTimeFormat('ru-RU', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(event.nextAt))
    assert.equal(same[0].time, expected)
  } finally {
    await cleanup()
  }
})

test('a yearly event rolls over to the next year', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const inAWeek = new Date(Date.now() + 7 * DAY)
    const birthday = store.add({ chatId: 1, userId: 1, title: 'День рождения мамы', at: inAWeek.toISOString(), repeat: 'yearly' })
    const [listed] = store.list(1)
    assert.equal(listed.id, birthday.id)
    assert.ok(Date.parse(listed.nextAt) > Date.now(), 'следующее вхождение в будущем')
    const next = new Date(listed.nextAt)
    const original = new Date(birthday.at)
    assert.equal(next.getUTCMonth(), original.getUTCMonth(), 'тот же месяц')
    assert.equal(next.getUTCDate(), original.getUTCDate(), 'то же число')
    // Событие ещё впереди — ближайшее вхождение это оно само.
    assert.equal(next.getUTCFullYear(), original.getUTCFullYear())

    // А прошедшее годовое событие уезжает на следующий год с тем же числом.
    const past = store.add({ chatId: 2, userId: 2, title: 'Годовщина', at: new Date(Date.now() - 30 * DAY).toISOString(), repeat: 'yearly' })
    const [moved] = store.list(2)
    assert.equal(moved.id, past.id)
    const movedDate = new Date(moved.nextAt)
    assert.ok(movedDate.getTime() > Date.now(), 'прошедшее переносится в будущее')
    assert.equal(movedDate.getUTCDate(), new Date(past.at).getUTCDate(), 'число сохраняется')
    assert.equal(movedDate.getUTCFullYear(), new Date(past.at).getUTCFullYear() + 1, 'следующий год')
  } finally {
    await cleanup()
  }
})

test('the tool books an event in the user zone and writes its reminder', async () => {
  const { store, dir, cleanup } = await makeStore()
  try {
    const reminders = { store: new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silent, timeZone: ZONE }) }
    await reminders.store.load()
    const tool = createEventTool({ store, reminders, timeZone: ZONE, logger: silent })

    const added = await tool.executeDetailed({ action: 'add', title: 'Приём у врача', date: dayIn(5), time: '09:15', remind_before: 60 }, { chatId: 555, userId: 555 })
    assert.match(added.text, /09:15/)
    assert.match(added.text, /Напомню за 60 мин/)
    assert.ok(added.event, 'событие возвращено')

    const [reminder] = reminders.store.list(555, 555)
    assert.equal(reminder.text, 'через 60 мин: Приём у врача')
    // Напоминание ровно за час до начала — проверяем относительно самого события.
    assert.equal(new Date(reminder.dueAt).getTime(), Date.parse(added.event.at) - HOUR)
  } finally {
    await cleanup()
  }
})

test('the tool refuses a missing date and lists or removes what exists', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const tool = createEventTool({ store, timeZone: ZONE, logger: silent })
    const noDate = await tool.executeDetailed({ action: 'add', title: 'Ничего' }, { chatId: 1, userId: 1 })
    assert.equal(noDate.event, undefined)
    assert.match(noDate.text, /не понял дату/)

    await tool.executeDetailed({ action: 'add', title: 'Созвон', date: dayIn(2), time: '16:00' }, { chatId: 1, userId: 1 })
    const list = await tool.executeDetailed({ action: 'list' }, { chatId: 1, userId: 1 })
    assert.match(list.text, /Созвон/)

    const removed = await tool.executeDetailed({ action: 'remove', id: '1' }, { chatId: 1, userId: 1 })
    assert.match(removed.text, /Удалил/)
    assert.deepEqual(store.list(1), [])
  } finally {
    await cleanup()
  }
})

test('a birthday is not reminded unless asked', async () => {
  const { store, dir, cleanup } = await makeStore()
  try {
    const reminders = { store: new ReminderStore({ file: path.join(dir, 'r.json'), logger: silent, timeZone: ZONE }) }
    await reminders.store.load()
    const tool = createEventTool({ store, reminders, timeZone: ZONE, logger: silent })
    const result = await tool.executeDetailed({ action: 'add', title: 'День рождения', date: dayIn(30), time: '09:00', repeat: 'yearly', remind_before: 0 }, { chatId: 1, userId: 1 })
    assert.match(result.text, /каждый год/)
    assert.match(result.text, /Напоминать не буду/)
    assert.deepEqual(reminders.store.list(1, 1), [])
  } finally {
    await cleanup()
  }
})

test('a past event is stored but never listed as upcoming', async () => {
  // Так было и в жизни: вчерашняя дата попадала в хранилище, но в «ближайшие» не
  // показывалась — тест однажды упал, потому что ждал её в списке.
  const { store, dir, cleanup } = await makeStore()
  try {
    const reminders = { store: new ReminderStore({ file: path.join(dir, 'r.json'), logger: silent, timeZone: ZONE }) }
    await reminders.store.load()
    const tool = createEventTool({ store, reminders, timeZone: ZONE, logger: silent })

    const past = await tool.executeDetailed({ action: 'add', title: 'Вчера', date: dayIn(-1), time: '12:00' }, { chatId: 1, userId: 1 })
    assert.ok(past.event, 'запись создаётся')
    assert.equal(past.text.includes('Напомню'), false, 'но напоминание о прошедшем не ставится')
    assert.deepEqual(reminders.store.list(1, 1), [])
    assert.deepEqual(store.upcoming(1, { days: 7 }), [], 'и в ближайших его нет')

    const future = await tool.executeDetailed({ action: 'add', title: 'Завтра', date: dayIn(1), time: '12:00' }, { chatId: 1, userId: 1 })
    assert.equal(store.upcoming(1, { days: 7 }).length, 1, 'завтрашнее видно')
    assert.match(future.text, /Напомню/)
  } finally {
    await cleanup()
  }
})

test('the day key follows the user zone', () => {
  // 22:00 UTC on the 8th is already the 9th in Moscow.
  assert.equal(dayKeyInZone(new Date('2026-10-08T22:00:00Z'), ZONE), '2026-10-09')
  assert.equal(dayKeyInZone(new Date('2026-10-08T22:00:00Z'), 'UTC'), '2026-10-08')
})
