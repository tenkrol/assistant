/**
 * Инструмент `find_history`: поиск по прошлой переписке этого чата.
 *
 * Раньше описание, поиск и форматирование собирались прямо в `bot.mjs`. Теперь
 * ядро только передаёт хранилище истории; сам поиск и текст ответа — здесь, а
 * правила ранжирования остаются в `src/history-search.mjs`.
 */
import { SEARCH_HINT, formatSearchResults, searchMessages } from '../history-search.mjs'
import { createTool } from './contract.mjs'

/** Описание инструмента для модели. */
export const FIND_HISTORY_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'find_history',
    description: SEARCH_HINT,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Что искать в прошлой переписке: 1–3 ключевых слова.' } },
      required: ['query'],
    },
  },
}

/**
 * Собрать инструмент поиска по истории.
 *
 * Многословный вопрос требует одного твёрдого совпадения, а не любого
 * случайного: с обычным порогом «что мы решали» совпадает с половиной чата.
 *
 * @param {object} options - зависимости.
 * @param {{ messages: (chatKey: string) => Array<object> }} options.history - хранилище истории.
 * @param {string} [options.timeZone] - пояс для дат в ответе.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
 */
export function createHistoryTool({ history, timeZone = '' } = {}) {
  const executeDetailed = async (args = {}, context = {}) => {
    const chatKey = String(context.chatId ?? '')
    const query = String(args.query ?? '')
    const messages = history?.messages?.(chatKey) ?? []
    const words = query.split(/\s+/).filter((word) => word.length > 1)
    const found = searchMessages(messages, query, { minScore: words.length >= 2 ? 120 : 1 })
    return { text: formatSearchResults(found, { query, timeZone }) }
  }

  return createTool({ definition: FIND_HISTORY_TOOL_DEFINITION, executeDetailed })
}
