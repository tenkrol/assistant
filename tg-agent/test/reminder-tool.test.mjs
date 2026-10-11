/**
 * The reminder tool must persist what it creates.
 *
 * The store keeps reminders in memory and writes on demand; the tool used to skip
 * that write, so a reminder confirmed to the user disappeared on the next restart.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ReminderStore } from '../src/reminders.mjs'
import { createReminderTool } from '../src/reminder-tool.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

test('a reminder created by the tool is on disk right away', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminders-'))
  const file = path.join(dir, 'reminders.json')
  try {
    const store = new ReminderStore({ file, logger: silentLogger })
    await store.load()
    const tool = createReminderTool({ store, timeZone: 'Europe/Moscow' })
    // Relative time on purpose: a hardcoded date turns into the past and the tool
    // then (correctly) refuses it, which used to break this test the next day.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const at = tomorrow.toISOString()
    const result = await tool.execute({ text: 'купить хлеб', at }, { chatId: 42, userId: 42 })
    assert.match(result, /создано/)
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(saved.reminders.length, 1, 'напоминание записано сразу')
    assert.equal(saved.reminders[0].text, 'купить хлеб')
    // A fresh store reading the file is exactly what a restart does.
    const reopened = new ReminderStore({ file, logger: silentLogger })
    await reopened.load()
    assert.equal(reopened.list().length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a reminder the tool refuses is not written', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminders-'))
  const file = path.join(dir, 'reminders.json')
  try {
    const store = new ReminderStore({ file, logger: silentLogger })
    await store.load()
    const tool = createReminderTool({ store, timeZone: 'Europe/Moscow' })
    // A moment in the past is rejected before anything is stored.
    const result = await tool.execute({ text: 'поздно', at: '2020-01-01T09:00:00+03:00' }, { chatId: 42 })
    assert.match(String(result), /уже прошло/)
    assert.equal(store.list().length, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
