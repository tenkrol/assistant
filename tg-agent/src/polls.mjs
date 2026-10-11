/**
 * Polls: a durable store of chat votes, the `poll` tool and the text helpers
 * the core uses to render a vote and its results.
 *
 * Design notes:
 *   - one poll is one message with one button per option; a press carries
 *     `poll:<id>:<index>`, so the core routes it without any in-memory map and
 *     a restart between the message and the tap changes nothing;
 *   - a vote is a list of user ids per option, and a user appears in at most one
 *     list: pressing another option *moves* the vote instead of adding a second
 *     one, which is what «проголосуем» in a family chat actually means;
 *   - the file is written atomically, exactly like the reminder store, so a
 *     restart never loses a vote that was already confirmed to the user;
 *   - `maxPolls` evicts the oldest *closed* polls only: an active vote is never
 *     dropped behind the user's back, even if that means the file temporarily
 *     grows past the cap;
 *   - nothing here throws at the caller: an invalid input is reported as
 *     `undefined` (store) or as a Russian sentence (tool).
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

/** Documented limits, shared by the store, the tool and the tests. */
export const MAX_QUESTION_LENGTH = 200
export const MAX_OPTION_LENGTH = 60
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 10

/** A voter id as platforms hand it over: a number in Telegram, a string elsewhere. */
const isUserId = (value) => typeof value === 'number' || typeof value === 'string'

/** Whether a stored option survived a round-trip through JSON. */
const isOption = (value) =>
  value != null
  && typeof value.text === 'string'
  && Array.isArray(value.votes)
  && value.votes.every(isUserId)

/** Poll in its stored shape. */
const isPoll = (value) =>
  value != null
  && typeof value.id === 'string'
  && typeof value.chatId === 'number'
  && typeof value.question === 'string'
  && Array.isArray(value.options)
  && value.options.length >= MIN_OPTIONS
  && value.options.every(isOption)
  && typeof value.createdAt === 'string'
  && (value.userId === undefined || isUserId(value.userId))
  && (value.closedAt === undefined || typeof value.closedAt === 'string')

/**
 * Trim incoming options, drop blanks and exact duplicates.
 *
 * Junk is dropped rather than rejected: a model that repeats one option must not
 * lose the whole poll. Too-long options are a separate, explicit rejection.
 *
 * @param {unknown} options - raw `options` argument.
 * @returns {string[]} cleaned texts, first occurrence wins.
 */
function cleanOptions(options) {
  if (!Array.isArray(options)) return []
  const seen = new Set()
  const cleaned = []
  for (const raw of options) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    cleaned.push(text)
  }
  return cleaned
}

/** One vote per person, in the order the votes were cast. */
const uniqueVotes = (votes) => {
  const seen = new Set()
  const unique = []
  for (const vote of votes) {
    const key = String(vote)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(vote)
  }
  return unique
}

/** How many distinct people voted in the whole poll. */
const voterCount = (poll) => {
  const voters = new Set()
  for (const option of poll.options) {
    for (const vote of option.votes) voters.add(String(vote))
  }
  return voters.size
}

export class PollStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxPolls] - polls kept after the oldest ones expire.
   */
  constructor({ file, logger, maxPolls = 100 }) {
    this.file = file
    this.logger = logger
    this.maxPolls = maxPolls
    /** @type {Array<{id: string, chatId: number, userId?: number|string, question: string, options: Array<{text: string, votes: Array<number|string>}>, createdAt: string, closedAt?: string}>} */
    this.polls = []
    this.nextId = 1
  }

  /** Read the file when it exists; a corrupt file is reported and replaced. */
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed?.version !== VERSION || !Array.isArray(parsed.polls)) throw new Error('unexpected file format')
      this.polls = parsed.polls.filter(isPoll)
      const highest = this.polls.reduce((max, poll) => Math.max(max, Number(poll.id) || 0), 0)
      this.nextId = Math.max(Number(parsed.nextId) || 0, highest + 1)
      this.logger?.info('polls loaded', { count: this.polls.length })
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn('poll file ignored', { file: this.file, error })
    }
    return this
  }

  /** All polls, or only those of one chat. */
  list(chatId) {
    return chatId === undefined ? [...this.polls] : this.polls.filter((poll) => poll.chatId === chatId)
  }

  /** One poll by id (ids are strings, as in reminders). */
  get(id) {
    return this.polls.find((poll) => poll.id === String(id))
  }

  /**
   * Create one poll.
   *
   * @param {object} input - `chatId`, `userId` (optional, stored for reference),
   *   `question`, `options`.
   * @returns {object | undefined} the stored poll, or `undefined` when the input
   *   cannot become one: an empty/over-long question, fewer than 2 or more than
   *   10 distinct non-blank options, or an option longer than 60 characters.
   *   Nothing is written in that case.
   */
  add({ chatId, userId, question, options } = {}) {
    const clean = String(question ?? '').trim()
    if (clean === '' || clean.length > MAX_QUESTION_LENGTH) return undefined
    const cleaned = cleanOptions(options)
    if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) return undefined
    if (cleaned.some((text) => text.length > MAX_OPTION_LENGTH)) return undefined
    const poll = {
      id: String(this.nextId++),
      chatId,
      ...(userId === undefined ? {} : { userId }),
      question: clean,
      options: cleaned.map((text) => ({ text, votes: [] })),
      createdAt: new Date().toISOString(),
    }
    this.polls.push(poll)
    this.enforceLimit()
    return poll
  }

  /**
   * Record or move one vote.
   *
   * A user has at most one vote per poll: tapping another option removes the old
   * vote and casts the new one. Poll data is mutated in memory only — the caller
   * persists it with `flush()`, exactly like `add`.
   *
   * @param {string} id - poll id.
   * @param {number|string} userId - who tapped; numeric and string forms of the
   *   same id count as one person.
   * @param {number} optionIndex - zero-based option index.
   * @returns {{poll: object, changed: boolean, previousIndex: number} | undefined}
   *   `undefined` only when there is no such poll. Otherwise `changed` says
   *   whether anything moved, and `previousIndex` is the option the user had
   *   picked before (`-1` when they had not voted). A closed poll, an unknown
   *   option index and a repeated tap on the same option all come back as
   *   `changed: false` and never modify the poll.
   */
  vote(id, userId, optionIndex) {
    const poll = this.get(id)
    if (!poll) return undefined
    const previousIndex = this.voteIndexOf(poll, userId)
    if (userId === undefined || userId === null) return { poll, changed: false, previousIndex: -1 }
    // A closed poll is frozen: the buttons are gone, but a stale message may
    // still be tapped, and that must not resurrect a finished vote.
    if (poll.closedAt !== undefined) return { poll, changed: false, previousIndex }
    if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
      return { poll, changed: false, previousIndex }
    }
    if (previousIndex === optionIndex) return { poll, changed: false, previousIndex }
    if (previousIndex !== -1) {
      poll.options[previousIndex].votes = poll.options[previousIndex].votes
        .filter((vote) => String(vote) !== String(userId))
    }
    poll.options[optionIndex].votes.push(userId)
    return { poll, changed: true, previousIndex }
  }

  /** Zero-based index of the option this user picked, or -1. */
  voteIndexOf(poll, userId) {
    return poll.options.findIndex((option) => option.votes.some((vote) => String(vote) === String(userId)))
  }

  /**
   * Close a poll: results stay, voting stops, the keyboard disappears.
   *
   * @param {string} id - poll id.
   * @returns {object | undefined} the closed poll, `undefined` for an unknown id.
   *   Closing an already closed poll keeps the original `closedAt`.
   */
  close(id) {
    const poll = this.get(id)
    if (!poll) return undefined
    if (poll.closedAt === undefined) poll.closedAt = new Date().toISOString()
    this.enforceLimit()
    return poll
  }

  /**
   * Drop one poll by id.
   *
   * @returns {object | undefined} the removed poll, `undefined` when it was absent.
   */
  remove(id) {
    const index = this.polls.findIndex((poll) => poll.id === String(id))
    if (index === -1) return undefined
    const [removed] = this.polls.splice(index, 1)
    return removed
  }

  /**
   * Trim the store back to `maxPolls` by dropping the oldest closed polls.
   *
   * Active polls are never dropped, so the store can legitimately exceed the cap
   * when every poll is still open; the next `close` brings it back down.
   */
  enforceLimit() {
    while (this.polls.length > this.maxPolls) {
      const index = this.polls.findIndex((poll) => poll.closedAt !== undefined)
      if (index === -1) break
      this.polls.splice(index, 1)
    }
  }

  /** Persist atomically and wait for the write. */
  async flush() {
    try {
      const payload = `${JSON.stringify({ version: VERSION, nextId: this.nextId, polls: this.polls }, null, 2)}\n`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, payload, 'utf8')
      await fs.rename(temporary, this.file)
    } catch (error) {
      this.logger?.error('poll save failed', { error })
    }
  }
}

/** OpenAI-compatible tool definition. */
export const POLL_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'poll',
    description:
      'Создать опрос (голосование) в этом чате с кнопками-вариантами. Вызывай, когда просят опрос или голосование '
      + '(«создай опрос», «спросим у всех», «проголосуем», «куда едем в выходные?»). '
      + 'Кнопки и подсчёт голосов бот берёт на себя: не описывай варианты текстом и не считай голоса сам.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Вопрос опроса, до 200 символов. Например: «Куда едем в выходные?».' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'От 2 до 10 разных вариантов ответа, каждый до 60 символов.',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
}

/** Short hint for the model's system instruction. */
export const POLL_HINT =
  'Опросы: когда просят «создай опрос», «спросим у всех» или «проголосуем», вызывай инструмент poll '
  + '(question — вопрос до 200 символов, options — от 2 до 10 разных вариантов до 60 символов). '
  + 'Кнопки и подсчёт голосов бот делает сам; повторное нажатие переносит голос, а не добавляет второй.'

/**
 * Build the `poll` tool.
 *
 * @param {object} options - tool options.
 * @param {PollStore} options.store - poll storage.
 */
export function createPollTool({ store }) {
  return {
    definition: POLL_TOOL_DEFINITION,

    /**
     * Create one poll for a chat.
     *
     * @param {object} args - tool arguments (`question`, `options`).
     * @param {{chatId: number, userId?: number|string}} context - chat and author, injected by the bot.
     * @returns {Promise<string>} confirmation or an error the model must report.
     */
    async execute(args, context) {
      const { text } = await this.executeDetailed(args, context)
      return text
    },

    /**
     * Same as `execute`, but also returns the stored poll.
     *
     * The bot needs the whole poll to send the message and the buttons; the model
     * must only ever see the text.
     *
     * @param {object} args - tool arguments (`question`, `options`).
     * @param {{chatId: number, userId?: number|string}} context - chat and author.
     * @returns {Promise<{text: string, poll?: object}>} result plus the poll when one was created.
     */
    async executeDetailed({ question, options } = {}, { chatId, userId } = {}) {
      if (!Number.isFinite(chatId)) return { text: 'Ошибка инструмента poll: не удалось определить чат.' }
      const clean = String(question ?? '').trim()
      if (clean === '') {
        return { text: 'Ошибка инструмента poll: нужен вопрос опроса. Спроси у пользователя, что именно голосуем.' }
      }
      if (clean.length > MAX_QUESTION_LENGTH) {
        return { text: `Ошибка инструмента poll: вопрос длиннее ${MAX_QUESTION_LENGTH} символов. Сократи его и вызови инструмент снова.` }
      }
      const cleaned = cleanOptions(options)
      if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) {
        return { text: `Ошибка инструмента poll: нужно от ${MIN_OPTIONS} до ${MAX_OPTIONS} разных непустых вариантов (получено ${cleaned.length}).` }
      }
      const tooLong = cleaned.find((text) => text.length > MAX_OPTION_LENGTH)
      if (tooLong !== undefined) {
        return { text: `Ошибка инструмента poll: вариант «${tooLong}» длиннее ${MAX_OPTION_LENGTH} символов. Сократи его и вызови инструмент снова.` }
      }

      const poll = store.add({ chatId, userId, question: clean, options: cleaned })
      if (!poll) return { text: 'Ошибка инструмента poll: не удалось создать опрос, проверь вопрос и варианты.' }
      // Persist immediately: a poll that was confirmed to the user must survive a
      // restart before the first tap.
      await store.flush()
      const list = poll.options.map((option, index) => `${index + 1}) ${option.text}`).join(', ')
      return {
        text: `Опрос №${poll.id} создан: «${poll.question}».\nВарианты: ${list}.\nОтправь сообщение с кнопками: ${poll.options.length} шт. Голоса считаются по нажатиям.`,
        poll,
      }
    },
  }
}

/**
 * Message text for a poll: question, options with counts and percentages and the
 * people who voted.
 *
 * Percentages are shares of the number of distinct voters, not of the number of
 * stored votes, so a repeated or a moved vote cannot push the sum past 100%.
 * Rounding is `Math.round`, so three equal options show 33% each.
 *
 * @param {object} poll - stored poll.
 * @param {object} [options] - `names`, a `userId -> name` map. A voter missing
 *   from the map is shown by id.
 * @returns {string} the message; `''` for a missing or malformed poll.
 */
export function pollMessage(poll, { names = {} } = {}) {
  if (!poll || !Array.isArray(poll.options)) return ''
  const total = voterCount(poll)
  const lines = [`📊 Опрос «${poll.question}»`]
  poll.options.forEach((option, index) => {
    const votes = uniqueVotes(option.votes)
    const share = total === 0 ? '' : ` (${Math.round((votes.length / total) * 100)}%)`
    const who = votes.map((vote) => names[vote] ?? String(vote))
    const voters = who.length > 0 ? `: ${who.join(', ')}` : ''
    lines.push(`${index + 1}. ${option.text} — ${votes.length}${share}${voters}`)
  })
  lines.push('', total === 0 ? 'Пока никто не голосовал.' : `Всего проголосовало: ${total}.`)
  if (poll.closedAt !== undefined) lines.push('', 'Опрос закрыт.')
  return lines.join('\n')
}

/**
 * Neutral keyboard for a poll: one button per option.
 *
 * @param {object} poll - stored poll.
 * @param {object} [options] - `prefix`, the callback namespace (default `poll`).
 * @returns {{rows: Array<Array<{text: string, data: string}>>} | undefined}
 *   `undefined` after the poll is closed (the buttons are no longer needed) and
 *   for a missing poll.
 */
export function pollKeyboard(poll, { prefix = 'poll' } = {}) {
  if (!poll || !Array.isArray(poll.options) || poll.closedAt !== undefined) return undefined
  return {
    rows: poll.options.map((option, index) => [{ text: option.text, data: `${prefix}:${poll.id}:${index}` }]),
  }
}

/**
 * One-line result for a summary command.
 *
 * @param {object} poll - stored poll.
 * @returns {string | undefined} `опрос «…»: вариант A — 3, вариант B — 1`,
 *   or `undefined` for a missing poll.
 */
export function pollResultsLine(poll) {
  if (!poll || !Array.isArray(poll.options)) return undefined
  const parts = poll.options.map((option) => `${option.text} — ${uniqueVotes(option.votes).length}`)
  return `опрос «${poll.question}»: ${parts.join(', ')}`
}

/**
 * Parse a poll button payload (`<prefix>:<id>:<index>`).
 *
 * Strict on purpose: `parsePollAction` runs on whatever a chat sends, so a
 * malformed payload must not silently count as a vote for option 0. The id must
 * be a plain positive string-number (the store never emits leading zeros), the
 * index a non-negative integer.
 *
 * @param {unknown} data - raw `callback.data`.
 * @param {object} [options] - `prefix`, must match `pollKeyboard`.
 * @returns {{id: string, optionIndex: number} | undefined}
 */
export function parsePollAction(data, { prefix = 'poll' } = {}) {
  if (typeof data !== 'string') return undefined
  const parts = data.split(':')
  if (parts.length !== 3) return undefined
  const [action, id, index] = parts
  if (action !== prefix) return undefined
  if (!/^[1-9]\d*$/.test(id)) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(index)) return undefined
  const optionIndex = Number(index)
  if (!Number.isSafeInteger(optionIndex)) return undefined
  return { id, optionIndex }
}
