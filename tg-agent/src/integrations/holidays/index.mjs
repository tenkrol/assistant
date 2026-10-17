/**
 * Official public holidays, from the free Nager.Date API.
 *
 * Design notes:
 *   - the whole year is fetched once and cached, so the digest does not depend on
 *     a network call every morning;
 *   - "today" is the configured time zone, not UTC: a holiday starts at local
 *     midnight for the person reading the message;
 *   - every failure is reported as text, never thrown: a holiday lookup must not
 *     be able to break an answer or the digest.
 */

import { connectionError, deadlineSignal } from '../connection.mjs'

const DEFAULT_BASE_URL = 'https://date.nager.at/api/v3'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000

/** Local date of `date` in `timeZone`, as `YYYY-MM-DD`. */
function localDate(date, timeZone) {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** "4 ноября" — a short human date for the same zone. */
function humanDate(isoDate, timeZone, locale = 'ru-RU') {
  const [year, month, day] = isoDate.split('-').map(Number)
  const instant = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return new Intl.DateTimeFormat(locale, { timeZone: timeZone || 'UTC', day: 'numeric', month: 'long' }).format(instant)
}

/** Whole days between two `YYYY-MM-DD` dates. */
function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`)
  const to = Date.parse(`${toIso}T00:00:00Z`)
  return Math.round((to - from) / 86_400_000)
}

/** OpenAI-compatible tool definition. */
export const HOLIDAYS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'holidays',
    description:
      'Официальные государственные праздники и выходные: какие праздники сегодня, когда ближайший, что за праздник в конкретную дату. '
      + 'Используй для вопросов «какой сегодня праздник», «когда следующий выходной», «есть ли праздник 4 ноября».',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата в формате YYYY-MM-DD. Если не указана — сегодня.' },
        country: { type: 'string', description: 'Код страны из двух букв, по умолчанию RU.' },
      },
      additionalProperties: false,
    },
  },
}

/**
 * Build the holidays tool.
 *
 * @param {object} [options] - dependencies.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {object} [options.logger] - logger.
 * @param {string} [options.country] - default ISO country code.
 * @param {string} [options.timeZone] - zone that defines "today".
 * @param {string} [options.baseUrl] - API root, overridable for tests.
 * @param {() => Date} [options.now] - clock, injected by tests.
 * @returns {object} `{ definition, execute, holidaysOn, nextHoliday }`.
 */
export function createHolidaysTool({
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  logger,
  country = 'RU',
  timeZone = '',
  baseUrl = DEFAULT_BASE_URL,
  now = () => new Date(),
} = {}) {
  /** @type {Map<string, {at: number, days: Array<{date: string, localName: string}>}>} */
  const cache = new Map()

  const loadYear = async (year, code) => {
    const key = `${code}-${year}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.days
    const response = await fetchImpl(`${baseUrl}/PublicHolidays/${year}/${code}`, { signal: deadlineSignal(timeoutMs) })
    if (!response.ok) throw connectionError(`HTTP ${response.status}`, { provider: 'holidays', status: response.status })
    const days = await response.json()
    if (!Array.isArray(days)) throw new Error('unexpected response')
    const clean = days
      .filter((entry) => typeof entry?.date === 'string')
      .map((entry) => ({ date: entry.date, localName: String(entry.localName ?? entry.name ?? 'праздник') }))
    cache.set(key, { at: Date.now(), days: clean })
    return clean
  }

  /** Holidays of the year that contains `date`, for one country. */
  const yearHolidays = async (date, code) => {
    const year = Number(localDate(date, timeZone).slice(0, 4))
    const [current, nextYear] = await Promise.all([
      loadYear(year, code),
      // The next holiday may already be in January of the following year.
      loadYear(year + 1, code).catch(() => []),
    ])
    return [...current, ...nextYear]
  }

  /** Holidays that fall on the local date of `date`. */
  const holidaysOn = async (date = now(), code = country) => {
    const today = localDate(date, timeZone)
    const all = await yearHolidays(date, code)
    return all.filter((entry) => entry.date === today)
  }

  /** The next holiday strictly after the local date of `date`. */
  const nextHoliday = async (date = now(), code = country) => {
    const today = localDate(date, timeZone)
    const all = await yearHolidays(date, code)
    return all.filter((entry) => entry.date > today).sort((a, b) => a.date.localeCompare(b.date))[0]
  }

  return {
    definition: HOLIDAYS_TOOL_DEFINITION,
    holidaysOn,
    nextHoliday,
    /**
     * Textual answer for the model.
     *
     * @param {object} args - `date` and `country`, both optional.
     * @returns {Promise<string>} never throws.
     */
    async execute({ date, country: code } = {}) {
      try {
        const when = typeof date === 'string' && date.trim() !== '' ? new Date(`${date.trim()}T12:00:00Z`) : now()
        if (Number.isNaN(when.getTime())) return 'Ошибка инструмента holidays: не удалось разобрать дату, нужен формат YYYY-MM-DD.'
        const iso = localDate(when, timeZone)
        const holidays = await holidaysOn(when, code ?? country)
        const nearest = await nextHoliday(when, code ?? country)
        const lines = []
        if (holidays.length > 0) {
          lines.push(`${humanDate(iso, timeZone)} — ${holidays.map((entry) => entry.localName).join(', ')}.`)
        } else {
          lines.push(`${humanDate(iso, timeZone)} — официальных праздников нет.`)
        }
        if (nearest) {
          const days = daysBetween(iso, nearest.date)
          lines.push(`Ближайший: ${humanDate(nearest.date, timeZone)} — ${nearest.localName}${days > 0 ? ` (через ${days} дн.)` : ''}.`)
        }
        return lines.join(' ')
      } catch (error) {
        logger?.warn('holidays lookup failed', { error })
        return `Ошибка инструмента holidays: не удалось получить данные (${error.message}).`
      }
    },
  }
}
