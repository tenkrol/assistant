/**
 * External watchdog for the tg-agent bot.
 *
 * The bot itself runs on a remote VPS under systemd, so the checks are made from
 * the machine where "outside" means "not the server": if Telegram is unreachable
 * from the VPS, an alert sent from there would never arrive. This script runs on
 * the owner's Mac (or any cron host) and reports to the owner in Telegram.
 *
 * Usage:
 *   node tools/watchdog.mjs            # run every check once, alert if needed
 *   node tools/watchdog.mjs --status   # print the facts, send nothing
 *   node tools/watchdog.mjs --quiet    # silent on success (for launchd)
 *   node tools/watchdog.mjs --test     # send a test message and exit
 *
 * Checks (each one is a fact with a verdict of ok, fail or skip):
 *   1. Telegram answers `getMe` from this machine (the token from `.env`).
 *   2. `systemctl is-active tg-agent` over SSH is `active`.
 *   3. The newest journal line is younger than STALE_MINUTES; skipped when
 *      HEARTBEAT_MINUTES=0, because then silence in the log is expected.
 *   4. No `polling failed` / `Conflict` / `ERROR` lines in the last
 *      ERROR_WINDOW_MINUTES (`offset save failed` is a known harmless one).
 *   5. Exactly one `src/index.mjs` process on the server.
 *
 * Exit code: 0 when nothing failed, 1 when at least one check failed. A broken
 * SSH connection is a failed check, never a crash.
 *
 * Anti-spam: alerts are throttled through `data/watchdog.json`. A message goes
 * out when the set of failing checks changes or when ALERT_REPEAT_MINUTES have
 * passed since the previous alert; when everything recovers after an alert, a
 * single "back to normal" message is sent.
 *
 * The token is never printed: every outgoing text and every reported error is
 * scrubbed of it.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Project root; `.env` and `.ssh/` live next to `package.json`. */
const projectDir = path.resolve(import.meta.dirname, '..')

/**
 * Services to watch, taken from `tools/watchdog.services` when that file exists.
 *
 * Keeping the list in the project means adding a platform (VK, MAX, VK Teams) is a
 * one-line change here instead of editing the installed launchd plist, which the
 * sandbox does not always allow.
 *
 * @returns {string} comma-separated service names, or an empty string.
 */
function readServiceList() {
  try {
    return fs.readFileSync(new URL('./watchdog.services', import.meta.url), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
      .join(',')
  } catch {
    return ''
  }
}

const DEFAULTS = {
  SERVER: 'root@185.174.136.53',
  SERVICE: 'tg-agent',
  STALE_MINUTES: 95,
  ERROR_WINDOW_MINUTES: 20,
  ALERT_REPEAT_MINUTES: 180,
  DISK_PERCENT: 90,
  SSH_TIMEOUT_MS: 20_000,
  HTTP_TIMEOUT_MS: 15_000,
}

/** `data/watchdog.json` shape written by this script. */
const STATE_VERSION = 1

/** Known harmless journal lines that must not raise an alert. */
const IGNORED_ERRORS = [/offset save failed/i]

/** Recognise "journalctl found nothing" as an empty window, not as a failure. */
const NO_ENTRIES_RE = /no entries|no journal files/i

const TEST_MESSAGE = [
  '🔔 tg-agent: тестовое сообщение сторожа',
  '',
  'Сторож на Mac запущен и умеет отправлять алерты.',
].join('\n')

const RECOVERY_MESSAGE = [
  '✅ tg-agent: бот снова в порядке',
  '',
  'Все проверки сторожа прошли.',
].join('\n')

/**
 * Load `KEY=VALUE` lines from a file into `process.env`.
 *
 * Uses `process.loadEnvFile` when the Node version provides it (20.12+) and a
 * small parser otherwise. Variables already present in the environment win, and
 * a missing file is not an error: the process may be configured entirely
 * through the real environment.
 *
 * @param {string} file - path to the env file.
 * @returns {boolean} whether a file was read.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file)
      return true
    } catch {
      // Fall through to the parser below so a stray line cannot abort a check.
    }
  }
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return true
}

/** Replace every secret occurrence with `[redacted]`. */
function redact(text, secrets) {
  return secrets
    .filter(Boolean)
    .reduce((acc, secret) => String(acc).split(String(secret)).join('[redacted]'), text)
}

/** A non-negative number of minutes from the environment, or the default. */
function readMinutes(env, key, fallback) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${key} должен быть числом >= 0, беру ${fallback}`)
    return fallback
  }
  return value
}

/** A positive number of milliseconds from the environment, or the default. */
function readMs(env, key, fallback) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${key} должен быть положительным числом, беру ${fallback}`)
    return fallback
  }
  return value
}

/**
 * Split SSH_OPTS into arguments, honouring simple single and double quotes.
 *
 * @param {string} raw - for example `-o ConnectTimeout=3 -J jump`.
 * @returns {string[]} arguments.
 */
function splitArgs(raw) {
  const args = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3])
  }
  return args
}

/** Everything the checks and the alerting need, read from the environment. */
function buildConfig(env) {
  const stateRaw = env.WATCHDOG_STATE || path.join('data', 'watchdog.json')
  const staleMinutes = readMinutes(env, 'STALE_MINUTES', DEFAULTS.STALE_MINUTES)
  return {
    server: env.SERVER || DEFAULTS.SERVER,
    key: env.KEY || path.join(projectDir, '.ssh', 'tg-agent-deploy'),
    sshOpts: splitArgs(env.SSH_OPTS || ''),
    // One or more unit names: a two-platform deployment runs both services.
    services: String(env.SERVICES || env.SERVICE || readServiceList() || DEFAULTS.SERVICE).split(',').map((value) => value.trim()).filter(Boolean),
    service: String(env.SERVICES || env.SERVICE || readServiceList() || DEFAULTS.SERVICE).split(',')[0].trim(),
    staleMs: staleMinutes * 60_000,
    staleMinutes,
    errorWindowMinutes: readMinutes(env, 'ERROR_WINDOW_MINUTES', DEFAULTS.ERROR_WINDOW_MINUTES),
    diskPercent: Number(env.DISK_PERCENT) || DEFAULTS.DISK_PERCENT,
    alertRepeatMs: readMinutes(env, 'ALERT_REPEAT_MINUTES', DEFAULTS.ALERT_REPEAT_MINUTES) * 60_000,
    sshTimeoutMs: readMs(env, 'SSH_TIMEOUT_MS', DEFAULTS.SSH_TIMEOUT_MS),
    httpTimeoutMs: readMs(env, 'HTTP_TIMEOUT_MS', DEFAULTS.HTTP_TIMEOUT_MS),
    heartbeatMinutes: readMinutes(env, 'HEARTBEAT_MINUTES', 0),
    stateFile: path.isAbsolute(stateRaw) ? stateRaw : path.resolve(projectDir, stateRaw),
    apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: resolveChatId(env),
  }
}

/** The owner: an explicit WATCHDOG_CHAT_ID or the first allowed user id. */
function resolveChatId(env) {
  if (env.WATCHDOG_CHAT_ID) return env.WATCHDOG_CHAT_ID
  return String(env.ALLOWED_USER_IDS ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)[0]
}

/** One check result. `verdict` is `ok`, `fail` or `skip`. */
const fact = (id, title, verdict, detail) => ({ id, title, verdict, detail })

/** First non-empty stderr line that is not an OpenSSH warning. */
function firstUsefulLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^warning:/i.test(line))
}

/** Turn an ssh child-process failure into a short, safe reason. */
function describeSshError(result, config) {
  if (result.error?.code === 'ENOENT') return 'ssh не найден в PATH'
  if (result.error?.killed || result.error?.signal) {
    return `ssh не ответил за ${Math.round(config.sshTimeoutMs / 1000)} с (${config.server})`
  }
  const line = firstUsefulLine(result.stderr)
  if (line) return /^ssh\b/i.test(line) ? line : `ssh: ${line}`
  if (result.error?.code === 255) return `ssh: не удалось подключиться к ${config.server}`
  return `ssh: ${result.error?.message ?? 'неизвестная ошибка'}`
}

/**
 * Run one command on the server over SSH.
 *
 * Never rejects: a timeout, a non-zero exit or a missing binary all come back as
 * `ok: false` with whatever output was produced, so a check can degrade into a
 * `fail` instead of crashing the watchdog.
 *
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error?: Error}>}
 */
function runSsh(config, command) {
  const args = [
    '-i', config.key,
    '-o', 'BatchMode=yes',
    // No TTY under launchd: accept a new host key instead of hanging on a prompt.
    '-o', 'StrictHostKeyChecking=accept-new',
    ...config.sshOpts,
    config.server,
    command,
  ]
  return new Promise((resolve) => {
    execFile('ssh', args, { timeout: config.sshTimeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '', error: error ?? undefined })
    })
  })
}

/** Check 1: Telegram is reachable from this machine and the token is valid. */
async function checkTelegram(config) {
  const title = 'Telegram доступен'
  if (!config.token) return fact('telegram', title, 'fail', 'не задан TELEGRAM_BOT_TOKEN')
  try {
    const response = await fetch(`${config.apiBase}/bot${config.token}/getMe`, {
      signal: AbortSignal.timeout(config.httpTimeoutMs),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.ok !== true) {
      const reason = body?.description || `HTTP ${response.status}`
      return fact('telegram', title, 'fail', `getMe: ${redact(reason, [config.token])}`)
    }
    const bot = body.result ?? {}
    return fact('telegram', title, 'ok', `getMe: @${bot.username ?? '—'} (id ${bot.id ?? '—'})`)
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'тайм-аут' : error?.message
    return fact('telegram', title, 'fail', `getMe не удался: ${redact(reason, [config.token])}`)
  }
}

/** Check 2: the systemd unit is active. */
async function checkService(config) {
  const title = 'Сервисы активны'
  const result = await runSsh(config, `systemctl is-active ${config.services.join(' ')}`)
  const states = result.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)
  const broken = config.services.filter((_, index) => states[index] !== 'active')
  if (broken.length === 0 && states.length >= config.services.length) {
    return fact('service', title, 'ok', `${config.services.join(', ')}: active`)
  }
  if (states.length === 0) return fact('service', title, 'fail', describeSshError(result, config))
  return fact('service', title, 'fail', `неактивны: ${broken.join(', ') || states.join(', ')}`)
}

/** Check 3: the newest journal line is fresh enough to prove the bot is alive. */
async function checkFreshness(config) {
  const title = 'Журнал свежий'
  if (config.heartbeatMinutes === 0) {
    return fact('freshness', title, 'skip', 'HEARTBEAT_MINUTES=0 — heartbeat выключен, проверка неприменима')
  }
  const result = await runSsh(config, `journalctl ${config.services.map((s) => `-u ${s}`).join(' ')} -n 1 --no-pager -o json`)
  const last = result.stdout.trim().split('\n').filter(Boolean).pop()
  if (!last) {
    if (result.ok || NO_ENTRIES_RE.test(result.stderr)) {
      return fact('freshness', title, 'fail', 'в журнале нет ни одной записи')
    }
    return fact('freshness', title, 'fail', describeSshError(result, config))
  }
  let timestamp
  try {
    timestamp = Number(JSON.parse(last).__REALTIME_TIMESTAMP) / 1000
  } catch {
    timestamp = Number.NaN
  }
  if (!Number.isFinite(timestamp)) {
    return fact('freshness', title, 'fail', 'не удалось разобрать время последней записи журнала')
  }
  const ageMs = Date.now() - timestamp
  const ageMinutes = Math.max(0, Math.round(ageMs / 60_000))
  if (ageMs > config.staleMs) {
    return fact('freshness', title, 'fail', `последняя запись ${ageMinutes} мин назад (порог ${config.staleMinutes} мин)`)
  }
  return fact('freshness', title, 'ok', `последняя запись ${ageMinutes} мин назад (порог ${config.staleMinutes} мин)`)
}

/** Check 4: no suspicious lines in the recent journal window. */
async function checkErrors(config) {
  const title = 'Ошибок опроса нет'
  const window = config.errorWindowMinutes
  const result = await runSsh(config, `journalctl ${config.services.map((s) => `-u ${s}`).join(' ')} --since "-${window}min" --no-pager -o cat`)
  const output = result.stdout.trim()
  if (!output) {
    if (result.ok || NO_ENTRIES_RE.test(result.stderr)) {
      return fact('errors', title, 'ok', `за ${window} мин подозрительных строк нет`)
    }
    return fact('errors', title, 'fail', describeSshError(result, config))
  }
  const suspicious = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !IGNORED_ERRORS.some((re) => re.test(line)))
    .filter((line) => /polling failed/i.test(line) || /Conflict/.test(line) || /\bERROR\b/.test(line))
  if (suspicious.length === 0) {
    return fact('errors', title, 'ok', `за ${window} мин подозрительных строк нет`)
  }
  const sample = suspicious[0].replace(/\s+/g, ' ').slice(0, 140)
  return fact('errors', title, 'fail', `за ${window} мин найдено ${suspicious.length} строк: ${sample}`)
}

/** Check 5: exactly one poller, so Telegram cannot answer with `Conflict`. */
async function checkInstances(config) {
  const title = 'Один экземпляр'
  // `[s]rc` keeps pgrep from matching the remote shell that carries this very
  // command line: the literal `src/index.mjs` would otherwise be counted too.
  const result = await runSsh(config, 'pgrep -fc "[s]rc/index.mjs" || true')
  const raw = result.stdout.trim()
  const count = Number(raw)
  if (!raw) return fact('instances', title, 'fail', describeSshError(result, config))
  if (!Number.isInteger(count)) return fact('instances', title, 'fail', `pgrep вернул неожиданное значение: ${raw}`)
  const expected = config.services.length
  if (count === expected) {
    return fact('instances', title, 'ok', `на сервере ${count} процесс(ов) src/index.mjs — по одному на сервис`)
  }
  return fact('instances', title, 'fail', `процессов src/index.mjs: ${count}, а сервисов ${expected} — у каждой платформы должен быть ровно один поллер`)
}

/**
 * Check 6: free space on the server.
 *
 * The state files live on the same small volume as everything else. A full disk
 * silently stops the bot from saving history and reminders — it happened once,
 * and the offset file came out truncated to zero bytes.
 */
async function checkDisk(config) {
  const title = 'Место на диске'
  const result = await runSsh(config, "df -P / | awk 'NR==2 {print $5}'")
  const raw = result.stdout.trim().replace('%', '')
  const used = Number(raw)
  if (!raw || !Number.isFinite(used)) return fact('disk', title, 'fail', describeSshError(result, config))
  if (used < config.diskPercent) return fact('disk', title, 'ok', `занято ${used}% (порог ${config.diskPercent}%)`)
  return fact('disk', title, 'fail', `занято ${used}% — мало места: apt-get clean; journalctl --vacuum-size=100M`)
}

/** Run every check; SSH checks go in parallel because each one opens a session. */
async function collectFacts(config) {
  const [telegram, service, freshness, errors, instances, disk] = await Promise.all([
    checkTelegram(config),
    checkService(config),
    checkFreshness(config),
    checkErrors(config),
    checkInstances(config),
    checkDisk(config),
  ])
  return [telegram, service, freshness, errors, instances, disk]
}

const MARK = { ok: '✅', fail: '❌', skip: '⏭️' }

/** Local `YYYY-MM-DD HH:MM:SS`, matching the other tools' listings. */
function formatNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Print the facts and a one-line verdict. */
function printFacts(facts) {
  const failing = facts.filter((item) => item.verdict === 'fail').length
  console.log(`сторож tg-agent · ${formatNow()}`)
  for (const item of facts) {
    console.log(`  ${MARK[item.verdict]} ${item.id}: ${item.title} — ${item.detail}`)
  }
  console.log(failing === 0
    ? `итог: всё в порядке (проверок: ${facts.length})`
    : `итог: проблем — ${failing} из ${facts.length}`)
}

/** Per-check hint lines for the alert. */
function hintsFor(item, config) {
  const ssh = (command) => `  ssh ${config.server} '${command}'`
  switch (item.id) {
    case 'telegram':
      return ['  проверьте на Mac доступ к api.telegram.org (VPN/прокси) и токен в .env']
    case 'service':
      return [ssh(`systemctl status ${config.service}`), ssh(`systemctl restart ${config.service}`)]
    case 'freshness':
    case 'errors':
      return [ssh(`journalctl -u ${config.service} -n 50 --no-pager`)]
    case 'instances':
      return [ssh('pgrep -af index.mjs'), ssh(`systemctl restart ${config.service}`)]
    default:
      return []
  }
}

/** Short Telegram alert: the problems, then the commands that explain them. */
function buildAlert(facts, config) {
  const problems = facts.filter((item) => item.verdict === 'fail')
  const lines = [`🚨 tg-agent: проблемы (${problems.length})`, '']
  for (const item of problems) {
    lines.push(`❌ ${item.title}: ${item.detail}`)
    lines.push(...hintsFor(item, config))
  }
  return lines.join('\n').slice(0, 4000)
}

/** Read the anti-spam state; a missing or damaged file means "no history". */
function readState(file) {
  const empty = { version: STATE_VERSION, lastAlertAt: null, lastAlertKey: null, consecutiveFailures: 0 }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || parsed.version !== STATE_VERSION) return empty
    return {
      version: STATE_VERSION,
      lastAlertAt: Number.isFinite(parsed.lastAlertAt) ? parsed.lastAlertAt : null,
      lastAlertKey: typeof parsed.lastAlertKey === 'string' ? parsed.lastAlertKey : null,
      consecutiveFailures: Number.isInteger(parsed.consecutiveFailures) ? parsed.consecutiveFailures : 0,
    }
  } catch {
    return empty
  }
}

/** Persist the anti-spam state atomically; a failure is reported, not fatal. */
function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch (error) {
    console.error(`не удалось сохранить состояние ${file}: ${error.message}`)
  }
}

/**
 * Send one message to the owner.
 *
 * The token is stripped from any returned error, so it can never reach the log.
 *
 * @returns {Promise<{ok: boolean, messageId?: number, error?: string}>}
 */
async function sendMessage(config, text) {
  if (!config.token) return { ok: false, error: 'не задан TELEGRAM_BOT_TOKEN' }
  if (!config.chatId) return { ok: false, error: 'задайте WATCHDOG_CHAT_ID или ALLOWED_USER_IDS' }
  const body = new URLSearchParams({
    chat_id: String(config.chatId),
    text,
    disable_web_page_preview: 'true',
  })
  try {
    const response = await fetch(`${config.apiBase}/bot${config.token}/sendMessage`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(config.httpTimeoutMs),
    })
    const parsed = await response.json().catch(() => null)
    if (!response.ok || parsed?.ok !== true) {
      const reason = parsed?.description || `HTTP ${response.status}`
      return { ok: false, error: redact(reason, [config.token]) }
    }
    return { ok: true, messageId: parsed.result?.message_id }
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'тайм-аут' : error?.message
    return { ok: false, error: redact(reason, [config.token]) }
  }
}

/** Send a test message; used to prove that alerts can reach the owner. */
async function runTest(config) {
  console.log(`отправляю тестовое сообщение (chat_id ${config.chatId ?? '—'})`)
  const result = await sendMessage(config, TEST_MESSAGE)
  if (!result.ok) {
    console.error(`тестовое сообщение не отправлено: ${result.error}`)
    return 1
  }
  console.log(`тестовое сообщение отправлено (message_id ${result.messageId ?? '—'})`)
  return 0
}

/**
 * One regular run: collect facts, alert when needed, exit 1 on any failure.
 *
 * @param {{facts: object[], config: object, quiet: boolean, statusOnly: boolean}} options
 */
async function runChecks({ facts, config, quiet, statusOnly }) {
  const failing = facts.filter((item) => item.verdict === 'fail')
  if (statusOnly) {
    if (!quiet) printFacts(facts)
    return failing.length > 0 ? 1 : 0
  }

  const state = readState(config.stateFile)
  const now = Date.now()

  if (failing.length > 0) {
    state.consecutiveFailures += 1
    const key = failing.map((item) => item.id).sort().join('+')
    const elapsedMs = state.lastAlertAt === null ? Infinity : now - state.lastAlertAt
    const changed = key !== state.lastAlertKey
    const due = elapsedMs >= config.alertRepeatMs

    if (changed || due) {
      const result = await sendMessage(config, buildAlert(facts, config))
      if (result.ok) {
        state.lastAlertAt = now
        state.lastAlertKey = key
        if (!quiet) console.log(`алерт отправлен (message_id ${result.messageId ?? '—'})`)
      } else {
        console.error(`не удалось отправить алерт: ${result.error}`)
      }
    } else if (!quiet) {
      const minutes = Math.floor(elapsedMs / 60_000)
      console.log(`алерт подавлен: тот же набор проблем, прошло ${minutes} мин из ${config.alertRepeatMs / 60_000}`)
    }
    writeState(config.stateFile, state)
    if (!quiet) printFacts(facts)
    return 1
  }

  // Everything that matters is fine; a previous alert may need closing.
  const hadAlert = state.lastAlertAt !== null || state.lastAlertKey !== null
  state.consecutiveFailures = 0
  if (hadAlert) {
    const result = await sendMessage(config, RECOVERY_MESSAGE)
    if (result.ok) {
      state.lastAlertAt = null
      state.lastAlertKey = null
      if (!quiet) console.log('отправлено «бот снова в порядке»')
    } else {
      console.error(`не удалось отправить «снова в порядке»: ${result.error}`)
    }
  }
  writeState(config.stateFile, state)
  if (!quiet) printFacts(facts)
  return 0
}

function printUsage() {
  console.log('Использование: node tools/watchdog.mjs [--quiet | --test | --status]')
  console.log('  (без флагов)  одна проверка; при проблемах алерт владельцу в Telegram')
  console.log('  --quiet       ничего не печатать при успехе (для launchd)')
  console.log('  --test        отправить тестовое сообщение владельцу и выйти')
  console.log('  --status      показать собранные факты, ничего не отправлять')
}

/** Parse flags, dispatch, and return the process exit code. */
async function main() {
  const argv = process.argv.slice(2)
  loadEnvFile(path.join(projectDir, '.env'))
  const config = buildConfig(process.env)

  if (argv.includes('--help')) {
    printUsage()
    return 0
  }
  if (argv.includes('--test')) return runTest(config)

  const statusOnly = argv.includes('--status')
  const quiet = argv.includes('--quiet')
  const facts = await collectFacts(config)
  return runChecks({ facts, config, quiet, statusOnly })
}

process.exitCode = await main()
