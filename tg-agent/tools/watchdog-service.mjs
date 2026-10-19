/**
 * Внешний сторож бота на сервере: systemd-таймер + этот скрипт.
 *
 * Зачем отдельный сторож: если упал сам бот или его HTTP-панель, сообщить об
 * этом изнутри процесса невозможно. Проверки простые и не зависят от бота:
 *   1. `systemctl is-active <service>` — процесс активен;
 *   2. `GET /api/reminders` — 401 без входа означает «HTTP жив» (панель
 *      отвечает и требует авторизацию), 2xx/3xx тоже считаем живыми.
 *
 * Алерт уходит владельцу через `agent-notify`, если он есть на машине, иначе
 * напрямую в Telegram. Повторный алерт — не чаще раза в час; отметка хранится
 * в `DATA_DIR/watchdog-service.json`, чтобы перезапуск таймера не спамил.
 *
 * Использование:
 *   node tools/watchdog-service.mjs            # проверить и при сбое уведомить
 *   node tools/watchdog-service.mjs --status   # только показать проверки
 *
 * Код выхода: 0 — всё в порядке (или алерт уже отправлен), 1 — бот недоступен.
 * Юнит объявляет `SuccessExitStatus=0 1`: недоступность не красит таймер.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Проект: рядом лежат `data/` и `.env`. */
const projectDir = path.resolve(import.meta.dirname, '..')

/** Повторный алерт не чаще раза в час. */
export const ALERT_INTERVAL_MS = 60 * 60 * 1000
/** Версия файла состояния сторожа. */
const STATE_VERSION = 1
/** Таймауты по умолчанию. */
const COMMAND_TIMEOUT_MS = 15_000
const HTTP_TIMEOUT_MS = 5_000

/** Пустой файл состояния: ни одного алерта, сбоев нет. */
function emptyState() {
  return {
    version: STATE_VERSION,
    lastAlertAt: 0,
    lastAlertKey: '',
    alertedDown: false,
    consecutiveFailures: 0,
    lastOkAt: 0,
  }
}

/** Прочитать состояние; битый файл не мешает проверке. */
async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    return {
      ...emptyState(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      version: STATE_VERSION,
    }
  } catch {
    return emptyState()
  }
}

/** Записать состояние атомарно: временный файл рядом и rename. */
async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}

/** Обёртка над execFile: не бросает, а возвращает код и вывод. */
function createExec() {
  return (command, args = [], options = {}) => new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      let code = 0
      if (error) {
        if (error.code === 'ENOENT') code = 127
        else if (error.killed || error.code === 'ETIMEDOUT') code = 124
        else if (typeof error.code === 'number') code = error.code
        else code = 1
      }
      resolve({
        code,
        stdout: stdout ?? '',
        stderr: stderr ?? (error?.message ?? ''),
      })
    })
  })
}

/**
 * Адрес HTTP-проверки.
 *
 * В юните порт и хост те же, что у мини-приложения; явный
 * `WATCHDOG_HEALTH_URL` побеждает (например, публичный HTTPS-адрес).
 *
 * @param {object} env - переменные окружения.
 * @returns {string} URL панели.
 */
export function resolveHealthUrl(env = {}) {
  const explicit = String(env.WATCHDOG_HEALTH_URL ?? '').trim()
  if (explicit !== '') return explicit
  const port = Number(env.MINIAPP_PORT) > 0 ? Number(env.MINIAPP_PORT) : 8787
  const rawHost = String(env.MINIAPP_HOST ?? '').trim()
  const host = rawHost === '' || rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
  return `http://${host}:${port}/api/reminders`
}

/** Проверка `systemctl is-active`. */
export async function checkService({ exec, service }) {
  try {
    const result = await exec('systemctl', ['is-active', service])
    const active = String(result?.stdout ?? '').trim()
    return {
      name: 'systemctl',
      ok: active === 'active',
      detail: active || `код ${result?.code ?? '—'}`,
    }
  } catch (error) {
    return { name: 'systemctl', ok: false, detail: error?.message ?? String(error) }
  }
}

/** Проверка HTTP: 401 — нормальный ответ живой панели без входа. */
export async function checkHttp({ fetchImpl, url, timeoutMs = HTTP_TIMEOUT_MS }) {
  if (!url) return { name: 'http', ok: true, skipped: true, detail: 'URL не задан' }
  if (typeof fetchImpl !== 'function') {
    return { name: 'http', ok: false, detail: 'fetch недоступен' }
  }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = Number(response?.status)
    // 401 — панель жива и просит вход; 2xx/3xx — тоже ответ, а не отказ.
    const ok = status === 401 || (status >= 200 && status < 400)
    return { name: 'http', ok, detail: `HTTP ${Number.isFinite(status) ? status : '—'}` }
  } catch (error) {
    return { name: 'http', ok: false, detail: String(error?.message ?? error).slice(0, 160) }
  }
}

/** Все проверки одним списком. */
export function describeChecks(checks = []) {
  return checks
    .map((check) => `${check.name}: ${check.skipped ? 'пропущено' : check.ok ? 'ок' : 'сбой'}${check.detail ? ` (${check.detail})` : ''}`)
    .join('\n')
}

/** Владелец: явный ALERT_CHAT_ID или первый из ALLOWED_USER_IDS. */
function resolveChatId(env) {
  if (env.ALERT_CHAT_ID) return String(env.ALERT_CHAT_ID)
  return String(env.ALLOWED_USER_IDS ?? '').split(/[,\s]+/).filter(Boolean)[0]
}

/** Убрать токен из любого текста ошибки. */
function redact(text, secrets = []) {
  return secrets
    .filter(Boolean)
    .reduce((result, secret) => String(result).split(String(secret)).join('[redacted]'), String(text))
}

/**
 * Отправка владельцу: сначала `agent-notify`, иначе Telegram Bot API.
 *
 * `agent-notify` живёт на сервере агента и умеет доставлять текст через
 * outbox; на сервере бота его может не быть — тогда прямой вызов Bot API.
 *
 * @returns {Promise<{ok: boolean, channel: string, error?: string}>}
 */
export function createNotifier({ exec, env = {}, fetchImpl = globalThis.fetch, logger } = {}) {
  return async ({ title, text }) => {
    if (typeof exec === 'function') {
      try {
        const result = await exec('agent-notify', ['--title', title, text], { timeoutMs: COMMAND_TIMEOUT_MS })
        if (result?.code === 0) return { ok: true, channel: 'agent-notify' }
        // 127 — команды нет, это штатный путь к Telegram.
        if (result?.code !== 127) {
          logger?.warn?.('agent-notify failed', { code: result?.code, error: String(result?.stderr ?? '').slice(0, 160) })
        }
      } catch (error) {
        logger?.warn?.('agent-notify unavailable', { error: String(error?.message ?? error) })
      }
    }

    const token = env.TELEGRAM_BOT_TOKEN
    const chatId = resolveChatId(env)
    if (!token || !chatId || typeof fetchImpl !== 'function') {
      return { ok: false, channel: 'none', error: 'нет agent-notify и не настроен Telegram' }
    }
    const apiBase = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')
    const timeoutMs = Number(env.TELEGRAM_TIMEOUT_MS) > 0 ? Number(env.TELEGRAM_TIMEOUT_MS) : COMMAND_TIMEOUT_MS
    try {
      const response = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
        method: 'POST',
        body: new URLSearchParams({ chat_id: String(chatId), text, disable_web_page_preview: 'true' }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        return { ok: false, channel: 'telegram', error: redact(payload?.description ?? `HTTP ${response.status}`, [token]) }
      }
      return { ok: true, channel: 'telegram' }
    } catch (error) {
      return { ok: false, channel: 'telegram', error: redact(error?.message ?? String(error), [token]) }
    }
  }
}

/**
 * Один прогон сторожа.
 *
 * @param {object} [options] - `env`, `exec`, `fetchImpl`, `notify`, `now`,
 *   `stateFile`, `service`, `healthUrl`, `alertIntervalMs`, `writeState`.
 * @returns {Promise<object>} `{ok, checks, alerted, recovered, reason, state}`.
 */
export async function runWatchdog(options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  const exec = options.exec ?? createExec()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const logger = options.logger
  const service = options.service ?? env.WATCHDOG_SERVICE ?? env.SERVICE ?? 'tg-agent'
  const healthUrl = options.healthUrl ?? resolveHealthUrl(env)
  const alertIntervalMs = Number(options.alertIntervalMs) > 0 ? Number(options.alertIntervalMs) : ALERT_INTERVAL_MS
  const stateFile = options.stateFile ?? path.join(env.DATA_DIR || path.join(projectDir, 'data'), 'watchdog-service.json')
  const at = Number(now())
  const state = await readState(stateFile)

  const checks = [
    await checkService({ exec, service }),
    await checkHttp({ fetchImpl, url: healthUrl }),
  ]
  const failed = checks.filter((check) => check.ok === false)
  const reason = failed.map((check) => `${check.name}: ${check.detail}`).join('; ')

  let alerted = false
  let recovered = false
  if (failed.length > 0) {
    state.consecutiveFailures = (Number(state.consecutiveFailures) || 0) + 1
    const canAlert = !state.lastAlertAt || at - Number(state.lastAlertAt) >= alertIntervalMs
    if (canAlert) {
      const notify = options.notify ?? createNotifier({ exec, env, fetchImpl, logger })
      const text = [
        `🚨 ${service}: бот недоступен`,
        '',
        reason,
        '',
        `проверки:\n${describeChecks(checks)}`,
        '',
        `проверьте: systemctl status ${service}; journalctl -u ${service} -n 50 --no-pager`,
      ].join('\n')
      let delivered = { ok: false, error: 'notify не вернул результат' }
      try {
        delivered = await notify({ title: `${service}: бот недоступен`, text })
      } catch (error) {
        logger?.warn?.('watchdog alert failed', { error: String(error?.message ?? error) })
      }
      if (!delivered?.ok) logger?.warn?.('watchdog alert not delivered', { error: delivered?.error })
      state.lastAlertAt = at
      state.lastAlertKey = reason
      state.alertedDown = true
      alerted = true
    }
  } else {
    state.consecutiveFailures = 0
    state.lastOkAt = at
    if (state.alertedDown) {
      const notify = options.notify ?? createNotifier({ exec, env, fetchImpl, logger })
      try {
        await notify({
          title: `${service}: снова в порядке`,
          text: `✅ ${service}: бот снова отвечает.\n\n${describeChecks(checks)}`,
        })
      } catch (error) {
        logger?.warn?.('watchdog recovery failed', { error: String(error?.message ?? error) })
      }
      recovered = true
    }
    state.alertedDown = false
  }

  if (options.writeState !== false) await writeState(stateFile, state)
  return { ok: failed.length === 0, checks, alerted, recovered, reason, state, stateFile }
}

/** Разобрать аргументы: сейчас поддерживается только `--status`. */
export function parseArgs(argv = []) {
  return { status: argv.includes('--status'), help: argv.includes('--help') || argv.includes('-h') }
}

/** CLI: проверка без уведомления для `--status`, иначе обычный прогон. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Использование: node tools/watchdog-service.mjs [--status]')
    return 0
  }
  const result = await runWatchdog({
    env: process.env,
    ...(options.status
      ? { writeState: false, notify: async () => ({ ok: false, channel: 'status' }) }
      : {}),
  })
  console.log(`${result.ok ? '✅' : '🚨'} состояние сторожа`)
  console.log(describeChecks(result.checks))
  if (result.reason) console.log(`причина: ${result.reason}`)
  if (result.alerted) console.log('алерт отправлен (или попытка учтена)')
  if (result.recovered) console.log('отправлено «снова в порядке»')
  return result.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (invokedDirectly) {
  process.exitCode = await main()
}
