/**
 * Домен профилей: память человека.
 *
 * Здесь правила фактов, предела их количества, города как одного значения и
 * отображаемого имени. Домен не знает ни про Telegram, ни про сеть: на входе
 * хранилище и обычные данные, на выходе результат и текст сообщения.
 *
 * Нумерация фактов не меняется: `/forget 2` должно указывать на тот же факт и
 * после удаления соседнего, поэтому номера выдаёт хранилище, а не текст.
 *
 * С PLB-019 записи памяти живут по правилам `src/memory.mjs`: у них есть
 * источник, область, статус, срок и история исправлений.
 */
import {
  SECRET_MEMORY_TEXT,
  createMemory,
  describeSource,
  detectSecretKind,
  isExpiredRecord,
} from '../memory.mjs'

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

/**
 * Ответ `/memory`; `undefined`, когда памяти нет вовсе.
 *
 * При одной странице текст остаётся прежним. Пагинация и фильтр проекта
 * добавляют строки только тогда, когда они действительно нужны.
 */
export function memoryText({ facts = [], city, page = 1, pages = 1, total = facts.length, scopeTitle, expiredIds } = {}) {
  if (facts.length === 0 && !city) {
    // Пустая вторая страница — не «ничего не помню», а просьба вернуться.
    if (page > 1) return `Записей на странице ${page} нет. Всего записей: ${total}. Вернуться: \`/memory 1\`.`
    if (scopeTitle !== undefined) return `В проекте «${scopeTitle}» записей памяти нет. Вся память — /memory.`
    return 'Я пока ничего о вас не помню. Скажите, например: «запомни, меня зовут Андрей».'
  }
  const lines = []
  if (city && page === 1 && scopeTitle === undefined) lines.push(`Город по умолчанию: **${city}** (сменить — \`/city\`)`)
  if (facts.length > 0) {
    lines.push(scopeTitle === undefined ? '**Что помню:**' : `**Что помню** (проект «${scopeTitle}»):`)
    for (const fact of facts) {
      const expired = expiredIds?.has?.(String(fact.id)) || isExpiredRecord(fact)
      const label = fact.scopeLabel === undefined ? '' : ` (проект «${fact.scopeLabel}»)`
      lines.push(`№${fact.id}: ${fact.text ?? fact.value}${label}${expired ? ' _(срок истёк)_' : ''}`)
    }
    lines.push('', 'Удалить один факт: `/forget <номер>`. Удалить всё: `/forget all`.')
    if (pages > 1) {
      const next = page < pages ? ` Следующая: \`/memory ${page + 1}\`.` : ''
      const previous = page > 1 ? ` Предыдущая: \`/memory ${page - 1}\`.` : ''
      lines.push(`Страница ${page} из ${pages}.${next}${previous}`)
      lines.push('Фильтр по проекту: `/memory проект <название>`. Исправить: `/memory correct <номер> <текст>`.')
    }
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

/**
 * Уточнение области удаления: запись памяти и исходное сообщение — разные вещи.
 *
 * Ничего не удаляет само: сначала человек выбирает, что именно забыть.
 */
export const FORGET_THIS_TEXT = [
  'Уточните область удаления:',
  '• только запись памяти — `/forget <номер>` или `/forget <номер> запись`;',
  '• запись и исходное сообщение в истории бота — `/forget <номер> сообщение`.',
  'Резервные копии хранятся ограниченное время (см. `/help`); удалённая запись не вернётся при повторной индексации.',
].join('\n')

/** Личная память в общем чате не показывается: её видно только в личном. */
export const MEMORY_GROUP_PRIVATE_TEXT = 'Личная память в общем чате не показывается — она остаётся в личном чате. Память проекта можно посмотреть так: `/memory проект <название>`.'

/** Проект для фильтра памяти не найден. */
export function memoryProjectMissingText(title) {
  return `Проекта «${title}» не нашёл. Список проектов — /project, вся память — /memory.`
}

/** Ответ на неполную команду исправления. */
export const MEMORY_CORRECT_USAGE_TEXT = 'Исправить запись: `/memory correct <номер> <новый текст>`. Номера — в `/memory`.'

/** Не удалось определить номер для истории или отмены. */
export const MEMORY_NUMBER_TEXT = 'Нужен номер записи: `/memory history <номер>` или `/memory undo <номер>`. Список — /memory.'

/** Синоним для тестов и старых вызовов. */
export const forgetScopeClarifyText = () => FORGET_THIS_TEXT

/** Ответ на незнакомый аргумент `/memory`. */
export const MEMORY_USAGE_TEXT = [
  'Страницы: `/memory 2`. Фильтр: `/memory проект <название>`.',
  'Источник последнего ответа: `/memory why`.',
  'Исправить: `/memory correct <номер> <текст>`. История: `/memory history <номер>`. Отмена: `/memory undo <номер>`.',
].join('\n')

/** Текст успешного исправления: новая запись заменила старую. */
export function memoryCorrectedText(record, previous) {
  return `Исправил: №${record.id} «${record.value ?? record.text}» — заменяет №${previous.id}. Старая запись осталась в истории: \`/memory history ${record.id}\`.`
}

/** Ответ на исправление, когда номер не найден или запись нельзя менять. */
export function memoryCorrectErrorText(reason, id) {
  if (reason === 'forbidden') return `Запись №${id} в этой области доступна только для чтения.`
  return `Записи №${id} нет. Список — /memory.`
}

/** Ответ на отмену исправления. */
export function memoryUndoText(result, id) {
  if (result?.ok) return `Исправление отменено: снова действует №${result.restored.id} «${result.restored.value ?? result.restored.text}». Замена №${result.reverted?.id ?? id} осталась в истории.`
  if (result?.reason === 'deleted') return 'Отменить нельзя: исходная запись уже удалена.'
  if (result?.reason === 'not-a-correction') return `№${id} не является исправлением.`
  if (result?.reason === 'forbidden') return 'Отменить исправление может только владелец области.'
  return `Записи №${id} нет или она уже не действует.`
}

/** Ответ `/memory why`: источник последней записи, попавшей в контекст. */
export function memoryWhyText(records = [], { at } = {}) {
  if (records.length === 0) return 'В последнем ответе я не опирался на память — источника нет.'
  const lines = ['**Почему я так решил**']
  for (const record of records) {
    const date = String(record.validFrom ?? record.createdAt ?? '').slice(0, 10)
    lines.push(`№${record.id} «${record.value ?? record.text}»: ${describeSource(record)}${date ? `, ${date}` : ''}.`)
    if (record.expiresAt) lines.push(`Срок действия: до ${String(record.expiresAt).slice(0, 10)}.`)
  }
  if (records.some((record) => (record.confirmationStatus ?? 'imported') === 'assumption')) {
    lines.push('Часть записей — предположения: подтверждения пользователя нет.')
  }
  if (at) lines.push(`Контекст собран: ${String(at).slice(0, 19).replace('T', ' ')}.`)
  return lines.join('\n')
}

/** Ответ `/memory history`. Показывает цепочку замен и возможность отмены. */
export function memoryHistoryText(history = [], currentId) {
  if (history.length === 0) return 'История этой записи пуста.'
  const lines = ['**История записи**']
  for (const record of history) {
    const date = String(record.replacedAt ?? record.validFrom ?? record.createdAt ?? '').slice(0, 10)
    const state = record.replacedAt ? `заменена${record.replacedBy ? ` на №${record.replacedBy}` : ''}` : 'действует'
    lines.push(`№${record.id} «${record.value ?? record.text}» — ${state}${date ? `, ${date}` : ''}`)
  }
  lines.push('', `Отменить последнее исправление: \`/memory undo ${currentId}\`.`)
  return lines.join('\n')
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
export function rulesOfProfiles({ store, access, history, logger } = {}) {
  // Доменные правила памяти поверх того же хранилища профилей: источник,
  // область, статус, срок и история исправлений живут в `src/memory.mjs`.
  const memory = store ? createMemory({ store, access, logger }) : undefined

  /** Действующие записи профиля (со всеми полями PLB-019). */
  const recordsOf = (userId) => store?.memoryRecords?.(userId) ?? store?.facts?.(userId) ?? []

  /** Заголовок проекта для подписи записи; личное пространство не подписываем. */
  const titleOf = (scopeId) => {
    const scope = scopeId === undefined ? undefined : access?.scopes?.get?.(scopeId)
    return scope?.kind === 'shared' ? scope.title : undefined
  }

  /** Пространства, память которых пользователь вправе видеть. */
  const scopesOf = (userId) => {
    if (!access) return []
    return [access.scopeOf(userId), ...access.sharedScopes(userId)].filter(Boolean)
  }

  /** Найти проект по id или части названия среди доступных пользователю. */
  const scopeByQuery = (userId, query) => {
    const wanted = cleanCity(query).toLowerCase()
    if (wanted === '') return undefined
    return scopesOf(userId).find((scope) => String(scope.id).toLowerCase() === wanted
      || String(scope.title ?? '').toLowerCase().includes(wanted))
  }

  /** Одна страница памяти: город только в личном списке и только на первой странице. */
  function memoryPage(userId, { page = 1, scopeId } = {}) {
    const listed = memory.list(userId, { page, scopeId })
    const facts = listed.records.map((record) => {
      const title = scopeId === undefined && access ? titleOf(record.scopeId) : undefined
      return title === undefined ? record : { ...record, scopeLabel: title }
    })
    const city = scopeId === undefined ? store?.city?.(userId) : undefined
    return {
      ...listed,
      facts,
      text: memoryText({
        facts,
        city,
        page: listed.page,
        pages: listed.pages,
        total: listed.total,
        scopeTitle: titleOf(scopeId),
      }),
    }
  }

  /** Источник записей, попавших в последний контекст модели. */
  function whyText(userId, { chatId } = {}) {
    const used = store?.lastUsed?.(userId, { chatId })
    const ids = Array.isArray(used?.ids) ? used.ids.map(String) : []
    const records = recordsOf(userId).filter((record) => ids.includes(String(record.id)))
    return memoryWhyText(records, { at: used?.at })
  }

  /** Исправление записи: мутация сразу, запись на диск — awaited. */
  async function correctMemory(userId, id, value, { chatId } = {}) {
    const result = memory.correct(userId, id, value, {
      chatId,
      sourceRef: chatId === undefined ? 'user' : `telegram:chat:${chatId}`,
    })
    if (!result.ok) return { text: result.text ?? memoryCorrectErrorText(result.reason, id) }
    await store.flush()
    return { text: memoryCorrectedText(result.record, result.previous), record: result.record }
  }

  /** Отмена исправления: возвращает прежнюю запись, замену оставляет в истории. */
  async function undoMemory(userId, id) {
    const result = memory.undo(userId, id)
    if (result.ok) await store.flush()
    return { text: memoryUndoText(result, id), ...result }
  }

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
    async remember({ text, city } = {}, { userId, chatId } = {}) {
      try {
        if (userId === undefined || userId === null) return REMEMBER_NO_USER_TEXT
        // Город проверяем первым: иначе факт остался бы в памяти, а ошибка в
        // городе не дала бы сохранить файл.
        const cityValue = city == null ? '' : String(city).trim()
        if (cityValue.length > MAX_CITY_LENGTH) return REMEMBER_CITY_TOO_LONG_TEXT
        // Секрет не становится записью: человек получает объяснение, а значение
        // не попадает ни в файл, ни в журнал.
        if (detectSecretKind(text)) return SECRET_MEMORY_TEXT
        const { fact, duplicate } = memory.remember(userId, text, { chatId })
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
        if (error?.name === 'MemorySecretError') return SECRET_MEMORY_TEXT
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

    /**
     * Команда `/memory`: список с пагинацией и фильтром проекта, `why`,
     * `correct`, `history` и `undo`.
     */
    memoryCommand(userId, rawValue = '', { chatId, isGroup = false } = {}) {
      const value = cleanCity(rawValue)
      // В общем чате личная память не раскрывается: показываем только проект.
      if (isGroup && !/^(?:проект|project)\s+/i.test(value)) {
        return { text: MEMORY_GROUP_PRIVATE_TEXT }
      }
      if (value === '' || /^\d+$/.test(value)) {
        return memoryPage(userId, { page: value === '' ? 1 : Number(value) })
      }
      if (/^(why|почему)$/i.test(value)) {
        return { text: whyText(userId, { chatId }) }
      }
      const project = /^(?:проект|project)\s+([\s\S]+?)(?:\s+(\d+))?$/i.exec(value)
      if (project) {
        const scope = scopeByQuery(userId, project[1])
        if (!scope || scope.kind === 'personal' || (access && !access.canReadScope(userId, scope.id))) {
          return { text: memoryProjectMissingText(project[1]) }
        }
        const listed = memoryPage(userId, { scopeId: scope.id, page: project[2] === undefined ? 1 : Number(project[2]) })
        return { text: listed.text, ...listed }
      }
      const correct = /^(?:correct|исправь)\s+(\d+)\s+([\s\S]+)$/i.exec(value)
      if (correct) {
        return correctMemory(userId, correct[1], correct[2], { chatId })
      }
      const historyId = /^(?:history|история)\s+(\d+)$/i.exec(value)
      if (historyId) {
        const result = memory.history(userId, historyId[1])
        if (!result.ok) return { text: memoryCorrectErrorText(result.reason, historyId[1]) }
        return { text: memoryHistoryText(result.history, historyId[1]), history: result.history }
      }
      const undoId = /^(?:undo|отмена|отменить)\s+(\d+)$/i.exec(value)
      if (undoId) {
        return undoMemory(userId, undoId[1])
      }
      // Команда узнана, но аргументов не хватает — подсказка точнее общей.
      if (/^(?:correct|исправь)\b/i.test(value)) return { text: MEMORY_CORRECT_USAGE_TEXT }
      if (/^(?:history|история|undo|отмена|отменить)\b/i.test(value)) return { text: MEMORY_NUMBER_TEXT }
      return { text: MEMORY_USAGE_TEXT }
    },

    /** Команда `/forget`: один факт по номеру или все сразу. */
    async forgetCommand(userId, rawValue, { chatId, isGroup = false } = {}) {
      const value = cleanCity(rawValue)
      if (value === '') {
        return { text: FORGET_USAGE_TEXT }
      }
      if (/^(это|этот факт|this)$/i.test(value)) {
        return { text: FORGET_THIS_TEXT }
      }
      if (/^(all|всё|все)$/i.test(value)) {
        const count = store?.clearFacts?.(userId) ?? 0
        await store?.flush?.()
        return { text: forgetAllText(count), count }
      }
      // Номер и необязательная область: запись памяти или ещё и исходное сообщение.
      const match = /^(\d+)(?:\s+(запись|запись памяти|сообщение|сообщение в истории))?$/i.exec(value)
      if (!match) {
        return { text: FORGET_NUMBER_TEXT }
      }
      const id = match[1]
      const region = match[2] ? match[2].toLowerCase() : 'запись'
      const result = memory.forget(userId, id)
      if (!result.ok) {
        // В общем чате текст удалённой записи не повторяем даже в отказе.
        return { text: forgetFactText(id, undefined) }
      }
      await store.flush()
      const removed = result.record
      let text = isGroup ? `Забыл №${id}.` : forgetFactText(id, removed)
      if (region.startsWith('сообщение')) {
        const count = typeof history?.forgetContaining === 'function'
          ? await history.forgetContaining(chatId, removed.value ?? removed.text, { userId })
          : 0
        text += count > 0
          ? ` Исходное сообщение удалено из истории (${count}).`
          : ' Исходного сообщения в истории не нашёл — удалена только запись памяти.'
      }
      return { text, removed }
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
          // Правило срабатывает только на прямую фразу пользователя о себе,
          // поэтому запись подтверждена; секреты отсеивает хранилище.
          const { duplicate } = store.addFact(userId, item.fact, {
            sourceRef: 'user',
            confirmationStatus: 'confirmed',
          })
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
