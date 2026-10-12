/**
 * Speech-to-text for incoming voice messages.
 *
 * OpenAI-compatible `/audio/transcriptions` is the contract: it covers OpenAI
 * Whisper itself and every self-hosted or proxied clone that speaks the same
 * shape, so the provider is a base URL plus a key.
 *
 * The transcriber never throws: a failed voice note becomes a note to the user.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'whisper-1'

/**
 * Build an OpenAI-compatible transcriber.
 *
 * @param {object} options - provider options.
 * @param {string} options.apiKey - provider key.
 * @param {string} [options.baseUrl] - API root.
 * @param {string} [options.model] - model name.
 * @param {string} [options.language] - language hint, `ru` by default.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @returns {(bytes: Buffer|Uint8Array, info?: object) => Promise<string>} transcriber.
 */
export function createOpenAiTranscriber({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  language = 'ru',
  timeoutMs = 60_000,
  logger,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('STT requires an API key')
  const root = baseUrl.replace(/\/+$/, '')

  return async function transcribe(bytes, info = {}) {
    const form = new FormData()
    const name = info.name ?? (info.mime === 'audio/ogg' ? 'voice.ogg' : 'voice.m4a')
    form.append('file', new Blob([bytes], { type: info.mime ?? 'audio/ogg' }), name)
    form.append('model', model)
    if (language) form.append('language', language)
    const response = await fetchImpl(`${root}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      // The body may name the reason (bad key, unsupported format); it never
      // contains the key itself.
      const detail = (await response.text()).slice(0, 200)
      logger?.warn('transcription failed', { status: response.status })
      throw new Error(`STT HTTP ${response.status}: ${detail}`)
    }
    const payload = await response.json()
    return String(payload?.text ?? '').trim()
  }
}
/**
 * Yandex SpeechKit v1: short audio (`stt:recognize`).
 *
 * Telegram voice notes are OGG/Opus, which this endpoint accepts as-is, so no
 * conversion is needed. The key may be an API key (`Api-Key` header) or an IAM
 * token (`Bearer`); both need the folder id of the Yandex Cloud folder.
 *
 * Limit: one request up to 30 seconds and about 1 MB. Longer recordings need the
 * asynchronous v2 API, which this bot does not use — a longer voice note is
 * reported as "could not recognise" instead of being silently dropped.
 *
 * @param {object} options - provider options.
 * @param {string} options.apiKey - API key or IAM token.
 * @param {string} [options.folderId] - Yandex Cloud folder id.
 * @param {string} [options.language] - language, `ru-RU` by default.
 * @param {string} [options.model] - `general` or `general:rc`.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @returns {(bytes: Buffer|Uint8Array, info?: object) => Promise<string>} transcriber.
 */
export function createYandexTranscriber({
  apiKey,
  folderId = '',
  language = 'ru-RU',
  model = 'general',
  timeoutMs = 60_000,
  logger,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('Yandex STT requires an API key')
  const root = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize'
  // An IAM token is a JWT; a service-account API key starts with `AQVN`.
  const authorization = apiKey.startsWith('AQVN') ? `Api-Key ${apiKey}` : `Bearer ${apiKey}`

  return async function transcribe(bytes, info = {}) {
    const query = new URLSearchParams({ lang: yandexLanguage(language), topic: 'general', format: yandexFormat(info.mime, info.name) })
    if (folderId) query.set('folderId', folderId)
    if (model === 'general:rc') query.set('model', 'general:rc')
    const response = await fetchImpl(`${root}?${query}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    if (!response.ok) {
      logger?.warn('transcription failed', { status: response.status })
      throw new Error(`Yandex STT HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error('Yandex STT returned an unreadable answer')
    }
    return String(payload?.result ?? '').trim()
  }
}

/**
 * SpeechKit wants a full locale: a bare `ru` returns an error, so it is expanded.
 *
 * @param {string} language - configured language.
 * @returns {string} a SpeechKit language tag.
 */
function yandexLanguage(language) {
  const value = String(language ?? '').trim()
  if (value === '') return 'ru-RU'
  if (value.includes('-')) return value
  const expanded = { ru: 'ru-RU', en: 'en-US', kk: 'kk-KK', uz: 'uz-UZ', tr: 'tr-TR', de: 'de-DE' }
  return expanded[value] ?? value
}

/** Yandex names the container format itself. */
function yandexFormat(mime, name) {
  const value = `${mime ?? ''} ${name ?? ''}`.toLowerCase()
  if (value.includes('mp3') || value.includes('mpeg')) return 'mp3'
  if (value.includes('wav') || value.includes('lpcm')) return 'lpcm'
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) return 'mp4'
  // Telegram voice notes are OGG/Opus, which is the common case.
  return 'oggopus'
}

/**
 * Pick the transcriber for the configured provider.
 *
 * @param {object} options - `{provider, ...provider options}`.
 * @returns {Function} a transcriber.
 */
export function createTranscriber({ provider = 'openai', ...options } = {}) {
  if (provider === 'yandex') return createYandexTranscriber(options)
  return createOpenAiTranscriber(options)
}
