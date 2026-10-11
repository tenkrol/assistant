/**
 * Headless DSH backend.
 *
 * Instead of talking to an HTTP endpoint, this model runs the local DSH CLI in
 * its `headless` mode: the conversation is flattened into a single text prompt,
 * the CLI prints the answer to stdout, and that text becomes the assistant
 * reply.
 *
 * The class exposes the same `complete({ messages, signal })` contract as
 * {@link ChatModel}, so the bot can use either backend without changes. Every
 * failure mode (non-zero exit, timeout, abort, oversized output) kills the
 * child so `bot.stop()` never waits on a hung CLI.
 */
import { spawn as spawnProcess } from 'node:child_process'

/** How many trailing stderr characters are kept for diagnostics. */
const STDERR_TAIL_CHARS = 500

/** Error raised for any DSH backend failure. */
export class DshModelError extends Error {
  /**
   * @param {string} message - readable failure summary.
   * @param {object} [options] - failure details.
   * @param {number|string} [options.code] - child exit code, when it ran.
   * @param {string} [options.stderr] - captured stderr tail.
   * @param {Error} [options.cause] - underlying failure.
   */
  constructor(message, { code, stderr, cause } = {}) {
    super(message, { cause })
    this.name = 'DshModelError'
    this.code = code
    this.stderr = stderr
  }
}

export class DshModel {
  /**
   * @param {object} options - backend options.
   * @param {string} options.command - path to the DSH CLI executable.
   * @param {string} [options.profile] - DSH profile name; the model name is `dsh:<profile>`.
   * @param {string} [options.home] - `DSH_HOME` for the child, when set.
   * @param {number} [options.timeoutMs] - per-run timeout.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxOutputBytes] - stdout cap before the run is killed.
   * @param {typeof import('node:child_process').spawn} [options.spawnImpl] - spawn implementation, injected by tests.
   * @param {string} [options.cwd] - working directory for the child.
   */
  constructor({ command, profile = 'headless', home, timeoutMs = 180000, logger, maxOutputBytes = 1_000_000, spawnImpl = spawnProcess, cwd } = {}) {
    this.command = command
    this.profile = profile
    this.home = home
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.maxOutputBytes = maxOutputBytes
    this.spawnImpl = spawnImpl
    this.cwd = cwd
    this.name = `dsh:${profile}`
  }

  /**
   * Run one headless turn.
   *
   * @param {object} request - `messages` is the full conversation, system prompt included.
   * @param {AbortSignal} [request.signal] - cancels the run and kills the child.
   * @returns {Promise<{text: string, model: string}>}
   */
  async complete({ messages, signal } = {}) {
    const prompt = buildPrompt(messages)
    if (prompt === '') throw new DshModelError('no messages to send')
    if (signal?.aborted) throw abortError(signal)

    const args = ['--profile', this.profile, 'headless', prompt]
    const env = { ...process.env }
    if (this.home !== undefined) env.DSH_HOME = this.home

    let child
    try {
      child = this.spawnImpl(this.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd: this.cwd,
      })
    } catch (cause) {
      throw new DshModelError(`dsh failed to start: ${cause?.message}`, { cause })
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      let stdout = ''
      let stdoutBytes = 0
      let stderrTail = ''

      const killChild = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // The process is already gone.
        }
      }

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        signal?.removeEventListener('abort', onAbort)
      }

      const fail = (error, { shouldKill = false } = {}) => {
        if (settled) return
        settled = true
        cleanup()
        if (shouldKill) killChild()
        this.logger?.warn('dsh call failed', { error })
        reject(error)
      }

      const succeed = (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }

      const onAbort = () => fail(abortError(signal), { shouldKill: true })

      timer = setTimeout(() => {
        fail(new DshModelError(`dsh run timed out after ${this.timeoutMs} ms`), { shouldKill: true })
      }, this.timeoutMs)
      timer.unref?.()

      signal?.addEventListener('abort', onAbort, { once: true })
      // The signal may have aborted between the check above and the listener.
      if (signal?.aborted) onAbort()

      child.stdout?.on('data', (chunk) => {
        if (settled) return
        stdoutBytes += chunk.length
        if (stdoutBytes > this.maxOutputBytes) {
          fail(new DshModelError(`dsh output exceeded ${this.maxOutputBytes} bytes`), { shouldKill: true })
          return
        }
        stdout += chunk
      })

      child.stderr?.on('data', (chunk) => {
        if (settled) return
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
      })

      child.on('error', (cause) => {
        fail(new DshModelError(`dsh failed to start: ${cause?.message}`, { cause }), { shouldKill: true })
      })

      child.on('close', (code, signalName) => {
        if (settled) return
        if (code === 0) {
          const text = stdout.trim()
          if (text === '') {
            fail(new DshModelError('dsh returned an empty answer'))
            return
          }
          succeed({ text, model: this.name })
          return
        }
        const exitCode = code ?? signalName ?? 'unknown'
        const tail = stderrTail.trim()
        fail(new DshModelError(`dsh exited with code ${exitCode}${tail ? `: ${tail}` : ''}`, { code: exitCode, stderr: stderrTail }))
      })
    })
  }
}

/**
 * Flatten a message list into one prompt: system instruction, the conversation
 * history, then the last user message and an instruction to answer it.
 *
 * @param {Array<{role: string, content: string}>} [messages] - conversation.
 * @returns {string} prompt text, or an empty string when nothing is left.
 */
function buildPrompt(messages) {
  if (!Array.isArray(messages)) return ''

  const system = []
  const turns = []
  for (const message of messages) {
    const content = typeof message?.content === 'string' ? message.content.trim() : ''
    if (content === '') continue
    if (message.role === 'system') system.push(content)
    else if (message.role === 'user' || message.role === 'assistant') turns.push({ role: message.role, content })
  }
  if (system.length === 0 && turns.length === 0) return ''

  const parts = []
  if (system.length > 0) parts.push(system.join('\n\n'))

  // The last user message is repeated after the history together with the
  // answer instruction, so the CLI always sees an explicit final question.
  const lastUser = turns.findLastIndex((turn) => turn.role === 'user')
  const history = lastUser === -1 ? turns : turns.filter((_, index) => index !== lastUser)
  if (history.length > 0) parts.push(history.map(renderTurn).join('\n'))
  if (lastUser !== -1) parts.push([`Пользователь: ${turns[lastUser].content}`, 'Ответь на последнее сообщение пользователя.'].join('\n'))

  return parts.join('\n\n')
}

/** Render one history turn as `Пользователь: …` / `Ассистент: …`. */
const renderTurn = (turn) => `${turn.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${turn.content}`

/** Reuse the abort reason when it is an Error, otherwise synthesise one. */
function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error(reason === undefined ? 'dsh run aborted' : String(reason))
  error.name = 'AbortError'
  return error
}
