import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/history.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

async function makeStore({ limit = 4, saveDelayMs = 1, maxChats = 1000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-history-'))
  const file = path.join(dir, 'history.json')
  const store = new HistoryStore({ file, limit, logger: silentLogger, saveDelayMs, maxChats })
  await store.load()
  return {
    dir,
    file,
    store,
    /**
     * Flush before removing: the store writes on a debounce, and an unflushed
     * write landing during `rm` would leave the directory non-empty.
     */
    cleanup: async () => {
      await store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

test('keeps at most `limit` messages and never starts with an assistant turn', async () => {
  const ctx = await makeStore({ limit: 3 })
  try {
    for (let i = 0; i < 5; i++) {
      await ctx.store.append('42', { role: 'user', content: `u${i}` })
      await ctx.store.append('42', { role: 'assistant', content: `a${i}` })
    }
    const messages = ctx.store.messages('42')
    assert.ok(messages.length <= 3, `length ${messages.length}`)
    assert.equal(messages[0].role, 'user')
    // The newest turn is always kept; older messages fall off the front.
    assert.deepEqual(messages.map((m) => m.content), ['u4', 'a4'])
  } finally {
    await ctx.cleanup()
  }
})

test('persists across instances and reloads the model override', async () => {
  const ctx = await makeStore()
  try {
    await ctx.store.append('42', { role: 'user', content: 'привет' })
    await ctx.store.append('42', { role: 'assistant', content: 'здравствуй' })
    await ctx.store.setModel('42', 'deepseek-reasoner')
    await ctx.store.flush()

    const reopened = new HistoryStore({ file: ctx.file, limit: 4, logger: silentLogger })
    await reopened.load()
    assert.deepEqual(reopened.messages('42').map((m) => m.content), ['привет', 'здравствуй'])
    assert.equal(reopened.model('42'), 'deepseek-reasoner')
  } finally {
    await ctx.cleanup()
  }
})

test('reset clears messages but keeps the model override', async () => {
  const ctx = await makeStore()
  try {
    await ctx.store.append('42', { role: 'user', content: 'привет' })
    await ctx.store.setModel('42', 'custom-model')
    await ctx.store.reset('42')
    assert.deepEqual(ctx.store.messages('42'), [])
    assert.equal(ctx.store.model('42'), 'custom-model')
  } finally {
    await ctx.cleanup()
  }
})

test('chats are isolated from each other', async () => {
  const ctx = await makeStore()
  try {
    await ctx.store.append('1', { role: 'user', content: 'первый чат' })
    await ctx.store.append('2', { role: 'user', content: 'второй чат' })
    assert.deepEqual(ctx.store.messages('1').map((m) => m.content), ['первый чат'])
    assert.deepEqual(ctx.store.messages('2').map((m) => m.content), ['второй чат'])
  } finally {
    await ctx.cleanup()
  }
})

test('findTaskText searches only inside the requested chat', async () => {
  const ctx = await makeStore({ limit: 10 })
  try {
    await ctx.store.append('101', { role: 'user', content: 'секрет первого' })
    await ctx.store.append('101', { role: 'assistant', content: 'Задача task-secret передана' })
    await ctx.store.append('202', { role: 'user', content: 'запрос второго' })
    assert.equal(ctx.store.findTaskText('task-secret', { chatId: '101' }), 'секрет первого')
    assert.equal(ctx.store.findTaskText('task-secret', { chatId: '202' }), undefined)
    assert.equal(ctx.store.findTaskText('task-secret'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('a corrupt file is ignored instead of crashing the bot', async () => {
  const ctx = await makeStore()
  try {
    await fs.writeFile(ctx.file, '{ this is not json', 'utf8')
    const store = new HistoryStore({ file: ctx.file, limit: 4, logger: silentLogger })
    await store.load()
    assert.deepEqual(store.messages('42'), [])
    await store.append('42', { role: 'user', content: 'после сбоя' })
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.chats['42'].messages[0].content, 'после сбоя')
  } finally {
    await ctx.cleanup()
  }
})

// Regression: the store used to keep a record per chat forever.
test('evicts the least recently used chats beyond maxChats', async () => {
  const ctx = await makeStore({ maxChats: 3 })
  try {
    for (const chatId of ['1', '2', '3']) await ctx.store.append(chatId, { role: 'user', content: chatId })
    // Touch chat 1 so chat 2 becomes the least recently used one.
    ctx.store.messages('1')
    await ctx.store.append('4', { role: 'user', content: '4' })

    assert.equal(ctx.store.size, 3)
    assert.deepEqual(ctx.store.messages('2'), [], 'chat 2 should have been evicted')
    for (const chatId of ['1', '3', '4']) {
      assert.equal(ctx.store.messages(chatId).length, 1, `chat ${chatId} should survive`)
    }
  } finally {
    await ctx.cleanup()
  }
})
