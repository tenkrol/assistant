/**
 * Calendar: the store, the tool the model calls, and the digest block.
 *
 * The interesting behaviour is time: a date without a zone must land at the user's
 * local time, a yearly event must come back next year, and the reminder the tool
 * writes is an ordinary reminder the scheduler already knows how to deliver.
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

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-events-'))
  const store = new EventStore({ file: path.join(dir, 'events.json'), logger: silent, timeZone: ZONE })
  await store.load()
  return { store, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('an event survives a restart and keeps its local time', async () => {
  const { store, dir, cleanup } = await makeStore()
  try {
    store.add({ chatId: 555, userId: 555, title: 'Стоматолог', at: '2026-10-15T08:30:00Z' })
    await store.flush()
    const reopened = new EventStore({ file: path.join(dir, 'events.json'), logger: silent, timeZone: ZONE })
    await reopened.load()
    const [event] = reopened.list(555)
    assert.equal(event.title, 'Стоматолог')
    const today = reopened.upcoming(555, { from: new Date('2026-10-15T05:00:00Z'), days: 1 })
    assert.equal(today.length, 1)
    assert.equal(today[0].time, '11:30', '11:30 по Москве, а не 08:30')
  } finally {
    await cleanup()
  }
})

test('a yearly event rolls over to the next year', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const birthday = store.add({ chatId: 1, userId: 1, title: 'День рождения мамы', at: '2026-03-12T06:00:00Z', repeat: 'yearly' })
    const [listed] = store.list(1)
    assert.equal(listed.id, birthday.id)
    assert.ok(Date.parse(listed.nextAt) > Date.now(), 'следующее вхождение в будущем')
    assert.equal(new Date(listed.nextAt).toISOString().slice(5, 10), '03-12', 'та же дата, другой год')
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
    const added = await tool.executeDetailed({ action: 'add', title: 'Приём у врача', date: '2026-10-20', time: '09:15', remind_before: 60 }, { chatId: 555, userId: 555 })
    assert.match(added.text, /20 октября в 09:15/)
    assert.match(added.text, /Напомню за 60 мин/)
    assert.ok(added.event, 'событие возвращено')
    const [reminder] = reminders.store.list(555, 555)
    assert.equal(reminder.text, 'через 60 мин: Приём у врача')
    assert.equal(new Date(reminder.dueAt).toISOString(), '2026-10-20T05:15:00.000Z', 'за час до начала по Москве')
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
    await tool.executeDetailed({ action: 'add', title: 'Созвон', date: '2026-10-11', time: '16:00' }, { chatId: 1, userId: 1 })
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
    const result = await tool.executeDetailed({ action: 'add', title: 'День рождения', date: '2026-12-01', time: '09:00', repeat: 'yearly', remind_before: 0 }, { chatId: 1, userId: 1 })
    assert.match(result.text, /каждый год/)
    assert.match(result.text, /Напоминать не буду/)
    assert.deepEqual(reminders.store.list(1, 1), [])
  } finally {
    await cleanup()
  }
})

test('the day key follows the user zone', () => {
  // 22:00 UTC on the 8th is already the 9th in Moscow.
  assert.equal(dayKeyInZone(new Date('2026-10-08T22:00:00Z'), ZONE), '2026-10-09')
  assert.equal(dayKeyInZone(new Date('2026-10-08T22:00:00Z'), 'UTC'), '2026-10-08')
})
