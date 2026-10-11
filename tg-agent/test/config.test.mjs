import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, loadConfig } from '../src/config.mjs'

/** Nothing to report in tests. */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

const minimal = {
  TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
  MODEL_API_KEY: 'sk-test',
  ALLOWED_USER_IDS: '1, 2',
}

test('applies documented defaults', () => {
  const config = loadConfig(minimal)
  assert.equal(config.telegram.apiBase, 'https://api.telegram.org')
  assert.equal(config.model.baseUrl, 'https://api.deepseek.com')
  assert.equal(config.model.name, 'deepseek-chat')
  assert.equal(config.history.limit, 20)
  assert.equal(config.telegram.pollTimeoutSec, 30)
  assert.equal(config.limits.maxConcurrentRequests, 4)
  assert.equal(config.dataDir, './data')
  assert.deepEqual([...config.access.allowedUserIds], [1, 2])
  assert.equal(config.access.allowedChatTypes.has('private'), true)
  assert.deepEqual(config.warnings, [])
})

test('requires a bot token and a model key', () => {
  assert.throws(() => loadConfig({ ...minimal, TELEGRAM_BOT_TOKEN: '' }), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /TELEGRAM_BOT_TOKEN is required/)
    return true
  })
  assert.throws(() => loadConfig({ ...minimal, MODEL_API_KEY: '' }), (error) => {
    assert.match(error.message, /MODEL_API_KEY is required/)
    return true
  })
})

test('rejects a token that cannot be a BotFather token', () => {
  assert.throws(() => loadConfig({ ...minimal, TELEGRAM_BOT_TOKEN: 'not-a-token' }), ConfigError)
})

test('refuses to start without an allowlist unless it is explicitly opened', () => {
  assert.throws(() => loadConfig({ ...minimal, ALLOWED_USER_IDS: '' }), (error) => {
    assert.match(error.message, /ALLOWED_USER_IDS is empty/)
    return true
  })
  const open = loadConfig({ ...minimal, ALLOWED_USER_IDS: '', ALLOW_ALL_USERS: 'true' })
  assert.equal(open.access.allowAllUsers, true)
  assert.match(open.warnings.join(' '), /spend your model credits/)
})

test('parses numbers strictly and rejects junk', () => {
  assert.throws(() => loadConfig({ ...minimal, HISTORY_LIMIT: 'много' }), ConfigError)
  assert.throws(() => loadConfig({ ...minimal, POLL_TIMEOUT_SEC: '120' }), ConfigError)
  assert.throws(() => loadConfig({ ...minimal, MODEL_TEMPERATURE: '3' }), ConfigError)
  const config = loadConfig({ ...minimal, MODEL_TEMPERATURE: '0.5', MODEL_MAX_TOKENS: '1000', HISTORY_LIMIT: '0' })
  assert.equal(config.model.temperature, 0.5)
  assert.equal(config.model.maxTokens, 1000)
  assert.equal(config.history.limit, 0)
})

test('rejects an unknown chat type', () => {
  assert.throws(() => loadConfig({ ...minimal, ALLOWED_CHAT_TYPES: 'private,forum' }), ConfigError)
  const config = loadConfig({ ...minimal, ALLOWED_CHAT_TYPES: 'private' })
  assert.deepEqual([...config.access.allowedChatTypes], ['private'])
})

test('strips trailing slashes from base urls', () => {
  const config = loadConfig({ ...minimal, MODEL_BASE_URL: 'https://gateway.example/v1/', TELEGRAM_API_BASE: 'https://tg.example/' })
  assert.equal(config.model.baseUrl, 'https://gateway.example/v1')
  assert.equal(config.telegram.apiBase, 'https://tg.example')
})

test('rejects a channel chat type, which polling never delivers', () => {
  assert.throws(() => loadConfig({ ...minimal, ALLOWED_CHAT_TYPES: 'private,channel' }), ConfigError)
})

// Regression: a secret pasted into the wrong variable used to be printed
// verbatim by the entry point, bypassing the logger's redaction.
test('never echoes a value in an error message', () => {
  const secret = 'sk-super-secret-key-1234567890'
  for (const env of [
    { ...minimal, MAX_CONCURRENT_REQUESTS: secret },
    { ...minimal, MODEL_TEMPERATURE: secret },
    { ...minimal, ALLOW_ALL_USERS: secret },
    { ...minimal, ALLOWED_USER_IDS: secret },
    { ...minimal, ALLOWED_CHAT_TYPES: secret },
    { ...minimal, MODEL_BACKEND: secret },
  ]) {
    assert.throws(
      () => loadConfig(env),
      (error) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(!error.message.includes(secret), `message leaked the value: ${error.message}`)
        assert.ok(!error.message.includes('sk-'), `message leaked a key prefix: ${error.message}`)
        return true
      },
    )
  }
})

test('selects the model backend and validates what each one needs', () => {
  const openai = loadConfig(minimal)
  assert.equal(openai.model.backend, 'openai')
  assert.equal(openai.model.apiKey, 'sk-test')

  // The dsh backend runs the local CLI and needs no provider key.
  const dsh = loadConfig({ ...minimal, MODEL_API_KEY: '', MODEL_BACKEND: 'dsh', DSH_COMMAND: '/usr/local/bin/dsh' })
  assert.equal(dsh.model.backend, 'dsh')
  assert.equal(dsh.model.dsh.command, '/usr/local/bin/dsh')
  assert.equal(dsh.model.dsh.profile, 'headless')
  assert.equal(dsh.model.dsh.home, undefined)

  assert.throws(() => loadConfig({ ...minimal, MODEL_API_KEY: '', MODEL_BACKEND: 'dsh' }), (error) => {
    assert.match(error.message, /DSH_COMMAND is required/)
    return true
  })
  assert.throws(() => loadConfig({ ...minimal, MODEL_BACKEND: 'ollama' }), (error) => {
    assert.match(error.message, /MODEL_BACKEND must be one of/)
    return true
  })
  assert.throws(() => loadConfig({ ...minimal, MODEL_API_KEY: '' }), (error) => {
    assert.match(error.message, /MODEL_API_KEY is required/)
    return true
  })
})

test('reads the lifecycle and memory limits', () => {
  const config = loadConfig({ ...minimal, STARTUP_ATTEMPTS: '5', SHUTDOWN_GRACE_MS: '1000', MAX_CHATS: '42' })
  assert.equal(config.limits.startupAttempts, 5)
  assert.equal(config.limits.shutdownGraceMs, 1000)
  assert.equal(config.history.maxChats, 42)
})

// Regression: an invalid zone used to fail inside a turn, where the user only
// saw the generic "could not answer" message.
test('validates TIME_ZONE at startup and never echoes it', () => {
  assert.throws(() => loadConfig({ ...minimal, TIME_ZONE: 'Not/AZone' }), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /TIME_ZONE is not a valid IANA zone/)
    assert.ok(!error.message.includes('Not/AZone'), 'the value must not be echoed')
    return true
  })
  assert.equal(loadConfig({ ...minimal, TIME_ZONE: 'Europe/Moscow' }).time.timeZone, 'Europe/Moscow')
  assert.equal(loadConfig({ ...minimal, TIME_ZONE: 'Asia/Tokyo' }).time.timeZone, 'Asia/Tokyo')
  assert.equal(loadConfig(minimal).time.timeZone, '', 'empty means the system zone')
})

test('PLATFORM selects the adapter and defaults to Telegram', () => {
  assert.equal(loadConfig(minimal).platform.name, 'telegram')
  assert.equal(loadConfig({ ...minimal, PLATFORM: 'tg' }).platform.name, 'telegram')
  assert.equal(loadConfig({ ...minimal, PLATFORM: 'MAX' }).platform.name, 'max')
  assert.throws(() => loadConfig({ ...minimal, PLATFORM: 'viber' }), ConfigError)
})

test('a MAX-only deployment does not need a Telegram token', () => {
  // The platform has to be readable before the Telegram token is validated,
  // otherwise a MAX-only server would be forced to keep a Telegram bot.
  const config = loadConfig({ PLATFORM: 'max', MAX_TOKEN: 'max-token', MODEL_API_KEY: 'sk-test', ALLOWED_USER_IDS: '1' })
  assert.equal(config.platform.name, 'max')
  assert.equal(config.platform.maxToken, 'max-token')
  assert.ok(!config.telegram.token, 'no Telegram token is required')
  assert.equal(config.platform.maxApiBase, 'https://platform-api2.max.ru')
  // A Telegram deployment still fails loudly without one.
  assert.throws(() => loadConfig({ MODEL_API_KEY: 'sk-test' }), /TELEGRAM_BOT_TOKEN is required/)
})

test('the polling hold time follows the platform', () => {
  assert.equal(loadConfig({ ...minimal, POLL_TIMEOUT_SEC: '25' }).platform.pollTimeoutSec, 25)
  assert.equal(loadConfig({ ...minimal, PLATFORM: 'max', MAX_POLL_TIMEOUT_SEC: '45' }).platform.pollTimeoutSec, 45)
  // Out of range is refused instead of silently clamped, like every other knob.
  assert.throws(() => loadConfig({ ...minimal, PLATFORM: 'max', MAX_POLL_TIMEOUT_SEC: '999' }), ConfigError)
})

test('PLATFORM=vk-teams requires a token and builds the adapter', async () => {
  const { loadConfig } = await import('../src/config.mjs')
  const { createPlatform } = await import('../src/platforms/index.mjs')
  const base = { MODEL_API_KEY: 'k', ALLOWED_USER_IDS: '1' }
  // Without a token the platform refuses to start, like MAX does.
  await assert.rejects(
    () => createPlatform(loadConfig({ ...base, PLATFORM: 'vk-teams' }), silentLogger),
    /VK_TEAMS_TOKEN/,
  )
  const platform = await createPlatform(loadConfig({ ...base, PLATFORM: 'vk-teams', VK_TEAMS_TOKEN: 'tok' }), silentLogger)
  assert.equal(platform.name, 'vk-teams')
  assert.equal(platform.namespace, 'vk')
  for (const method of ['start', 'stop', 'getUpdates', 'sendText', 'editText', 'answerCallback', 'sendTyping']) {
    assert.equal(typeof platform[method], 'function', method)
  }
  assert.equal(loadConfig({ ...base, PLATFORM: 'vk' }).platform.name, 'vk')
  assert.equal(loadConfig({ ...base, PLATFORM: 'vk-teams' }).platform.name, 'vk-teams')
  // Telegram is the default, and it needs its own token.
  const tg = { ...base, TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789' }
  assert.equal(loadConfig({ ...tg, PLATFORM: '' }).platform.name, 'telegram')
  assert.equal(loadConfig({ ...base, PLATFORM: 'max', MAX_TOKEN: 't' }).platform.name, 'max')
})

test('each platform can extend the allow list with its own ids', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
    MODEL_API_KEY: 'k',
    ALLOWED_USER_IDS: '433296567',
    ALLOWED_USER_IDS_VK: '123456789',
  })
  assert.deepEqual([...config.access.allowedUserIds], [433296567])
  assert.deepEqual([...config.access.allowedByPlatform.vk], [123456789])
  assert.deepEqual([...config.access.allowedByPlatform.telegram], [])
})
