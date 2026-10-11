/**
 * VK Teams adapter tests.
 *
 * They run against a fake VK Teams API on 127.0.0.1, so the adapter exercises
 * its real fetch path without touching the network. The wire shape below is the
 * one documented in the OpenAPI spec (`/botapi/api.yaml` and the `$ref` files it
 * points at) and produced by the official libraries: a `{eventId, type,
 * payload}` envelope, `{ok: true, msgId}` acknowledgements and a token sent as a
 * query parameter.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  DEFAULT_API_BASE,
  OWN_MESSAGE_CACHE_SIZE,
  VK_TEAMS_KEYBOARD_BUTTONS,
  VK_TEAMS_KEYBOARD_ROWS,
  VK_TEAMS_TEXT_LIMIT,
  VkTeamsError,
  VkTeamsPlatform,
  createVkTeamsPlatform,
  nextCursor,
  redactToken,
  splitVkTeamsText,
  toInlineKeyboardMarkup,
} from '../src/platforms/vk-teams.mjs'

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

const defaultMe = { userId: 42, nick: 'test_bot', firstName: 'Test Bot', ok: true }

/**
 * Fake VK Teams API.
 *
 * Every method is a `GET` with the token in the query string. `eventBatches` is
 * a queue of `/events/get` answers (the last one repeats); `script(call, state)`
 * may return `{status, body}` to force a failure.
 */
async function createVkStub({ me = defaultMe, eventBatches = [], script, downloadBytes = Buffer.from('hello') } = {}) {
  const batches = [...eventBatches]
  const state = { requests: [], polls: [], sends: [], edits: [], answers: [], actions: [], files: [], downloads: [], lastBatch: undefined }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    await readBody(request)
    const call = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
    }
    state.requests.push(call)
    if (url.pathname === '/events/get') state.polls.push(call)
    if (url.pathname === '/messages/sendText') state.sends.push(call)
    if (url.pathname === '/messages/editText') state.edits.push(call)
    if (url.pathname === '/messages/answerCallbackQuery') state.answers.push(call)
    if (url.pathname === '/chats/sendActions') state.actions.push(call)
    if (url.pathname === '/files/getInfo') state.files.push(call)
    if (url.pathname.startsWith('/dl/')) state.downloads.push(call)
    const override = script?.(call, state)
    if (override) return reply(response, override.status ?? 200, override.body, override.headers)

    if (url.pathname === '/self/get') return reply(response, 200, me)
    if (url.pathname === '/events/get') {
      // The queue is drained once per response; the last one then repeats.
      state.lastBatch = batches.shift() ?? state.lastBatch ?? { events: [] }
      return reply(response, 200, { ok: true, events: state.lastBatch.events ?? [] })
    }
    if (url.pathname === '/messages/sendText') return reply(response, 200, { ok: true, msgId: `msg.${state.sends.length}` })
    if (url.pathname === '/messages/editText') return reply(response, 200, { ok: true })
    if (url.pathname === '/messages/answerCallbackQuery') return reply(response, 200, { ok: true })
    if (url.pathname === '/chats/sendActions') return reply(response, 200, { ok: true })
    if (url.pathname === '/files/getInfo') {
      // `getInfo` documents `{url, filename, size, type}` with a pre-signed url.
      return reply(response, 200, {
        ok: true,
        url: `http://${request.headers.host}/dl/${call.query.fileId}`,
        filename: 'report.pdf',
        size: downloadBytes.length,
        type: 'file',
      })
    }
    if (url.pathname.startsWith('/dl/')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': downloadBytes.length })
      response.end(downloadBytes)
      return
    }
    return reply(response, 404, { ok: false, description: `no route for ${request.method} ${url.pathname}` })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => closeServer(server),
  }
}

/** One `newMessage` / `editedMessage` event with the documented payload. */
function messageEvent({
  eventId = 1,
  type = 'newMessage',
  chatType = 'private',
  chatId = 'user-1',
  userId = 'user-1',
  firstName = 'Иван',
  lastName,
  nick = 'ivan',
  text = 'привет',
  msgId = '1000',
  parts,
  replyMsgId,
} = {}) {
  return {
    eventId,
    type,
    payload: {
      msgId,
      chat: { chatId, type: chatType, title: 'Чат' },
      from: { userId, firstName, lastName, nick },
      text,
      timestamp: 1700000000,
      ...(parts === undefined ? {} : { parts }),
      ...(replyMsgId === undefined ? {} : { replyMsgId }),
    },
  }
}

/**
 * A `reply` part quoting another message; the default author is the bot (id 42).
 * `withFrom: false` models a quoted message the API returned without `from`,
 * which is why the adapter also tracks the `msgId`s it sent itself.
 */
const replyPart = ({ userId = 42, msgId = '900', text = 'предыдущий ответ', withFrom = true } = {}) => ({
  type: 'reply',
  payload: {
    message: {
      msgId,
      text,
      timestamp: 1699999999,
      ...(withFrom ? { from: { userId, firstName: 'Bot', nick: 'bot' } } : {}),
    },
  },
})

/** A `mention` part naming the bot (id 42). */
const mentionPart = ({ userId = 42 } = {}) => ({ type: 'mention', payload: { userId, firstName: 'Bot' } })

/** One `callbackQuery` event. */
function callbackEvent({
  eventId = 9,
  chatType = 'group',
  chatId = 'chat-1',
  userId = 'user-2',
  queryId = 'QDFWEscvSW',
  data = 'cancel:3',
  text = 'напоминание',
  msgId = '1000',
  withChat = true,
  withMessage = true,
} = {}) {
  return {
    eventId,
    type: 'callbackQuery',
    payload: {
      queryId,
      callbackData: data,
      ...(withChat ? { chat: { chatId, type: chatType, title: 'Чат' } } : {}),
      from: { userId, firstName: 'Пётр', nick: 'petr' },
      ...(withMessage
        ? { message: { msgId, chat: { chatId, type: chatType }, from: { userId: 'bot-1' }, text, timestamp: 1 } }
        : {}),
    },
  }
}

const makePlatform = (stub, options = {}) =>
  new VkTeamsPlatform({
    token: 'secret-token',
    apiBase: stub?.apiBase,
    logger: silentLogger,
    sleep: async () => {},
    ...options,
  })

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

test('start() fills identity from GET /self/get and sends the token as a query parameter', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    assert.deepEqual(platform.identity, { id: 42, username: 'test_bot', title: 'Test Bot' })
    assert.equal(platform.name, 'vk-teams')
    assert.equal(platform.namespace, 'vk')
    const call = stub.state.requests.find((request) => request.path === '/self/get')
    assert.equal(call.method, 'GET')
    // VK Teams has no header auth: the token is part of the query string.
    assert.equal(call.query.token, 'secret-token')
    assert.equal(call.headers.authorization, undefined)
    assert.equal(call.headers['content-type'], undefined)
  } finally {
    await stub.close()
  }
})

test('start() falls back to the nick when firstName is absent', async () => {
  const stub = await createVkStub({ me: { userId: '1000000001', nick: 'legacy_bot', ok: true } })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    assert.deepEqual(platform.identity, { id: 1000000001, username: 'legacy_bot', title: 'legacy_bot' })
  } finally {
    await stub.close()
  }
})

test('VK_TEAMS_API_BASE and VK_TEAMS_TOKEN override the defaults', async () => {
  const stub = await createVkStub()
  const previousBase = process.env.VK_TEAMS_API_BASE
  const previousToken = process.env.VK_TEAMS_TOKEN
  process.env.VK_TEAMS_API_BASE = stub.apiBase
  process.env.VK_TEAMS_TOKEN = 'env-token'
  try {
    const platform = new VkTeamsPlatform({ logger: silentLogger, sleep: async () => {} })
    await platform.start()
    assert.equal(platform.identity.id, 42)
    assert.equal(stub.state.requests[0].query.token, 'env-token')
  } finally {
    if (previousBase === undefined) delete process.env.VK_TEAMS_API_BASE
    else process.env.VK_TEAMS_API_BASE = previousBase
    if (previousToken === undefined) delete process.env.VK_TEAMS_TOKEN
    else process.env.VK_TEAMS_TOKEN = previousToken
    await stub.close()
  }
})

test('a missing token is reported instead of sending `undefined`', async () => {
  const previousToken = process.env.VK_TEAMS_TOKEN
  const previousMyteam = process.env.MYTEAM_TOKEN
  delete process.env.VK_TEAMS_TOKEN
  delete process.env.MYTEAM_TOKEN
  try {
    const platform = new VkTeamsPlatform({ apiBase: 'http://127.0.0.1:1', logger: silentLogger })
    await assert.rejects(() => platform.start(), (error) => {
      assert.ok(error instanceof VkTeamsError)
      assert.match(error.message, /no bot token/)
      return true
    })
  } finally {
    if (previousToken !== undefined) process.env.VK_TEAMS_TOKEN = previousToken
    if (previousMyteam !== undefined) process.env.MYTEAM_TOKEN = previousMyteam
  }
})

// ---------------------------------------------------------------------------
// getUpdates()
// ---------------------------------------------------------------------------

test('getUpdates sends lastEventId=0 first, then the cursor, together with pollTime', async () => {
  const stub = await createVkStub({ eventBatches: [{ events: [messageEvent({ eventId: 7 })] }] })
  try {
    const platform = makePlatform(stub)
    await platform.start()

    const first = await platform.getUpdates({ timeoutSec: 25 })
    assert.equal(first.updates.length, 1)
    assert.equal(first.updates[0].id, 7)
    assert.equal(first.cursor, 7)
    assert.equal(stub.state.polls[0].query.lastEventId, '0')
    assert.equal(stub.state.polls[0].query.pollTime, '25')

    const second = await platform.getUpdates({ cursor: first.cursor, timeoutSec: 5 })
    assert.equal(stub.state.polls[1].query.lastEventId, '7')
    assert.equal(stub.state.polls[1].query.pollTime, '5')
    // The stub repeats the last batch, so the cursor is stable.
    assert.equal(second.cursor, 7)
  } finally {
    await stub.close()
  }
})

test('getUpdates drops events the adapter does not handle but still advances the cursor', async () => {
  const stub = await createVkStub({
    eventBatches: [{
      events: [
        messageEvent({ eventId: 1 }),
        { eventId: 2, type: 'deletedMessage', payload: { msgId: '1', chat: { chatId: 'user-1', type: 'private' } } },
        { eventId: 3, type: 'newChatMembers', payload: { chat: { chatId: 'chat-1', type: 'group' } } },
        { eventId: 4, type: 'pinnedMessage', payload: {} },
      ],
    }],
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const { updates, cursor } = await platform.getUpdates({})
    assert.equal(updates.length, 1)
    // Handled and ignored events share the cursor: re-fetching them would loop.
    assert.equal(cursor, 4)
  } finally {
    await stub.close()
  }
})

test('getUpdates keeps the previous cursor when the server returns no events', async () => {
  const stub = await createVkStub({ eventBatches: [{ events: [] }] })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const { updates, cursor } = await platform.getUpdates({ cursor: 55 })
    assert.deepEqual(updates, [])
    assert.equal(cursor, 55)
  } finally {
    await stub.close()
  }
})

test('the long-poll request gets a timeout budget above the server hold time', async () => {
  const stub = await createVkStub()
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

test('normalizes a private message as addressed', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize(messageEvent({
    eventId: 11,
    chatType: 'private',
    chatId: 'user-1',
    userId: 'user-1',
    firstName: 'Иван',
    lastName: 'Петров',
    nick: 'ivan',
    text: '  привет  ',
    msgId: '1000',
  }))
  assert.equal(update.kind, 'message')
  assert.equal(update.chat.type, 'private')
  assert.equal(update.chat.id, 'user-1')
  assert.equal(update.addressed, true)
  assert.equal(update.text, 'привет')
  assert.equal(update.replyToMessageId, '1000')
  assert.equal(update.id, 11)
  assert.deepEqual(update.from, { id: 'user-1', name: 'Иван Петров', username: 'ivan', isBot: false })
})

test('normalizes a group message: addressed only with a mention or a reply to the bot', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const group = { chatType: 'group', chatId: '681869378@chat.agent', userId: 'user-2' }

  const plain = platform.normalize(messageEvent({ ...group, text: 'просто болтаю' }))
  assert.equal(plain.chat.type, 'group')
  assert.equal(plain.chat.id, '681869378@chat.agent')
  assert.equal(plain.addressed, false)

  assert.equal(platform.normalize(messageEvent({ ...group, text: 'бот @test_bot, помоги' })).addressed, true)
  assert.equal(platform.normalize(messageEvent({ ...group, text: 'бот @[42], помоги' })).addressed, true)
  assert.equal(platform.normalize(messageEvent({ ...group, text: 'помоги', parts: [mentionPart()] })).addressed, true)
  assert.equal(platform.normalize(messageEvent({ ...group, text: 'а теперь?', parts: [replyPart()] })).addressed, true)
  assert.equal(
    platform.normalize(messageEvent({ ...group, text: 'а теперь?', parts: [replyPart({ userId: 'user-2' })] })).addressed,
    false,
  )
  // A partial username must not count as a mention.
  assert.equal(platform.normalize(messageEvent({ ...group, text: '@test_botik привет' })).addressed, false)
  // A channel is folded into `group`: the core only separates private chats.
  assert.equal(platform.normalize(messageEvent({ ...group, chatType: 'channel' })).chat.type, 'group')
})

test('a reply to a message this adapter sent is addressed even without from.userId', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  platform.rememberOwnMessage('msg.7', 'chat-1')
  const quoted = platform.normalize(messageEvent({
    chatType: 'group',
    chatId: 'chat-1',
    userId: 'user-2',
    text: 'а теперь?',
    parts: [replyPart({ withFrom: false, msgId: 'msg.7' })],
  }))
  assert.equal(quoted.addressed, true)
  // The undocumented top-level `replyMsgId` is honoured as a fallback too.
  const fallback = platform.normalize(messageEvent({
    chatType: 'group',
    chatId: 'chat-1',
    userId: 'user-2',
    text: 'и это?',
    replyMsgId: 'msg.7',
  }))
  assert.equal(fallback.addressed, true)
  // A reply to an unknown message is not a reply to the bot.
  assert.equal(platform.normalize(messageEvent({
    chatType: 'group',
    chatId: 'chat-1',
    userId: 'user-2',
    parts: [replyPart({ withFrom: false, msgId: 'msg.999' })],
  })).addressed, false)
})

test('treats editedMessage as a regular message and ignores the other types', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const edited = platform.normalize(messageEvent({ type: 'editedMessage', text: 'исправлено' }))
  assert.equal(edited.kind, 'message')
  assert.equal(edited.text, 'исправлено')
  for (const type of ['deletedMessage', 'pinnedMessage', 'unpinnedMessage', 'newChatMembers', 'leftChatMembers', 'unknown']) {
    assert.equal(platform.normalize({ eventId: 1, type, payload: {} }), undefined, type)
  }
  assert.equal(platform.normalize(null), undefined)
  assert.equal(platform.normalize({ eventId: 1, type: 'newMessage' }), undefined)
})

test('normalizes a callback with queryId, callbackData and the message id', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize(callbackEvent({ eventId: 9, chatType: 'group', chatId: 'chat-1', userId: 'user-2', msgId: '1000' }))
  assert.equal(update.kind, 'callback')
  assert.equal(update.id, 9)
  assert.equal(update.chat.type, 'group')
  assert.equal(update.chat.id, 'chat-1')
  assert.equal(update.from.id, 'user-2')
  assert.equal(update.addressed, true)
  assert.equal(update.text, '')
  assert.deepEqual(update.callback, { id: 'QDFWEscvSW', data: 'cancel:3', messageId: '1000', text: 'напоминание' })
})

test('a callback whose message is gone still resolves through the tapper', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  // The keyboard's message is gone, so neither `chat` nor `message` is present.
  const update = platform.normalize(callbackEvent({ withChat: false, withMessage: false, userId: 'user-2', queryId: 'Q2' }))
  assert.equal(update.kind, 'callback')
  assert.equal(update.callback.id, 'Q2')
  assert.equal(update.callback.messageId, undefined)
  assert.equal(update.callback.text, '')
  // The dialog of the user who tapped is the only chat we can name.
  assert.equal(update.chat.id, 'user-2')
  assert.equal(update.chat.type, 'private')
  assert.equal(platform.normalize({ eventId: 1, type: 'callbackQuery', payload: {} }), undefined)
})

// ---------------------------------------------------------------------------
// sendText()
// ---------------------------------------------------------------------------

test('sendText maps markdown, the reply id and the keyboard onto the query string', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const result = await platform.sendText({
      chatId: '681869378@chat.agent',
      markdown: '**Готово** [сайт](https://example.com)',
      replyToMessageId: '900',
      keyboard: { rows: [[{ text: '✖️ Отменить', data: 'cancel:3' }, { text: 'Сайт', url: 'https://example.com' }]] },
    })
    assert.equal(result.messageId, 'msg.1')
    const call = stub.state.sends[0]
    assert.equal(call.method, 'GET')
    assert.equal(call.path, '/messages/sendText')
    assert.equal(call.query.chatId, '681869378@chat.agent')
    // Markdown is converted to the documented HTML subset, not sent raw.
    assert.equal(call.query.text, '<b>Готово</b> <a href="https://example.com">сайт</a>')
    assert.equal(call.query.parseMode, 'HTML')
    assert.equal(call.query.replyMsgId, '900')
    assert.deepEqual(JSON.parse(call.query.inlineKeyboardMarkup), [[
      { text: '✖️ Отменить', callbackData: 'cancel:3' },
      { text: 'Сайт', url: 'https://example.com' },
    ]])
    assert.equal(call.query.token, 'secret-token')
  } finally {
    await stub.close()
  }
})

test('sendText splits long answers and attaches the keyboard to the last chunk', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const blocks = Array.from({ length: 120 }, (_, index) => `## Блок ${index}\n${'текст '.repeat(30)}`)
    const markdown = blocks.join('\n\n')
    assert.ok(markdown.length > 9000)

    const result = await platform.sendText({
      chatId: 'chat-1',
      markdown,
      keyboard: { rows: [[{ text: 'Ещё', data: 'more' }]] },
    })

    const sends = stub.state.sends
    assert.ok(sends.length >= 3, `expected several chunks, got ${sends.length}`)
    for (const call of sends) {
      assert.equal(call.query.parseMode, 'HTML')
      assert.ok(call.query.text.length <= VK_TEAMS_TEXT_LIMIT, `chunk of ${call.query.text.length} exceeds the limit`)
    }
    assert.equal(result.messageId, `msg.${sends.length}`)
    // Buttons only under the final chunk, otherwise they would sit mid-answer.
    assert.equal(sends.slice(0, -1).every((call) => call.query.inlineKeyboardMarkup === undefined), true)
    assert.equal(sends.at(-1).query.inlineKeyboardMarkup, JSON.stringify([[{ text: 'Ещё', callbackData: 'more' }]]))
  } finally {
    await stub.close()
  }
})

test('sendText records its own message ids so a later reply can be recognised', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const { messageId } = await platform.sendText({ chatId: 'chat-1', markdown: 'напоминание' })
    assert.equal(messageId, 'msg.1')
    assert.equal(platform.isOwnMessage('msg.1'), true)
    const update = platform.normalize(messageEvent({
      chatType: 'group',
      chatId: 'chat-1',
      userId: 'user-2',
      text: 'готово',
      parts: [replyPart({ withFrom: false, msgId: 'msg.1' })],
    }))
    assert.equal(update.addressed, true)
  } finally {
    await stub.close()
  }
})

test('the own-message cache is bounded and evicts the oldest entry', async () => {
  const platform = makePlatform(undefined, { client: {}, ownMessageCacheSize: 2 })
  platform.rememberOwnMessage('a', 'chat-1')
  platform.rememberOwnMessage('b', 'chat-1')
  platform.rememberOwnMessage('c', 'chat-1')
  assert.equal(platform.ownMessages.size, 2)
  assert.equal(platform.isOwnMessage('a'), false)
  assert.equal(platform.isOwnMessage('c'), true)
  assert.equal(OWN_MESSAGE_CACHE_SIZE, 200)
})

test('an empty answer sends nothing', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const result = await platform.sendText({ chatId: 'chat-1', markdown: '' })
    assert.equal(result.messageId, undefined)
    assert.equal(stub.state.sends.length, 0)
  } finally {
    await stub.close()
  }
})

test('a rejected HTML body falls back to plain text', async () => {
  let sends = 0
  const stub = await createVkStub({
    script: (call) => {
      if (call.path !== '/messages/sendText') return undefined
      sends++
      return sends === 1 ? { status: 400, body: { ok: false, description: 'Invalid markup' } } : undefined
    },
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.sendText({ chatId: 'chat-1', markdown: '**Готово** & <b>' })
    assert.equal(stub.state.sends.length, 2)
    assert.equal(stub.state.sends[0].query.parseMode, 'HTML')
    assert.equal(stub.state.sends[1].query.parseMode, undefined)
    // Entities must be decoded again: no parse mode means literal characters.
    assert.equal(stub.state.sends[1].query.text, 'Готово & <b>')
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// editText() / answerCallback() / sendTyping()
// ---------------------------------------------------------------------------

test('editText rewrites the message text and can replace the keyboard', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.editText({ chatId: 'chat-1', messageId: '1000', markdown: '**Итог:** отменено' })
    const call = stub.state.edits[0]
    assert.equal(call.method, 'GET')
    assert.equal(call.path, '/messages/editText')
    assert.equal(call.query.chatId, 'chat-1')
    assert.equal(call.query.msgId, '1000')
    assert.equal(call.query.text, '<b>Итог:</b> отменено')
    assert.equal(call.query.parseMode, 'HTML')
    // No keyboard passed: the parameter stays out of the query.
    assert.equal(call.query.inlineKeyboardMarkup, undefined)

    await platform.editText({
      chatId: 'chat-1',
      messageId: '1000',
      markdown: 'готово',
      keyboard: { rows: [[{ text: 'Ок', data: 'ok' }]] },
    })
    assert.equal(stub.state.edits[1].query.inlineKeyboardMarkup, JSON.stringify([[{ text: 'Ок', callbackData: 'ok' }]]))
  } finally {
    await stub.close()
  }
})

test('answerCallback passes queryId, text and showAlert', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.answerCallback({ callbackId: 'Q1', text: 'Напоминание отменено', alert: true })
    const call = stub.state.answers[0]
    assert.equal(call.method, 'GET')
    assert.equal(call.path, '/messages/answerCallbackQuery')
    assert.equal(call.query.queryId, 'Q1')
    assert.equal(call.query.text, 'Напоминание отменено')
    assert.equal(call.query.showAlert, 'true')

    await platform.answerCallback({ callbackId: 'Q2', text: 'ок' })
    assert.equal(stub.state.answers[1].query.showAlert, 'false')
  } finally {
    await stub.close()
  }
})

test('sendTyping asks for the typing action and never fails the answer', async () => {
  let calls = 0
  const stub = await createVkStub({
    script: (call) => {
      if (call.path !== '/chats/sendActions') return undefined
      calls++
      // The second call is rejected (a 4xx is not retried) and must still resolve.
      return calls > 1 ? { status: 400, body: { ok: false, description: 'Action is not allowed' } } : undefined
    },
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await platform.sendTyping({ chatId: 'chat-1' })
    assert.equal(stub.state.actions[0].path, '/chats/sendActions')
    assert.equal(stub.state.actions[0].query.chatId, 'chat-1')
    assert.equal(stub.state.actions[0].query.actions, 'typing')
    await platform.sendTyping({ chatId: 'chat-2' })
    assert.equal(stub.state.actions.length, 2)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

test('normalizes the message id and the downloadable parts of a message', async () => {
  const platform = makePlatform(undefined, { client: {} })
  platform.identity = { id: 42, username: 'test_bot', title: 'Test Bot' }
  const update = platform.normalize(messageEvent({
    msgId: '1000',
    text: '',
    parts: [
      { type: 'file', payload: { fileId: 'F1', type: 'image', caption: 'схема' } },
      { type: 'file', payload: { fileId: 'F2', type: 'audio' } },
      { type: 'file', payload: { fileId: 'F3' } },
      { type: 'voice', payload: { fileId: 'V1', duration: 3 } },
      // A sticker carries only a `fileId` and would degrade to a document.
      { type: 'sticker', payload: { fileId: 'S1' } },
      // A reply part is not media.
      { type: 'reply', payload: { message: { msgId: '900', from: { userId: 42 } } } },
    ],
  }))
  assert.equal(update.messageId, '1000')
  assert.equal(update.replyToMessageId, '1000')
  assert.deepEqual(
    update.attachments.map((attachment) => [attachment.kind, attachment.fileId]),
    [['photo', 'F1'], ['audio', 'F2'], ['document', 'F3'], ['voice', 'V1']],
  )
  assert.equal(update.attachments[0].caption, 'схема')
  // A message without parts has no attachments at all.
  assert.deepEqual(platform.normalize(messageEvent({ parts: [] })).attachments, [])
})

test('downloadFile resolves a fileId through /files/getInfo and returns the bytes', async () => {
  const stub = await createVkStub({ downloadBytes: Buffer.from('pdf-bytes') })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    const file = await platform.downloadFile({ fileId: 'F1' })
    assert.equal(stub.state.files[0].path, '/files/getInfo')
    assert.equal(stub.state.files[0].query.fileId, 'F1')
    assert.equal(stub.state.files[0].query.token, 'secret-token')
    // The pre-signed url needs no token and is fetched directly.
    assert.equal(stub.state.downloads.length, 1)
    assert.equal(stub.state.downloads[0].path, '/dl/F1')
    assert.equal(file.bytes.toString(), 'pdf-bytes')
    assert.equal(file.size, 9)
    assert.equal(file.fileName, 'report.pdf')

    // A direct url skips getInfo entirely.
    const direct = await platform.downloadFile({ url: `${stub.apiBase}/dl/F2` })
    assert.equal(direct.bytes.toString(), 'pdf-bytes')
    assert.equal(stub.state.files.length, 1)
  } finally {
    await stub.close()
  }
})

test('downloadFile refuses a file whose declared size exceeds the limit', async () => {
  const stub = await createVkStub({ downloadBytes: Buffer.alloc(1000) })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await assert.rejects(() => platform.downloadFile({ fileId: 'F1', maxBytes: 10 }), (error) => {
      assert.ok(error instanceof VkTeamsError)
      assert.match(error.message, /too large/)
      return true
    })
    // The declared size is checked before the body is pulled down.
    assert.equal(stub.state.downloads.length, 0)
  } finally {
    await stub.close()
  }
})

test('downloadFile reports a missing file id and a getInfo answer without a url', async () => {
  const noUrl = await createVkStub({
    script: (call) => (call.path === '/files/getInfo' ? { status: 200, body: { ok: true } } : undefined),
  })
  try {
    const platform = makePlatform(noUrl)
    await platform.start()
    await assert.rejects(() => platform.downloadFile({}), /neither fileId nor url/)
    await assert.rejects(() => platform.downloadFile({ fileId: 'F1' }), /returned no url/)
  } finally {
    await noUrl.close()
  }
})

test('setReaction is a documented no-op: the API has no reaction method', async () => {
  const platform = makePlatform(undefined, { client: {} })
  assert.equal(await platform.setReaction({ chatId: 'chat-1', messageId: '1000', emoji: '👍' }), undefined)
})

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

test('an HTTP 401 becomes a VkTeamsError with code and description, and never leaks the token', async () => {
  const stub = await createVkStub({
    script: (call) => (call.path === '/messages/sendText'
      ? { status: 401, body: { ok: false, code: 'verify.token', description: 'Invalid access token' } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await assert.rejects(
      () => platform.sendText({ chatId: 'chat-1', markdown: 'привет' }),
      (error) => {
        assert.ok(error instanceof VkTeamsError)
        assert.equal(error.name, 'VkTeamsError')
        assert.equal(error.status, 401)
        assert.equal(error.code, 'verify.token')
        assert.equal(error.description, 'Invalid access token')
        assert.equal(error.method, 'GET /messages/sendText')
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

test('the real in-band "Invalid token" answer (HTTP 200, ok: false) is fatal and not retried', async () => {
  const stub = await createVkStub({
    script: (call) => (call.path === '/messages/sendText'
      ? { status: 200, body: { ok: false, description: 'Invalid token' } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.start()
    await assert.rejects(
      () => platform.sendText({ chatId: 'chat-1', markdown: 'привет' }),
      (error) => {
        assert.ok(error instanceof VkTeamsError)
        assert.equal(error.status, 200)
        assert.equal(error.description, 'Invalid token')
        assert.equal(error.message.includes('secret-token'), false)
        assert.equal(platform.isFatalError(error), true)
        return true
      },
    )
    assert.equal(stub.state.sends.length, 1)
  } finally {
    await stub.close()
  }
})

test('a 5xx is retried with backoff and then succeeds', async () => {
  let attempts = 0
  const sleeps = []
  const stub = await createVkStub({
    script: (call) => {
      if (call.path !== '/self/get') return undefined
      attempts++
      return attempts < 3 ? { status: 503, body: { ok: false, description: 'Service unavailable' } } : undefined
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
    const stub = await createVkStub({
      script: (call) => {
        if (call.path !== '/self/get') return undefined
        attempts++
        return attempts === 1
          ? {
            status: 429,
            body: { ok: false, description: 'Too many requests' },
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

test('the in-band `ratelimit` description is retried like a 429', async () => {
  let attempts = 0
  const sleeps = []
  const stub = await createVkStub({
    script: (call) => {
      if (call.path !== '/self/get') return undefined
      attempts++
      return attempts === 1 ? { status: 200, body: { ok: false, description: 'ratelimit' } } : undefined
    },
  })
  try {
    const platform = makePlatform(stub, { sleep: async (ms) => { sleeps.push(ms) } })
    await platform.start()
    assert.equal(attempts, 2)
    assert.deepEqual(sleeps, [500])
  } finally {
    await stub.close()
  }
})

test('a network failure is retried and the final error hides the token', async () => {
  let attempts = 0
  let logged
  const platform = new VkTeamsPlatform({
    token: 'secret-token',
    apiBase: 'https://myteam.mail.ru/bot/v1',
    logger: { ...silentLogger, warn: (message, fields) => { logged = { message, fields } } },
    sleep: async () => {},
    maxAttempts: 3,
    fetchImpl: async (url) => {
      attempts++
      // The URL carries the token; a failure that echoes it must be redacted.
      throw new TypeError(`request to ${url} failed`)
    },
  })
  await assert.rejects(() => platform.start(), (error) => {
    assert.ok(error instanceof VkTeamsError)
    assert.equal(error.method, 'GET /self/get')
    assert.match(error.message, /failed after 3 attempts/)
    assert.equal(error.message.includes('secret-token'), false)
    assert.equal(String(error.cause?.message).includes('secret-token'), false)
    return true
  })
  assert.equal(attempts, 3)
  assert.equal(JSON.stringify(logged).includes('secret-token'), false)
  assert.equal(JSON.stringify(logged).includes('***'), true)
})

test('redactToken removes every occurrence of the secret', () => {
  assert.equal(redactToken('token=abc&x=1', 'abc'), 'token=***&x=1')
  assert.equal(redactToken('abcabc', 'abc'), '******')
  assert.equal(redactToken('no secret here', ''), 'no secret here')
  assert.equal(redactToken(undefined, 'abc'), '')
})

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('toInlineKeyboardMarkup maps the neutral keyboard and trims what VK Teams cannot render', () => {
  assert.equal(toInlineKeyboardMarkup(undefined), undefined)
  assert.equal(toInlineKeyboardMarkup({ rows: [] }), undefined)
  assert.equal(toInlineKeyboardMarkup({ rows: [[{ text: '', data: 'x' }]] }), undefined)
  assert.equal(toInlineKeyboardMarkup({ rows: [[]] }), undefined)
  assert.deepEqual(
    toInlineKeyboardMarkup({ rows: [[{ text: 'A', data: 'a' }], [{ text: 'B', url: 'https://b.example' }]] }),
    [[{ text: 'A', callbackData: 'a' }], [{ text: 'B', url: 'https://b.example' }]],
  )
  // Rows and buttons beyond the documented 14 × 8 are dropped, not rejected.
  const wide = { rows: [Array.from({ length: 10 }, (_, index) => ({ text: `C${index}`, data: `c${index}` }))] }
  assert.equal(toInlineKeyboardMarkup(wide)[0].length, VK_TEAMS_KEYBOARD_BUTTONS)
  const tall = { rows: Array.from({ length: 20 }, (_, index) => [{ text: `R${index}`, data: `r${index}` }]) }
  assert.equal(toInlineKeyboardMarkup(tall).length, VK_TEAMS_KEYBOARD_ROWS)
  // `url` wins when a button carries both: the API forbids both at once.
  assert.deepEqual(toInlineKeyboardMarkup({ rows: [[{ text: 'X', url: 'https://x.example', data: 'x' }]] }), [[{ text: 'X', url: 'https://x.example' }]])
})

test('splitVkTeamsText respects the limit and keeps tags balanced', () => {
  assert.deepEqual(splitVkTeamsText('коротко'), ['коротко'])
  assert.deepEqual(splitVkTeamsText(''), [])

  const long = splitVkTeamsText('a'.repeat(9001), VK_TEAMS_TEXT_LIMIT)
  assert.equal(long.length, 3)
  assert.equal(long.every((chunk) => chunk.length <= VK_TEAMS_TEXT_LIMIT), true)

  const bold = splitVkTeamsText(`<b>${'жирный текст '.repeat(400)}</b>`, 300)
  assert.ok(bold.length > 1)
  for (const chunk of bold) {
    assert.ok(chunk.length <= 300)
    assert.equal((chunk.match(/<b>/g) ?? []).length, (chunk.match(/<\/b>/g) ?? []).length, `unbalanced tag in ${chunk.slice(0, 30)}`)
  }

  // Multi-byte characters must survive the cut.
  const emoji = splitVkTeamsText('🙂'.repeat(4000), 1000)
  assert.equal(emoji.every((chunk) => chunk.length <= 1000), true)
})

test('nextCursor keeps the highest event id and never moves backwards', () => {
  assert.equal(nextCursor([{ eventId: 1 }, { eventId: 7 }, { eventId: 3 }], 0), 7)
  assert.equal(nextCursor([], 55), 55)
  assert.equal(nextCursor([{ eventId: 4 }], 9), 9)
  assert.equal(nextCursor([{ eventId: '12' }], 0), 12)
  assert.equal(nextCursor([{ eventId: undefined }, {}], 5), 5)
})

test('createVkTeamsPlatform builds a usable adapter with the whole port surface', async () => {
  const stub = await createVkStub()
  try {
    const platform = createVkTeamsPlatform({
      token: 'secret-token',
      apiBase: stub.apiBase,
      logger: silentLogger,
      sleep: async () => {},
    })
    assert.ok(platform instanceof VkTeamsPlatform)
    assert.equal(platform.name, 'vk-teams')
    assert.equal(platform.namespace, 'vk')
    assert.equal(platform.identity, undefined)
    for (const method of ['start', 'stop', 'getUpdates', 'sendText', 'editText', 'answerCallback', 'sendTyping', 'downloadFile', 'setReaction', 'isFatalError']) {
      assert.equal(typeof platform[method], 'function', method)
    }
    await platform.start()
    assert.equal(platform.identity.username, 'test_bot')
    await platform.stop()
    assert.equal(DEFAULT_API_BASE, 'https://myteam.mail.ru/bot/v1')
  } finally {
    await stub.close()
  }
})
