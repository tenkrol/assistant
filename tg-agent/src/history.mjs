/**
 * Per-chat conversation history with durable storage.
 *
 * The store keeps at most `limit` messages per chat, always starting at a user
 * message so the API never receives a dangling assistant turn. Writes are
 * debounced and atomic (temp file + rename) so a crash mid-write cannot corrupt
 * the file the next start reads.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

export class HistoryStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {number} options.limit - messages kept per chat.
   * @param {object} [options.logger] - logger with warn/error methods.
   * @param {number} [options.saveDelayMs] - debounce before writing to disk.
   * @param {number} [options.maxChats] - chats kept in memory, least recently used evicted first.
   */
  constructor({ file, limit, logger, saveDelayMs = 250, maxChats = 1000 }) {
    this.file = file
    this.limit = limit
    this.logger = logger
    this.saveDelayMs = saveDelayMs
    this.maxChats = Math.max(1, maxChats)
    /** @type {Map<string, { messages: Array<{role: string, content: string}>, model?: string }>} */
    this.chats = new Map()
    /** Chat id -> last access, used to evict the least recently used record. */
    this.lastUsed = new Map()
    this.timer = null
    this.writing = Promise.resolve()
  }

  /** Read the file when it exists; a corrupt file is reported and replaced. */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.version !== VERSION || typeof parsed.chats !== 'object' || parsed.chats === null) {
        throw new Error('unexpected file format')
      }
      for (const [chatId, record] of Object.entries(parsed.chats)) {
        const messages = Array.isArray(record?.messages)
          ? record.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          : []
        this.chats.set(chatId, { messages, model: typeof record?.model === 'string' ? record.model : undefined })
      }
      this.logger?.info('history loaded', { chats: this.chats.size })
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn('history file ignored', { file: this.file, error })
    }
    return this
  }

  /** Messages for one chat, oldest first. */
  messages(chatId) {
    const key = String(chatId)
    if (this.chats.has(key)) this.touch(key)
    return [...(this.chats.get(key)?.messages ?? [])]
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
  async append(chatId, message) {
    const record = this.record(chatId)
    record.messages.push(message)
    while (record.messages.length > this.limit || (record.messages.length > 0 && record.messages[0].role !== 'user')) {
      record.messages.shift()
    }
    this.schedule()
  }

  /** Drop the conversation but keep the chat's model override. */
  async reset(chatId) {
    const record = this.record(chatId)
    record.messages = []
    this.schedule()
  }

  /** Number of chats currently held in memory. */
  get size() {
    return this.chats.size
  }

  record(chatId) {
    const key = String(chatId)
    let record = this.chats.get(key)
    if (!record) {
      record = { messages: [] }
      this.chats.set(key, record)
      this.evictIfNeeded()
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
    this.writing = this.writing.then(() => this.save())
    await this.writing.catch((error) => this.logger?.error('history save failed', { error }))
  }

  async save() {
    const chats = {}
    for (const [chatId, record] of this.chats) {
      if (record.messages.length === 0 && record.model === undefined) continue
      chats[chatId] = record
    }
    const payload = `${JSON.stringify({ version: VERSION, chats }, null, 2)}\n`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await fs.writeFile(temporary, payload, 'utf8')
    await fs.rename(temporary, this.file)
  }
}
