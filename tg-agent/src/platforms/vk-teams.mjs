/**
 * VK Teams adapter (Myteam / VK WorkSpace, ex-ICQ New for business).
 *
 * Everything VK Teams-specific lives here: query-parameter auth, long polling
 * with `lastEventId`, the `payload`-wrapped event union mapped onto neutral
 * updates, `inlineKeyboardMarkup` serialisation and the `parseMode: "HTML"`
 * text path. The core only sees normalised updates and neutral keyboards (see
 * `port.mjs`).
 *
 * ## Field names used by this adapter
 *
 * Verified against the OpenAPI spec the official documentation is built from
 * (`https://myteam.mail.ru/botapi/api.yaml` and its `$ref` files — the same
 * document is served at `https://teams.vk.com/botapi/api.yaml`; `host_config.json`
 * of both sites declares `"apiUrl": "myteam.mail.ru/bot/v1/"`), against the
 * three official libraries and against the live service (probe with an invalid
 * token, 2026-10-07):
 *
 * - Method list and `$ref` targets: https://myteam.mail.ru/botapi/api.yaml
 * - `token` is a **query** parameter on every method
 *   (https://myteam.mail.ru/botapi/params.json → `token`, `in: "query"`);
 *   there is no header form.
 * - `GET /self/get` → `{userId, nick, firstName, about, photo, ok}`
 *   (https://myteam.mail.ru/botapi/self/get.json, `schemas.json#bot`).
 * - `GET /events/get` → `{events: [...], ok}` with required `lastEventId` and
 *   `pollTime` (https://myteam.mail.ru/botapi/events/get.json, `params.json`).
 *   The first call passes `lastEventId=0`
 *   (https://myteam.mail.ru/botapi/lang_config_en.json → `mainPage.getEventsDesc`).
 * - Event envelope `{eventId, type, payload}`; the message fields are **nested
 *   under `payload`**, not inline (`schemas.json#eventNewMessage`). Types:
 *   `newMessage`, `editedMessage`, `deletedMessage`, `pinnedMessage`,
 *   `unpinnedMessage`, `newChatMembers`, `leftChatMembers`, `callbackQuery`.
 * - `payload`: `{msgId, chat: {chatId, type, title}, from: {userId, firstName,
 *   lastName, nick}, text, timestamp, parts[]}`; `chat.type` is `private`,
 *   `group` or `channel` (`schemas.json#chatPrivate|chatGroup|chatChannel`).
 * - A reply arrives as a **part** `{type: "reply", payload: {message: {msgId,
 *   from: {userId}, text, timestamp}}}` (`schemas.json#eventNewMessageReply`);
 *   a mention as `{type: "mention", payload: {userId, …}}`. There is no
 *   documented top-level `replyMsgId` on incoming events, although such a field
 *   is honoured here as a fallback because it was reported in the field.
 * - `callbackQuery`: `payload = {queryId, callbackData, chat, from, message}`
 *   where `message` is a plain message body (`schemas.json#eventCallbackQuery`;
 *   `bot-java` `CallbackQueryEvent.Data`).
 * - `GET /messages/sendText` → `{ok, msgId}`; parameters `chatId`, `text`,
 *   `replyMsgId`, `forwardChatId`, `forwardMsgId`, `inlineKeyboardMarkup`,
 *   `format`, `parseMode` (https://myteam.mail.ru/botapi/messages/sendText.json).
 *   The OpenAPI document marks `inlineKeyboardMarkup` as a body field, but the
 *   API is GET-only and all three official libraries send it as a **query
 *   parameter holding a JSON string**
 *   (bot-golang `client.go`: `params.Set("inlineKeyboardMarkup", string(data))`).
 * - Keyboard rows are capped at **14 rows × 8 buttons** per the tutorial:
 *   https://myteam.mail.ru/botapi/botTutorial/botTutorial.html → "Buttons in messages".
 *   Buttons are `{text, url}` or `{text, callbackData}`, plus an optional `style`
 *   (`attention` | `primary` | `base`); `url` and `callbackData` are mutually
 *   exclusive.
 * - `GET /messages/editText` → `{ok}` with `chatId`, `msgId`, `text`,
 *   `inlineKeyboardMarkup`, `parseMode`
 *   (https://myteam.mail.ru/botapi/messages/editText.json).
 * - `GET /messages/answerCallbackQuery` with `queryId` (required), `text`,
 *   `showAlert`, `url`
 *   (https://myteam.mail.ru/botapi/messages/answerCallbackQuery.json).
 * - `GET /chats/sendActions` with `chatId` and `actions` (`looking` | `typing`)
 *   — the "typing…" hint exists
 *   (https://myteam.mail.ru/botapi/chats/sendActions.json).
 * - Files: `GET /files/getInfo?fileId=…` returns `{url, filename, size, type}`
 *   with a short-lived pre-signed `url`; that is how an incoming attachment is
 *   downloaded (`downloadFile`). `GET /messages/sendFile?fileId=…` sends an
 *   already uploaded file and `POST /messages/sendFile` (multipart `file`)
 *   uploads a new one — sending is not implemented, because the port has no way
 *   to hand bytes to a platform. Note the method is `getInfo`, not
 *   `getFileInfo`, and it is a `GET`.
 * - Errors: VK Teams answers **HTTP 200 with `{ok: false, description}`** even
 *   for a rejected token (live probe: `GET /self/get?token=…` →
 *   `200 {"ok": false, "description": "Invalid token"}`), so `status` alone is
 *   not enough to classify a failure; see `isFatalError`. Some deployments and
 *   proxies do send 401/403/429/5xx, which are handled too.
 * - Rate limits: 30 messages/second to private dialogs and 1 message/second per
 *   group chat; exceeding them returns the `ratelimit` error
 *   (https://myteam.mail.ru/botapi/faq → "Restrictions").
 * - Webhooks are not supported ("Not supported yet", same FAQ), so long polling
 *   is the only transport and `stop()` has nothing to tear down.
 *
 * ## Text limit
 *
 * VK Teams does not publish a maximum message length. The documented limits are
 * 60 KB for the whole query string and 50 MB for a request body (FAQ →
 * "Working with files"/"querystring"), so 4000 characters per message — the
 * same conservative value the MAX adapter uses — is safely inside the query
 * string even after percent-encoding. Change `VK_TEAMS_TEXT_LIMIT` if support
 * ever publishes a number.
 *
 * ## Token hygiene
 *
 * The token is only ever placed in the `token` query parameter. Error messages
 * and log records are built from the method label, HTTP status and the API's
 * `description`, and every string that could embed a URL is passed through
 * `redactToken`, so the secret cannot leak into logs or into a thrown error.
 */
import { markdownToTelegramHtml, splitForTelegram } from '../format.mjs'
import { numericId } from './port.mjs'

/**
 * API root. The documentation at both `myteam.mail.ru/botapi/` and
 * `teams.vk.com/botapi/` is generated from the same spec, whose
 * `host_config.json` names `myteam.mail.ru/bot/v1/` as the API URL;
 * `teams.vk.com/botapi` is the documentation site, not an endpoint. The
 * official libraries still default to the legacy `https://api.icq.net/bot/v1`.
 */
export const DEFAULT_API_BASE = 'https://myteam.mail.ru/bot/v1'
/** Conservative per-message limit; VK Teams does not publish one. */
export const VK_TEAMS_TEXT_LIMIT = 4000
/** Documented keyboard limits: at most 14 rows of at most 8 buttons. */
export const VK_TEAMS_KEYBOARD_ROWS = 14
export const VK_TEAMS_KEYBOARD_BUTTONS = 8
/** Defensive caps for callback payloads and URLs (undocumented by VK Teams). */
export const VK_TEAMS_CALLBACK_DATA_LIMIT = 1024
export const VK_TEAMS_URL_LIMIT = 2048
/** Server-side hold time for one long poll, in seconds. */
export const DEFAULT_POLL_TIMEOUT_SEC = 30
/** How many of our own `msgId`s are remembered for reply detection. */
export const OWN_MESSAGE_CACHE_SIZE = 200
/** Download cap, matching the other adapters' default. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 20_000_000

/**
 * `parts[].type === 'file'` sub-type → the core's attachment kind
 * (`schemas.json#eventNewMessageFile`: `image` | `audio` | `video`).
 */
const FILE_KINDS = { image: 'photo', audio: 'audio', video: 'video' }

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const backoff = (attempt) => Math.min(500 * 2 ** (attempt - 1), 10000)

/**
 * The lines VK Teams uses when a token is rejected or when a request is rate
 * limited. The service reports both **in-band** (`HTTP 200 {ok: false}`), so a
 * status code alone cannot classify them.
 */
const AUTH_PATTERN = /invalid token|token (is )?(invalid|expired)|unauthorized|forbidden|access denied|not authorized/i
const RATE_LIMIT_PATTERN = /ratelimit|rate limit|too many requests|flood control/i

/** Error carrying the VK Teams operation, HTTP status, `code` and `description`. */
export class VkTeamsError extends Error {
  /**
   * @param {string} message - readable description (never contains the token).
   * @param {object} [details] - error details.
   * @param {string} [details.method] - operation, for example `GET /messages/sendText`.
   * @param {number} [details.status] - HTTP status, when there was a response.
   * @param {string} [details.code] - API error code, when the body carries one.
   * @param {string} [details.description] - the API `description` field.
   * @param {boolean} [details.fatal] - true when retrying can never help.
   * @param {Error} [details.cause] - original error.
   */
  constructor(message, { method, status, code, description, fatal = false, cause } = {}) {
    super(message, { cause })
    this.name = 'VkTeamsError'
    this.method = method
    this.status = status
    this.code = code
    this.description = description
    this.fatal = fatal
  }
}

/** Remove the token from any string that may embed it (URLs, causes, logs). */
export function redactToken(text, token) {
  const value = String(text ?? '')
  if (token === undefined || token === null || token === '') return value
  return value.split(String(token)).join('***')
}

/**
 * A copy of `error` whose message no longer contains the token.
 *
 * The token travels in the URL, so a network error thrown by `fetch` may quote
 * it (`request to https://…?token=… failed`). The raw error is still useful, so
 * its name and syscall fields are kept while the message — and any nested cause,
 * which `util.inspect` prints — is rebuilt without the secret.
 */
function redactError(error, token) {
  if (!error || typeof error !== 'object' || typeof error.message !== 'string') return error
  const message = redactToken(error.message, token)
  const nested = error.cause ? redactError(error.cause, token) : undefined
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

/** `Retry-After` in milliseconds, when the response carries one. */
function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after')
  // `Headers.get` returns null for an absent header and `Number(null)` is 0,
  // which would turn "no header" into "retry immediately".
  if (value === undefined || value === null || value === '') return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : undefined
}

/** `numericId` that leaves missing ids missing instead of stringifying them. */
const idOrUndefined = (value) =>
  (value === undefined || value === null || value === '' ? undefined : numericId(value))

/**
 * An id that must stay a string.
 *
 * VK Teams `msgId`s are int64-like ("57883346846815032") and are documented as
 * strings; `numericId` would turn a small one into a number and lose the type
 * consistency the core relies on, so message ids are kept verbatim.
 */
const stringOrUndefined = (value) =>
  (value === undefined || value === null || value === '' ? undefined : String(value))

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stripTags = (html) => String(html ?? '').replace(/<[^>]+>/g, '')
/** Turn our own HTML entities back into characters for a plain-text resend. */
const unescapeHtml = (text) => String(text ?? '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')

/**
 * VK Teams Bot API client: GET requests, query-parameter auth, `ok` envelope.
 *
 * Every call is a plain fetch, so the client runs against a local stub in tests
 * exactly as it runs against `myteam.mail.ru` in production.
 */
export class VkTeamsClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.token] - bot token; defaults to `VK_TEAMS_TOKEN`.
   * @param {string} [options.apiBase] - API root; defaults to `VK_TEAMS_API_BASE`.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   */
  constructor({
    token,
    apiBase = process.env.VK_TEAMS_API_BASE ?? process.env.MYTEAM_API_BASE ?? DEFAULT_API_BASE,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60000,
    logger,
    maxAttempts = 4,
    sleep = defaultSleep,
  } = {}) {
    this.token = token ?? process.env.VK_TEAMS_TOKEN ?? process.env.MYTEAM_TOKEN
    this.apiBase = String(apiBase).replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.maxAttempts = maxAttempts
    this.sleep = sleep
  }

  /**
   * Build a request URL.
   *
   * VK Teams authenticates with a query parameter — unlike MAX and Telegram —
   * so the token is deliberately added here and nowhere else. Because it is part
   * of the URL, every error and log line that could echo the URL goes through
   * `redactToken`.
   */
  url(path, query) {
    const url = new URL(`${this.apiBase}${path}`)
    url.searchParams.set('token', this.token)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * Perform one API request and unwrap the `{ok, …}` envelope.
   *
   * @param {string} operation - label used in errors, for example `GET /messages/sendText`.
   * @param {object} request - `path`, `query`, `signal`, `timeoutMs`.
   * @returns {Promise<{data: any, text: string, status: number}>} parsed body and raw text.
   */
  async request(operation, { path, query, signal, timeoutMs } = {}) {
    if (!this.token) {
      throw new VkTeamsError(
        `VK Teams ${operation} failed: no bot token (pass token or set VK_TEAMS_TOKEN)`,
        { method: operation },
      )
    }
    const url = this.url(path, query)
    const deadline = timeoutMs ?? this.timeoutMs
    let lastError
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const timeoutSignal = AbortSignal.timeout(deadline)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: requestSignal,
        })
        const text = await response.text()
        const data = parseJson(text)
        // `ok: false` arrives with HTTP 200; a non-JSON body is a proxy error
        // page, never a valid API answer.
        if (response.ok && data !== undefined && data?.ok !== false) {
          return { data, text, status: response.status }
        }

        const code = data?.code === undefined ? undefined : String(data.code)
        // A non-JSON body is a proxy error page: its text is the only clue.
        const rawDescription = data?.description ?? data?.error ?? (data === undefined ? text.slice(0, 200) : '')
        const description = String(rawDescription ?? response.statusText ?? '').trim() || undefined
        const error = new VkTeamsError(
          redactToken(
            `VK Teams ${operation} failed:${code ? ` [${code}]` : ''} ${description ?? 'unknown error'}`,
            this.token,
          ),
          {
            method: operation,
            status: response.status,
            code,
            description: description === undefined ? undefined : redactToken(description, this.token),
            fatal: response.status === 401 || response.status === 403 || AUTH_PATTERN.test(description ?? ''),
          },
        )
        if ((response.status === 429 || RATE_LIMIT_PATTERN.test(description ?? '')) && attempt < this.maxAttempts) {
          const waitMs = retryAfterMs(response.headers) ?? backoff(attempt)
          this.logger?.warn('vk teams rate limited', { method: operation, waitMs, attempt })
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
        if (error instanceof VkTeamsError) throw error
        if (signal?.aborted) throw error
        lastError = error
        if (attempt >= this.maxAttempts) break
        this.logger?.warn('vk teams request failed, retrying', {
          method: operation,
          attempt,
          reason: redactToken(error?.message, this.token),
        })
        await this.sleep(backoff(attempt))
      }
    }
    throw new VkTeamsError(
      redactToken(`VK Teams ${operation} failed after ${this.maxAttempts} attempts: ${lastError?.message}`, this.token),
      { method: operation, cause: redactError(lastError, this.token) },
    )
  }

  /** Bot identity; also validates the token at startup. */
  getSelf(options) {
    return this.request('GET /self/get', { path: '/self/get', ...options })
  }

  /**
   * Long polling.
   *
   * `lastEventId` is the highest event id already handled (the first call sends
   * 0) and `pollTime` the server-side hold time in seconds; the request budget
   * is kept above the hold time so the client does not abort a healthy poll.
   */
  getEvents({ lastEventId = 0, pollTime = DEFAULT_POLL_TIMEOUT_SEC }, options = {}) {
    return this.request('GET /events/get', {
      path: '/events/get',
      query: { lastEventId, pollTime },
      timeoutMs: (Number(pollTime) + 20) * 1000,
      ...options,
    })
  }

  /** Send one text message; `inlineKeyboardMarkup` is a JSON string in the query. */
  sendText({ chatId, text, parseMode, replyToMessageId, inlineKeyboardMarkup }, options) {
    return this.request('GET /messages/sendText', {
      path: '/messages/sendText',
      query: {
        chatId,
        text,
        parseMode,
        replyMsgId: replyToMessageId,
        inlineKeyboardMarkup: inlineKeyboardMarkup === undefined ? undefined : JSON.stringify(inlineKeyboardMarkup),
      },
      ...options,
    })
  }

  /** Rewrite the text (and optionally the keyboard) of one message. */
  editText({ chatId, msgId, text, parseMode, inlineKeyboardMarkup }, options) {
    return this.request('GET /messages/editText', {
      path: '/messages/editText',
      query: {
        chatId,
        msgId,
        text,
        parseMode,
        inlineKeyboardMarkup: inlineKeyboardMarkup === undefined ? undefined : JSON.stringify(inlineKeyboardMarkup),
      },
      ...options,
    })
  }

  /** Acknowledge a button tap; `showAlert` turns the toast into a modal alert. */
  answerCallbackQuery({ queryId, text, showAlert }, options) {
    return this.request('GET /messages/answerCallbackQuery', {
      path: '/messages/answerCallbackQuery',
      query: { queryId, text, showAlert: showAlert === undefined ? undefined : Boolean(showAlert) },
      ...options,
    })
  }

  /**
   * Chat action (`looking` | `typing`).
   *
   * The API expects `actions` to be re-sent on every change and at least every
   * 10 seconds (documented for `sendActions`), and an empty value to clear it.
   */
  sendActions({ chatId, actions }, options) {
    return this.request('GET /chats/sendActions', {
      path: '/chats/sendActions',
      query: { chatId, actions },
      ...options,
    })
  }

  /**
   * Metadata for one uploaded file: `{url, filename, size, type}`.
   *
   * The `url` is a short-lived pre-signed link that needs no token, which is how
   * a bot downloads an incoming attachment
   * (https://myteam.mail.ru/botapi/files/getInfo.json).
   */
  getFileInfo({ fileId }, options) {
    return this.request('GET /files/getInfo', {
      path: '/files/getInfo',
      query: { fileId },
      ...options,
    })
  }
}

/**
 * Convert the core's markdown into VK Teams HTML.
 *
 * VK Teams documents exactly the tags `format.mjs` emits (`b`/`strong`,
 * `i`/`em`, `s`/`strike`, `a href`, `code`, `pre>code`) and only requires
 * `&`, `<` and `>` to be escaped, which the converter does before adding its own
 * tags — a malformed construct therefore degrades to literal text instead of
 * breaking the whole message. MarkdownV2 was rejected as the parse mode: it
 * needs every special character escaped correctly, and one miss voids the send.
 *
 * @param {string} markdown - core markdown.
 * @returns {string} HTML, or `''` for an empty input.
 */
export const markdownToVkTeamsHtml = (markdown) => markdownToTelegramHtml(markdown)

/**
 * Split HTML into chunks of at most `limit` characters.
 *
 * The splitter from `format.mjs` closes and reopens the tags it knows
 * (`b`, `i`, `s`, `code`, `pre`, `a`) across chunk boundaries and never cuts a
 * surrogate pair, which is exactly the guarantee the VK Teams HTML parser
 * needs.
 *
 * @param {string} html - output of {@link markdownToVkTeamsHtml}.
 * @param {number} [limit] - VK Teams per-message limit.
 * @returns {string[]} one or more non-empty chunks.
 */
export const splitVkTeamsText = (html, limit = VK_TEAMS_TEXT_LIMIT) => splitForTelegram(html, limit)

/**
 * Map the neutral keyboard onto `inlineKeyboardMarkup`.
 *
 * Rows and buttons beyond VK Teams' documented 14 × 8 are dropped rather than
 * failing the send; buttons without text, or with neither `url` nor `data`,
 * cannot be rendered at all. `url` and `callbackData` are mutually exclusive
 * on the wire, so `url` wins when both are present (as in the other adapters).
 *
 * @param {{rows?: Array<Array<object>>}} [keyboard] - neutral keyboard.
 * @returns {object[][]|undefined} the API's array-of-rows, or undefined when empty.
 */
export function toInlineKeyboardMarkup(keyboard) {
  if (!keyboard?.rows?.length) return undefined
  const rows = keyboard.rows
    .slice(0, VK_TEAMS_KEYBOARD_ROWS)
    .map((row) => (row ?? []).map(toButton).filter(Boolean).slice(0, VK_TEAMS_KEYBOARD_BUTTONS))
    .filter((row) => row.length > 0)
  return rows.length > 0 ? rows : undefined
}

/** One neutral button in VK Teams' wire shape. */
function toButton(button) {
  if (!button) return undefined
  const text = String(button.text ?? '')
  if (text === '') return undefined
  if (button.url) return { text, url: String(button.url).slice(0, VK_TEAMS_URL_LIMIT) }
  return { text, callbackData: String(button.data ?? '').slice(0, VK_TEAMS_CALLBACK_DATA_LIMIT) }
}

/**
 * The next polling cursor: the highest `eventId` in the batch.
 *
 * The service replaces `lastEventId` with whatever the last request carried, so
 * the cursor must never move backwards; a batch without usable ids keeps the
 * previous cursor.
 *
 * @param {object[]} events - raw `/events/get` events.
 * @param {number|string|undefined} cursor - the cursor the batch was fetched with.
 * @returns {number|string|undefined} the cursor for the next poll.
 */
export function nextCursor(events, cursor) {
  let highest
  for (const event of events ?? []) {
    const value = Number(event?.eventId)
    if (!Number.isSafeInteger(value)) continue
    if (highest === undefined || value > highest) highest = value
  }
  if (highest === undefined) return cursor
  const previous = Number(cursor)
  return Number.isSafeInteger(previous) && previous > highest ? previous : highest
}

/**
 * The VK Teams adapter.
 *
 * @see the port contract in `port.mjs` for the neutral shapes.
 */
export class VkTeamsPlatform {
  /**
   * @param {object} options - adapter options.
   * @param {string} [options.token] - bot token; defaults to `VK_TEAMS_TOKEN`.
   * @param {string} [options.apiBase] - API root; defaults to `VK_TEAMS_API_BASE`.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {number} [options.ownMessageCacheSize] - reply-detection cache size.
   * @param {VkTeamsClient} [options.client] - pre-built client (tests).
   */
  constructor({
    token,
    apiBase,
    timeoutMs,
    logger,
    fetchImpl,
    sleep = defaultSleep,
    maxAttempts,
    ownMessageCacheSize = OWN_MESSAGE_CACHE_SIZE,
    client,
  } = {}) {
    this.name = 'vk-teams'
    // Short platform marker: it names the adapter and can prefix shared keys.
    this.namespace = 'vk'
    this.logger = logger
    this.client = client ?? new VkTeamsClient({ token, apiBase, timeoutMs, logger, fetchImpl, maxAttempts, sleep })
    // The client owns the request budget; the adapter needs one too, for the
    // direct download of a pre-signed file url.
    this.timeoutMs = timeoutMs ?? 60000
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.identity = undefined
    this.ownMessageCacheSize = ownMessageCacheSize
    /**
     * `msgId` → chat id for the messages this adapter sent.
     *
     * VK Teams does not mark a reply to the bot in any other reliable way when
     * the reply part carries no `from.userId`, so our own sends are remembered
     * to answer "is this a reply to me?". A Map keeps insertion order, which
     * makes evicting the oldest entry trivial.
     */
    this.ownMessages = new Map()
  }

  /**
   * Resolve the bot identity.
   *
   * There is no webhook to drop: VK Teams does not support webhooks yet, so
   * long polling is the only transport.
   *
   * @returns {Promise<VkTeamsPlatform>} this adapter.
   */
  async start() {
    const { data } = await this.client.getSelf()
    this.identity = {
      id: idOrUndefined(data?.userId),
      username: data?.nick ?? undefined,
      title: data?.firstName ?? data?.nick ?? undefined,
    }
    return this
  }

  /** Long polling needs no unsubscription; the method exists for the port. */
  async stop() {}

  /**
   * A rejected token is not worth retrying.
   *
   * VK Teams reports a bad token as `HTTP 200 {ok: false, description: "Invalid
   * token"}`, so the in-band `fatal` flag is checked alongside 401/403.
   */
  isFatalError(error) {
    return error instanceof VkTeamsError && Boolean(error.fatal || error.status === 401 || error.status === 403)
  }

  /**
   * Long-poll and normalise.
   *
   * @param {object} request - `cursor` is the last handled `eventId`, `timeoutSec` the hold time.
   * @returns {Promise<{updates: object[], cursor: number|string|undefined}>} updates and the new cursor.
   */
  async getUpdates({ cursor, timeoutSec = DEFAULT_POLL_TIMEOUT_SEC, signal } = {}) {
    const pollTime = Number.isFinite(Number(timeoutSec)) ? Number(timeoutSec) : DEFAULT_POLL_TIMEOUT_SEC
    // The first call must send 0: `lastEventId` is a required parameter.
    const { data } = await this.client.getEvents({ lastEventId: cursor ?? 0, pollTime })
    const events = data?.events ?? []
    const updates = []
    for (const event of events) {
      const normalised = this.normalize(event)
      if (normalised) updates.push(normalised)
    }
    return { updates, cursor: nextCursor(events, cursor) }
  }

  /**
   * Turn one VK Teams event into the neutral shape.
   *
   * `editedMessage` is handled as a regular message, like the Telegram and MAX
   * adapters handle their edit events: the core is stateless about message
   * versions and simply sees the new text. Everything else (`deletedMessage`,
   * `pinnedMessage`, `newChatMembers`, …) returns `undefined` and is dropped by
   * `getUpdates`.
   *
   * @param {object} event - one `{eventId, type, payload}` event.
   * @returns {object|undefined} the neutral update, or undefined when ignored.
   */
  normalize(event) {
    switch (event?.type) {
      case 'newMessage':
      case 'editedMessage':
        return this.normalizeMessage(event)
      case 'callbackQuery':
        return this.normalizeCallback(event)
      default:
        return undefined
    }
  }

  /** `newMessage` / `editedMessage` → `kind: 'message'`. */
  normalizeMessage(event) {
    const payload = event?.payload
    if (!payload) return undefined
    const chatType = neutralChatType(payload.chat?.type)
    const chatId = idOrUndefined(payload.chat?.chatId)
    const peerId = idOrUndefined(payload.from?.userId)
    const messageId = stringOrUndefined(payload.msgId)
    return {
      kind: 'message',
      id: event.eventId,
      chat: { id: chatId, type: chatType },
      from: {
        id: peerId,
        name: displayName(payload.from),
        username: payload.from?.nick ?? undefined,
        isBot: Boolean(payload.from?.isBot),
      },
      text: String(payload.text ?? '').trim(),
      // Files, voice notes and stickers arrive as `parts`; only those the core
      // can download are described.
      attachments: this.attachmentsOf(payload),
      // A private chat always addresses the bot; in a group it has to be named
      // or answered. The core gets this as a plain boolean.
      addressed: chatType === 'private' || this.isAddressed(payload),
      // The current message's `msgId`: the core needs it for reactions and to
      // quote the message in a reply.
      messageId,
      replyToMessageId: messageId,
    }
  }

  /** `callbackQuery` → `kind: 'callback'`. */
  normalizeCallback(event) {
    const payload = event?.payload
    const queryId = payload?.queryId
    if (queryId === undefined || queryId === null || queryId === '') return undefined
    // `message` is the keyboard's message; it can be absent when that message is
    // already gone, and the tap can still be acknowledged by `queryId` alone.
    const message = payload?.message
    const chatType = neutralChatType(payload?.chat?.type ?? message?.chat?.type)
    const chatId = idOrUndefined(payload?.chat?.chatId) ?? idOrUndefined(message?.chat?.chatId)
    const peerId = idOrUndefined(payload?.from?.userId) ?? idOrUndefined(message?.from?.userId)
    const from = payload?.from ?? message?.from
    return {
      kind: 'callback',
      id: event.eventId,
      // The user who tapped is the only chat we can name when the message is gone.
      chat: { id: chatId ?? peerId, type: chatId === undefined ? 'private' : chatType },
      from: {
        id: peerId,
        name: displayName(from),
        username: from?.nick ?? undefined,
        isBot: Boolean(from?.isBot),
      },
      text: '',
      addressed: true,
      callback: {
        id: String(queryId),
        data: String(payload?.callbackData ?? ''),
        messageId: stringOrUndefined(message?.msgId),
        text: String(message?.text ?? ''),
      },
    }
  }

  /**
   * Whether a group message addresses the bot.
   *
   * Three documented signals are checked, in order of reliability:
   * a `reply` part whose quoted `from.userId` is the bot, a `reply` part that
   * quotes a `msgId` this adapter sent (see `ownMessages`), and a `mention`
   * part naming the bot. For updates without parts the `@nick` text and the
   * `@[userId]` mention form are checked as a fallback. A top-level
   * `payload.replyMsgId` is honoured too, although the OpenAPI event schema does
   * not list it.
   *
   * @param {object} payload - the event payload.
   * @returns {boolean} true when the bot was addressed.
   */
  isAddressed(payload) {
    const botId = this.identity?.id
    const username = this.identity?.username
    const parts = payload?.parts ?? []
    for (const part of parts) {
      if (part?.type === 'reply') {
        const quoted = part.payload?.message
        if (botId !== undefined && quoted?.from?.userId !== undefined
          && String(quoted.from.userId) === String(botId)) return true
        if (quoted?.msgId !== undefined && this.isOwnMessage(quoted.msgId)) return true
      }
      if (part?.type === 'mention') {
        if (botId !== undefined && part.payload?.userId !== undefined
          && String(part.payload.userId) === String(botId)) return true
        if (username && String(part.payload?.nick ?? '').toLowerCase() === String(username).toLowerCase()) return true
      }
    }
    if (payload?.replyMsgId !== undefined && this.isOwnMessage(payload.replyMsgId)) return true
    const text = String(payload?.text ?? '')
    if (botId !== undefined && text.includes(`@[${botId}]`)) return true
    if (username) {
      const pattern = new RegExp(`(^|[^\\w@])@${escapeRegExp(username)}(?![\\w@])`, 'i')
      if (pattern.test(text)) return true
    }
    return false
  }

  /**
   * Send markdown, split to the VK Teams limit.
   *
   * The keyboard is attached to the last chunk only, so the buttons sit under
   * the end of a long answer, and every chunk is a reply to the same message
   * (mirroring the Telegram and MAX adapters).
   *
   * @param {object} request - `chatId`, `markdown`, optional `replyToMessageId`, `keyboard`.
   * @returns {Promise<{messageId?: string|number}>} the last message id (`msgId`).
   */
  async sendText({ chatId, markdown, replyToMessageId, keyboard }) {
    const chunks = splitVkTeamsText(markdownToVkTeamsHtml(markdown))
    const inlineKeyboardMarkup = toInlineKeyboardMarkup(keyboard)
    let last
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      last = await this.sendChunk({
        chatId,
        html: chunk,
        replyToMessageId,
        inlineKeyboardMarkup: isLast ? inlineKeyboardMarkup : undefined,
      })
    }
    const messageId = stringOrUndefined(last?.msgId)
    if (messageId !== undefined) this.rememberOwnMessage(messageId, chatId)
    return { messageId }
  }

  /**
   * Send one chunk as HTML, falling back to plain text when VK Teams rejects
   * the markup with 400 (the Telegram adapter does the same for its own HTML).
   */
  async sendChunk({ chatId, html, replyToMessageId, inlineKeyboardMarkup }) {
    try {
      const { data } = await this.client.sendText({
        chatId,
        text: html,
        parseMode: 'HTML',
        replyToMessageId,
        inlineKeyboardMarkup,
      })
      return data
    } catch (error) {
      if (!(error instanceof VkTeamsError) || error.status !== 400) throw error
      this.logger?.warn('vk teams rejected HTML, sending plain text', { chatId, description: error.description })
      // The chunk is HTML, so entities must be turned back into characters:
      // sending `&lt;` with no parse mode would show the entity itself.
      const { data } = await this.client.sendText({
        chatId,
        text: unescapeHtml(stripTags(html)),
        replyToMessageId,
        inlineKeyboardMarkup,
      })
      return data
    }
  }

  /**
   * Replace the text (and optionally the keyboard) of one message.
   *
   * A keyboard is only sent when one is given; whether VK Teams keeps or drops
   * the previous markup when the field is absent is not documented, and the core
   * uses the edit to report the outcome of a tap.
   *
   * @param {object} request - `chatId`, `messageId`, `markdown`, optional `keyboard`.
   * @returns {Promise<object>} the API result (`{ok: true}`).
   */
  async editText({ chatId, messageId, markdown, keyboard }) {
    const { data } = await this.client.editText({
      chatId,
      msgId: messageId,
      text: markdownToVkTeamsHtml(markdown),
      parseMode: 'HTML',
      inlineKeyboardMarkup: toInlineKeyboardMarkup(keyboard),
    })
    return data ?? {}
  }

  /**
   * Acknowledge a button tap.
   *
   * `showAlert` is a real VK Teams parameter: without it the text is a toast,
   * with it a modal alert.
   *
   * @param {object} request - `callbackId`, `text`, `alert`.
   * @returns {Promise<void>} resolves once acknowledged.
   */
  async answerCallback({ callbackId, text, alert = false }) {
    await this.client.answerCallbackQuery({ queryId: callbackId, text, showAlert: alert })
  }

  /**
   * "typing…" hint.
   *
   * `GET /chats/sendActions` is documented ("You must call this method every
   * time you change the current actions"), but a failure there must never break
   * the answer, hence the swallow.
   *
   * @param {object} request - `chatId`.
   * @returns {Promise<void>} resolves whether or not the hint was accepted.
   */
  async sendTyping({ chatId }) {
    try {
      await this.client.sendActions({ chatId, actions: 'typing' })
    } catch (error) {
      this.logger?.debug('vk teams typing failed', { chatId, reason: error?.message })
    }
  }

  /**
   * VK Teams has no reaction method in its public API, so the port method is a
   * documented no-op (the same choice the MAX adapter makes).
   *
   * @returns {Promise<undefined>} always undefined.
   */
  async setReaction() {
    return undefined
  }

  /**
   * Media attached to a VK Teams message, in the core's neutral shape.
   *
   * Attachments arrive as `parts` of type `file` (`payload.type` is `image`,
   * `audio` or `video`) and `voice`. Stickers are skipped: they carry only a
   * `fileId` and would degrade to an unreadable document. The file name and mime
   * type are not part of the event and are filled in by `downloadFile` through
   * `/files/getInfo`.
   *
   * @param {object} payload - the event payload.
   * @returns {Array<object>} zero or more `{kind, fileId, …}` attachments.
   */
  attachmentsOf(payload) {
    const list = []
    for (const part of payload?.parts ?? []) {
      const fileId = part?.payload?.fileId
      if (typeof fileId !== 'string' || fileId === '') continue
      if (part?.type === 'file') {
        list.push({
          kind: FILE_KINDS[part.payload?.type] ?? 'document',
          fileId,
          caption: part.payload?.caption,
        })
        continue
      }
      if (part?.type === 'voice') {
        list.push({ kind: 'voice', fileId, duration: part.payload?.duration })
      }
    }
    return list
  }

  /**
   * Download one attachment.
   *
   * `/files/getInfo` turns a `fileId` into a short-lived pre-signed URL (no
   * token needed), which is then fetched directly; the declared size is checked
   * before the body is pulled down.
   *
   * @param {object} request - `fileId` or `url`, optional `maxBytes`.
   * @returns {Promise<{bytes: Buffer, size: number, fileName?: string}>} the file.
   */
  async downloadFile({ fileId, url, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES }) {
    let target = typeof url === 'string' && url !== '' ? url : undefined
    let info
    if (target === undefined) {
      if (typeof fileId !== 'string' || fileId === '') {
        throw new VkTeamsError('VK Teams attachment has neither fileId nor url', { method: 'downloadFile' })
      }
      const { data } = await this.client.getFileInfo({ fileId })
      if (Number(data?.size) > maxBytes) {
        throw new VkTeamsError(`file is too large (${data.size} bytes, limit ${maxBytes})`, { method: 'downloadFile' })
      }
      target = data?.url
      info = data
    }
    if (typeof target !== 'string' || target === '') {
      throw new VkTeamsError('VK Teams getFileInfo returned no url', { method: 'downloadFile' })
    }
    const response = await this.fetchImpl(target, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) {
      throw new VkTeamsError(`VK Teams file download failed: HTTP ${response.status}`, {
        method: 'downloadFile',
        status: response.status,
      })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) {
      throw new VkTeamsError(`file is too large (${bytes.length} bytes, limit ${maxBytes})`, { method: 'downloadFile' })
    }
    // `getInfo.type` is a coarse kind ("image"), not a mime type, so it is not
    // reported as one.
    return { bytes, size: bytes.length, fileName: info?.filename }
  }

  /**
   * Remember one of our own messages so a later reply to it can be recognised.
   *
   * The cache is bounded: re-inserting refreshes recency and the oldest entry is
   * evicted once the limit is reached.
   */
  rememberOwnMessage(messageId, chatId) {
    if (messageId === undefined || messageId === null || messageId === '') return
    const key = String(messageId)
    this.ownMessages.delete(key)
    this.ownMessages.set(key, chatId === undefined || chatId === null ? undefined : String(chatId))
    while (this.ownMessages.size > this.ownMessageCacheSize) {
      const oldest = this.ownMessages.keys().next().value
      this.ownMessages.delete(oldest)
    }
  }

  /** Whether `messageId` was sent by this adapter. */
  isOwnMessage(messageId) {
    if (messageId === undefined || messageId === null || messageId === '') return false
    return this.ownMessages.has(String(messageId))
  }
}

/**
 * `chat.type` → the port's chat type.
 *
 * VK Teams documents a third value, `channel`; it is folded into `group` here
 * because the core only distinguishes a private chat from a non-private one and
 * the port's `channel` state carries no behaviour of its own in this adapter.
 */
function neutralChatType(chatType) {
  return chatType === 'private' ? 'private' : 'group'
}

/** `first_name` + `last_name`, falling back to the nick. */
function displayName(user) {
  if (!user) return undefined
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full !== '' ? full : (user.nick ?? undefined)
}

/**
 * Build the VK Teams adapter.
 *
 * @param {object} options - see `VkTeamsPlatform`.
 * @returns {VkTeamsPlatform} the adapter.
 */
export const createVkTeamsPlatform = (options) => new VkTeamsPlatform(options)
