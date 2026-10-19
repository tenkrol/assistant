/**
 * PLB-026: внешний сторож бота.
 *
 * Сервер не нужен: `systemctl` и HTTP подставные, состояние — во временном
 * каталоге. Проверяется то, что важно в проде: активность сервиса, 401 от
 * панели, алерт не чаще раза в час и одно сообщение о восстановлении.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ALERT_INTERVAL_MS,
  createNotifier,
  resolveHealthUrl,
  runWatchdog,
} from '../tools/watchdog-service.mjs'

/** Временный каталог и файл состояния. */
async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-watchdog-'))
  return {
    dir,
    stateFile: path.join(dir, 'watchdog-service.json'),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

/** Подставной `systemctl` и `agent-notify`. */
function fakeExec({ active = true, notifyCode = 0, calls = [] } = {}) {
  return async (command, args) => {
    calls.push({ command, args })
    if (command === 'systemctl' && args[0] === 'is-active') {
      return { code: 0, stdout: `${active ? 'active' : 'inactive'}\n`, stderr: '' }
    }
    if (command === 'agent-notify') return { code: notifyCode, stdout: '', stderr: '' }
    return { code: 127, stdout: '', stderr: 'not found' }
  }
}

/** Подставной HTTP: только статус. */
function fakeFetch(status) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options })
    return { status, ok: status >= 200 && status < 300, json: async () => ({ ok: true }) }
  }
  impl.calls = calls
  return impl
}

const silent = { info() {}, warn() {}, error() {} }
const NOW = Date.now()
const env = { DATA_DIR: '/tmp/watchdog-data' }

test('живой сервис и 401 от панели — тревоги нет', async () => {
  const ctx = await sandbox()
  try {
    const sent = []
    const result = await runWatchdog({
      env,
      exec: fakeExec({ active: true }),
      fetchImpl: fakeFetch(401),
      stateFile: ctx.stateFile,
      now: () => NOW,
      notify: async (message) => { sent.push(message); return { ok: true } },
      logger: silent,
    })
    assert.equal(result.ok, true)
    assert.equal(result.alerted, false)
    assert.equal(sent.length, 0)
    assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [['systemctl', true], ['http', true]])

    const state = JSON.parse(await fs.readFile(ctx.stateFile, 'utf8'))
    assert.equal(state.alertedDown, false)
    assert.equal(state.consecutiveFailures, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('404 или 500 от панели считается недоступностью', async () => {
  const ctx = await sandbox()
  try {
    const result = await runWatchdog({
      env,
      exec: fakeExec({ active: true }),
      fetchImpl: fakeFetch(500),
      stateFile: ctx.stateFile,
      now: () => NOW,
      notify: async () => ({ ok: true }),
      logger: silent,
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /http/)
  } finally {
    await ctx.cleanup()
  }
})

test('алерт не чаще раза в час, но следующий час снова напоминает', async () => {
  const ctx = await sandbox()
  try {
    const sent = []
    const run = (at) => runWatchdog({
      env,
      exec: fakeExec({ active: false }),
      fetchImpl: fakeFetch(500),
      stateFile: ctx.stateFile,
      now: () => at,
      notify: async (message) => { sent.push({ at, ...message }); return { ok: true } },
      logger: silent,
    })

    const first = await run(NOW)
    assert.equal(first.ok, false)
    assert.equal(first.alerted, true)
    assert.equal(sent.length, 1)

    // Через полчаса бот всё ещё лежит: тревога уже была, второй не шлём.
    const second = await run(NOW + 30 * 60 * 1000)
    assert.equal(second.alerted, false)
    assert.equal(sent.length, 1)

    // Через час с лишним — снова алерт.
    const third = await run(NOW + ALERT_INTERVAL_MS + 1000)
    assert.equal(third.alerted, true)
    assert.equal(sent.length, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('после тревоги приходит одно сообщение «снова в порядке»', async () => {
  const ctx = await sandbox()
  try {
    const sent = []
    const notify = async (message) => { sent.push(message); return { ok: true } }
    const down = await runWatchdog({
      env,
      exec: fakeExec({ active: false }),
      fetchImpl: fakeFetch(500),
      stateFile: ctx.stateFile,
      now: () => NOW,
      notify,
      logger: silent,
    })
    assert.equal(down.alerted, true)

    const up = await runWatchdog({
      env,
      exec: fakeExec({ active: true }),
      fetchImpl: fakeFetch(401),
      stateFile: ctx.stateFile,
      now: () => NOW + 10 * 60 * 1000,
      notify,
      logger: silent,
    })
    assert.equal(up.recovered, true)
    assert.equal(up.alerted, false)
    assert.equal(sent.length, 2)
    assert.match(sent[1].title, /снова в порядке/)

    const again = await runWatchdog({
      env,
      exec: fakeExec({ active: true }),
      fetchImpl: fakeFetch(401),
      stateFile: ctx.stateFile,
      now: () => NOW + 20 * 60 * 1000,
      notify,
      logger: silent,
    })
    assert.equal(again.recovered, false)
    assert.equal(sent.length, 2, 'восстановление не повторяется')
  } finally {
    await ctx.cleanup()
  }
})

test('без agent-notify алерт уходит напрямую в Telegram', async () => {
  const messages = []
  const fetchImpl = async (url, options) => {
    messages.push({ url, body: String(options.body) })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const notify = createNotifier({
    exec: fakeExec({ notifyCode: 127 }),
    env: { TELEGRAM_BOT_TOKEN: '123456:supersecret', ALLOWED_USER_IDS: '433296567' },
    fetchImpl,
    logger: silent,
  })
  const result = await notify({ title: 'tg-agent: бот недоступен', text: 'проверьте сервис' })
  assert.equal(result.ok, true)
  assert.equal(result.channel, 'telegram')
  assert.equal(messages.length, 1)
  assert.match(messages[0].url, /\/bot123456:supersecret\/sendMessage$/)
  assert.match(messages[0].body, /chat_id=433296567/)
  assert.match(messages[0].body, /%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80/)
})

test('URL проверки берётся из настроек панели или задаётся явно', () => {
  assert.equal(resolveHealthUrl({ MINIAPP_PORT: '9000' }), 'http://127.0.0.1:9000/api/reminders')
  assert.equal(resolveHealthUrl({ MINIAPP_HOST: '0.0.0.0', MINIAPP_PORT: '9000' }), 'http://127.0.0.1:9000/api/reminders')
  assert.equal(resolveHealthUrl({ WATCHDOG_HEALTH_URL: 'https://tenkrol.ru/api/reminders' }), 'https://tenkrol.ru/api/reminders')
})
