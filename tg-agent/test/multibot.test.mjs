/**
 * Several bots of one process.
 *
 * Each bot must get its own adapter token, its own state files and its own
 * scheduler, while the model client and tool sources stay shared.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInstance } from '../src/index.mjs'
import { loadConfig } from '../src/config.mjs'
import { ChatModel } from '../src/model.mjs'
import { createTelegramPlatform } from '../src/platforms/telegram.mjs'
import { createModelStub, createTelegramStub, testEnv, waitFor } from './helpers.mjs'

/** Nothing to report in tests. */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

const TOKEN_A = '123456:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '123456:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('readBots lists the primary bot first and gives extras their own namespace', async () => {
  const { readBots } = await import('../src/config.mjs')
  const warnings = []
  const bots = readBots({
    PLATFORM: 'telegram',
    TELEGRAM_BOT_TOKEN: TOKEN_A,
    BOT_1_LABEL: 'family',
    BOT_1_TOKEN: TOKEN_B,
    BOT_2_PLATFORM: 'max',
    BOT_2_TOKEN: 'max-token',
    BOT_3_LABEL: 'no token',
  }, warnings)
  assert.deepEqual(bots.map((bot) => [bot.label, bot.platform, bot.namespace]), [
    ['main', 'telegram', 'telegram'],
    ['family', 'telegram', 'telegram-family'],
    ['bot2', 'max', 'max-bot2'],
  ])
  assert.equal(bots[1].token, TOKEN_B)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /BOT_3_TOKEN/)
})

test('two bots run side by side with separate state files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-multibot-'))
  const telegramStub = await createTelegramStub({ updates: [] })
  const modelStub = await createModelStub({ responses: [{ content: 'ответ' }] })
  const env = testEnv({
    telegramApiBase: telegramStub.apiBase,
    modelBaseUrl: modelStub.baseUrl,
    dataDir: dir,
    overrides: {
      TELEGRAM_BOT_TOKEN: TOKEN_A,
      BOT_1_LABEL: 'family',
      BOT_1_TOKEN: TOKEN_B,
      DIGEST: 'false',
      REMINDERS: 'true',
      MEMORY: 'true',
    },
  })
  const config = loadConfig(env)
  const model = new ChatModel({ baseUrl: modelStub.baseUrl, apiKey: 'sk-test', name: config.model.name, logger: silentLogger })
  const tokens = []
  const platformFactory = async (botConfig) => {
    tokens.push(botConfig.telegram.token)
    return createTelegramPlatform({ token: botConfig.telegram.token, apiBase: telegramStub.apiBase, logger: silentLogger })
  }
  const instances = []
  try {
    for (const instance of config.bots) {
      instances.push(await createInstance({ config, logger: silentLogger, instance, shared: { model }, platformFactory }))
    }
    assert.equal(instances.length, 2)
    assert.deepEqual(tokens, [TOKEN_A, TOKEN_B], 'каждый бот получил свой токен')
    // Both poll: the stub records getUpdates calls for both tokens.
    await waitFor(
      () => telegramStub.state.calls.filter((call) => call.method === 'getUpdates').length >= 2,
      { what: 'оба бота опрашивают Telegram' },
    )
    for (const { bot, instance } of instances) {
      assert.equal(bot.platform.namespace, 'tg', `${instance.label}: namespace адаптера`)
      assert.ok(bot.running, `${instance.label}: бот запущен`)
    }
    // Separate state files: the primary keeps the historical names, the extra
    // bot gets a suffixed namespace. The paths are what decides it, because a
    // store writes its file only when there is something to save.
    const [first, second] = instances
    assert.ok(first.bot.history.file.endsWith(path.join('', 'history.json')), first.bot.history.file)
    assert.ok(second.bot.history.file.endsWith('history-telegram-family.json'), second.bot.history.file)
    assert.ok(first.bot.profiles.store.file.endsWith('users.json'), first.bot.profiles.store.file)
    assert.ok(second.bot.profiles.store.file.endsWith('users-telegram-family.json'), second.bot.profiles.store.file)
    assert.ok(second.bot.reminders.store.file.endsWith('reminders-telegram-family.json'), second.bot.reminders.store.file)
    assert.notEqual(first.bot.history.file, second.bot.history.file)
  } finally {
    for (const { bot } of instances) await bot.stop().catch(() => {})
    await telegramStub.close()
    await modelStub.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('each bot digests only to its own platform ids', async () => {
  // A Telegram id is meaningless in VK: after the allow lists were split, a VK
  // bot used to schedule the digest for both platforms and would fail at 08:00.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-digest-'))
  const telegramStub = await createTelegramStub({ updates: [] })
  const modelStub = await createModelStub({ responses: [{ content: 'ответ' }] })
  const env = testEnv({
    telegramApiBase: telegramStub.apiBase,
    modelBaseUrl: modelStub.baseUrl,
    dataDir: dir,
    overrides: {
      TELEGRAM_BOT_TOKEN: TOKEN_A,
      ALLOWED_USER_IDS: '433296567',
      ALLOWED_USER_IDS_VK: '123456789',
      DIGEST: 'true',
      REMINDERS: 'false',
      MEMORY: 'false',
    },
  })
  const config = loadConfig(env)
  const model = new ChatModel({ baseUrl: modelStub.baseUrl, apiKey: 'sk-test', name: config.model.name, logger: silentLogger })
  const instances = []
  try {
    for (const instance of config.bots) {
      instances.push(await createInstance({ config, logger: silentLogger, instance, shared: { model }, platformFactory: async () => fakePlatform() }))
    }
    const byPlatform = Object.fromEntries(instances.map((item) => [item.instance.platform, item]))
    assert.deepEqual(byPlatform.telegram.bot.digest?.chatIds, ['433296567'])
    const vkInstance = await createInstance({
      config,
      logger: silentLogger,
      instance: { label: 'vk', platform: 'vk', token: 'vk-token', namespace: 'vk' },
      shared: { model },
      platformFactory: async () => fakePlatform(),
    })
    instances.push(vkInstance)
    assert.deepEqual(vkInstance.bot.digest?.chatIds, ['123456789'], 'VK-бот пишет только своим')
  } finally {
    for (const { bot } of instances) await bot.stop().catch(() => {})
    await telegramStub.close()
    await modelStub.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** The smallest adapter that satisfies the port: the digest never sends here. */
function fakePlatform() {
  return {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 1, username: 'stub' },
    async start() {},
    async stop() {},
    async getUpdates({ signal } = {}) {
      // A real adapter blocks for its poll timeout; returning instantly would spin
      // the core's loop at full speed.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      return { updates: [], cursor: undefined }
    },
    async sendText() {
      return { messageId: 1 }
    },
    async editText() {},
    async answerCallback() {},
    async sendTyping() {},
  }
}
