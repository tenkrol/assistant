/**
 * Контракт v2 с агентом на стороне ассистента: события, ack, дедупликация.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createOutbox } from '../src/outbox.mjs'
import { createAgentEventsStore } from '../src/storage/agent-events.mjs'
import { createAgentBridge } from '../src/integrations/agent-bridge/index.mjs'
import { createAgentLink } from '../src/agent-link/index.mjs'

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'agent-link-test-'))
const TOKEN = 'outbox-token'

async function startReceiver(overrides = {}) {
  const delivered = []
  const outbox = createOutbox({
    token: TOKEN,
    port: 0,
    logger: { info() {}, warn() {}, error() {} },
    deliver: async () => ({ chatId: 1, messageId: 2 }),
    deliverEvent: async (event) => { delivered.push(event) },
    ...overrides,
  })
  const port = await outbox.start()
  return { outbox, port, delivered, url: `http://127.0.0.1:${port}/outbox` }
}

const event = (eventId = 't1:result:1') => ({
  contract: 2,
  eventId,
  taskId: 't1',
  type: 'result',
  route: { platform: 'telegram', chatId: '42' },
  title: 'Ответ агента',
  text: 'готово',
})

test('a v2 event is delivered once and repeated event is acknowledged as duplicate', async () => {
  const { outbox, url, delivered } = await startReceiver({
    events: { seen: () => false, mark: async () => {} },
    deliverEvent: async (payload) => { delivered.push(payload) },
  })
  try {
    const send = () => fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(event()),
    })
    const first = await send()
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true, eventId: 't1:result:1', processed: true, duplicate: false })
    assert.equal(delivered.length, 1)

    // Повтор с тем же eventId: получатель уже обработал — сообщение не дублируется.
    const seenStore = {
      seen: () => true,
      mark: async () => {},
    }
    const second = await startReceiver({ events: seenStore, deliverEvent: async (payload) => { delivered.push(payload) } })
    try {
      const repeat = await fetch(second.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(event()),
      })
      assert.equal(repeat.status, 200)
      assert.equal((await repeat.json()).duplicate, true)
      assert.equal(delivered.length, 1)
    } finally {
      await second.outbox.stop()
    }
  } finally {
    await outbox.stop()
  }
})

test('a delivery failure is 5xx and does not mark the event', async () => {
  let marked = 0
  const { outbox, url } = await startReceiver({
    events: { seen: () => false, mark: async () => { marked += 1 } },
    deliverEvent: async () => { throw new Error('chat unavailable') },
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(event('t1:question:1')),
    })
    assert.equal(response.status, 500)
    assert.equal(marked, 0)
  } finally {
    await outbox.stop()
  }
})

test('legacy text delivery keeps working and needs no eventId', async () => {
  const delivered = []
  const { outbox, url } = await startReceiver({
    deliver: async (message) => { delivered.push(message); return { chatId: message.chatId, messageId: 7 } },
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'старый текст', title: 'Ответ агента' }),
    })
    assert.equal(response.status, 200)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].text, 'старый текст')
  } finally {
    await outbox.stop()
  }
})

test('the v2 client submits with requestId and route and can reply/cancel', async () => {
  const calls = []
  const bridge = createAgentBridge({
    url: 'http://agent.test/bridge',
    token: 'token',
    contract: 'v2',
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ ok: true, taskId: 'task-1', contract: 2 }) }
    },
  })
  assert.equal(bridge.contract, 'v2')
  const submitted = await bridge.submitTask({
    task: 'сделай отчёт',
    route: { platform: 'telegram', chatId: '42' },
    principal: { userId: '7', scopeId: 'personal-7' },
  })
  assert.equal(submitted.taskId, 'task-1')
  assert.equal(calls[0].url, 'http://agent.test/v1/tasks')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.contract, 2)
  assert.match(body.requestId, /[0-9a-f-]{36}/)
  assert.equal(body.route.chatId, '42')
  assert.deepEqual(body.principal, { userId: '7', scopeId: 'personal-7' })

  await bridge.replyTask('task-1', 'DOCX')
  assert.equal(calls[1].url, 'http://agent.test/v1/tasks/task-1/reply')
  await bridge.cancelTask('task-1')
  assert.equal(calls[2].url, 'http://agent.test/v1/tasks/task-1/cancel')
})

test('the ask_agent tool passes the route and revision id to the agent', async () => {
  const calls = []
  const bridge = createAgentBridge({
    url: 'http://agent.test',
    token: 'token',
    contract: 'v2',
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body })
      return { ok: true, status: 202, json: async () => ({ ok: true, taskId: 'task-9', contract: 2 }) }
    },
  })
  const answer = await bridge.execute('ask_agent', { task: 'сделай файл', revisionOf: 'old-1' }, {
    chatId: 42,
    userId: 7,
    botId: 999,
    replyTo: 7,
    attachments: [],
  })
  assert.match(answer, /task-9/)
  const body = JSON.parse(calls[0].body)
  assert.equal(body.route.chatId, '42')
  assert.equal(body.route.botId, '999')
  assert.deepEqual(body.principal, { userId: '7', scopeId: 'personal-7' })
  assert.equal(body.revisionOf, 'old-1')
})

test('pending question is answered through the contract and cleared', async () => {
  let pending = { taskId: 'task-1', question: 'какой формат?', askedAt: Date.now() }
  const calls = []
  const events = {
    pendingFor: () => pending,
    setPending: (_chatId, value) => { pending = value },
    clearPending: () => { pending = undefined },
  }
  const bridge = {
    enabled: true,
    replyTask: async (taskId, text) => { calls.push({ taskId, text }) },
    cancelTask: async (taskId) => { calls.push({ taskId, cancel: true }) },
  }
  const link = createAgentLink({ bridge, events })
  const outcome = await link.handleOwnerMessage({ chatId: 42, text: 'DOCX' })
  assert.equal(outcome.handled, true)
  assert.deepEqual(calls[0], { taskId: 'task-1', text: 'DOCX' })
  assert.equal(pending, undefined)

  pending = { taskId: 'task-1', askedAt: Date.now() }
  const cancelled = await link.handleOwnerMessage({ chatId: 42, text: 'отмена' })
  assert.match(cancelled.message, /отменил/)
  assert.equal(calls[1].cancel, true)
})

test('event journal survives a restart and pending questions are restored', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'agent-events.json')
    const first = await createAgentEventsStore({ file }).load()
    await first.mark('e1', { taskId: 't1', type: 'result' })
    await first.setPending('42', { taskId: 't1', question: 'какой формат?' })
    const second = await createAgentEventsStore({ file }).load()
    assert.equal(second.seen('e1'), true)
    assert.equal(second.pendingFor('42').taskId, 't1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
