import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { createBotHarness } from './helpers.mjs'

const OK_USAGE = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 160, steps: 1, turns: 1 }

const okResult = (over = {}) => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  aborted: false,
  text: 'Готово',
  sessionId: 'session-stub-1',
  usage: OK_USAGE,
  tools: [],
  errors: [],
  stderr: '',
  durationMs: 2000,
  ...over,
})

const message = (over = {}) => ({
  kind: 'message',
  id: 1,
  chat: { id: 42, type: 'private' },
  from: { id: 42, name: 'Вячеслав', isBot: false },
  text: '',
  attachments: [],
  addressed: true,
  messageId: 7,
  ...over,
})

/** A started bot over a temporary tree, ready for one test. */
const makeBot = (options = {}) => createBotHarness(options)

test('the usage report separates cheap cache from real money', async () => {
  const ctx = await makeBot()
  try {
    const day = new Date('2026-10-08T18:00:00Z')
    ctx.bot.now = () => day
    // The shape of a real journal record: mostly cached context, small output.
    await ctx.bot.journal.save({
      id: 'aaaaaa-1', chatId: '1', userId: '1', status: 'done', brief: 'кеды',
      createdAt: day.getTime(), steps: 12, tokens: { total: 515_870, uncachedInput: 13_353, cachedInput: 494_080, output: 8_437 }, usd: 0.00855,
    })
    await ctx.bot.journal.save({
      id: 'bbbbbb-2', chatId: '1', userId: '1', status: 'done', brief: 'пляж',
      createdAt: day.getTime() + 1000, steps: 7, tokens: { total: 155_839, uncachedInput: 7_194, cachedInput: 144_256, output: 4_389 }, usd: 0.00415,
    })

    const text = ctx.bot.usageText('1')
    assert.match(text, /Расход за сегодня/)
    assert.match(text, /кэш/)
    assert.match(text, /\$0\.01/, 'деньги показаны, а не только токены')
    assert.match(text, /Самые дорогие задачи сегодня/)
    assert.match(text, /aaaaaa-1/, 'самая дорогая задача названа')
    assert.ok(text.includes('50 раз дешевле'), 'объяснено, почему счётчик большой')
  } finally {
    await ctx.close()
  }
})

test('a task runs, the answer and the file go out, usage is recorded', async () => {
  const env = await makeBot()
  try {
    const calls = []
    env.bot.runner = {
      calls,
      async run(request) {
        calls.push(request)
        await fs.mkdir(path.join(env.ws, 'outbox'), { recursive: true })
        await fs.writeFile(path.join(env.ws, 'outbox', 'отчёт.docx'), 'документ')
        return okResult({ text: 'Готово: отчёт в outbox/отчёт.docx' })
      },
    }

    await env.bot.handleUpdate(message({ text: 'сделай отчёт по продажам' }))
    await env.bot.worker

    assert.equal(calls.length, 1)
    assert.match(calls[0].task, /сделай отчёт по продажам/)
    assert.equal(calls[0].sessionId, undefined, 'первая задача без сессии')
    assert.equal(env.platform.documents.length, 1)
    assert.match(env.platform.documents[0].caption, /отчёт\.docx/)
    assert.ok(env.platform.sent.some((entry) => /Готово/.test(entry.markdown)))
    assert.equal(env.usage.tokens(), 160)
    assert.equal(env.state.get('session:42'), 'session-stub-1')
    assert.ok(env.platform.edits.some((entry) => /выполнена/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('an unreadable photo is saved to the inbox, reported, and never echoed back', async () => {
  const env = await makeBot()
  try {
    env.platform.downloads.set('photo-1', { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), fileName: 'photo.png' })
    env.bot.runner = { calls: [], async run(request) { this.calls.push(request); return okResult() } }

    await env.bot.handleUpdate(message({ text: 'что тут?', attachments: [{ kind: 'photo', fileId: 'photo-1', mime: 'image/png' }] }))
    await env.bot.worker

    assert.equal(env.platform.documents.length, 0)
    assert.equal(env.platform.photos.length, 0)
    assert.ok(env.platform.sent.some((entry) => /не удалось прочитать изображение/.test(entry.markdown)))
    const inboxFiles = await fs.readdir(path.join(env.ws, 'inbox'))
    assert.equal(inboxFiles.length, 1)
  } finally {
    await env.close()
  }
})

test('a photo read by vision reaches the task as text and its tokens are billed', async () => {
  const vision = {
    enabled: true,
    maxImageBytes: 8_000_000,
    calls: [],
    async describe(request) {
      this.calls.push(request)
      return { text: 'На скриншоте счёт на 12 345 рублей.', usage: { prompt_tokens: 210, completion_tokens: 20, cached_tokens: 0 } }
    },
  }
  const env = await makeBot({ vision })
  try {
    env.platform.downloads.set('photo-1', { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), fileName: 'счёт.png' })
    const calls = []
    env.bot.runner = {
      async run(request) {
        calls.push(request)
        // 400 tokens for the task itself, on top of the vision call.
        return okResult({ usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 400, steps: 1, turns: 1 } })
      },
    }

    await env.bot.handleUpdate(message({ text: 'проверь счёт', attachments: [{ kind: 'photo', fileId: 'photo-1' }] }))
    await env.bot.worker

    assert.equal(vision.calls.length, 1)
    assert.match(calls[0].task, /На скриншоте счёт на 12 345 рублей/)
    assert.match(calls[0].task, /изображение распознано ниже/)
    assert.equal(env.usage.total().requests, 2, 'vision call and task run are both counted')
    assert.equal(env.usage.tokens(), 210 + 20 + 400)
    assert.equal(env.platform.sent.some((entry) => /не удалось прочитать изображение/.test(entry.markdown)), false)
  } finally {
    await env.close()
  }
})

test('another user gets the refusal and no task is started', async () => {
  const env = await makeBot()
  try {
    let runs = 0
    env.bot.runner = { async run() { runs += 1; return okResult() } }
    await env.bot.handleUpdate(message({ from: { id: 777, isBot: false }, text: 'привет' }))
    assert.equal(runs, 0)
    assert.match(env.platform.sent[0].markdown, /Доступ закрыт.*777/)
  } finally {
    await env.close()
  }
})

test('the daily budget stops new tasks before anything is spent', async () => {
  const env = await makeBot()
  try {
    env.usage.record({ usage: { prompt_tokens: 2_000_000, completion_tokens: 1 }, userId: '42', chatId: 42 })
    let runs = 0
    env.bot.runner = { async run() { runs += 1; return okResult() } }
    await env.bot.handleUpdate(message({ text: 'ещё задача' }))
    assert.equal(runs, 0)
    // The chat gets the refusal, the owner gets a short alert.
    assert.ok(env.platform.sent.some((entry) => /лимит токенов исчерпан/i.test(entry.markdown)))
    assert.ok(env.platform.sent.some((entry) => /не запущена/i.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('session continuity: the stored session id is resumed', async () => {
  const env = await makeBot()
  try {
    env.state.set('session:42', 'session-persisted')
    const calls = []
    env.bot.runner = { async run(request) { calls.push(request); return okResult() } }
    await env.bot.handleUpdate(message({ text: 'продолжи' }))
    await env.bot.worker
    assert.equal(calls[0].sessionId, 'session-persisted')
  } finally {
    await env.close()
  }
})

test('/new forgets the session', async () => {
  const env = await makeBot()
  try {
    env.state.set('session:42', 'session-persisted')
    await env.bot.handleUpdate(message({ text: '/new' }))
    assert.equal(env.state.get('session:42'), undefined)
    assert.match(env.platform.sent.at(-1).markdown, /Контекст сброшен/)
  } finally {
    await env.close()
  }
})

test('/status reports the running task and the spend', async () => {
  const env = await makeBot()
  try {
    env.usage.record({ usage: { prompt_tokens: 5000, completion_tokens: 100 }, userId: '42', chatId: 42 })
    env.bot.running = { id: 'task-1', chatId: 42, startedAt: Date.now() - 60_000, steps: 4, controller: new AbortController() }
    await env.bot.handleUpdate(message({ text: '/status' }))
    const answer = env.platform.sent.at(-1).markdown
    assert.match(answer, /task-1/)
    assert.match(answer, /5\s?100|5100/)
    env.bot.running = undefined
  } finally {
    await env.close()
  }
})

test('/cancel aborts the running task and the answer says so', async () => {
  const env = await makeBot()
  try {
    env.bot.runner = {
      async run({ signal }) {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(okResult({ ok: false, aborted: true, text: '' })), { once: true })
        })
      },
    }
    await env.bot.handleUpdate(message({ text: 'долгая задача' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await env.bot.handleUpdate(message({ text: '/cancel' }))
    await env.bot.worker
    assert.ok(env.platform.sent.some((entry) => /Останавливаю задачу/.test(entry.markdown)))
    assert.ok(env.platform.sent.some((entry) => /Задача отменена/.test(entry.markdown)))
    assert.equal(env.bot.running, undefined)
  } finally {
    await env.close()
  }
})

test('a second task waits in the queue and the fourth is refused', async () => {
  const env = await makeBot()
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    env.bot.runner = {
      async run({ signal }) {
        await Promise.race([gate, new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))])
        return okResult()
      },
    }
    await env.bot.handleUpdate(message({ text: 'задача 1' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await env.bot.handleUpdate(message({ text: 'задача 2' }))
    await env.bot.handleUpdate(message({ text: 'задача 3' }))
    await env.bot.handleUpdate(message({ text: 'задача 4' }))
    await env.bot.handleUpdate(message({ text: 'задача 5' }))
    assert.ok(env.platform.sent.some((entry) => /в очереди \(позиция/.test(entry.markdown)))
    assert.ok(env.platform.sent.some((entry) => /Очередь заполнена/.test(entry.markdown)))
    release()
    await env.bot.worker
  } finally {
    await env.close()
  }
})

test('files beyond the limit are reported, not silently dropped', async () => {
  const env = await makeBot({ configEnv: { MAX_OUTPUT_FILES: '1' } })
  try {
    env.bot.runner = {
      async run() {
        await fs.writeFile(path.join(env.ws, 'a.txt'), 'a')
        await new Promise((resolve) => setTimeout(resolve, 10))
        await fs.writeFile(path.join(env.ws, 'b.txt'), 'b')
        return okResult()
      },
    }
    await env.bot.handleUpdate(message({ text: 'сделай два файла' }))
    await env.bot.worker
    assert.equal(env.platform.documents.length, 1)
    assert.ok(env.platform.sent.some((entry) => /остались файлы сверх лимита/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('a failed run is reported with its diagnostics', async () => {
  const env = await makeBot()
  try {
    env.bot.runner = {
      async run() {
        return okResult({ ok: false, exitCode: 1, text: '', stderr: 'dsh: MODEL_ERROR: нет связи' })
      },
    }
    await env.bot.handleUpdate(message({ text: 'сломайся' }))
    await env.bot.worker
    const answer = env.platform.sent.map((entry) => entry.markdown).join('\n')
    assert.match(answer, /кодом 1/)
    assert.match(answer, /MODEL_ERROR/)
  } finally {
    await env.close()
  }
})
