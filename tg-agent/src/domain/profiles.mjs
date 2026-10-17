/**
 * Домен профилей: память человека.
 *
 * Здесь правила фактов, предела их количества, города как одного значения и
 * отображаемого имени. Домен не знает ни про Telegram, ни про сеть: на входе
 * хранилище и обычные данные, на выходе результат и текст сообщения.
 *
 * Нумерация фактов не меняется: `/forget 2` должно указывать на тот же факт и
 * после удаления соседнего, поэтому номера выдаёт хранилище, а не текст.
 */

/** Предел длины одного факта — прежний. */
export const MAX_FACT_LENGTH = 200
/** Предел длины названия города — прежний. */
export const MAX_CITY_LENGTH = 80
/** Сколько профилей храним по умолчанию. */
export const DEFAULT_MAX_USERS = 1000
/** Сколько фактов на человека храним по умолчанию. */
export const DEFAULT_MAX_FACTS = 50

/** Приводит факт к одному пробелу между словами. */
export function cleanFactText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Приводит город к одному значению без лишних пробелов. */
export function cleanCity(value) {
  return String(value ?? '').trim()
}

/** Команда убрать город: те же слова, что понимал `/city`. */
export const isCityRemoval = (value) => /^(нет|убрать|сброс|удали)$/i.test(cleanCity(value))

/** Ответ `/city` без аргумента. */
export function cityShowText(city) {
  return city
    ? `Ваш город по умолчанию — **${city}**. Поменять: \`/city Казань\`. Убрать: \`/city нет\`.`
    : 'Город по умолчанию не задан. Задайте: `/city Москва` — тогда погоду можно спрашивать без города.'
}

/** Ответ на слишком длинное название города. */
export const CITY_TOO_LONG_TEXT = 'Слишком длинное название города.'

/** Ответ на установку города. */
export function citySetText(city) {
  return `Город по умолчанию — **${city}**. Теперь погоду можно спрашивать без города.`
}

/** Ответ на удаление города. */
export function cityRemovedText(removed) {
  return removed ? 'Город по умолчанию убран.' : 'Города по умолчанию и не было.'
}

/** Ответ `/memory`; `undefined`, когда памяти нет вовсе. */
export function memoryText({ facts = [], city } = {}) {
  if (facts.length === 0 && !city) {
    return 'Я пока ничего о вас не помню. Скажите, например: «запомни, меня зовут Андрей».'
  }
  const lines = []
  if (city) lines.push(`Город по умолчанию: **${city}** (сменить — \`/city\`)`)
  if (facts.length > 0) {
    lines.push('**Что помню:**')
    for (const fact of facts) lines.push(`№${fact.id}: ${fact.text}`)
    lines.push('', 'Удалить один факт: `/forget <номер>`. Удалить всё: `/forget all`.')
  }
  return lines.join('\n')
}

/** Ответ `/forget` без аргумента. */
export const FORGET_USAGE_TEXT = 'Укажите номер: `/forget 2`, или всё сразу: `/forget all`. Список — `/memory`.'

/** Ответ `/forget all`. */
export function forgetAllText(count) {
  return count > 0 ? `Забыл все факты (${count}).` : 'Фактов и не было.'
}

/** Ответ `/forget` с нечисловым аргументом. */
export const FORGET_NUMBER_TEXT = 'Номер должен быть числом: `/forget 2`. Список — `/memory`.'

/** Ответ `/forget <номер>`. */
export function forgetFactText(value, removed) {
  return removed ? `Забыл №${value}: «${removed.text}».` : `Факта №${value} нет. Список — /memory.`
}

/** Ошибка инструмента `remember` о слишком длинном городе. */
export const REMEMBER_CITY_TOO_LONG_TEXT = 'Ошибка инструмента remember: слишком длинное название города.'

/** Ошибка инструмента `remember`, когда пользователь не определён. */
export const REMEMBER_NO_USER_TEXT = 'Ошибка инструмента remember: не удалось определить пользователя.'

/** Текст успешного запоминания: факт и, если он был, город. */
export function rememberText({ fact, duplicate, city, changed = false } = {}) {
  const lines = [duplicate ? `Уже помню (№${fact.id}): «${fact.text}».` : `Запомнил (№${fact.id}): «${fact.text}».`]
  if (city !== undefined) {
    lines.push(changed ? `Город по умолчанию — ${city}.` : `Город по умолчанию уже ${city}.`)
  }
  return lines.join(' ')
}

/** Сообщение об ошибке инструмента `remember`. */
export function rememberErrorText(error) {
  return `Ошибка инструмента remember: ${error.message}`
}

/**
 * Как обращаться к человеку: запомненное имя важнее имени из мессенджера.
 *
 * @param {{facts?: Array<{text: string}>, firstName?: string, username?: string}} [profile] - профиль.
 * @returns {string|undefined} имя, когда оно известно.
 */
export function displayNameOf(profile) {
  if (!profile) return undefined
  for (const fact of profile.facts ?? []) {
    const match = /(?:его|её|ее|меня)?\s*зовут\s+([\p{L}-]{2,})/iu.exec(fact.text)
    if (match) return match[1][0].toUpperCase() + match[1].slice(1)
  }
  return profile.firstName || profile.username
}

/** Текст ошибки о пределе фактов: его видят и инструмент, и хранилище. */
export function factLimitError(maxFacts) {
  return `too many facts (max ${maxFacts}); remove one first`
}

/**
 * Правила домена профилей.
 *
 * @param {object} options - `store` и `logger`.
 * @returns {object} правила: запоминание, город, список и удаление фактов.
 */
export function rulesOfProfiles({ store, logger } = {}) {
  return {
    store,

    facts: (userId) => store?.facts?.(userId) ?? [],
    cityOf: (userId) => store?.city?.(userId),
    displayName: (userId) => displayNameOf(store?.peek?.(userId)) ?? store?.displayName?.(userId),
    summary: (userId) => store?.summary?.(userId),

    /** Имена проголосовавших: отображаемое имя важнее числового id. */
    namesOf(poll) {
      const names = {}
      for (const option of poll?.options ?? []) {
        for (const voter of option.votes ?? []) {
          names[voter] = displayNameOf(store?.peek?.(voter)) ?? store?.displayName?.(voter) ?? String(voter)
        }
      }
      return names
    },

    /**
     * Правила инструмента `remember`: один короткий факт и необязательный город.
     *
     * @returns {Promise<string>} текст для модели; не бросает исключений.
     */
    async remember({ text, city } = {}, { userId } = {}) {
      try {
        if (userId === undefined || userId === null) return REMEMBER_NO_USER_TEXT
        // Город проверяем первым: иначе факт остался бы в памяти, а ошибка в
        // городе не дала бы сохранить файл.
        const cityValue = city == null ? '' : String(city).trim()
        if (cityValue.length > MAX_CITY_LENGTH) return REMEMBER_CITY_TOO_LONG_TEXT
        const { fact, duplicate } = store.addFact(userId, text)
        let savedCity
        let changed = false
        if (cityValue !== '') {
          const saved = store.setCity(userId, cityValue)
          savedCity = saved.city
          changed = saved.changed
        }
        await store.flush()
        logger?.info?.('profile updated', { userId, duplicate, hasCity: cityValue !== '' })
        return rememberText({ fact, duplicate, city: savedCity, changed })
      } catch (error) {
        return rememberErrorText(error)
      }
    },

    /** Команда `/city`: показать, задать или убрать город. */
    async cityCommand(userId, rawValue) {
      const value = cleanCity(rawValue)
      if (value === '') {
        return { text: cityShowText(store?.city?.(userId)) }
      }
      if (isCityRemoval(value)) {
        const removed = store?.clearCity?.(userId)
        await store?.flush?.()
        return { text: cityRemovedText(removed), removed }
      }
      if (value.length > MAX_CITY_LENGTH) {
        return { text: CITY_TOO_LONG_TEXT }
      }
      store.setCity(userId, value)
      await store.flush()
      return { text: citySetText(value), city: value }
    },

    /** Команда `/memory`: город и пронумерованные факты. */
    memoryCommand(userId) {
      return { text: memoryText({ facts: store?.facts?.(userId) ?? [], city: store?.city?.(userId) }) }
    },

    /** Команда `/forget`: один факт по номеру или все сразу. */
    async forgetCommand(userId, rawValue) {
      const value = cleanCity(rawValue)
      if (value === '') {
        return { text: FORGET_USAGE_TEXT }
      }
      if (/^(all|всё|все)$/i.test(value)) {
        const count = store?.clearFacts?.(userId) ?? 0
        await store?.flush?.()
        return { text: forgetAllText(count), count }
      }
      if (!/^\d+$/.test(value)) {
        return { text: FORGET_NUMBER_TEXT }
      }
      const removed = store?.removeFact?.(userId, value)
      await store?.flush?.()
      return { text: forgetFactText(value, removed), removed }
    },

    /**
     * Запомнить факты, которые пользователь назвал сам.
     *
     * Модель иногда отвечает «запомнил» словами; такие однозначные утверждения
     * сохраняются напрямую. Ошибка одного факта не мешает остальным.
     *
     * @returns {Promise<{changed: boolean}>} был ли изменён профиль.
     */
    async rememberDetected(userId, items = []) {
      let changed = false
      for (const item of items) {
        try {
          const { duplicate } = store.addFact(userId, item.fact)
          if (!duplicate) changed = true
          if (item.city) {
            store.setCity(userId, item.city)
            changed = true
          }
        } catch (error) {
          logger?.debug?.('auto-memory skipped', { error })
        }
      }
      if (changed) await store.flush()
      return { changed }
    },
  }
}
