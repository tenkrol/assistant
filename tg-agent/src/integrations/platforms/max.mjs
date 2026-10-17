/**
 * MAX (max.ru) adapter: the MAX Bot API behind the platform port.
 *
 * Everything MAX-specific lives here: long polling with `marker`, the
 * `update_type` union mapped onto neutral updates, `format: markdown`
 * sanitation, `inline_keyboard` attachments and the two-messages-per-second
 * limit. The core only ever sees normalised updates and neutral keyboards
 * (see `port.mjs`).
 *
 * ## Field names used by this adapter
 *
 * Verified against the API reference and the official OpenAPI schema
 * (https://github.com/max-messenger/api-schema, `schema.yaml`):
 *
 * - `Update` (`update_type`, `timestamp`) and its variants — `message` for
 *   `message_created` / `message_edited`; `callback` + nullable `message` for
 *   `message_callback`: https://dev.max.ru/docs-api/objects/Update
 * - `Message` (`sender`, `recipient`, `timestamp`, `link`, `body`), `Recipient`
 *   (`chat_id`, `chat_type`, `user_id`), `MessageBody` (`mid`, `seq`, `text`,
 *   `attachments`, `markup`), `LinkedMessage` (`type`, `sender`, `chat_id`,
 *   `message`): https://dev.max.ru/docs-api/objects/Message
 * - `User` (`user_id`, `first_name`, `last_name`, `username`, `is_bot`) —
 *   `name` is deprecated but still honoured as a fallback for bots:
 *   https://dev.max.ru/docs-api/objects/User
 * - `Callback` (`callback_id`, `payload`, `user`, `timestamp`) and
 *   `CallbackAnswer` (`notification`, `message`):
 *   https://dev.max.ru/docs-api/methods/POST/answers
 * - `BotInfo` (`user_id`, `first_name`, `username`):
 *   https://dev.max.ru/docs-api/objects/BotInfo
 * - `GET /updates` (`limit`, `timeout`, `marker`, `types` → `{updates, marker}`):
 *   https://dev.max.ru/docs-api/methods/GET/updates
 * - `POST /messages` (`user_id` | `chat_id`, `disable_link_preview` as *query*
 *   parameters; `text`, `format`, `notify`, `attachments`, `link` in the body):
 *   https://dev.max.ru/docs-api/methods/POST/messages
 * - `PUT /messages?message_id=` (body `NewMessageBody`, result
 *   `{success, message}`): https://dev.max.ru/docs-api/methods/PUT/messages
 * - `POST /answers?callback_id=` (body `CallbackAnswer`):
 *   https://dev.max.ru/docs-api/methods/POST/answers
 * - `POST /chats/{chatId}/actions` (`action: "typing_on"`):
 *   https://dev.max.ru/docs-api/methods/POST/chats/-chatId-/actions
 * - Inline keyboard (`attachments[].type = "inline_keyboard"`,
 *   `payload.buttons`, button types `callback` | `link`, 30 rows × 7 buttons,
 *   3 for `link`):
 *   https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard
 * - Markdown subset:
 *   https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting
 *
 * ## Long polling is not a production transport
 *
 * MAX states plainly that `GET /updates` "ограничено по скорости и сроку
 * хранения событий — этот способ не подходит для production-окружения" and
 * recommends a webhook (`POST /subscriptions`) at every stage; long polling
 * also stops working while a webhook subscription is active. It is implemented
 * here because it needs no public HTTPS endpoint, which is what the current
 * deployment has. Moving to production means adding a webhook entry point that
 * feeds the same `normalize()`; nothing else in this file changes.
 *
 * ## TLS
 *
 * The `*.max.ru` certificate chains to the "Russian Trusted Sub CA" root of the
 * Ministry of Digital Development (Минцифры). Hosts without that root reject
 * every request with a certificate error, so such a failure is reported as a
 * single readable `MaxError` (no retries) whose text names the root certificate
 * and `NODE_EXTRA_CA_CERTS`.
 */
import { numericId } from './port.mjs'
import { ConnectionError, deadlineSignal } from '../connection.mjs'

/** Recommended API root; `platform-api.max.ru` and `botapi.max.ru` are stale. */
export const DEFAULT_API_BASE = 'https://platform-api2.max.ru'
/** MAX rejects a longer single message body. */
export const MAX_TEXT_LIMIT = 4000
/** "не более двух сообщений в секунду" → 500 ms between sends to one chat. */
export const MAX_SEND_INTERVAL_MS = 500
/** Keyboard limits from the keyboard guide. */
export const MAX_KEYBOARD_ROWS = 30
export const MAX_KEYBOARD_BUTTONS = 7
export const MAX_KEYBOARD_LINK_BUTTONS = 3
/** Update types the bot subscribes to by default. */
export const DEFAULT_UPDATE_TYPES = ['message_created', 'message_edited', 'message_callback']

export const CERTIFICATE_HINT =
  'The *.max.ru certificate is signed by the "Russian Trusted Sub CA" root of the Ministry of Digital Development (Минцифры): '
  + 'установите корневой сертификат Минцифры (https://gu-st.ru/) в системное хранилище '
  + 'или укажите PEM-файл через NODE_EXTRA_CA_CERTS'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const backoff = (attempt) => Math.min(500 * 2 ** (attempt - 1), 10000)

/** Error carrying the MAX operation, HTTP status, `code` and `message`. */
export class MaxError extends ConnectionError {
  /**
   * @param {string} message - readable description (never contains the token).
   * @param {object} [details] - error details.
   * @param {string} [details.method] - operation, for example `POST /messages`.
   * @param {number} [details.status] - HTTP status, when there was a response.
   * @param {string} [details.code] - MAX error code, for example `chat.denied`.
   * @param {string} [details.description] - MAX `message` field.
   * @param {boolean} [details.certificate] - true for a TLS trust failure.
   * @param {Error} [details.cause] - original error.
   */
  constructor(message, { method, status, code, description, certificate = false, cause } = {}) {
    super(message, { provider: 'max', status, cause })
    this.name = 'MaxError'
    this.method = method
    this.status = status
    this.code = code
    this.description = description
    this.certificate = certificate
  }
}

/** Node/OpenSSL codes that mean "this certificate chain is not trusted". */
const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * Whether a thrown fetch error is a TLS trust problem.
 *
 * undici reports it as `TypeError: fetch failed` with `cause.code` from OpenSSL;
 * other runtimes only put the text in the message, so both are inspected.
 *
 * @param {unknown} error - error thrown by `fetchImpl`.
 * @returns {boolean} true when the certificate chain is the problem.
 */
export function isCertificateError(error) {
  if (!error) return false
  const codes = [error.code, error.cause?.code].filter(Boolean)
  if (codes.some((code) => CERTIFICATE_CODES.has(String(code)))) return true
  const text = `${error.message ?? ''} ${error.cause?.message ?? ''}`
  return /certificate|self[- ]signed|unable to verify|issuer cert|CERT_[A-Z_]+|ERR_TLS_CERT/i.test(text)
}

/** Parse a JSON body, keeping the raw text so a huge `marker` stays exact. */
function parseJson(text) {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text.slice(0, 200) }
  }
}

/**
 * Read `marker` from the raw response body.
 *
 * `marker` is int64; `JSON.parse` would silently round values above 2^53, and
 * echoing a rounded cursor back to MAX would skip or repeat updates. Small
 * markers are returned as numbers (the common case), huge ones as strings.
 *
 * @param {string} text - raw `/updates` response body.
 * @returns {number|string|undefined} the cursor, or undefined when absent/null.
 */
export function markerFrom(text) {
  const match = /"marker"\s*:\s*(-?\d+)/.exec(String(text ?? ''))
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : match[1]
}

/** `numericId` that leaves missing ids missing instead of stringifying them. */
const idOrUndefined = (value) =>
  (value === undefined || value === null || value === '' ? undefined : numericId(value))

/**
 * MAX Bot API client: JSON over HTTPS with the retry policy the API expects.
 *
 * Every call is a plain fetch, so the client runs against a local stub in tests
 * exactly as it runs against `platform-api2.max.ru` in production.
 */
export class MaxClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.token] - bot access token; defaults to `MAX_TOKEN`.
   * @param {string} [options.apiBase] - API root; defaults to `MAX_API_BASE`.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   */
  constructor({
    token,
    apiBase = process.env.MAX_API_BASE ?? DEFAULT_API_BASE,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60000,
    logger,
    maxAttempts = 4,
    sleep = defaultSleep,
  } = {}) {
    this.token = token ?? process.env.MAX_TOKEN
    this.apiBase = String(apiBase).replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.maxAttempts = maxAttempts
    this.sleep = sleep
  }

  /**
   * Build a request URL with only the query parameters that are set.
   *
   * The token never reaches the URL (query-parameter auth was removed by MAX),
   * so it cannot leak through logs or error messages.
   */
  url(path, query) {
    const url = new URL(`${this.apiBase}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * Perform one API request.
   *
   * @param {string} operation - label used in errors, for example `POST /messages`.
   * @param {object} request - `method`, `path`, `query`, `body`, `signal`, `timeoutMs`.
   * @returns {Promise<{data: any, text: string, status: number}>} parsed body and raw text.
   */
  async request(operation, { method = 'GET', path, query, body, signal, timeoutMs } = {}) {
    if (!this.token) {
      throw new MaxError(`MAX ${operation} failed: no access token (pass token or set MAX_TOKEN)`, { method: operation })
    }
    const url = this.url(path, query)
    const deadline = timeoutMs ?? this.timeoutMs
    let lastError
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const requestSignal = deadlineSignal(deadline, signal)
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: this.token,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: requestSignal,
        })
        const text = await response.text()
        const data = parseJson(text)
        if (response.ok) return { data, text, status: response.status }

        // MAX errors are `{code, message}` (OpenAPI `Error` schema). HTTP 200
        // with `{success: false}` is treated as a result, not as an error.
        const code = data?.code === undefined ? undefined : String(data.code)
        const description = String(data?.message ?? data?.error ?? response.statusText ?? '') || undefined
        const error = new MaxError(`MAX ${operation} failed:${code ? ` [${code}]` : ''} ${description ?? 'unknown error'}`, {
          method: operation,
          status: response.status,
          code,
          description,
        })
        if (response.status === 429 && attempt < this.maxAttempts) {
          // MAX does not document a rate-limit header, so `Retry-After` is used
          // when a proxy sends one and exponential backoff otherwise.
          const waitMs = retryAfterMs(response.headers) ?? backoff(attempt)
          this.logger?.warn('max rate limited', { method: operation, waitMs, attempt })
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
        if (error instanceof MaxError) throw error
        if (signal?.aborted) throw error
        if (isCertificateError(error)) {
          // The chain will not fix itself: report once with an actionable hint.
          throw new MaxError(`MAX ${operation} failed: TLS certificate is not trusted (${error.cause?.code ?? error.message}). ${CERTIFICATE_HINT}`, {
            method: operation,
            certificate: true,
            cause: error,
          })
        }
        lastError = error
        if (attempt >= this.maxAttempts) break
        this.logger?.warn('max request failed, retrying', { method: operation, attempt, reason: error?.message })
        await this.sleep(backoff(attempt))
      }
    }
    throw new MaxError(`MAX ${operation} failed after ${this.maxAttempts} attempts: ${lastError?.message}`, {
      method: operation,
      cause: lastError,
    })
  }

  /** Bot identity; also validates the token at startup. */
  getMe(options) {
    return this.request('GET /me', { path: '/me', ...options })
  }

  /**
   * Long polling.
   *
   * `marker` is the pointer to the next page; without it MAX returns only the
   * latest update. `timeout` is the server-side hold time in seconds (0..90).
   */
  getUpdates({ marker, timeoutSec = 30, limit = 100, types = DEFAULT_UPDATE_TYPES }, options = {}) {
    return this.request('GET /updates', {
      path: '/updates',
      query: {
        limit,
        timeout: timeoutSec,
        marker,
        types: types?.length ? types.join(',') : undefined,
      },
      timeoutMs: (Number(timeoutSec) + 20) * 1000,
      ...options,
    })
  }

  /**
   * Send one message. `disable_link_preview` is a query parameter in the MAX
   * schema (NewMessageBody has no such field); `link` makes the message a reply.
   */
  sendMessage({ chatId, userId, text, format = 'markdown', attachments, replyToMessageId, disableLinkPreview = true, notify = true }, options) {
    return this.request('POST /messages', {
      method: 'POST',
      path: '/messages',
      query: {
        chat_id: chatId,
        user_id: userId,
        disable_link_preview: disableLinkPreview ? true : undefined,
      },
      body: {
        text,
        format,
        notify,
        attachments,
        ...(replyToMessageId === undefined || replyToMessageId === null
          ? {}
          : { link: { type: 'reply', mid: String(replyToMessageId) } }),
      },
      ...options,
    })
  }

  /**
   * Rewrite one message. `attachments` is omitted unless a keyboard is given:
   * per the MAX docs an absent `attachments` field keeps the current one.
   * Edits do not notify participants.
   */
  editMessage({ messageId, text, format = 'markdown', attachments }, options) {
    return this.request('PUT /messages', {
      method: 'PUT',
      path: '/messages',
      query: { message_id: messageId },
      body: { text, format, notify: false, attachments },
      ...options,
    })
  }

  /**
   * Acknowledge a button tap.
   *
   * `CallbackAnswer` has `notification` (one-time toast) and `message` (edit the
   * original message); there is no "alert" mode, so `alert` is not sent.
   */
  answerCallback({ callbackId, notification, message }, options) {
    return this.request('POST /answers', {
      method: 'POST',
      path: '/answers',
      query: { callback_id: callbackId },
      body: {
        ...(notification ? { notification: String(notification) } : {}),
        ...(message ? { message } : {}),
      },
      ...options,
    })
  }

  /** Best effort "bot is typing" hint; only documented for group chats. */
  sendChatAction({ chatId, action = 'typing_on' }, options) {
    return this.request('POST /chats/{chatId}/actions', {
      method: 'POST',
      path: `/chats/${encodeURIComponent(chatId)}/actions`,
      body: { action },
      ...options,
    })
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

/**
 * Sanitise our markdown for MAX's `format: "markdown"`.
 *
 * MAX documents this subset: `*italic*`/`_italic_`, `**bold**`/`__bold__`,
 * `~~strike~~`, `++underline++`, `` `code` ``, `[label](url)`,
 * `[name](max://user/<id>)` mentions, `^^highlight^^`, `# heading` and
 * `> quote` — so headings and bold (which the core emits) are safe.
 *
 * Rewritten here, because MAX does not document them and they would otherwise
 * render as literal markers:
 * - bullet markers `- ` / `* ` / `+ ` become `• `; `* item` is the worst case,
 *   since a leading asterisk starts italics;
 * - `***x***` / `___x___` collapse to plain bold;
 * - images become `alt (url)`;
 * - links with a scheme MAX does not open become `label (url)`;
 * - horizontal rules become a dash row;
 * - fenced code loses its language tag (MAX has no highlighting). The fences
 *   themselves are kept: the OpenAPI schema maps ```code``` blocks onto
 *   `monospaced` markup.
 *
 * MAX does not document how malformed markup is handled (the alternative,
 * `format: "html"`, is documented even more thinly), so the safe route — plain
 * text — was considered and rejected: it would drop every bold and link.
 *
 * @param {string} markdown - core markdown.
 * @returns {string} markdown MAX can render.
 */
export function toMaxMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  let text = markdown
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '**$1**')
  text = text.replace(/___([^_\n]+)___/g, '__$1__')
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_all, alt, url) => (alt ? `${alt} (${url})` : url))
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label, url) =>
    (/^(https?:\/\/|max:\/\/)/i.test(url) ? all : `${label} (${url})`))
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
  text = text.replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '———')
  text = text.replace(/^([ \t]*)```[^\n`]*$/gm, '$1```')
  return text
}

/**
 * Split text into chunks of at most `limit` characters, preferring paragraph
 * and line boundaries.
 *
 * The MAX markdown parser sees each chunk on its own, so a fenced code block
 * that straddles the limit is closed at the end of one chunk and reopened at
 * the start of the next; text is never left inside a broken fence.
 *
 * @param {string} text - already-sanitised markdown.
 * @param {number} [limit] - MAX's per-message limit.
 * @returns {string[]} one or more non-empty chunks.
 */
export function splitMaxText(text, limit = MAX_TEXT_LIMIT) {
  const source = String(text ?? '')
  if (source === '') return []
  if (source.length <= limit) return [source]
  // Below this the fence bookkeeping cannot make progress; plain greedy
  // splitting is used instead of hanging.
  const fenceAware = limit >= 64
  const closeFence = fenceAware ? '\n```' : ''
  const openFence = fenceAware ? '```\n' : ''
  const chunks = []
  let current = ''
  let fenceOpen = false

  const flush = () => {
    if (current !== '') chunks.push(fenceOpen ? current + closeFence : current)
    current = fenceOpen ? openFence : ''
  }

  for (const line of source.split('\n')) {
    let rest = line
    for (;;) {
      const isFence = fenceAware && rest === line && /^ {0,3}```/.test(rest)
      const sep = current === '' || current.endsWith('\n') ? '' : '\n'
      const room = limit - current.length - sep.length - (fenceOpen ? closeFence.length : 0)
      if (rest.length <= room) {
        current += sep + rest
        if (isFence) fenceOpen = !fenceOpen
        break
      }
      if (current !== '') {
        // The line does not fit here: close this chunk and retry it below.
        flush()
        continue
      }
      // A single line longer than a whole chunk: hard-split it, but never
      // between the halves of a surrogate pair.
      const keep = Math.max(1, room)
      let cut = rest.slice(0, keep)
      const unit = cut.charCodeAt(cut.length - 1)
      if (unit >= 0xd800 && unit <= 0xdbff && rest.length > keep) cut = rest.slice(0, keep + 1)
      current += sep + cut
      rest = rest.slice(cut.length)
      flush()
      if (rest === '') break
    }
  }
  if (current !== '') chunks.push(fenceOpen ? current + closeFence : current)
  return chunks.filter((chunk) => chunk !== '')
}

/**
 * Map the neutral keyboard onto a MAX `inline_keyboard` attachment.
 *
 * Rows and buttons beyond MAX's limits (30 rows, 7 buttons per row, 3 when the
 * row holds a link) are dropped rather than failing the whole send; buttons with
 * no text, or with neither `url` nor `data`, cannot be rendered at all.
 *
 * @param {{rows?: Array<Array<object>>}} [keyboard] - neutral keyboard.
 * @returns {object[]|undefined} attachment list, or undefined when empty.
 */
export function toAttachments(keyboard) {
  if (!keyboard?.rows?.length) return undefined
  const buttons = keyboard.rows
    .slice(0, MAX_KEYBOARD_ROWS)
    .map((row) => {
      const links = (row ?? []).filter((button) => button?.url).length
      const max = links > 0 ? MAX_KEYBOARD_LINK_BUTTONS : MAX_KEYBOARD_BUTTONS
      return (row ?? []).map(toButton).filter(Boolean).slice(0, max)
    })
    .filter((row) => row.length > 0)
  if (buttons.length === 0) return undefined
  return [{ type: 'inline_keyboard', payload: { buttons } }]
}

/** One neutral button in MAX's wire shape (`callback` carries `payload`). */
function toButton(button) {
  if (!button) return undefined
  const text = String(button.text ?? '')
  if (text === '') return undefined
  if (button.url) return { type: 'link', text, url: String(button.url).slice(0, 2048) }
  return { type: 'callback', text, payload: String(button.data ?? '').slice(0, 1024) }
}

/** `dialog` → `private`; `chat` → `group`; `channel` stays `channel`. */
function neutralChatType(chatType) {
  if (chatType === 'chat') return 'group'
  if (chatType === 'channel') return 'channel'
  return 'private'
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The MAX adapter.
 *
 * @see the port contract in `port.mjs` for the neutral shapes.
 */
export class MaxPlatform {
  /**
   * @param {object} options - adapter options.
   * @param {string} [options.token] - bot token; defaults to `MAX_TOKEN`.
   * @param {string} [options.apiBase] - API root; defaults to `MAX_API_BASE`.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   * @param {() => number} [options.now] - clock, injected by tests.
   * @param {number} [options.minSendIntervalMs] - pause between sends to one chat.
   * @param {string[]} [options.updateTypes] - `types` for `/updates`.
   * @param {MaxClient} [options.client] - pre-built client (tests).
   */
  constructor({
    token,
    apiBase,
    timeoutMs,
    logger,
    fetchImpl,
    sleep = defaultSleep,
    now = Date.now,
    minSendIntervalMs = MAX_SEND_INTERVAL_MS,
    updateTypes = DEFAULT_UPDATE_TYPES,
    maxAttempts,
    client,
  } = {}) {
    this.name = 'max'
    // Short platform marker: it names the adapter and can prefix shared keys.
    this.namespace = 'max'
    this.logger = logger
    this.client = client ?? new MaxClient({ token, apiBase, timeoutMs, logger, fetchImpl, maxAttempts, sleep })
    this.sleep = sleep
    this.now = now
    this.minSendIntervalMs = minSendIntervalMs
    this.updateTypes = updateTypes
    this.identity = undefined
    /** chatId → { type, userId, param }: how to address a chat. */
    this.routes = new Map()
    /** Per-chat send chains and the time of the last send. */
    this.chains = new Map()
    this.lastSendAt = new Map()
  }

  /**
   * Resolve the bot identity.
   *
   * No webhook call is needed: MAX has no "delete webhook" method, and long
   * polling simply stops working while a webhook subscription is active.
   *
   * @returns {Promise<MaxPlatform>} this adapter.
   */
  async start() {
    const { data } = await this.client.getMe()
    this.identity = {
      id: idOrUndefined(data?.user_id),
      username: data?.username ?? undefined,
      // `first_name` is the documented field; `name` is deprecated but still
      // returned by some bots.
      title: data?.first_name ?? data?.name ?? undefined,
    }
    return this
  }

  /**
   * MAX has no reaction API, so the port method is a documented no-op.
   *
   * @returns {Promise<undefined>} always undefined.
   */
  async setReaction() {
    return undefined
  }

  /**
   * Media attached to a MAX message.
   *
   * MAX delivers attachments as `body.attachments` with `type` and `payload`;
   * only those carrying a direct URL can be fetched by the bot. Voice needs
   * transcription and images need a vision model — both handled by the core.
   *
   * @param {object} message - raw MAX message.
   * @returns {Array<object>} attachments the bot can download.
   */
  attachmentsOf(message) {
    const raw = message?.body?.attachments
    if (!Array.isArray(raw)) return []
    const kinds = { image: 'photo', audio: 'voice', file: 'document', video: 'video' }
    const list = []
    for (const item of raw) {
      const kind = kinds[item?.type]
      const url = item?.payload?.url
      if (!kind || typeof url !== 'string' || url === '') continue
      list.push({
        kind,
        url,
        name: item?.payload?.file_name ?? item?.filename,
        mime: item?.payload?.mime_type,
        size: item?.payload?.size,
        duration: item?.payload?.duration,
      })
    }
    return list
  }

  /**
   * Download an attachment by its direct URL.
   *
   * @param {object} request - `url` and optional `maxBytes`.
   * @returns {Promise<{bytes: Buffer, size: number}>} the file.
   */
  async downloadFile({ url, maxBytes = 20_000_000 }) {
    if (!url) throw new MaxError('MAX attachment has no downloadable url', { method: 'downloadFile' })
    const response = await this.fetchImpl(url, { signal: deadlineSignal(60_000) })
    if (!response.ok) {
      throw new MaxError(`MAX file download failed: HTTP ${response.status}`, { method: 'downloadFile', status: response.status })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) {
      throw new MaxError(`file is too large (${bytes.length} bytes, limit ${maxBytes})`, { method: 'downloadFile' })
    }
    return { bytes, size: bytes.length }
  }

  /** Long polling needs no unsubscription; the method exists for the port. */
  async stop() {}

  /** A rejected token or an untrusted certificate is not worth retrying. */
  isFatalError(error) {
    return error instanceof MaxError && Boolean(error.certificate || error.status === 401 || error.status === 403)
  }

  /**
   * Long-poll and normalise.
   *
   * @param {object} request - `cursor` is the last `marker`, `timeoutSec` the hold time.
   * @returns {Promise<{updates: object[], cursor: number|string|undefined}>} updates and the new cursor.
   */
  async getUpdates({ cursor, timeoutSec = 30, signal } = {}) {
    // Without a cursor `marker` is not sent at all: MAX then returns only the
    // latest update, which is the documented way to start polling.
    const { data, text } = await this.client.getUpdates({
      marker: cursor,
      timeoutSec,
      limit: 100,
      types: this.updateTypes,
    })
    const updates = []
    for (const update of data?.updates ?? []) {
      const normalised = this.normalize(update)
      if (normalised) updates.push(normalised)
    }
    return { updates, cursor: markerFrom(text) ?? cursor }
  }

  /**
   * Turn one MAX update into the neutral shape.
   *
   * `message_edited` is handled as a regular message, like the Telegram adapter
   * handles `edited_message`: the core is stateless about message versions and
   * simply sees the new text. Everything else (`bot_started`, `chat_title_changed`,
   * `message_removed`, …) returns `undefined` and is dropped by `getUpdates`.
   *
   * @param {object} update - one MAX `Update`.
   * @returns {object|undefined} the neutral update, or undefined when ignored.
   */
  normalize(update) {
    switch (update?.update_type) {
      case 'message_created':
      case 'message_edited':
        return this.normalizeMessage(update)
      case 'message_callback':
        return this.normalizeCallback(update)
      default:
        return undefined
    }
  }

  /** `message_created` / `message_edited` → `kind: 'message'`. */
  normalizeMessage(update) {
    const message = update?.message
    const sender = message?.sender
    // A channel post has no sender (the channel is the author); the core cannot
    // act on it, and the Telegram adapter drops the equivalent case too.
    if (!sender) return undefined
    const chatType = neutralChatType(message?.recipient?.chat_type)
    const peerId = idOrUndefined(sender.user_id)
    // A dialog is identified by the other participant (MAX addresses dialogs by
    // `user_id`, not `chat_id`); groups and channels by `recipient.chat_id`.
    const chatId = chatType === 'private'
      ? (idOrUndefined(message?.recipient?.chat_id) ?? peerId)
      : idOrUndefined(message?.recipient?.chat_id)
    this.rememberRoute(chatId, chatType, peerId)
    return {
      kind: 'message',
      // MAX updates carry no id; their millisecond timestamp is the closest
      // stable identifier and `id` is only used for logging by the core. The
      // polling cursor is the `marker`, not this value.
      id: update.timestamp,
      chat: { id: chatId, type: chatType },
      from: {
        id: peerId,
        name: sender.first_name ?? sender.name,
        username: sender.username ?? undefined,
        isBot: Boolean(sender.is_bot),
      },
      text: String(message?.body?.text ?? '').trim(),

      attachments: this.attachmentsOf(message),
      addressed: chatType === 'private' || this.isAddressed(message),
      // The current message's `mid`, so a reply can quote it.
      replyToMessageId: message?.body?.mid === undefined ? undefined : String(message.body.mid),
    }
  }

  /** `message_callback` → `kind: 'callback'`. */
  normalizeCallback(update) {
    const callback = update?.callback
    if (!callback?.callback_id) return undefined
    // `message` is nullable: the keyboard's message may already be deleted.
    const message = update?.message
    const user = callback.user
    const chatType = neutralChatType(message?.recipient?.chat_type ?? 'dialog')
    const peerId = idOrUndefined(user?.user_id)
    const chatId = chatType === 'private'
      ? (idOrUndefined(message?.recipient?.chat_id) ?? peerId)
      : idOrUndefined(message?.recipient?.chat_id)
    this.rememberRoute(chatId, chatType, peerId)
    const mid = message?.body?.mid
    return {
      kind: 'callback',
      id: update.timestamp,
      chat: { id: chatId ?? peerId, type: chatType },
      from: {
        id: peerId,
        name: user?.first_name ?? user?.name,
        username: user?.username ?? undefined,
        isBot: Boolean(user?.is_bot),
      },
      text: '',
      addressed: true,
      callback: {
        id: String(callback.callback_id),
        data: String(callback.payload ?? ''),
        // Undefined when the keyboard's message is gone; `POST /answers` needs
        // only the callback id, so the tap can still be acknowledged.
        messageId: mid === undefined ? undefined : String(mid),
      },
    }
  }

  /**
   * Whether a group message addresses the bot.
   *
   * A reply to the bot's own message is found through `link.type === 'reply'`
   * and the linked message's `sender.user_id`. A mention arrives as a
   * `user_mention` markup element (by `user_id`, or by `user_link` =
   * `@username`); for updates without markup the `@username` text and the
   * `max://user/<id>` mention link are checked as a fallback. The bot's display
   * name is deliberately not matched: it is a common word for bots and matching
   * it would wake the bot on unrelated chatter.
   *
   * @param {object} message - MAX `Message`.
   * @returns {boolean} true when the bot was addressed.
   */
  isAddressed(message) {
    const botId = this.identity?.id
    const username = this.identity?.username
    if (message?.link?.type === 'reply' && botId !== undefined
      && String(message.link.sender?.user_id ?? '') === String(botId)) return true
    const body = message?.body ?? {}
    for (const element of body.markup ?? []) {
      if (element?.type !== 'user_mention') continue
      if (botId !== undefined && element.user_id !== undefined && String(element.user_id) === String(botId)) return true
      if (username && String(element.user_link ?? '').toLowerCase() === `@${String(username).toLowerCase()}`) return true
    }
    const text = String(body.text ?? '')
    if (botId !== undefined && text.includes(`max://user/${botId}`)) return true
    if (username) {
      const pattern = new RegExp(`(^|[^\\w@])@${escapeRegExp(username)}(?![\\w@])`, 'i')
      if (pattern.test(text)) return true
    }
    return false
  }

  /**
   * Send markdown, split to MAX's 4000-character limit.
   *
   * `inline_keyboard` is attached to the last chunk only, so the buttons sit
   * under the end of a long answer, and every chunk is a reply to the same
   * message (mirroring the Telegram adapter).
   *
   * @param {object} request - `chatId`, `markdown`, optional `replyToMessageId`, `keyboard`.
   * @returns {Promise<{messageId?: string}>} the last message id (`body.mid`).
   */
  async sendText({ chatId, markdown, replyToMessageId, keyboard }) {
    const chunks = splitMaxText(toMaxMarkdown(markdown), MAX_TEXT_LIMIT)
    const attachments = toAttachments(keyboard)
    let last
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      // The queue keeps at most two messages per second per chat; a long answer
      // would otherwise be rejected by MAX.
      last = await this.withChatSlot(chatId, () => this.sendChunk({
        chatId,
        text: chunk,
        replyToMessageId,
        attachments: isLast ? attachments : undefined,
      }))
    }
    return { messageId: last?.body?.mid === undefined ? undefined : String(last.body.mid) }
  }

  /**
   * Replace the text of one message.
   *
   * MAX answers `200 {success: false, message}` when there is nothing to change,
   * and the core only uses the edit to report the outcome of a tap — so that
   * case is logged, not thrown.
   *
   * @param {object} request - `chatId`, `messageId`, `markdown`, optional `keyboard`.
   * @returns {Promise<{success?: boolean}>} the API result.
   */
  async editText({ chatId, messageId, markdown, keyboard }) {
    const attachments = toAttachments(keyboard)
    return this.withChatSlot(chatId, async () => {
      try {
        const { data } = await this.client.editMessage({
          messageId,
          text: toMaxMarkdown(markdown),
          attachments,
        })
        if (data?.success === false) {
          this.logger?.warn('max edit reported no change', { chatId, messageId, description: data.message })
        }
        return data ?? {}
      } catch (error) {
        if (isNothingToChange(error)) {
          this.logger?.warn('max edit skipped', { chatId, messageId, code: error.code, description: error.description })
          return { success: false }
        }
        throw error
      }
    })
  }

  /**
   * Acknowledge a button tap with a one-time notification.
   *
   * MAX's `CallbackAnswer` has no "alert" flag: a notification is always a
   * toast, so `alert` is accepted for the port's sake and ignored.
   *
   * @param {object} request - `callbackId`, `text`, `alert`.
   * @returns {Promise<void>} resolves once acknowledged.
   */
  async answerCallback({ callbackId, text }) {
    // A tap has no chat id in the port, so acknowledgements share one queue;
    // MAX limits answers to two per second per chat and this is deliberately
    // stricter.
    await this.withChatSlot('@callbacks', () => this.client.answerCallback({ callbackId, notification: text }))
  }

  /**
   * "typing…" hint.
   *
   * `POST /chats/{chatId}/actions` is documented for group chats only, so a
   * dialog may reject it; that must never break the answer, hence the swallow.
   *
   * @param {object} request - `chatId`.
   * @returns {Promise<void>} resolves whether or not the hint was accepted.
   */
  async sendTyping({ chatId }) {
    try {
      await this.client.sendChatAction({ chatId, action: 'typing_on' })
    } catch (error) {
      this.logger?.debug('max typing failed', { chatId, reason: error?.message })
    }
  }

  /** Remember how a chat is addressed and which participant it belongs to. */
  rememberRoute(chatId, chatType, peerId) {
    if (chatId === undefined || chatId === null) return
    this.routes.set(String(chatId), { type: chatType, userId: chatType === 'private' ? peerId : undefined })
  }

  /**
   * Which query parameter reaches this chat.
   *
   * The port carries a single `chatId`, while `POST /messages` distinguishes
   * `user_id` (dialogs) from `chat_id` (groups and channels): a dialog seen in
   * an update is addressed by its participant, everything else by `chat_id`.
   *
   * Guessing `user_id = chatId` for an unknown chat is deliberately *not* done:
   * if that number belonged to a group, MAX would look up a user with the same
   * id and the bot could message a stranger. The cost of that caution is that a
   * proactive send into a dialog after a restart (no update seen yet) may need
   * the `chat_id` fallback in `sendChunk`.
   */
  routeFor(chatId) {
    const known = this.routes.get(String(chatId))
    if (known?.param === 'chat_id') return { chatId }
    if (known?.param === 'user_id' && known.userId !== undefined) return { userId: known.userId }
    if (known?.type === 'private' && known.userId !== undefined) return { userId: known.userId }
    return { chatId }
  }

  /**
   * Send one chunk, retrying once with the other routing parameter.
   *
   * Only an unconfirmed guess is retried: once a chat has answered to one
   * parameter, a later failure is a real error and is surfaced as such.
   */
  async sendChunk({ chatId, text, replyToMessageId, attachments }) {
    const route = this.routeFor(chatId)
    const send = (target) => this.client.sendMessage({
      ...target,
      text,
      format: 'markdown',
      attachments,
      replyToMessageId,
    })
    try {
      const { data } = await send(route)
      this.rememberParam(chatId, route)
      return data?.message
    } catch (error) {
      const known = this.routes.get(String(chatId))
      const alternative = route.userId !== undefined
        ? { chatId }
        : (known?.userId !== undefined ? { userId: known.userId } : undefined)
      if (known?.param !== undefined || !alternative || !isRoutingFailure(error)) throw error
      this.logger?.warn('max message routing rejected, retrying', { chatId, status: error.status, code: error.code })
      const { data } = await send(alternative)
      this.rememberParam(chatId, alternative)
      return data?.message
    }
  }

  /** Cache the parameter that worked for a chat. */
  rememberParam(chatId, target) {
    const known = this.routes.get(String(chatId)) ?? {}
    this.routes.set(String(chatId), {
      ...known,
      type: known.type ?? (target.userId !== undefined ? 'private' : undefined),
      userId: target.userId !== undefined ? target.userId : known.userId,
      param: target.userId !== undefined ? 'user_id' : 'chat_id',
    })
  }

  /**
   * Run `task` as the only sender for `chatId`, at least `minSendIntervalMs`
   * after the previous one.
   *
   * MAX allows two messages (and two edits) per second per chat; serialising
   * per chat keeps a split answer inside that budget.
   */
  withChatSlot(chatId, task) {
    const key = String(chatId)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const run = previous.then(() => this.runWithGap(key, task))
    // The chain entry must never reject: it is stored, not awaited, and an
    // unhandled rejection would take the process down.
    const settled = run.then(() => {}, () => {})
    settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
    this.chains.set(key, settled)
    return run
  }

  /** Wait out the gap for one chat slot, then run the task. */
  async runWithGap(key, task) {
    const last = this.lastSendAt.get(key)
    if (last !== undefined) {
      const wait = this.minSendIntervalMs - (this.now() - last)
      if (wait > 0) await this.sleep(wait)
    }
    try {
      return await task()
    } finally {
      // Recorded even on failure: a rejected send still counts against the rate
      // limit, and retrying immediately would only fail again.
      this.lastSendAt.set(key, this.now())
    }
  }
}

/** A 400/403 is how MAX reports a routing parameter it cannot use. */
const isRoutingFailure = (error) =>
  error instanceof MaxError && (error.status === 400 || error.status === 403)

/** MAX answers "nothing to change" either as a result flag or as a 400. */
const isNothingToChange = (error) =>
  error instanceof MaxError && /nothing to (change|edit)|not (changed|modified)|unchanged|нечего|не измен/i.test(
    `${error.code ?? ''} ${error.description ?? ''} ${error.message ?? ''}`,
  )

/**
 * Build the MAX adapter.
 *
 * @param {object} options - see `MaxPlatform`.
 * @returns {MaxPlatform} the adapter.
 */
export const createMaxPlatform = (options) => new MaxPlatform(options)
