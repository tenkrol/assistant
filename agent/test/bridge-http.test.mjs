import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBridgeServer } from '../src/bridge-http.mjs'
import { loadConfig } from '../src/config.mjs'
import { createBotHarness, createTestLogger } from './helpers.mjs'

const base = { TELEGRAM_BOT_TOKEN: '1:a', ALLOWED_USER_IDS: '42' }
const TOKEN = 'bridge-secret-token'

/** Start a bridge on a free port and return its URL plus the recorded calls. */
async function startBridge({ token = TOKEN, onSubmit } = {}) {
  const seen = []
  const server = createBridgeServer({
    token,
    port: 0,
    maxTaskChars: 200,
    logger: createTestLogger(),
    onSubmit: onSubmit ?? (async (request) => {
      seen.push(request)
      return { taskId: 'task-1' }
    }),
  })
  const address = await server.start()
  return { server, seen, url: `http://127.0.0.1:${address.port}` }
}

test('the bridge configuration needs a token to be enabled', () => {
  const off = loadConfig(base)
  assert.equal(off.bridge.http, true)
  assert.equal(off.bridge.token, '')
  assert.equal(off.bridge.bind, '127.0.0.1')

  const on = loadConfig({ ...base, BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: '9100' })
  assert.equal(on.bridge.token, TOKEN)
  assert.equal(on.bridge.port, 9100)
  assert.throws(() => loadConfig({ ...base, BRIDGE_PORT: '70000' }), /BRIDGE_PORT/)
})

test('health answers without a secret, unknown paths do not', async () => {
  const { server, url } = await startBridge()
  try {
    const health = await fetch(`${url}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, service: 'agent-bridge' })
    const missing = await fetch(`${url}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await server.stop()
  }
})

test('a request without the token is refused, and nothing is queued', async () => {
  const { server, seen, url } = await startBridge()
  try {
    const response = await fetch(`${url}/bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'сделай отчёт' }),
    })
    assert.equal(response.status, 401)
    assert.equal(seen.length, 0)
  } finally {
    await server.stop()
  }
})

test('an authorised task is queued and its id comes back', async () => {
  const { server, seen, url } = await startBridge()
  try {
    const response = await fetch(`${url}/bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ task: 'собери отчёт по продажам за октябрь', source: 'chat-bot' }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true, taskId: 'task-1' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].task, 'собери отчёт по продажам за октябрь')
    assert.equal(seen[0].source, 'chat-bot')
  } finally {
    await server.stop()
  }
})

test('an empty or oversized task is refused before queuing', async () => {
  const { server, seen, url } = await startBridge()
  try {
    const header = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
    const empty = await fetch(`${url}/bridge`, { method: 'POST', headers: header, body: JSON.stringify({ task: '   ' }) })
    assert.equal(empty.status, 400)
    const long = await fetch(`${url}/bridge`, { method: 'POST', headers: header, body: JSON.stringify({ task: 'я'.repeat(300) }) })
    assert.equal(long.status, 400)
    assert.equal(seen.length, 0)
  } finally {
    await server.stop()
  }
})

test('broken json and a broken submission are reported, not thrown', async () => {
  const { server, url } = await startBridge({
    onSubmit: async () => {
      throw new Error('очередь заполнена')
    },
  })
  try {
    const header = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
    const broken = await fetch(`${url}/bridge`, { method: 'POST', headers: header, body: '{ не json' })
    assert.equal(broken.status, 400)
    const failed = await fetch(`${url}/bridge`, { method: 'POST', headers: header, body: JSON.stringify({ task: 'задача' }) })
    assert.equal(failed.status, 500)
    assert.match((await failed.json()).error, /очередь заполнена/)
  } finally {
    await server.stop()
  }
})

test('a bridged task is queued for the owner and answered privately', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: {
      async run(request) {
        calls.push(request)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'Готово', sessionId: 's1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 100 }
      },
    },
  })
  try {
    const { taskId } = await env.bot.submitBridgedTask({ task: 'сделай отчёт в xlsx', source: 'chat-bot' })
    await env.bot.worker

    assert.equal(calls.length, 1)
    assert.match(calls[0].task, /сделай отчёт в xlsx/)
    assert.equal(calls[0].task.includes('предложи 2–3 варианта'), false, 'a bridged task never offers variants')

    const record = env.journal.get(taskId)
    assert.equal(record.chatId, '42', 'the result goes to the owner')
    assert.equal(record.userId, '42')
    assert.match(record.brief, /^🔗 /)
    assert.ok(env.platform.sent.some((entry) => /пришла из чата-бота/.test(entry.markdown)), 'the owner is told where it came from')
  } finally {
    await env.close()
  }
})

test('a bridged task starts fresh instead of inheriting the owner conversation', async () => {
  const sessions = []
  const env = await createBotHarness({
    runner: {
      async run(request) {
        sessions.push(request.sessionId)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'ок', sessionId: 'session-bridge', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 50 }
      },
    },
  })
  try {
    // The owner has a long-running conversation in the private chat.
    env.state.set('session:42', 'session-owner')

    await env.bot.submitBridgedTask({ task: 'сделай отчёт' })
    await env.bot.worker

    assert.deepEqual(sessions, [undefined], 'no context is inherited')
    assert.equal(env.state.get('session:42'), 'session-owner', 'and the stored session is untouched')
  } finally {
    await env.close()
  }
})

test('a full queue refuses a bridged task with a readable reason', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await createBotHarness({
    runner: {
      async run({ signal }) {
        await Promise.race([gate, new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))])
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'ок', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    await env.bot.submitBridgedTask({ task: 'первая' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await env.bot.submitBridgedTask({ task: 'вторая' })
    await env.bot.submitBridgedTask({ task: 'третья' })
    await env.bot.submitBridgedTask({ task: 'четвёртая' })
    await assert.rejects(() => env.bot.submitBridgedTask({ task: 'пятая' }), /очередь заполнена/)
    release()
    await env.bot.worker
  } finally {
    await env.close()
  }
})
