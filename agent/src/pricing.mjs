/**
 * What a task costs, in dollars, from the token counts we already have.
 *
 * DeepSeek bills `deepseek-flash` by three counters and two tariffs:
 *
 *   - input cache miss   $0.30 / 1M (peak), $0.15 (off-peak)
 *   - input cache hit    $0.006 / 1M (peak), $0.003 (off-peak)
 *   - output             $1.20 / 1M (peak), $0.60 (off-peak)
 *
 * Peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays; everything else,
 * weekends and Chinese public holidays included, is off-peak (half price).
 * Prices are configurable, because a provider is allowed to change them.
 *
 * The numbers stay honest in one direction: a run that starts before a peak
 * boundary is priced as peak if it crosses into one, and this estimate ignores
 * the balance/granted-token subtleties — it is what the tokens cost, not what
 * was deducted.
 */

/** Default tariffs in USD per 1M tokens, peak and off-peak. */
export const DEFAULT_PRICES = {
  inputPeak: 0.30,
  inputOffPeak: 0.15,
  cachedPeak: 0.006,
  cachedOffPeak: 0.003,
  outputPeak: 1.20,
  outputOffPeak: 0.60,
}

/** Default peak windows, in UTC, as `startHour-endHour` (end exclusive). */
export const DEFAULT_PEAK_WINDOWS = '01:00-04:00,06:00-10:00'

/**
 * Parse `"01:00-04:00,06:00-10:00"` into `[[1, 4], [6, 10]]`.
 *
 * @param {string} value - the configured windows.
 * @returns {Array<[number, number]>} hour pairs; malformed entries are dropped.
 */
export function parsePeakWindows(value = DEFAULT_PEAK_WINDOWS) {
  const windows = []
  for (const chunk of String(value).split(',')) {
    const match = chunk.trim().match(/^(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}$/)
    if (!match) continue
    const start = Number(match[1])
    const end = Number(match[2])
    if (start >= 0 && start <= 24 && end >= 0 && end <= 24 && start < end) windows.push([start, end])
  }
  return windows.length > 0 ? windows : parsePeakWindows(DEFAULT_PEAK_WINDOWS)
}

/**
 * Whether a moment falls into a peak tariff.
 *
 * @param {Date} date - the moment (UTC is what matters).
 * @param {object} [options] - `windows`, `weekdaysOnly`.
 * @returns {boolean} true for peak.
 */
export function isPeak(date = new Date(), { windows = DEFAULT_PEAK_WINDOWS, weekdaysOnly = true } = {}) {
  const day = date.getUTCDay()
  if (weekdaysOnly && (day === 0 || day === 6)) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return parsePeakWindows(windows).some(([start, end]) => hour >= start && hour < end)
}

/**
 * Cost of one usage record.
 *
 * Accepts either already-normalised counters (`{ uncachedInput, cachedInput, output }`)
 * or the DSH shape (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`).
 *
 * @param {object} usage - token counters.
 * @param {object} [options] - `date` (for the tariff), `prices`, `windows`, `weekdaysOnly`.
 * @returns {{usd: number, peak: boolean, tokens: object}} the estimate and the counters used.
 */
export function costOf(usage = {}, { date = new Date(), prices = DEFAULT_PRICES, windows = DEFAULT_PEAK_WINDOWS, weekdaysOnly = true } = {}) {
  const peak = isPeak(date, { windows, weekdaysOnly })
  // The DSH shape is recognised by any of its three counters: a record may
  // legitimately carry only `outputTokens`.
  const hasDshShape = usage.inputTokens !== undefined || usage.outputTokens !== undefined
    || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
  const tokens = hasDshShape
    ? {
      uncachedInput: (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0),
      cachedInput: Number(usage.cacheReadTokens) || 0,
      output: Number(usage.outputTokens) || 0,
    }
    : {
      uncachedInput: Number(usage.uncachedInput) || 0,
      cachedInput: Number(usage.cachedInput) || 0,
      output: Number(usage.output) || 0,
    }

  const inputPrice = peak ? prices.inputPeak : prices.inputOffPeak
  const cachedPrice = peak ? prices.cachedPeak : prices.cachedOffPeak
  const outputPrice = peak ? prices.outputPeak : prices.outputOffPeak
  const usd = (tokens.uncachedInput * inputPrice + tokens.cachedInput * cachedPrice + tokens.output * outputPrice) / 1_000_000
  return { usd, peak, tokens }
}

/** Cost of one day of the aggregated usage store (`prompt`, `completion`, `cached`). */
export function costOfDay(day = {}, options = {}) {
  const prompt = Number(day.prompt) || 0
  const cached = Number(day.cached) || 0
  return costOf({
    uncachedInput: Math.max(0, prompt - cached),
    cachedInput: cached,
    output: Number(day.completion) || 0,
  }, options)
}

/** Format dollars for a person: cents matter, fractions of a cent do not. */
export function formatUsd(usd) {
  const value = Number(usd) || 0
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}
