/**
 * Configuration for the Telegram agent, read from the environment.
 *
 * Every field has a default except the secrets, and validation fails fast with
 * an actionable message instead of starting a half-configured bot.
 *
 * Error messages never echo a value: a secret in the wrong variable would
 * otherwise be printed verbatim by the entry point, bypassing the logger's
 * redaction. They report the length instead.
 */

/** Defaults applied when the variable is absent or empty. */
const DEFAULTS = {
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  PLATFORM: 'telegram',
  MAX_TOKEN: '',
  VK_TOKEN: '',
  VK_GROUP_ID: '',
  VK_API_BASE: 'https://api.vk.com/method',
  VK_API_VERSION: '5.199',
  VK_TIMEOUT_MS: '40000',
  VK_TEAMS_TOKEN: '',
  VK_TEAMS_API_BASE: 'https://myteam.mail.ru/bot/v1',
  VK_TEAMS_TIMEOUT_MS: '40000',
  MAX_API_BASE: 'https://platform-api2.max.ru',
  MAX_TIMEOUT_MS: '60000',
  MAX_POLL_TIMEOUT_SEC: '30',
  MODEL_BACKEND: 'openai',
  MODEL_BASE_URL: 'https://api.deepseek.com',
  MODEL_NAME: 'deepseek-chat',
  MODEL_TEMPERATURE: '',
  MODEL_MAX_TOKENS: '',
  DSH_PROFILE: 'headless',
  DSH_HOME: '',
  SYSTEM_PROMPT:
    // Тон и рамки. Запретов на темы здесь намеренно нет: ассистент говорит со взрослым
    // человеком, и неловкая тема — не причина для отказа. Остались только правила
    // корректности (не выдавать несделанное за сделанное) и вызова инструментов.
    'Ты личный ассистент взрослого человека в мессенджере. Отвечай по существу, на языке собеседника, без лишних преамбул и извинений. '
    + 'Отвечай на любой законный вопрос: медицина, физиология, интимные и взрослые темы, политика, религия, спорные и неприятные сюжеты — это нормальные темы. Говори прямо и по делу, без морализаторства, нравоучений и предупреждений, о которых не просили. Не отказывайся из-за неловкости темы: отказ уместен только там, где просят инструкции для реального вреда или преступления. '
    + 'Список твоих инструментов и возможностей приходит отдельным системным сообщением — он точный: обещай только то, что в нём есть, и не выдумывай новых умений. '
    + 'Для любых вопросов о погоде вызывай weather, а не web_search и не отвечай по памяти; остальные свежие данные — через web_search. '
    + 'Когда просят напомнить — вызывай remind и бери время из системного сообщения о текущем моменте; личные факты о собеседнике — remember (город передавай в параметре city). '
    + 'Когда просят таблицу, документ, отчёт или файл — вызывай file. Не утверждай, что напоминание, файл, опрос или событие созданы, если соответствующий инструмент не вызывался. '
    + 'В групповом чате ты видишь только то, что написано в этом чате: не приписывай участникам фактов, которых не слышал. '
    + 'Если инструмент вернул ошибку — скажи об этом прямо и не выдумывай данные. Коротко указывай источник и время наблюдения.',
  WEB_TOOLS: 'true',
  // Bridge to the task agent, reached through an SSH tunnel; empty = off.
  AGENT_BRIDGE_URL: 'http://127.0.0.1:8787/bridge',
  AGENT_BRIDGE_TOKEN: '',
  // The Telegram group stays a manual entry point for the owner, not a bot path.
  AGENT_BRIDGE_GROUP_ID: '',
  WEB_SEARCH_MAX_USES: '3',
  WEB_FETCH_MAX_BYTES: '200000',
  SEARCH_BASE_URL: 'https://api.deepseek.com/anthropic/v1',
  SEARCH_MODEL: 'deepseek-v4-flash',
  MAX_TOOL_ROUNDS: '4',
  REMINDERS: 'true',
  REMINDER_CHECK_SEC: '20',
  MEMORY: 'true',
  MAX_USERS: '1000',
  DAILY_TOKEN_LIMIT: '0',
  USAGE_RETENTION_DAYS: '60',
  DIGEST: 'true',
  DIGEST_TIME: '08:00',
  DIGEST_TOPICS: '',
  DIGEST_NEWS: 'false',
  DIGEST_JOKE: 'true',
  DIGEST_COUNTRY: 'RU',
  STT_PROVIDER: 'none',
  STT_API_KEY: '',
  STT_BASE_URL: 'https://api.openai.com/v1',
  STT_MODEL: 'whisper-1',
  STT_LANGUAGE: 'ru',
  STT_FOLDER_ID: '',
  TTS_PROVIDER: 'none',
  TTS_API_KEY: '',
  TTS_VOICE: 'alena',
  TTS_SPEED: '1.0',
  TTS_MAX_CHARS: '1200',
  QUIET_HOURS: '23:00-08:00',
  WEATHER_ALERTS: 'true',
  EVENTS: 'true',
  MINIAPP: 'true',
  MINIAPP_PORT: '8787',
  MINIAPP_HOST: '127.0.0.1',
  MINIAPP_URL: '',
  OUTBOX: 'true',
  OUTBOX_PORT: '8788',
  // Токен для агента: без него точка приёма не поднимается вообще.
  OUTBOX_TOKEN: '',
  YOUTUBE: 'true',
  POLLS: 'true',
  SERVER_STATUS: 'true',
  SERVER_LABEL: 'сервер',
  SERVER_SERVICES: '',
  SERVER_RELEASE_PATH: '/opt/tg-agent',
  SERVER_DATA_DIR: '',
  ALERT_RAIN_PERCENT: '60',
  ALERT_TEMP_MIN: '-15',
  ALERT_TEMP_MAX: '30',
  ALERT_WIND_KMH: '40',
  MEDIA_MAX_BYTES: '20000000',
  STREAM: 'true',
  REACTIONS: 'false',
  STREAM_THROTTLE_MS: '900',
  HA_URL: '',
  ALERT_CHAT_ID: '',
  HA_TOKEN: '',
  HA_ALLOWED_ENTITIES: '',
  DIGEST_CHAT_IDS: '',
  HISTORY_LIMIT: '20',
  MAX_CHATS: '1000',
  POLL_TIMEOUT_SEC: '30',
  TELEGRAM_TIMEOUT_MS: '60000',
  MODEL_TIMEOUT_MS: '180000',
  MAX_CONCURRENT_REQUESTS: '4',
  STARTUP_ATTEMPTS: '3',
  SHUTDOWN_GRACE_MS: '5000',
  HEARTBEAT_MINUTES: '0',
  TIME_ZONE: '',
  DATA_DIR: './data',
  LOG_LEVEL: 'info',
  ALLOWED_USER_IDS: '',
  ALLOWED_USER_IDS_TELEGRAM: '',
  ALLOWED_USER_IDS_MAX: '',
  ALLOWED_USER_IDS_VK: '',
  ALLOWED_USER_IDS_VK_TEAMS: '',
  ALLOW_ALL_USERS: 'false',
  ALLOWED_CHAT_TYPES: 'private,group,supergroup',
  DENY_MESSAGE: 'Доступ закрыт. Ваш ID: {id}. Передайте его владельцу бота.',
}

/** Configuration error that the entry point prints without a stack trace. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const read = (env, key) => {
  const value = env[key]
  return value === undefined || value === '' ? DEFAULTS[key] : value
}

/** Describe a rejected value without printing it. */
const described = (raw) => `got a ${String(raw).length}-character value`

const readInt = (env, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = read(env, key)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}, ${described(raw)}`)
  }
  return value
}

const readOptionalNumber = (env, key, { min, max }) => {
  const raw = read(env, key)
  if (raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be a number between ${min} and ${max}, ${described(raw)}`)
  }
  return value
}

const readBool = (env, key) => {
  const raw = String(read(env, key)).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  throw new ConfigError(`${key} must be a truthy or falsy switch, ${described(raw)}`)
}

const readChoice = (env, key, allowed) => {
  const raw = String(read(env, key)).toLowerCase()
  if (!allowed.includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, ${described(raw)}`)
  }
  return raw
}

/** Parse `1,2, 3` into a set of numbers. */
const readIdSet = (env, key) => {
  const raw = read(env, key)
  const ids = new Set()
  for (const part of String(raw).split(/[,\s]+/).filter(Boolean)) {
    const id = Number(part)
    if (!Number.isInteger(id)) throw new ConfigError(`${key} contains a non-numeric entry of ${part.length} characters`)
    ids.add(id)
  }
  return ids
}

/** Parse a comma- or space-separated list of plain strings. */
const readList = (env, key) =>
  String(read(env, key))
    .split(/[,\s]+/)
    .filter(Boolean)

/**
 * Parse a list of free-form phrases, split on commas and semicolons only.
 *
 * Search topics contain spaces ("курсы валют"), so they must not be split the
 * way ids and host names are.
 */
const readPhrases = (env, key) =>
  String(read(env, key))
    .split(/[;,]+/)
    .map((value) => value.trim())
    .filter(Boolean)

/** Which messenger this process serves. */
function readPlatform(env) {
  const value = read(env, 'PLATFORM').toLowerCase()
  if (value === '' || value === 'telegram' || value === 'tg') return 'telegram'
  if (value === 'max') return 'max'
  if (value === 'vk') return 'vk'
  if (value === 'vk-teams' || value === 'vkteams') return 'vk-teams'
  throw new ConfigError('PLATFORM must be "telegram", "vk", "vk-teams" or "max"')
}

/** How many extra bots one process may serve (`BOT_1_*` ... `BOT_8_*`). */
const MAX_EXTRA_BOTS = 8

/**
 * Every bot this process serves.
 *
 * The first entry is the primary bot from `PLATFORM` and its token variable; it
 * keeps the historical state file names (`history.json` for Telegram). Extra bots
 * come from `BOT_<n>_PLATFORM`, `BOT_<n>_TOKEN` and `BOT_<n>_LABEL` and each gets
 * its own namespace (`telegram-family`), so histories, memories and reminders of
 * different bots never mix.
 *
 * @param {object} env - environment variables.
 * @param {Array<string>} [warnings] - collected warnings, for skipped bots.
 * @returns {Array<{label: string, platform: string, token: string, namespace: string}>} bots, primary first.
 */
export function readBots(env, warnings = []) {
  const primary = readPlatform(env)
  const bots = [{ label: 'main', platform: primary, token: platformToken(env, primary), namespace: primary }]
  const labels = new Set(['main'])
  for (let index = 1; index <= MAX_EXTRA_BOTS; index++) {
    const prefix = 'BOT_' + index + '_'
    const get = (key) => String(read(env, prefix + key) ?? '')
    const rawLabel = get('LABEL')
    const rawPlatform = get('PLATFORM')
    const token = get('TOKEN')
    if (rawLabel === '' && rawPlatform === '' && token === '') continue
    if (token === '') {
      warnings.push(`${prefix}TOKEN is empty: the additional bot is skipped`)
      continue
    }
    let platform
    try {
      platform = rawPlatform === '' ? primary : readPlatform({ ...env, PLATFORM: rawPlatform })
    } catch (error) {
      warnings.push(`${prefix}PLATFORM is invalid (${error.message}): the additional bot is skipped`)
      continue
    }
    const label = (rawLabel === '' ? `bot${index}` : rawLabel).toLowerCase()
    // The label becomes part of a file name, so it must stay filesystem-safe.
    if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(label)) {
      warnings.push(`${prefix}LABEL must be latin letters, digits and dashes: the additional bot is skipped`)
      continue
    }
    if (labels.has(label)) {
      warnings.push(`${prefix}LABEL repeats another bot (${label}): the additional bot is skipped`)
      continue
    }
    labels.add(label)
    bots.push({ label, platform, token, namespace: `${platform}-${label}` })
  }
  return bots
}

/** The token variable that belongs to one platform. */
function platformToken(env, platform) {
  const get = (key) => String(read(env, key) ?? '')
  if (platform === 'telegram') return get('TELEGRAM_BOT_TOKEN')
  if (platform === 'max') return get('MAX_TOKEN')
  if (platform === 'vk') return get('VK_TOKEN')
  if (platform === 'vk-teams') return get('VK_TEAMS_TOKEN')
  return ''
}

/**
 * Parse `QUIET_HOURS` — `HH:MM-HH:MM`, empty or `off` to disable.
 *
 * @param {object} env - environment.
 * @returns {{start: number, end: number}|undefined} minutes from midnight, or undefined.
 */
function readQuietHours(env) {
  const value = read(env, 'QUIET_HOURS').trim().toLowerCase()
  if (value === '' || value === 'off' || value === 'нет') return undefined
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value)
  if (!match) {
    throw new ConfigError('QUIET_HOURS must look like 23:00-08:00')
  }
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start > 1439 || end > 1439 || start === end) {
    throw new ConfigError('QUIET_HOURS has an invalid time range')
  }
  return { start, end }
}

/** A wall-clock time the digest can use; anything else becomes the default. */
const readClockTime = (env, key, fallback) => {
  const value = read(env, key)
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value) ? value : fallback
}

const readChatTypes = (env, key) => {
  const allowed = ['private', 'group', 'supergroup']
  const parts = String(read(env, key))
    .split(/[,\s]+/)
    .filter(Boolean)
  for (const part of parts) {
    if (!allowed.includes(part)) throw new ConfigError(`${key} contains an unknown chat type of ${part.length} characters`)
  }
  return new Set(parts)
}

/**
 * Validate the configured time zone at startup.
 *
 * An invalid zone would otherwise surface as a generic "could not answer" inside
 * a turn, because `Intl` throws while building the clock context.
 */
const readTimeZone = (env) => {
  const zone = read(env, 'TIME_ZONE')
  if (zone === '') return ''
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: zone })
  } catch {
    throw new ConfigError(`TIME_ZONE is not a valid IANA zone (for example Europe/Moscow), got a ${zone.length}-character value`)
  }
  return zone
}

/**
 * Telegram token, validated only when this process actually serves Telegram.
 *
 * A MAX-only deployment must not be forced to keep a Telegram bot around.
 */
const requireTelegramToken = (env) => {
  if (readPlatform(env) !== 'telegram') return read(env, 'TELEGRAM_BOT_TOKEN')
  const token = read(env, 'TELEGRAM_BOT_TOKEN')
  if (!token) throw new ConfigError('TELEGRAM_BOT_TOKEN is required: create a bot with @BotFather and paste its token')
  if (!/^\d+:[\w-]{20,}$/.test(token)) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN does not look like a BotFather token ("<digits>:<secret>")')
  }
  return token
}

/**
 * Build the immutable configuration.
 *
 * @param {Record<string, string | undefined>} env - process environment.
 * @returns configuration plus non-fatal `warnings` for the entry point to log.
 */
export function loadConfig(env = process.env) {
  const warnings = []
  // Validate the required settings first: on a completely empty environment the
  // user should be told about the missing token, not about the access list.
  const token = requireTelegramToken(env)
  const backend = readChoice(env, 'MODEL_BACKEND', ['openai', 'dsh'])
  const apiKey = read(env, 'MODEL_API_KEY')
  const dshCommand = read(env, 'DSH_COMMAND')
  if (backend === 'openai' && !apiKey) {
    throw new ConfigError('MODEL_API_KEY is required: the key of the model provider (or set MODEL_BACKEND=dsh)')
  }
  if (backend === 'dsh' && !dshCommand) {
    throw new ConfigError('DSH_COMMAND is required with MODEL_BACKEND=dsh: the path to the dsh executable')
  }
  const allowedUserIds = readIdSet(env, 'ALLOWED_USER_IDS')
  // A messenger may use its own id space: VK ids are not Telegram ids, so each
  // platform can extend the list without granting access on the others.
  const allowedByPlatform = {
    telegram: readIdSet(env, 'ALLOWED_USER_IDS_TELEGRAM'),
    max: readIdSet(env, 'ALLOWED_USER_IDS_MAX'),
    vk: readIdSet(env, 'ALLOWED_USER_IDS_VK'),
    'vk-teams': readIdSet(env, 'ALLOWED_USER_IDS_VK_TEAMS'),
  }
  const allowAllUsers = readBool(env, 'ALLOW_ALL_USERS')
  if (allowedUserIds.size === 0 && !allowAllUsers) {
    throw new ConfigError(
      'ALLOWED_USER_IDS is empty: list the Telegram user ids allowed to talk to the bot, or set ALLOW_ALL_USERS=true to accept everyone',
    )
  }
  if (allowAllUsers) warnings.push('ALLOW_ALL_USERS=true: any Telegram user can spend your model credits')

  return {
    // Which messenger this process serves. One process per platform keeps the
    // state files independent, and a shared core keeps the behaviour identical.
    // Every bot of this process: the primary one plus optional extras.
    bots: readBots(env, warnings),
    platform: {
      name: readPlatform(env),
      maxToken: read(env, 'MAX_TOKEN'),
      vkToken: read(env, 'VK_TOKEN'),
      vkGroupId: read(env, 'VK_GROUP_ID'),
      vkApiBase: read(env, 'VK_API_BASE') === '' ? 'https://api.vk.com/method' : read(env, 'VK_API_BASE'),
      vkApiVersion: read(env, 'VK_API_VERSION') === '' ? '5.199' : read(env, 'VK_API_VERSION'),
      vkTimeoutMs: readInt(env, 'VK_TIMEOUT_MS', { min: 1000, max: 120000 }),
      vkTeamsToken: read(env, 'VK_TEAMS_TOKEN'),
      vkTeamsApiBase: read(env, 'VK_TEAMS_API_BASE').replace(/\/+$/, ''),
      vkTeamsTimeoutMs: readInt(env, 'VK_TEAMS_TIMEOUT_MS', { min: 1000, max: 120000 }),
      maxApiBase: read(env, 'MAX_API_BASE').replace(/\/+$/, ''),
      maxTimeoutMs: readInt(env, 'MAX_TIMEOUT_MS', { min: 1000, max: 600000 }),
      maxPollTimeoutSec: readInt(env, 'MAX_POLL_TIMEOUT_SEC', { min: 1, max: 90 }),
      // Single place the core reads the hold time from.
      get pollTimeoutSec() {
        return this.name === 'max' ? this.maxPollTimeoutSec : readInt(env, 'POLL_TIMEOUT_SEC', { min: 1, max: 60 })
      },
    },
    telegram: {
      token,
      apiBase: read(env, 'TELEGRAM_API_BASE').replace(/\/+$/, ''),
      timeoutMs: readInt(env, 'TELEGRAM_TIMEOUT_MS', { min: 1000, max: 600000 }),
      pollTimeoutSec: readInt(env, 'POLL_TIMEOUT_SEC', { min: 1, max: 60 }),
    },
    model: {
      backend,
      baseUrl: read(env, 'MODEL_BASE_URL').replace(/\/+$/, ''),
      apiKey,
      name: read(env, 'MODEL_NAME'),
      systemPrompt: read(env, 'SYSTEM_PROMPT'),
      temperature: readOptionalNumber(env, 'MODEL_TEMPERATURE', { min: 0, max: 2 }),
      maxTokens: readOptionalNumber(env, 'MODEL_MAX_TOKENS', { min: 1, max: 200000 }),
      timeoutMs: readInt(env, 'MODEL_TIMEOUT_MS', { min: 1000, max: 900000 }),
      dsh: {
        command: dshCommand,
        profile: read(env, 'DSH_PROFILE'),
        home: read(env, 'DSH_HOME') || undefined,
      },
    },
    access: {
      allowedUserIds,
      allowedByPlatform,
      allowAllUsers,
      allowedChatTypes: readChatTypes(env, 'ALLOWED_CHAT_TYPES'),
      denyMessage: read(env, 'DENY_MESSAGE'),
    },
    history: {
      limit: readInt(env, 'HISTORY_LIMIT', { min: 0, max: 200 }),
      maxChats: readInt(env, 'MAX_CHATS', { min: 1, max: 100000 }),
    },
    time: {
      // Empty means "use the system zone"; the value is passed to Intl.
      timeZone: readTimeZone(env),
    },
    limits: {
      maxConcurrentRequests: readInt(env, 'MAX_CONCURRENT_REQUESTS', { min: 1, max: 64 }),
      startupAttempts: readInt(env, 'STARTUP_ATTEMPTS', { min: 1, max: 20 }),
      shutdownGraceMs: readInt(env, 'SHUTDOWN_GRACE_MS', { min: 0, max: 120000 }),
      heartbeatMs: readInt(env, 'HEARTBEAT_MINUTES', { min: 0, max: 1440 }) * 60_000,
    },
    agentBridge: {
      // Inert without url + token: the chat bot behaves exactly as before.
      url: read(env, 'AGENT_BRIDGE_URL').trim(),
      token: read(env, 'AGENT_BRIDGE_TOKEN').trim(),
    },
    web: {
      // Only the openai backend needs these: the dsh backend brings its own tools.
      enabled: readBool(env, 'WEB_TOOLS'),
      searchBaseUrl: read(env, 'SEARCH_BASE_URL').replace(/\/+$/, ''),
      searchModel: read(env, 'SEARCH_MODEL'),
      maxUses: readInt(env, 'WEB_SEARCH_MAX_USES', { min: 1, max: 20 }),
      maxFetchBytes: readInt(env, 'WEB_FETCH_MAX_BYTES', { min: 1000, max: 5_000_000 }),
      maxToolRounds: readInt(env, 'MAX_TOOL_ROUNDS', { min: 1, max: 20 }),
      // Hosts the owner trusts even though they resolve to a private address.
      allowedHosts: readList(env, 'WEB_FETCH_ALLOWED_HOSTS'),
    },
    reminders: {
      enabled: readBool(env, 'REMINDERS'),
      checkIntervalMs: readInt(env, 'REMINDER_CHECK_SEC', { min: 5, max: 600 }) * 1000,
    },
    profiles: {
      // Facts about the user plus their default city for weather.
      enabled: readBool(env, 'MEMORY'),
      maxUsers: readInt(env, 'MAX_USERS', { min: 1, max: 1_000_000 }),
    },
    usage: {
      // 0 disables the budget; the counters are kept either way.
      dailyLimit: readInt(env, 'DAILY_TOKEN_LIMIT', { min: 0, max: 1_000_000_000 }),
      retentionDays: readInt(env, 'USAGE_RETENTION_DAYS', { min: 1, max: 3650 }),
    },
    digest: {
      enabled: readBool(env, 'DIGEST'),
      // Normalised here as well as in the service, so the startup log cannot
      // advertise a time the scheduler would refuse.
      time: readClockTime(env, 'DIGEST_TIME', DEFAULTS.DIGEST_TIME),
      topics: readPhrases(env, 'DIGEST_TOPICS'),
      news: readBool(env, 'DIGEST_NEWS'),
      joke: readBool(env, 'DIGEST_JOKE'),
      country: read(env, 'DIGEST_COUNTRY'),
      // Empty means "every allowed user", which is what a personal bot wants.
      chatIds: readList(env, 'DIGEST_CHAT_IDS'),
    },
    // Reactions on the user's messages (👀 received, 👍 answered). Off by
    // default: they are decoration and some people find them noisy.
    reactions: {
      enabled: readBool(env, 'REACTIONS'),
    },
    // Quiet hours: reminders that would fire inside this window are moved to its
    // end, so nobody is woken up at 03:00. Empty or 'off' disables the window.
    quiet: readQuietHours(env),
    // Local calendar of events (meetings, appointments, birthdays).
    events: { enabled: read(env, 'EVENTS').trim().toLowerCase() !== 'false' },
    // Mini App: панель внутри Telegram. Работает только когда задан публичный
    // HTTPS-адрес — без него Telegram не откроет приложение.
    miniapp: {
      enabled: read(env, 'MINIAPP').trim().toLowerCase() !== 'false',
      port: Number(read(env, 'MINIAPP_PORT')) || 8787,
      host: read(env, 'MINIAPP_HOST') || '127.0.0.1',
      url: read(env, 'MINIAPP_URL').trim(),
    },
    // Точка приёма сообщений от агента: только localhost, только с токеном.
    outbox: {
      enabled: read(env, 'OUTBOX').trim().toLowerCase() !== 'false',
      port: Number(read(env, 'OUTBOX_PORT')) || 8788,
      host: '127.0.0.1',
      token: read(env, 'OUTBOX_TOKEN').trim(),
    },
    youtube: { enabled: read(env, 'YOUTUBE').trim().toLowerCase() !== 'false' },
    polls: { enabled: read(env, 'POLLS').trim().toLowerCase() !== 'false' },
    // The machine the bot runs on, as reported by `server` and /server.
    server: {
      enabled: read(env, 'SERVER_STATUS').trim().toLowerCase() !== 'false',
      label: read(env, 'SERVER_LABEL') || 'сервер',
      services: read(env, 'SERVER_SERVICES').split(',').map((name) => name.trim()).filter(Boolean),
      releasePath: read(env, 'SERVER_RELEASE_PATH') || '/opt/tg-agent',
      dataDir: read(env, 'SERVER_DATA_DIR'),
    },
    // Weather warnings in the digest: rain, frost, heat, wind. Thresholds are
    // deliberately conservative — a warning every day is a warning nobody reads.
    weatherAlerts: {
      enabled: read(env, 'WEATHER_ALERTS').trim().toLowerCase() !== 'false',
      thresholds: {
        rainPercent: Number(read(env, 'ALERT_RAIN_PERCENT')) || 60,
        tempMin: Number(read(env, 'ALERT_TEMP_MIN')) || -15,
        tempMax: Number(read(env, 'ALERT_TEMP_MAX')) || 30,
        windKmh: Number(read(env, 'ALERT_WIND_KMH')) || 40,
      },
    },
    // Streaming: the answer is written into a message as it is generated.
    stream: {
      enabled: readBool(env, 'STREAM'),
      throttleMs: readInt(env, 'STREAM_THROTTLE_MS', { min: 200, max: 10000 }),
    },
    // Smart home: Home Assistant is the bridge (its Yandex Smart Home
    // integration exposes devices to Alice). Empty URL or token disables it.
    smartHome: {
      baseUrl: read(env, 'HA_URL').replace(/\/+$/, ''),
      token: read(env, 'HA_TOKEN'),
      allowedEntities: readList(env, 'HA_ALLOWED_ENTITIES'),
    },
    // Voice notes and documents: an optional transcriber plus size limits.
    media: {
      maxBytes: readInt(env, 'MEDIA_MAX_BYTES', { min: 1000, max: 50_000_000 }),
    },
    // Voice answers: the same SpeechKit key can synthesise, so it falls back to it.
    tts: {
      provider: readChoice(env, 'TTS_PROVIDER', ['none', 'yandex']),
      apiKey: read(env, 'TTS_API_KEY') === '' ? read(env, 'STT_API_KEY') : read(env, 'TTS_API_KEY'),
      voice: read(env, 'TTS_VOICE'),
      speed: readOptionalNumber(env, 'TTS_SPEED', { min: 0.1, max: 3 }) ?? 1,
      maxChars: readInt(env, 'TTS_MAX_CHARS', { min: 50, max: 5000 }),
      folderId: read(env, 'STT_FOLDER_ID'),
    },
    stt: {
      provider: readChoice(env, 'STT_PROVIDER', ['none', 'openai', 'yandex']),
      apiKey: read(env, 'STT_API_KEY'),
      baseUrl: read(env, 'STT_BASE_URL').replace(/\/+$/, ''),
      model: read(env, 'STT_MODEL'),
      language: read(env, 'STT_LANGUAGE'),
      folderId: read(env, 'STT_FOLDER_ID'),
    },
    // Where operational warnings go (model failures, token budget). Defaults to
    // the first allowed user.
    alerts: {
      chatId: readOptionalNumber(env, 'ALERT_CHAT_ID', { min: -1_000_000_000_000, max: 1_000_000_000_000 }),
    },
    dataDir: read(env, 'DATA_DIR'),
    logLevel: read(env, 'LOG_LEVEL'),
    warnings,
  }
}
