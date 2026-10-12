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

/** A runner that records every call and succeeds. */
function recordingRunner(usage = OK_USAGE) {
  const calls = []
  return {
    calls,
    async run(request) {
      calls.push(request)
      return result({ usage })
    },
  }
}

test('a due schedule runs its task and moves to the next occurrence', async () => {
  const runner = recordingRunner()
  const env = await createBotHarness({ runner })
  try {
    const record = await env.schedules.add({ chatId: 42, userId: 42, cron: '0 9 * * *', task: 'собери сводку по продажам' })
    await env.schedules.update(record.id, { nextRunAt: Date.now() - 60_000 })
    env.bot.lastScheduleAt = 0

    assert.equal(await env.bot.tickSchedules(), 1)
    await env.bot.worker

    assert.equal(runner.calls.length, 1)
    assert.match(runner.calls[0].task, /собери сводку по продажам/)
    // A recurring job runs unattended: the variants directive must not be there.
    assert.equal(/предложи 2–3 варианта/.test(runner.calls[0].task), false)

    const updated = env.schedules.get(record.id)
    assert.equal(updated.runs, 1)
    assert.ok(updated.nextRunAt > Date.now(), 'the next run is in the future')

    const journal = env.journal.recent(1)[0]
    assert.equal(journal.scheduledFrom, record.id)
    assert.equal(journal.status, STATUS.done)
    assert.ok(env.platform.sent.some((entry) => /по расписанию/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('a disabled schedule does not fire', async () => {
  const runner = recordingRunner()
  const env = await createBotHarness({ runner })
  try {
    const record = await env.schedules.add({ chatId: 42, cron: '0 9 * * *', task: 'не должна' })
    await env.schedules.update(record.id, { enabled: false, nextRunAt: Date.now() - 60_000 })
    env.bot.lastScheduleAt = 0

    assert.equal(await env.bot.tickSchedules(), 0)
    assert.equal(runner.calls.length, 0)
  } finally {
    await env.close()
  }
})

test('the tick respects its own interval', async () => {
  const runner = recordingRunner()
  const env = await createBotHarness({ runner })
  try {
    const record = await env.schedules.add({ chatId: 42, cron: '* * * * *', task: 'каждую минуту' })
    await env.schedules.update(record.id, { nextRunAt: Date.now() - 1000 })
    env.bot.lastScheduleAt = 0
    assert.equal(await env.bot.tickSchedules(), 1)
    await env.bot.worker

    // The same schedule is due again, but the tick interval has not passed.
    await env.schedules.update(record.id, { nextRunAt: Date.now() - 1000 })
    assert.equal(await env.bot.tickSchedules(), 0)
  } finally {
    await env.close()
  }
})

test('a late run is noted, and the schedule does not fire twice for it', async () => {
  const runner = recordingRunner()
  const env = await createBotHarness({ runner })
  try {
    const record = await env.schedules.add({ chatId: 42, cron: '0 9 * * *', task: 'сводка' })
    await env.schedules.update(record.id, { nextRunAt: Date.now() - 3 * 3600_000 })
    env.bot.lastScheduleAt = 0

    await env.bot.tickSchedules()
    await env.bot.worker
    const updated = env.schedules.get(record.id)
    assert.equal(updated.runs, 1, 'one run for one missed occurrence')
    assert.equal(updated.missed, 1)
    assert.ok(updated.lastLateMinutes >= 170)
  } finally {
    await env.close()
  }
})

test('a restart recomputes the next run and reports the missed ones once', async () => {
  const runner = recordingRunner()
  const env = await createBotHarness({ runner })
  try {
    const record = await env.schedules.add({ chatId: 42, cron: '0 9 * * *', task: 'сводка' })
    await env.schedules.update(record.id, { nextRunAt: Date.now() - 2 * 86_400_000 })

    // A restart is what calls refresh: same store, fresh process semantics.
    const missed = await env.schedules.refresh(new Date())
    assert.equal(missed, 1)
    assert.ok(env.schedules.get(record.id).nextRunAt > Date.now())
    assert.equal(runner.calls.length, 0, 'a restart must not fire anything by itself')
  } finally {
    await env.close()
  }
})

test('/schedule add, list, off, run and del work end to end', async () => {
  const runner = recordingRunner()
  const env = await createBotHarness({ runner })
  try {
    await env.bot.handleUpdate(message({ text: '/schedule add "0 9 * * 1-5" собери сводку и пришли файлом' }))
    const created = env.platform.sent.at(-1).markdown
    assert.match(created, /Расписание s[0-9a-z]+ создано/)
    assert.match(created, /по будням в 09:00/)
    assert.match(created, /Следующий запуск/)

    const id = env.schedules.all()[0].id

    await env.bot.handleUpdate(message({ text: '/schedule' }))
    const list = env.platform.sent.at(-1).markdown
    assert.match(list, new RegExp(id))
    assert.match(list, /по будням в 09:00/)
    assert.match(list, /выполнено 0/)

    await env.bot.handleUpdate(message({ text: `/schedule off ${id}` }))
    assert.equal(env.schedules.get(id).enabled, false)
    assert.match(env.platform.sent.at(-1).markdown, /выключено/)

    await env.bot.handleUpdate(message({ text: `/schedule run ${id}` }))
    await env.bot.worker
    assert.equal(runner.calls.length, 1, 'run now works even while disabled')
    assert.match(runner.calls[0].task, /собери сводку/)

    await env.bot.handleUpdate(message({ text: `/schedule del ${id}` }))
    assert.equal(env.schedules.all().length, 0)
    assert.match(env.platform.sent.at(-1).markdown, /удалено/)
  } finally {
    await env.close()
  }
})

test('a broken cron expression is answered with the reason, not a crash', async () => {
  const env = await createBotHarness()
  try {
    await env.bot.handleUpdate(message({ text: '/schedule add "0 99 * * *" задача' }))
    const answer = env.platform.sent.at(-1).markdown
    assert.match(answer, /Не понял расписание/)
    assert.match(answer, /часы/)
    assert.equal(env.schedules.all().length, 0)
  } finally {
    await env.close()
  }
})

test('the schedule list explains how to start when empty', async () => {
  const env = await createBotHarness()
  try {
    await env.bot.handleUpdate(message({ text: '/schedule' }))
    assert.match(env.platform.sent.at(-1).markdown, /Расписаний нет/)
    assert.match(env.platform.sent.at(-1).markdown, /\/schedule add/)
  } finally {
    await env.close()
  }
})
