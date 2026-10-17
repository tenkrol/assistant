/**
 * The platform port: the single interface the core talks to.
 *
 * Everything platform-specific (polling, formatting, buttons, callbacks) lives in
 * an adapter behind this contract, so `bot.mjs` — the core — never mentions
 * Telegram or MAX. Two adapters exist today: `telegram.mjs` and `max.mjs`.
 *
 * ## Contract
 *
 * ```
 * {
 *   name: 'telegram' | 'max',        // human name, used in logs
 *   namespace: string,               // key prefix for shared stores ('tg' | 'max')
 *   identity: { id, username, title } // filled by start()
 *
 *   async start(): Promise<void>                 // resolve identity, drop webhooks
 *   async stop(): Promise<void>
 *
 *   async getUpdates({ cursor, timeoutSec }): Promise<{ updates: Update[], cursor }>
 *   async sendText({ chatId, markdown, replyToMessageId, keyboard }): Promise<{ messageId }>
 *   async editText({ chatId, messageId, markdown, keyboard }): Promise<void>
 *   async answerCallback({ callbackId, text, alert }): Promise<void>
 *   async sendTyping({ chatId }): Promise<void>
 * }
 * ```
 *
 * ## Normalised update
 *
 * ```
 * {
 *   kind: 'message' | 'callback',
 *   id: string|number,               // update id, used for the polling cursor
 *   chat: { id: number|string, type: 'private' | 'group' | 'channel' },
 *   from: { id: number|string, name?: string, username?: string, isBot: boolean },
 *   text: string,                    // '' for callbacks
 *   addressed: boolean,              // private chat, mention, or reply to the bot
 *   messageId?: number|string,        // id of this message (reactions)
 *   replyToMessageId?: number|string,
 *   callback?: { id: string, data: string, messageId: number|string, text?: string }
 * }
 * ```
 *
 * ## Keyboard
 *
 * Platform-neutral shape produced by the core:
 *
 * ```
 * { rows: [[{ text: '✖️ Отменить', data: 'cancel:3' }, { text: 'Сайт', url: 'https://…' }]] }
 * ```
 *
 * The adapter maps it to its own wire format (Telegram `reply_markup`, MAX
 * `inline_keyboard` attachment) and drops buttons the platform cannot render.
 */

/** Convert a platform id into a stable numeric value where possible. */
export function numericId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : String(value)
}
