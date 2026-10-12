import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { STATUS, TaskJournal, describeTask } from '../src/tasks.mjs'
import { cleanup, createTestLogger, tempDir } from './helpers.mjs'

const journalFor = (dir) => new TaskJournal({ file: path.join(dir, 'tasks.jsonl'), logger: createTestLogger(), maxEntries: 10 })

test('a task is opened, updated and closed on disk', async () => {
  const dir = await tempDir()
  try {
    const journal = await journalFor(dir).load()
    await journal.open({ id: 't1', chatId: 42, userId: 7, brief: 'сделай отчёт' })
    await journal.update('t1', { steps: 3, tokens: { total: 100 } })
    await journal.close('t1', { status: STATUS.done, files: ['outbox/отчёт.docx'] })
    await journal.flush()

    const reloaded = await journalFor(dir).load()
    const record = reloaded.get('t1')
    assert.equal(record.status, STATUS.done)
    assert.equal(record.steps, 3)
    assert.equal(record.chatId, '42')
    assert.deepEqual(record.files, ['outbox/отчёт.docx'])
    assert.ok(record.finishedAt >= record.createdAt)
  } finally {
    await cleanup(dir)
  }
})

test('the last line for an id wins, and junk lines are skipped', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'tasks.jsonl')
    await fs.writeFile(file, [
      JSON.stringify({ version: 1, id: 't1', status: 'running', createdAt: 1 }),
      'это не json',
      JSON.stringify({ version: 1, id: 't1', status: 'done', createdAt: 1 }),
      JSON.stringify({ version: 99, id: 't2', status: 'done' }),
    ].join('\n'))
    const journal = await journalFor(dir).load()
    assert.equal(journal.records.size, 1)
    assert.equal(journal.get('t1').status, 'done')
  } finally {
    await cleanup(dir)
  }
})

test('ids are unique and short', async () => {
  const dir = await tempDir()
  try {
    const journal = journalFor(dir)
    const ids = new Set()
    for (let i = 0; i < 50; i += 1) ids.add(journal.nextId())
    assert.equal(ids.size, 50)
    for (const id of ids) assert.ok(id.length <= 12, id)
  } finally {
    await cleanup(dir)
  }
})

test('recent returns newest first and awaiting finds parked tasks', async () => {
  const dir = await tempDir()
  try {
    const journal = journalFor(dir)
    await journal.open({ id: 'a', chatId: 1, brief: 'первая' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await journal.open({ id: 'b', chatId: 1, brief: 'вторая' })
    await journal.update('b', { status: STATUS.awaiting, question: 'какой формат?' })

    assert.deepEqual(journal.recent(5).map((record) => record.id), ['b', 'a'])
    assert.deepEqual(journal.awaiting().map((record) => record.id), ['b'])
  } finally {
    await cleanup(dir)
  }
})

test('compaction keeps the journal to one line per task', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'tasks.jsonl')
    const journal = new TaskJournal({ file, maxEntries: 2, logger: createTestLogger() })
    // Distinct creation times: "newest first" must not depend on tie-breaking.
    for (const id of ['a', 'b', 'c', 'd']) {
      await journal.open({ id, chatId: 1, brief: id })
      await new Promise((resolve) => setTimeout(resolve, 3))
    }
    await journal.update('c', { status: STATUS.done })
    await journal.compact()

    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2, 'only the newest maxEntries tasks stay')
    const reloaded = await journalFor(dir).load()
    assert.deepEqual(reloaded.recent(5).map((record) => record.id), ['d', 'c'])
    assert.equal(reloaded.get('c').status, STATUS.done)
  } finally {
    await cleanup(dir)
  }
})

test('describeTask shows status, spend and files', async () => {
  const dir = await tempDir()
  try {
    const journal = journalFor(dir)
    await journal.open({ id: 't9', chatId: 1, brief: 'собери отчёт по продажам' })
    await journal.close('t9', {
      status: STATUS.done,
      durationMs: 25_000,
      steps: 4,
      tokens: { total: 28_572 },
      usd: 0.0042,
      files: ['outbox/отчёт.docx'],
    })
    const text = describeTask(journal.get('t9'))
    assert.match(text, /✅ выполнена/)
    assert.match(text, /t9/)
    assert.match(text, /собери отчёт/)
    assert.match(text, /28\s?572/)
    assert.match(text, /outbox\/отчёт\.docx/)
  } finally {
    await cleanup(dir)
  }
})
