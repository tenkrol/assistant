/**
 * Домен опросов: один голос на человека и закрытый опрос голосов не принимает.
 *
 * Голос — список id по вариантам, причём человек встречается максимум в одном
 * списке: нажатие другого варианта переносит голос, а не добавляет второй.
 * Тексты результатов и разбор кнопок тоже живут здесь, чтобы ядро оставалось
 * оркестратором, а правила можно было проверить без мессенджера и сети.
 */

/** Документированные пределы, общие для хранилища, инструмента и тестов. */
export const MAX_QUESTION_LENGTH = 200
export const MAX_OPTION_LENGTH = 60
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 10

/** Id голосующего в том виде, в каком его отдаёт платформа. */
const isUserId = (value) => typeof value === 'number' || typeof value === 'string'

/** Пережил ли вариант круговой путь через JSON. */
const isOption = (value) =>
  value != null
  && typeof value.text === 'string'
  && Array.isArray(value.votes)
  && value.votes.every(isUserId)

/** Опрос в хранимой форме. */
export const isPoll = (value) =>
  value != null
  && typeof value.id === 'string'
  && typeof value.chatId === 'number'
  && typeof value.question === 'string'
  && Array.isArray(value.options)
  && value.options.length >= MIN_OPTIONS
  && value.options.every(isOption)
  && typeof value.createdAt === 'string'
  && (value.userId === undefined || isUserId(value.userId))
  && (value.closedAt === undefined || typeof value.closedAt === 'string')

/**
 * Обрезать варианты, выбросить пустые и точные повторы.
 *
 * Мусор выбрасывается, а не отклоняется целиком: модель, повторившая вариант,
 * не должна терять весь опрос. Слишком длинный вариант — отдельный отказ.
 */
export function cleanOptions(options) {
  if (!Array.isArray(options)) return []
  const seen = new Set()
  const cleaned = []
  for (const raw of options) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    cleaned.push(text)
  }
  return cleaned
}

/** Один голос на человека, в порядке подачи. */
export function uniqueVotes(votes) {
  const seen = new Set()
  const unique = []
  for (const vote of votes) {
    const key = String(vote)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(vote)
  }
  return unique
}

/** Сколько разных людей проголосовало во всём опросе. */
export function voterCount(poll) {
  const voters = new Set()
  for (const option of poll.options) {
    for (const vote of option.votes) voters.add(String(vote))
  }
  return voters.size
}

/** Номер варианта, который выбрал человек, или -1. */
export function voteIndexOf(poll, userId) {
  return poll.options.findIndex((option) => option.votes.some((vote) => String(vote) === String(userId)))
}

/**
 * Записать или перенести один голос.
 *
 * Прежний голос удаляется, новый добавляется: два голоса у одного человека
 * невозможны. Закрытый опрос заморожен — устаревшая кнопка не должна его
 * оживить. Данные меняются только в памяти; запись делает вызывающий код.
 *
 * @param {object} poll - хранимый опрос.
 * @param {number|string} userId - кто голосует.
 * @param {number} optionIndex - номер варианта с нуля.
 * @returns {{poll: object, changed: boolean, previousIndex: number}|undefined}
 */
export function castVote(poll, userId, optionIndex) {
  if (!poll) return undefined
  const previousIndex = voteIndexOf(poll, userId)
  if (userId === undefined || userId === null) return { poll, changed: false, previousIndex: -1 }
  if (poll.closedAt !== undefined) return { poll, changed: false, previousIndex }
  if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
    return { poll, changed: false, previousIndex }
  }
  if (previousIndex === optionIndex) return { poll, changed: false, previousIndex }
  if (previousIndex !== -1) {
    poll.options[previousIndex].votes = poll.options[previousIndex].votes
      .filter((vote) => String(vote) !== String(userId))
  }
  poll.options[optionIndex].votes.push(userId)
  return { poll, changed: true, previousIndex }
}

/**
 * Текст опроса: вопрос, варианты с количеством и процентами и кто голосовал.
 *
 * Проценты считаются от числа разных проголосовавших, а не от числа записей,
 * поэтому перенос голоса не поднимает сумму выше 100%.
 */
export function pollMessage(poll, { names = {} } = {}) {
  if (!poll || !Array.isArray(poll.options)) return ''
  const total = voterCount(poll)
  const lines = [`📊 Опрос «${poll.question}»`]
  poll.options.forEach((option, index) => {
    const votes = uniqueVotes(option.votes)
    const share = total === 0 ? '' : ` (${Math.round((votes.length / total) * 100)}%)`
    const who = votes.map((vote) => names[vote] ?? String(vote))
    const voters = who.length > 0 ? `: ${who.join(', ')}` : ''
    lines.push(`${index + 1}. ${option.text} — ${votes.length}${share}${voters}`)
  })
  lines.push('', total === 0 ? 'Пока никто не голосовал.' : `Всего проголосовало: ${total}.`)
  if (poll.closedAt !== undefined) lines.push('', 'Опрос закрыт.')
  return lines.join('\n')
}

/** Клавиатура опроса: по кнопке на вариант; после закрытия кнопок нет. */
export function pollKeyboard(poll, { prefix = 'poll' } = {}) {
  if (!poll || !Array.isArray(poll.options) || poll.closedAt !== undefined) return undefined
  return {
    rows: poll.options.map((option, index) => [{ text: option.text, data: `${prefix}:${poll.id}:${index}` }]),
  }
}

/** Одна строка результата для сводки. */
export function pollResultsLine(poll) {
  if (!poll || !Array.isArray(poll.options)) return undefined
  const parts = poll.options.map((option) => `${option.text} — ${uniqueVotes(option.votes).length}`)
  return `опрос «${poll.question}»: ${parts.join(', ')}`
}

/**
 * Разобрать payload кнопки (`<prefix>:<id>:<index>`).
 *
 * Строго намеренно: сюда приходит всё, что шлёт чат, и кривой payload не должен
 * молча засчитаться как голос за вариант 0.
 */
export function parsePollAction(data, { prefix = 'poll' } = {}) {
  if (typeof data !== 'string') return undefined
  const parts = data.split(':')
  if (parts.length !== 3) return undefined
  const [action, id, index] = parts
  if (action !== prefix) return undefined
  if (!/^[1-9]\d*$/.test(id)) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(index)) return undefined
  const optionIndex = Number(index)
  if (!Number.isSafeInteger(optionIndex)) return undefined
  return { id, optionIndex }
}

/**
 * Правила домена опросов.
 *
 * @param {object} options - `store` — хранилище опросов.
 * @returns {object} правила создания и голосования.
 */
export function rulesOfPolls({ store, access } = {}) {
  const guard = access ?? store?.access
  const readOnlyText = 'Ошибка инструмента poll: в этом проекте у вас роль viewer (только просмотр), создать опрос нельзя.'
  const readOnlyToast = 'Только просмотр: голосовать в этом проекте нельзя'

  return {
    store,

    /** Правила инструмента `poll`: проверить вход и создать опрос. */
    async create({ question, options } = {}, { chatId, userId } = {}) {
      if (!Number.isFinite(chatId)) return { text: 'Ошибка инструмента poll: не удалось определить чат.' }
      const clean = String(question ?? '').trim()
      if (clean === '') {
        return { text: 'Ошибка инструмента poll: нужен вопрос опроса. Спроси у пользователя, что именно голосуем.' }
      }
      if (clean.length > MAX_QUESTION_LENGTH) {
        return { text: `Ошибка инструмента poll: вопрос длиннее ${MAX_QUESTION_LENGTH} символов. Сократи его и вызови инструмент снова.` }
      }
      const cleaned = cleanOptions(options)
      if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) {
        return { text: `Ошибка инструмента poll: нужно от ${MIN_OPTIONS} до ${MAX_OPTIONS} разных непустых вариантов (получено ${cleaned.length}).` }
      }
      const tooLong = cleaned.find((text) => text.length > MAX_OPTION_LENGTH)
      if (tooLong !== undefined) {
        return { text: `Ошибка инструмента poll: вариант «${tooLong}» длиннее ${MAX_OPTION_LENGTH} символов. Сократи его и вызови инструмент снова.` }
      }

      if (guard && userId !== undefined) {
        const scopeId = guard.scopeIdFor(userId, chatId)
        if (!guard.canWriteScope(userId, scopeId)) return { text: readOnlyText }
      }
      let poll
      try {
        poll = store.add({ chatId, userId, question: clean, options: cleaned })
      } catch (error) {
        if (/access denied/.test(String(error?.message))) return { text: readOnlyText }
        throw error
      }
      if (!poll) return { text: 'Ошибка инструмента poll: не удалось создать опрос, проверь вопрос и варианты.' }
      // Подтверждённый опрос обязан пережить перезапуск до первого нажатия.
      await store.flush()
      const list = poll.options.map((option, index) => `${index + 1}) ${option.text}`).join(', ')
      return {
        text: `Опрос №${poll.id} создан: «${poll.question}».\nВарианты: ${list}.\nОтправь сообщение с кнопками: ${poll.options.length} шт. Голоса считаются по нажатиям.`,
        poll,
      }
    },

    /**
     * Голос из кнопки: перенести голос и сказать, что показать пользователю.
     *
     * Запись на диск делает ядро после перерисовки сообщения: прежний порядок
     * «сначала правим сообщение, потом сохраняем» не меняется.
     *
     * @returns {Promise<{poll?: object, changed?: boolean, toast: string}>} результат.
     */
    async vote(id, userId, optionIndex) {
      const poll = store?.get?.(id)
      if (!poll) return { toast: 'Опрос уже закрыт' }
      if (guard && userId !== undefined) {
        // Чужой опрос не должен даже подтверждать своё существование.
        if (!guard.canRead(userId, poll)) return { toast: 'Опрос не найден или недоступен', denied: true }
        if (!guard.canWrite(userId, poll)) return { poll, changed: false, toast: readOnlyToast, denied: true }
      }
      const result = store.vote(id, userId, optionIndex)
      if (!result?.poll) return { toast: 'Опрос уже закрыт' }
      if (result.denied) return { poll: result.poll, changed: false, toast: readOnlyToast, denied: true }
      return {
        ...result,
        toast: result.poll.closedAt !== undefined
          ? 'Опрос уже закрыт'
          : result.changed
            ? 'Голос учтён'
            : 'Вы уже голосовали так',
      }
    },

    /** Текст и кнопки опроса для отправки и перерисовки. */
    message: pollMessage,
    keyboard: pollKeyboard,
    resultsLine: pollResultsLine,
    parseAction: parsePollAction,
  }
}
