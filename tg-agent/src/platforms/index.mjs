/**
 * Platform factory: one process serves one messenger, chosen by `PLATFORM`.
 *
 * Adapters are imported lazily so a Telegram deployment never loads MAX code and
 * the other way round.
 */
import { ConfigError } from '../config.mjs'

/**
 * Build the adapter for the configured platform.
 *
 * @param {object} config - loaded configuration.
 * @param {object} logger - logger.
 * @returns {Promise<object>} an object implementing the port from `port.mjs`.
 */
export async function createPlatform(config, logger) {
  if (config.platform.name === 'max') {
    if (!config.platform.maxToken) throw new ConfigError('PLATFORM=max requires MAX_TOKEN (токен бота из MAX для бизнеса)')
    const { createMaxPlatform } = await import('./max.mjs')
    return createMaxPlatform({
      token: config.platform.maxToken,
      apiBase: config.platform.maxApiBase,
      timeoutMs: config.platform.maxTimeoutMs,
      logger,
    })
  }
  if (config.platform.name === 'vk') {
    if (!config.platform.vkToken) throw new ConfigError('PLATFORM=vk requires VK_TOKEN (ключ сообщества VK)')
    const { createVkPlatform } = await import('./vk.mjs')
    return createVkPlatform({
      token: config.platform.vkToken,
      groupId: config.platform.vkGroupId,
      apiBase: config.platform.vkApiBase,
      apiVersion: config.platform.vkApiVersion,
      timeoutMs: config.platform.vkTimeoutMs,
      logger,
    })
  }
  if (config.platform.name === 'vk-teams') {
    if (!config.platform.vkTeamsToken) throw new ConfigError('PLATFORM=vk-teams requires VK_TEAMS_TOKEN (токен бота из VK Teams)')
    const { createVkTeamsPlatform } = await import('./vk-teams.mjs')
    return createVkTeamsPlatform({
      token: config.platform.vkTeamsToken,
      apiBase: config.platform.vkTeamsApiBase,
      timeoutMs: config.platform.vkTeamsTimeoutMs,
      logger,
    })
  }
  const { createTelegramPlatform } = await import('./telegram.mjs')
  return createTelegramPlatform({
    token: config.telegram.token,
    apiBase: config.telegram.apiBase,
    timeoutMs: config.telegram.timeoutMs,
    logger,
  })
}

/**
 * State file name for one platform.
 *
 * Telegram keeps the historical names (`history.json`), so an existing bot keeps
 * its data; every other platform gets its own suffixed files, which also means
 * two processes never write the same file.
 *
 * @param {string} dataDir - state directory.
 * @param {string} base - logical name, e.g. `history`.
 * @param {string} platformName - `telegram` or `max`.
 * @returns {string} absolute path.
 */
export const stateFile = (dataDir, base, platformName) =>
  `${dataDir}/${base}${platformName === 'telegram' ? '' : `-${platformName}`}.json`

