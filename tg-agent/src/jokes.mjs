/**
 * A source of fresh anecdotes (rzhunemogu.ru) plus the tool that exposes it.
 *
 * Design notes:
 *   - the endpoint answers in windows-1251 and its "JSON" contains raw newlines,
 *     so the payload is decoded explicitly and parsed defensively;
 *   - the previous joke is remembered and the source retries once, because "новый
 *     анекдот" every morning must not be the same anecdote every morning;
 *   - failures return `undefined`/text instead of throwing: a joke is decoration,
 *     the digest and the answer must survive without it.
 */

const DEFAULT_ENDPOINT = 'http://rzhunemogu.ru/RandJSON.aspx?CType=1'

/** OpenAI-compatible tool definition. */
export const JOKE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'joke',
    description:
      'Рассказать случайный анекдот. Используй, когда пользователь просит анекдот, шутку или хочет поднять настроение.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}

/** Pull `content` out of the provider's loosely-valid JSON. */
export function parseJoke(payload) {
  const text = String(payload ?? '').trim()
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.content === 'string' && parsed.content.trim() !== '') return parsed.content.trim()
  } catch {
    // The provider sometimes emits unescaped newlines, which JSON.parse rejects.
  }
  const match = /"content"\s*:\s*"([\s\S]*?)"\s*\}\s*$/.exec(text)
  const found = match?.[1]?.trim()
  return found === '' ? undefined : found
}

/**
 * Build the joke source.
 *
 * @param {object} [options] - dependencies.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 * @param {string} [options.endpoint] - API URL, overridable for tests.
 * @returns {{next: (attempts?: number) => Promise<string|undefined>, last: () => string|undefined}}
 */
export function createJokeSource({ fetchImpl = globalThis.fetch, timeoutMs = 15_000, logger, endpoint = DEFAULT_ENDPOINT } = {}) {
  let previous
  const fetchOnce = async () => {
    const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // The API declares windows-1251; decoding as UTF-8 would mangle every joke.
    const buffer = await response.arrayBuffer()
    const charset = /charset=([\w-]+)/i.exec(response.headers?.get?.('content-type') ?? '')?.[1] ?? 'windows-1251'
    let text
    try {
      text = new TextDecoder(charset).decode(buffer)
    } catch {
      text = new TextDecoder('windows-1251').decode(buffer)
    }
    return parseJoke(text)
  }

  return {
    last: () => previous,
    /**
     * Fetch a joke that differs from the previous one when possible.
     *
     * @param {number} [attempts] - how many tries before accepting a repeat.
     * @returns {Promise<string|undefined>} the joke, or `undefined` on failure.
     */
    async next(attempts = 2) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const joke = await fetchOnce()
          if (!joke) continue
          if (joke !== previous) {
            previous = joke
            return joke
          }
        } catch (error) {
          logger?.warn('joke fetch failed', { attempt, error })
          break
        }
      }
      return undefined
    },
  }
}

/**
 * Build the joke tool.
 *
 * @param {object} options - dependencies.
 * @param {ReturnType<typeof createJokeSource>} options.source - joke source.
 * @returns {{definition: object, execute: () => Promise<string>}}
 */
export function createJokeTool({ source }) {
  return {
    definition: JOKE_TOOL_DEFINITION,
    /** @returns {Promise<string>} the joke, or an error the model must relay. */
    async execute() {
      const joke = await source.next()
      return joke ?? 'Ошибка инструмента joke: не удалось получить анекдот, попробуйте позже.'
    },
  }
}
