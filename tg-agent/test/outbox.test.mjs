/**
 * Outbox: the endpoint the task agent posts finished work to.
 *
 * The tests pin the security-relevant behaviour: no token means no server, a wrong
 * token is refused, oversized bodies are rejected before they are read, and only
 * loopback is bound.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutbox, sameToken } from '../src/outbox.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** Start an outbox on an ephemeral port and return a small helper around it. */
async function startOutbox(options = {}) {
  const delivered = []
  const outbox = createOutbox({
    token: 'test-token-abc',
    deliver: async (message) => {
      if (options.failDelivery) throw new Error('канал недоступен')
      delivered.push(message)
      return { chatId: message.chatId ?? 433296567, messageId: 42 }
    },
    port: 0,
    logger: silent,
  })
  const port = await outbox.start()
  const base = `http://127.0.0.1:${port}`
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { outbox, port, base, delivered, post, stop: () => outbox.stop() }
}

test('without a token the server is not created at all', () => {
  assert.throws(() => createOutbox({ deliver: async () => {}, token: '' }), /токен/)
  assert.throws(() => createOutbox({ token: 'x' }), /deliver/)
})

test('healthz answers without a token', async () => {
  const ctx = await startOutbox()
  try {
    const response = await fetch(`${ctx.base}/healthz`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    await ctx.stop()
  }
})

test('a post without a token is refused and nothing is delivered', async () => {
  const ctx = await startOutbox()
  try {
    const response = await ctx.post('/outbox', { text: 'привет' })
    assert.equal(response.status, 401)
    assert.equal(ctx.delivered.length, 0)
  } finally {
    await ctx.stop()
  }
})

test('a post with a wrong token is refused', async () => {
  const ctx = await startOutbox()
  try {
    const response = await ctx.post('/outbox', { text: 'привет' }, { authorization: 'Bearer wrong-token' })
    assert.equal(response.status, 401)
    assert.equal(ctx.delivered.length, 0)
  } finally {
    await ctx.stop()
  }
})

test('a correct token delivers the text and answers with the chat', async () => {
  const ctx = await startOutbox()
  try {
    const response = await ctx.post('/outbox', { text: '  Отчёт готов  ', title: 'Задача' }, { authorization: 'Bearer test-token-abc' })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.chatId, 433296567)
    assert.equal(ctx.delivered.length, 1)
    assert.equal(ctx.delivered[0].text, 'Отчёт готов', 'текст обрезан по краям')
    assert.equal(ctx.delivered[0].title, 'Задача')
  } finally {
    await ctx.stop()
  }
})

test('an explicit chat is passed through', async () => {
  const ctx = await startOutbox()
  try {
    await ctx.post('/outbox', { text: 'текст', chatId: 396122626 }, { authorization: 'Bearer test-token-abc' })
    assert.equal(ctx.delivered[0].chatId, 396122626)
  } finally {
    await ctx.stop()
  }
})

test('an empty text is refused', async () => {
  const ctx = await startOutbox()
  try {
    assert.equal((await ctx.post('/outbox', { text: '   ' }, { authorization: 'Bearer test-token-abc' })).status, 400)
    assert.equal((await ctx.post('/outbox', {}, { authorization: 'Bearer test-token-abc' })).status, 400)
    assert.equal((await ctx.post('/outbox', 'не-json', { authorization: 'Bearer test-token-abc' })).status, 400)
    assert.equal(ctx.delivered.length, 0)
  } finally {
    await ctx.stop()
  }
})

test('an oversized body is refused with 413', async () => {
  const ctx = await startOutbox()
  try {
    const huge = 'я'.repeat(40 * 1024)
    const response = await ctx.post('/outbox', { text: huge }, { authorization: 'Bearer test-token-abc' })
    assert.equal(response.status, 413)
    assert.equal(ctx.delivered.length, 0, 'огромное сообщение не доставляется')
  } finally {
    await ctx.stop()
  }
})

test('unknown paths and methods are answered, not ignored', async () => {
  const ctx = await startOutbox()
  try {
    assert.equal((await fetch(`${ctx.base}/другое`)).status, 404)
    assert.equal((await fetch(`${ctx.base}/outbox`)).status, 405)
  } finally {
    await ctx.stop()
  }
})

test('a delivery failure is reported as 500 and logged', async () => {
  const ctx = await startOutbox({ failDelivery: true })
  try {
    const response = await ctx.post('/outbox', { text: 'текст' }, { authorization: 'Bearer test-token-abc' })
    assert.equal(response.status, 500)
    assert.match((await response.json()).error, /доставить/)
  } finally {
    await ctx.stop()
  }
})

test('the server binds loopback only', async () => {
  const ctx = await startOutbox()
  try {
    const address = ctx.outbox.server.address()
    assert.equal(address.address, '127.0.0.1', 'наружу не слушаем')
    assert.ok(address.port > 0)
  } finally {
    await ctx.stop()
  }
})

test('the token comparison does not fall over on wrong lengths', () => {
  assert.equal(sameToken('abc', 'abc'), true)
  assert.equal(sameToken('abc', 'abcd'), false)
  assert.equal(sameToken('', ''), false, 'пустой токен не совпадает ни с чем')
  assert.equal(sameToken(undefined, 'abc'), false)
})
