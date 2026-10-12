/**
 * Test doubles: a Telegram adapter, a DSH runner, and a temporary environment.
 *
 * Nothing here talks to the network or to a real DSH process; the tests assert
 * the agent's own decisions (what it sends, what it quotes, what it stores).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentBot } from '../src/bot.mjs'
import { MemoryStore } from '../src/memory.mjs'
import { loadConfig } from '../src/config.mjs'
import { ScheduleStore } from '../src/schedule.mjs'
import { StateStore } from '../src/state.mjs'
import { TaskJournal } from '../src/tasks.mjs'
import { UsageStore } from '../src/usage.mjs'

/** Fresh temporary directory for one test. */
export async function tempDir(prefix = 'agent-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Remove a temporary tree, ignoring races with the running code. */
export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** A logger that keeps everything in memory instead of printing it. */
export function createTestLogger() {
  const lines = []
  const record = (level) => (message, fields) => lines.push({ level, message, fields })
  return {
    lines,
    level: 'debug',
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => createTestLogger(),
  }
}

/**
 * Stub Telegram adapter: records what the bot sends, serves canned downloads.
 *
 * @param {object} [options] - `identity`, `updates` returned once by `getUpdates`.
 */
export function createStubPlatform({ identity = { id: 999, username: 'test_bot' }, updates = [] } = {}) {
  const sent = []
  const edits = []
  const documents = []
  const photos = []
  const downloads = new Map()
  const callbacks = []
  let polls = 0
  return {
    name: 'stub',
    identity,
    sent,
    edits,
    documents,
    photos,
    downloads,
    callbacks,
    async start() { return this },
    async stop() {},
    async getUpdates() {
      polls += 1
      // The first poll returns the prepared updates, then the loop waits.
      if (polls === 1) return { updates, cursor: updates.length > 0 ? 100 + updates.length : undefined }
      return { updates: [], cursor: updates.length > 0 ? 100 + updates.length : undefined }
    },
    async sendText({ chatId, markdown, keyboard, replyToMessageId }) {
      sent.push({ chatId, markdown, keyboard, replyToMessageId })
      return { messageId: sent.length }
    },
    async editText({ chatId, messageId, markdown, keyboard }) {
      edits.push({ chatId, messageId, markdown, keyboard })
    },
    voices: [],
    async sendVoice(request) {
      if (!this.voices) this.voices = []
      this.voices.push(request)
      return { messageId: this.voices.length }
    },
    async answerCallback({ callbackId, text, alert }) {
      callbacks.push({ callbackId, text, alert })
      return true
    },
    async sendTyping() {},
    async sendDocument(request) {
      documents.push(request)
      return { messageId: documents.length }
    },
    async sendPhoto(request) {
      photos.push(request)
      return { messageId: photos.length }
    },
    async downloadFile({ fileId }) {
      if (!downloads.has(fileId)) throw new Error(`нет файла ${fileId}`)
      return downloads.get(fileId)
    },
  }
}

/** A runner that returns a canned result and records the tasks it was given. */
export function createStubRunner(result = {}) {
  const calls = []
  return {
    calls,
    async run(request) {
      calls.push(request)
      if (typeof result === 'function') return result(request)
      return {
        ok: true,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        text: 'готово',
        sessionId: 'session-stub-1',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, steps: 1, turns: 1 },
        tools: ['bash'],
        errors: [],
        stderr: '',
        durationMs: 1000,
        ...result,
      }
    },
  }
}

/** Configuration pointing at a temporary tree, with a token and one allowed user. */
export function testConfig(dir, overrides = {}) {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    ALLOWED_USER_IDS: '42',
    DSH_BIN: '/bin/true',
    DSH_HOME: path.join(dir, 'dsh'),
    WORKSPACE_DIR: path.join(dir, 'workspace'),
    STATE_DIR: path.join(dir, 'state'),
    MODEL_API_KEY: 'test-key',
    ...overrides,
  })
}

/**
 * A started bot over a temporary tree: stores, journal, adapter and runner.
 *
 * Shared by the bot and dialogue suites so both exercise the same wiring the
 * service uses (journal included) instead of a bespoke arrangement.
 *
 * @param {object} [options] - `runner`, `configEnv`, `vision`, `ocr`.
 * @returns {Promise<object>} the environment, with `close()` to clean up.
 */
export async function createBotHarness({ runner = createStubRunner(), configEnv = {}, vision, ocr, now } = {}) {
  const dir = await tempDir()
  const config = testConfig(dir, configEnv)
  const platform = createStubPlatform()
  const logger = createTestLogger()
  const state = await new StateStore({ file: path.join(config.workspace.stateDir, 'state.json'), logger }).load()
  // Keep the startup notice out of the assertions.
  state.set('startupNoticeAt', Date.now())
  const usage = new UsageStore({
    file: path.join(config.workspace.stateDir, 'usage.json'),
    logger,
    dailyLimit: config.limits.dailyTokenLimit,
  })
  const journal = new TaskJournal({
    file: path.join(config.workspace.stateDir, 'tasks.jsonl'),
    logger,
    maxEntries: 50,
  })
  const schedules = new ScheduleStore({
    file: path.join(config.workspace.stateDir, 'schedules.json'),
    timeZone: config.schedules.timeZone || 'Europe/Moscow',
    logger,
  })
  const memory = await new MemoryStore({ file: path.join(config.workspace.stateDir, 'memory.json'), logger }).load()
  const bot = new AgentBot({ config, platform, runner, usage, state, journal, schedules, vision, ocr, memory, logger, now })
  await bot.start()
  return {
    dir,
    ws: config.workspace.dir,
    config,
    platform,
    state,
    usage,
    journal,
    schedules,
    memory,
    bot,
    logger,
    close: () => cleanup(dir),
  }
}
