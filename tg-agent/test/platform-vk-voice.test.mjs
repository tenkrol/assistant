/**
 * Голосовые ответы в VK: `sendVoice` адаптера.
 *
 * Путь документирован VK: `docs.getMessagesUploadServer` с типом
 * `audio_message` → POST `multipart/form-data` с OGG → `docs.save` →
 * `messages.send` с вложением `audio_message<owner_id>_<id>`.
 *
 * Вторая половина тестов держит обещание «голос — не сам ответ»: любой сбой
 * шага не бросается наружу, причина попадает в журнал, а подпись уходит
 * обычным текстом. Заглушка живёт на 127.0.0.1, поэтому адаптер проходит
 * настоящий путь `fetch`, но в сеть не выходит.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { VkPlatform } from '../src/integrations/platforms/vk.mjs'
import { capabilityLines } from '../src/core/capabilities.mjs'

const silentLogger = { warn() {}, debug() {}, info() {}, error() {} }

/** Журнал, который запоминает предупреждения: по ним проверяется причина отката. */
function recordingLogger() {
  const warnings = []
  return {
    warnings,
    warn(message, meta = {}) { warnings.push({ message, ...meta }) },
    debug() {},
    info() {},
    error() {},
  }
}

const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => { chunks.push(chunk) })
    request.on('end', () => resolve(Buffer.concat(chunks)))
  })

const reply = (response, status, payload, headers = {}) => {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers })
  response.end(body)
}

const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  })

const makePlatform = (stub, options = {}) =>
  new VkPlatform({
    token: 'secret-token',
    groupId: 123,
    apiBase: stub?.apiBase,
    logger: silentLogger,
    sleep: async () => {},
    random: () => 0.5,
    maxAttempts: 1,
    ...options,
  })

/**
 * Заглушка VK API и upload-сервера.
 *
 * `script(call, state)` может подменить ответ шага. По умолчанию голосовое
 * успешно загружается, сохраняется как `audio_message` с `owner_id: -123,
 * id: 777` и отправляется сообщением с id 7001.
 */
async function createVoiceStub({ script } = {}) {
  const state = {
    requests: [],
    uploadServers: [],
    uploads: [],
    saves: [],
    sends: [],
  }
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request)
    const url = new URL(request.url, 'http://127.0.0.1')
    const api = url.pathname.startsWith('/method/') ? url.pathname.slice('/method/'.length) : undefined
    const call = {
      method: request.method,
      path: url.pathname,
      api,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body,
    }
    state.requests.push(call)
    if (url.pathname === '/upload') state.uploads.push(call)
    if (api === 'docs.getMessagesUploadServer') state.uploadServers.push(call)
    if (api === 'docs.save') state.saves.push(call)
    if (api === 'messages.send') state.sends.push(call)

    const override = script?.(call, state)
    if (override) return reply(response, override.status ?? 200, override.body, override.headers)

    if (url.pathname === '/upload') {
      return reply(response, 200, { file: 'uploaded|voice|token' })
    }
    switch (api) {
      case 'docs.getMessagesUploadServer':
        return reply(response, 200, {
          response: { upload_url: `http://${request.headers.host}/upload?act=add_audio_message` },
        })
      case 'docs.save':
        return reply(response, 200, {
          response: { type: 'audio_message', audio_message: { id: 777, owner_id: -123, duration: 3 } },
        })
      case 'messages.send':
        return reply(response, 200, { response: 7000 + state.sends.length })
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
    close: () => closeServer(server),
  }
}

// ---------------------------------------------------------------------------
// Успешная отправка
// ---------------------------------------------------------------------------

test('sendVoice в VK: upload server → upload → docs.save → messages.send', async () => {
  const stub = await createVoiceStub()
  try {
    const platform = makePlatform(stub)
    const bytes = Buffer.from('OggS-voice-data')
    const result = await platform.sendVoice({
      chatId: 42,
      bytes,
      caption: 'Готовый **ответ**',
      replyToMessageId: 321,
    })

    assert.deepEqual(result, { messageId: 7001 })
    assert.deepEqual(
      stub.state.requests.map((call) => call.api ?? call.path),
      ['docs.getMessagesUploadServer', '/upload', 'docs.save', 'messages.send'],
      'ровно четыре шага в документированном порядке',
    )

    const server = stub.state.uploadServers[0]
    assert.equal(server.query.peer_id, '42')
    assert.equal(server.query.type, 'audio_message', 'VK загружает озвучку как audio_message')
    assert.equal(server.query.access_token, 'secret-token')

    const upload = stub.state.uploads[0]
    assert.equal(upload.method, 'POST')
    assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/)
    const form = upload.body.toString('latin1')
    assert.match(form, /name="file"/)
    assert.match(form, /filename="voice.ogg"/, 'расширение .ogg обязательно')
    assert.match(form, /Content-Type: audio\/ogg/)
    assert.ok(upload.body.includes(bytes), 'содержимое OGG уходит в multipart')
    assert.equal(upload.query.access_token, undefined, 'адрес загрузки не требует токена')

    const save = stub.state.saves[0]
    assert.equal(save.query.file, 'uploaded|voice|token')
    assert.equal(save.query.title, undefined, 'у озвучки нет названия документа')

    const send = stub.state.sends[0]
    assert.equal(send.query.attachment, 'audio_message-123_777')
    assert.equal(send.query.peer_id, '42')
    assert.equal(send.query.message, 'Готовый ответ', 'подпись доходит без markdown')
    assert.equal(send.query.reply_to, '321')
    assert.match(String(send.query.random_id), /^\d+$/, 'random_id как у остальных сообщений')

    assert.equal(platform.isOwnMessage(7001), true, 'отправленное голосовое запоминается как своё')
    assert.equal(platform.lastMessageByPeer.get('42'), 7001)
  } finally {
    await stub.close()
  }
})

test('sendVoice принимает старый ответ docs.save массивом', async () => {
  const stub = await createVoiceStub({
    script: (call) => (call.api === 'docs.save'
      ? { body: { response: [{ id: 888, owner_id: -123, duration: 2 }] } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    const result = await platform.sendVoice({ chatId: 42, bytes: Buffer.from('OggS') })
    assert.deepEqual(result, { messageId: 7001 })
    assert.equal(stub.state.sends[0].query.attachment, 'audio_message-123_888')
    assert.equal(stub.state.sends[0].query.message, undefined, 'без подписи остаётся только вложение')
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// Текстовый откат
// ---------------------------------------------------------------------------

test('сбой загрузки голосового: ответ уходит текстом, причина в журнале', async () => {
  const stub = await createVoiceStub({
    script: (call) => (call.path === '/upload' ? { status: 500, body: { error: 'upload failed' } } : undefined),
  })
  const logger = recordingLogger()
  try {
    const platform = makePlatform(stub, { logger })
    const result = await platform.sendVoice({
      chatId: 42,
      bytes: Buffer.from('OggS'),
      caption: 'Текстовый **ответ**',
    })

    assert.deepEqual(result, { messageId: 7001, fallback: 'text' }, 'метод не бросает и сообщает об откате')
    assert.equal(stub.state.saves.length, 0, 'после сбоя загрузки docs.save не вызывается')
    assert.equal(stub.state.sends.length, 1, 'вместо голоса уходит ровно один текст')
    const send = stub.state.sends[0]
    assert.equal(send.query.message, 'Текстовый ответ', 'подпись становится текстовым ответом')
    assert.equal(send.query.attachment, undefined)
    assert.equal(send.query.reply_to, undefined)

    assert.equal(logger.warnings.length, 1)
    assert.match(logger.warnings[0].message, /falling back to text/)
    assert.equal(logger.warnings[0].step, 'upload')
    assert.match(logger.warnings[0].reason, /HTTP 500/, 'причина сбоя попадает в журнал')
  } finally {
    await stub.close()
  }
})

test('сбой адреса загрузки: тоже текстовый откат', async () => {
  const stub = await createVoiceStub({
    script: (call) => (call.api === 'docs.getMessagesUploadServer'
      ? { body: { error: { error_code: 15, error_msg: 'Access denied' } } }
      : undefined),
  })
  const logger = recordingLogger()
  try {
    const platform = makePlatform(stub, { logger })
    const result = await platform.sendVoice({ chatId: 42, bytes: Buffer.from('OggS'), caption: 'Ответ' })

    assert.equal(result.fallback, 'text')
    assert.equal(stub.state.uploads.length, 0, 'без адреса загрузки OGG никуда не уходит')
    assert.equal(stub.state.sends[0].query.message, 'Ответ')
    assert.equal(logger.warnings[0].step, 'docs.getMessagesUploadServer')
    assert.match(logger.warnings[0].reason, /Access denied/)
  } finally {
    await stub.close()
  }
})

test('сбой messages.send для голосового: текст уходит вторым сообщением', async () => {
  let sends = 0
  const stub = await createVoiceStub({
    script: (call) => {
      if (call.api !== 'messages.send') return undefined
      sends += 1
      // Первая попытка — голосовое, вторая — текстовый откат.
      return sends === 1
        ? { body: { error: { error_code: 917, error_msg: "You don't have access to this chat" } } }
        : undefined
    },
  })
  const logger = recordingLogger()
  try {
    const platform = makePlatform(stub, { logger })
    const result = await platform.sendVoice({ chatId: 42, bytes: Buffer.from('OggS'), caption: 'Ответ' })

    assert.deepEqual(result, { messageId: 7002, fallback: 'text' })
    assert.equal(stub.state.sends.length, 2)
    assert.equal(stub.state.sends[0].query.attachment, 'audio_message-123_777')
    assert.equal(stub.state.sends[1].query.message, 'Ответ')
    assert.equal(stub.state.sends[1].query.attachment, undefined)
    assert.equal(logger.warnings[0].step, 'messages.send')
    assert.match(logger.warnings[0].reason, /You don't have access to this chat/)
  } finally {
    await stub.close()
  }
})

test('без подписи откат не отправляет пустое сообщение', async () => {
  const stub = await createVoiceStub({
    script: (call) => (call.path === '/upload' ? { status: 500, body: { error: 'upload failed' } } : undefined),
  })
  const logger = recordingLogger()
  try {
    const platform = makePlatform(stub, { logger })
    const result = await platform.sendVoice({ chatId: 42, bytes: Buffer.from('OggS') })

    assert.deepEqual(result, { fallback: 'text' })
    assert.equal(stub.state.sends.length, 0, 'VK не принимает сообщение без текста и вложения')
    assert.equal(logger.warnings.length, 1, 'причина всё равно в журнале')
  } finally {
    await stub.close()
  }
})

test('пустое голосовое не отправляется и не ходит в сеть', async () => {
  const logger = recordingLogger()
  const platform = makePlatform(undefined, { logger })
  const result = await platform.sendVoice({ chatId: 42, bytes: Buffer.alloc(0), caption: 'Ответ' })

  assert.equal(result.fallback, 'text')
  assert.equal(logger.warnings[0].step, 'sendVoice')
  assert.match(logger.warnings[0].reason, /содержимое пустое/)
})

// ---------------------------------------------------------------------------
// Контракт с ядром и возможности
// ---------------------------------------------------------------------------

test('ядро видит у VK и sendVoice, и sendDocument', () => {
  const platform = makePlatform(undefined)
  assert.equal(typeof platform.sendVoice, 'function')
  assert.equal(typeof platform.sendDocument, 'function')
})

test('возможности VK: файлы и голосовые ответы доступны', () => {
  const lines = capabilityLines({
    config: {},
    media: { transcribe: async () => '', extractText: async () => ({ text: '' }) },
    platformName: 'vk',
  })
  assert.equal(lines.some((line) => line.includes('файлы на выход')), true)
  assert.equal(lines.some((line) => line.includes('PDF, Excel, Word, CSV')), true)
  assert.equal(lines.some((line) => line.includes('голосовые')), true, 'входящие голосовые распознаются')
  assert.equal(lines.some((line) => line.includes('отвечать голосом')), true, 'озвучка ответов в VK доступна')
})
