/**
 * Общий помощник подключений: таймауты и единый вид ошибок.
 *
 * Каждое подключение в `src/integrations/` ходит в сеть через переданный
 * `fetchImpl`, принимает `timeoutMs` и не читает окружение самостоятельно.
 * Общее у всех провайдеров собрано здесь:
 *
 *   - `deadlineSignal` — сигнал запроса, который срабатывает по таймауту и
 *     учитывает внешнюю отмену;
 *   - `classifyError` / `isTemporaryStatus` — признак «временная/постоянная»
 *     ошибка: по нему понятно, стоит ли повторять запрос;
 *   - `ConnectionError` — ошибка с прежним текстом провайдера и полями
 *     `provider`, `status`, `temporary`, `kind`.
 *
 * Тексты ошибок не переписываются: помощник только классифицирует сбой,
 * поэтому публичное поведение подключений остаётся прежним.
 */

/** Коды сетевых сбоев Node, при которых повтор имеет смысл. */
const TEMPORARY_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * Временный ли HTTP-статус: таймаут, ранний сброс, лимит запросов или 5xx.
 *
 * @param {number|string} status - HTTP-статус ответа.
 * @returns {boolean} true, если запрос имеет смысл повторить.
 */
export function isTemporaryStatus(status) {
  const code = Number(status)
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599)
}

/**
 * Классифицировать сбой подключения.
 *
 * @param {unknown} error - ошибка сети, таймаута или ответа провайдера.
 * @param {object} [options] - уточнения.
 * @param {number|string} [options.status] - HTTP-статус, если он известен.
 * @returns {'temporary'|'permanent'} временная ошибка или постоянная.
 */
export function classifyError(error, { status } = {}) {
  const code = status ?? error?.status ?? error?.cause?.status
  if (isTemporaryStatus(code)) return 'temporary'
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'temporary'
  const systemCode = error?.code ?? error?.cause?.code
  if (TEMPORARY_CODES.has(systemCode)) return 'temporary'
  return 'permanent'
}

/**
 * Сигнал запроса: таймаут плюс необязательная внешняя отмена.
 *
 * @param {number} timeoutMs - сколько ждать ответа.
 * @param {AbortSignal} [signal] - сигнал вызывающего кода.
 * @returns {AbortSignal} сигнал для `fetch`.
 */
export function deadlineSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Сработал ли запрос именно по таймауту, а не по внешней отмене. */
export function isTimeoutError(error) {
  return error?.name === 'TimeoutError'
}

/** Отменил ли запрос вызывающий код. */
export function isAbortError(error) {
  return error?.name === 'AbortError'
}

/**
 * Единая ошибка подключения.
 *
 * Текст остаётся таким, каким его задал провайдер; добавлены только поля
 * классификации, чтобы вызывающий код мог решить, повторять ли операцию.
 */
export class ConnectionError extends Error {
  /**
   * @param {string} message - понятный текст ошибки.
   * @param {object} [details] - сведения о сбое.
   * @param {string} [details.provider] - имя подключения.
   * @param {number} [details.status] - HTTP-статус, если был ответ.
   * @param {boolean} [details.temporary] - временная ли ошибка.
   * @param {Error} [details.cause] - исходная ошибка.
   */
  constructor(message, { provider, status, temporary, cause } = {}) {
    super(message, { cause })
    this.name = 'ConnectionError'
    this.provider = provider
    this.status = status
    this.temporary = temporary ?? classifyError(cause ?? this, { status }) === 'temporary'
    this.kind = this.temporary ? 'temporary' : 'permanent'
  }
}

/**
 * Собрать ошибку подключения, не меняя её текст.
 *
 * @param {string} message - прежний текст ошибки провайдера.
 * @param {object} [details] - сведения для классификации.
 * @returns {ConnectionError} ошибка с полями `temporary` и `kind`.
 */
export function connectionError(message, details) {
  return new ConnectionError(message, details)
}
