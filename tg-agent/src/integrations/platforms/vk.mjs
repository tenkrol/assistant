/**
 * VK (VKontakte, vk.com) community bot adapter.
 *
 * This is the adapter for a **community bot on vk.com** — a different platform
 * from VK Teams (`vk-teams.mjs`, the Myteam / VK WorkSpace messenger), which
 * only shares the company that owns both services.
 *
 * Everything VK-specific lives here: query-parameter auth (`access_token`,
 * `v`), Bots Long Poll with a `ts` cursor, the `{type, object}` event envelope
 * mapped onto neutral updates, `keyboard` JSON serialisation — VK has no
 * message formatting at all — and the `{response}` / `{error}` envelope.
 *
 * ## Field names used by this adapter
 *
 * Verified against the official documentation and the community-events schema
 * (fetched 2026-10-07):
 *
 * - API root and envelope: every method is
 *   `GET https://api.vk.com/method/<method>?…&access_token=<token>&v=<version>`
 *   and answers `{response: …}` or `{error: {error_code, error_msg, …}}`
 *   (https://dev.vk.com/ru/api/api-requests).
 * - `groups.getById` → an array of group objects
 *   (https://dev.vk.com/ru/method/groups.getById) with `id`, `name`,
 *   `screen_name`. Since API 5.139 the response is `{groups: […], profiles: […]}`
 *   (see the 5.139 note on that page), so both shapes are accepted.
 * - `groups.getLongPollServer?group_id=` → `{key, server, ts}`
 *   (https://dev.vk.com/ru/method/groups.getLongPollServer). The community
 *   token must carry the `manage` scope.
 * - Polling: `GET {server}?act=a_check&key={key}&ts={ts}&wait=25` →
 *   `{ts, updates: […]}`, or `{"failed": N}`
 *   (https://dev.vk.com/ru/api/bots-long-poll/getting-started). `wait` is
 *   capped at 90 seconds; 25 is the documented recommendation.
 * - Events (https://dev.vk.com/ru/api/community-events/json-schema):
 *   `message_new` (`object.message` for API ≥ 5.103, the message itself below
 *   that), `message_reply` (an outgoing community message), `message_edit`
 *   (only ever emitted for the community's own messages) and `message_event`
 *   (`object = {user_id, peer_id, event_id, payload, conversation_message_id?}`
 *   — a callback-button tap; `event_id` lives for one minute).
 * - Sending: `messages.send?peer_id=&message=&random_id=&reply_to=&keyboard=`
 *   → `{response: <message_id>}`
 *   (https://dev.vk.com/ru/method/messages.send). `random_id` is an `int32`
 *   de-duplication key and is **required** by the API. `reply_to` is the id of
 *   the message being answered.
 * - Editing: `messages.edit?peer_id=&message_id=&message=&keyboard=` → `1`
 *   (https://dev.vk.com/ru/method/messages.edit).
 * - Typing: `messages.setActivity?peer_id=&type=typing&group_id=` → `1`
 *   (https://dev.vk.com/ru/method/messages.setActivity).
 * - Answering a tap: `messages.sendMessageEventAnswer?event_id=&user_id=&peer_id=&event_data=`
 *   → `1` (https://dev.vk.com/ru/method/messages.sendMessageEventAnswer).
 *   `event_data` is a JSON object; the only "toast" action is
 *   `{"type":"show_snackbar","text":"…"}` with a 90-character limit, and VK has
 *   **no modal alert** (https://dev.vk.com/ru/api/bots/development/keyboard/callback-keys),
 *   so the port's `alert` flag is accepted but has no wire equivalent.
 * - Keyboard: `{one_time, inline, buttons: [[{action, color}]]}`
 *   (https://dev.vk.com/ru/api/bots/development/keyboard). `inline: false`
 *   allows 10 rows x 5 buttons (40 total), `inline: true` 6 rows x 5 (10 total).
 *   Button labels are capped at 40 characters and `payload` at 255 characters,
 *   and a `payload` must be a JSON string delimited by braces
 *   (https://dev.vk.com/ru/api/bots/development/keyboard/key-types).
 * - Документы в сообщениях: `docs.getMessagesUploadServer?peer_id=&type=doc`
 *   → `{upload_url}` (https://dev.vk.com/ru/method/docs.getMessagesUploadServer),
 *   POST `multipart/form-data` с полем `file` на этот адрес → `{file}`
 *   (https://dev.vk.com/ru/api/upload/document-in-profile), `docs.save?file=&title=`
 *   → `{type: 'doc', doc: {owner_id, id, …}}`
 *   (https://dev.vk.com/ru/method/docs.save), затем `messages.send` с
 *   `attachment=doc<owner_id>_<id>`. Адрес загрузки одноразовый и не требует
 *   токена; имя файла задаётся в `docs.save` полем `title`, подпись — текстом
 *   сообщения.
 * - Attachments (https://dev.vk.com/ru/reference/objects/attachments-message):
 *   `photo` with a `sizes` array of `{url, width, height, type}` (older objects
 *   use `src` — https://dev.vk.com/ru/reference/objects/photo-sizes), `doc`
 *   with `url`, `title`, `ext`, `size`
 *   (https://dev.vk.com/ru/reference/objects/doc) and `audio_message` with
 *   `link_ogg`, `link_mp3`, `duration`
 *   (https://dev.vk.com/ru/reference/objects/audio-message). All of them carry
 *   direct, token-free URLs, so downloads never need the bot token.
 * - Reactions: `messages.sendReaction?peer_id=&cmid=&reaction_id=`
 *   (https://dev.vk.com/ru/method/messages.sendReaction) takes a *numeric*
 *   reaction id and a **conversation** message id, and the documentation lists
 *   it for a community token with the `messages` right. Whether a community bot
 *   may actually react is not documented anywhere, so `setReaction` is
 *   best-effort: it issues the documented call and degrades to a logged no-op
 *   (exactly like the MAX and VK Teams adapters) when VK refuses.
 * - Errors (https://dev.vk.com/ru/reference/errors): `5` (authorization
 *   failed), `15` (access denied) and `27` (community token invalid) can never
 *   succeed on a retry; `6` (too many requests per second) and `10` (internal
 *   server error) can.
 *
 * ## Discrepancies with the task brief
 *
 * - The brief swaps the Long Poll `failed` codes. The documented meaning is
 *   `failed:1` — "история событий устарела … используя новое значение ts из
 *   ответа" (keep the session, continue with the returned `ts`), `failed:2` —
 *   the session key expired (re-fetch the key), `failed:3` — the history is
 *   lost (re-fetch both key and `ts`). This adapter follows the documentation;
 *   `failed:2` both re-fetches the key **and** continues from the returned `ts`,
 *   so the behaviour the brief describes is a subset of the documented one.
 * - The brief says one message is at most 4096 characters. `messages.send`
 *   currently documents `Макс. длина = 9000` for `message`, while
 *   `messages.edit` still says 4096; the conservative 4096 limit is kept for
 *   both paths.
 * - `object.message.text` vs `object.message.message`: the community-events
 *   schema nests a Message object under `message`, and the Message reference
 *   labels its text field `message` while every sample payload uses `text`
 *   (older versions used `body`). All three names are accepted.
 *
 * ## Token hygiene
 *
 * The token travels in the query string, and so does the long-poll session
 * `key`. Every string that may echo a URL — log records, thrown error messages
 * and error `cause` chains — is passed through `redactToken`, so neither secret
 * can leak.
 */
import { numericId } from './port.mjs'
import { ConnectionError, deadlineSignal } from '../connection.mjs'

/** API root: every method is `<apiBase>/<method>`. */
export const DEFAULT_API_BASE = 'https://api.vk.com/method'
/** API version sent as `v` on every call. */
export const DEFAULT_API_VERSION = '5.199'
/**
 * Server-side hold time for one long poll, in seconds.
 *
 * The documentation recommends 25 ("некоторые прокси-серверы обрывают
 * соединение после 30 секунд") and caps it at 90.
 */
export const DEFAULT_POLL_TIMEOUT_SEC = 25
export const MAX_POLL_TIMEOUT_SEC = 90
/** How many times one `getUpdates` call recovers from a `failed` answer. */
export const MAX_POLL_RECOVERIES = 3
/**
 * Per-message text limit.
 *
 * `messages.edit` documents 4096; `messages.send` currently documents 9000.
 * The smaller number is kept for both so a chunk is always editable.
 */
export const VK_TEXT_LIMIT = 4096
/** Non-inline ("chat") keyboard: up to 10 rows x 5 buttons, 40 buttons total. */
export const VK_KEYBOARD_ROWS = 10
export const VK_KEYBOARD_BUTTONS = 5
export const VK_KEYBOARD_TOTAL = 40
/** Inline keyboard: up to 6 rows x 5 buttons, 10 buttons total. */
export const VK_INLINE_KEYBOARD_ROWS = 6
export const VK_INLINE_KEYBOARD_BUTTONS = 5
export const VK_INLINE_KEYBOARD_TOTAL = 10
/** `label` and `payload` limits from the keyboard documentation. */
export const VK_LABEL_LIMIT = 40
export const VK_PAYLOAD_LIMIT = 255
/** `show_snackbar` text limit. */
export const VK_SNACKBAR_LIMIT = 90
/** Download cap, matching the other adapters' default. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 20_000_000
/**
 * Имя документа для `docs.save`.
 *
 * Точный предел VK не документирует; 256 символов с запасом покрывают имена
 * файлов инструмента `file` и при этом не раздувают запрос.
 */
export const VK_DOCUMENT_TITLE_LIMIT = 256
/** How many of our own message ids are remembered for reply detection. */
export const OWN_MESSAGE_CACHE_SIZE = 200
/** How many `message_event`s are remembered so `answerCallback` can reply. */
export const CALLBACK_CACHE_SIZE = 100
/** How many attachment URLs are remembered for a `fileId`-only download. */
export const ATTACHMENT_CACHE_SIZE = 200

/**
 * Error codes that can never succeed on a retry
 * (https://dev.vk.com/ru/reference/errors): `5` authorization failed,
 * `15` access denied, `27` community token invalid.
 */
export const FATAL_ERROR_CODES = new Set([5, 15, 27])
/** Error codes worth retrying: `6` too many requests, `10` internal error. */
export const RETRYABLE_ERROR_CODES = new Set([6, 10])

/**
 * Emoji → numeric reaction id.
 *
 * The `messages.sendReaction` documentation names the parameter but not the
 * numbering, and it is not published anywhere on dev.vk.com; these are the ids
 * the VK clients use for the standard reaction set. An id may also be passed
 * directly as a numeric string/emoji, and anything unknown (for example the
 * 👀 receipt the core sends) degrades to a no-op.
 */
export const VK_REACTION_IDS = {
  '❤️': 1, '❤': 1, '🔥': 2, '👍': 3, '👎': 4, '🤔': 5, '😁': 6, '🤣': 7, '😢': 8, '😡': 9,
  '🎉': 10, '🥰': 11, '😍': 12, '🤩': 13, '🤯': 14, '😱': 15, '🤬': 16, '😭': 17, '🤗': 18,
  '🤝': 19, '🫡': 20,
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const backoff = (attempt) => Math.min(500 * 2 ** (attempt - 1), 10_000)

/** Error carrying the VK method, error code, description and HTTP status. */
export class VkError extends ConnectionError {
  /**
   * @param {string} message - readable description (never contains a secret).
   * @param {object} [details] - error details.
   * @param {string} [details.method] - operation, for example `messages.send`.
   * @param {number} [details.code] - VK `error_code`, when the body carries one.
   * @param {string} [details.description] - the API `error_msg`.
   * @param {number} [details.status] - HTTP status, when there was a response.
   * @param {boolean} [details.fatal] - true when retrying can never help.
   * @param {Error} [details.cause] - original error.
   */
  constructor(message, { method, code, description, status, fatal = false, cause } = {}) {
    super(message, { provider: 'vk', status, cause })
    this.name = 'VkError'
    this.method = method
    this.code = code
    this.description = description
    this.status = status
    this.fatal = fatal
  }
}

/** Remove one secret (usually the token) from any string that may embed it. */
export function redactToken(text, token) {
  const value = String(text ?? '')
  if (token === undefined || token === null || token === '') return value
  return value.split(String(token)).join('***')
}

/** Remove several secrets (token and long-poll key) from one string. */
export function redactSecrets(text, secrets) {
  let value = String(text ?? '')
  for (const secret of secrets ?? []) value = redactToken(value, secret)
  return value
}

/**
 * A copy of `error` whose message no longer contains a secret.
 *
 * A network error thrown by `fetch` quotes the URL it failed on, and the token
 * and long-poll key travel in that URL. The original's name and syscall fields
 * are kept, while the message and any nested cause — which `util.inspect`
 * prints — are rebuilt without the secrets.
 */
function redactError(error, secrets) {
  if (!error || typeof error !== 'object' || typeof error.message !== 'string') return error
  const message = redactSecrets(error.message, secrets)
  const nested = error.cause ? redactError(error.cause, secrets) : undefined
  if (message === error.message && nested === error.cause) return error
  const copy = new Error(message)
  copy.name = error.name ?? 'Error'
  if (nested !== undefined) copy.cause = nested
  for (const key of ['code', 'errno', 'syscall', 'status', 'method', 'description', 'fatal']) {
    if (error[key] !== undefined) copy[key] = error[key]
  }
  return copy
}

/** Parse a JSON body; `undefined` means "not JSON at all". */
function parseJson(text) {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `numericId` that leaves a missing id missing instead of stringifying it. */
const idOrUndefined = (value) =>
  (value === undefined || value === null || value === '' ? undefined : numericId(value))

/** The first argument that is a non-empty string. */
const firstString = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * Короткая причина сбоя без URL и токена.
 *
 * У `VkError` берём описание VK, у таймаута — понятную фразу, у сетевой
 * ошибки — только код: текст `fetch` цитирует URL, а в адресе загрузки лежит
 * одноразовая подпись.
 */
function failureDetail(error) {
  if (error instanceof VkError) {
    return firstString(error.description, error.message) || 'неизвестная ошибка VK'
  }
  if (error?.name === 'TimeoutError') return 'истекло время ожидания'
  const code = error?.cause?.code ?? error?.code
  return code ? `сетевая ошибка ${code}` : 'сеть недоступна'
}

/** Обернуть сбой шага отправки документа в `VkError` с русским объяснением. */
function documentError(error, summary, method) {
  return new VkError(`${summary}: ${failureDetail(error)}`, {
    method,
    code: error?.code,
    description: error?.description,
    status: error?.status,
    fatal: error?.fatal,
    cause: error,
  })
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a `peer_id` names a one-to-one dialog.
 *
 * VK documents the peer id as the user id for a private dialog,
 * `2000000000 + chat_id` for a conversation and `-community_id` for a
 * community (https://dev.vk.com/ru/method/messages.send).
 */
export function isPrivatePeer(peerId) {
  const value = Number(peerId)
  return Number.isFinite(value) && value > 0 && value < 2_000_000_000
}

/** `peer_id` → the port's chat type (`private` | `group`). */
export function peerChatType(peerId) {
  return isPrivatePeer(peerId) ? 'private' : 'group'
}

/**
 * The next `ts`: the larger of the two values, so the cursor never rolls back.
 *
 * `ts` is a monotonically increasing event counter for the community, so a
 * server answer that is numerically lower than the local cursor is ignored
 * rather than allowed to replay old events.
 */
export function nextTs(previous, candidate) {
  if (candidate === undefined || candidate === null || candidate === '') return previous
  if (previous === undefined || previous === null || previous === '') return String(candidate)
  const before = Number(previous)
  const after = Number(candidate)
  if (Number.isFinite(before) && Number.isFinite(after)) return after >= before ? String(candidate) : String(previous)
  return String(candidate)
}

/** Clamp `timeoutSec` into the documented `wait` range. */
export function normalizeWait(timeoutSec) {
  const value = Number(timeoutSec)
  if (!Number.isFinite(value)) return DEFAULT_POLL_TIMEOUT_SEC
  return Math.min(Math.max(Math.floor(value), 1), MAX_POLL_TIMEOUT_SEC)
}

/**
 * One neutral button's `data` in the payload VK accepts.
 *
 * VK requires a button `payload` to be a JSON string delimited by braces and
 * capped at 255 characters, while the core's neutral button carries a plain
 * string (`cancel:3`). The value is wrapped in a one-key envelope on the way
 * out and unwrapped again by {@link decodeCallbackData}, which keeps the core
 * untouched.
 */
export function encodeCallbackData(data) {
  const value = String(data ?? '')
  let body = JSON.stringify({ d: value })
  if (body.length > VK_PAYLOAD_LIMIT) {
    // Shrink the value until the whole JSON envelope fits the documented cap.
    const room = VK_PAYLOAD_LIMIT - '{"d":""}'.length
    body = JSON.stringify({ d: value.slice(0, Math.max(0, room)) })
  }
  return body
}

/** Unwrap a `message_event.payload` back into the core's callback string. */
export function decodeCallbackData(payload) {
  if (payload === undefined || payload === null) return ''
  if (typeof payload === 'object') return payload.d === undefined ? '' : String(payload.d)
  const raw = String(payload)
  const parsed = parseJson(raw)
  if (parsed && typeof parsed === 'object' && parsed.d !== undefined) return String(parsed.d)
  return raw
}

/**
 * Map the neutral keyboard onto VK's `keyboard` object.
 *
 * Rows and buttons beyond the documented caps are dropped rather than failing
 * the send, and a button without text cannot be rendered at all. A `url`
 * button becomes `open_link`, a button with `data` becomes `callback` and
 * anything else becomes a `text` button that sends its own label.
 *
 * @param {{rows?: Array<Array<object>>}} [keyboard] - neutral keyboard.
 * @param {object} [options] - rendering options.
 * @param {boolean} [options.inline] - true for an in-message keyboard.
 * @returns {object|undefined} the API's keyboard object, or undefined when empty.
 */
export function toVkKeyboard(keyboard, { inline = false } = {}) {
  const maxRows = inline ? VK_INLINE_KEYBOARD_ROWS : VK_KEYBOARD_ROWS
  const maxPerRow = inline ? VK_INLINE_KEYBOARD_BUTTONS : VK_KEYBOARD_BUTTONS
  const maxTotal = inline ? VK_INLINE_KEYBOARD_TOTAL : VK_KEYBOARD_TOTAL
  if (!keyboard?.rows?.length) return undefined
  const buttons = []
  let total = 0
  for (const row of keyboard.rows.slice(0, maxRows)) {
    const rendered = (row ?? [])
      .map((button) => toVkButton(button, inline))
      .filter(Boolean)
      .slice(0, maxPerRow)
    if (rendered.length === 0) continue
    const room = maxTotal - total
    if (room <= 0) break
    buttons.push(rendered.slice(0, room))
    total += Math.min(rendered.length, room)
  }
  if (buttons.length === 0) return undefined
  // `one_time` only has an effect on a non-inline keyboard.
  return { one_time: false, inline: Boolean(inline), buttons }
}

/**
 * Remove a community mention from the text of a message.
 *
 * A conversation message reaches the bot as «[club123|Название] /reminders», and the
 * markup used to survive into the text: the core then saw a message that does not
 * start with a slash, so commands typed after a mention were ignored and the model
 * received the markup as noise.
 *
 * @param {string} text - raw message text.
 * @param {object} [options] - `{ screenName }` for the @short-name form.
 * @returns {string} the text without mention markup.
 */
export function stripMentionMarkup(text, { screenName } = {}) {
  let result = String(text ?? '')
  result = result.replace(/\[(?:club|public)\d+\|[^\]]*\]/gi, ' ')
  result = result.replace(/\[(?:club|public)\d+\]/gi, ' ')
  result = result.replace(/@(?:club|public)\d+/gi, ' ')
  if (screenName) {
    const escaped = String(screenName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`@${escaped}\\b`, 'gi'), ' ')
  }
  return result
    .replace(/^[\s,.:;!—-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.:;!?])/g, '$1')
    .trim()
}

/** One neutral button in VK's wire shape. */
function toVkButton(button, inline) {
  if (!button) return undefined
  const label = String(button.text ?? '').slice(0, VK_LABEL_LIMIT)
  if (label === '') return undefined
  if (button.url) {
    return { action: { type: 'open_link', link: String(button.url).slice(0, 2048), label }, color: 'secondary' }
  }
  if (!inline && button.data === undefined) {
    // A non-inline button with neither a link nor data is a plain text button;
    // VK only accepts a payload that is a braced JSON string, so it is omitted.
    return { action: { type: 'text', label }, color: 'secondary' }
  }
  if (button.data === undefined) return undefined
  return {
    action: { type: 'callback', label, payload: encodeCallbackData(button.data) },
    color: 'secondary',
  }
}

/**
 * Convert the core's markdown into the plain text VK can display.
 *
 * VK has no message formatting: asterisks, underscores and hashes would be
 * shown literally, so emphasis markers are dropped, headings lose their hash,
 * bullets become `•` and a link degrades to `label (url)` because the raw URL
 * is at least clickable. Code spans are protected first and restored last, so
 * an asterisk inside `code` is never mistaken for emphasis.
 *
 * @param {string} markdown - core markdown.
 * @returns {string} plain text, or `''` for an empty input.
 */
export function markdownToVkText(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  const code = []
  const stash = (value) => {
    code.push(value)
    return `\u0000${code.length - 1}\u0000`
  }
  let text = markdown
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_all, block) => stash(block.replace(/\n$/, '')))
  text = text.replace(/`{1,2}([^\n`]+?)`{1,2}/g, (_all, span) => stash(span))
  // Images and links: VK cannot render either, so the label plus the URL is the
  // most useful form.
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_all, alt, url) => (alt ? `${alt} (${url})` : url))
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_all, label, url) =>
    (/^https?:\/\//i.test(url) ? `${label} (${url})` : label))
  // Block level marks.
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, '$1')
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
  text = text.replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '———')
  // Emphasis, longest markers first.
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
  text = text.replace(/___([^_\n]+)___/g, '$1')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1$2')
  return text.replace(/\u0000(\d+)\u0000/g, (_all, index) => code[Number(index)] ?? '')
}

/**
 * Split plain text into chunks of at most `limit` characters.
 *
 * Paragraph breaks are preferred, then line breaks, then spaces, and only a
 * single unbroken run longer than the limit is hard-cut — never between the
 * halves of a surrogate pair. The whitespace a cut lands on is dropped, so no
 * chunk starts or ends with the break itself.
 *
 * @param {string} text - already-plain text.
 * @param {number} [limit] - VK's per-message limit.
 * @returns {string[]} one or more non-empty chunks.
 */
export function splitVkText(text, limit = VK_TEXT_LIMIT) {
  const source = String(text ?? '')
  if (source === '') return []
  const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : VK_TEXT_LIMIT
  if (source.length <= size) return [source]
  const chunks = []
  let rest = source
  while (rest.length > size) {
    const window = rest.slice(0, size)
    let take = 0
    const paragraph = window.lastIndexOf('\n\n')
    if (paragraph > 0) take = paragraph + 2
    if (take === 0) {
      const line = window.lastIndexOf('\n')
      if (line > 0) take = line + 1
    }
    if (take === 0) {
      const space = window.lastIndexOf(' ')
      if (space > 0) take = space + 1
    }
    if (take === 0) {
      // A single run longer than the limit: cut it, but keep a surrogate pair
      // together by spilling one unit past the target when needed.
      take = size
      const unit = rest.charCodeAt(take - 1)
      if (unit >= 0xd800 && unit <= 0xdbff && rest.length > take) take += 1
    }
    const chunk = rest.slice(0, take).replace(/\s+$/, '')
    if (chunk !== '') chunks.push(chunk)
    rest = rest.slice(take).replace(/^\s+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks.filter((chunk) => chunk !== '')
}

/**
 * A photo's largest copy.
 *
 * Sizes are objects `{url, width, height, type}`; pre-2012 photos use `src`
 * instead of `url`, and `width`/`height` may both be `0`. Ties and missing
 * dimensions fall back to the last entry, which is the order VK documents
 * (`s`, `m`, `x`, `y`, `z`, `w`).
 *
 * @param {object} photo - a `photo` attachment body.
 * @returns {{url: string, width?: number, height?: number}|undefined} the copy.
 */
export function pickPhotoSize(photo) {
  const sizes = photo?.sizes
  if (!Array.isArray(sizes) || sizes.length === 0) return undefined
  let best
  let bestArea = -1
  for (const size of sizes) {
    const url = typeof size?.url === 'string' && size.url !== '' ? size.url : size?.src
    if (typeof url !== 'string' || url === '') continue
    const area = Number(size?.width ?? 0) * Number(size?.height ?? 0)
    if (!Number.isFinite(area) || area <= 0) {
      // Unknown dimensions: a later entry is still preferable to nothing.
      if (best === undefined) best = { url, width: size?.width, height: size?.height }
      continue
    }
    if (area >= bestArea) {
      bestArea = area
      best = { url, width: size?.width, height: size?.height }
    }
  }
  return best
}

/** The URL of a photo's largest copy. */
export const pickPhotoUrl = (photo) => pickPhotoSize(photo)?.url

/** The first direct file URL in a video object's `files` map, if any. */
function videoFileUrl(video) {
  const files = video?.files
  if (!files || typeof files !== 'object') return undefined
  for (const value of Object.values(files)) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  return undefined
}

/**
 * VK API client: GET requests, query-parameter auth, `{response}` / `{error}`.
 *
 * Every call is a plain fetch, so the client runs against a local stub in tests
 * exactly as it runs against `api.vk.com` in production.
 */
export class VkClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.token] - community access token; defaults to `VK_TOKEN`.
   * @param {string} [options.apiBase] - API root; defaults to `VK_API_BASE`.
   * @param {string} [options.apiVersion] - `v` parameter; defaults to `VK_API_VERSION`.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   */
  constructor({
    token,
    apiBase = DEFAULT_API_BASE,
    apiVersion = DEFAULT_API_VERSION,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
    logger,
    maxAttempts = 4,
    sleep = defaultSleep,
  } = {}) {
    this.token = token ?? ''
    this.apiBase = String(apiBase).replace(/\/+$/, '')
    this.apiVersion = String(apiVersion)
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.maxAttempts = maxAttempts
    this.sleep = sleep
  }

  /**
   * Build a request URL.
   *
   * VK authenticates with the query parameters `access_token` and `v`, so the
   * token is added here and nowhere else; every string that could echo the URL
   * goes through `redactSecrets`.
   */
  url(method, params) {
    const url = new URL(`${this.apiBase}/${method}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
    url.searchParams.set('v', this.apiVersion)
    if (this.token) url.searchParams.set('access_token', this.token)
    return url.toString()
  }

  /** One fetch plus body parse, with no retry or error interpretation. */
  async once(url, { signal, timeoutMs } = {}) {
    const requestSignal = deadlineSignal(timeoutMs ?? this.timeoutMs, signal)
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: requestSignal,
    })
    const text = await response.text()
    return { response, text, data: parseJson(text) }
  }

  /**
   * Perform one API method and unwrap the `{response}` envelope.
   *
   * Retries in-band `error_code` 6 and 10 (they arrive with HTTP 200), HTTP 429
   * and 5xx, and network failures; a fatal code (5/15/27) is thrown at once.
   *
   * @param {string} method - API method, for example `messages.send`.
   * @param {object} [params] - query parameters.
   * @param {object} [options] - `signal`, `timeoutMs`.
   * @returns {Promise<{data: any, text: string, status: number}>} the `response` value.
   */
  async call(method, params, options = {}) {
    if (!this.token) {
      throw new VkError(`VK ${method} failed: no community token (pass token or set VK_TOKEN)`, { method })
    }
    const url = this.url(method, params)
    let lastError
    const maxAttempts = Number(options.attempts) > 0 ? Number(options.attempts) : this.maxAttempts
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { response, text, data } = await this.once(url, options)
        // A non-JSON body is a proxy error page, never a valid API answer.
        if (data === undefined) {
          const error = new VkError(`VK ${method} failed: HTTP ${response.status} (not JSON)`, {
            method,
            status: response.status,
          })
          if (response.status >= 500 && attempt < this.maxAttempts) {
            lastError = error
            await this.sleep(backoff(attempt))
            continue
          }
          throw error
        }
        if (data?.error) {
          const code = Number(data.error.error_code)
          const description = redactSecrets(String(data.error.error_msg ?? '').trim(), [this.token]) || undefined
          const fatal = FATAL_ERROR_CODES.has(code)
          const error = new VkError(
            `VK ${method} failed: [${Number.isFinite(code) ? code : '?'}] ${description ?? 'unknown error'}`,
            { method, code: Number.isFinite(code) ? code : undefined, description, status: response.status, fatal },
          )
          if (!fatal && RETRYABLE_ERROR_CODES.has(code) && attempt < this.maxAttempts) {
            this.logger?.warn('vk rate limited or server error, retrying', { method, code, attempt })
            await this.sleep(backoff(attempt))
            continue
          }
          throw error
        }
        if (!response.ok) {
          const error = new VkError(`VK ${method} failed: HTTP ${response.status}`, { method, status: response.status })
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxAttempts) {
            lastError = error
            await this.sleep(backoff(attempt))
            continue
          }
          throw error
        }
        return { data: data.response, text, status: response.status }
      } catch (error) {
        if (error instanceof VkError) throw error
        if (options.signal?.aborted) throw error
        lastError = error
        if (attempt >= this.maxAttempts) break
        this.logger?.warn('vk request failed, retrying', {
          method,
          attempt,
          reason: redactSecrets(error?.message, [this.token]),
        })
        await this.sleep(backoff(attempt))
      }
    }
    throw new VkError(
      redactSecrets(`VK ${method} failed after ${this.maxAttempts} attempts: ${lastError?.message}`, [this.token]),
      { method, cause: redactError(lastError, [this.token]) },
    )
  }

  /** `groups.getById` — community identity, or the token's own community. */
  getGroup({ groupId } = {}, options) {
    return this.call('groups.getById', { group_id: groupId }, options)
  }

  /** `groups.getLongPollServer` — the `{key, server, ts}` session. */
  getLongPollServer({ groupId } = {}, options) {
    return this.call('groups.getLongPollServer', { group_id: groupId }, options)
  }

  /**
   * One `a_check` request against the long-poll server.
   *
   * The long-poll server is not `api.vk.com` and needs no access token, but the
   * session `key` is a secret of its own; the request budget stays above the
   * server-side `wait` so a healthy poll is never aborted.
   */
  async longPoll({ server, key, ts, wait = DEFAULT_POLL_TIMEOUT_SEC }, options = {}) {
    const url = new URL(String(server))
    url.searchParams.set('act', 'a_check')
    url.searchParams.set('key', String(key))
    url.searchParams.set('ts', String(ts))
    url.searchParams.set('wait', String(wait))
    const secrets = [this.token, key]
    let lastError
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const { response, text, data } = await this.once(url.toString(), {
          timeoutMs: (Number(wait) + 20) * 1000,
          ...options,
        })
        if (data === undefined) {
          const error = new VkError(`VK a_check failed: HTTP ${response.status} (not JSON)`, {
            method: 'a_check',
            status: response.status,
          })
          if (response.status >= 500 && attempt < this.maxAttempts) {
            lastError = error
            await this.sleep(backoff(attempt))
            continue
          }
          throw error
        }
        if (!response.ok) {
          const error = new VkError(`VK a_check failed: HTTP ${response.status}`, {
            method: 'a_check',
            status: response.status,
          })
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxAttempts) {
            lastError = error
            await this.sleep(backoff(attempt))
            continue
          }
          throw error
        }
        return { data, text, status: response.status }
      } catch (error) {
        if (error instanceof VkError) throw error
        if (options.signal?.aborted) throw error
        lastError = error
        if (attempt >= this.maxAttempts) break
        this.logger?.warn('vk long poll request failed, retrying', {
          attempt,
          reason: redactSecrets(error?.message, secrets),
        })
        await this.sleep(backoff(attempt))
      }
    }
    throw new VkError(
      redactSecrets(`VK a_check failed after ${this.maxAttempts} attempts: ${lastError?.message}`, secrets),
      { method: 'a_check', cause: redactError(lastError, secrets) },
    )
  }

  /** `messages.send` → the new message id. */
  sendMessage({ peerId, message, randomId, replyTo, keyboard, attachment }, options) {
    return this.call('messages.send', {
      peer_id: peerId,
      message,
      random_id: randomId,
      reply_to: replyTo,
      keyboard: keyboard === undefined ? undefined : JSON.stringify(keyboard),
      attachment,
    }, options)
  }

  /** `docs.getMessagesUploadServer` — одноразовый адрес загрузки документа. */
  getMessagesUploadServer({ peerId, type = 'doc' }, options) {
    return this.call('docs.getMessagesUploadServer', { peer_id: peerId, type }, options)
  }

  /** `docs.save` — сохранить загруженный файл и получить его id. */
  saveDocument({ file, title }, options) {
    return this.call('docs.save', { file, title }, options)
  }

  /** `messages.edit` — rewrite the text (and optionally the keyboard). */
  editMessage({ peerId, messageId, message, keyboard }, options) {
    return this.call('messages.edit', {
      peer_id: peerId,
      message_id: messageId,
      message,
      keyboard: keyboard === undefined ? undefined : JSON.stringify(keyboard),
    }, options)
  }

  /** `messages.setActivity` — the "typing…" hint. */
  setActivity({ peerId, groupId, type = 'typing' }, options) {
    return this.call('messages.setActivity', { peer_id: peerId, group_id: groupId, type }, options)
  }

  /** `messages.sendMessageEventAnswer` — acknowledge a callback tap. */
  sendMessageEventAnswer({ eventId, userId, peerId, eventData }, options) {
    return this.call('messages.sendMessageEventAnswer', {
      event_id: eventId,
      user_id: userId,
      peer_id: peerId,
      event_data: eventData === undefined ? undefined : JSON.stringify(eventData),
    }, options)
  }

  /** `messages.sendReaction` — best-effort reaction on a conversation message. */
  sendReaction({ peerId, cmid, reactionId }, options) {
    return this.call('messages.sendReaction', { peer_id: peerId, cmid, reaction_id: reactionId }, options)
  }
}

/**
 * The VK community-bot adapter.
 *
 * @see the port contract in `port.mjs` for the neutral shapes.
 */
export class VkPlatform {
  /**
   * @param {object} options - adapter options.
   * @param {string} [options.token] - community token; defaults to `VK_TOKEN`.
   * @param {string|number} [options.groupId] - community id of the community.
   * @param {string} [options.apiBase] - API root; defaults to `VK_API_BASE`.
   * @param {string} [options.apiVersion] - `v`; defaults to `VK_API_VERSION`.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   * @param {() => number} [options.random] - random source for `random_id`.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {number} [options.ownMessageCacheSize] - reply-detection cache size.
   * @param {VkClient} [options.client] - pre-built client (tests).
   */
  constructor({
    token,
    groupId = '',
    apiBase,
    apiVersion,
    timeoutMs,
    logger,
    fetchImpl,
    sleep = defaultSleep,
    maxAttempts,
    ownMessageCacheSize = OWN_MESSAGE_CACHE_SIZE,
    callbackCacheSize = CALLBACK_CACHE_SIZE,
    attachmentCacheSize = ATTACHMENT_CACHE_SIZE,
    random = Math.random,
    client,
  } = {}) {
    this.name = 'vk'
    // Short platform marker: it names the adapter and prefixes shared keys.
    this.namespace = 'vk'
    this.logger = logger
    this.client = client ?? new VkClient({ token, apiBase, apiVersion, timeoutMs, logger, fetchImpl, maxAttempts, sleep })
    // The client owns the API budget; the adapter needs one too, for the direct
    // download of an attachment URL.
    this.timeoutMs = timeoutMs ?? 60_000
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.groupId = groupId === undefined || groupId === null || groupId === '' ? undefined : numericId(groupId)
    this.identity = undefined
    this.random = typeof random === 'function' ? random : Math.random
    this.ownMessageCacheSize = ownMessageCacheSize
    this.callbackCacheSize = callbackCacheSize
    this.attachmentCacheSize = attachmentCacheSize
    /** The `{server, key, ts}` long-poll session, dropped when a key expires. */
    this.session = undefined
    this.lastRandomId = undefined
    /**
     * `message_id` → peer id for the messages this adapter sent.
     *
     * VK does not mark "this is a reply to the bot" in any other reliable way
     * when `reply_message.from_id` is missing, so our own sends are remembered.
     */
    this.ownMessages = new Map()
    /** `message_id` → `conversation_message_id`, needed by `sendReaction`. */
    this.conversationIds = new Map()
    /** `peer_id` → the last message id sent there, for callback message ids. */
    this.lastMessageByPeer = new Map()
    /** `event_id` → `{userId, peerId}`, needed by `answerCallback`. */
    this.pendingCallbacks = new Map()
    /** `fileId` → `{url, name}` for a download that only knows the file id. */
    this.attachmentUrls = new Map()
  }

  /**
   * Resolve the community identity through `groups.getById`.
   *
   * A failure is logged and does not stop the bot: the adapter still knows the
   * configured `groupId`, and long polling only needs that. There is no webhook
   * to drop — a community bot uses Long Poll or Callback API, and this adapter
   * only implements the former.
   *
   * @returns {Promise<VkPlatform>} this adapter.
   */
  async start() {
    this.identity = { id: this.groupId, username: undefined, title: undefined }
    try {
      const { data } = await this.client.getGroup({ groupId: this.groupId })
      // Since API 5.139 the answer is `{groups: [...], profiles: [...]}`; before
      // that it was the bare array of group objects.
      const group = Array.isArray(data) ? data[0] : (data?.groups?.[0] ?? data)
      if (group && typeof group === 'object') {
        if (this.groupId === undefined && group.id !== undefined) this.groupId = numericId(group.id)
        this.identity = {
          id: this.groupId ?? idOrUndefined(group.id),
          username: group.screen_name ?? undefined,
          title: group.name ?? group.screen_name ?? undefined,
        }
      }
      if (this.groupId === undefined) {
        this.logger?.warn('vk identity has no community id; set VK_GROUP_ID before polling')
      }
    } catch (error) {
      this.logger?.warn('vk identity lookup failed', { reason: error?.message, groupId: this.groupId })
    }
    return this
  }

  /** Long polling needs no unsubscription; the session is simply forgotten. */
  async stop() {
    this.session = undefined
  }

  /** A rejected community token is not worth retrying. */
  isFatalError(error) {
    return error instanceof VkError
      && Boolean(error.fatal || FATAL_ERROR_CODES.has(Number(error.code)))
  }

  /** The community id, which every long-poll and typing call needs. */
  requireGroupId() {
    const value = this.groupId ?? this.identity?.id
    if (value === undefined || value === null || value === '') {
      throw new VkError('VK community id is unknown: pass groupId or set VK_GROUP_ID', { method: 'groups.getLongPollServer' })
    }
    return value
  }

  /**
   * Long-poll and normalise.
   *
   * `cursor` is the `ts` of the last handled event; the first call asks
   * `groups.getLongPollServer` for a session and uses its `ts`. A `failed`
   * answer is recovered per the documentation: `1` keeps the session and
   * continues from the returned `ts`, `2` (expired key) and `3` (lost history)
   * re-fetch the session. The returned cursor never moves backwards.
   *
   * @param {object} [request] - `cursor` (the previous `ts`), `timeoutSec` (the `wait`).
   * @returns {Promise<{updates: object[], cursor: string|undefined}>} updates and the new `ts`.
   */
  async getUpdates({ cursor, timeoutSec = DEFAULT_POLL_TIMEOUT_SEC, signal } = {}) {
    const wait = normalizeWait(timeoutSec)
    let lastTs = cursor === undefined || cursor === null || cursor === '' ? undefined : String(cursor)
    let ts = lastTs
    for (let attempt = 1; attempt <= MAX_POLL_RECOVERIES + 1; attempt++) {
      const session = await this.ensureSession({ signal })
      if (ts === undefined) {
        ts = nextTs(lastTs, session.ts)
        lastTs = ts
      }
      if (ts === undefined) {
        throw new VkError('VK long poll session carries no ts', { method: 'groups.getLongPollServer' })
      }
      const { data } = await this.client.longPoll({ server: session.server, key: session.key, ts, wait }, { signal })
      if (data?.failed === undefined || data?.failed === null) {
        const next = nextTs(ts, data?.ts)
        this.session = { ...session, ts: next }
        const updates = []
        for (const update of data?.updates ?? []) {
          const normalised = this.normalize(update)
          if (normalised) updates.push(normalised)
        }
        return { updates, cursor: next }
      }
      const failed = Number(data.failed)
      // failed:2 means the long-poll key expired, which VK does about hourly and
      // which is handled right below by asking for a new session. Logging that as a
      // warning buried the real ones; only history loss (1 and 3) is noteworthy.
      if (failed === 2) this.logger?.debug('vk long poll session expired', { ts, attempt })
      else this.logger?.warn('vk long poll failed', { failed, ts, attempt })
      if (failed === 1) {
        // The history is outdated or was partially lost: the same session keeps
        // working, the answer carries the `ts` to continue from.
        ts = nextTs(lastTs, data?.ts)
        lastTs = ts
        continue
      }
      if (failed === 2 || failed === 3) {
        // 2 — the session key expired; 3 — the history is lost. Both need a new
        // session from `groups.getLongPollServer`; 3 also needs its fresh `ts`,
        // while 2 keeps the local one (an answer's `ts` wins when it is newer).
        if (data?.ts !== undefined) {
          lastTs = nextTs(lastTs, data.ts)
          ts = lastTs
        }
        this.session = undefined
        if (failed === 3) ts = undefined
        continue
      }
      throw new VkError(`VK a_check failed with an unknown code ${data.failed}`, { method: 'a_check' })
    }
    throw new VkError(`VK long poll did not recover after ${MAX_POLL_RECOVERIES} attempts`, { method: 'a_check' })
  }

  /** Fetch the long-poll session once and cache it until it expires. */
  async ensureSession(options = {}) {
    if (this.session?.server && this.session?.key) return this.session
    const { data } = await this.client.getLongPollServer({ groupId: this.requireGroupId() }, options)
    const server = data?.server
    const key = data?.key
    if (typeof server !== 'string' || server === '' || typeof key !== 'string' || key === '') {
      throw new VkError('VK groups.getLongPollServer returned no server/key', { method: 'groups.getLongPollServer' })
    }
    this.session = { server, key, ts: idOrUndefined(data?.ts) === undefined ? undefined : String(data.ts) }
    return this.session
  }

  /**
   * Turn one long-poll event into the neutral shape.
   *
   * `message_new` is the only incoming-message event. `message_reply` is an
   * outgoing community message and `message_edit` is only ever emitted for the
   * community's own messages, so both are normalised with `from.isBot: true` —
   * the core drops them, but a "what did the bot edit" consumer still can see
   * them. Everything else (`message_typing_state`, `group_join`, …) is ignored.
   *
   * @param {object} update - one `{type, object, event_id}` event.
   * @returns {object|undefined} the neutral update, or undefined when ignored.
   */
  normalize(update) {
    switch (update?.type) {
      case 'message_new':
      case 'message_reply':
      case 'message_edit':
        return this.normalizeMessage(update)
      case 'message_event':
        return this.normalizeCallback(update)
      default:
        return undefined
    }
  }

  /** `message_new` / `message_edit` / `message_reply` → `kind: 'message'`. */
  normalizeMessage(update) {
    const raw = update?.object ?? {}
    // For API 5.103 and newer `object.message` holds the message; below that the
    // event object *is* the message.
    const message = raw.message && typeof raw.message === 'object' ? raw.message : raw
    if (!message || typeof message !== 'object') return undefined
    const peerId = idOrUndefined(message.peer_id)
    if (peerId === undefined) return undefined
    const fromId = idOrUndefined(message.from_id)
    const chatType = peerChatType(peerId)
    const messageId = idOrUndefined(message.id)
    if (messageId !== undefined) {
      this.rememberConversationId(messageId, message.conversation_message_id)
    }
    // The text field is `text` in every sample payload; the Message reference
    // labels it `message`, and versions below 5.80 used `body`.
    // Mentions are stripped: the command after «[club1|Бот]» must stay a command.
    const text = stripMentionMarkup(firstString(message.text, message.message, message.body, raw.text).trim(), { screenName: this.identity?.username })
    return {
      kind: 'message',
      id: update.event_id,
      chat: { id: peerId, type: chatType },
      from: {
        id: fromId,
        // VK never sends the author's name in an event; resolving it would cost
        // a `users.get` per message, which the brief rules out.
        name: undefined,
        username: undefined,
        // A community message has a negative `from_id`; the core drops bots.
        isBot: this.isCommunityId(fromId),
      },
      text,
      // A private dialog always addresses the bot; in a conversation it has to
      // be named or answered.
      addressed: chatType === 'private' || this.isAddressed(message, peerId),
      messageId,
      // The core quotes this id when it answers, which is exactly `reply_to`.
      replyToMessageId: messageId,
      attachments: this.attachmentsOf(message),
    }
  }

  /** `message_event` → `kind: 'callback'`. */
  normalizeCallback(update) {
    const raw = update?.object ?? {}
    const eventId = raw.event_id
    if (eventId === undefined || eventId === null || eventId === '') return undefined
    const peerId = idOrUndefined(raw.peer_id)
    const userId = idOrUndefined(raw.user_id)
    const conversationId = idOrUndefined(raw.conversation_message_id)
    // The core edits the message the buttons belong to, and `messages.edit`
    // wants a *message* id, while a tap only names the `conversation_message_id`
    // (and only for an in-message keyboard). The last message sent to that peer
    // is the one carrying the keyboard, so it is the better answer.
    const quoted = (peerId === undefined ? undefined : this.lastMessageByPeer.get(String(peerId))) ?? conversationId
    this.rememberCallback(eventId, { userId, peerId })
    return {
      kind: 'callback',
      id: update.event_id,
      chat: { id: peerId, type: peerChatType(peerId) },
      // The user who tapped is the only actor a callback names.
      from: { id: userId, name: undefined, username: undefined, isBot: false },
      text: '',
      addressed: true,
      messageId: quoted,
      callback: {
        id: String(eventId),
        data: decodeCallbackData(raw.payload),
        messageId: quoted,
        text: undefined,
        // VK needs both ids to answer the tap; the port has no room for them,
        // so they ride along as extra fields on the callback.
        userId,
        peerId,
        chatId: peerId,
        conversationMessageId: conversationId,
      },
    }
  }

  /** Whether an id names the community rather than a user. */
  isCommunityId(id) {
    const value = Number(id)
    return Number.isFinite(value) && value < 0
  }

  /**
   * Whether a conversation message addresses the bot.
   *
   * Three documented signals are checked: a reply whose `from_id` is the
   * community, a reply to a message this adapter sent (VK omits `from_id` on
   * some replies), and a mention of the community — `[club<id>|…]`,
   * `[public<id>|…]` or the short `@club<id>` / `@<screen_name>` form.
   *
   * @param {object} message - the message object.
   * @param {number|string} peerId - the dialog id.
   * @returns {boolean} true when the bot was addressed.
   */
  isAddressed(message, peerId) {
    const groupId = this.groupId ?? this.identity?.id
    const reply = message?.reply_message
    if (reply && typeof reply === 'object') {
      if (groupId !== undefined && Number(reply.from_id) === -Number(groupId)) return true
      if (this.isOwnMessage(reply.id)) return true
    }
    const text = firstString(message?.text, message?.message, message?.body)
    if (text === '') return false
    const names = ['club', 'public']
    for (const name of names) {
      if (groupId !== undefined && new RegExp(`\\[${name}${escapeRegExp(String(groupId))}\\|`).test(text)) return true
      if (groupId !== undefined && new RegExp(`@${name}${escapeRegExp(String(groupId))}(?![\\w])`, 'i').test(text)) return true
    }
    const screenName = this.identity?.username
    if (screenName) {
      const escaped = escapeRegExp(String(screenName))
      if (new RegExp(`\\[(?:club|public)${escaped}\\|`, 'i').test(text)) return true
      if (new RegExp(`@(?:club|public)?${escaped}(?![\\w])`, 'i').test(text)) return true
    }
    return false
  }

  /**
   * Media attached to a VK message, in the core's neutral shape.
   *
   * Each attachment is `{type, <type>: {…}}`; only the kinds the core can do
   * something with are described. A sticker carries a photo under a different
   * type and would degrade to a document, so it is skipped, and a `video`
   * without a direct file link keeps only its id.
   *
   * @param {object} message - the message object.
   * @returns {Array<object>} zero or more `{kind, url, …}` attachments.
   */
  attachmentsOf(message) {
    const raw = message?.attachments
    if (!Array.isArray(raw)) return []
    const list = []
    for (const item of raw) {
      const type = item?.type
      const body = item?.[type]
      if (!type || !body || typeof body !== 'object') continue
      if (type === 'photo') {
        const size = pickPhotoSize(body)
        const fileId = `photo${body.owner_id ?? ''}_${body.id ?? ''}`
        if (size === undefined) continue
        this.rememberAttachment(fileId, { url: size.url, name: undefined })
        list.push({ kind: 'photo', url: size.url, fileId, width: size.width, height: size.height })
        continue
      }
      if (type === 'doc') {
        const url = typeof body.url === 'string' && body.url !== '' ? body.url : undefined
        const fileId = `doc${body.owner_id ?? ''}_${body.id ?? ''}`
        if (url === undefined) continue
        const name = body.title ?? body.ext ?? undefined
        this.rememberAttachment(fileId, { url, name })
        list.push({ kind: 'document', url, fileId, name, ext: body.ext, size: body.size })
        continue
      }
      if (type === 'audio_message') {
        const url = firstString(body.link_ogg, body.link_mp3) || undefined
        const fileId = `audio_message${body.owner_id ?? ''}_${body.id ?? ''}`
        if (url === undefined) continue
        this.rememberAttachment(fileId, { url, name: 'audio_message.ogg' })
        list.push({ kind: 'voice', url, fileId, duration: body.duration })
        continue
      }
      if (type === 'audio') {
        const url = firstString(body.url) || undefined
        if (url === undefined) continue
        const name = [body.artist, body.title].filter(Boolean).join(' — ') || undefined
        const fileId = `audio${body.owner_id ?? ''}_${body.id ?? ''}`
        this.rememberAttachment(fileId, { url, name })
        list.push({ kind: 'audio', url, fileId, name, duration: body.duration })
        continue
      }
      if (type === 'video') {
        // A video object usually has no direct file URL; when it does, the file
        // is downloadable and otherwise `downloadFile` reports the failure.
        const url = videoFileUrl(body)
        const fileId = `video${body.owner_id ?? ''}_${body.id ?? ''}`
        if (url === undefined) continue
        this.rememberAttachment(fileId, { url, name: body.title })
        list.push({ kind: 'video', url, fileId, name: body.title, duration: body.duration })
      }
    }
    return list
  }

  /**
   * Send plain text, split to VK's limit.
   *
   * A keyboard is attached to the last chunk only, so the buttons sit under the
   * end of a long answer, and every chunk is a reply to the same message.
   * A private dialog gets a persistent (`inline: false`) keyboard, a
   * conversation an in-message one: only the latter carries a
   * `conversation_message_id` on a tap, and the persistent keyboard in a dialog
   * is what a user expects there.
   *
   * @param {object} request - `chatId`, `markdown`, optional `replyToMessageId`, `keyboard`.
   * @returns {Promise<{messageId?: number|string}>} the last message id.
   */
  async sendText({ chatId, markdown, replyToMessageId, keyboard }) {
    const chunks = splitVkText(markdownToVkText(markdown))
    const inline = !isPrivatePeer(chatId)
    const rendered = toVkKeyboard(keyboard, { inline })
    let last
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      const { data } = await this.client.sendMessage({
        peerId: chatId,
        message: chunk,
        randomId: this.nextRandomId(),
        replyTo: replyToMessageId,
        keyboard: isLast ? rendered : undefined,
      })
      last = data
    }
    const messageId = idOrUndefined(last)
    if (messageId !== undefined) {
      this.rememberOwnMessage(messageId, chatId)
      this.rememberLastMessage(chatId, messageId)
    }
    return { messageId }
  }

  /**
   * Отправить файл (PDF, Excel, Word, CSV) в чат VK.
   *
   * VK принимает документы только через загрузку: адрес → multipart → сохранение
   * → сообщение с вложением `doc<owner_id>_<id>`. Имя файла сохраняется в
   * `docs.save` (`title`), подпись — текст сообщения. Любой сбой шага
   * превращается в `VkError` с русским объяснением: ядро покажет пользователю
   * понятный текст, а бот продолжит работу.
   *
   * @param {object} request - `chatId`, `bytes`, `fileName`, optional `caption`, `replyToMessageId`.
   * @returns {Promise<{messageId?: number|string}>} id отправленного сообщения.
   */
  async sendDocument({ chatId, bytes, fileName, caption, replyToMessageId }) {
    if (!bytes || bytes.length === 0) {
      throw new VkError('Не удалось отправить файл: содержимое пустое', { method: 'sendDocument' })
    }
    const name = firstString(fileName).trim().slice(0, VK_DOCUMENT_TITLE_LIMIT) || 'file.bin'
    const peerId = idOrUndefined(chatId)
    if (peerId === undefined) {
      throw new VkError('Не удалось отправить файл: не указан получатель', { method: 'sendDocument' })
    }

    let uploadUrl
    try {
      const { data } = await this.client.getMessagesUploadServer({ peerId, type: 'doc' })
      uploadUrl = typeof data?.upload_url === 'string' ? data.upload_url : ''
    } catch (error) {
      throw documentError(error, `Не удалось получить адрес загрузки файла «${name}»`, 'docs.getMessagesUploadServer')
    }
    if (uploadUrl === '') {
      throw new VkError(`Не удалось получить адрес загрузки файла «${name}»: VK не вернул upload_url`, {
        method: 'docs.getMessagesUploadServer',
      })
    }

    const file = await this.uploadDocument({ uploadUrl, bytes, fileName: name })

    let saved
    try {
      const { data } = await this.client.saveDocument({ file, title: name })
      saved = data
    } catch (error) {
      throw documentError(error, `Не удалось сохранить файл «${name}»`, 'docs.save')
    }
    // API отвечает `{type: 'doc', doc: {…}}`; старые версии — массивом документов.
    const doc = Array.isArray(saved) ? saved[0] : (saved?.doc ?? saved)
    const ownerId = idOrUndefined(doc?.owner_id)
    const docId = idOrUndefined(doc?.id)
    if (ownerId === undefined || docId === undefined) {
      throw new VkError(`Не удалось сохранить файл «${name}»: VK не вернул идентификатор документа`, {
        method: 'docs.save',
      })
    }

    const body = markdownToVkText(caption).slice(0, VK_TEXT_LIMIT)
    let sent
    try {
      const { data } = await this.client.sendMessage({
        peerId,
        message: body === '' ? undefined : body,
        randomId: this.nextRandomId(),
        replyTo: replyToMessageId,
        attachment: `doc${ownerId}_${docId}`,
      })
      sent = data
    } catch (error) {
      throw documentError(error, `Не удалось отправить файл «${name}»`, 'messages.send')
    }
    const messageId = idOrUndefined(sent)
    if (messageId !== undefined) {
      this.rememberOwnMessage(messageId, chatId)
      this.rememberLastMessage(chatId, messageId)
    }
    return { messageId }
  }

  /**
   * Загрузить документ на выданный VK адрес.
   *
   * Это единственный запрос, который идёт не в `api.vk.com` и не несёт токен:
   * адрес уже содержит одноразовую подпись. Тело — `multipart/form-data` с полем
   * `file`; имя файла важно сохранить, по нему VK строит `title`.
   *
   * @param {object} request - `uploadUrl`, `bytes`, `fileName`.
   * @returns {Promise<string>} значение поля `file` для `docs.save`.
   */
  async uploadDocument({ uploadUrl, bytes, fileName }) {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), fileName)
    let response
    try {
      response = await this.fetchImpl(uploadUrl, {
        method: 'POST',
        body: form,
        signal: deadlineSignal(this.timeoutMs),
      })
    } catch (error) {
      throw documentError(error, `Не удалось загрузить файл «${fileName}»`, 'upload')
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      throw documentError(error, `Не удалось загрузить файл «${fileName}»`, 'upload')
    }
    const data = parseJson(text)
    if (!response.ok) {
      throw new VkError(`Не удалось загрузить файл «${fileName}»: HTTP ${response.status}`, {
        method: 'upload',
        status: response.status,
      })
    }
    if (data === undefined) {
      throw new VkError(`Не удалось загрузить файл «${fileName}»: VK ответил не JSON`, {
        method: 'upload',
        status: response.status,
      })
    }
    if (data?.error) {
      const code = Number(data.error.error_code)
      const description = firstString(data.error.error_msg, data.error.message, data.error) || 'неизвестная ошибка VK'
      throw new VkError(`Не удалось загрузить файл «${fileName}»: ${description}`, {
        method: 'upload',
        code: Number.isFinite(code) ? code : undefined,
        description,
        status: response.status,
      })
    }
    const file = typeof data?.file === 'string' ? data.file.trim() : ''
    if (file === '') {
      throw new VkError(`Не удалось загрузить файл «${fileName}»: VK не вернул поле file`, {
        method: 'upload',
        status: response.status,
      })
    }
    return file
  }

  /**
   * Replace the text (and optionally the keyboard) of one message.
   *
   * `messages.edit` wants a message id; the core hands back the id
   * `messages.send` returned, which is exactly that.
   *
   * @param {object} request - `chatId`, `messageId`, `markdown`, optional `keyboard`.
   * @returns {Promise<object>} the API result (`{response: 1}` unwrapped).
   */
  /**
   * Streaming is private-chat only.
   *
   * A conversation (беседа) reports a partial answer when edits do not land, and
   * VK treats its group chats far more strictly than dialogs, so there the answer
   * is sent once, complete.
   *
   * @param {object} request - `chatId`.
   * @returns {boolean} true when progressive edits are safe here.
   */
  canStream({ chatId }) {
    return isPrivatePeer(chatId)
  }

  async editText({ chatId, messageId, markdown, keyboard }) {
    const { data } = await this.client.editMessage({
      peerId: chatId,
      messageId,
      message: markdownToVkText(markdown),
      keyboard: toVkKeyboard(keyboard, { inline: !isPrivatePeer(chatId) }),
    })
    return data ?? {}
  }

  /**
   * Acknowledge a button tap.
   *
   * `messages.sendMessageEventAnswer` needs the `user_id` and `peer_id` of the
   * original event; both are remembered when the tap is normalised and are also
   * accepted in this request as a fallback. VK's only toast is
   * `show_snackbar`, and it has no modal alert, so `alert` is accepted for port
   * compatibility but has no wire effect.
   *
   * @param {object} request - `callbackId`, `text`, `alert`, optional `chatId`/`userId`.
   * @returns {Promise<void>} resolves once acknowledged.
   */
  async answerCallback({ callbackId, text, alert = false, chatId, userId }) {
    const remembered = this.pendingCallbacks.get(String(callbackId))
    const peerId = remembered?.peerId ?? idOrUndefined(chatId)
    const fromUser = remembered?.userId ?? idOrUndefined(userId) ?? (isPrivatePeer(peerId) ? peerId : undefined)
    if (peerId === undefined || fromUser === undefined) {
      this.logger?.debug('vk callback answer skipped: user_id/peer_id unknown', { callbackId, alert })
      return
    }
    const body = firstString(text).trim()
    const eventData = body === '' ? undefined : { type: 'show_snackbar', text: body.slice(0, VK_SNACKBAR_LIMIT) }
    await this.client.sendMessageEventAnswer({ eventId: callbackId, userId: fromUser, peerId, eventData })
    this.pendingCallbacks.delete(String(callbackId))
  }

  /**
   * "typing…" hint.
   *
   * The service shows it for 5–10 seconds. A failure there must never break the
   * answer, hence the swallow.
   *
   * @param {object} request - `chatId`.
   * @returns {Promise<void>} resolves whether or not the hint was accepted.
   */
  async sendTyping({ chatId }) {
    try {
      // VK rate-limits setActivity hard and a typing indicator is decoration: one
      // attempt, no retries, so the journal stays about real problems.
      await this.client.setActivity({ peerId: chatId, groupId: this.groupId ?? this.identity?.id, type: 'typing' }, { attempts: 1 })
    } catch (error) {
      this.logger?.debug('vk typing failed', { chatId, reason: error?.message })
    }
  }

  /**
   * Set a reaction on a message, best-effort.
   *
   * `messages.sendReaction` takes a **conversation** message id (`cmid`) and a
   * numeric reaction id. The core hands over the message id it saw, so the
   * conversation id is looked up from the updates that carried both. Whether a
   * community bot is allowed to react is not documented; a refusal is logged
   * and reported as success-of-nothing, exactly like the MAX and VK Teams
   * adapters' documented no-op. An emoji outside {@link VK_REACTION_IDS} is a
   * no-op too.
   *
   * @param {object} request - `chatId`, `messageId`, `emoji`.
   * @returns {Promise<object|undefined>} the API result, or undefined when skipped.
   */
  async setReaction({ chatId, messageId, emoji }) {
    const reactionId = resolveReactionId(emoji)
    if (reactionId === undefined || messageId === undefined) return undefined
    const cmid = this.conversationIds.get(String(messageId)) ?? messageId
    try {
      const { data } = await this.client.sendReaction({ peerId: chatId, cmid, reactionId })
      return data ?? {}
    } catch (error) {
      this.logger?.debug('vk reaction unavailable', { chatId, messageId, emoji, reason: error?.message })
      return undefined
    }
  }

  /**
   * Download one attachment.
   *
   * VK attachment objects carry direct, token-free URLs, so `url` wins when it
   * is given; a `fileId` alone works for an attachment this adapter has already
   * seen (the URL is remembered from the update). The declared size is checked
   * before the body is pulled down, and the body again afterwards.
   *
   * @param {object} request - `fileId` or `url`, optional `maxBytes`.
   * @returns {Promise<{bytes: Buffer, size: number, fileName?: string}>} the file.
   */
  async downloadFile({ fileId, url, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = {}) {
    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Number(maxBytes)
      : DEFAULT_MAX_DOWNLOAD_BYTES
    const known = fileId === undefined || fileId === null || fileId === ''
      ? undefined
      : this.attachmentUrls.get(String(fileId))
    const target = typeof url === 'string' && url !== '' ? url : known?.url
    if (typeof target !== 'string' || target === '') {
      throw new VkError('VK attachment has neither a download url nor a known fileId', { method: 'downloadFile' })
    }
    const response = await this.fetchImpl(target, { signal: deadlineSignal(this.timeoutMs) })
    if (!response.ok) {
      throw new VkError(`VK file download failed: HTTP ${response.status}`, {
        method: 'downloadFile',
        status: response.status,
      })
    }
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > limit) {
      throw new VkError(`file is too large (${declared} bytes, limit ${limit})`, { method: 'downloadFile' })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) {
      throw new VkError(`file is too large (${bytes.length} bytes, limit ${limit})`, { method: 'downloadFile' })
    }
    return { bytes, size: bytes.length, fileName: known?.name }
  }

  /**
   * A fresh `random_id`.
   *
   * `messages.send` requires an `int32` de-duplication key. The injected
   * `random` may return a fraction in `[0, 1)` (like `Math.random`) or an
   * integer; whatever it returns, two consecutive sends never share an id.
   */
  nextRandomId() {
    const raw = Number(this.random?.())
    const value = Number.isFinite(raw) ? raw : Math.random()
    const scaled = Math.abs(Math.floor(value >= 1 ? value : value * 2 ** 31)) % 2 ** 31
    const id = scaled === this.lastRandomId ? (scaled + 1) % 2 ** 31 : scaled
    this.lastRandomId = id
    return id
  }

  /** Remember one of our own messages so a later reply to it is recognised. */
  rememberOwnMessage(messageId, chatId) {
    if (messageId === undefined || messageId === null || messageId === '') return
    const key = String(messageId)
    this.ownMessages.delete(key)
    this.ownMessages.set(key, chatId === undefined || chatId === null ? undefined : String(chatId))
    trimMap(this.ownMessages, this.ownMessageCacheSize)
  }

  /** Whether `messageId` was sent by this adapter. */
  isOwnMessage(messageId) {
    if (messageId === undefined || messageId === null || messageId === '') return false
    return this.ownMessages.has(String(messageId))
  }

  /** Remember the newest message sent to a peer (non-inline callback fallback). */
  rememberLastMessage(chatId, messageId) {
    if (chatId === undefined || chatId === null || messageId === undefined || messageId === null) return
    const key = String(chatId)
    this.lastMessageByPeer.delete(key)
    this.lastMessageByPeer.set(key, messageId)
    trimMap(this.lastMessageByPeer, this.ownMessageCacheSize)
  }

  /** Remember `message_id → conversation_message_id` for `sendReaction`. */
  rememberConversationId(messageId, conversationId) {
    if (messageId === undefined || messageId === null || conversationId === undefined || conversationId === null) return
    const key = String(messageId)
    this.conversationIds.delete(key)
    this.conversationIds.set(key, idOrUndefined(conversationId))
    trimMap(this.conversationIds, this.ownMessageCacheSize)
  }

  /** Remember the ids a callback answer needs. */
  rememberCallback(eventId, { userId, peerId }) {
    const key = String(eventId)
    this.pendingCallbacks.delete(key)
    this.pendingCallbacks.set(key, { userId, peerId })
    trimMap(this.pendingCallbacks, this.callbackCacheSize)
  }

  /** Remember where an attachment can be downloaded from. */
  rememberAttachment(fileId, { url, name }) {
    if (typeof fileId !== 'string' || fileId === '' || typeof url !== 'string' || url === '') return
    this.attachmentUrls.delete(fileId)
    this.attachmentUrls.set(fileId, { url, name })
    trimMap(this.attachmentUrls, this.attachmentCacheSize)
  }
}

/** Evict the oldest entries of a Map until it is within `size`. */
function trimMap(map, size) {
  while (map.size > size) {
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
}

/** `emoji` → a numeric reaction id, accepting an explicit id as well. */
function resolveReactionId(emoji) {
  if (emoji === undefined || emoji === null || emoji === '') return undefined
  if (typeof emoji === 'number' && Number.isFinite(emoji)) return emoji
  const value = String(emoji).trim()
  if (/^\d+$/.test(value)) return Number(value)
  return VK_REACTION_IDS[value]
}

/**
 * Build the VK adapter.
 *
 * @param {object} options - see `VkPlatform`.
 * @returns {VkPlatform} the adapter.
 */
export const createVkPlatform = (options) => new VkPlatform(options)
