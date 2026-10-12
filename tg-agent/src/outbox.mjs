/**
 * Outbox: the way the task agent speaks through the bot.
 *
 * The bridge to the agent is one-way — the bot asks, the agent answers that request —
 * so a finished long task had nowhere to land. This is a deliberately tiny HTTP
 * endpoint on loopback: the agent posts text, the bot delivers it into the chat and
 * records it in history, so the user's reply continues the same conversation instead
 * of starting blind.
 *
 * Fail-closed by design: without a token no server is created, and it never binds
 * off loopback, so nothing is exposed to the internet even if a port is forgotten.
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const DEFAULT_MAX_BODY = 32 * 1024
const DEFAULT_MAX_TEXT = 4000

/** Constant-time comparison that does not leak the expected token length. */
function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8')
  const b = Buffer.from(String(expected ?? ''), 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/**
 * Build the receiver.
 *
 * @param {object} options - `token` (required), `deliver({text, chatId, platform, title})`,
 *   `port`, `host`, `maxBodyBytes`, `maxTextChars`, `logger`.
 * @returns {{server: object, start: Function, stop: Function, url: string, port: number}} the outbox.
 */
export function createOutbox({
  token,
  deliver,
  port = 8788,
  host = '127.0.0.1',
  maxBodyBytes = DEFAULT_MAX_BODY,
  maxTextChars = DEFAULT_MAX_TEXT,
  logger,
} = {}) {
  if (typeof deliver !== 'function') throw new Error('Outbox: нужна функция deliver')
  if (!token) throw new Error('Outbox: не задан токен — приём сообщений от агента выключен')
  // Заголовок Authorization допускает только ASCII: с кириллическим токеном fetch
  // падает с непонятной ошибкой, поэтому проверяем заранее.
  if (!/^[\x20-\x7e]+$/.test(String(token))) throw new Error('Outbox: токен должен быть из ASCII-символов')

  const server = http.createServer((request, response) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz') return send(200, { ok: true })
    if (url.pathname !== '/outbox') return send(404, { ok: false, error: 'not found' })
    if (request.method !== 'POST') return send(405, { ok: false, error: 'только POST' })

    const header = String(request.headers.authorization ?? '')
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!sameToken(given, token)) return send(401, { ok: false, error: 'неверный токен' })

    let size = 0
    const chunks = []
    let answered = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes && !answered) {
        answered = true
        send(413, { ok: false, error: 'слишком большое сообщение' })
        request.destroy()
        return
      }
      if (!answered) chunks.push(chunk)
    })
    request.on('end', async () => {
      if (answered) return
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        return send(400, { ok: false, error: 'не разобрал JSON' })
      }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (text === '') return send(400, { ok: false, error: 'нужно поле text' })
      try {
        const result = await deliver({
          text: text.slice(0, maxTextChars),
          chatId: payload.chatId,
          platform: payload.platform,
          title: typeof payload.title === 'string' ? payload.title : undefined,
        })
        logger?.info?.('agent message delivered', { chars: text.length, chatId: result?.chatId })
        return send(200, { ok: true, chatId: result?.chatId, messageId: result?.messageId })
      } catch (error) {
        logger?.warn?.('agent message delivery failed', { error: error?.message ?? error })
        return send(500, { ok: false, error: 'не удалось доставить' })
      }
    })
    request.on('error', () => {})
  })

  let actual = port
  return {
    server,
    get port() {
      return actual
    },
    get url() {
      return `http://${host}:${actual}/outbox`
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          actual = server.address().port
          logger?.info?.('outbox listening', { url: `http://${host}:${actual}` })
          resolve(actual)
        })
      })
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

export { sameToken, DEFAULT_MAX_BODY, DEFAULT_MAX_TEXT }
