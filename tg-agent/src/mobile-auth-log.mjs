/** Журнал входов на мобильный сайт: кто, откуда и когда. */
import { createJsonStore } from './storage/json-store.mjs'

const MAX_ENTRIES = 500

export class MobileAuthLogStore {
  constructor({ file, logger } = {}) {
    this.logger = logger
    this.storage = createJsonStore({ file, version: 1, defaults: { entries: [] }, logger })
  }

  get entries() {
    return Array.isArray(this.storage.state?.entries) ? this.storage.state.entries : []
  }

  async load() {
    await this.storage.load()
    if (!Array.isArray(this.storage.state.entries)) this.storage.state.entries = []
    return this
  }

  async add({ login, ok, via = 'password', ip, userAgent, reason } = {}) {
    this.entries.push({
      at: new Date().toISOString(),
      login: String(login || '').slice(0, 64),
      ok: Boolean(ok),
      via: String(via || 'password').slice(0, 20),
      ip: String(ip || '').slice(0, 64),
      userAgent: String(userAgent || '').slice(0, 240),
      ...(reason ? { reason: String(reason).slice(0, 80) } : {}),
    })
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    await this.storage.flush()
  }

  list({ login, limit = 20 } = {}) {
    return this.entries
      .filter((entry) => !login || entry.login === login)
      .slice(-Math.max(1, Math.min(Number(limit) || 20, 100)))
      .reverse()
  }
}
