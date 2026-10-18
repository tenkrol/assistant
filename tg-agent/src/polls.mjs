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
import { createJsonStore } from './storage/json-store.mjs'
import {
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  castVote,
  cleanOptions,
  isPoll,
  voteIndexOf,
} from './domain/polls.mjs'

// Публичный API `src/polls.mjs` не меняется: правила и тексты живут в домене,
// а здесь остаются совместимые реэкспорты.
export {
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  parsePollAction,
  pollKeyboard,
  pollMessage,
  pollResultsLine,
} from './domain/polls.mjs'

const VERSION = 1

/**
 * Миграция схемы опросов: файл без `version` считаем версией 0.
 * Форма данных не менялась — отбрасываем только записи неверной формы.
 */
function migratePolls(data) {
  return {
    ...data,
    polls: Array.isArray(data?.polls) ? data.polls.filter(isPoll) : [],
  }
}

export class PollStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxPolls] - polls kept after the oldest ones expire.
   * @param {object} [options.access] - единая проверка доступа (`src/core/access.mjs`).
   */
  constructor({ file, logger, maxPolls = 100, access }) {
    this.file = file
    this.logger = logger
    this.maxPolls = maxPolls
    this.access = access
    /** @type {Array<{id: string, chatId: number, userId?: number|string, question: string, options: Array<{text: string, votes: Array<number|string>}>, createdAt: string, closedAt?: string}>} */
    this.polls = []
    this.nextId = 1
    // Очередь записей: перекрывающиеся flush не должны перетирать снимки.
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { nextId: 1, polls: [] },
      migrate: migratePolls,
      logger,
    })
  }

  /** Прочитать файл через общий слой; битый файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      this.polls = Array.isArray(state.polls) ? state.polls.filter(isPoll) : []
      const highest = this.polls.reduce((max, poll) => Math.max(max, Number(poll.id) || 0), 0)
      this.nextId = Math.max(Number(state.nextId) || 0, highest + 1)
      this.logger?.info('polls loaded', { count: this.polls.length })
    } catch (error) {
      // Старое поведение: чужая версия схемы и ошибки чтения только логируются.
      this.logger?.warn('poll file ignored', { file: this.file, error })
    }
    return this
  }

  /** All polls, only those of one chat, or only those readable by one user. */
  list(chatId, userId) {
    return this.polls.filter((poll) => {
      if (chatId !== undefined && poll.chatId !== chatId) {
        if (!this.access || userId === undefined || !this.access.isSharedFor(userId, poll)) return false
      }
      if (this.access && userId !== undefined) return this.access.canRead(userId, poll)
      return true
    })
  }

  /** One poll by id (ids are strings, as in reminders). */
  get(id, userId) {
    const poll = this.polls.find((item) => item.id === String(id))
    if (!poll) return undefined
    if (this.access && userId !== undefined && !this.access.canRead(userId, poll)) return undefined
    return poll
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
  add({ chatId, userId, question, options, scopeId } = {}) {
    const clean = String(question ?? '').trim()
    if (clean === '' || clean.length > MAX_QUESTION_LENGTH) return undefined
    const cleaned = cleanOptions(options)
    if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) return undefined
    if (cleaned.some((text) => text.length > MAX_OPTION_LENGTH)) return undefined
    // Viewer и архивный проект не создают опрос: отказ до записи.
    const targetScope = userId === undefined || !this.access
      ? scopeId
      : this.access.scopeIdFor(userId, chatId, scopeId)
    if (targetScope !== undefined && this.access && userId !== undefined && !this.access.canWriteScope(userId, targetScope)) {
      throw new Error('access denied: в этом проекте только просмотр')
    }
    const poll = {
      id: String(this.nextId++),
      chatId,
      ...(userId === undefined ? {} : { userId }),
      ...(targetScope === undefined ? {} : { scope_id: targetScope }),
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
    // Один голос на человека и закрытие опроса — правила домена.
    const poll = this.get(id, userId)
    if (!poll) return undefined
    // Viewer читает результаты, но не меняет их; архивный проект тоже заморожен.
    if (this.access && userId !== undefined && !this.access.canWrite(userId, poll)) {
      return { poll, changed: false, previousIndex: this.voteIndexOf(poll, userId), denied: true }
    }
    return castVote(poll, userId, optionIndex)
  }

  /** Zero-based index of the option this user picked, or -1. */
  voteIndexOf(poll, userId) {
    return voteIndexOf(poll, userId)
  }

  /**
   * Close a poll: results stay, voting stops, the keyboard disappears.
   *
   * @param {string} id - poll id.
   * @returns {object | undefined} the closed poll, `undefined` for an unknown id.
   *   Closing an already closed poll keeps the original `closedAt`.
   */
  close(id, userId) {
    const poll = this.get(id, userId)
    if (!poll) return undefined
    if (this.access && userId !== undefined && !this.access.canWrite(userId, poll)) return undefined
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

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    // Записи выполняются по очереди, чтобы поздний снимок не затёрся ранним.
    this.writing = this.writing.then(async () => {
      try {
        // Синхронизируем доменное состояние с состоянием слоя перед записью.
        this.storage.state.nextId = this.nextId
        this.storage.state.polls = this.polls
        await this.storage.flush()
      } catch (error) {
        this.logger?.error('poll save failed', { error })
      }
    })
    return this.writing
  }
}

// Инструмент переехал в `src/tools/poll-tool.mjs`; старый путь остаётся
// реэкспортом, чтобы `src/index.mjs` и тесты не меняли импорты.
export { POLL_HINT, POLL_TOOL_DEFINITION, createPollTool } from './tools/poll-tool.mjs'

// Тексты опроса, клавиатура и разбор кнопок живут в `src/domain/polls.mjs`
// и реэкспортированы выше: здесь остаётся только хранилище.
