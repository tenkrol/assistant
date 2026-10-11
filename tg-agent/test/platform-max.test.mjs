/**
 * MAX adapter tests.
 *
 * They run against a fake MAX API on 127.0.0.1, so the adapter exercises its
 * real fetch path without touching the network. The stub is local to this file:
 * `test/helpers.mjs` describes the Telegram and model stubs, and the MAX wire
 * format shares nothing with them beyond JSON.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  DEFAULT_UPDATE_TYPES,
  MaxError,
  MaxPlatform,
  createMaxPlatform,
  isCertificateError,
  markerFrom,
  splitMaxText,
  toMaxMarkdown,
  toAttachments,
} from '../src/platforms/max.mjs'

const silentLogger = { warn() {}, debug() {}, info() {}, error() {} }

const readBody = (request) =>
  new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
  })

const reply = (response, status, payload, headers = {}) => {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers })
  response.end(body)
}

/** Close a stub without waiting for undici's keep-alive sockets. */
const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  })

const defaultMe = { user_id: 42, first_name: 'Test Bot', username: 'test_bot', is_bot: true }

/**
 * Fake MAX API.
 *
 * `updateBatches` is a queue of `/updates` responses (the last one repeats);
 * `script(call, state)` may return `{status, body}` to force a failure.
 */
async function createMaxStub({ me = defaultMe, updateBatches = [], script } = {}) {
  const batches = [...updateBatches]
  const state = { requests: [], polls: [], sends: [], edits: [], answers: [], actions: [], lastBatch: undefined }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const raw = await readBody(request)
    const body = raw === '' ? {} : JSON.parse(raw)
    const call = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body,
    }
    state.requests.push(call)
    // Recorded before `script` runs, so a forced failure is visible as an
    // attempt (the adapter must not retry the ones it is not supposed to).
    if (request.method === 'GET' && url.pathname === '/updates') state.polls.push(call)
    if (request.method === 'POST' && url.pathname === '/messages') state.sends.push(call)
    if (request.method === 'PUT' && url.pathname === '/messages') state.edits.push(call)
    if (request.method === 'POST' && url.pathname === '/answers') state.answers.push(call)
    if (request.method === 'POST' && /^\/chats\/[^/]+\/actions$/.test(url.pathname)) state.actions.push(call)
    const override = script?.(call, state)
    if (override) return reply(response, override.status ?? 200, override.body, override.headers)

    if (request.method === 'GET' && url.pathname === '/me') return reply(response, 200, me)
    if (request.method === 'GET' && url.pathname === '/updates') {
      // The queue is drained once per response; the last one then repeats.
      state.lastBatch = batches.shift() ?? state.lastBatch ?? { updates: [] }
      const batch = state.lastBatch
      return reply(response, 200, { updates: batch.updates ?? [], marker: batch.marker ?? null })
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      return reply(response, 200, {
        message: {
          recipient: { chat_id: Number(call.query.chat_id), chat_type: 'dialog' },
          body: { mid: `mid.${state.sends.length}` },
        },
      })
    }
    if (request.method === 'PUT' && url.pathname === '/messages') return reply(response, 200, { success: true })
    if (request.method === 'POST' && url.pathname === '/answers') return reply(response, 200, { success: true })
    if (request.method === 'POST' && /^\/chats\/[^/]+\/actions$/.test(url.pathname)) return reply(response, 200, { success: true })
    return reply(response, 404, { code: 'not.found', message: `no route for ${request.method} ${url.pathname}` })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => closeServer(server),
  }
}

/** A `message_created` update with the documented MAX shape. */
function messageUpdate({
  updateType = 'message_created',
  timestamp = 1700000000000,
  chatType = 'dialog',
  chatId = 555,
  userId = 777,
  firstName = 'Иван',
  username = 'ivan',
  isBot = false,
  text = 'привет',
  mid = 'mid.1',
  markup,
  link,
  sender = true,
} = {}) {
  return {
    update_type: updateType,
    timestamp,
    message: {
      sender: sender ? { user_id: userId, first_name: firstName, username, is_bot: isBot } : null,
      recipient: { chat_id: chatId, chat_type: chatType, user_id: 42 },
      timestamp,
      link,
      body: { mid, seq: 1, text, markup },
    },
  }
}

/** A `message_callback` update, as MAX sends it for a button tap. */
function callbackUpdate({ timestamp = 1700000000000, chatType = 'dialog', chatId = 555, userId = 777, mid = 'mid.9', data = 'cancel:3' } = {}) {
  return {
    update_type: 'message_callback',
    timestamp,
    callback: {
      timestamp,
      callback_id: `cb-${data}`,
      payload: data,
      user: { user_id: userId, first_name: 'Иван', username: 'ivan', is_bot: false },
    },
    message: {
      sender: { user_id: 42, first_name: 'Test Bot', username: 'test_bot', is_bot: true },
      recipient: { chat_id: chatId, chat_type: chatType, user_id: userId },
      timestamp,
      body: { mid, seq: 2, text: 'напоминание' },
    },
  }
}

const makePlatform = (stub, options = {}) =>
  new MaxPlatform({
    token: 'secret-token',
    apiBase: stub?.apiBase,
    logger: silentLogger,
    sleep: async () => {},
    ...options,
  })

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

test('start() fills identity from GET /me and sends the token as a header', async () => {
  const stub = await createMaxStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    assert.deepEqual(platform.identity, { id: 42, username: 'test_bot', title: 'Test Bot' })
    assert.equal(platform.name, 'max')
    assert.equal(platform.namespace, 'max')
    const call = stub.state.requests.find((request) => request.path === '/me')
    assert.equal(call.method, 'GET')
    // Query-parameter auth was removed by MAX: the token must be a header.
    assert.equal(call.headers.authorization, 'secret-token')
    assert.equal(Object.keys(call.query).length, 0)
  } finally {
    await stub.close()
  }
})

test('start() uses the deprecated `name` when `first_name` is absent', async () => {
  const stub = await createMaxStub({ me: { user_id: 7, name: 'Legacy Bot', username: 'legacy' } })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    assert.deepEqual(platform.identity, { id: 7, username: 'legacy', title: 'Legacy Bot' })
  } finally {
    await stub.close()
  }
})

test('MAX_API_BASE and MAX_TOKEN override the defaults', async () => {
  const stub = await createMaxStub()
  const previousBase = process.env.MAX_API_BASE
  const previousToken = process.env.MAX_TOKEN
  process.env.MAX_API_BASE = stub.apiBase
  process.env.MAX_TOKEN = 'env-token'
  try {
    const platform = new MaxPlatform({ logger: silentLogger, sleep: async () => {} })
    await platform.start()
    assert.equal(platform.identity.id, 42)
    assert.equal(stub.state.requests[0].headers.authorization, 'env-token')
  } finally {
    if (previousBase === undefined) delete process.env.MAX_API_BASE
    else process.env.MAX_API_BASE = previousBase
    if (previousToken === undefined) delete process.env.MAX_TOKEN
    else process.env.MAX_TOKEN = previousToken
    await stub.close()
  }
})

test('a missing token is reported instead of sending `undefined`', async () => {
  const previousToken = process.env.MAX_TOKEN
  delete process.env.MAX_TOKEN
  try {
    const platform = new MaxPlatform({ apiBase: 'http://127.0.0.1:1', logger: silentLogger })
    await assert.rejects(() => platform.start(), (error) => {
      assert.ok(error instanceof MaxError)
      assert.match(error.message, /no access token/)
      return true
    })
  } finally {
    if (previousToken !== undefined) process.env.MAX_TOKEN = previousToken
  }
})

// ---------------------------------------------------------------------------
// getUpdates()
// ---------------------------------------------------------------------------

test('getUpdates passes timeout, limit and types, and sends marker only from the second call', async () => {
  const stub = await createMaxStub({ updateBatches: [{ updates: [messageUpdate()], marker: 101 }] })
  try {
    const platform = makePlatform(stub)
    await platform.start()

    const first = await platform.getUpdates({ timeoutSec: 25 })
    assert.equal(first.updates.length, 1)
    assert.equal(first.cursor, 101)
    const poll1 = stub.state.polls[0]
    assert.equal(poll1.query.timeout, '25')
    assert.equal(poll1.query.limit, '100')
    assert.equal(poll1.query.types, DEFAULT_UPDATE_TYPES.join(','))
    // Without a marker MAX returns only the latest update; the first poll must
    // therefore not send one at all.
    assert.equal('marker' in poll1.query, false)

    const second = await platform.getUpdates({ cursor: first.cursor, timeoutSec: 5 })
    const poll2 = stub.state.polls[1]
    assert.equal(poll2.query.marker, '101')
    assert.equal(poll2.query.timeout, '5')
    // The stub repeats the last batch, so the marker is stable.
    assert.equal(second.cursor, 101)
    assert.equal(second.updates.length, 1)
  } finally {
    await stub.close()
  }
})

test('getUpdates drops updates the adapter does not handle and keeps a null marker as the cursor', async () => {
  const stub = await createMaxStub({
    updateBatches: [{
      updates: [
        { update_type: 'bot_started', timestamp: 1, chat_id: 5, user: { user_id: 777 } },
        messageUpdate(),
        { update_type: 'chat_title_changed', timestamp: 3, chat_id: 5 },
      ],
      marker: null,
    }],
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const { updates, cursor } = await platform.getUpdates({ cursor: 55 })
    assert.equal(updates.length, 1)
    assert.equal(updates[0].kind, 'message')
    // `marker: null` means "nothing new to point at": keep the cursor we had.
    assert.equal(cursor, 55)
  } finally {
    await stub.close()
  }
})

test('the long-poll request gets a timeout budget above the server hold time', async () => {
  const stub = await createMaxStub()
  try {
    // 1 ms is the client-wide default; a long poll that inherited it would
    // abort long before the 2 s server-side hold time elapses.
    const platform = makePlatform(stub, { timeoutMs: 1 })
    const { updates } = await platform.getUpdates({ timeoutSec: 2 })
    assert.deepEqual(updates, [])
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// normalize()
// ---------------------------------------------------------------------------

test('normalizes a dialog message as addressed and private', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize(messageUpdate({ chatType: 'dialog', text: '  привет  ', mid: 'mid.77' }))
  assert.equal(update.kind, 'message')
  assert.equal(update.chat.type, 'private')
  assert.equal(update.chat.id, 555)
  assert.equal(update.addressed, true)
  assert.equal(update.text, 'привет')
  assert.equal(update.replyToMessageId, 'mid.77')
  assert.deepEqual(update.from, { id: 777, name: 'Иван', username: 'ivan', isBot: false })
  assert.equal(update.id, 1700000000000)
})

test('normalizes a group message: addressed only with a mention or a reply to the bot', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }

  const plain = platform.normalize(messageUpdate({ chatType: 'chat', chatId: 900, text: 'просто болтаю' }))
  assert.equal(plain.chat.type, 'group')
  assert.equal(plain.chat.id, 900)
  assert.equal(plain.addressed, false)

  const mentioned = platform.normalize(messageUpdate({
    chatType: 'chat',
    chatId: 900,
    text: 'тест бота @test_bot, помоги',
  }))
  assert.equal(mentioned.addressed, true)

  const mentionMarkup = platform.normalize(messageUpdate({
    chatType: 'chat',
    chatId: 900,
    text: 'помоги',
    markup: [{ type: 'user_mention', from: 0, length: 5, user_id: 42 }],
  }))
  assert.equal(mentionMarkup.addressed, true)

  const replied = platform.normalize(messageUpdate({
    chatType: 'chat',
    chatId: 900,
    text: 'а теперь?',
    link: { type: 'reply', sender: { user_id: 42, first_name: 'Test Bot', is_bot: true }, chat_id: 900, message: { mid: 'mid.5', seq: 3, text: 'ответ' } },
  }))
  assert.equal(replied.addressed, true)

  const replyToHuman = platform.normalize(messageUpdate({
    chatType: 'chat',
    chatId: 900,
    text: 'а теперь?',
    link: { type: 'reply', sender: { user_id: 778, first_name: 'Пётр', is_bot: false }, chat_id: 900, message: { mid: 'mid.5', seq: 3, text: 'ответ' } },
  }))
  assert.equal(replyToHuman.addressed, false)

  // A partial username must not count as a mention.
  const partial = platform.normalize(messageUpdate({ chatType: 'chat', chatId: 900, text: '@test_botik привет' }))
  assert.equal(partial.addressed, false)
})

test('treats message_edited as a regular message and ignores other update types', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const edited = platform.normalize(messageUpdate({ updateType: 'message_edited', chatType: 'dialog', text: 'исправлено' }))
  assert.equal(edited.kind, 'message')
  assert.equal(edited.text, 'исправлено')
  for (const type of ['bot_started', 'bot_added', 'message_removed', 'chat_title_changed', 'user_added', 'comment_created']) {
    assert.equal(platform.normalize({ update_type: type, timestamp: 1 }), undefined, type)
  }
  assert.equal(platform.normalize(null), undefined)
})

test('a channel post without a sender is ignored', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize(messageUpdate({ chatType: 'channel', sender: false, text: 'пост' }))
  assert.equal(update, undefined)
})

test('normalizes a callback with its id, payload and message id', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize(callbackUpdate({ chatType: 'chat', chatId: 900, userId: 777, mid: 'mid.42', data: 'snooze:5:1' }))
  assert.equal(update.kind, 'callback')
  assert.equal(update.chat.type, 'group')
  assert.equal(update.chat.id, 900)
  assert.equal(update.from.id, 777)
  assert.equal(update.from.isBot, false)
  assert.equal(update.addressed, true)
  assert.equal(update.text, '')
  assert.deepEqual(update.callback, { id: 'cb-snooze:5:1', data: 'snooze:5:1', messageId: 'mid.42' })
})

test('a callback whose message is gone still resolves, with an undefined messageId', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize({
    update_type: 'message_callback',
    timestamp: 5,
    callback: { callback_id: 'cb-1', payload: 'cancel:1', user: { user_id: 777, first_name: 'Иван', is_bot: false } },
    message: null,
  })
  assert.equal(update.kind, 'callback')
  assert.equal(update.callback.messageId, undefined)
  // The dialog of the user who tapped is the only chat we can name.
  assert.equal(update.chat.id, 777)
  assert.equal(update.chat.type, 'private')
})

// ---------------------------------------------------------------------------
// sendText()
// ---------------------------------------------------------------------------

test('sendText posts markdown with an inline keyboard and no link preview', async () => {
  const stub = await createMaxStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const result = await platform.sendText({
      chatId: 555,
      markdown: '**Готово** [сайт](https://example.com)',
      replyToMessageId: 'mid.7',
      keyboard: { rows: [[{ text: '✖️ Отменить', data: 'cancel:3' }, { text: 'Сайт', url: 'https://example.com' }]] },
    })
    assert.equal(result.messageId, 'mid.1')
    assert.equal(stub.state.sends.length, 1)
    const call = stub.state.sends[0]
    assert.equal(call.method, 'POST')
    assert.equal(call.path, '/messages')
    assert.equal(call.query.chat_id, '555')
    assert.equal(call.query.disable_link_preview, 'true')
    assert.equal(call.headers['content-type'], 'application/json')
    assert.equal(call.body.text, '**Готово** [сайт](https://example.com)')
    assert.equal(call.body.format, 'markdown')
    assert.equal(call.body.notify, true)
    assert.deepEqual(call.body.link, { type: 'reply', mid: 'mid.7' })
    assert.deepEqual(call.body.attachments, [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[
          { type: 'callback', text: '✖️ Отменить', payload: 'cancel:3' },
          { type: 'link', text: 'Сайт', url: 'https://example.com' },
        ]],
      },
    }])
  } finally {
    await stub.close()
  }
})

test('sendText splits long text and attaches the keyboard to the last chunk', async () => {
  const stub = await createMaxStub()
  const waits = []
  let clock = 0
  try {
    const platform = makePlatform(stub, {
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms },
    })
    await platform.start()
    const blocks = Array.from({ length: 120 }, (_, index) => `## Блок ${index}\n${'текст '.repeat(30)}`)
    const markdown = blocks.join('\n\n')
    assert.ok(markdown.length > 8000)

    const result = await platform.sendText({
      chatId: 555,
      markdown,
      keyboard: { rows: [[{ text: 'Ещё', data: 'more' }]] },
    })

    const sends = stub.state.sends
    assert.ok(sends.length >= 3, `expected several chunks, got ${sends.length}`)
    for (const call of sends) {
      assert.equal(call.body.format, 'markdown')
      assert.ok(call.body.text.length <= 4000, `chunk of ${call.body.text.length} exceeds the MAX limit`)
    }
    assert.equal(result.messageId, `mid.${sends.length}`)
    // Buttons only under the final chunk, otherwise they would sit mid-answer.
    assert.equal(sends.slice(0, -1).every((call) => call.body.attachments === undefined), true)
    assert.equal(sends.at(-1).body.attachments[0].payload.buttons[0][0].payload, 'more')
    // Two messages per second per chat: one 500 ms pause before each follow-up.
    assert.equal(waits.length, sends.length - 1)
    assert.equal(waits.every((ms) => ms >= 500), true)
  } finally {
    await stub.close()
  }
})

test('the send queue is per chat, so another chat is not delayed', async () => {
  const stub = await createMaxStub()
  const waits = []
  let clock = 0
  try {
    const platform = makePlatform(stub, {
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms },
    })
    await platform.start()
    await platform.sendText({ chatId: 555, markdown: 'первое' })
    await platform.sendText({ chatId: 555, markdown: 'второе' })
    assert.deepEqual(waits, [500])
    await platform.sendText({ chatId: 556, markdown: 'другому' })
    assert.deepEqual(waits, [500])
    assert.equal(stub.state.sends.length, 3)
  } finally {
    await stub.close()
  }
})

test('sendText addresses a dialog by user_id and a group by chat_id', async () => {
  const stub = await createMaxStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    platform.normalize(messageUpdate({ chatType: 'dialog', chatId: 555, userId: 777 }))
    platform.normalize(messageUpdate({ chatType: 'chat', chatId: 900, userId: 777 }))
    await platform.sendText({ chatId: 555, markdown: 'в диалог' })
    await platform.sendText({ chatId: 900, markdown: 'в группу' })
    assert.equal(stub.state.sends[0].query.user_id, '777')
    assert.equal(stub.state.sends[0].query.chat_id, undefined)
    assert.equal(stub.state.sends[1].query.chat_id, '900')
    assert.equal(stub.state.sends[1].query.user_id, undefined)
  } finally {
    await stub.close()
  }
})

test('a guessed dialog route falls back to chat_id when user_id is rejected', async () => {
  const stub = await createMaxStub({
    script: (call) => {
      if (call.method !== 'POST' || call.path !== '/messages') return undefined
      if (call.query.user_id !== undefined) {
        return { status: 400, body: { code: 'user.not.found', message: 'User not found' } }
      }
      return undefined
    },
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    // Seeing a dialog update makes the adapter prefer `user_id`…
    platform.normalize(messageUpdate({ chatType: 'dialog', chatId: 555, userId: 777 }))
    await platform.sendText({ chatId: 555, markdown: 'привет' })
    assert.equal(stub.state.sends.length, 2)
    assert.equal(stub.state.sends[0].query.user_id, '777')
    assert.equal(stub.state.sends[1].query.chat_id, '555')
    // …and the parameter that worked is remembered.
    await platform.sendText({ chatId: 555, markdown: 'ещё' })
    assert.equal(stub.state.sends.length, 3)
    assert.equal(stub.state.sends[2].query.chat_id, '555')
    assert.equal(stub.state.sends[2].query.user_id, undefined)
  } finally {
    await stub.close()
  }
})

test('an unknown chat is sent by chat_id and never guessed into a user_id', async () => {
  const stub = await createMaxStub({
    script: (call) => (call.method === 'POST' && call.path === '/messages'
      ? { status: 400, body: { code: 'chat.not.found', message: 'Chat not found' } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    // No update from this chat was ever seen. MAX's `user_id` and `chat_id` are
    // different namespaces, so retrying the same number as a user would risk
    // messaging a stranger who happens to own that id.
    await assert.rejects(() => platform.sendText({ chatId: 777, markdown: 'напоминание' }), (error) => {
      assert.ok(error instanceof MaxError)
      assert.equal(error.code, 'chat.not.found')
      return true
    })
    assert.equal(stub.state.sends.length, 1)
    assert.equal(stub.state.sends[0].query.chat_id, '777')
  } finally {
    await stub.close()
  }
})

test('an empty answer sends nothing', async () => {
  const stub = await createMaxStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const result = await platform.sendText({ chatId: 555, markdown: '' })
    assert.equal(result.messageId, undefined)
    assert.equal(stub.state.sends.length, 0)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// editText() / answerCallback() / sendTyping()
// ---------------------------------------------------------------------------

test('editText sends PUT /messages with the message id and keeps the keyboard when asked', async () => {
  const stub = await createMaxStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.editText({ chatId: 555, messageId: 'mid.9', markdown: '**Итог:** отменено' })
    const call = stub.state.edits[0]
    assert.equal(call.method, 'PUT')
    assert.equal(call.path, '/messages')
    assert.equal(call.query.message_id, 'mid.9')
    assert.equal(call.body.text, '**Итог:** отменено')
    assert.equal(call.body.format, 'markdown')
    assert.equal(call.body.notify, false)
    // No keyboard passed: `attachments` stays out of the body so MAX keeps the
    // existing one.
    assert.equal(call.body.attachments, undefined)

    await platform.editText({
      chatId: 555,
      messageId: 'mid.9',
      markdown: 'готово',
      keyboard: { rows: [[{ text: 'Ок', data: 'ok' }]] },
    })
    assert.equal(stub.state.edits[1].body.attachments[0].type, 'inline_keyboard')
  } finally {
    await stub.close()
  }
})

test('editText does not throw when MAX reports that there was nothing to change', async () => {
  const stub = await createMaxStub({
    script: (call) => {
      if (call.method !== 'PUT' || call.path !== '/messages') return undefined
      return { status: 200, body: { success: false, message: 'Message is not changed' } }
    },
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const result = await platform.editText({ chatId: 555, messageId: 'mid.9', markdown: 'то же самое' })
    assert.equal(result.success, false)
  } finally {
    await stub.close()
  }
})

test('editText swallows a 400 "nothing to change" but rethrows other failures', async () => {
  const unchanged = await createMaxStub({
    script: (call) => (call.method === 'PUT' && call.path === '/messages'
      ? { status: 400, body: { code: 'message.not.changed', message: 'Message is not changed' } }
      : undefined),
  })
  const other = await createMaxStub({
    script: (call) => (call.method === 'PUT' && call.path === '/messages'
      ? { status: 400, body: { code: 'message.too.old', message: 'Message is too old to edit' } }
      : undefined),
  })
  try {
    const first = makePlatform(unchanged)
    await first.start()
    await first.editText({ chatId: 555, messageId: 'mid.9', markdown: 'текст' })

    const second = makePlatform(other)
    await second.start()
    await assert.rejects(
      () => second.editText({ chatId: 555, messageId: 'mid.9', markdown: 'текст' }),
      (error) => {
        assert.ok(error instanceof MaxError)
        assert.equal(error.code, 'message.too.old')
        return true
      },
    )
  } finally {
    await unchanged.close()
    await other.close()
  }
})

test('answerCallback posts to /answers with callback_id and ignores alert', async () => {
  const stub = await createMaxStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.answerCallback({ callbackId: 'cb-7', text: 'Напоминание отменено', alert: true })
    const call = stub.state.answers[0]
    assert.equal(call.method, 'POST')
    assert.equal(call.path, '/answers')
    assert.equal(call.query.callback_id, 'cb-7')
    // CallbackAnswer has `notification`; there is no alert flag in MAX.
    assert.equal(call.body.notification, 'Напоминание отменено')
    assert.equal('alert' in call.body, false)
    assert.equal('show_alert' in call.body, false)
  } finally {
    await stub.close()
  }
})

test('sendTyping posts typing_on and never fails the answer', async () => {
  let calls = 0
  const stub = await createMaxStub({
    script: (call) => {
      if (call.method !== 'POST' || !call.path.endsWith('/actions')) return undefined
      calls++
      // `/chats/{chatId}/actions` is documented for group chats only: the
      // second call fails and must not break the answer.
      return calls > 1 ? { status: 405, body: { code: 'method.not.allowed', message: 'Not allowed' } } : undefined
    },
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.sendTyping({ chatId: 900 })
    assert.equal(stub.state.actions[0].path, '/chats/900/actions')
    assert.deepEqual(stub.state.actions[0].body, { action: 'typing_on' })
    // The second call is forced to fail and must still resolve.
    await platform.sendTyping({ chatId: 901 })
    assert.equal(stub.state.actions.length, 2)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

test('a 401 becomes a MaxError with code and description, and never leaks the token', async () => {
  const stub = await createMaxStub({
    script: (call) => (call.method === 'POST' && call.path === '/messages'
      ? { status: 401, body: { code: 'verify.token', message: 'Invalid access token' } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await assert.rejects(
      () => platform.sendText({ chatId: 555, markdown: 'привет' }),
      (error) => {
        assert.ok(error instanceof MaxError)
        assert.equal(error.status, 401)
        assert.equal(error.code, 'verify.token')
        assert.equal(error.description, 'Invalid access token')
        assert.equal(error.method, 'POST /messages')
        assert.match(error.message, /Invalid access token/)
        assert.equal(error.message.includes('secret-token'), false)
        assert.equal(JSON.stringify({ message: error.message, cause: error.cause?.message ?? '' }).includes('secret-token'), false)
        // A rejected token is not retried, and the core can treat it as fatal.
        assert.equal(stub.state.sends.length, 1)
        assert.equal(platform.isFatalError(error), true)
        return true
      },
    )
  } finally {
    await stub.close()
  }
})

test('a certificate failure explains how to trust the Минцифры root', async () => {
  const cases = [
    () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }) },
    () => { throw new TypeError('self-signed certificate in certificate chain') },
  ]
  for (const fetchImpl of cases) {
    let calls = 0
    const platform = new MaxPlatform({
      token: 'secret-token',
      apiBase: 'https://platform-api2.max.ru',
      logger: silentLogger,
      sleep: async () => {},
      fetchImpl: (...args) => { calls++; return fetchImpl(...args) },
    })
    await assert.rejects(() => platform.start(), (error) => {
      assert.ok(error instanceof MaxError)
      assert.equal(error.certificate, true)
      assert.match(error.message, /Минцифры/)
      assert.match(error.message, /NODE_EXTRA_CA_CERTS/)
      assert.match(error.message, /gu-st\.ru/)
      assert.equal(error.message.includes('secret-token'), false)
      assert.equal(platform.isFatalError(error), true)
      return true
    })
    // The chain will not repair itself, so the failure must not be retried.
    assert.equal(calls, 1)
  }
})

test('a 5xx is retried with backoff and then succeeds', async () => {
  let attempts = 0
  const sleeps = []
  const stub = await createMaxStub({
    script: (call) => {
      if (call.path !== '/me') return undefined
      attempts++
      return attempts < 3 ? { status: 503, body: { code: 'server.error', message: 'Service unavailable' } } : undefined
    },
  })
  try {
    const platform = makePlatform(stub, { sleep: async (ms) => { sleeps.push(ms) } })
    await platform.start()
    assert.equal(attempts, 3)
    assert.deepEqual(sleeps, [500, 1000])
  } finally {
    await stub.close()
  }
})

test('a 429 honours Retry-After and falls back to backoff without it', async () => {
  const runs = []
  for (const retryAfter of ['2', undefined]) {
    let attempts = 0
    const sleeps = []
    const stub = await createMaxStub({
      script: (call) => {
        if (call.path !== '/me') return undefined
        attempts++
        return attempts === 1
          ? {
            status: 429,
            body: { code: 'rate.limit', message: 'Too many requests' },
            headers: retryAfter === undefined ? undefined : { 'retry-after': retryAfter },
          }
          : undefined
      },
    })
    try {
      const platform = makePlatform(stub, { sleep: async (ms) => { sleeps.push(ms) } })
      await platform.start()
      runs.push({ attempts, sleeps })
    } finally {
      await stub.close()
    }
  }
  assert.deepEqual(runs[0], { attempts: 2, sleeps: [2000] })
  assert.deepEqual(runs[1], { attempts: 2, sleeps: [500] })
})

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('toMaxMarkdown keeps the documented subset and rewrites the rest', () => {
  assert.equal(toMaxMarkdown('**жирный** и *курсив*'), '**жирный** и *курсив*')
  assert.equal(toMaxMarkdown('# Заголовок'), '# Заголовок')
  assert.equal(toMaxMarkdown('***важно***'), '**важно**')
  assert.equal(toMaxMarkdown('- пункт\n* второй\n+ третий'), '• пункт\n• второй\n• третий')
  assert.equal(toMaxMarkdown('---'), '———')
  assert.equal(toMaxMarkdown('![схема](https://example.com/a.png)'), 'схема (https://example.com/a.png)')
  assert.equal(toMaxMarkdown('[тык](javascript:alert(1))'), 'тык (javascript:alert(1))')
  assert.equal(toMaxMarkdown('[сайт](https://example.com)'), '[сайт](https://example.com)')
  assert.equal(toMaxMarkdown('```js\nconst a = 1\n```'), '```\nconst a = 1\n```')
  assert.equal(toMaxMarkdown(''), '')
  assert.equal(toMaxMarkdown(undefined), '')
})

test('splitMaxText respects the limit and keeps code fences balanced', () => {
  assert.deepEqual(splitMaxText('коротко'), ['коротко'])
  assert.deepEqual(splitMaxText(''), [])

  const long = splitMaxText('a'.repeat(9001), 4000)
  assert.equal(long.length, 3)
  assert.equal(long.every((chunk) => chunk.length <= 4000), true)

  const fenced = `вступление\n\`\`\`js\n${'const x = 1\n'.repeat(500)}\`\`\`\nконец`
  const chunks = splitMaxText(fenced, 4000)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000, `chunk of ${chunk.length}`)
    // An odd number of fence markers would leave the parser inside a code block.
    assert.equal((chunk.match(/^```/gm) ?? []).length % 2, 0, `unbalanced fence in ${JSON.stringify(chunk.slice(0, 40))}`)
  }

  // Multi-byte characters must survive the cut.
  const emoji = splitMaxText('🙂'.repeat(4000), 1000)
  assert.equal(emoji.every((chunk) => chunk.length <= 1000 && !chunk.includes('\uFFFD')), true)
  assert.equal(emoji.join(''), '🙂'.repeat(4000))
})

test('toAttachments maps the neutral keyboard and trims what MAX cannot render', () => {
  assert.equal(toAttachments(undefined), undefined)
  assert.equal(toAttachments({ rows: [] }), undefined)
  assert.equal(toAttachments({ rows: [[{ text: '', data: 'x' }]] }), undefined)
  assert.deepEqual(
    toAttachments({ rows: [[{ text: 'A', data: 'a' }], [{ text: 'B', url: 'https://b.example' }]] }),
    [
      { type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: 'A', payload: 'a' }], [{ type: 'link', text: 'B', url: 'https://b.example' }]] } },
    ],
  )
  // A row holding a link holds at most three buttons.
  const wide = { rows: [Array.from({ length: 6 }, (_, index) => ({ text: `L${index}`, url: `https://example.com/${index}` }))] }
  assert.equal(toAttachments(wide)[0].payload.buttons[0].length, 3)
  // ... while a callback row holds up to seven.
  const callbacks = { rows: [Array.from({ length: 9 }, (_, index) => ({ text: `C${index}`, data: `c${index}` }))] }
  assert.equal(toAttachments(callbacks)[0].payload.buttons[0].length, 7)
})

test('markerFrom keeps int64 markers exact', () => {
  assert.equal(markerFrom('{"updates":[],"marker":101}'), 101)
  assert.equal(markerFrom('{"updates":[],"marker":null}'), undefined)
  assert.equal(markerFrom('{"updates":[]}'), undefined)
  assert.equal(markerFrom('{"marker":9223372036854775807}'), '9223372036854775807')
})

test('isCertificateError recognises OpenSSL codes and messages', () => {
  assert.equal(isCertificateError(Object.assign(new Error('boom'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), true)
  assert.equal(isCertificateError(new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } })), true)
  assert.equal(isCertificateError(new TypeError('unable to verify the first certificate')), true)
  assert.equal(isCertificateError(new Error('socket hang up')), false)
  assert.equal(isCertificateError(undefined), false)
})

test('createMaxPlatform builds a usable adapter', async () => {
  const stub = await createMaxStub()
  try {
    const platform = createMaxPlatform({ token: 'secret-token', apiBase: stub.apiBase, logger: silentLogger, sleep: async () => {} })
    assert.ok(platform instanceof MaxPlatform)
    await platform.start()
    assert.equal(platform.identity.username, 'test_bot')
  } finally {
    await stub.close()
  }
})
