/**
 * Инструмент `server` и команда `/server`: как бот рассказывает о своей машине.
 *
 * Факты собирает `src/server-status.mjs`; здесь решается только то, что увидит
 * модель и что покажет команда. Ничего не привязано к одному серверу: подпись и
 * пути приходят из конфигурации, поэтому код одинаков в Испании и в Финляндии.
 */
import { SERVER_STATUS_HINT, collectServerStatus, formatServerStatus } from '../server-status.mjs'
import { createTool } from './contract.mjs'

/** Описание инструмента для модели. */
export const SERVER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'server',
    description: SERVER_STATUS_HINT,
    parameters: { type: 'object', properties: {} },
  },
}

/**
 * Собрать инструмент.
 *
 * @param {object} [options] - `{ label, services, releasePath, dataDir, timeZone, exec, logger }`.
 * @returns {{definition: object, execute: Function, executeDetailed: Function, collect: Function, format: Function}} инструмент.
 */
export function createServerTool({ label = 'сервер', services, releasePath, dataDir, timeZone = '', exec, logger, diskWarnPercent = 90 } = {}) {
  const collect = () => collectServerStatus({
    label,
    ...(services ? { services } : {}),
    ...(releasePath ? { releasePath } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(exec ? { exec } : {}),
    ...(logger ? { logger } : {}),
    timeZone,
    diskWarnPercent,
  })
  const executeDetailed = async () => {
    try {
      const status = await collect()
      return { text: formatServerStatus(status, { warnPercent: diskWarnPercent, timeZone }), status }
    } catch (error) {
      logger?.warn?.('server status failed', { error: error?.message ?? error })
      return { text: 'Не удалось собрать состояние сервера.' }
    }
  }
  const tool = createTool({ definition: SERVER_TOOL_DEFINITION, executeDetailed })
  // Команда `/server` и тесты пользуются разбором статуса напрямую.
  return {
    ...tool,
    collect,
    format: (status) => formatServerStatus(status, { warnPercent: diskWarnPercent, timeZone }),
  }
}
