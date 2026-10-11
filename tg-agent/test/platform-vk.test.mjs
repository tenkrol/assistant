/**
 * VK (VKontakte) community-bot adapter tests.
 *
 * They run against a fake VK API on 127.0.0.1, so the adapter exercises its real
 * fetch path without touching the network. The wire shape below is the one the
 * official documentation describes: `{response}` / `{error}` on
 * `api.vk.com/method`, `{ts, updates}` (or `{failed}`) on the long-poll server,
 * and a community token sent as the `access_token` query parameter.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  DEFAULT_API_BASE,
  DEFAULT_API_VERSION,
  DEFAULT_POLL_TIMEOUT_SEC,
  MAX_POLL_TIMEOUT_SEC,
  VK_INLINE_KEYBOARD_TOTAL,
  VK_KEYBOARD_BUTTONS,
  VK_KEYBOARD_ROWS,
  VK_LABEL_LIMIT,
  VK_PAYLOAD_LIMIT,
  VK_SNACKBAR_LIMIT,
  VK_TEXT_LIMIT,
  VkError,
  VkPlatform,
  createVkPlatform,
  decodeCallbackData,
  encodeCallbackData,
  isPrivatePeer,
  markdownToVkText,
  nextTs,
  normalizeWait,
  peerChatType,
  pickPhotoSize,
  pickPhotoUrl,
  redactToken,
  splitVkText,
  toVkKeyboard,
} from '../src/platforms/vk.mjs'

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

const defaultGroup = [{ id: 123, name: 'Test Community', screen_name: 'test_community' }]

/**
 * Fake VK API plus long-poll server.
 *
 * `longPoll` is a queue of `a_check` answers (the last one repeats).
 * `script(call, state)` may return `{status, body}` to force a failure, and
 * `downloadBytes` is what `/dl/*` serves.
 */
async function createVkStub({ group = defaultGroup, longPoll = [], script, downloadBytes = Buffer.from('hello') } = {}) {
  // The caller's array is kept by reference, so a test can append a poll answer
  // once it knows the stub's own origin (which the download fixtures need).
  const polls = longPoll
  const state = {
    requests: [],
    sends: [],
    edits: [],
    activities: [],
    answers: [],
    reactions: [],
    downloads: [],
    lpRequests: [],
    lpSessions: 0,
    lastPoll: undefined,
  }
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
    if (url.pathname === '/lp') state.lpRequests.push(call)
    if (url.pathname.startsWith('/dl/')) state.downloads.push(call)
    const api = url.pathname.startsWith('/method/') ? url.pathname.slice('/method/'.length) : undefined
    if (api) {
      call.api = api
      if (api === 'messages.send') state.sends.push(call)
      if (api === 'messages.edit') state.edits.push(call)
      if (api === 'messages.setActivity') state.activities.push(call)
      if (api === 'messages.sendMessageEventAnswer') state.answers.push(call)
      if (api === 'messages.sendReaction') state.reactions.push(call)
      if (api === 'groups.getLongPollServer') state.lpSessions += 1
    }
    const override = script?.(call, state)
    if (override) return reply(response, override.status ?? 200, override.body, override.headers)

    if (url.pathname === '/lp') {
      state.lastPoll = polls.shift() ?? state.lastPoll ?? { ts: '600', updates: [] }
      return reply(response, 200, state.lastPoll)
    }
    if (url.pathname.startsWith('/dl/')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': downloadBytes.length })
      response.end(downloadBytes)
      return
    }
    switch (api) {
      case 'groups.getById':
        return reply(response, 200, { response: group })
      case 'groups.getLongPollServer':
        return reply(response, 200, {
          response: {
            key: `key-${state.lpSessions}`,
            server: `http://${request.headers.host}/lp`,
            ts: String(500 + state.lpSessions),
          },
        })
      case 'messages.send':
        return reply(response, 200, { response: 5000 + state.sends.length })
      case 'messages.edit':
      case 'messages.setActivity':
      case 'messages.sendMessageEventAnswer':
        return reply(response, 200, { response: 1 })
      case 'messages.sendReaction':
        return reply(response, 200, { response: { result: 1 } })
      default:
        return reply(response, 200, { error: { error_code: 3, error_msg: `Unknown method passed: ${api}` } })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    state,
    origin,
    apiBase: `${origin}/method`,
    pushPoll: (entry) => polls.push(entry),
    close: () => closeServer(server),
  }
}

/** One `message_new` (or `message_edit`) event with the documented payload. */
function messageEvent({
  type = 'message_new',
  eventId = 'evt-1',
  id = 1000,
  date = 1700000000,
  peerId = 1,
  fromId = 1,
  text = 'привет',
  attachments,
  replyMessage,
  conversationMessageId = 15,
  nested = true,
  body,
} = {}) {
  const message = {
    id,
    date,
    peer_id: peerId,
    from_id: fromId,
    text,
    conversation_message_id: conversationMessageId,
    ...(attachments === undefined ? {} : { attachments }),
    ...(replyMessage === undefined ? {} : { reply_message: replyMessage }),
    ...(body === undefined ? {} : { body }),
  }
  return {
    type,
    event_id: eventId,
    v: '5.199',
    group_id: 123,
    object: nested ? { message, client_info: { keyboard: true, inline_keyboard: true } } : message,
  }
}

/** One `message_event` (callback tap). */
function callbackEvent({
  eventId = 'evt-9',
  callbackId = 'QDFWEscvSW',
  userId = 2,
  peerId = 2000000001,
  payload = '{"d":"cancel:3"}',
  conversationMessageId = 15,
} = {}) {
  return {
    type: 'message_event',
    event_id: eventId,
    v: '5.199',
    group_id: 123,
    object: {
      user_id: userId,
      peer_id: peerId,
      event_id: callbackId,
      payload,
      ...(conversationMessageId === undefined ? {} : { conversation_message_id: conversationMessageId }),
    },
  }
}

const photoAttachment = {
  type: 'photo',
  photo: {
    id: 1,
    owner_id: -123,
    sizes: [
      { type: 'm', url: 'https://sun.example/m.jpg', width: 130, height: 87 },
      { type: 'z', url: 'https://sun.example/z.jpg', width: 1080, height: 720 },
      { type: 'x', url: 'https://sun.example/x.jpg', width: 604, height: 403 },
    ],
  },
}

const docAttachment = {
  type: 'doc',
  doc: { id: 2, owner_id: -123, title: 'report.pdf', ext: 'pdf', size: 1234, url: 'https://sun.example/report.pdf' },
}

const voiceAttachment = {
  type: 'audio_message',
  audio_message: { id: 3, owner_id: 1, duration: 7, link_ogg: 'https://sun.example/v.ogg', link_mp3: 'https://sun.example/v.mp3' },
}

const makePlatform = (stub, options = {}) =>
  new VkPlatform({
    token: 'secret-token',
    groupId: 123,
    apiBase: stub?.apiBase,
    logger: silentLogger,
    sleep: async () => {},
    random: () => 0.5,
    ...options,
  })

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

test('start() fills identity from groups.getById and sends the token as a query parameter', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.start()
    assert.deepEqual(platform.identity, { id: 123, username: 'test_community', title: 'Test Community' })
    assert.equal(platform.name, 'vk')
    assert.equal(platform.namespace, 'vk')
    const call = stub.state.requests.find((request) => request.api === 'groups.getById')
    assert.equal(call.method, 'GET')
    assert.equal(call.query.access_token, 'secret-token')
    assert.equal(call.query.v, DEFAULT_API_VERSION)
    assert.equal(call.query.group_id, '123')
  } finally {
    await stub.close()
  }
})

test('start() accepts the API 5.139 {groups: [...]} shape and an unknown community id', async () => {
  const stub = await createVkStub({ group: { groups: [{ id: 777, name: 'Other', screen_name: 'other' }], profiles: [] } })
  try {
    const platform = makePlatform(stub, { groupId: undefined })
    await platform.start()
    // No group id was configured, so `groups.getById` is asked for the token's own community.
    const call = stub.state.requests.find((request) => request.api === 'groups.getById')
    assert.equal(call.query.group_id, undefined)
    assert.deepEqual(platform.identity, { id: 777, username: 'other', title: 'Other' })
    // The id found at start is the one long polling uses.
    await platform.getUpdates({ cursor: '1' })
    const session = stub.state.requests.find((request) => request.api === 'groups.getLongPollServer')
    assert.equal(session.query.group_id, '777')
  } finally {
    await stub.close()
  }
})

test('start() keeps going when groups.getById fails and logs the reason', async () => {
  const warnings = []
  const logger = { ...silentLogger, warn: (...args) => warnings.push(args) }
  const stub = await createVkStub({
    script: (call) => (call.api === 'groups.getById'
      ? { body: { error: { error_code: 5, error_msg: 'User authorization failed' } } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub, { logger })
    await platform.start()
    assert.deepEqual(platform.identity, { id: 123, username: undefined, title: undefined })
    assert.equal(warnings.some(([message]) => message === 'vk identity lookup failed'), true)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// Long polling
// ---------------------------------------------------------------------------

test('getUpdates acquires the long-poll server, polls with the cursor and advances ts', async () => {
  const stub = await createVkStub({
    longPoll: [{ ts: '601', updates: [messageEvent({ text: 'привет' })] }],
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.getUpdates({ cursor: '550', timeoutSec: 25 })
    assert.equal(result.cursor, '601')
    assert.equal(result.updates.length, 1)
    assert.equal(result.updates[0].text, 'привет')
    const session = stub.state.requests.find((request) => request.api === 'groups.getLongPollServer')
    assert.equal(session.query.group_id, '123')
    assert.equal(session.query.access_token, 'secret-token')
    const poll = stub.state.lpRequests[0]
    assert.equal(poll.query.act, 'a_check')
    assert.equal(poll.query.key, 'key-1')
    assert.equal(poll.query.ts, '550')
    assert.equal(poll.query.wait, '25')
    // The long-poll server needs no token at all.
    assert.equal(poll.query.access_token, undefined)
  } finally {
    await stub.close()
  }
})

test('the first poll uses the ts from groups.getLongPollServer when no cursor is given', async () => {
  const stub = await createVkStub({ longPoll: [{ ts: '601', updates: [] }] })
  try {
    const platform = makePlatform(stub)
    const result = await platform.getUpdates({})
    assert.equal(stub.state.lpRequests[0].query.ts, '501')
    assert.equal(result.cursor, '601')
  } finally {
    await stub.close()
  }
})

test('failed:2 re-fetches the session key and continues from the new ts', async () => {
  const stub = await createVkStub({
    longPoll: [{ failed: 2, ts: '601' }, { ts: '700', updates: [] }],
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.getUpdates({ cursor: '550' })
    assert.equal(stub.state.lpSessions, 2)
    assert.equal(stub.state.lpRequests[1].query.key, 'key-2')
    assert.equal(stub.state.lpRequests[1].query.ts, '601')
    assert.equal(result.cursor, '700')
  } finally {
    await stub.close()
  }
})

test('failed:3 re-fetches the server and uses the fresh ts', async () => {
  const stub = await createVkStub({
    longPoll: [{ failed: 3 }, { ts: '900', updates: [] }],
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.getUpdates({ cursor: '1' })
    assert.equal(stub.state.lpSessions, 2)
    assert.equal(stub.state.lpRequests[1].query.key, 'key-2')
    // The second session's ts (502) wins over the lost history.
    assert.equal(stub.state.lpRequests[1].query.ts, '502')
    assert.equal(result.cursor, '900')
  } finally {
    await stub.close()
  }
})

test('failed:1 keeps the session and continues from the returned ts', async () => {
  const stub = await createVkStub({
    longPoll: [{ failed: 1, ts: '777' }, { ts: '800', updates: [] }],
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.getUpdates({ cursor: '550' })
    assert.equal(stub.state.lpSessions, 1)
    assert.equal(stub.state.lpRequests.length, 2)
    assert.equal(stub.state.lpRequests[1].query.key, 'key-1')
    assert.equal(stub.state.lpRequests[1].query.ts, '777')
    assert.equal(result.cursor, '800')
  } finally {
    await stub.close()
  }
})

test('the cursor never rolls back when the server reports a lower ts', async () => {
  const stub = await createVkStub({
    longPoll: [{ failed: 1, ts: '5' }, { ts: '10', updates: [] }],
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.getUpdates({ cursor: '900' })
    assert.equal(result.cursor, '900')
    assert.equal(stub.state.lpRequests[1].query.ts, '900')
  } finally {
    await stub.close()
  }
})

test('an unknown failed code is raised instead of looping', async () => {
  const stub = await createVkStub({ longPoll: [{ failed: 9 }] })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(() => platform.getUpdates({ cursor: '1' }), (error) => {
      assert.ok(error instanceof VkError)
      assert.match(error.message, /unknown code 9/)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('wait is clamped to the documented 1..90 second range', () => {
  assert.equal(normalizeWait(undefined), DEFAULT_POLL_TIMEOUT_SEC)
  assert.equal(DEFAULT_POLL_TIMEOUT_SEC, 25)
  assert.equal(normalizeWait(200), MAX_POLL_TIMEOUT_SEC)
  assert.equal(normalizeWait(90), 90)
  assert.equal(normalizeWait(0), 1)
  assert.equal(normalizeWait('30'), 30)
})

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('a private message_new is normalised and always addressed', async () => {
  const stub = await createVkStub({ longPoll: [{ ts: '700', updates: [messageEvent({ text: '  привет  ' })] }] })
  try {
    const platform = makePlatform(stub)
    const [update] = (await platform.getUpdates({ cursor: '1' })).updates
    assert.equal(update.kind, 'message')
    assert.equal(update.id, 'evt-1')
    assert.deepEqual(update.chat, { id: 1, type: 'private' })
    assert.deepEqual(update.from, { id: 1, name: undefined, username: undefined, isBot: false })
    assert.equal(update.text, 'привет')
    assert.equal(update.addressed, true)
    assert.equal(update.messageId, 1000)
    assert.equal(update.replyToMessageId, 1000)
    assert.deepEqual(update.attachments, [])
  } finally {
    await stub.close()
  }
})

test('a conversation message is only addressed by a mention or a reply', async () => {
  const stub = await createVkStub({
    longPoll: [{
      ts: '700',
      updates: [
        messageEvent({ eventId: 'a', peerId: 2000000001, text: 'привет всем' }),
        messageEvent({ eventId: 'b', peerId: 2000000001, text: 'бот [club123|Тест], помоги' }),
        messageEvent({ eventId: 'c', peerId: 2000000001, text: 'эй @club123' }),
        messageEvent({ eventId: 'd', peerId: 2000000001, text: '@test_community помоги' }),
      ],
    }],
  })
  try {
    const platform = makePlatform(stub)
    // The short-name form needs the identity from `start()`.
    await platform.start()
    const { updates } = await platform.getUpdates({ cursor: '1' })
    assert.deepEqual(updates.map((update) => update.addressed), [false, true, true, true])
    assert.deepEqual(updates.map((update) => update.chat.type), ['group', 'group', 'group', 'group'])
  } finally {
    await stub.close()
  }
})

test('a reply to the community or to one of our messages addresses the bot', async () => {
  const stub = await createVkStub({
    longPoll: [{
      ts: '700',
      updates: [
        messageEvent({
          eventId: 'a',
          peerId: 2000000001,
          text: 'ответ',
          replyMessage: { id: 999, from_id: -123, text: 'прошлый ответ' },
        }),
        messageEvent({
          eventId: 'b',
          peerId: 2000000001,
          text: 'ответ без from_id',
          replyMessage: { id: 5001, text: 'наш ответ' },
        }),
        messageEvent({
          eventId: 'c',
          peerId: 2000000001,
          text: 'ответ человеку',
          replyMessage: { id: 998, from_id: 5, text: 'чужое' },
        }),
      ],
    }],
  })
  try {
    const platform = makePlatform(stub)
    // 5001 is the id the stub returns for the first `messages.send`.
    await platform.sendText({ chatId: 2000000001, markdown: 'наш ответ' })
    const { updates } = await platform.getUpdates({ cursor: '1' })
    assert.deepEqual(updates.map((update) => update.addressed), [true, true, false])
  } finally {
    await stub.close()
  }
})

test('message_edit and message_reply from the community are marked as the bot', async () => {
  const stub = await createVkStub({
    longPoll: [{
      ts: '700',
      updates: [
        messageEvent({ eventId: 'a', type: 'message_edit', fromId: -123, peerId: 1, text: 'правка' }),
        messageEvent({ eventId: 'b', type: 'message_reply', fromId: -123, peerId: 1, text: 'исходящее' }),
      ],
    }],
  })
  try {
    const platform = makePlatform(stub)
    const { updates } = await platform.getUpdates({ cursor: '1' })
    assert.deepEqual(updates.map((update) => update.from.isBot), [true, true])
  } finally {
    await stub.close()
  }
})

test('attachments keep the largest photo, the document and the voice note', async () => {
  const stub = await createVkStub({
    longPoll: [{
      ts: '700',
      updates: [messageEvent({
        text: '',
        attachments: [photoAttachment, docAttachment, voiceAttachment, { type: 'sticker', sticker: { sticker_id: 1 } }],
      })],
    }],
  })
  try {
    const platform = makePlatform(stub)
    const [update] = (await platform.getUpdates({ cursor: '1' })).updates
    assert.deepEqual(update.attachments, [
      { kind: 'photo', url: 'https://sun.example/z.jpg', fileId: 'photo-123_1', width: 1080, height: 720 },
      { kind: 'document', url: 'https://sun.example/report.pdf', fileId: 'doc-123_2', name: 'report.pdf', ext: 'pdf', size: 1234 },
      { kind: 'voice', url: 'https://sun.example/v.ogg', fileId: 'audio_message1_3', duration: 7 },
    ])
  } finally {
    await stub.close()
  }
})

test('an API < 5.103 event object (the message itself, text in body) is accepted', async () => {
  const stub = await createVkStub({
    longPoll: [{
      ts: '700',
      updates: [{
        type: 'message_new',
        event_id: 'evt-old',
        object: { id: 42, peer_id: 5, from_id: 5, body: 'старый формат', date: 1 },
      }],
    }],
  })
  try {
    const platform = makePlatform(stub)
    const [update] = (await platform.getUpdates({ cursor: '1' })).updates
    assert.equal(update.text, 'старый формат')
    assert.deepEqual(update.chat, { id: 5, type: 'private' })
    assert.equal(update.messageId, 42)
  } finally {
    await stub.close()
  }
})

test('a message_event becomes a callback that remembers user_id and peer_id', async () => {
  const stub = await createVkStub({
    longPoll: [{ ts: '700', updates: [callbackEvent(), messageEvent({ eventId: 'x', type: 'message_typing_state' })] }],
  })
  try {
    const platform = makePlatform(stub)
    const { updates } = await platform.getUpdates({ cursor: '1' })
    assert.equal(updates.length, 1)
    const [update] = updates
    assert.equal(update.kind, 'callback')
    assert.equal(update.chat.id, 2000000001)
    assert.equal(update.chat.type, 'group')
    assert.equal(update.from.id, 2)
    assert.equal(update.addressed, true)
    assert.equal(update.callback.id, 'QDFWEscvSW')
    assert.equal(update.callback.data, 'cancel:3')
    assert.equal(update.callback.messageId, 15)
    assert.equal(update.callback.userId, 2)
    assert.equal(update.callback.peerId, 2000000001)
    assert.equal(update.callback.chatId, 2000000001)
    assert.equal(update.callback.conversationMessageId, 15)
    assert.equal(update.callback.text, undefined)
  } finally {
    await stub.close()
  }
})

test('an event without a usable peer id or an unknown type is dropped', async () => {
  const stub = await createVkStub({
    longPoll: [{
      ts: '700',
      updates: [
        { type: 'group_join', event_id: 'g', object: { user_id: 1 } },
        { type: 'message_new', event_id: 'm', object: { message: { text: 'нет peer_id' } } },
        { type: 'message_event', event_id: 'c', object: { user_id: 2, peer_id: 1 } },
      ],
    }],
  })
  try {
    const platform = makePlatform(stub)
    const { updates } = await platform.getUpdates({ cursor: '1' })
    assert.deepEqual(updates, [])
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// sendText / editText / typing / callbacks
// ---------------------------------------------------------------------------

test('sendText sends a fresh random_id, quotes the message and returns the id', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    const first = await platform.sendText({ chatId: 1, markdown: 'привет', replyToMessageId: 1000 })
    const second = await platform.sendText({ chatId: 1, markdown: 'ещё раз' })
    assert.equal(first.messageId, 5001)
    assert.equal(second.messageId, 5002)
    assert.equal(stub.state.sends.length, 2)
    assert.equal(stub.state.sends[0].query.peer_id, '1')
    assert.equal(stub.state.sends[0].query.message, 'привет')
    assert.equal(stub.state.sends[0].query.reply_to, '1000')
    assert.equal(stub.state.sends[1].query.reply_to, undefined)
    const ids = stub.state.sends.map((call) => call.query.random_id)
    assert.equal(ids.every((id) => /^\d+$/.test(id)), true)
    assert.notEqual(ids[0], ids[1])
  } finally {
    await stub.close()
  }
})

test('sendText builds the keyboard: url → open_link, data → callback', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.sendText({
      chatId: 1,
      markdown: 'выберите',
      keyboard: { rows: [[{ text: 'Сайт', url: 'https://example.com' }, { text: 'Отмена', data: 'cancel:3' }]] },
    })
    const keyboard = JSON.parse(stub.state.sends[0].query.keyboard)
    // A private dialog gets a persistent keyboard.
    assert.equal(keyboard.inline, false)
    assert.equal(keyboard.one_time, false)
    assert.deepEqual(keyboard.buttons, [[
      { action: { type: 'open_link', link: 'https://example.com', label: 'Сайт' }, color: 'secondary' },
      { action: { type: 'callback', label: 'Отмена', payload: '{"d":"cancel:3"}' }, color: 'secondary' },
    ]])
  } finally {
    await stub.close()
  }
})

test('a conversation gets an inline keyboard and long text is split with the keyboard last', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    const keyboard = { rows: [[{ text: 'Отмена', data: 'cancel:3' }]] }
    await platform.sendText({ chatId: 2000000001, markdown: 'a'.repeat(9000), keyboard })
    assert.equal(stub.state.sends.length, 3)
    assert.equal(stub.state.sends.every((call) => call.query.message.length <= VK_TEXT_LIMIT), true)
    assert.equal(stub.state.sends.slice(0, 2).every((call) => call.query.keyboard === undefined), true)
    assert.equal(JSON.parse(stub.state.sends[2].query.keyboard).inline, true)
    assert.deepEqual(stub.state.sends.map((call) => JSON.parse(JSON.stringify(call.query.peer_id))), ['2000000001', '2000000001', '2000000001'])
  } finally {
    await stub.close()
  }
})

test('editText sends message_id with the plain text and can replace the keyboard', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.editText({
      chatId: 1,
      messageId: 5001,
      markdown: '**готово**',
      keyboard: { rows: [[{ text: 'Ок', data: 'ok:1' }]] },
    })
    const call = stub.state.edits[0]
    assert.equal(call.query.peer_id, '1')
    assert.equal(call.query.message_id, '5001')
    // VK has no formatting: the asterisks are gone.
    assert.equal(call.query.message, 'готово')
    assert.deepEqual(JSON.parse(call.query.keyboard).buttons, [[
      { action: { type: 'callback', label: 'Ок', payload: '{"d":"ok:1"}' }, color: 'secondary' },
    ]])
  } finally {
    await stub.close()
  }
})

test('sendTyping asks for the typing activity and swallows a failure', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    await platform.sendTyping({ chatId: 2000000001 })
    const call = stub.state.activities[0]
    assert.equal(call.api, 'messages.setActivity')
    assert.equal(call.query.peer_id, '2000000001')
    assert.equal(call.query.type, 'typing')
    assert.equal(call.query.group_id, '123')
  } finally {
    await stub.close()
  }

  const failing = await createVkStub({
    script: (call) => (call.api === 'messages.setActivity'
      ? { body: { error: { error_code: 15, error_msg: 'Access denied' } } }
      : undefined),
  })
  try {
    const platform = makePlatform(failing)
    await platform.sendTyping({ chatId: 1 })
  } finally {
    await failing.close()
  }
})

test('answerCallback sends the remembered ids in event_data', async () => {
  const stub = await createVkStub({ longPoll: [{ ts: '700', updates: [callbackEvent()] }] })
  try {
    const platform = makePlatform(stub)
    await platform.getUpdates({ cursor: '1' })
    await platform.answerCallback({ callbackId: 'QDFWEscvSW', text: 'Напоминание отменено', alert: false })
    const call = stub.state.answers[0]
    assert.equal(call.api, 'messages.sendMessageEventAnswer')
    assert.equal(call.query.event_id, 'QDFWEscvSW')
    assert.equal(call.query.user_id, '2')
    assert.equal(call.query.peer_id, '2000000001')
    const data = JSON.parse(call.query.event_data)
    assert.equal(data.type, 'show_snackbar')
    assert.equal(data.text, 'Напоминание отменено')
  } finally {
    await stub.close()
  }
})

test('answerCallback truncates the snackbar and is a no-op without known ids', async () => {
  const stub = await createVkStub({ longPoll: [{ ts: '700', updates: [callbackEvent()] }] })
  try {
    const platform = makePlatform(stub)
    await platform.getUpdates({ cursor: '1' })
    await platform.answerCallback({ callbackId: 'QDFWEscvSW', text: 'я'.repeat(200) })
    assert.equal(JSON.parse(stub.state.answers[0].query.event_data).text.length, VK_SNACKBAR_LIMIT)

    // An event nobody saw: VK cannot answer it, so nothing is sent and nothing throws.
    const before = stub.state.answers.length
    await platform.answerCallback({ callbackId: 'unknown', text: 'привет' })
    assert.equal(stub.state.answers.length, before)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// downloadFile / setReaction
// ---------------------------------------------------------------------------

test('downloadFile fetches an attachment url and reports its size', async () => {
  const bytes = Buffer.from('document body')
  const stub = await createVkStub({ downloadBytes: bytes })
  try {
    const platform = makePlatform(stub)
    const file = await platform.downloadFile({ url: `${stub.origin}/dl/report.pdf` })
    assert.equal(file.size, bytes.length)
    assert.deepEqual(file.bytes, bytes)
    assert.equal(stub.state.downloads.length, 1)
  } finally {
    await stub.close()
  }
})

test('downloadFile works from a remembered fileId and reports a missing target', async () => {
  const stub = await createVkStub()
  try {
    const platform = makePlatform(stub)
    // The fixture URL is only known once the stub is listening.
    stub.pushPoll({
      ts: '700',
      updates: [messageEvent({
        attachments: [{ type: 'doc', doc: { ...docAttachment.doc, url: `${stub.origin}/dl/report.pdf` } }],
      })],
    })
    await platform.getUpdates({ cursor: '1' })
    const file = await platform.downloadFile({ fileId: 'doc-123_2' })
    assert.equal(file.fileName, 'report.pdf')
    await assert.rejects(() => platform.downloadFile({ fileId: 'doc-1_1' }), (error) => {
      assert.ok(error instanceof VkError)
      assert.match(error.message, /neither a download url/)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('downloadFile refuses a file above maxBytes by its declared length', async () => {
  const stub = await createVkStub({ downloadBytes: Buffer.from('0123456789') })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(() => platform.downloadFile({ url: `${stub.origin}/dl/big`, maxBytes: 4 }), (error) => {
      assert.ok(error instanceof VkError)
      assert.match(error.message, /too large \(10 bytes, limit 4\)/)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('setReaction uses the conversation id and reaction id, and unknown emoji is a no-op', async () => {
  const stub = await createVkStub({ longPoll: [{ ts: '700', updates: [messageEvent({ text: 'напоминание' })] }] })
  try {
    const platform = makePlatform(stub)
    await platform.getUpdates({ cursor: '1' })
    await platform.setReaction({ chatId: 1, messageId: 1000, emoji: '🔥' })
    const call = stub.state.reactions[0]
    assert.equal(call.api, 'messages.sendReaction')
    assert.equal(call.query.peer_id, '1')
    assert.equal(call.query.cmid, '15')
    assert.equal(call.query.reaction_id, '2')

    const before = stub.state.reactions.length
    await platform.setReaction({ chatId: 1, messageId: 1000, emoji: '👀' })
    assert.equal(stub.state.reactions.length, before)
  } finally {
    await stub.close()
  }
})

test('setReaction degrades to a no-op when VK refuses the reaction', async () => {
  const stub = await createVkStub({
    longPoll: [{ ts: '700', updates: [messageEvent({ text: 'напоминание' })] }],
    script: (call) => (call.api === 'messages.sendReaction'
      ? { body: { error: { error_code: 15, error_msg: 'Access denied' } } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.getUpdates({ cursor: '1' })
    assert.equal(await platform.setReaction({ chatId: 1, messageId: 1000, emoji: '👍' }), undefined)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('error_code 5 is fatal, raised as VkError, and never leaks the token', async () => {
  const stub = await createVkStub({
    script: (call) => (call.api === 'messages.send'
      ? { body: { error: { error_code: 5, error_msg: 'User authorization failed: invalid access_token secret-token' } } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(() => platform.sendText({ chatId: 1, markdown: 'привет' }), (error) => {
      assert.ok(error instanceof VkError)
      assert.equal(error.code, 5)
      assert.equal(error.fatal, true)
      assert.equal(platform.isFatalError(error), true)
      assert.equal(error.message.includes('secret-token'), false)
      assert.equal(error.message.includes('***'), true)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('error_code 6 is retried with backoff and then succeeds', async () => {
  const attempts = []
  const stub = await createVkStub({
    script: (call) => {
      if (call.api !== 'messages.send') return undefined
      attempts.push(call)
      if (attempts.length === 1) {
        return { body: { error: { error_code: 6, error_msg: 'Too many requests per second' } } }
      }
      return undefined
    },
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.sendText({ chatId: 1, markdown: 'привет' })
    assert.equal(attempts.length, 2)
    assert.equal(typeof result.messageId, 'number')
  } finally {
    await stub.close()
  }
})

test('a network failure is retried and the token is redacted from the retry log', async () => {
  const stub = await createVkStub()
  const warnings = []
  const logger = { ...silentLogger, warn: (...args) => warnings.push(args) }
  let calls = 0
  const flakyFetch = async (url, init) => {
    calls += 1
    if (calls === 1) throw new Error(`request to ${url} failed`)
    return globalThis.fetch(url, init)
  }
  try {
    const platform = makePlatform(stub, { fetchImpl: flakyFetch, logger })
    const result = await platform.sendText({ chatId: 1, markdown: 'привет' })
    assert.equal(calls, 2)
    assert.equal(typeof result.messageId, 'number')
    const logged = JSON.stringify(warnings)
    assert.equal(logged.includes('secret-token'), false)
    assert.equal(logged.includes('***'), true)
  } finally {
    await stub.close()
  }
})

test('a missing token fails immediately without building a query', async () => {
  const platform = new VkPlatform({ token: '', groupId: 123, apiBase: 'http://127.0.0.1:1/method', logger: silentLogger })
  await assert.rejects(() => platform.sendText({ chatId: 1, markdown: 'привет' }), (error) => {
    assert.ok(error instanceof VkError)
    assert.match(error.message, /no community token/)
    return true
  })
})

test('isFatalError recognises 5/15/27 and not 6', () => {
  const platform = makePlatform(undefined)
  assert.equal(platform.isFatalError(new VkError('x', { code: 5 })), true)
  assert.equal(platform.isFatalError(new VkError('x', { code: 27 })), true)
  assert.equal(platform.isFatalError(new VkError('x', { code: 15 })), true)
  assert.equal(platform.isFatalError(new VkError('x', { code: 6 })), false)
  assert.equal(platform.isFatalError(new Error('boom')), false)
})

test('redactToken removes the secret wherever it appears', () => {
  assert.equal(redactToken('https://api.vk.com/method/x?access_token=abc', 'abc'), 'https://api.vk.com/method/x?access_token=***')
  assert.equal(redactToken('plain', ''), 'plain')
  assert.equal(redactToken(undefined, 'abc'), '')
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('markdownToVkText strips the markers VK cannot render', () => {
  assert.equal(markdownToVkText(''), '')
  assert.equal(markdownToVkText('**жирный** и *курсив*'), 'жирный и курсив')
  assert.equal(markdownToVkText('# Заголовок'), 'Заголовок')
  assert.equal(markdownToVkText('- один\n- два'), '• один\n• два')
  assert.equal(markdownToVkText('~~нет~~'), 'нет')
  assert.equal(markdownToVkText('[сайт](https://example.com)'), 'сайт (https://example.com)')
  // Code spans are protected: their asterisks are content, not emphasis.
  assert.equal(markdownToVkText('`a * b * c`'), 'a * b * c')
  assert.equal(markdownToVkText('```\nx ** y\n```'), 'x ** y')
})

test('splitVkText respects the limit, keeps paragraphs and survives emoji', () => {
  assert.deepEqual(splitVkText(''), [])
  assert.deepEqual(splitVkText('коротко'), ['коротко'])
  assert.deepEqual(splitVkText('a'.repeat(9001)).map((chunk) => chunk.length), [VK_TEXT_LIMIT, VK_TEXT_LIMIT, 9001 - 2 * VK_TEXT_LIMIT])

  const paragraphs = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`
  assert.deepEqual(splitVkText(paragraphs, 40), ['a'.repeat(30), 'b'.repeat(30)])

  const emoji = splitVkText('🙂'.repeat(4000), 1000)
  assert.equal(emoji.every((chunk) => chunk.length <= 1000), true)
  assert.equal(emoji.join(''), '🙂'.repeat(4000))
})

test('toVkKeyboard trims what VK cannot render and caps the rows', () => {
  assert.equal(toVkKeyboard(undefined), undefined)
  assert.equal(toVkKeyboard({ rows: [] }), undefined)
  assert.equal(toVkKeyboard({ rows: [[{ text: '', data: 'x' }]] }), undefined)

  const wide = { rows: [Array.from({ length: 9 }, (_, index) => ({ text: `C${index}`, data: `c${index}` }))] }
  assert.equal(toVkKeyboard(wide).buttons[0].length, VK_KEYBOARD_BUTTONS)
  const tall = { rows: Array.from({ length: 20 }, (_, index) => [{ text: `R${index}`, data: `r${index}` }]) }
  assert.equal(toVkKeyboard(tall).buttons.length, VK_KEYBOARD_ROWS)

  // An inline keyboard holds at most ten buttons in total.
  const many = { rows: Array.from({ length: 6 }, (_, row) => Array.from({ length: 4 }, (_, column) => ({ text: `${row}${column}`, data: `${row}${column}` }))) }
  const inlineTotal = toVkKeyboard(many, { inline: true }).buttons.flat().length
  assert.equal(inlineTotal, VK_INLINE_KEYBOARD_TOTAL)

  // Labels are capped at 40 characters.
  const long = toVkKeyboard({ rows: [[{ text: 'u'.repeat(100), data: 'x' }]] })
  assert.equal(long.buttons[0][0].action.label.length, VK_LABEL_LIMIT)
  // A button without url or data is a plain text button.
  assert.deepEqual(toVkKeyboard({ rows: [[{ text: 'Дальше' }]] }).buttons, [[{ action: { type: 'text', label: 'Дальше' }, color: 'secondary' }]])
})

test('encodeCallbackData round-trips through decodeCallbackData within the VK payload cap', () => {
  assert.equal(encodeCallbackData('cancel:3'), '{"d":"cancel:3"}')
  assert.equal(decodeCallbackData('{"d":"cancel:3"}'), 'cancel:3')
  assert.equal(decodeCallbackData('snooze:10:2'), 'snooze:10:2')
  assert.equal(decodeCallbackData(undefined), '')
  assert.equal(decodeCallbackData({ d: 'cancel:9' }), 'cancel:9')
  assert.equal(decodeCallbackData({ command: 'start' }), '')
  assert.equal(encodeCallbackData('x'.repeat(400)).length, VK_PAYLOAD_LIMIT)
})

test('pickPhotoSize prefers the largest copy and tolerates legacy src fields', () => {
  assert.equal(pickPhotoUrl({ sizes: [] }), undefined)
  assert.equal(pickPhotoUrl(photoAttachment.photo), 'https://sun.example/z.jpg')
  assert.equal(pickPhotoUrl({ sizes: [{ type: 'm', src: 'https://sun.example/legacy.jpg', width: 130, height: 87 }] }), 'https://sun.example/legacy.jpg')
  assert.deepEqual(pickPhotoSize({ sizes: [{ url: 'https://a', width: 0, height: 0 }] }), { url: 'https://a', width: 0, height: 0 })
})

test('peer helpers and nextTs follow the documented ranges', () => {
  assert.equal(isPrivatePeer(1), true)
  assert.equal(isPrivatePeer(1999999999), true)
  assert.equal(isPrivatePeer(2000000000), false)
  assert.equal(isPrivatePeer(-123), false)
  assert.equal(peerChatType(5), 'private')
  assert.equal(peerChatType(2000000001), 'group')
  assert.equal(nextTs(undefined, '5'), '5')
  assert.equal(nextTs('5', undefined), '5')
  assert.equal(nextTs('5', '9'), '9')
  assert.equal(nextTs('9', '5'), '9')
})

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

test('createVkPlatform builds a usable adapter with the whole port surface', async () => {
  const stub = await createVkStub()
  try {
    const platform = createVkPlatform({
      token: 'secret-token',
      groupId: 123,
      apiBase: stub.apiBase,
      logger: silentLogger,
      sleep: async () => {},
    })
    assert.ok(platform instanceof VkPlatform)
    assert.equal(platform.name, 'vk')
    assert.equal(platform.namespace, 'vk')
    assert.equal(platform.identity, undefined)
    for (const method of ['start', 'stop', 'getUpdates', 'sendText', 'editText', 'answerCallback', 'sendTyping', 'downloadFile', 'setReaction', 'isFatalError']) {
      assert.equal(typeof platform[method], 'function', method)
    }
    await platform.start()
    assert.equal(platform.identity.username, 'test_community')
    await platform.stop()
    assert.equal(DEFAULT_API_BASE, 'https://api.vk.com/method')
    assert.equal(DEFAULT_API_VERSION, '5.199')
  } finally {
    await stub.close()
  }
})

test('the adapter never reads the process environment', async () => {
  // Reading env inside the adapter made behaviour depend on whatever the host
  // exported: a deployment tool that loads .env leaked the real VK_GROUP_ID into
  // this suite and turned a passing test into a failing one. Configuration is
  // config.mjs's job; the adapter only uses what it is given.
  const saved = { ...process.env }
  process.env.VK_GROUP_ID = '999999'
  process.env.VK_TOKEN = 'env-token'
  process.env.VK_API_BASE = 'http://env.invalid/method'
  try {
    const platform = createVkPlatform({ token: 'option-token', groupId: '', apiBase: 'http://127.0.0.1:1/method', logger: silentLogger })
    assert.equal(platform.client.token, 'option-token')
    assert.equal(platform.groupId, undefined)
    assert.match(platform.client.apiBase, /127\.0\.0\.1:1/)
    const module = await import('node:fs')
    const source = module.readFileSync(new URL('../src/platforms/vk.mjs', import.meta.url), 'utf8')
    assert.equal(source.includes('process.env'), false, 'адаптер не должен читать окружение')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})

test('an expired long-poll session is routine: handled quietly without a warning', async () => {
  // VK expires the key about once an hour and the adapter simply asks for a new
  // one. Warning about it buried real problems under dozens of lines a day.
  const warnings = []
  const debugged = []
  const logger = { debug: (...args) => debugged.push(args), info() {}, warn: (...args) => warnings.push(args), error() {} }
  const stub = await createVkStub({ longPoll: [{ failed: 2, ts: '601' }, { ts: '700', updates: [] }] })
  try {
    const platform = makePlatform(stub, { logger })
    const result = await platform.getUpdates({ cursor: '600' })
    assert.equal(result.cursor, '700', 'опрос продолжился с новой меткой')
    assert.equal(warnings.filter((args) => String(args[0]).includes('long poll failed')).length, 0, 'без WARN')
    assert.ok(debugged.some((args) => String(args[0]).includes('session expired')), 'написано в debug')
  } finally {
    await stub.close()
  }
})

test('the typing indicator is sent once and never retried', async () => {
  // VK rate-limits setActivity; retrying decoration wasted calls and filled the log.
  const stub = await createVkStub({
    script: (call) => (call.api === 'messages.setActivity' ? { body: { error: { error_code: 10, error_msg: 'Internal server error' } } } : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.sendTyping({ chatId: 555 })
    const calls = stub.state.requests.filter((request) => request.api === 'messages.setActivity')
    assert.equal(calls.length, 1, 'ровно одна попытка')
  } finally {
    await stub.close()
  }
})

test('a mention before a command is stripped so the command still works', async () => {
  // VK sends «[club123|Название] /reminders»; the markup used to survive into the
  // text, so nothing that follows a mention was recognised as a command.
  const { stripMentionMarkup } = await import('../src/platforms/vk.mjs')
  assert.equal(stripMentionMarkup('[club242075818|Дом TenKrol] /reminders', { screenName: 'club242075818' }), '/reminders')
  assert.equal(stripMentionMarkup('@club242075818 /calendar', { screenName: 'club242075818' }), '/calendar')
  assert.equal(stripMentionMarkup('[club242075818] /help'), '/help')
  assert.equal(stripMentionMarkup('/reminders'), '/reminders', 'обычная команда не портится')
  assert.equal(stripMentionMarkup('бот [club1|X], помоги', { screenName: 'club1' }), 'бот, помоги', 'пробел перед запятой не остаётся')
  assert.equal(stripMentionMarkup('[club1|X] @club1 /search ремонт'), '/search ремонт')
  assert.equal(stripMentionMarkup('[club242075818]'), '', 'одно упоминание без текста даёт пустую строку')
  assert.equal(stripMentionMarkup('привет в чате'), 'привет в чате', 'обычный текст не меняется')
})
