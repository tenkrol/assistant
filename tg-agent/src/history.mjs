/**
 * Per-chat conversation history with durable storage.
 *
 * The store keeps at most `limit` messages per chat, always starting at a user
 * message so the API never receives a dangling assistant turn. Writes are
 * debounced and atomic (temp file + rename) so a crash mid-write cannot corrupt
 * the file the next start reads.
 */
import crypto from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const VERSION = 1

/** Служебные слова, которые не делают два сообщения «тем же фактом». */
const STOP_STEMS = new Set(['живе', 'живу', 'люби', 'работ', 'зову', 'горо', 'есть', 'меня', 'его', 'ее', 'её', 'был', 'была', 'были'])

/** Нормализованный текст для сравнения. */
const normalizeStatement = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Начала значимых слов: «Мытищах» и «Мытищи» дают общий корень «мыти». */
const stemsOf = (text) => String(text ?? '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((word) => word.length >= 4)
  .map((word) => word.slice(0, 4))
  .filter((stem) => !STOP_STEMS.has(stem))

/** Похоже ли сообщение на источник записи памяти. */
const matchesStatement = (content, phrase) => {
  if (String(content ?? '').toLowerCase().includes(phrase)) return true
  const wanted = new Set(stemsOf(phrase))
  return stemsOf(content).some((stem) => wanted.has(stem))
}

/**
 * Миграция схемы истории: файл без `version` считаем версией 0.
 * Форма данных та же — чаты остаются как есть.
 */
function migrateHistory(data) {
  return {
    ...data,
    chats: data?.chats != null && typeof data.chats === 'object' ? data.chats : {},
  }
}

export class HistoryStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {number} options.limit - messages kept per chat.
   * @param {object} [options.logger] - logger with warn/error methods.
   * @param {number} [options.saveDelayMs] - debounce before writing to disk.
   * @param {number} [options.maxChats] - chats kept in memory, least recently used evicted first.
   * @param {object} [options.access] - единая проверка доступа (`src/core/access.mjs`).
   */
  constructor({ file, limit, logger, saveDelayMs = 250, maxChats = 1000, access }) {
    this.file = file
    this.limit = limit
    this.logger = logger
    this.saveDelayMs = saveDelayMs
    this.maxChats = Math.max(1, maxChats)
    this.access = access
    /** @type {Map<string, { messages: Array<{role: string, content: string}>, model?: string, scope_id?: string }>} */
    this.chats = new Map()
    /** Chat id -> last access, used to evict the least recently used record. */
    this.lastUsed = new Map()
    this.timer = null
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { chats: {} },
      migrate: migrateHistory,
      logger,
    })
  }

  /** Прочитать файл через общий слой; битый файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      if (state.chats == null || typeof state.chats !== 'object') throw new Error('unexpected file format')
      let assignedIds = false
      for (const [chatId, record] of Object.entries(state.chats)) {
        const messages = Array.isArray(record?.messages)
          ? record.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          : []
        for (const message of messages) {
          if (message.id === undefined) {
            message.id = crypto.randomUUID()
            assignedIds = true
          }
        }
        this.chats.set(chatId, {
          messages,
          model: typeof record?.model === 'string' ? record.model : undefined,
          ...(typeof record?.scope_id === 'string' ? { scope_id: record.scope_id } : {}),
        })
      }
      if (assignedIds) await this.storage.flush()
      this.logger?.info('history loaded', { chats: this.chats.size })
    } catch (error) {
      // Старое поведение: чужая версия схемы и ошибки чтения только логируются.
      this.logger?.warn('history file ignored', { file: this.file, error })
    }
    return this
  }

  /**
   * Messages for one chat, oldest first.
   *
   * Личная история проверяется через access: второй человек не читает чужой
   * диалог, даже зная id чата. Без `userId` поведение прежнее — это системные
   * читатели (выгрузка владельца и планировщик).
   */
  messages(chatId, userId) {
    const key = String(chatId)
    if (this.chats.has(key)) this.touch(key)
    const record = this.chats.get(key)
    if (!record) return []
    if (this.access && userId !== undefined && !this.access.canRead(userId, record)) return []
    return [...record.messages]
  }

  /** Model override set with `/model`; undefined means "use the configured one". */
  model(chatId) {
    const key = String(chatId)
    if (this.chats.has(key)) this.touch(key)
    return this.chats.get(key)?.model
  }

  /** Whether answers in this chat are also spoken aloud. */
  voice(chatId) {
    return this.record(chatId).voice === true
  }

  /**
   * Turn voice answers on or off for one chat.
   *
   * @param {string|number} chatId - the chat.
   * @param {boolean} enabled - whether to speak answers.
   */
  async setVoice(chatId, enabled) {
    const record = this.record(chatId)
    if (enabled) record.voice = true
    else delete record.voice
    this.schedule()
  }

  async setModel(chatId, model) {
    const record = this.record(chatId)
    if (model === undefined) delete record.model
    else record.model = model
    this.schedule()
  }

  /**
   * Append one message, trimming the window to `limit` messages.
   *
   * Trimming drops from the front until both invariants hold: at most `limit`
   * messages, and the window starts with a user message (an assistant-first
   * window confuses providers and wastes context).
   */
  async append(chatId, message, { userId } = {}) {
    const record = this.record(chatId, { userId })
    // Время сообщения нужно веб-чату; старые записи остаются без него.
    const entry = message && typeof message === 'object'
      ? {
        ...message,
        ...(message.id === undefined ? { id: crypto.randomUUID() } : {}),
        ...(message.at === undefined ? { at: new Date().toISOString() } : {}),
      }
      : message
    record.messages.push(entry)
    while (record.messages.length > this.limit || (record.messages.length > 0 && record.messages[0].role !== 'user')) {
      record.messages.shift()
    }
    this.schedule()
  }

  /** Найти сообщение по id. */
  message(chatId, messageId) {
    const record = this.chats.get(String(chatId))
    return record?.messages.find((item) => String(item.id) === String(messageId))
  }

  /** Изменить текст пользовательского сообщения. */
  async edit(chatId, messageId, text) {
    const message = this.message(chatId, messageId)
    if (!message || message.role !== 'user') return undefined
    message.content = String(text)
    message.editedAt = new Date().toISOString()
    this.touch(String(chatId))
    this.schedule()
    return message
  }

  /** Удалить сообщение из истории. */
  async remove(chatId, messageId) {
    const record = this.chats.get(String(chatId))
    if (!record) return undefined
    const index = record.messages.findIndex((item) => String(item.id) === String(messageId))
    if (index === -1) return undefined
    const [removed] = record.messages.splice(index, 1)
    this.touch(String(chatId))
    this.schedule()
    return removed
  }

  /** Поставить реакцию на сообщение; возвращает обновлённое сообщение. */
  async react(chatId, messageId, reaction) {
    const record = this.chats.get(String(chatId))
    if (!record) return undefined
    const message = record.messages.find((item) => String(item.id) === String(messageId))
    if (!message) return undefined
    message.reaction = reaction || undefined
    message.reactedAt = new Date().toISOString()
    this.touch(String(chatId))
    this.schedule()
    return message
  }

  /** Drop the conversation but keep the chat's model override. */
  async reset(chatId) {
    const record = this.record(chatId)
    record.messages = []
    this.schedule()
  }

  /**
   * Удалить из истории сообщения пользователя, на которых основана запись памяти.
   *
   * Это отдельная операция от `/forget <номер>`: память и исходная переписка
   * хранятся по-разному. Сравнение идёт по словам с общим началом, потому что в
   * памяти факт записан от третьего лица («живёт в Мытищах»), а в сообщении —
   * от первого («переехал в Мытищи»).
   *
   * @param {string|number} chatId - чат, где лежит сообщение.
   * @param {string} text - текст записи памяти.
   * @param {object} [options] - `userId` для проверки доступа к личной истории.
   * @returns {Promise<number>} сколько сообщений удалено.
   */
  async forgetContaining(chatId, text, { userId } = {}) {
    const key = String(chatId)
    const record = this.chats.get(key)
    if (!record) return 0
    if (this.access && userId !== undefined && !this.access.canRead(userId, record)) return 0
    const phrase = normalizeStatement(text)
    if (phrase === '') return 0
    const before = record.messages.length
    record.messages = record.messages.filter((message) => !(message.role === 'user' && matchesStatement(message.content, phrase)))
    const removed = before - record.messages.length
    // Окно обязано начинаться с сообщения пользователя: ответ без вопроса
    // сбивает провайдера и тратит контекст. Отброшенные при этом ответы не
    // считаются удалёнными сообщениями пользователя.
    while (record.messages.length > 0 && record.messages[0].role !== 'user') record.messages.shift()
    if (removed > 0) {
      this.touch(key)
      this.schedule()
    }
    return removed
  }

  /** Number of chats currently held in memory. */
  get size() {
    return this.chats.size
  }

  record(chatId, { userId } = {}) {
    const key = String(chatId)
    let record = this.chats.get(key)
    if (!record) {
      // Личный чат получает личное пространство владельца. Общая история
      // группы остаётся историей чата и живёт без scope_id.
      const scopeId = this.access && userId !== undefined ? this.access.scopeIdFor(userId, chatId) : undefined
      record = { messages: [], ...(scopeId === undefined ? {} : { scope_id: scopeId }) }
      this.chats.set(key, record)
      this.evictIfNeeded()
    } else if (this.access && userId !== undefined && record.scope_id === undefined) {
      // Старая запись до миграции: личный чат получает пространство владельца.
      record.scope_id = this.access.scopeIdFor(userId, chatId)
    }
    this.touch(key)
    return record
  }

  /** Mark a chat as recently used. */
  touch(key) {
    this.lastUsed.delete(key)
    this.lastUsed.set(key, Date.now())
  }

  /** Drop least recently used chats so a long-lived bot cannot grow without bound. */
  evictIfNeeded() {
    while (this.chats.size > this.maxChats) {
      let oldest
      let oldestAt = Infinity
      for (const [key, at] of this.lastUsed) {
        if (at < oldestAt) { oldest = key; oldestAt = at }
      }
      if (oldest === undefined) break
      this.chats.delete(oldest)
      this.lastUsed.delete(oldest)
    }
  }

  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.writing = this.writing.then(() => this.save()).catch((error) => this.logger?.error('history save failed', { error }))
    }, this.saveDelayMs)
    this.timer.unref?.()
  }

  /** Write immediately; awaited on shutdown. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Перехватываем ошибку в самой цепочке: иначе одна неудачная запись
    // навсегда «отравит» очередь, и следующие flush молча ничего не сохранят.
    this.writing = this.writing.then(() => this.save()).catch((error) => this.logger?.error('history save failed', { error }))
    await this.writing
  }

  async save() {
    const chats = {}
    for (const [chatId, record] of this.chats) {
      if (record.messages.length === 0 && record.model === undefined) continue
      chats[chatId] = {
        messages: record.messages,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.scope_id === undefined ? {} : { scope_id: record.scope_id }),
        ...(record.voice === true ? { voice: true } : {}),
      }
    }
    // Синхронизируем доменное состояние с состоянием слоя перед записью.
    this.storage.state.chats = chats
    await this.storage.flush()
  }
}
