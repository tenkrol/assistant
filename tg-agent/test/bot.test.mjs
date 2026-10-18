import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChatModel } from '../src/model.mjs'
import { HistoryStore } from '../src/history.mjs'
import { Assistant } from '../src/bot.mjs'
import { createTelegramPlatform } from '../src/platforms/telegram.mjs'
import { loadConfig } from '../src/config.mjs'
import { ReminderStore } from '../src/reminders.mjs'
import { createReminderTool } from '../src/reminder-tool.mjs'
import { ProfileStore } from '../src/profiles.mjs'
import { createProfileTool } from '../src/profile-tool.mjs'
import { PollStore, createPollTool } from '../src/polls.mjs'
import { UsageStore } from '../src/usage.mjs'
import { callbackUpdate, createModelStub, createTelegramStub, testEnv, textUpdate, waitFor } from './helpers.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const ALLOWED = 777

async function setup({ updates = [], responses, overrides = {}, delayMs = 0, withReminders = true, withProfiles = true, withPolls = false, webTools, media, tts, beforeStart } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-agent-'))
  const telegramStub = await createTelegramStub({ updates })
  const modelStub = await createModelStub({ ...(responses ? { responses } : {}), delayMs })
  // Streaming is off unless a test asks for it: the tests assert the final text.
  const config = loadConfig(testEnv({ telegramApiBase: telegramStub.apiBase, modelBaseUrl: modelStub.baseUrl, dataDir: dir, overrides: { STREAM: 'false', ...overrides } }))
  const history = new HistoryStore({ file: path.join(dir, 'history.json'), limit: config.history.limit, logger: silentLogger, saveDelayMs: 5 })
  await history.load()
  const platform = createTelegramPlatform({ token: config.telegram.token, apiBase: config.telegram.apiBase, logger: silentLogger })
  const model = new ChatModel({ baseUrl: modelStub.baseUrl, apiKey: 'sk-test', name: config.model.name, logger: silentLogger, sleep: async () => {} })
  let reminders
  if (withReminders) {
    const store = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger })
    await store.load()
    reminders = { store, tool: createReminderTool({ store, timeZone: config.time.timeZone, logger: silentLogger }) }
  }
  let profiles
  if (withProfiles) {
    const store = new ProfileStore({ file: path.join(dir, 'users.json'), logger: silentLogger })
    await store.load()
    profiles = { store, tool: createProfileTool({ store, logger: silentLogger }) }
  }
  let polls
  if (withPolls) {
    const store = new PollStore({ file: path.join(dir, 'polls.json'), logger: silentLogger })
    await store.load()
    polls = { store, tool: createPollTool({ store }) }
  }
  const usage = new UsageStore({ file: path.join(dir, 'usage.json'), logger: silentLogger, dailyLimit: config.usage.dailyLimit })
  await usage.load()
  const bot = new Assistant({ config, platform, model, history, webTools, reminders, profiles, usage, media, tts, polls, logger: silentLogger })
  if (beforeStart) await beforeStart({ dir, bot, config })
  await bot.start()
  return {
    dir,
    telegramStub,
    modelStub,
    config,
    history,
    bot,
    reminders,
    profiles,
    polls,
    usage,
    async cleanup() {
      await bot.stop()
      await telegramStub.close()
      await modelStub.close()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

const historyFile = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8'))

test('answers an allowed private chat and persists the turn', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })] })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the reply' })
    assert.equal(sent.chat_id, 555)
    assert.equal(sent.text, 'ответ модели')
    assert.equal(sent.parse_mode, 'HTML')

    const request = ctx.modelStub.state.requests[0]
    assert.equal(request.payload.messages[0].role, 'system')
    assert.deepEqual(request.payload.messages.at(-1), { role: 'user', content: 'привет' })

    await waitFor(async () => {
      try {
        const file = await historyFile(ctx.dir)
        return file.chats['555']?.messages?.length === 2
      } catch {
        return false
      }
    }, { what: 'the history file' })
    const file = await historyFile(ctx.dir)
    assert.equal(file.chats['555'].messages[1].role, 'assistant')
  } finally {
    await ctx.cleanup()
  }
})

test('rejects a stranger and tells them their id', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 1, userId: 999 })] })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the denial' })
    assert.match(sent.text, /999/)
    assert.equal(ctx.modelStub.state.requests.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('accepts anyone when ALLOW_ALL_USERS is set', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 1, userId: 4242 })], overrides: { ALLOWED_USER_IDS: '', ALLOW_ALL_USERS: 'true' } })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the reply' })
    assert.equal(sent.text, 'ответ модели')
  } finally {
    await ctx.cleanup()
  }
})

test('/whoami reports the ids without calling the model', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: '/whoami', updateId: 1, userId: ALLOWED, chatId: 555 })] })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the reply' })
    assert.match(sent.text, /<b>user id:<\/b> <code>777<\/code>/)
    assert.match(sent.text, /<b>chat id:<\/b> <code>555<\/code>/)
    assert.equal(ctx.modelStub.state.requests.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('the contact book is read from disk at startup', async () => {
  // Регрессия: справочник читался только при первом изменении, поэтому sendto
  // после рестарта не видел людей, сохранённых прошлым запуском.
  const ctx = await setup({
    updates: [],
    beforeStart: async ({ dir }) => {
      await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify({
        version: 1,
        contacts: [{ chatId: 123, name: 'Мария', username: 'maria', phone: '9991234567' }],
      }))
    },
  })
  try {
    assert.equal(ctx.bot.contacts.byPhone('+7 999 123-45-67')?.chatId, 123)
    assert.equal(ctx.bot.contacts.byUsername('@maria')?.name, 'Мария')
    assert.equal(ctx.bot.contacts.search('Мари')[0]?.chatId, 123)
  } finally {
    await ctx.cleanup()
  }
})

test('/new clears the conversation and confirms', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED }), textUpdate({ text: '/new', updateId: 2, userId: ALLOWED })] })
  try {
    await waitFor(() => ctx.telegramStub.state.sends.length >= 2, { what: 'both replies' })
    assert.match(ctx.telegramStub.state.sends[1].text, /Контекст диалога очищен/)
    assert.deepEqual(ctx.history.messages('555'), [])
  } finally {
    await ctx.cleanup()
  }
})

test('ignores a group message that does not address the bot, and answers one that does', async () => {
  const mention = (text) => [{ type: 'mention', offset: 0, length: '@test_bot'.length }]
  const ctx = await setup({
    updates: [
      textUpdate({ text: 'просто болтаю', updateId: 1, userId: ALLOWED, chatId: -100, chatType: 'group' }),
      textUpdate({ text: '@test_bot как дела?', updateId: 2, userId: ALLOWED, chatId: -100, chatType: 'group', entities: mention() }),
    ],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the group reply' })
    assert.equal(ctx.telegramStub.state.sends.length, 1)
    // In a group every message is attributed to its author.
    assert.deepEqual(ctx.modelStub.state.requests[0].payload.messages.at(-1), { role: 'user', content: 'User: как дела?' })
    assert.equal(sent.chat_id, -100)
  } finally {
    await ctx.cleanup()
  }
})

test('answers when the user replies to a message from the bot', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'а подробнее?', updateId: 1, userId: ALLOWED, chatId: -100, chatType: 'group', replyFromId: 42 })],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the reply' })
    assert.equal(ctx.modelStub.state.requests[0].payload.messages.at(-1).content, 'User: а подробнее?')
  } finally {
    await ctx.cleanup()
  }
})

test('splits a long answer into Telegram-sized messages', async () => {
  const long = 'абв '.repeat(3000)
  const ctx = await setup({ updates: [textUpdate({ text: 'расскажи', updateId: 1, userId: ALLOWED })], responses: [{ content: long }] })
  try {
    await waitFor(() => ctx.telegramStub.state.sends.length >= 2, { what: 'the split reply' })
    for (const sent of ctx.telegramStub.state.sends) assert.ok(sent.text.length <= 4096, `length ${sent.text.length}`)
    assert.ok(ctx.telegramStub.state.sends.map((s) => s.text).join('').includes('абв'))
  } finally {
    await ctx.cleanup()
  }
})

test('falls back to plain text when Telegram rejects the HTML entities', async () => {
  let sendAttempts = 0
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-agent-'))
  const telegramStub = await createTelegramStub({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    script: (method, payload) => {
      if (method !== 'sendMessage') return undefined
      sendAttempts++
      if (payload.parse_mode === 'HTML') return { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }
      return undefined
    },
  })
  const modelStub = await createModelStub({ responses: [{ content: '**ответ**' }] })
  const config = loadConfig(testEnv({ telegramApiBase: telegramStub.apiBase, modelBaseUrl: modelStub.baseUrl, dataDir: dir }))
  const history = new HistoryStore({ file: path.join(dir, 'history.json'), limit: config.history.limit, logger: silentLogger, saveDelayMs: 5 })
  const platform = createTelegramPlatform({ token: config.telegram.token, apiBase: config.telegram.apiBase, logger: silentLogger })
  const model = new ChatModel({ baseUrl: modelStub.baseUrl, apiKey: 'sk-test', name: config.model.name, logger: silentLogger })
  const bot = new Assistant({ config, platform, model, history, logger: silentLogger })
  try {
    await bot.start()
    const sent = await waitFor(() => telegramStub.state.sends[0], { what: 'the plain-text retry' })
    assert.equal(sent.text, 'ответ')
    assert.equal(sent.parse_mode, undefined)
    assert.equal(sendAttempts, 2)
  } finally {
    await bot.stop()
    await telegramStub.close()
    await modelStub.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('/model switches the model for that chat only', async () => {
  const ctx = await setup({
    updates: [
      textUpdate({ text: '/model deepseek-reasoner', updateId: 1, userId: ALLOWED }),
      textUpdate({ text: 'вопрос', updateId: 2, userId: ALLOWED }),
    ],
    responses: [{ content: 'ок' }],
  })
  try {
    await waitFor(() => ctx.modelStub.state.requests.length >= 1, { what: 'the completion' })
    assert.equal(ctx.modelStub.state.requests[0].payload.model, 'deepseek-reasoner')
    await waitFor(() => ctx.telegramStub.state.sends.length >= 2, { what: 'both replies' })
    assert.match(ctx.telegramStub.state.sends[0].text, /deepseek-reasoner/)
  } finally {
    await ctx.cleanup()
  }
})

test('reports a model failure to the user instead of staying silent', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ status: 401, message: 'bad key' }],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the error reply' })
    assert.match(sent.text, /Не удалось получить ответ/)
    assert.match(sent.text, /API key/)
    assert.deepEqual(ctx.history.messages('555'), [])
  } finally {
    await ctx.cleanup()
  }
})

test('keeps the history window bounded and starting with a user message', async () => {
  const updates = Array.from({ length: 5 }, (_, i) => textUpdate({ text: `вопрос ${i}`, updateId: i + 1, userId: ALLOWED }))
  const ctx = await setup({ updates, overrides: { HISTORY_LIMIT: '4' } })
  try {
    await waitFor(() => ctx.modelStub.state.requests.length >= 5, { what: 'five turns' })
    await waitFor(() => ctx.history.messages('555').length > 0, { what: 'history' })
    const messages = ctx.history.messages('555')
    assert.ok(messages.length <= 4, `history length ${messages.length}`)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages.at(-1).content, 'ответ модели')
    const sent = ctx.modelStub.state.requests.at(-1).payload.messages
    assert.equal(sent[0].role, 'system')
    assert.match(sent[1].content, /^Сейчас: /, 'the turn carries the current date and time')
    const firstNonSystem = sent.find((message) => message.role !== 'system')
    assert.equal(firstNonSystem.role, 'user', 'the history window is sent starting at a user message')
    assert.equal(sent.at(-1).role, 'user')
  } finally {
    await ctx.cleanup()
  }
})

test('records the polling offset so a restart does not replay updates', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 5, userId: ALLOWED })] })
  try {
    await waitFor(async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(ctx.dir, 'offset.json'), 'utf8'))
        return parsed.offset === 6
      } catch {
        return false
      }
    }, { what: 'the offset file' })
  } finally {
    await ctx.cleanup()
  }
})

// Regression: a stranger in a group used to get a denial reply, publishing
// their Telegram id to the whole chat even though the message was not addressed
// to the bot.
test('stays silent for a stranger in a group', async () => {
  const update = textUpdate({ text: 'я тут', updateId: 1, userId: 999, chatId: -100, chatType: 'group' })
  const ctx = await setup({ updates: [] })
  try {
    await ctx.bot.handleMessage(update.message)
    assert.equal(ctx.telegramStub.state.sends.length, 0)
    assert.equal(ctx.modelStub.state.requests.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('answers a stranger in a private chat with their id', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 1, userId: 999 })] })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the denial' })
    assert.match(ctx.telegramStub.state.sends[0].text, /999/)
  } finally {
    await ctx.cleanup()
  }
})

// Regression: an empty completion produced no reply at all and stored an empty
// assistant turn.
test('answers an empty completion with a notice and keeps history clean', async () => {
  const ctx = await setup({ updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })], responses: [{ content: '   ' }] })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the notice' })
    assert.match(sent.text, /пустой ответ/)
    const messages = ctx.history.messages('555')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
  } finally {
    await ctx.cleanup()
  }
})

// Regression: SIGTERM used to wait for the model timeout (up to minutes) while
// the supervisor kills the process after ~10 seconds.
test('stop aborts an in-flight model call quickly', { timeout: 20000 }, async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'долгий вопрос', updateId: 1, userId: ALLOWED })],
    delayMs: 30000,
    overrides: { SHUTDOWN_GRACE_MS: '5000', MODEL_TIMEOUT_MS: '600000' },
  })
  try {
    await waitFor(() => ctx.modelStub.state.requests.length >= 1, { what: 'the hanging request' })
    const started = Date.now()
    await ctx.bot.stop()
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `stop took ${elapsed} ms`)
    assert.equal(ctx.bot.running, false)
    // State still reaches the disk, so the offset does not replay the update.
    const offset = JSON.parse(await fs.readFile(path.join(ctx.dir, 'offset.json'), 'utf8'))
    assert.equal(offset.offset, 2)
  } finally {
    await ctx.cleanup()
  }
})

// Regression: the per-chat promise chains were never released.
test('releases per-chat chains once their work settles', async () => {
  const updates = Array.from({ length: 5 }, (_, i) => textUpdate({ text: `вопрос ${i}`, updateId: i + 1, userId: ALLOWED, chatId: 1000 + i }))
  const ctx = await setup({ updates })
  try {
    await waitFor(() => ctx.telegramStub.state.sends.length >= 5, { what: 'five replies' })
    await waitFor(() => ctx.bot.chains.size === 0, { what: 'the chains map to drain' })
    assert.equal(ctx.bot.inFlight.size, 0)
  } finally {
    await ctx.cleanup()
  }
})

// Regression: the plain-text fallback sent `&lt;` literally.
test('unescapes entities when falling back to plain text', async () => {
  let attempts = 0
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-agent-'))
  const telegramStub = await createTelegramStub({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    script: (method, payload) => {
      if (method !== 'sendMessage') return undefined
      attempts++
      if (payload.parse_mode === 'HTML') return { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }
      return undefined
    },
  })
  const modelStub = await createModelStub({ responses: [{ content: 'если a < b и c > d' }] })
  const config = loadConfig(testEnv({ telegramApiBase: telegramStub.apiBase, modelBaseUrl: modelStub.baseUrl, dataDir: dir }))
  const history = new HistoryStore({ file: path.join(dir, 'history.json'), limit: config.history.limit, logger: silentLogger, saveDelayMs: 5 })
  const platform = createTelegramPlatform({ token: config.telegram.token, apiBase: config.telegram.apiBase, logger: silentLogger })
  const model = new ChatModel({ baseUrl: modelStub.baseUrl, apiKey: 'sk-test', name: config.model.name, logger: silentLogger })
  const bot = new Assistant({ config, platform, model, history, logger: silentLogger })
  try {
    await bot.start()
    const sent = await waitFor(() => telegramStub.state.sends[0], { what: 'the plain-text retry' })
    assert.equal(sent.text, 'если a < b и c > d')
    assert.equal(attempts, 2)
  } finally {
    await bot.stop()
    await telegramStub.close()
    await modelStub.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// Regression: the model once answered "Готово: напомню в 01:23" without calling
// the tool, so nothing was scheduled and the user was told otherwise.
test('forces the remind tool when the model only answers in words', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'Напомни мне через минуту отспать', updateId: 1, userId: ALLOWED })],
    responses: [
      { content: 'Готово: напомню в 01:23 (Europe/Moscow) — «Отспать».' },
      { toolCalls: [{ id: 'call_1', name: 'remind', arguments: { text: 'Отспать', in_minutes: 1 } }] },
      { content: 'Готово.' },
    ],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the confirmation' })
    // The reminder really exists now, and its own text is what the user sees.
    const [reminder] = ctx.reminders.store.list(555)
    assert.ok(reminder, 'a reminder must be stored after the forced call')
    assert.equal(reminder.text, 'Отспать')
    assert.match(sent.text, /создано/)
    assert.match(sent.text, /Отспать/)
    // The first request chose freely; the retry pinned the tool.
    const requests = ctx.modelStub.state.requests
    assert.equal(requests[0].payload.tool_choice, undefined)
    assert.deepEqual(requests[1].payload.tool_choice, { type: 'function', function: { name: 'remind' } })
    const names = requests[0].payload.tools.map((tool) => tool.function.name)
    assert.ok(names.includes('remind'), `remind must be offered: ${names.join(',')}`)
  } finally {
    await ctx.cleanup()
  }
})

test('does not force a tool for an ordinary message', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'Расскажи про антиматерию', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Антиматерия — это…' }],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.match(sent.text, /Антиматерия/)
    assert.equal(ctx.reminders.store.list(555).length, 0)
    assert.equal(ctx.modelStub.state.requests.length, 1, 'no retry for a normal question')
    assert.equal(ctx.modelStub.state.requests[0].payload.tool_choice, undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('tells the user the truth when the forced remind still does not run', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'напомни через час позвонить', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Хорошо, напомню в 02:22.' }, { content: 'ок' }],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.match(sent.text, /Не удалось поставить напоминание/)
    assert.equal(ctx.reminders.store.list(555).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('attaches cancel and snooze buttons to a new reminder', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'напомни через 10 минут про чайник', updateId: 1, userId: ALLOWED })],
    responses: [
      { toolCalls: [{ id: 'call_1', name: 'remind', arguments: { text: 'про чайник', in_minutes: 10 } }] },
      { content: 'Готово.' },
    ],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the confirmation' })
    const [reminder] = ctx.reminders.store.list(555)
    assert.ok(reminder, 'the reminder must exist')
    const rows = sent.reply_markup?.inline_keyboard
    assert.ok(Array.isArray(rows), 'an inline keyboard must be attached')
    assert.deepEqual(rows.flat().map((button) => button.callback_data), [`snooze:10:${reminder.id}`, `cancel:${reminder.id}`])
    assert.match(rows.flat()[1].text, /Отменить/)
  } finally {
    await ctx.cleanup()
  }
})

test('a tap on «Отменить» drops the reminder and rewrites the message', async () => {
  const ctx = await setup({ updates: [] })
  try {
    const reminder = ctx.reminders.store.add({ chatId: 555, text: 'про чайник', dueAt: new Date(Date.now() + 600_000) })
    await ctx.reminders.store.flush()
    ctx.telegramStub.push(callbackUpdate({ data: `cancel:${reminder.id}`, text: '⏰ Напоминание: про чайник' }))
    const answer = await waitFor(() => ctx.telegramStub.state.answers[0], { what: 'the toast' })
    assert.match(answer.text, /отменено/)
    assert.equal(ctx.reminders.store.list(555).length, 0)
    const edit = await waitFor(() => ctx.telegramStub.state.edits[0], { what: 'the edited message' })
    assert.match(edit.text, /Отменено/)
    assert.match(edit.text, /про чайник/, 'the original text must be kept')
    // The change survives a restart.
    const reloaded = new ProfileStore({ file: path.join(ctx.dir, 'users.json'), logger: silentLogger })
    await reloaded.load()
    const reread = new ReminderStore({ file: path.join(ctx.dir, 'reminders.json'), logger: silentLogger })
    await reread.load()
    assert.equal(reread.list(555).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('a tap on «Отложить» moves the reminder into the future', async () => {
  const ctx = await setup({ updates: [] })
  try {
    const reminder = ctx.reminders.store.add({ chatId: 555, text: 'про чайник', dueAt: new Date(Date.now() - 60_000) })
    ctx.telegramStub.push(callbackUpdate({ data: `snooze:10:${reminder.id}` }))
    const answer = await waitFor(() => ctx.telegramStub.state.answers[0], { what: 'the toast' })
    assert.match(answer.text, /Отложено/)
    const list = ctx.reminders.store.list(555)
    assert.equal(list.length, 1, 'exactly one reminder must remain')
    assert.notEqual(list[0].id, reminder.id, 'postponing creates a fresh reminder')
    assert.equal(list[0].text, 'про чайник')
    assert.ok(Date.parse(list[0].dueAt) - Date.now() > 9 * 60_000, 'due in about ten minutes')
  } finally {
    await ctx.cleanup()
  }
})

test('a poll button vote is counted once and a repeated tap moves the voice', async () => {
  const ctx = await setup({ updates: [], withPolls: true })
  try {
    const poll = ctx.polls.store.add({ chatId: 555, userId: ALLOWED, question: 'Куда едем?', options: ['Лес', 'Река'] })
    const update = (optionIndex, updateId) => callbackUpdate({
      data: `poll:${poll.id}:${optionIndex}`,
      updateId,
      messageId: 42,
      text: '📊 Опрос «Куда едем?»',
    })

    ctx.telegramStub.push(update(0, 1))
    const first = await waitFor(() => ctx.telegramStub.state.answers[0], { what: 'the first toast' })
    assert.equal(first.text, 'Голос учтён')
    assert.deepEqual(ctx.polls.store.get(poll.id).options.map((option) => option.votes), [[ALLOWED], []])
    const edit = await waitFor(() => ctx.telegramStub.state.edits[0], { what: 'the poll message' })
    assert.match(edit.text, /Лес/)

    // Второй голос не добавляет второй записи, а переносит голос.
    ctx.telegramStub.push(update(1, 2))
    const second = await waitFor(() => ctx.telegramStub.state.answers[1], { what: 'the moved vote' })
    assert.equal(second.text, 'Голос учтён')
    assert.deepEqual(ctx.polls.store.get(poll.id).options.map((option) => option.votes), [[], [ALLOWED]])

    // Закрытый опрос голосов не принимает.
    ctx.polls.store.close(poll.id)
    ctx.telegramStub.push(update(0, 3))
    const closed = await waitFor(() => ctx.telegramStub.state.answers[2], { what: 'the closed toast' })
    assert.equal(closed.text, 'Опрос уже закрыт')
    assert.deepEqual(ctx.polls.store.get(poll.id).options.map((option) => option.votes), [[], [ALLOWED]])
  } finally {
    await ctx.cleanup()
  }
})

test('a tap from a stranger changes nothing', async () => {
  const ctx = await setup({ updates: [] })
  try {
    const reminder = ctx.reminders.store.add({ chatId: 555, text: 'про чайник', dueAt: new Date(Date.now() + 600_000) })
    ctx.telegramStub.push(callbackUpdate({ userId: 999, data: `cancel:${reminder.id}` }))
    const answer = await waitFor(() => ctx.telegramStub.state.answers[0], { what: 'the refusal' })
    assert.match(answer.text, /Нет доступа/)
    assert.equal(answer.show_alert, true)
    assert.equal(ctx.reminders.store.list(555).length, 1, 'the reminder must survive')
  } finally {
    await ctx.cleanup()
  }
})

test('the model can remember a fact and a city for the user', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'запомни: меня зовут Андрей, я живу в Москве', updateId: 1, userId: ALLOWED })],
    responses: [
      { toolCalls: [{ id: 'call_1', name: 'remember', arguments: { text: 'его зовут Андрей', city: 'Москва' } }] },
      { content: 'Запомнил.' },
    ],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    // Auto-memory may add its own facts for the same message, so check the content.
    assert.ok(ctx.profiles.store.facts(ALLOWED).some((fact) => fact.text.includes('Андрей')))
    assert.equal(ctx.profiles.store.city(ALLOWED), 'Москва')
    // Everything is on disk, not just in memory.
    const reread = new ProfileStore({ file: path.join(ctx.dir, 'users.json'), logger: silentLogger })
    await reread.load()
    assert.equal(reread.city(ALLOWED), 'Москва')
  } finally {
    await ctx.cleanup()
  }
})

test('known facts reach the model on the next turn', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'как меня зовут?', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Вас зовут Андрей.' }],
  })
  try {
    ctx.profiles.store.addFact(ALLOWED, 'его зовут Андрей')
    ctx.profiles.store.setCity(ALLOWED, 'Москва')
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    const request = ctx.modelStub.state.requests[0].payload
    const systemTexts = request.messages.filter((m) => m.role === 'system').map((m) => m.content)
    const known = systemTexts.find((text) => text.includes('Андрей'))
    assert.ok(known, `a system message must carry the facts: ${JSON.stringify(systemTexts)}`)
    assert.match(known, /Москва/)
    assert.match(known, /№1/)
    // The tool is offered to the model, otherwise it could never remember anything.
    assert.ok(request.tools.some((tool) => tool.function.name === 'remember'))
  } finally {
    await ctx.cleanup()
  }
})

test('weather without a city uses the saved default', async () => {
  const calls = []
  const webTools = {
    definitions: [{ type: 'function', function: { name: 'weather', description: 'погода', parameters: { type: 'object', properties: {} } } }],
    async execute(name, args) {
      calls.push({ name, args })
      return 'Москва: +9 °C'
    },
  }
  const ctx = await setup({
    updates: [],
    webTools,
    responses: [
      { toolCalls: [{ id: 'call_1', name: 'weather', arguments: {} }] },
      { content: 'В Москве +9.' },
    ],
  })
  try {
    ctx.profiles.store.setCity(ALLOWED, 'Москва')
    ctx.telegramStub.push(textUpdate({ text: 'какая погода?', updateId: 1, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { name: 'weather', args: { city: 'Москва' } })
  } finally {
    await ctx.cleanup()
  }
})

test('/city, /memory and /forget manage what the bot knows', async () => {
  const ctx = await setup({ updates: [], responses: [{ content: 'не используется' }] })
  try {
    const command = (text, updateId) => ctx.telegramStub.push(textUpdate({ text, updateId, userId: ALLOWED }))
    command('/city Казань', 1)
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the city confirmation' })
    assert.equal(ctx.profiles.store.city(ALLOWED), 'Казань')
    assert.match(ctx.telegramStub.state.sends[0].text, /Казань/)

    ctx.profiles.store.addFact(ALLOWED, 'его зовут Андрей')
    command('/memory', 2)
    const memory = await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'the memory list' })
    assert.match(memory.text, /Казань/)
    assert.match(memory.text, /Андрей/)

    command('/forget 1', 3)
    const forgotten = await waitFor(() => ctx.telegramStub.state.sends[2], { what: 'the forget confirmation' })
    assert.match(forgotten.text, /Забыл/)
    assert.equal(ctx.profiles.store.facts(ALLOWED).length, 0)
    assert.equal(ctx.profiles.store.city(ALLOWED), 'Казань', 'the city is not a fact')

    command('/city нет', 4)
    await waitFor(() => ctx.telegramStub.state.sends[3], { what: 'the city removal' })
    assert.equal(ctx.profiles.store.city(ALLOWED), undefined)
    // No model call was made for any of these commands.
    assert.equal(ctx.modelStub.state.requests.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('postponing a repeating reminder keeps its repeat', async () => {
  const ctx = await setup({ updates: [] })
  try {
    const reminder = ctx.reminders.store.add({ chatId: 555, text: 'зарядка', dueAt: new Date(Date.now() - 60_000), repeat: 'daily' })
    ctx.telegramStub.push(callbackUpdate({ data: `snooze:10:${reminder.id}` }))
    const answer = await waitFor(() => ctx.telegramStub.state.answers[0], { what: 'the toast' })
    assert.match(answer.text, /Отложено/)
    const [moved] = ctx.reminders.store.list(555)
    assert.equal(moved.repeat, 'daily', 'the repeat must survive postponing')
    assert.notEqual(moved.id, reminder.id)
    const edit = await waitFor(() => ctx.telegramStub.state.edits[0], { what: 'the edited message' })
    assert.match(edit.text, /каждый день/)
  } finally {
    await ctx.cleanup()
  }
})

// Regression: "мой город — Казань" used to be answered with "Записал!" while the
// profile stayed untouched, so the city never stuck.
test('forces remember when a city is stated in words', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'мой город — Казань', updateId: 1, userId: ALLOWED })],
    responses: [
      { content: 'Записал: ваш город — Казань.' },
      { toolCalls: [{ id: 'call_1', name: 'remember', arguments: { text: 'живёт в Казани', city: 'Казань' } }] },
      { content: 'ок' },
    ],
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the confirmation' })
    assert.equal(ctx.profiles.store.city(ALLOWED), 'Казань', 'the city must be stored')
    assert.ok(ctx.profiles.store.facts(ALLOWED).some((fact) => /Казан/.test(fact.text)))
    assert.match(sent.text, /Запомнил|Уже помню/)
    const requests = ctx.modelStub.state.requests
    assert.equal(requests[0].payload.tool_choice, undefined)
    assert.deepEqual(requests[1].payload.tool_choice, { type: 'function', function: { name: 'remember' } })
  } finally {
    await ctx.cleanup()
  }
})

test('questions about the profile do not create facts', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'какой мой город?', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Вы пока не говорили, в каком городе живёте.' }],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.equal(ctx.profiles.store.facts(ALLOWED).length, 0)
    assert.equal(ctx.profiles.store.city(ALLOWED), undefined)
    assert.equal(ctx.modelStub.state.requests.length, 1, 'a question must not be forced into remember')
  } finally {
    await ctx.cleanup()
  }
})

// Groups get names only: a personal fact must never reach a conversation with
// other people, and the model must still know who it is talking to.
test('a group gets participant names but no personal facts', async () => {
  const mention = [{ type: 'mention', offset: 0, length: '@test_bot'.length }]
  const ctx = await setup({
    updates: [
      textUpdate({ text: '@test_bot привет, я Вячеслав', updateId: 1, userId: ALLOWED, firstName: 'Вячеслав', chatId: -100, chatType: 'group', entities: mention }),
      textUpdate({ text: '@test_bot а какой у меня город?', updateId: 2, userId: ALLOWED, firstName: 'Вячеслав', chatId: -100, chatType: 'group', entities: mention }),
    ],
  })
  try {
    ctx.profiles.store.setCity(ALLOWED, 'Москва')
    ctx.profiles.store.addFact(ALLOWED, 'его зовут Вячеслав')
    await waitFor(() => ctx.telegramStub.state.sends.length >= 2, { what: 'both group answers' })
    const request = ctx.modelStub.state.requests.at(-1).payload
    const joined = request.messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
    assert.match(joined, /Сейчас пишет Вячеслав|Участники этого чата/, 'the group must know who is speaking')
    assert.ok(!joined.includes('Москва'), `the city must not reach a group: ${joined}`)
    assert.ok(!joined.includes('город по умолчанию'), 'no personal summary in a group')
    assert.match(request.messages.at(-1).content, /Вячеслав/)
  } finally {
    await ctx.cleanup()
  }
})

test('a private chat still gets the full profile', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'какой у меня город?', updateId: 1, userId: ALLOWED, firstName: 'Вячеслав' })],
    responses: [{ content: 'Москва.' }],
  })
  try {
    ctx.profiles.store.setCity(ALLOWED, 'Москва')
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    const systems = ctx.modelStub.state.requests[0].payload.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
    assert.match(systems, /Москва/)
  } finally {
    await ctx.cleanup()
  }
})

test('reminders in one chat belong to the user who created them', async () => {
  const mention = [{ type: 'mention', offset: 0, length: '@test_bot'.length }]
  // In a group a command carries the bot name: `/reminders@test_bot`.
  const command = '/reminders@test_bot'
  const botCommand = [{ type: 'bot_command', offset: 0, length: command.length }]
  const OTHER = 888
  const ctx = await setup({
    updates: [
      textUpdate({ text: '@test_bot напомни через час забрать посылку', updateId: 1, userId: ALLOWED, firstName: 'Вячеслав', chatId: -100, chatType: 'group', entities: mention }),
      textUpdate({ text: command, updateId: 2, userId: OTHER, firstName: 'Мария', chatId: -100, chatType: 'group', entities: botCommand }),
    ],
    responses: [
      { toolCalls: [{ id: 'call_1', name: 'remind', arguments: { text: 'забрать посылку', in_minutes: 60 } }] },
      { content: 'Готово.' },
    ],
    overrides: { ALLOWED_USER_IDS: `${ALLOWED},${OTHER}` },
  })
  try {
    // The second user asks for the list: it must not contain the first reminder.
    const list = await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'the other user list' })
    assert.match(list.text, /Напоминаний нет/)
    const [reminder] = ctx.reminders.store.list(-100)
    assert.equal(reminder.userId, ALLOWED, 'the reminder records its owner')
    // And nobody can cancel somebody else's reminder by id.
    assert.equal(ctx.reminders.store.cancel(-100, reminder.id, OTHER), undefined)
    assert.equal(ctx.reminders.store.list(-100).length, 1)
    // A group reminder names its owner when it fires. This test is about
    // ownership, so the quiet-hours clock is pinned too — otherwise it fails at
    // night, when delivery is deliberately postponed.
    ctx.bot.quietHoursEnd = () => undefined
    await ctx.bot.deliverReminder(reminder)
    const fired = ctx.telegramStub.state.sends.at(-1)
    assert.match(fired.text, /Вячеслав/)
  } finally {
    await ctx.cleanup()
  }
})

// Regression: the cancel button passed the bot's own id instead of the tapper's,
// so a reminder with an owner could never be cancelled from the keyboard.
test('a tap on «Отменить» removes an owned reminder', async () => {
  const ctx = await setup({ updates: [] })
  try {
    const reminder = ctx.reminders.store.add({ chatId: 555, userId: ALLOWED, text: 'про чайник', dueAt: new Date(Date.now() + 600_000) })
    ctx.telegramStub.push(callbackUpdate({ data: `cancel:${reminder.id}`, userId: ALLOWED, text: '⏰ Напоминание: про чайник' }))
    const answer = await waitFor(() => ctx.telegramStub.state.answers[0], { what: 'the toast' })
    assert.match(answer.text, /отменено/)
    assert.equal(ctx.reminders.store.list(555).length, 0, 'the owned reminder must be gone')
  } finally {
    await ctx.cleanup()
  }
})

test('a group never uses the saved city for weather', async () => {
  const calls = []
  const webTools = {
    definitions: [{ type: 'function', function: { name: 'weather', description: 'погода', parameters: { type: 'object', properties: {} } } }],
    async execute(name, args) {
      calls.push({ name, args })
      return 'Москва: +9 °C'
    },
  }
  const mention = [{ type: 'mention', offset: 0, length: '@test_bot'.length }]
  const ctx = await setup({
    updates: [],
    webTools,
    responses: [
      { toolCalls: [{ id: 'call_1', name: 'weather', arguments: {} }] },
      { content: 'Уточните город.' },
    ],
  })
  try {
    ctx.profiles.store.setCity(ALLOWED, 'Москва')
    ctx.telegramStub.push(textUpdate({ text: '@test_bot какая погода?', updateId: 1, userId: ALLOWED, chatId: -100, chatType: 'group', entities: mention }))
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the group answer' })
    assert.equal(calls.length, 1)
    assert.ok(!calls[0].args.city, `the city must not be filled in a group: ${JSON.stringify(calls[0].args)}`)
  } finally {
    await ctx.cleanup()
  }
})

test('facts stated about the user are stored without the model', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'меня зовут Вячеслав, я живу в Москве', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Приятно познакомиться!' }],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    const facts = ctx.profiles.store.facts(ALLOWED).map((fact) => fact.text)
    assert.ok(facts.includes('его зовут Вячеслав'), JSON.stringify(facts))
    assert.ok(facts.includes('живёт в Москве'), JSON.stringify(facts))
    // The name is used to address the person, and the model was never asked to remember.
    assert.equal(ctx.profiles.store.displayName(ALLOWED), 'Вячеслав')
    assert.equal(ctx.modelStub.state.requests[0].payload.messages.at(-1).role, 'user')
  } finally {
    await ctx.cleanup()
  }
})

test('automatic extraction is off unless MEMORY_AUTO_EXTRACT is set', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'меня зовут Вячеслав, я живу в Москве', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Приятно познакомиться!' }],
    overrides: { MEMORY_AUTO_EXTRACT: 'false' },
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.equal(ctx.profiles.store.facts(ALLOWED).length, 0, 'факт не должен сохраняться автоматически')
    assert.equal(ctx.profiles.store.city(ALLOWED), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('questions are never stored as facts', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'как меня зовут?', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Вы не говорили.' }],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.equal(ctx.profiles.store.facts(ALLOWED).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('/mode sets the answer style for this user', async () => {
  const ctx = await setup({ updates: [], responses: [{ content: 'ок' }] })
  try {
    ctx.telegramStub.push(textUpdate({ text: '/mode кратко', updateId: 1, userId: ALLOWED }))
    const answer = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the confirmation' })
    assert.match(answer.text, /кратко/)
    assert.equal(ctx.profiles.store.mode(ALLOWED), 'кратко')
    // The next answer carries the mode hint to the model.
    ctx.telegramStub.push(textUpdate({ text: 'расскажи про Луну', updateId: 2, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'the answer' })
    const systems = ctx.modelStub.state.requests[0].payload.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
    assert.match(systems, /Режим ответа/)
    // And /mode сброс clears it.
    ctx.telegramStub.push(textUpdate({ text: '/mode сброс', updateId: 3, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[2], { what: 'the reset confirmation' })
    assert.equal(ctx.profiles.store.mode(ALLOWED), undefined)
  } finally {
    await ctx.cleanup()
  }
})

// Alerts must reach the owner through the platform, not through the model: the
// model is exactly what tends to be broken.
test('three model failures in a row alert the owner once', async () => {
  const ctx = await setup({
    updates: [
      textUpdate({ text: 'раз', updateId: 1, userId: ALLOWED }),
      textUpdate({ text: 'два', updateId: 2, userId: ALLOWED }),
      textUpdate({ text: 'три', updateId: 3, userId: ALLOWED }),
    ],
    responses: [{ status: 500, body: { error: { message: 'provider is down' } } }],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends.length >= 3, { what: 'the failure notices' })
    const alerts = ctx.telegramStub.state.sends.filter((send) => String(send.text).includes('🚨'))
    assert.equal(alerts.length, 1, 'exactly one alert for three failures')
    assert.match(alerts[0].text, /Модель не отвечает/)
  } finally {
    await ctx.cleanup()
  }
})

test('a single failure does not alert', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ status: 500, body: { error: { message: 'nope' } } }],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the failure notice' })
    assert.equal(ctx.telegramStub.state.sends.filter((send) => String(send.text).includes('🚨')).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('spending 80% of the daily budget warns once', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'привет' }],
    overrides: { DAILY_TOKEN_LIMIT: '100' },
  })
  try {
    // The stub reports 30 tokens per call, so three calls cross 80 of 100.
    ctx.bot.recordUsage(ALLOWED, 555, { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 })
    ctx.bot.recordUsage(ALLOWED, 555, { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 })
    ctx.bot.checkSpend()
    // The alert is delivered asynchronously through the platform adapter.
    const warn = await waitFor(() => ctx.telegramStub.state.sends.find((send) => String(send.text).includes('🚨')), { what: 'the spend warning' })
    assert.match(warn.text, /дневного лимита/)
    // A second check the same day stays silent.
    ctx.bot.checkSpend()
    assert.equal(ctx.telegramStub.state.sends.filter((send) => String(send.text).includes('🚨')).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('the answer is streamed into a message and finished in place', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'расскажи про Луну', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'Луна — единственный естественный спутник Земли.' }],
    overrides: { STREAM: 'true' },
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the streamed message' })
    assert.match(sent.text, /Луна/)
    // The final text arrives through editMessageText, not as a second message.
    const edit = await waitFor(() => ctx.telegramStub.state.edits[0], { what: 'the final edit' })
    assert.match(edit.text, /спутник Земли/)
    assert.equal(ctx.telegramStub.state.sends.length, 1, 'exactly one message, then edits')
  } finally {
    await ctx.cleanup()
  }
})

test('streaming can be turned off', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'привет!' }],
    overrides: { STREAM: 'false' },
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    assert.equal(sent.text, 'привет!')
    assert.equal(ctx.telegramStub.state.edits.length, 0, 'no edits when streaming is off')
  } finally {
    await ctx.cleanup()
  }
})

test('reactions are off unless the deployment asks for them', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'привет!' }],
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'the answer' })
    const reactions = ctx.telegramStub.state.calls.filter((call) => call.method === 'setMessageReaction')
    assert.equal(reactions.length, 0, 'по умолчанию бот не ставит реакции')
  } finally {
    await ctx.cleanup()
  }
})

test('reactions appear when REACTIONS=true', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'привет!' }],
    overrides: { REACTIONS: 'true' },
  })
  try {
    await waitFor(() => ctx.telegramStub.state.calls.filter((call) => call.method === 'setMessageReaction').length >= 2, { what: 'реакции' })
    const emojis = ctx.telegramStub.state.calls
      .filter((call) => call.method === 'setMessageReaction')
      .map((call) => call.payload.reaction?.[0]?.emoji)
    assert.deepEqual(emojis, ['👀', '👍'])
  } finally {
    await ctx.cleanup()
  }
})

test('a string cursor survives a restart', async () => {
  // VK long polling counts with a string `ts`, not an integer: dropping it on
  // start made the bot lose whatever happened while it was restarting.
  const ctx = await setup({ updates: [], responses: [{ content: 'ок' }] })
  try {
    ctx.bot.offset = '91'
    await ctx.bot.flushOffset()
    ctx.bot.offset = undefined
    await ctx.bot.loadOffset()
    assert.equal(ctx.bot.offset, '91')
  } finally {
    await ctx.cleanup()
  }
})

test('the poll loop passes an abort signal to the adapter', async () => {
  const seen = []
  const platform = {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async getUpdates(options) {
      seen.push(options.signal)
      // Hold like a real long poll, then answer: the test stops the bot meanwhile.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000)
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      return { updates: [], cursor: 'x' }
    },
    async sendText() {
      return { messageId: 1 }
    },
    async editText() {},
    async answerCallback() {},
    async sendTyping() {},
  }
  const path = await import('node:path')
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-signal-'))
  const { loadConfig } = await import('../src/config.mjs')
  const { HistoryStore } = await import('../src/history.mjs')
  const { Assistant } = await import('../src/bot.mjs')
  const { testEnv } = await import('./helpers.mjs')
  const config = loadConfig(testEnv({ dataDir: dir, overrides: { STREAM: 'false', DIGEST: 'false' } }))
  const history = new HistoryStore({ file: path.join(dir, 'history.json'), limit: 5, logger: silentLogger })
  const bot = new Assistant({ config, platform, history, logger: silentLogger })
  try {
    await bot.start()
    await waitFor(() => seen.length > 0, { what: 'опрос начался' })
    assert.equal(typeof seen[0]?.aborted, 'boolean', 'адаптеру передан AbortSignal')
    await bot.stop()
    assert.equal(seen[0].aborted, true, 'остановка прерывает длинный опрос')
  } finally {
    await bot.stop().catch(() => {})
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('an unreadable attachment gets an explanation instead of silence', async () => {
  // A scanned PDF has no text layer: without this the model was asked with an
  // empty message and the user saw nothing useful at all.
  const ctx = await setup({
    updates: [textUpdate({
      text: '',
      updateId: 1,
      userId: ALLOWED,
      document: { file_id: 'doc-1', file_name: 'scan.pdf', mime_type: 'application/pdf' },
    })],
    responses: [{ content: 'ответ модели' }],
    media: {
      extractText: async () => ({ kind: 'pdf', text: '', truncated: false, error: 'PDF без текстового слоя (скан) — нужен OCR' }),
    },
  })
  try {
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'пояснение' })
    assert.match(sent.text, /нужен OCR/)
    assert.match(sent.text, /Пришлите текст/)
    assert.equal(ctx.modelStub.state.requests.length, 0, 'модель не спрашивают с пустым сообщением')
  } finally {
    await ctx.cleanup()
  }
})

test('a readable document reaches the model as text', async () => {
  const ctx = await setup({
    updates: [textUpdate({
      text: '',
      updateId: 1,
      userId: ALLOWED,
      document: { file_id: 'doc-2', file_name: 'otchet.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    })],
    responses: [{ content: 'В отчёте три пункта.' }],
    media: { extractText: async () => ({ kind: 'docx', text: 'Пункт 1\nПункт 2\nПункт 3', truncated: false }) },
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'ответ' })
    const payload = ctx.modelStub.state.requests[0].payload
    const user = payload.messages.at(-1)
    const text = Array.isArray(user.content) ? user.content.map((part) => part.text ?? '').join('\n') : String(user.content)
    assert.match(text, /Пункт 1/)
    assert.match(text, /otchet\.docx/)
  } finally {
    await ctx.cleanup()
  }
})

test('the bot is told exactly what this build can do', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'что ты умеешь?', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'умею многое' }],
    media: { extractText: async () => ({ text: 'x' }) },
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'ответ' })
    const systems = ctx.modelStub.state.requests[0].payload.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n')
    assert.match(systems, /Твои возможности в этой сборке/)
    assert.match(systems, /документы/, 'документы включены — бот об этом знает')
    // No Home Assistant credentials in this environment, so the build must not
    // claim it can switch the lights.
    assert.equal(/умный дом/.test(systems), false, 'без HA-ключей умный дом не обещаем')
    assert.equal(/голосовые: запишите голосом/.test(systems), false, 'без STT голосовых не обещаем')
  } finally {
    await ctx.cleanup()
  }
})

test('a build without a transcriber never promises voice input', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'привет' }],
    media: { extractText: async () => ({ text: 'x' }) },
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'ответ' })
    const systems = ctx.modelStub.state.requests[0].payload.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n')
    assert.equal(/расшифровывать голосовые/.test(systems), false, 'без STT голосовых нет')
  } finally {
    await ctx.cleanup()
  }
})

test('/help lists the real capabilities', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: '/help', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'ок' }],
    media: { transcribe: async () => 'текст', extractText: async () => ({ text: 'x' }) },
  })
  try {
    const help = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'справка' })
    assert.match(help.text, /\/mode/)
    assert.match(help.text, /голосов/i)
    assert.match(help.text, /документ/i)
    assert.match(help.text, /фото/i)
    // The help must keep up with the features that were added later.
    assert.match(help.text, /\/calendar/)
    assert.match(help.text, /\/search/)
    assert.match(help.text, /\/server/)
    assert.match(help.text, /опрос/i)
  } finally {
    await ctx.cleanup()
  }
})

test('smart home appears in the capabilities only with credentials', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: 'привет', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'привет' }],
    overrides: { HA_URL: 'http://home.local:8123', HA_TOKEN: 'ha-token' },
  })
  try {
    await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'ответ' })
    const systems = ctx.modelStub.state.requests[0].payload.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n')
    assert.match(systems, /умный дом через Home Assistant/, 'с ключами HA умный дом объявлен')
  } finally {
    await ctx.cleanup()
  }
})

test('a photo reaches the model as an image, and the model is told not to deny it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-photo-'))
  try {
    const ctx = await setup({
      updates: [textUpdate({ text: '', updateId: 1, userId: ALLOWED, photo: { file_id: 'photo-1', file_size: 367 } })],
      responses: [{ content: 'вижу картинку' }],
      media: {},
    })
    // Real PNG magic: the mime is sniffed from the bytes, not taken on trust.
    ctx.telegramStub.state.fileBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest of a png'),
    ])
    try {
      await waitFor(() => ctx.modelStub.state.requests[0], { what: 'запрос к модели' })
      const user = ctx.modelStub.state.requests[0].payload.messages.at(-1)
      assert.ok(Array.isArray(user.content), 'содержимое составное')
      const image = user.content.find((part) => part.type === 'image_url')
      assert.ok(image, 'изображение передано')
      assert.match(image.image_url.url, /^data:image\/png;base64,/, 'вложение стало data-url с верным типом')
      const systems = ctx.modelStub.state.requests[0].payload.messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n')
      assert.match(systems, /не утверждай, что картинка не пришла/)
    } finally {
      await ctx.cleanup()
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('/voice turns spoken answers on and off per chat', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: '/voice вкл', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'ок' }],
    tts: async () => Buffer.from('OggS'),
  })
  try {
    const on = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'подтверждение' })
    assert.match(on.text, /Озвучка включена/)
    assert.equal(ctx.bot.history.voice(555), true, 'флаг включён для этого чата')
    // Status and off are checked one at a time: three updates at once would race.
    ctx.telegramStub.push(textUpdate({ text: '/voice', updateId: 2, userId: ALLOWED }))
    const state = await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'состояние' })
    assert.match(state.text, /включена/)
    ctx.telegramStub.push(textUpdate({ text: '/voice выкл', updateId: 3, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[2], { what: 'выключение' })
    assert.equal(ctx.bot.history.voice(555), false, 'флаг снят')
  } finally {
    await ctx.cleanup()
  }
})

test('a spoken answer is sent only when the chat asked for it', async () => {
  const sent = []
  const platform = {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText() { return { messageId: 1 } },
    async editText() {},
    async answerCallback() {},
    async sendTyping() {},
    async sendVoice({ bytes }) { sent.push(bytes); return { messageId: 2 } },
  }
  const history = { voice: () => false }
  const bot = new (await import('../src/bot.mjs')).Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 } },
    platform,
    history,
    logger: silentLogger,
    tts: async () => Buffer.from('OggS-voice'),
  })
  await bot.speakAnswer(1, 'привет', { messageId: 5 })
  assert.equal(sent.length, 0, 'выключено — голоса нет')
  history.voice = () => true
  await bot.speakAnswer(1, 'привет', { messageId: 5 })
  assert.equal(sent.length, 1, 'включено — голос уходит')
  assert.equal(sent[0].toString(), 'OggS-voice')
})

test('a synthesis failure never breaks the answer', async () => {
  const platform = {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText() { return { messageId: 1 } },
    async editText() {},
    async answerCallback() {},
    async sendTyping() {},
    async sendVoice() { throw new Error('telegram said no') },
  }
  const bot = new (await import('../src/bot.mjs')).Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 } },
    platform,
    history: { voice: () => true },
    logger: silentLogger,
    tts: async () => Buffer.from('OggS'),
  })
  await bot.speakAnswer(1, 'привет', {})
})

test('a failed stream edit still delivers the whole answer', async () => {
  // In a VK conversation the edits did not land and only the first fragment stayed
  // visible. The answer must arrive whole even when progressive edits fail.
  const sent = []
  const platform = {
    name: 'vk',
    namespace: 'vk',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText({ markdown }) { sent.push(markdown); return { messageId: sent.length } },
    async editText() { throw new Error('edit rejected') },
    async answerCallback() {},
    async sendTyping() {},
  }
  const history = { voice: () => false, messages: () => [], append: async () => {}, model: () => undefined, setModel: async () => {} }
  const bot = new (await import('../src/bot.mjs')).Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, stream: { enabled: true, throttleMs: 0 }, access: {}, model: { name: 'm' }, time: {} },
    platform,
    history,
    logger: silentLogger,
  })
  const streamer = bot.createStreamer(42)
  streamer.onDelta('первый ')
  streamer.onDelta('второй ')
  const delivered = await streamer.finish('первый второй конец', undefined)
  assert.equal(delivered, false, 'правки сорвались — доставку берёт на себя вызывающий')
  assert.equal(sent.length, 1, 'создано одно сообщение')
})

test('a platform that forbids streaming gets one complete message', async () => {
  const streamed = []
  const platform = {
    name: 'vk',
    namespace: 'vk',
    identity: { id: 1 },
    canStream: () => false,
    async start() {},
    async stop() {},
    async editText() { throw new Error('не должно вызываться') },
  }
  const { Assistant } = await import('../src/bot.mjs')
  const bot = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, stream: { enabled: true, throttleMs: 0 } },
    platform,
    history: { voice: () => false },
    logger: silentLogger,
  })
  // The core asks the adapter before creating a streamer.
  assert.equal(platform.canStream({ chatId: 2000000002 }), false, 'в беседе стриминг запрещён')
  assert.ok(bot, 'бот собрался')
})

test('/character sets the character and it reaches the model', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: '/character с юмором', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'ок' }],
  })
  try {
    const reply = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'подтверждение' })
    assert.match(reply.text, /с юмором/)
    assert.equal(ctx.profiles.store.persona(ALLOWED), 'с юмором')
    // The next answer carries the character to the model.
    ctx.telegramStub.push(textUpdate({ text: 'как дела?', updateId: 2, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'ответ' })
    const systems = ctx.modelStub.state.requests[0].payload.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n')
    assert.match(systems, /Твой характер: с юмором/)
    assert.match(systems, /факты, цифры и время всегда точные/)
  } finally {
    await ctx.cleanup()
  }
})

test('/character lists the options and resets', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: '/character', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'ок' }],
  })
  try {
    const list = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'список' })
    assert.match(list.text, /дружелюбный/)
    assert.match(list.text, /наставник/)
    ctx.telegramStub.push(textUpdate({ text: '/character сброс', updateId: 2, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'сброс' })
    assert.equal(ctx.profiles.store.persona(ALLOWED), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('/mood shows today, pins a mood and returns to the rotation', async () => {
  const ctx = await setup({
    updates: [textUpdate({ text: '/mood', updateId: 1, userId: ALLOWED })],
    responses: [{ content: 'ок' }],
  })
  try {
    const today = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'настроение' })
    assert.match(today.text, /Сегодня я/)
    assert.match(today.text, /меняется само/)
    ctx.telegramStub.push(textUpdate({ text: '/mood серьёзный', updateId: 2, userId: ALLOWED }))
    const pinned = await waitFor(() => ctx.telegramStub.state.sends[1], { what: 'закрепление' })
    assert.match(pinned.text, /закреплено/)
    assert.equal(ctx.profiles.store.mood(ALLOWED), 'серьёзный')
    ctx.telegramStub.push(textUpdate({ text: '/mood авто', updateId: 3, userId: ALLOWED }))
    await waitFor(() => ctx.telegramStub.state.sends[2], { what: 'авто' })
    assert.equal(ctx.profiles.store.mood(ALLOWED), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('quiet hours postpone a night reminder instead of waking anyone', async () => {
  const ctx = await setup({
    updates: [],
    responses: [{ content: 'ок' }],
    overrides: { QUIET_HOURS: '23:00-08:00', TIME_ZONE: 'Europe/Moscow' },
  })
  try {
    // 03:00 in Moscow is inside the window.
    const store = ctx.bot.reminders.store
    const night = store.add({ chatId: 555, userId: ALLOWED, text: 'выпить воды', dueAt: new Date('2026-10-09T00:00:00Z'), repeat: 'none' })
    // The bot thinks it is 03:00 MSK: the clock is injected through quietHoursEnd's arg.
    const original = ctx.bot.quietHoursEnd.bind(ctx.bot)
    ctx.bot.quietHoursEnd = (now) => (now.toISOString().startsWith('2026-10-09T00:') ? original(now) : original(new Date('2026-10-09T00:00:00Z')))
    await ctx.bot.deliverReminder(night)
    assert.equal(ctx.telegramStub.state.sends.length, 0, 'ночью сообщение не отправляем')
    const moved = store.list(555, ALLOWED).find((reminder) => reminder.text === 'выпить воды')
    assert.ok(moved, 'напоминание сохранено')
    assert.notEqual(moved.id, night.id, 'создано новое напоминание на утро')
    const hour = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(new Date(moved.dueAt))
    assert.equal(hour, '08', `перенесено на 08:00, а не на ${hour}`)
  } finally {
    await ctx.cleanup()
  }
})

test('a daytime reminder is delivered as usual', async () => {
  const ctx = await setup({
    updates: [],
    responses: [{ content: 'ок' }],
    overrides: { QUIET_HOURS: '23:00-08:00', TIME_ZONE: 'Europe/Moscow' },
  })
  try {
    // The test is about daytime delivery, so the clock is pinned the same way the
    // quiet-hours test pins it: without this it only passed outside 23:00–08:00.
    ctx.bot.quietHoursEnd = () => undefined
    const store = ctx.bot.reminders.store
    const noon = store.add({ chatId: 555, userId: ALLOWED, text: 'позвонить маме', dueAt: new Date(), repeat: 'none' })
    await ctx.bot.deliverReminder(noon)
    const sent = await waitFor(() => ctx.telegramStub.state.sends[0], { what: 'напоминание' })
    assert.match(sent.text, /позвонить маме/)
  } finally {
    await ctx.cleanup()
  }
})

test('a file built by the model is sent to the chat as a document', async () => {
  const sent = []
  const platform = {
    name: 'telegram',
    namespace: 'telegram',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText({ markdown }) { sent.push(['text', markdown]); return { messageId: 1 } },
    async editText() { throw new Error('стриминг выключен') },
    async answerCallback() {},
    async sendTyping() {},
    async sendDocument({ fileName, bytes, caption }) { sent.push(['file', fileName, bytes?.length, caption]); return { messageId: 2 } },
  }
  const model = {
    name: 'test',
    async complete({ executeTool }) {
      await executeTool('file', { format: 'csv', name: 'список покупок', table: { header: ['что'], rows: [['хлеб']] } }, {})
      // The bot's model layer normalises the reply to { text, model, usage }.
      return { text: 'Готово: файл приложен.', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const { Assistant } = await import('../src/bot.mjs')
  const { createFileTool } = await import('../src/file-tool.mjs')
  const history = { voice: () => false, messages: () => [], append: async () => {}, model: () => undefined, setModel: async () => {} }
  const bot = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100, maxToolRounds: 4 }, stream: { enabled: false }, time: { timeZone: 'Europe/Moscow' }, model: { name: 'test' }, web: { enabled: true, maxToolRounds: 4 }, access: { allowedChatTypes: new Set(['private', 'group', 'supergroup']), allowedUserIds: new Set([ALLOWED]) } },
    platform,
    model,
    history,
    files: createFileTool(),
    logger: silentLogger,
  })
  await bot.handleMessage({ kind: 'message', chat: { id: 555, type: 'private' }, from: { id: ALLOWED, name: 'Вячеслав' }, text: 'сделай файл', message_id: 7, addressed: true })
  const file = sent.find((entry) => entry[0] === 'file')
  assert.ok(file, `файл должен уйти в чат, отправлено: ${JSON.stringify(sent)}`)
  assert.equal(file[1], 'список покупок.csv')
  assert.ok(file[2] > 10, 'в файле должны быть данные')
})

test('a platform without file support gets a plain explanation', async () => {
  const sent = []
  const platform = {
    name: 'vk',
    namespace: 'vk',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText({ markdown }) { sent.push(markdown); return { messageId: 1 } },
    async editText() { throw new Error('нет') },
    async answerCallback() {},
    async sendTyping() {},
  }
  const { Assistant } = await import('../src/bot.mjs')
  const bot = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, time: { timeZone: 'Europe/Moscow' } },
    platform,
    history: { voice: () => false },
    logger: silentLogger,
  })
  const delivered = await bot.sendFile(555, { bytes: Buffer.from('данные'), fileName: 'файл.csv' }, undefined)
  assert.equal(delivered, false)
  assert.match(sent.join(' '), /не умеет отправлять файлы/)
})

test('a file request answered without a tool call is forced through the tool', async () => {
  // The model answered "вот таблица" in words and built nothing: the bot must run
  // one forced round so the document really exists.
  const sent = []
  let rounds = 0
  const platform = {
    name: 'telegram',
    namespace: 'telegram',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText({ markdown }) { sent.push(['text', markdown]); return { messageId: 1 } },
    async editText() { throw new Error('стриминг выключен') },
    async answerCallback() {},
    async sendTyping() {},
    async sendDocument({ fileName, bytes }) { sent.push(['file', fileName, bytes?.length]); return { messageId: 2 } },
  }
  const model = {
    name: 'test',
    async complete({ executeTool, toolChoice }) {
      rounds += 1
      if (!toolChoice) return { text: 'Вот таблица: Хлеб — 50, Молоко — 80.', toolCalls: 0, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      // The forced round: the model must call the tool it was told to call.
      await executeTool('file', { format: 'xlsx', name: 'цены', table: { header: ['Товар', 'Цена'], rows: [['Хлеб', '50']] } }, {})
      return { text: 'готово', toolCalls: 1, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    },
  }
  const { Assistant } = await import('../src/bot.mjs')
  const { createFileTool } = await import('../src/file-tool.mjs')
  const bot = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, stream: { enabled: false }, time: { timeZone: 'Europe/Moscow' }, model: { name: 'test' }, web: { enabled: true, maxToolRounds: 2 }, access: { allowedChatTypes: new Set(['private']), allowedUserIds: new Set([ALLOWED]) } },
    platform,
    model,
    history: { voice: () => false, messages: () => [], append: async () => {}, model: () => undefined, setModel: async () => {} },
    files: createFileTool(),
    logger: silentLogger,
  })
  await bot.handleMessage({ kind: 'message', chat: { id: 555, type: 'private' }, from: { id: ALLOWED, name: 'В' }, text: 'сделай таблицу в Excel с ценами', message_id: 7, addressed: true })
  assert.equal(rounds, 2, 'должен быть дополнительный раунд')
  const file = sent.find((entry) => entry[0] === 'file')
  assert.ok(file, `файл обязателен, отправлено: ${JSON.stringify(sent)}`)
  assert.equal(file[1], 'цены.xlsx')
  const text = sent.find((entry) => entry[0] === 'text')
  assert.match(text[1], /Файл/i, 'в ответе — правда о файле, а не «вот таблица»')
})

test('the polling cursor is written atomically and never left truncated', async () => {
  // A full disk once turned the Telegram offset into a 0-byte file: the write went
  // straight into the real file, which truncates it first.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-offset-'))
  try {
    const { Assistant } = await import('../src/bot.mjs')
    const bot = new Assistant({
      config: { dataDir: dir, reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, time: {} },
      platform: { name: 'telegram', namespace: 'telegram', identity: { id: 1 } },
      history: { voice: () => false },
      logger: silentLogger,
    })
    bot.offsetFile = path.join(dir, 'offset.json')
    // Two saves in a row: the second must replace the first without leftovers.
    bot.offset = 111
    await bot.flushOffset()
    const first = await fs.readFile(bot.offsetFile, 'utf8')
    assert.equal(JSON.parse(first).offset, 111)
    bot.offset = 222
    await bot.flushOffset()
    assert.equal(JSON.parse(await fs.readFile(bot.offsetFile, 'utf8')).offset, 222)
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'временный файл не должен оставаться')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('the bot warns the owner when the disk is nearly full', async () => {
  const alerts = []
  const { Assistant } = await import('../src/bot.mjs')
  const bot = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 } },
    platform: { name: 'telegram', namespace: 'telegram', identity: { id: 1 } },
    history: { voice: () => false },
    logger: silentLogger,
  })
  bot.alertOwner = async (text) => { alerts.push(text) }
  bot.freeDiskMb = async () => 50
  await bot.checkDiskSpace()
  assert.equal(alerts.length, 1, 'предупреждение должно уйти')
  assert.match(alerts[0], /Мало места/)
  // A second check inside the hour stays quiet.
  await bot.checkDiskSpace()
  assert.equal(alerts.length, 1, 'не спамим: не чаще раза в час')
  bot.diskWarnedAt = 0
  bot.freeDiskMb = async () => 9000
  await bot.checkDiskSpace()
  assert.equal(alerts.length, 1, 'на свободном диске молчим')
})

test('VK gets a tappable command menu, Telegram does not', async () => {
  // VK has no «/» command list, so the bot offers buttons whose labels are commands.
  const { Assistant } = await import('../src/bot.mjs')
  const sent = []
  const vk = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, time: {} },
    platform: {
      name: 'vk',
      namespace: 'vk',
      identity: { id: 1 },
      async sendText({ markdown, keyboard }) { sent.push([markdown, keyboard]); return { messageId: 1 } },
    },
    history: { voice: () => false },
    logger: silentLogger,
  })
  vk.send = async (chatId, text, replyTo, keyboard) => { sent.push([text, keyboard]) }
  await vk.runCommand({ name: 'help', args: '' }, { chat: { id: 2000000001 }, from: { id: 4831476 }, message_id: 1 })
  const vkMenu = sent.at(-1)[1]
  assert.ok(vkMenu, 'в VK меню должно прийти')
  const labels = vkMenu.rows.flat().map((button) => button.text)
  assert.deepEqual(labels, ['/reminders', '/calendar', '/digest', '/help'])
  assert.deepEqual(vk.menuKeyboard(), vkMenu, 'меню стабильно между вызовами')

  const telegram = new Assistant({
    config: { dataDir: os.tmpdir(), reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, time: {} },
    platform: { name: 'telegram', namespace: 'telegram', identity: { id: 1 } },
    history: { voice: () => false },
    logger: silentLogger,
  })
  assert.equal(telegram.menuKeyboard(), undefined, 'в Telegram меню не нужно: там есть «/»')
})

test('a thinking model that rejects tool_choice still gets the tool called', async () => {
  // «Thinking mode does not support this tool_choice» — HTTP 400 от провайдера.
  // Раньше это ломало весь ход: напоминание не создавалось.
  const sent = []
  let rounds = 0
  const platform = {
    name: 'telegram',
    namespace: 'telegram',
    identity: { id: 1 },
    async start() {},
    async stop() {},
    async sendText({ markdown }) { sent.push(['text', markdown]); return { messageId: 1 } },
    async editText() { throw new Error('стриминг выключен') },
    async answerCallback() {},
    async sendTyping() {},
  }
  const model = {
    name: 'thinking-model',
    async complete({ executeTool, toolChoice }) {
      rounds += 1
      // Первый ход: модель отвечает словами и инструмент не вызывает.
      if (rounds === 1) return { text: 'Хорошо, напомню.', toolCalls: 0, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      // Принудительный ход провайдер отвергает — именно это ломало напоминания.
      if (toolChoice) throw new Error('provider error (HTTP 400): Thinking mode does not support this tool_choice')
      // Повтор без принуждения: подсказка сработала, инструмент вызван.
      await executeTool('remind', { text: 'выпить воды', in_minutes: 30 }, {})
      return { text: 'Готово', toolCalls: 1, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    },
  }
  const { Assistant } = await import('../src/bot.mjs')
  const { ReminderStore } = await import('../src/reminders.mjs')
  const { createReminderTool } = await import('../src/reminder-tool.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-thinking-'))
  try {
    const store = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger, timeZone: 'Europe/Moscow' })
    await store.load()
    const bot = new Assistant({
      config: { dataDir: dir, reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, stream: { enabled: false }, time: { timeZone: 'Europe/Moscow' }, model: { name: 'thinking-model' }, web: { enabled: true, maxToolRounds: 4 }, access: { allowedChatTypes: new Set(['private']), allowedUserIds: new Set([ALLOWED]) } },
      platform,
      model,
      history: { voice: () => false, messages: () => [], append: async () => {}, model: () => undefined, setModel: async () => {} },
      reminders: { store, tool: createReminderTool({ store, timeZone: 'Europe/Moscow' }) },
      logger: silentLogger,
    })
    await bot.handleMessage({ kind: 'message', chat: { id: 555, type: 'private' }, from: { id: ALLOWED, name: 'В' }, text: 'напомни через 30 минут выпить воды', message_id: 7, addressed: true })
    assert.equal(rounds, 3, 'обычный ход, принудительный и повтор без принуждения')
    assert.equal(store.list(555, ALLOWED).length, 1, 'напоминание создано, несмотря на отказ провайдера')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a request to list reminders is not forced into creating one', async () => {
  // Так было в VK: на «покажи напоминания» бот отвечал «Не удалось поставить
  // напоминание — инструмент не сработал». Предохранитель видел «напомин» и
  // насильно звал remind, а затем затирал правильный ответ.
  const sent = []
  let forcedRounds = 0
  const platform = {
    name: 'vk',
    namespace: 'vk',
    identity: { id: 1 },
    canStream: () => false,
    async start() {},
    async stop() {},
    async sendText({ markdown }) { sent.push(String(markdown)); return { messageId: 1 } },
    async editText() { throw new Error('в VK без стриминга') },
    async answerCallback() {},
    async sendTyping() {},
  }
  const model = {
    name: 'test',
    async complete({ toolChoice }) {
      if (toolChoice) forcedRounds += 1
      return { text: 'Вот ваши напоминания:\n1. в 22:01 — выпить воды', toolCalls: 0, usage: { total_tokens: 3 } }
    },
  }
  const { Assistant } = await import('../src/bot.mjs')
  const { ReminderStore } = await import('../src/reminders.mjs')
  const { createReminderTool } = await import('../src/reminder-tool.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-list-rem-'))
  try {
    const store = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger, timeZone: 'Europe/Moscow' })
    await store.load()
    const bot = new Assistant({
      config: { dataDir: dir, reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, stream: { enabled: false }, time: { timeZone: 'Europe/Moscow' }, model: { name: 'test' }, web: { enabled: false, maxToolRounds: 4 }, access: { allowedChatTypes: new Set(['private']), allowedUserIds: new Set([ALLOWED]) } },
      platform,
      model,
      history: { voice: () => false, messages: () => [], append: async () => {}, model: () => undefined, setModel: async () => {} },
      reminders: { store, tool: createReminderTool({ store, timeZone: 'Europe/Moscow' }) },
      logger: silentLogger,
    })
    await bot.handleMessage({ kind: 'message', chat: { id: 555, type: 'private' }, from: { id: ALLOWED, name: 'В' }, text: 'покажи напоминания', message_id: 9, addressed: true })
    const text = sent.join(' ')
    assert.match(text, /Вот ваши напоминания/, 'ответ со списком сохраняется')
    assert.doesNotMatch(text, /Не удалось поставить напоминание/, 'ошибки создания быть не должно')
    assert.equal(forcedRounds, 0, 'принудительный вызов remind не нужен')
    assert.deepEqual(store.list(555, ALLOWED), [], 'ничего не создано')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('an explicit creation request still forces the tool', async () => {
  const sent = []
  let forcedRounds = 0
  const platform = {
    name: 'vk', namespace: 'vk', identity: { id: 1 }, canStream: () => false,
    async start() {}, async stop() {},
    async sendText({ markdown }) { sent.push(String(markdown)); return { messageId: 1 } },
    async editText() { throw new Error('нет') }, async answerCallback() {}, async sendTyping() {},
  }
  const { Assistant } = await import('../src/bot.mjs')
  const { ReminderStore } = await import('../src/reminders.mjs')
  const { createReminderTool } = await import('../src/reminder-tool.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-force-rem-'))
  try {
    const store = new ReminderStore({ file: path.join(dir, 'reminders.json'), logger: silentLogger, timeZone: 'Europe/Moscow' })
    await store.load()
    const tool = createReminderTool({ store, timeZone: 'Europe/Moscow' })
    const model = {
      name: 'test',
      async complete({ toolChoice, executeTool }) {
        if (toolChoice) {
          forcedRounds += 1
          await executeTool('remind', { text: 'выпить воды', in_minutes: 30 }, {})
          return { text: 'Готово', toolCalls: 1, usage: { total_tokens: 3 } }
        }
        // Первый ход — только словами, как и бывает у thinking-моделей.
        return { text: 'Хорошо, напомню.', toolCalls: 0, usage: { total_tokens: 3 } }
      },
    }
    const bot = new Assistant({
      config: { dataDir: dir, reactions: { enabled: false }, limits: { maxConcurrentRequests: 4, shutdownGraceMs: 100 }, stream: { enabled: false }, time: { timeZone: 'Europe/Moscow' }, model: { name: 'test' }, web: { enabled: false, maxToolRounds: 4 }, access: { allowedChatTypes: new Set(['private']), allowedUserIds: new Set([ALLOWED]) } },
      platform, model,
      history: { voice: () => false, messages: () => [], append: async () => {}, model: () => undefined, setModel: async () => {} },
      reminders: { store, tool },
      logger: silentLogger,
    })
    await bot.handleMessage({ kind: 'message', chat: { id: 555, type: 'private' }, from: { id: ALLOWED, name: 'В' }, text: 'напомни через 30 минут выпить воды', message_id: 10, addressed: true })
    assert.equal(forcedRounds, 1, 'просьба создать — инструмент вызывается принудительно')
    assert.equal(store.list(555, ALLOWED).length, 1, 'напоминание создано')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('веб-сообщение проходит через конвейер и не уходит в Telegram', async () => {
  const ctx = await setup({ responses: [{ content: 'ответ с сайта' }] })
  try {
    const result = await ctx.bot.handleWebMessage({
      userId: ALLOWED,
      chatId: ALLOWED,
      text: 'привет с сайта',
      name: 'Вячеслав',
    })
    assert.ok(result.sends.length >= 1, 'сайт получил ответ')
    assert.match(result.sends.map((entry) => entry.text).join('\n'), /ответ с сайта/)
    assert.equal(ctx.telegramStub.state.sends.length, 0, 'в Telegram ничего не отправлено')
    await ctx.history.flush()
    const history = await historyFile(ctx.dir)
    const chat = history.chats[String(ALLOWED)] ?? history.chats[ALLOWED]
    assert.ok(chat, 'история чата записана')
    assert.equal(chat.messages.at(-2).content, 'привет с сайта')
    assert.equal(chat.messages.at(-1).content, 'ответ с сайта')
  } finally {
    await ctx.cleanup()
  }
})

test('веб-команда возвращает ответ на сайт, а не в Telegram', async () => {
  const ctx = await setup({ updates: [] })
  try {
    const result = await ctx.bot.handleWebMessage({
      userId: ALLOWED,
      chatId: ALLOWED,
      text: '/whoami',
      name: 'Вячеслав',
    })
    assert.ok(result.sends.some((entry) => entry.text.includes(String(ALLOWED))))
    assert.equal(ctx.telegramStub.state.sends.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

// F1: напоминания — это данные, а не заявка на разработку.
test('a reminder message does not create a feature request', async () => {
  const ctx = await setup({ responses: [{ content: 'напоминание принято' }] })
  try {
    let requests = 0
    ctx.bot.agentBridge = { enabled: true, createRequest: async () => { requests += 1; return { requestId: 'REQ-X' } } }
    const update = textUpdate({ text: 'Добавь напоминание завтра в 10:00 позвонить маме', updateId: 1, userId: ALLOWED })
    update.message.addressed = true
    await ctx.bot.handleMessage(update.message)
    await waitFor(() => ctx.modelStub.state.requests.length >= 1, { what: 'the normal model turn' })
    assert.equal(requests, 0, 'createRequest не вызывается для напоминания')
    assert.ok(ctx.modelStub.state.requests.length >= 1, 'обычный путь обработки выполнен')
  } finally {
    await ctx.cleanup()
  }
})

test('an explicit product change creates a request instead of a reminder', async () => {
  const ctx = await setup({ responses: [{ content: 'ответ модели' }] })
  try {
    const seen = []
    ctx.bot.agentBridge = {
      enabled: true,
      createRequest: async ({ text }) => { seen.push(text); return { requestId: 'REQ-1', analysis: { components: [] }, compareUrl: 'https://example/c' } },
    }
    const update = textUpdate({ text: 'Добавь в бота возможность повторять напоминание до подтверждения', updateId: 2, userId: ALLOWED })
    update.message.addressed = true
    await ctx.bot.handleMessage(update.message)
    assert.equal(seen.length, 1)
    assert.ok(ctx.telegramStub.state.sends.some((item) => /REQ-1/.test(item.text)))
  } finally {
    await ctx.cleanup()
  }
})

test('/request remains an explicit path to a change request', async () => {
  const ctx = await setup({ responses: [{ content: 'ответ модели' }] })
  try {
    let requests = 0
    ctx.bot.agentBridge = { enabled: true, createRequest: async () => { requests += 1; return { requestId: 'REQ-2', analysis: { components: [] } } } }
    const update = textUpdate({ text: '/request добавь в бота команду показа релиза', updateId: 3, userId: ALLOWED })
    update.message.addressed = true
    await ctx.bot.handleMessage(update.message)
    assert.equal(requests, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('an answer to an open agent question is not intercepted as a feature request', async () => {
  const ctx = await setup({ responses: [{ content: 'ответ модели' }] })
  try {
    let requests = 0
    ctx.bot.agentBridge = { enabled: true, createRequest: async () => { requests += 1; return { requestId: 'REQ-3' } } }
    let answered = 0
    ctx.bot.agentLink = { handleOwnerMessage: async () => { answered += 1; return { handled: true, message: 'ответ агента' } } }
    const update = textUpdate({ text: 'Добавь в бота команду показа релиза', updateId: 4, userId: ALLOWED })
    update.message.addressed = true
    await ctx.bot.handleMessage(update.message)
    assert.equal(requests, 0)
    assert.equal(answered, 1, 'ответ на открытый вопрос агента обработан до детектора заявок')
  } finally {
    await ctx.cleanup()
  }
})

test('веб-сообщение в общий чат пересылается в Telegram с автором', async () => {
  const ctx = await setup({ responses: [{ content: 'ответ группе' }] })
  try {
    const result = await ctx.bot.handleWebMessage({
      userId: ALLOWED,
      chatId: -1001234567890,
      chatType: 'group',
      chatTitle: 'TenKrol и Машулечка',
      text: 'привет группе',
      name: 'Вячеслав',
    })
    assert.match(result.sends.map((entry) => entry.text).join('\n'), /ответ группе/)
    assert.equal(ctx.telegramStub.state.sends.length, 2)
    assert.equal(String(ctx.telegramStub.state.sends[0].chat_id), '-1001234567890')
    assert.match(ctx.telegramStub.state.sends[0].text, /Вячеслав \(с сайта\)/)
    assert.match(ctx.telegramStub.state.sends[0].text, /привет группе/)
    assert.match(ctx.telegramStub.state.sends[1].text, /ответ группе/)
    await ctx.history.flush()
    const history = await historyFile(ctx.dir)
    const chat = history.chats['-1001234567890']
    assert.ok(chat, 'история группы записана')
    assert.equal(chat.messages.at(-2).author, 'Вячеслав')
  } finally {
    await ctx.cleanup()
  }
})
