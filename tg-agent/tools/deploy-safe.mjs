/**
 * Safe self-deployment for the tg-agent bot: verify, switch, roll back.
 *
 * Runs ON the server, from the directory that holds the new version (after the
 * project is copied there: `/tmp/tg-deploy/tg-agent`). The layout it maintains is
 * a directory of immutable releases plus the symlink systemd actually starts:
 *
 *   /opt/tg-agent-releases/release-20261007-011500/   # one release
 *   /opt/tg-agent -> .../release-20261007-011500      # what runs now
 *
 * Unlike `deploy/deploy-remote.sh`, which copies straight over the live
 * directory, this script never touches the running install until the new version
 * has passed `node --check` and the test suite. After the switch the service is
 * restarted and watched; a failed health check puts the previous release back
 * and reports to Telegram.
 *
 * Usage (installation needs root: /opt and systemctl are root's):
 *   cd /tmp/tg-deploy/tg-agent
 *   sudo node tools/deploy-safe.mjs                     # verify, release, switch
 *   sudo node tools/deploy-safe.mjs --dry-run           # checks only, no switch
 *   sudo node tools/deploy-safe.mjs --from /tmp/other   # another source tree
 *   sudo node tools/deploy-safe.mjs --service max-agent # deploy the MAX service
 *   sudo node tools/deploy-safe.mjs --no-tests          # debug only, loud warning
 *   node tools/deploy-safe.mjs --status                 # read-only report
 *
 * Exit code 0 (success or report) and 1 (refused to switch, or rolled back).
 *
 * Every external command goes through one injectable `runner`, which is what
 * lets the tests run on a Mac without systemd. The token is never printed: only
 * the presence of `TELEGRAM_BOT_TOKEN` matters, and outgoing errors are redacted.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Project root of the running copy; the default `--from` source. */
const scriptProjectDir = path.resolve(import.meta.dirname, '..')

/** Paths and names that match the existing systemd deployment. */
const DEFAULTS = {
  RELEASES_DIR: '/opt/tg-agent-releases',
  CURRENT_LINK: '/opt/tg-agent',
  SERVICE: 'tg-agent',
  SERVICE_USER: 'tgagent',
}

const DEFAULT_KEEP = 3
const DEFAULT_TEST_TIMEOUT_SEC = 180
const DEFAULT_HEALTH_TIMEOUT_SEC = 60
const DEFAULT_TELEGRAM_TIMEOUT_MS = 15_000

/** A journal line younger than this proves the restarted bot is logging. */
const JOURNAL_FRESH_MS = 30_000
/** Window in which `ERROR` must not appear after the restart. */
const ERROR_WINDOW = '-1min'
const HEALTH_POLL_MS = 2_000
const RESTART_TIMEOUT_MS = 60_000
const COMMAND_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT = 16 * 1024 * 1024

const RELEASE_PREFIX = 'release-'
/** `release-YYYYMMDD-HHMMSS`, optionally with a `-legacy` / `-2` suffix. */
const RELEASE_RE = /^release-\d{8}-\d{6}(?:-[a-z0-9]+)*$/
/** Top-level directories that never belong to a release. */
const EXCLUDED_DIRS = new Set(['data', '.ssh', 'backups', '.git', 'node_modules'])
/** Known harmless lines, the same set the watchdog ignores. */
const IGNORED_ERRORS = [/offset save failed/i]

const pad = (value) => String(value).padStart(2, '0')

/** `YYYYMMDD-HHMMSS`, the release directory suffix. */
function stamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Human-readable elapsed time for the summary. */
function formatDuration(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} мс`
  return `${(ms / 1000).toFixed(1)} с`
}

/** First non-empty line of a command's stderr, shortened. */
function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/).map((item) => item.trim()).find(Boolean)
  return line ? line.slice(0, 200) : ''
}

/** Replace every occurrence of a secret, so it can never reach the log. */
function redact(text, secrets) {
  return secrets
    .filter(Boolean)
    .reduce((acc, secret) => String(acc).split(String(secret)).join('[redacted]'), text)
}

/** A positive integer from the environment, or the default. */
function readCount(raw, fallback, label, log) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    log(`ВНИМАНИЕ: ${label} должен быть целым числом >= 1, беру ${fallback}`)
    return fallback
  }
  return value
}

/**
 * Load `KEY=VALUE` lines from a file into `process.env`, if it exists.
 *
 * Variables already present in the environment win. A missing file is not an
 * error: the process may be configured entirely through the real environment,
 * and `--status` must work on a machine without a `.env`.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file)
      return true
    } catch {
      // Fall through to the parser so a stray line cannot abort a deploy.
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

/**
 * The default command runner: a thin, never-throwing wrapper over spawnSync.
 *
 * @returns {{status: number, stdout: string, stderr: string, error?: Error}}
 */
function createRunner() {
  return (command, args = [], options = {}) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT,
    })
    const failed = Boolean(result.error)
    return {
      status: typeof result.status === 'number' ? result.status : (failed ? 127 : 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (failed ? result.error.message : ''),
      error: failed ? result.error : undefined,
    }
  }
}

/** Run a command through the runner, turning a thrown error into a failed run. */
function safeRun(runner, command, args, options = {}) {
  try {
    const result = runner(command, args, options)
    return {
      status: typeof result?.status === 'number' ? result.status : 1,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    }
  } catch (error) {
    return { status: 1, stdout: '', stderr: error.message }
  }
}

/** Existing releases, newest first (the names sort chronologically). */
export function listReleases(releasesDir) {
  let entries
  try {
    entries = fs.readdirSync(releasesDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && RELEASE_RE.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(releasesDir, entry.name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}

/** What `CURRENT_LINK` currently is: a symlink, a plain directory, or nothing. */
function readCurrent(currentLink) {
  let stat
  try {
    stat = fs.lstatSync(currentLink)
  } catch {
    return { kind: 'missing', path: null }
  }
  if (stat.isSymbolicLink()) {
    const raw = fs.readlinkSync(currentLink)
    return { kind: 'link', path: path.resolve(path.dirname(currentLink), raw) }
  }
  if (stat.isDirectory()) return { kind: 'dir', path: currentLink }
  return { kind: 'other', path: currentLink }
}

/**
 * Point `currentLink` at `target` atomically: a temporary symlink in the same
 * directory is created first, then renamed over the link. A reader either sees
 * the old target or the new one, never a missing link.
 */
function atomicSwitch(currentLink, target) {
  const directory = path.dirname(currentLink)
  const temporary = path.join(directory, `.${path.basename(currentLink)}.deploy-tmp-${process.pid}`)
  fs.rmSync(temporary, { force: true })
  fs.symlinkSync(target, temporary)
  fs.renameSync(temporary, currentLink)
}

/** A free `release-<stamp>` directory, with a numeric suffix when taken. */
function uniqueReleaseDir(releasesDir, date) {
  const base = `${RELEASE_PREFIX}${stamp(date)}`
  let candidate = path.join(releasesDir, base)
  let suffix = 1
  while (fs.existsSync(candidate)) {
    suffix += 1
    candidate = path.join(releasesDir, `${base}-${suffix}`)
  }
  return candidate
}

/**
 * Files that macOS puts next to real ones when a project is copied from a Mac.
 *
 * They end in `.mjs` (after the `._` prefix), so `node --check` fails on them and
 * a release would never deploy. They are never part of the project.
 *
 * @param {string} name - base name of a file.
 * @returns {boolean} true when the file must be ignored.
 */
export const isJunkFile = (name) => name.startsWith('._') || name === '.DS_Store'

/** Every `src/**\/*.mjs` plus every `tools/*.mjs` of the new version. */
function collectSyntaxTargets(sourceDir) {
  const files = []
  const walk = (directory) => {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (isJunkFile(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(full)
    }
  }
  walk(path.join(sourceDir, 'src'))
  try {
    for (const entry of fs.readdirSync(path.join(sourceDir, 'tools'), { withFileTypes: true })) {
      if (isJunkFile(entry.name)) continue
      if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path.join(sourceDir, 'tools', entry.name))
    }
  } catch {
    // A version without tools/ is still deployable.
  }
  return files.sort()
}

/** `node --check` every file of the new version; the real Node, not the runner. */
function checkSyntax(sourceDir) {
  const files = collectSyntaxTargets(sourceDir)
  const failures = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
    if (result.status !== 0) {
      failures.push({ file: path.relative(sourceDir, file), message: firstLine(result.stderr) || `код ${result.status}` })
    }
  }
  return { ok: failures.length === 0, checked: files.length, failures }
}

/**
 * Test counts from the runner's output.
 *
 * The explicit `tap` reporter is used below, so `# pass N` is the normal shape,
 * but the `spec` reporter (`ℹ pass N`) and raw `ok N` lines are understood too:
 * a Node that ignores the reporter must not turn into "0 tests passed".
 */
function parseTestCounts(output) {
  const pass = /^# pass (\d+)/m.exec(output)?.[1] ?? /^\s*ℹ pass (\d+)/m.exec(output)?.[1]
  const fail = /^# fail (\d+)/m.exec(output)?.[1] ?? /^\s*ℹ fail (\d+)/m.exec(output)?.[1]
  if (pass !== undefined && fail !== undefined) return { pass: Number(pass), fail: Number(fail) }
  return {
    pass: (output.match(/^ok \d+/gm) ?? []).length,
    fail: (output.match(/^not ok \d+/gm) ?? []).length,
  }
}

/**
 * Run `node --test` in the new version. Uses the real Node and the real test
 * runner: the point of the step is to catch a version that only breaks when run.
 * The reporter is pinned to `tap`, whose summary lines are stable across Node
 * versions and independent of whether stdout is a terminal.
 */
function runTests(sourceDir, timeoutSec, log) {
  // The Node test runner marks child processes with NODE_TEST_CONTEXT; a nested
  // `node --test` that inherits it reports nothing. Strip it so the real suite
  // runs when this tool is itself exercised by `node --test`.
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  // --test-force-exit matches the project's own command: some tests leave a timer
  // behind, and without the flag the runner waits for them on Node 22.
  // `serial` runs one file at a time: local test stubs open sockets, so a parallel
  // run sometimes trips a single test under load.
  const attempt = (serial = false) => {
    const args = ['--test', '--test-force-exit', '--test-reporter=tap']
    if (serial) args.push('--test-concurrency=1')
    const result = spawnSync(process.execPath, args, {
      cwd: sourceDir,
      env: childEnv,
      encoding: 'utf8',
      timeout: timeoutSec * 1000,
      maxBuffer: OUTPUT_LIMIT,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const counts = parseTestCounts(output)
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'
    return { ok: !timedOut && result.status === 0 && counts.fail === 0, timedOut, ...counts, output }
  }
  const first = attempt()
  if (first.ok) return first
  // One flake must not block a deploy, while a real breakage fails twice: the
  // suite opens local sockets, so back-to-back runs sometimes collide.
  log?.('тесты не прошли — повторяю последовательно, чтобы отличить флейк от поломки')
  const second = attempt(true)
  if (second.ok) {
    log?.(`последовательный прогон прошёл (${second.pass} тестов): первый сбой считаю случайным`)
  }
  return second
}

/**
 * Build one release directory: project files without state, plus the *working*
 * `.env`. The secret file is taken from the current install on purpose: a copy
 * of the repository carries `.env.example`, never the real token.
 */
function createRelease({ sourceDir, releaseDir, envFile, runner, user, log }) {
  fs.mkdirSync(releaseDir, { recursive: true })
  try {
    fs.cpSync(sourceDir, releaseDir, {
      recursive: true,
      filter: (src) => {
        const relative = path.relative(sourceDir, src)
        if (relative === '') return true
        // macOS sidecar files (`._name.mjs`) must not enter a release.
        if (isJunkFile(path.basename(relative))) return false
        const top = relative.split(path.sep)[0]
        return !EXCLUDED_DIRS.has(top)
      },
    })
  } catch (error) {
    fs.rmSync(releaseDir, { recursive: true, force: true })
    return { ok: false, reason: `не удалось скопировать файлы: ${error.message}` }
  }

  const destination = path.join(releaseDir, '.env')
  fs.rmSync(destination, { force: true })
  if (!fs.existsSync(envFile)) {
    fs.rmSync(releaseDir, { recursive: true, force: true })
    return { ok: false, reason: `не найден рабочий файл секретов ${envFile}` }
  }
  fs.copyFileSync(envFile, destination)
  fs.chmodSync(destination, 0o600)
  log(`  .env перенесён из ${envFile} (права 600)`)

  const chown = safeRun(runner, 'chown', ['-R', `${user}:${user}`, releaseDir])
  if (chown.status !== 0) {
    log(`  ВНИМАНИЕ: не удалось выставить владельца ${user}: ${firstLine(chown.stderr) || `код ${chown.status}`}`)
  }
  return { ok: true }
}

/** `systemctl restart`; a non-zero exit is returned, not thrown. */
function restartService({ runner, service }) {
  const result = safeRun(runner, 'systemctl', ['restart', service], { timeoutMs: RESTART_TIMEOUT_MS })
  if (result.status !== 0) {
    return { ok: false, reason: `systemctl restart ${service}: ${firstLine(result.stderr) || `код ${result.status}`}` }
  }
  return { ok: true }
}

/** Age of the newest journal line, as reported by `journalctl -o json`. */
function lastJournalAge({ runner, service, now }) {
  const result = safeRun(runner, 'journalctl', ['-u', service, '-n', '1', '--no-pager', '-o', 'json'])
  const line = result.stdout.trim().split('\n').filter(Boolean).pop()
  if (!line) return { ok: false, reason: 'в журнале нет ни одной записи' }
  let timestampMs = Number.NaN
  try {
    timestampMs = Number(JSON.parse(line).__REALTIME_TIMESTAMP) / 1000
  } catch {
    timestampMs = Number.NaN
  }
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: 'не удалось разобрать время последней записи журнала' }
  }
  const ageMs = now() - timestampMs
  if (ageMs > JOURNAL_FRESH_MS) {
    return { ok: false, reason: `последняя запись журнала ${Math.round(ageMs / 1000)} с назад (порог 30 с)` }
  }
  return { ok: true, ageMs }
}

/** No `ERROR` lines in the journal window after the restart. */
function recentErrors({ runner, service }) {
  const result = safeRun(runner, 'journalctl', ['-u', service, '--since', ERROR_WINDOW, '--no-pager', '-o', 'cat'])
  const suspicious = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !IGNORED_ERRORS.some((pattern) => pattern.test(line)))
    .filter((line) => /\bERROR\b/.test(line))
  if (suspicious.length === 0) return { ok: true }
  return { ok: false, reason: `в журнале ERROR за последнюю минуту: ${suspicious[0].slice(0, 140)}` }
}

/**
 * HTTP-проверка живой панели.
 *
 * 401 без входа — нормальный ответ `/api/reminders` (панель жива и требует
 * авторизацию). 2xx/3xx тоже считаем ответом. Пустой `url` — проверка
 * пропущена: так `deploySafe` остаётся вызываемым из тестов и скриптов.
 */
async function httpHealth({ fetchImpl, url, timeoutMs = 5_000 }) {
  if (!url) return { ok: true, skipped: true }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'HTTP-проверка недоступна: нет fetch' }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = Number(response?.status)
    const ok = status === 401 || (status >= 200 && status < 400)
    return ok
      ? { ok: true, status }
      : { ok: false, reason: `HTTP ${Number.isFinite(status) ? status : '—'} (${url})` }
  } catch (error) {
    return { ok: false, reason: `HTTP недоступен (${url}): ${String(error?.message ?? error).slice(0, 140)}` }
  }
}

/**
 * Poll until the service is `active`, logs something fresh, prints no `ERROR`
 * and answers HTTP. The conditions are checked cheapest first.
 */
async function waitForHealthy({ runner, service, sleep, now, timeoutMs, fetchImpl, healthUrl }) {
  const deadline = now() + timeoutMs
  let reason = 'нет данных'
  let attempts = 0
  for (;;) {
    attempts += 1
    const active = safeRun(runner, 'systemctl', ['is-active', service]).stdout.trim()
    if (active !== 'active') {
      reason = `systemctl is-active ${service}: ${active || '—'}`
    } else {
      const fresh = lastJournalAge({ runner, service, now })
      if (!fresh.ok) {
        reason = fresh.reason
      } else {
        const errors = recentErrors({ runner, service })
        if (!errors.ok) reason = errors.reason
        else {
          const http = await httpHealth({ fetchImpl, url: healthUrl })
          if (!http.ok) reason = http.reason
          else return { ok: true, attempts, ageMs: fresh.ageMs, httpStatus: http.status }
        }
      }
    }
    if (now() >= deadline) return { ok: false, reason, attempts }
    await sleep(HEALTH_POLL_MS)
  }
}

/** The owner: an explicit ALERT_CHAT_ID or the first allowed user id. */
function resolveChatId(env) {
  if (env.ALERT_CHAT_ID) return env.ALERT_CHAT_ID
  return String(env.ALLOWED_USER_IDS ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)[0]
}

/**
 * Send one message to the owner via the Bot API. Never prints the token; a
 * failed delivery is reported and swallowed: the deploy result is what matters.
 */
async function sendTelegram({ env, fetchImpl, log, text }) {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) {
    log('  уведомление пропущено: не задан TELEGRAM_BOT_TOKEN')
    return false
  }
  const chatId = resolveChatId(env)
  if (!chatId) {
    log('  уведомление пропущено: задайте ALERT_CHAT_ID или ALLOWED_USER_IDS')
    return false
  }
  if (typeof fetchImpl !== 'function') {
    log('  уведомление пропущено: fetch недоступен')
    return false
  }
  const apiBase = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')
  const timeoutMs = Number(env.TELEGRAM_TIMEOUT_MS) > 0 ? Number(env.TELEGRAM_TIMEOUT_MS) : DEFAULT_TELEGRAM_TIMEOUT_MS
  try {
    const response = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      body: new URLSearchParams({ chat_id: String(chatId), text, disable_web_page_preview: 'true' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.description || `HTTP ${response.status}`)
    }
    log(`  уведомление отправлено в Telegram (message_id ${body.result?.message_id ?? '—'})`)
    return true
  } catch (error) {
    log(`  не удалось отправить уведомление: ${redact(error?.message ?? String(error), [token])}`)
    return false
  }
}

/** Delete releases beyond `keep`, always sparing the active and previous ones. */
function rotateReleases({ releasesDir, keep, protectedPaths, log }) {
  const releases = listReleases(releasesDir)
  const spared = new Set(releases.slice(0, keep).map((release) => release.path))
  for (const item of protectedPaths) {
    if (item) spared.add(path.resolve(item))
  }
  let removed = 0
  for (const release of releases) {
    if (spared.has(release.path)) continue
    try {
      fs.rmSync(release.path, { recursive: true, force: true })
      removed += 1
      log(`  удалён старый релиз: ${release.name}`)
    } catch (error) {
      log(`  не удалось удалить ${release.name}: ${error.message}`)
    }
  }
  if (removed === 0) log('  старых релизов сверх лимита нет')
}

/**
 * Поставить внешний сторож из нового релиза: юнит и таймер.
 *
 * Вызывается только успешным деплоем CLI. Ошибка установки не откатывает уже
 * проверенный релиз: бот работает, а сторож — отдельная страховка; причина
 * пишется в лог и в сводку.
 */
export function installWatchUnits({
  sourceDir,
  systemdDir = '/etc/systemd/system',
  runner,
  nodeBin = process.execPath,
  installDir,
  dataDir = '/var/lib/tg-agent',
  user = DEFAULTS.SERVICE_USER,
  service = DEFAULTS.SERVICE,
  log = () => {},
  logError = () => {},
} = {}) {
  if (service !== 'tg-agent') {
    return { ok: true, skipped: true, reason: `сторож ставится только для tg-agent, а не ${service}` }
  }
  if (!sourceDir || !installDir) return { ok: false, reason: 'не переданы sourceDir/installDir' }
  const source = path.join(sourceDir, 'deploy')
  const sourceService = path.join(source, 'tg-agent-watch.service')
  const sourceTimer = path.join(source, 'tg-agent-watch.timer')
  if (!fs.existsSync(sourceService) || !fs.existsSync(sourceTimer)) {
    return { ok: false, skipped: true, reason: 'в релизе нет юнитов сторожа' }
  }

  const unitPath = path.join(systemdDir, 'tg-agent-watch.service')
  const timerPath = path.join(systemdDir, 'tg-agent-watch.timer')
  try {
    let unit = fs.readFileSync(sourceService, 'utf8')
      .replace(/^ExecStart=.*$/m, `ExecStart=${nodeBin} tools/watchdog-service.mjs`)
      .replace(/^User=.*$/m, `User=${user}`)
      .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${installDir}`)
      .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${path.join(installDir, '.env')}`)
      .replace(/^Environment=DATA_DIR=.*$/m, `Environment=DATA_DIR=${dataDir}`)
      .replace(/^Environment=WATCHDOG_SERVICE=.*$/m, `Environment=WATCHDOG_SERVICE=${service}`)
      .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${dataDir}`)
      .replace(/^StateDirectory=.*$/m, `StateDirectory=${path.basename(dataDir)}`)
      .replace(/^Documentation=.*$/m, `Documentation=file:${path.join(installDir, 'README.md')}`)
    if (/^\/(?:root|home)\//.test(installDir)) unit = unit.replace(/^ProtectHome=.*$/m, 'ProtectHome=false')
    fs.mkdirSync(systemdDir, { recursive: true })
    const temporary = `${unitPath}.tmp-${process.pid}`
    fs.writeFileSync(temporary, unit, 'utf8')
    fs.renameSync(temporary, unitPath)
    fs.copyFileSync(sourceTimer, timerPath)
    const daemon = safeRun(runner, 'systemctl', ['daemon-reload'])
    if (daemon.status !== 0) {
      return { ok: false, reason: `systemctl daemon-reload: ${firstLine(daemon.stderr) || `код ${daemon.status}`}` }
    }
    const enabled = safeRun(runner, 'systemctl', ['enable', '--now', 'tg-agent-watch.timer'])
    if (enabled.status !== 0) {
      return { ok: false, reason: `systemctl enable --now tg-agent-watch.timer: ${firstLine(enabled.stderr) || `код ${enabled.status}`}` }
    }
    log(`  сторож установлен: ${unitPath} (таймер tg-agent-watch.timer)`)
    return { ok: true, unitPath, timerPath }
  } catch (error) {
    logError(`  не удалось установить сторожа: ${error.message}`)
    return { ok: false, reason: error.message }
  }
}

/** Read-only report: the active release and everything in the releases dir. */
function showStatus({ currentLink, releasesDir, log }) {
  const current = readCurrent(currentLink)
  if (current.kind === 'link') {
    log(`активный релиз: ${currentLink} -> ${current.path}`)
  } else if (current.kind === 'dir') {
    log(`активный релиз: ${currentLink} (обычный каталог, релизная схема ещё не включена)`)
  } else {
    log(`активный релиз: нет (${currentLink} не существует)`)
  }
  const releases = listReleases(releasesDir)
  if (releases.length === 0) {
    log(`релизов нет в ${releasesDir}`)
    return 0
  }
  log(`релизов: ${releases.length} в ${releasesDir}`)
  for (const release of releases) {
    const active = current.kind === 'link' && path.resolve(current.path) === release.path
    log(`  ${release.name}${active ? '  <-- активен' : ''}`)
  }
  return 0
}

/**
 * The whole deployment. Every external command comes from `runner`, every wait
 * from `sleep`, every clock reading from `now`, so the logic is testable off the
 * server.
 *
 * @param {object} [options]
 * @returns {Promise<number>} the process exit code: 0 on success, 1 otherwise.
 */
export async function deploySafe(options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? ((line) => console.log(line))
  const logError = options.error ?? ((line) => console.error(line))
  const runner = options.runner ?? createRunner()
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  const releasesDir = path.resolve(options.releasesDir ?? env.RELEASES_DIR ?? DEFAULTS.RELEASES_DIR)
  const currentLink = path.resolve(options.currentLink ?? env.CURRENT_LINK ?? DEFAULTS.CURRENT_LINK)
  const service = options.service ?? env.SERVICE ?? DEFAULTS.SERVICE
  const user = options.user ?? env.SERVICE_USER ?? DEFAULTS.SERVICE_USER
  const envFile = path.resolve(options.envFile ?? env.ENV_FILE ?? path.join(currentLink, '.env'))
  const keep = Number.isInteger(options.keep) ? options.keep : readCount(env.KEEP, DEFAULT_KEEP, 'KEEP', log)
  const testTimeoutSec = Number.isFinite(options.testTimeoutSec)
    ? options.testTimeoutSec
    : readCount(env.TEST_TIMEOUT_SEC, DEFAULT_TEST_TIMEOUT_SEC, 'TEST_TIMEOUT_SEC', log)
  const healthTimeoutSec = Number.isFinite(options.healthTimeoutSec)
    ? options.healthTimeoutSec
    : readCount(env.HEALTH_TIMEOUT_SEC, DEFAULT_HEALTH_TIMEOUT_SEC, 'HEALTH_TIMEOUT_SEC', log)
  const sourceDir = path.resolve(options.from ?? env.DEPLOY_FROM ?? scriptProjectDir)
  const dryRun = Boolean(options.dryRun)
  const noTests = Boolean(options.noTests)
  const notify = Boolean(options.notify)
  // HTTP-проверка после старта: пусто — проверка пропущена (так вызывают
  // тесты и скрипты). `main` подставляет адрес панели или WATCHDOG_HEALTH_URL.
  const healthUrl = options.healthUrl ?? ''
  // Юнит и таймер сторожа ставит только CLI: прямой вызов из тестов не должен
  // писать в /etc/systemd/system.
  const installUnits = Boolean(options.installUnits)
  const systemdDir = path.resolve(options.systemdDir ?? '/etc/systemd/system')
  const dataDir = path.resolve(options.dataDir ?? env.DATA_DIR ?? '/var/lib/tg-agent')

  if (options.status) return showStatus({ currentLink, releasesDir, log })

  const startedAt = now()
  const summary = { release: null, tests: null }
  const done = (code, message) => {
    log('')
    log('--- сводка')
    log(`  результат: ${message}`)
    if (summary.release) log(`  релиз: ${summary.release}`)
    if (summary.tests) {
      log(`  тестов: ${summary.tests.pass} пройдено${summary.tests.fail ? `, ${summary.tests.fail} провалено` : ''}`)
    }
    log(`  время: ${formatDuration(now() - startedAt)}`)
    log(`  код выхода: ${code}`)
    return code
  }

  log(`=== безопасный деплой: ${service}`)
  log(`  источник: ${sourceDir}`)
  log(`  релизы:   ${releasesDir}`)
  log(`  симлинк:  ${currentLink}`)
  log(`  хранить:  ${keep} релиз(ов)`)
  if (noTests) {
    log('  !!! ВНИМАНИЕ: --no-tests выключил прогон тестов — версия проверена только синтаксически !!!')
  }

  log('--- 1/6 подготовка')
  if (!fs.existsSync(path.join(sourceDir, 'src', 'index.mjs'))) {
    logError(`ОШИБКА: в ${sourceDir} нет src/index.mjs — это не копия проекта`)
    return done(1, 'источник не похож на проект tg-agent')
  }
  const currentBefore = readCurrent(currentLink)
  if (currentBefore.kind === 'other') {
    logError(`ОШИБКА: ${currentLink} не каталог и не симлинк`)
    return done(1, 'текущая установка в неизвестном состоянии')
  }
  if (!fs.existsSync(envFile)) {
    logError(`ОШИБКА: не найден рабочий файл секретов ${envFile}`)
    return done(1, 'нет .env текущей установки')
  }
  log(`  текущая установка: ${currentBefore.kind === 'link' ? currentBefore.path : currentBefore.kind}`)

  log('--- 2/6 проверка новой версии до переключения')
  const syntax = checkSyntax(sourceDir)
  if (!syntax.ok) {
    for (const failure of syntax.failures) logError(`  СИНТАКСИС ${failure.file}: ${failure.message}`)
    return done(1, `node --check не прошёл (файлов: ${syntax.checked}, ошибок: ${syntax.failures.length})`)
  }
  log(`  node --check: файлов ${syntax.checked}, ошибок нет`)

  if (noTests) {
    log('  тесты пропущены (--no-tests)')
  } else {
    log(`  node --test (таймаут ${testTimeoutSec} с)`)
    const tests = runTests(sourceDir, testTimeoutSec, log)
    summary.tests = { pass: tests.pass, fail: tests.fail }
    if (!tests.ok) {
      // Name the failing tests first: the tail of a TAP run is counts, not causes.
      const lines = tests.output.split('\n')
      const failing = []
      for (let index = 0; index < lines.length && failing.length < 3; index++) {
        if (!lines[index].startsWith('not ok')) continue
        // The TAP block right after the header carries the actual cause.
        failing.push(lines.slice(index, index + 22).join('\n'))
      }
      if (failing.length > 0) logError(`упавшие тесты:\n${failing.join('\n')}`)
      const tail = tests.output.trim().split('\n').slice(-15).join('\n')
      logError(tail)
      const reason = tests.timedOut
        ? `тесты не уложились в ${testTimeoutSec} с`
        : `тесты не прошли (провалено: ${tests.fail})`
      return done(1, reason)
    }
    log(`  тесты пройдены: ${tests.pass} шт.`)
  }

  if (dryRun) {
    log('--- dry-run: переключение и перезапуск не выполняются')
    return done(0, 'dry-run завершён: новая версия прошла проверки')
  }

  log('--- 3/6 создание релиза')
  fs.mkdirSync(releasesDir, { recursive: true })
  const releaseDir = uniqueReleaseDir(releasesDir, new Date(now()))
  const created = createRelease({ sourceDir, releaseDir, envFile, runner, user, log })
  if (!created.ok) {
    logError(`ОШИБКА: ${created.reason}`)
    return done(1, 'релиз не создан')
  }
  summary.release = releaseDir
  log(`  создан релиз: ${releaseDir}`)

  log('--- 4/6 переключение симлинка и перезапуск')
  let previous = null
  const currentNow = readCurrent(currentLink)
  if (currentNow.kind === 'link') {
    previous = currentNow.path
  } else if (currentNow.kind === 'dir') {
    // First transition to the release scheme: the live directory becomes a
    // release of its own, so a rollback has somewhere to return to.
    const migrated = path.join(releasesDir, `${RELEASE_PREFIX}${stamp(new Date(now()))}-legacy`)
    try {
      fs.renameSync(currentLink, migrated)
    } catch (error) {
      logError(`ОШИБКА: не удалось перенести ${currentLink}: ${error.message}`)
      return done(1, 'первый переход на релизную схему не удался')
    }
    previous = migrated
    log(`  первый переход: ${currentLink} сохранён как ${migrated}`)
  }
  try {
    atomicSwitch(currentLink, releaseDir)
  } catch (error) {
    logError(`ОШИБКА: не удалось переключить симлинк: ${error.message}`)
    return done(1, `симлинк ${currentLink} не переключён`)
  }
  log(`  симлинк: ${currentLink} -> ${releaseDir}`)

  const restarted = restartService({ runner, service })
  if (!restarted.ok) {
    logError(`ПЕРЕЗАПУСК НЕ УДАЛСЯ: ${restarted.reason}`)
    return rollback({
      runner, sleep, now, log, logError, env, fetchImpl, service, currentLink, previous, releaseDir,
      healthTimeoutSec, reason: restarted.reason, summary, done,
    })
  }

  log('--- 5/6 проверка после запуска')
  const health = await waitForHealthy({
    runner, service, sleep, now, timeoutMs: healthTimeoutSec * 1000, fetchImpl, healthUrl,
  })
  if (!health.ok) {
    logError(`ПРОВЕРКА НЕ ПРОЙДЕНА: ${health.reason}`)
    return rollback({
      runner, sleep, now, log, logError, env, fetchImpl, service, currentLink, previous, releaseDir,
      healthTimeoutSec, healthUrl, reason: health.reason, summary, done,
    })
  }
  log(`  сервис активен, журнал свежий (${Math.round(health.ageMs / 1000)} с), ERROR нет`
    + (health.httpStatus ? `, HTTP ${health.httpStatus}` : ', HTTP-проверка пропущена'))

  log('--- 6/6 очистка старых релизов')
  rotateReleases({ releasesDir, keep, protectedPaths: [releaseDir, previous], log })

  // Сторож — часть схемы доступности: ставим его после зелёного старта, чтобы
  // не откатывать рабочий релиз из-за ошибки установки таймера.
  if (installUnits) {
    const watchdog = installWatchUnits({
      sourceDir: releaseDir,
      systemdDir,
      runner,
      nodeBin: process.execPath,
      installDir: currentLink,
      dataDir,
      user,
      service,
      log,
      logError,
    })
    summary.watchdog = watchdog.ok ? 'установлен' : `не установлен: ${watchdog.reason}`
    if (!watchdog.ok) logError(`ВНИМАНИЕ: внешний сторож не установлен: ${watchdog.reason}`)
  }

  if (notify) {
    const text = [
      `✅ ${service}: задеплоен ${path.basename(releaseDir)}`,
      '',
      summary.tests ? `тестов пройдено: ${summary.tests.pass}` : 'тесты пропущены (--no-tests)',
      `путь: ${releaseDir}`,
    ].join('\n')
    await sendTelegram({ env, fetchImpl, log, text })
  }

  return done(0, `активен ${releaseDir}`)
}

/**
 * Put the previous release back, restart, verify, and report. Always returns 1:
 * reaching this function means the new version failed.
 */
async function rollback(context) {
  const {
    runner, sleep, now, log, logError, env, fetchImpl, service, currentLink,
    previous, releaseDir, healthTimeoutSec, healthUrl, reason, summary, done,
  } = context

  log('--- ОТКАТ')
  if (!previous) {
    logError('  предыдущего релиза нет — откатывать некуда, симлинк оставлен как есть')
    const text = [
      `🚨 ${service}: деплой не удался, откатывать некуда`,
      '',
      `новый релиз: ${path.basename(releaseDir)}`,
      `причина: ${reason}`,
      '',
      `проверьте: journalctl -u ${service} -n 50 --no-pager`,
    ].join('\n')
    await sendTelegram({ env, fetchImpl, log, text })
    return done(1, `откат невозможен: ${reason}`)
  }

  log(`  возвращаю релиз: ${previous}`)
  try {
    atomicSwitch(currentLink, previous)
  } catch (error) {
    logError(`  ОШИБКА: не удалось вернуть симлинк: ${error.message}`)
    return done(1, `откат не удался: ${error.message}`)
  }
  log(`  симлинк: ${currentLink} -> ${previous}`)

  const restarted = restartService({ runner, service })
  if (!restarted.ok) logError(`  перезапуск после отката не удался: ${restarted.reason}`)
  const health = await waitForHealthy({
    runner, service, sleep, now, timeoutMs: healthTimeoutSec * 1000, fetchImpl, healthUrl,
  })
  if (health.ok) {
    log('  откат выполнен: предыдущий релиз снова активен')
  } else {
    logError(`  ВНИМАНИЕ: предыдущий релиз тоже не проходит проверку: ${health.reason}`)
  }
  summary.release = `${previous} (откат)`

  const text = [
    `🚨 ${service}: деплой откатился`,
    '',
    `новый релиз: ${path.basename(releaseDir)}`,
    `причина: ${reason}`,
    `возвращён релиз: ${path.basename(previous)}`,
    health.ok ? 'сервис снова работает' : 'ВНИМАНИЕ: предыдущий релиз тоже не проходит проверку',
    '',
    `проверьте: journalctl -u ${service} -n 50 --no-pager`,
  ].join('\n')
  await sendTelegram({ env, fetchImpl, log, text })

  return done(1, `откат выполнен: ${reason}`)
}

/** Parse the command line; unknown flags are reported by the caller. */
export function parseArgs(argv) {
  const options = { unknown: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const take = (label) => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) throw new Error(`после ${label} нужно значение`)
      return argv[index]
    }
    switch (name) {
      case '--dry-run': options.dryRun = true; break
      case '--no-tests': options.noTests = true; break
      case '--notify': options.notify = true; break
      case '--status': options.status = true; break
      case '--help': case '-h': options.help = true; break
      case '--from': options.from = take('--from'); break
      case '--service': options.service = take('--service'); break
      case '--releases-dir': options.releasesDir = take('--releases-dir'); break
      case '--current-link': options.currentLink = take('--current-link'); break
      case '--env-file': options.envFile = take('--env-file'); break
      case '--user': options.user = take('--user'); break
      case '--keep': options.keep = Number(take('--keep')); break
      case '--test-timeout': options.testTimeoutSec = Number(take('--test-timeout')); break
      case '--health-timeout': options.healthTimeoutSec = Number(take('--health-timeout')); break
      default: options.unknown.push(arg)
    }
  }
  return options
}

function printUsage(log) {
  log('Использование: node tools/deploy-safe.mjs [флаги]')
  log('  (без флагов)        проверить, создать релиз, переключить, откатить при сбое')
  log('  --dry-run           только проверки, без переключения и перезапуска')
  log('  --from <dir>        каталог новой версии (по умолчанию каталог скрипта)')
  log('  --service <name>    systemd-юнит (по умолчанию tg-agent)')
  log('  --releases-dir <d>  каталог релизов (по умолчанию /opt/tg-agent-releases)')
  log('  --current-link <l>  симлинк установки (по умолчанию /opt/tg-agent)')
  log('  --env-file <file>   рабочий .env (по умолчанию <current-link>/.env)')
  log('  --keep <n>          сколько релизов хранить (по умолчанию 3)')
  log('  --test-timeout <s>  таймаут тестов, с (по умолчанию 180)')
  log('  --health-timeout <s> таймаут проверки после запуска, с (по умолчанию 60)')
  log('  --no-tests          пропустить тесты (только для отладки)')
  log('  --notify            отправить «задеплоено» в Telegram при успехе')
  log('  --status            показать активный релиз и список релизов')
}

/** CLI entry point: parse flags, load the working `.env`, run. */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`ОШИБКА: ${error.message}`)
    printUsage(console.error)
    return 2
  }
  if (options.help) {
    printUsage(console.log)
    return 0
  }
  if (options.unknown.length > 0) {
    console.error(`ОШИБКА: неизвестные флаги: ${options.unknown.join(', ')}`)
    printUsage(console.error)
    return 2
  }
  const currentLink = path.resolve(options.currentLink ?? process.env.CURRENT_LINK ?? DEFAULTS.CURRENT_LINK)
  const envFile = path.resolve(options.envFile ?? process.env.ENV_FILE ?? path.join(currentLink, '.env'))
  loadEnvFile(envFile)
  // После перезапуска проверяем не только журнал, но и HTTP панели. Порт и хост
  // те же, что у мини-приложения; явный WATCHDOG_HEALTH_URL побеждает. Если
  // панель выключена (MINIAPP=false), проверка пропускается.
  const miniappEnabled = String(process.env.MINIAPP ?? '').toLowerCase() !== 'false'
  const port = Number(process.env.MINIAPP_PORT) > 0 ? Number(process.env.MINIAPP_PORT) : 8787
  const rawHost = String(process.env.MINIAPP_HOST ?? '').trim()
  const host = rawHost === '' || rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
  const healthUrl = options.healthUrl
    ?? process.env.WATCHDOG_HEALTH_URL
    ?? (miniappEnabled ? `http://${host}:${port}/api/reminders` : '')
  // Сторож ставится при обычном деплое; прямой вызов deploySafe из тестов его
  // не трогает (installUnits по умолчанию false).
  return deploySafe({ ...options, env: process.env, healthUrl, installUnits: options.installUnits ?? true })
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  process.exitCode = await main()
}
