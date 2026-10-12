import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { createBotHarness } from './helpers.mjs'

const OK_USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, steps: 1, turns: 1 }

const result = (over = {}) => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  aborted: false,
  text: 'Готово: файл в outbox/отчёт.docx',
  sessionId: 'session-1',
  usage: OK_USAGE,
  tools: [],
  errors: [],
  stderr: '',
  durationMs: 1200,
  ...over,
})

/** The chat bot in Spain writing in the bridge group. */
const botMessage = (over = {}) => ({
  kind: 'message',
  id: 5,
  chat: { id: -100777, type: 'supergroup' },
  from: { id: 555, name: 'Tenkrol', username: 'Tenkrol_bot', isBot: true },
  text: '@Tenkrol_ag_bot собери отчёт по продажам за октябрь',
  attachments: [],
  addressed: true,
  messageId: 91,
  replyToMessageId: 91,
  ...over,
})

const humanMessage = (over = {}) => ({
  kind: 'message',
  id: 6,
  chat: { id: -100777, type: 'supergroup' },
  from: { id: 42, name: 'Вячеслав', isBot: false },
  text: '@Tenkrol_ag_bot сделай выгрузку',
  attachments: [],
  addressed: true,
  messageId: 92,
  replyToMessageId: 92,
  ...over,
})

const bridgeEnv = { BRIDGE_GROUP_ID: '-100777' }

test('the bridge group and its source bots are configured', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '1:a',
    ALLOWED_USER_IDS: '42',
    BRIDGE_GROUP_ID: '-100777',
    BRIDGE_SOURCE_BOT_IDS: '555, 777',
  })
  assert.equal(config.bridge.groupId, '-100777')
  assert.equal(config.bridge.sourceBotIds.has('555'), true)
  assert.equal(config.bridge.notify, true)
})

test('a bot task in the bridge group runs, is attributed to the owner and answers by reply', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: { async run(request) { calls.push(request); return result() } },
    configEnv: bridgeEnv,
  })
  try {
    await env.bot.handleUpdate(botMessage())
    await env.bot.worker

    assert.equal(calls.length, 1)
    assert.match(calls[0].task, /собери отчёт по продажам/)

    // The answer goes to the group, as a reply to the chat bot's message — that
    // is the only way its own bot will see it.
    const answer = env.platform.sent.filter((entry) => /Готово/.test(entry.markdown)).at(-1)
    assert.equal(answer.chatId, -100777)
    assert.equal(answer.replyToMessageId, 91)

    // Usage is billed to the owner, not to the bot.
    const journal = env.journal.recent(1)[0]
    assert.equal(journal.chatId, '-100777')
    assert.equal(journal.userId, '42')
    assert.ok(env.platform.sent.some((entry) => /Задача .* пришла из чата-бота/.test(entry.markdown)), 'the owner is notified')
  } finally {
    await env.close()
  }
})

test('a bot is ignored outside the bridge group', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: { async run(request) { calls.push(request); return result() } },
    configEnv: bridgeEnv,
  })
  try {
    await env.bot.handleUpdate(botMessage({ chat: { id: 555, type: 'private' } }))
    assert.equal(calls.length, 0)
  } finally {
    await env.close()
  }
})

test('a bot is ignored in the bridge group when the message is not addressed', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: { async run(request) { calls.push(request); return result() } },
    configEnv: bridgeEnv,
  })
  try {
    await env.bot.handleUpdate(botMessage({ addressed: false, text: 'просто болтаю' }))
    assert.equal(calls.length, 0)
  } finally {
    await env.close()
  }
})

test('only the listed source bots may submit, when the list is set', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: { async run(request) { calls.push(request); return result() } },
    configEnv: { ...bridgeEnv, BRIDGE_SOURCE_BOT_IDS: '999' },
  })
  try {
    await env.bot.handleUpdate(botMessage())
    assert.equal(calls.length, 0, 'bot 555 is not on the list')
  } finally {
    await env.close()
  }
})

test('without a bridge group the bot still ignores bots entirely', async () => {
  const calls = []
  const env = await createBotHarness({ runner: { async run(request) { calls.push(request); return result() } } })
  try {
    await env.bot.handleUpdate(botMessage())
    assert.equal(calls.length, 0)
  } finally {
    await env.close()
  }
})

test('the owner writing in the bridge group is a normal task, not a bridged one', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: { async run(request) { calls.push(request); return result() } },
    configEnv: bridgeEnv,
  })
  try {
    await env.bot.handleUpdate(humanMessage())
    await env.bot.worker

    assert.equal(calls.length, 1)
    const journal = env.journal.recent(1)[0]
    assert.equal(journal.userId, '42')
    assert.equal(journal.scheduledFrom, undefined)
    const answer = env.platform.sent.filter((entry) => /Готово/.test(entry.markdown)).at(-1)
    assert.equal(answer.replyToMessageId, undefined, 'a human answer needs no reply trick')
  } finally {
    await env.close()
  }
})

test('a bridged question is sent as a reply too, so the chat bot can relay it', async () => {
  const env = await createBotHarness({
    runner: {
      async run() {
        return result({ text: 'Собрал данные.\n\nВОПРОС: за какой месяц считать?' })
      },
    },
    configEnv: bridgeEnv,
  })
  try {
    await env.bot.handleUpdate(botMessage())
    await env.bot.worker
    const question = env.platform.sent.filter((entry) => /Вопрос по задаче/.test(entry.markdown)).at(-1)
    assert.equal(question.replyToMessageId, 91)
    assert.equal(env.state.get('await:-100777').kind, 'question')
  } finally {
    await env.close()
  }
})
