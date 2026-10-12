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
import fs from 'node:fs/promises'

const MAX_CONTACTS = 500

/** Приводит телефон к последним 10 цифрам: «+7 999 123-45-67» = «9991234567». */
export function phoneKey(value) {
  const all = String(value ?? '').replace(/\D/g, '')
  return all.length > 10 ? all.slice(-10) : all
}

export function createContactStore({ file, logger } = {}) {
  /** @type {Map<string, {chatId: number, name?: string, username?: string, phone?: string}>} */
  const contacts = new Map()
  let writing = false

  const keyOf = (chatId) => String(chatId)

  async function flush() {
    if (!file || writing) return
    writing = true
    const payload = { contacts: [...contacts.values()] }
    const tmp = `${file}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(payload, null, 0))
      await fs.rename(tmp, file)
    } catch (error) {
      logger?.warn?.('contacts save failed', { error: error?.message ?? error })
    } finally {
      writing = false
    }
  }

  return {
    async load() {
      if (!file) return
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'))
        for (const entry of data?.contacts ?? []) {
          if (entry?.chatId !== undefined) contacts.set(keyOf(entry.chatId), entry)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') logger?.warn?.('contacts load failed', { error: error?.message ?? error })
      }
    },

    /** Запомнить или уточнить человека. Пустые поля не затирают уже известные. */
    async remember({ chatId, name, username, phone } = {}) {
      if (chatId === undefined || chatId === null || chatId === '') return undefined
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
