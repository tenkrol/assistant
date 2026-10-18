/**
 * Test doubles: a Bot API stub, a chat-completions stub, and small helpers.
 *
 * Both stubs are real HTTP servers on 127.0.0.1, so the clients under test use
 * the same fetch path they will use in production.
 */
import http from 'node:http'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sleep without holding the event loop open, for delays a test aborts before
 * they elapse (a 30-second stub delay would otherwise delay process exit).
 */
export const sleepUnref = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

const readBody = (request) =>
  new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
  })

const reply = (response, status, payload) => {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/** Stub Bot API. `script` may return a raw response for a method to test failures. */
export async function createTelegramStub({ updates = [], script } = {}) {
  const state = {
    updates: [...updates],
    calls: [],
    sends: [],
    actions: [],
    answers: [],
    edits: [],
    handledUpdates: 0,
    /** What a `/file/…` download returns; tests may set their own bytes. */
    fileBytes: undefined,
  }
  const server = http.createServer(async (request, response) => {
    // Files are served from a second host: `/file/bot<token>/<path>`.
    if (request.url.includes('/file/bot')) {
      const bytes = Buffer.from(state.fileBytes ?? 'test-file-bytes')
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      response.end(bytes)
      return
    }
    const method = request.url.split('/').pop()
    const raw = await readBody(request)
    const payload = raw === '' ? {} : JSON.parse(raw)
    state.calls.push({ method, payload })
    const override = script?.(method, payload, state)
    if (override) return reply(response, override.status ?? 200, override.body)

    switch (method) {
      case 'getMe':
        return reply(response, 200, { ok: true, result: { id: 42, is_bot: true, username: 'test_bot', first_name: 'Test' } })
      case 'deleteWebhook':
        return reply(response, 200, { ok: true, result: true })
      case 'getUpdates': {
        await sleep(10)
        if (state.updates.length === 0) return reply(response, 200, { ok: true, result: [] })
        const batch = state.updates.splice(0, state.updates.length)
        state.handledUpdates += batch.length
        return reply(response, 200, { ok: true, result: batch })
      }
      case 'sendMessage': {
        state.sends.push(payload)
        return reply(response, 200, { ok: true, result: { message_id: state.sends.length, chat: { id: payload.chat_id }, text: payload.text } })
      }
      case 'getFile':
        return reply(response, 200, { ok: true, result: { file_id: payload.file_id, file_path: 'documents/file_1.bin', file_size: 15 } })
      case 'sendChatAction': {
        state.actions.push(payload)
        return reply(response, 200, { ok: true, result: true })
      }
      case 'answerCallbackQuery': {
        state.answers.push(payload)
        return reply(response, 200, { ok: true, result: true })
      }
      case 'editMessageText': {
        state.edits.push(payload)
        return reply(response, 200, { ok: true, result: { message_id: payload.message_id, chat: { id: payload.chat_id }, text: payload.text } })
      }
      case 'editMessageReplyMarkup': {
        state.edits.push(payload)
        return reply(response, 200, { ok: true, result: { message_id: payload.message_id, chat: { id: payload.chat_id } } })
      }
      default:
        return reply(response, 404, { ok: false, description: `unknown method ${method}` })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    state,
    apiBase: `http://127.0.0.1:${port}`,
    /** Queue one more update, as Telegram would deliver it. */
    push(update) { state.updates.push(update) },
    close: () => closeServer(server),
  }
}

/**
 * Stub chat-completions API; `responses` is a queue, the last entry repeats.
 * `delayMs` keeps the request open, which is how shutdown/abort behaviour is
 * tested.
 */
export async function createModelStub({ responses = [{ content: 'ответ модели' }], delayMs = 0 } = {}) {
  const state = { requests: [], responses: [...responses] }
  const server = http.createServer(async (request, response) => {
    const raw = await readBody(request)
    const payload = raw === '' ? {} : JSON.parse(raw)
    state.requests.push({ url: request.url, headers: request.headers, payload })
    // Record the request first: a test that waits for it must not stall until
    // the artificial delay elapses. The timer is unref'd so a request that is
    // aborted before it fires cannot keep the test process alive.
    if (delayMs > 0) await sleepUnref(delayMs)
    // Streaming: the client asks for SSE with `stream: true`; answer with real
    // event-stream chunks so the streaming path is exercised for real.
    if (payload.stream === true) {
      const next = state.responses.length > 1 ? state.responses.shift() : state.responses[0]
      const text = next.content ?? ''
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const pieces = String(text).match(/[\s\S]{1,8}/g) ?? []
      for (const piece of pieces) {
        response.write(`data: ${JSON.stringify({ model: payload.model, choices: [{ index: 0, delta: { content: piece } }] })}\n\n`)
      }
      response.write(`data: ${JSON.stringify({ model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    const next = state.responses.length > 1 ? state.responses.shift() : state.responses[0]
    if (next.status && next.status !== 200) {
      return reply(response, next.status, next.body ?? { error: { message: next.message ?? 'stub failure' } })
    }
    const body = JSON.stringify({
      model: payload.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: next.content ?? (next.toolCalls ? '' : undefined),
          // A response entry with `toolCalls` asks the client to run tools:
          // `[{ id, name, arguments }]` is expanded to the OpenAI wire shape.
          ...(next.toolCalls
            ? {
              tool_calls: next.toolCalls.map((call, index) => ({
                id: call.id ?? `call_${index}`,
                type: 'function',
                function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
              })),
            }
            : {}),
        },
        finish_reason: next.toolCalls ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  }
}

/**
 * Close a stub server without waiting for the fetch connection pool: undici
 * keeps sockets alive, and `server.close()` alone would block for seconds.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  })
}

/** Poll a condition until it is truthy or the timeout elapses. */
export async function waitFor(condition, { timeout = 3000, interval = 10, what = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await condition()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`)
    await sleep(interval)
  }
}

/** Build one Telegram update carrying a private or group text message. */
export function textUpdate({ updateId = 1, chatId = 555, chatType = 'private', userId = 777, firstName = 'User', text = 'привет', entities, replyToMessageId, replyFromId, document, photo, voice } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: firstName },
      chat: { id: chatId, type: chatType },
      date: Math.floor(Date.now() / 1000),
      text,
      entities,
      // Attachments as Telegram sends them: the adapter turns these into the
      // neutral `attachments` list the core works with.
      document: document ? { file_id: document.file_id, file_name: document.file_name, mime_type: document.mime_type, file_size: document.file_size } : undefined,
      photo: photo ? [{ file_id: photo.file_id, file_size: photo.file_size, width: 90, height: 90 }] : undefined,
      voice: voice ? { file_id: voice.file_id, mime_type: voice.mime_type ?? 'audio/ogg', duration: voice.duration ?? 3, file_size: voice.file_size } : undefined,
      reply_to_message: replyFromId ? { message_id: replyToMessageId ?? 1, from: { id: replyFromId, is_bot: replyFromId === 42 } } : undefined,
    },
  }
}

/** An inline-button tap, as Telegram delivers it. */
export function callbackUpdate({ updateId = 1, chatId = 555, userId = 777, data = 'cancel:1', messageId = 1, text = 'напоминание' } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat_instance: 'test',
      data,
      message: {
        message_id: messageId,
        from: { id: 42, is_bot: true, username: 'test_bot' },
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    },
  }
}

/** Environment for `loadConfig` pointing at the stubs. */
export function testEnv({ telegramApiBase, modelBaseUrl, dataDir, overrides = {} }) {
  return {
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
    MODEL_API_KEY: 'sk-test',
    MODEL_NAME: 'deepseek-chat',
    MODEL_BASE_URL: modelBaseUrl,
    TELEGRAM_API_BASE: telegramApiBase,
    ALLOWED_USER_IDS: '777',
    ALLOW_ALL_USERS: 'false',
    DATA_DIR: dataDir,
    LOG_LEVEL: 'error',
    POLL_TIMEOUT_SEC: '1',
    TELEGRAM_TIMEOUT_MS: '5000',
    MODEL_TIMEOUT_MS: '5000',
    HISTORY_LIMIT: '6',
    // Тесты старого поведения извлечения фактов явно включают настройку:
    // в production она по умолчанию выключена (PLB-019).
    MEMORY_AUTO_EXTRACT: 'true',
    ...overrides,
  }
}
