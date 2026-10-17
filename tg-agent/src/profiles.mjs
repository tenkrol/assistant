/**
 * Per-user profiles: the durable facts a chat partner has shared, plus their
 * default city for weather.
 *
 * Design notes:
 *   - one JSON file written atomically, like the reminder store, so a restart
 *     never loses something the user was told was remembered;
 *   - facts are numbered per user and never renumbered, because `/forget 2` must
 *     keep pointing at the same fact after other facts are deleted;
 *   - the store is bounded (users and facts per user), so a hostile or merely
 *     chatty partner cannot grow the file without limit.
 */
import { createJsonStore } from './storage/json-store.mjs'

const VERSION = 1
const MAX_FACT_LENGTH = 200
/** Older profiles are dropped first when the store grows past `maxUsers`. */
const DEFAULT_MAX_USERS = 1000
const DEFAULT_MAX_FACTS = 50

/** One stored profile. */
const emptyProfile = () => ({ city: undefined, persona: undefined, mood: undefined, facts: [], nextFactId: 1, updatedAt: new Date().toISOString() })

const isFact = (value) => value != null && typeof value.id === 'string' && typeof value.text === 'string' && value.text.trim() !== ''

/**
 * Миграция схемы профилей: файл без `version` считаем версией 0.
 * Форма данных не менялась, поэтому пользователи остаются как есть.
 */
function migrateProfiles(data) {
  return {
    ...data,
    users: data?.users != null && typeof data.users === 'object' ? data.users : {},
  }
}

export class ProfileStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxUsers] - how many profiles to keep.
   * @param {number} [options.maxFacts] - facts allowed per user.
   */
  constructor({ file, logger, maxUsers = DEFAULT_MAX_USERS, maxFacts = DEFAULT_MAX_FACTS }) {
    this.file = file
    this.logger = logger
    this.maxUsers = maxUsers
    this.maxFacts = maxFacts
    /** @type {Map<string, {city?: string, facts: Array<{id: string, text: string, createdAt: string}>, nextFactId: number, updatedAt: string}>} */
    this.users = new Map()
    // Очередь записей: перекрывающиеся flush не должны перетирать снимки.
    this.writing = Promise.resolve()
    // Единый слой: атомарная запись, замок, версия схемы и миграции.
    this.storage = createJsonStore({
      file,
      version: VERSION,
      defaults: { users: {} },
      migrate: migrateProfiles,
      logger,
    })
  }

  /** Number of known users. */
  get size() {
    return this.users.size
  }

  /** Прочитать файл через общий слой; битый файл не роняет бота. */
  async load() {
    try {
      const state = await this.storage.load()
      if (state.users == null || typeof state.users !== 'object') throw new Error('unexpected file format')
      for (const [userId, profile] of Object.entries(state.users)) {
        const facts = Array.isArray(profile?.facts) ? profile.facts.filter(isFact) : []
        const highest = facts.reduce((max, fact) => Math.max(max, Number(fact.id) || 0), 0)
        this.users.set(String(userId), {
          city: typeof profile?.city === 'string' && profile.city.trim() !== '' ? profile.city.trim() : undefined,
          mode: typeof profile?.mode === 'string' && profile.mode.trim() !== '' ? profile.mode.trim() : undefined,
          persona: typeof profile?.persona === 'string' && profile.persona.trim() !== '' ? profile.persona.trim() : undefined,
          mood: typeof profile?.mood === 'string' && profile.mood.trim() !== '' ? profile.mood.trim() : undefined,
          firstName: typeof profile?.firstName === 'string' && profile.firstName.trim() !== '' ? profile.firstName.trim() : undefined,
          username: typeof profile?.username === 'string' && profile.username.trim() !== '' ? profile.username.trim() : undefined,
          facts,
          nextFactId: Math.max(Number(profile?.nextFactId) || 0, highest + 1),
          updatedAt: typeof profile?.updatedAt === 'string' ? profile.updatedAt : new Date().toISOString(),
        })
      }
      this.logger?.info('profiles loaded', { users: this.users.size })
    } catch (error) {
      // Старое поведение: чужая версия схемы и ошибки чтения только логируются.
      this.logger?.warn('profile file ignored', { file: this.file, error })
    }
    return this
  }

  /** The profile of one user, created on demand. */
  get(userId) {
    const key = String(userId)
    let profile = this.users.get(key)
    if (!profile) {
      profile = emptyProfile()
      this.users.set(key, profile)
    }
    return profile
  }

  /** Existing profile without creating one. */
  peek(userId) {
    return this.users.get(String(userId))
  }

  /** Default city of one user, if any. */
  city(userId) {
    return this.users.get(String(userId))?.city
  }

  /**
   * Remember the default city.
   *
   * @returns {{city: string, changed: boolean}} the stored city.
   */
  setCity(userId, city) {
    const clean = String(city ?? '').trim()
    if (clean === '') throw new Error('city is required')
    if (clean.length > 80) throw new Error('city name is too long')
    const profile = this.get(userId)
    const changed = profile.city !== clean
    profile.city = clean
    profile.updatedAt = new Date().toISOString()
    this.enforceBounds()
    return { city: clean, changed }
  }

  /** Answer mode of one user (set with `/mode`), if any. */
  mode(userId) {
    return this.users.get(String(userId))?.mode
  }

  /** The chosen character of one user (set with `/character`), if any. */
  persona(userId) {
    return this.users.get(String(userId))?.persona
  }

  /**
   * Set or clear the character.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} [value] - character name; empty returns to the default.
   * @returns {string|undefined} the stored character.
   */
  setPersona(userId, value) {
    const clean = String(value ?? '').trim()
    const profile = this.get(userId)
    profile.persona = clean === '' ? undefined : clean
    profile.updatedAt = new Date().toISOString()
    return profile.persona
  }

  /** The pinned mood of one user; undefined means the daily rotation decides. */
  mood(userId) {
    return this.users.get(String(userId))?.mood
  }

  /**
   * Pin or clear the mood.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} [value] - mood name; empty returns to the rotation.
   * @returns {string|undefined} the stored mood.
   */
  setMood(userId, value) {
    const clean = String(value ?? '').trim()
    const profile = this.get(userId)
    profile.mood = clean === '' ? undefined : clean
    profile.updatedAt = new Date().toISOString()
    return profile.mood
  }

  /**
   * Set or clear the answer mode.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} [value] - mode name; empty clears it.
   * @returns {string|undefined} the stored mode.
   */
  setMode(userId, value) {
    const clean = String(value ?? '').trim()
    const profile = this.get(userId)
    profile.mode = clean === '' ? undefined : clean
    profile.updatedAt = new Date().toISOString()
    return profile.mode
  }

  /** Forget the default city; returns whether there was one. */
  clearCity(userId) {
    const profile = this.users.get(String(userId))
    if (!profile?.city) return false
    profile.city = undefined
    profile.updatedAt = new Date().toISOString()
    return true
  }

  /** All facts of one user, in insertion order (copies, so callers cannot mutate the store). */
  facts(userId) {
    return (this.users.get(String(userId))?.facts ?? []).map((fact) => ({ ...fact }))
  }

  /**
   * Add one fact, skipping an exact duplicate.
   *
   * @param {string|number} userId - profile owner.
   * @param {string} text - the fact, phrased as a short statement ("его зовут Андрей").
   * @returns {{fact: object, duplicate: boolean}} the stored (or matching) fact.
   */
  addFact(userId, text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (clean === '') throw new Error('fact text is required')
    if (clean.length > MAX_FACT_LENGTH) throw new Error(`fact is too long (max ${MAX_FACT_LENGTH} characters)`)
    const profile = this.get(userId)
    const existing = profile.facts.find((fact) => fact.text.toLowerCase() === clean.toLowerCase())
    if (existing) return { fact: existing, duplicate: true }
    if (profile.facts.length >= this.maxFacts) throw new Error(`too many facts (max ${this.maxFacts}); remove one first`)
    const fact = { id: String(profile.nextFactId++), text: clean, createdAt: new Date().toISOString() }
    profile.facts.push(fact)
    profile.updatedAt = fact.createdAt
    this.enforceBounds()
    return { fact, duplicate: false }
  }

  /** Remove one fact by its number; returns it when it existed. */
  removeFact(userId, id) {
    const profile = this.users.get(String(userId))
    if (!profile) return undefined
    const index = profile.facts.findIndex((fact) => fact.id === String(id))
    if (index === -1) return undefined
    const [removed] = profile.facts.splice(index, 1)
    profile.updatedAt = new Date().toISOString()
    return removed
  }

  /** Remove every fact (used by "забудь всё"); returns how many were dropped. */
  clearFacts(userId) {
    const profile = this.users.get(String(userId))
    if (!profile || profile.facts.length === 0) return 0
    const count = profile.facts.length
    profile.facts = []
    profile.updatedAt = new Date().toISOString()
    return count
  }

  /**
   * Remember the public Telegram name of a user.
   *
   * This is what lets the bot tell participants apart in a group without asking
   * anybody anything: the name is public in the chat anyway.
   *
   * @returns {boolean} whether anything changed.
   */
  touch(userId, { firstName, username } = {}) {
    const name = String(firstName ?? '').trim()
    const handle = String(username ?? '').trim().replace(/^@/, '')
    if (name === '' && handle === '') return false
    const profile = this.get(userId)
    let changed = false
    if (name !== '' && profile.firstName !== name) {
      profile.firstName = name
      changed = true
    }
    if (handle !== '' && profile.username !== handle) {
      profile.username = handle
      changed = true
    }
    if (changed) profile.updatedAt = new Date().toISOString()
    return changed
  }

  /**
   * How to address this user: a remembered name beats the Telegram name.
   *
   * @returns {string|undefined} the name, when one is known.
   */
  displayName(userId) {
    const profile = this.users.get(String(userId))
    if (!profile) return undefined
    for (const fact of profile.facts) {
      const match = /(?:его|её|ее|меня)?\s*зовут\s+([\p{L}-]{2,})/iu.exec(fact.text)
      if (match) return match[1][0].toUpperCase() + match[1].slice(1)
    }
    return profile.firstName || profile.username
  }

  /**
   * What the model should know about this user, or `undefined` when nothing is.
   *
   * Facts are numbered exactly as `/memory` lists them, so the model can refer to
   * a number the user sees, and `/forget N` always means the same thing.
   */
  summary(userId) {
    const profile = this.users.get(String(userId))
    if (!profile) return undefined
    const parts = []
    if (profile.city) parts.push(`город по умолчанию — ${profile.city}`)
    for (const fact of profile.facts) parts.push(`№${fact.id}: ${fact.text}`)
    if (parts.length === 0) return undefined
    return `Что известно об этом пользователе (помни это и не переспрашивай): ${parts.join('; ')}.`
  }

  /** Drop the oldest profiles once the store is over its limit. */
  enforceBounds() {
    if (this.users.size <= this.maxUsers) return 0
    const ordered = [...this.users.entries()].sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)))
    let dropped = 0
    for (const [key] of ordered) {
      if (this.users.size <= this.maxUsers) break
      this.users.delete(key)
      dropped++
    }
    if (dropped > 0) this.logger?.warn('profiles dropped to stay within the limit', { dropped, maxUsers: this.maxUsers })
    return dropped
  }

  /** Сохранить через общий слой и дождаться записи. */
  async flush() {
    // Записи выполняются по очереди, чтобы поздний снимок не затёрся ранним.
    this.writing = this.writing.then(async () => {
      try {
        const users = Object.fromEntries(
          [...this.users.entries()].map(([key, profile]) => [key, {
            ...(profile.city ? { city: profile.city } : {}),
            ...(profile.mode ? { mode: profile.mode } : {}),
            ...(profile.persona ? { persona: profile.persona } : {}),
            ...(profile.mood ? { mood: profile.mood } : {}),
            ...(profile.firstName ? { firstName: profile.firstName } : {}),
            ...(profile.username ? { username: profile.username } : {}),
            nextFactId: profile.nextFactId,
            facts: profile.facts,
            updatedAt: profile.updatedAt,
          }]),
        )
        this.storage.state.users = users
        await this.storage.flush()
      } catch (error) {
        this.logger?.error('profile save failed', { error })
      }
    })
    return this.writing
  }
}

export { MAX_FACT_LENGTH }
