/**
 * Telegram Bot API client: long polling with the retry policy Telegram expects.
 *
 * Only the handful of methods the bot needs are wrapped. Every call is a plain
 * JSON POST, so the client works against any Bot API base URL — including a
 * local stub, which is how the tests run without network access.
 */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Error carrying the Telegram method, HTTP status and description. */
export class TelegramError extends Error {
  constructor(message, { method, status, description, retryAfter, cause } = {}) {
    super(message, { cause })
    this.name = 'TelegramError'
    this.method = method
    this.status = status
    this.description = description
    this.retryAfter = retryAfter
  }
}

export class TelegramClient {
  /**
   * @param {object} options - client options.
   * @param {string} options.token - BotFather token.
   * @param {string} [options.apiBase] - Bot API root, overridable for tests and mirrors.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   */
  constructor({ token, apiBase = 'https://api.telegram.org', fetchImpl = globalThis.fetch, timeoutMs = 60000, logger, maxAttempts = 4, sleep = defaultSleep }) {
    this.token = token
    this.apiBase = apiBase.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.maxAttempts = maxAttempts
    this.sleep = sleep
  }

  /**
   * Call one Bot API method.
   *
   * @param {string} method - for example `sendMessage`.
   * @param {object} [payload] - JSON body.
   * @param {object} [options] - `signal` cancels the call; `timeoutMs` overrides the default.
   * @returns {Promise<any>} the `result` field of the response.
   */
  async call(method, payload = {}, { signal, timeoutMs } = {}) {
    const url = `${this.apiBase}/bot${this.token}/${method}`
    const deadline = timeoutMs ?? this.timeoutMs
    let lastError
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const timeoutSignal = AbortSignal.timeout(deadline)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: requestSignal,
        })
        const body = await parseJson(response)
        if (response.ok && body?.ok === true) return body.result

        const description = body?.description ?? response.statusText
        const retryAfter = body?.parameters?.retry_after
        const error = new TelegramError(`Telegram ${method} failed: ${description}`, {
          method,
          status: response.status,
          description,
          retryAfter,
        })
        if (response.status === 429 && attempt < this.maxAttempts) {
          const waitMs = Math.min(Math.max(Number(retryAfter) || 1, 1), 60) * 1000
          this.logger?.warn('telegram rate limited', { method, waitMs, attempt })
          await this.sleep(waitMs)
          continue
        }
        if (response.status >= 500 && attempt < this.maxAttempts) {
          lastError = error
          await this.sleep(backoff(attempt))
          continue
        }
        throw error
      } catch (error) {
        if (error instanceof TelegramError) throw error
        if (signal?.aborted) throw error
        lastError = error
        if (attempt >= this.maxAttempts) break
        this.logger?.warn('telegram request failed, retrying', { method, attempt, error })
        await this.sleep(backoff(attempt))
      }
    }
    throw new TelegramError(`Telegram ${method} failed after ${this.maxAttempts} attempts: ${lastError?.message}`, {
      method,
      cause: lastError,
    })
  }

  /** Identity of the bot; also validates the token at startup. */
  getMe(options) {
    return this.call('getMe', {}, options)
  }

  /** Long polling. `timeout` is the server-side hold time in seconds. */
  getUpdates({ offset, timeoutSec = 30, limit = 100 }, options = {}) {
    return this.call('getUpdates', {
      offset,
      timeout: timeoutSec,
      limit,
      // `callback_query` carries the inline-button taps.
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    }, {
      timeoutMs: (timeoutSec + 20) * 1000,
      ...options,
    })
  }

  /**
   * Stop webhooks so long polling can start.
   *
   * @param {object} [request] - `dropPendingUpdates` discards the backlog, which
   *   the agent does once on a first-ever start so stale tasks are not executed.
   */
  deleteWebhook({ dropPendingUpdates = false } = {}, options) {
    return this.call('deleteWebhook', { drop_pending_updates: dropPendingUpdates }, options)
  }

  sendMessage({ chatId, text, parseMode = 'HTML', disablePreview = true, replyToMessageId, replyMarkup }, options) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: parseMode ?? undefined,
      link_preview_options: disablePreview ? { is_disabled: true } : undefined,
      reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
      reply_markup: replyMarkup ?? undefined,
    }, options)
  }

  /** Acknowledge a button tap; Telegram shows `text` as a toast. */
  answerCallbackQuery({ callbackQueryId, text, showAlert = false }, options) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text ? String(text).slice(0, 190) : undefined,
      show_alert: showAlert || undefined,
    }, options)
  }

  /** Replace or remove the inline keyboard of a message. */
  editMessageReplyMarkup({ chatId, messageId, replyMarkup }, options) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? undefined,
    }, options)
  }

  /** Rewrite the text of one message (used to report the outcome of a tap). */
  editMessageText({ chatId, messageId, text, parseMode = 'HTML', replyMarkup }, options) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode ?? undefined,
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup ?? undefined,
    }, options)
  }

  sendChatAction({ chatId, action = 'typing' }, options) {
    return this.call('sendChatAction', { chat_id: chatId, action }, options)
  }

  /**
   * Send a voice message.
   *
   * Telegram wants multipart for files, so this bypasses `call()` and posts a
   * form directly. The bytes must already be OGG/Opus, which is what SpeechKit
   * and Telegram voice notes use.
   *
   * @param {object} request - `chatId`, `bytes`, optional `replyToMessageId`, `durationSec`, `title`.
   * @returns {Promise<object>} the sent message.
   */
  async sendVoice({ chatId, bytes, replyToMessageId, durationSec, caption }, options = {}) {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('voice', new Blob([bytes], { type: 'audio/ogg' }), 'answer.ogg')
    if (durationSec !== undefined) form.append('duration', String(Math.round(durationSec)))
    if (caption) form.append('caption', caption)
    if (replyToMessageId !== undefined) form.append('reply_to_message_id', String(replyToMessageId))
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    const response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/sendVoice`, { method: 'POST', body: form, signal })
    const payload = await parseJson(response)
    if (!payload?.ok) {
      throw new TelegramError(`Telegram sendVoice failed: ${payload?.description ?? response.status}`, { method: 'sendVoice', status: response.status })
    }
    return payload.result
  }

  /**
   * Send a file as a Telegram document (any type, keeps the file name).
   *
   * @param {object} request - `chatId`, `bytes`, `fileName`, optional `caption`, `mime`, `replyToMessageId`.
   * @param {object} [options] - `signal`.
   * @returns {Promise<object>} the sent message.
   */
  sendDocument(request, options = {}) {
    return this.sendUpload('sendDocument', 'document', request, options)
  }

  /**
   * Send an image as a Telegram photo (inline preview, still keeps the name).
   *
   * @param {object} request - `chatId`, `bytes`, `fileName`, optional `caption`, `replyToMessageId`.
   * @param {object} [options] - `signal`.
   * @returns {Promise<object>} the sent message.
   */
  sendPhoto(request, options = {}) {
    return this.sendUpload('sendPhoto', 'photo', request, options)
  }

  /**
   * Shared multipart upload for the two file-sending methods.
   *
   * Telegram caps captions at 1024 characters and rejects control characters in
   * file names, so both are normalised here rather than at every call site.
   *
   * @param {string} method - `sendDocument` or `sendPhoto`.
   * @param {string} field - the multipart field name (`document` or `photo`).
   * @param {object} request - see `sendDocument`.
   * @param {object} [options] - `signal`.
   * @returns {Promise<object>} the sent message.
   */
  async sendUpload(method, field, { chatId, bytes, fileName, caption, mime = 'application/octet-stream', replyToMessageId } = {}, options = {}) {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    const safeName = String(fileName ?? 'file').replace(/[\r\n"]/g, '_').replace(/[/\\]/g, '_').slice(0, 200) || 'file'
    form.append(field, new Blob([bytes], { type: mime }), safeName)
    if (caption) form.append('caption', String(caption).slice(0, 1024))
    if (replyToMessageId !== undefined) form.append('reply_to_message_id', String(replyToMessageId))
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    const response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, { method: 'POST', body: form, signal })
    const payload = await parseJson(response)
    if (!payload?.ok) {
      throw new TelegramError(`Telegram ${method} failed: ${payload?.description ?? response.status}`, {
        method,
        status: response.status,
        description: payload?.description,
      })
    }
    return payload.result
  }

  /** React to a message; an empty emoji removes the reaction. */
  setMessageReaction({ chatId, messageId, emoji }, options) {
    return this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }, options)
  }

  /** Where a file lives on Telegram's servers, plus its size. */
  getFile({ fileId }, options) {
    return this.call('getFile', { file_id: fileId }, options)
  }

  /**
   * Download a file by id.
   *
   * The Bot API serves files from a second host (`/file/bot<token>/<path>`), so
   * this bypasses `call()` and reads the body as bytes.
   *
   * @param {object} request - `fileId` and optional `maxBytes`.
   * @param {object} [options] - `signal`.
   * @returns {Promise<{bytes: Buffer, fileName?: string, size: number}>} the file.
   */
  async downloadFile({ fileId, maxBytes = 20_000_000 }, options = {}) {
    const file = await this.getFile({ fileId }, options)
    if (!file?.file_path) throw new TelegramError('Telegram getFile returned no file_path', { method: 'getFile' })
    if (Number(file.file_size) > maxBytes) {
      throw new TelegramError(`file is too large (${file.file_size} bytes, limit ${maxBytes})`, { method: 'getFile' })
    }
    const url = `${this.apiBase}/file/bot${this.token}/${file.file_path}`
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    const response = await this.fetchImpl(url, { signal })
    if (!response.ok) {
      throw new TelegramError(`Telegram file download failed: HTTP ${response.status}`, { method: 'downloadFile', status: response.status })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    return { bytes, fileName: file.file_path.split('/').pop(), size: bytes.length }
  }
}

async function parseJson(response) {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, description: text.slice(0, 200) }
  }
}

const backoff = (attempt) => Math.min(500 * 2 ** (attempt - 1), 10000)
