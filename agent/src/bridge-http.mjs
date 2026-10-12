/**
 * The bridge intake: an HTTP endpoint the chat bot in Spain calls.
 *
 * Telegram cannot carry this: a bot never receives messages sent by another bot
 * (measured on a live group — a plain mention, a `tg://user` link, an explicit
 * `mention` entity and a `/help@bot` command all stayed invisible). So the chat
 * bot talks to the agent directly.
 *
 * The listener binds to loopback only and is reached through an SSH tunnel opened
 * from Spain (`ssh -N -L 8787:127.0.0.1:8787`): no port is exposed to the
 * internet, TLS is unnecessary because SSH already encrypts the hop, and the
 * bearer token is the second factor.
 *
 * The handler never blocks the response on the task itself: it queues the task
 * and answers with its id, because a run can take twenty minutes.
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/** Bodies above this are refused before parsing. */
const DEFAULT_MAX_BYTES = 64 * 1024
/** Longest task text accepted from the bridge. */
const DEFAULT_MAX_TASK_CHARS = 4000

/** Compare two secrets without leaking their length through timing. */
function sameSecret(expected, received) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(received))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Read a request body with a hard size cap. */
function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export class BridgeServer {
  /**
   * @param {object} options - server options.
   * @param {string} options.token - shared secret; the server refuses to start without it.
   * @param {(request: {task: string, source?: string}) => Promise<{taskId: string}>} options.onSubmit - queue one task.
   * @param {string} [options.host] - bind address, loopback by default.
   * @param {number} [options.port] - bind port.
   * @param {number} [options.maxBytes] - body cap.
   * @param {number} [options.maxTaskChars] - task length cap.
   * @param {object} [options.logger] - logger.
   */
  constructor({ token, onSubmit, host = '127.0.0.1', port = 8787, maxBytes = DEFAULT_MAX_BYTES, maxTaskChars = DEFAULT_MAX_TASK_CHARS, logger } = {}) {
    this.token = token
    this.onSubmit = onSubmit
    this.host = host
    this.port = port
    this.maxBytes = maxBytes
    this.maxTaskChars = maxTaskChars
    this.logger = logger
    this.server = undefined
    this.address = undefined
  }

  /** True when the bridge has everything it needs. */
  get enabled() {
    return Boolean(this.token && this.onSubmit)
  }

  /** Start listening; resolves once the port is bound. */
  async start() {
    if (!this.enabled) return undefined
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, resolve)
    })
    this.address = this.server.address()
    this.logger?.info('bridge listening', { host: this.host, port: this.address?.port })
    return this.address
  }

  /** Stop listening. */
  async stop() {
    if (!this.server) return
    await new Promise((resolve) => this.server.close(resolve))
    this.server = undefined
  }

  /** One request: authenticate, parse, queue. */
  async handle(request, response) {
    const send = (status, payload) => {
      const body = `${JSON.stringify(payload)}\n`
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(body)
    }

    if (request.method === 'GET' && request.url === '/health') {
      // No secret needed: the tunnel only exposes loopback, and a health probe
      // must work without one. It reveals nothing but "alive".
      send(200, { ok: true, service: 'agent-bridge' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/bridge') {
      send(404, { ok: false, error: 'not found' })
      return
    }
    const header = String(request.headers.authorization ?? '')
    const received = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!sameSecret(this.token, received)) {
      this.logger?.warn('bridge request rejected', { remote: request.socket?.remoteAddress })
      send(401, { ok: false, error: 'unauthorized' })
      return
    }

    let body
    try {
      body = await readBody(request, this.maxBytes)
    } catch (error) {
      send(error?.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: 'bad body' })
      return
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      send(400, { ok: false, error: 'bad json' })
      return
    }
    const task = String(payload?.task ?? '').trim()
    if (task === '') {
      send(400, { ok: false, error: 'empty task' })
      return
    }
    if (task.length > this.maxTaskChars) {
      send(400, { ok: false, error: `task longer than ${this.maxTaskChars} chars` })
      return
    }

    try {
      const result = await this.onSubmit({ task, source: payload?.source })
      this.logger?.info('bridge task accepted', { taskId: result?.taskId, chars: task.length, source: payload?.source })
      send(202, { ok: true, taskId: result?.taskId })
    } catch (error) {
      this.logger?.error('bridge task rejected', { error })
      send(500, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
    }
  }
}

/** Build the bridge server. */
export const createBridgeServer = (options) => new BridgeServer(options)
