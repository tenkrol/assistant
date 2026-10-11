/**
 * The `server` tool and the `/server` command: how the bot reports on its own machine.
 *
 * The facts come from `src/server-status.mjs`; this file only decides what the model
 * and the command see. Nothing here is specific to one server — the label and paths
 * come from the configuration, so the same code works in Испания and in Финляндия.
 */
import { SERVER_STATUS_HINT, collectServerStatus, formatServerStatus } from './server-status.mjs'

/** The tool definition handed to the model. */
export const SERVER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'server',
    description: SERVER_STATUS_HINT,
    parameters: { type: 'object', properties: {} },
  },
}

/**
 * Build the tool.
 *
 * @param {object} [options] - `{ label, services, releasePath, dataDir, timeZone, exec, logger }`.
 * @returns {{definition: object, execute: Function, executeDetailed: Function, collect: Function, format: Function}} the tool.
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
  return {
    definition: SERVER_TOOL_DEFINITION,
    collect,
    format: (status) => formatServerStatus(status, { warnPercent: diskWarnPercent, timeZone }),
    executeDetailed,
    execute: async () => (await executeDetailed()).text,
  }
}
