/**
 * Chat completions client for any OpenAI-compatible endpoint.
 *
 * The bot only needs one method: send a message list, get the assistant text
 * back. Provider-specific extras are deliberately not modelled, so the same
 * client works with DeepSeek, OpenAI, OpenRouter, a local llama.cpp server or a
 * company gateway that speaks the same schema.
 */
import { ConnectionError, deadlineSignal } from '../connection.mjs'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Error carrying the HTTP status and a readable provider message. */
export class ModelError extends ConnectionError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { provider: 'model', status, cause })
    this.name = 'ModelError'
    this.status = status
    this.body = body
  }
}

export class ChatModel {
  /**
   * @param {object} options - client options.
   * @param {string} options.baseUrl - provider root, without `/chat/completions`.
   * @param {string} options.apiKey - bearer token.
   * @param {string} options.name - default model id.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxAttempts] - attempts for retryable failures.
   * @param {number} [options.temperature] - optional sampling temperature.
   * @param {number} [options.maxTokens] - optional completion cap.
   * @param {(ms: number) => Promise<void>} [options.sleep] - injected by tests.
   */
  constructor({ baseUrl, apiKey, name, timeoutMs = 180000, fetchImpl = globalThis.fetch, logger, maxAttempts = 3, temperature, maxTokens, sleep = defaultSleep }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.name = name
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.maxAttempts = maxAttempts
    this.temperature = temperature
    this.maxTokens = maxTokens
    this.sleep = sleep
  }

  /**
   * Ask the model for one completion.
   *
   * @param {object} request - `messages` is the full conversation, system prompt included.
   * @param {string} [request.model] - overrides the default model id.
   * @param {AbortSignal} [request.signal] - cancels the HTTP call.
   * @returns {Promise<{text: string, model?: string, usage?: object}>}
   */
  /**
   * Ask the model for one completion, running tool calls when they are offered.
   *
   * @param {object} request - `messages` is the full conversation, system prompt included.
   * @param {string} [request.model] - overrides the default model id.
   * @param {AbortSignal} [request.signal] - cancels the HTTP call.
   * @param {object[]} [request.tools] - OpenAI-compatible tool definitions.
   * @param {(name: string, args: object, options: object) => Promise<string>} [request.executeTool] - runs one call.
   * @param {number} [request.maxToolRounds] - how many tool rounds one answer may take.
   * @param {object} [request.toolChoice] - forces the first request to call one tool
   *   (`{type:'function', function:{name}}`); later rounds choose freely.
   * @returns {Promise<{text: string, model?: string, usage?: object, toolCalls: number}>}
   */
  async complete({ messages, model = this.name, signal, tools, executeTool, maxToolRounds = 4, toolChoice, onDelta }) {
    const conversation = [...messages]
    const useTools = Array.isArray(tools) && tools.length > 0 && typeof executeTool === 'function'
    let toolCalls = 0
    // A tool-using answer is several requests; reporting only the last one would
    // hide most of the cost, so the usage of every round is summed.
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, requests: 0 }
    let last

    for (let round = 0; round <= (useTools ? maxToolRounds : 0); round++) {
      // The force applies to the first request only: after the tool ran, the
      // model must be free to answer in words.
      const choice = round === 0 && useTools ? toolChoice : undefined
      last = await this.request({ model, messages: conversation, tools: useTools ? tools : undefined, signal, toolChoice: choice, onDelta })
      usage = addUsage(usage, last.usage)
      const calls = last.message?.tool_calls
      if (!useTools || !Array.isArray(calls) || calls.length === 0 || round === maxToolRounds) {
        const text = last.message?.content
        if (typeof text !== 'string' || text.trim() === '') {
          // A tool round that produced only calls still ends with a text answer;
          // anything else is reported as an empty completion by the caller.
          return { text: typeof text === 'string' ? text : '', model: last.model, usage, toolCalls }
        }
        return { text, model: last.model, usage, toolCalls }
      }

      conversation.push({ role: 'assistant', content: last.message.content ?? '', tool_calls: calls })
      for (const call of calls) {
        toolCalls++
        const name = call.function?.name ?? 'unknown'
        let args = {}
        try {
          args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
          args = {}
        }
        this.logger?.info('tool call', { round, name, args })
        const result = await executeTool(name, args, { signal, round })
        conversation.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 20000) })
      }
    }
    return { text: '', model: last?.model, usage, toolCalls }
  }

  /**
   * One HTTP request with the retry policy, returning the raw assistant message.
   *
   * @param {object} request - payload pieces.
   * @returns {Promise<{message: object, model?: string, usage?: object}>}
   */
  async request({ model, messages, tools, signal, toolChoice, onDelta }) {
    // Streaming only when the caller asked for it: every other call stays a
    // plain request, and a non-streaming answer is handled either way.
    const payload = { model, messages, stream: Boolean(onDelta) }
    if (this.temperature !== undefined) payload.temperature = this.temperature
    if (this.maxTokens !== undefined) payload.max_tokens = this.maxTokens
    if (tools) payload.tools = tools
    if (tools && toolChoice) payload.tool_choice = toolChoice

    let lastError
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const requestSignal = deadlineSignal(this.timeoutMs, signal)
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(payload),
          signal: requestSignal,
        })
        const streaming = Boolean(onDelta) && (response.headers?.get?.('content-type') ?? '').includes('text/event-stream')
        if (streaming && response.ok) {
          return await readStream(response, onDelta, this.logger)
        }
        const raw = await response.text()
        if (!response.ok) {
          const error = new ModelError(describeFailure(response.status, raw), { status: response.status, body: raw.slice(0, 500) })
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxAttempts) {
            lastError = error
            this.logger?.warn('model request failed, retrying', { status: response.status, attempt })
            await this.sleep(backoff(attempt))
            continue
          }
          throw error
        }
        const parsed = raw === '' ? null : JSON.parse(raw)
        const message = parsed?.choices?.[0]?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          throw new ModelError('model response has no assistant text', { status: response.status, body: raw.slice(0, 500) })
        }
        return { message, model: parsed?.model, usage: parsed?.usage }
      } catch (error) {
        if (error instanceof ModelError && !(error.status === 429 || error.status >= 500)) throw error
        if (signal?.aborted) throw error
        lastError = error
        if (attempt >= this.maxAttempts) break
        this.logger?.warn('model request errored, retrying', { attempt, error })
        await this.sleep(backoff(attempt))
      }
    }
    throw new ModelError(`model request failed after ${this.maxAttempts} attempts: ${lastError?.message}`, { cause: lastError })
  }
}

/**
 * Read an OpenAI-compatible SSE answer, reporting text as it arrives.
 *
 * Tool calls arrive as fragments: the name comes once, the arguments in pieces,
 * both keyed by `index`. They are reassembled here so the tool loop upstream
 * sees exactly the same shape as in a non-streaming reply.
 *
 * @param {Response} response - streaming response.
 * @param {(chunk: string) => void} onDelta - called with each text fragment.
 * @param {object} [logger] - logger.
 * @returns {Promise<{message: object, model?: string, usage?: object}>} the full message.
 */
export async function readStream(response, onDelta, logger) {
  const decoder = new TextDecoder()
  const message = { role: 'assistant', content: '', tool_calls: [] }
  let usage
  let model
  let buffer = ''
  const flushEvent = (event) => {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        logger?.debug('unparseable stream chunk')
        continue
      }
      model = parsed?.model ?? model
      usage = parsed?.usage ?? usage
      const delta = parsed?.choices?.[0]?.delta
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content !== '') {
        message.content += delta.content
        onDelta(delta.content)
      }
      for (const call of delta.tool_calls ?? []) {
        const index = Number(call.index ?? 0)
        message.tool_calls[index] ??= { id: call.id ?? `call_${index}`, type: 'function', function: { name: '', arguments: '' } }
        if (call.id) message.tool_calls[index].id = call.id
        if (call.function?.name) message.tool_calls[index].function.name += call.function.name
        if (call.function?.arguments) message.tool_calls[index].function.arguments += call.function.arguments
      }
    }
  }

  for await (const chunk of response.body ?? []) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      flushEvent(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim() !== '') flushEvent(buffer)
  if (message.tool_calls.length === 0) delete message.tool_calls
  if (typeof message.content !== 'string') message.content = ''
  return { message, model, usage }
}

/** Turn a provider error body into one readable line. */
function describeFailure(status, raw) {
  let detail = raw.slice(0, 300)
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.error?.message ?? parsed?.message ?? detail
  } catch {
    // non-JSON body: keep the raw prefix
  }
  if (status === 401 || status === 403) return `provider rejected the API key (HTTP ${status}): ${detail}`
  if (status === 404) return `provider has no such endpoint or model (HTTP 404): ${detail}`
  if (status === 429) return `provider rate limited the request (HTTP 429): ${detail}`
  return `provider error (HTTP ${status}): ${detail}`
}

const backoff = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 15000)

/**
 * Sum two provider usage payloads (a tool-using answer is several requests).
 *
 * @param {object} base - accumulated counters.
 * @param {object} [next] - one more provider payload.
 * @returns {object} the sum, in the provider's field names.
 */
export function addUsage(base, next) {
  const prompt = Number(next?.prompt_tokens ?? next?.input_tokens ?? 0) || 0
  const completion = Number(next?.completion_tokens ?? next?.output_tokens ?? 0) || 0
  const cached = Number(next?.prompt_cache_hit_tokens ?? next?.prompt_tokens_details?.cached_tokens ?? 0) || 0
  return {
    prompt_tokens: (base?.prompt_tokens ?? 0) + prompt,
    completion_tokens: (base?.completion_tokens ?? 0) + completion,
    total_tokens: (base?.total_tokens ?? 0) + (prompt + completion),
    prompt_cache_hit_tokens: (base?.prompt_cache_hit_tokens ?? 0) + cached,
    prompt_cache_miss_tokens: (base?.prompt_cache_miss_tokens ?? 0) + Math.max(0, prompt - cached),
    ...(next ? { requests: (base?.requests ?? 0) + 1 } : {}),
  }
}
