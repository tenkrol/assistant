/**
 * OCR fallback for images: local `tesseract`, no network and no key.
 *
 * It exists for the cases where the vision call cannot be used — the provider is
 * unreachable, the key is missing, or the picture is a dense scan where a
 * deterministic OCR pass is what the task actually needs. The caller tries
 * vision first and only then this.
 */
import { spawn as spawnProcess } from 'node:child_process'

/** How much stderr is kept for diagnostics. */
const STDERR_TAIL_CHARS = 400

export class OcrClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.command] - tesseract executable.
   * @param {string} [options.languages] - tesseract `-l` value, e.g. `rus+eng`.
   * @param {number} [options.timeoutMs] - per-file timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof import('node:child_process').spawn} [options.spawnImpl] - spawn, injected by tests.
   */
  constructor({ command = 'tesseract', languages = 'rus+eng', timeoutMs = 60_000, logger, spawnImpl = spawnProcess } = {}) {
    this.command = command
    this.languages = languages
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.spawnImpl = spawnImpl
  }

  get enabled() {
    return Boolean(this.command)
  }

  /** Whether the executable exists and answers; used once at startup. */
  async probe() {
    return new Promise((resolve) => {
      let child
      try {
        child = this.spawnImpl(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolve(false)
      }, 5000)
      timer.unref?.()
      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }

  /**
   * Read the text of one image file.
   *
   * @param {object} request - `path` to the image, optional `languages`.
   * @returns {Promise<{text: string, error?: string, durationMs: number}>}
   */
  async extract({ path, languages } = {}) {
    const startedAt = Date.now()
    if (!this.enabled || !path) return { text: '', error: 'OCR отключён', durationMs: 0 }
    return new Promise((resolve) => {
      let child
      try {
        child = this.spawnImpl(this.command, [path, 'stdout', '-l', languages ?? this.languages], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ text: '', error: `tesseract не запустился: ${String(error?.message ?? error).slice(0, 160)}`, durationMs: Date.now() - startedAt })
        return
      }

      let stdout = ''
      let stderrTail = ''
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ...result, durationMs: Date.now() - startedAt })
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        finish({ text: '', error: `tesseract не ответил за ${this.timeoutMs} мс` })
      }, this.timeoutMs)
      timer.unref?.()

      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
      })
      child.on('error', (error) => finish({ text: '', error: `tesseract недоступен: ${String(error?.message ?? error).slice(0, 160)}` }))
      child.on('close', (code) => {
        const text = stdout.trim()
        if (code !== 0) {
          finish({ text: '', error: `tesseract вышел с кодом ${code}${stderrTail.trim() ? `: ${stderrTail.trim().slice(0, 200)}` : ''}` })
          return
        }
        if (text === '') {
          finish({ text: '', error: 'на изображении не нашлось текста' })
          return
        }
        this.logger?.info('image read by ocr', { chars: text.length })
        finish({ text })
      })
    })
  }
}
