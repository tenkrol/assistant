/**
 * Telegram platform adapter for the task agent.
 *
 * Derived from `tg-agent/src/platforms/telegram.mjs` (same author, same
 * conventions), trimmed to what an executor needs and extended with two things
 * the chat bot had but the agent initially went without:
 *
 *   - file delivery: `sendDocument` and `sendPhoto`;
 *   - inline keyboards and `callback_query`, which carry the dialogue with a
 *     task (picking a variant, or cancelling a task that waits for an answer).
 *
 * The core (`bot.mjs`) sees only normalised updates, so the transport details —
 * HTML conversion, message splitting, multipart uploads — stay here.
 */
import { markdownToTelegramHtml, splitForTelegram } from './format.mjs'
import { TelegramClient, TelegramError } from './telegram.mjs'

/** Convert a platform id into a stable numeric value where possible. */
export function numericId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : String(value)
}

/** Turn our own HTML entities back into characters for a plain-text resend. */
const unescapeHtml = (text) => text
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')

const stripTags = (html) => html.replace(/<[^>]+>/g, '')

/** Telegram inline keyboard from the neutral shape. */
function toReplyMarkup(keyboard) {
  if (!keyboard?.rows?.length) return undefined
  const inline_keyboard = keyboard.rows
    .map((row) => row.map((button) => (button.url
      ? { text: button.text, url: button.url }
      : { text: button.text, callback_data: String(button.data ?? '') })))
    .filter((row) => row.length > 0)
  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined
}

export class TelegramPlatform {
  /**
   * @param {object} options - adapter options.
   * @param {string} options.token - BotFather token.
   * @param {string} [options.apiBase] - Bot API root, overridable for tests.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   */
  constructor({ token, apiBase, timeoutMs, logger, fetchImpl }) {
    this.name = 'telegram'
    this.logger = logger
    this.client = new TelegramClient({ token, apiBase, timeoutMs, logger, fetchImpl })
    this.identity = undefined
  }

  /**
   * Resolve the bot identity and drop any webhook (polling wins).
   *
   * @param {object} [request] - `dropPendingUpdates` discards the update backlog.
   */
  async start({ dropPendingUpdates = false } = {}) {
    const me = await this.client.getMe()
    this.identity = { id: me.id, username: me.username, title: me.first_name ?? me.username }
    await this.client.deleteWebhook({ dropPendingUpdates })
    return this
  }

  async stop() {}

  /**
   * Long-poll and normalise.
   *
   * @param {object} request - `cursor` is the last seen update id, `timeoutSec` the hold time.
   * @returns {Promise<{updates: object[], cursor: number|undefined}>} normalised updates.
   */
  async getUpdates({ cursor, timeoutSec = 30, signal } = {}) {
    const raw = await this.client.getUpdates({ offset: cursor, timeoutSec }, { signal })
    const updates = []
    for (const update of raw ?? []) {
      const normalised = this.normalize(update)
      if (normalised) updates.push(normalised)
    }
    return { updates, cursor: this.nextCursor(raw, cursor) }
  }

  /** Telegram expects `offset = last update id + 1`. */
  nextCursor(raw, cursor) {
    const highest = (raw ?? []).reduce((max, update) => Math.max(max, Number(update.update_id) || 0), 0)
    return highest > 0 ? highest + 1 : cursor
  }

  /**
   * Turn one Telegram update into the neutral shape.
   *
   * @param {object} update - raw update.
   * @returns {object|undefined} the normalised update, or `undefined` for kinds this bot ignores.
   */
  normalize(update) {
    const query = update.callback_query
    if (query?.message) {
      return {
        kind: 'callback',
        id: update.update_id,
        chat: { id: numericId(query.message.chat?.id), type: query.message.chat?.type ?? 'private' },
        from: {
          id: numericId(query.from?.id),
          name: query.from?.first_name,
          username: query.from?.username,
          isBot: Boolean(query.from?.is_bot),
        },
        text: '',
        attachments: [],
        // A tap is always meant for this bot: nobody else has its buttons.
        addressed: true,
        messageId: numericId(query.message.message_id),
        callback: {
          id: query.id,
          data: String(query.data ?? ''),
          messageId: numericId(query.message.message_id),
          text: query.message.text ?? query.message.caption ?? '',
        },
      }
    }

    const message = update.message ?? update.edited_message
    if (!message?.from) return undefined
    const chatType = message.chat?.type ?? 'private'
    return {
      kind: 'message',
      id: update.update_id,
      chat: { id: numericId(message.chat?.id), type: chatType },
      from: {
        id: numericId(message.from.id),
        name: message.from.first_name,
        username: message.from.username,
        isBot: Boolean(message.from.is_bot),
      },
      text: (message.text ?? message.caption ?? '').trim(),
      attachments: this.attachmentsOf(message),
      // A private chat always addresses the bot; in a group it has to be named
      // or answered. The core gets this as a plain boolean.
      addressed: chatType === 'private' || this.isAddressed(message),
      messageId: numericId(message.message_id),
      replyToMessageId: message.message_id,
    }
  }

  /**
   * Media attached to one message, in a platform-neutral shape.
   *
   * @param {object} message - raw Telegram message.
   * @returns {Array<object>} zero or more attachments.
   */
  attachmentsOf(message) {
    const list = []
    // Telegram sends several sizes; the last one is the largest.
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]
      list.push({ kind: 'photo', fileId: largest.file_id, size: largest.file_size, width: largest.width, height: largest.height })
    }
    if (message.voice) {
      list.push({ kind: 'voice', fileId: message.voice.file_id, mime: message.voice.mime_type, duration: message.voice.duration, size: message.voice.file_size })
    }
    if (message.audio) {
      list.push({ kind: 'audio', fileId: message.audio.file_id, name: message.audio.file_name, mime: message.audio.mime_type, duration: message.audio.duration, size: message.audio.file_size })
    }
    if (message.document) {
      list.push({ kind: 'document', fileId: message.document.file_id, name: message.document.file_name, mime: message.document.mime_type, size: message.document.file_size })
    }
    if (message.video) {
      list.push({ kind: 'video', fileId: message.video.file_id, name: message.video.file_name, mime: message.video.mime_type, duration: message.video.duration, size: message.video.file_size })
    }
    return list
  }

  /** True when the bot is mentioned, or the user replies to one of its messages. */
  isAddressed(message) {
    const botId = this.identity?.id
    const username = this.identity?.username
    if (message.reply_to_message?.from?.id === botId) return true
    const entities = message.entities ?? message.caption_entities ?? []
    const text = message.text ?? message.caption ?? ''
    for (const entity of entities) {
      if (entity.type === 'mention') {
        const value = text.slice(entity.offset, entity.offset + entity.length)
        if (username && value.toLowerCase() === `@${username.toLowerCase()}`) return true
      }
      if (entity.type === 'text_mention' && entity.user?.id === botId) return true
      if (entity.type === 'bot_command' && username) {
        const value = text.slice(entity.offset, entity.offset + entity.length)
        if (value.toLowerCase().endsWith(`@${username.toLowerCase()}`)) return true
      }
    }
    return false
  }

  /** Download one attachment; the platform caps the size. */
  downloadFile({ fileId, maxBytes }) {
    return this.client.downloadFile({ fileId, maxBytes })
  }

  /**
   * Send markdown, split to Telegram's limit, falling back to plain text when
   * Telegram rejects the entities.
   *
   * Buttons belong to the last chunk: on the first they would appear above the
   * rest of a long answer.
   *
   * @param {object} request - `chatId`, `markdown`, optional `replyToMessageId`, `keyboard`.
   * @returns {Promise<{messageId?: number}>} the last message id.
   */
  async sendText({ chatId, markdown, replyToMessageId, keyboard } = {}) {
    const rows = toReplyMarkup(keyboard)
    const chunks = splitForTelegram(markdownToTelegramHtml(markdown ?? ''))
    let last
    for (const [index, chunk] of chunks.entries()) {
      const replyMarkup = index === chunks.length - 1 ? rows : undefined
      try {
        last = await this.client.sendMessage({ chatId, text: chunk, parseMode: 'HTML', replyToMessageId, replyMarkup })
      } catch (error) {
        if (error instanceof TelegramError && error.status === 400) {
          this.logger?.warn('html rejected, sending plain text', { chatId, description: error.description })
          last = await this.client.sendMessage({ chatId, text: unescapeHtml(stripTags(chunk)), parseMode: null, replyToMessageId, replyMarkup })
        } else {
          throw error
        }
      }
    }
    return { messageId: last?.message_id }
  }

  /** Replace the text of one message; plain text, so any content is safe. */
  editText({ chatId, messageId, markdown, keyboard }) {
    return this.client.editMessageText({
      chatId,
      messageId,
      text: stripTags(markdownToTelegramHtml(markdown ?? '')),
      parseMode: undefined,
      replyMarkup: toReplyMarkup(keyboard),
    })
  }

  /** Acknowledge a button tap; Telegram shows `text` as a toast. */
  answerCallback({ callbackId, text, alert = false }) {
    return this.client.answerCallbackQuery({ callbackQueryId: callbackId, text, showAlert: alert })
  }

  /** "typing…" hint while the task runs. */
  sendTyping({ chatId }) {
    return this.client.sendChatAction({ chatId, action: 'typing' })
  }

  /** Send a voice note (already OGG/Opus, as SpeechKit returns it). */
  sendVoice({ chatId, bytes, durationSec, caption, replyToMessageId }) {
    return this.client.sendVoice({ chatId, bytes, durationSec, caption, replyToMessageId })
  }

  /** Send a file as a document with an optional caption. */
  sendDocument({ chatId, bytes, fileName, caption, mime, replyToMessageId }) {
    return this.client.sendDocument({ chatId, bytes, fileName, caption, mime, replyToMessageId })
  }

  /** Send an image as a photo with an optional caption. */
  sendPhoto({ chatId, bytes, fileName, caption, replyToMessageId }) {
    return this.client.sendPhoto({ chatId, bytes, fileName, caption, replyToMessageId })
  }
}

/** Build the Telegram adapter. */
export const createTelegramPlatform = (options) => new TelegramPlatform(options)
