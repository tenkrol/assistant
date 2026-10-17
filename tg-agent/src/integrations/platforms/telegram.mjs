/**
 * Telegram adapter: the Bot API behind the platform port.
 *
 * Everything Telegram-specific lives here — HTML conversion and message
 * splitting, the plain-text retry when Telegram rejects entities, inline
 * keyboards, callback queries and typing hints. The core only sees normalised
 * updates and neutral keyboards.
 */
import { markdownToTelegramHtml } from '../../delivery/format.mjs'
import { splitForTelegram } from '../../delivery/stream.mjs'
import { TelegramClient, TelegramError } from '../telegram/index.mjs'
import { numericId } from './port.mjs'

/** @param {string} html - our HTML chunk. */
const stripTags = (html) => html.replace(/<[^>]+>/g, '')
/** Turn our own HTML entities back into characters for a plain-text resend. */
const unescapeHtml = (text) => text
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')

/** Telegram inline keyboard from the neutral shape. */
function toReplyMarkup(keyboard) {
  if (!keyboard?.rows?.length) return undefined
  const inline_keyboard = keyboard.rows
    .map((row) => row.map((button) => {
      // A web app button opens the Mini App inside Telegram; a plain url button would
      // push the user into a browser instead.
      if (button.webApp) return { text: button.text, web_app: { url: button.webApp } }
      if (button.url) return { text: button.text, url: button.url }
      return { text: button.text, callback_data: String(button.data ?? '') }
    }))
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
    // Short platform marker: it names the adapter and can prefix shared keys.
    this.namespace = 'tg'
    this.logger = logger
    this.client = new TelegramClient({ token, apiBase, timeoutMs, logger, fetchImpl })
    this.identity = undefined
  }

  /** Resolve the bot identity and drop any webhook (polling wins). */
  async start() {
    const me = await this.client.getMe()
    this.identity = { id: me.id, username: me.username, title: me.first_name ?? me.username }
    await this.client.deleteWebhook()
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
   * @returns {object|undefined} the normalised update, or `undefined` when the kind is not handled.
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
        addressed: true,
        callback: {
          id: query.id,
          data: String(query.data ?? ''),
          messageId: numericId(query.message.message_id),
          text: query.message.text ?? '',
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
      // Photos, voice notes and documents are described here; the core decides
      // what to do with them (download, transcribe, extract text).
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
    // Переданный контакт: Telegram отдаёт имя, @ник, телефон и user_id.
    // Это единственный способ узнать телефон — по номеру искать нельзя.
    if (message.contact) {
      list.push({
        kind: 'contact',
        userId: message.contact.user_id,
        name: [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' '),
        username: message.contact.username,
        phone: message.contact.phone_number,
      })
    }
    if (message.document) {
      list.push({ kind: 'document', fileId: message.document.file_id, name: message.document.file_name, mime: message.document.mime_type, size: message.document.file_size })
    }
    if (message.video) {
      list.push({ kind: 'video', fileId: message.video.file_id, name: message.video.file_name, mime: message.video.mime_type, duration: message.video.duration, size: message.video.file_size })
    }
    return list
  }

  /**
   * Send a voice message the user can play in the chat.
   *
   * @param {object} request - `chatId`, `bytes` (OGG/Opus), optional `replyToMessageId`, `durationSec`.
   * @returns {Promise<{messageId: number|string}>} the sent message.
   */
  async sendVoice({ chatId, bytes, replyToMessageId, durationSec }) {
    const message = await this.client.sendVoice({ chatId, bytes, replyToMessageId, durationSec })
    return { messageId: message?.message_id }
  }

  /**
   * Send a generated file (report, table, document) to the chat.
   *
   * @param {object} request - `chatId`, `bytes`, `fileName`, optional `caption`, `replyToMessageId`.
   * @returns {Promise<{messageId: number|string}>} the sent message.
   */
  async sendDocument({ chatId, bytes, fileName, caption, replyToMessageId }) {
    const message = await this.client.sendDocument({ chatId, bytes, fileName, caption, replyToMessageId })
    return { messageId: message?.message_id }
  }

  /** Download one attachment; the platform caps the size. */
  async downloadFile({ fileId, maxBytes }) {
    return this.client.downloadFile({ fileId, maxBytes })
  }

  /** Put an emoji reaction on a message; a no-op when Telegram refuses. */
  async setReaction({ chatId, messageId, emoji }) {
    try {
      return await this.client.setMessageReaction({ chatId, messageId, emoji })
    } catch (error) {
      this.logger?.debug('reaction rejected', { error: error?.description ?? error?.message })
      return undefined
    }
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

  /**
   * Send markdown, split to Telegram's limit, falling back to plain text when
   * Telegram rejects the entities.
   *
   * @param {object} request - `chatId`, `markdown`, optional `replyToMessageId`, `keyboard`.
   * @returns {Promise<{messageId?: number}>} the last message id.
   */
  async sendText({ chatId, markdown, replyToMessageId, keyboard }) {
    const rows = toReplyMarkup(keyboard)
    const chunks = splitForTelegram(markdownToTelegramHtml(markdown))
    let last
    for (const [index, chunk] of chunks.entries()) {
      // Buttons belong to the last chunk: on the first they would appear above
      // the rest of a long answer.
      const replyMarkup = index === chunks.length - 1 ? rows : undefined
      try {
        last = await this.client.sendMessage({ chatId, text: chunk, parseMode: 'HTML', replyToMessageId, replyMarkup })
      } catch (error) {
        if (error instanceof TelegramError && error.status === 400) {
          this.logger?.warn('html rejected, sending plain text', { chatId, description: error.description })
          // The chunk is HTML, so entities must be turned back into characters:
          // sending `&lt;` with no parse mode would show the entity itself.
          last = await this.client.sendMessage({ chatId, text: unescapeHtml(stripTags(chunk)), parseMode: null, replyToMessageId, replyMarkup })
        } else {
          throw error
        }
      }
    }
    return { messageId: last?.message_id }
  }

  /** Replace the text of one message; plain text, so any content is safe. */
  async editText({ chatId, messageId, markdown, keyboard }) {
    return this.client.editMessageText({
      chatId,
      messageId,
      text: stripTags(markdownToTelegramHtml(markdown)),
      parseMode: undefined,
      replyMarkup: toReplyMarkup(keyboard),
    })
  }

  /** Acknowledge a button tap; Telegram shows `text` as a toast. */
  async answerCallback({ callbackId, text, alert = false }) {
    return this.client.answerCallbackQuery({ callbackQueryId: callbackId, text, showAlert: alert })
  }

  /**
   * Send ready-made HTML, without markdown conversion.
   *
   * Used by the agent bridge: a mention of another bot has to go out as an
   * explicit `tg://user` link, and the markdown converter would escape it.
   *
   * @param {object} request - `chatId`, `html`.
   * @returns {Promise<{messageId?: number}>} the sent message.
   */
  async sendHtml({ chatId, html }) {
    const message = await this.client.sendMessage({ chatId, text: html, parseMode: 'HTML' })
    return { messageId: message?.message_id }
  }

  /** "typing…" hint while the model works. */
  async sendTyping({ chatId }) {
    return this.client.sendChatAction({ chatId, action: 'typing' })
  }
}

/**
 * Build the Telegram adapter.
 *
 * @param {object} options - see `TelegramPlatform`.
 * @returns {TelegramPlatform} the adapter.
 */
export const createTelegramPlatform = (options) => new TelegramPlatform(options)
