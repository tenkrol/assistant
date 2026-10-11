/**
 * The morning digest: weather, today's reminders and optional topics, sent to
 * each configured chat once a day at a local wall-clock time.
 *
 * Design notes:
 *   - the next run is computed in the configured time zone, so "08:00" means
 *     08:00 for the person reading it even after a DST change;
 *   - a missed run is not replayed: a digest from yesterday is noise, and the
 *     process may have been down for hours;
 *   - every part is optional: a failure of the weather tool or of a search must
 *     not stop the digest from being sent.
 */
import { dayKey } from './usage.mjs'
import { zonedTimeToUtc } from './reminders.mjs'
import { churchHolidays, folkHolidays, healthTip } from './calendar.mjs'

const MAX_TOPICS = 3
/** A wall-clock time the scheduler can actually use. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const TOPIC_EXCERPT = 400
/** The general news block may be a little longer than one topic. */
const NEWS_EXCERPT = 700

/** Local date `YYYY-MM-DD` of the day after `key`. */
function nextDayKey(key, timeZone) {
  // Noon UTC is far from any DST edge, so a plain 24-hour step is safe here.
  const noon = new Date(`${key}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(noon.getTime() + 86_400_000))
}

export class DigestService {
  /**
   * @param {object} options - service options.
   * @param {object} options.deliver - `(chatId, markdown) => Promise<void>`.
   * @param {object} [options.weather] - weather tool (`execute({city})`).
   * @param {object} [options.reminders] - reminder store, or the wrapper holding it.
   * @param {object} [options.profiles] - profile store, for the city and the name.
   * @param {(query: string) => Promise<string>} [options.search] - web search call.
   * @param {object} [options.holidays] - holidays tool (`holidaysOn`, `nextHoliday`).
   * @param {object} [options.jokes] - joke source (`next()`).
   * @param {object} [options.logger] - logger.
   * @param {string} [options.timeZone] - IANA zone for the schedule and the dates.
   * @param {string} [options.time] - local `HH:MM` when the digest is sent.
   * @param {string[]} [options.chatIds] - chats to send to.
   * @param {string[]} [options.topics] - search queries for the news section.
   * @param {boolean} [options.news] - add a general news summary.
   * @param {boolean} [options.joke] - add a joke of the day.
   * @param {() => Date} [options.now] - clock, injected by tests.
   */
  constructor({ deliver, weather, alerts, reminders, events, profiles, search, holidays, jokes, logger, timeZone = '', time = '08:00', chatIds = [], topics = [], news = false, joke = true, now = () => new Date() }) {
    this.deliver = deliver
    this.weather = weather
    // Optional: returns short warnings for the city (rain, frost, heat, wind).
    this.alerts = alerts
    // Optional calendar: today's events, and what is coming tomorrow.
    this.events = events
    // Same for reminders: accept the store or the { store, tool, scheduler } wrapper.
    this.reminders = reminders?.store ?? reminders
    // Accept both the store and the { store, tool } wrapper: the call site
    // should not have to remember which one this service wants.
    this.profiles = profiles?.store ?? profiles
    this.search = search
    this.holidays = holidays
    this.jokes = jokes
    this.news = news
    this.joke = joke
    this.logger = logger
    this.timeZone = timeZone
    // Range-checked, not just shaped: '25:99' would throw later, inside the
    // scheduler, and take the whole bot process down with it.
    this.time = TIME_PATTERN.test(String(time ?? '')) ? time : '08:00'
    this.chatIds = chatIds
    this.topics = topics.slice(0, MAX_TOPICS)
    this.now = now
    this.timer = undefined
  }

  /** The zone used for dates and for the schedule. */
  get zone() {
    return this.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }

  /** When the digest should go out next. */
  nextRunAt(now = this.now()) {
    const key = dayKey(now, this.timeZone)
    let target = zonedTimeToUtc(`${key}T${this.time}`, this.timeZone)
    if (target.getTime() <= now.getTime()) target = zonedTimeToUtc(`${nextDayKey(key, this.zone)}T${this.time}`, this.timeZone)
    return target
  }

  /** Arm the daily timer; a no-op when there is nowhere to send. */
  start() {
    if (this.timer || this.chatIds.length === 0) return this
    const arm = () => {
      const next = this.nextRunAt()
      const delay = Math.max(1000, next.getTime() - this.now().getTime())
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.run()
        arm()
      }, delay)
      this.timer.unref?.()
      this.logger?.info('digest scheduled', { at: next.toISOString(), chats: this.chatIds.length, topics: this.topics.length })
    }
    arm()
    return this
  }

  /** Stop the timer (the pending digest is dropped). */
  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Build and send the digest to every configured chat. */
  async run() {
    for (const chatId of this.chatIds) {
      try {
        const text = await this.build(chatId)
        await this.deliver(chatId, text)
        this.logger?.info('digest sent', { chatId })
      } catch (error) {
        this.logger?.error('digest failed', { chatId, error })
      }
    }
  }

  /** The user's name, when a fact happens to hold it. */
  greeting(userId) {
    for (const fact of this.profiles?.facts(userId) ?? []) {
      const match = /(?:его|её|меня)?\s*зовут\s+([\p{L}-]{2,})/iu.exec(fact.text)
      if (match) return match[1][0].toUpperCase() + match[1].slice(1)
    }
    return undefined
  }

  /** Reminders of one chat that are due today (or later today by repeat). */
  todayReminders(chatId, now = this.now()) {
    const key = dayKey(now, this.timeZone)
    return (this.reminders?.list(chatId) ?? [])
      .filter((reminder) => dayKey(new Date(reminder.dueAt), this.timeZone) === key)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  }

  /**
   * Compose the digest for one chat.
   *
   * @param {number} chatId - target chat.
   * @param {number} [userId] - whose profile to read; defaults to the chat (a private chat).
   * @returns {Promise<string>} Markdown for `send()`.
   */
  async build(chatId, userId = chatId) {
    const now = this.now()
    const city = this.profiles?.city(userId)
    const date = new Intl.DateTimeFormat('ru-RU', { timeZone: this.zone, day: 'numeric', month: 'long', weekday: 'long' }).format(now)
    const name = this.greeting(userId)
    const lines = [`☀️ **Доброе утро${name ? `, ${name}` : ''}!** ${date}`, '']

    if (this.weather) {
      try {
        const answer = await this.weather.execute({ city: city ?? '' })
        lines.push('**Погода**', stripToolError(answer, city), '')
      } catch (error) {
        this.logger?.warn('digest weather failed', { error })
      }
    }

    // Warnings sit right under the forecast: they are the part people act on.
    if (this.alerts) {
      try {
        const warnings = await this.alerts(city ?? '')
        if (warnings.length > 0) lines.push("**⚠️ На что обратить внимание**", ...warnings.map((line) => `• ${line}`), '')
      } catch (error) {
        this.logger?.warn('digest alerts failed', { error })
      }
    }

    // The holiday line is always present: "праздников нет, ближайший такой-то"
    // is more useful than a section that silently disappears.
    const holidayLine = await this.holidayLine(now)
    if (holidayLine) lines.push('**Праздники**', holidayLine, '')

    // Church and folk days are computed locally: the official API only covers
    // the days off, and those are a small part of what people mark.
    const church = churchHolidays(now, this.zone)
    const folk = folkHolidays(now, this.zone)
    if (church.length > 0) lines.push('**Церковные праздники**', church.map((name) => `⛪ ${name}`).join('\n'), '')
    if (folk.length > 0) lines.push('**Народные и профессиональные**', folk.map((name) => `• ${name}`).join('\n'), '')

    // One everyday health habit, the same for the whole day and personal to the
    // reader: general advice only, never a diagnosis.
    const tip = healthTip(now, chatId, this.zone)
    if (tip) lines.push('**Совет для здоровья**', `${tip.tip[0].toUpperCase()}${tip.tip.slice(1)} — ${tip.why}.`, '')

    // Events come before reminders: they are fixed points of the day.
    const today = this.events?.store?.upcoming?.(chatId, { days: 1 }) ?? []
    const tomorrow = this.events?.store?.upcoming?.(chatId, { from: new Date(now.getTime() + 86_400_000), days: 1 }) ?? []
    if (today.length > 0 || tomorrow.length > 0) {
      lines.push('**События**')
      for (const event of today) lines.push(`— ${event.time} ${event.title}${event.place ? ` (${event.place})` : ''}`)
      if (today.length === 0) lines.push('— сегодня ничего')
      for (const event of tomorrow) lines.push(`— завтра ${event.time} ${event.title}`)
      lines.push('')
    }

    const reminders = this.todayReminders(chatId, now)
    lines.push('**Напоминания на сегодня**')
    if (reminders.length === 0) {
      lines.push('— на сегодня ничего не запланировано')
    } else {
      for (const reminder of reminders) {
        const time = new Intl.DateTimeFormat('ru-RU', { timeZone: this.zone, hour: '2-digit', minute: '2-digit' }).format(new Date(reminder.dueAt))
        const repeat = reminder.repeat === 'none' ? '' : reminder.repeat === 'daily' ? ' (каждый день)' : ' (каждую неделю)'
        lines.push(`— ${time} ${reminder.text}${repeat}`)
      }
    }

    const news = await this.newsBlock(now)
    if (news.length > 0) lines.push('', ...news)

    const joke = await this.jokeOfTheDay()
    if (joke) lines.push('', '**Анекдот дня**', joke)

    lines.push('', '_Хорошего дня. Список напоминаний — /reminders, настройки памяти — /memory._')
    return lines.join('\n')
  }

  /** Holidays that fall on the digest day; an empty array on any failure. */
  async todaysHolidays(now = this.now()) {
    if (!this.holidays?.holidaysOn) return []
    try {
      return await this.holidays.holidaysOn(now)
    } catch (error) {
      this.logger?.warn('digest holidays failed', { error })
      return []
    }
  }

  /** One line about holidays: today's, or the nearest one when today is empty. */
  async holidayLine(now = this.now()) {
    if (!this.holidays?.holidaysOn) return undefined
    try {
      const today = await this.holidays.holidaysOn(now)
      if (today.length > 0) return `🎉 Сегодня ${today.map((entry) => entry.localName).join(', ')}.`
      const nearest = await this.holidays.nextHoliday?.(now)
      if (!nearest) return 'Официальных праздников сегодня нет.'
      const date = new Intl.DateTimeFormat('ru-RU', { timeZone: this.zone, day: 'numeric', month: 'long' }).format(new Date(`${nearest.date}T12:00:00Z`))
      return `Официальных праздников сегодня нет. Ближайший — ${date}: ${nearest.localName}.`
    } catch (error) {
      this.logger?.warn('digest holidays failed', { error })
      return undefined
    }
  }

  /** A general news summary plus one block per configured topic. */
  async newsBlock(now = this.now()) {
    if (!this.search) return []
    // The result is the same for every recipient, so a digest run searches once
    // per day and also stops /digest from paying for a second identical search.
    const day = dayKey(now, this.timeZone)
    if (this.newsCache?.day === day) return this.newsCache.value
    const queries = []
    if (this.news) {
      const date = new Intl.DateTimeFormat('ru-RU', { timeZone: this.zone, day: 'numeric', month: 'long', year: 'numeric' }).format(now)
      queries.push({ title: 'Новости', query: `главные новости ${date}` })
    }
    for (const topic of this.topics) queries.push({ title: topic, query: topic })
    const found = []
    for (const item of queries) {
      try {
        const answer = await this.search(item.query)
        if (typeof answer === 'string' && answer.trim() !== '') {
          const limit = item.title === 'Новости' ? NEWS_EXCERPT : TOPIC_EXCERPT
          found.push(`**${item.title}**\n${cleanSearchText(answer).slice(0, limit)}`)
        }
      } catch (error) {
        this.logger?.warn('digest search failed', { query: item.query, error })
      }
    }
    this.newsCache = { day, value: found }
    return found
  }

  /** One fresh anecdote, or `undefined` when the source is off or unreachable. */
  async jokeOfTheDay(now = this.now()) {
    if (!this.joke || !this.jokes?.next) return undefined
    // Everyone gets the same joke of the day, and nobody pays for it twice.
    const day = dayKey(now, this.timeZone)
    if (this.jokeCache?.day === day) return this.jokeCache.value
    try {
      const joke = await this.jokes.next()
      this.jokeCache = { day, value: joke }
      return joke
    } catch (error) {
      this.logger?.warn('digest joke failed', { error })
      return undefined
    }
  }
}

/**
 * Search output arrives as markdown ("Сводка:", "# Заголовок"); Telegram would
 * show those characters literally, so they are stripped before the digest.
 */
function cleanSearchText(answer) {
  return String(answer ?? '')
    .replace(/^\s*Сводка:\s*/i, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Keep the weather answer readable and never show a raw tool error twice. */
function stripToolError(answer, city) {
  const text = String(answer ?? '').trim()
  // A tool error string is not a forecast: whoever reads the digest wants the
  // weather, and when there is none, a hint on how to fix it.
  if (text === '' || /^Ошибка инструмента/.test(text)) {
    if (/укажите город/i.test(text)) {
      return 'Город не задан — напишите `/city Москва` (или любой другой), и прогноз появится.'
    }
    return city ? `Не удалось получить погоду для «${city}».` : 'Не удалось получить погоду.'
  }
  return text
}
