/**
 * Web tools for the bot: native DeepSeek search plus a plain HTTP page reader.
 *
 * DeepSeek exposes no dedicated search endpoint. Its documented entry point is a
 * server-side tool (`web_search_20250305`) on the Anthropic-compatible Messages
 * API, which returns structured `web_search_tool_result` blocks; the same shape
 * the harness itself consumes. One search therefore costs a full model turn,
 * which the tool description tells the model to spend sparingly.
 *
 * `web_fetch` is an ordinary GET with the usual private-address guard: the bot
 * usually runs next to other local services (the DSH GUI is on 127.0.0.1), and a
 * page URL suggested by a model must never reach them.
 */

const DEFAULT_SEARCH_BASE_URL = 'https://api.deepseek.com/anthropic/v1'
const DEFAULT_SEARCH_MODEL = 'deepseek-v4-flash'
const DEFAULT_API_VERSION = '2023-06-01'
const MAX_SUMMARY_CHARS = 1500
const MAX_SNIPPET_CHARS = 400

/** Error carrying the failing tool and, when available, the HTTP status. */
export class WebToolError extends Error {
  constructor(message, { tool, status, cause } = {}) {
    super(message, { cause })
    this.name = 'WebToolError'
    this.tool = tool
    this.status = status
  }
}

/** OpenAI-compatible tool definitions handed to the chat model. */
export const WEB_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Найти свежую информацию в интернете: новости, курсы, цены, события, расписания, свежие версии. Для погоды вызывай инструмент weather, а не этот поиск: выдача поиска закеширована и даёт прогноз на неверный день.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Поисковый запрос на языке пользователя.' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Прочитать текст веб-страницы по ссылке. Вызывай, когда нужны детали со страницы, найденной через web_search.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Полный URL, начинающийся с http:// или https://' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
]

/**
 * Build the tool executor used by the chat model.
 *
 * @param {object} options - tool options.
 * @param {string} options.apiKey - DeepSeek key, shared with the chat model.
 * @param {string} [options.searchBaseUrl] - Anthropic-compatible base, `/messages` is appended.
 * @param {string} [options.searchModel] - model used for the server-side search turn.
 * @param {number} [options.maxUses] - server-side searches allowed per call.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {number} [options.maxFetchBytes] - page bytes read before truncation.
 * @param {string[]} [options.allowedHosts] - hosts allowed despite being private (an intranet wiki, or a test stub).
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {object} [options.logger] - logger.
 */
export function createWebTools({
  apiKey,
  searchBaseUrl = DEFAULT_SEARCH_BASE_URL,
  searchModel = DEFAULT_SEARCH_MODEL,
  maxUses = 3,
  timeoutMs = 45000,
  maxFetchBytes = 200_000,
  allowedHosts = [],
  extraTools = [],
  fetchImpl = globalThis.fetch,
  logger,
}) {
  const call = async (url, init, tool, signal) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal })
    } catch (error) {
      throw new WebToolError(`${tool} failed: ${error?.message ?? error}`, { tool, cause: error })
    }
  }

  /** Run one native search and flatten the structured result for the model. */
  const webSearch = async ({ query }, signal) => {
    if (typeof query !== 'string' || query.trim() === '') throw new WebToolError('web_search needs a query', { tool: 'web_search' })
    const response = await call(`${searchBaseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': DEFAULT_API_VERSION,
      },
      body: JSON.stringify({
        model: searchModel,
        max_tokens: 2048,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
      }),
    }, 'web_search', signal)

    const raw = await response.text()
    if (!response.ok) {
      throw new WebToolError(`web_search failed with HTTP ${response.status}: ${raw.slice(0, 200)}`, { tool: 'web_search', status: response.status })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new WebToolError('web_search returned a non-JSON body', { tool: 'web_search', status: response.status })
    }
    const blocks = Array.isArray(parsed.content) ? parsed.content : []
    const results = blocks.filter((block) => block?.type === 'web_search_tool_result').flatMap((block) => block.content ?? [])
    const snippets = citationSnippets(blocks)
    const summary = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()

    if (results.length === 0 && summary === '') {
      throw new WebToolError('web_search produced neither results nor text', { tool: 'web_search' })
    }
    logger?.debug('web_search done', { query, sources: results.length })

    const lines = []
    if (summary !== '') lines.push('Сводка:', truncate(summary, MAX_SUMMARY_CHARS), '')
    lines.push(`Источники (${results.length}):`)
    const seen = new Set()
    let index = 0
    for (const item of results) {
      if (!item?.url || seen.has(item.url)) continue
      seen.add(item.url)
      index++
      const snippet = snippets.get(item.url)
      lines.push(`${index}. ${item.title ?? item.url}`)
      lines.push(`   ${item.url}${item.page_age ? ` (${item.page_age})` : ''}`)
      if (snippet) lines.push(`   ${truncate(snippet, MAX_SNIPPET_CHARS)}`)
    }
    return lines.join('\n')
  }

  /** Fetch one page and return readable text. */
  const webFetch = async ({ url }, signal) => {
    const target = assertPublicUrl(url, { allowedHosts })
    const response = await call(target, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; tg-agent/0.1; +https://github.com/deepseek-ai/deepseek-harness)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
        'accept-language': 'ru,en;q=0.8',
      },
    }, 'web_fetch', signal)
    if (!response.ok) {
      throw new WebToolError(`web_fetch failed with HTTP ${response.status}`, { tool: 'web_fetch', status: response.status })
    }
    const contentType = response.headers.get('content-type') ?? ''
    const { text: body, bytes } = await readLimited(response, maxFetchBytes)
    logger?.debug('web_fetch done', { url: target, contentType, bytes })
    if (contentType.includes('json') || contentType.startsWith('text/plain')) return truncate(body.trim(), MAX_SUMMARY_CHARS * 2)
    return truncate(htmlToText(body), MAX_SUMMARY_CHARS * 2)
  }

  const definitions = [...WEB_TOOL_DEFINITIONS, ...extraTools.map((tool) => tool.definition)]
  const names = definitions.map((definition) => definition.function.name).join(', ')

  return {
    definitions,
    /** Execute one tool call; unknown names are reported to the model, not thrown. */
    async execute(name, args, { signal } = {}) {
      try {
        if (name === 'web_search') return await webSearch(args ?? {}, signal)
        if (name === 'web_fetch') return await webFetch(args ?? {}, signal)
        const extra = extraTools.find((tool) => tool.definition?.function?.name === name)
        if (extra) return await extra.execute(args ?? {}, signal)
        return `Инструмент ${name} не поддерживается. Доступны: ${names}.`
      } catch (error) {
        logger?.warn('web tool failed', { tool: name, error })
        return `Ошибка инструмента ${name}: ${error?.message ?? error}`
      }
    },
  }
}

/** Map `cited_text` to its URL so search results carry an excerpt. */
function citationSnippets(blocks) {
  const map = new Map()
  for (const block of blocks) {
    for (const citation of block?.citations ?? []) {
      if (typeof citation?.url === 'string' && typeof citation?.cited_text === 'string' && citation.cited_text.length > 0 && !map.has(citation.url)) {
        map.set(citation.url, citation.cited_text)
      }
    }
  }
  return map
}

/**
 * Read at most `maxBytes` of a response body.
 *
 * The body is streamed and cancelled once the cap is reached, so a huge page
 * cannot be buffered whole. A multi-byte sequence cut by the limit decodes to a
 * replacement character instead of throwing.
 *
 * @param {Response} response - fetch response with an optional body stream.
 * @param {number} maxBytes - hard cap on bytes consumed.
 * @returns {Promise<{text: string, bytes: number}>}
 */
async function readLimited(response, maxBytes) {
  if (typeof response.body?.getReader !== 'function') {
    const text = await response.text()
    return { text: text.slice(0, maxBytes), bytes: Math.min(text.length, maxBytes) }
  }
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    received += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const buffer = Buffer.concat(chunks).subarray(0, maxBytes)
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), bytes: buffer.byteLength }
}

/**
 * Reject anything that is not a public http(s) address.
 *
 * The bot runs on the same host as the DSH GUI and other loopback services, so a
 * model-supplied URL must not be able to reach them. `allowedHosts` is the
 * deliberate escape hatch for an intranet host the owner trusts (and for tests).
 *
 * @param {string} value - URL from the model.
 * @param {object} [options] - `allowedHosts` lists hosts exempt from the private-address rule.
 * @returns {string} the normalized URL.
 */
export function assertPublicUrl(value, { allowedHosts = [] } = {}) {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    throw new WebToolError('web_fetch needs an absolute http(s) URL', { tool: 'web_fetch' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebToolError(`web_fetch supports only http(s), got ${parsed.protocol}`, { tool: 'web_fetch' })
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blocked = host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === '::1'
    || host === '0.0.0.0'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(fc|fd|fe80)/i.test(host)
  const allowed = allowedHosts.some((entry) => {
    const candidate = String(entry).toLowerCase()
    return host === candidate || host.endsWith(`.${candidate}`)
  })
  if (blocked && !allowed) throw new WebToolError(`web_fetch refuses a private address: ${host}`, { tool: 'web_fetch' })
  return parsed.toString()
}

/** Strip scripts, styles and tags; collapse whitespace; decode common entities. */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
