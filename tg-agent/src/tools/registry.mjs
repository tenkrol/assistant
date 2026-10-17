/**
 * Реестр инструментов модели.
 *
 * Ядро больше не собирает список инструментов и не знает, что делать с каждым
 * именем: оно получает `definitions` для модели и зовёт `executeTool(name, args,
 * context)`. Всё, что относится к конкретному инструменту, остаётся здесь или в
 * его модуле.
 *
 * Реестр получает зависимости (хранилища, домены, подключения, конфиг, логгер) и
 * терпит отсутствие любой из них: выключенные возможности просто не попадают в
 * список, как и раньше.
 */
import { pollKeyboard, pollMessage } from '../domain/polls.mjs'
import { asTool, createTool } from './contract.mjs'
import { createEventTool } from './event-tool.mjs'
import { createHistoryTool } from './history-tool.mjs'
import { createPollTool } from './poll-tool.mjs'
import { createProfileTool } from './profile-tool.mjs'
import { createReminderTool } from './reminder-tool.mjs'
import { createSendToTool } from './sendto-tool.mjs'

/**
 * Собрать реестр инструментов.
 *
 * @param {object} options - зависимости.
 * @param {object} [options.config] - конфигурация бота.
 * @param {object} [options.domains] - правила доменов (профили, напоминания и т. д.).
 * @param {object} [options.logger] - логгер.
 * @param {object} [options.history] - хранилище истории разговоров.
 * @param {object} [options.webTools] - подключение web-инструментов (`definitions`, `execute`).
 * @param {object} [options.agentBridge] - мост к агенту-исполнителю.
 * @param {object} [options.reminders] - `{ store, tool }` напоминаний.
 * @param {object} [options.profiles] - `{ store, tool }` профилей и памяти.
 * @param {object} [options.events] - `{ store, tool }` календаря.
 * @param {object} [options.polls] - `{ store, tool }` опросов.
 * @param {object} [options.files] - инструмент файлов.
 * @param {object} [options.youtube] - инструмент YouTube.
 * @param {object} [options.server] - инструмент состояния сервера.
 * @param {object} [options.contacts] - справочник контактов для `sendto`.
 * @param {string} [options.ownerName] - имя владельца для подписи `sendto`.
 * @param {(chatId: number|string, markdown: string, replyTo?: number|string, keyboard?: object) => Promise<object>} [options.sendText] - доставка текста в чат.
 * @param {(poll: object) => object|string[]} [options.namesOf] - имена голосующих для сообщения опроса.
 * @returns {{definitions: object[], executeTool: Function, has: Function, definitionOf: Function}} реестр.
 */
export function createToolRegistry({
  config = {},
  domains,
  logger,
  history,
  webTools,
  agentBridge,
  reminders,
  profiles,
  events,
  polls,
  files,
  youtube,
  server,
  contacts,
  ownerName,
  sendText,
  namesOf,
} = {}) {
  const timeZone = config.time?.timeZone ?? ''
  /** @type {Array<{name: string, tool: object}>} */
  const entries = []
  const byName = new Map()
  /** Имена проголосовавших: колбэк, иначе домен профилей. */
  const pollNames = (poll) => namesOf?.(poll) ?? domains?.profiles?.namesOf?.(poll) ?? []

  /**
   * Подставить сохранённый город в аргументы погоды.
   *
   * @param {object} args - аргументы модели.
   * @param {object} context - контекст хода.
   * @returns {object} аргументы, возможно, с городом.
   */
  const withSavedCity = (args, context) => {
    if (context.isGroup) return args ?? {}
    const city = typeof args?.city === 'string' ? args.city.trim() : ''
    if (city !== '' || context.userId === undefined) return args ?? {}
    const saved = domains?.profiles?.cityOf?.(context.userId) ?? profiles?.store?.city?.(context.userId)
    return saved ? { ...args, city: saved } : (args ?? {})
  }

  /**
   * Зарегистрировать один инструмент.
   *
   * Первый инструмент с таким именем выигрывает: встроенный важнее одноимённого
   * web-инструмента, как было и в ручном диспетчере.
   */
  const add = (tool) => {
    if (!tool?.definition) return
    const normalized = asTool(tool)
    const name = normalized.definition.function?.name
    if (!name) return
    const entry = { name, tool: normalized }
    entries.push(entry)
    if (!byName.has(name)) byName.set(name, entry)
  }

  // Подключения отдают свои определения сами: web-поиск, страницы, погода,
  // праздники, анекдоты, умный дом и мост к агенту.
  for (const definition of webTools?.definitions ?? []) {
    const name = definition?.function?.name
    if (!name) continue
    add(createTool({
      definition,
      executeDetailed: async (args = {}, context = {}) => {
        // Погода без города означает «мой город»: его подставляет профиль,
        // чтобы человеку не приходилось повторять, где он живёт. В группе
        // этого не делаем — иначе город говорящего узнают все.
        const prepared = name === 'weather' ? withSavedCity(args, context) : args
        return { text: await webTools.execute(name, prepared, { signal: context.signal }) }
      },
    }))
  }
  if (agentBridge?.enabled) {
    for (const definition of agentBridge.definitions ?? []) {
      const name = definition?.function?.name
      if (!name) continue
      add(createTool({
        definition,
        executeDetailed: async (args = {}, context = {}) => ({ text: await agentBridge.execute(name, args, context) }),
      }))
    }
  }

  // Встроенные инструменты: готовый объект из ядра или собранный из хранилища.
  add(reminders?.tool ?? (reminders?.store ? createReminderTool({ store: reminders.store, timeZone, logger }) : undefined))
  add(profiles?.tool ?? (profiles?.store ? createProfileTool({ store: profiles.store, logger }) : undefined))
  add(files)
  add(events?.tool ?? (events?.store ? createEventTool({ store: events.store, reminders: reminders?.store, timeZone, logger }) : undefined))
  add(polls?.tool ?? (polls?.store ? createPollTool({ store: polls.store }) : undefined))
  add(youtube)
  add(server)
  if (typeof sendText === 'function') {
    add(createSendToTool({
      send: (message) => sendText(message.chatId, message.text),
      contacts,
      ownerName,
      logger,
    }))
  }
  if (history) add(createHistoryTool({ history, timeZone }))

  const definitions = entries.map((entry) => entry.tool.definition)

  /** Найти инструмент по имени, не бросая исключений. */
  const find = (name) => byName.get(String(name ?? ''))

  /**
   * Выполнить инструмент по имени.
   *
   * Неизвестное имя и любая ошибка инструмента возвращаются текстом для модели,
   * а не исключением: один сбой не должен обрывать весь ход диалога.
   *
   * @param {string} name - имя инструмента.
   * @param {object} [args] - аргументы от модели.
   * @param {object} [context] - `{ chatId, userId, isGroup, replyTo, signal, onResult }`.
   * @returns {Promise<string>} текст результата.
   */
  const executeTool = async (name, args = {}, context = {}) => {
    const entry = find(name)
    if (!entry) {
      // Совместимость: при включённых web-инструментах прежний диспетчер
      // передавал неизвестное имя подключению, и оно перечисляло доступные.
      if (typeof webTools?.execute === 'function') {
        try {
          return await webTools.execute(name, args ?? {}, { signal: context.signal })
        } catch (error) {
          return `Ошибка инструмента ${name}: ${error?.message ?? error}`
        }
      }
      return `Инструмент ${name} не поддерживается.`
    }
    let outcome
    try {
      const result = await entry.tool.executeDetailed(args ?? {}, context)
      outcome = { ...result, name: entry.name }
      // Сообщение опроса — часть результата инструмента: сначала отправляем
      // его с кнопками, потом отдаём модели текст подтверждения.
      if (outcome.poll && typeof sendText === 'function') {
        await sendText(
          context.chatId,
          pollMessage(outcome.poll, { names: pollNames(outcome.poll) }),
          context.replyTo,
          pollKeyboard(outcome.poll),
        )
      }
    } catch (error) {
      outcome = { name: entry.name, text: `Ошибка инструмента ${entry.name}: ${error?.message ?? error}` }
    }
    try {
      context.onResult?.(outcome)
    } catch (error) {
      // Обработчик результата — код ядра; его сбой не должен ломать ответ.
      logger?.warn?.('tool result handler failed', { tool: entry.name, error: error?.message ?? error })
    }
    return typeof outcome.text === 'string' ? outcome.text : ''
  }

  return {
    definitions,
    executeTool,
    /** Есть ли такой инструмент. */
    has: (name) => find(name) !== undefined,
    /** Схема инструмента по имени (для совместимости и тестов). */
    definitionOf: (name) => find(name)?.tool.definition,
  }
}
