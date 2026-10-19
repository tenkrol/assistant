/**
 * Bridge to the task agent in Finland.
 *
 * The chat bot does not do heavy work itself: when a request needs files, code or
 * documents, the model calls `ask_agent`, and the task is POSTed to the agent's
 * loopback endpoint. The hop travels through an SSH tunnel opened from this
 * server (`agent-bridge-tunnel.service`), so nothing is exposed to the internet
 * and no TLS certificate is involved.
 *
 * Telegram cannot carry this: a bot never receives messages sent by another bot
 * (measured on a live group — a plain mention, a `tg://user` link, an explicit
 * `mention` entity and a `/help@bot` command all stayed invisible to the agent).
 *
 * The return leg needs no work here: the agent sends the result — text and files
 * — straight to the owner, so this side only hands the task over and tells the
 * user what to expect.
 *
 * The bridge is inert until a URL and a token are configured, which keeps the
 * chat bot behaviour byte-for-byte identical on a deployment without the agent.
 */
import { createLogger } from '../../logger.mjs'
import { deadlineSignal } from '../connection.mjs'
import { createAgentBridgeV2 } from './v2.mjs'

export { AgentBridgeError } from './v2.mjs'

/** The tool name the model sees. */
export const AGENT_TOOL_NAME = 'ask_agent'

const DEFAULT_URL = 'http://127.0.0.1:8787/bridge'

function createAgentBridgeLegacy({
  url = DEFAULT_URL,
  token = '',
  platformName = 'telegram',
  logger = createLogger(),
  maxTaskChars = 4000,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const enabled = Boolean(url && token && platformName === 'telegram' && fetchImpl)

  const definition = {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAME,
      description: 'Передать задачу агенту-исполнителю на отдельном сервере: он умеет работать '
        + 'с файлами и кодом, делать документы (DOCX/XLSX/PPTX) и присылать готовый файл. '
        + 'Используй, когда нужен результат-файл или длинная работа. Результат придёт отдельным '
        + 'сообщением от @Tenkrol_ag_bot — скажи об этом пользователю.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Полная формулировка задачи для агента: что сделать и в каком виде отдать результат.',
          },
        },
        required: ['task'],
      },
    },
  }

  return {
    enabled,
    definitions: enabled ? [definition] : [],

    /**
     * Hand one task to the agent.
     *
     * @param {string} name - tool name; anything else is reported back.
     * @param {object} args - `task` text.
     * @returns {Promise<string>} what the model should tell the user.
     */
    async execute(name, args = {}) {
      if (!enabled) return 'Мост к агенту-исполнителю не настроен: задача не передана.'
      if (name !== AGENT_TOOL_NAME) return `Инструмент ${name} не поддерживается.`
      const task = String(args?.task ?? '').trim()
      if (task === '') return 'Задачу не передал: пустой текст. Спроси пользователя, что именно нужно сделать.'
      const text = task.length > maxTaskChars ? task.slice(0, maxTaskChars) : task

      let payload
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ task: text, source: 'chat-bot' }),
          signal: deadlineSignal(timeoutMs),
        })
        payload = await response.json().catch(() => ({}))
        if (!response.ok || payload?.ok !== true) {
          logger?.warn('agent bridge rejected the task', { status: response.status, error: payload?.error })
          return 'Агент не принял задачу. Скажи пользователю, что передать не удалось, и повтори позже.'
        }
      } catch (error) {
        logger?.warn('agent bridge unreachable', { error })
        return 'Агент недоступен: мост не отвечает. Скажи пользователю, что задача не ушла.'
      }

      logger?.info('task handed to the agent', { taskId: payload?.taskId, chars: text.length })
      return `Задача ${payload?.taskId ? `${payload.taskId} ` : ''}передана агенту-исполнителю. `
        + 'Результат придёт отдельным сообщением от @Tenkrol_ag_bot (текстом и файлами) — '
        + 'предупреди пользователя и не повторяй сама эту задачу.'
    },
  }
}


/**
 * Область задачи из моста в терминах пространств бота.
 *
 * Агент живёт на другом сервере и своих `scope_id` бота не знает: он отдаёт
 * область задачи из проверенного контекста (чат/рабочее место). Пространства
 * бота — отдельная модель, поэтому задача, пришедшая по мосту, личная для
 * проверенного владельца. Готовый `personal-…`/`project-…` не переписываем:
 * он уже называет пространство бота.
 *
 * @param {string|number} raw - `scopeId` из активности агента.
 * @param {string|number} userId - проверенный владелец задачи.
 * @returns {string} `scopeId` для ACL бота.
 */
function normalizeScopeId(raw, userId) {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  if (/^(?:personal|project)-/.test(value)) return value
  return `personal-${userId}`
}

/**
 * Привести событие активности агента к виду задачи для проактивности.
 *
 * Поля `userId`/`scopeId` приходят из проверенного контекста задачи на стороне
 * агента. Без `userId` событие остаётся как есть: проактивность отфильтрует
 * его как задачу без владельца, а не сделает общедоступной.
 *
 * @param {object} event - событие `/v1/activity`.
 * @param {object} [options] - `channel` (не используется для id, оставлен для
 *   совместимости с будущими каналами).
 * @returns {object} событие с `taskPrincipal`-полями.
 */
export function normalizeActivityEvent(event, options = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const userId = event.userId ?? event.ownerId
  if (userId === undefined || userId === null || userId === '') return event
  const rawScope = event.scopeId ?? event.scope_id
  const scopeId = normalizeScopeId(rawScope, userId)
  return {
    ...event,
    userId,
    ...(scopeId === '' ? {} : { scopeId }),
  }
}

/** Обернуть клиент так, чтобы его активность уже несла владельца и область. */
function withNormalizedActivity(bridge, options) {
  if (typeof bridge?.activity !== 'function') return bridge
  return {
    ...bridge,
    async activity(query) {
      const events = await bridge.activity(query)
      return Array.isArray(events)
        ? events.map((event) => normalizeActivityEvent(event, options))
        : events
    },
  }
}

/** Выбрать режим контракта: v2 (по умолчанию) или прежний /bridge. */
export function createAgentBridge(options = {}) {
  const bridge = String(options.contract ?? 'v1').toLowerCase() === 'v1'
    ? createAgentBridgeLegacy(options)
    : createAgentBridgeV2(options)
  return withNormalizedActivity(bridge, options)
}
