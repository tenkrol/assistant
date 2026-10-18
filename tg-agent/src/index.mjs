/**
 * Entry point: wire the configuration into clients, start the bot, and shut
 * down cleanly on SIGINT/SIGTERM (containers send SIGTERM on redeploy).
 *
 * `.env` is loaded automatically, so the README's `cp .env.example .env` flow
 * works without extra flags. An explicitly passed environment object (used by
 * tests and embedders) is never overridden.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError, loadConfig } from './config.mjs'
import { createLogger } from './logger.mjs'
import { createPlatform, stateFile } from './platforms/index.mjs'
import { ChatModel } from './model.mjs'
import { HistoryStore } from './history.mjs'
import { Assistant } from './bot.mjs'
import { createAgentBridge } from './agent-bridge.mjs'
import { createWebTools } from './web-tools.mjs'
import { createWeatherTool } from './weather.mjs'
import { forecastAlerts } from './weather-alerts.mjs'
import { ReminderScheduler, ReminderStore } from './reminders.mjs'
import { createReminderTool } from './reminder-tool.mjs'
import { ProfileStore } from './profiles.mjs'
import { EventStore } from './events.mjs'
import { PollStore, createPollTool } from './polls.mjs'
import { ScopeStore, migrateScopeMembers } from './scopes.mjs'
import { createAccess, migrateScopes } from './core/access.mjs'
import { createYoutubeTool } from './youtube-tool.mjs'
import { createServerTool } from './server-tool.mjs'
import { createEventTool } from './event-tool.mjs'
import { createMiniApp } from './miniapp.mjs'
import { createOutbox } from './outbox.mjs'
import { createAgentEventsStore } from './storage/agent-events.mjs'
import { createAgentLink } from './agent-link/index.mjs'
import { createProfileTool } from './profile-tool.mjs'
import { UsageStore } from './usage.mjs'
import { DigestService } from './digest.mjs'
import { ProactiveService, ProactiveStore } from './proactive.mjs'
import { createTranscriber } from './stt.mjs'
import { createSynthesizer } from './tts.mjs'
import { createFileTool } from './file-tool.mjs'
import { DocumentStore, createDocumentsTool, createModelSemanticRanker } from './documents.mjs'
import { createSmartHomeTool } from './smart-home.mjs'
import { createHolidaysTool } from './holidays.mjs'
import { createJokeSource, createJokeTool } from './jokes.mjs'

/** Warn when the process cannot honour a proxy that the environment declares. */
function proxyHint(logger, env) {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (!proxy) return
  const flag = process.execArgv.includes('--use-env-proxy') || env.NODE_USE_ENV_PROXY === '1' || env.NODE_USE_ENV_PROXY === 'true'
  if (flag) logger.info('proxy enabled', { proxy })
  else logger.warn('proxy variables are set but fetch will ignore them: start node with --use-env-proxy or NODE_USE_ENV_PROXY=1', { proxy })
}

/**
 * Load `KEY=VALUE` lines from a file into `process.env`.
 *
 * Uses `process.loadEnvFile` when the Node version provides it (20.12+) and a
 * small parser otherwise. Existing variables win, and a missing file is not an
 * error: the process may be configured entirely through the real environment.
 *
 * @param {string} file - path to the env file, relative to the working directory.
 * @returns {boolean} whether a file was read.
 */
export function loadEnvFile(file = '.env') {
  if (!fs.existsSync(file)) return false
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file)
    return true
  }
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    const value = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
    process.env[key] = value
  }
  return true
}

/** Build the model client for the configured backend. */
async function createModel(config, logger) {
  if (config.model.backend === 'dsh') {
    const { DshModel } = await import('./dsh-model.mjs')
    return new DshModel({
      command: config.model.dsh.command,
      profile: config.model.dsh.profile,
      home: config.model.dsh.home,
      timeoutMs: config.model.timeoutMs,
      logger,
    })
  }
  return new ChatModel({
    baseUrl: config.model.baseUrl,
    apiKey: config.model.apiKey,
    name: config.model.name,
    timeoutMs: config.model.timeoutMs,
    temperature: config.model.temperature,
    maxTokens: config.model.maxTokens,
    logger,
  })
}

export async function main({ env, platformFactory } = {}) {
  if (env === undefined) {
    loadEnvFile(process.env.DOTENV_FILE ?? '.env')
    env = process.env
  }

  let config
  try {
    config = loadConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const logger = createLogger({ level: config.logLevel, redact: [config.telegram.token, config.platform.maxToken, config.platform.vkToken, config.platform.vkTeamsToken, config.model.apiKey, config.agentBridge.token].filter(Boolean) })
  for (const warning of config.warnings) logger.warn(warning)
  proxyHint(logger, env)

  // Model and tool sources are built once and shared by every bot.
  const model = await createModel(config, logger)
  // Holiday and joke sources are shared by the model's tools and by the digest,
  // so both answer from the same place and neither fetches twice.
  const smartHome = config.smartHome.baseUrl && config.smartHome.token
    ? createSmartHomeTool({
      baseUrl: config.smartHome.baseUrl,
      token: config.smartHome.token,
      allowedEntities: config.smartHome.allowedEntities,
      logger,
    })
    : undefined
  const holidays = createHolidaysTool({ logger, country: config.digest.country || 'RU', timeZone: config.time.timeZone })
  const jokes = createJokeSource({ logger })
  // The dsh backend runs an agent that already carries its own web tools.
  const webTools = config.web.enabled && config.model.backend === 'openai'
    ? createWebTools({
      apiKey: config.model.apiKey,
      searchBaseUrl: config.web.searchBaseUrl,
      searchModel: config.web.searchModel,
      maxUses: config.web.maxUses,
      maxFetchBytes: config.web.maxFetchBytes,
      allowedHosts: config.web.allowedHosts,
      timeoutMs: Math.min(config.model.timeoutMs, 60000),
      // Weather, holidays and jokes come from their own APIs rather than from
      // search snippets: cached result pages were producing forecasts for the
      // wrong day, and an anecdote from a search result is rarely a good one.
      extraTools: [createWeatherTool({ timeoutMs: 20000, logger }), holidays, createJokeTool({ source: jokes }), ...(smartHome ? [smartHome] : [])],
      logger,
    })
    : undefined


  // One tool instance for every bot in the process: it holds no state.
  const sharedFiles = createFileTool()
  const sharedWebTools = webTools

  const instances = []
  for (const instance of config.bots) {
    try {
      instances.push(await createInstance({ config, logger, instance, shared: { model, webTools, holidays, jokes, files: sharedFiles }, platformFactory: platformFactory ?? createPlatform }))
    } catch (error) {
      // One broken bot must not stop the others: a wrong token is the usual cause.
      logger.error('bot failed to start', { label: instance.label, platform: instance.platform, error })
    }
  }
  if (instances.length === 0) {
    logger.error('no bot could be started: check the token of PLATFORM and the network')
    return 1
  }

  for (const { bot, instance } of instances) {
    logger.info('bot started', {
      label: instance.label,
      platform: instance.platform,
      identity: bot.platform.identity,
      backend: config.model.backend,
      model: bot.model.name,
      webTools: sharedWebTools ? sharedWebTools.definitions.map((definition) => definition.function.name).join('+') : 'off',
      agentBridge: bot.agentBridge?.enabled ? bot.agentBridge.definitions.map((definition) => definition.function.name).join('+') : 'off',
      timeZone: config.time.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      users: config.access.allowAllUsers ? 'all' : config.access.allowedUserIds.size,
      dataDir: config.dataDir,
      state: instance.namespace,
      reminders: bot.reminders ? bot.reminders.store.list().length : 'off',
      profiles: bot.profiles ? bot.profiles.store.size : 'off',
      digest: bot.digest ? `${config.digest.time} ${config.time.timeZone || 'system'}` : 'off',
      proactive: bot.proactive ? (bot.config.proactive?.enabled ? 'on' : 'dry-run') : 'off',
      dailyTokenLimit: config.usage.dailyLimit || 'off',
      media: [config.stt.provider !== 'none' && config.stt.apiKey ? 'voice' : '', 'photo', 'documents'].filter(Boolean).join('+'),
    })
  }

  /**
   * Stop every bot and exit.
   *
   * @param {string} signal - the signal that triggered shutdown.
   */
  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    logger.info('shutting down', { signal, bots: instances.length })
    for (const { bot } of instances) {
      await bot.outbox?.stop?.().catch((error) => logger.warn('outbox stop failed', { error: error?.message ?? error }))
      await bot.miniApp?.stop?.().catch((error) => logger.warn('mini app stop failed', { error: error?.message ?? error }))
      await bot.stop().catch((error) => logger.error('shutdown failed', { error }))
      await bot.agentEvents?.flush?.().catch?.(() => {})
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { error: reason }))

  // Polling keeps the process alive; a signal ends it through shutdown().
  return 0
}

const isEntryPoint = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`
if (isEntryPoint) {
  const code = await main()
  if (code !== 0) process.exit(code)
}

/**
 * Build one bot.
 *
 * Every bot owns its adapter, its state files (named by its namespace), its
 * reminder scheduler and its digest. The model client and the tool sources are
 * shared: they hold no per-chat state, so one copy serves every bot.
 *
 * @param {object} options - build options.
 * @param {object} options.config - full configuration.
 * @param {object} options.logger - logger.
 * @param {{label: string, platform: string, token: string, namespace: string}} options.instance - which bot.
 * @param {object} options.shared - shared model and tools.
 * @param {Function} options.platformFactory - creates the adapter (injectable for tests).
 * @returns {Promise<object>} the bot plus its pieces.
 */
export async function createInstance({ config, logger, instance, shared, platformFactory }) {
  // The adapter is built from this bot's own token, so several bots of the same
  // platform can live in one process.
  const botConfig = {
    ...config,
    platform: {
      ...config.platform,
      name: instance.platform,
      maxToken: instance.platform === 'max' ? instance.token : config.platform.maxToken,
      vkToken: instance.platform === 'vk' ? instance.token : config.platform.vkToken,
      vkTeamsToken: instance.platform === 'vk-teams' ? instance.token : config.platform.vkTeamsToken,
    },
    telegram: { ...config.telegram, token: instance.platform === 'telegram' ? instance.token : config.telegram.token },
    // Access on this platform: the common list plus its own ids.
    access: {
      ...config.access,
      allowedUserIds: new Set([...config.access.allowedUserIds, ...(config.access.allowedByPlatform?.[instance.platform] ?? [])]),
    },
  }
  const { model, webTools, holidays, jokes, files, ocr } = shared
  // Пространства читаются первыми: без них миграция не знает личных областей.
  const scopesPath = stateFile(botConfig.dataDir, 'scopes', instance.namespace)
  const scopes = {
    // Платформа известна из адаптера: по ней старые участники получают principal.
    store: new ScopeStore({ file: scopesPath, logger, platform: instance.platform }),
  }
  await scopes.store.load()
  // Существующие участники (в том числе Маша) остаются; добавляется платформа.
  // Копия файла делается до записи, повторный запуск ничего не меняет.
  const memberMigration = await migrateScopeMembers({
    store: scopes.store,
    backupDir: path.join(botConfig.dataDir, 'backups'),
    logger,
  })
  if (memberMigration.migrated > 0) {
    logger.info('scope members migrated to principals', {
      records: memberMigration.migrated,
      backupDir: memberMigration.backupDir,
    })
  }
  const access = createAccess({ store: scopes.store, platform: instance.platform, logger })
  const history = new HistoryStore({
    file: stateFile(botConfig.dataDir, 'history', instance.namespace),
    limit: config.history.limit,
    maxChats: config.history.maxChats,
    logger,
    access,
  })
  await history.load()

  // The adapter is the only platform-specific piece of one bot.
  const platform = await platformFactory(botConfig, logger)
  // The bridge is created per instance: it posts into the group through this
  // instance's own platform adapter.
  const agentBridge = createAgentBridge({
    url: botConfig.agentBridge?.url,
    token: botConfig.agentBridge?.token,
    platformName: instance.platform,
    contract: botConfig.agentBridge?.contract,
    maxFileBytes: botConfig.agentBridge?.filesMaxBytes,
    logger,
  })
  // Журнал событий и ожидающих вопросов агента: только Telegram.
  const agentEvents = instance.platform === 'telegram'
    ? await createAgentEventsStore({
      file: stateFile(botConfig.dataDir, 'agent-events', instance.namespace),
      logger,
      retentionDays: botConfig.agentBridge?.eventsRetentionDays,
    }).load()
    : undefined
  const agentLink = instance.platform === 'telegram'
    ? createAgentLink({
      bridge: agentBridge,
      events: agentEvents,
      answerTimeoutMs: botConfig.agentBridge?.answerTimeoutMs,
      logger,
    })
    : undefined
  // Reminders live on disk: the store is read before the bot starts so overdue
  // reminders can be delivered right away, and the scheduler is built once the
  // bot exists because delivery goes through its `send`.
  const reminders = config.reminders.enabled
    ? { store: new ReminderStore({ file: stateFile(botConfig.dataDir, 'reminders', instance.namespace), logger, access }) }
    : undefined
  if (reminders) {
    await reminders.store.load()
    reminders.tool = createReminderTool({ store: reminders.store, timeZone: botConfig.time.timeZone })
  }

  // Profiles: durable facts about each user and their default city. Loaded before
  // the bot starts, because the first answer already uses them.
  const profiles = config.profiles.enabled
    ? { store: new ProfileStore({ file: stateFile(botConfig.dataDir, 'users', instance.namespace), logger, maxUsers: config.profiles.maxUsers, access }) }
    : undefined
  if (profiles) {
    await profiles.store.load()
    profiles.tool = createProfileTool({ store: profiles.store, access, logger })
  }

  // Token accounting: written by every answered message, read by /stats and by
  // the daily budget check.
  const usage = new UsageStore({
    file: stateFile(botConfig.dataDir, 'usage', instance.namespace),
    logger,
    retentionDays: config.usage.retentionDays,
    dailyLimit: config.usage.dailyLimit,
  })
  await usage.load()

  // Voice notes and documents: an optional transcriber plus the text extractor.
  // Both degrade to a note when unavailable, so a missing key never breaks a turn.
  const media = {
    extractText: async ({ fileName, mimeType, bytes }) => {
      const { extractText } = await import('./extract.mjs')
      return extractText({ fileName, mimeType, bytes })
    },
    ...(config.stt.provider !== 'none' && config.stt.apiKey
      ? {
        transcribe: createTranscriber({
          provider: config.stt.provider,
          apiKey: config.stt.apiKey,
          baseUrl: config.stt.baseUrl,
          model: config.stt.model,
          language: config.stt.language,
          folderId: config.stt.folderId,
          logger,
        }),
      }
      : {}),
  }

  // Spoken answers are opt-in per chat with /voice; the key may be the STT one.
  const tts = config.tts.provider !== 'none' && config.tts.apiKey
    ? createSynthesizer({
      apiKey: config.tts.apiKey,
      folderId: config.tts.folderId,
      voice: config.tts.voice,
      speed: config.tts.speed,
      maxChars: config.tts.maxChars,
      logger,
    })
    : undefined
  // Calendar: one store per bot instance, next to the other state files.
  const events = config.events?.enabled === false
    ? undefined
    : { store: new EventStore({ file: stateFile(botConfig.dataDir, 'events', instance.namespace), logger, timeZone: config.time?.timeZone, access }) }
  if (events) {
    await events.store.load()
    events.tool = createEventTool({ store: events.store, reminders, timeZone: config.time?.timeZone, logger })
  }
  // Polls, video summaries and the server report. YouTube and the server tool hold
  // no per-chat state, polls do — one store per bot, like reminders.
  const youtube = config.youtube?.enabled === false ? undefined : createYoutubeTool({ logger })
  const server = config.server?.enabled === false ? undefined : createServerTool({
    label: config.server?.label ?? 'сервер',
    services: config.server?.services,
    releasePath: config.server?.releasePath,
    dataDir: config.server?.dataDir || botConfig.dataDir,
    timeZone: config.time?.timeZone,
    logger,
  })
  const polls = config.polls?.enabled === false
    ? undefined
    : { store: new PollStore({ file: stateFile(botConfig.dataDir, 'polls', instance.namespace), logger, access }) }
  if (polls) {
    await polls.store.load()
    polls.tool = createPollTool({ store: polls.store })
  }

  // Документы как источник: оригиналы, текст с локаторами и поиск под ACL.
  // Флаг `DOCUMENTS_ENABLED=false` оставляет прежнее поведение без домена.
  let documents = botConfig.documents?.enabled === false
    ? undefined
    : new DocumentStore({
      dataDir: botConfig.dataDir,
      file: stateFile(botConfig.dataDir, 'documents', instance.namespace),
      access,
      logger,
      limits: botConfig.documents,
      ocr,
      semantic: botConfig.documents?.semantic !== false && typeof model?.complete === 'function'
        ? createModelSemanticRanker({ model, modelName: botConfig.model.name, logger })
        : undefined,
      linkTtlMs: botConfig.documents?.linkTtlMs,
      cacheTtlMs: botConfig.documents?.cacheTtlMs,
    })
  if (documents) {
    try {
      await documents.load()
      documents.tool = createDocumentsTool({ store: documents, logger })
    } catch (error) {
      // Файл документов новее кода или повреждён не по-нашему: не затираем его
      // и не роняем остальных ботов. Домен просто выключен до разбора.
      logger.error('documents disabled: store failed to load', { error: error?.message ?? error })
      documents = undefined
    }
  }

  const bot = new Assistant({ config: botConfig, platform, model, history, webTools, agentBridge, agentLink, reminders, profiles, usage, media, tts, files, documents, events, polls, youtube, server, access, scopes, logger })
  bot.agentEvents = agentEvents

  // Миграция записей без `scope_id` в личные пространства. Копия файлов
  // создаётся до первой записи; повторный запуск ничего не меняет.
  try {
    await bot.contacts?.load?.()
    const targets = [
      {
        name: 'history',
        file: history.file,
        entries: () => [...history.chats.entries()].map(([chatId, record]) => ({ record, ownerId: chatId })),
        flush: () => history.flush(),
      },
      ...(reminders ? [{
        name: 'reminders',
        file: reminders.store.file,
        entries: () => reminders.store.reminders.map((record) => ({ record, ownerId: record.userId ?? record.chatId })),
        flush: () => reminders.store.flush(),
      }] : []),
      ...(profiles ? [{
        name: 'profiles',
        file: profiles.store.file,
        entries: () => [...profiles.store.users.entries()].map(([userId, record]) => ({ record, ownerId: userId })),
        flush: () => profiles.store.flush(),
      }] : []),
      ...(events ? [{
        name: 'events',
        file: events.store.file,
        entries: () => events.store.events.map((record) => ({ record, ownerId: record.userId ?? record.chatId })),
        flush: () => events.store.flush(),
      }] : []),
      ...(polls ? [{
        name: 'polls',
        file: polls.store.file,
        entries: () => polls.store.polls.map((record) => ({ record, ownerId: record.userId ?? record.chatId })),
        flush: () => polls.store.flush(),
      }] : []),
      ...(bot.contacts ? [{
        name: 'contacts',
        file: bot.contacts.file,
        // Старый справочник принадлежал боту, а не человеку, с которым
        // переписывались: его законный владелец — первый допущенный пользователь.
        entries: () => {
          const owner = [...(botConfig.access.allowedUserIds ?? [])][0]
          return bot.contacts.scopeEntries().map((entry) => ({ ...entry, ownerId: owner ?? entry.ownerId }))
        },
        flush: () => bot.contacts.flush(),
      }] : []),
    ]
    const result = await migrateScopes({
      access,
      targets,
      backupDir: path.join(botConfig.dataDir, 'backups'),
      logger,
    })
    if (result.migrated > 0) {
      logger.info('scopes migrated for existing records', { records: result.migrated, backupDir: result.backupDir })
    }
  } catch (error) {
    // Копия не удалась или файл занят: не начинаем работу с наполовину
    // мигрированными данными.
    logger.error('scope migration failed', { error: error?.message ?? error })
    throw error
  }

  // Кому доставлять: люди этой платформы, как у утреннего дайджеста. Канал
  // входит в ключ получателя, чтобы id Telegram и VK не слились в одного.
  const proactivePlatformIds = botConfig.access.allowedByPlatform?.[instance.platform] ?? new Set()
  const proactiveTargetIds = proactivePlatformIds.size > 0 ? proactivePlatformIds : botConfig.access.allowedUserIds
  const proactiveTargets = [...proactiveTargetIds].map((id) => ({ userId: id, chatId: id, channel: instance.platform }))
  // Проактивность: один файл состояния и один планировщик. Сервис не создаёт
  // свой таймер — его тик зовёт существующий `ReminderScheduler`. Флаг
  // `PROACTIVE_ENABLED=false` оставляет только журнал решений (dry-run).
  const proactiveStore = new ProactiveStore({
    file: stateFile(botConfig.dataDir, 'proactive', instance.namespace),
    logger,
    timeZone: botConfig.time?.timeZone ?? '',
    quiet: botConfig.quiet,
    reviewAt: botConfig.proactive?.reviewAt ?? '09:00',
    dayLimit: botConfig.proactive?.dayLimit ?? 3,
    // Старые общие настройки переходят первому получателю этой платформы.
    owner: proactiveTargets[0],
  })
  await proactiveStore.load()
  // Поручения приходят из моста агента. Ответ кэшируется, чтобы минутный
  // планировщик не дёргал мост каждую минуту.
  let taskCache
  const taskSource = bot.agentBridge?.enabled && typeof bot.agentBridge.activity === 'function'
    ? async () => {
      const now = Date.now()
      if (taskCache && now - taskCache.at < 5 * 60_000) return taskCache.value
      const value = await bot.agentBridge.activity({ limit: 20 })
      taskCache = { at: now, value: Array.isArray(value) ? value : [] }
      return taskCache.value
    }
    : undefined
  const proactive = new ProactiveService({
    store: proactiveStore,
    sources: {
      reminders: reminders?.store,
      events: events?.store,
      tasks: taskSource,
    },
    targets: proactiveTargets,
    access,
    logger,
    enabled: botConfig.proactive?.enabled === true,
    channel: instance.platform,
    intervalMs: botConfig.proactive?.checkIntervalMs ?? 60_000,
    deliver: (chatId, text, keyboard) => bot.send(chatId, text, undefined, keyboard),
  })
  bot.proactive = proactive

  // The digest needs the bot for delivery and the profile for the city, so it is
  // built after the bot and attached to it.
  if (botConfig.digest.enabled) {
    // The digest goes to the people of *this* platform: a Telegram id is not a VK
    // id, and sending the morning digest to the other platform's ids fails there.
    // An explicit DIGEST_CHAT_IDS wins, because it names targets on purpose.
    const platformIds = botConfig.access.allowedByPlatform?.[instance.platform] ?? new Set()
    const targets = platformIds.size > 0 ? platformIds : botConfig.access.allowedUserIds
    const digests = botConfig.digest.chatIds.length > 0
      ? botConfig.digest.chatIds
      : (botConfig.access.allowAllUsers ? [] : [...targets].map(String))
    if (digests.length > 0) {
      bot.digest = new DigestService({
        deliver: (chatId, text) => bot.send(chatId, text),
        weather: createWeatherTool({ timeoutMs: 20000, logger }),
        // Thresholds for the digest warnings; disabled with WEATHER_ALERTS=false.
        alerts: config.weatherAlerts?.enabled === false
          ? undefined
          : (city) => forecastAlerts({ city, timeZone: config.time?.timeZone, thresholds: config.weatherAlerts?.thresholds, logger }),
        reminders,
        profiles,
        events,
        holidays,
        jokes,
        news: botConfig.digest.news,
        joke: botConfig.digest.joke,
        search: config.web.enabled && config.model.backend === 'openai'
          ? async (query) => {
            const result = await webTools.execute('web_search', { query })
            return typeof result === 'string' ? result : ''
          }
          : undefined,
        logger,
        timeZone: botConfig.time.timeZone,
        time: botConfig.digest.time,
        chatIds: digests,
        topics: botConfig.digest.topics,
      })
    } else {
      logger.warn('digest enabled but there is nobody to send it to')
    }
  }
  if (!reminders && botConfig.proactive?.enabled) {
    // Второго таймера нет: без планировщика напоминаний проактивности негде жить.
    logger.warn('proactive is on but REMINDERS=false: there is no scheduler timer to run it')
  }
  if (reminders) {
    reminders.scheduler = new ReminderScheduler({
      store: reminders.store,
      deliver: (reminder, info) => bot.deliverReminder(reminder, info),
      logger,
      intervalMs: botConfig.reminders.checkIntervalMs,
      // Тот же таймер: второго планировщика проактивности нет.
      onTick: ({ now }) => proactive.tick({ now: new Date(now) }),
    })
  }


  try {
    await bot.start()
  } catch (error) {
    // A wrong token, a blocked Bot API or no network: one readable line, and the
    // caller keeps the other bots running.
    logger.error('bot start failed: check the token, the network and any proxy settings', { label: instance.label, error })
    throw error
  }

  // Mini App: панель управления поверх тех же файлов состояния. Только Telegram
  // (там есть подписанный initData) и только когда задан публичный HTTPS-адрес.
  // Сообщения от агента: одна точка на бота, только localhost и только с токеном.
  /** Доставить событие агента v2: текст, файлы, вопрос, предложение памяти. */
  async function deliverAgentEvent(event) {
    const owners = [...(botConfig.access?.allowedUserIds ?? [])].map(String)
    const chatId = event.route?.chatId === undefined ? owners[0] : String(event.route.chatId)
    if (owners.length === 0 || !owners.includes(String(chatId))) throw new Error('чужой маршрут события')
    if (event.type === 'memory_proposal') {
      // Автоматическое извлечение — отдельная настройка. Пока она выключена,
      // предложение агента не становится памятью: иначе предположение модели
      // выглядело бы как подтверждённый пользователем факт.
      if (!botConfig.profiles?.autoExtract) {
        logger.info('memory proposal ignored: auto extraction is off')
        return
      }
      const fact = String(event.proposal?.text ?? '').trim()
      if (fact !== '') {
        try {
          // Даже при включённой настройке это предположение с источником-агентом,
          // а не подтверждённый факт.
          bot.profiles?.store?.addFact?.(chatId, fact, {
            confirmationStatus: 'assumption',
            sourceRef: 'agent',
          })
          await bot.profiles?.store?.flush?.()
        } catch (error) {
          logger.warn('memory proposal rejected', { error: error?.message ?? error })
        }
      }
      return
    }
    const text = [event.title, event.text].filter((part) => typeof part === 'string' && part !== '').join('\n\n')
    if (text !== '') await bot.deliverAgentMessage({ text, chatId })
    for (const file of event.files ?? []) {
      const data = await agentBridge.downloadFile(file.fileId).catch((error) => ({ ok: false, error: error?.message ?? error }))
      if (data.ok) {
        await bot.platform.sendDocument({ chatId, bytes: data.bytes, fileName: file.name, caption: file.caption }).catch((error) => {
          logger.warn('agent file delivery failed', { file: file.name, error: error?.message ?? error })
        })
      } else {
        await bot.deliverAgentMessage({ text: '⚠️ Файл «' + file.name + '» недоступен: ' + (data.error ?? 'ошибка'), chatId }).catch(() => {})
      }
    }
    if (event.type === 'question') await agentLink?.rememberQuestion(event, chatId)
  }

  if (platform.name === 'telegram' && config.outbox?.enabled && config.outbox.token) {
    try {
      const outbox = createOutbox({
        token: config.outbox.token,
        port: config.outbox.port,
        host: config.outbox.host,
        logger,
        events: agentEvents,
        deliverEvent: (event) => deliverAgentEvent(event),
        deliver: (message) => bot.deliverAgentMessage(message),
      })
      const outboxPort = await outbox.start()
      bot.outbox = outbox
      logger.info('outbox listening', { host: config.outbox.host, port: outboxPort })
    } catch (error) {
      logger.warn('outbox not started', { error: error?.message ?? error })
    }
  }
  if (platform.name === 'telegram' && config.miniapp?.enabled && config.miniapp.url) {
    try {
      const miniApp = createMiniApp({
        port: config.miniapp.port,
        host: config.miniapp.host,
        botToken: config.telegram.token,
        allowedUserIds: [...botConfig.access.allowedUserIds],
        stores: {
          reminders: reminders?.store,
          events: events?.store,
          profiles: profiles?.store,
          usage,
        },
        history,
        mobilePasswordHash: config.miniapp.mobile.passwordHash,
        mobileSessionSecret: config.miniapp.mobile.sessionSecret,
        mobileUserId: config.miniapp.mobile.userId || [...botConfig.access.allowedUserIds][0],
        mobileUserName: config.miniapp.mobile.userName,
        mobileUsername: config.miniapp.mobile.username,
        sessionTtlSec: config.miniapp.mobile.sessionTtlSec,
        cookieSecure: config.miniapp.mobile.cookieSecure,
        defaultModel: config.model.name,
        modelOptions: [config.model.name, 'deepseek-flash', 'deepseek-chat', 'deepseek-v4-pro'],
        telegramUrl: config.miniapp.mobile.telegramUrl,
        timeZone: config.time?.timeZone ?? '',
        logger,
      })
      const miniPort = await miniApp.start()
      bot.miniApp = miniApp
      logger.info('mini app listening', { host: config.miniapp.host, port: miniPort, url: config.miniapp.url })
      // Кнопка рядом с полем ввода — самый короткий путь в приложение.
      const menu = platform.client?.setChatMenuButton?.({ url: config.miniapp.url })
      if (menu?.catch) menu.catch((error) => logger.warn('menu button failed', { error: error?.message ?? error }))
    } catch (error) {
      logger.warn('mini app failed to start', { error: error?.message ?? error })
    }
  }

  return { bot, instance, platform, reminders, scopes }
}
