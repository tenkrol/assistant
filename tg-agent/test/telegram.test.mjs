import assert from 'node:assert/strict'
import test from 'node:test'
import { TelegramClient, TelegramError } from '../src/telegram.mjs'
import { createTelegramStub } from './helpers.mjs'

const makeClient = (stub, options = {}) =>
  new TelegramClient({
    token: 'test-token',
    apiBase: stub.apiBase,
    maxAttempts: 3,
    sleep: async () => {},
    logger: { warn() {}, debug() {}, info() {}, error() {} },
    ...options,
  })

test('returns the result of a successful call', async () => {
  const stub = await createTelegramStub()
  try {
    const client = makeClient(stub)
    const me = await client.getMe()
    assert.equal(me.username, 'test_bot')
    assert.equal(stub.state.calls[0].method, 'getMe')
  } finally {
    await stub.close()
  }
})

test('retries a 429 after the retry_after delay', async () => {
  const sleeps = []
  let attempts = 0
  const stub = await createTelegramStub({
    script: (method) => {
      if (method !== 'sendMessage') return undefined
      attempts++
      if (attempts === 1) return { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } } }
      return { status: 200, body: { ok: true, result: { message_id: 1 } } }
    },
  })
  try {
    const client = makeClient(stub, { sleep: async (ms) => { sleeps.push(ms) } })
    const result = await client.sendMessage({ chatId: 1, text: 'hi' })
    assert.equal(result.message_id, 1)
    assert.equal(attempts, 2)
    assert.deepEqual(sleeps, [2000])
  } finally {
    await stub.close()
  }
})

test('retries a 5xx with backoff and then succeeds', async () => {
  let attempts = 0
  const sleeps = []
  const stub = await createTelegramStub({
    script: (method) => {
      if (method !== 'getMe') return undefined
      attempts++
      if (attempts < 3) return { status: 502, body: { ok: false, description: 'Bad Gateway' } }
      return undefined
    },
  })
  try {
    const client = makeClient(stub, { sleep: async (ms) => { sleeps.push(ms) } })
    const me = await client.getMe()
    assert.equal(me.id, 42)
    assert.equal(attempts, 3)
    assert.deepEqual(sleeps, [500, 1000])
  } finally {
    await stub.close()
  }
})

test('does not retry a 400 and surfaces the description', async () => {
  let attempts = 0
  const stub = await createTelegramStub({
    script: (method) => {
      if (method !== 'sendMessage') return undefined
      attempts++
      return { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }
    },
  })
  try {
    const client = makeClient(stub)
    await assert.rejects(
      () => client.sendMessage({ chatId: 1, text: '<b>' }),
      (error) => {
        assert.ok(error instanceof TelegramError)
        assert.equal(error.status, 400)
        assert.match(error.description, /can't parse entities/)
        return true
      },
    )
    assert.equal(attempts, 1)
  } finally {
    await stub.close()
  }
})

test('reports a network failure after exhausting the attempts', async () => {
  const stub = await createTelegramStub()
  const apiBase = stub.apiBase
  await stub.close()
  const client = makeClient({ apiBase }, { sleep: async () => {} })
  await assert.rejects(() => client.getMe(), (error) => {
    assert.ok(error instanceof TelegramError)
    assert.match(error.message, /after 3 attempts/)
    return true
  })
})

test('getUpdates passes the long-poll window and returns an empty array when idle', async () => {
  const stub = await createTelegramStub()
  try {
    const client = makeClient(stub)
    const updates = await client.getUpdates({ offset: 5, timeoutSec: 1 })
    assert.deepEqual(updates, [])
    const call = stub.state.calls.find((c) => c.method === 'getUpdates')
    assert.equal(call.payload.offset, 5)
    assert.equal(call.payload.timeout, 1)
    // `callback_query` carries inline-button taps, so it must be subscribed to.
    assert.deepEqual(call.payload.allowed_updates, ['message', 'edited_message', 'callback_query'])
  } finally {
    await stub.close()
  }
})
