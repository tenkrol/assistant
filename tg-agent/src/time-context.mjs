/**
 * Per-turn clock context.
 *
 * A chat model has no clock: asked for "today" it invented a date, and it then
 * labelled cached search results with that invented day — which is how a weather
 * answer ends up describing the wrong date. The context is rebuilt for every
 * request and is never written to the stored history, so it stays accurate for
 * long conversations.
 */

/**
 * Format the current moment for the model.
 *
 * @param {object} [options] - formatting options.
 * @param {Date} [options.now] - moment to describe, defaults to now.
 * @param {string} [options.timeZone] - IANA zone; empty means the system zone.
 * @param {string} [options.locale] - locale for names, defaults to ru-RU.
 * @returns {string} one line the model can rely on.
 */
export function formatTimeContext({ now = new Date(), timeZone = '', locale = 'ru-RU' } = {}) {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: zone,
  }).format(now)
  return `Сейчас: ${formatted} (${zone}). Считай эту дату и время верными: используй их для слов «сегодня», «сейчас», «вчера» и при проверке свежести найденных данных.`
}
