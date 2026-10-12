/**
 * Text-to-speech for voice answers.
 *
 * Yandex SpeechKit v1 `tts:synthesize` with OGG/Opus output: that is exactly the
 * container Telegram expects for a voice message, so nothing has to be converted.
 * The same SpeechKit key that transcribes voice notes also synthesises them.
 */

const DEFAULT_ENDPOINT = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize'
const DEFAULT_VOICE = 'alena'
/** SpeechKit accepts up to 5000 characters; a shorter cap keeps answers listenable. */
const DEFAULT_MAX_CHARS = 1200

/**
 * Turn an answer into speech.
 *
 * Markdown is stripped first: reading asterisks, hashes and links aloud is noise.
 *
 * @param {object} options - provider options.
 * @param {string} options.apiKey - SpeechKit API key.
 * @param {string} [options.folderId] - cloud folder id, when the key needs one.
 * @param {string} [options.voice] - `alena`, `filipp`, `jane`, `zahar`, …
 * @param {number} [options.speed] - 0.1 … 3.0.
 * @param {number} [options.maxChars] - truncation limit for one answer.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @returns {(text: string) => Promise<Buffer>} synthesiser, or throws on failure.
 */
export function createSynthesizer({
  apiKey,
  folderId = '',
  voice = DEFAULT_VOICE,
  speed = 1,
  maxChars = DEFAULT_MAX_CHARS,
  timeoutMs = 60_000,
  logger,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
} = {}) {
  if (!apiKey) throw new Error('TTS requires an API key')

  return async function synthesize(text) {
    const spoken = speechText(text, maxChars)
    if (spoken === '') throw new Error('nothing to say')
    const query = new URLSearchParams({ lang: 'ru-RU', voice, format: 'oggopus', speed: String(speed) })
    if (folderId) query.set('folderId', folderId)
    const response = await fetchImpl(`${endpoint}?${query}`, {
      method: 'POST',
      headers: { authorization: `Api-Key ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: spoken }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      logger?.warn('speech synthesis failed', { status: response.status })
      throw new Error(`TTS HTTP ${response.status}: ${detail}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) throw new Error('TTS returned no audio')
    return bytes
  }
}

/**
 * Prepare an answer for reading aloud.
 *
 * @param {string} text - the answer as shown to the user.
 * @param {number} [maxChars] - truncation limit.
 * @returns {string} plain text without markdown, links or code fences.
 */
export function speechText(text, maxChars = DEFAULT_MAX_CHARS) {
  let value = String(text ?? '')
    // Fenced code blocks: reading code aloud is useless, say so instead.
    .replace(/```[\s\S]*?```/g, ' (код пропущен) ')
    .replace(/`([^`]+)`/g, '$1')
    // Links keep their label: "смотри [тут](https://…)" reads as "смотри тут".
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')
    // Bare URLs become the word "ссылка".
    .replace(/https?:\/\/\S+/g, 'ссылка')
    .replace(/[*_#>]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim()
  if (value.length > maxChars) {
    value = `${value.slice(0, maxChars).replace(/\s+\S*$/, '')}. Дальше — текстом.`
  }
  return value
}
