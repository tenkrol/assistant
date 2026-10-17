/**
 * Справочник людей, которых знает бот: имя, @ник и телефон.
 *
 * Telegram не даёт боту ни искать людей по номеру, ни писать человеку по @нику —
 * для личных чатов нужен числовой id. Поэтому бот запоминает то, что видит сам:
 * имя и @ник приходят в каждом сообщении, а телефон — только когда человек сам
 * делится контактом. Здесь эти связки и хранятся.
 *
 * Файл маленький и пишется атомарно: состояние бота не должно теряться из-за
 * прерванной записи.
 */
import { createJsonStore } from './storage/json-store.mjs'

const VERSION = 1
const MAX_CONTACTS = 500

/** Приводит телефон к последним 10 цифрам: «+7 999 123-45-67» = «9991234567». */
export function phoneKey(value) {
  const all = String(value ?? '').replace(/\D/g, '')
  return all.length > 10 ? all.slice(-10) : all
}

/**
 * Миграция схемы контактов: файл без `version` считаем версией 0.
 * Форма данных не изменилась — записи без `chatId` просто не нужны.
 */
function migrateContacts(data) {
  return {
    ...data,
    contacts: Array.isArray(data?.contacts)
      ? data.contacts.filter((entry) => entry?.chatId !== undefined)
      : [],
  }
}

export function createContactStore({ file, logger } = {}) {
  /** @type {Map<string, {chatId: number, name?: string, username?: string, phone?: string}>} */
  const contacts = new Map()
  // Без каталога данных стор работает только в памяти: записывать некуда.
  const storage = file
    ? createJsonStore({
      file,
      version: VERSION,
      defaults: { contacts: [] },
      migrate: migrateContacts,
      logger,
    })
    : undefined
  let loading
  // Очередь записей: перекрывающиеся flush не должны перетирать снимки.
  let writing = Promise.resolve()

  const keyOf = (chatId) => String(chatId)

  /** Прочитать файл через общий слой; ошибки не роняют бота. */
  async function load() {
    if (!storage) return
    try {
      const state = await storage.load()
      contacts.clear()
      for (const entry of Array.isArray(state.contacts) ? state.contacts : []) {
        if (entry?.chatId !== undefined) contacts.set(keyOf(entry.chatId), entry)
      }
    } catch (error) {
      logger?.warn?.('contacts load failed', { error: error?.message ?? error })
    }
  }

  /**
   * Первое изменение догружает файл: иначе запись затёрла бы контакты,
   * сохранённые прошлым запуском. Одновременные вызовы ждут одно чтение.
   */
  async function ensureLoaded() {
    if (!storage || storage.loaded) return
    if (!loading) {
      loading = load().finally(() => {
        loading = undefined
      })
    }
    await loading
  }

  /** Сохранить через общий слой: атомарно, под замком, с версией схемы. */
  async function flush() {
    if (!storage) return
    writing = writing.then(async () => {
      try {
        storage.state.contacts = [...contacts.values()]
        await storage.flush()
      } catch (error) {
        logger?.warn?.('contacts save failed', { error: error?.message ?? error })
      }
    })
    await writing
  }

  return {
    load,

    /** Запомнить или уточнить человека. Пустые поля не затирают уже известные. */
    async remember({ chatId, name, username, phone } = {}) {
      if (chatId === undefined || chatId === null || chatId === '') return undefined
      await ensureLoaded()
      const key = keyOf(chatId)
      const current = contacts.get(key) ?? { chatId }
      const next = {
        chatId: current.chatId,
        name: name || current.name,
        username: username ? String(username).replace(/^@/, '') : current.username,
        phone: phone ? phoneKey(phone) : current.phone,
      }
      contacts.set(key, next)
      if (contacts.size > MAX_CONTACTS) contacts.delete(contacts.keys().next().value)
      await flush()
      return next
    },

    byPhone(phone) {
      const wanted = phoneKey(phone)
      if (!wanted) return undefined
      return [...contacts.values()].find((entry) => entry.phone === wanted)
    },

    byUsername(username) {
      const wanted = String(username ?? '').replace(/^@/, '').toLowerCase()
      if (!wanted) return undefined
      return [...contacts.values()].find((entry) => String(entry.username ?? '').toLowerCase() === wanted)
    },

    /** Поиск по началу имени: «Маша» найдёт «Марию», если так записано. */
    search(query) {
      const needle = String(query ?? '').trim().toLowerCase()
      if (!needle) return []
      const all = [...contacts.values()]
      const exact = all.filter((entry) => String(entry.name ?? '').toLowerCase() === needle)
      if (exact.length > 0) return exact
      return all.filter((entry) => String(entry.name ?? '').toLowerCase().includes(needle))
    },

    list() {
      return [...contacts.values()].map((entry) => ({
        chatId: entry.chatId,
        name: entry.name ?? entry.username ?? String(entry.chatId),
      }))
    },

    size() {
      return contacts.size
    },
  }
}

export { MAX_CONTACTS }
