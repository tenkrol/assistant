/**
 * The quick layer: answer a trivial request without starting a task.
 *
 * Every DSH run pays for the whole headless system prompt and tool set — about
 * 7 000 tokens and 4–5 seconds even for "сколько 2+2". A question that needs no
 * files, no internet and no programs should not cost that, so it is answered by
 * one small model call instead.
 *
 * The model itself decides, with a strict contract: answer the question, or say
 * `DSH` and the request goes to the executor. A wrong "quick" answer is cheap to
 * fix (`/retry` runs the same task through DSH), while a wrong "DSH" only costs
 * one extra small call.
 */

/** The only word the model may answer with when the executor is needed. */
export const ROUTE_TO_DSH = 'DSH'

/**
 * Words that mean "this needs hands": an artifact, the file system, the network
 * or installed programs. A request containing one of them skips the quick layer
 * and never pays for the classification call.
 */
export const TOOL_SIGNALS = [
  'файл', 'папк', 'документ', 'отчёт', 'отчет', 'презентац', 'таблиц', 'слайд',
  'docx', 'xlsx', 'pptx', 'pdf', 'csv', 'zip', 'архив',
  'фото', 'картинк', 'изображен', 'скан', 'скриншот', 'нарисуй', 'сгенерируй картинку',
  'скачай', 'найди', 'поищи', 'погугл', 'интернет', 'сайт', 'ссылк', 'курс', 'цен',
  'скрипт', 'код', 'программ', 'запусти', 'установи', 'скомпилир', 'почини', 'исправь',
  'переименуй', 'перемести', 'удали', 'создай', 'сделай', 'собери', 'конвертируй',
  'извлеки', 'распознай', 'проанализируй', 'посчитай', 'проверь', 'отправь', 'загрузи',
  'напомни', 'расписан', 'погод', 'новост', 'сравни', 'обнови', 'заполни',
]

/** What the quick layer is asked to do. */
export const DEFAULT_QUICK_PROMPT = [
  'Ты — быстрый слой ассистента при исполнителе задач.',
  'Если запрос можно полностью и правильно выполнить ответом из своих знаний — ответь по-русски, коротко и по делу',
  '(вопросы, объяснения, вычисления, советы, формулировки, переводы, разбор уже приведённого в запросе текста).',
  `Если для выполнения нужны файлы, интернет, программы, работа в папке, документ на выходе или уточнения — ответь ровно одним словом ${ROUTE_TO_DSH} и больше ничего.`,
  'Не выдумывай: не знаешь точно — отвечай DSH. Без вступлений и вежливости.',
].join(' ')

const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  steps: 0,
})

/**
 * Whether a request obviously needs the executor.
 *
 * A cheap pre-filter, not a classifier: it only has to be safe in one direction
 * (never send tool work to the quick layer), so anything doubtful returns true.
 *
 * @param {object} request - `text`, optional `attachments`.
 * @param {object} [options] - `maxChars`.
 * @returns {boolean} true when DSH must run.
 */
export function needsExecutor({ text = '', attachments = [] } = {}, { maxChars = 240 } = {}) {
  if (attachments.length > 0) return true
  const value = String(text).trim()
  if (value === '') return true
  if (value.length > maxChars) return true
  // A newline usually means a list of requirements, not one question.
  if (value.includes('\n')) return true
  const lower = value.toLowerCase()
  return TOOL_SIGNALS.some((signal) => lower.includes(signal))
}

/** What the planner is asked for: a short, checkable plan, not the work itself. */
export const DEFAULT_PLAN_PROMPT = [
  'Ты — планировщик при исполнителе задач. Составь короткий план выполнения задачи.',
  'Формат: 3–7 пунктов, каждый начинается с «- » и укладывается в одну строку, по-русски.',
  'Пиши только план: без вступлений, без пояснений, без самого результата.',
  'Если в задаче не хватает важного (что именно, для кого, в каком виде) — добавь последним пунктом `? вопрос`.',
].join(' ')

export class QuickClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.baseUrl] - OpenAI-compatible root (`…/v1`).
   * @param {string} [options.apiKey] - model key; without it the client is off.
   * @param {string} [options.model] - model to ask.
   * @param {number} [options.maxTokens] - answer cap.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {string} [options.prompt] - system instruction.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch, injected by tests.
   */
  constructor({
    baseUrl = 'https://api.deepseek.com/v1',
    apiKey,
    model = 'deepseek-flash',
    maxTokens = 700,
    timeoutMs = 60_000,
    prompt = DEFAULT_QUICK_PROMPT,
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

  /** True when the client can make a call. */
  get enabled() {
    return Boolean(this.apiKey && this.baseUrl && this.fetchImpl)
  }

  /**
   * Draft a plan for a task that is about to run.
   *
   * Planning is done by the cheap model on purpose: it is a sketch the owner
   * approves, while the executor still does the work. A DSH planning pass would
   * cost the whole headless overhead for that sketch.
   *
   * @param {object} request - `task`, optional `memory`, `signal`.
   * @returns {Promise<{plan: string, usage: object, error?: string, durationMs: number}>}
   */
  async plan({ task, memory = '', signal } = {}) {
    const startedAt = Date.now()
    const usage = emptyUsage()
    if (!this.enabled) return { plan: '', usage, error: 'быстрый слой выключен', durationMs: 0 }
    const facts = String(memory ?? '').trim()
    const system = facts === ''
      ? DEFAULT_PLAN_PROMPT
      : `${DEFAULT_PLAN_PROMPT}\nЧто уже известно о пользователе и его делах:\n${facts.slice(0, 2000)}`

    let payload
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: String(task ?? '') },
          ],
        }),
        signal: requestSignal,
      })
      const raw = await response.text()
      try {
        payload = JSON.parse(raw)
      } catch {
        return { plan: '', usage, error: `провайдер ответил не-JSON (HTTP ${response.status})`, durationMs: Date.now() - startedAt }
      }
      if (!response.ok || payload?.error) {
        const detail = payload?.error?.message ?? `HTTP ${response.status}`
        return { plan: '', usage, error: String(detail).slice(0, 200), durationMs: Date.now() - startedAt }
      }
    } catch (error) {
      if (signal?.aborted) return { plan: '', usage, error: 'отменено', durationMs: Date.now() - startedAt }
      this.logger?.warn('planner failed', { error })
      return { plan: '', usage, error: `модель недоступна (${String(error?.message ?? error).slice(0, 120)})`, durationMs: Date.now() - startedAt }
    }

    const raw = payload?.usage ?? {}
    usage.inputTokens = Number(raw.prompt_tokens) || 0
    usage.outputTokens = Number(raw.completion_tokens) || 0
    usage.cacheReadTokens = Number(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens) || 0
    usage.steps = 1
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens

    const content = payload?.choices?.[0]?.message?.content
    const plan = typeof content === 'string' ? content.trim() : ''
    return { plan, usage, durationMs: Date.now() - startedAt }
  }

  /**
   * Classify and, when the request is trivial, answer it.
   *
   * Never throws: any failure comes back as `routed: 'dsh'`, because the executor
   * can always do the work — the quick layer is only an optimisation.
   *
   * @param {object} request - `task` text, optional `memory`, `signal`.
   * @returns {Promise<{routed: 'quick'|'dsh', text: string, usage: object, error?: string, durationMs: number}>}
   */
  async answer({ task, memory = '', signal } = {}) {
    const startedAt = Date.now()
    const usage = emptyUsage()
    if (!this.enabled) return { routed: 'dsh', text: '', usage, error: 'быстрый слой выключен', durationMs: 0 }

    const facts = String(memory ?? '').trim()
    const system = facts === ''
      ? this.prompt
      : `${this.prompt}\nЧто уже известно о пользователе и его делах:\n${facts.slice(0, 2000)}`

    let payload
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: String(task ?? '') },
          ],
        }),
        signal: requestSignal,
      })
      const raw = await response.text()
      try {
        payload = JSON.parse(raw)
      } catch {
        return { routed: 'dsh', text: '', usage, error: `провайдер ответил не-JSON (HTTP ${response.status})`, durationMs: Date.now() - startedAt }
      }
      if (!response.ok || payload?.error) {
        const detail = payload?.error?.message ?? `HTTP ${response.status}`
        this.logger?.warn('quick layer rejected', { status: response.status, detail: String(detail).slice(0, 200) })
        return { routed: 'dsh', text: '', usage, error: String(detail).slice(0, 200), durationMs: Date.now() - startedAt }
      }
    } catch (error) {
      // A cancelled task must not be reported as a routing failure.
      if (signal?.aborted) return { routed: 'dsh', text: '', usage, error: 'отменено', durationMs: Date.now() - startedAt }
      this.logger?.warn('quick layer failed', { error })
      return { routed: 'dsh', text: '', usage, error: `модель недоступна (${String(error?.message ?? error).slice(0, 120)})`, durationMs: Date.now() - startedAt }
    }

    const raw = payload?.usage ?? {}
    usage.inputTokens = Number(raw.prompt_tokens) || 0
    usage.outputTokens = Number(raw.completion_tokens) || 0
    usage.cacheReadTokens = Number(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens) || 0
    usage.steps = 1
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens

    const content = payload?.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content.trim() : ''
    const upper = text.toUpperCase()

    // The contract is deliberately strict: only a bare `DSH` routes to the
    // executor, and an empty answer is treated as a failure to answer.
    if (text === '' || upper === ROUTE_TO_DSH || upper.startsWith(`${ROUTE_TO_DSH}\n`)) {
      return { routed: 'dsh', text: '', usage, durationMs: Date.now() - startedAt }
    }
    return { routed: 'quick', text, usage, durationMs: Date.now() - startedAt }
  }
}
