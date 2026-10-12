import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATUS } from '../src/tasks.mjs'
import { createBotHarness } from './helpers.mjs'

const OK_USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, steps: 1, turns: 1 }

const result = (over = {}) => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  aborted: false,
  text: 'Готово',
  sessionId: 'session-1',
  usage: OK_USAGE,
  tools: [],
  errors: [],
  stderr: '',
  durationMs: 1000,
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

const callback = (data, over = {}) => ({
  kind: 'callback',
  id: 2,
  chat: { id: 42, type: 'private' },
  from: { id: 42, isBot: false },
  text: '',
  attachments: [],
  addressed: true,
  messageId: 9,
  callback: { id: 'cb-1', data, messageId: 9, text: '🔀 По задаче варианты' },
  ...over,
})

/** A runner that answers with `text` once, then records every call. */
function scriptedRunner(texts) {
  const calls = []
  let index = 0
  return {
    calls,
    async run(request) {
      calls.push(request)
      const text = texts[Math.min(index, texts.length - 1)]
      index += 1
      return result({ text })
    },
  }
}

test('a question parks the task and the answer resumes the same session', async () => {
  const runner = scriptedRunner([
    'Собрал данные.\n\nВОПРОС: за какой месяц считать?',
    'Готово: отчёт за октябрь в outbox/отчёт.docx',
  ])
  const env = await createBotHarness({ runner })
  try {
    await env.bot.handleUpdate(message({ text: 'сделай отчёт по продажам' }))
    await env.bot.worker

    const parked = env.journal.recent(1)[0]
    assert.equal(parked.status, STATUS.awaiting)
    assert.match(parked.question, /за какой месяц/)
    assert.ok(env.state.get('await:42'), 'the chat owes an answer')
    assert.ok(env.platform.sent.some((entry) => /Вопрос по задаче/.test(entry.markdown)))
    assert.equal(env.bot.running, undefined)

    await env.bot.handleUpdate(message({ text: 'за октябрь', messageId: 8 }))
    await env.bot.worker

    assert.equal(runner.calls.length, 2)
    assert.equal(runner.calls[1].sessionId, 'session-1', 'the same DSH session is resumed')
    assert.match(runner.calls[1].task, /за октябрь/)
    assert.match(runner.calls[1].task, /Продолжи выполнение/)
    assert.equal(env.state.get('await:42'), undefined, 'the question is closed')
    assert.equal(env.journal.get(parked.id).status, STATUS.done)
  } finally {
    await env.close()
  }
})

test('variants arrive as buttons and a tap resumes the chosen one', async () => {
  const runner = scriptedRunner([
    'Есть два пути.\n\nВАРИАНТ 1: краткий отчёт — быстро.\nВАРИАНТ 2: полный отчёт с графиками — дольше.',
    'Готово: полный отчёт в outbox/отчёт.docx',
  ])
  const env = await createBotHarness({ runner })
  try {
    await env.bot.handleUpdate(message({ text: 'сделай отчёт' }))
    await env.bot.worker

    const record = env.journal.recent(1)[0]
    assert.equal(record.status, STATUS.awaiting)
    assert.equal(record.variants.length, 2)

    const variantsMessage = env.platform.sent.at(-1)
    assert.equal(variantsMessage.keyboard.rows.length, 3, 'two variants and a cancel')
    assert.equal(variantsMessage.keyboard.rows[0][0].data, `v:${record.id}:1`)
    assert.match(variantsMessage.keyboard.rows[1][0].text, /^2\. /)

    await env.bot.handleUpdate(callback(`v:${record.id}:2`))
    await env.bot.worker

    assert.equal(env.platform.callbacks.at(-1).text, 'Вариант 2')
    assert.ok(env.platform.edits.some((entry) => /Выбран вариант 2/.test(entry.markdown)), 'the keyboard is dropped')
    assert.match(runner.calls[1].task, /ВАРИАНТ 2/)
    assert.match(runner.calls[1].task, /Выполни выбранный вариант/)
    assert.equal(env.journal.get(record.id).status, STATUS.done)
  } finally {
    await env.close()
  }
})

test('a variant can be chosen by number in a message', async () => {
  const runner = scriptedRunner([
    'ВАРИАНТ 1: кратко\nВАРИАНТ 2: подробно',
    'Готово: подробный вариант',
  ])
  const env = await createBotHarness({ runner })
  try {
    await env.bot.handleUpdate(message({ text: 'сделай отчёт' }))
    await env.bot.worker
    await env.bot.handleUpdate(message({ text: 'вариант 2', messageId: 8 }))
    await env.bot.worker
    assert.equal(runner.calls.length, 2)
    assert.match(runner.calls[1].task, /ВАРИАНТ 2/)
  } finally {
    await env.close()
  }
})

test('words instead of a number answer the question, not variant 1', async () => {
  const runner = scriptedRunner([
    'ВОПРОС: для какого документа?\nВАРИАНТ 1: ГОСТ\nВАРИАНТ 2: деловой',
    'Готово: сделал деловой титул',
  ])
  const env = await createBotHarness({ runner })
  try {
    await env.bot.handleUpdate(message({ text: 'сделай титульный лист' }))
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, STATUS.awaiting)
    assert.equal(record.variants.length, 2)
    assert.match(record.question, /для какого документа/)

    await env.bot.handleUpdate(message({ text: 'для внутренней инструкции, нужен docx', messageId: 8 }))
    await env.bot.worker

    assert.equal(runner.calls.length, 2)
    assert.match(runner.calls[1].task, /Ответ пользователя/)
    assert.match(runner.calls[1].task, /внутренней инструкции/)
    assert.equal(/выбрал вариант/.test(runner.calls[1].task), false, 'variant 1 is not assumed')
    assert.equal(/ГОСТ/.test(runner.calls[1].task), false, 'the first variant text is not injected')
  } finally {
    await env.close()
  }
})

test('a stale button tap is refused with a toast', async () => {
  const env = await createBotHarness({ runner: scriptedRunner(['Готово']) })
  try {
    await env.bot.handleUpdate(message({ text: 'задача' }))
    await env.bot.worker
    await env.bot.handleUpdate(callback('v:нет-такой:1'))
    assert.match(env.platform.callbacks.at(-1).text, /неактуален/)
    assert.equal(env.platform.callbacks.at(-1).alert, true)
  } finally {
    await env.close()
  }
})

test('an expired question closes the task and a new message becomes a new task', async () => {
  const runner = scriptedRunner(['ВОПРОС: какой формат?', 'Готово'])
  const env = await createBotHarness({ runner, configEnv: { AWAIT_REPLY_MS: '60000' } })
  try {
    await env.bot.handleUpdate(message({ text: 'сделай отчёт' }))
    await env.bot.worker
    const parked = env.journal.recent(1)[0]

    // Move the clock two minutes ahead: the answer window is one minute.
    env.bot.now = () => new Date(Date.now() + 120_000)
    await env.bot.handleUpdate(message({ text: 'ну и ладно', messageId: 8 }))
    await env.bot.worker

    assert.equal(env.journal.get(parked.id).status, STATUS.expired)
    assert.ok(env.platform.sent.some((entry) => /время ожидания истекло/.test(entry.markdown)))
    assert.equal(runner.calls.length, 2, 'the late message started a fresh task')
    assert.equal(env.journal.recent(1)[0].status, STATUS.done)
  } finally {
    await env.close()
  }
})

test('/cancel drops the open question', async () => {
  const env = await createBotHarness({ runner: scriptedRunner(['ВОПРОС: что дальше?']) })
  try {
    await env.bot.handleUpdate(message({ text: 'задача' }))
    await env.bot.worker
    const parked = env.journal.recent(1)[0]
    await env.bot.handleUpdate(message({ text: '/cancel', messageId: 8 }))
    assert.equal(env.state.get('await:42'), undefined)
    assert.equal(env.journal.get(parked.id).status, STATUS.cancelled)
  } finally {
    await env.close()
  }
})

test('/tasks and /task show the journal, /retry re-runs the request', async () => {
  const runner = scriptedRunner(['Готово: файл в outbox/отчёт.docx'])
  const env = await createBotHarness({ runner })
  try {
    await env.bot.handleUpdate(message({ text: 'собери отчёт по продажам' }))
    await env.bot.worker
    const id = env.journal.recent(1)[0].id

    await env.bot.handleUpdate(message({ text: '/tasks' }))
    const list = env.platform.sent.at(-1).markdown
    assert.match(list, /Последние 1 задач/)
    assert.match(list, new RegExp(id))
    assert.match(list, /выполнена/)

    await env.bot.handleUpdate(message({ text: `/task ${id}` }))
    const details = env.platform.sent.at(-1).markdown
    assert.match(details, /собери отчёт по продажам/)
    assert.match(details, /Токены/)

    await env.bot.handleUpdate(message({ text: `/retry ${id}` }))
    await env.bot.worker
    assert.equal(runner.calls.length, 2)
    // The stored request is replayed; the dialogue directive is appended to it.
    assert.match(runner.calls[1].task, /^собери отчёт по продажам/)
    assert.equal(env.journal.recent(1)[0].retryOf, id)
  } finally {
    await env.close()
  }
})

test('/usage reports days in tokens and money', async () => {
  const env = await createBotHarness({ runner: scriptedRunner(['Готово']) })
  try {
    await env.bot.handleUpdate(message({ text: 'посчитай что-нибудь' }))
    await env.bot.worker
    await env.bot.handleUpdate(message({ text: '/usage' }))
    const text = env.platform.sent.at(-1).markdown
    assert.match(text, /Расход/)
    assert.match(text, /токенов/)
    assert.match(text, /\$/)
    assert.match(text, /Сегодня задач: 1/)
  } finally {
    await env.close()
  }
})

test('crossing the daily threshold sends one alert, not one per task', async () => {
  const env = await createBotHarness({
    runner: {
      async run() {
        return result({ usage: { ...OK_USAGE, totalTokens: 900_000, inputTokens: 900_000, outputTokens: 0 } })
      },
    },
    configEnv: { DAILY_TOKEN_LIMIT: '1000000', ALERT_ON_LIMIT_PERCENT: '80' },
  })
  try {
    await env.bot.handleUpdate(message({ text: 'задача раз' }))
    await env.bot.worker
    const alerts = env.platform.sent.filter((entry) => /Израсходовано/.test(entry.markdown))
    assert.equal(alerts.length, 1)

    await env.bot.handleUpdate(message({ text: 'задача два', messageId: 8 }))
    await env.bot.worker
    assert.equal(env.platform.sent.filter((entry) => /Израсходовано/.test(entry.markdown)).length, 1, 'one alert per day')
  } finally {
    await env.close()
  }
})

test('the daily limit stops a parked task from resuming', async () => {
  const runner = scriptedRunner(['ВОПРОС: какой формат?'])
  const env = await createBotHarness({ runner, configEnv: { DAILY_TOKEN_LIMIT: '1000' } })
  try {
    await env.bot.handleUpdate(message({ text: 'задача' }))
    await env.bot.worker
    env.usage.record({ usage: { prompt_tokens: 2000, completion_tokens: 0 }, userId: '42', chatId: 42 })

    await env.bot.handleUpdate(message({ text: 'любой', messageId: 8 }))
    await env.bot.worker
    assert.equal(runner.calls.length, 1, 'the continuation never reached DSH')
    assert.ok(env.platform.sent.some((entry) => /лимит токенов исчерпан/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})
