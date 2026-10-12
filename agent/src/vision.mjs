/**
 * Vision pre-step: read an image before the task reaches DSH.
 *
 * DSH's headless runner submits the task as plain text, so a photo can never
 * reach the model as an image part. This client closes that gap on our side: it
 * asks the same model account for a textual description — verbatim text first
 * (an OCR pass), then structure and key details — and that text travels into the
 * task prompt as ordinary content.
 *
 * Measured cost of the round trip: ~200 tokens for a small screenshot. Usage is
 * returned so the daily budget counts it like any other model call.
 *
 * The provider is OpenAI-compatible (`/chat/completions` with `image_url`); the
 * agent's account answers here as `deepseek-flash` even when `deepseek-chat` is
 * requested, which is what the endpoint resolves to.
 */

/** What we ask for by default: text first, then meaning, no inventions. */
export const DEFAULT_VISION_PROMPT = [
  'Разбери изображение по-русски и строго по делу.',
  'Сначала дословно весь видимый текст (как OCR, сохраняя строки, столбцы таблиц и подписи полей).',
  'Затем: что это за объект или документ, ключевые числа, даты, имена; если это скриншот интерфейса — назначение экрана, поля и кнопки.',
  'Ничего не выдумывай: чего не видно, так и скажи. Без вступлений и вежливости.',
].join(' ')

/** Sniff the image type from magic bytes; providers need a correct mime. */
export function sniffImageMime(bytes) {
  const buffer = Buffer.from(bytes ?? [])
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

const emptyUsage = () => ({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 })

export class VisionClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.baseUrl] - OpenAI-compatible root (`…/v1`).
   * @param {string} [options.apiKey] - model key; when absent the client is disabled.
   * @param {string} [options.model] - model name to request.
   * @param {number} [options.maxTokens] - answer cap for the description.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {string} [options.prompt] - instruction sent with the image.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch, injected by tests.
   */
  constructor({
    baseUrl = 'https://api.deepseek.com/v1',
    apiKey,
    model = 'deepseek-chat',
    maxTokens = 900,
    timeoutMs = 90_000,
    prompt = DEFAULT_VISION_PROMPT,
    logger,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.maxTokens = maxTokens
    this.timeoutMs = timeoutMs
    this.prompt = prompt
    this.logger = logger
    this.fetchImpl = fetchImpl
  }

  /** True when the client can actually make a call. */
  get enabled() {
    return Boolean(this.apiKey && this.baseUrl && this.fetchImpl)
  }

  /**
   * Describe one image.
   *
   * Never throws: a failure comes back as `{ text: '', error }` so the caller can
   * fall back to OCR or simply tell the user what happened.
   *
   * @param {object} request - `bytes` (image), optional `mime`, `prompt`, `signal`.
   * @returns {Promise<{text: string, usage: object, error?: string, durationMs: number}>}
   */
  async describe({ bytes, mime, prompt, signal } = {}) {
    const startedAt = Date.now()
    const usage = emptyUsage()
    if (!this.enabled) return { text: '', usage, error: 'vision отключён', durationMs: 0 }
    const image = Buffer.from(bytes ?? [])
    if (image.length === 0) return { text: '', usage, error: 'пустой файл изображения', durationMs: 0 }

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt ?? this.prompt },
          { type: 'image_url', image_url: { url: `data:${mime ?? sniffImageMime(image)};base64,${image.toString('base64')}` } },
        ],
      }],
    }

    let payload
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: requestSignal,
      })
      const text = await response.text()
      try {
        payload = JSON.parse(text)
      } catch {
        return { text: '', usage, error: `провайдер ответил не-JSON (HTTP ${response.status})`, durationMs: Date.now() - startedAt }
      }
      if (!response.ok || payload?.error) {
        const detail = payload?.error?.message ?? `HTTP ${response.status}`
        this.logger?.warn('vision request rejected', { status: response.status, detail: String(detail).slice(0, 200) })
        return { text: '', usage, error: String(detail).slice(0, 300), durationMs: Date.now() - startedAt }
      }
    } catch (error) {
      this.logger?.warn('vision request failed', { error })
      return { text: '', usage, error: `не удалось обратиться к модели (${String(error?.message ?? error).slice(0, 160)})`, durationMs: Date.now() - startedAt }
    }

    const raw = payload?.usage ?? {}
    usage.prompt_tokens = Number(raw.prompt_tokens) || 0
    usage.completion_tokens = Number(raw.completion_tokens) || 0
    usage.cached_tokens = Number(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens) || 0
    const content = payload?.choices?.[0]?.message?.content
    const description = typeof content === 'string' ? content.trim() : ''
    if (description === '') {
      return { text: '', usage, error: 'модель не дала описания изображения', durationMs: Date.now() - startedAt }
    }
    const durationMs = Date.now() - startedAt
    this.logger?.info('image described', { bytes: image.length, tokens: usage.prompt_tokens + usage.completion_tokens, durationMs })
    return { text: description, usage, durationMs }
  }
}
