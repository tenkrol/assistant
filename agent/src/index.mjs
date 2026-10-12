/**
 * Entry point of the task agent.
 *
 * Wires the configuration, the Telegram adapter, the DSH runner and the two
 * stores together, then runs the polling loop until SIGTERM/SIGINT. A
 * configuration or startup problem is reported as one readable line — never as
 * a stack trace with a token inside it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentBot } from './bot.mjs'
import { CgroupLimiter } from './cgroup.mjs'
import { createBridgeServer } from './bridge-http.mjs'
import { ConfigError, loadConfig, secretsOf } from './config.mjs'
import { DshTaskRunner } from './dsh-task.mjs'
import { createLogger } from './logger.mjs'
import { OcrClient } from './ocr.mjs'
import { createTelegramPlatform } from './platform.mjs'
import { ScheduleStore } from './schedule.mjs'
import { createMemoryStore } from './memory.mjs'
import { createDiskStorage } from './yandex-disk.mjs'
import { QuickClient } from './quick.mjs'
import { createTranscriber } from './stt.mjs'
import { StateStore } from './state.mjs'
import { TaskJournal } from './tasks.mjs'
import { createSynthesizer } from './tts.mjs'
import { UsageStore } from './usage.mjs'
import { VisionClient } from './vision.mjs'
import { ensureWorkspace } from './workspace.mjs'

const projectDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Fail with one readable line instead of a stack trace. */
function fatal(message) {
  process.stderr.write(`ОШИБКА: ${message}\n`)
  process.exit(1)
}

/** Refuse to start when the DSH binary is missing or not executable. */
async function assertDshUsable(bin) {
  try {
    await fs.access(bin, fs.constants.X_OK)
  } catch {
    fatal(`DSH_BIN=${bin} не найден или не исполняется. Установите: npm i -g @deepseek-ai/dsh@0.2.0-rc.2`)
  }
}

async function main() {
  let config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) fatal(error.message)
    throw error
  }

  const logger = createLogger({ level: config.runtime.logLevel, redact: secretsOf(config) })
  await assertDshUsable(config.dsh.bin)

  const { dir, stateDir } = config.workspace
  await fs.mkdir(stateDir, { recursive: true })
  await fs.mkdir(config.dsh.home, { recursive: true })
  await ensureWorkspace(dir)

  const platform = createTelegramPlatform({
    token: config.telegram.token,
    apiBase: config.telegram.apiBase,
    timeoutMs: config.telegram.timeoutMs,
    logger,
  })

  const state = await new StateStore({ file: path.join(stateDir, 'state.json'), logger }).load()
  const usage = await new UsageStore({
    file: path.join(stateDir, 'usage.json'),
    logger,
    retentionDays: config.limits.usageRetentionDays,
    dailyLimit: config.limits.dailyTokenLimit,
  }).load()
  const memory = await createMemoryStore({ file: path.join(stateDir, 'memory.json'), logger }).load()
  logger.info('memory loaded', { facts: memory.size })
  const journal = new TaskJournal({
    file: path.join(stateDir, 'tasks.jsonl'),
    logger,
    maxEntries: config.journal.maxEntries,
  })
  const schedules = new ScheduleStore({
    file: path.join(stateDir, 'schedules.json'),
    timeZone: config.schedules.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    logger,
  })

  /** @type {AgentBot} */
  let bot
  const cgroupLimiter = config.task.cgroup
    ? new CgroupLimiter({
      memoryMaxBytes: config.task.memoryMaxBytes,
      cpuPercent: config.task.cpuPercent,
      pidsMax: config.task.pidsMax,
      logger,
    })
    : undefined
  await cgroupLimiter?.probe()
  const runner = new DshTaskRunner({
    command: config.dsh.bin,
    workspaceDir: dir,
    dshHome: config.dsh.home,
    profile: config.dsh.profile,
    permissionMode: config.dsh.permissionMode,
    apiKey: config.model.apiKey,
    timeoutMs: config.limits.taskTimeoutMs,
    tokenBudget: config.limits.taskTokenBudget,
    logger,
    cgroup: cgroupLimiter,
    onEvent: (event) => bot?.onDshEvent(event),
  })

  const vision = new VisionClient({
    baseUrl: config.vision.baseUrl,
    apiKey: config.vision.apiKey,
    model: config.vision.model,
    maxTokens: config.vision.maxTokens,
    timeoutMs: config.vision.timeoutMs,
    logger,
  })
  const ocr = new OcrClient({
    command: config.ocr.command,
    languages: config.ocr.languages,
    timeoutMs: config.ocr.timeoutMs,
    logger,
  })
  // Voice is optional in both directions: no key means the feature is simply off.
  const stt = config.voice.stt.provider !== 'none' && config.voice.stt.apiKey
    ? createTranscriber({
      provider: config.voice.stt.provider,
      apiKey: config.voice.stt.apiKey,
      baseUrl: config.voice.stt.baseUrl,
      model: config.voice.stt.model,
      language: config.voice.stt.language,
      folderId: config.voice.stt.folderId,
      timeoutMs: config.voice.stt.timeoutMs,
      logger,
    })
    : undefined
  const tts = config.voice.tts.provider !== 'none' && config.voice.tts.apiKey
    ? createSynthesizer({
      apiKey: config.voice.tts.apiKey,
      folderId: config.voice.folderId,
      voice: config.voice.tts.voice,
      speed: config.voice.tts.speed,
      maxChars: config.voice.tts.maxChars,
      timeoutMs: config.voice.tts.timeoutMs,
      logger,
    })
    : undefined
  logger.info('voice', { stt: Boolean(stt), tts: Boolean(tts), reply: config.voice.reply })
  const visionEnabled = config.vision.enabled && Boolean(config.vision.apiKey)
  const ocrAvailable = config.ocr.enabled ? await ocr.probe() : false
  logger.info('image input', { vision: visionEnabled, ocr: ocrAvailable, model: config.vision.model })
  // The quick layer answers trivial requests without starting a task at all.
  const quick = config.routing.mode === 'auto' && config.routing.apiKey
    ? new QuickClient({
      baseUrl: config.routing.baseUrl,
      apiKey: config.routing.apiKey,
      model: config.routing.model,
      maxTokens: config.routing.maxTokens,
      timeoutMs: config.routing.timeoutMs,
      logger,
    })
    : undefined
  // Yandex.Disk keeps the archive; missing credentials simply leave it off.
  const diskReady = config.disk.mode === 'webdav'
    ? Boolean(config.disk.login && config.disk.password)
    : Boolean(config.disk.token)
  const disk = config.disk.enabled && diskReady
    ? createDiskStorage({
      mode: config.disk.mode,
      token: config.disk.token,
      login: config.disk.login,
      password: config.disk.password,
      dir: config.disk.dir,
      timeoutMs: config.disk.timeoutMs,
      logger,
    })
    : undefined
  if (disk) {
    const probe = await disk.probe()
    if (probe.ok) logger.info('yandex disk ready', { dir: probe.dir, total: probe.total, used: probe.used })
    else logger.warn('yandex disk unavailable', { error: probe.error })
  } else {
    logger.info('yandex disk off', { enabled: config.disk.enabled, mode: config.disk.mode, credentials: diskReady })
  }
  logger.info('routing', { mode: config.routing.mode, quick: Boolean(quick), model: config.routing.model, maxChars: config.routing.maxChars })
  if (config.ocr.enabled && !ocrAvailable) {
    logger.warn('OCR недоступен: команда не найдена', { command: config.ocr.command })
  }

  bot = new AgentBot({
    config,
    platform,
    runner,
    usage,
    state,
    journal,
    schedules,
    vision: visionEnabled ? vision : undefined,
    ocr: ocrAvailable ? ocr : undefined,
    stt,
    tts,
    quick,
    memory,
    disk,
    logger,
    instructionsPath: path.join(projectDir, 'deploy', 'workspace', 'AGENTS.md.template'),
  })

  // The bridge is a loopback listener reached through an SSH tunnel from Spain.
  const bridgeEnabled = config.bridge.http && Boolean(config.bridge.token)
  const bridge = bridgeEnabled
    ? createBridgeServer({
      token: config.bridge.token,
      host: config.bridge.bind,
      port: config.bridge.port,
      maxTaskChars: config.bridge.maxTaskChars,
      logger,
      onSubmit: ({ task, source }) => bot.submitBridgedTask({ task, source }),
    })
    : undefined
  if (!bridgeEnabled) logger.info('bridge http off', { http: config.bridge.http, token: Boolean(config.bridge.token) })

  if (!config.model.apiKey) {
    logger.warn('MODEL_API_KEY не задан: DSH не сможет обратиться к модели')
  }

  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    logger.info('shutdown requested', { signal })
    await bot.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { error: reason }))

  await bot.start()
  await bridge?.start()
  process.on('exit', () => { void bridge?.stop() })
  try {
    await bot.run()
  } finally {
    await bridge?.stop()
  }
}

main().catch((error) => {
  process.stderr.write(`ОШИБКА: ${error?.message ?? error}\n`)
  process.exit(1)
})
