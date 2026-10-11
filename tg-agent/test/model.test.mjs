import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatModel, ModelError } from '../src/model.mjs'
import { createModelStub } from './helpers.mjs'

const makeClient = (stub, options = {}) =>
  new ChatModel({
    baseUrl: stub.baseUrl,
    apiKey: 'sk-test',
    name: 'deepseek-chat',
    maxAttempts: 3,
    sleep: async () => {},
    logger: { warn() {}, debug() {}, info() {}, error() {} },
    ...options,
  })

test('sends the conversation and returns the assistant text', async () => {
  const stub = await createModelStub({ responses: [{ content: 'привет!' }] })
  try {
    const model = makeClient(stub)
    const result = await model.complete({ messages: [{ role: 'user', content: 'привет' }] })
    assert.equal(result.text, 'привет!')
    assert.equal(result.usage.total_tokens, 30)
    const [request] = stub.state.requests
    assert.equal(request.url, '/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer sk-test')
    assert.equal(request.payload.model, 'deepseek-chat')
    assert.equal(request.payload.stream, false)
    assert.deepEqual(request.payload.messages, [{ role: 'user', content: 'привет' }])
  } finally {
    await stub.close()
  }
})

test('passes temperature and max tokens when configured', async () => {
  const stub = await createModelStub()
  try {
    const model = makeClient(stub, { temperature: 0.3, maxTokens: 512 })
    await model.complete({ messages: [{ role: 'user', content: 'x' }] })
    assert.equal(stub.state.requests[0].payload.temperature, 0.3)
    assert.equal(stub.state.requests[0].payload.max_tokens, 512)
  } finally {
    await stub.close()
  }
})

test('honours a per-chat model override', async () => {
  const stub = await createModelStub()
  try {
    const model = makeClient(stub)
    await model.complete({ messages: [{ role: 'user', content: 'x' }], model: 'deepseek-reasoner' })
    assert.equal(stub.state.requests[0].payload.model, 'deepseek-reasoner')
  } finally {
    await stub.close()
  }
})

test('reports a rejected key without retrying', async () => {
  const stub = await createModelStub({ responses: [{ status: 401, message: 'invalid api key' }] })
  try {
    const model = makeClient(stub)
    await assert.rejects(() => model.complete({ messages: [] }), (error) => {
      assert.ok(error instanceof ModelError)
      assert.equal(error.status, 401)
      assert.match(error.message, /rejected the API key/)
      assert.match(error.message, /invalid api key/)
      return true
    })
    assert.equal(stub.state.requests.length, 1)
  } finally {
    await stub.close()
  }
})

test('retries a 500 and succeeds on the next attempt', async () => {
  const delays = []
  const stub = await createModelStub({ responses: [{ status: 500, message: 'boom' }, { content: 'готово' }] })
  try {
    const model = makeClient(stub, { sleep: async (ms) => { delays.push(ms) } })
    const result = await model.complete({ messages: [] })
    assert.equal(result.text, 'готово')
    assert.equal(stub.state.requests.length, 2)
    assert.deepEqual(delays, [1000])
  } finally {
    await stub.close()
  }
})

test('rejects a response without assistant text', async () => {
  const stub = await createModelStub({ responses: [{ content: undefined }] })
  try {
    const model = makeClient(stub)
    await assert.rejects(() => model.complete({ messages: [] }), (error) => {
      assert.ok(error instanceof ModelError)
      assert.match(error.message, /no assistant text/)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('gives up after the configured attempts', async () => {
  const stub = await createModelStub({ responses: [{ status: 503, message: 'unavailable' }] })
  try {
    const model = makeClient(stub, { sleep: async () => {}, maxAttempts: 2 })
    await assert.rejects(() => model.complete({ messages: [] }), (error) => {
      assert.ok(error instanceof ModelError)
      assert.match(error.message, /after 2 attempts/)
      return true
    })
    assert.equal(stub.state.requests.length, 2)
  } finally {
    await stub.close()
  }
})

test('runs a tool call and returns the final answer', async () => {
  const stub = await createModelStub({
    responses: [
      { toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'погода в Москве' } }] },
      { content: 'Сейчас +19 °C.' },
    ],
  })
  try {
    const model = makeClient(stub)
    const calls = []
    const result = await model.complete({
      messages: [{ role: 'user', content: 'погода?' }],
      tools: [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
      executeTool: async (name, args) => {
        calls.push({ name, args })
        return 'Источник: yandex.ru/pogoda — +19 °C'
      },
    })

    assert.equal(result.text, 'Сейчас +19 °C.')
    assert.equal(result.toolCalls, 1)
    assert.deepEqual(calls, [{ name: 'web_search', args: { query: 'погода в Москве' } }])
    assert.equal(stub.state.requests.length, 2)
    // The tool definitions are only sent while tools are offered.
    assert.equal(stub.state.requests[0].payload.tools.length, 1)
    const second = stub.state.requests[1].payload.messages
    assert.equal(second.at(-1).role, 'tool')
    assert.equal(second.at(-1).tool_call_id, 'call_1')
    assert.match(second.at(-1).content, /\+19 °C/)
    assert.equal(second.at(-2).role, 'assistant')
  } finally {
    await stub.close()
  }
})

test('sends no tools when the caller offers no executor', async () => {
  const stub = await createModelStub({ responses: [{ content: 'без инструментов' }] })
  try {
    const model = makeClient(stub)
    const result = await model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'web_search' } }] })
    assert.equal(result.text, 'без инструментов')
    assert.equal(result.toolCalls, 0)
    assert.equal(stub.state.requests[0].payload.tools, undefined)
  } finally {
    await stub.close()
  }
})

test('stops after the configured tool rounds', async () => {
  const stub = await createModelStub({
    responses: [
      { toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'a' } }] },
      { toolCalls: [{ id: 'c2', name: 'web_search', arguments: { query: 'b' } }] },
      { content: 'готово' },
    ],
  })
  try {
    const model = makeClient(stub)
    let executed = 0
    const result = await model.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'web_search' } }],
      executeTool: async () => { executed++; return 'результат' },
      maxToolRounds: 1,
    })
    assert.equal(executed, 1, 'one round means one executed call')
    assert.equal(result.toolCalls, 1)
    assert.equal(stub.state.requests.length, 2)
  } finally {
    await stub.close()
  }
})

test('survives a tool call with malformed JSON arguments', async () => {
  const stub = await createModelStub({
    responses: [
      { toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{not json' }] },
      { content: 'ответ' },
    ],
  })
  try {
    const model = makeClient(stub)
    const seen = []
    const result = await model.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'web_search' } }],
      executeTool: async (name, args) => { seen.push(args); return 'ok' },
    })
    assert.equal(result.text, 'ответ')
    assert.deepEqual(seen, [{}])
  } finally {
    await stub.close()
  }
})
