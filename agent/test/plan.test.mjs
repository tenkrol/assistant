import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotHarness, createTestLogger } from './helpers.mjs'
import { QuickClient } from '../src/quick.mjs'

const PLAN = '- собрать данные\n- посчитать итоги\n- оформить xlsx'

/** A quick client whose planner returns the given plan. */
function planner(plan = PLAN, extra = {}) {
  return new QuickClient({
    apiKey: 'sk-test',
    logger: createTestLogger(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: plan } }], usage: { prompt_tokens: 300, completion_tokens: 40 } }),
    }),
    ...extra,
  })
}

const runStub = (calls) => ({
  async run({ task }) {
    calls.push(task)
    return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 20 }
  },
})

const message = (text, over = {}) => ({
  kind: 'message', id: 1, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
  text, attachments: [], addressed: true, messageId: 20, ...over,
})

test('auto planning triggers on size, on signal words, and never for unattended work', async () => {
  const env = await createBotHarness({ runner: runStub([]) })
  try {
    const bot = env.bot
    bot.quick = planner()
    assert.equal(bot.shouldPlan({ text: 'сделай презентацию о компании', chatId: 42 }), true, 'слово-сигнал')
    assert.equal(bot.shouldPlan({ text: `сделай ${'подробное описание '.repeat(15)}`, chatId: 42 }), true, 'длина')
    assert.equal(bot.shouldPlan({ text: 'сколько будет 2+2', chatId: 42 }), false, 'мелкая задача')
    assert.equal(bot.shouldPlan({ text: 'сделай презентацию', chatId: 42, scheduledFrom: 's1' }), false, 'по расписанию')
    assert.equal(bot.shouldPlan({ text: 'сделай презентацию', chatId: 42, bridgeFrom: 'chat-bot' }), false, 'из моста')
    assert.equal(bot.shouldPlan({ text: 'делай', chatId: 42, continuationOf: 't1' }), false, 'продолжение')
  } finally {
    await env.close()
  }
})

test('a big task is parked with a plan instead of running', async () => {
  const calls = []
  const env = await createBotHarness({ runner: runStub(calls) })
  try {
    env.bot.quick = planner()
    await env.bot.handleUpdate(message('сделай отчёт по продажам за квартал'))
    await env.bot.worker

    assert.equal(calls.length, 0, 'DSH не запускался до утверждения')
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, 'awaiting_reply')
    assert.match(record.plan, /собрать данные/)
    const sent = env.platform.sent.at(-1)
    assert.match(sent.markdown, /План задачи/)
    assert.match(sent.markdown, /собрать данные/)
    assert.equal(sent.keyboard.rows[0][0].data, `p:${record.id}:run`)
    assert.equal(sent.keyboard.rows[1][0].data, `x:${record.id}:0`)
  } finally {
    await env.close()
  }
})

test('approving the plan runs the task with the plan inside the prompt', async () => {
  const calls = []
  const env = await createBotHarness({ runner: runStub(calls) })
  try {
    env.bot.quick = planner()
    await env.bot.handleUpdate(message('сделай отчёт по продажам за квартал'))
    await env.bot.worker
    const id = env.journal.recent(1)[0].id

    await env.bot.handleUpdate({
      kind: 'callback', id: 5, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      callback: { data: `p:${id}:run`, id: 'cb-1', messageId: 99, text: '📝 План задачи' },
    })
    await env.bot.worker

    assert.equal(calls.length, 1, 'задача ушла в DSH')
    assert.match(calls[0], /сделай отчёт по продажам за квартал/, 'исходная задача сохранена')
    assert.match(calls[0], /Утверждённый план/)
    assert.match(calls[0], /собрать данные/)
    assert.equal(env.journal.recent(1)[0].status, 'done')
    assert.ok(env.platform.edits.some((edit) => /План утверждён/.test(edit.markdown)), 'кнопки сняты')
  } finally {
    await env.close()
  }
})

test('cancelling the plan closes the task without a run', async () => {
  const calls = []
  const env = await createBotHarness({ runner: runStub(calls) })
  try {
    env.bot.quick = planner()
    await env.bot.handleUpdate(message('сделай презентацию о компании'))
    await env.bot.worker
    const id = env.journal.recent(1)[0].id

    await env.bot.handleUpdate({
      kind: 'callback', id: 6, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      callback: { data: `x:${id}:0`, id: 'cb-2', messageId: 99, text: '📝 План задачи' },
    })
    await env.bot.worker

    assert.equal(calls.length, 0)
    assert.equal(env.journal.recent(1)[0].status, 'cancelled')
  } finally {
    await env.close()
  }
})

test('a planner that fails does not block the task', async () => {
  const calls = []
  const env = await createBotHarness({ runner: runStub(calls) })
  try {
    env.bot.quick = new QuickClient({
      apiKey: 'sk-test',
      logger: createTestLogger(),
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    })
    await env.bot.handleUpdate(message('сделай отчёт по продажам за квартал'))
    await env.bot.worker

    assert.equal(calls.length, 1, 'задача всё равно выполнена')
    assert.equal(env.journal.recent(1)[0].status, 'done')
  } finally {
    await env.close()
  }
})

test('plan text edits are answered by the executor as a continuation', async () => {
  const calls = []
  const env = await createBotHarness({ runner: runStub(calls) })
  try {
    env.bot.quick = planner()
    await env.bot.handleUpdate(message('сделай отчёт по продажам за квартал'))
    await env.bot.worker
    // Instead of a button the owner types a correction: it must reach the task.
    await env.bot.handleUpdate(message('только без диаграмм', { messageId: 21 }))
    await env.bot.worker
    assert.equal(calls.length, 1)
    assert.match(calls[0], /без диаграмм/)
  } finally {
    await env.close()
  }
})
