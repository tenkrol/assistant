/**
 * Отправка файлов в VK: `sendDocument` адаптера.
 *
 * Проверяется весь путь, который описывает документация VK:
 * `docs.getMessagesUploadServer` → POST `multipart/form-data` на выданный
 * адрес → `docs.save` → `messages.send` с `attachment=doc<owner_id>_<id>`.
 * Заглушка живёт на 127.0.0.1, поэтому адаптер проходит настоящий путь
 * `fetch`, но в сеть не выходит.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { VkError, VkPlatform } from '../src/integrations/platforms/vk.mjs'
import { capabilityLines } from '../src/core/capabilities.mjs'

const silentLogger = { warn() {}, debug() {}, info() {}, error() {} }

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
    ...options,
  })

/**
 * Заглушка VK API и upload-сервера.
 *
 * `script(call, state)` может подменить ответ шага. По умолчанию документ
 * успешно загружается, сохраняется с `owner_id: -123, id: 777` и отправляется
 * сообщением с id 6001.
 */
async function createDocumentStub({ script } = {}) {
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
      return reply(response, 200, { file: 'uploaded|file|token' })
    }
    switch (api) {
      case 'docs.getMessagesUploadServer':
        return reply(response, 200, {
          response: { upload_url: `http://${request.headers.host}/upload?act=add_doc` },
        })
      case 'docs.save':
        return reply(response, 200, {
          response: { type: 'doc', doc: { id: 777, owner_id: -123, title: call.query.title } },
        })
      case 'messages.send':
        return reply(response, 200, { response: 6000 + state.sends.length })
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

/** Общая проверка ошибки шага: VkError, русский текст, метод. */
function assertStepError(error, { method, pattern }) {
  assert.ok(error instanceof VkError, 'ошибка шага — VkError')
  assert.equal(error.method, method)
  assert.match(error.message, pattern)
  return true
}

// ---------------------------------------------------------------------------
// Успешная отправка
// ---------------------------------------------------------------------------

test('sendDocument в личный чат: upload server → upload → docs.save → messages.send', async () => {
  const stub = await createDocumentStub()
  try {
    const platform = makePlatform(stub)
    const result = await platform.sendDocument({
      chatId: 42,
      bytes: Buffer.from('PDF-DATA'),
      fileName: 'report.pdf',
      caption: 'Готовый **отчёт**',
      replyToMessageId: 321,
    })

    assert.deepEqual(result, { messageId: 6001 })
    assert.deepEqual(
      stub.state.requests.map((call) => call.api ?? call.path),
      ['docs.getMessagesUploadServer', '/upload', 'docs.save', 'messages.send'],
      'ровно четыре шага в документированном порядке',
    )

    const server = stub.state.uploadServers[0]
    assert.equal(server.query.peer_id, '42', 'личный диалог — это user id')
    assert.equal(server.query.type, 'doc')
    assert.equal(server.query.access_token, 'secret-token')

    const upload = stub.state.uploads[0]
    assert.equal(upload.method, 'POST')
    assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/)
    const form = upload.body.toString('utf8')
    assert.match(form, /name="file"/)
    assert.match(form, /filename="report.pdf"/, 'имя файла уходит в multipart')
    assert.match(form, /PDF-DATA/, 'содержимое файла уходит в multipart')
    assert.equal(upload.query.access_token, undefined, 'адрес загрузки не требует токена')

    const save = stub.state.saves[0]
    assert.equal(save.query.file, 'uploaded|file|token')
    assert.equal(save.query.title, 'report.pdf', 'имя документа сохраняется в docs.save')

    const send = stub.state.sends[0]
    assert.equal(send.query.attachment, 'doc-123_777')
    assert.equal(send.query.peer_id, '42')
    assert.equal(send.query.message, 'Готовый отчёт', 'подпись доходит без markdown')
    assert.equal(send.query.reply_to, '321')
    assert.match(String(send.query.random_id), /^\d+$/, 'random_id как у остальных сообщений')

    assert.equal(platform.isOwnMessage(6001), true, 'отправленный файл запоминается как свой')
    assert.equal(platform.lastMessageByPeer.get('42'), 6001)
  } finally {
    await stub.close()
  }
})

test('sendDocument в беседу: peer_id 2000000000 + chat_id и пустая подпись', async () => {
  const stub = await createDocumentStub()
  try {
    const platform = makePlatform(stub)
    const result = await platform.sendDocument({
      chatId: 2000000001,
      bytes: Buffer.from('XLSX'),
      fileName: 'table.xlsx',
      caption: '',
    })

    assert.deepEqual(result, { messageId: 6001 })
    assert.equal(stub.state.uploadServers[0].query.peer_id, '2000000001')
    assert.equal(stub.state.uploads[0].body.toString('utf8').includes('filename="table.xlsx"'), true)
    assert.equal(stub.state.saves[0].query.title, 'table.xlsx')
    const send = stub.state.sends[0]
    assert.equal(send.query.peer_id, '2000000001')
    assert.equal(send.query.attachment, 'doc-123_777')
    assert.equal(send.query.message, undefined, 'без подписи сообщение остаётся вложением')
  } finally {
    await stub.close()
  }
})

test('sendDocument принимает старый ответ docs.save массивом', async () => {
  const stub = await createDocumentStub({
    script: (call) => (call.api === 'docs.save'
      ? { body: { response: [{ id: 888, owner_id: -123, title: 'old.pdf' }] } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await platform.sendDocument({ chatId: 42, bytes: Buffer.from('old'), fileName: 'old.pdf' })
    assert.equal(stub.state.sends[0].query.attachment, 'doc-123_888')
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// Ошибки шагов
// ---------------------------------------------------------------------------

test('ошибка загрузки файла объясняется по-русски и не доходит до docs.save', async () => {
  const stub = await createDocumentStub({
    script: (call) => (call.path === '/upload' ? { status: 500, body: { error: 'upload failed' } } : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(
      platform.sendDocument({ chatId: 42, bytes: Buffer.from('PDF'), fileName: 'report.pdf' }),
      (error) => assertStepError(error, { method: 'upload', pattern: /Не удалось загрузить файл «report.pdf»: HTTP 500/ }),
    )
    assert.equal(stub.state.saves.length, 0, 'после сбоя загрузки файл не сохраняется')
    assert.equal(stub.state.sends.length, 0)
  } finally {
    await stub.close()
  }
})

test('ошибка docs.save объясняется по-русски и не отправляет сообщение', async () => {
  const stub = await createDocumentStub({
    script: (call) => (call.api === 'docs.save'
      ? { body: { error: { error_code: 105, error_msg: "Couldn't save file" } } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(
      platform.sendDocument({ chatId: 42, bytes: Buffer.from('PDF'), fileName: 'report.pdf' }),
      (error) => {
        assertStepError(error, {
          method: 'docs.save',
          pattern: /Не удалось сохранить файл «report.pdf»: Couldn't save file/,
        })
        assert.equal(error.code, 105)
        return true
      },
    )
    assert.equal(stub.state.sends.length, 0)
  } finally {
    await stub.close()
  }
})

test('ошибка docs.getMessagesUploadServer объясняется по-русски', async () => {
  const stub = await createDocumentStub({
    script: (call) => (call.api === 'docs.getMessagesUploadServer'
      ? { body: { error: { error_code: 15, error_msg: 'Access denied' } } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(
      platform.sendDocument({ chatId: 42, bytes: Buffer.from('PDF'), fileName: 'report.pdf' }),
      (error) => {
        assertStepError(error, {
          method: 'docs.getMessagesUploadServer',
          pattern: /Не удалось получить адрес загрузки файла «report.pdf»: Access denied/,
        })
        assert.equal(error.code, 15)
        return true
      },
    )
    assert.equal(stub.state.uploads.length, 0, 'без адреса загрузки файл никуда не уходит')
  } finally {
    await stub.close()
  }
})

test('ошибка messages.send объясняется по-русски после успешной загрузки', async () => {
  const stub = await createDocumentStub({
    script: (call) => (call.api === 'messages.send'
      ? { body: { error: { error_code: 917, error_msg: "You don't have access to this chat" } } }
      : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(
      platform.sendDocument({ chatId: 2000000001, bytes: Buffer.from('PDF'), fileName: 'report.pdf' }),
      (error) => {
        assertStepError(error, {
          method: 'messages.send',
          pattern: /Не удалось отправить файл «report.pdf»: You don't have access to this chat/,
        })
        assert.equal(error.code, 917)
        return true
      },
    )
    assert.equal(stub.state.saves.length, 1, 'документ успел сохраниться')
  } finally {
    await stub.close()
  }
})

test('ответ upload-сервера без поля file — понятная ошибка', async () => {
  const stub = await createDocumentStub({
    script: (call) => (call.path === '/upload' ? { body: { ok: true } } : undefined),
  })
  try {
    const platform = makePlatform(stub)
    await assert.rejects(
      platform.sendDocument({ chatId: 42, bytes: Buffer.from('PDF'), fileName: 'report.pdf' }),
      (error) => assertStepError(error, { method: 'upload', pattern: /VK не вернул поле file/ }),
    )
    assert.equal(stub.state.saves.length, 0)
  } finally {
    await stub.close()
  }
})

test('пустой файл не отправляется и не ходит в сеть', async () => {
  const platform = makePlatform(undefined)
  await assert.rejects(
    platform.sendDocument({ chatId: 42, bytes: Buffer.alloc(0), fileName: 'empty.pdf' }),
    (error) => assertStepError(error, { method: 'sendDocument', pattern: /содержимое пустое/ }),
  )
})

// ---------------------------------------------------------------------------
// Контракт с ядром и возможности
// ---------------------------------------------------------------------------

test('ядро видит sendDocument у VK, а sendVoice по-прежнему отсутствует', () => {
  const platform = makePlatform(undefined)
  assert.equal(typeof platform.sendDocument, 'function')
  assert.equal(typeof platform.sendVoice, 'undefined')
})

test('возможности VK: файлы на выход есть, голосовых ответов нет', () => {
  const lines = capabilityLines({
    config: {},
    media: { transcribe: async () => '', extractText: async () => ({ text: '' }) },
    platformName: 'vk',
  })
  assert.equal(lines.some((line) => line.includes('файлы на выход')), true)
  assert.equal(lines.some((line) => line.includes('PDF, Excel, Word, CSV')), true)
  assert.equal(lines.some((line) => line.includes('голосовые')), true, 'входящие голосовые распознаются')
  assert.equal(lines.some((line) => line.includes('отвечать голосом')), false, 'озвучки ответов в VK нет')

  // Остальные платформы список не меняют: Telegram по-прежнему обещает озвучку.
  const telegram = capabilityLines({
    config: {},
    media: { transcribe: async () => '' },
    platformName: 'telegram',
  })
  assert.equal(telegram.some((line) => line.includes('отвечать голосом')), true)
})
