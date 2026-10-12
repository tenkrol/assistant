/**
 * Configuration for the task agent, read from the environment.
 *
 * Every field has a default except the secrets, and validation fails fast with
 * an actionable message instead of starting a half-configured agent.
 *
 * Error messages never echo a value: a secret in the wrong variable would
 * otherwise be printed verbatim by the entry point, bypassing the logger's
 * redaction. They report the length instead.
 */

/** Defaults applied when the variable is absent or empty. */
const DEFAULTS = {
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  ALLOW_ALL_USERS: 'false',
  DENY_MESSAGE: 'Доступ закрыт. Ваш ID: {id}. Передайте его владельцу бота.',

  // Where the DSH runtime lives on this server.
  DSH_BIN: '/usr/local/bin/dsh',
  DSH_PROFILE: 'headless',
  DSH_HOME: '/var/lib/agent/dsh',
  DSH_PERMISSION_MODE: 'workspace-write',

  // Where the agent works and keeps its own state.
  WORKSPACE_DIR: '/var/lib/agent/workspace',
  STATE_DIR: '/var/lib/agent/state',

  // Task limits. The daily budget is in tokens, the timeout in milliseconds.
  TASK_TIMEOUT_MS: '1200000',
  // A ceiling on one run's tokens (a looping model re-sends its context every
  // step) and the level at which the answer says "this one was expensive".
  TASK_TOKEN_BUDGET: '1500000',
  TASK_TOKEN_WARN: '300000',
  DAILY_TOKEN_LIMIT: '2000000',
  MAX_TASK_CHARS: '8000',
  MAX_ANSWER_CHARS: '20000',
  MAX_ATTACHMENT_BYTES: '20000000',
  MAX_OUTPUT_FILES: '8',
  MAX_OUTPUT_FILE_BYTES: '45000000',
  OUTPUT_RETENTION_DAYS: '14',

  // Behaviour.
  SESSION_CONTINUITY: 'true',
  PROGRESS_INTERVAL_MS: '60000',
  POLL_TIMEOUT_SEC: '30',
  TELEGRAM_TIMEOUT_MS: '60000',
  USAGE_RETENTION_DAYS: '60',

  // Model: the key is forwarded to DSH as DEEPSEEK_API_KEY before each run.
  MODEL_API_KEY: '',
  MODEL_NAME: 'deepseek-flash',

  // Images: a vision call turns a photo into task text before DSH runs.
  VISION: 'true',
  VISION_BASE_URL: 'https://api.deepseek.com/v1',
  VISION_API_KEY: '',
  VISION_MODEL: 'deepseek-chat',
  VISION_MAX_TOKENS: '900',
  VISION_TIMEOUT_MS: '90000',
  VISION_MAX_IMAGE_BYTES: '8000000',

  // Local OCR fallback: tesseract, used when vision is unavailable.
  OCR: 'true',
  OCR_COMMAND: 'tesseract',
  OCR_LANGUAGES: 'rus+eng',
  OCR_TIMEOUT_MS: '60000',

  // Dialogue with a task: how long an answer is awaited, when to offer variants.
  AWAIT_REPLY_MS: '86400000',
  PROPOSE_VARIANTS: 'auto',
  MAX_VARIANTS: '3',

  // Voice: SpeechKit transcribes incoming notes and can read an answer aloud.
  STT_PROVIDER: 'none',
  STT_API_KEY: '',
  STT_BASE_URL: 'https://api.openai.com/v1',
  STT_MODEL: 'whisper-1',
  STT_LANGUAGE: 'ru-RU',
  STT_FOLDER_ID: '',
  STT_TIMEOUT_MS: '60000',
  STT_MAX_BYTES: '1000000',
  TTS_PROVIDER: 'none',
  TTS_API_KEY: '',
  TTS_VOICE: 'alena',
  TTS_SPEED: '1.0',
  TTS_MAX_CHARS: '1200',
  TTS_TIMEOUT_MS: '60000',
  VOICE_REPLY: 'auto',

  // Quick layer: answer a trivial request with one small model call instead of
  // a full DSH run (~7k tokens and ~5 s of overhead).
  ROUTING: 'auto',
  ROUTER_MAX_CHARS: '240',
  ROUTER_BASE_URL: '',
  ROUTER_MODEL: '',
  ROUTER_MAX_TOKENS: '700',
  ROUTER_TIMEOUT_MS: '60000',

  // Yandex.Disk: the archive of everything the agent produces.
  YANDEX_DISK: 'false',
  YANDEX_DISK_MODE: 'rest',
  YANDEX_DISK_TOKEN: '',
  // WebDAV (режим webdav): логин Яндекса и пароль приложения.
  YANDEX_DISK_LOGIN: '',
  YANDEX_DISK_PASSWORD: '',
  YANDEX_DISK_DIR: '/Агент',
  YANDEX_DISK_PUBLISH: 'false',
  YANDEX_DISK_TIMEOUT_MS: '60000',

  // Plan mode: for work that looks big, show a plan and wait for approval before
  // spending a real run on it.
  PLAN_MODE: 'auto',
  PLAN_MIN_CHARS: '200',
  PLAN_SIGNALS: '',

  // Bridge: a loopback HTTP endpoint the chat bot reaches through an SSH tunnel.
  BRIDGE_HTTP: 'true',
  BRIDGE_BIND: '127.0.0.1',
  BRIDGE_PORT: '8787',
  BRIDGE_TOKEN: '',
  BRIDGE_MAX_TASK_CHARS: '4000',

  // The Telegram group stays as a manual entry point for the owner.
  BRIDGE_GROUP_ID: '',
  BRIDGE_SOURCE_BOT_IDS: '',
  BRIDGE_NOTIFY: 'true',

  // Recurring tasks: the agent's own scheduler (cron in the owner's time zone).
  SCHEDULES: 'true',
  SCHEDULE_TICK_SEC: '60',
  MAX_SCHEDULES: '20',

  // Per-task resource limits (a delegated cgroup; see src/cgroup.mjs).
  TASK_CGROUP: 'true',
  TASK_MEMORY_MAX_MB: '1500',
  TASK_CPU_PERCENT: '150',
  TASK_PIDS_MAX: '256',
  WORKSPACE_ALERT_MB: '2048',

  // Journal, alerts and the money estimate.
  TASKS_MAX_ENTRIES: '2000',
  ALERT_CHAT_ID: '',
  ALERT_ON_LIMIT_PERCENT: '80',
  PRICE_INPUT_PEAK_PER_M: '0.3',
  PRICE_INPUT_OFFPEAK_PER_M: '0.15',
  PRICE_CACHED_PEAK_PER_M: '0.006',
  PRICE_CACHED_OFFPEAK_PER_M: '0.003',
  PRICE_OUTPUT_PEAK_PER_M: '1.2',
  PRICE_OUTPUT_OFFPEAK_PER_M: '0.6',
  PEAK_WINDOWS_UTC: '01:00-04:00,06:00-10:00',
  PEAK_WEEKDAYS_ONLY: 'true',

  TIME_ZONE: '',
  LOG_LEVEL: 'info',
  SHUTDOWN_GRACE_MS: '10000',
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
const described = (raw) => `получено значение длиной ${String(raw).length}`

/** Parse a positive integer, or fail with the variable's name. */
function positiveInt(raw, key, { min = 1, max = Number.MAX_SAFE_INTEGER, allowZero = false } = {}) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : min) || value > max) {
    throw new ConfigError(`${key}: нужно целое число ${allowZero ? `от 0` : `от ${min}`} до ${max}, ${described(raw)}`)
  }
  return value
}

/** Parse a boolean written as true/false/1/0/yes/no. */
function boolean(raw, key) {
  const value = String(raw).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'off'].includes(value)) return false
  throw new ConfigError(`${key}: нужно true или false, ${described(raw)}`)
}

/** Parse a non-negative number (prices are fractions of a dollar). */
function nonNegativeNumber(raw, key, { max = 1_000_000 } = {}) {
  const value = Number(String(raw).trim().replace(',', '.'))
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new ConfigError(`${key}: нужно число от 0 до ${max}, ${described(raw)}`)
  }
  return value
}

/** A choice from a closed set, reported without echoing the value. */
function choice(raw, key, allowed, fallback) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '' || value === fallback) return fallback
  if (!allowed.includes(value)) throw new ConfigError(`${key}: нужно одно из ${allowed.join(', ')}`)
  return value
}

/** A number in a range, for speeds and ratios. */
function numberInRange(raw, key, { min, max }) {
  const value = Number(String(raw).trim().replace(',', '.'))
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${key}: нужно число от ${min} до ${max}, ${described(raw)}`)
  }
  return value
}

/** The variants mode: auto (decide by the task), always, never. */
function variantsMode(raw) {
  const value = String(raw).trim().toLowerCase()
  if (!['auto', 'always', 'never'].includes(value)) {
    throw new ConfigError('PROPOSE_VARIANTS: нужно auto, always или never')
  }
  return value
}

/** Require an absolute path, without touching the filesystem. */
function absolutePath(raw, key) {
  const value = String(raw).trim()
  if (!value.startsWith('/')) throw new ConfigError(`${key}: нужен абсолютный путь (начинается с /)`)
  return value.replace(/\/+$/, '') || '/'
}

/** Telegram user ids from a comma/space separated list. */
export function parseUserIds(raw) {
  return new Set(String(raw ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== ''))
}

/**
 * Build the agent configuration from an environment object.
 *
 * @param {Record<string, string|undefined>} [env] - environment, defaults to `process.env`.
 * @returns {object} validated configuration.
 * @throws {ConfigError} when a required value is missing or malformed.
 */
export function loadConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim()
  if (token === '') throw new ConfigError('TELEGRAM_BOT_TOKEN: не задан токен бота агента')
  if (!token.includes(':')) throw new ConfigError('TELEGRAM_BOT_TOKEN: токен должен содержать «:» (формат <id>:<secret>)')

  const allowAll = boolean(read(env, 'ALLOW_ALL_USERS'), 'ALLOW_ALL_USERS')
  const allowedUserIds = parseUserIds(env.ALLOWED_USER_IDS)
  if (!allowAll && allowedUserIds.size === 0) {
    throw new ConfigError('ALLOWED_USER_IDS: список пуст, а ALLOW_ALL_USERS=false — бот не ответит никому')
  }

  const maxTaskChars = positiveInt(read(env, 'MAX_TASK_CHARS'), 'MAX_TASK_CHARS', { min: 100, max: 200_000 })
  const maxAttachmentBytes = positiveInt(read(env, 'MAX_ATTACHMENT_BYTES'), 'MAX_ATTACHMENT_BYTES', { min: 1024, max: 2_000_000_000 })

  return {
    telegram: {
      token,
      apiBase: String(read(env, 'TELEGRAM_API_BASE')).replace(/\/+$/, ''),
      timeoutMs: positiveInt(read(env, 'TELEGRAM_TIMEOUT_MS'), 'TELEGRAM_TIMEOUT_MS', { min: 5000, max: 600_000 }),
      pollTimeoutSec: positiveInt(read(env, 'POLL_TIMEOUT_SEC'), 'POLL_TIMEOUT_SEC', { min: 1, max: 300 }),
      allowedUserIds,
      allowAllUsers: allowAll,
      denyMessage: String(read(env, 'DENY_MESSAGE')),
    },
    dsh: {
      bin: absolutePath(read(env, 'DSH_BIN'), 'DSH_BIN'),
      profile: String(read(env, 'DSH_PROFILE')).trim() || 'headless',
      home: absolutePath(read(env, 'DSH_HOME'), 'DSH_HOME'),
      permissionMode: String(read(env, 'DSH_PERMISSION_MODE')).trim() || 'workspace-write',
    },
    workspace: {
      dir: absolutePath(read(env, 'WORKSPACE_DIR'), 'WORKSPACE_DIR'),
      stateDir: absolutePath(read(env, 'STATE_DIR'), 'STATE_DIR'),
      maxTaskChars,
      maxAnswerChars: positiveInt(read(env, 'MAX_ANSWER_CHARS'), 'MAX_ANSWER_CHARS', { min: 500, max: 200_000 }),
      maxAttachmentBytes,
      maxOutputFiles: positiveInt(read(env, 'MAX_OUTPUT_FILES'), 'MAX_OUTPUT_FILES', { min: 1, max: 50 }),
      maxOutputFileBytes: positiveInt(read(env, 'MAX_OUTPUT_FILE_BYTES'), 'MAX_OUTPUT_FILE_BYTES', { min: 1024, max: 2_000_000_000 }),
      retentionDays: positiveInt(read(env, 'OUTPUT_RETENTION_DAYS'), 'OUTPUT_RETENTION_DAYS', { min: 0, max: 3650, allowZero: true }),
      alertMb: positiveInt(read(env, 'WORKSPACE_ALERT_MB'), 'WORKSPACE_ALERT_MB', { min: 1, max: 1_000_000 }),
    },
    limits: {
      taskTimeoutMs: positiveInt(read(env, 'TASK_TIMEOUT_MS'), 'TASK_TIMEOUT_MS', { min: 10_000, max: 7_200_000 }),
      dailyTokenLimit: positiveInt(read(env, 'DAILY_TOKEN_LIMIT'), 'DAILY_TOKEN_LIMIT', { min: 0, max: 1_000_000_000, allowZero: true }),
      usageRetentionDays: positiveInt(read(env, 'USAGE_RETENTION_DAYS'), 'USAGE_RETENTION_DAYS', { min: 1, max: 3650 }),
      // 0 turns the per-task ceiling off.
      taskTokenBudget: positiveInt(read(env, 'TASK_TOKEN_BUDGET'), 'TASK_TOKEN_BUDGET', { min: 0, max: 1_000_000_000, allowZero: true }),
      taskTokenWarn: positiveInt(read(env, 'TASK_TOKEN_WARN'), 'TASK_TOKEN_WARN', { min: 0, max: 1_000_000_000, allowZero: true }),
    },
    task: {
      cgroup: boolean(read(env, 'TASK_CGROUP'), 'TASK_CGROUP'),
      memoryMaxBytes: positiveInt(read(env, 'TASK_MEMORY_MAX_MB'), 'TASK_MEMORY_MAX_MB', { min: 128, max: 65_536 }) * 1024 * 1024,
      cpuPercent: positiveInt(read(env, 'TASK_CPU_PERCENT'), 'TASK_CPU_PERCENT', { min: 10, max: 800 }),
      pidsMax: positiveInt(read(env, 'TASK_PIDS_MAX'), 'TASK_PIDS_MAX', { min: 16, max: 4096 }),
    },
    model: {
      apiKey: String(env.MODEL_API_KEY ?? '').trim(),
      name: String(read(env, 'MODEL_NAME')),
    },
    disk: {
      enabled: boolean(read(env, 'YANDEX_DISK'), 'YANDEX_DISK'),
      // rest — OAuth-токен приложения; webdav — логин и пароль приложения.
      mode: choice(read(env, 'YANDEX_DISK_MODE'), 'YANDEX_DISK_MODE', ['rest', 'webdav'], 'rest'),
      token: String(env.YANDEX_DISK_TOKEN ?? '').trim(),
      login: String(env.YANDEX_DISK_LOGIN ?? '').trim(),
      password: String(env.YANDEX_DISK_PASSWORD ?? '').trim(),
      dir: String(read(env, 'YANDEX_DISK_DIR')).trim() || '/Агент',
      // A public link is readable by anyone who has it, so it stays opt-in.
      publish: boolean(read(env, 'YANDEX_DISK_PUBLISH'), 'YANDEX_DISK_PUBLISH'),
      timeoutMs: positiveInt(read(env, 'YANDEX_DISK_TIMEOUT_MS'), 'YANDEX_DISK_TIMEOUT_MS', { min: 5000, max: 600_000 }),
    },
    plan: {
      mode: choice(read(env, 'PLAN_MODE'), 'PLAN_MODE', ['auto', 'always', 'never'], 'auto'),
      minChars: positiveInt(read(env, 'PLAN_MIN_CHARS'), 'PLAN_MIN_CHARS', { min: 20, max: 10_000 }),
      signals: String(env.PLAN_SIGNALS ?? '').trim(),
    },
    routing: {
      mode: choice(read(env, 'ROUTING'), 'ROUTING', ['auto', 'off'], 'auto'),
      maxChars: positiveInt(read(env, 'ROUTER_MAX_CHARS'), 'ROUTER_MAX_CHARS', { min: 20, max: 4000 }),
      // Anything above this length is treated as real work, not a question.
      baseUrl: String(env.ROUTER_BASE_URL ?? '').trim().replace(/\/+$/, '') || String(read(env, 'VISION_BASE_URL')).replace(/\/+$/, ''),
      apiKey: String(env.ROUTER_API_KEY ?? '').trim() || String(env.MODEL_API_KEY ?? '').trim(),
      model: String(read(env, 'ROUTER_MODEL')).trim() || String(read(env, 'MODEL_NAME')).trim(),
      maxTokens: positiveInt(read(env, 'ROUTER_MAX_TOKENS'), 'ROUTER_MAX_TOKENS', { min: 50, max: 8000 }),
      timeoutMs: positiveInt(read(env, 'ROUTER_TIMEOUT_MS'), 'ROUTER_TIMEOUT_MS', { min: 5000, max: 600_000 }),
    },
    vision: {
      enabled: boolean(read(env, 'VISION'), 'VISION'),
      baseUrl: String(read(env, 'VISION_BASE_URL')).replace(/\/+$/, ''),
      // A separate key for image calls is optional; the model key is the default.
      apiKey: String(env.VISION_API_KEY ?? '').trim() || String(env.MODEL_API_KEY ?? '').trim(),
      model: String(read(env, 'VISION_MODEL')).trim(),
      maxTokens: positiveInt(read(env, 'VISION_MAX_TOKENS'), 'VISION_MAX_TOKENS', { min: 32, max: 8000 }),
      timeoutMs: positiveInt(read(env, 'VISION_TIMEOUT_MS'), 'VISION_TIMEOUT_MS', { min: 5000, max: 600_000 }),
      maxImageBytes: positiveInt(read(env, 'VISION_MAX_IMAGE_BYTES'), 'VISION_MAX_IMAGE_BYTES', { min: 1024, max: 50_000_000 }),
    },
    ocr: {
      enabled: boolean(read(env, 'OCR'), 'OCR'),
      command: String(read(env, 'OCR_COMMAND')).trim(),
      languages: String(read(env, 'OCR_LANGUAGES')).trim(),
      timeoutMs: positiveInt(read(env, 'OCR_TIMEOUT_MS'), 'OCR_TIMEOUT_MS', { min: 5000, max: 600_000 }),
    },
    dialogue: {
      awaitReplyMs: positiveInt(read(env, 'AWAIT_REPLY_MS'), 'AWAIT_REPLY_MS', { min: 60_000, max: 30 * 24 * 3600 * 1000 }),
      proposeVariants: variantsMode(read(env, 'PROPOSE_VARIANTS')),
      maxVariants: positiveInt(read(env, 'MAX_VARIANTS'), 'MAX_VARIANTS', { min: 2, max: 5 }),
    },
    journal: {
      maxEntries: positiveInt(read(env, 'TASKS_MAX_ENTRIES'), 'TASKS_MAX_ENTRIES', { min: 50, max: 100_000 }),
    },
    voice: {
      stt: {
        provider: choice(read(env, 'STT_PROVIDER'), 'STT_PROVIDER', ['none', 'yandex', 'openai'], 'none'),
        apiKey: String(env.STT_API_KEY ?? '').trim(),
        baseUrl: String(read(env, 'STT_BASE_URL')).replace(/\/+$/, ''),
        model: String(read(env, 'STT_MODEL')).trim(),
        language: String(read(env, 'STT_LANGUAGE')).trim(),
        folderId: String(env.STT_FOLDER_ID ?? '').trim(),
        timeoutMs: positiveInt(read(env, 'STT_TIMEOUT_MS'), 'STT_TIMEOUT_MS', { min: 5000, max: 600_000 }),
        maxBytes: positiveInt(read(env, 'STT_MAX_BYTES'), 'STT_MAX_BYTES', { min: 1024, max: 20_000_000 }),
      },
      tts: {
        provider: choice(read(env, 'TTS_PROVIDER'), 'TTS_PROVIDER', ['none', 'yandex'], 'none'),
        // One SpeechKit key usually covers both directions.
        apiKey: String(env.TTS_API_KEY ?? '').trim() || String(env.STT_API_KEY ?? '').trim(),
        voice: String(read(env, 'TTS_VOICE')).trim() || 'alena',
        speed: numberInRange(read(env, 'TTS_SPEED'), 'TTS_SPEED', { min: 0.1, max: 3 }),
        maxChars: positiveInt(read(env, 'TTS_MAX_CHARS'), 'TTS_MAX_CHARS', { min: 100, max: 5000 }),
        timeoutMs: positiveInt(read(env, 'TTS_TIMEOUT_MS'), 'TTS_TIMEOUT_MS', { min: 5000, max: 600_000 }),
      },
      // auto: answer with a voice note when the request came as one.
      reply: choice(read(env, 'VOICE_REPLY'), 'VOICE_REPLY', ['auto', 'always', 'never'], 'auto'),
      folderId: String(env.STT_FOLDER_ID ?? '').trim(),
    },
    bridge: {
      // HTTP intake: enabled only when a token is set.
      http: boolean(read(env, 'BRIDGE_HTTP'), 'BRIDGE_HTTP'),
      bind: String(read(env, 'BRIDGE_BIND')).trim() || '127.0.0.1',
      port: positiveInt(read(env, 'BRIDGE_PORT'), 'BRIDGE_PORT', { min: 1, max: 65_535 }),
      token: String(env.BRIDGE_TOKEN ?? '').trim(),
      maxTaskChars: positiveInt(read(env, 'BRIDGE_MAX_TASK_CHARS'), 'BRIDGE_MAX_TASK_CHARS', { min: 100, max: 20_000 }),
      groupId: String(env.BRIDGE_GROUP_ID ?? '').trim(),
      // Empty means "any bot in that group", which is acceptable there: the group
      // holds the two bots and the owner, and the message must be addressed.
      sourceBotIds: parseUserIds(env.BRIDGE_SOURCE_BOT_IDS),
      notify: boolean(read(env, 'BRIDGE_NOTIFY'), 'BRIDGE_NOTIFY'),
    },
    schedules: {
      enabled: boolean(read(env, 'SCHEDULES'), 'SCHEDULES'),
      tickSec: positiveInt(read(env, 'SCHEDULE_TICK_SEC'), 'SCHEDULE_TICK_SEC', { min: 10, max: 3600 }),
      max: positiveInt(read(env, 'MAX_SCHEDULES'), 'MAX_SCHEDULES', { min: 1, max: 200 }),
      // An empty value means "the same zone as the daily budget".
      timeZone: String(env.SCHEDULE_TIME_ZONE ?? '').trim() || String(env.TIME_ZONE ?? '').trim(),
    },
    alerts: {
      chatId: String(env.ALERT_CHAT_ID ?? '').trim(),
      limitPercent: positiveInt(read(env, 'ALERT_ON_LIMIT_PERCENT'), 'ALERT_ON_LIMIT_PERCENT', { min: 1, max: 100 }),
    },
    pricing: {
      prices: {
        inputPeak: nonNegativeNumber(read(env, 'PRICE_INPUT_PEAK_PER_M'), 'PRICE_INPUT_PEAK_PER_M'),
        inputOffPeak: nonNegativeNumber(read(env, 'PRICE_INPUT_OFFPEAK_PER_M'), 'PRICE_INPUT_OFFPEAK_PER_M'),
        cachedPeak: nonNegativeNumber(read(env, 'PRICE_CACHED_PEAK_PER_M'), 'PRICE_CACHED_PEAK_PER_M'),
        cachedOffPeak: nonNegativeNumber(read(env, 'PRICE_CACHED_OFFPEAK_PER_M'), 'PRICE_CACHED_OFFPEAK_PER_M'),
        outputPeak: nonNegativeNumber(read(env, 'PRICE_OUTPUT_PEAK_PER_M'), 'PRICE_OUTPUT_PEAK_PER_M'),
        outputOffPeak: nonNegativeNumber(read(env, 'PRICE_OUTPUT_OFFPEAK_PER_M'), 'PRICE_OUTPUT_OFFPEAK_PER_M'),
      },
      windows: String(read(env, 'PEAK_WINDOWS_UTC')),
      weekdaysOnly: boolean(read(env, 'PEAK_WEEKDAYS_ONLY'), 'PEAK_WEEKDAYS_ONLY'),
    },
    runtime: {
      timeZone: String(env.TIME_ZONE ?? '').trim(),
      logLevel: String(read(env, 'LOG_LEVEL')).trim().toLowerCase(),
      sessionContinuity: boolean(read(env, 'SESSION_CONTINUITY'), 'SESSION_CONTINUITY'),
      progressIntervalMs: positiveInt(read(env, 'PROGRESS_INTERVAL_MS'), 'PROGRESS_INTERVAL_MS', { min: 5000, max: 600_000 }),
      shutdownGraceMs: positiveInt(read(env, 'SHUTDOWN_GRACE_MS'), 'SHUTDOWN_GRACE_MS', { min: 0, max: 120_000, allowZero: true }),
    },
  }
}

/** The values the logger must never print; deduplicated, since one key may serve both roles. */
export const secretsOf = (config) => [...new Set([
  config.telegram.token,
  config.model.apiKey,
  config.vision.apiKey,
  config.voice.stt.apiKey,
  config.voice.tts.apiKey,
  config.bridge.token,
  config.disk.token,
  config.disk.password,
].filter(Boolean))]
