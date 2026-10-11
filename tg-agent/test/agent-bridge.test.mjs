import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_TOOL_NAME, createAgentBridge } from '../src/agent-bridge.mjs'

const TOKEN = 'bridge-secret-token'
const URL = 'http://127.0.0.1:8787/bridge'

/** A fetch stub that records the request and answers with `body`. */
function stubFetch({ ok = true, status = 202, body = { ok: true, taskId: 'task-1' }, delayError } = {}) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    if (delayError) throw delayError
    return { ok, status, json: async () => body }
  }
  impl.calls = calls
  return impl
}

const silent = { warn: () => {}, info: () => {} }

test('the bridge is inert without a token', async () => {
  const fetchImpl = stubFetch()
  const bridge = createAgentBridge({ url: URL, token: '', fetchImpl, logger: silent })
  assert.equal(bridge.enabled, false)
  assert.deepEqual(bridge.definitions, [])
  const answer = await bridge.execute(AGENT_TOOL_NAME, { task: 'сделай отчёт' })
  assert.match(answer, /не настроен/)
  assert.equal(fetchImpl.calls.length, 0, 'nothing leaves the process')
})

test('the bridge is off on platforms that are not Telegram', () => {
  const bridge = createAgentBridge({ url: URL, token: TOKEN, platformName: 'vk' })
  assert.equal(bridge.enabled, false)
  assert.deepEqual(bridge.definitions, [])
})

test('a configured bridge exposes exactly one tool', () => {
  const bridge = createAgentBridge({ url: URL, token: TOKEN })
  assert.equal(bridge.enabled, true)
  assert.equal(bridge.definitions.length, 1)
  assert.equal(bridge.definitions[0].function.name, AGENT_TOOL_NAME)
  assert.deepEqual(bridge.definitions[0].function.parameters.required, ['task'])
})

test('a task is posted to the bridge endpoint with the bearer token', async () => {
  const fetchImpl = stubFetch()
  const bridge = createAgentBridge({ url: URL, token: TOKEN, fetchImpl, logger: silent })
  const answer = await bridge.execute(AGENT_TOOL_NAME, { task: 'собери отчёт по продажам в xlsx' })

  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, URL)
  assert.equal(fetchImpl.calls[0].options.method, 'POST')
  assert.equal(fetchImpl.calls[0].options.headers.authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(fetchImpl.calls[0].body, { task: 'собери отчёт по продажам в xlsx', source: 'chat-bot' })
  assert.match(answer, /Задача task-1 передана агенту/)
  assert.match(answer, /@Tenkrol_ag_bot/)
})

test('an empty task is refused without calling the agent', async () => {
  const fetchImpl = stubFetch()
  const bridge = createAgentBridge({ url: URL, token: TOKEN, fetchImpl, logger: silent })
  const answer = await bridge.execute(AGENT_TOOL_NAME, { task: '   ' })
  assert.equal(fetchImpl.calls.length, 0)
  assert.match(answer, /пустой текст/)
})

test('a very long task is trimmed to the configured budget', async () => {
  const fetchImpl = stubFetch()
  const bridge = createAgentBridge({ url: URL, token: TOKEN, fetchImpl, logger: silent, maxTaskChars: 50 })
  await bridge.execute(AGENT_TOOL_NAME, { task: 'я'.repeat(500) })
  assert.equal(fetchImpl.calls[0].body.task.length, 50)
})

test('a rejection from the agent is reported, not thrown', async () => {
  const fetchImpl = stubFetch({ ok: false, status: 401, body: { ok: false, error: 'unauthorized' } })
  const bridge = createAgentBridge({ url: URL, token: TOKEN, fetchImpl, logger: silent })
  const answer = await bridge.execute(AGENT_TOOL_NAME, { task: 'задача' })
  assert.match(answer, /не принял задачу/i)
})

test('an unreachable bridge is reported, not thrown', async () => {
  const bridge = createAgentBridge({
    url: URL,
    token: TOKEN,
    fetchImpl: stubFetch({ delayError: new Error('ECONNREFUSED') }),
    logger: silent,
  })
  const answer = await bridge.execute(AGENT_TOOL_NAME, { task: 'задача' })
  assert.match(answer, /недоступен/i)
})

test('another tool name is refused', async () => {
  const fetchImpl = stubFetch()
  const bridge = createAgentBridge({ url: URL, token: TOKEN, fetchImpl, logger: silent })
  const answer = await bridge.execute('web_search', { query: 'x' })
  assert.match(answer, /не поддерживается/)
  assert.equal(fetchImpl.calls.length, 0)
})
