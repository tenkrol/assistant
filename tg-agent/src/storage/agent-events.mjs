/**
 * Журнал событий агента и ожидающих вопросов (PLB-009).
 *
 * Один файл состояния через общий слой: атомарная запись, версия схемы, битый
 * файл не затирается. `eventId` записывается только после успешной доставки —
 * повтор после сбоя снова доставляется. Ожидающие вопросы нужны, чтобы ответ
 * владельца обычным сообщением продолжал ту же задачу агента.
 */
import { createJsonStore } from './json-store.mjs'

const VERSION = 1

export class AgentEventsStore {
  /**
   * @param {object} options - `file`, `logger`, `retentionDays`, `now`.
   */
  constructor({ file, logger, retentionDays = 30, now = () => new Date() } = {}) {
    this.logger = logger
    this.retentionDays = retentionDays
    this.now = now
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { events: {}, pending: {} },
      logger,
    })
  }

  async load() {
    const state = await this.storage.load()
    if (!state.events || typeof state.events !== 'object') state.events = {}
    if (!state.pending || typeof state.pending !== 'object') state.pending = {}
    this.prune(state)
    return this
  }

  /** Убрать старые события; ожидающие вопросы не трогаем (у них свой срок). */
  prune(state = this.storage.state) {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 3600 * 1000
    for (const [eventId, record] of Object.entries(state.events ?? {})) {
      if ((record?.processedAt ?? 0) < cutoff) delete state.events[eventId]
    }
    return this
  }

  /** Событие уже обработано? */
  seen(eventId) {
    return Boolean(this.storage.state.events?.[String(eventId)])
  }

  /** Записать событие после успешной доставки. */
  async mark(eventId, info = {}) {
    const state = this.storage.state
    state.events = state.events ?? {}
    state.events[String(eventId)] = {
      ...info,
      processedAt: this.now().getTime(),
    }
    await this.storage.flush()
    return this
  }

  /** Запомнить ожидающий вопрос агента для чата. */
  async setPending(chatId, info = {}) {
    const state = this.storage.state
    state.pending = state.pending ?? {}
    state.pending[String(chatId)] = { ...info, askedAt: info.askedAt ?? this.now().getTime() }
    await this.storage.flush()
    return this
  }

  /** Ожидающий вопрос для чата. */
  pendingFor(chatId) {
    return this.storage.state.pending?.[String(chatId)]
  }

  /** Снять ожидающий вопрос. */
  async clearPending(chatId) {
    const state = this.storage.state
    if (state.pending) delete state.pending[String(chatId)]
    await this.storage.flush()
    return this
  }

  /** Сохранить изменения на диск. */
  async flush() {
    this.prune(this.storage.state)
    await this.storage.flush()
  }
}

export const createAgentEventsStore = (options) => new AgentEventsStore(options)
