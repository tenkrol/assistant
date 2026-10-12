/**
 * One headless DSH run: the process, its JSON event stream and its budget.
 *
 * DSH's headless profile takes a task on stdin and writes newline-delimited
 * JSON events to stdout (`--json`). This module owns the whole lifecycle:
 *
 *   - it starts `dsh --profile headless --json -` in the workspace directory,
 *     so DSH's `workspace-write` sandbox resolves its root to that directory;
 *   - it forwards the model key as `DEEPSEEK_API_KEY`, the only env var the
 *     `deepseek-official` provider reads;
 *   - it parses the event stream into the answer text, the per-step token usage
 *     and a small activity summary;
 *   - it enforces the per-task timeout by killing the whole process group, so
 *     LibreOffice or Python children of the bash tool die with it.
 *
 * The task text never travels through a shell and never appears in argv (it goes
 * to stdin), which keeps long tasks and leading dashes harmless.
 */
import { spawn as spawnProcess } from 'node:child_process'

/** How many trailing stderr characters are kept for diagnostics. */
const STDERR_TAIL_CHARS = 4000
/** Upper bound on one NDJSON event line; anything longer is treated as junk. */
const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024
/** Upper bound on the whole stdout stream. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024
/** Grace period between SIGTERM and SIGKILL when a run is stopped. */
const KILL_GRACE_MS = 5000

/** Error raised when the run itself could not be started or parsed. */
export class DshRunError extends Error {
  constructor(message, { code, stderr, cause } = {}) {
    super(message, { cause })
    this.name = 'DshRunError'
    this.code = code
    this.stderr = stderr
  }
}

/** The empty usage accumulator. */
const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  steps: 0,
  turns: 0,
})

/** Add one step's usage to the accumulator. */
function accumulate(usage, step) {
  usage.inputTokens += Number(step?.inputTokens) || 0
  usage.outputTokens += Number(step?.outputTokens) || 0
  usage.cacheReadTokens += Number(step?.cacheReadTokens) || 0
  usage.cacheWriteTokens += Number(step?.cacheWriteTokens) || 0
  usage.reasoningTokens += Number(step?.reasoningTokens) || 0
  // `totalTokens` arrives from DSH; recompute when it is absent so a partial
  // step record still counts.
  usage.totalTokens += Number(step?.totalTokens)
    || (Number(step?.inputTokens) || 0) + (Number(step?.outputTokens) || 0)
      + (Number(step?.cacheReadTokens) || 0) + (Number(step?.cacheWriteTokens) || 0)
  usage.steps += 1
}

export class DshTaskRunner {
  /**
   * @param {object} options - runner options.
   * @param {string} options.command - path to the `dsh` executable.
   * @param {string} options.workspaceDir - directory to run in (DSH workspace root).
   * @param {string} options.dshHome - `DSH_HOME` for the child.
   * @param {string} [options.profile] - DSH profile name.
   * @param {string} [options.permissionMode] - `DSH_PERMISSION_MODE` for the child.
   * @param {string} [options.apiKey] - forwarded as `DEEPSEEK_API_KEY`.
   * @param {number} [options.timeoutMs] - per-task timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof import('node:child_process').spawn} [options.spawnImpl] - spawn, injected by tests.
   * @param {NodeJS.ProcessEnv} [options.env] - base environment, defaults to `process.env`.
   * @param {(event: object) => void} [options.onEvent] - called for every parsed event.
   * @param {object} [options.cgroup] - limiter with `create`/`assign`/`release`.
   */
  constructor({
    command,
    workspaceDir,
    dshHome,
    profile = 'headless',
    permissionMode = 'workspace-write',
    apiKey,
    timeoutMs = 1_200_000,
    logger,
    spawnImpl = spawnProcess,
    env = process.env,
    onEvent,
    cgroup,
    tokenBudget = 0,
  } = {}) {
    this.command = command
    this.workspaceDir = workspaceDir
    this.dshHome = dshHome
    this.profile = profile
    this.permissionMode = permissionMode
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.env = env
    this.onEvent = onEvent
    this.cgroup = cgroup
    // A ceiling on one run's tokens: a model that loops keeps re-sending its
    // context, so cost grows with every step. 0 turns the guard off.
    this.tokenBudget = Number(tokenBudget) > 0 ? Number(tokenBudget) : 0
  }

  /** The child environment: inherited, plus the few variables DSH reads. */
  childEnv() {
    return {
      ...this.env,
      DSH_HOME: this.dshHome,
      DSH_PERMISSION_MODE: this.permissionMode,
      // Feedback-only telemetry is the default; switch it off entirely: the
      // tasks are the owner's private work.
      DSH_TELEMETRY_DISABLED: '1',
      ...(this.apiKey ? { DEEPSEEK_API_KEY: this.apiKey } : {}),
    }
  }

  /**
   * The argv DSH receives; the task goes to stdin as `-`.
   *
   * The launcher owns `--profile` and hands everything after its own flags to
   * the profile's app, so no extra profile word belongs here: a stray `headless`
   * would become the first word of the task text.
   */
  args({ sessionId } = {}) {
    return [
      '--profile',
      this.profile,
      '--json',
      ...(sessionId ? ['--session-id', String(sessionId)] : []),
      '-',
    ]
  }

  /**
   * Run one task to completion.
   *
   * @param {object} request - `task` text, optional `sessionId`, `signal`, `id`.
   * @returns {Promise<object>} the run result; `ok` is false for a failed or timed-out run.
   */
  async run({ task, sessionId, signal, id } = {}) {
    const startedAt = Date.now()
    const usage = emptyUsage()
    const tools = []
    const errors = []
    let finalText = ''
    let discoveredSessionId = sessionId
    let turnReason
    let stdoutBytes = 0
    let stderrTail = ''
    let timedOut = false
    let aborted = Boolean(signal?.aborted)
    let killedForOverflow = false
    let budgetExceeded = false
    let spawnError

    // The resource group is created before the process exists, so nothing the
    // task spawns can escape the limits.
    const group = await this.cgroup?.create(id ?? `run-${startedAt.toString(36)}`)

    let child
    try {
      child = this.spawnImpl(this.command, this.args({ sessionId }), {
        cwd: this.workspaceDir,
        env: this.childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        // A new process group: killing it on timeout takes the bash tool's
        // children (LibreOffice, python) with it.
        detached: true,
      })
    } catch (cause) {
      void this.cgroup?.release(group)
      throw new DshRunError(`dsh не удалось запустить: ${cause?.message}`, { cause })
    }

    // Placing the child in its cgroup also covers everything it forks later.
    if (group && child.pid) await this.cgroup.assign(group, child.pid)

    const result = await new Promise((resolve) => {
      let settled = false
      let killTimer
      let timeoutTimer
      let buffer = ''

      const killGroup = (signalName) => {
        try {
          if (child.pid) process.kill(-child.pid, signalName)
          else child.kill(signalName)
        } catch {
          // The process is already gone.
        }
      }

      const stop = (reason) => {
        if (settled) return
        if (reason === 'timeout') timedOut = true
        if (reason === 'abort') aborted = true
        if (reason === 'overflow') killedForOverflow = true
        if (reason === 'budget') budgetExceeded = true
        killGroup('SIGTERM')
        killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
        killTimer.unref?.()
      }

      const cleanup = () => {
        if (killTimer) {
          clearTimeout(killTimer)
          killTimer = undefined
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = undefined
        }
        signal?.removeEventListener('abort', onAbort)
      }

      /** Handle one complete NDJSON line. */
      const handleLine = (line) => {
        if (line.trim() === '') return
        let event
        try {
          event = JSON.parse(line)
        } catch {
          this.logger?.debug('dsh event not JSON, ignored', { bytes: line.length })
          return
        }
        if (event?.type === 'session' && event.sessionId) discoveredSessionId = event.sessionId
        else if (event?.type === 'status' && event.phase === 'step_end' && event.usage) {
          accumulate(usage, event.usage)
          if (this.tokenBudget > 0 && usage.totalTokens > this.tokenBudget) {
            this.logger?.warn('task over its token budget, stopping', {
              totalTokens: usage.totalTokens,
              budget: this.tokenBudget,
              steps: usage.steps,
            })
            stop('budget')
          }
        }
        else if (event?.type === 'status' && event.phase === 'turn_end') turnReason = event.reason
        else if (event?.type === 'tool_call') tools.push(String(event.tool ?? 'tool'))
        else if (event?.type === 'error') errors.push(String(event.message ?? event.code ?? 'error'))
        else if (event?.type === 'final' && typeof event.text === 'string') finalText = event.text
        try {
          this.onEvent?.(event)
        } catch (error) {
          this.logger?.debug('onEvent handler failed', { error })
        }
      }

      const onAbort = () => stop('abort')
      timeoutTimer = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
        ? setTimeout(() => {
          this.logger?.warn('task timeout, killing dsh', { timeoutMs: this.timeoutMs })
          stop('timeout')
        }, this.timeoutMs)
        : undefined
      timeoutTimer?.unref?.()

      if (signal?.aborted) {
        aborted = true
        stop('abort')
      } else {
        signal?.addEventListener('abort', onAbort, { once: true })
      }

      const finish = (exitCode, exitSignal) => {
        if (settled) return
        settled = true
        cleanup()
        // Hand the cgroup back once the process is gone; whatever is still
        // inside is killed there, so the next task starts from a clean group.
        void this.cgroup?.release(group)
        // A trailing partial line is still worth parsing: DSH flushes whole
        // lines, so this only happens on a truncated stream.
        if (buffer.trim() !== '') handleLine(buffer)
        const durationMs = Date.now() - startedAt
        const ok = exitCode === 0 && !timedOut && !aborted && !killedForOverflow
        const text = finalText.trim()
        if (ok && text === '') {
          errors.push('dsh завершился без ответа')
        }
        resolve({
          ok: ok && text !== '',
          exitCode,
          exitSignal,
          timedOut,
          aborted,
          stdoutOverflow: killedForOverflow,
          budgetExceeded,
          text,
          sessionId: discoveredSessionId,
          usage,
          tools,
          errors,
          turnReason,
          stderr: stderrTail.trim(),
          durationMs,
          spawnError,
        })
      }

      child.stdout?.on('data', (chunk) => {
        if (settled) return
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          this.logger?.warn('dsh stdout overflow, killing run')
          stop('overflow')
          return
        }
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line.length > MAX_EVENT_LINE_BYTES) {
            this.logger?.debug('oversized dsh event line ignored', { bytes: line.length })
          } else {
            handleLine(line)
          }
          index = buffer.indexOf('\n')
        }
      })

      child.stderr?.on('data', (chunk) => {
        if (settled) return
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
      })

      child.on('error', (cause) => {
        spawnError = cause
        this.logger?.error('dsh process error', { error: cause })
        finish(null, null)
      })

      child.on('close', (code, exitSignal) => finish(code, exitSignal))

      try {
        child.stdin?.on('error', () => {})
        child.stdin?.end(`${task ?? ''}\n`)
      } catch (cause) {
        this.logger?.warn('could not write task to dsh stdin', { error: cause })
      }
    })

    this.logger?.info('dsh run finished', {
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      steps: usage.steps,
      totalTokens: usage.totalTokens,
      tools: tools.length,
      timedOut: result.timedOut,
      aborted: result.aborted,
      budgetExceeded: result.budgetExceeded,
    })
    return result
  }
}
