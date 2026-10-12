import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, loadConfig, parseUserIds, secretsOf } from '../src/config.mjs'

const base = {
  TELEGRAM_BOT_TOKEN: '123456:test-token',
  ALLOWED_USER_IDS: '433296567',
}

test('defaults match the agreed server limits', () => {
  const config = loadConfig(base)
  assert.equal(config.limits.taskTimeoutMs, 20 * 60 * 1000)
  assert.equal(config.limits.dailyTokenLimit, 2_000_000)
  assert.equal(config.dsh.bin, '/usr/local/bin/dsh')
  assert.equal(config.dsh.home, '/var/lib/agent/dsh')
  assert.equal(config.workspace.dir, '/var/lib/agent/workspace')
  assert.equal(config.workspace.stateDir, '/var/lib/agent/state')
  assert.equal(config.dsh.permissionMode, 'workspace-write')
  assert.equal(config.runtime.sessionContinuity, true)
})

test('per-task resource limits have sensible defaults', () => {
  const config = loadConfig(base)
  assert.equal(config.task.cgroup, true)
  assert.equal(config.task.memoryMaxBytes, 1500 * 1024 * 1024)
  assert.equal(config.task.cpuPercent, 150)
  assert.equal(config.task.pidsMax, 256)
  assert.equal(config.workspace.alertMb, 2048)
})

test('a task without limits is still configurable', () => {
  const config = loadConfig({ ...base, TASK_CGROUP: 'false', TASK_MEMORY_MAX_MB: '512' })
  assert.equal(config.task.cgroup, false)
  assert.equal(config.task.memoryMaxBytes, 512 * 1024 * 1024)
  assert.throws(() => loadConfig({ ...base, TASK_MEMORY_MAX_MB: '0' }), /TASK_MEMORY_MAX_MB/)
})

test('image input is on by default and takes the model key', () => {
  const config = loadConfig({ ...base, MODEL_API_KEY: 'sk-model' })
  assert.equal(config.vision.enabled, true)
  assert.equal(config.vision.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(config.vision.model, 'deepseek-chat')
  assert.equal(config.vision.apiKey, 'sk-model', 'the model key is the default')
  assert.equal(config.vision.maxImageBytes, 8_000_000)
  assert.equal(config.ocr.enabled, true)
  assert.equal(config.ocr.languages, 'rus+eng')
  assert.deepEqual(secretsOf(config), ['123456:test-token', 'sk-model'])
})

test('a separate vision key wins over the model key', () => {
  const config = loadConfig({ ...base, MODEL_API_KEY: 'sk-model', VISION_API_KEY: 'sk-vision' })
  assert.equal(config.vision.apiKey, 'sk-vision')
  assert.equal(secretsOf(config).includes('sk-vision'), true)
})

test('vision and OCR can be switched off', () => {
  const config = loadConfig({ ...base, VISION: 'false', OCR: 'false' })
  assert.equal(config.vision.enabled, false)
  assert.equal(config.ocr.enabled, false)
})

test('the bot refuses to start without a token', () => {
  assert.throws(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '' }), ConfigError)
  assert.throws(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 'no-colon' }), ConfigError)
})

test('the bot refuses to start when nobody is allowed', () => {
  assert.throws(() => loadConfig({ ...base, ALLOWED_USER_IDS: '' }), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /ALLOWED_USER_IDS/)
    return true
  })
})

test('ALLOW_ALL_USERS=true lifts the requirement for an id list', () => {
  const config = loadConfig({ ...base, ALLOWED_USER_IDS: '', ALLOW_ALL_USERS: 'true' })
  assert.equal(config.telegram.allowAllUsers, true)
})

test('user ids are parsed from commas and whitespace', () => {
  assert.deepEqual([...parseUserIds('1, 2  3,\n4')], ['1', '2', '3', '4'])
  const config = loadConfig({ ...base, ALLOWED_USER_IDS: '1, 2' })
  assert.equal(config.telegram.allowedUserIds.has('2'), true)
  assert.equal(config.telegram.allowedUserIds.has('3'), false)
})

test('numeric limits are validated instead of silently coerced', () => {
  assert.throws(() => loadConfig({ ...base, TASK_TIMEOUT_MS: 'скоро' }), /TASK_TIMEOUT_MS/)
  assert.throws(() => loadConfig({ ...base, DAILY_TOKEN_LIMIT: '-1' }), /DAILY_TOKEN_LIMIT/)
  assert.throws(() => loadConfig({ ...base, MAX_OUTPUT_FILES: '0' }), /MAX_OUTPUT_FILES/)
  const config = loadConfig({ ...base, DAILY_TOKEN_LIMIT: '0' })
  assert.equal(config.limits.dailyTokenLimit, 0, '0 disables the budget')
})

test('paths must be absolute', () => {
  assert.throws(() => loadConfig({ ...base, DSH_HOME: 'relative/path' }), /DSH_HOME/)
  assert.throws(() => loadConfig({ ...base, WORKSPACE_DIR: './ws' }), /WORKSPACE_DIR/)
})

test('error messages never echo the rejected value', () => {
  const secret = 'super-secret-value'
  try {
    loadConfig({ ...base, TASK_TIMEOUT_MS: secret })
    assert.fail('должно было упасть')
  } catch (error) {
    assert.equal(error.message.includes(secret), false)
    assert.match(error.message, /длиной \d+/)
  }
})

test('secretsOf collects exactly the secrets to redact', () => {
  const config = loadConfig({ ...base, MODEL_API_KEY: 'sk-abc' })
  assert.deepEqual(secretsOf(config), ['123456:test-token', 'sk-abc'])
})
