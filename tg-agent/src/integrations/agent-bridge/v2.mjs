/**
 * Клиент агента, контракт v2 (PLB-009).
 *
 * Задача уходит на `/v1/tasks` с постоянным `requestId`, маршрутом ответа и
 * файлами через `/v1/files`; результат и вопрос приходят событиями в точку
 * приёма. Сеть — только здесь, правила — в домене agent-link.
 */
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../logger.mjs'
import { deadlineSignal } from '../connection.mjs'

export const AGENT_TOOL_NAME = 'ask_agent'
const DEFAULT_URL = 'http://127.0.0.1:8787/bridge'
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

export class AgentBridgeError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'AgentBridgeError'
    this.status = status
  }
}

const trimBase = (url) => String(url ?? '').replace(/\/+$/, '').replace(/\/bridge$/, '')

export function createAgentBridgeV2({
  url = DEFAULT_URL,
  token = '',
  platformName = 'telegram',
  logger = createLogger(),
  maxTaskChars = 4000,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const enabled = Boolean(url && token && platformName === 'telegram' && fetchImpl)
  const base = trimBase(url)
  const headers = () => ({ authorization: `Bearer ${token}` })

  async function call(path, { method = 'POST', body } = {}) {
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { ...headers(), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: deadlineSignal(timeoutMs),
      })
    } catch (error) {
      throw new AgentBridgeError(`агент недоступен: ${error?.message ?? error}`)
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload?.ok !== true) {
      throw new AgentBridgeError(String(payload?.error ?? `агент ответил ${response.status}`).slice(0, 200), { status: response.status })
    }
    return payload
  }

  async function uploadFile({ bytes, name, mime } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new AgentBridgeError('пустой файл')
    if (bytes.length > maxFileBytes) throw new AgentBridgeError(`файл больше ${maxFileBytes} байт`)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name || 'file')
    let response
    try {
      response = await fetchImpl(`${base}/v1/files`, {
        method: 'POST',
        headers: headers(),
        body: form,
        signal: deadlineSignal(timeoutMs),
      })
    } catch (error) {
      throw new AgentBridgeError(`не удалось загрузить файл: ${error?.message ?? error}`)
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload?.ok !== true || !payload.fileId) {
      throw new AgentBridgeError(String(payload?.error ?? `загрузка файла: ${response.status}`).slice(0, 200), { status: response.status })
    }
    return payload
  }

  async function downloadFile(fileId, { maxBytes = maxFileBytes } = {}) {
    let response
    try {
      response = await fetchImpl(`${base}/v1/files/${encodeURIComponent(fileId)}`, {
        headers: headers(),
        signal: deadlineSignal(timeoutMs),
      })
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
    if (!response.ok) return { ok: false, error: `файл недоступен (${response.status})` }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) return { ok: false, error: 'файл больше лимита' }
    return { ok: true, bytes, mime: response.headers?.get?.('content-type') ?? 'application/octet-stream' }
  }

  async function submitTask({ task, route, attachments = [], facts = [], revisionOf, source = 'chat-bot' } = {}) {
    return call('/v1/tasks', {
      body: {
        contract: 2,
        requestId: randomUUID(),
        task: String(task),
        source,
        ...(revisionOf ? { revisionOf: String(revisionOf) } : {}),
        ...(route ? { route } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(facts.length > 0 ? { context: { facts } } : {}),
      },
    })
  }

  async function replyTask(taskId, text, { variant } = {}) {
    return call(`/v1/tasks/${encodeURIComponent(taskId)}/reply`, {
      body: { contract: 2, requestId: randomUUID(), text: String(text), ...(variant ? { variant: Number(variant) } : {}) },
    })
  }

  async function cancelTask(taskId) {
    return call(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      body: { contract: 2, requestId: randomUUID() },
    })
  }

  async function getTask(taskId) {
    return call(`/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' })
  }

  /** Реестр агентов (PLB-015). */
  async function agents() {
    const payload = await call('/v1/agents', { method: 'GET' })
    return Array.isArray(payload?.agents) ? payload.agents : []
  }

  /** Последние события активности (PLB-015). */
  async function activity({ limit = 20, agent, taskId } = {}) {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    if (agent) params.set('agent', String(agent))
    if (taskId) params.set('taskId', String(taskId))
    const payload = await call(`/v1/activity?${params.toString()}`, { method: 'GET' })
    return Array.isArray(payload?.events) ? payload.events : []
  }

  /** Расходы агента (PLB-015). */
  async function usage() {
    const payload = await call('/v1/usage', { method: 'GET' })
    return payload?.usage ?? {}
  }

  /** Создать draft-заявку (PLB-017). */
  async function createRequest({ text, title } = {}) {
    const payload = await call('/v1/requests', { body: { text, title } })
    return payload ?? {}
  }

  const definition = {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAME,
      description: 'Передать задачу агенту-исполнителю на отдельном сервере: он умеет работать '
        + 'с файлами и кодом, делать документы (DOCX/XLSX/PPTX) и присылать готовый файл. '
        + 'Используй, когда нужен результат-файл или длинная работа. Результат придёт отдельным '
        + 'сообщением в этот же чат; можно передать revisionOf — id прошлой задачи, если нужно доработать.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Полная формулировка задачи для агента: что сделать и в каком виде отдать результат.',
          },
          revisionOf: {
            type: 'string',
            description: 'Необязательный id прошлой задачи агента, если нужно доработать её результат.',
          },
        },
        required: ['task'],
      },
    },
  }

  return {
    enabled,
    contract: 'v2',
    definitions: enabled ? [definition] : [],
    submitTask,
    replyTask,
    cancelTask,
    getTask,
    createRequest,
    agents,
    activity,
    usage,
    uploadFile,
    downloadFile,

    async execute(name, args = {}, context = {}) {
      if (!enabled) return 'Мост к агенту-исполнителю не настроен: задача не передана.'
      if (name !== AGENT_TOOL_NAME) return `Инструмент ${name} не поддерживается.`
      const raw = String(args?.task ?? '').trim()
      if (raw === '') return 'Задачу не передал: пустой текст. Спроси пользователя, что именно нужно сделать.'
      const task = raw.length > maxTaskChars ? raw.slice(0, maxTaskChars) : raw

      const route = context.chatId === undefined
        ? undefined
        : {
          platform: 'telegram',
          botId: context.botId === undefined ? undefined : String(context.botId),
          chatId: String(context.chatId),
          messageId: context.replyTo === undefined ? undefined : Number(context.replyTo),
        }
      const attachments = []
      for (const item of context.attachments ?? []) {
        if (!item?.fileId || typeof context.downloadFile !== 'function') continue
        try {
          const file = await context.downloadFile(item.fileId, { maxBytes: maxFileBytes })
          const bytes = file?.bytes ?? file
          if (!Buffer.isBuffer(bytes)) continue
          const uploaded = await uploadFile({ bytes, name: item.fileName ?? item.name ?? 'file', mime: item.mime })
          attachments.push({ fileId: uploaded.fileId, kind: item.kind ?? 'document', name: uploaded.name, mime: uploaded.mime, size: uploaded.size })
        } catch (error) {
          logger?.warn('agent attachment upload failed', { error })
        }
      }

      let payload
      try {
        payload = await submitTask({ task, route, attachments, revisionOf: args?.revisionOf })
      } catch (error) {
        logger?.warn('agent bridge v2 rejected the task', { error, status: error?.status })
        return `Агент не принял задачу: ${String(error?.message ?? error).slice(0, 160)}. Скажи пользователю и предложи повторить позже.`
      }
      logger?.info('task handed to the agent v2', {
        taskId: payload?.taskId,
        chars: task.length,
        attachments: attachments.length,
        routed: Boolean(route),
      })
      return `Задача ${payload?.taskId ? `${payload.taskId} ` : ''}передана агенту-исполнителю. `
        + 'Результат придёт отдельным сообщением в этот чат (текстом и файлами) — '
        + 'предупреди пользователя и не повторяй сама эту задачу.'
    },
  }
}
